import type { ReviewBlockingMode, ReviewRuntimeSettings } from './review-workflow.js'

export type AgentConnectionTiming = 'current-result' | 'next-completion'
export type AgentConnectionBehavior = 'handoff-once' | 'one-review' | 'keep-reviewing' | 'review-loop'

export type AgentConnectionTarget =
  | { kind: 'existing'; sessionId: string }
  | {
      kind: 'new'
      label: string
      instruction: string
      cwd?: string
      providerKind: 'claude-code' | 'codex'
      providerInstanceId: string
      runtimeSettings: ReviewRuntimeSettings
      position?: { x: number; y: number }
    }

export type ConnectAgentsInput = {
  sourceSessionId: string
  target: AgentConnectionTarget
  timing: AgentConnectionTiming
  behavior: AgentConnectionBehavior
  instruction: string
  review?: {
    blocking: { mode: ReviewBlockingMode; customCriteria?: string }
    maxLaps: number
  }
}

export type CompiledAgentConnection = {
  immediate: boolean
  relationships: Array<
    | { role: 'forward'; oneShot: boolean; reportIssuesOnly: false }
    | { role: 'review-pass'; oneShot: boolean; reportIssuesOnly: false }
    | { role: 'review-fix'; oneShot: false; reportIssuesOnly: true }
  >
}

export function compileAgentConnection(input: ConnectAgentsInput): CompiledAgentConnection {
  const immediate = input.timing === 'current-result'
  if (input.behavior === 'review-loop') {
    return {
      immediate,
      relationships: [
        { role: 'review-pass', oneShot: false, reportIssuesOnly: false },
        { role: 'review-fix', oneShot: false, reportIssuesOnly: true },
      ],
    }
  }
  return {
    immediate,
    relationships: [
      {
        role: input.behavior === 'handoff-once' ? 'forward' : 'review-pass',
        oneShot: input.behavior !== 'keep-reviewing',
        reportIssuesOnly: false,
      },
    ],
  }
}

function trimmed(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function validateAgentConnection(input: ConnectAgentsInput, providerInstanceIds: string[] = []) {
  const issues: Array<{ field: string; message: string }> = []
  if (!trimmed(input?.sourceSessionId)) issues.push({ field: 'sourceSessionId', message: 'Choose a source Agent.' })
  if (!['current-result', 'next-completion'].includes(input?.timing)) issues.push({ field: 'timing', message: 'Choose when this Relationship starts.' })
  if (!['handoff-once', 'one-review', 'keep-reviewing', 'review-loop'].includes(input?.behavior)) {
    issues.push({ field: 'behavior', message: 'Choose what the receiving Agent should do.' })
  }
  if (!trimmed(input?.instruction)) issues.push({ field: 'instruction', message: 'Add the receiving Agent instruction.' })
  if (input?.target?.kind === 'existing') {
    if (!trimmed(input.target.sessionId)) issues.push({ field: 'target.sessionId', message: 'Choose a receiving Agent.' })
    if (input.target.sessionId === input.sourceSessionId) issues.push({ field: 'target.sessionId', message: 'Connect two different Agents.' })
  } else if (input?.target?.kind === 'new') {
    if (!trimmed(input.target.label)) issues.push({ field: 'target.label', message: 'Name the receiving Agent.' })
    if (!trimmed(input.target.providerInstanceId)) {
      issues.push({ field: 'target.providerInstanceId', message: 'Choose a receiving Agent provider.' })
    } else if (providerInstanceIds.length > 0 && !providerInstanceIds.includes(input.target.providerInstanceId)) {
      issues.push({ field: 'target.providerInstanceId', message: 'The selected provider is unavailable.' })
    }
  } else {
    issues.push({ field: 'target', message: 'Choose or create a receiving Agent.' })
  }
  if (input?.behavior === 'review-loop') {
    if (!input.review || !Number.isSafeInteger(input.review.maxLaps) || input.review.maxLaps < 1 || input.review.maxLaps > 99) {
      issues.push({ field: 'review.maxLaps', message: 'Max laps must be a whole number from 1 to 99.' })
    }
    if (input.review?.blocking.mode === 'custom' && !trimmed(input.review.blocking.customCriteria)) {
      issues.push({ field: 'review.blocking.customCriteria', message: 'Describe the custom blocking criteria.' })
    }
  }
  return { ok: issues.length === 0, issues }
}
