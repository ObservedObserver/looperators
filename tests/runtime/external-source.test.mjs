import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)
import { startRuntimeHttpServer } from '../../dist-electron/electron/runtimeHttpServer.js'
import {
  KernelStore,
  kernelDatabaseFileFor,
} from '../../dist-electron/electron/runtime/kernelStore.js'

// L2 runtime tests: everything below the adapters goes through the
// ingestion choke point, so a synthetic emitExternalEvent call exercises
// the exact production path (matching, gate, concurrency, guardrails) —
// no real watcher required. Adapters get their own suites.

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

test('an emit rides the ordinary scheduler: field match, activation, payload delivery, anchors', async () => {
  const { manager, cleanup } = harness('orrery-l2-emit-')
  try {
    const runtime = manager()
    const fixer = await createIdleSession(runtime, 'fixer')

    const { source } = runtime.registerExternalSource({
      id: 'src-ci',
      kind: 'manual',
      topic: 'ci',
      label: 'CI status',
    })
    assert.equal(source.state, 'active')
    assert.equal(runtime.getState().sources['src-ci'].topic, 'ci')

    runtime.authorSubscription({
      id: 'sub-ci-fix',
      source: { kind: 'external', sourceId: 'src-ci' },
      on: { on: 'external', topic: 'ci', match: { status: 'failed' } },
      targetSessionId: fixer,
      action: { kind: 'deliver+activate' },
      gate: 'auto',
    })

    // A non-matching emit is accepted at the choke point but fires nothing.
    const passed = runtime.emitExternalEvent({
      sourceId: 'src-ci',
      payload: { status: 'passed' },
      dedupeKey: 'run-1',
    })
    assert.equal(passed.ok, true)
    assert.equal(passed.type, 'external.ci')
    await delay(200)
    assert.equal(runtime.getState().subscriptions['sub-ci-fix'].firings, 0)

    // The matching emit activates the fixer and delivers the payload.
    const failed = runtime.emitExternalEvent({
      sourceId: 'src-ci',
      payload: { status: 'failed', log: 'assertion boom in suite X' },
      dedupeKey: 'run-2',
    })
    assert.equal(failed.ok, true)
    await waitFor(
      'external firing',
      () => runtime.getState().subscriptions['sub-ci-fix'].firings === 1
    )
    await waitFor(
      'fixer back to idle',
      () => runtime.getState().sessions[fixer]?.status === 'idle'
    )

    // The emit payload reached the target's channel as a delivery.
    const delivered = runtime
      .getKernelEvents({ type: 'delivered' })
      .events.filter((event) => event.payload.subscriptionId === 'sub-ci-fix')
    assert.equal(delivered.length, 1)

    // Ingestion anchors are caches of the appended facts.
    const anchored = runtime.getState().sources['src-ci']
    assert.equal(anchored.lastDedupeKey, 'run-2')
    assert.ok(anchored.lastEventAt)

    // Both emits are ordinary kernel facts with the source identity.
    const facts = runtime.getKernelEvents({ type: 'external.ci' }).events
    assert.equal(facts.length, 2)
    assert.ok(facts.every((event) => event.payload.sourceId === 'src-ci'))

    // An external entry edge never renders as a loop.
    assert.deepEqual(runtime.getState().loops ?? [], [])
  } finally {
    cleanup()
  }
})

test('the choke point drops duplicates and too-soon emits without touching the log', async () => {
  const { manager, cleanup } = harness('orrery-l2-guards-')
  try {
    const runtime = manager()

    runtime.registerExternalSource({
      id: 'src-watch',
      kind: 'manual',
      topic: 'watch',
      minIntervalSeconds: 60,
    })

    const first = runtime.emitExternalEvent({
      sourceId: 'src-watch',
      payload: { head: 'aaa' },
      dedupeKey: 'aaa',
    })
    assert.equal(first.ok, true)

    // Same dedupeKey: consecutive-duplicate suppression.
    const repeat = runtime.emitExternalEvent({
      sourceId: 'src-watch',
      payload: { head: 'aaa' },
      dedupeKey: 'aaa',
    })
    assert.equal(repeat.ok, false)
    assert.match(repeat.reason, /Duplicate/)

    // Fresh dedupeKey but inside the sampling window: dropped.
    const tooSoon = runtime.emitExternalEvent({
      sourceId: 'src-watch',
      payload: { head: 'bbb' },
      dedupeKey: 'bbb',
    })
    assert.equal(tooSoon.ok, false)
    assert.match(tooSoon.reason, /Sampling/)

    // Drops append nothing (sampling exists to protect the log).
    assert.equal(runtime.getKernelEvents({ type: 'external.watch' }).events.length, 1)

    // Payload discipline: reserved keys and oversized payloads are caller
    // errors, not drops.
    assert.throws(
      () => runtime.emitExternalEvent({ sourceId: 'src-watch', payload: { sessionId: 'x' } }),
      /reserved key/
    )
    assert.throws(
      () =>
        runtime.emitExternalEvent({
          sourceId: 'src-watch',
          payload: { blob: 'x'.repeat(17 * 1024) },
        }),
      /exceeds/
    )
    // The cap is bytes, not UTF-16 units: 9K three-byte chars ≈ 27KB of UTF-8.
    assert.throws(
      () =>
        runtime.emitExternalEvent({
          sourceId: 'src-watch',
          payload: { blob: '€'.repeat(9 * 1024) },
        }),
      /exceeds/
    )
    assert.throws(
      () => runtime.emitExternalEvent({ sourceId: 'src-watch', topic: 'other' }),
      /must match the source's declared topic/
    )
    assert.throws(
      () => runtime.emitExternalEvent({ sourceId: 'src-nope' }),
      /Unknown external source/
    )
  } finally {
    cleanup()
  }
})

test('a key-less accepted emit breaks the consecutive-dedupe chain', async () => {
  const { manager, cleanup } = harness('orrery-l2-dedupe-chain-')
  try {
    const runtime = manager()
    runtime.registerExternalSource({ id: 'src-chain', kind: 'manual', topic: 'chain' })

    assert.equal(
      runtime.emitExternalEvent({ sourceId: 'src-chain', dedupeKey: 'A', payload: {} }).ok,
      true
    )
    assert.equal(runtime.emitExternalEvent({ sourceId: 'src-chain', payload: {} }).ok, true)
    // 'A' is no longer the LAST accepted key — this is a fresh fact.
    assert.equal(
      runtime.emitExternalEvent({ sourceId: 'src-chain', dedupeKey: 'A', payload: {} }).ok,
      true,
      'a repeat across a key-less gap must not be treated as consecutive'
    )
    assert.equal(runtime.getKernelEvents({ type: 'external.chain' }).events.length, 3)
  } finally {
    cleanup()
  }
})

test('webhook tokens never leave through the read API but survive a restart', async () => {
  const { manager, cleanup } = harness('orrery-l2-token-plane-')
  try {
    const runtime = manager()
    const { token } = runtime.registerExternalSource({ id: 'src-hooked', kind: 'webhook', topic: 'hook' })
    assert.ok(token)

    assert.equal(runtime.getState().sourceTokens, undefined, 'getState must not expose tokens')
    runtime.killAll()

    const reloaded = manager()
    assert.equal(reloaded.verifyExternalSourceToken('src-hooked', token), true, 'token persisted with the snapshot')
    assert.equal(reloaded.verifyExternalSourceToken('src-hooked', 'wrong'), false)
    assert.equal(reloaded.getState().sourceTokens, undefined)
  } finally {
    cleanup()
  }
})

test('registration validates its inputs and subscriptions demand the exact pairing', async () => {
  const { manager, cleanup } = harness('orrery-l2-validate-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'target')

    assert.throws(() => runtime.registerExternalSource({ kind: 'cron' }), /kind must be one of/)
    assert.throws(
      () => runtime.registerExternalSource({ kind: 'manual', topic: 'timer' }),
      /reserved/
    )
    assert.throws(
      () => runtime.registerExternalSource({ kind: 'manual', topic: 'Not-A-Slug' }),
      /lowercase slug/
    )
    assert.throws(
      () => runtime.registerExternalSource({ kind: 'manual', minIntervalSeconds: -1 }),
      /minIntervalSeconds/
    )

    runtime.registerExternalSource({ id: 'src-a', kind: 'manual', topic: 'ping' })
    assert.throws(
      () => runtime.registerExternalSource({ id: 'src-a', kind: 'manual' }),
      /already exists/
    )

    // Pairing is bidirectional, like schedule ⟺ timer.
    assert.throws(
      () =>
        runtime.authorSubscription({
          sourceSessionId: target,
          on: { on: 'external' },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /external pattern requires source/
    )
    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'external', sourceId: 'src-a' },
          on: { on: 'finished' },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /external source requires the external pattern/
    )
    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'external', sourceId: 'src-a' },
          on: { on: 'external', topic: 'pong' },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /must match the source's topic/
    )
    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'external', sourceId: 'src-a' },
          on: { on: 'external', match: { count: 3 } },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /non-empty strings/
    )
    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'external', sourceId: 'src-a' },
          on: { on: 'external' },
          targetSessionId: target,
          action: { kind: 'deliver' },
        }),
      /requires action deliver\+activate/
    )
    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'external', sourceId: 'src-missing' },
          on: { on: 'external' },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /registered, active source/
    )
  } finally {
    cleanup()
  }
})

test('removing a source tombstones it, stops its edges, and rejects further emits', async () => {
  const { manager, cleanup } = harness('orrery-l2-remove-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'listener')

    runtime.registerExternalSource({ id: 'src-gone', kind: 'manual', topic: 'ping' })
    runtime.authorSubscription({
      id: 'sub-gone',
      source: { kind: 'external', sourceId: 'src-gone' },
      on: { on: 'external' },
      targetSessionId: target,
      action: { kind: 'deliver+activate' },
      gate: 'auto',
    })

    const removed = runtime.removeExternalSource({ sourceId: 'src-gone' })
    assert.equal(removed.ok, true)

    const state = runtime.getState()
    assert.equal(state.sources['src-gone'].state, 'removed', 'tombstone stays renderable')
    assert.equal(state.subscriptions['sub-gone'].state, 'stopped', 'participant parity')

    const emit = runtime.emitExternalEvent({ sourceId: 'src-gone', payload: {} })
    assert.equal(emit.ok, false)
    assert.match(emit.reason, /removed/i)

    assert.throws(
      () =>
        runtime.authorSubscription({
          source: { kind: 'external', sourceId: 'src-gone' },
          on: { on: 'external' },
          targetSessionId: target,
          action: { kind: 'deliver+activate' },
        }),
      /registered, active source/
    )

    // Removing twice is a no-op, not an error.
    assert.equal(runtime.removeExternalSource({ sourceId: 'src-gone' }).ok, true)
  } finally {
    cleanup()
  }
})

test('ingestion anchors recover from the log across a restart (events are truth)', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-l2-restart-')
  try {
    const runtime = manager()
    runtime.registerExternalSource({ id: 'src-git', kind: 'manual', topic: 'git' })
    const emitted = runtime.emitExternalEvent({
      sourceId: 'src-git',
      payload: { head: 'abc123' },
      dedupeKey: 'abc123',
    })
    assert.equal(emitted.ok, true)
    runtime.killAll()

    // Simulate a stale snapshot: wipe the cached anchors on disk, keeping
    // the kernel log intact.
    const store = new KernelStore({ databaseFile: kernelDatabaseFileFor(storageFile) })
    const snapshot = store.loadSnapshot()
    assert.ok(snapshot, 'the first manager persisted a snapshot')
    delete snapshot.state.sources['src-git'].lastEventAt
    delete snapshot.state.sources['src-git'].lastDedupeKey
    store.saveSnapshot(snapshot.state)
    store.close?.()

    const reloaded = manager({ storageFile })
    const source = reloaded.getState().sources['src-git']
    assert.ok(source.lastEventAt, 'lastEventAt reconciled from the log')
    assert.equal(source.lastDedupeKey, 'abc123', 'dedupe anchor reconciled from the log')

    // The recovered anchor still suppresses the duplicate.
    const repeat = reloaded.emitExternalEvent({
      sourceId: 'src-git',
      payload: { head: 'abc123' },
      dedupeKey: 'abc123',
    })
    assert.equal(repeat.ok, false)
    assert.match(repeat.reason, /Duplicate/)
  } finally {
    cleanup()
  }
})

test('a master-gated external firing tells the master what fired and what it carried', async () => {
  const { manager, cleanup } = harness('orrery-l2-master-gate-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'CI Fixer')
    const cluster = runtime.upsertCluster({ label: 'Gate Cluster', nodeIds: [worker] })
    const master = await runtime.createMasterForCluster({
      clusterId: cluster.clusterId,
      prompt: 'gate master bootstrap',
      label: 'Gate Master',
      cwd: process.cwd(),
    })
    await waitFor(
      'master idle',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )

    runtime.registerExternalSource({
      id: 'src-gated',
      kind: 'manual',
      topic: 'ci',
      label: 'CI status feed',
    })
    runtime.authorSubscription({
      id: 'sub-gated',
      source: { kind: 'external', sourceId: 'src-gated' },
      on: { on: 'external' },
      targetSessionId: worker,
      action: { kind: 'deliver+activate' },
      gate: 'master',
    })

    assert.equal(
      runtime.emitExternalEvent({
        sourceId: 'src-gated',
        payload: { status: 'failed', log: 'suite X exploded' },
      }).ok,
      true
    )

    // The gate request must name the source and carry the event payload —
    // "a finished turn from unknown" is not an informed decision.
    const request = await waitFor('master gate request', () => {
      const messages = runtime.getState().sessions[master.sessionId]?.messages ?? []
      return messages.map((message) => message.content ?? '').find((content) =>
        content.includes('Pending activation requires your decision')
      )
    })
    assert.match(request, /external event external\.ci/)
    assert.match(request, /CI status feed/)
    assert.match(request, /suite X exploded/)
    assert.doesNotMatch(request, /a finished turn/)
    assert.doesNotMatch(request, /from unknown/)
  } finally {
    cleanup()
  }
})

test('recovery takes the dedupe anchor from the log even when timestamps tie', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-l2-anchor-tie-')
  try {
    const runtime = manager()
    runtime.registerExternalSource({ id: 'src-tie', kind: 'manual', topic: 'tie' })
    assert.equal(
      runtime.emitExternalEvent({ sourceId: 'src-tie', dedupeKey: 'A', payload: {} }).ok,
      true
    )
    // The log's LATEST accepted event is key-less — it broke the chain.
    assert.equal(runtime.emitExternalEvent({ sourceId: 'src-tie', payload: {} }).ok, true)
    runtime.killAll()

    // A stale snapshot with the newest timestamp but the OLD key: recovery
    // must still take the key (its absence) from the log, not keep this.
    const store = new KernelStore({ databaseFile: kernelDatabaseFileFor(storageFile) })
    const snapshot = store.loadSnapshot()
    snapshot.state.sources['src-tie'].lastDedupeKey = 'A'
    store.saveSnapshot(snapshot.state)
    store.close?.()

    const reloaded = manager({ storageFile })
    assert.equal(reloaded.getState().sources['src-tie'].lastDedupeKey, undefined)
    assert.equal(
      reloaded.emitExternalEvent({ sourceId: 'src-tie', dedupeKey: 'A', payload: {} }).ok,
      true,
      'the repeat across the key-less gap stays accepted after a restart'
    )
  } finally {
    cleanup()
  }
})

test('the HTTP ingestion endpoint enforces tokens and maps unknown sources to 404', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-l2-http-'))
  const runtimeServer = await startRuntimeHttpServer({
    port: 0,
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  })
  try {
    const base = `http://${runtimeServer.host}:${runtimeServer.port}`
    const postJson = (url, body, headers = {}) =>
      fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })

    // Webhook-kind sources are born with a token (their endpoint faces out).
    const registered = await (
      await postJson('/api/runtime/sources', { id: 'src-hook', kind: 'webhook', topic: 'issues' })
    ).json()
    assert.ok(registered.token, 'webhook registration returns a token')
    assert.equal(
      registered.source.config.token,
      undefined,
      'the token is not part of the kernel-logged source'
    )

    const unauthorized = await postJson('/api/runtime/external-events', {
      sourceId: 'src-hook',
      payload: { title: 'crash on save' },
    })
    assert.equal(unauthorized.status, 401)

    const authorized = await postJson(
      '/api/runtime/external-events',
      { sourceId: 'src-hook', payload: { title: 'crash on save' } },
      { 'X-Orrery-Source-Token': registered.token }
    )
    assert.equal(authorized.status, 200)
    const accepted = await authorized.json()
    assert.equal(accepted.ok, true)
    assert.equal(accepted.type, 'external.issues')

    const missing = await postJson('/api/runtime/external-events', {
      sourceId: 'src-unknown',
      payload: {},
    })
    assert.equal(missing.status, 404)

    // Tokenless sources accept plain local emits (npm run emit path).
    await postJson('/api/runtime/sources', { id: 'src-local', kind: 'manual', topic: 'ping' })
    const local = await postJson('/api/runtime/external-events', {
      sourceId: 'src-local',
      payload: { note: 'hello' },
    })
    assert.equal(local.status, 200)
    assert.equal((await local.json()).ok, true)

    // The state read never carries transport secrets.
    const stateResponse = await fetch(`${base}/api/runtime/state`)
    assert.equal(stateResponse.status, 200)
    assert.equal((await stateResponse.json()).sourceTokens, undefined)

    const removedResponse = await postJson('/api/runtime/sources/src-hook/remove', {})
    assert.equal(removedResponse.status, 200)
    const removedMissing = await postJson('/api/runtime/sources/src-nope/remove', {})
    assert.equal(removedMissing.status, 404)
  } finally {
    await runtimeServer.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
