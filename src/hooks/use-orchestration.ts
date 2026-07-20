import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useState } from 'react';

import type { AgentSession, GraphState } from '@/shared/graph-state';
import type { ProviderInstance, ProviderKind, ProviderReasoningEffort, ProviderRuntimeMode } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { loopLastEvent, loopStateStatus } from '@/lib/graph-view';
import { validateProjectCwd } from '@/lib/workspace';
import { providerOption, providerRuntimeSettingsDraft } from '@/lib/provider-catalog';
import type { WorkflowStepStatus } from '@/components/workflow';

export function useOrchestration({
  runtimeApi,
  runtimeUnavailableText,
  runtimeState,
  setRuntimeState,
  setRuntimeError,
  selectedSession,
  selectedSessionId,
  setSelectedSessionId,
  selectedSessionFrozen,
  selectedCanvasNodeIds,
  activeClusterId,
  setActiveClusterId,
  setPendingLinkedSourceId,
  newChat,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeUnavailableText: string;
  runtimeState: GraphState;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  selectedSession: AgentSession | undefined;
  selectedSessionId: string | null | undefined;
  setSelectedSessionId: Dispatch<SetStateAction<string | null | undefined>>;
  selectedSessionFrozen: boolean;
  selectedCanvasNodeIds: string[];
  activeClusterId: string | undefined;
  setActiveClusterId: Dispatch<SetStateAction<string | undefined>>;
  setPendingLinkedSourceId: Dispatch<SetStateAction<string | null>>;
  newChat: {
    newCwd: string;
    newProviderKind: ProviderKind;
    newRuntimeMode: ProviderRuntimeMode;
    newModel: string;
    newReasoningEffort: ProviderReasoningEffort;
    newProviderInstance: ProviderInstance;
  };
}) {
  const { newCwd, newProviderKind, newRuntimeMode, newModel, newReasoningEffort, newProviderInstance } = newChat;

  const [clusterLabel, setClusterLabel] = useState('Review loop');
  const [maxIterations, setMaxIterations] = useState('6');
  const [masterPrompt, setMasterPrompt] = useState(
    'You are the Orrery Master for this project Scope. Translate workflow requests into reviewable Workflow Proposals with inspect_scope and propose_workflow; govern active workflows through inspect_workflow_wakeups and propose_workflow_patch, or acknowledge when no patch is needed. Explain Graph Diff, impact, rollback, and safety policy, wait for human approval, then commit exactly once. Never bypass Proposal/Commit with raw graph mutations or forward ordinary turns yourself.',
  );
  const [isUpdatingCluster, setIsUpdatingCluster] = useState(false);
  const [isCreatingMaster, setIsCreatingMaster] = useState(false);
  const [isStartingLoop, setIsStartingLoop] = useState(false);
  const [isStoppingLoop, setIsStoppingLoop] = useState(false);
  const [isFreezingSelected, setIsFreezingSelected] = useState(false);
  const [isFreezingCluster, setIsFreezingCluster] = useState(false);

  const selectedManagedNodeIds = useMemo(() => {
    const canvasSelection = selectedCanvasNodeIds.filter((nodeId) => {
      const session = runtimeState.sessions[nodeId];
      return session && session.role !== 'master';
    });

    if (canvasSelection.length > 0) {
      return canvasSelection;
    }

    if (selectedSession && selectedSession.role !== 'master') {
      return [selectedSession.sessionId];
    }

    return [];
  }, [runtimeState.sessions, selectedCanvasNodeIds, selectedSession]);
  const clusters = Object.values(runtimeState.clusters).sort((left, right) => left.label.localeCompare(right.label));
  const activeCluster = activeClusterId ? runtimeState.clusters[activeClusterId] : undefined;
  const selectedSessionCluster = selectedSessionId
    ? Object.values(runtimeState.clusters).find((cluster) => cluster.nodeIds.includes(selectedSessionId))
    : undefined;
  // Cluster freeze also projects frozen=true onto every member node, so the
  // node bit cannot distinguish direct from inherited freeze. A frozen owner
  // cluster must always be lifted as the authoritative target.
  const selectedSessionInheritedFreeze = selectedSessionCluster?.frozen === true;
  const workflowManagedNodeIds = useMemo(() => {
    if (selectedManagedNodeIds.length > 0 && selectedCanvasNodeIds.length > 0) {
      return selectedManagedNodeIds;
    }

    if (activeCluster?.nodeIds.length) {
      return activeCluster.nodeIds;
    }

    return selectedManagedNodeIds;
  }, [activeCluster, selectedCanvasNodeIds.length, selectedManagedNodeIds]);
  const activeManagedSessions = useMemo(
    () => activeCluster?.nodeIds.map((sessionId) => runtimeState.sessions[sessionId]).filter((session): session is AgentSession => Boolean(session)) ?? [],
    [activeCluster, runtimeState.sessions],
  );
  const activeMasterSession = activeCluster?.masterSessionId ? runtimeState.sessions[activeCluster.masterSessionId] : undefined;
  const activeLoopStatus = loopStateStatus(activeCluster);
  const activeLoopIterations = activeCluster?.loopState?.iterations ?? 0;
  const activeLoopMaxIterations = activeCluster?.loopPolicy?.maxIterations ?? 6;
  const activeLoopReason = activeCluster?.loopState?.reason;
  const activeLoopLastEvent = loopLastEvent(activeCluster, runtimeState);
  const activeLoopCoder = activeCluster?.loopState?.coderSessionId ? runtimeState.sessions[activeCluster.loopState.coderSessionId] : activeManagedSessions[0];
  const activeLoopReviewer = activeCluster?.loopState?.reviewerSessionId
    ? runtimeState.sessions[activeCluster.loopState.reviewerSessionId]
    : activeManagedSessions.find((session) => session.sessionId !== activeLoopCoder?.sessionId);
  const canStartLoop =
    Boolean(activeCluster) &&
    Boolean(activeCluster?.masterSessionId) &&
    Boolean(activeCluster?.loopPolicy) &&
    activeLoopStatus !== 'running' &&
    activeCluster?.frozen !== true;
  const canStopLoop = Boolean(activeCluster) && activeLoopStatus === 'running';
  const canFreezeSelectedSession = Boolean(selectedSession) && !selectedSessionFrozen;
  const canFreezeActiveCluster = Boolean(activeCluster) && activeCluster?.frozen !== true;
  const hasWorkerSelection = workflowManagedNodeIds.length > 0;
  const setupSteps = [
    {
      title: 'Select worker chats',
      detail: hasWorkerSelection
        ? `${workflowManagedNodeIds.length} worker ${workflowManagedNodeIds.length === 1 ? 'chat' : 'chats'} selected`
        : 'Use the canvas selection or current worker chat',
      status: hasWorkerSelection ? 'done' : 'active',
    },
    {
      title: 'Save cluster',
      detail: activeCluster ? activeCluster.label : hasWorkerSelection ? 'Ready to save' : 'Waiting for worker selection',
      status: activeCluster ? 'done' : hasWorkerSelection ? 'active' : 'blocked',
    },
    {
      title: 'Create or open master',
      detail: activeMasterSession?.label ?? 'Master is a normal chat session',
      status: activeMasterSession ? 'done' : activeCluster ? 'active' : 'blocked',
    },
    {
      title: 'Run review loop',
      detail:
        activeLoopStatus === 'running'
          ? `${activeLoopIterations}/${activeLoopMaxIterations} iterations`
          : canStartLoop
            ? 'Ready to run'
            : 'Needs cluster, master, and policy',
      status: activeLoopStatus === 'running' ? 'active' : canStartLoop ? 'active' : activeCluster?.frozen ? 'done' : 'blocked',
    },
    {
      title: 'Freeze if needed',
      detail: activeCluster?.frozen ? (activeCluster.freezeReason ?? 'Cluster frozen') : 'Available for selected chat or active cluster',
      status: activeCluster?.frozen ? 'done' : activeCluster ? 'active' : 'blocked',
    },
  ] satisfies {
    title: string;
    detail: string;
    status: WorkflowStepStatus;
  }[];

  useEffect(() => {
    if (!activeCluster) {
      return;
    }

    setClusterLabel(activeCluster.label);
    setMaxIterations(String(activeCluster.loopPolicy?.maxIterations ?? 6));
  }, [activeCluster]);

  const currentLoopPolicy = useCallback(() => {
    const parsedMaxIterations = Number(maxIterations);
    return {
      until: { whenReport: { verdict: 'clean' } },
      onStop: 'freeze' as const,
      maxIterations: Number.isInteger(parsedMaxIterations) && parsedMaxIterations > 0 ? parsedMaxIterations : 6,
    };
  }, [maxIterations]);

  const upsertManagedCluster = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText);
      return;
    }

    if (workflowManagedNodeIds.length === 0) {
      setRuntimeError('Select at least one worker node for the cluster.');
      return;
    }

    setIsUpdatingCluster(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.upsertCluster({
        clusterId: activeClusterId,
        label: clusterLabel,
        nodeIds: workflowManagedNodeIds,
        loopPolicy: currentLoopPolicy(),
      });
      setRuntimeState(result.state);
      setActiveClusterId(result.clusterId);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUpdatingCluster(false);
    }
  }, [
    activeClusterId,
    clusterLabel,
    currentLoopPolicy,
    runtimeApi,
    runtimeUnavailableText,
    setActiveClusterId,
    setRuntimeError,
    setRuntimeState,
    workflowManagedNodeIds,
  ]);

  const saveLoopPolicy = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return;
    }

    setIsUpdatingCluster(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.setClusterLoopPolicy({
        clusterId: activeClusterId,
        loopPolicy: currentLoopPolicy(),
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUpdatingCluster(false);
    }
  }, [activeClusterId, currentLoopPolicy, runtimeApi, setRuntimeError, setRuntimeState]);

  const createMasterForCluster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return;
    }

    const cwd = newCwd.trim();
    const cwdValidation = validateProjectCwd(cwd);
    if (!cwdValidation.ok) {
      setRuntimeError(cwdValidation.message);
      return;
    }

    setIsCreatingMaster(true);
    setRuntimeError(undefined);

    try {
      const selectedProvider = providerOption(newProviderKind);
      const result = await runtimeApi.createMasterForCluster({
        clusterId: activeClusterId,
        prompt: masterPrompt,
        cwd,
        agent: selectedProvider.agent,
        providerKind: selectedProvider.id,
        providerInstanceId: newProviderInstance.providerInstanceId,
        runtimeSettings: providerRuntimeSettingsDraft({
          runtimeMode: newRuntimeMode,
          model: newModel,
          reasoningEffort: newReasoningEffort,
        }),
        label: `${runtimeState.clusters[activeClusterId]?.label ?? 'Cluster'} Master`,
        loopPolicy: currentLoopPolicy(),
      });
      setRuntimeState(result.state);
      setPendingLinkedSourceId(null);
      setSelectedSessionId(result.sessionId);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreatingMaster(false);
    }
  }, [
    activeClusterId,
    currentLoopPolicy,
    masterPrompt,
    newCwd,
    newModel,
    newProviderInstance.providerInstanceId,
    newProviderKind,
    newReasoningEffort,
    newRuntimeMode,
    runtimeApi,
    runtimeState.clusters,
    setPendingLinkedSourceId,
    setRuntimeError,
    setRuntimeState,
    setSelectedSessionId,
  ]);

  const assignSelectedAsMaster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId || !selectedSessionId) {
      return;
    }

    setIsCreatingMaster(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.assignMasterToCluster({
        clusterId: activeClusterId,
        sessionId: selectedSessionId,
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreatingMaster(false);
    }
  }, [activeClusterId, runtimeApi, selectedSessionId, setRuntimeError, setRuntimeState]);

  const startMasterLoop = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return;
    }

    setIsStartingLoop(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.startMasterLoop({
        clusterId: activeClusterId,
        reason: 'Loop started from looperators controls.',
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStartingLoop(false);
    }
  }, [activeClusterId, runtimeApi, setRuntimeError, setRuntimeState]);

  const stopMasterLoop = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return;
    }

    setIsStoppingLoop(true);
    setRuntimeError(undefined);

    try {
      const result = await runtimeApi.stopMasterLoop({
        clusterId: activeClusterId,
        reason: 'Loop killed from looperators controls.',
        killRunning: true,
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStoppingLoop(false);
    }
  }, [activeClusterId, runtimeApi, setRuntimeError, setRuntimeState]);

  const freezeSelectedSession = useCallback(async () => {
    if (!runtimeApi || !selectedSessionId || !selectedSession) {
      return;
    }

    setIsFreezingSelected(true);
    setRuntimeError(undefined);

    try {
      const reason = `Frozen from Workflows panel: ${selectedSession.label}`;
      const source = activeMasterSession?.sessionId && activeMasterSession.sessionId !== selectedSessionId ? activeMasterSession.sessionId : undefined;
      const result = await runtimeApi.freeze({
        target: selectedSessionId,
        reason,
        source,
        masterReason: source ? reason : undefined,
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFreezingSelected(false);
    }
  }, [activeMasterSession, runtimeApi, selectedSession, selectedSessionId, setRuntimeError, setRuntimeState]);

  const freezeActiveCluster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId || !activeCluster) {
      return;
    }

    setIsFreezingCluster(true);
    setRuntimeError(undefined);

    try {
      const reason = `Frozen from Workflows panel: ${activeCluster.label}`;
      const result = await runtimeApi.freeze({
        target: activeClusterId,
        reason,
        source: activeMasterSession?.sessionId,
        masterReason: activeMasterSession ? reason : undefined,
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFreezingCluster(false);
    }
  }, [activeCluster, activeClusterId, activeMasterSession, runtimeApi, setRuntimeError, setRuntimeState]);

  const unfreezeSelectedSession = useCallback(async () => {
    if (!runtimeApi || !selectedSessionId || !selectedSession) return;
    setIsFreezingSelected(true);
    setRuntimeError(undefined);
    try {
      const result = await runtimeApi.unfreeze({
        target: selectedSessionInheritedFreeze
          ? selectedSessionCluster?.clusterId
          : selectedSessionId,
        reason: selectedSessionInheritedFreeze
          ? `Unfrozen from Workflows panel through ${selectedSessionCluster?.label ?? 'its cluster'}`
          : `Unfrozen from Workflows panel: ${selectedSession.label}`,
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFreezingSelected(false);
    }
  }, [runtimeApi, selectedSession, selectedSessionCluster, selectedSessionId, selectedSessionInheritedFreeze, setRuntimeError, setRuntimeState]);

  const unfreezeActiveCluster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId || !activeCluster) return;
    setIsFreezingCluster(true);
    setRuntimeError(undefined);
    try {
      const result = await runtimeApi.unfreeze({
        target: activeClusterId,
        reason: `Unfrozen from Workflows panel: ${activeCluster.label}`,
      });
      setRuntimeState(result.state);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFreezingCluster(false);
    }
  }, [activeCluster, activeClusterId, runtimeApi, setRuntimeError, setRuntimeState]);

  return {
    clusterLabel,
    setClusterLabel,
    maxIterations,
    setMaxIterations,
    masterPrompt,
    setMasterPrompt,
    isUpdatingCluster,
    isCreatingMaster,
    isStartingLoop,
    isStoppingLoop,
    isFreezingSelected,
    isFreezingCluster,
    selectedManagedNodeIds,
    clusters,
    activeCluster,
    workflowManagedNodeIds,
    activeManagedSessions,
    activeMasterSession,
    activeLoopStatus,
    activeLoopIterations,
    activeLoopMaxIterations,
    activeLoopReason,
    activeLoopLastEvent,
    activeLoopCoder,
    activeLoopReviewer,
    canStartLoop,
    canStopLoop,
    canFreezeSelectedSession,
    selectedSessionInheritedFreeze,
    canFreezeActiveCluster,
    hasWorkerSelection,
    setupSteps,
    currentLoopPolicy,
    upsertManagedCluster,
    saveLoopPolicy,
    createMasterForCluster,
    assignSelectedAsMaster,
    startMasterLoop,
    stopMasterLoop,
    freezeSelectedSession,
    freezeActiveCluster,
    unfreezeSelectedSession,
    unfreezeActiveCluster,
  };
}

export type OrchestrationState = ReturnType<typeof useOrchestration>;
