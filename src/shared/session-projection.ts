import type { AgentMessage, AgentSession, SessionStatus } from './graph-state';
import type {
  ProviderRuntimeEvent,
  RuntimeActivity,
  RuntimePlan,
  RuntimeRequest,
  SessionProjection,
  SessionTimelineEntry,
  TurnDiffSummary,
  UserInputRequest,
} from './provider-runtime';

const runtimeEventRetentionLimit = 2000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortKey(item: { createdAt?: string; startedAt?: string; updatedAt?: string; generatedAt?: string; ts?: string }) {
  return item.createdAt ?? item.startedAt ?? item.updatedAt ?? item.generatedAt ?? item.ts ?? '';
}

function sortByCreatedAt<T>(items: T[]) {
  return [...items].sort((left, right) =>
    sortKey(left as Record<string, string | undefined>).localeCompare(sortKey(right as Record<string, string | undefined>)),
  );
}

function isTerminalRuntimeRequestStatus(status?: RuntimeRequest['status']) {
  return (
    status === 'approved' || status === 'approved_for_session' || status === 'denied' || status === 'resolved' || status === 'stale' || status === 'canceled'
  );
}

function isTerminalUserInputStatus(status?: UserInputRequest['status']) {
  return status === 'answered' || status === 'resolved' || status === 'stale' || status === 'canceled';
}

function statusFromEvents(events: ProviderRuntimeEvent[], fallbackStatus: SessionStatus) {
  const stateEvents = events.filter((event) => event.type === 'session.state');
  return stateEvents.at(-1)?.status ?? fallbackStatus;
}

function applyRuntimeEvents(input: {
  sessionId: string;
  events: ProviderRuntimeEvent[];
  fallbackActivities: RuntimeActivity[];
  fallbackRequests: RuntimeRequest[];
  fallbackUserInputRequests: UserInputRequest[];
  fallbackPlans: RuntimePlan[];
}) {
  const activities = new Map<string, RuntimeActivity>();
  const requests = new Map<string, RuntimeRequest>();
  const userInputRequests = new Map<string, UserInputRequest>();
  const plans = new Map<string, RuntimePlan>();

  for (const activity of input.fallbackActivities) {
    activities.set(activity.id, clone(activity));
  }
  for (const request of input.fallbackRequests) {
    requests.set(request.id, clone(request));
  }
  for (const request of input.fallbackUserInputRequests) {
    userInputRequests.set(request.id, clone(request));
  }
  for (const plan of input.fallbackPlans) {
    plans.set(plan.id, clone(plan));
  }

  for (const event of input.events) {
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      activities.set(event.item.id, {
        ...(activities.get(event.item.id) ?? {}),
        ...clone(event.item),
        sessionId: input.sessionId,
      });
      continue;
    }

    if (event.type === 'request.opened') {
      const existing = requests.get(event.request.id);
      if (isTerminalRuntimeRequestStatus(existing?.status) && (event.request.status === undefined || event.request.status === 'open')) {
        continue;
      }

      requests.set(event.request.id, {
        ...clone(event.request),
        sessionId: input.sessionId,
        status: event.request.status ?? 'open',
      });
      continue;
    }

    if (event.type === 'request.resolved') {
      const existing = requests.get(event.requestId);
      if (existing) {
        requests.set(event.requestId, {
          ...existing,
          status: event.status ?? 'resolved',
          resolvedAt: event.ts,
        });
      }
      continue;
    }

    if (event.type === 'user-input.requested') {
      const existing = userInputRequests.get(event.request.id);
      if (isTerminalUserInputStatus(existing?.status) && (event.request.status === undefined || event.request.status === 'open')) {
        continue;
      }

      userInputRequests.set(event.request.id, {
        ...clone(event.request),
        sessionId: input.sessionId,
        status: event.request.status ?? 'open',
      });
      continue;
    }

    if (event.type === 'user-input.answered') {
      const existing = userInputRequests.get(event.requestId);
      if (existing) {
        userInputRequests.set(event.requestId, {
          ...existing,
          status: 'answered',
          answeredAt: event.ts,
          answer: event.answer,
          answers: event.answers,
        });
      }
      continue;
    }

    if (event.type === 'user-input.resolved') {
      const existing = userInputRequests.get(event.requestId);
      if (existing) {
        userInputRequests.set(event.requestId, {
          ...existing,
          status: event.status ?? 'resolved',
          answeredAt: event.ts,
        });
      }
      continue;
    }

    if (event.type === 'plan.updated') {
      plans.set(event.plan.id, clone(event.plan));
    }
  }

  return {
    activities: sortByCreatedAt([...activities.values()]),
    requests: sortByCreatedAt([...requests.values()]),
    userInputRequests: sortByCreatedAt([...userInputRequests.values()]),
    plans: sortByCreatedAt([...plans.values()]),
  };
}

function projectedTurnDiffs(events: ProviderRuntimeEvent[]) {
  const turnDiffs = new Map<string, TurnDiffSummary>();

  for (const event of events) {
    if (event.type !== 'turn.diff.updated') {
      continue;
    }
    turnDiffs.set(event.turnId, clone(event.diff));
  }

  return sortByCreatedAt([...turnDiffs.values()]);
}

function assistantMessageKey(event: { turnId?: string; itemId?: string }) {
  return event.itemId ?? event.turnId ?? 'unknown-turn';
}

function assistantProjectionEventKey(event: ProviderRuntimeEvent) {
  if (
    event.type === 'content.delta' &&
    event.streamKind === 'assistant_text' &&
    typeof event.text === 'string'
  ) {
    return assistantMessageKey(event);
  }
  if (event.type === 'message.completed' && event.message.role === 'assistant') {
    return event.message.providerItemId ?? event.message.runId ?? event.message.id;
  }
  return undefined;
}

function projectedAssistantMessages(session: AgentSession, events: ProviderRuntimeEvent[]) {
  const assistantByKey = new Map<
    string,
    {
      id: string;
      content: string;
      ts: string;
      runId?: string;
      providerItemId?: string;
      phase?: string;
      status: AgentMessage['status'];
    }
  >();
  const sawTextDeltaByKey = new Set<string>();
  const completedMessageKeys = new Set<string>();

  for (const event of events) {
    if (event.type === 'message.completed' && event.message.role === 'assistant') {
      const key = event.message.providerItemId ?? event.message.runId ?? event.message.id;
      completedMessageKeys.add(key);
      const existing = assistantByKey.get(key);
      assistantByKey.set(key, {
        id: existing?.id ?? event.message.id,
        content: event.message.content,
        ts: event.message.ts,
        runId: event.message.runId,
        providerItemId: event.message.providerItemId,
        phase: event.message.phase,
        status: 'complete',
      });
      continue;
    }

    if (event.type !== 'content.delta' || event.streamKind !== 'assistant_text' || typeof event.text !== 'string') {
      continue;
    }

    const key = assistantMessageKey(event);
    const existing = assistantByKey.get(key) ?? {
      id: `${session.sessionId}:${key}:assistant`,
      content: '',
      ts: event.ts,
      runId: event.turnId ?? key,
      providerItemId: event.itemId,
      status: 'streaming' as const,
    };

    let applied = false;
    if (event.isSnapshot) {
      if (!sawTextDeltaByKey.has(key)) {
        existing.content = event.text;
        applied = true;
      }
    } else {
      existing.content += event.text;
      sawTextDeltaByKey.add(key);
      applied = true;
    }
    if (!applied) {
      continue;
    }
    existing.ts = event.ts;
    existing.status = 'streaming';
    assistantByKey.set(key, existing);
  }

  const completedTurns = new Set(events.filter((event) => event.type === 'turn.completed').map((event) => event.turnId));

  const projectedMessages = [...assistantByKey.values()].map((message) => ({
    id: message.id,
    sessionId: session.sessionId,
    role: 'assistant' as const,
    content: message.content,
    ts: message.ts,
    runId: message.runId,
    providerItemId: message.providerItemId,
    phase: message.phase,
    status: message.runId && completedTurns.has(message.runId) ? ('complete' as const) : message.status,
  }));

  const persistedAssistantMessages = session.messages.filter((message) => message.role === 'assistant');
  const retainedProjectedMessages =
    events.length < runtimeEventRetentionLimit
      ? projectedMessages
      : mergeCappedAssistantMessages(projectedMessages, persistedAssistantMessages, completedMessageKeys);
  const projectedRunIds = new Set(retainedProjectedMessages.map((message) => message.runId));
  const projectedMessageIds = new Set(retainedProjectedMessages.map((message) => message.id));
  const persistedMessages = persistedAssistantMessages
    .filter((message) => !projectedMessageIds.has(message.id))
    .filter((message) => !message.runId || !projectedRunIds.has(message.runId))
    .map((message) => clone(message));

  return [...persistedMessages, ...retainedProjectedMessages];
}

function mergeCappedAssistantMessages(
  projectedMessages: AgentMessage[],
  persistedMessages: AgentMessage[],
  completedMessageKeys: Set<string>,
) {
  const projectedCountByRun = new Map<string, number>();
  for (const message of projectedMessages) {
    if (message.runId) {
      projectedCountByRun.set(message.runId, (projectedCountByRun.get(message.runId) ?? 0) + 1);
    }
  }

  const usedPersistedIds = new Set<string>();
  return projectedMessages.map((projected) => {
    const projectedKey = projected.providerItemId ?? projected.runId ?? projected.id;
    if (completedMessageKeys.has(projectedKey)) {
      return projected;
    }

    const exact = persistedMessages.find(
      (persisted) =>
        !usedPersistedIds.has(persisted.id) &&
        (persisted.id === projected.id ||
          Boolean(
            projected.providerItemId &&
              persisted.providerItemId &&
              projected.providerItemId === persisted.providerItemId,
          )),
    );
    const persistedRunCandidates =
      projected.runId && projectedCountByRun.get(projected.runId) === 1
        ? persistedMessages.filter(
            (persisted) => !usedPersistedIds.has(persisted.id) && persisted.runId === projected.runId,
          )
        : [];
    const sameRun = exact ?? (persistedRunCandidates.length === 1 ? persistedRunCandidates[0] : undefined);
    if (
      !sameRun ||
      sameRun.content.length <= projected.content.length ||
      !sameRun.content.endsWith(projected.content)
    ) {
      return projected;
    }

    usedPersistedIds.add(sameRun.id);
    return {
      id: sameRun.id,
      sessionId: sameRun.sessionId,
      role: 'assistant' as const,
      content: sameRun.content,
      ts: projected.ts,
      runId: sameRun.runId ?? projected.runId,
      providerItemId: sameRun.providerItemId ?? projected.providerItemId,
      phase: sameRun.phase ?? projected.phase,
      status: projected.status === 'complete' ? ('complete' as const) : sameRun.status ?? projected.status,
    };
  });
}

function messageTimelineEntry(message: AgentMessage): SessionTimelineEntry {
  return {
    id: `message:${message.id}`,
    kind: 'message',
    ts: message.ts,
    turnId: message.runId,
    message,
  };
}

function buildTimeline(input: {
  events: ProviderRuntimeEvent[];
  messages: AgentMessage[];
  activities: RuntimeActivity[];
  requests: RuntimeRequest[];
  userInputRequests: UserInputRequest[];
  plans: RuntimePlan[];
  turnDiffs: TurnDiffSummary[];
}) {
  const entries: SessionTimelineEntry[] = [];

  for (const event of input.events) {
    if (event.type === 'turn.started') {
      entries.push({
        id: `turn-started:${event.turnId}:${event.id}`,
        kind: 'turn',
        status: 'started',
        ts: event.ts,
        turnId: event.turnId,
      });
    }
    if (event.type === 'turn.completed') {
      entries.push({
        id: `turn-completed:${event.turnId}:${event.id}`,
        kind: 'turn',
        status: 'completed',
        ts: event.ts,
        turnId: event.turnId,
      });
    }
  }

  entries.push(...input.messages.map(messageTimelineEntry));
  entries.push(
    ...input.activities.map((activity) => ({
      id: `activity:${activity.id}`,
      kind: 'activity' as const,
      ts: sortKey(activity),
      turnId: activity.turnId,
      activity,
    })),
  );
  entries.push(
    ...input.requests.map((request) => ({
      id: `request:${request.id}`,
      kind: 'request' as const,
      ts: request.createdAt,
      turnId: request.turnId,
      request,
    })),
  );
  entries.push(
    ...input.userInputRequests.map((request) => ({
      id: `user-input:${request.id}`,
      kind: 'user-input' as const,
      ts: request.createdAt,
      turnId: request.turnId,
      request,
    })),
  );
  entries.push(
    ...input.plans.map((plan) => ({
      id: `plan:${plan.id}`,
      kind: 'plan' as const,
      ts: plan.updatedAt,
      turnId: plan.turnId,
      plan,
    })),
  );
  entries.push(
    ...input.turnDiffs.map((diff) => ({
      id: `turn-diff:${diff.turnId}`,
      kind: 'turn-diff' as const,
      ts: diff.generatedAt,
      turnId: diff.turnId,
      diff,
    })),
  );

  return entries.sort((left, right) => {
    const tsComparison = left.ts.localeCompare(right.ts);
    if (tsComparison !== 0) {
      return tsComparison;
    }
    return timelineKindOrder(left.kind) - timelineKindOrder(right.kind);
  });
}

function timelineKindOrder(kind: SessionTimelineEntry['kind']) {
  switch (kind) {
    case 'turn':
      return 0;
    case 'request':
    case 'user-input':
      return 1;
    case 'plan':
      return 2;
    case 'activity':
      return 3;
    case 'message':
      return 4;
    case 'turn-diff':
      return 5;
  }
}

function appendedRuntimeEvents(previous: AgentSession, next: AgentSession) {
  const previousEvents = previous.runtimeEvents ?? [];
  const nextEvents = next.runtimeEvents ?? [];
  if (previousEvents.length === 0) {
    return {
      appended: nextEvents,
      evicted: [] as ProviderRuntimeEvent[],
    };
  }
  if (nextEvents.length === 0) {
    return undefined;
  }

  const overlapStart = previousEvents.findIndex((event) => event.id === nextEvents[0]?.id);
  if (overlapStart < 0) {
    return undefined;
  }
  const overlapLength = previousEvents.length - overlapStart;
  if (overlapLength > nextEvents.length) {
    return undefined;
  }
  for (let index = 0; index < overlapLength; index += 1) {
    if (previousEvents[overlapStart + index]?.id !== nextEvents[index]?.id) {
      return undefined;
    }
  }
  return {
    appended: nextEvents.slice(overlapLength),
    evicted: previousEvents.slice(0, overlapStart),
  };
}

function sameAttachments(left: AgentMessage['attachments'], right: AgentMessage['attachments']) {
  if (left === right) {
    return true;
  }
  const leftAttachments = left ?? [];
  const rightAttachments = right ?? [];
  return (
    leftAttachments.length === rightAttachments.length &&
    leftAttachments.every((attachment, index) => {
      const candidate = rightAttachments[index];
      return (
        attachment.id === candidate?.id &&
        attachment.name === candidate.name &&
        attachment.mediaType === candidate.mediaType &&
        attachment.size === candidate.size &&
        attachment.kind === candidate.kind &&
        attachment.text === candidate.text &&
        attachment.dataUrl === candidate.dataUrl &&
        attachment.truncated === candidate.truncated
      );
    })
  );
}

function sameMessage(left: AgentMessage, right: AgentMessage) {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.role === right.role &&
    left.content === right.content &&
    left.ts === right.ts &&
    left.runId === right.runId &&
    left.providerItemId === right.providerItemId &&
    left.phase === right.phase &&
    left.status === right.status &&
    sameAttachments(left.attachments, right.attachments)
  );
}

function projectionMessageIndexForDelta(
  messages: AgentMessage[],
  event: Extract<ProviderRuntimeEvent, { type: 'content.delta' }>,
) {
  if (event.itemId) {
    const exactItem = messages.findIndex(
      (message) => message.role === 'assistant' && message.providerItemId === event.itemId,
    );
    if (exactItem >= 0) {
      return exactItem;
    }
    return -1;
  }
  if (!event.turnId) {
    return -1;
  }
  const sameRunIndexes = messages.flatMap((message, index) =>
    message.role === 'assistant' && message.runId === event.turnId ? [index] : [],
  );
  return sameRunIndexes.length === 1 ? sameRunIndexes[0] : -1;
}

function messagesForAssistantDelta(
  session: AgentSession,
  previous: SessionProjection,
  appendedEvents: ProviderRuntimeEvent[],
): AgentMessage[] | undefined {
  type AssistantDelta = Extract<ProviderRuntimeEvent, { type: 'content.delta' }>;
  const itemIndexes = new Map<string, number>();
  const runIndexes = new Map<string, number>();
  previous.messages.forEach((message, index) => {
    if (message.role !== 'assistant') {
      return;
    }
    if (message.providerItemId && !itemIndexes.has(message.providerItemId)) {
      itemIndexes.set(message.providerItemId, index);
    }
    if (message.runId) {
      runIndexes.set(message.runId, runIndexes.has(message.runId) ? -1 : index);
    }
  });
  const completedTurnIds = new Set(
    (session.runtimeEvents ?? []).flatMap((event) =>
      event.type === 'turn.completed' ? [event.turnId] : [],
    ),
  );
  const updates = new Map<number, { text: string; lastEvent: AssistantDelta }>();

  for (const event of appendedEvents) {
    if (
      event.type !== 'content.delta' ||
      event.streamKind !== 'assistant_text' ||
      typeof event.text !== 'string'
    ) {
      continue;
    }
    const index = event.itemId
      ? (itemIndexes.get(event.itemId) ?? -1)
      : event.turnId
        ? (runIndexes.get(event.turnId) ?? -1)
        : -1;
    if (index < 0) {
      return undefined;
    }
    const current = updates.get(index);
    updates.set(index, {
      text: `${current?.text ?? ''}${event.text}`,
      lastEvent: event,
    });
  }

  if (updates.size === 0) {
    return previous.messages;
  }

  const messages = [...previous.messages];
  let changed = false;
  for (const [index, update] of updates) {
    const existing = previous.messages[index];
    if (!existing) {
      return undefined;
    }
    const runId = existing.runId ?? update.lastEvent.turnId;
    const nextMessage: AgentMessage = {
      ...existing,
      role: 'assistant',
      content: `${existing.content}${update.text}`,
      ts: update.lastEvent.ts,
      runId,
      providerItemId: existing.providerItemId ?? update.lastEvent.itemId,
      status: runId && completedTurnIds.has(runId) ? 'complete' : 'streaming',
    };
    if (sameMessage(existing, nextMessage)) {
      continue;
    }
    messages[index] = nextMessage;
    changed = true;
  }

  return changed
    ? messages.sort((left, right) => left.ts.localeCompare(right.ts))
    : previous.messages;
}

function timelineForAssistantDelta(previous: SessionProjection, messages: AgentMessage[]) {
  const previousEntries = new Map(
    previous.timeline
      .filter((entry): entry is Extract<SessionTimelineEntry, { kind: 'message' }> => entry.kind === 'message')
      .map((entry) => [entry.message.id, entry]),
  );
  const nextMessageIds = new Set(messages.map((message) => message.id));
  const timeline = previous.timeline.filter((entry) => entry.kind !== 'message' || nextMessageIds.has(entry.message.id));
  const timelineEntryIndexes = new Map(timeline.map((entry, index) => [entry.id, index]));

  for (const message of messages) {
    const id = `message:${message.id}`;
    const previousEntry = previousEntries.get(message.id);
    const entry = previousEntry?.message === message ? previousEntry : messageTimelineEntry(message);
    const index = timelineEntryIndexes.get(id);
    if (index === undefined) {
      timeline.push(entry);
    } else {
      timeline[index] = entry;
    }
  }

  return timeline.sort((left, right) => {
    const tsComparison = left.ts.localeCompare(right.ts);
    if (tsComparison !== 0) {
      return tsComparison;
    }
    return timelineKindOrder(left.kind) - timelineKindOrder(right.kind);
  });
}

function projectionContainsAssistantDelta(
  projection: SessionProjection,
  event: ProviderRuntimeEvent,
) {
  if (event.type !== 'content.delta' || event.streamKind !== 'assistant_text') {
    return true;
  }
  return projectionMessageIndexForDelta(projection.messages, event) >= 0;
}

function projectAssistantDeltaBoundary(
  session: AgentSession,
  previous: SessionProjection,
) {
  const canonical = projectSession(session);
  const previousMessages = new Map(previous.messages.map((message) => [message.id, message]));
  const messages = canonical.messages.map((message) => {
    const existing = previousMessages.get(message.id);
    return existing && sameMessage(existing, message) ? existing : message;
  });
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const previousTimeline = new Map(previous.timeline.map((entry) => [entry.id, entry]));
  const timeline = canonical.timeline.map((entry) => {
    const existing = previousTimeline.get(entry.id);
    if (entry.kind !== 'message') {
      return existing ?? entry;
    }
    const message = messagesById.get(entry.message.id) ?? entry.message;
    return existing?.kind === 'message' && existing.message === message
      ? existing
      : { ...entry, message };
  });

  return {
    ...canonical,
    messages,
    activities: previous.activities,
    openRequests: previous.openRequests,
    userInputRequests: previous.userInputRequests,
    staleRequests: previous.staleRequests,
    staleUserInputRequests: previous.staleUserInputRequests,
    plans: previous.plans,
    activePlan: previous.activePlan,
    turnDiffs: previous.turnDiffs,
    timeline,
  };
}

/**
 * Fast path for the dominant renderer workload: append-only content deltas.
 * It extends the prior projected message from only the newly appended events,
 * avoiding a replay of every historical provider event on each 50 ms batch.
 * All other event shapes retain the canonical full projection path.
 */
export function projectSessionIncrementally(
  session: AgentSession,
  previousSession?: AgentSession,
  previousProjection?: SessionProjection,
): SessionProjection {
  if (!previousSession || !previousProjection || previousSession.sessionId !== session.sessionId) {
    return projectSession(session);
  }
  if (previousSession === session) {
    return previousProjection;
  }

  const runtimeEventDelta = appendedRuntimeEvents(previousSession, session);
  const stableFallbacks =
    previousSession.runtimeActivities === session.runtimeActivities &&
    previousSession.runtimeRequests === session.runtimeRequests &&
    previousSession.runtimeUserInputRequests === session.runtimeUserInputRequests &&
    previousSession.runtimePlans === session.runtimePlans &&
    previousSession.status === session.status &&
    previousSession.runtimeSettings === session.runtimeSettings &&
    previousSession.effectiveRuntimeConfig === session.effectiveRuntimeConfig;
  const currentAssistantKeys = new Set(
    (session.runtimeEvents ?? []).flatMap((event) => {
      const key = assistantProjectionEventKey(event);
      return key ? [key] : [];
    }),
  );
  const previousAssistantKeys = new Set(
    (previousSession.runtimeEvents ?? []).flatMap((event) => {
      const key = assistantProjectionEventKey(event);
      return key ? [key] : [];
    }),
  );
  const evictedAssistantMessage =
    runtimeEventDelta?.evicted.some((event) => {
      const key = assistantProjectionEventKey(event);
      return Boolean(key && !currentAssistantKeys.has(key));
    }) ?? false;
  const appendedAssistantEvents = new Map<string, ProviderRuntimeEvent>();
  for (const event of runtimeEventDelta?.appended ?? []) {
    const key = assistantProjectionEventKey(event);
    if (key && !appendedAssistantEvents.has(key)) {
      appendedAssistantEvents.set(key, event);
    }
  }
  const introducesAssistantMessage = [...appendedAssistantEvents].some(([key, event]) => {
    return (
      !previousAssistantKeys.has(key) ||
      !projectionContainsAssistantDelta(previousProjection, event)
    );
  });
  const crossesSnapshotBoundary =
    [...(runtimeEventDelta?.appended ?? []), ...(runtimeEventDelta?.evicted ?? [])].some(
      (event) => event.type === 'content.delta' && event.isSnapshot === true,
    );
  if (
    !runtimeEventDelta ||
    !stableFallbacks ||
    runtimeEventDelta.appended.some((event) => event.type !== 'content.delta') ||
    runtimeEventDelta.evicted.some((event) => event.type !== 'content.delta') ||
    evictedAssistantMessage
  ) {
    return projectSession(session);
  }
  if (introducesAssistantMessage || crossesSnapshotBoundary) {
    return projectAssistantDeltaBoundary(session, previousProjection);
  }

  const messages = messagesForAssistantDelta(session, previousProjection, runtimeEventDelta.appended);
  if (!messages) {
    return projectAssistantDeltaBoundary(session, previousProjection);
  }
  const messagesUnchanged =
    messages.length === previousProjection.messages.length &&
    messages.every((message, index) => message === previousProjection.messages[index]);
  if (messagesUnchanged) {
    return previousProjection;
  }

  return {
    ...previousProjection,
    messages,
    timeline: timelineForAssistantDelta(previousProjection, messages),
  };
}

export function projectSession(session: AgentSession): SessionProjection {
  const events = session.runtimeEvents ?? [];
  const userAndSystemMessages = (session.messages ?? []).filter((message) => message.role !== 'assistant').map((message) => clone(message));
  const messages = [...userAndSystemMessages, ...projectedAssistantMessages(session, events)].sort((left, right) => left.ts.localeCompare(right.ts));

  const runtime = applyRuntimeEvents({
    sessionId: session.sessionId,
    events,
    fallbackActivities: session.runtimeActivities ?? [],
    fallbackRequests: session.runtimeRequests ?? [],
    fallbackUserInputRequests: session.runtimeUserInputRequests ?? [],
    fallbackPlans: session.runtimePlans ?? [],
  });
  const turnDiffs = projectedTurnDiffs(events);
  const activePlan = runtime.plans.at(-1);
  const timeline = buildTimeline({
    events,
    messages,
    activities: runtime.activities,
    requests: runtime.requests,
    userInputRequests: runtime.userInputRequests,
    plans: runtime.plans,
    turnDiffs,
  });

  return {
    sessionId: session.sessionId,
    messages,
    activities: runtime.activities,
    openRequests: runtime.requests.filter((request) => request.status === 'open'),
    userInputRequests: runtime.userInputRequests.filter((request) => request.status === 'open'),
    staleRequests: runtime.requests.filter((request) => request.status === 'stale'),
    staleUserInputRequests: runtime.userInputRequests.filter((request) => request.status === 'stale'),
    plans: runtime.plans,
    activePlan,
    turnDiffs,
    timeline,
    status: statusFromEvents(events, session.status),
    runtimeSettings: session.runtimeSettings,
    effectiveRuntimeConfig: session.effectiveRuntimeConfig,
  };
}
