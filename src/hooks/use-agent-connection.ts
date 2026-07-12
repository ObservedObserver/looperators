import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import type { ConnectAgentsInput, GraphState } from '@/shared/graph-state';
import type { ProviderKind, ProviderReasoningEffort, ProviderRuntimeMode } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { providerInstanceForKind } from '@/lib/provider-catalog';
import { validateAgentConnection, type AgentConnectionBehavior, type AgentConnectionTiming } from '@shared/agent-connection';
import { nextProviderKind } from '@shared/provider-metadata';

type NewTargetDraft = {
  kind: 'new';
  label: string;
  cwd: string;
  providerKind: ProviderKind;
  providerInstanceId: string;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
  runtimeMode: ProviderRuntimeMode;
  position: { x: number; y: number };
};

type ExistingTargetDraft = { kind: 'existing'; sessionId: string };

export type AgentConnectionDraft = {
  sourceSessionId: string;
  target: NewTargetDraft | ExistingTargetDraft;
  timing: AgentConnectionTiming;
  behavior: AgentConnectionBehavior;
  instruction: string;
  blockingMode: 'any-issue' | 'p0-p1' | 'custom';
  customCriteria: string;
  maxLaps: string;
};

function defaultTiming(state: GraphState, sourceSessionId: string): AgentConnectionTiming {
  const status = state.sessions[sourceSessionId]?.status;
  return status === 'running' || status === 'pending' ? 'next-completion' : 'current-result';
}

function reviewInstruction() {
  return 'Review the implementation against the requested behavior. Verify the actual workspace diff and run focused checks when useful.';
}

function payloadOf(draft: AgentConnectionDraft): ConnectAgentsInput {
  return {
    sourceSessionId: draft.sourceSessionId,
    target:
      draft.target.kind === 'existing'
        ? draft.target
        : {
            kind: 'new',
            label: draft.target.label,
            instruction: draft.instruction,
            cwd: draft.target.cwd,
            providerKind: draft.target.providerKind,
            providerInstanceId: draft.target.providerInstanceId,
            runtimeSettings: {
              runtimeMode: draft.target.runtimeMode,
              reasoningEffort: draft.target.reasoningEffort,
              ...(draft.target.model.trim() ? { model: draft.target.model.trim() } : {}),
            },
            position: draft.target.position,
          },
    timing: draft.timing,
    behavior: draft.behavior,
    instruction: draft.instruction,
    ...(draft.behavior === 'review-loop'
      ? {
          review: {
            blocking: {
              mode: draft.blockingMode,
              ...(draft.blockingMode === 'custom' ? { customCriteria: draft.customCriteria } : {}),
            },
            maxLaps: Number(draft.maxLaps),
          },
        }
      : {}),
  };
}

export function useAgentConnection({
  runtimeApi,
  runtimeState,
  setRuntimeState,
  setRuntimeError,
  setSelectedSessionId,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null | undefined>>;
}) {
  const [draft, setDraft] = useState<AgentConnectionDraft>();
  const [isStarting, setIsStarting] = useState(false);
  const [isCheckingSetup, setIsCheckingSetup] = useState(false);
  const [setupMessages, setSetupMessages] = useState<string[]>([]);

  const openExisting = useCallback(
    (sourceSessionId: string, targetSessionId: string) => {
      if (!runtimeState.sessions[sourceSessionId] || !runtimeState.sessions[targetSessionId] || sourceSessionId === targetSessionId) return;
      setDraft({
        sourceSessionId,
        target: { kind: 'existing', sessionId: targetSessionId },
        timing: defaultTiming(runtimeState, sourceSessionId),
        behavior: 'one-review',
        instruction: reviewInstruction(),
        blockingMode: 'p0-p1',
        customCriteria: '',
        maxLaps: '6',
      });
    },
    [runtimeState],
  );

  const openNew = useCallback(
    (sourceSessionId: string, position: { x: number; y: number }) => {
      const source = runtimeState.sessions[sourceSessionId];
      if (!source) return;
      const providerKind: ProviderKind = nextProviderKind(source.providerKind);
      const instance = providerInstanceForKind(runtimeState.providerInstances, providerKind);
      setDraft({
        sourceSessionId,
        target: {
          kind: 'new',
          label: 'Reviewer',
          cwd: source.cwd,
          providerKind,
          providerInstanceId: instance.providerInstanceId,
          model: '',
          reasoningEffort: 'high',
          runtimeMode: 'approval-required',
          position,
        },
        timing: defaultTiming(runtimeState, sourceSessionId),
        behavior: 'one-review',
        instruction: reviewInstruction(),
        blockingMode: 'p0-p1',
        customCriteria: '',
        maxLaps: '6',
      });
    },
    [runtimeState],
  );

  const payload = useMemo(() => (draft ? payloadOf(draft) : undefined), [draft]);
  const validation = useMemo(() => {
    if (!payload) return { ok: false, issues: [] };
    const result = validateAgentConnection(
      payload,
      runtimeState.providerInstances.map((instance) => instance.providerInstanceId),
    );
    const issues = [...result.issues];
    const source = runtimeState.sessions[payload.sourceSessionId];
    if (!source || source.status === 'killed') issues.push({ field: 'sourceSessionId', message: 'The source Agent is no longer available.' });
    if (source && (source.status === 'running' || source.status === 'pending') && payload.timing === 'current-result') {
      issues.push({ field: 'timing', message: 'The source Agent is still working. Wait for next completion to avoid a partial workspace.' });
    }
    if (payload.target.kind === 'existing') {
      const targetSessionId = payload.target.sessionId;
      const target = runtimeState.sessions[targetSessionId];
      if (!target || target.status === 'killed') issues.push({ field: 'target.sessionId', message: 'The receiving Agent is no longer available.' });
      if (target && (target.status === 'running' || target.status === 'pending')) {
        issues.push({ field: 'target.sessionId', message: `The receiving Agent is ${target.status}; wait until it is idle.` });
      }
      if (runtimeState.nodes.find((node) => node.sessionId === targetSessionId)?.frozen) {
        issues.push({ field: 'target.sessionId', message: 'The receiving Agent is frozen.' });
      }
      if (source && target && payload.behavior !== 'handoff-once' && source.cwd !== target.cwd) {
        issues.push({ field: 'target.sessionId', message: 'Code review Agents must share the same workspace.' });
      }
    }
    return { ok: issues.length === 0, issues };
  }, [payload, runtimeState.nodes, runtimeState.providerInstances, runtimeState.sessions]);
  const setupTarget = draft?.target.kind === 'new' ? draft.target : undefined;

  useEffect(() => {
    if (!runtimeApi || !setupTarget) {
      setIsCheckingSetup(false);
      setSetupMessages([]);
      return;
    }
    let active = true;
    setIsCheckingSetup(true);
    Promise.all([
      runtimeApi.getProviderSetupStatus({
        providerKind: setupTarget.providerKind,
        providerInstanceId: setupTarget.providerInstanceId,
        cwd: setupTarget.cwd,
      }),
      runtimeApi.getProjectContext({ cwd: setupTarget.cwd }),
    ])
      .then(([provider, project]) => {
        if (!active) return;
        setSetupMessages([
          ...provider.checks.filter((check) => check.status === 'error').map((check) => check.message),
          ...(project.error ? [project.error] : []),
        ]);
        setIsCheckingSetup(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSetupMessages([error instanceof Error ? error.message : String(error)]);
        setIsCheckingSetup(false);
      });
    return () => {
      active = false;
    };
  }, [runtimeApi, setupTarget]);

  const isReady = validation.ok && !isCheckingSetup && setupMessages.length === 0;

  const update = useCallback((patch: Partial<AgentConnectionDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const updateNewTarget = useCallback((patch: Partial<NewTargetDraft>) => {
    setDraft((current) => (current?.target.kind === 'new' ? { ...current, target: { ...current.target, ...patch } } : current));
  }, []);

  const start = useCallback(async () => {
    if (!runtimeApi || !payload || !isReady || isStarting) return;
    setIsStarting(true);
    setRuntimeError(undefined);
    try {
      const result = await runtimeApi.connectAgents(payload);
      setRuntimeState(result.state);
      setSelectedSessionId(result.targetSessionId);
      setDraft(undefined);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStarting(false);
    }
  }, [isReady, isStarting, payload, runtimeApi, setRuntimeError, setRuntimeState, setSelectedSessionId]);

  return {
    draft,
    setDraft,
    update,
    updateNewTarget,
    validation,
    isReady,
    isCheckingSetup,
    setupMessages,
    isStarting,
    openExisting,
    openNew,
    start,
  };
}

export type AgentConnectionState = ReturnType<typeof useAgentConnection>;
