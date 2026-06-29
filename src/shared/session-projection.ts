import type { AgentMessage, AgentSession, SessionStatus } from './graph-state'
import type {
  ProviderRuntimeEvent,
  RuntimeActivity,
  RuntimePlan,
  RuntimeRequest,
  SessionProjection,
  UserInputRequest,
} from './provider-runtime'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sortKey(item: {
  createdAt?: string
  startedAt?: string
  updatedAt?: string
  ts?: string
}) {
  return item.createdAt ?? item.startedAt ?? item.updatedAt ?? item.ts ?? ''
}

function sortByCreatedAt<T>(items: T[]) {
  return [...items].sort((left, right) =>
    sortKey(left as Record<string, string | undefined>).localeCompare(
      sortKey(right as Record<string, string | undefined>)
    )
  )
}

function isTerminalRuntimeRequestStatus(status?: RuntimeRequest['status']) {
  return (
    status === 'approved' ||
    status === 'denied' ||
    status === 'resolved' ||
    status === 'stale' ||
    status === 'canceled'
  )
}

function isTerminalUserInputStatus(status?: UserInputRequest['status']) {
  return (
    status === 'answered' ||
    status === 'resolved' ||
    status === 'stale' ||
    status === 'canceled'
  )
}

function statusFromEvents(
  events: ProviderRuntimeEvent[],
  fallbackStatus: SessionStatus
) {
  const stateEvents = events.filter((event) => event.type === 'session.state')
  return stateEvents.at(-1)?.status ?? fallbackStatus
}

function applyRuntimeEvents(input: {
  sessionId: string
  events: ProviderRuntimeEvent[]
  fallbackActivities: RuntimeActivity[]
  fallbackRequests: RuntimeRequest[]
  fallbackUserInputRequests: UserInputRequest[]
  fallbackPlans: RuntimePlan[]
}) {
  const activities = new Map<string, RuntimeActivity>()
  const requests = new Map<string, RuntimeRequest>()
  const userInputRequests = new Map<string, UserInputRequest>()
  const plans = new Map<string, RuntimePlan>()

  for (const activity of input.fallbackActivities) {
    activities.set(activity.id, clone(activity))
  }
  for (const request of input.fallbackRequests) {
    requests.set(request.id, clone(request))
  }
  for (const request of input.fallbackUserInputRequests) {
    userInputRequests.set(request.id, clone(request))
  }
  for (const plan of input.fallbackPlans) {
    plans.set(plan.id, clone(plan))
  }

  for (const event of input.events) {
    if (
      event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed'
    ) {
      activities.set(event.item.id, {
        ...(activities.get(event.item.id) ?? {}),
        ...clone(event.item),
        sessionId: input.sessionId,
      })
      continue
    }

    if (event.type === 'request.opened') {
      const existing = requests.get(event.request.id)
      if (
        isTerminalRuntimeRequestStatus(existing?.status) &&
        (event.request.status === undefined || event.request.status === 'open')
      ) {
        continue
      }

      requests.set(event.request.id, {
        ...clone(event.request),
        sessionId: input.sessionId,
        status: event.request.status ?? 'open',
      })
      continue
    }

    if (event.type === 'request.resolved') {
      const existing = requests.get(event.requestId)
      if (existing) {
        requests.set(event.requestId, {
          ...existing,
          status: event.status ?? 'resolved',
          resolvedAt: event.ts,
        })
      }
      continue
    }

    if (event.type === 'user-input.requested') {
      const existing = userInputRequests.get(event.request.id)
      if (
        isTerminalUserInputStatus(existing?.status) &&
        (event.request.status === undefined || event.request.status === 'open')
      ) {
        continue
      }

      userInputRequests.set(event.request.id, {
        ...clone(event.request),
        sessionId: input.sessionId,
        status: event.request.status ?? 'open',
      })
      continue
    }

    if (event.type === 'user-input.answered') {
      const existing = userInputRequests.get(event.requestId)
      if (existing) {
        userInputRequests.set(event.requestId, {
          ...existing,
          status: 'answered',
          answeredAt: event.ts,
          answer: event.answer,
        })
      }
      continue
    }

    if (event.type === 'user-input.resolved') {
      const existing = userInputRequests.get(event.requestId)
      if (existing) {
        userInputRequests.set(event.requestId, {
          ...existing,
          status: event.status ?? 'resolved',
          answeredAt: event.ts,
        })
      }
      continue
    }

    if (event.type === 'plan.updated') {
      plans.set(event.plan.id, clone(event.plan))
    }
  }

  return {
    activities: sortByCreatedAt([...activities.values()]),
    requests: sortByCreatedAt([...requests.values()]),
    userInputRequests: sortByCreatedAt([...userInputRequests.values()]),
    plans: sortByCreatedAt([...plans.values()]),
  }
}

function projectedAssistantMessages(session: AgentSession, events: ProviderRuntimeEvent[]) {
  const assistantByTurn = new Map<
    string,
    { id: string; content: string; ts: string; status: AgentMessage['status'] }
  >()
  const sawTextDeltaByTurn = new Set<string>()

  for (const event of events) {
    if (
      event.type !== 'content.delta' ||
      event.streamKind !== 'assistant_text' ||
      typeof event.text !== 'string'
    ) {
      continue
    }

    const turnId = event.turnId ?? event.itemId ?? 'unknown-turn'
    const existing = assistantByTurn.get(turnId) ?? {
      id: `${session.sessionId}:${turnId}:assistant`,
      content: '',
      ts: event.ts,
      status: 'streaming' as const,
    }

    let applied = false
    if (event.isSnapshot) {
      if (!sawTextDeltaByTurn.has(turnId)) {
        existing.content = event.text
        applied = true
      }
    } else {
      existing.content += event.text
      sawTextDeltaByTurn.add(turnId)
      applied = true
    }
    if (!applied) {
      continue
    }
    existing.ts = event.ts
    existing.status = 'streaming'
    assistantByTurn.set(turnId, existing)
  }

  const completedTurns = new Set(
    events
      .filter((event) => event.type === 'turn.completed')
      .map((event) => event.turnId)
  )

  const projectedMessages = [...assistantByTurn.entries()].map(([turnId, message]) => ({
    id: message.id,
    sessionId: session.sessionId,
    role: 'assistant' as const,
    content: message.content,
    ts: message.ts,
    runId: turnId,
    status: completedTurns.has(turnId) ? ('complete' as const) : message.status,
  }))
  const projectedRunIds = new Set(projectedMessages.map((message) => message.runId))
  const persistedMessages = session.messages
    .filter((message) => message.role === 'assistant')
    .filter((message) => !message.runId || !projectedRunIds.has(message.runId))
    .map((message) => clone(message))

  return [...persistedMessages, ...projectedMessages]
}

export function projectSession(session: AgentSession): SessionProjection {
  const events = session.runtimeEvents ?? []
  const userAndSystemMessages = (session.messages ?? [])
    .filter((message) => message.role !== 'assistant')
    .map((message) => clone(message))
  const messages = [...userAndSystemMessages, ...projectedAssistantMessages(session, events)]
    .sort((left, right) => left.ts.localeCompare(right.ts))

  const runtime = applyRuntimeEvents({
    sessionId: session.sessionId,
    events,
    fallbackActivities: session.runtimeActivities ?? [],
    fallbackRequests: session.runtimeRequests ?? [],
    fallbackUserInputRequests: session.runtimeUserInputRequests ?? [],
    fallbackPlans: session.runtimePlans ?? [],
  })

  return {
    sessionId: session.sessionId,
    messages,
    activities: runtime.activities,
    openRequests: runtime.requests.filter((request) => request.status === 'open'),
    userInputRequests: runtime.userInputRequests.filter(
      (request) => request.status === 'open'
    ),
    staleRequests: runtime.requests.filter((request) => request.status === 'stale'),
    staleUserInputRequests: runtime.userInputRequests.filter(
      (request) => request.status === 'stale'
    ),
    plans: runtime.plans,
    status: statusFromEvents(events, session.status),
    runtimeSettings: session.runtimeSettings,
  }
}
