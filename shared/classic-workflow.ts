import type { ReviewRuntimeSettings, ReviewWorkflowSessionSummary, ReviewWorkflowValidationContext } from './review-workflow.js'

export type WorkflowNewAgentEndpoint = {
  kind: 'new'
  label: string
  prompt: string
  cwd: string
  workMode: 'local' | 'worktree'
  branch?: string
  providerKind: 'claude-code' | 'codex' | 'legacy-claude-cli'
  providerInstanceId: string
  runtimeSettings: ReviewRuntimeSettings
}

export type WorkflowExistingAgentEndpoint = {
  kind: 'existing'
  sessionId: string
  prompt: string
}

export type WorkflowAgentEndpoint = WorkflowNewAgentEndpoint | WorkflowExistingAgentEndpoint

export type HandoffWorkflowStartInput = {
  source: WorkflowAgentEndpoint
  target: WorkflowAgentEndpoint
  note: string
}

export type GoalWorkflowStartInput = {
  worker: WorkflowAgentEndpoint
  goal: string
  maxLaps: number
  judgeProviderInstanceId?: string
  judgeModel?: string
}

export type ClassicWorkflowValidationIssue = { field: string; message: string }

export type ClassicWorkflowPreflightTarget = {
  role: string
  cwd?: string
  workMode?: 'local' | 'worktree'
  checkProject: boolean
  providerKind: WorkflowNewAgentEndpoint['providerKind']
  providerInstanceId: string
  providerProfileFingerprint: string
}

// The serialized value is both the request payload and the React effect key.
// Equal selected inputs therefore stay equal even when unrelated runtime
// snapshots replace their surrounding object/array identities.
export function classicWorkflowPreflightKey(targets: ClassicWorkflowPreflightTarget[]) {
  return JSON.stringify(targets)
}

export function resolveGoalJudgeRuntime(
  worker: { providerKind: WorkflowNewAgentEndpoint['providerKind']; providerInstanceId: string; runtimeSettings?: ReviewRuntimeSettings },
  providerInstances: Array<{ providerInstanceId: string; kind: WorkflowNewAgentEndpoint['providerKind'] }>,
  overrideProviderInstanceId?: string,
  overrideModel?: string,
) {
  const providerInstanceId = overrideProviderInstanceId?.trim() || worker.providerInstanceId
  const instance = providerInstances.find((candidate) => candidate.providerInstanceId === providerInstanceId)
  if (!instance) throw new Error(`Unknown Judge provider instance: ${providerInstanceId}`)
  const runtimeSettings = worker.runtimeSettings ? structuredClone(worker.runtimeSettings) : undefined
  if (runtimeSettings && instance.kind !== worker.providerKind) delete runtimeSettings.model
  if (runtimeSettings && overrideModel?.trim()) runtimeSettings.model = overrideModel.trim()
  return {
    providerKind: instance.kind,
    providerInstanceId,
    ...(runtimeSettings ? { runtimeSettings } : {}),
  }
}

function trimmed(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateEndpoint(
  field: string,
  endpoint: WorkflowAgentEndpoint | undefined,
  context: ReviewWorkflowValidationContext,
  issues: ClassicWorkflowValidationIssue[],
  requireExistingPrompt = true,
) {
  if (!endpoint || (endpoint.kind !== 'new' && endpoint.kind !== 'existing')) {
    issues.push({ field, message: `Choose or create the ${field} Agent.` })
    return
  }
  if (!trimmed(endpoint.prompt) && (endpoint.kind === 'new' || requireExistingPrompt)) {
    issues.push({ field: `${field}.prompt`, message: `Add the ${field} Agent's Prompt.` })
  }
  if (endpoint.kind === 'new') {
    if (!trimmed(endpoint.label)) issues.push({ field: `${field}.label`, message: `Name the ${field} Agent.` })
    if (!trimmed(endpoint.cwd)) issues.push({ field: `${field}.cwd`, message: `Choose the ${field} Agent's workspace.` })
    if (!trimmed(endpoint.providerInstanceId)) {
      issues.push({ field: `${field}.providerInstanceId`, message: `Choose the ${field} Agent's provider.` })
    } else if (context.providerInstanceIds?.length && !context.providerInstanceIds.includes(endpoint.providerInstanceId)) {
      issues.push({ field: `${field}.providerInstanceId`, message: `The selected ${field} provider is unavailable.` })
    }
    return
  }
  const session = context.sessions?.[endpoint.sessionId]
  if (!trimmed(endpoint.sessionId) || (context.sessions && !session)) {
    issues.push({ field: `${field}.sessionId`, message: `Choose an existing ${field} Agent.` })
  } else if (session) {
    if (!['idle', 'failed'].includes(session.status)) {
      issues.push({ field: `${field}.sessionId`, message: `The selected ${field} Agent is ${session.status}; wait until it is idle.` })
    }
    if (session.frozen) issues.push({ field: `${field}.sessionId`, message: `The selected ${field} Agent is frozen.` })
  }
}

export function validateHandoffWorkflowStart(input: HandoffWorkflowStartInput, context: ReviewWorkflowValidationContext = {}) {
  const issues: ClassicWorkflowValidationIssue[] = []
  validateEndpoint('source', input?.source, context, issues, false)
  validateEndpoint('target', input?.target, context, issues, false)
  if (input?.source?.kind === 'existing' && input?.target?.kind === 'existing' && input.source.sessionId === input.target.sessionId) {
    issues.push({ field: 'target.sessionId', message: 'Choose two different Agents.' })
  }
  if (!trimmed(input?.note)) issues.push({ field: 'note', message: 'Describe what the receiving Agent should do.' })
  return { ok: issues.length === 0, issues }
}

export function validateGoalWorkflowStart(input: GoalWorkflowStartInput, context: ReviewWorkflowValidationContext = {}) {
  const issues: ClassicWorkflowValidationIssue[] = []
  validateEndpoint('worker', input?.worker, context, issues)
  if (!trimmed(input?.goal)) issues.push({ field: 'goal', message: 'Define done in one sentence.' })
  if (!Number.isSafeInteger(input?.maxLaps) || input.maxLaps < 1 || input.maxLaps > 99) {
    issues.push({ field: 'maxLaps', message: 'Max laps must be a whole number from 1 to 99.' })
  }
  if (input?.judgeProviderInstanceId && context.providerInstanceIds?.length && !context.providerInstanceIds.includes(input.judgeProviderInstanceId)) {
    issues.push({ field: 'judgeProviderInstanceId', message: 'The selected Judge provider is unavailable.' })
  }
  return { ok: issues.length === 0, issues }
}

export function workflowSessionContext(sessions: Record<string, ReviewWorkflowSessionSummary>) {
  return sessions
}
