import { startTransition, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

import type { AgentSession } from '@/shared/graph-state';
import type { SessionProjection } from '@/shared/provider-runtime';
import type { RuntimeStateStore } from '@shared/runtime-state-store';

export type RuntimeSessionView = {
  session: AgentSession;
  projection?: SessionProjection;
};

function useTransitionedRuntimeSessionView(
  runtimeStateStore: RuntimeStateStore,
  sessionId: string | null | undefined,
) {
  const [, scheduleRender] = useReducer((revision: number) => revision + 1, 0);
  const renderedSessionRef = useRef<AgentSession | undefined>(undefined);
  const view = sessionId
    ? (runtimeStateStore.getSessionView(sessionId) as RuntimeSessionView | undefined)
    : undefined;
  useLayoutEffect(() => {
    renderedSessionRef.current = view?.session;
  }, [view?.session]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const enqueueRender = () => {
      startTransition(() => {
        scheduleRender();
      });
    };
    const unsubscribe = runtimeStateStore.subscribeSession(sessionId, enqueueRender);

    // Close the render-to-subscribe race without turning every stream update
    // into useSyncExternalStore's non-interruptible SyncLane.
    const currentSession = runtimeStateStore.getState().sessions?.[sessionId];
    if (currentSession !== renderedSessionRef.current) {
      enqueueRender();
    }

    return unsubscribe;
  }, [runtimeStateStore, sessionId]);

  return view;
}

export function useRuntimeSessionView(
  runtimeStateStore: RuntimeStateStore,
  sessionId: string | null | undefined,
) {
  return useTransitionedRuntimeSessionView(runtimeStateStore, sessionId);
}

export function useRuntimeSessionProjection(
  runtimeStateStore: RuntimeStateStore,
  sessionId: string | null | undefined,
) {
  return useTransitionedRuntimeSessionView(runtimeStateStore, sessionId)?.projection;
}
