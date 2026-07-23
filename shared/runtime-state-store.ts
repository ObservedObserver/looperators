import {
  applyLightweightRuntimeEvents,
  lightweightRuntimeEventsRequireRootRender,
  preferRuntimeSnapshot,
} from './runtime-state-patch.js';

type RuntimeRecord = Record<string, any>;
type SessionProjectionFactory = (
  session: any,
  previousSession: any,
  previousProjection: any,
) => any;

type SessionView = {
  session: RuntimeRecord;
  projection?: RuntimeRecord;
};

export function createRuntimeStateStore<State extends RuntimeRecord>(
  initialState: State,
  options: {
    projectSession?: SessionProjectionFactory;
  } = {},
) {
  let state = initialState;
  const sessionListeners = new Map<string, Set<() => void>>();
  const sessionViews = new Map<
    string,
    {
      session: RuntimeRecord;
      projection?: RuntimeRecord;
      view: SessionView;
    }
  >();

  const notifyChangedSessions = (previous: State, next: State) => {
    for (const [sessionId, listeners] of sessionListeners) {
      if (previous.sessions?.[sessionId] === next.sessions?.[sessionId]) {
        continue;
      }
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const replaceState = (next: State, preserveSessionViews: boolean) => {
    if (next === state) {
      return state;
    }
    const previous = state;
    state = next;
    if (!preserveSessionViews) {
      for (const sessionId of sessionViews.keys()) {
        if (previous.sessions?.[sessionId] !== next.sessions?.[sessionId]) {
          sessionViews.delete(sessionId);
        }
      }
    }
    notifyChangedSessions(previous, next);
    return state;
  };

  return {
    getState() {
      return state;
    },

    setState(update: State | ((current: State) => State)) {
      const incoming = typeof update === 'function' ? update(state) : update;
      return replaceState(preferRuntimeSnapshot(state, incoming) as State, false);
    },

    applyStreamEvents(events: RuntimeRecord[]) {
      const next = applyLightweightRuntimeEvents(state, events) as State;
      return {
        state: replaceState(next, true),
        requiresRootRender: lightweightRuntimeEventsRequireRootRender(events),
      };
    },

    subscribeSession(sessionId: string, listener: () => void) {
      const listeners = sessionListeners.get(sessionId) ?? new Set<() => void>();
      listeners.add(listener);
      sessionListeners.set(sessionId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          sessionListeners.delete(sessionId);
          sessionViews.delete(sessionId);
        }
      };
    },

    getSessionView(sessionId: string): SessionView | undefined {
      const session = state.sessions?.[sessionId];
      if (!session) {
        sessionViews.delete(sessionId);
        return undefined;
      }

      const previous = sessionViews.get(sessionId);
      if (previous && previous.session === session) {
        return previous.view;
      }

      const projection = options.projectSession?.(
        session,
        previous?.session,
        previous?.projection,
      );
      const view = { session, projection };
      sessionViews.set(sessionId, { session, projection, view });
      return view;
    },
  };
}

export type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;
export type RuntimeSessionView = ReturnType<RuntimeStateStore['getSessionView']>;
