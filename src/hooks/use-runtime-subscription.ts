import { type Dispatch, type SetStateAction, useEffect } from 'react';

import type { GraphState, KernelEvent, RuntimeTerminal } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import {
  applyLightweightRuntimeEvent,
  applyNodePositionUpdates,
  preferRuntimeSnapshot,
} from '../../shared/runtime-state-patch';

const streamRenderBatchMs = 50;

export function useRuntimeSubscription({
  runtimeApi,
  setRuntimeState,
  applyRuntimeStreamEvents,
  setSelectedSessionId,
  setRuntimeError,
  syncTerminalFromEvent,
  restoreCwdFallback,
  ingestKernelEvents,
}: {
  runtimeApi: RuntimeApi | undefined;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  applyRuntimeStreamEvents: (events: Parameters<typeof applyLightweightRuntimeEvent>[1][]) => void;
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
    let streamBatchTimer: number | undefined;
    let pendingStreamEvents: Parameters<typeof applyLightweightRuntimeEvent>[1][] = [];

    const discardPendingStreamEvents = () => {
      pendingStreamEvents = [];
      if (streamBatchTimer !== undefined) {
        window.clearTimeout(streamBatchTimer);
        streamBatchTimer = undefined;
      }
    };

    const flushPendingStreamEvents = () => {
      streamBatchTimer = undefined;
      const events = pendingStreamEvents;
      pendingStreamEvents = [];
      if (events.length === 0) {
        return;
      }
      applyRuntimeStreamEvents(events);
    };

    const enqueueStreamEvent = (event: Parameters<typeof applyLightweightRuntimeEvent>[1]) => {
      pendingStreamEvents.push(event);
      streamBatchTimer ??= window.setTimeout(flushPendingStreamEvents, streamRenderBatchMs);
    };
    runtimeApi
      .getState()
      .then((state) => {
        if (isMounted) {
          setRuntimeState((current) => preferRuntimeSnapshot(current, state) as GraphState);
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
        // A boundary snapshot already contains every earlier delta. Dropping
        // the queued patches preserves event order without replaying them.
        discardPendingStreamEvents();
        setRuntimeState((current) => preferRuntimeSnapshot(current, event.state) as GraphState);
      } else if (event.type === 'provider.runtime' || event.type === 'session.stream') {
        enqueueStreamEvent(event);
      } else if (event.type === 'node.positions.updated') {
        setRuntimeState((current) =>
          applyNodePositionUpdates(
            current,
            event.positions,
            event.updatedAt,
          ) as GraphState
        );
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
      discardPendingStreamEvents();
      unsubscribe();
    };
  }, [
    applyRuntimeStreamEvents,
    ingestKernelEvents,
    restoreCwdFallback,
    runtimeApi,
    setRuntimeError,
    setRuntimeState,
    setSelectedSessionId,
    syncTerminalFromEvent,
  ]);
}
