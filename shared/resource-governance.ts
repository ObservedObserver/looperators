import type { ExecutionEnvelope } from './execution-envelope.js'

export type WorkspaceLeaseMode = 'reader' | 'writer'
export type WorkspaceLease = {
  leaseId: string
  workspaceKey: string
  mode: WorkspaceLeaseMode
  sessionId: string
  turnId: string
  scopeId: string
  providerInstanceId: string
  reservedTokens?: number
  reservedDurationMs?: number
  reservedToolCalls?: number
  status: 'active' | 'released' | 'revoked'
  acquiredAt: string
  releasedAt?: string
  releaseReason?: string
  baseline?: { head?: string; statusDigest?: string }
}

export type QueuedProviderRun = {
  queueId: string
  turnId: string
  sessionId: string
  providerInstanceId: string
  scopeId: string
  workspaceKey: string
  leaseMode: WorkspaceLeaseMode
  priority: number
  order: number
  queuedAt: string
  reason: 'provider-cap' | 'scope-cap' | 'workspace-lease'
  request: Record<string, unknown>
  execution?: ExecutionEnvelope
  reservedTokens?: number
  reservedDurationMs?: number
  reservedToolCalls?: number
}

export type RuntimeUsageFact = {
  usageId: string
  sessionId: string
  turnId: string
  providerKind: string
  providerInstanceId: string
  scopeId: string
  startedAt: string
  completedAt: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
  toolCalls: number
  providerTurns: number
  source: 'provider' | 'unavailable'
  execution?: ExecutionEnvelope
  loopIds?: string[]
}

export type RuntimeResourcePolicy = {
  scopeId: string
  maxConcurrentSessions: number
  maxConcurrentPerProvider: number
  maxQueuedRuns: number
  maxTurns: number
  maxTokens: number
  maxDurationMs: number
  maxToolCalls: number
  maxFanout: number
  maxTokensPerTurn: number
  maxDurationPerTurnMs: number
  maxToolCallsPerTurn: number
  updatedAt: string
  updatedBy: 'runtime' | 'human'
  budgetStartedAt?: string
}

export type SchedulerBackpressureMetrics = {
  queuedTotal: number
  admittedTotal: number
  rejectedTotal: number
  maxQueueDepth: number
  lastAdmittedScopeId?: string
  lastAdmissionAt?: string
  byReason: Record<string, number>
}

export const defaultRuntimeBudget = {
  maxConcurrentSessions: 4,
  maxConcurrentPerProvider: 4,
  maxQueuedRuns: 100,
  maxTurns: 100,
  maxTokens: 2_000_000,
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxToolCalls: 500,
  maxFanout: 8,
  maxTokensPerTurn: 200_000,
  maxDurationPerTurnMs: 15 * 60 * 1000,
  maxToolCallsPerTurn: 10,
}

export function leaseCompatible(
  leases: WorkspaceLease[],
  candidate: Pick<WorkspaceLease, 'workspaceKey' | 'mode' | 'turnId'>,
) {
  const active = leases.filter(
    (lease) => lease.status === 'active' && lease.workspaceKey === candidate.workspaceKey && lease.turnId !== candidate.turnId,
  )
  return candidate.mode === 'reader'
    ? active.every((lease) => lease.mode === 'reader')
    : active.length === 0
}

export function usageTotals(facts: RuntimeUsageFact[]) {
  return facts.reduce((total, fact) => ({
    turns: total.turns + 1,
    tokens: total.tokens + fact.totalTokens,
    durationMs: total.durationMs + fact.durationMs,
    toolCalls: total.toolCalls + fact.toolCalls,
  }), { turns: 0, tokens: 0, durationMs: 0, toolCalls: 0 })
}

export function budgetExceeded(policy: RuntimeResourcePolicy, facts: RuntimeUsageFact[], live: { fanout?: number } = {}) {
  const totals = usageTotals(facts)
  if (totals.turns >= policy.maxTurns) return { dimension: 'turns', used: totals.turns, limit: policy.maxTurns }
  if (totals.tokens >= policy.maxTokens) return { dimension: 'tokens', used: totals.tokens, limit: policy.maxTokens }
  if (totals.durationMs >= policy.maxDurationMs) return { dimension: 'durationMs', used: totals.durationMs, limit: policy.maxDurationMs }
  if (totals.toolCalls >= policy.maxToolCalls) return { dimension: 'toolCalls', used: totals.toolCalls, limit: policy.maxToolCalls }
  if ((live.fanout ?? 0) >= policy.maxFanout) return { dimension: 'fanout', used: live.fanout ?? 0, limit: policy.maxFanout }
  return undefined
}

export function projectRuntimeUsage(
  facts: RuntimeUsageFact[],
  { sessionToLoopIds = {} }: { sessionToLoopIds?: Record<string, string[]> } = {},
) {
  void sessionToLoopIds // legacy caller shape; loop attribution now freezes on each usage fact.
  const dimensions = {
    runs: {} as Record<string, ReturnType<typeof usageTotals>>,
    nodes: {} as Record<string, ReturnType<typeof usageTotals>>,
    loops: {} as Record<string, ReturnType<typeof usageTotals>>,
    workflows: {} as Record<string, ReturnType<typeof usageTotals>>,
    scopes: {} as Record<string, ReturnType<typeof usageTotals>>,
  }
  // Use direct numeric accumulation so a projection is stable even when a
  // provider reports no token data.
  const accumulate = (target: Record<string, any>, key: string | undefined, fact: RuntimeUsageFact) => {
    if (!key) return
    const value = target[key] ??= { turns: 0, tokens: 0, durationMs: 0, toolCalls: 0 }
    value.turns += 1
    value.tokens += fact.totalTokens
    value.durationMs += fact.durationMs
    value.toolCalls += fact.toolCalls
  }
  for (const fact of facts) {
    accumulate(dimensions.runs, fact.turnId, fact)
    accumulate(dimensions.nodes, fact.sessionId, fact)
    accumulate(dimensions.scopes, fact.scopeId, fact)
    accumulate(dimensions.workflows, fact.execution?.workflowId, fact)
    for (const loopId of fact.loopIds ?? []) accumulate(dimensions.loops, loopId, fact)
  }
  return dimensions
}

export type RuntimeUsageProjection = ReturnType<typeof projectRuntimeUsage>

export function selectFairQueuedRun(
  queue: QueuedProviderRun[],
  nowMs: number,
  eligible: (candidate: QueuedProviderRun) => boolean,
) {
  return [...queue]
    .filter(eligible)
    .sort((left, right) => {
      const leftAge = Math.floor(Math.max(0, nowMs - Date.parse(left.queuedAt)) / 1000)
      const rightAge = Math.floor(Math.max(0, nowMs - Date.parse(right.queuedAt)) / 1000)
      const priority = (right.priority + rightAge) - (left.priority + leftAge)
      return priority || left.order - right.order
    })[0]
}

export function normalizeProviderUsage(value: unknown) {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (...keys: string[]) => {
    for (const key of keys) {
      const candidate = Number(usage[key])
      if (Number.isFinite(candidate) && candidate >= 0) return candidate
    }
    return 0
  }
  const inputTokens = number('input_tokens', 'inputTokens', 'prompt_tokens')
  const outputTokens = number('output_tokens', 'outputTokens', 'completion_tokens')
  const cachedInputTokens = number('cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens')
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: number('total_tokens', 'totalTokens') || inputTokens + outputTokens,
  }
}
