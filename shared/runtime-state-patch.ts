const runtimeEventLimit = 2000;
const streamChunkLimit = 1000;

type RuntimeRecord = Record<string, any>;

function laterTimestamp(current: unknown, candidate: unknown) {
  if (typeof candidate !== 'string') {
    return current;
  }
  if (typeof current !== 'string') {
    return candidate;
  }
  const currentAt = Date.parse(current);
  const candidateAt = Date.parse(candidate);
  if (Number.isNaN(currentAt)) {
    return candidate;
  }
  if (Number.isNaN(candidateAt) || candidateAt < currentAt) {
    return current;
  }
  return candidate;
}

export function preferRuntimeSnapshot(current: RuntimeRecord, incoming: RuntimeRecord) {
  const currentVersion = Number(current?.controlVersion ?? 0);
  const incomingVersion = Number(incoming?.controlVersion ?? 0);
  if (incomingVersion !== currentVersion) {
    return incomingVersion > currentVersion ? incoming : current;
  }
  const currentAt = Date.parse(String(current?.updatedAt ?? ''));
  const incomingAt = Date.parse(String(incoming?.updatedAt ?? ''));
  if (!Number.isNaN(currentAt) && !Number.isNaN(incomingAt) && incomingAt < currentAt) {
    return current;
  }
  return incoming;
}

export function applyNodePositionUpdates(
  state: RuntimeRecord,
  updates: Array<{
    nodeId: string;
    position: { x: number; y: number };
  }>,
  updatedAt?: string,
) {
  const nextUpdatedAt = laterTimestamp(state.updatedAt, updatedAt);
  if (updates.length === 0) {
    return nextUpdatedAt === state.updatedAt
      ? state
      : { ...state, updatedAt: nextUpdatedAt };
  }

  const updateById = new Map(updates.map((update) => [update.nodeId, update]));
  let changed = false;
  const nextNodes = (state.nodes ?? []).map((node: RuntimeRecord) => {
    const update = updateById.get(node.nodeId);
    if (
      !update ||
      (node.position.x === update.position.x &&
        node.position.y === update.position.y)
    ) {
      return node;
    }

    changed = true;
    return {
      ...node,
      position: {
        x: update.position.x,
        y: update.position.y,
      },
    };
  });

  if (!changed && nextUpdatedAt === state.updatedAt) {
    return state;
  }
  return {
    ...state,
    updatedAt: nextUpdatedAt,
    nodes: changed ? nextNodes : state.nodes,
  };
}

function trimTail(items: any[], limit: number) {
  return items.length > limit ? items.slice(items.length - limit) : items;
}

function assistantMessageKey(event: RuntimeRecord) {
  return event.itemId ?? event.turnId ?? 'unknown-turn';
}

function messageMatchesEvent(message: RuntimeRecord, event: RuntimeRecord) {
  if (message.role !== 'assistant') {
    return false;
  }
  if (event.itemId && message.providerItemId) {
    return message.providerItemId === event.itemId;
  }
  return Boolean(event.turnId && message.runId === event.turnId);
}

function applyAssistantEvent(session: RuntimeRecord, event: RuntimeRecord, previousEvents: RuntimeRecord[]) {
  if (event.type !== 'content.delta' || event.streamKind !== 'assistant_text' || typeof event.text !== 'string') {
    if (event.type !== 'message.completed' || event.message?.role !== 'assistant') {
      return session.messages ?? [];
    }

    const completed = event.message;
    const messages = [...(session.messages ?? [])];
    const index = messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        ((completed.providerItemId && message.providerItemId === completed.providerItemId) || (completed.runId && message.runId === completed.runId)),
    );
    if (index >= 0) {
      messages[index] = { ...messages[index], ...completed, status: 'complete' };
    } else {
      messages.push({ ...completed, status: 'complete' });
    }
    return messages;
  }

  const key = assistantMessageKey(event);
  const previousDeltaExists = previousEvents.some(
    (candidate) =>
      candidate.type === 'content.delta' &&
      candidate.streamKind === 'assistant_text' &&
      candidate.isSnapshot !== true &&
      assistantMessageKey(candidate) === key,
  );
  const messages = [...(session.messages ?? [])];
  const index = messages.findIndex((message) => messageMatchesEvent(message, event));
  const existing =
    index >= 0
      ? messages[index]
      : {
          id: `${session.sessionId}:${key}:assistant`,
          sessionId: session.sessionId,
          role: 'assistant',
          content: '',
          ts: event.ts,
          runId: event.turnId ?? key,
          providerItemId: event.itemId,
          status: 'streaming',
        };

  if (event.isSnapshot && previousDeltaExists) {
    return messages;
  }

  const content = event.isSnapshot ? event.text : `${existing.content ?? ''}${event.text}`;
  const next = {
    ...existing,
    content,
    ts: event.ts,
    providerItemId: existing.providerItemId ?? event.itemId,
    status: 'streaming',
  };
  if (index >= 0) {
    messages[index] = next;
  } else {
    messages.push(next);
  }
  return messages;
}

function patchNodeStatus(nodes: RuntimeRecord[], sessionId: string, status: string | undefined) {
  if (!status) {
    return nodes;
  }
  let changed = false;
  const next = nodes.map((node) => {
    if (node.sessionId !== sessionId || node.status === status) {
      return node;
    }
    changed = true;
    return { ...node, status };
  });
  return changed ? next : nodes;
}

export function applyProviderRuntimeEventToState(state: RuntimeRecord, sessionId: string, providerEvent: RuntimeRecord) {
  const session = state.sessions?.[sessionId];
  if (!session || !providerEvent) {
    return state;
  }

  const previousEvents = session.runtimeEvents ?? [];
  if (previousEvents.at(-1)?.id === providerEvent.id) {
    return state;
  }

  const runtimeEvents = trimTail([...previousEvents, providerEvent], runtimeEventLimit);
  const retainedPreviousEvents = runtimeEvents.slice(0, -1);
  const messages = applyAssistantEvent(session, providerEvent, retainedPreviousEvents);
  const status = providerEvent.type === 'session.state' ? providerEvent.status : session.status;
  const effectiveRuntimeConfig = providerEvent.type === 'runtime.configured' ? providerEvent.effectiveRuntimeConfig : session.effectiveRuntimeConfig;
  const nextSession = {
    ...session,
    runtimeEvents,
    messages,
    status,
    updatedAt: laterTimestamp(session.updatedAt, providerEvent.ts),
    effectiveRuntimeConfig,
  };

  return {
    ...state,
    updatedAt: laterTimestamp(state.updatedAt, providerEvent.ts),
    nodes: patchNodeStatus(state.nodes ?? [], sessionId, status),
    sessions: {
      ...state.sessions,
      [sessionId]: nextSession,
    },
  };
}

export function applyLightweightRuntimeEvent(state: RuntimeRecord, event: RuntimeRecord) {
  if (event.type === 'provider.runtime') {
    return applyProviderRuntimeEventToState(state, event.sessionId, event.providerEvent);
  }

  if (event.type !== 'session.stream') {
    return state;
  }

  let next = state;
  for (const providerEvent of event.providerEvents ?? []) {
    next = applyProviderRuntimeEventToState(next, event.sessionId, providerEvent);
  }
  const session = next.sessions?.[event.sessionId];
  if (!session || !event.chunk) {
    return next;
  }
  const chunks = trimTail([...(session.chunks ?? []), event.chunk], streamChunkLimit);
  return {
    ...next,
    updatedAt: laterTimestamp(next.updatedAt, event.chunk.ts),
    sessions: {
      ...next.sessions,
      [event.sessionId]: {
        ...session,
        chunks,
        updatedAt: laterTimestamp(session.updatedAt, event.chunk.ts),
      },
    },
  };
}

function appendOnlyAssistantDelta(event: RuntimeRecord) {
  if (
    event.type !== 'provider.runtime' ||
    event.providerEvent?.type !== 'content.delta' ||
    event.providerEvent.streamKind !== 'assistant_text' ||
    typeof event.providerEvent.text !== 'string' ||
    event.providerEvent.isSnapshot === true ||
    (!event.providerEvent.itemId && !event.providerEvent.turnId)
  ) {
    return undefined;
  }
  return {
    sessionId: event.sessionId,
    key: assistantMessageKey(event.providerEvent),
    providerEvent: event.providerEvent,
  };
}

function applyAssistantDeltaBatchToState(
  state: RuntimeRecord,
  sessionId: string,
  providerEvents: RuntimeRecord[],
) {
  const session = state.sessions?.[sessionId];
  if (!session || providerEvents.length === 0) {
    return state;
  }

  const previousEvents = session.runtimeEvents ?? [];
  const acceptedEvents: RuntimeRecord[] = [];
  let lastEventId = previousEvents.at(-1)?.id;
  for (const providerEvent of providerEvents) {
    if (lastEventId === providerEvent.id) {
      continue;
    }
    acceptedEvents.push(providerEvent);
    lastEventId = providerEvent.id;
  }
  if (acceptedEvents.length === 0) {
    return state;
  }

  const firstEvent = acceptedEvents[0]!;
  const lastEvent = acceptedEvents.at(-1)!;
  const runtimeEvents = trimTail([...previousEvents, ...acceptedEvents], runtimeEventLimit);
  const messages = [...(session.messages ?? [])];
  const index = messages.findIndex((message) => messageMatchesEvent(message, firstEvent));
  const key = assistantMessageKey(firstEvent);
  const existing =
    index >= 0
      ? messages[index]
      : {
          id: `${session.sessionId}:${key}:assistant`,
          sessionId: session.sessionId,
          role: 'assistant',
          content: '',
          ts: firstEvent.ts,
          runId: firstEvent.turnId ?? key,
          providerItemId: firstEvent.itemId,
          status: 'streaming',
        };
  const nextMessage = {
    ...existing,
    content: `${existing.content ?? ''}${acceptedEvents.map((event) => event.text).join('')}`,
    ts: lastEvent.ts,
    providerItemId: existing.providerItemId ?? firstEvent.itemId,
    status: 'streaming',
  };
  if (index >= 0) {
    messages[index] = nextMessage;
  } else {
    messages.push(nextMessage);
  }

  const nextSession = {
    ...session,
    runtimeEvents,
    messages,
    status: session.status,
    updatedAt: laterTimestamp(session.updatedAt, lastEvent.ts),
    effectiveRuntimeConfig: session.effectiveRuntimeConfig,
  };
  return {
    ...state,
    updatedAt: laterTimestamp(state.updatedAt, lastEvent.ts),
    sessions: {
      ...state.sessions,
      [sessionId]: nextSession,
    },
  };
}

export function applyLightweightRuntimeEvents(state: RuntimeRecord, events: RuntimeRecord[]) {
  const expandedEvents = events.flatMap((event) => {
    if (event.type !== 'session.stream') {
      return [event];
    }
    const providerEvents = (event.providerEvents ?? []).map((providerEvent: RuntimeRecord) => ({
      type: 'provider.runtime',
      sessionId: event.sessionId,
      providerEvent,
    }));
    return event.chunk
      ? [
          ...providerEvents,
          {
            type: 'session.stream',
            sessionId: event.sessionId,
            chunk: event.chunk,
          },
        ]
      : providerEvents;
  });
  let next = state;
  let index = 0;
  while (index < expandedEvents.length) {
    const first = appendOnlyAssistantDelta(expandedEvents[index]);
    if (!first) {
      next = applyLightweightRuntimeEvent(next, expandedEvents[index]);
      index += 1;
      continue;
    }

    const providerEvents = [first.providerEvent];
    let nextIndex = index + 1;
    while (nextIndex < expandedEvents.length) {
      const candidate = appendOnlyAssistantDelta(expandedEvents[nextIndex]);
      if (
        !candidate ||
        candidate.sessionId !== first.sessionId ||
        candidate.key !== first.key
      ) {
        break;
      }
      providerEvents.push(candidate.providerEvent);
      nextIndex += 1;
    }
    next = applyAssistantDeltaBatchToState(next, first.sessionId, providerEvents);
    index = nextIndex;
  }
  return next;
}

function providerEventsFromLightweightEvent(event: RuntimeRecord): RuntimeRecord[] {
  if (event.type === 'provider.runtime') {
    return event.providerEvent ? [event.providerEvent] : [];
  }
  if (event.type === 'session.stream') {
    return event.providerEvents ?? [];
  }
  return [];
}

const sessionIsolatedProviderEventTypes = new Set([
  'content.delta',
  'item.started',
  'item.updated',
  'item.completed',
  'turn.started',
  'turn.completed',
  'turn.diff.updated',
]);

/**
 * Most provider events only change one Session's transcript. Keeping those
 * updates out of App's root state prevents a token stream from invalidating
 * the sidebar, graph, and workflow surfaces. Events that affect controls or
 * cross-session summaries still request a root render.
 */
export function lightweightRuntimeEventsRequireRootRender(events: RuntimeRecord[]) {
  return events.some((event) =>
    providerEventsFromLightweightEvent(event).some(
      (providerEvent) => !sessionIsolatedProviderEventTypes.has(providerEvent.type),
    ),
  );
}
