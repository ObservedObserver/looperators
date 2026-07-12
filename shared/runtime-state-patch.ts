const runtimeEventLimit = 2000;
const streamChunkLimit = 1000;

type RuntimeRecord = Record<string, any>;

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
  const messages = applyAssistantEvent(session, providerEvent, previousEvents);
  const status = providerEvent.type === 'session.state' ? providerEvent.status : session.status;
  const effectiveRuntimeConfig = providerEvent.type === 'runtime.configured' ? providerEvent.effectiveRuntimeConfig : session.effectiveRuntimeConfig;
  const nextSession = {
    ...session,
    runtimeEvents,
    messages,
    status,
    updatedAt: providerEvent.ts ?? session.updatedAt,
    effectiveRuntimeConfig,
  };

  return {
    ...state,
    updatedAt: providerEvent.ts ?? state.updatedAt,
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
    updatedAt: event.chunk.ts ?? next.updatedAt,
    sessions: {
      ...next.sessions,
      [event.sessionId]: {
        ...session,
        chunks,
        updatedAt: event.chunk.ts ?? session.updatedAt,
      },
    },
  };
}
