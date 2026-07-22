import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch, type SetStateAction } from 'react';
import type { Connection } from '@xyflow/react';

import type { GraphState } from '@/shared/graph-state';
import type { ProviderKind } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { providerInstanceForKind } from '@/lib/provider-catalog';
import {
  emptyDraftGraph,
  reduceDraftGraph,
  validateDraftGraph,
  type DraftAgentEndpoint,
  type DraftGraphAction,
  type DraftPoint,
  type DraftRelationKind,
} from '@shared/draft-graph';
import { providerKindForOrdinal } from '@shared/provider-metadata';

export type PendingDraftConnection = {
  sourceNodeId: string;
  targetNodeId: string;
};

function sessionContext(state: GraphState) {
  return Object.fromEntries(
    Object.values(state.sessions).map((session) => [
      session.sessionId,
      {
        sessionId: session.sessionId,
        cwd: session.cwd,
        status: session.status,
        frozen: state.nodes.find((node) => node.sessionId === session.sessionId)?.frozen,
      },
    ]),
  );
}

export function useDraftGraph({
  runtimeApi,
  runtimeState,
  defaultCwd,
  setRuntimeState,
  setRuntimeError,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  defaultCwd: string;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
}) {
  const [graph, dispatch] = useReducer(reduceDraftGraph, undefined, emptyDraftGraph);
  const [pendingConnection, setPendingConnection] = useState<PendingDraftConnection>();
  const [isStarting, setIsStarting] = useState(false);
  const [isCheckingSetup, setIsCheckingSetup] = useState(false);
  const [setupMessages, setSetupMessages] = useState<string[]>([]);
  const validation = useMemo(
    () =>
      validateDraftGraph(graph, {
        sessions: sessionContext(runtimeState),
        providerInstanceIds: runtimeState.providerInstances.map((instance) => instance.providerInstanceId),
      }),
    [graph, runtimeState],
  );
  const setupKey = useMemo(
    () =>
      JSON.stringify(
        graph.nodeOrder.flatMap((nodeId) => {
          const endpoint = graph.nodes[nodeId]?.endpoint;
          return endpoint?.kind === 'new' ? [[endpoint.providerKind, endpoint.providerInstanceId, endpoint.cwd, endpoint.workMode]] : [];
        }),
      ),
    [graph.nodeOrder, graph.nodes],
  );

  useEffect(() => {
    if (!runtimeApi || graph.nodeOrder.length === 0) {
      setIsCheckingSetup(false);
      setSetupMessages([]);
      return;
    }
    const endpoints = graph.nodeOrder
      .map((nodeId) => graph.nodes[nodeId]?.endpoint)
      .filter((endpoint): endpoint is Extract<DraftAgentEndpoint, { kind: 'new' }> => endpoint?.kind === 'new');
    let active = true;
    setIsCheckingSetup(true);
    void Promise.all([
      ...endpoints.map((endpoint) =>
        runtimeApi.getProviderSetupStatus({
          providerKind: endpoint.providerKind,
          providerInstanceId: endpoint.providerInstanceId,
          cwd: endpoint.cwd,
        }),
      ),
      ...[...new Set(endpoints.map((endpoint) => endpoint.cwd.trim()).filter(Boolean))].map((cwd) => runtimeApi.getProjectContext({ cwd })),
    ])
      .then((results) => {
        if (!active) return;
        const providerErrors = results.flatMap((result) =>
          'checks' in result ? result.checks.filter((check) => check.status === 'error').map((check) => check.message) : [],
        );
        const projectErrors = results.flatMap((result) => ('checks' in result || !result.error ? [] : [result.error]));
        const worktreeErrors = endpoints.flatMap((endpoint) => {
          if (endpoint.workMode !== 'worktree') return [];
          const context = results.find((result) => !('checks' in result) && result.cwd === endpoint.cwd);
          return context && !('checks' in context) && !context.isGitRepo ? [`${endpoint.label}: Worktree mode requires a Git project.`] : [];
        });
        setSetupMessages([...new Set([...providerErrors, ...projectErrors, ...worktreeErrors])]);
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
  }, [graph.nodeOrder, graph.nodes, runtimeApi, setupKey]);

  const isReady = validation.ok && !isCheckingSetup && setupMessages.length === 0;

  const addAgent = useCallback(
    (position?: DraftPoint) => {
      const ordinal = graph.nodeOrder.length;
      const providerKind: ProviderKind = providerKindForOrdinal(ordinal);
      const providerInstance = providerInstanceForKind(runtimeState.providerInstances, providerKind);
      dispatch({
        type: 'add-node',
        node: {
          position: position ?? { x: 120 + ordinal * 360, y: 160 + (ordinal % 2) * 180 },
          endpoint: {
            kind: 'new',
            label: ordinal === 0 ? 'Coder' : ordinal === 1 ? 'Reviewer' : `Agent ${ordinal + 1}`,
            prompt: '',
            cwd: defaultCwd,
            workMode: 'local',
            providerKind,
            providerInstanceId: providerInstance.providerInstanceId,
            runtimeSettings: {
              runtimeMode: 'auto',
              reasoningEffort: ordinal === 0 ? 'medium' : 'high',
            },
          },
        },
      });
    },
    [defaultCwd, graph.nodeOrder.length, runtimeState.providerInstances],
  );

  const updateNodeEndpoint = useCallback((id: string, endpoint: DraftAgentEndpoint) => {
    dispatch({ type: 'update-node', id, patch: { endpoint } });
  }, []);

  const connect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      if (!graph.nodes[connection.source] || !graph.nodes[connection.target]) return;
      setPendingConnection({ sourceNodeId: connection.source, targetNodeId: connection.target });
      dispatch({ type: 'select', selection: undefined });
    },
    [graph.nodes],
  );

  const confirmConnection = useCallback(
    (kind: DraftRelationKind) => {
      if (!pendingConnection) return;
      dispatch({
        type: 'add-relation',
        relation: {
          kind,
          ...pendingConnection,
          instruction: kind === 'review-loop' ? 'Review the implementation against the requested behavior. Verify the actual workspace diff.' : '',
          ...(kind === 'review-loop' ? { review: { blocking: { mode: 'p0-p1' }, maxLaps: 6 } } : {}),
        },
      });
      setPendingConnection(undefined);
    },
    [pendingConnection],
  );

  const start = useCallback(async () => {
    if (!runtimeApi || !isReady || isStarting) return undefined;
    setIsStarting(true);
    setRuntimeError(undefined);
    try {
      const result = await runtimeApi.startDraftWorkflow({ graph });
      setRuntimeState(result.state);
      dispatch({ type: 'clear' });
      setPendingConnection(undefined);
      return result;
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setIsStarting(false);
    }
  }, [graph, isReady, isStarting, runtimeApi, setRuntimeError, setRuntimeState]);

  const discard = useCallback(() => {
    dispatch({ type: 'clear' });
    setPendingConnection(undefined);
  }, []);

  return {
    graph,
    dispatch: dispatch as Dispatch<DraftGraphAction>,
    validation,
    isReady,
    isCheckingSetup,
    setupMessages,
    pendingConnection,
    setPendingConnection,
    isStarting,
    addAgent,
    updateNodeEndpoint,
    connect,
    confirmConnection,
    start,
    discard,
  };
}

export type DraftGraphState = ReturnType<typeof useDraftGraph>;
