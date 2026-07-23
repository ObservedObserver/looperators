// Electron-runtime mirror of src/shared/session-projection.ts (same convention
// as graph-state). Keep the projection logic in both files identical; the
// parity test in tests/runtime compares their outputs.

const runtimeEventRetentionLimit = 2000

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

function assistantMessageKey(event) {
  return event.itemId ?? event.turnId ?? 'unknown-turn'
}

function projectedAssistantMessages(session, events) {
  const assistantByKey = new Map()
  const sawTextDeltaByKey = new Set()
  const completedMessageKeys = new Set()

  for (const event of events) {
    if (event.type === 'message.completed' && event.message.role === 'assistant') {
      const key = event.message.providerItemId ?? event.message.runId ?? event.message.id
      completedMessageKeys.add(key)
      const existing = assistantByKey.get(key)
      assistantByKey.set(key, {
        id: existing?.id ?? event.message.id,
        content: event.message.content,
        ts: event.message.ts,
        runId: event.message.runId,
        providerItemId: event.message.providerItemId,
        phase: event.message.phase,
        status: 'complete',
      })
      continue
    }

    if (
      event.type !== 'content.delta' ||
      event.streamKind !== 'assistant_text' ||
      typeof event.text !== 'string'
    ) {
      continue
    }

    const key = assistantMessageKey(event)
    const existing = assistantByKey.get(key) ?? {
      id: `${session.sessionId}:${key}:assistant`,
      content: '',
      ts: event.ts,
      runId: event.turnId ?? key,
      providerItemId: event.itemId,
      status: 'streaming',
    }

    let applied = false
    if (event.isSnapshot) {
      if (!sawTextDeltaByKey.has(key)) {
        existing.content = event.text
        applied = true
      }
    } else {
      existing.content += event.text
      sawTextDeltaByKey.add(key)
      applied = true
    }
    if (!applied) {
      continue
    }
    existing.ts = event.ts
    existing.status = 'streaming'
    assistantByKey.set(key, existing)
  }

  const completedTurns = new Set(
    events
      .filter((event) => event.type === 'turn.completed')
      .map((event) => event.turnId)
  )

  const projectedMessages = [...assistantByKey.values()].map((message) => ({
    id: message.id,
    sessionId: session.sessionId,
    role: 'assistant',
    content: message.content,
    ts: message.ts,
    runId: message.runId,
    providerItemId: message.providerItemId,
    phase: message.phase,
    status: message.runId && completedTurns.has(message.runId) ? 'complete' : message.status,
  }))

  const persistedAssistantMessages = session.messages.filter(
    (message) => message.role === 'assistant'
  )
  const retainedProjectedMessages =
    events.length < runtimeEventRetentionLimit
      ? projectedMessages
      : mergeCappedAssistantMessages(
          projectedMessages,
          persistedAssistantMessages,
          completedMessageKeys
        )
  const projectedRunIds = new Set(
    retainedProjectedMessages.map((message) => message.runId)
  )
  const projectedMessageIds = new Set(
    retainedProjectedMessages.map((message) => message.id)
  )
  const persistedMessages = persistedAssistantMessages
    .filter((message) => !projectedMessageIds.has(message.id))
    .filter((message) => !message.runId || !projectedRunIds.has(message.runId))
    .map((message) => clone(message))

  return [...persistedMessages, ...retainedProjectedMessages]
}

function mergeCappedAssistantMessages(
  projectedMessages,
  persistedMessages,
  completedMessageKeys
) {
  const projectedCountByRun = new Map()
  for (const message of projectedMessages) {
    if (message.runId) {
      projectedCountByRun.set(
        message.runId,
        (projectedCountByRun.get(message.runId) ?? 0) + 1
      )
    }
  }

  const usedPersistedIds = new Set()
  return projectedMessages.map((projected) => {
    const projectedKey =
      projected.providerItemId ?? projected.runId ?? projected.id
    if (completedMessageKeys.has(projectedKey)) {
      return projected
    }

    const exact = persistedMessages.find(
      (persisted) =>
        !usedPersistedIds.has(persisted.id) &&
        (persisted.id === projected.id ||
          Boolean(
            projected.providerItemId &&
              persisted.providerItemId &&
              projected.providerItemId === persisted.providerItemId
          ))
    )
    const persistedRunCandidates =
      projected.runId && projectedCountByRun.get(projected.runId) === 1
        ? persistedMessages.filter(
            (persisted) =>
              !usedPersistedIds.has(persisted.id) &&
              persisted.runId === projected.runId
          )
        : []
    const sameRun =
      exact ??
      (persistedRunCandidates.length === 1
        ? persistedRunCandidates[0]
        : undefined)
    if (
      !sameRun ||
      sameRun.content.length <= projected.content.length ||
      !sameRun.content.endsWith(projected.content)
    ) {
      return projected
    }

    usedPersistedIds.add(sameRun.id)
    return {
      id: sameRun.id,
      sessionId: sameRun.sessionId,
      role: 'assistant',
      content: sameRun.content,
      ts: projected.ts,
      runId: sameRun.runId ?? projected.runId,
      providerItemId: sameRun.providerItemId ?? projected.providerItemId,
      phase: sameRun.phase ?? projected.phase,
      status:
        projected.status === 'complete'
          ? 'complete'
          : sameRun.status ?? projected.status,
    }
  })
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
