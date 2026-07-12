import type {
  GoalWorkflowStartInput,
  HandoffWorkflowStartInput,
  WorkflowAgentEndpoint,
} from './classic-workflow.js'
import {
  validateGoalWorkflowStart,
  validateHandoffWorkflowStart,
} from './classic-workflow.js'
import type { StartPlanCouncilInput } from './plan-council.js'
import { validatePlanCouncilStart } from './plan-council.js'
import type {
  ReviewRuntimeSettings,
  ReviewWorkflowStartInput,
  ReviewWorkflowValidationContext,
} from './review-workflow.js'
import { validateReviewWorkflowStart } from './review-workflow.js'
import type { DynamicCreateAction } from './dynamic-topology.js'
import { validateDynamicCreateAction } from './dynamic-topology.js'

export const workflowRecipes = ['review', 'goal', 'handoff', 'plan-council'] as const
export const workflowPlanStatuses = [
  'draft',
  'proposed',
  'committing',
  'active',
  'replanning',
  'completed',
  'aborted',
  'superseded',
] as const
export const workflowProposalStatuses = [
  'proposed',
  'approved',
  'committed',
  'rejected',
  'expired',
] as const

export type WorkflowRecipe = (typeof workflowRecipes)[number]
export type WorkflowPlanStatus = (typeof workflowPlanStatuses)[number]
export type WorkflowProposalStatus = (typeof workflowProposalStatuses)[number]
export type WorkflowManagedBy = 'master' | 'human'
export type WorkflowAccess = 'read' | 'write'

export type WorkflowRecipeInput =
  | { recipe: 'review'; input: ReviewWorkflowStartInput }
  | { recipe: 'goal'; input: GoalWorkflowStartInput }
  | { recipe: 'handoff'; input: HandoffWorkflowStartInput }
  | { recipe: 'plan-council'; input: StartPlanCouncilInput }

export type WorkflowParticipantEndpoint =
  | {
      kind: 'new'
      providerKind: 'claude-code' | 'codex' | 'grok'
      providerInstanceId: string
      runtimeSettings: ReviewRuntimeSettings & Record<string, unknown>
    }
  | { kind: 'existing'; sessionId: string }

export type WorkflowParticipantSpec = {
  key: string
  role: string
  label: string
  endpoint: WorkflowParticipantEndpoint
  prompt: string
  workspace: {
    cwd?: string
    access: WorkflowAccess
    workMode: 'local' | 'worktree'
    branch?: string
  }
  managedBy: WorkflowManagedBy
  lockedByHuman?: boolean
}

export type WorkflowRelationshipSpec = {
  key: string
  from: string
  to: string
  recipe: string
  trigger: string
  action: 'deliver' | 'deliver+activate' | DynamicCreateAction
  stop?: string
  runtimeStop?: { whenReport?: Record<string, string>; maxFirings?: number }
  gate: 'auto' | 'master' | 'human'
  concurrency: 'coalesce' | 'queue' | 'drop' | 'interrupt'
  managedBy: WorkflowManagedBy
  lockedByHuman?: boolean
  disabledByHuman?: { at: string; reason: string }
}

export type WorkflowAutonomyPolicy = {
  mode: 'review-first' | 'auto-within-scope' | 'ask-on-expansion'
  allowedProviderInstanceIds: string[]
  mayCreateSessions: boolean
  mayModifyRelationships: boolean
  mayStopWorkflow: boolean
  mayExpandScope: boolean
  maxSessions: number
  maxConcurrentSessions: number
  maxFanout: number
  maxVersions: number
  requireApprovalFor: Array<'commit' | 'scope-expansion' | 'write-access' | 'new-provider'>
}

export type ScopeWorkflowCapability = {
  scopeId: string
  policy: WorkflowAutonomyPolicy
  updatedAt: string
  updatedBy: 'human' | 'runtime'
}

export type WorkflowExecutionMapping = {
  planVersion: number
  participantSessionIds: Record<string, string>
  relationshipSubscriptionIds: Record<string, string>
  relationshipRuntimeRefs: Record<
    string,
    { kind: 'subscription' | 'product-phase' | 'one-shot'; ref: string }
  >
  scopeIds: string[]
  productWorkflowId?: string
  runId?: string
  committedAt: string
}

export type WorkflowPlan = {
  workflowId: string
  version: number
  objective: string
  recipe: WorkflowRecipe
  recipeInput: WorkflowRecipeInput
  masterSessionId?: string
  scopeId: string
  status: WorkflowPlanStatus
  participants: WorkflowParticipantSpec[]
  relationships: WorkflowRelationshipSpec[]
  autonomyPolicy: WorkflowAutonomyPolicy
  createdAt: string
  createdBy: { kind: 'master' | 'human'; ref?: string }
  supersedesVersion?: number
  reason?: string
  executionMapping?: WorkflowExecutionMapping
}

export type WorkflowDiffEntry<T> = {
  key: string
  before?: T
  after?: T
}

export type WorkflowGraphDiff = {
  participants: {
    add: WorkflowDiffEntry<WorkflowParticipantSpec>[]
    update: WorkflowDiffEntry<WorkflowParticipantSpec>[]
    remove: WorkflowDiffEntry<WorkflowParticipantSpec>[]
  }
  relationships: {
    add: WorkflowDiffEntry<WorkflowRelationshipSpec>[]
    update: WorkflowDiffEntry<WorkflowRelationshipSpec>[]
    remove: WorkflowDiffEntry<WorkflowRelationshipSpec>[]
  }
}

export type WorkflowPatchOperation =
  | {
      op: 'replace-participant'
      participantKey: string
      replacement: WorkflowParticipantSpec
    }
  | {
      op: 'add-verifier'
      verifier: WorkflowParticipantSpec
      observes: string[]
      trigger?: 'finished' | 'report'
      gate?: WorkflowRelationshipSpec['gate']
      stop?: string
    }
  | {
      op: 'stop-branch'
      relationshipKeys: string[]
      reason: string
    }
  | {
      op: 'change-relationship-policy'
      relationshipKey: string
      gate?: WorkflowRelationshipSpec['gate']
      stop?: string
    }
  | {
      op: 'resynthesize'
      reason: string
    }
  | {
      op: 'add-dynamic-triage'
      relationshipKey: string
      sourceParticipantKey: string
      ownerParticipantKey: string
      action: DynamicCreateAction
      maxFirings: number
      gate?: WorkflowRelationshipSpec['gate']
    }

export type WorkflowPatchImpact = {
  addedParticipantKeys: string[]
  replacedParticipantKeys: string[]
  addedRelationshipKeys: string[]
  stoppedRelationshipKeys: string[]
  updatedRelationshipKeys: string[]
  requiresNewSessions: number
  preservesSessionKeys: string[]
}

export type WorkflowPatchRollback = {
  strategy: 'restore-base-version'
  baseVersion: number
  stopCreatedSessionKeys: string[]
  restoreRelationshipKeys: string[]
  note: string
}

export type WorkflowPatch = {
  baseVersion: number
  wakeupIds: string[]
  reason: string
  operations: WorkflowPatchOperation[]
  impact: WorkflowPatchImpact
  rollback: WorkflowPatchRollback
}

export type WorkflowValidationIssue = {
  field: string
  message: string
  code?: string
}

export type WorkflowProposal = {
  proposalId: string
  workflowId: string
  baseVersion: number
  proposedPlan: WorkflowPlan
  graphDiff: WorkflowGraphDiff
  patch?: WorkflowPatch
  validation: {
    errors: WorkflowValidationIssue[]
    warnings: WorkflowValidationIssue[]
    estimatedSessionCount: number
    estimatedConcurrentSessions: number
    providerInstanceIds: string[]
    requiresHumanApproval: boolean
    approvalReasons: string[]
  }
  status: WorkflowProposalStatus
  idempotencyKey: string
  createdAt: string
  createdBy: { kind: 'master' | 'human'; ref?: string }
  updatedAt: string
  approvedAt?: string
  approvedBy?: string
  committedAt?: string
  rejectedAt?: string
  rejectionReason?: string
  expiresAt?: string
}

export type WorkflowAuthoringSession = {
  sessionId: string
  label?: string
  cwd: string
  status: string
  frozen?: boolean
  providerKind: 'claude-code' | 'codex' | 'grok'
  providerInstanceId: string
  runtimeSettings?: ReviewRuntimeSettings & Record<string, unknown>
}

export type WorkflowAuthoringContext = {
  sessions?: Record<string, WorkflowAuthoringSession>
  /** Session ids already governed by this capability scope. */
  scopeSessionIds?: string[]
  /** Participant keys whose sessions are already materialized by the active base version. */
  existingParticipantKeys?: string[]
  providerInstanceIds?: string[]
  capability: ScopeWorkflowCapability
}

export function defaultScopeWorkflowCapability(
  scopeId: string,
  providerInstanceIds: string[],
  updatedAt: string,
): ScopeWorkflowCapability {
  return {
    scopeId,
    policy: {
      mode: 'review-first',
      allowedProviderInstanceIds: [...new Set(providerInstanceIds)].sort(),
      mayCreateSessions: true,
      mayModifyRelationships: true,
      mayStopWorkflow: true,
      mayExpandScope: false,
      maxSessions: 8,
      maxConcurrentSessions: 4,
      maxFanout: 4,
      maxVersions: 20,
      requireApprovalFor: ['commit', 'scope-expansion', 'write-access', 'new-provider'],
    },
    updatedAt,
    updatedBy: 'runtime',
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function stableEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function runtimeStopFromDisplay(stop: string) {
  const max = stop.match(/max\D+(\d+)/i)
  const verdict = /clean/i.test(stop) ? 'clean' : /done/i.test(stop) ? 'done' : undefined
  return {
    ...(verdict ? { whenReport: { verdict } } : {}),
    ...(max ? { maxFirings: Number(max[1]) } : {}),
  }
}

function diffByKey<T extends { key: string }>(before: T[], after: T[]) {
  const previous = new Map(before.map((item) => [item.key, item]))
  const next = new Map(after.map((item) => [item.key, item]))
  const add: WorkflowDiffEntry<T>[] = []
  const update: WorkflowDiffEntry<T>[] = []
  const remove: WorkflowDiffEntry<T>[] = []
  for (const item of after) {
    const old = previous.get(item.key)
    if (!old) add.push({ key: item.key, after: clone(item) })
    else if (!stableEqual(old, item)) update.push({ key: item.key, before: clone(old), after: clone(item) })
  }
  for (const item of before) {
    if (!next.has(item.key)) remove.push({ key: item.key, before: clone(item) })
  }
  return { add, update, remove }
}

export function workflowGraphDiff(base: WorkflowPlan | undefined, next: WorkflowPlan): WorkflowGraphDiff {
  return {
    participants: diffByKey(base?.participants ?? [], next.participants),
    relationships: diffByKey(base?.relationships ?? [], next.relationships),
  }
}

export function applyWorkflowPatch(
  base: WorkflowPlan,
  input: {
    version: number
    createdAt: string
    createdBy: WorkflowPlan['createdBy']
    reason: string
    wakeupIds?: string[]
    operations: WorkflowPatchOperation[]
  },
): { plan: WorkflowPlan; patch: WorkflowPatch } {
  if (input.version !== base.version + 1) {
    throw new Error(`Workflow Patch version must be ${base.version + 1}.`)
  }
  if (!input.reason.trim()) throw new Error('Workflow Patch requires a reason.')
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error('Workflow Patch requires at least one operation.')
  }

  const plan = clone(base)
  plan.version = input.version
  plan.status = 'proposed'
  plan.createdAt = input.createdAt
  plan.createdBy = clone(input.createdBy)
  plan.reason = input.reason.trim()
  plan.supersedesVersion = base.version
  delete plan.executionMapping

  const addedParticipantKeys = new Set<string>()
  const replacedParticipantKeys = new Set<string>()
  const addedRelationshipKeys = new Set<string>()
  const stoppedRelationshipKeys = new Set<string>()
  const updatedRelationshipKeys = new Set<string>()

  const participant = (key: string) => plan.participants.find((item) => item.key === key)
  const relationshipByKey = (key: string) => plan.relationships.find((item) => item.key === key)

  for (const operation of input.operations) {
    if (operation.op === 'replace-participant') {
      const index = plan.participants.findIndex((item) => item.key === operation.participantKey)
      if (index < 0) throw new Error(`Unknown Workflow participant: ${operation.participantKey}`)
      if (plan.participants[index].lockedByHuman) {
        throw new Error(`Human-locked participant cannot be replaced: ${operation.participantKey}`)
      }
      if (operation.replacement.key !== operation.participantKey) {
        throw new Error('Replacement participant must preserve the participant key.')
      }
      plan.participants[index] = { ...clone(operation.replacement), managedBy: 'master' }
      replacedParticipantKeys.add(operation.participantKey)
      continue
    }

    if (operation.op === 'add-verifier') {
      if (participant(operation.verifier.key)) {
        throw new Error(`Workflow participant already exists: ${operation.verifier.key}`)
      }
      if (operation.verifier.lockedByHuman) {
        throw new Error('A Master-created verifier cannot claim a human lock.')
      }
      const observes = [...new Set(operation.observes.map((key) => key.trim()).filter(Boolean))]
      if (observes.length === 0) throw new Error('add-verifier requires at least one observed participant.')
      for (const sourceKey of observes) {
        if (!participant(sourceKey)) throw new Error(`Unknown observed participant: ${sourceKey}`)
      }
      plan.participants.push({ ...clone(operation.verifier), managedBy: 'master' })
      addedParticipantKeys.add(operation.verifier.key)
      for (const sourceKey of observes) {
        const key = `verify:${sourceKey}:${operation.verifier.key}`
        if (relationshipByKey(key)) throw new Error(`Workflow relationship already exists: ${key}`)
        plan.relationships.push({
          key,
          from: sourceKey,
          to: operation.verifier.key,
          recipe: `${base.recipe}:verifier`,
          trigger: operation.trigger ?? 'finished',
          action: 'deliver+activate',
          ...(operation.stop ? { stop: operation.stop } : {}),
          gate: operation.gate ?? 'auto',
          concurrency: 'coalesce',
          managedBy: 'master',
        })
        addedRelationshipKeys.add(key)
      }
      continue
    }

    if (operation.op === 'add-dynamic-triage') {
      if (!operation.relationshipKey.trim()) throw new Error('add-dynamic-triage requires relationshipKey.')
      if (relationshipByKey(operation.relationshipKey)) {
        throw new Error(`Workflow relationship already exists: ${operation.relationshipKey}`)
      }
      if (!participant(operation.sourceParticipantKey)) {
        throw new Error(`Unknown dynamic triage source participant: ${operation.sourceParticipantKey}`)
      }
      if (!participant(operation.ownerParticipantKey)) {
        throw new Error(`Unknown dynamic triage owner participant: ${operation.ownerParticipantKey}`)
      }
      const actionValidation = validateDynamicCreateAction(operation.action)
      if (!actionValidation.ok) throw new Error(actionValidation.errors.join(' '))
      if (!Number.isSafeInteger(operation.maxFirings) || operation.maxFirings < 1) {
        throw new Error('add-dynamic-triage maxFirings must be a positive integer.')
      }
      plan.relationships.push({
        key: operation.relationshipKey,
        from: operation.sourceParticipantKey,
        to: operation.ownerParticipantKey,
        recipe: `${base.recipe}:dynamic-triage`,
        trigger: 'report:issues',
        action: clone(operation.action),
        stop: `max ${operation.maxFirings} issue reports`,
        runtimeStop: { maxFirings: operation.maxFirings },
        gate: operation.gate ?? 'auto',
        concurrency: 'queue',
        managedBy: 'master',
      })
      addedRelationshipKeys.add(operation.relationshipKey)
      continue
    }

    if (operation.op === 'stop-branch') {
      if (!operation.reason.trim()) throw new Error('stop-branch requires a reason.')
      const keys = new Set(operation.relationshipKeys)
      for (const key of keys) {
        const existing = relationshipByKey(key)
        if (!existing) throw new Error(`Unknown Workflow relationship: ${key}`)
        if (existing.lockedByHuman) throw new Error(`Human-locked relationship cannot be stopped: ${key}`)
        stoppedRelationshipKeys.add(key)
      }
      plan.relationships = plan.relationships.filter((item) => !keys.has(item.key))
      continue
    }

    if (operation.op === 'resynthesize') {
      if (base.recipe !== 'plan-council') throw new Error('resynthesize is only valid for Plan Council.')
      if (!operation.reason.trim()) throw new Error('resynthesize requires a reason.')
      continue
    }

    const existing = relationshipByKey(operation.relationshipKey)
    if (!existing) throw new Error(`Unknown Workflow relationship: ${operation.relationshipKey}`)
    if (existing.lockedByHuman) {
      throw new Error(`Human-locked relationship cannot be changed: ${operation.relationshipKey}`)
    }
    if (operation.gate === undefined && operation.stop === undefined) {
      throw new Error('change-relationship-policy requires gate or stop.')
    }
    if (operation.gate !== undefined) existing.gate = operation.gate
    if (operation.stop !== undefined) {
      existing.stop = operation.stop
      existing.runtimeStop = runtimeStopFromDisplay(operation.stop)
    }
    updatedRelationshipKeys.add(operation.relationshipKey)
  }

  const impact: WorkflowPatchImpact = {
    addedParticipantKeys: [...addedParticipantKeys],
    replacedParticipantKeys: [...replacedParticipantKeys],
    addedRelationshipKeys: [...addedRelationshipKeys],
    stoppedRelationshipKeys: [...stoppedRelationshipKeys],
    updatedRelationshipKeys: [...updatedRelationshipKeys],
    requiresNewSessions: [...addedParticipantKeys, ...replacedParticipantKeys]
      .filter((key) => participant(key)?.endpoint.kind === 'new').length,
    preservesSessionKeys: base.participants
      .map((item) => item.key)
      .filter((key) => !replacedParticipantKeys.has(key)),
  }
  const rollback: WorkflowPatchRollback = {
    strategy: 'restore-base-version',
    baseVersion: base.version,
    stopCreatedSessionKeys: [...addedParticipantKeys, ...replacedParticipantKeys],
    restoreRelationshipKeys: [
      ...stoppedRelationshipKeys,
      ...updatedRelationshipKeys,
    ],
    note: `Stop resources created by v${input.version}, then restore the v${base.version} relationship definitions without reviving human-deleted items.`,
  }
  return {
    plan,
    patch: {
      baseVersion: base.version,
      wakeupIds: [...new Set(input.wakeupIds ?? [])],
      reason: input.reason.trim(),
      operations: clone(input.operations),
      impact,
      rollback,
    },
  }
}

function existingParticipant(
  key: string,
  role: string,
  prompt: string,
  sessionId: string,
  context: WorkflowAuthoringContext,
  access: WorkflowAccess,
): WorkflowParticipantSpec {
  const session = context.sessions?.[sessionId]
  // Existing sessions keep their real provider sandbox. A proposal must not
  // claim read-only access for a session that can actually write.
  const actualAccess: WorkflowAccess = session?.runtimeSettings?.sandbox === 'read-only'
    ? 'read'
    : 'write'
  return {
    key,
    role,
    label: session?.label || role,
    endpoint: { kind: 'existing', sessionId },
    prompt,
    workspace: { cwd: session?.cwd, access: session ? actualAccess : access, workMode: 'local' },
    managedBy: 'master',
  }
}

function newParticipant(
  key: string,
  role: string,
  label: string | undefined,
  prompt: string,
  endpoint: {
    providerKind: 'claude-code' | 'codex' | 'grok'
    providerInstanceId: string
    runtimeSettings: ReviewRuntimeSettings & Record<string, unknown>
    cwd?: string
    workMode?: 'local' | 'worktree'
    branch?: string
  },
  access: WorkflowAccess,
): WorkflowParticipantSpec {
  return {
    key,
    role,
    label: label?.trim() || role,
    endpoint: {
      kind: 'new',
      providerKind: endpoint.providerKind,
      providerInstanceId: endpoint.providerInstanceId,
      runtimeSettings: clone(endpoint.runtimeSettings),
    },
    prompt,
    workspace: {
      cwd: endpoint.cwd,
      access,
      workMode: endpoint.workMode ?? 'local',
      ...(endpoint.branch ? { branch: endpoint.branch } : {}),
    },
    managedBy: 'master',
  }
}

function classicParticipant(
  key: string,
  role: string,
  endpoint: WorkflowAgentEndpoint,
  context: WorkflowAuthoringContext,
  access: WorkflowAccess,
) {
  return endpoint.kind === 'existing'
    ? existingParticipant(key, role, endpoint.prompt, endpoint.sessionId, context, access)
    : newParticipant(key, role, endpoint.label, endpoint.prompt, endpoint, access)
}

function relationship(
  key: string,
  from: string,
  to: string,
  recipe: string,
  trigger: string,
  action: 'deliver' | 'deliver+activate',
  options: Partial<WorkflowRelationshipSpec> = {},
): WorkflowRelationshipSpec {
  return {
    key,
    from,
    to,
    recipe,
    trigger,
    action,
    gate: 'auto',
    concurrency: 'coalesce',
    managedBy: 'master',
    ...options,
  }
}

function compileRecipe(
  recipeInput: WorkflowRecipeInput,
  context: WorkflowAuthoringContext,
): Pick<WorkflowPlan, 'participants' | 'relationships'> {
  if (recipeInput.recipe === 'review') {
    const input = recipeInput.input
    const coder = input.coder.kind === 'existing'
      ? existingParticipant('coder', 'Coder', input.coder.prompt, input.coder.sessionId, context, 'write')
      : newParticipant('coder', 'Coder', input.coder.label, input.coder.prompt, input.coder, 'write')
    const reviewer = input.reviewer.kind === 'existing'
      ? existingParticipant('reviewer', 'Reviewer', input.reviewer.instruction, input.reviewer.sessionId, context, 'read')
      : newParticipant(
          'reviewer',
          'Reviewer',
          input.reviewer.label,
          input.reviewer.instruction,
          {
            ...input.reviewer,
            runtimeSettings: {
              ...input.reviewer.runtimeSettings,
              runtimeMode: 'approval-required',
              sandbox: 'read-only',
            },
            cwd: coder.workspace.cwd,
            workMode: coder.workspace.workMode,
            branch: coder.workspace.branch,
          },
          'read',
        )
    return {
      participants: [coder, reviewer],
      relationships: [
        relationship('review-request', 'coder', 'reviewer', 'review-until-clean', 'finished', 'deliver+activate', {
          stop: `when reviewer reports clean; max ${input.maxLaps} laps`,
          runtimeStop: { whenReport: { verdict: 'clean' }, maxFirings: input.maxLaps },
        }),
        relationship('review-fix', 'reviewer', 'coder', 'review-until-clean', 'report:issues', 'deliver+activate', {
          stop: `when reviewer reports clean; max ${input.maxLaps} laps`,
          runtimeStop: { whenReport: { verdict: 'clean' }, maxFirings: input.maxLaps },
        }),
      ],
    }
  }

  if (recipeInput.recipe === 'goal') {
    const input = recipeInput.input
    const worker = classicParticipant('worker', 'Worker', input.worker, context, 'write')
    const workerSession = input.worker.kind === 'existing' ? context.sessions?.[input.worker.sessionId] : undefined
    const workerNew = input.worker.kind === 'new' ? input.worker : undefined
    const judgeProviderInstanceId = input.judgeProviderInstanceId ||
      (worker.endpoint.kind === 'new' ? worker.endpoint.providerInstanceId : workerSession?.providerInstanceId) || ''
    const judgeProviderKind = context.sessions
      ? Object.values(context.sessions).find((session) => session.providerInstanceId === judgeProviderInstanceId)?.providerKind
      : undefined
    const judge = newParticipant(
      'judge',
      'Goal Judge',
      'Goal Judge',
      `Judge whether this goal is done: ${input.goal}`,
      {
        providerKind: judgeProviderKind || (worker.endpoint.kind === 'new' ? worker.endpoint.providerKind : workerSession?.providerKind) || 'codex',
        providerInstanceId: judgeProviderInstanceId,
        runtimeSettings: {
          ...(worker.endpoint.kind === 'new' ? worker.endpoint.runtimeSettings : workerSession?.runtimeSettings),
          runtimeMode: 'approval-required',
          sandbox: 'read-only',
          ...(input.judgeModel ? { model: input.judgeModel } : {}),
        },
        cwd: worker.workspace.cwd,
        workMode: worker.workspace.workMode,
        branch: worker.workspace.branch ?? workerNew?.branch,
      },
      'read',
    )
    return {
      participants: [worker, judge],
      relationships: [
        relationship('goal-check', 'worker', 'judge', 'goal-loop', 'finished', 'deliver+activate', {
          stop: `when judge reports done; max ${input.maxLaps} laps`,
          runtimeStop: { whenReport: { verdict: 'done' }, maxFirings: input.maxLaps },
        }),
        relationship('goal-retry', 'judge', 'worker', 'goal-loop', 'report:retry', 'deliver+activate', {
          stop: `when judge reports done; max ${input.maxLaps} laps`,
          runtimeStop: { whenReport: { verdict: 'done' }, maxFirings: input.maxLaps },
        }),
      ],
    }
  }

  if (recipeInput.recipe === 'handoff') {
    const input = recipeInput.input
    return {
      participants: [
        classicParticipant('source', 'Source', input.source, context, 'write'),
        classicParticipant('target', 'Target', input.target, context, 'write'),
      ],
      relationships: [
        relationship('handoff', 'source', 'target', 'handoff', 'one-shot', 'deliver+activate', {
          stop: 'after one delivery and activation',
        }),
      ],
    }
  }

  const input = recipeInput.input
  const participants = input.planners.map((planner) =>
    newParticipant(
      `planner:${planner.key}`,
      'Planner',
      planner.label,
      input.objective,
      { ...planner, cwd: input.cwd, workMode: 'local' },
      'read',
    ),
  )
  participants.push(
    newParticipant(
      `synthesizer:${input.synthesizer.key}`,
      'Synthesizer',
      input.synthesizer.label,
      input.objective,
      { ...input.synthesizer, cwd: input.cwd, workMode: 'local' },
      'read',
    ),
  )
  const synthesizerKey = `synthesizer:${input.synthesizer.key}`
  const relationships: WorkflowRelationshipSpec[] = []
  if (input.reviewTopology === 'hub-and-spoke') {
    for (const planner of input.planners) {
      const plannerKey = `planner:${planner.key}`
      relationships.push(
        relationship(
          `hub-review-input:${planner.key}`,
          plannerKey,
          synthesizerKey,
          'plan-council:phase-batch',
          'all proposals approved',
          'deliver',
          { gate: 'human', stop: 'after the hub peer-review artifact is captured' },
        ),
        relationship(
          `synthesis-input:${planner.key}`,
          plannerKey,
          synthesizerKey,
          'plan-council:phase-batch',
          'hub peer review approved',
          'deliver',
          { gate: 'human', stop: 'after synthesis artifact is captured' },
        ),
      )
    }
    return { participants, relationships }
  }
  for (const planner of input.planners) {
    const plannerKey = `planner:${planner.key}`
    for (const peer of input.planners.filter((candidate) => candidate.key !== planner.key)) {
      relationships.push(
        relationship(
          `cross-review:${planner.key}->${peer.key}`,
          plannerKey,
          `planner:${peer.key}`,
          'plan-council:phase-batch',
          'all proposals approved',
          'deliver',
          { gate: 'human', stop: 'after one cross-review round' },
        ),
      )
    }
    relationships.push(
      relationship(
        `synthesis-input:${planner.key}`,
        plannerKey,
        synthesizerKey,
        'plan-council:phase-batch',
        'all peer reviews approved',
        'deliver',
        { gate: 'human', stop: 'after synthesis artifact is captured' },
      ),
    )
  }
  return { participants, relationships }
}

export function compileWorkflowPlan(input: {
  workflowId: string
  version: number
  objective: string
  recipeInput: WorkflowRecipeInput
  masterSessionId?: string
  scopeId: string
  autonomyPolicy: WorkflowAutonomyPolicy
  createdAt: string
  createdBy: WorkflowPlan['createdBy']
  reason?: string
  supersedesVersion?: number
}, context: WorkflowAuthoringContext): WorkflowPlan {
  const compiled = compileRecipe(input.recipeInput, context)
  return {
    workflowId: input.workflowId,
    version: input.version,
    objective: input.objective.trim(),
    recipe: input.recipeInput.recipe,
    recipeInput: clone(input.recipeInput),
    masterSessionId: input.masterSessionId,
    scopeId: input.scopeId,
    status: 'proposed',
    participants: compiled.participants,
    relationships: compiled.relationships,
    autonomyPolicy: clone(input.autonomyPolicy),
    createdAt: input.createdAt,
    createdBy: clone(input.createdBy),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.supersedesVersion ? { supersedesVersion: input.supersedesVersion } : {}),
  }
}

function recipeValidation(recipeInput: WorkflowRecipeInput, context: WorkflowAuthoringContext) {
  const validationContext: ReviewWorkflowValidationContext = {
    sessions: context.sessions,
    providerInstanceIds: context.providerInstanceIds,
  }
  if (recipeInput.recipe === 'review') return validateReviewWorkflowStart(recipeInput.input, validationContext)
  if (recipeInput.recipe === 'goal') return validateGoalWorkflowStart(recipeInput.input, validationContext)
  if (recipeInput.recipe === 'handoff') return validateHandoffWorkflowStart(recipeInput.input, validationContext)
  return validatePlanCouncilStart(recipeInput.input, {
    providerInstanceIds: context.providerInstanceIds,
    sessionIds: Object.keys(context.sessions ?? {}),
  })
}

export function validateWorkflowPlan(plan: WorkflowPlan, context: WorkflowAuthoringContext) {
  const errors: WorkflowValidationIssue[] = recipeValidation(plan.recipeInput, context).issues.map((issue) => ({ ...issue }))
  const warnings: WorkflowValidationIssue[] = []
  const policy = context.capability.policy
  const existingParticipantKeys = new Set(context.existingParticipantKeys ?? [])
  const newParticipants = plan.participants.filter(
    (participant) => participant.endpoint.kind === 'new' && !existingParticipantKeys.has(participant.key),
  )
  const scopeSessionIds = new Set(context.scopeSessionIds ?? Object.keys(context.sessions ?? {}))
  const estimatedScopeSessionCount = scopeSessionIds.size + newParticipants.length
  const providers = [...new Set(plan.participants.map((participant) =>
    participant.endpoint.kind === 'new'
      ? participant.endpoint.providerInstanceId
      : context.sessions?.[participant.endpoint.sessionId]?.providerInstanceId ?? '',
  ).filter(Boolean))].sort()

  if (!plan.objective.trim()) errors.push({ field: 'objective', message: 'Describe the workflow objective.', code: 'objective-required' })
  if (plan.scopeId !== context.capability.scopeId) {
    errors.push({ field: 'scopeId', message: 'The proposal cannot expand beyond its capability scope.', code: 'scope-expansion' })
  }
  if (!policy.mayCreateSessions && newParticipants.length > 0) {
    errors.push({ field: 'participants', message: 'This scope does not allow Master-created sessions.', code: 'session-create-denied' })
  }
  if (!policy.mayModifyRelationships && plan.relationships.length > 0) {
    errors.push({ field: 'relationships', message: 'This scope does not allow Master-authored relationships.', code: 'relationship-write-denied' })
  }
  if (estimatedScopeSessionCount > policy.maxSessions) {
    errors.push({
      field: 'participants',
      message: `This Scope would contain ${estimatedScopeSessionCount} sessions after commit; scope limit is ${policy.maxSessions}.`,
      code: 'session-limit',
    })
  }
  const estimatedConcurrentSessions = plan.recipe === 'plan-council' ? newParticipants.length - 1 : Math.min(1, newParticipants.length)
  if (estimatedConcurrentSessions > policy.maxConcurrentSessions) {
    errors.push({ field: 'participants', message: `Estimated concurrency ${estimatedConcurrentSessions} exceeds scope limit ${policy.maxConcurrentSessions}.`, code: 'concurrency-limit' })
  }
  const recipeFanout = plan.recipe === 'plan-council'
    ? plan.recipeInput.recipe === 'plan-council' && plan.recipeInput.input?.reviewTopology === 'hub-and-spoke'
      ? 1
      : plan.participants.filter((participant) => participant.role === 'Planner').length
    : 1
  const dynamicRelationships = plan.relationships.filter(
    (relationship) => typeof relationship.action === 'object' && relationship.action.kind === 'create',
  )
  const estimatedFanout = Math.max(
    recipeFanout,
    ...dynamicRelationships.map((relationship) =>
      typeof relationship.action === 'object' ? relationship.action.limits.maxFanOut : 0),
  )
  if (estimatedFanout > policy.maxFanout) {
    errors.push({ field: 'relationships', message: `Estimated fan-out ${estimatedFanout} exceeds scope limit ${policy.maxFanout}.`, code: 'fanout-limit' })
  }
  if (plan.version > policy.maxVersions) {
    errors.push({ field: 'version', message: `Workflow version ${plan.version} exceeds scope limit ${policy.maxVersions}.`, code: 'version-limit' })
  }
  for (const relationship of dynamicRelationships) {
    const action = relationship.action as DynamicCreateAction
    const dynamicValidation = validateDynamicCreateAction(action, {
      providerInstanceIds: context.providerInstanceIds,
    })
    for (const message of dynamicValidation.errors) {
      errors.push({
        field: `relationships.${relationship.key}.action`,
        message,
        code: 'dynamic-template-invalid',
      })
    }
    if (!policy.mayCreateSessions) {
      errors.push({
        field: `relationships.${relationship.key}.action`,
        message: 'This Scope does not allow dynamic session creation.',
        code: 'session-create-denied',
      })
    }
    if (!policy.allowedProviderInstanceIds.includes(action.template.providerInstanceId)) {
      errors.push({
        field: `relationships.${relationship.key}.action.template.providerInstanceId`,
        message: `Dynamic provider ${action.template.providerInstanceId} is outside this Scope capability.`,
        code: 'provider-expansion',
      })
    }
    if (plan.version > action.limits.maxPlanVersions ||
        action.limits.maxSessions > policy.maxSessions ||
        action.limits.maxFanOut > policy.maxFanout ||
        action.limits.maxPlanVersions > policy.maxVersions) {
      errors.push({
        field: `relationships.${relationship.key}.action.limits`,
        message: 'Dynamic topology limits must fit within the Scope session, fan-out, and version capability.',
        code: 'dynamic-limit-expansion',
      })
    }
  }
  for (const providerId of providers) {
    if (!context.providerInstanceIds?.includes(providerId)) {
      errors.push({ field: 'participants', message: `Provider ${providerId} is unavailable.`, code: 'provider-unavailable' })
    } else if (!policy.allowedProviderInstanceIds.includes(providerId)) {
      warnings.push({ field: 'participants', message: `Provider ${providerId} expands this scope capability and requires human approval.`, code: 'provider-expansion' })
    }
  }
  for (const participant of plan.participants) {
    if (participant.endpoint.kind === 'existing' && !scopeSessionIds.has(participant.endpoint.sessionId)) {
      errors.push({
        field: `participants.${participant.key}.endpoint.sessionId`,
        message: `${participant.label} is outside capability Scope ${context.capability.scopeId}.`,
        code: 'session-outside-scope',
      })
    }
    if (!participant.workspace.cwd?.trim()) {
      errors.push({ field: `participants.${participant.key}.workspace.cwd`, message: `${participant.label} needs a workspace.`, code: 'workspace-required' })
    }
    if (participant.workspace.access === 'write') {
      warnings.push({ field: `participants.${participant.key}.workspace.access`, message: `${participant.label} may write to the workspace.`, code: 'write-access' })
    }
    if (
      participant.workspace.access === 'read' &&
      participant.endpoint.kind === 'new' &&
      participant.endpoint.runtimeSettings.runtimeMode !== 'approval-required'
    ) {
      errors.push({
        field: `participants.${participant.key}.endpoint.runtimeSettings.runtimeMode`,
        message: `${participant.label} is read-only but requests ${participant.endpoint.runtimeSettings.runtimeMode} runtime mode.`,
        code: 'workspace-access-conflict',
      })
    }
    if (
      participant.workspace.access === 'read' &&
      participant.endpoint.kind === 'new' &&
      participant.endpoint.runtimeSettings.sandbox &&
      participant.endpoint.runtimeSettings.sandbox !== 'read-only'
    ) {
      errors.push({
        field: `participants.${participant.key}.endpoint.runtimeSettings.sandbox`,
        message: `${participant.label} is read-only but requests ${String(participant.endpoint.runtimeSettings.sandbox)} sandbox access.`,
        code: 'workspace-access-conflict',
      })
    }
  }
  const reviewParticipant = plan.recipe === 'review'
    ? plan.participants.find((participant) => participant.key === 'reviewer')
    : undefined
  if (reviewParticipant && reviewParticipant.workspace.access !== 'read') {
    errors.push({
      field: 'participants.reviewer.workspace.access',
      message: 'The Review participant must use a read-only sandbox.',
      code: 'reviewer-write-access',
    })
  }

  const approvalReasons = new Set<string>()
  if (policy.mode === 'review-first' || policy.requireApprovalFor.includes('commit')) approvalReasons.add('Scope policy requires approval before commit.')
  if (warnings.some((warning) => warning.code === 'write-access') && policy.requireApprovalFor.includes('write-access')) {
    approvalReasons.add('The workflow requests workspace write access.')
  }
  if (providers.some((provider) => !policy.allowedProviderInstanceIds.includes(provider))) {
    approvalReasons.add('The workflow requests a provider outside the current capability.')
  }

  return {
    errors,
    warnings,
    estimatedSessionCount: estimatedScopeSessionCount,
    estimatedConcurrentSessions: Math.max(0, estimatedConcurrentSessions),
    providerInstanceIds: providers,
    requiresHumanApproval: approvalReasons.size > 0,
    approvalReasons: [...approvalReasons],
  }
}

export type WorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * Derive the user-visible lifecycle of a committed proposal from its durable
 * execution mapping. The Proposal status says the graph was committed; it is
 * not itself evidence that the execution is still live.
 */
export function workflowExecutionStatus(
  proposal: WorkflowProposal,
  state: {
    sessions?: Record<string, { status?: string }>
    planCouncils?: Record<string, { phase?: string }>
    loops?: Array<{
      status?: string
      subscriptionIds?: string[]
      terminal?: { type?: string; reason?: string }
    }>
  },
): WorkflowExecutionStatus | undefined {
  if (proposal.status !== 'committed') return undefined
  const plan = proposal.proposedPlan
  const mapping = plan.executionMapping
  if (!mapping) return 'failed'

  const participantIds = Object.values(mapping.participantSessionIds)
  const participantStatuses = participantIds.map((sessionId) => state.sessions?.[sessionId]?.status)
  if (participantStatuses.some((status) => status === 'failed')) return 'failed'

  if (plan.recipe === 'plan-council' && mapping.productWorkflowId) {
    const phase = state.planCouncils?.[mapping.productWorkflowId]?.phase
    if (phase === 'completed') return 'completed'
    if (phase === 'failed') return 'failed'
    if (phase === 'stopped') return 'stopped'
    return phase ? 'running' : 'failed'
  }

  if (plan.recipe === 'review' || plan.recipe === 'goal') {
    const subscriptionIds = new Set(Object.values(mapping.relationshipSubscriptionIds))
    const loop = state.loops?.find((candidate) =>
      candidate.subscriptionIds?.some((subscriptionId) => subscriptionIds.has(subscriptionId)),
    )
    if (!loop) return participantStatuses.some((status) => status === 'killed') ? 'stopped' : 'failed'
    if (loop.status !== 'stopped') return 'running'
    return /Report verdict (clean|done) satisfied the stop condition\./i.test(loop.terminal?.reason ?? '')
      ? 'completed'
      : 'stopped'
  }

  const targetSessionId = mapping.participantSessionIds.target
  const targetStatus = targetSessionId ? state.sessions?.[targetSessionId]?.status : undefined
  if (targetStatus === 'failed') return 'failed'
  if (targetStatus === 'killed') return 'stopped'
  if (targetStatus === 'pending' || targetStatus === 'running') return 'running'
  return targetStatus ? 'completed' : 'failed'
}

export function lockedPlanConflicts(base: WorkflowPlan, next: WorkflowPlan) {
  const conflicts: WorkflowValidationIssue[] = []
  const inspect = <T extends { key: string; lockedByHuman?: boolean }>(
    kind: 'participants' | 'relationships',
    previous: T[],
    proposed: T[],
  ) => {
    const proposedByKey = new Map(proposed.map((item) => [item.key, item]))
    for (const item of previous) {
      if (!item.lockedByHuman) continue
      const candidate = proposedByKey.get(item.key)
      if (!candidate || !stableEqual(item, candidate)) {
        conflicts.push({
          field: `${kind}.${item.key}`,
          message: `Master revision cannot change human-locked ${kind === 'participants' ? 'participant' : 'relationship'} ${item.key}.`,
          code: 'human-lock-conflict',
        })
      }
    }
  }
  inspect('participants', base.participants, next.participants)
  inspect('relationships', base.relationships, next.relationships)
  return conflicts
}
