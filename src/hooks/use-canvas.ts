import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkerType, applyNodeChanges, type Edge, type Node, type NodeChange } from '@xyflow/react';

import type { GraphState, Report } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import {
  applyFlowNodePositionUpdates,
  applyNodePositionUpdates,
  clusterBoundaryNodes,
  edgeSummary,
  loopBadgeNodes,
  nodePositionUpdatesFromFlowNodes,
  sourceNodes,
  subscriptionEdgeDescriptors,
  subscriptionPatternLabel,
  subscriptionUntilSummary,
  timerNodes,
} from '@/lib/graph-view';
import { latestReportForSession, reportIssueCount, reportSummary } from '@/lib/reports';
import { lastMessagePreview, sessionDisplayLabel, sessionProviderLabel, shortAgentName } from '@/lib/session-display';
import { draftCanvasEdges, draftCanvasNodes } from '@/lib/draft-graph-view';
import type { DraftGraphState } from '@/hooks/use-draft-graph';

function sameStringList(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canvasNodesRenderSignature(nodes: Node[]) {
  return JSON.stringify(
    nodes.map((node) => {
      const data = node.data as Record<string, unknown>;
      if (node.type !== 'agent' || (data.status !== 'running' && data.status !== 'pending')) {
        return node;
      }
      const stableData = { ...data };
      delete stableData.description;
      delete stableData.lastActivityTs;
      return { ...node, data: stableData };
    }),
  );
}

export function useCanvas({
  runtimeApi,
  runtimeState,
  setRuntimeState,
  setRuntimeError,
  reportsById,
  setSelectedCanvasNodeIds,
  setActiveClusterId,
  draft,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  setRuntimeState: Dispatch<SetStateAction<GraphState>>;
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>;
  reportsById: Map<string, Report>;
  setSelectedCanvasNodeIds: Dispatch<SetStateAction<string[]>>;
  setActiveClusterId: Dispatch<SetStateAction<string | undefined>>;
  draft: DraftGraphState;
}) {
  const { graph: draftGraph, validation: draftValidation, dispatch: draftDispatch } = draft;
  const nodes: Node[] = useMemo(
    () => [
      ...clusterBoundaryNodes(runtimeState),
      // L4/L2 synthetic presences: clock sources, external sources, and
      // ring badges. Their positions derive from session nodes, so they
      // re-place on every state change and never persist.
      ...timerNodes(runtimeState),
      ...sourceNodes(runtimeState),
      ...loopBadgeNodes(runtimeState),
      ...draftCanvasNodes(draftGraph, draftValidation.issues),
      ...runtimeState.nodes.map((node) => {
        const session = runtimeState.sessions[node.sessionId];
        const cluster = node.clusterId ? runtimeState.clusters[node.clusterId] : undefined;
        const latestReport = latestReportForSession(runtimeState.reports, node.sessionId);
        const latestVerdict = latestReport?.payload.type === 'verdict' ? latestReport.payload.verdict : undefined;
        const latestIssueCount = latestReport ? reportIssueCount(latestReport) : undefined;
        return {
          id: node.nodeId,
          type: 'agent',
          position: node.position,
          zIndex: node.role === 'master' ? 20 : 10,
          data: {
            label: session ? sessionDisplayLabel(session) : node.label,
            description: lastMessagePreview(session),
            agent: shortAgentName(session ? sessionProviderLabel(session) : node.agent),
            role: node.role,
            status: node.status,
            messageCount: session?.messages.length ?? 0,
            lastActivityTs: session?.updatedAt,
            latestVerdict,
            latestReportIssueCount: latestIssueCount,
            latestReportSummary: latestReport ? reportSummary(latestReport) : undefined,
            frozen: node.frozen,
            freezeReason: node.freezeReason,
            masterReason: node.masterReason,
            clusterLabel: cluster?.label,
            isManaged: Boolean(cluster?.nodeIds.includes(node.nodeId)),
          },
        };
      }),
    ],
    [draftGraph, draftValidation.issues, runtimeState],
  );
  const [canvasNodes, setCanvasNodes] = useState<Node[]>(nodes);
  const canvasNodesSignatureRef = useRef(canvasNodesRenderSignature(nodes));
  const isDraggingCanvasNodeRef = useRef(false);

  const edges: Edge[] = useMemo(() => {
    const sorted = [...runtimeState.edges].sort((left, right) => left.ts.localeCompare(right.ts));
    const sequenceById = new Map(sorted.map((edge, index) => [edge.edgeId, index + 1]));
    const recentEdgeIds = new Set(sorted.slice(-3).map((edge) => edge.edgeId));

    const historyEdges = runtimeState.edges.map((edge) => {
      const report = edge.reportId ? reportsById.get(edge.reportId) : undefined;
      return {
        id: edge.edgeId,
        type: 'readability',
        source: edge.source,
        target: edge.target,
        animated: edge.kind === 'create-session' || edge.kind === 'resume-session',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          edgeId: edge.edgeId,
          kind: edge.kind,
          label: edge.label ?? edge.kind,
          sequence: sequenceById.get(edge.edgeId) ?? 0,
          ts: edge.ts,
          verdict: edge.verdict ?? (report?.payload.type === 'verdict' ? report.payload.verdict : undefined),
          issueCount: edge.issueCount ?? (report ? reportIssueCount(report) : undefined),
          summary: edgeSummary(edge, reportsById),
          masterReason: edge.masterReason,
          frozen: edge.frozen,
          freezeReason: edge.freezeReason,
          recent: recentEdgeIds.has(edge.edgeId),
        },
      };
    });

    // Intent edges (kernel doc §3): subscriptions are the dashed primary
    // structure; a live pending slot animates the edge (the activity pulse).
    const intentEdges = subscriptionEdgeDescriptors(runtimeState).map((descriptor) => {
      const subscription = descriptor.subscription;
      return {
        id: descriptor.id,
        type: 'readability',
        source: descriptor.source,
        target: descriptor.target,
        animated: subscription.state === 'active' && Boolean(descriptor.pendingStatus),
        markerEnd: { type: MarkerType.ArrowClosed },
        zIndex: 5,
        data: {
          subscriptionId: subscription.id,
          kind: 'subscription' as const,
          label: subscription.label ?? 'when',
          sequence: 0,
          ts: subscription.createdAt,
          summary: subscriptionPatternLabel(subscription),
          frozen: subscription.state === 'stopped',
          gate: subscription.gate,
          firings: subscription.firings,
          maxFirings: subscription.stop?.maxFirings,
          untilSummary: subscriptionUntilSummary(subscription),
          subscriptionState: subscription.state,
          pendingStatus: descriptor.pendingStatus,
        },
      };
    });

    return [...historyEdges, ...intentEdges, ...draftCanvasEdges(draftGraph)];
  }, [draftGraph, reportsById, runtimeState]);

  useEffect(() => {
    if (isDraggingCanvasNodeRef.current) {
      return;
    }
    const signature = canvasNodesRenderSignature(nodes);
    if (signature === canvasNodesSignatureRef.current) {
      return;
    }
    canvasNodesSignatureRef.current = signature;
    setCanvasNodes(nodes);
  }, [nodes]);

  const updateCanvasNodePositions = useCallback((changes: NodeChange[]) => {
    setCanvasNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const beginCanvasNodeDrag = useCallback(() => {
    isDraggingCanvasNodeRef.current = true;
  }, []);

  const persistCanvasNodePositions = useCallback(
    (_event: globalThis.MouseEvent | TouchEvent, node: Node, draggedNodes: Node[]) => {
      isDraggingCanvasNodeRef.current = false;
      if (draftGraph.nodes[node.id]) {
        draftDispatch({ type: 'update-node', id: node.id, patch: { position: { x: node.position.x, y: node.position.y } } });
        return;
      }
      const updates = nodePositionUpdatesFromFlowNodes(draggedNodes.length > 0 ? draggedNodes : [node]);
      if (updates.length === 0) {
        return;
      }

      setCanvasNodes((current) => applyFlowNodePositionUpdates(current, updates));
      setRuntimeState((current) => applyNodePositionUpdates(current, updates));

      if (!runtimeApi) {
        return;
      }

      runtimeApi
        .updateNodePositions({ positions: updates })
        .then((result) => setRuntimeState(result.state))
        .catch((error: unknown) => {
          setRuntimeError(error instanceof Error ? error.message : String(error));
        });
    },
    [draftDispatch, draftGraph.nodes, runtimeApi, setRuntimeError, setRuntimeState],
  );

  const updateCanvasSelection = useCallback(
    ({ nodes: selectedNodes }: { nodes: Node[] }) => {
      const nextSelection = selectedNodes
        .map((node) => node.id)
        .filter(
          (nodeId) =>
            !draftGraph.nodes[nodeId] &&
            !nodeId.startsWith('cluster:') &&
            !nodeId.startsWith('timer:') &&
            !nodeId.startsWith('loop:') &&
            !nodeId.startsWith('source:'),
        );

      setSelectedCanvasNodeIds((previousSelection) => (sameStringList(previousSelection, nextSelection) ? previousSelection : nextSelection));

      const selectedClusterId = nextSelection
        .map((nodeId) => runtimeState.nodes.find((node) => node.nodeId === nodeId)?.clusterId)
        .find((clusterId): clusterId is string => Boolean(clusterId));
      if (selectedClusterId) {
        setActiveClusterId((current) => (current === selectedClusterId ? current : selectedClusterId));
      }
    },
    [draftGraph.nodes, runtimeState.nodes, setActiveClusterId, setSelectedCanvasNodeIds],
  );

  return {
    nodes,
    edges,
    canvasNodes,
    updateCanvasNodePositions,
    beginCanvasNodeDrag,
    persistCanvasNodePositions,
    updateCanvasSelection,
  };
}

export type CanvasState = ReturnType<typeof useCanvas>;
