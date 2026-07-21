import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { KernelStore, kernelDatabaseFileFor } from '../../dist-electron/electron/runtime/kernelStore.js'
import {
  deterministicProviderAdapters,
  deterministicRuntimeSessionManager,
} from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function activeCouncil(runtime, advancement, reviewFocus) {
  const worker = await runtime.createSession({
    prompt: 'Project context.', cwd: process.cwd(),
    providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Worker',
  })
  const master = await runtime.createSession({
    prompt: 'Coordinate this project.', cwd: process.cwd(),
    providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Master',
  })
  await waitFor('scope sessions idle', () =>
    [worker.sessionId, master.sessionId].every((id) => runtime.getState().sessions[id]?.status === 'idle'))
  await runtime.dispatchCommand({
    kind: 'upsert_scope', actor: { kind: 'human' },
    input: { clusterId: 'scope-1', label: 'Project', nodeIds: [worker.sessionId] },
  })
  await runtime.dispatchCommand({
    kind: 'assign_master', actor: { kind: 'human' },
    input: { clusterId: 'scope-1', sessionId: master.sessionId },
  })
  const runtimeSettings = { runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' }
  await runtime.dispatchCommand({
    commandId: 'governance-propose', idempotencyKey: 'governance-propose',
    kind: 'propose_workflow', actor: { kind: 'master', ref: master.sessionId },
    input: {
      proposalId: 'governance-proposal', recipe: 'plan-council', objective: 'Compare two implementation plans.',
      input: {
        objective: 'Compare two implementation plans.', cwd: process.cwd(),
        ...(reviewFocus ? { reviewFocus } : {}),
        planners: [
          { key: 'a', label: 'Planner A', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings },
          { key: 'b', label: 'Planner B', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings },
        ],
        synthesizer: { key: 's', label: 'Synthesizer', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings },
        coordinatorSessionId: master.sessionId,
        ...(advancement ? { advancement } : {}),
      },
      reason: 'Independent plans need a durable Council.',
    },
  })
  await runtime.dispatchCommand({
    kind: 'approve_workflow_proposal', actor: { kind: 'human' },
    input: { proposalId: 'governance-proposal' },
  })
  const committed = await runtime.dispatchCommand({
    commandId: 'governance-commit', idempotencyKey: 'governance-commit',
    kind: 'commit_workflow', actor: { kind: 'master', ref: master.sessionId },
    input: { proposalId: 'governance-proposal', expectedBaseVersion: 0 },
  })
  return {
    masterSessionId: master.sessionId,
    workflowId: committed.plan.workflowId,
    workflowVersion: committed.plan.version,
    councilWorkflowId: committed.executionMapping.productWorkflowId,
    participantSessionIds: committed.executionMapping.participantSessionIds,
  }
}

test('Master advances only Council gates explicitly delegated to the governing Scope Master', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-council-master-gate-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeCouncil(runtime, { crossReview: 'master', synthesis: 'master' })
    await waitFor('Master-gated proposals', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    const proposalWakeup = await waitFor('Master proposal-gate wakeup', () =>
      Object.values(runtime.getState().workflowWakeups).find((item) =>
        item.kind === 'workflow-milestone' && item.summary.includes(fixture.councilWorkflowId)))
    await runtime.dispatchCommand({
      commandId: 'simulate-master-gate-advance-before-ack',
      idempotencyKey: 'simulate-master-gate-advance-before-ack',
      kind: 'start_plan_council_cross_review',
      actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { workflowId: fixture.councilWorkflowId },
    })
    const firstAdvance = await runtime.handleMembraneRequest({
      tool: 'advance_plan_council', source: fixture.masterSessionId,
      input: { workflowId: fixture.councilWorkflowId, wakeupId: proposalWakeup.wakeupId, reason: 'The independent proposals are sufficient to review.' },
    })
    assert.equal(firstAdvance.wakeup.status, 'acknowledged')
    await waitFor('Master-gated reviews', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-synthesis')
    const reviewWakeup = await waitFor('Master review-gate wakeup', () =>
      Object.values(runtime.getState().workflowWakeups).find((item) =>
        item.kind === 'workflow-milestone' && item.status !== 'acknowledged' && item.summary.includes(fixture.councilWorkflowId)))
    const secondAdvance = await runtime.handleMembraneRequest({
      tool: 'advance_plan_council', source: fixture.masterSessionId,
      input: { workflowId: fixture.councilWorkflowId, wakeupId: reviewWakeup.wakeupId, reason: 'The review quorum is complete and readable.' },
    })
    assert.equal(secondAdvance.wakeup.status, 'acknowledged')
    await waitFor('Master-gated synthesis', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'completed')
    await assert.rejects(runtime.handleMembraneRequest({
      tool: 'advance_plan_council', source: fixture.masterSessionId,
      input: { workflowId: fixture.councilWorkflowId, reason: 'No further phase exists.' },
    }), /no phase is waiting/)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Council rejects participant topology patches while peer review is actively running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-council-active-phase-patch-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeCouncil(runtime, undefined, 'ORRERY_DELAY')
    await waitFor('Council proposals before active-phase patch', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    await runtime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId })
    assert.equal(runtime.getState().planCouncils[fixture.councilWorkflowId].phase, 'reviewing-peers')
    const proposed = await runtime.dispatchCommand({
      commandId: 'active-phase-add-reviewer', idempotencyKey: 'active-phase-add-reviewer',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'This must wait for a phase boundary.',
        operations: [{
          op: 'add-verifier', observes: ['planner:a'],
          verifier: {
            key: 'late-reviewer', label: 'Late Reviewer', role: 'Verifier', prompt: 'Review late.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    assert.ok(proposed.proposal.validation.errors.some((issue) => issue.code === 'patch-phase-incompatible'))
    await assert.rejects(runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: proposed.proposal.proposalId },
    }), /cannot change during an active phase/)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function activeReview(runtime) {
  const master = await runtime.createSession({
    prompt: 'Govern review workflow.', cwd: process.cwd(),
    providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Review Master',
  })
  const seed = await runtime.createSession({
    prompt: 'Project seed.', cwd: process.cwd(),
    providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Seed',
  })
  await waitFor('review scope idle', () =>
    [master.sessionId, seed.sessionId].every((id) => runtime.getState().sessions[id]?.status === 'idle'))
  await runtime.dispatchCommand({
    kind: 'upsert_scope', actor: { kind: 'human' },
    input: { clusterId: 'review-scope', label: 'Review Project', nodeIds: [seed.sessionId] },
  })
  await runtime.dispatchCommand({
    kind: 'assign_master', actor: { kind: 'human' },
    input: { clusterId: 'review-scope', sessionId: master.sessionId },
  })
  await runtime.dispatchCommand({
    commandId: 'review-governance-propose', idempotencyKey: 'review-governance-propose',
    kind: 'propose_workflow', actor: { kind: 'master', ref: master.sessionId },
    input: {
      proposalId: 'review-governance-proposal', recipe: 'review', objective: 'Implement and review until clean.',
      input: {
        coder: {
          kind: 'new', label: 'Coder', prompt: 'Implement the deterministic fixture.', cwd: process.cwd(), workMode: 'local',
          providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
          runtimeSettings: { runtimeMode: 'auto-accept-edits' },
        },
        reviewer: {
          kind: 'new', label: 'Reviewer', instruction: 'Return a typed clean or issues verdict.',
          providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
          runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
        },
        blocking: { mode: 'any-issue' }, maxLaps: 2,
      },
      reason: 'The change needs deterministic review.',
    },
  })
  await runtime.dispatchCommand({
    kind: 'approve_workflow_proposal', actor: { kind: 'human' },
    input: { proposalId: 'review-governance-proposal' },
  })
  const committed = await runtime.dispatchCommand({
    commandId: 'review-governance-commit', idempotencyKey: 'review-governance-commit',
    kind: 'commit_workflow', actor: { kind: 'master', ref: master.sessionId },
    input: { proposalId: 'review-governance-proposal', expectedBaseVersion: 0 },
  })
  return {
    masterSessionId: master.sessionId,
    seedSessionId: seed.sessionId,
    workflowId: committed.plan.workflowId,
    workflowVersion: committed.plan.version,
    scopeId: 'review-scope',
    mapping: committed.executionMapping,
  }
}

test('Master can propose and commit a bounded dynamic triage relationship', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-dynamic-triage-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeReview(runtime)
    const proposed = await runtime.dispatchCommand({
      commandId: 'propose-dynamic-triage', idempotencyKey: 'propose-dynamic-triage',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Spawn one bounded specialist per typed review issue.',
        operations: [{
          op: 'add-dynamic-triage', relationshipKey: 'review-issue-triage',
          sourceParticipantKey: 'reviewer', ownerParticipantKey: 'coder', maxFirings: 2,
          action: {
            kind: 'create', forEach: { kind: 'report-issues' },
            template: {
              templateId: 'master-triage-v1', labelPrefix: 'Master Triage', role: 'triage',
              prompt: 'Investigate the assigned issue and report a concise diagnosis. ORRERY_DELAY',
              providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
              workspace: { access: 'read-only', workMode: 'local' }, retention: 'keep',
            },
            limits: { maxGenerationDepth: 2, maxSessions: 8, maxFanOut: 2, maxPlanVersions: 20 },
          },
        }],
      },
    })
    assert.deepEqual(proposed.proposal.validation.errors, [])
    assert.equal(proposed.proposal.graphDiff.relationships.add[0].after.action.kind, 'create')
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: proposed.proposal.proposalId },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-dynamic-triage', idempotencyKey: 'commit-dynamic-triage',
      kind: 'commit_workflow', actor: { kind: 'human' },
      input: { proposalId: proposed.proposal.proposalId, expectedBaseVersion: 1 },
    })
    const subscriptionId = committed.executionMapping.relationshipSubscriptionIds['review-issue-triage']
    assert.equal(runtime.getState().subscriptions[subscriptionId].action.template.templateId, 'master-triage-v1')
    const reviewerId = committed.executionMapping.participantSessionIds.reviewer
    await runtime.dispatchCommand({
      kind: 'report', actor: { kind: 'agent', ref: reviewerId },
      execution: {
        workflowId: 'foreign-workflow', workflowVersion: 1, runId: 'foreign-run',
        phaseId: 'foreign-phase', activationId: 'foreign-activation', attempt: 1,
        correlationKey: 'foreign-workflow:v1:foreign-run:foreign-phase:g1',
      },
      input: { type: 'verdict', verdict: 'issues', issues: [
        { id: 'one', message: 'One' }, { id: 'two', message: 'Two' }, { id: 'three', message: 'Three' },
      ] },
    })
    const group = await waitFor('Master-authored dynamic triage group', () =>
      Object.values(runtime.getState().dynamicSpawnGroups ?? {})[0])
    assert.equal(group.scopeId, fixture.scopeId)
    assert.equal(group.createdCount, 2)
    assert.equal(group.skippedCount, 1)
    assert.equal(group.templateId, 'master-triage-v1')
    assert.equal(group.execution.workflowId, fixture.workflowId)
    assert.equal(group.execution.workflowVersion, 2)
    assert.equal(group.execution.phaseId, 'review-issue-triage')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function recordWakeup(runtime, fixture, suffix, kind = 'failure') {
  return runtime.dispatchCommand({
    commandId: `record-${suffix}`, idempotencyKey: `record-${suffix}`,
    kind: 'record_workflow_wakeup', actor: { kind: 'runtime' },
    input: {
      workflowId: fixture.workflowId,
      workflowVersion: fixture.workflowVersion,
      scopeId: fixture.scopeId ?? 'scope-1',
      masterSessionId: fixture.masterSessionId,
      wakeupKind: kind,
      summary: `${kind} fixture ${suffix}`,
      sourceEventId: `event-${suffix}`,
      sourceSessionId: `session-${suffix}`,
      observedAt: `2026-07-12T12:00:0${suffix}.000Z`,
    },
  })
}

test('Governor wakeups coalesce durably, activate only the Master, and require explicit acknowledgement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-wakeup-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeCouncil(runtime)
    await runtime.resumeSession({ sessionId: fixture.masterSessionId, message: 'ORRERY_SLEEP remain busy while failures arrive.' })
    await waitFor('Master busy', () => ['pending', 'running'].includes(runtime.getState().sessions[fixture.masterSessionId]?.status))

    await recordWakeup(runtime, fixture, '1')
    await recordWakeup(runtime, fixture, '2')
    const pending = Object.values(runtime.getState().workflowWakeups)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, 'pending')
    assert.equal(pending[0].occurrenceCount, 2)
    assert.deepEqual(pending[0].sourceEventIds, ['event-1', 'event-2'])

    const notified = await waitFor('coalesced wakeup notified', () =>
      Object.values(runtime.getState().workflowWakeups).find((item) => item.status === 'notified'))
    assert.ok(notified.notificationTurnId)
    await waitFor('Master settles after Governor turn', () => runtime.getState().sessions[fixture.masterSessionId]?.status === 'idle')
    const masterMessage = runtime.getState().sessions[fixture.masterSessionId].messages
      .filter((message) => message.role === 'user')
      .at(-1)
    assert.match(masterMessage.content, /2 related facts were coalesced/)
    assert.match(masterMessage.content, /Mechanical turn routing remains owned by the Kernel/)

    const inspected = await runtime.handleMembraneRequest({
      tool: 'inspect_workflow_wakeups', source: fixture.masterSessionId,
      input: { statuses: ['notified'] },
    })
    assert.equal(inspected.wakeups.length, 1)
    await runtime.handleMembraneRequest({
      tool: 'acknowledge_workflow_wakeup', source: fixture.masterSessionId,
      input: { wakeupId: notified.wakeupId, reason: 'No topology change is needed for this fixture.' },
    })
    assert.equal(runtime.getState().workflowWakeups[notified.wakeupId].status, 'acknowledged')
    assert.equal(
      runtime.getKernelEvents({ type: 'workflow.master-wakeup.acknowledged' }).events.length,
      1,
    )
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pending Governor state survives restart and remains Scope-authorized', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-restart-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const fixture = await activeCouncil(runtime)
    await runtime.freeze({ target: fixture.masterSessionId, reason: 'Keep wakeup pending across restart.' })
    const recorded = await recordWakeup(runtime, fixture, '3', 'permission-expansion')
    await delay(50)
    assert.equal(runtime.getState().workflowWakeups[recorded.wakeup.wakeupId].status, 'pending')
    runtime.killAll()
    runtime = new RuntimeSessionManager({ storageFile })
    const restored = runtime.getState().workflowWakeups[recorded.wakeup.wakeupId]
    assert.equal(restored.status, 'pending')
    assert.equal(restored.kind, 'permission-expansion')
    assert.equal(restored.masterSessionId, fixture.masterSessionId)
    const inspected = runtime.inspectWorkflowWakeups({ statuses: ['pending'] }, fixture.masterSessionId)
    assert.equal(inspected.wakeups[0].wakeupId, restored.wakeupId)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a Governor notification queued before shutdown cannot start a fresh turn after killAll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-shutdown-'))
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(root, 'state.json'),
    controlCommandCommitDelayMs: 50,
  })
  try {
    const fixture = await activeCouncil(runtime)
    await runtime.dispatchCommand({
      commandId: 'freeze-shutdown-governor',
      idempotencyKey: 'freeze-shutdown-governor',
      kind: 'freeze',
      actor: { kind: 'human' },
      input: { target: fixture.masterSessionId, reason: 'Hold the wakeup pending.' },
    })
    const recorded = await recordWakeup(runtime, fixture, 'shutdown')

    const unfreezing = runtime.unfreeze({
      commandId: 'unfreeze-shutdown-governor',
      idempotencyKey: 'unfreeze-shutdown-governor',
      target: fixture.masterSessionId,
    })
    const deterministicNotifyCommandId =
      `notify-${recorded.wakeup.wakeupId}-${recorded.wakeup.occurrenceCount}`
    const deterministicNotifyKey =
      `notify:${recorded.wakeup.wakeupId}:${recorded.wakeup.occurrenceCount}`
    const notifying = runtime.dispatchCommand({
      commandId: deterministicNotifyCommandId,
      idempotencyKey: deterministicNotifyKey,
      kind: 'notify_workflow_wakeup',
      actor: { kind: 'runtime' },
      input: { wakeupId: recorded.wakeup.wakeupId },
    })
    runtime.killAll()
    await unfreezing
    await assert.rejects(notifying, /draining is disabled/)
    await delay(150)

    const wakeup = runtime.getState().workflowWakeups[recorded.wakeup.wakeupId]
    assert.equal(wakeup.status, 'pending')
    assert.equal(wakeup.notificationAttempts, undefined)
    assert.equal(
      runtime.getKernelEvents({ type: 'workflow.master-wakeup.notified' }).events
        .filter((event) => event.payload.wakeupId === wakeup.wakeupId).length,
      0,
    )
    assert.ok(
      !['pending', 'running'].includes(runtime.getState().sessions[fixture.masterSessionId].status),
      'shutdown does not leave a fresh Governor provider turn live',
    )

    await runtime.unfreeze({
      commandId: 'revive-shutdown-governor',
      idempotencyKey: 'revive-shutdown-governor',
      target: fixture.masterSessionId,
    })
    await waitFor('shutdown wakeup retries after revival', () =>
      runtime.getState().workflowWakeups[wakeup.wakeupId]?.notificationAttempts === 1)
    assert.equal(runtime.getState().workflowWakeups[wakeup.wakeupId].status, 'notified')
    assert.equal(
      runtime.getKernelEvents({ type: 'workflow.master-wakeup.notified' }).events
        .filter((event) => event.payload.wakeupId === wakeup.wakeupId).length,
      1,
      'the same deterministic notify identity remains usable after shutdown',
    )
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a notified Governor turn interrupted by restart returns to pending and can notify again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-notified-restart-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const fixture = await activeCouncil(runtime)
    const recorded = await recordWakeup(runtime, fixture, 'ORRERY_SLEEP-notified-restart')
    await waitFor('wakeup notified and turn live', () =>
      runtime.getState().workflowWakeups[recorded.wakeup.wakeupId]?.status === 'notified' &&
      ['pending', 'running'].includes(runtime.getState().sessions[fixture.masterSessionId]?.status))
    const interruptedRuntime = runtime
    runtime = new RuntimeSessionManager({ storageFile })
    interruptedRuntime.killAll()
    const restored = runtime.getState().workflowWakeups[recorded.wakeup.wakeupId]
    assert.equal(restored.status, 'pending')
    assert.equal(restored.notificationAttempts, 1)
    assert.ok(restored.lastNotificationInterruptedAt)
    await runtime.resumeSession({ sessionId: fixture.masterSessionId, message: 'Recover and become idle.' })
    await waitFor('recovered Master idle', () => runtime.getState().sessions[fixture.masterSessionId]?.status === 'idle')
    await runtime.dispatchCommand({
      commandId: 'retry-wakeup-notification', idempotencyKey: 'retry-wakeup-notification',
      kind: 'notify_workflow_wakeup', actor: { kind: 'runtime' },
      input: { wakeupId: recorded.wakeup.wakeupId },
    })
    await waitFor('wakeup re-notified after recovery', () =>
      runtime.getState().workflowWakeups[recorded.wakeup.wakeupId]?.notificationAttempts === 2)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('mechanical Council turns do not wake Master, but synthesis completion creates a milestone wakeup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-milestone-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeCouncil(runtime)
    await waitFor('Council proposals ready', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    assert.equal(
      Object.keys(runtime.getState().workflowWakeups).length,
      0,
      'ordinary participant finished events remain mechanical Kernel routing',
    )
    await runtime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId })
    await waitFor('Council reviews ready', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-synthesis')
    assert.equal(Object.keys(runtime.getState().workflowWakeups).length, 0)
    await runtime.startPlanCouncilSynthesis({ workflowId: fixture.councilWorkflowId })
    await waitFor('Council completed', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'completed')
    const milestone = await waitFor('milestone wakeup', () =>
      Object.values(runtime.getState().workflowWakeups)
        .find((wakeup) => wakeup.kind === 'workflow-milestone'))
    assert.match(milestone.summary, /final synthesis is ready/i)
    assert.equal(milestone.workflowId, fixture.workflowId)
    assert.equal(milestone.workflowVersion, 1)
    assert.ok(milestone.sourceEventIds.length === 1)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('human changes to a running Workflow become durable wakeups without rebuilding the deleted item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-human-change-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeCouncil(runtime)
    const plannerSessionId = fixture.participantSessionIds['planner:a']
    await waitFor('planner idle', () => runtime.getState().sessions[plannerSessionId]?.status === 'idle')
    await runtime.resumeSession({ sessionId: plannerSessionId, message: 'ORRERY_SLEEP human is about to stop this participant.' })
    await waitFor('planner running', () => ['pending', 'running'].includes(runtime.getState().sessions[plannerSessionId]?.status))
    await runtime.dispatchCommand({
      commandId: 'human-kills-planner', idempotencyKey: 'human-kills-planner',
      kind: 'kill_session', actor: { kind: 'human' },
      input: { sessionId: plannerSessionId },
    })
    const wakeup = await waitFor('human change wakeup', () =>
      Object.values(runtime.getState().workflowWakeups)
        .find((item) => item.kind === 'human-change'))
    assert.match(wakeup.summary, /preserve the change/i)
    assert.equal(runtime.getState().sessions[plannerSessionId].status, 'killed')
    assert.equal(
      runtime.getKernelEvents({ type: 'session.created' }).events
        .filter((event) => event.payload.sessionId === plannerSessionId).length,
      1,
      'Governor notification never recreates the human-removed participant',
    )
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('missing typed reports and firing caps wake the Governor without routing ordinary turns through it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-review-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeReview(runtime)
    const missing = await waitFor('missing report wakeup', () =>
      Object.values(runtime.getState().workflowWakeups).find((item) => item.kind === 'missing-report'))
    assert.match(missing.summary, /without the required typed report/)
    await waitFor('review Master idle', () => runtime.getState().sessions[fixture.masterSessionId]?.status === 'idle')
    await runtime.handleMembraneRequest({
      tool: 'acknowledge_workflow_wakeup', source: fixture.masterSessionId,
      input: { wakeupId: missing.wakeupId, reason: 'The Reviewer contract will be patched.' },
    })
    const subscriptionId = Object.values(fixture.mapping.relationshipSubscriptionIds)[0]
    await runtime.dispatchCommand({
      commandId: 'cap-review-edge', idempotencyKey: 'cap-review-edge',
      kind: 'stop_subscription', actor: { kind: 'rule', ref: subscriptionId },
      reason: 'maxFirings=2 reached.',
      input: { subscriptionId },
    })
    const cap = await waitFor('cap wakeup', () =>
      Object.values(runtime.getState().workflowWakeups).find((item) => item.kind === 'cap'))
    assert.match(cap.summary, /firing cap/)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('participant failure and permission expansion enter the durable wakeup catalog', async () => {
  const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-failure-'))
  const failureRuntime = new RuntimeSessionManager({
    storageFile: path.join(failureRoot, 'state.json'),
    providerAdapters: deterministicProviderAdapters({
      failWhen: (input) => input.prompt?.includes("Cross-review the other planners' proposals"),
    }),
  })
  try {
    const fixture = await activeCouncil(failureRuntime)
    await waitFor('failure Council proposals ready', () =>
      failureRuntime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    await assert.rejects(
      failureRuntime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId }),
      /failed|configured failure/i,
    )
    const failure = await waitFor('failure wakeup', () =>
      Object.values(failureRuntime.getState().workflowWakeups).find((item) => item.kind === 'failure'))
    assert.match(failure.summary, /failed/i)
    await waitFor('failure Governor notification settles', () =>
      !Object.values(failureRuntime.getState().workflowWakeups).some((item) => item.status === 'pending') &&
      failureRuntime.getState().sessions[fixture.masterSessionId]?.status === 'idle')
  } finally {
    failureRuntime.killAll()
    fs.rmSync(failureRoot, { recursive: true, force: true })
  }

  const permissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-permission-'))
  const permissionRuntime = new RuntimeSessionManager({
    storageFile: path.join(permissionRoot, 'state.json'),
    providerAdapters: deterministicProviderAdapters({
      permissionWhen: (input) => input.prompt?.includes('Planning task: Compare two implementation plans.'),
    }),
  })
  try {
    const fixture = await activeCouncil(permissionRuntime)
    await waitFor('permission Council proposals ready', () =>
      permissionRuntime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    const permission = await waitFor('permission wakeup', () =>
      Object.values(permissionRuntime.getState().workflowWakeups)
        .find((item) => item.kind === 'permission-expansion'))
    assert.match(permission.summary, /Expand workspace write permission/)
    await waitFor('permission Governor notifications settle', () =>
      !Object.values(permissionRuntime.getState().workflowWakeups).some((item) => item.status === 'pending') &&
      permissionRuntime.getState().sessions[fixture.masterSessionId]?.status === 'idle')
  } finally {
    permissionRuntime.killAll()
    fs.rmSync(permissionRoot, { recursive: true, force: true })
  }
})

test('restart reconciles an eligible kernel fact committed before its wakeup command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-reconcile-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const fixture = await activeCouncil(runtime)
    await waitFor('reconcile Council proposals ready', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    runtime.killAll()
    const store = new KernelStore({ databaseFile: kernelDatabaseFileFor(storageFile) })
    const sourceEvent = store.appendEvent({
      type: 'session.failed',
      actor: { kind: 'provider', ref: 'default-claude-sdk' },
      reason: 'Injected crash-gap fact.',
      payload: {
        sessionId: fixture.participantSessionIds['planner:a'],
        error: 'Provider failed immediately before wakeup recording.',
      },
    })
    store.close()
    runtime = new RuntimeSessionManager({ storageFile })
    const recovered = await waitFor('reconciled failure wakeup', () =>
      Object.values(runtime.getState().workflowWakeups)
        .find((wakeup) => wakeup.sourceEventIds.includes(sourceEvent.id)))
    assert.equal(recovered.kind, 'failure')
    assert.equal(recovered.workflowId, fixture.workflowId)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('approved add-verifier patch commits only incremental resources and survives restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-patch-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const fixture = await activeReview(runtime)
    const beforeSessions = new Set(Object.keys(runtime.getState().sessions))
    const beforeMapping = structuredClone(fixture.mapping)
    const proposed = await runtime.dispatchCommand({
      commandId: 'patch-add-verifier', idempotencyKey: 'patch-add-verifier',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-add-verifier', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Add an independent database verifier without rebuilding the review ring.',
        operations: [{
          op: 'add-verifier', observes: ['coder'],
          verifier: {
            key: 'database-verifier', label: 'Database Verifier', role: 'Verifier',
            prompt: 'Inspect database migration safety and report findings.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    assert.equal(proposed.proposal.baseVersion, 1)
    assert.deepEqual(proposed.proposal.patch.impact.addedParticipantKeys, ['database-verifier'])
    assert.equal(proposed.proposal.patch.rollback.baseVersion, 1)
    assert.equal(Object.keys(runtime.getState().sessions).length, beforeSessions.size, 'proposal is authoring-only')
    await assert.rejects(runtime.dispatchCommand({
      commandId: 'revise-patch-as-workflow', idempotencyKey: 'revise-patch-as-workflow',
      kind: 'revise_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-add-verifier', objective: 'Silently reinterpret the Patch.' },
    }), /Patch operations are immutable/)

    await runtime.dispatchCommand({
      kind: 'lock_workflow_item', actor: { kind: 'human' },
      input: { proposalId: 'patch-add-verifier', kind: 'relationship', key: 'verify:coder:database-verifier' },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-add-verifier' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-patch-add-verifier', idempotencyKey: 'commit-patch-add-verifier',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-add-verifier', expectedBaseVersion: 1 },
    })
    assert.equal(committed.result.incremental, true)
    assert.equal(committed.result.createdSessionIds.length, 1)
    assert.equal(committed.result.createdSubscriptionIds.length, 1)
    assert.equal(committed.executionMapping.participantSessionIds.coder, beforeMapping.participantSessionIds.coder)
    assert.equal(committed.executionMapping.participantSessionIds.reviewer, beforeMapping.participantSessionIds.reviewer)
    assert.equal(Object.keys(runtime.getState().sessions).length, beforeSessions.size + 1)
    assert.equal(runtime.getState().workflowPlans[fixture.workflowId]['1'].status, 'superseded')
    assert.equal(runtime.getState().workflowPlans[fixture.workflowId]['2'].status, 'active')

    await assert.rejects(runtime.dispatchCommand({
      commandId: 'patch-locked-edge', idempotencyKey: 'patch-locked-edge',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        workflowId: fixture.workflowId, baseVersion: 2, reason: 'Try to change a human-owned edge.',
        operations: [{
          op: 'change-relationship-policy',
          relationshipKey: 'verify:coder:database-verifier', gate: 'master',
        }],
      },
    }), /Human-locked relationship/)

    runtime.killAll()
    runtime = new RuntimeSessionManager({ storageFile })
    const restored = runtime.getState().workflowPlans[fixture.workflowId]['2']
    assert.equal(restored.status, 'active')
    assert.equal(restored.executionMapping.participantSessionIds.coder, beforeMapping.participantSessionIds.coder)
    assert.ok(restored.executionMapping.participantSessionIds['database-verifier'])
    assert.equal(runtime.getState().workflowProposals['patch-add-verifier'].status, 'committed')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('replace-participant patch rewires affected edges, preserves the writer, and resolves its wakeup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-replace-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeReview(runtime)
    const recorded = await recordWakeup(runtime, {
      ...fixture,
      workflowVersion: 1,
    }, 'replace-reviewer')
    const staleWakeup = await recordWakeup(runtime, {
      ...fixture,
      workflowVersion: 1,
    }, 'stale-cap', 'cap')
    const oldReviewer = fixture.mapping.participantSessionIds.reviewer
    const oldCoder = fixture.mapping.participantSessionIds.coder
    const oldSubscriptions = Object.values(fixture.mapping.relationshipSubscriptionIds)
    await runtime.dispatchCommand({
      commandId: 'patch-replace-reviewer', idempotencyKey: 'patch-replace-reviewer',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-replace-reviewer', workflowId: fixture.workflowId, baseVersion: 1,
        wakeupIds: [recorded.wakeup.wakeupId], reason: 'Replace the failed reviewer with a fresh model.',
        operations: [{
          op: 'replace-participant', participantKey: 'reviewer',
          replacement: {
            label: 'Replacement Reviewer', role: 'Reviewer',
            prompt: 'Re-run the review and report a typed verdict.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-replace-reviewer' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-patch-replace-reviewer', idempotencyKey: 'commit-patch-replace-reviewer',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-replace-reviewer', expectedBaseVersion: 1 },
    })
    assert.equal(committed.executionMapping.participantSessionIds.coder, oldCoder)
    assert.notEqual(committed.executionMapping.participantSessionIds.reviewer, oldReviewer)
    assert.equal(committed.result.createdSessionIds.length, 1)
    assert.equal(committed.result.createdSubscriptionIds.length, 2)
    assert.ok(oldSubscriptions.every((id) => runtime.getState().subscriptions[id].state === 'stopped'))
    assert.equal(runtime.getState().workflowWakeups[recorded.wakeup.wakeupId].status, 'acknowledged')
    assert.match(
      runtime.getState().workflowWakeups[recorded.wakeup.wakeupId].acknowledgmentReason,
      /Workflow Patch/,
    )
    assert.equal(runtime.getState().workflowWakeups[staleWakeup.wakeup.wakeupId].status, 'superseded')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Council patch adds a specialist reviewer, resynthesizes, and continues into implementation authoring', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-council-v2-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeCouncil(runtime)
    await waitFor('Council proposals ready', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    const unsupported = await runtime.dispatchCommand({
      commandId: 'patch-council-unsupported', idempotencyKey: 'patch-council-unsupported',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-council-unsupported', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Expose unsupported Council policy changes before approval.',
        operations: [{ op: 'change-relationship-policy', relationshipKey: 'cross-review:a->b', gate: 'auto' }],
      },
    })
    assert.ok(unsupported.proposal.validation.errors.some((issue) => issue.code === 'patch-operation-unsupported'))
    await assert.rejects(runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-council-unsupported' },
    }), /does not support/)
    await runtime.dispatchCommand({
      kind: 'abort_workflow_proposal', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-council-unsupported', reason: 'Use a supported Council Patch.' },
    })
    await runtime.dispatchCommand({
      commandId: 'patch-council-db-reviewer', idempotencyKey: 'patch-council-db-reviewer',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-council-db-reviewer', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Add a database specialist before peer review.',
        operations: [{
          op: 'add-verifier', observes: ['planner:a'],
          verifier: {
            key: 'database-reviewer', label: 'Database Reviewer', role: 'Verifier',
            prompt: 'Review all proposed plans for database safety.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-council-db-reviewer' },
    })
    const patched = await runtime.dispatchCommand({
      commandId: 'commit-council-db-reviewer', idempotencyKey: 'commit-council-db-reviewer',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-council-db-reviewer', expectedBaseVersion: 1 },
    })
    const specialistId = patched.executionMapping.participantSessionIds['database-reviewer']
    assert.ok(specialistId)
    assert.equal(runtime.getState().planCouncils[fixture.councilWorkflowId].participants[specialistId].role, 'reviewer')

    await runtime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId })
    await waitFor('specialist and peer reviews ready', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-synthesis')
    assert.ok(runtime.getState().planCouncils[fixture.councilWorkflowId].artifacts.some(
      (artifact) => artifact.kind === 'peer-review' && artifact.authorSessionId === specialistId))
    await runtime.startPlanCouncilSynthesis({ workflowId: fixture.councilWorkflowId })
    await waitFor('first Council synthesis', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'completed')

    await runtime.dispatchCommand({
      commandId: 'patch-council-resynthesize', idempotencyKey: 'patch-council-resynthesize',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-council-resynthesize', workflowId: fixture.workflowId, baseVersion: 2,
        reason: 'Produce a fresh synthesis after the specialist review.',
        operations: [{ op: 'resynthesize', reason: 'Include the database specialist findings.' }],
      },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-council-resynthesize' },
    })
    await runtime.dispatchCommand({
      commandId: 'commit-council-resynthesize', idempotencyKey: 'commit-council-resynthesize',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-council-resynthesize', expectedBaseVersion: 2 },
    })
    await waitFor('second Council synthesis', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'completed' &&
      runtime.getState().planCouncils[fixture.councilWorkflowId].artifacts
        .filter((artifact) => artifact.kind === 'synthesis').length === 2)
    assert.deepEqual(
      runtime.getState().planCouncils[fixture.councilWorkflowId].artifacts
        .filter((artifact) => artifact.kind === 'synthesis').map((artifact) => artifact.version),
      [1, 2],
    )

    const continuation = await runtime.dispatchCommand({
      commandId: 'council-continuation', idempotencyKey: 'council-continuation',
      kind: 'propose_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'council-implementation-proposal', recipe: 'goal',
        objective: 'Implement the final Plan Council synthesis.',
        input: {
          goal: 'Implement the final Plan Council synthesis delivered in the coordinator channel.', maxLaps: 2,
          worker: {
            kind: 'new', label: 'Implementer', prompt: 'Implement the approved synthesis.', cwd: process.cwd(), workMode: 'local',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'auto-accept-edits' },
          },
          judgeProviderInstanceId: 'default-claude-sdk',
        },
        reason: `Continue from Plan Council ${fixture.councilWorkflowId} synthesis v2.`,
      },
    })
    assert.equal(continuation.proposal.status, 'proposed')
    assert.equal(continuation.proposal.proposedPlan.recipe, 'goal')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('failed Council model is replaced through a reviewed patch instead of a silent retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-council-replace-'))
  let failedOnce = false
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(root, 'state.json'),
    providerAdapters: deterministicProviderAdapters({
      failWhen: (input) => {
        if (!failedOnce && input.prompt?.includes("Cross-review the other planners' proposals")) {
          failedOnce = true
          return true
        }
        return false
      },
    }),
  })
  try {
    const fixture = await activeCouncil(runtime)
    await waitFor('Council proposals ready before injected failure', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    await assert.rejects(runtime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId }), /failed/i)
    const failedSessionId = Object.values(fixture.participantSessionIds).find(
      (sessionId) => runtime.getState().sessions[sessionId]?.status === 'failed')
    const participantKey = Object.entries(fixture.participantSessionIds).find(
      ([, sessionId]) => sessionId === failedSessionId)?.[0]
    assert.ok(participantKey?.startsWith('planner:'))

    await runtime.dispatchCommand({
      commandId: 'patch-council-replace-failed', idempotencyKey: 'patch-council-replace-failed',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-council-replace-failed', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Replace the failed planning model; do not silently rerun the old session.',
        operations: [{
          op: 'replace-participant', participantKey,
          replacement: {
            label: 'Replacement Planner', role: 'Planner',
            prompt: 'Create a replacement independent implementation plan.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    assert.equal(runtime.getState().planCouncils[fixture.councilWorkflowId].phase, 'failed', 'proposal alone does not retry')
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-council-replace-failed' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-council-replace-failed', idempotencyKey: 'commit-council-replace-failed',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-council-replace-failed', expectedBaseVersion: 1 },
    })
    assert.notEqual(committed.executionMapping.participantSessionIds[participantKey], failedSessionId)
    await waitFor('replacement planner restores Council proposal barrier', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    assert.ok(runtime.getState().planCouncils[fixture.councilWorkflowId].supersededParticipantIds.includes(failedSessionId))
    await runtime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId })
    await waitFor('replacement cross-review generation', () =>
      runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-synthesis')
    const reviewBarriers = Object.values(runtime.getState().barriers).filter(
      (barrier) => barrier.runId === fixture.councilWorkflowId ||
        (barrier.phaseId === 'peer-review' && barrier.barrierId.startsWith(fixture.councilWorkflowId)),
    ).filter((barrier) => barrier.phaseId === 'peer-review')
    assert.equal(reviewBarriers.length, 2)
    assert.equal(new Set(reviewBarriers.map((barrier) => barrier.correlationKey)).size, 2)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('patch can stop a branch and change gate policy without rebuilding participants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-policy-patch-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeReview(runtime)
    const beforeSessions = Object.keys(runtime.getState().sessions).length
    await runtime.dispatchCommand({
      commandId: 'patch-review-policy', idempotencyKey: 'patch-review-policy',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-review-policy', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Stop automatic fix retries and require human approval for each review pass.',
        operations: [
          { op: 'stop-branch', relationshipKeys: ['review-fix'], reason: 'Human will choose whether to apply findings.' },
          { op: 'change-relationship-policy', relationshipKey: 'review-request', gate: 'human', stop: 'max 1 laps' },
        ],
      },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-review-policy' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-review-policy', idempotencyKey: 'commit-review-policy',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-review-policy', expectedBaseVersion: 1 },
    })
    assert.equal(Object.keys(runtime.getState().sessions).length, beforeSessions)
    assert.equal(committed.result.createdSessionIds.length, 0)
    assert.equal(committed.result.createdSubscriptionIds.length, 1)
    assert.equal(committed.plan.relationships.some((item) => item.key === 'review-fix'), false)
    assert.equal(committed.plan.relationships.find((item) => item.key === 'review-request').gate, 'human')
    assert.equal(committed.executionMapping.relationshipSubscriptionIds['review-fix'], undefined)
    const replacementId = committed.executionMapping.relationshipSubscriptionIds['review-request']
    assert.equal(runtime.getState().subscriptions[replacementId].gate, 'human')
    assert.equal(runtime.getState().subscriptions[replacementId].stop.maxFirings, 1)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('restart compensates an interrupted incremental Patch and the approved Proposal can retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-patch-crash-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const fixture = await activeReview(runtime)
    const baseSessionCount = Object.keys(runtime.getState().sessions).length
    await runtime.dispatchCommand({
      commandId: 'patch-crash-proposal', idempotencyKey: 'patch-crash-proposal',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'patch-crash-proposal', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Exercise durable incremental deployment recovery.',
        operations: [{
          op: 'add-verifier', observes: ['coder'],
          verifier: {
            key: 'crash-verifier', prompt: 'Verify after recovery.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'patch-crash-proposal' },
    })
    runtime.killAll()

    const crashedRuntime = new RuntimeSessionManager({ storageFile, workflowDeploymentCrashAfterStage: 'resources-created' })
    runtime = crashedRuntime
    await assert.rejects(crashedRuntime.dispatchCommand({
      commandId: 'patch-crash-commit', idempotencyKey: 'patch-crash-commit',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-crash-proposal', expectedBaseVersion: 1 },
    }), /Injected workflow deployment crash/)

    runtime = new RuntimeSessionManager({ storageFile })
    crashedRuntime.killAll()
    assert.equal(Object.keys(runtime.getState().sessions).length, baseSessionCount)
    assert.equal(runtime.getState().workflowPlans[fixture.workflowId]['1'].status, 'active')
    assert.equal(runtime.getState().workflowProposals['patch-crash-proposal'].status, 'approved')
    const retried = await runtime.dispatchCommand({
      commandId: 'patch-crash-commit', idempotencyKey: 'patch-crash-commit',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'patch-crash-proposal', expectedBaseVersion: 1 },
    })
    assert.equal(retried.plan.version, 2)
    assert.equal(Object.keys(runtime.getState().sessions).length, baseSessionCount + 1)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Patch permissions, human edge tombstones, and replacement Scope budget stay authoritative', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-patch-safety-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeReview(runtime)
    await assert.rejects(runtime.dispatchCommand({
      commandId: 'unsafe-existing-reviewer', idempotencyKey: 'unsafe-existing-reviewer',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        workflowId: fixture.workflowId, baseVersion: 1, reason: 'Unsafe existing replacement.',
        operations: [{
          op: 'replace-participant', participantKey: 'reviewer',
          replacement: { kind: 'existing', sessionId: fixture.seedSessionId, workspace: { access: 'read' } },
        }],
      },
    }), /can write/)

    const collision = await runtime.dispatchCommand({
      commandId: 'participant-session-collision', idempotencyKey: 'participant-session-collision',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'participant-session-collision', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'A participant key must not alias its peer Session.',
        operations: [{
          op: 'replace-participant', participantKey: 'coder',
          replacement: {
            kind: 'existing', sessionId: fixture.mapping.participantSessionIds.reviewer,
            workspace: { access: 'write' },
          },
        }],
      },
    })
    assert.ok(collision.proposal.validation.errors.some((issue) => issue.code === 'participant-session-collision'))
    await runtime.dispatchCommand({
      kind: 'abort_workflow_proposal', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'participant-session-collision', reason: 'Reject endpoint aliasing.' },
    })

    const safe = await runtime.dispatchCommand({
      commandId: 'safe-default-verifier', idempotencyKey: 'safe-default-verifier',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'safe-default-verifier', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Read-only defaults must be execution facts.',
        operations: [{
          op: 'add-verifier', observes: ['coder'],
          verifier: {
            key: 'safe-verifier', prompt: 'Verify safely.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'full-access' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    const verifier = safe.proposal.proposedPlan.participants.find((item) => item.key === 'safe-verifier')
    assert.equal(verifier.endpoint.runtimeSettings.runtimeMode, 'approval-required')
    assert.equal(verifier.endpoint.runtimeSettings.sandbox, 'read-only')
    await runtime.dispatchCommand({
      kind: 'abort_workflow_proposal', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'safe-default-verifier', reason: 'Continue tombstone test.' },
    })

    const fixId = fixture.mapping.relationshipSubscriptionIds['review-fix']
    await runtime.dispatchCommand({
      commandId: 'human-stop-review-fix', idempotencyKey: 'human-stop-review-fix',
      kind: 'stop_subscription', actor: { kind: 'human' },
      input: { subscriptionId: fixId, reason: 'Human removed automatic retries.' },
    })
    const active = runtime.getState().workflowPlans[fixture.workflowId]['1']
    assert.ok(active.relationships.every((item) => item.disabledByHuman && item.lockedByHuman))
    const replacement = await runtime.dispatchCommand({
      commandId: 'replace-after-human-stop', idempotencyKey: 'replace-after-human-stop',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'replace-after-human-stop', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Replace reviewer while preserving human-disabled edges.',
        operations: [{
          op: 'replace-participant', participantKey: 'reviewer',
          replacement: {
            prompt: 'Replacement reviewer.', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    await runtime.dispatchCommand({ kind: 'approve_workflow_proposal', actor: { kind: 'human' }, input: { proposalId: replacement.proposal.proposalId } })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-replace-after-human-stop', idempotencyKey: 'commit-replace-after-human-stop',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: replacement.proposal.proposalId, expectedBaseVersion: 1 },
    })
    assert.equal(committed.result.createdSubscriptionIds.length, 0)
    assert.equal(Object.keys(committed.executionMapping.relationshipSubscriptionIds).length, 0)
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a new replacement Session counts against cumulative Scope maxSessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-replace-budget-'))
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json') })
  try {
    const fixture = await activeReview(runtime)
    const extras = []
    for (let index = 0; index < 4; index += 1) {
      const created = await runtime.createSession({
        prompt: `Budget filler ${index}.`, cwd: process.cwd(),
        providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: `Filler ${index}`,
      })
      extras.push(created.sessionId)
    }
    await waitFor('budget fillers idle', () => extras.every((id) => runtime.getState().sessions[id]?.status === 'idle'))
    await runtime.dispatchCommand({
      kind: 'upsert_scope', actor: { kind: 'human' },
      input: {
        clusterId: 'review-scope', label: 'Review Project',
        nodeIds: [fixture.seedSessionId, fixture.mapping.participantSessionIds.coder, fixture.mapping.participantSessionIds.reviewer, ...extras],
      },
    })
    const proposed = await runtime.dispatchCommand({
      commandId: 'over-budget-replacement', idempotencyKey: 'over-budget-replacement',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        workflowId: fixture.workflowId, baseVersion: 1, reason: 'Replacement must consume a new Scope slot.',
        operations: [{
          op: 'replace-participant', participantKey: 'reviewer',
          replacement: {
            prompt: 'New reviewer.', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required' },
            workspace: { cwd: process.cwd(), access: 'read', workMode: 'local' },
          },
        }],
      },
    })
    assert.ok(proposed.proposal.validation.errors.some((issue) => issue.code === 'session-limit'))
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Council resynthesis crash restores synthesizer state and channel before retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-governor-council-crash-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const fixture = await activeCouncil(runtime)
    await waitFor('Council proposals for crash fixture', () => runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-cross-review')
    await runtime.startPlanCouncilCrossReview({ workflowId: fixture.councilWorkflowId })
    await waitFor('Council reviews for crash fixture', () => runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'ready-for-synthesis')
    await runtime.startPlanCouncilSynthesis({ workflowId: fixture.councilWorkflowId })
    await waitFor('Council completed before crash fixture', () => runtime.getState().planCouncils[fixture.councilWorkflowId]?.phase === 'completed')
    await runtime.dispatchCommand({
      commandId: 'council-crash-resynth-proposal', idempotencyKey: 'council-crash-resynth-proposal',
      kind: 'propose_workflow_patch', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: {
        proposalId: 'council-crash-resynth-proposal', workflowId: fixture.workflowId, baseVersion: 1,
        reason: 'Exercise durable Council resynthesis recovery.',
        operations: [{ op: 'resynthesize', reason: 'Retry synthesis safely.' }],
      },
    })
    await runtime.dispatchCommand({ kind: 'approve_workflow_proposal', actor: { kind: 'human' }, input: { proposalId: 'council-crash-resynth-proposal' } })
    const synthesizerId = runtime.getState().planCouncils[fixture.councilWorkflowId].synthesizerSessionId
    const manifestFile = path.join(root, 'channels', synthesizerId, 'manifest.json')
    const beforeManifest = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '[]'
    runtime.killAll()

    const crashedRuntime = new RuntimeSessionManager({ storageFile, workflowDeploymentCrashAfterStage: 'roots-started' })
    runtime = crashedRuntime
    await assert.rejects(crashedRuntime.dispatchCommand({
      commandId: 'council-crash-resynth-commit', idempotencyKey: 'council-crash-resynth-commit',
      kind: 'commit_workflow', actor: { kind: 'master', ref: fixture.masterSessionId },
      input: { proposalId: 'council-crash-resynth-proposal', expectedBaseVersion: 1 },
    }), /Injected workflow deployment crash/)
    runtime = new RuntimeSessionManager({ storageFile })
    crashedRuntime.killAll()
    assert.equal(runtime.getState().planCouncils[fixture.councilWorkflowId].phase, 'completed')
    assert.equal(runtime.getState().sessions[synthesizerId].status, 'idle')
    assert.equal(fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '[]', beforeManifest)
    assert.equal(runtime.getState().workflowProposals['council-crash-resynth-proposal'].status, 'approved')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
