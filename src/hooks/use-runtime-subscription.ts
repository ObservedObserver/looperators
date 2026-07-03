import { type Dispatch, type SetStateAction, useEffect } from 'react';

import type { GraphState, KernelEvent, RuntimeTerminal } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

export function useRuntimeSubscription({
  runtimeApi,
  setRuntimeState,
  setSelectedSessionId,
  setRuntimeError,
  syncTerminalFromEvent,
  restoreCwdFallback,
  ingestKernelEvents,
}: {
  runtimeApi: RuntimeApi | undefined;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null | undefined>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  syncTerminalFromEvent: (terminal: RuntimeTerminal) => void;
  restoreCwdFallback: (state: GraphState) => void;
  ingestKernelEvents?: (events: KernelEvent[]) => void;
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

    if (ingestKernelEvents) {
      runtimeApi
        .getKernelEvents({ limit: 250, tail: true })
        .then((result) => {
          if (isMounted) {
            ingestKernelEvents(result.events);
          }
        })
        .catch(() => {
          // The timeline is progressive enhancement; live events still land.
        });
    }

    const unsubscribe = runtimeApi.onEvent((event) => {
      if ('state' in event) {
        setRuntimeState(event.state);
      }
      if ('terminal' in event) {
        syncTerminalFromEvent(event.terminal);
      }
      if (event.type === 'kernel.event' && ingestKernelEvents) {
        ingestKernelEvents([event.event]);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [ingestKernelEvents, restoreCwdFallback, runtimeApi, setRuntimeError, setRuntimeState, setSelectedSessionId, syncTerminalFromEvent]);
}
