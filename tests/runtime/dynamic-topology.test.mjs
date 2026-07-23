import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(label, predicate, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function idle(runtime, label) {
  const result = await runtime.createSession({ prompt: `bootstrap ${label}`, label, cwd: process.cwd() })
  await waitFor(`${label} idle`, () => runtime.getState().sessions[result.sessionId]?.status === 'idle')
  return result.sessionId
}
function createAction(maxFanOut = 2, workspaceAccess = 'read-only') {
  return {
    kind: 'create',
    forEach: { kind: 'report-issues' },
    template: {
      templateId: 'bounded-triage-v1', labelPrefix: 'Triage', role: 'triage',
      prompt: 'Investigate the assigned issue. ORRERY_DELAY',
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
      workspace: {
        access: workspaceAccess,
        workMode: workspaceAccess === 'workspace-write' ? 'worktree' : 'local',
      },
      retention: 'archive-on-stop',
    },
    limits: { maxGenerationDepth: 2, maxSessions: 8, maxFanOut, maxPlanVersions: 10 },
  }
}

test('writable dynamic participants use provider-native auto mode', async () => {
  const runtime = new RuntimeSessionManager()
  try {
    const source = await idle(runtime, 'Writable spawn reporter')
    const target = await idle(runtime, 'Writable spawn owner')
    runtime.authorSubscription({
      id: 'spawn-writable-triage', sourceSessionId: source,
      on: { on: 'report', match: { verdict: 'issues' } }, targetSessionId: target,
      action: createAction(1, 'workspace-write'), gate: 'auto', concurrency: 'queue', stop: { maxFirings: 1 },
    })
    await runtime.handleMembraneRequest({
      tool: 'report', source,
      input: { type: 'verdict', verdict: 'issues', issues: [{ id: 'write-one', message: 'Fix it' }] },
    })
    const group = await waitFor('writable dynamic spawn', () =>
      Object.values(runtime.getState().dynamicSpawnGroups ?? {})[0],
    )
    const child = runtime.getState().sessions[group.children[0].sessionId]
    assert.equal(child.runtimeSettings.runtimeMode, 'auto')
    assert.equal(child.runtimeSettings.sandbox, 'workspace-write')
  } finally {
    runtime.killAll()
  }
})

test('typed issues spawn bounded triage participants in the inherited Scope and survive restart without duplication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-dynamic-topology-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const reporter = await idle(runtime, 'Reporter')
    const anchor = await idle(runtime, 'Triage owner')
    await runtime.dispatchCommand({
      kind: 'upsert_scope', actor: { kind: 'human' },
      input: { clusterId: 'triage-scope', label: 'Triage Scope', nodeIds: [reporter, anchor] },
    })
    const authored = runtime.authorSubscription({
      id: 'spawn-triage', sourceSessionId: reporter,
      on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
      targetSessionId: anchor, action: createAction(2), gate: 'auto',
      concurrency: 'queue', stop: { maxFirings: 1 },
    })
    await runtime.handleMembraneRequest({
      tool: 'report', source: reporter,
      input: {
        type: 'verdict', verdict: 'issues',
        issues: [
          { id: 'a', message: 'First defect', file: 'a.ts', line: 1 },
          { id: 'b', message: 'Second defect', file: 'b.ts', line: 2 },
          { id: 'c', message: 'Third defect', file: 'c.ts', line: 3 },
        ],
      },
    })
    const group = await waitFor('bounded spawn group', () =>
      Object.values(runtime.getState().dynamicSpawnGroups ?? {})[0],
    )
    assert.equal(group.requestedCount, 3)
    assert.equal(group.createdCount, 2)
    assert.equal(group.skippedCount, 1)
    assert.equal(group.status, 'capped')
    assert.match(group.reason, /capacity|fan-out/i)
    assert.ok(group.children.every((child) =>
      runtime.getState().clusters['triage-scope'].nodeIds.includes(child.sessionId),
    ))
    assert.ok(group.children.every((child) =>
      runtime.getState().sessions[child.sessionId].dynamicTopology.scopeId === 'triage-scope',
    ))
    assert.equal(runtime.getState().subscriptions[authored.subscription.id].state, 'stopped')
    const childIds = group.children.map((child) => child.sessionId).sort()
    const previousRuntime = runtime
    runtime = new RuntimeSessionManager({ storageFile })
    previousRuntime.killAll()
    const recovered = Object.values(runtime.getState().dynamicSpawnGroups ?? {})[0]
    assert.deepEqual(recovered.children.map((child) => child.sessionId).sort(), childIds)
    assert.equal(Object.keys(runtime.getState().sessions).filter((id) => childIds.includes(id)).length, 2)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dynamic create rejects arbitrary prompt templates and unbounded subscriptions', async () => {
  const runtime = new RuntimeSessionManager()
  try {
    const source = await idle(runtime, 'Source')
    const target = await idle(runtime, 'Target')
    assert.throws(() => runtime.authorSubscription({
      sourceSessionId: source, on: { on: 'report' }, targetSessionId: target,
      action: { kind: 'create', agent: 'claude-code', promptTemplate: '{{issue}}' },
      gate: 'auto',
    }), /template|bounded|fixed|limits/i)
    assert.throws(() => runtime.authorSubscription({
      sourceSessionId: source, on: { on: 'report' }, targetSessionId: target,
      action: createAction(), gate: 'auto',
    }), /maxFirings/i)
  } finally {
    runtime.killAll()
  }
})

test('restart compensates an interrupted dynamic deployment and retries one spawn group without duplicates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-dynamic-crash-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({
    storageFile,
    workflowDeploymentCrashAfterStage: 'resources-created',
  })
  try {
    const source = await idle(runtime, 'Crash reporter')
    const target = await idle(runtime, 'Crash owner')
    runtime.authorSubscription({
      id: 'spawn-after-crash', sourceSessionId: source,
      on: { on: 'report', match: { verdict: 'issues' } }, targetSessionId: target,
      action: createAction(2), gate: 'auto', concurrency: 'queue', stop: { maxFirings: 1 },
    })
    await runtime.handleMembraneRequest({
      tool: 'report', source,
      input: { type: 'verdict', verdict: 'issues', issues: [
        { id: 'one', message: 'One' }, { id: 'two', message: 'Two' },
      ] },
    })
    await waitFor('interrupted dynamic deployment', () =>
      runtime.getWorkflowDeployments({ status: 'in_progress' }).deployments
        .some((deployment) => deployment.journal?.kind === 'rule_execute_activation'),
    )
    const crashedRuntime = runtime
    runtime = new RuntimeSessionManager({ storageFile })
    crashedRuntime.killAll()
    const group = await waitFor('recovered dynamic spawn', () =>
      Object.values(runtime.getState().dynamicSpawnGroups ?? {})[0],
    )
    assert.equal(group.children.length, 2)
    assert.equal(new Set(group.children.map((child) => child.itemKey)).size, 2)
    assert.equal(new Set(group.children.map((child) => child.sessionId)).size, 2)
    assert.equal(Object.values(runtime.getState().dynamicSpawnGroups).length, 1)
    const aborted = runtime.getWorkflowDeployments({ status: 'aborted' }).deployments
      .filter((deployment) => deployment.journal?.kind === 'rule_execute_activation')
    assert.equal(aborted.length, 1)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('manual cancellation recycles archive-on-stop dynamic children', async () => {
  const runtime = new RuntimeSessionManager()
  try {
    const source = await idle(runtime, 'Recycle reporter')
    const target = await idle(runtime, 'Recycle owner')
    const authored = runtime.authorSubscription({
      id: 'spawn-and-recycle', sourceSessionId: source,
      on: { on: 'report', match: { verdict: 'issues' } }, targetSessionId: target,
      action: createAction(1), gate: 'auto', concurrency: 'queue', stop: { maxFirings: 2 },
    })
    await runtime.handleMembraneRequest({
      tool: 'report', source,
      input: { type: 'verdict', verdict: 'issues', issues: [{ id: 'one', message: 'One' }] },
    })
    const group = await waitFor('live recyclable group', () =>
      Object.values(runtime.getState().dynamicSpawnGroups ?? {})[0],
    )
    runtime.stopSubscription({ subscriptionId: authored.subscription.id, reason: 'Cancel triage branch.' })
    const recycled = runtime.getState().dynamicSpawnGroups[group.groupId]
    assert.equal(recycled.status, 'cancelled')
    assert.equal(recycled.children[0].status, 'recycled')
    assert.equal(runtime.getState().sessions[recycled.children[0].sessionId].archived, true)
  } finally {
    runtime.killAll()
  }
})
