export const dynamicRetentionPolicies = ['keep', 'archive-on-stop'] as const

export type DynamicRetentionPolicy = (typeof dynamicRetentionPolicies)[number]

export type DynamicParticipantTemplate = {
  templateId: string
  labelPrefix: string
  role: 'triage'
  /** A fixed, reviewed instruction. Trigger data is attached separately. */
  prompt: string
  providerKind: 'claude-code' | 'codex' | 'grok'
  providerInstanceId: string
  runtimeSettings?: Record<string, unknown>
  workspace: {
    access: 'read-only' | 'workspace-write'
    workMode: 'local' | 'worktree'
  }
  retention: DynamicRetentionPolicy
}

export type DynamicCreateAction = {
  kind: 'create'
  template: DynamicParticipantTemplate
  forEach: { kind: 'report-issues' }
  limits: {
    maxGenerationDepth: number
    maxSessions: number
    maxFanOut: number
    maxPlanVersions: number
  }
}

export type DynamicSpawnChild = {
  itemKey: string
  sessionId: string
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'recycled'
  error?: string
}

export type DynamicSpawnGroup = {
  groupId: string
  subscriptionId: string
  triggerEventId: string
  correlationKey: string
  execution?: import('./execution-envelope.js').ExecutionEnvelope
  templateId: string
  scopeId: string
  masterSessionId?: string
  parentSessionId: string
  generationDepth: number
  status: 'creating' | 'active' | 'completed' | 'failed' | 'cancelled' | 'capped'
  requestedCount: number
  createdCount: number
  skippedCount: number
  reason?: string
  children: DynamicSpawnChild[]
  createdAt: string
  updatedAt: string
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
const unknownKeys = (value: unknown, allowed: string[]) =>
  value && typeof value === 'object'
    ? Object.keys(value).filter((key) => !allowed.includes(key))
    : []

export function validateDynamicCreateAction(
  value: unknown,
  context: { providerInstanceIds?: string[] } = {},
) {
  const errors: string[] = []
  const action = value as Partial<DynamicCreateAction> | undefined
  const template = action?.template as Partial<DynamicParticipantTemplate> | undefined
  const limits = action?.limits as Partial<DynamicCreateAction['limits']> | undefined
  const actionExtras = unknownKeys(action, ['kind', 'template', 'forEach', 'limits'])
  const templateExtras = unknownKeys(template, [
    'templateId', 'labelPrefix', 'role', 'prompt', 'providerKind',
    'providerInstanceId', 'runtimeSettings', 'workspace', 'retention',
  ])
  const forEachExtras = unknownKeys(action?.forEach, ['kind'])
  const limitExtras = unknownKeys(limits, ['maxGenerationDepth', 'maxSessions', 'maxFanOut', 'maxPlanVersions'])
  const workspaceExtras = unknownKeys(template?.workspace, ['access', 'workMode'])
  if (actionExtras.length) errors.push(`Dynamic action contains unsupported fields: ${actionExtras.join(', ')}.`)
  if (templateExtras.length) errors.push(`Dynamic template contains unsupported fields: ${templateExtras.join(', ')}.`)
  if (forEachExtras.length) errors.push(`Dynamic forEach contains unsupported fields: ${forEachExtras.join(', ')}.`)
  if (limitExtras.length) errors.push(`Dynamic limits contain unsupported fields: ${limitExtras.join(', ')}.`)
  if (workspaceExtras.length) errors.push(`Dynamic workspace contains unsupported fields: ${workspaceExtras.join(', ')}.`)
  if (action?.kind !== 'create') errors.push('Dynamic action kind must be create.')
  if (action?.forEach?.kind !== 'report-issues') errors.push('Dynamic create only supports forEach report-issues.')
  if (!text(template?.templateId)) errors.push('Dynamic template requires a stable templateId.')
  if (!text(template?.labelPrefix)) errors.push('Dynamic template requires labelPrefix.')
  if (template?.role !== 'triage') errors.push('Dynamic template role must be triage.')
  const prompt = text(template?.prompt)
  if (!prompt) errors.push('Dynamic template requires a fixed prompt.')
  if (prompt.length > 8_000) errors.push('Dynamic template prompt exceeds 8,000 characters.')
  if (prompt.includes('{{') || prompt.includes('${') || prompt.includes('<%')) {
    errors.push('Dynamic template prompt must be fixed; interpolation syntax is not allowed.')
  }
  if (!['claude-code', 'codex', 'grok'].includes(template?.providerKind ?? '')) {
    errors.push('Dynamic template providerKind is invalid.')
  }
  if (!text(template?.providerInstanceId)) errors.push('Dynamic template requires providerInstanceId.')
  if (context.providerInstanceIds?.length && !context.providerInstanceIds.includes(text(template?.providerInstanceId))) {
    errors.push(`Dynamic template provider ${text(template?.providerInstanceId)} is unavailable.`)
  }
  if (!['read-only', 'workspace-write'].includes(template?.workspace?.access ?? '')) {
    errors.push('Dynamic template workspace access is invalid.')
  }
  if (template?.runtimeSettings !== undefined &&
      (!template.runtimeSettings || typeof template.runtimeSettings !== 'object' || Array.isArray(template.runtimeSettings))) {
    errors.push('Dynamic template runtimeSettings must be an object when provided.')
  }
  if (!['local', 'worktree'].includes(template?.workspace?.workMode ?? '')) {
    errors.push('Dynamic template workMode is invalid.')
  }
  if (!dynamicRetentionPolicies.includes(template?.retention as DynamicRetentionPolicy)) {
    errors.push('Dynamic template retention is invalid.')
  }
  for (const key of ['maxGenerationDepth', 'maxSessions', 'maxFanOut', 'maxPlanVersions'] as const) {
    if (!positive(limits?.[key])) errors.push(`Dynamic create limits.${key} must be a positive integer.`)
  }
  if (positive(limits?.maxGenerationDepth) && Number(limits?.maxGenerationDepth) > 8) {
    errors.push('Dynamic create generation depth cannot exceed 8.')
  }
  if (positive(limits?.maxFanOut) && Number(limits?.maxFanOut) > Number(limits?.maxSessions ?? 0)) {
    errors.push('Dynamic create maxFanOut cannot exceed maxSessions.')
  }
  return { ok: errors.length === 0, errors }
}

export function dynamicItemKey(issue: unknown, index: number) {
  const candidate = issue as Record<string, unknown> | undefined
  return text(candidate?.id) || [text(candidate?.file), String(candidate?.line ?? ''), text(candidate?.message)].join(':') || `issue-${index + 1}`
}
