import { type Dispatch, type SetStateAction, useEffect } from 'react';

import type { GraphState, RuntimeTerminal } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

export function useRuntimeSubscription({
  runtimeApi,
  setRuntimeState,
  setSelectedSessionId,
  setRuntimeError,
  syncTerminalFromEvent,
  restoreCwdFallback,
}: {
  runtimeApi: RuntimeApi | undefined;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null | undefined>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  syncTerminalFromEvent: (terminal: RuntimeTerminal) => void;
  restoreCwdFallback: (state: GraphState) => void;
}) {
  useEffect(() => {
    if (!runtimeApi) {
      return;
    }

    let isMounted = true;
    runtimeApi
      .getState()
      .then((state) => {
        if (isMounted) {
          setRuntimeState(state);
          setSelectedSessionId((current) => (current === undefined ? null : current));
          restoreCwdFallback(state);
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error));
        }
      });

    const unsubscribe = runtimeApi.onEvent((event) => {
      if ('state' in event) {
        setRuntimeState(event.state);
      }
      if ('terminal' in event) {
        syncTerminalFromEvent(event.terminal);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [restoreCwdFallback, runtimeApi, setRuntimeError, setRuntimeState, setSelectedSessionId, syncTerminalFromEvent]);
}
