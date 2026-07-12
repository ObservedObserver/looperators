import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ContextChannelStore } from '../../dist-electron/electron/runtime/contextChannel.js'
import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

function setProviderBinary(runtime, binaryPath) {
  runtime.upsertProviderInstance({
    kind: 'claude-code',
    providerInstanceId: 'default-claude-sdk',
    label: 'Test Claude SDK',
    binaryPath,
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForIdle(runtime, sessionId, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (runtime.getState().sessions[sessionId]?.status === 'idle') {
      return
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${sessionId} to be idle`)
}

function kernelEvents(runtime) {
  return runtime.getKernelEvents({ limit: 2000 }).events
}

test('channel store: immutable seq-numbered deliveries with topic supersession', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-store-'))
  const store = new ContextChannelStore({ root: tempRoot })

  try {
    const first = store.deliver({
      target: 'b',
      from: 'a',
      fromLabel: 'Coder',
      topic: 'diff',
      entries: [{ name: 'diff.patch', content: 'first diff' }],
    })
    const second = store.deliver({
      target: 'b',
      from: 'a',
      topic: 'diff',
      entries: [{ name: 'diff.patch', content: 'second diff' }],
    })
    const noteOnly = store.deliver({ target: 'b', from: 'human', note: 'FYI' })

    assert.deepEqual(
      store.manifest('b').map((entry) => entry.seq),
      [1, 2, 3]
    )
    assert.equal(fs.readFileSync(first.files[0], 'utf8'), 'first diff')
    assert.equal(fs.readFileSync(second.files[0], 'utf8'), 'second diff')

    const unread = store.unread('b')
    assert.deepEqual(
      unread.current.map((entry) => entry.seq),
      [2, 3],
      'the newer diff supersedes the older one; topic-less stays current'
    )
    assert.deepEqual(
      unread.superseded.map((entry) => entry.seq),
      [1]
    )

    store.markRead('b', 3)
    assert.equal(store.unread('b').current.length, 0)
    assert.ok(noteOnly.files[0].endsWith('note.md'))

    // The inbox (and thus the provider read allowlist) can never escape the
    // channel root through a crafted session id.
    for (const evil of ['../x', '/etc', 'a/b', '..', '']) {
      assert.throws(() => store.channelDir(evil), /Invalid channel session id/)
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('channel retention removes only old read deliveries and preserves unread/latest-topic material', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-retention-'))
  const store = new ContextChannelStore({ root: tempRoot })
  try {
    const first = store.deliver({
      target: 'target',
      from: 'a',
      topic: 'plan',
      entries: [{ name: 'plan.md', content: 'old plan' }],
    })
    store.deliver({
      target: 'target',
      from: 'a',
      topic: 'plan',
      entries: [{ name: 'plan.md', content: 'new plan' }],
    })
    store.deliver({
      target: 'target',
      from: 'b',
      topic: 'review',
      entries: [{ name: 'review.md', content: 'latest review' }],
    })
    store.deliver({ target: 'target', from: 'human', note: 'recent read note' })
    store.markRead('target', 4)
    const unread = store.deliver({ target: 'target', from: 'human', note: 'must stay unread' })
    await delay(5)

    const cleaned = store.cleanup('target', {
      maxReadAgeDays: 0,
      maxReadEntries: 1,
      keepLatestReadPerTopic: true,
    })
    assert.equal(cleaned.removedDeliveries, 1)
    assert.ok(cleaned.removedBytes > 0)
    assert.equal(fs.existsSync(first.files[0]), false)
    assert.equal(fs.existsSync(unread.files[0]), true)
    assert.deepEqual(
      store.manifest('target').map((entry) => entry.seq),
      [2, 3, 4, 5],
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('deliver + activate: data plane facts, deterministic preamble, read tracking', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-kernel-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  setProviderBinary(runtime, '/usr/bin/true')

  try {
    const a = await runtime.createSession({
      prompt: 'channel smoke source',
      label: 'Source',
      cwd: process.cwd(),
    })
    const b = await runtime.createSession({
      prompt: 'channel smoke target',
      label: 'Target',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, a.sessionId)
    await waitForIdle(runtime, b.sessionId)

    // Membrane deliver from A to B: pure data plane, B stays idle.
    const delivered = await runtime.handleMembraneRequest({
      tool: 'deliver',
      source: a.sessionId,
      input: { sessionId: b.sessionId, topic: 'progress', content: 'work so far' },
    })
    assert.equal(delivered.ok, true)
    assert.equal(runtime.getState().sessions[b.sessionId].status, 'idle')
    assert.ok(fs.existsSync(delivered.delivery.files[0]))

    const deliveredEvent = kernelEvents(runtime).find(
      (event) =>
        event.type === 'delivered' && event.payload.target === b.sessionId
    )
    assert.ok(deliveredEvent, 'delivered must be a kernel fact')
    assert.equal(deliveredEvent.actor.kind, 'agent')
    assert.equal(deliveredEvent.payload.source, a.sessionId)
    assert.equal(deliveredEvent.payload.topic, 'progress')

    // Activate B: message = note + deterministic preamble listing the file.
    await runtime.activateSession({
      sessionId: b.sessionId,
      note: 'Process the delivery.',
    })
    await waitForIdle(runtime, b.sessionId)

    const bSession = runtime.getState().sessions[b.sessionId]
    const activationMessage = [...bSession.messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(activationMessage.content, /Process the delivery\./)
    assert.match(activationMessage.content, /1 new delivery/)
    assert.ok(
      activationMessage.content.includes(delivered.delivery.files[0]),
      'the activation message lists the delivered file path'
    )

    const activatedEvent = kernelEvents(runtime).find(
      (event) =>
        event.type === 'activated' && event.payload.sessionId === b.sessionId
    )
    assert.ok(activatedEvent, 'activated must be a kernel fact')
    assert.deepEqual(activatedEvent.payload.deliveries, [1])

    // The delivery is now read: a second activation must not re-list it.
    await runtime.activateSession({
      sessionId: b.sessionId,
      note: 'Anything new?',
    })
    await waitForIdle(runtime, b.sessionId)
    const secondMessage = [...runtime.getState().sessions[b.sessionId].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.equal(secondMessage.content, 'Anything new?')

    // A bare activate with no note and no unread deliveries is an error.
    await assert.rejects(
      () => runtime.activateSession({ sessionId: b.sessionId }),
      /requires a note or pending channel deliveries/
    )
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('resume decomposes into deliver + activate; plain resumes stay verbatim', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-resume-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  setProviderBinary(runtime, '/usr/bin/true')

  try {
    const target = await runtime.createSession({
      prompt: 'resume decomposition target',
      label: 'Target',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, target.sessionId)

    // Plain resume without context: the message is exactly what was sent.
    await runtime.resumeSession({
      sessionId: target.sessionId,
      message: 'plain resume message',
    })
    await waitForIdle(runtime, target.sessionId)
    const plainMessage = [...runtime.getState().sessions[target.sessionId].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.equal(plainMessage.content, 'plain resume message')
    assert.equal(
      kernelEvents(runtime).filter((event) => event.type === 'delivered').length,
      0,
      'a context-less resume delivers nothing'
    )

    // Resume with context: the context lands in the channel, not the chat.
    await runtime.resumeSession({
      sessionId: target.sessionId,
      message: 'review the attached context',
      context: 'THE-BIG-DIFF-CONTENT',
    })
    await waitForIdle(runtime, target.sessionId)

    const contextMessage = [...runtime.getState().sessions[target.sessionId].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(contextMessage.content, /review the attached context/)
    assert.ok(
      !contextMessage.content.includes('THE-BIG-DIFF-CONTENT'),
      'context is not inlined into the chat message'
    )
    const log = kernelEvents(runtime)
    const deliveredEvent = log.find((event) => event.type === 'delivered')
    assert.ok(deliveredEvent, 'the context ride became a delivered fact')
    assert.equal(deliveredEvent.payload.topic, 'context')
    const deliveredFile = deliveredEvent.payload.files[0]
    assert.equal(fs.readFileSync(deliveredFile, 'utf8'), 'THE-BIG-DIFF-CONTENT')
    assert.ok(
      contextMessage.content.includes(deliveredFile),
      'the activation message points at the delivered file'
    )

    const activatedEvent = log.find(
      (event) =>
        event.type === 'activated' &&
        event.payload.sessionId === target.sessionId &&
        (event.payload.deliveries ?? []).length > 0
    )
    assert.ok(activatedEvent, 'the resume activation consumed the delivery')
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('create_session pre-seeds the channel with handoff context (§8.1)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-create-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  setProviderBinary(runtime, '/usr/bin/true')

  try {
    const source = await runtime.createSession({
      prompt: 'handoff source',
      label: 'Upstream',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, source.sessionId)

    const handedOff = await runtime.createSession({
      prompt: 'Read the handoff delivery listed below and follow it.',
      label: 'Downstream',
      cwd: process.cwd(),
      sourceSessionId: source.sessionId,
      context: 'HANDOFF-PAYLOAD-XYZ',
    })
    await waitForIdle(runtime, handedOff.sessionId)

    const session = runtime.getState().sessions[handedOff.sessionId]
    const bootstrap = session.messages[0]
    assert.ok(
      !bootstrap.content.includes('HANDOFF-PAYLOAD-XYZ'),
      'handoff content stays out of the chat history'
    )
    assert.match(bootstrap.content, /1 new delivery/)

    const log = kernelEvents(runtime)
    const createdEvent = log.find(
      (event) =>
        event.type === 'session.created' &&
        event.payload.sessionId === handedOff.sessionId
    )
    const deliveredEvent = log.find(
      (event) =>
        event.type === 'delivered' &&
        event.payload.target === handedOff.sessionId
    )
    assert.ok(deliveredEvent, 'the handoff is a delivered fact')
    assert.equal(deliveredEvent.payload.topic, 'handoff')
    assert.equal(deliveredEvent.payload.source, source.sessionId)
    assert.ok(
      deliveredEvent.seq > createdEvent.seq,
      'the log reads create → deliver (§8.1)'
    )
    assert.equal(deliveredEvent.causeId, createdEvent.id)
    assert.equal(
      fs.readFileSync(deliveredEvent.payload.files[0], 'utf8'),
      'HANDOFF-PAYLOAD-XYZ'
    )
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a spawn failure does not swallow unread deliveries', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-spawnfail-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  setProviderBinary(runtime, '/usr/bin/true')

  try {
    const target = await runtime.createSession({
      prompt: 'spawn failure target',
      label: 'Target',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, target.sessionId)

    await runtime.deliverToSession({
      sessionId: target.sessionId,
      topic: 'notes',
      content: 'must survive a failed activation',
    })

    // Break the provider binary so the activation run cannot start.
    setProviderBinary(runtime, path.join(tempRoot, 'missing-binary'))
    await runtime
      .activateSession({ sessionId: target.sessionId, note: 'doomed' })
      .catch(() => undefined)
    const startedAt = Date.now()
    while (
      runtime.getState().sessions[target.sessionId]?.status !== 'failed' &&
      Date.now() - startedAt < 5000
    ) {
      await delay(25)
    }
    assert.equal(runtime.getState().sessions[target.sessionId].status, 'failed')

    // Restore the binary; the next activation must re-list the delivery.
    setProviderBinary(runtime, '/usr/bin/true')
    await runtime.activateSession({
      sessionId: target.sessionId,
      note: 'retry after failure',
    })
    await waitForIdle(runtime, target.sessionId)
    const retryMessage = [...runtime.getState().sessions[target.sessionId].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(
      retryMessage.content,
      /1 new delivery/,
      'the delivery the agent never saw must be re-listed'
    )
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a failed control commit kills the spawned run and restores channel read state', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-commit-failure-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({
    storageFile,
    controlCommandCommitDelayMs: 150,
  })
  let recovered
  try {
    const target = await runtime.createSession({
      prompt: 'commit failure target',
      label: 'Commit failure target',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, target.sessionId)
    await runtime.deliverToSession({
      sessionId: target.sessionId,
      topic: 'notes',
      content: 'must remain unread if the control commit loses ownership',
    })

    const committing = runtime.dispatchCommand({
      commandId: 'activation-owner-loss',
      kind: 'activate',
      actor: { kind: 'human' },
      input: { sessionId: target.sessionId, note: 'start then lose the commit' },
    })
    await delay(30)
    recovered = new RuntimeSessionManager({ storageFile })
    await assert.rejects(committing, /newer runtime owns/i)

    const manifest = new ContextChannelStore({
      root: path.join(tempRoot, 'channels'),
    }).manifest(target.sessionId)
    assert.equal(manifest.length, 1)
    assert.equal(manifest[0].readAt, undefined)
    assert.equal(recovered.getState().sessions[target.sessionId]?.status, 'idle')
    assert.equal(
      recovered.getWorkflowDeployments().deployments.find(
        (deployment) => deployment.commandId === 'activation-owner-loss',
      )?.status,
      'aborted',
    )
  } finally {
    recovered?.killAll()
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('durable cleanup outbox replays a commit-before-effect crash on restart', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-cleanup-outbox-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({
    storageFile,
    controlCommandCrashBeforeEffectDrain: true,
  })
  let recovered
  try {
    const target = await runtime.createSession({
      prompt: 'cleanup outbox target',
      label: 'Cleanup outbox target',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, target.sessionId)
    const store = new ContextChannelStore({ root: path.join(tempRoot, 'channels') })
    const delivery = store.deliver({
      target: target.sessionId,
      from: 'human',
      entries: [{ name: 'old.md', content: 'old read payload' }],
    })
    store.markRead(target.sessionId, delivery.seq)

    await assert.rejects(
      runtime.cleanupChannels({
        commandId: 'cleanup-outbox-crash',
        sessionId: target.sessionId,
        maxReadAgeDays: 0,
        maxReadEntries: 0,
        keepLatestReadPerTopic: false,
      }),
      /crash before durable effect drain/i,
    )
    assert.equal(fs.existsSync(delivery.files[0]), true)

    recovered = new RuntimeSessionManager({ storageFile })
    assert.equal(fs.existsSync(delivery.files[0]), false)
    assert.equal(store.manifest(target.sessionId).length, 0)
    assert.ok(
      recovered.getKernelEvents({ type: 'channel.cleanup.completed' }).events.some(
        (event) => event.payload.commandId === 'cleanup-outbox-crash',
      ),
    )
  } finally {
    recovered?.killAll()
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('deliver without content forwards the artifact bundle', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channel-bundle-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  setProviderBinary(runtime, '/usr/bin/true')

  try {
    const a = await runtime.createSession({
      prompt: 'bundle source',
      label: 'Bundle Source',
      cwd: process.cwd(),
    })
    const b = await runtime.createSession({
      prompt: 'bundle target',
      label: 'Bundle Target',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, a.sessionId)
    await waitForIdle(runtime, b.sessionId)

    const result = await runtime.handleMembraneRequest({
      tool: 'deliver',
      source: a.sessionId,
      input: { sessionId: b.sessionId, topic: 'progress' },
    })
    const summaryFile = result.delivery.files.find((file) =>
      file.endsWith('turn-summary.md')
    )
    assert.ok(summaryFile, 'the artifact bundle includes the turn summary')
    assert.match(fs.readFileSync(summaryFile, 'utf8'), /handled:/)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
