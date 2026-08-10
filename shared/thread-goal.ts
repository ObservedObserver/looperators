export const threadGoalStatuses = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const

export type ThreadGoalStatus = (typeof threadGoalStatuses)[number]

export type ThreadGoal = {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget?: number | null
  tokensUsed: number
  timeUsedSeconds: number
  /** Provider-contract Unix epoch seconds. */
  createdAt: number
  /** Provider-contract Unix epoch seconds. */
  updatedAt: number
}

export const threadGoalObjectiveMaxLength = 4_000

export type GoalComposerCommand =
  | { kind: 'view' }
  | { kind: 'set'; objective: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'invalid'; message: string }

export function parseGoalComposerCommand(value: string): GoalComposerCommand | undefined {
  const match = /^\s*\/goal(?:\s+([\s\S]*?))?\s*$/i.exec(value)
  if (!match) return undefined

  const input = match[1]?.trim() ?? ''
  if (!input) return { kind: 'view' }

  const [command = '', ...rest] = input.split(/\s+/)
  const normalized = command.toLowerCase()
  if (normalized === 'pause' && rest.length === 0) return { kind: 'pause' }
  if (normalized === 'resume' && rest.length === 0) return { kind: 'resume' }
  if (normalized === 'clear' && rest.length === 0) return { kind: 'clear' }
  if (normalized === 'set') {
    const objective = rest.join(' ').trim()
    if (!objective) {
      return { kind: 'invalid', message: 'Add an objective after /goal set.' }
    }
    return validateGoalObjective(objective)
  }

  return validateGoalObjective(input)
}

function validateGoalObjective(objective: string): GoalComposerCommand {
  if (objective.length > threadGoalObjectiveMaxLength) {
    return {
      kind: 'invalid',
      message: `Goal objectives must be ${threadGoalObjectiveMaxLength.toLocaleString()} characters or fewer.`,
    }
  }
  return { kind: 'set', objective }
}

export function normalizeThreadGoal(value: unknown): ThreadGoal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const goal = value as Record<string, unknown>
  if (
    typeof goal.threadId !== 'string' ||
    goal.threadId.trim().length === 0 ||
    typeof goal.objective !== 'string' ||
    goal.objective.trim().length === 0 ||
    goal.objective.length > threadGoalObjectiveMaxLength ||
    !threadGoalStatuses.includes(goal.status as ThreadGoalStatus)
  ) {
    return undefined
  }

  const tokensUsed = nonNegativeInteger(goal.tokensUsed)
  const timeUsedSeconds = nonNegativeInteger(goal.timeUsedSeconds)
  const createdAt = nonNegativeInteger(goal.createdAt)
  const updatedAt = nonNegativeInteger(goal.updatedAt)
  if (
    tokensUsed === undefined ||
    timeUsedSeconds === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined
  }

  const tokenBudget =
    goal.tokenBudget === null ? null : nonNegativeInteger(goal.tokenBudget)
  if (goal.tokenBudget !== undefined && tokenBudget === undefined) return undefined

  return {
    threadId: goal.threadId.trim(),
    objective: goal.objective.trim(),
    status: goal.status as ThreadGoalStatus,
    ...(goal.tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  }
}

export function shouldApplyThreadGoalEvent({
  authoritative,
  lastAppliedAt,
  eventAt,
}: {
  authoritative?: boolean
  lastAppliedAt: unknown
  eventAt: unknown
}) {
  if (authoritative === true) return true
  const normalizedEventAt = Number(eventAt)
  if (!Number.isFinite(normalizedEventAt)) return false
  return !Number.isFinite(lastAppliedAt) || normalizedEventAt >= Number(lastAppliedAt)
}

export function threadGoalEventTimestampSeconds(value: unknown, fallbackMs = Date.now()) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Math.floor((Number.isFinite(parsed) ? parsed : fallbackMs) / 1000)
}

export function projectThreadGoalEvent({
  currentGoal,
  lastAppliedAt,
  event,
}: {
  currentGoal: ThreadGoal | undefined
  lastAppliedAt: unknown
  event: Record<string, any>
}) {
  if (event.type === 'thread.goal.updated') {
    const goal = normalizeThreadGoal(event.goal)
    if (!goal) {
      return { applied: false, goal: currentGoal, lastAppliedAt }
    }
    const updatedAt = goal.updatedAt
    if (event.authoritative !== true && !currentGoal) {
      return { applied: false, goal: currentGoal, lastAppliedAt }
    }
    if (!shouldApplyThreadGoalEvent({
      authoritative: event.authoritative,
      lastAppliedAt,
      eventAt: updatedAt,
    })) {
      return { applied: false, goal: currentGoal, lastAppliedAt }
    }
    return { applied: true, goal, lastAppliedAt: updatedAt }
  }

  if (event.type === 'thread.goal.cleared') {
    const clearedAt = threadGoalEventTimestampSeconds(event.ts)
    if (!shouldApplyThreadGoalEvent({
      authoritative: event.authoritative,
      lastAppliedAt,
      eventAt: clearedAt,
    })) {
      return { applied: false, goal: currentGoal, lastAppliedAt }
    }
    return { applied: true, goal: undefined, lastAppliedAt: clearedAt }
  }

  return { applied: false, goal: currentGoal, lastAppliedAt }
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined
}
