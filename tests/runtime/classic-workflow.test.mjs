import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(label, predicate, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function harness(prefix, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const runtime = new RuntimeSessionManager({ ...options, storageFile: path.join(root, 'state.json') })
  return { root, runtime, cleanup() { runtime.killAll(); fs.rmSync(root, { recursive: true, force: true }) } }
}

function fresh(label, prompt) {
  return {
    kind: 'new', label, prompt, cwd: process.cwd(), workMode: 'local',
    providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
    runtimeSettings: { runtimeMode: 'approval-required' },
  }
}

function participantSnapshot(root, runtime, sessionId) {
  const state = runtime.getState()
  const manifestFile = path.join(root, 'channels', sessionId, 'manifest.json')
  return {
    session: state.sessions[sessionId],
    node: state.nodes.find((node) => node.sessionId === sessionId),
    channel: fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : [],
  }
}

test('cold-start Handoff installs one-shot intent before Source runs and leaves no standing automation after delivery', async () => {
  const { runtime, cleanup } = harness('orrery-classic-handoff-')
  try {
    const result = await runtime.startHandoffWorkflow({
      source: fresh('Source', 'Produce the result.'),
      target: fresh('Receiver', 'Wait for a delivered result.'),
      note: 'Continue exactly once.',
    })
    assert.equal(result.createdSessionIds.length, 2)
    assert.equal(result.subscriptionIds.length, 1)
    await waitFor('Receiver completes', () => {
      const state = runtime.getState()
      return state.sessions[result.targetSessionId]?.status === 'idle' && state.subscriptions[result.subscriptionIds[0]]?.firings === 1
    })
    const state = runtime.getState()
    assert.equal(state.subscriptions[result.subscriptionIds[0]].state, 'stopped')
    assert.equal(state.sessions[result.targetSessionId].messages.some((message) => message.role === 'user' && /new delivery/i.test(message.content)), true)
  } finally { cleanup() }
})

test('existing-source Handoff uses the current result immediately and leaves no subscription', async () => {
  const { runtime, cleanup } = harness('orrery-classic-handoff-current-')
  try {
    const source = await runtime.createSession({
      prompt: 'Produce the current result.', cwd: process.cwd(), providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
    })
    await waitFor('Source becomes idle', () => runtime.getState().sessions[source.sessionId]?.status === 'idle')
    const result = await runtime.startHandoffWorkflow({
      source: { kind: 'existing', sessionId: source.sessionId, prompt: 'Use the current result.' },
      target: fresh('Receiver', 'Receive the current result.'),
      note: 'Continue immediately.',
    })
    assert.deepEqual(result.subscriptionIds, [])
    assert.deepEqual(result.deliveredTo, [result.targetSessionId])
    await waitFor('Receiver becomes idle', () => runtime.getState().sessions[result.targetSessionId]?.status === 'idle')
  } finally { cleanup() }
})

test('cold-start Goal installs Worker/Judge ring before Worker finishes', async () => {
  const { runtime, cleanup } = harness('orrery-classic-goal-')
  try {
    const result = await runtime.startGoalWorkflow({
      worker: fresh('Worker', 'Make progress.'), goal: 'The requested result exists.', maxLaps: 3,
      judgeProviderInstanceId: 'default-claude-sdk', judgeModel: 'judge-model',
    })
    assert.equal(result.createdSessionIds.length, 2)
    assert.equal(result.subscriptionIds.length, 2)
    const events = runtime.getKernelEvents({ limit: 500 }).events
    const authored = events.filter((event) => event.type === 'subscription.authored' && result.subscriptionIds.includes(event.payload?.subscription?.id))
    const workerFinished = await waitFor('Worker finishes', () => runtime.getKernelEvents({ limit: 500 }).events.find((event) => event.type === 'session.finished' && event.payload?.sessionId === result.workerSessionId))
    assert.equal(authored.length, 2)
    assert.ok(Math.max(...authored.map((event) => event.seq)) < workerFinished.seq)
    assert.equal(runtime.getState().loops.find((loop) => loop.subscriptionIds.includes(result.subscriptionIds[0]))?.kind, 'goal')
    assert.equal(runtime.getState().sessions[result.judgeSessionId].runtimeSettings.model, 'judge-model')
  } finally { cleanup() }
})

test('provider start failure rejects atomically and removes cold-start Handoff/Goal intent', async () => {
  for (const kind of ['handoff', 'goal']) {
    const { root, runtime, cleanup } = harness(`orrery-classic-${kind}-failure-`)
    try {
      runtime.upsertProviderInstance({
        providerInstanceId: 'default-claude-sdk',
        kind: 'claude-code',
        label: 'Missing Claude SDK',
        binaryPath: path.join(root, 'missing-provider-binary'),
      })
      await assert.rejects(
        kind === 'handoff'
          ? runtime.startHandoffWorkflow({ source: fresh('Source', 'Start.'), target: fresh('Receiver', 'Wait.'), note: 'Continue.' })
          : runtime.startGoalWorkflow({ worker: fresh('Worker', 'Start.'), goal: 'Done.', maxLaps: 3 }),
      )
      const state = runtime.getState()
      assert.equal(Object.keys(state.sessions).length, 0, `${kind} removes created participants`)
      assert.equal(Object.keys(state.subscriptions ?? {}).length, 0, `${kind} removes authored intent`)
    } finally { cleanup() }
  }
})

test('cross-provider Judge start failure rejects Goal atomically', async () => {
  const { root, runtime, cleanup } = harness('orrery-classic-goal-judge-failure-')
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Broken Codex Judge',
      binaryPath: path.join(root, 'missing-codex-binary'),
    })

    await assert.rejects(
      runtime.startGoalWorkflow({
        worker: fresh('Worker', 'Start.'),
        goal: 'Done.',
        maxLaps: 3,
        judgeProviderInstanceId: 'default-codex',
        judgeModel: 'gpt-5.1-codex-mini',
      }),
      /Judge|ENOENT|missing-codex-binary/i,
    )

    const state = runtime.getState()
    assert.equal(Object.keys(state.sessions).length, 0, 'removes Worker and failed Judge')
    assert.equal(Object.keys(state.subscriptions ?? {}).length, 0, 'removes both Goal relationships')
    assert.equal(state.loops.length, 0, 'removes the failed Goal loop projection')
  } finally { cleanup() }
})

test('provider start failure restores existing Handoff and Goal participants exactly', async () => {
  for (const kind of ['handoff', 'goal']) {
    const harnessResult = harness(`orrery-classic-existing-${kind}-failure-`)
    const { root, runtime, cleanup } = harnessResult
    try {
      const source = await runtime.createSession({
        prompt: 'Prepare existing state.', cwd: process.cwd(),
        providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
      })
      const target = kind === 'handoff'
        ? await runtime.createSession({
            prompt: 'Prepare receiver state.', cwd: process.cwd(),
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
          })
        : undefined
      await waitFor('existing participants become idle', () => [source.sessionId, target?.sessionId].filter(Boolean).every((id) => runtime.getState().sessions[id]?.status === 'idle'))
      const before = Object.fromEntries([source.sessionId, target?.sessionId].filter(Boolean).map((id) => [id, participantSnapshot(root, runtime, id)]))
      runtime.upsertProviderInstance({
        providerInstanceId: 'default-claude-sdk',
        kind: 'claude-code',
        label: 'Missing Claude SDK',
        binaryPath: path.join(root, 'missing-provider-binary'),
      })
      await assert.rejects(
        kind === 'handoff'
          ? runtime.startHandoffWorkflow({
              source: { kind: 'existing', sessionId: source.sessionId, prompt: '' },
              target: { kind: 'existing', sessionId: target.sessionId, prompt: '' },
              note: 'Continue once.',
            })
          : runtime.startGoalWorkflow({
              worker: { kind: 'existing', sessionId: source.sessionId, prompt: 'Continue toward done.' },
              goal: 'Done.', maxLaps: 3,
            }),
      )
      for (const sessionId of Object.keys(before)) {
        assert.deepEqual(participantSnapshot(root, runtime, sessionId), before[sessionId], `${kind} restores ${sessionId}`)
      }
      assert.equal(Object.keys(runtime.getState().subscriptions ?? {}).length, 0)
    } finally { cleanup() }
  }
})

test('parallel workflow submissions lock shared existing endpoints', async () => {
  const { runtime, cleanup } = harness('orrery-classic-lock-')
  try {
    const source = await runtime.createSession({ prompt: 'Source ready.', cwd: process.cwd(), providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk' })
    const target = await runtime.createSession({ prompt: 'Target ready.', cwd: process.cwd(), providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk' })
    await waitFor('both idle', () => [source.sessionId, target.sessionId].every((id) => runtime.getState().sessions[id]?.status === 'idle'))
    const input = {
      source: { kind: 'existing', sessionId: source.sessionId, prompt: '' },
      target: { kind: 'existing', sessionId: target.sessionId, prompt: '' },
      note: 'Continue once.',
    }
    const results = await Promise.allSettled([runtime.startHandoffWorkflow(input), runtime.startHandoffWorkflow(input)])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /already being changed/)
  } finally { cleanup() }
})

test('Save this workflow round-trips typed Goal and Review user fields, including existing Agents', async () => {
  const { runtime, cleanup } = harness('orrery-classic-save-')
  try {
    const workflowSpec = {
      version: 1,
      kind: 'goal-loop',
      input: {
        worker: fresh('Worker', 'Implement the change.'), goal: 'Focused tests pass.', maxLaps: 7,
        judgeProviderInstanceId: 'default-claude-sdk', judgeModel: 'claude-haiku-4-5',
      },
    }
    const saved = runtime.saveTemplate({ name: 'green goal', workflowSpec })
    assert.deepEqual(saved.template.workflowSpec, workflowSpec)
    assert.deepEqual(saved.template.savedFields, {
      kind: 'goal', relationshipCount: 2, maxLaps: 7, instructions: ['Focused tests pass.'],
    })
    const descriptor = runtime.listTemplates().templates.find((template) => template.id === saved.template.id)
    assert.deepEqual(descriptor.workflowSpec, workflowSpec)
    assert.match(descriptor.handsOff, /Goal workflow · max 7 laps/)

    const reviewSpec = {
      version: 1,
      kind: 'review-until-clean',
      input: {
        coder: fresh('Coder', 'Implement the requested behavior.'),
        reviewer: {
          kind: 'new', label: 'Reviewer', instruction: 'Report only release blockers.',
          providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
          runtimeSettings: { runtimeMode: 'approval-required', reasoningEffort: 'high' },
        },
        blocking: { mode: 'custom', customCriteria: 'Breaks the public contract.' },
        maxLaps: 9,
      },
    }
    const savedReview = runtime.saveTemplate({ name: 'release review', workflowSpec: reviewSpec })
    assert.deepEqual(savedReview.template.workflowSpec, reviewSpec)
    assert.deepEqual(savedReview.template.savedFields, {
      kind: 'review', relationshipCount: 2, maxLaps: 9,
      instructions: ['Report only release blockers.', 'Breaks the public contract.'],
    })
    assert.deepEqual(runtime.listTemplates().templates.find((template) => template.id === savedReview.template.id).workflowSpec, reviewSpec)

    const existing = await runtime.createSession({
      prompt: 'Prepare reusable context.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
    })
    await waitFor('existing Agent becomes idle', () => runtime.getState().sessions[existing.sessionId]?.status === 'idle')
    const existingSpec = {
      version: 1, kind: 'goal-loop',
      input: { worker: { kind: 'existing', sessionId: existing.sessionId, prompt: 'Continue toward green.' }, goal: 'Focused tests pass.', maxLaps: 4 },
    }
    assert.deepEqual(runtime.saveTemplate({ name: 'existing worker', workflowSpec: existingSpec }).template.workflowSpec, existingSpec)
  } finally { cleanup() }
})
