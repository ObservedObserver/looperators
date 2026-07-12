import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileWorkflowPlan,
  defaultScopeWorkflowCapability,
  lockedPlanConflicts,
  validateWorkflowPlan,
  workflowExecutionStatus,
  workflowGraphDiff,
} from '../../dist-electron/shared/workflow-authoring.js'

const at = '2026-07-12T12:00:00.000Z'
const providers = ['codex-default', 'claude-default', 'grok-default']
const capability = defaultScopeWorkflowCapability('scope-1', providers, at)
const runtimeSettings = {
  runtimeMode: 'approval-required',
  approvalPolicy: 'never',
  sandbox: 'read-only',
  interactionMode: 'plan',
}
const context = {
  capability,
  providerInstanceIds: providers,
  sessions: {
    coder: {
      sessionId: 'coder',
      label: 'Existing Coder',
      cwd: '/tmp/project',
      status: 'idle',
      providerKind: 'codex',
      providerInstanceId: 'codex-default',
      runtimeSettings,
    },
    reviewer: {
      sessionId: 'reviewer',
      label: 'Existing Reviewer',
      cwd: '/tmp/project',
      status: 'idle',
      providerKind: 'claude-code',
      providerInstanceId: 'claude-default',
      runtimeSettings,
    },
  },
}

function compile(recipeInput, objective = 'Ship the requested change') {
  return compileWorkflowPlan({
    workflowId: `workflow-${recipeInput.recipe}`,
    version: 1,
    objective,
    recipeInput,
    scopeId: 'scope-1',
    autonomyPolicy: capability.policy,
    createdAt: at,
    createdBy: { kind: 'master', ref: 'master-1' },
    masterSessionId: 'master-1',
  }, context)
}

test('four built-in recipes compile to stable authoring plans without runtime ids', () => {
  const review = compile({
    recipe: 'review',
    input: {
      coder: { kind: 'existing', sessionId: 'coder', prompt: 'Implement it.' },
      reviewer: { kind: 'existing', sessionId: 'reviewer', instruction: 'Review correctness.' },
      blocking: { mode: 'any-issue' },
      maxLaps: 3,
    },
  })
  assert.deepEqual(review.participants.map(({ key }) => key), ['coder', 'reviewer'])
  assert.deepEqual(review.relationships.map(({ key }) => key), ['review-request', 'review-fix'])
  assert.deepEqual(review.relationships[0].runtimeStop, { whenReport: { verdict: 'clean' }, maxFirings: 3 })

  const goal = compile({
    recipe: 'goal',
    input: {
      worker: { kind: 'existing', sessionId: 'coder', prompt: 'Make tests pass.' },
      goal: 'All tests pass.',
      maxLaps: 4,
    },
  })
  assert.deepEqual(goal.participants.map(({ key }) => key), ['worker', 'judge'])
  assert.match(goal.relationships[0].stop, /max 4 laps/)
  assert.deepEqual(goal.relationships[0].runtimeStop, { whenReport: { verdict: 'done' }, maxFirings: 4 })

  const handoff = compile({
    recipe: 'handoff',
    input: {
      source: { kind: 'existing', sessionId: 'coder', prompt: '' },
      target: { kind: 'existing', sessionId: 'reviewer', prompt: '' },
      note: 'Continue from the latest result.',
    },
  })
  assert.equal(handoff.relationships.length, 1)
  assert.equal(handoff.relationships[0].trigger, 'one-shot')

  const council = compile({
    recipe: 'plan-council',
    input: {
      objective: 'Plan a durable queue.',
      cwd: '/tmp/project',
      planners: [
        { key: 'codex', label: 'Codex', providerKind: 'codex', providerInstanceId: 'codex-default', runtimeSettings },
        { key: 'claude', label: 'Claude', providerKind: 'claude-code', providerInstanceId: 'claude-default', runtimeSettings },
      ],
      synthesizer: { key: 'grok', label: 'Grok', providerKind: 'grok', providerInstanceId: 'grok-default', runtimeSettings },
    },
  }, 'Plan a durable queue.')
  assert.equal(council.participants.length, 3)
  assert.equal(council.relationships.length, 4)
  assert.ok(council.relationships.every(({ gate }) => gate === 'human'))
  assert.deepEqual(workflowGraphDiff(undefined, council).participants.add.map(({ key }) => key), [
    'planner:codex',
    'planner:claude',
    'synthesizer:grok',
  ])
})

test('validation exposes provider, workspace, concurrency, and approval before commit', () => {
  const restrictive = structuredClone(capability)
  restrictive.policy.allowedProviderInstanceIds = ['codex-default']
  restrictive.policy.maxConcurrentSessions = 1
  const plan = compileWorkflowPlan({
    workflowId: 'workflow-council',
    version: 1,
    objective: 'Compare plans',
    recipeInput: {
      recipe: 'plan-council',
      input: {
        objective: 'Compare plans',
        cwd: '/tmp/project',
        planners: [
          { key: 'a', label: 'A', providerKind: 'codex', providerInstanceId: 'codex-default', runtimeSettings },
          { key: 'b', label: 'B', providerKind: 'claude-code', providerInstanceId: 'claude-default', runtimeSettings },
        ],
        synthesizer: { key: 'c', label: 'C', providerKind: 'grok', providerInstanceId: 'missing-provider', runtimeSettings },
      },
    },
    scopeId: 'scope-1',
    autonomyPolicy: restrictive.policy,
    createdAt: at,
    createdBy: { kind: 'master' },
  }, { ...context, capability: restrictive })
  const validation = validateWorkflowPlan(plan, { ...context, capability: restrictive })
  assert.ok(validation.errors.some(({ code }) => code === 'concurrency-limit'))
  assert.ok(validation.warnings.some(({ code }) => code === 'provider-expansion'))
  assert.ok(validation.errors.some(({ code }) => code === 'provider-unavailable'))
  assert.equal(validation.requiresHumanApproval, true)
  assert.match(validation.approvalReasons[0], /approval/i)
})

test('large Council authoring projection is linear hub-and-spoke, not planner full mesh', () => {
  const planners = ['a', 'b', 'c', 'd', 'e'].map((key) => ({
    key, label: key.toUpperCase(), providerKind: 'codex',
    providerInstanceId: 'codex-default', runtimeSettings,
  }))
  const council = compile({
    recipe: 'plan-council',
    input: {
      objective: 'Compare five plans.', cwd: '/tmp/project', planners,
      synthesizer: { key: 's', label: 'Synth', providerKind: 'grok', providerInstanceId: 'grok-default', runtimeSettings },
      reviewTopology: 'hub-and-spoke',
    },
  })
  assert.equal(council.relationships.length, 10)
  assert.ok(council.relationships.every((relationship) => relationship.to === 'synthesizer:s'))
  assert.equal(council.relationships.filter((relationship) => relationship.key.startsWith('hub-review-input:')).length, 5)
  assert.equal(council.relationships.some((relationship) => relationship.key.startsWith('cross-review:')), false)
})

test('graph diff is version-independent and Master revision cannot override human locks', () => {
  const base = compile({
    recipe: 'review',
    input: {
      coder: { kind: 'existing', sessionId: 'coder', prompt: 'Implement it.' },
      reviewer: { kind: 'existing', sessionId: 'reviewer', instruction: 'Review correctness.' },
      blocking: { mode: 'any-issue' },
      maxLaps: 3,
    },
  })
  base.participants[0].lockedByHuman = true
  const next = structuredClone(base)
  next.version = 2
  next.participants[0].prompt = 'Ignore the human edit.'
  next.relationships[0].stop = 'max 8 laps'
  const diff = workflowGraphDiff(base, next)
  assert.deepEqual(diff.participants.update.map(({ key }) => key), ['coder'])
  assert.deepEqual(diff.relationships.update.map(({ key }) => key), ['review-request'])
  assert.deepEqual(lockedPlanConflicts(base, next).map(({ code }) => code), ['human-lock-conflict'])
})

test('committed Proposal status follows the mapped execution instead of staying permanently live', () => {
  const councilPlan = compile({
    recipe: 'plan-council',
    input: {
      objective: 'Compare plans.', cwd: '/tmp/project',
      planners: [
        { key: 'a', label: 'A', providerKind: 'codex', providerInstanceId: 'codex-default', runtimeSettings },
        { key: 'b', label: 'B', providerKind: 'claude-code', providerInstanceId: 'claude-default', runtimeSettings },
      ],
      synthesizer: { key: 's', label: 'S', providerKind: 'grok', providerInstanceId: 'grok-default', runtimeSettings },
    },
  })
  councilPlan.executionMapping = {
    planVersion: 1,
    participantSessionIds: { 'planner:a': 'a', 'planner:b': 'b', 'synthesizer:s': 's' },
    relationshipSubscriptionIds: {}, relationshipRuntimeRefs: {}, scopeIds: ['scope-1'],
    productWorkflowId: 'council-1', runId: 'run-1', committedAt: at,
  }
  const proposal = {
    proposalId: 'proposal-status', workflowId: councilPlan.workflowId, baseVersion: 0,
    proposedPlan: councilPlan, graphDiff: workflowGraphDiff(undefined, councilPlan),
    validation: { errors: [], warnings: [], estimatedSessionCount: 3, estimatedConcurrentSessions: 2, providerInstanceIds: providers, requiresHumanApproval: true, approvalReasons: [] },
    status: 'committed', idempotencyKey: 'status', createdAt: at, createdBy: { kind: 'human' }, updatedAt: at,
  }
  assert.equal(workflowExecutionStatus(proposal, { planCouncils: { 'council-1': { phase: 'drafting-plans' } } }), 'running')
  assert.equal(workflowExecutionStatus(proposal, { planCouncils: { 'council-1': { phase: 'completed' } } }), 'completed')
  assert.equal(workflowExecutionStatus(proposal, { planCouncils: { 'council-1': { phase: 'failed' } } }), 'failed')
  assert.equal(workflowExecutionStatus(proposal, { planCouncils: { 'council-1': { phase: 'stopped' } } }), 'stopped')

  const reviewPlan = compile({
    recipe: 'review',
    input: {
      coder: { kind: 'existing', sessionId: 'coder', prompt: 'Implement.' },
      reviewer: { kind: 'existing', sessionId: 'reviewer', instruction: 'Review.' },
      blocking: { mode: 'any-issue' }, maxLaps: 2,
    },
  })
  reviewPlan.executionMapping = {
    planVersion: 1, participantSessionIds: { coder: 'coder', reviewer: 'reviewer' },
    relationshipSubscriptionIds: { 'review-request': 'pass', 'review-fix': 'fix' },
    relationshipRuntimeRefs: {}, scopeIds: ['scope-1'], committedAt: at,
  }
  const reviewProposal = { ...proposal, proposedPlan: reviewPlan }
  assert.equal(workflowExecutionStatus(reviewProposal, {
    sessions: { coder: { status: 'idle' }, reviewer: { status: 'idle' } },
    loops: [{ status: 'stopped', subscriptionIds: ['pass', 'fix'], terminal: { reason: 'Report verdict clean satisfied the stop condition.' } }],
  }), 'completed')
  assert.equal(workflowExecutionStatus(reviewProposal, {
    sessions: { coder: { status: 'idle' }, reviewer: { status: 'idle' } },
    loops: [{ status: 'stopped', subscriptionIds: ['pass', 'fix'], terminal: { reason: 'Stopped by human.' } }],
  }), 'stopped')
  const goalPlan = compile({
    recipe: 'goal',
    input: {
      worker: { kind: 'existing', sessionId: 'coder', prompt: 'Finish.' },
      goal: 'Done.', maxLaps: 2,
    },
  })
  goalPlan.executionMapping = {
    planVersion: 1, participantSessionIds: { worker: 'coder', judge: 'judge' },
    relationshipSubscriptionIds: { 'goal-check': 'check', 'goal-retry': 'retry' },
    relationshipRuntimeRefs: {}, scopeIds: ['scope-1'], committedAt: at,
  }
  assert.equal(workflowExecutionStatus({ ...proposal, proposedPlan: goalPlan }, {
    sessions: { coder: { status: 'idle' }, judge: { status: 'idle' } },
    loops: [{ status: 'stopped', subscriptionIds: ['check', 'retry'], terminal: { reason: 'Report verdict done satisfied the stop condition.' } }],
  }), 'completed')
})
