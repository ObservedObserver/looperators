// Electron-runtime mirror of src/shared/session-projection.ts (same convention
// as graph-state). Keep the projection logic in both files identical; the
// parity test in tests/runtime compares their outputs.

function clone(value) {
  return structuredClone(value)
}

function sortKey(item) {
  return (
    item.createdAt ??
    item.startedAt ??
    item.updatedAt ??
    item.generatedAt ??
    item.ts ??
    ''
  )
}

function sortByCreatedAt(items) {
  return [...items].sort((left, right) =>
    sortKey(left).localeCompare(sortKey(right))
  )
}

function isTerminalRuntimeRequestStatus(status) {
  return (
    status === 'approved' ||
    status === 'approved_for_session' ||
    status === 'denied' ||
    status === 'resolved' ||
    status === 'stale' ||
    status === 'canceled'
  )
}

function isTerminalUserInputStatus(status) {
  return (
    status === 'answered' ||
    status === 'resolved' ||
    status === 'stale' ||
    status === 'canceled'
  )
}

function statusFromEvents(events, fallbackStatus) {
  const stateEvents = events.filter((event) => event.type === 'session.state')
  return stateEvents.at(-1)?.status ?? fallbackStatus
}

function applyRuntimeEvents(input) {
  const activities = new Map()
  const requests = new Map()
  const userInputRequests = new Map()
  const plans = new Map()

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
          answers: event.answers,
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

function projectedTurnDiffs(events) {
  const turnDiffs = new Map()

  for (const event of events) {
    if (event.type !== 'turn.diff.updated') {
      continue
    }
    turnDiffs.set(event.turnId, clone(event.diff))
  }

  return sortByCreatedAt([...turnDiffs.values()])
}

function projectedAssistantMessages(session, events) {
  const assistantByTurn = new Map()
  const sawTextDeltaByTurn = new Set()

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
      status: 'streaming',
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
    role: 'assistant',
    content: message.content,
    ts: message.ts,
    runId: turnId,
    status: completedTurns.has(turnId) ? 'complete' : message.status,
  }))
  const projectedRunIds = new Set(projectedMessages.map((message) => message.runId))
  const persistedMessages = session.messages
    .filter((message) => message.role === 'assistant')
    .filter((message) => !message.runId || !projectedRunIds.has(message.runId))
    .map((message) => clone(message))

  return [...persistedMessages, ...projectedMessages]
}

function messageTimelineEntry(message) {
  return {
    id: `message:${message.id}`,
    kind: 'message',
    ts: message.ts,
    turnId: message.runId,
    message,
  }
}

function buildTimeline(input) {
  const entries = []

  for (const event of input.events) {
    if (event.type === 'turn.started') {
      entries.push({
        id: `turn-started:${event.turnId}:${event.id}`,
        kind: 'turn',
        status: 'started',
        ts: event.ts,
        turnId: event.turnId,
      })
    }
    if (event.type === 'turn.completed') {
      entries.push({
        id: `turn-completed:${event.turnId}:${event.id}`,
        kind: 'turn',
        status: 'completed',
        ts: event.ts,
        turnId: event.turnId,
      })
    }
  }

  entries.push(...input.messages.map(messageTimelineEntry))
  entries.push(
    ...input.activities.map((activity) => ({
      id: `activity:${activity.id}`,
      kind: 'activity',
      ts: sortKey(activity),
      turnId: activity.turnId,
      activity,
    }))
  )
  entries.push(
    ...input.requests.map((request) => ({
      id: `request:${request.id}`,
      kind: 'request',
      ts: request.createdAt,
      turnId: request.turnId,
      request,
    }))
  )
  entries.push(
    ...input.userInputRequests.map((request) => ({
      id: `user-input:${request.id}`,
      kind: 'user-input',
      ts: request.createdAt,
      turnId: request.turnId,
      request,
    }))
  )
  entries.push(
    ...input.plans.map((plan) => ({
      id: `plan:${plan.id}`,
      kind: 'plan',
      ts: plan.updatedAt,
      turnId: plan.turnId,
      plan,
    }))
  )
  entries.push(
    ...input.turnDiffs.map((diff) => ({
      id: `turn-diff:${diff.turnId}`,
      kind: 'turn-diff',
      ts: diff.generatedAt,
      turnId: diff.turnId,
      diff,
    }))
  )

  return entries.sort((left, right) => {
    const tsComparison = left.ts.localeCompare(right.ts)
    if (tsComparison !== 0) {
      return tsComparison
    }
    return timelineKindOrder(left.kind) - timelineKindOrder(right.kind)
  })
}

function timelineKindOrder(kind) {
  switch (kind) {
    case 'turn':
      return 0
    case 'request':
    case 'user-input':
      return 1
    case 'plan':
      return 2
    case 'activity':
      return 3
    case 'message':
      return 4
    case 'turn-diff':
      return 5
  }
}

export function projectSession(session) {
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
  const turnDiffs = projectedTurnDiffs(events)
  const activePlan = runtime.plans.at(-1)
  const timeline = buildTimeline({
    events,
    messages,
    activities: runtime.activities,
    requests: runtime.requests,
    userInputRequests: runtime.userInputRequests,
    plans: runtime.plans,
    turnDiffs,
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
    activePlan,
    turnDiffs,
    timeline,
    status: statusFromEvents(events, session.status),
    runtimeSettings: session.runtimeSettings,
    effectiveRuntimeConfig: session.effectiveRuntimeConfig,
  }
}
