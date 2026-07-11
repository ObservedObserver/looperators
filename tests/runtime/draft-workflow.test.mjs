import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
emit({ type: 'assistant', session_id: backendSessionId, message: { content: [{ type: 'text', text: 'handled: ' + prompt.slice(0, 120) }] } })
emit({ type: 'result', session_id: backendSessionId, result: 'done' })
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

function node(label, prompt, position) {
  return {
    position,
    endpoint: {
      kind: 'new',
      label,
      prompt,
      cwd: process.cwd(),
      workMode: 'local',
      providerKind: 'legacy-claude-cli',
      providerInstanceId: 'legacy-claude-cli',
      runtimeSettings: { runtimeMode: 'approval-required' },
    },
  }
}

function graph(relationKind) {
  return {
    nodes: {
      coder: { id: 'coder', ...node('Draft Coder', 'Implement the draft task.', { x: 140, y: 180 }) },
      reviewer: { id: 'reviewer', ...node('Draft Reviewer', 'Inspect the delivered work.', { x: 540, y: 180 }) },
    },
    nodeOrder: ['coder', 'reviewer'],
    relations: {
      relation: {
        id: 'relation',
        kind: relationKind,
        sourceNodeId: 'coder',
        targetNodeId: 'reviewer',
        instruction: relationKind === 'review-loop' ? 'Review against SPEC.md.' : 'Continue with the delivered result.',
        ...(relationKind === 'review-loop' ? { review: { blocking: { mode: 'p0-p1' }, maxLaps: 4 } } : {}),
      },
    },
    relationOrder: ['relation'],
    nextNodeNumber: 3,
    nextRelationNumber: 2,
  }
}

test('static handoff Draft installs one-shot relation before root starts and preserves positions', async () => {
  const { runtime, cleanup } = harness('orrery-draft-handoff-')
  try {
    assert.equal(Object.keys(runtime.getState().sessions).length, 0)
    const started = await runtime.startDraftWorkflow({ graph: graph('handoff-once') })
    const coderId = started.mapping.nodeSessionIds.coder
    const reviewerId = started.mapping.nodeSessionIds.reviewer
    const [subscriptionId] = started.mapping.relationSubscriptionIds.relation

    await waitFor('one-shot target completes', () => {
      const state = runtime.getState()
      return state.subscriptions[subscriptionId]?.firings === 1 && state.sessions[reviewerId]?.status === 'idle'
    })
    const state = runtime.getState()
    assert.equal(state.subscriptions[subscriptionId].firings, 1)
    assert.equal(state.subscriptions[subscriptionId].state, 'stopped')
    assert.deepEqual(state.nodes.find((entry) => entry.sessionId === coderId)?.position, { x: 140, y: 180 })
    assert.deepEqual(state.nodes.find((entry) => entry.sessionId === reviewerId)?.position, { x: 540, y: 180 })
    assert.match(
      state.sessions[reviewerId].messages.find((message) => message.role === 'user' && /Continue with/.test(message.content))?.content ?? '',
      /new delivery/i,
    )

    const events = runtime.getKernelEvents({ limit: 500 }).events
    const authored = events.find((event) => event.type === 'subscription.authored' && event.payload?.subscription?.id === subscriptionId)
    const coderFinished = events.find((event) => event.type === 'session.finished' && event.payload?.sessionId === coderId)
    assert.ok(authored && coderFinished && authored.seq < coderFinished.seq)
    assert.equal(
      events.some((event) => JSON.stringify(event.payload).includes('draft-agent')),
      false,
      'renderer Draft ids never enter kernel facts',
    )
  } finally {
    cleanup()
  }
})

test('trigger-on-completion stays active after its first firing', async () => {
  const { runtime, cleanup } = harness('orrery-draft-trigger-')
  try {
    const started = await runtime.startDraftWorkflow({ graph: graph('trigger-on-completion') })
    const reviewerId = started.mapping.nodeSessionIds.reviewer
    const [subscriptionId] = started.mapping.relationSubscriptionIds.relation
    await waitFor('trigger target completes', () => {
      const state = runtime.getState()
      return state.subscriptions[subscriptionId]?.firings === 1 && state.sessions[reviewerId]?.status === 'idle'
    })
    const subscription = runtime.getState().subscriptions[subscriptionId]
    assert.equal(subscription.firings, 1)
    assert.equal(subscription.state, 'active')
    assert.equal(subscription.stop, undefined)
  } finally {
    cleanup()
  }
})

test('static Review Draft compiles through the P1 relationship shape before Coder finishes', async () => {
  const { runtime, cleanup } = harness('orrery-draft-review-')
  try {
    const started = await runtime.startDraftWorkflow({ graph: graph('review-loop') })
    const coderId = started.mapping.nodeSessionIds.coder
    const reviewerId = started.mapping.nodeSessionIds.reviewer
    const relationIds = started.mapping.relationSubscriptionIds.relation
    assert.equal(relationIds.length, 2)
    await waitFor('Reviewer first review completes', () => {
      const state = runtime.getState()
      const session = state.sessions[reviewerId]
      return (
        state.subscriptions[relationIds[0]]?.firings === 1 && session?.status === 'idle' && session.messages.some((message) => message.role === 'assistant')
      )
    })
    const state = runtime.getState()
    const loop = state.loops.find((entry) => entry.subscriptionIds.includes(relationIds[0]))
    assert.equal(loop?.kind, 'review')
    assert.equal(loop?.lapCap, 4)
    const reviewerTurn = state.sessions[reviewerId].messages.find(
      (message) => message.role === 'user' && /Blocking rule/.test(message.content),
    )
    assert.match(reviewerTurn?.content ?? '', /Inspect the delivered work/)
    const events = runtime.getKernelEvents({ limit: 500 }).events
    const authoredSeqs = events
      .filter((event) => event.type === 'subscription.authored' && relationIds.includes(event.payload?.subscription?.id))
      .map((event) => event.seq)
    const coderFinished = events.find((event) => event.type === 'session.finished' && event.payload?.sessionId === coderId)
    assert.equal(authoredSeqs.length, 2)
    assert.ok(coderFinished && Math.max(...authoredSeqs) < coderFinished.seq)
  } finally {
    cleanup()
  }
})

test('static Review Draft binds a new Reviewer to the Coder final worktree cwd', async () => {
  const { runtime, cleanup } = harness('orrery-draft-review-worktree-')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-draft-review-repo-'))
  try {
    fs.writeFileSync(path.join(repo, 'SPEC.md'), 'Review the same checkout.\n')
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync(
      'git',
      ['-c', 'user.name=orrery-test', '-c', 'user.email=test@orrery.local', 'commit', '-m', 'baseline'],
      { cwd: repo },
    )
    const draft = graph('review-loop')
    draft.nodes.coder.endpoint.cwd = repo
    draft.nodes.coder.endpoint.workMode = 'worktree'
    draft.nodes.reviewer.endpoint.cwd = os.tmpdir()

    const started = await runtime.startDraftWorkflow({ graph: draft })
    const state = runtime.getState()
    const coder = state.sessions[started.mapping.nodeSessionIds.coder]
    const reviewer = state.sessions[started.mapping.nodeSessionIds.reviewer]
    assert.notEqual(coder.cwd, repo, 'Coder runs in its managed worktree')
    assert.equal(reviewer.cwd, coder.cwd, 'Reviewer shares the exact final Coder checkout')
  } finally {
    cleanup()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
