import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  ControlVersionConflictError,
  KernelStore,
} from '../../dist-electron/electron/runtime/kernelStore.js'
import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { startRuntimeHttpServer } from '../../dist-electron/electron/runtimeHttpServer.js'
import {
  deterministicProviderAdapters,
  deterministicRuntimeSessionManager,
} from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 5000) {
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

function eventsOfType(log, type) {
  return log.filter((event) => event.type === type)
}

test('kernel event log records mutations with actor, cause, and monotonic seq', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-kernel-log-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }

  try {
    const runtime = manager({ storageFile })

    // Human creates and resumes a session; provider lifecycle chains to it.
    const created = await runtime.createSession({
      prompt: 'kernel log smoke',
      label: 'Kernel Smoke',
      cwd: process.cwd(),
    })
    const sessionId = created.sessionId
    await waitFor(
      'session to finish',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )

    let log = runtime.getKernelEvents({ limit: 2000 }).events
    const createdEvent = eventsOfType(log, 'session.created').find(
      (event) => event.payload.sessionId === sessionId
    )
    assert.ok(createdEvent, 'session.created must be logged')
    assert.equal(createdEvent.actor.kind, 'human')
    assert.equal(createdEvent.payload.label, 'Kernel Smoke')

    const finishedEvent = eventsOfType(log, 'session.finished').find(
      (event) => event.payload.sessionId === sessionId
    )
    assert.ok(finishedEvent, 'session.finished must be logged')
    assert.equal(finishedEvent.actor.kind, 'provider')
    assert.equal(
      finishedEvent.causeId,
      createdEvent.id,
      'provider finish must chain to the activation that started the run'
    )

    await runtime.resumeSession({ sessionId, message: 'resume for kernel log' })
    await waitFor(
      'resumed session to finish',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )
    log = runtime.getKernelEvents({ limit: 2000 }).events
    const resumedEvent = eventsOfType(log, 'activated').find(
      (event) => event.payload.sessionId === sessionId
    )
    assert.ok(resumedEvent, 'activated must be logged for the resume')
    assert.equal(resumedEvent.actor.kind, 'human')
    assert.ok(
      eventsOfType(log, 'session.finished').some(
        (event) => event.causeId === resumedEvent.id
      ),
      'second finish must chain to the resume'
    )

    // Scope + master assignment.
    const second = await runtime.createSession({
      prompt: 'kernel log second session',
      label: 'Kernel Second',
      cwd: process.cwd(),
    })
    await waitFor(
      'second session to finish',
      () => runtime.getState().sessions[second.sessionId]?.status === 'idle'
    )
    const cluster = runtime.upsertCluster({
      label: 'Kernel Cluster',
      nodeIds: [sessionId],
    })
    const master = await runtime.createMasterForCluster({
      clusterId: cluster.clusterId,
      prompt: 'kernel log master',
      label: 'Kernel Master',
      cwd: process.cwd(),
    })
    await waitFor(
      'master to finish',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )

    log = runtime.getKernelEvents({ limit: 2000 }).events
    assert.ok(
      eventsOfType(log, 'scope.upserted').some(
        (event) => event.payload.clusterId === cluster.clusterId
      ),
      'scope.upserted must be logged'
    )
    assert.ok(
      eventsOfType(log, 'role.assigned').some(
        (event) =>
          event.payload.clusterId === cluster.clusterId &&
          event.payload.masterSessionId === master.sessionId &&
          event.actor.kind === 'human'
      ),
      'role.assigned must be logged'
    )

    // Membrane commands carry the caller's identity.
    const membraneChild = await runtime.handleMembraneRequest({
      tool: 'create_session',
      source: second.sessionId,
      input: { prompt: 'kernel log membrane child', label: 'Membrane Child' },
    })
    await waitFor(
      'membrane child to finish',
      () =>
        runtime.getState().sessions[membraneChild.sessionId]?.status === 'idle'
    )
    await runtime.handleMembraneRequest({
      tool: 'report',
      source: second.sessionId,
      input: { type: 'info', payload: { note: 'kernel log info report' } },
    })

    log = runtime.getKernelEvents({ limit: 2000 }).events
    const membraneCreated = eventsOfType(log, 'session.created').find(
      (event) => event.payload.sessionId === membraneChild.sessionId
    )
    assert.ok(membraneCreated, 'membrane creation must be logged')
    assert.equal(membraneCreated.actor.kind, 'agent')
    assert.equal(membraneCreated.actor.ref, second.sessionId)

    const reportEvent = eventsOfType(log, 'report.received').find(
      (event) => event.payload.from === second.sessionId
    )
    assert.ok(reportEvent, 'report.received must be logged')
    assert.equal(reportEvent.actor.kind, 'agent')
    assert.equal(reportEvent.actor.ref, second.sessionId)

    // Edges, archive, freeze, kill.
    const { edge } = runtime.linkSessions({
      source: sessionId,
      target: second.sessionId,
      label: 'kernel-link',
      reason: 'kernel log link',
    })
    runtime.removeEdge({ edgeId: edge.edgeId })
    runtime.archiveSession({ sessionId: second.sessionId })
    runtime.freeze({ target: second.sessionId, reason: 'kernel log freeze' })

    const delayed = await runtime.createSession({
      prompt: 'ORRERY_DELAY kernel log kill target',
      label: 'Kernel Delay',
      cwd: process.cwd(),
    })
    await waitFor(
      'delayed session to run',
      () => runtime.getState().sessions[delayed.sessionId]?.status === 'running'
    )
    const killResult = runtime.killSession(delayed.sessionId)
    assert.equal(killResult.ok, true)

    log = runtime.getKernelEvents({ limit: 2000 }).events
    assert.ok(
      eventsOfType(log, 'edge.linked').some(
        (event) => event.payload.edgeId === edge.edgeId
      ),
      'edge.linked must be logged'
    )
    assert.ok(
      eventsOfType(log, 'edge.removed').some(
        (event) => event.payload.edgeId === edge.edgeId
      ),
      'edge.removed must be logged'
    )
    assert.ok(
      eventsOfType(log, 'session.archived').some(
        (event) => event.payload.sessionId === second.sessionId
      ),
      'session.archived must be logged'
    )
    const freezeEvent = eventsOfType(log, 'freeze.applied').find(
      (event) => event.payload.targetId === second.sessionId
    )
    assert.ok(freezeEvent, 'freeze.applied must be logged')
    assert.equal(freezeEvent.actor.kind, 'human')
    assert.equal(freezeEvent.reason, 'kernel log freeze')
    const killedEvent = eventsOfType(log, 'session.killed').find(
      (event) => event.payload.sessionId === delayed.sessionId
    )
    assert.ok(killedEvent, 'session.killed must be logged')
    assert.equal(killedEvent.actor.kind, 'human')

    // Seq is monotonic and the cursor paginates.
    const seqs = log.map((event) => event.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    const midpoint = seqs[Math.floor(seqs.length / 2)]
    const tail = runtime.getKernelEvents({ since: midpoint }).events
    assert.deepEqual(
      tail.map((event) => event.seq),
      seqs.filter((seq) => seq > midpoint)
    )
    const limited = runtime.getKernelEvents({ limit: 3 }).events
    assert.equal(limited.length, 3)
    const typed = runtime.getKernelEvents({ type: 'session.created' }).events
    assert.ok(typed.length >= 3)
    assert.ok(typed.every((event) => event.type === 'session.created'))

    // The log is durable across restarts.
    const latestSeq = runtime.getKernelEvents().latestSeq
    const restored = manager({ storageFile })
    const restoredLog = restored.getKernelEvents({ limit: 2000 })
    assert.ok(restoredLog.latestSeq >= latestSeq, 'restart must keep the log')
    assert.ok(
      restoredLog.events.some((event) => event.id === createdEvent.id),
      'events must be durable across restarts'
    )
  } finally {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('the newest store connection owns the snapshot slot', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-kernel-owner-'))
  const databaseFile = path.join(tempRoot, 'ownership.sqlite')
  const first = new KernelStore({ databaseFile })
  const second = new KernelStore({ databaseFile })

  try {
    second.saveSnapshot({ marker: 'second' })
    // The stale connection's late write must not clobber the newer snapshot.
    first.saveSnapshot({ marker: 'stale-first' })
    assert.equal(second.loadSnapshot().state.marker, 'second')

    // Events stay append-only for every connection (facts are never dropped).
    first.appendEvent({ type: 'probe', actor: { kind: 'runtime' } })
    assert.ok(
      second.listEvents().some((event) => event.type === 'probe'),
      'events from a stale connection must still land'
    )
  } finally {
    first.close()
    second.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('in-memory stores keep events but skip snapshots', () => {
  const store = new KernelStore({})
  try {
    const event = store.appendEvent({ type: 'probe', actor: { kind: 'runtime' } })
    assert.equal(event.seq, 1)
    store.saveSnapshot({ marker: 'unused' })
    assert.equal(store.loadSnapshot(), undefined)
    assert.equal(store.listEvents().length, 1)
  } finally {
    store.close()
  }
})

test('control command atomically commits durable state, audit events, and idempotency record', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-control-command-'))
  const databaseFile = path.join(tempRoot, 'control.sqlite')
  const store = new KernelStore({ databaseFile })
  try {
    const committed = store.commitControlCommand({
      state: { version: 8, marker: 'committed' },
      events: [
        {
          id: 'event-control-1',
          ts: '2026-07-12T00:00:00.000Z',
          type: 'scope.upserted',
          actor: { kind: 'human' },
          payload: { clusterId: 'scope-1' },
        },
      ],
      command: {
        commandId: 'command-control-1',
        idempotencyKey: 'scope-create-1',
        kind: 'upsert_scope',
        actor: { kind: 'human' },
        expectedVersion: 0,
      },
      result: { clusterId: 'scope-1' },
    })
    assert.equal(committed.duplicate, false)
    assert.equal(committed.events.length, 1)
    assert.equal(committed.events[0].id, 'event-control-1')
    assert.equal(committed.record.committedVersion, 1)

    const durable = store.loadDurableState()
    assert.equal(durable.version, 1)
    assert.equal(durable.eventSeq, committed.events[0].seq)
    assert.equal(durable.state.controlVersion, 1)
    assert.equal(durable.state.marker, 'committed')
    assert.equal(store.loadSnapshot().state.marker, 'committed', 'snapshot reads resolve the durable authority')
    assert.deepEqual(
      store.getCommandRecord({ idempotencyKey: 'scope-create-1' }).result,
      { clusterId: 'scope-1' },
    )
  } finally {
    store.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('control command idempotency returns the first result without duplicating state or events', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-control-idempotency-'))
  const store = new KernelStore({ databaseFile: path.join(tempRoot, 'control.sqlite') })
  try {
    const first = store.commitControlCommand({
      state: { version: 8, marker: 'first' },
      events: [{ type: 'edge.linked', actor: { kind: 'human' }, payload: { edgeId: 'edge-1' } }],
      command: {
        commandId: 'command-first',
        idempotencyKey: 'link-once',
        kind: 'link_sessions',
        actor: { kind: 'human' },
      },
      result: { edgeId: 'edge-1' },
    })
    const repeated = store.commitControlCommand({
      state: { version: 8, marker: 'must-not-land' },
      events: [{ type: 'edge.linked', actor: { kind: 'human' }, payload: { edgeId: 'edge-2' } }],
      command: {
        commandId: 'command-retry',
        idempotencyKey: 'link-once',
        kind: 'link_sessions',
        actor: { kind: 'human' },
        expectedVersion: 0,
      },
      result: { edgeId: 'edge-2' },
    })
    assert.equal(repeated.duplicate, true)
    assert.deepEqual(repeated.record.result, { edgeId: 'edge-1' })
    assert.equal(store.getControlVersion(), 1)
    assert.equal(store.eventCount(), 1)
    assert.equal(store.loadDurableState().state.marker, 'first')
    assert.equal(first.record.commandId, 'command-first')
  } finally {
    store.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('expectedVersion conflicts and failed event inserts roll back the whole control transaction', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-control-conflict-'))
  const store = new KernelStore({ databaseFile: path.join(tempRoot, 'control.sqlite') })
  try {
    store.commitControlCommand({
      state: { version: 8, marker: 'base' },
      command: {
        commandId: 'command-base',
        kind: 'freeze',
        actor: { kind: 'human' },
      },
    })
    assert.throws(
      () => store.commitControlCommand({
        state: { version: 8, marker: 'conflict' },
        events: [{ type: 'freeze.applied', actor: { kind: 'human' } }],
        command: {
          commandId: 'command-conflict',
          kind: 'freeze',
          actor: { kind: 'human' },
          expectedVersion: 0,
        },
      }),
      (error) => error instanceof ControlVersionConflictError && error.actualVersion === 1,
    )
    assert.throws(
      () => store.commitControlCommand({
        state: { version: 8, marker: 'invalid-event' },
        events: [{ type: '', actor: { kind: 'human' } }],
        command: {
          commandId: 'command-invalid-event',
          kind: 'freeze',
          actor: { kind: 'human' },
          expectedVersion: 1,
        },
      }),
      /event type is required/i,
    )
    assert.equal(store.getControlVersion(), 1)
    assert.equal(store.eventCount(), 0)
    assert.equal(store.loadDurableState().state.marker, 'base')
    assert.equal(store.getCommandRecord({ commandId: 'command-conflict' }), undefined)
    assert.equal(store.getCommandRecord({ commandId: 'command-invalid-event' }), undefined)
  } finally {
    store.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('workflow deployment journal advances durably and rejects stale stage writers', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-deployment-journal-'))
  const databaseFile = path.join(tempRoot, 'control.sqlite')
  let store = new KernelStore({ databaseFile })
  try {
    store.createWorkflowDeployment({
      deploymentId: 'deployment-1',
      workflowId: 'workflow-1',
      commandId: 'command-1',
      journal: { kind: 'plan-council', createdSessionIds: [] },
    })
    store.updateWorkflowDeployment('deployment-1', {
      expectedStage: 'prepared',
      stage: 'resources-created',
      journal: { createdSessionIds: ['session-a', 'session-b'] },
    })
    assert.throws(
      () => store.updateWorkflowDeployment('deployment-1', {
        expectedStage: 'prepared',
        stage: 'graph-committed',
      }),
      /stage conflict/i,
    )
    store.close()
    store = new KernelStore({ databaseFile })
    const restored = store.getWorkflowDeployment('deployment-1')
    assert.equal(restored.stage, 'resources-created')
    assert.deepEqual(restored.journal.createdSessionIds, ['session-a', 'session-b'])
    assert.equal(store.listWorkflowDeployments({ status: 'in_progress' }).length, 1)
    store.commitControlCommand({
      state: { version: 8, workflow: 'committed' },
      command: {
        commandId: 'deployment-final-command',
        kind: 'start_plan_council',
        actor: { kind: 'human' },
      },
      deploymentFinalizations: [{
        deploymentId: 'deployment-1',
        stage: 'active',
        status: 'completed',
        journal: { activatedAt: 'now' },
      }],
    })
    assert.equal(store.getWorkflowDeployment('deployment-1').status, 'completed')

    store.createWorkflowDeployment({
      deploymentId: 'deployment-rollback',
      workflowId: 'workflow-rollback',
      commandId: 'command-rollback',
    })
    assert.throws(
      () => store.commitControlCommand({
        state: { version: 8, workflow: 'must-not-commit' },
        events: [{ type: '', actor: { kind: 'human' } }],
        command: {
          commandId: 'deployment-final-command-fails',
          kind: 'start_review_workflow',
          actor: { kind: 'human' },
        },
        deploymentFinalizations: [{
          deploymentId: 'deployment-rollback',
          stage: 'active',
          status: 'completed',
        }],
      }),
      /event type is required/i,
    )
    assert.equal(store.getWorkflowDeployment('deployment-rollback').status, 'in_progress')
    store.updateWorkflowDeployment('deployment-1', {
      expectedStage: 'active',
      stage: 'aborted',
      status: 'aborted',
      journal: { reason: 'recovered after restart' },
    })
    store.updateWorkflowDeployment('deployment-rollback', {
      stage: 'aborted',
      status: 'aborted',
      journal: { reason: 'rollback verified' },
    })
    assert.equal(store.listWorkflowDeployments({ status: 'in_progress' }).length, 0)
  } finally {
    store.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('durable effect completion and its audit fact commit atomically', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-effect-completion-'))
  const store = new KernelStore({ databaseFile: path.join(tempRoot, 'control.sqlite') })
  try {
    store.commitControlCommand({
      state: { version: 8 },
      command: {
        commandId: 'cleanup-effect-command',
        kind: 'cleanup_channels',
        actor: { kind: 'human' },
      },
      outboxEffects: [{
        effectId: 'cleanup-effect-1',
        kind: 'channel-cleanup',
        payload: { sessionIds: ['session-a'] },
      }],
    })
    assert.throws(
      () => store.completeEffectWithEvent('cleanup-effect-1', {
        type: '',
        actor: { kind: 'runtime' },
      }),
      /event type is required/i,
    )
    assert.equal(store.listPendingEffects().length, 1)
    assert.equal(store.listEvents({ type: 'channel.cleanup.completed' }).length, 0)

    const event = store.completeEffectWithEvent('cleanup-effect-1', {
      type: 'channel.cleanup.completed',
      actor: { kind: 'runtime' },
      payload: { effectId: 'cleanup-effect-1' },
    })
    assert.ok(event?.seq)
    assert.equal(store.listPendingEffects().length, 0)
    assert.equal(store.listEvents({ type: 'channel.cleanup.completed' }).length, 1)
  } finally {
    store.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('legacy snapshot state is promoted to the durable runtime_state authority on restart', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-durable-state-migration-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const created = await runtime.createSession({
      prompt: 'legacy migration fixture',
      label: 'Legacy worker',
      cwd: process.cwd(),
    })
    runtime.upsertCluster({
      clusterId: 'legacy-scope',
      label: 'Legacy scope',
      nodeIds: [created.sessionId],
    })
    await waitFor(
      'legacy migration worker idle',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle',
    )
    runtime.killAll()
    const database = new DatabaseSync(storageFile.replace(/\.json$/, '.sqlite'))
    const durableBeforeMigration = database
      .prepare('SELECT event_seq, updated_at, state FROM runtime_state WHERE singleton = 1')
      .get()
    database.prepare('DELETE FROM snapshots').run()
    database
      .prepare('INSERT INTO snapshots (seq, ts, state) VALUES (?, ?, ?)')
      .run(
        durableBeforeMigration.event_seq,
        durableBeforeMigration.updated_at,
        durableBeforeMigration.state,
      )
    database.prepare('DELETE FROM runtime_state').run()
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM runtime_state').get().count, 0)
    database.close()

    runtime = new RuntimeSessionManager({ storageFile })
    assert.equal(runtime.getState().clusters['legacy-scope'].label, 'Legacy scope')
    const verified = new DatabaseSync(storageFile.replace(/\.json$/, '.sqlite'))
    const durable = verified.prepare('SELECT version, state FROM runtime_state WHERE singleton = 1').get()
    assert.ok(durable)
    assert.equal(JSON.parse(durable.state).clusters['legacy-scope'].label, 'Legacy scope')
    verified.close()
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('dispatchCommand validates command kind and actor', async () => {
  const runtime = new RuntimeSessionManager({})
  try {
    await assert.rejects(
      () => runtime.dispatchCommand({ kind: 'no-such-command', actor: { kind: 'human' } }),
      /Unknown kernel command/
    )
    await assert.rejects(
      () => runtime.dispatchCommand({ kind: 'freeze', actor: { kind: 'wizard' } }),
      /valid actor/
    )
    await assert.rejects(
      () =>
        runtime.dispatchCommand({
          kind: 'freeze',
          actor: { kind: 'master', ref: 'no-such-session' },
        }),
      /actor session is unknown/
    )
  } finally {
    runtime.killAll()
  }
})

test('dispatchCommand applies expectedVersion and idempotency before mutating runtime state', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-dispatch-envelope-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') })
  try {
    const created = await runtime.createSession({
      prompt: 'dispatch envelope fixture',
      label: 'Envelope target',
      cwd: process.cwd(),
    })
    await waitFor('envelope target idle', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')

    const first = await runtime.dispatchCommand({
      commandId: 'freeze-command-1',
      idempotencyKey: 'freeze-target-once',
      expectedVersion: 0,
      kind: 'freeze',
      actor: { kind: 'human' },
      input: { target: created.sessionId, reason: 'transactional freeze' },
    })
    assert.equal(runtime.getState().controlVersion, 1)
    assert.equal(first.ok, true)
    assert.equal(first.state.controlVersion, 1)

    const repeated = await runtime.dispatchCommand({
      commandId: 'freeze-command-retry',
      idempotencyKey: 'freeze-target-once',
      expectedVersion: 0,
      kind: 'freeze',
      actor: { kind: 'human' },
      input: { target: created.sessionId, reason: 'must not replace first result' },
    })
    assert.equal(repeated.ok, true)
    assert.equal(repeated.state.controlVersion, 1)
    assert.equal(runtime.getState().controlVersion, 1)
    assert.equal(
      runtime.getKernelEvents({ type: 'freeze.applied' }).events.filter(
        (event) => event.payload.targetId === created.sessionId,
      ).length,
      1,
    )
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'freeze-command-cross-actor',
        idempotencyKey: 'freeze-target-once',
        kind: 'freeze',
        actor: { kind: 'master', ref: created.sessionId },
        input: { target: created.sessionId },
      }),
      /replay identity mismatch/,
    )
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'freeze-command-wrong-kind',
        idempotencyKey: 'freeze-target-once',
        kind: 'unfreeze',
        actor: { kind: 'human' },
        input: { target: created.sessionId },
      }),
      /replay identity mismatch/,
    )

    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'freeze-command-conflict',
        expectedVersion: 0,
        kind: 'freeze',
        actor: { kind: 'human' },
        input: { target: created.sessionId, reason: 'stale writer' },
      }),
      /version conflict: expected 0, current 1/i,
    )
    assert.equal(runtime.getState().controlVersion, 1)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('replayed create_session and author_subscription commands do not duplicate resources', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-command-resource-idempotency-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') })
  try {
    const target = await runtime.createSession({
      prompt: 'idempotency target',
      label: 'Idempotency target',
      cwd: process.cwd(),
    })
    await waitFor('idempotency target idle', () => runtime.getState().sessions[target.sessionId]?.status === 'idle')
    const createCommand = {
      commandId: 'create-resource-1',
      idempotencyKey: 'create-resource-once',
      expectedVersion: 0,
      kind: 'create_session',
      actor: { kind: 'human' },
      input: {
        prompt: 'idempotent source',
        label: 'Idempotent source',
        cwd: process.cwd(),
      },
    }
    const created = await runtime.dispatchCommand(createCommand)
    const replayedCreate = await runtime.dispatchCommand({
      ...createCommand,
      commandId: 'create-resource-retry',
    })
    assert.equal(replayedCreate.sessionId, created.sessionId)
    assert.equal(Object.keys(runtime.getState().sessions).length, 2)
    await waitFor('idempotent source idle', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')

    const subscriptionCommand = {
      commandId: 'subscription-resource-1',
      idempotencyKey: 'subscription-resource-once',
      expectedVersion: 1,
      kind: 'author_subscription',
      actor: { kind: 'human' },
      input: {
        id: 'idempotent-subscription',
        sourceSessionId: created.sessionId,
        on: { on: 'finished' },
        targetSessionId: target.sessionId,
        action: { kind: 'deliver+activate', note: 'idempotent activation' },
        gate: 'human',
      },
    }
    const authored = await runtime.dispatchCommand(subscriptionCommand)
    const replayedSubscription = await runtime.dispatchCommand({
      ...subscriptionCommand,
      commandId: 'subscription-resource-retry',
    })
    assert.equal(replayedSubscription.subscription.id, authored.subscription.id)
    assert.equal(Object.keys(runtime.getState().subscriptions).length, 1)
    assert.equal(runtime.getState().controlVersion, 2)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('concurrent commands with the same expectedVersion commit exactly one writer', async () => {
  const runtime = new RuntimeSessionManager({})
  try {
    const left = await runtime.createSession({ prompt: 'left', label: 'Left', cwd: process.cwd() })
    const right = await runtime.createSession({ prompt: 'right', label: 'Right', cwd: process.cwd() })
    const results = await Promise.allSettled([
      runtime.dispatchCommand({
        commandId: 'concurrent-left',
        expectedVersion: 0,
        kind: 'freeze',
        actor: { kind: 'human' },
        input: { target: left.sessionId },
      }),
      runtime.dispatchCommand({
        commandId: 'concurrent-right',
        expectedVersion: 0,
        kind: 'freeze',
        actor: { kind: 'human' },
        input: { target: right.sessionId },
      }),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.match(
      results.find((result) => result.status === 'rejected').reason.message,
      /version conflict/i,
    )
    assert.equal(runtime.getState().controlVersion, 1)
    assert.equal(runtime.getState().nodes.filter((node) => node.frozen).length, 1)
  } finally {
    runtime.killAll()
  }
})

test('runtime readers never observe control state before its audit event transaction commits', async () => {
  const runtime = new RuntimeSessionManager({ controlCommandCommitDelayMs: 100 })
  try {
    const created = await runtime.createSession({
      prompt: 'transaction visibility fixture',
      label: 'Visibility target',
      cwd: process.cwd(),
    })
    const committing = runtime.dispatchCommand({
      commandId: 'visibility-freeze',
      expectedVersion: 0,
      kind: 'freeze',
      actor: { kind: 'human' },
      input: { target: created.sessionId, reason: 'atomic visibility' },
    })
    await delay(25)
    assert.notEqual(
      runtime.getState().nodes.find((node) => node.sessionId === created.sessionId)?.frozen,
      true,
      'uncommitted working state stays invisible',
    )
    assert.equal(
      runtime.getKernelEvents({ type: 'freeze.applied' }).events.length,
      0,
      'audit event is also absent before commit',
    )
    assert.notEqual(
      runtime.getGraphTopology().nodes.find((node) => node.sessionId === created.sessionId)?.frozen,
      true,
      'graph topology stays on the committed snapshot',
    )
    assert.notEqual(
      runtime.listSessionSummaries().sessions.find((session) => session.sessionId === created.sessionId)?.frozen,
      true,
      'session summaries stay on the committed snapshot',
    )
    await committing
    assert.equal(
      runtime.getState().nodes.find((node) => node.sessionId === created.sessionId)?.frozen,
      true,
    )
    assert.equal(runtime.getKernelEvents({ type: 'freeze.applied' }).events.length, 1)
  } finally {
    runtime.killAll()
  }
})

test('loop projections and timelines stay committed while a ring edge is uncommitted', async () => {
  const runtime = new RuntimeSessionManager({ controlCommandCommitDelayMs: 100 })
  try {
    const left = await runtime.createSession({ prompt: 'left', label: 'Left', cwd: process.cwd() })
    const right = await runtime.createSession({ prompt: 'right', label: 'Right', cwd: process.cwd() })
    await waitFor('loop projection fixtures idle', () =>
      [left.sessionId, right.sessionId].every(
        (sessionId) => runtime.getState().sessions[sessionId]?.status === 'idle',
      ),
    )
    await runtime.dispatchCommand({
      commandId: 'loop-visibility-forward',
      kind: 'author_subscription',
      actor: { kind: 'human' },
      input: {
        id: 'loop-visibility-forward',
        sourceSessionId: left.sessionId,
        on: { on: 'finished' },
        targetSessionId: right.sessionId,
        action: { kind: 'deliver+activate' },
        gate: 'auto',
        stop: { maxFirings: 3 },
      },
    })
    const committing = runtime.dispatchCommand({
      commandId: 'loop-visibility-reverse',
      expectedVersion: 1,
      kind: 'author_subscription',
      actor: { kind: 'human' },
      input: {
        id: 'loop-visibility-reverse',
        sourceSessionId: right.sessionId,
        on: { on: 'finished' },
        targetSessionId: left.sessionId,
        action: { kind: 'deliver+activate' },
        gate: 'auto',
        stop: { maxFirings: 3 },
      },
    })
    await delay(25)
    assert.equal(runtime.getState().loops.length, 0)
    assert.throws(
      () => runtime.getLoopTimeline({ loopId: 'loop-visibility-forward' }),
      /Unknown loop/,
    )
    await committing
    assert.equal(runtime.getState().loops.length, 1)
  } finally {
    runtime.killAll()
  }
})

test('kernel-events endpoint serves the log over HTTP', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-kernel-endpoint-'))
  const runtimeServer = await startRuntimeHttpServer({
    port: 0,
    storageFile: path.join(tempRoot, 'runtime-state.json'),
    providerAdapters: deterministicProviderAdapters(),
  })

  try {
    const base = `http://${runtimeServer.host}:${runtimeServer.port}`
    const runtime = runtimeServer.runtime

    const created = await runtime.createSession({
      prompt: 'kernel endpoint smoke',
      label: 'Kernel Endpoint',
      cwd: process.cwd(),
    })
    await waitFor(
      'session to finish',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const response = await fetch(`${base}/api/runtime/kernel-events`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(Array.isArray(body.events))
    assert.ok(body.latestSeq >= 2)
    assert.ok(
      body.events.some(
        (event) =>
          event.type === 'session.created' &&
          event.payload.sessionId === created.sessionId
      )
    )

    const firstSeq = body.events[0].seq
    const paged = await (
      await fetch(`${base}/api/runtime/kernel-events?since=${firstSeq}&limit=1`)
    ).json()
    assert.equal(paged.events.length, 1)
    assert.equal(paged.events[0].seq, firstSeq + 1)

    const typed = await (
      await fetch(`${base}/api/runtime/kernel-events?type=session.finished`)
    ).json()
    assert.ok(typed.events.length >= 1)
    assert.ok(typed.events.every((event) => event.type === 'session.finished'))
  } finally {
    await runtimeServer.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
