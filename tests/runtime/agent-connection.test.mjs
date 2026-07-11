import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
const prompt = readArg('-p') ?? ''
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const run = () => {
  emit({ type: 'assistant', session_id: backendSessionId, message: { content: [{ type: 'text', text: 'handled: ' + prompt.slice(0, 180) }] } })
  emit({ type: 'result', session_id: backendSessionId, result: 'done' })
}
if (prompt.includes('ORRERY_DELAY')) setTimeout(run, 500)
else run()
`

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function harness(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const fakeClaude = path.join(root, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  return {
    runtime,
    cleanup() {
      runtime.killAll()
      delete process.env.ORRERY_CLAUDE_BIN
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function createIdleSource(runtime, prompt = 'Produce a source result.') {
  const created = await runtime.createSession({
    label: 'Source Agent',
    prompt,
    cwd: process.cwd(),
    workMode: 'local',
    providerKind: 'legacy-claude-cli',
    providerInstanceId: 'legacy-claude-cli',
    runtimeSettings: { runtimeMode: 'approval-required' },
  })
  await waitFor('source Agent idle', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')
  return created.sessionId
}

function newTarget(position = { x: 640, y: 220 }) {
  return {
    kind: 'new',
    label: 'Receiving Agent',
    instruction: 'Inspect the delivered result.',
    cwd: process.cwd(),
    providerKind: 'legacy-claude-cli',
    providerInstanceId: 'legacy-claude-cli',
    runtimeSettings: { runtimeMode: 'approval-required' },
    position,
  }
}

test('current-result handoff delivers and activates immediately without leaving standing intent', async () => {
  const { runtime, cleanup } = harness('orrery-agent-connect-current-')
  try {
    const sourceSessionId = await createIdleSource(runtime)
    const connected = await runtime.connectAgents({
      sourceSessionId,
      target: newTarget(),
      timing: 'current-result',
      behavior: 'handoff-once',
      instruction: 'Continue from this result now.',
    })
    assert.deepEqual(connected.subscriptionIds, [])
    await waitFor('receiving Agent idle', () => runtime.getState().sessions[connected.targetSessionId]?.status === 'idle')
    const state = runtime.getState()
    const target = state.sessions[connected.targetSessionId]
    assert.equal(target.messages.filter((message) => message.role === 'assistant').length, 1)
    const delivered = runtime
      .getKernelEvents({ limit: 200 })
      .events.find((event) => event.type === 'delivered' && event.payload?.source === sourceSessionId && event.payload?.target === connected.targetSessionId)
    assert.ok(delivered, 'the current source artifact is delivered before activation')
    assert.deepEqual(state.nodes.find((node) => node.sessionId === connected.targetSessionId)?.position, { x: 640, y: 220 })
  } finally {
    cleanup()
  }
})

test('next-completion does not replay an old finish and fires once on the next turn', async () => {
  const { runtime, cleanup } = harness('orrery-agent-connect-next-')
  try {
    const sourceSessionId = await createIdleSource(runtime)
    const connected = await runtime.connectAgents({
      sourceSessionId,
      target: newTarget(),
      timing: 'next-completion',
      behavior: 'one-review',
      instruction: 'Review the next completed turn.',
    })
    const [subscriptionId] = connected.subscriptionIds
    await delay(100)
    let state = runtime.getState()
    assert.equal(state.subscriptions[subscriptionId].firings, 0)
    assert.equal(state.subscriptions[subscriptionId].state, 'active')
    assert.equal(
      state.sessions[connected.targetSessionId].messages.some((message) => message.role === 'assistant'),
      false,
    )

    await runtime.resumeSession({ sessionId: sourceSessionId, message: 'Produce the next result.' })
    await waitFor('next-completion relationship fires', () => {
      const next = runtime.getState()
      return next.subscriptions[subscriptionId]?.firings === 1 && next.sessions[connected.targetSessionId]?.status === 'idle'
    })
    state = runtime.getState()
    assert.equal(state.subscriptions[subscriptionId].state, 'stopped')
    assert.equal(state.sessions[connected.targetSessionId].messages.filter((message) => message.role === 'assistant').length, 1)
  } finally {
    cleanup()
  }
})

test('current-result review loop installs both directions and counts the immediate review as lap one', async () => {
  const { runtime, cleanup } = harness('orrery-agent-connect-loop-')
  try {
    const sourceSessionId = await createIdleSource(runtime)
    const connected = await runtime.connectAgents({
      sourceSessionId,
      target: newTarget(),
      timing: 'current-result',
      behavior: 'review-loop',
      instruction: 'Review against SPEC.md.',
      review: { blocking: { mode: 'p0-p1' }, maxLaps: 4 },
    })
    assert.equal(connected.subscriptionIds.length, 2)
    const [reviewPassId, reviewFixId] = connected.subscriptionIds
    await waitFor('immediate review completes', () => {
      const state = runtime.getState()
      return state.subscriptions[reviewPassId]?.firings === 1 && state.sessions[connected.targetSessionId]?.status === 'idle'
    })
    const state = runtime.getState()
    assert.equal(state.subscriptions[reviewPassId].state, 'active')
    assert.equal(state.subscriptions[reviewFixId].state, 'active')
    assert.deepEqual(state.subscriptions[reviewPassId].source, { kind: 'session', sessionId: sourceSessionId })
    assert.deepEqual(state.subscriptions[reviewFixId].source, { kind: 'session', sessionId: connected.targetSessionId })
    const loop = state.loops.find((candidate) => candidate.subscriptionIds.includes(reviewPassId))
    assert.equal(loop?.kind, 'review')
    assert.equal(loop?.lapCount, 1)
    assert.equal(loop?.lapCap, 4)
  } finally {
    cleanup()
  }
})

test('Relationship inspector stop contract returns the updated graph state', async () => {
  const { runtime, cleanup } = harness('orrery-agent-connect-stop-')
  try {
    const sourceSessionId = await createIdleSource(runtime)
    const connected = await runtime.connectAgents({
      sourceSessionId,
      target: newTarget(),
      timing: 'next-completion',
      behavior: 'keep-reviewing',
      instruction: 'Review future turns.',
    })
    const [subscriptionId] = connected.subscriptionIds
    const stopped = runtime.stopSubscription({ subscriptionId, reason: 'Stopped from the Relationship inspector.' })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.state.subscriptions[subscriptionId].state, 'stopped')
  } finally {
    cleanup()
  }
})

test('current-result rejects a running source instead of delivering a mid-turn workspace', async () => {
  const { runtime, cleanup } = harness('orrery-agent-connect-running-current-')
  try {
    const sourceSessionId = await createIdleSource(runtime)
    await runtime.resumeSession({ sessionId: sourceSessionId, message: 'ORRERY_DELAY continue editing.' })
    await waitFor('source Agent running', () => runtime.getState().sessions[sourceSessionId]?.status === 'running')
    const beforeCount = Object.keys(runtime.getState().sessions).length
    await assert.rejects(
      runtime.connectAgents({
        sourceSessionId,
        target: newTarget(),
        timing: 'current-result',
        behavior: 'handoff-once',
        instruction: 'Use the current result.',
      }),
      /Wait for next completion/,
    )
    assert.equal(Object.keys(runtime.getState().sessions).length, beforeCount, 'validation happens before creating a target')
  } finally {
    cleanup()
  }
})
