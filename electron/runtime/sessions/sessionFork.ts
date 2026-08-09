import { randomUUID } from 'node:crypto'
import { projectSession } from '../../../shared/session-projection.js'
import {
  type JsonRecord,
  clone,
  nonEmptyString,
  now,
  optionalTrimmedString,
} from '../runtimeCommon.js'

type ForkProviderSelector = {
  sourceProviderSessionId: string
  sourceTurnId?: string
  sourceMessageId?: string
}

function itemTurnId(item: JsonRecord) {
  return optionalTrimmedString(item.turnId)
}

function itemTimestamp(item: JsonRecord) {
  return (
    optionalTrimmedString(item.completedAt) ??
    optionalTrimmedString(item.updatedAt) ??
    optionalTrimmedString(item.createdAt) ??
    optionalTrimmedString(item.startedAt) ??
    optionalTrimmedString(item.ts)
  )
}

function isAtOrBefore(item: JsonRecord, boundaryTs: string) {
  const timestamp = itemTimestamp(item)
  return !timestamp || timestamp.localeCompare(boundaryTs) <= 0
}

function includedAtForkPoint(
  item: JsonRecord,
  includedTurnIds: Set<string>,
  boundaryTs: string,
) {
  const turnId = itemTurnId(item)
  return (
    (!turnId || includedTurnIds.has(turnId)) && isAtOrBefore(item, boundaryTs)
  )
}

function messageKey(message: JsonRecord) {
  return (
    optionalTrimmedString(message.providerItemId) ??
    optionalTrimmedString(message.id)
  )
}

function cloneMessagesThrough(
  messages: JsonRecord[],
  targetIndex: number,
  sessionId: string,
) {
  const idByKey = new Map<string, string>()
  const copied = messages.slice(0, targetIndex + 1).map((message) => {
    const id = randomUUID()
    const key = messageKey(message)
    if (key) idByKey.set(key, id)
    return {
      ...clone(message),
      id,
      sessionId,
    }
  })
  return { messages: copied, idByKey }
}

function eventTurnId(event: JsonRecord) {
  return (
    optionalTrimmedString(event.turnId) ??
    optionalTrimmedString(event.message?.runId) ??
    optionalTrimmedString(event.item?.turnId) ??
    optionalTrimmedString(event.request?.turnId) ??
    optionalTrimmedString(event.plan?.turnId)
  )
}

function targetEventBoundary(source: JsonRecord, target: JsonRecord) {
  const events = Array.isArray(source.runtimeEvents) ? source.runtimeEvents : []
  if (source.providerKind === 'codex') {
    const completedIndex = events.findLastIndex(
      (event) =>
        event?.type === 'turn.completed' && event?.turnId === target.runId,
    )
    if (completedIndex >= 0) return completedIndex
    return events.findLastIndex((event) => eventTurnId(event) === target.runId)
  }

  return events.findIndex(
    (event) =>
      event?.type === 'message.completed' &&
      event?.message?.role === 'assistant' &&
      event?.message?.providerItemId === target.providerItemId,
  )
}

function rewriteRuntimeEvent(
  event: JsonRecord,
  sessionId: string,
  messageIdByKey: Map<string, string>,
) {
  const copied = clone(event)
  copied.id = randomUUID()
  copied.sessionId = sessionId
  if (copied.message) {
    const key = messageKey(copied.message)
    copied.message = {
      ...copied.message,
      id: (key && messageIdByKey.get(key)) || randomUUID(),
      sessionId,
    }
  }
  if (copied.item) copied.item = { ...copied.item, sessionId }
  if (copied.request) copied.request = { ...copied.request, sessionId }
  if (copied.plan) copied.plan = { ...copied.plan, sessionId }
  if (copied.diff) copied.diff = { ...copied.diff, sessionId }
  return copied
}

function cloneRuntimeEventsThrough(
  source: JsonRecord,
  target: JsonRecord,
  sessionId: string,
  messageIdByKey: Map<string, string>,
  createdAt: string,
) {
  const sourceEvents = Array.isArray(source.runtimeEvents)
    ? source.runtimeEvents
    : []
  const boundary = targetEventBoundary(source, target)
  const historicalEvents =
    boundary >= 0
      ? sourceEvents.slice(0, boundary + 1)
      : sourceEvents.filter(
          (event) =>
            typeof event?.ts === 'string' &&
            event.ts.localeCompare(target.ts) <= 0,
        )
  const copied = historicalEvents
    // Checkpoint refs are owned by the source session. Showing them on the
    // fork would create a patch button that cannot resolve its files.
    .filter(
      (event) =>
        event?.type !== 'turn.diff.updated' && event?.type !== 'session.state',
    )
    .map((event) => rewriteRuntimeEvent(event, sessionId, messageIdByKey))

  copied.push({
    id: randomUUID(),
    ts: createdAt,
    type: 'session.state',
    sessionId,
    status: 'idle',
  })
  return copied
}

function cloneHistoricalItems(
  items: unknown,
  sessionId: string,
  includedTurnIds: Set<string>,
  boundaryTs: string,
  staleOpen = false,
) {
  if (!Array.isArray(items)) return []
  return items
    .filter((item) =>
      item && typeof item === 'object'
        ? includedAtForkPoint(item, includedTurnIds, boundaryTs)
        : false,
    )
    .map((item) => {
      const copied = { ...clone(item), sessionId }
      if (staleOpen && copied.status === 'open') copied.status = 'stale'
      return copied
    })
}

function forkWorkspaceProject(source: JsonRecord) {
  if (!source.project || typeof source.project !== 'object') return undefined
  const project = {
    ...clone(source.project),
    // A conversation fork shares the current cwd. It does not become a
    // second owner of a managed worktree or its merge/cleanup lifecycle.
    workMode: 'local',
  }
  delete project.forkPoint
  delete project.mergedAt
  delete project.mergedTurnId
  delete project.cleanupStatus
  delete project.cleanedAt
  return project
}

function providerForkSelector(
  source: JsonRecord,
  target: JsonRecord,
): ForkProviderSelector {
  const sourceProviderSessionId = optionalTrimmedString(
    source.providerSessionId ?? source.backendSessionId,
  )
  if (!sourceProviderSessionId) {
    throw new Error('This chat has no provider session to fork yet.')
  }

  if (source.providerKind === 'codex') {
    if (target.phase === 'commentary') {
      throw new Error(
        'Fork from the completed Codex response at the end of this turn.',
      )
    }
    const sourceTurnId = optionalTrimmedString(target.providerTurnId)
    if (!sourceTurnId) {
      throw new Error(
        'This Codex reply predates provider turn metadata and cannot be forked precisely.',
      )
    }
    return { sourceProviderSessionId, sourceTurnId }
  }

  if (source.providerKind === 'claude-code') {
    const inheritedForkBoundary = optionalTrimmedString(
      source.forkedFrom?.createdAt,
    )
    if (
      inheritedForkBoundary &&
      optionalTrimmedString(target.ts)?.localeCompare(inheritedForkBoundary) <=
        0
    ) {
      throw new Error(
        'Fork copied Claude history from its source chat; fork a reply created in this chat instead.',
      )
    }
    const sourceMessageId = optionalTrimmedString(target.providerItemId)
    if (!sourceMessageId) {
      throw new Error(
        'This Claude reply predates message-level fork metadata and cannot be forked precisely.',
      )
    }
    return { sourceProviderSessionId, sourceMessageId }
  }

  throw new Error('This provider does not support independent session forks.')
}

export function createSessionFork(
  source: JsonRecord,
  input: JsonRecord,
  position: { x: number; y: number },
) {
  if (source.project?.workMode === 'worktree') {
    throw new Error(
      'Forking a managed-worktree chat requires an independent workspace and is not supported yet.',
    )
  }
  if (source.status !== 'idle') {
    throw new Error('Wait for the source chat to finish before forking it.')
  }
  const messageId = optionalTrimmedString(input.messageId)
  if (!messageId)
    throw new Error('An assistant message is required to fork a chat.')

  const projection = projectSession(source)
  const targetIndex = projection.messages.findIndex(
    (message) => message.id === messageId,
  )
  const target = projection.messages[targetIndex]
  if (!target || target.role !== 'assistant') {
    throw new Error(
      `Unknown assistant message in session ${source.sessionId}: ${messageId}`,
    )
  }
  if (target.status === 'streaming' || target.status === 'failed') {
    throw new Error('Only completed assistant messages can be forked.')
  }
  const latestAssistantIndex = projection.messages.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      message.status !== 'streaming' &&
      message.status !== 'failed',
  )
  if (targetIndex !== latestAssistantIndex) {
    throw new Error(
      'Fork the latest completed assistant message; historical workspace rewind is not supported yet.',
    )
  }

  const providerFork = providerForkSelector(source, target)
  const sessionId = randomUUID()
  const createdAt = now()
  const copiedMessages = cloneMessagesThrough(
    projection.messages,
    targetIndex,
    sessionId,
  )
  const includedTurnIds = new Set(
    copiedMessages.messages.flatMap((message) =>
      nonEmptyString(message.runId) ? [message.runId] : [],
    ),
  )
  const runtimeEvents = cloneRuntimeEventsThrough(
    source,
    target,
    sessionId,
    copiedMessages.idByKey,
    createdAt,
  )
  const label = optionalTrimmedString(input.label) ?? `${source.label} (fork)`
  const forkedFrom = {
    sessionId: source.sessionId,
    messageId: target.id,
    ...(nonEmptyString(target.runId) ? { turnId: target.runId } : {}),
    ...(nonEmptyString(target.providerTurnId)
      ? { providerTurnId: target.providerTurnId }
      : {}),
    ...(nonEmptyString(target.providerItemId)
      ? { providerItemId: target.providerItemId }
      : {}),
    createdAt,
  }

  const session = {
    sessionId,
    nodeId: sessionId,
    backend: source.backend,
    backendSessionId: undefined,
    providerKind: source.providerKind,
    providerInstanceId: source.providerInstanceId,
    providerSessionId: undefined,
    providerResumeCursor: undefined,
    providerFork,
    forkedFrom,
    agent: source.agent,
    label,
    prompt: target.content,
    cwd: source.cwd,
    project: forkWorkspaceProject(source),
    role: 'worker',
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    finishedAt: createdAt,
    exitCode: 0,
    result: target.content,
    chunks: [],
    messages: copiedMessages.messages,
    nativeEvents: [],
    runtimeEvents,
    runtimeActivities: cloneHistoricalItems(
      source.runtimeActivities,
      sessionId,
      includedTurnIds,
      target.ts,
    ),
    runtimeRequests: cloneHistoricalItems(
      source.runtimeRequests,
      sessionId,
      includedTurnIds,
      target.ts,
      true,
    ),
    runtimeUserInputRequests: cloneHistoricalItems(
      source.runtimeUserInputRequests,
      sessionId,
      includedTurnIds,
      target.ts,
      true,
    ),
    runtimePlans: cloneHistoricalItems(
      source.runtimePlans,
      sessionId,
      includedTurnIds,
      target.ts,
    ),
    runtimeSettings: clone(source.runtimeSettings),
    effectiveRuntimeConfig: clone(source.effectiveRuntimeConfig),
    archived: false,
  }
  const node = {
    nodeId: sessionId,
    sessionId,
    label,
    role: 'worker',
    agent: source.agent,
    status: 'idle',
    position,
  }

  return { sessionId, session, node, target, forkedFrom }
}
