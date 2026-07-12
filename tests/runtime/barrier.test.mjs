import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { kernelDatabaseFileFor } from '../../dist-electron/electron/runtime/kernelStore.js'
import { deterministicProviderAdapters } from './support/deterministic-provider.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function envelope({ phase = 'review', generation = 1, activation = 'a', attempt = 1 } = {}) {
  return {
    workflowId: 'workflow-1', workflowVersion: 1, runId: 'run-1', phaseId: phase,
    activationId: activation, attempt,
    correlationKey: `workflow-1:v1:run-1:${phase}:g${generation}`,
  }
}

async function create(runtime, { id, mode = 'all', expected = ['a', 'b'], quorum, env = envelope(), deadline } = {}) {
  return runtime.dispatchCommand({
    commandId: `create-${id}`, idempotencyKey: `create-${id}`, kind: 'create_barrier', actor: { kind: 'human' },
    input: { barrierId: id, mode, expectedParticipantKeys: expected, quorum, envelope: env, deadline },
  })
}

async function arrive(runtime, id, participantKey, env, eventId) {
  return runtime.dispatchCommand({
    commandId: `arrive-${id}-${eventId}`, idempotencyKey: `arrive-${id}-${eventId}`,
    kind: 'arrive_barrier', actor: { kind: 'runtime' },
    input: { barrierId: id, participantKey, envelope: env, eventId },
  })
}

test('correlation generations never mix and an all Barrier releases exactly once', async () => {
  const runtime = new RuntimeSessionManager()
  try {
    const g1 = envelope({ generation: 1 })
    const g2 = envelope({ generation: 2 })
    await create(runtime, { id: 'g1', env: g1 })
    await create(runtime, { id: 'g2', env: g2 })
    await arrive(runtime, 'g1', 'a', { ...g1, activationId: 'g1-a' }, 'g1-a')
    await arrive(runtime, 'g2', 'b', { ...g2, activationId: 'g2-b' }, 'g2-b')
    assert.equal(runtime.getState().barriers.g1.status, 'pending')
    assert.equal(runtime.getState().barriers.g2.status, 'pending')
    await assert.rejects(
      arrive(runtime, 'g1', 'b', { ...g2, activationId: 'wrong-generation' }, 'wrong-generation'),
      /correlation/,
    )
    const released = await arrive(runtime, 'g1', 'b', { ...g1, activationId: 'g1-b' }, 'g1-b')
    assert.equal(released.released, true)
    assert.equal(released.barrier.status, 'released')
    await arrive(runtime, 'g1', 'b', { ...g1, activationId: 'g1-b-retry', attempt: 2 }, 'g1-b-retry')
    assert.equal(
      runtime.getKernelEvents({ type: 'barrier.released' }).events.filter((event) => event.payload.barrierId === 'g1').length,
      1,
    )
    await assert.rejects(
      arrive(runtime, 'g1', 'unknown', { ...g2, activationId: 'foreign-terminal' }, 'foreign-terminal'),
      /correlation|expect participant/,
    )
    const terminalReplay = await arrive(
      runtime, 'g1', 'b', { ...g1, activationId: 'valid-terminal-replay', attempt: 3 }, 'valid-terminal-replay',
    )
    assert.equal(terminalReplay.released, false)
    assert.equal(terminalReplay.alreadyReleased, true)
  } finally {
    runtime.killAll()
  }
})

test('retry attempts replace one participant arrival instead of double-counting quorum', async () => {
  const runtime = new RuntimeSessionManager()
  try {
    const env = envelope({ phase: 'quorum' })
    await create(runtime, { id: 'quorum', mode: 'quorum', expected: ['a', 'b', 'c'], quorum: 2, env })
    await arrive(runtime, 'quorum', 'a', { ...env, activationId: 'a1', attempt: 1 }, 'a1')
    await arrive(runtime, 'quorum', 'a', { ...env, activationId: 'a2', attempt: 2 }, 'a2')
    assert.equal(runtime.getState().barriers.quorum.status, 'pending')
    assert.equal(Object.keys(runtime.getState().barriers.quorum.arrivals).length, 1)
    assert.equal(runtime.getState().barriers.quorum.arrivals.a.attempt, 2)
    await arrive(runtime, 'quorum', 'b', { ...env, activationId: 'b1' }, 'b1')
    assert.equal(runtime.getState().barriers.quorum.status, 'released')

    const anyEnv = envelope({ phase: 'any' })
    await create(runtime, { id: 'any', mode: 'any', expected: ['a', 'b'], env: anyEnv })
    await arrive(runtime, 'any', 'b', { ...anyEnv, activationId: 'any-b' }, 'any-b')
    assert.equal(runtime.getState().barriers.any.status, 'released')
  } finally {
    runtime.killAll()
  }
})

test('Barrier cancellation and restart-recovered timeout have readable durable terminal states', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-barrier-timeout-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const cancelEnv = envelope({ phase: 'cancel' })
    await create(runtime, { id: 'cancel', env: cancelEnv })
    await runtime.dispatchCommand({
      commandId: 'cancel-barrier', idempotencyKey: 'cancel-barrier', kind: 'cancel_barrier', actor: { kind: 'human' },
      input: { barrierId: 'cancel', reason: 'User changed the workflow.' },
    })
    assert.equal(runtime.getState().barriers.cancel.status, 'cancelled')
    assert.equal(runtime.getState().barriers.cancel.terminalReason, 'User changed the workflow.')

    const timeoutEnv = envelope({ phase: 'timeout' })
    await create(runtime, {
      id: 'timeout', env: timeoutEnv,
      deadline: new Date(Date.now() + 250).toISOString(),
    })
    runtime.killAll()
    runtime = new RuntimeSessionManager({ storageFile })
    for (let index = 0; index < 30 && runtime.getState().barriers.timeout.status === 'pending'; index += 1) {
      await delay(25)
    }
    assert.equal(runtime.getState().barriers.timeout.status, 'timed-out')
    assert.match(runtime.getState().barriers.timeout.terminalReason, /deadline elapsed/)
    assert.equal(runtime.getKernelEvents({ type: 'barrier.timed-out' }).events.length, 1)

    const futureEnv = envelope({ phase: 'future-timeout' })
    await create(runtime, {
      id: 'future-timeout', env: futureEnv,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    })
    await runtime.dispatchCommand({
      commandId: 'premature-expire', idempotencyKey: 'premature-expire',
      kind: 'expire_barrier', actor: { kind: 'runtime' },
      input: { barrierId: 'future-timeout', correlationKey: futureEnv.correlationKey },
    })
    assert.equal(runtime.getState().barriers['future-timeout'].status, 'pending')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Execution Envelope is durable command provenance and is copied onto emitted events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-envelope-command-'))
  const storageFile = path.join(root, 'state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  try {
    const env = envelope({ phase: 'command-provenance', activation: 'command-activation' })
    await runtime.dispatchCommand({
      commandId: 'enveloped-create', idempotencyKey: 'enveloped-create',
      kind: 'create_barrier', actor: { kind: 'runtime' }, execution: env,
      input: { barrierId: 'enveloped', mode: 'all', expectedParticipantKeys: ['a'], envelope: env },
    })
    const db = new DatabaseSync(kernelDatabaseFileFor(storageFile), { readOnly: true })
    const row = db.prepare('SELECT execution FROM command_records WHERE command_id = ?').get('enveloped-create')
    db.close()
    assert.deepEqual(JSON.parse(row.execution), env)
    const created = runtime.getKernelEvents({ type: 'barrier.created' }).events.find(
      (event) => event.payload.barrier?.barrierId === 'enveloped',
    )
    assert.deepEqual(created.payload.execution, env)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Execution Envelope survives activation into the provider terminal fact', async () => {
  const runtime = new RuntimeSessionManager({ providerAdapters: deterministicProviderAdapters() })
  try {
    const env = envelope({ phase: 'provider-turn', activation: 'create-command' })
    const created = await runtime.dispatchCommand({
      commandId: 'enveloped-session', idempotencyKey: 'enveloped-session',
      kind: 'create_session', actor: { kind: 'human' }, execution: env,
      input: { prompt: 'Finish this correlated turn.', cwd: process.cwd() },
    })
    for (let index = 0; index < 100 && runtime.getState().sessions[created.sessionId]?.status !== 'idle'; index += 1) {
      await delay(10)
    }
    assert.equal(runtime.getState().sessions[created.sessionId].status, 'idle')
    const finished = runtime.getKernelEvents({ type: 'session.finished' }).events.find(
      (event) => event.payload.sessionId === created.sessionId,
    )
    assert.equal(finished.payload.execution.correlationKey, env.correlationKey)
    assert.equal(finished.payload.execution.phaseId, env.phaseId)
    assert.equal(finished.payload.execution.activationId, finished.payload.turnId)
  } finally {
    runtime.killAll()
  }
})

test('Execution Envelope crosses a scheduler pending slot into the downstream terminal fact', async () => {
  const runtime = new RuntimeSessionManager({ providerAdapters: deterministicProviderAdapters() })
  try {
    const source = await runtime.createSession({ prompt: 'Source ready.', cwd: process.cwd() })
    const target = await runtime.createSession({ prompt: 'Target ready.', cwd: process.cwd() })
    for (let index = 0; index < 100 && [source.sessionId, target.sessionId].some(
      (id) => runtime.getState().sessions[id]?.status !== 'idle'); index += 1) await delay(10)
    runtime.authorSubscription({
      sourceSessionId: source.sessionId,
      on: { on: 'finished' },
      targetSessionId: target.sessionId,
      action: { kind: 'deliver+activate', topic: 'correlated', note: 'Continue correlated work.' },
      gate: 'auto', stop: { maxFirings: 1 },
    })
    const env = envelope({ phase: 'scheduled-downstream', activation: 'source-resume' })
    await runtime.dispatchCommand({
      commandId: 'correlated-source-resume', idempotencyKey: 'correlated-source-resume',
      kind: 'resume_session', actor: { kind: 'human' }, execution: env,
      input: { sessionId: source.sessionId, message: 'Produce the correlated source result.' },
    })
    let downstream
    for (let index = 0; index < 200 && !downstream; index += 1) {
      downstream = runtime.getKernelEvents({ type: 'session.finished' }).events.find(
        (event) => event.payload.sessionId === target.sessionId && event.payload.execution,
      )
      if (!downstream) await delay(10)
    }
    assert.equal(downstream.payload.execution.correlationKey, env.correlationKey)
    assert.equal(downstream.payload.execution.activationId, downstream.payload.turnId)
    const delivery = runtime.getKernelEvents({ type: 'delivered' }).events.find(
      (event) => event.payload.target === target.sessionId && event.payload.execution,
    )
    assert.equal(delivery.payload.execution.correlationKey, env.correlationKey)
  } finally {
    runtime.killAll()
  }
})

test('malformed or correlation-changing command replay envelopes are rejected', async () => {
  const runtime = new RuntimeSessionManager()
  try {
    await assert.rejects(runtime.dispatchCommand({
      commandId: 'bad-envelope', kind: 'create_barrier', actor: { kind: 'runtime' },
      execution: { workflowId: 'incomplete' }, input: {},
    }), /valid ExecutionEnvelope/)
    const env = envelope({ phase: 'replay' })
    await create(runtime, { id: 'replay-envelope', env })
    await assert.rejects(runtime.dispatchCommand({
      commandId: 'create-replay-envelope', idempotencyKey: 'create-replay-envelope',
      kind: 'create_barrier', actor: { kind: 'human' },
      execution: { ...env, correlationKey: `${env.correlationKey}:changed` },
      input: { barrierId: 'replay-envelope', mode: 'all', expectedParticipantKeys: ['a'], envelope: env },
    }), /replay identity mismatch/)
  } finally {
    runtime.killAll()
  }
})
