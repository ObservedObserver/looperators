import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { KernelStore } from '../../dist-electron/electron/runtime/kernelStore.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { startRuntimeHttpServer } from '../../dist-electron/electron/runtimeHttpServer.js'

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const prompt = readArg('-p') ?? ''
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
if (prompt.includes('ORRERY_DELAY')) {
  setInterval(() => {}, 1000)
} else {
  emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
}
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
  installFakeClaude(tempRoot)
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
      source: master.sessionId,
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
    assert.equal(membraneCreated.actor.kind, 'master')
    assert.equal(membraneCreated.actor.ref, master.sessionId)

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
    delete process.env.ORRERY_CLAUDE_BIN
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

test('kernel-events endpoint serves the log over HTTP', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-kernel-endpoint-'))
  installFakeClaude(tempRoot)
  const runtimeServer = await startRuntimeHttpServer({
    port: 0,
    storageFile: path.join(tempRoot, 'runtime-state.json'),
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
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
