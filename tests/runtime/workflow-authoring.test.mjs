import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function harness(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const storageFile = path.join(root, 'state.json')
  const runtime = new RuntimeSessionManager({ storageFile })
  return {
    root,
    storageFile,
    runtime,
    cleanup() {
      runtime.killAll()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function masterScope(runtime) {
  const worker = await runtime.createSession({
    prompt: 'Prepare project context.',
    cwd: process.cwd(),
    providerKind: 'claude-code',
    providerInstanceId: 'default-claude-sdk',
    label: 'Worker',
  })
  const master = await runtime.createSession({
    prompt: 'Coordinate this project.',
    cwd: process.cwd(),
    providerKind: 'claude-code',
    providerInstanceId: 'default-claude-sdk',
    label: 'Master',
  })
  await waitFor('scope sessions idle', () =>
    [worker.sessionId, master.sessionId].every((id) => runtime.getState().sessions[id]?.status === 'idle'))
  await runtime.dispatchCommand({
    kind: 'upsert_scope',
    actor: { kind: 'human' },
    input: { clusterId: 'scope-1', label: 'Project', nodeIds: [worker.sessionId, master.sessionId] },
  })
  await runtime.dispatchCommand({
    kind: 'assign_master',
    actor: { kind: 'human' },
    input: { clusterId: 'scope-1', sessionId: master.sessionId },
  })
  return { workerSessionId: worker.sessionId, masterSessionId: master.sessionId }
}

function councilRecipe() {
  const runtimeSettings = {
    runtimeMode: 'approval-required',
    sandbox: 'read-only',
    interactionMode: 'plan',
  }
  return {
    recipe: 'plan-council',
    input: {
      objective: 'Review this codebase and produce a staged implementation plan.',
      cwd: process.cwd(),
      reviewFocus: 'Architecture and verification.',
      planners: [
        { key: 'a', label: 'Planner A', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings },
        { key: 'b', label: 'Planner B', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings },
      ],
      synthesizer: { key: 's', label: 'Synthesizer', providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings },
    },
  }
}

test('Master proposal is authoring-only, human approval gates commit, and duplicate commit is idempotent', async () => {
  const { runtime, cleanup } = harness('orrery-workflow-authoring-')
  try {
    const { masterSessionId } = await masterScope(runtime)
    const before = runtime.getState()
    const proposed = await runtime.dispatchCommand({
      commandId: 'propose-council-command',
      idempotencyKey: 'propose-council-once',
      kind: 'propose_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: {
        proposalId: 'proposal-council',
        objective: 'Review this codebase and produce a staged implementation plan.',
        recipeInput: councilRecipe(),
        reason: 'The user asked for independent planning and synthesis.',
      },
    })
    assert.equal(proposed.proposal.status, 'proposed')
    assert.equal(proposed.proposal.validation.errors.length, 0)
    assert.equal(proposed.proposal.validation.requiresHumanApproval, true)
    const afterProposal = runtime.getState()
    assert.equal(Object.keys(afterProposal.sessions).length, Object.keys(before.sessions).length)
    assert.equal(afterProposal.nodes.length, before.nodes.length)
    assert.equal(Object.keys(afterProposal.subscriptions).length, Object.keys(before.subscriptions).length)
    assert.equal(Object.keys(afterProposal.planCouncils).length, 0)
    assert.equal(afterProposal.workflowPlans[proposed.proposal.workflowId]['1'].status, 'proposed')
    await assert.rejects(
      runtime.dispatchCommand({
        kind: 'commit_workflow',
        actor: { kind: 'master', ref: masterSessionId },
        input: { proposalId: 'proposal-council', expectedBaseVersion: 0, idempotencyKey: 'unapproved-commit' },
      }),
      /must be approved/,
    )

    const approved = await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal',
      actor: { kind: 'human' },
      input: { proposalId: 'proposal-council', reason: 'The graph diff is acceptable.' },
    })
    assert.equal(approved.proposal.status, 'approved')
    const commitCommand = {
      commandId: 'commit-council-command',
      idempotencyKey: 'commit-council-once',
      kind: 'commit_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-council', expectedBaseVersion: 0 },
    }
    const committed = await runtime.dispatchCommand(commitCommand)
    assert.equal(committed.proposal.status, 'committed')
    assert.equal(committed.plan.status, 'active')
    assert.equal(Object.keys(committed.executionMapping.participantSessionIds).length, 3)
    assert.equal(
      Object.keys(committed.executionMapping.relationshipRuntimeRefs).length,
      committed.plan.relationships.length,
    )
    assert.ok(committed.executionMapping.productWorkflowId)
    assert.ok(
      Object.values(committed.executionMapping.participantSessionIds).every((sessionId) =>
        runtime.getState().clusters['scope-1'].nodeIds.includes(sessionId)),
      'committed participants join the authorizing Scope',
    )
    const sessionCount = Object.keys(runtime.getState().sessions).length
    const repeated = await runtime.dispatchCommand(commitCommand)
    assert.equal(repeated.executionMapping.productWorkflowId, committed.executionMapping.productWorkflowId)
    assert.equal(Object.keys(runtime.getState().sessions).length, sessionCount)
    assert.equal(
      runtime.getKernelEvents({ limit: 500 }).events.filter((event) => event.type === 'workflow.committed').length,
      1,
    )
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'commit-council-wrong-base', idempotencyKey: 'commit-council-wrong-base',
        kind: 'commit_workflow', actor: { kind: 'master', ref: masterSessionId },
        input: { proposalId: 'proposal-council', expectedBaseVersion: 99 },
      }),
      /base version is 0/,
    )
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'commit-council-new-key', idempotencyKey: 'commit-council-new-key',
        kind: 'commit_workflow', actor: { kind: 'master', ref: masterSessionId },
        input: { proposalId: 'proposal-council', expectedBaseVersion: 0 },
      }),
      /already committed/,
    )
    const otherMaster = await runtime.createSession({
      prompt: 'Govern an unrelated scope.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Other Master',
    })
    const otherWorker = await runtime.createSession({
      prompt: 'Belong to an unrelated scope.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Other Worker',
    })
    await waitFor('other scope idle', () =>
      [otherMaster.sessionId, otherWorker.sessionId].every((id) => runtime.getState().sessions[id]?.status === 'idle'))
    await runtime.dispatchCommand({
      kind: 'upsert_scope', actor: { kind: 'human' },
      input: { clusterId: 'scope-other', label: 'Other', nodeIds: [otherWorker.sessionId] },
    })
    await runtime.dispatchCommand({
      kind: 'assign_master', actor: { kind: 'human' },
      input: { clusterId: 'scope-other', sessionId: otherMaster.sessionId },
    })
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'commit-council-cross-actor-replay', idempotencyKey: 'commit-council-once',
        kind: 'commit_workflow', actor: { kind: 'master', ref: otherMaster.sessionId },
        input: { proposalId: 'proposal-council', expectedBaseVersion: 0 },
      }),
      /replay identity mismatch/,
    )
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'commit-council-wrong-master', idempotencyKey: 'commit-council-wrong-master',
        kind: 'commit_workflow', actor: { kind: 'master', ref: otherMaster.sessionId },
        input: { proposalId: 'proposal-council', expectedBaseVersion: 0 },
      }),
      /cannot author outside Scope scope-other/,
    )
    const events = runtime.getKernelEvents({ limit: 500 }).events
    assert.equal(events.find((event) => event.type === 'workflow.committed').actor.kind, 'master')
    assert.equal(
      events.filter((event) => event.type === 'session.created' && event.actor.kind === 'master').length,
      3,
    )
  } finally {
    cleanup()
  }
})

test('Scope capability rejects cross-scope participants and cumulative session expansion', async () => {
  const { runtime, cleanup } = harness('orrery-workflow-scope-budget-')
  try {
    const { workerSessionId, masterSessionId } = await masterScope(runtime)
    const outside = await runtime.createSession({
      prompt: 'Outside participant.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
      runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
      label: 'Outside Reviewer',
    })
    const outsideMaster = await runtime.createSession({
      prompt: 'Govern another scope.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Outside Master',
    })
    await waitFor('outside sessions idle', () =>
      [outside.sessionId, outsideMaster.sessionId].every((id) => runtime.getState().sessions[id]?.status === 'idle'))
    await runtime.dispatchCommand({
      kind: 'upsert_scope', actor: { kind: 'human' },
      input: { clusterId: 'scope-2', label: 'Other Project', nodeIds: [outside.sessionId] },
    })
    await runtime.dispatchCommand({
      kind: 'assign_master', actor: { kind: 'human' },
      input: { clusterId: 'scope-2', sessionId: outsideMaster.sessionId },
    })

    const crossScope = await runtime.dispatchCommand({
      commandId: 'propose-cross-scope', idempotencyKey: 'propose-cross-scope',
      kind: 'propose_workflow', actor: { kind: 'master', ref: masterSessionId },
      input: {
        proposalId: 'proposal-cross-scope', recipe: 'review', objective: 'Review across scopes.',
        input: {
          coder: { kind: 'existing', sessionId: workerSessionId, prompt: 'Implement.' },
          reviewer: { kind: 'existing', sessionId: outside.sessionId, instruction: 'Review.' },
          blocking: { mode: 'any-issue' }, maxLaps: 2,
        },
      },
    })
    assert.ok(crossScope.proposal.validation.errors.some(({ code }) => code === 'session-outside-scope'))
    await assert.rejects(
      runtime.dispatchCommand({
        kind: 'approve_workflow_proposal', actor: { kind: 'human' },
        input: { proposalId: 'proposal-cross-scope' },
      }),
      /outside capability Scope/,
    )
    assert.ok(runtime.getState().clusters['scope-2'].nodeIds.includes(outside.sessionId))

    const extras = []
    for (let index = 0; index < 4; index += 1) {
      const created = await runtime.createSession({
        prompt: `Existing scoped participant ${index}.`, cwd: process.cwd(),
        providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: `Existing ${index}`,
      })
      extras.push(created.sessionId)
    }
    await waitFor('scope budget sessions idle', () => extras.every((id) => runtime.getState().sessions[id]?.status === 'idle'))
    await runtime.dispatchCommand({
      kind: 'upsert_scope', actor: { kind: 'human' },
      input: { clusterId: 'scope-1', label: 'Project', nodeIds: [workerSessionId, ...extras] },
    })
    const overBudget = await runtime.dispatchCommand({
      commandId: 'propose-over-budget', idempotencyKey: 'propose-over-budget',
      kind: 'propose_workflow', actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-over-budget', recipeInput: councilRecipe() },
    })
    assert.ok(overBudget.proposal.validation.errors.some(({ code }) => code === 'session-limit'))
    assert.equal(overBudget.proposal.validation.estimatedSessionCount, 9)
  } finally {
    cleanup()
  }
})

test('Review Proposal keeps writable defaults native-auto and the Reviewer read-only', async () => {
  const { runtime, cleanup } = harness('orrery-workflow-review-safety-')
  try {
    const { masterSessionId } = await masterScope(runtime)
    const endpoint = (label, prompt, runtimeMode) => ({
      kind: 'new', label, prompt, cwd: process.cwd(), workMode: 'local',
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
      ...(runtimeMode ? { runtimeSettings: { runtimeMode } } : {}),
    })
    const proposed = await runtime.dispatchCommand({
      commandId: 'standalone-review-propose', idempotencyKey: 'standalone-review-propose',
      kind: 'propose_workflow', actor: { kind: 'master', ref: masterSessionId },
      input: {
        proposalId: 'proposal-review-safety', scopeId: 'scope-1', recipe: 'review', objective: 'Implement and review safely.',
        input: {
          coder: endpoint('Coder', 'Implement the change.'),
          reviewer: {
            kind: 'new', label: 'Reviewer', instruction: 'Review correctness.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'full-access' },
          },
          blocking: { mode: 'any-issue' }, maxLaps: 2,
        },
      },
    })
    const coderPlan = proposed.proposal.proposedPlan.participants.find((item) => item.key === 'coder')
    const reviewerPlan = proposed.proposal.proposedPlan.participants.find((item) => item.key === 'reviewer')
    assert.equal(coderPlan.workspace.access, 'write')
    assert.equal(coderPlan.endpoint.runtimeSettings.runtimeMode, 'auto')
    assert.equal(reviewerPlan.workspace.access, 'read')
    assert.equal(reviewerPlan.endpoint.runtimeSettings.runtimeMode, 'approval-required')
    assert.equal(reviewerPlan.endpoint.runtimeSettings.sandbox, 'read-only')
    assert.equal(proposed.proposal.validation.errors.length, 0)
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'proposal-review-safety' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'standalone-review-commit', idempotencyKey: 'standalone-review-commit',
      kind: 'commit_workflow', actor: { kind: 'human' },
      input: { proposalId: 'proposal-review-safety', expectedBaseVersion: 0 },
    })
    const coderSessionId = committed.executionMapping.participantSessionIds.coder
    const reviewerSessionId = committed.executionMapping.participantSessionIds.reviewer
    assert.equal(runtime.getState().sessions[coderSessionId].runtimeSettings.runtimeMode, 'auto')
    assert.equal(runtime.getState().sessions[reviewerSessionId].runtimeSettings.runtimeMode, 'approval-required')
    assert.equal(runtime.getState().sessions[reviewerSessionId].runtimeSettings.sandbox, 'read-only')
  } finally {
    cleanup()
  }
})

test('validation blocks unavailable providers and human locks survive and reject Master revision', async () => {
  const { root, runtime, cleanup } = harness('orrery-workflow-locks-')
  try {
    const { masterSessionId } = await masterScope(runtime)
    const invalidRecipe = councilRecipe()
    invalidRecipe.input.planners[1].providerInstanceId = 'missing-provider'
    invalidRecipe.input.cwd = path.join(root, 'missing-workspace')
    const invalid = await runtime.dispatchCommand({
      kind: 'propose_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-invalid', recipeInput: invalidRecipe, idempotencyKey: 'proposal-invalid' },
    })
    assert.ok(invalid.proposal.validation.errors.some(({ code }) => code === 'provider-unavailable'))
    assert.ok(invalid.proposal.validation.errors.some(({ code }) => code === 'workspace-unavailable'))
    await assert.rejects(
      runtime.dispatchCommand({
        kind: 'approve_workflow_proposal',
        actor: { kind: 'human' },
        input: { proposalId: 'proposal-invalid' },
      }),
      /validation errors/,
    )

    await runtime.dispatchCommand({
      kind: 'propose_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-locked', recipeInput: councilRecipe(), idempotencyKey: 'proposal-locked' },
    })
    await runtime.dispatchCommand({
      kind: 'lock_workflow_item',
      actor: { kind: 'human' },
      input: { proposalId: 'proposal-locked', kind: 'participant', key: 'planner:a' },
    })
    const revisedRecipe = councilRecipe()
    revisedRecipe.input.planners[0].label = 'Master replacement'
    await assert.rejects(
      runtime.dispatchCommand({
        kind: 'revise_workflow',
        actor: { kind: 'master', ref: masterSessionId },
        input: { proposalId: 'proposal-locked', recipeInput: revisedRecipe },
      }),
      /human-locked participant planner:a/,
    )
    assert.equal(
      runtime.getState().workflowProposals['proposal-locked'].proposedPlan.participants[0].label,
      'Planner A',
    )
  } finally {
    cleanup()
  }
})

test('Workflow Plan, Proposal, Graph Diff, capability, and execution mapping survive restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-workflow-restart-'))
  const storageFile = path.join(root, 'state.json')
  let runtime = new RuntimeSessionManager({ storageFile })
  try {
    const { masterSessionId } = await masterScope(runtime)
    const proposed = await runtime.dispatchCommand({
      kind: 'propose_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-persisted', recipeInput: councilRecipe(), idempotencyKey: 'proposal-persisted' },
    })
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'proposal-persisted' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-persisted', idempotencyKey: 'commit-persisted',
      kind: 'commit_workflow', actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-persisted', expectedBaseVersion: 0 },
    })
    runtime.killAll()
    runtime = new RuntimeSessionManager({ storageFile })
    const restored = runtime.getState()
    assert.equal(restored.workflowProposals['proposal-persisted'].workflowId, proposed.proposal.workflowId)
    assert.equal(restored.workflowProposals['proposal-persisted'].status, 'committed')
    assert.equal(restored.workflowPlans[proposed.proposal.workflowId]['1'].recipe, 'plan-council')
    assert.ok(restored.workflowProposals['proposal-persisted'].graphDiff.participants.add.length > 0)
    assert.equal(restored.workflowCapabilities['scope-1'].policy.mode, 'review-first')
    assert.deepEqual(
      restored.workflowProposals['proposal-persisted'].proposedPlan.executionMapping,
      committed.executionMapping,
    )
    assert.equal(runtime.inspectWorkflowScope({}, masterSessionId).scope.scopeId, 'scope-1')
    assert.equal(runtime.explainWorkflow({ proposalId: 'proposal-persisted' }, masterSessionId).recipe, 'plan-council')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Master membrane exposes all four proposal recipes while raw authoring and cross-scope operations are denied', async () => {
  const { runtime, cleanup } = harness('orrery-workflow-membrane-')
  try {
    const { workerSessionId, masterSessionId } = await masterScope(runtime)
    const newAgent = (label, prompt) => ({
      kind: 'new',
      label,
      prompt,
      cwd: process.cwd(),
      workMode: 'local',
      providerKind: 'claude-code',
      providerInstanceId: 'default-claude-sdk',
      runtimeSettings: { runtimeMode: 'approval-required' },
    })
    const recipes = [
      {
        recipe: 'review',
        objective: 'Review a change until clean.',
        input: {
          coder: newAgent('Coder', 'Implement the change.'),
          reviewer: {
            kind: 'new', label: 'Reviewer', instruction: 'Review correctness.',
            providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
            runtimeSettings: { runtimeMode: 'approval-required' },
          },
          blocking: { mode: 'any-issue' }, maxLaps: 3,
        },
      },
      {
        recipe: 'goal',
        objective: 'Reach a verifiable goal.',
        input: { worker: newAgent('Worker', 'Make progress.'), goal: 'All tests pass.', maxLaps: 3 },
      },
      {
        recipe: 'handoff',
        objective: 'Hand work to a receiver.',
        input: { source: newAgent('Source', 'Prepare context.'), target: newAgent('Target', 'Continue.'), note: 'Continue once.' },
      },
      {
        recipe: 'plan-council',
        objective: 'Compare plans.',
        input: {
          objective: 'Compare plans.',
          planners: [{ key: 'a', label: 'Planner A' }, { key: 'b', label: 'Planner B' }],
          synthesizer: { key: 's', label: 'Synthesizer' },
        },
      },
    ]
    const before = runtime.getState()
    for (const [index, recipe] of recipes.entries()) {
      const result = await runtime.handleMembraneRequest({
        tool: 'propose_workflow',
        source: masterSessionId,
        input: { ...recipe, reason: `Use ${recipe.recipe} for this intent.`, idempotencyKey: `membrane-proposal-${index}` },
      })
      assert.equal(result.recipe, recipe.recipe)
      assert.equal(result.validation.errors.length, 0)
      assert.equal('state' in result, false)
      assert.ok(JSON.stringify(result).length < 12_000, 'Master tool result stays inline-readable')
      if (recipe.recipe === 'plan-council') {
        assert.ok(result.participants.every((participant) => participant.workspace.cwd === process.cwd()))
        assert.ok(result.participants.every((participant) => participant.workspace.access === 'read'))
      }
    }
    const after = runtime.getState()
    assert.equal(Object.keys(after.sessions).length, Object.keys(before.sessions).length)
    assert.equal(after.nodes.length, before.nodes.length)
    assert.equal(Object.keys(after.subscriptions).length, Object.keys(before.subscriptions).length)
    const inspected = await runtime.handleMembraneRequest({ tool: 'inspect_scope', source: masterSessionId, input: { pageSize: 1 } })
    assert.equal(inspected.scope.scopeId, 'scope-1')
    assert.equal(inspected.sessionRefs.length, 1)
    assert.ok(inspected.nextCursor)

    await assert.rejects(
      runtime.handleMembraneRequest({
        tool: 'create_session', source: masterSessionId,
        input: { agent: 'claude-code', prompt: 'Bypass proposal.' },
      }),
      /cannot create raw graph nodes/,
    )
    await assert.rejects(
      runtime.handleMembraneRequest({
        tool: 'propose_workflow', source: workerSessionId,
        input: { ...recipes[0], reason: 'Worker tries to author.', idempotencyKey: 'worker-authoring-denied' },
      }),
      /Only a human or Scope Master|real Master session/,
    )
    const outside = await runtime.createSession({
      prompt: 'Outside scope.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
    })
    await assert.rejects(
      runtime.handleMembraneRequest({
        tool: 'deliver', source: masterSessionId,
        input: { sessionId: outside.sessionId, content: 'Cross scope.' },
      }),
      /outside its governed Scope/,
    )
    const outsideSource = await runtime.createSession({
      prompt: 'Produce outside work.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Outside Source',
    })
    const outsideMaster = await runtime.createSession({
      prompt: 'Govern outside work.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', label: 'Outside Master',
    })
    await waitFor('outside gate sessions idle', () =>
      [outside.sessionId, outsideSource.sessionId, outsideMaster.sessionId]
        .every((id) => runtime.getState().sessions[id]?.status === 'idle'))
    runtime.upsertCluster({
      clusterId: 'scope-outside', label: 'Outside', nodeIds: [outsideSource.sessionId, outside.sessionId],
    })
    runtime.assignMasterToCluster({ clusterId: 'scope-outside', sessionId: outsideMaster.sessionId })
    const authored = runtime.authorSubscription({
      sourceSessionId: outsideSource.sessionId,
      on: { on: 'finished' },
      targetSessionId: outside.sessionId,
      action: { kind: 'deliver+activate' },
      gate: 'master',
    })
    const slotKey = `${authored.subscription.id}→${outside.sessionId}`
    await runtime.resumeSession({ sessionId: outsideSource.sessionId, message: 'Finish outside work.' })
    await waitFor('outside pending activation', () => runtime.getState().pendingActivations?.[slotKey])
    await assert.rejects(
      runtime.handleMembraneRequest({
        tool: 'approve_activation', source: masterSessionId, input: { slotKey },
      }),
      /outside its governed Scope/,
    )
    await runtime.handleMembraneRequest({
      tool: 'deny_activation', source: outsideMaster.sessionId, input: { slotKey, reason: 'Test cleanup.' },
    })
  } finally {
    cleanup()
  }
})

test('Goal commit executes the Proposal-declared read-only Judge settings', async () => {
  const { runtime, cleanup } = harness('orrery-workflow-goal-safety-')
  try {
    const { masterSessionId } = await masterScope(runtime)
    const proposed = await runtime.dispatchCommand({
      commandId: 'propose-goal-safety',
      idempotencyKey: 'propose-goal-safety',
      kind: 'propose_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: {
        proposalId: 'proposal-goal-safety',
        recipe: 'goal',
        objective: 'Reach a deterministic done condition.',
        input: {
          worker: { kind: 'new', label: 'Worker', prompt: 'Make progress.' },
          goal: 'The requested result exists.',
          maxLaps: 2,
        },
        reason: 'A Judge should verify completion without write access.',
      },
    })
    const judgePlan = proposed.proposal.proposedPlan.participants.find((item) => item.key === 'judge')
    assert.equal(judgePlan.endpoint.runtimeSettings.sandbox, 'read-only')
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'proposal-goal-safety' },
    })
    const committed = await runtime.dispatchCommand({
      commandId: 'commit-goal-safety',
      idempotencyKey: 'commit-goal-safety',
      kind: 'commit_workflow',
      actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-goal-safety', expectedBaseVersion: 0 },
    })
    const judgeSessionId = committed.executionMapping.participantSessionIds.judge
    assert.equal(runtime.getState().sessions[judgeSessionId].runtimeSettings.sandbox, 'read-only')
    assert.equal(runtime.getState().sessions[judgeSessionId].runtimeSettings.runtimeMode, 'approval-required')
  } finally {
    cleanup()
  }
})

test('failed Proposal commit rolls authoring status and execution resources back to approved', async () => {
  const { root, runtime, cleanup } = harness('orrery-workflow-commit-rollback-')
  try {
    const { masterSessionId } = await masterScope(runtime)
    runtime.upsertProviderInstance({
      providerInstanceId: 'broken-council-provider',
      kind: 'claude-code',
      label: 'Broken Council provider',
      binaryPath: path.join(root, 'missing-provider-binary'),
    })
    const recipe = councilRecipe()
    recipe.input.planners[1].providerInstanceId = 'broken-council-provider'
    const proposed = await runtime.dispatchCommand({
      commandId: 'propose-broken-council', idempotencyKey: 'propose-broken-council',
      kind: 'propose_workflow', actor: { kind: 'master', ref: masterSessionId },
      input: { proposalId: 'proposal-broken-council', recipeInput: recipe },
    })
    assert.equal(proposed.proposal.validation.errors.length, 0, 'configured provider passes preflight identity checks')
    await runtime.dispatchCommand({
      kind: 'approve_workflow_proposal', actor: { kind: 'human' },
      input: { proposalId: 'proposal-broken-council' },
    })
    const beforeSessionIds = Object.keys(runtime.getState().sessions).sort()
    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'commit-broken-council', idempotencyKey: 'commit-broken-council',
        kind: 'commit_workflow', actor: { kind: 'master', ref: masterSessionId },
        input: { proposalId: 'proposal-broken-council', expectedBaseVersion: 0 },
      }),
      /failed|could not start|missing-provider-binary/i,
    )
    const state = runtime.getState()
    assert.deepEqual(Object.keys(state.sessions).sort(), beforeSessionIds)
    assert.equal(Object.keys(state.planCouncils).length, 0)
    assert.equal(state.workflowProposals['proposal-broken-council'].status, 'approved')
    assert.equal(state.workflowProposals['proposal-broken-council'].proposedPlan.status, 'proposed')
    assert.equal(runtime.getWorkflowDeployments({ status: 'in_progress' }).deployments.length, 0)
    assert.equal(
      runtime.getWorkflowDeployments().deployments.find((item) => item.commandId === 'commit-broken-council')?.status,
      'aborted',
    )
  } finally {
    cleanup()
  }
})
