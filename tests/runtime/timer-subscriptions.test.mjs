import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import {
  KernelStore,
  kernelDatabaseFileFor,
} from '../../dist-electron/electron/runtime/kernelStore.js'
import { deterministicRuntimeSessionManager } from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

// L1 timer source tests run on second-scale intervals; the production
// minimum (15s) is a guardrail, not a scheduling assumption.
process.env.ORRERY_TIMER_MIN_INTERVAL_SECONDS = '1'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate()
    if (value) {
      return value
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function kernelEvents(runtime) {
  return runtime.getKernelEvents({ limit: 5000 }).events
}

function eventsOfType(runtime, type) {
  return kernelEvents(runtime).filter((event) => event.type === type)
}

async function createIdleSession(runtime, label) {
  const created = await runtime.createSession({
    prompt: `bootstrap ${label}`,
    label,
    cwd: process.cwd(),
  })
  await waitFor(
    `${label} idle`,
    () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
  )
  return created.sessionId
}

function harness(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input = { storageFile }) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }
  const cleanup = () => {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, storageFile, manager, cleanup }
}

function authorTimer(runtime, target, overrides = {}) {
  return runtime.authorSubscription({
    label: 'morning-brief',
    source: { kind: 'timer' },
    on: { on: 'schedule', everySeconds: 1 },
    targetSessionId: target,
    action: { kind: 'deliver+activate', note: 'Scheduled check-in.' },
    ...overrides,
  })
}

test('a schedule subscription ticks and auto-activates its target with a full causal chain', async () => {
  const { manager, cleanup } = harness('orrery-timer-live-')
  try {
    const runtime = manager()
    const summarizer = await createIdleSession(runtime, 'Summarizer')

    const authored = authorTimer(runtime, summarizer)
    assert.deepEqual(authored.subscription.source, { kind: 'timer' })
    assert.equal(
      authored.subscription.gate,
      'auto',
      'timer edges are acyclic, so the default gate is auto'
    )
    assert.equal(authored.subscription.stop, undefined, 'no forced guardrail off-cycle')

    await waitFor(
      'two activations driven by ticks',
      () =>
        eventsOfType(runtime, 'activated').filter(
          (event) => event.payload.subscriptionId === authored.subscription.id
        ).length >= 2,
      15000
    )

    const ticks = eventsOfType(runtime, 'external.timer')
    assert.ok(ticks.length >= 2, `expected >= 2 ticks, saw ${ticks.length}`)
    for (const tick of ticks) {
      assert.equal(tick.payload.subscriptionId, authored.subscription.id)
      assert.equal(tick.actor.kind, 'runtime')
    }

    // Causal chain: every pending activation is caused by a tick.
    const tickIds = new Set(ticks.map((event) => event.id))
    const pendings = eventsOfType(runtime, 'activation.pending').filter(
      (event) => event.payload.subscriptionId === authored.subscription.id
    )
    assert.ok(pendings.length >= 2)
    for (const pending of pendings) {
      assert.ok(
        tickIds.has(pending.causeId),
        `activation.pending ${pending.id} must chain back to a tick`
      )
    }

    // Read the snapshot before the log: every anchor in the snapshot must
    // already be an appended tick fact (events are truth).
    const subscription =
      runtime.getState().subscriptions[authored.subscription.id]
    assert.ok(subscription.firings >= 2)
    const loggedTickTs = new Set(
      eventsOfType(runtime, 'external.timer').map((event) => event.ts)
    )
    assert.ok(
      loggedTickTs.has(subscription.lastTickAt),
      'the snapshot anchor mirrors an appended tick fact'
    )
  } finally {
    cleanup()
  }
})

test('validation: timer/schedule pairing, minimum interval, and action shape', async () => {
  const { manager, cleanup } = harness('orrery-timer-validate-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'Target')

    assert.throws(
      () =>
        runtime.authorSubscription({
          sourceSessionId: target,
          on: { on: 'schedule', everySeconds: 5 },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /timer/,
      'schedule pattern requires a timer source'
    )
    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'timer' },
          on: { on: 'finished' },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /schedule/,
      'timer source requires the schedule pattern'
    )
    assert.throws(
      () => authorTimer(runtime, target, { on: { on: 'schedule', everySeconds: 0 } }),
      /everySeconds/,
      'sub-minimum intervals are rejected'
    )
    assert.throws(
      () =>
        authorTimer(runtime, target, {
          action: { kind: 'deliver', topic: 'tick' },
        }),
      /deliver\+activate/,
      'a clock has nothing to deliver'
    )
    assert.throws(
      () => authorTimer(runtime, target, { concurrency: 'queue' }),
      /queue/,
      'ticks are fungible; queueing stale ticks is rejected'
    )

    // The default activation note is a deterministic template.
    const authored = runtime.authorSubscription({
      source: { kind: 'timer' },
      on: { on: 'schedule', everySeconds: 3600 },
      targetSessionId: target,
      action: { kind: 'deliver+activate' },
    })
    assert.match(authored.subscription.action.note, /every 3600s/)
  } finally {
    cleanup()
  }
})

test('freeze gates scheduled activation; the coalesced slot is the dirty flag', async () => {
  const { manager, cleanup } = harness('orrery-timer-freeze-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'Frozen Target')
    runtime.freeze({ target, reason: 'Hold scheduled work.' })

    const authored = authorTimer(runtime, target)

    await waitFor(
      'two ticks while frozen',
      () => eventsOfType(runtime, 'external.timer').length >= 2,
      15000
    )

    assert.equal(
      eventsOfType(runtime, 'activated').filter(
        (event) => event.payload.subscriptionId === authored.subscription.id
      ).length,
      0,
      'a frozen target must not be activated'
    )

    const slots = Object.values(runtime.getState().pendingActivations ?? {}).filter(
      (slot) => slot.subscriptionId === authored.subscription.id
    )
    assert.equal(slots.length, 1, 'coalesce keeps exactly one live slot')
    assert.equal(slots[0].status, 'approved', 'auto gate approved; freeze holds execution')

    assert.ok(
      eventsOfType(runtime, 'activation.superseded').some(
        (event) => event.payload.subscriptionId === authored.subscription.id
      ),
      'later ticks supersede the parked slot instead of queueing'
    )

    const lifted = await runtime.unfreeze({
      target,
      reason: 'Release the latest scheduled work.',
      commandId: 'unfreeze-frozen-target',
      idempotencyKey: 'unfreeze-frozen-target-once',
      expectedVersion: runtime.getState().controlVersion,
    })
    assert.equal(lifted.ok, true)
    await waitFor(
      'dirty slot activates after unfreeze',
      () =>
        eventsOfType(runtime, 'activated').some(
          (event) => event.payload.subscriptionId === authored.subscription.id
        ) &&
        !Object.values(runtime.getState().pendingActivations ?? {}).some(
          (slot) => slot.subscriptionId === authored.subscription.id
        ),
      10000,
    )
    runtime.stopSubscription({ subscriptionId: authored.subscription.id, reason: 'Unfreeze verified.' })
    assert.equal(runtime.getState().nodes.find((node) => node.sessionId === target)?.frozen, false)
    assert.ok(
      eventsOfType(runtime, 'freeze.lifted').some(
        (event) => event.payload.targetId === target
      ),
      'unfreeze is a durable control fact',
    )
  } finally {
    cleanup()
  }
})

test('session unfreeze rejects an inherited cluster freeze and cluster unfreeze lifts it', async () => {
  const { manager, cleanup } = harness('orrery-cluster-unfreeze-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'Cluster Frozen Target')
    runtime.upsertCluster({
      clusterId: 'frozen-cluster',
      label: 'Frozen cluster',
      nodeIds: [target],
    })
    runtime.freeze({ target: 'frozen-cluster', reason: 'Hold the cluster.' })
    await assert.rejects(
      runtime.unfreeze({ target, reason: 'Wrong level.' }),
      /inherits freeze from cluster frozen-cluster/i,
    )
    const lifted = await runtime.unfreeze({
      target: 'frozen-cluster',
      reason: 'Release the cluster.',
    })
    assert.equal(lifted.ok, true)
    assert.equal(runtime.getState().clusters['frozen-cluster'].frozen, false)
  } finally {
    cleanup()
  }
})

test('stopping the subscription silences the timer', async () => {
  const { manager, cleanup } = harness('orrery-timer-stop-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'Stoppable')
    const authored = authorTimer(runtime, target)

    await waitFor(
      'first tick',
      () => eventsOfType(runtime, 'external.timer').length >= 1,
      15000
    )
    runtime.stopSubscription({
      subscriptionId: authored.subscription.id,
      reason: 'Enough.',
    })
    const countAtStop = eventsOfType(runtime, 'external.timer').length

    await delay(2300)
    assert.equal(
      eventsOfType(runtime, 'external.timer').length,
      countAtStop,
      'no ticks after stop'
    )
  } finally {
    cleanup()
  }
})

test('recovery sweep: a schedule subscription with a killed target is stopped on load', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-timer-killsweep-')
  try {
    const first = manager()
    const target = await createIdleSession(first, 'Doomed Target')
    const authored = authorTimer(first, target, {
      on: { on: 'schedule', everySeconds: 3600 },
    })
    first.killAll()

    // Simulate the shutdown race: the target was killed but the async
    // session.killed sweep never ran, so the persisted snapshot still has
    // the subscription active. (killAll leaves the store open, so a fresh
    // connection takes snapshot ownership.)
    const store = new KernelStore({ databaseFile: kernelDatabaseFileFor(storageFile) })
    const snapshot = store.loadSnapshot()
    assert.ok(snapshot, 'the first manager persisted a snapshot')
    snapshot.state.sessions[target].status = 'killed'
    assert.equal(snapshot.state.subscriptions[authored.subscription.id].state, 'active')
    store.saveSnapshot(snapshot.state)
    store.close?.()

    const second = manager({ storageFile })
    const subscription = second.getState().subscriptions[authored.subscription.id]
    assert.equal(
      subscription.state,
      'stopped',
      'kill parity re-runs on load; the timer edge is not resurrected'
    )
    assert.ok(
      kernelEvents(second).some(
        (event) =>
          event.type === 'subscription.stopped' &&
          event.payload.subscriptionId === authored.subscription.id &&
          /killed/i.test(event.reason ?? '')
      ),
      'the stop is a logged fact with the kill-parity reason'
    )
  } finally {
    cleanup()
  }
})

test('recovery reconciles a lost tick anchor from the event log', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-timer-anchor-')
  try {
    const first = manager()
    const target = await createIdleSession(first, 'Anchored')
    const authored = authorTimer(first, target)

    await waitFor(
      'a tick on record',
      () => eventsOfType(first, 'external.timer').length >= 1,
      15000
    )
    await waitFor(
      'target idle before shutdown',
      () => first.getState().sessions[target]?.status === 'idle'
    )
    first.killAll()

    // Simulate a stale snapshot that predates the tick: the anchor is gone
    // from the snapshot but the tick fact is in the log.
    const store = new KernelStore({ databaseFile: kernelDatabaseFileFor(storageFile) })
    const snapshot = store.loadSnapshot()
    assert.ok(snapshot)
    const loggedTicks = store.listEvents({ type: 'external.timer', limit: 100 })
    const latestLoggedTs = loggedTicks.at(-1).ts
    delete snapshot.state.subscriptions[authored.subscription.id].lastTickAt
    // A long interval keeps the reconciled anchor observable (no immediate
    // catch-up tick overwriting it before the assertion).
    snapshot.state.subscriptions[authored.subscription.id].on.everySeconds = 3600
    store.saveSnapshot(snapshot.state)
    store.close?.()

    const second = manager({ storageFile })
    assert.equal(
      second.getState().subscriptions[authored.subscription.id].lastTickAt,
      latestLoggedTs,
      'the anchor is recovered from the log, not from snapshot freshness'
    )
  } finally {
    cleanup()
  }
})

test('restart catches up with exactly one overdue tick, then resumes cadence', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-timer-restart-')
  try {
    const first = manager()
    const target = await createIdleSession(first, 'Restartable')
    authorTimer(first, target, { on: { on: 'schedule', everySeconds: 2 } })

    await waitFor(
      'first tick before restart',
      () => eventsOfType(first, 'external.timer').length >= 1,
      15000
    )
    // Let the in-flight activation finish before shutdown: killAll would
    // kill a running target, and the kill sweep stops its subscriptions.
    await waitFor(
      'target idle before restart',
      () => first.getState().sessions[target]?.status === 'idle'
    )
    first.killAll()
    const ticksBeforeRestart = eventsOfType(first, 'external.timer').length

    // Sleep past more than one full interval: several ticks are "missed".
    await delay(5000)

    const second = manager({ storageFile })
    await waitFor(
      'catch-up tick shortly after restart',
      () => eventsOfType(second, 'external.timer').length >= ticksBeforeRestart + 1,
      3000
    )
    // Sample inside the next interval: the backlog must not replay.
    await delay(800)
    assert.equal(
      eventsOfType(second, 'external.timer').length,
      ticksBeforeRestart + 1,
      'exactly one catch-up tick for arbitrary downtime'
    )
  } finally {
    cleanup()
  }
})
