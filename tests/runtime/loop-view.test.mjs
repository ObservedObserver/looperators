import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import {
  KernelStore,
  kernelDatabaseFileFor,
} from '../../dist-electron/electron/runtime/kernelStore.js'

// L4 loop view tests run schedules on second-scale intervals.
process.env.ORRERY_TIMER_MIN_INTERVAL_SECONDS = '1'

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
process.on('SIGTERM', () => process.exit(143))
emit({
  type: 'assistant',
  session_id: backendSessionId,
  message: { content: [{ type: 'text', text: 'fake response for ' + backendSessionId }] },
})
emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
`

function installFakeClaude(tempRoot) {
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
}

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

function harness(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  installFakeClaude(tempRoot)
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
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, storageFile, manager, cleanup }
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

function authorRing(runtime, coder, reviewer, overrides = {}) {
  const subA = runtime.authorSubscription({
    id: 'ring-a',
    label: 'coder→reviewer',
    sourceSessionId: coder,
    on: { on: 'finished' },
    targetSessionId: reviewer,
    action: { kind: 'deliver+activate' },
    gate: 'auto',
    ...(overrides.a ?? {}),
  })
  const subB = runtime.authorSubscription({
    id: 'ring-b',
    label: 'reviewer→coder',
    sourceSessionId: reviewer,
    on: { on: 'finished' },
    targetSessionId: coder,
    action: { kind: 'deliver+activate' },
    gate: 'auto',
    ...(overrides.b ?? {}),
  })
  return { subA, subB }
}

test('a live two-session ring projects a loop, spins to its cap, and reads lap by lap', async () => {
  const { manager, cleanup } = harness('orrery-loop-live-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const reviewer = await createIdleSession(runtime, 'Reviewer')

    authorRing(runtime, coder, reviewer, {
      a: { stop: { maxFirings: 2 } },
      b: { stop: { maxFirings: 2 } },
    })

    const loopId = [coder, reviewer].sort().join('+')
    const idle = runtime.getState()
    assert.equal(idle.loops.length, 1, 'the ring projects as one loop')
    const projected = idle.loops[0]
    assert.equal(projected.loopId, loopId)
    assert.deepEqual(projected.memberSessionIds, [coder, reviewer].sort())
    assert.deepEqual(projected.subscriptionIds, ['ring-a', 'ring-b'])
    assert.equal(projected.lapCap, 2)
    assert.equal(projected.status, 'idle')

    // One push starts the ring; the guardrail must end it on its own.
    await runtime.resumeSession({ sessionId: coder, message: 'begin lap one' })
    await waitFor(
      'the ring runs itself to a guardrail stop',
      () => runtime.getState().loops[0]?.status === 'stopped',
      30000
    )

    const state = runtime.getState()
    const loop = state.loops[0]
    assert.equal(
      loop.lapCount,
      state.subscriptions[loop.designatedSubscriptionId].firings,
      'the badge count is the designated firings, straight from state'
    )
    assert.ok(loop.lapCount >= 2, 'the ring completed its capped laps')

    const { loop: fetched, timeline } = runtime.getLoopTimeline({ loopId })
    assert.equal(fetched.loopId, loopId)
    assert.equal(
      timeline.laps.length,
      fetched.lapCount,
      'one timeline lap per designated firing'
    )

    for (const lap of timeline.laps) {
      for (const hop of lap.hops) {
        assert.ok(
          ['ring-a', 'ring-b'].includes(hop.subscriptionId),
          'every hop belongs to the ring'
        )
        assert.equal(hop.trigger?.type, 'session.finished', 'ticks of this ring are finish facts')
        assert.equal(hop.gate?.actor.kind, 'rule', 'auto gate approvals are readable per hop')
        assert.match(hop.gate?.reason ?? '', /Auto gate/)
      }
    }
    const firstHop = timeline.laps[0].hops[0]
    assert.equal(firstHop.target, reviewer, 'lap 1 starts with coder→reviewer')
    assert.equal(firstHop.trigger?.sourceSessionId, coder)
    assert.equal(firstHop.outcome?.type, 'finished', 'the causal chain closes the hop')

    assert.ok(
      timeline.stops.length >= 1 &&
        timeline.stops.every((stop) => /maxFirings/i.test(stop.reason ?? '')),
      'the timeline explains why the ring stopped'
    )

    assert.throws(
      () => runtime.getLoopTimeline({ loopId: 'no-such-loop' }),
      /Unknown loop/,
      'unknown rings are an explicit error'
    )
  } finally {
    cleanup()
  }
})

test('an unguarded ring gets the default guardrail and freeze shows on the badge', async () => {
  const { manager, cleanup } = harness('orrery-loop-freeze-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const reviewer = await createIdleSession(runtime, 'Reviewer')

    authorRing(runtime, coder, reviewer)

    const loop = runtime.getState().loops[0]
    assert.equal(
      loop.lapCap,
      6,
      'on-cycle edges carry the default maxFirings guardrail, and the badge shows it'
    )

    runtime.freeze({ target: coder, reason: 'Overnight hold.' })
    const frozen = runtime.getState().loops[0]
    assert.equal(frozen.status, 'frozen')
    assert.equal(frozen.statusDetail, 'Overnight hold.')
  } finally {
    cleanup()
  }
})

test('dailyAt: validation, normalization, and the deterministic note', async () => {
  const { manager, cleanup } = harness('orrery-loop-dailyat-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'Morning Brief')

    const timerInput = (on) => ({
      source: { kind: 'timer' },
      on,
      targetSessionId: target,
      action: { kind: 'deliver+activate' },
    })

    assert.throws(
      () => runtime.authorSubscription(timerInput({ on: 'schedule' })),
      /exactly one of everySeconds or dailyAt/,
      'a schedule needs one form'
    )
    assert.throws(
      () =>
        runtime.authorSubscription(
          timerInput({ on: 'schedule', everySeconds: 60, dailyAt: '09:00' })
        ),
      /exactly one of everySeconds or dailyAt/,
      'a schedule cannot mix both forms'
    )
    assert.throws(
      () => runtime.authorSubscription(timerInput({ on: 'schedule', dailyAt: '25:00' })),
      /HH:MM/,
      'out-of-range wall-clock times are rejected'
    )

    const authored = runtime.authorSubscription(
      timerInput({ on: 'schedule', dailyAt: '9:30' })
    )
    assert.equal(
      authored.subscription.on.dailyAt,
      '09:30',
      'the stored form is normalized for stable display'
    )
    assert.equal(authored.subscription.on.everySeconds, undefined)
    assert.match(
      authored.subscription.action.note,
      /daily at 09:30/,
      'the default note names the wall-clock schedule'
    )

    // A daily schedule with no missed occurrence must not tick immediately.
    await delay(1500)
    const ticks = runtime
      .getKernelEvents({ limit: 5000 })
      .events.filter((event) => event.type === 'external.timer')
    assert.equal(ticks.length, 0, 'the first occurrence is in the future')
  } finally {
    cleanup()
  }
})

test('dailyAt: a restart past the wall-clock time fires exactly one catch-up tick', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-loop-dailyat-catchup-')
  try {
    const first = manager()
    const target = await createIdleSession(first, 'Daily Target')
    const authored = first.authorSubscription({
      id: 'daily-brief',
      source: { kind: 'timer' },
      on: { on: 'schedule', dailyAt: '09:00' },
      targetSessionId: target,
      action: { kind: 'deliver+activate' },
    })
    first.killAll()

    // Simulate downtime across the daily time: the last tick is anchored
    // more than a day ago, so the next 09:00 occurrence already passed.
    const store = new KernelStore({ databaseFile: kernelDatabaseFileFor(storageFile) })
    const snapshot = store.loadSnapshot()
    assert.ok(snapshot, 'the first manager persisted a snapshot')
    snapshot.state.subscriptions[authored.subscription.id].lastTickAt = new Date(
      Date.now() - 25 * 3600 * 1000
    ).toISOString()
    store.saveSnapshot(snapshot.state)
    store.close?.()

    const second = manager({ storageFile })
    await waitFor(
      'one overdue dailyAt tick shortly after restart',
      () =>
        second
          .getKernelEvents({ limit: 5000 })
          .events.filter(
            (event) =>
              event.type === 'external.timer' &&
              event.payload.subscriptionId === authored.subscription.id
          ).length >= 1,
      3000
    )
    await delay(800)
    const ticks = second
      .getKernelEvents({ limit: 5000 })
      .events.filter(
        (event) =>
          event.type === 'external.timer' &&
          event.payload.subscriptionId === authored.subscription.id
      )
    assert.equal(ticks.length, 1, 'exactly one catch-up tick, no backlog replay')
    assert.equal(ticks[0].payload.dailyAt, '09:00', 'the tick fact names its schedule')
  } finally {
    cleanup()
  }
})
