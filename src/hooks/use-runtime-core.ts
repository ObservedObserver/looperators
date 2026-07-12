import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react';

import { createEmptyGraphState, type GraphState, type KernelEvent } from '@/shared/graph-state';
import { projectSession } from '@/shared/session-projection';
import { createDemoGraphState } from '@/shared/demo-state';
import { useRuntimeClient } from '@/runtime-client';
import { demoMode } from '@/lib/workspace';
import { invalidCwdsFromDiagnostics, sessionRecoveryState } from '@/lib/diagnostics';
import { sessionSort } from '@/lib/session-display';
import { activityEvents } from '@/lib/graph-view';
import { preferRuntimeSnapshot } from '../../shared/runtime-state-patch';

export function useRuntimeCore() {
  const [runtimeState, setRuntimeStateRaw] = useState<GraphState>(demoMode ? createDemoGraphState : createEmptyGraphState);
  const setRuntimeState = useCallback<Dispatch<SetStateAction<GraphState>>>((update) => {
    setRuntimeStateRaw((current) => {
      const incoming = typeof update === 'function'
        ? update(current)
        : update;
      return preferRuntimeSnapshot(current, incoming) as GraphState;
    });
  }, []);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null | undefined>(demoMode ? 'sess-p1-accept' : undefined);
  const [runtimeError, setRuntimeError] = useState<string>();
  const runtimeClient = useRuntimeClient({ disabled: demoMode });
  const runtimeApi = demoMode ? undefined : runtimeClient.runtime;
  const isRuntimeAvailable = Boolean(runtimeApi);
  const isElectron = !demoMode && runtimeClient.kind === 'electron';
  const runtimeHostPlatform = runtimeClient.kind === 'electron' || runtimeClient.kind === 'http' ? runtimeClient.platform : undefined;
  const runtimeModeLabel = demoMode
    ? 'demo'
    : runtimeClient.kind === 'electron'
      ? 'electron'
      : runtimeClient.kind === 'http'
        ? 'web runtime'
        : runtimeClient.kind === 'connecting'
          ? 'connecting'
          : 'no runtime';
  const runtimeStatusText =
    runtimeClient.kind === 'http'
      ? `Web runtime ${runtimeClient.runtimeUrl}`
      : runtimeClient.kind === 'electron'
        ? 'Electron runtime'
        : runtimeClient.kind === 'connecting'
          ? `Connecting to web runtime ${runtimeClient.runtimeUrl}`
          : runtimeClient.kind === 'unavailable' && runtimeClient.runtimeUrl
            ? `No runtime at ${runtimeClient.runtimeUrl}`
            : demoMode
              ? 'Demo graph'
              : 'No runtime client';
  const runtimeUnavailableText = demoMode
    ? 'Demo mode uses sample data. Remove ?demo=1 to connect to a runtime.'
    : runtimeClient.kind === 'unavailable' && runtimeClient.error
      ? runtimeClient.error
      : runtimeClient.kind === 'connecting'
        ? `Connecting to web runtime at ${runtimeClient.runtimeUrl}.`
        : 'Runtime is unavailable. Start the desktop app or the web runtime server.';

  const selectedSession = selectedSessionId ? runtimeState.sessions[selectedSessionId] : undefined;
  const selectedSessionProjection = useMemo(() => (selectedSession ? projectSession(selectedSession) : undefined), [selectedSession]);
  const selectedNode = selectedSessionId ? runtimeState.nodes.find((node) => node.sessionId === selectedSessionId) : undefined;
  const selectedManagedCluster = selectedSessionId
    ? Object.values(runtimeState.clusters).find((cluster) => cluster.nodeIds.includes(selectedSessionId))
    : undefined;
  const selectedSessionFrozen = selectedNode?.frozen === true || selectedManagedCluster?.frozen === true;
  const openRuntimeRequests = selectedSessionProjection?.openRequests ?? [];
  const openUserInputRequests = selectedSessionProjection?.userInputRequests ?? [];
  const sessions = Object.values(runtimeState.sessions).sort(sessionSort);
  const providerInstances = runtimeState.providerInstances ?? [];
  const runtimeDiagnostics = useMemo(() => runtimeState.diagnostics ?? [], [runtimeState.diagnostics]);
  const invalidProjectCwds = useMemo(() => invalidCwdsFromDiagnostics(runtimeDiagnostics), [runtimeDiagnostics]);
  const selectedRecoveryState =
    selectedSession !== undefined
      ? sessionRecoveryState({
          session: selectedSession,
          diagnostics: runtimeDiagnostics,
          frozen: selectedSessionFrozen,
        })
      : undefined;
  const reportsById = useMemo(() => new Map(runtimeState.reports.map((report) => [report.id, report])), [runtimeState.reports]);
  const graphActivity = useMemo(() => activityEvents(runtimeState), [runtimeState]);

  // Kernel event timeline (G4): the append-only log of graph-level facts,
  // seeded via HTTP/IPC and kept live by kernel.event broadcasts.
  const [kernelEvents, setKernelEvents] = useState<KernelEvent[]>([]);
  const ingestKernelEvents = useCallback((incoming: KernelEvent[]) => {
    if (incoming.length === 0) {
      return;
    }
    setKernelEvents((current) => {
      const byId = new Map(current.map((event) => [event.id, event]));
      let changed = false;
      for (const event of incoming) {
        if (!byId.has(event.id)) {
          byId.set(event.id, event);
          changed = true;
        }
      }
      if (!changed) {
        return current;
      }
      return [...byId.values()].sort((left, right) => left.seq - right.seq).slice(-250);
    });
  }, []);
  const selectedSessionIsMaster = selectedSession?.role === 'master';
  const canResume =
    Boolean(selectedSession) &&
    selectedSession?.status !== 'running' &&
    selectedSession?.status !== 'pending' &&
    selectedSession?.status !== 'killed' &&
    !selectedSessionFrozen;
  const canKill = selectedSession?.status === 'running' || selectedSession?.status === 'pending';
  const canActOnPlan = Boolean(isRuntimeAvailable && selectedSession && canResume);

  return {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    isElectron,
    runtimeHostPlatform,
    runtimeModeLabel,
    runtimeStatusText,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    runtimeError,
    setRuntimeError,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionProjection,
    selectedNode,
    selectedManagedCluster,
    selectedSessionFrozen,
    selectedSessionIsMaster,
    openRuntimeRequests,
    openUserInputRequests,
    sessions,
    providerInstances,
    runtimeDiagnostics,
    invalidProjectCwds,
    selectedRecoveryState,
    reportsById,
    graphActivity,
    kernelEvents,
    ingestKernelEvents,
    canResume,
    canKill,
    canActOnPlan,
  };
}

export type RuntimeCoreState = ReturnType<typeof useRuntimeCore>;
