import { type Node } from '@xyflow/react';
import { type GraphEdge, type GraphEdgeKind, type GraphState, type Report, type SessionStatus, type UpdateNodePositionsInput } from '@/shared/graph-state';
import { compactId, formatClock } from '@/lib/format';
import { reportIssueCount, reportSummary } from '@/lib/reports';
import { sessionLabel } from '@/lib/session-display';

export type AgentNodeData = {
  label: string;
  description: string;
  agent: string;
  role: 'worker' | 'master';
  status: SessionStatus;
  messageCount: number;
  lastActivityTs?: string;
  latestVerdict?: string;
  latestReportIssueCount?: number;
  latestReportSummary?: string;
  frozen?: boolean;
  freezeReason?: string;
  masterReason?: string;
  clusterLabel?: string;
  isManaged?: boolean;
};

export type GraphEdgeData = {
  kind: GraphEdgeKind;
  label: string;
  sequence: number;
  ts: string;
  verdict?: string;
  issueCount?: number;
  summary?: string;
  masterReason?: string;
  frozen?: boolean;
  freezeReason?: string;
  recent?: boolean;
};

export type ActivityEvent = {
  id: string;
  kind: GraphEdgeKind | 'report';
  ts: string;
  title: string;
  detail?: string;
  reason?: string;
};

export type ClusterNodeData = {
  label: string;
  nodeCount: number;
  masterLabel?: string;
  policySummary?: string;
  frozen?: boolean;
  freezeReason?: string;
};

export const edgeKindLabels: Record<GraphEdgeKind, string> = {
  'create-session': 'new chat',
  'resume-session': 'send',
  report: 'report',
  freeze: 'freeze',
  link: 'link',
};

export const edgeKindClassNames: Record<GraphEdgeKind, string> = {
  'create-session': 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'resume-session': 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  report: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  freeze: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  link: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

export const edgeKindStrokes: Record<GraphEdgeKind, string> = {
  'create-session': 'oklch(0.72 0.15 162)',
  'resume-session': 'oklch(0.75 0.15 75)',
  report: 'oklch(0.72 0.13 210)',
  freeze: 'oklch(0.6 0.02 240)',
  link: 'oklch(0.65 0.19 300)',
};

export function edgeDisplayLabel(edgeData: GraphEdgeData) {
  const label = edgeData.label.trim();
  if (!label || label === edgeData.kind || label === 'create_session' || label === 'resume_session') {
    return edgeKindLabels[edgeData.kind];
  }

  return label;
}

export function loopPolicySummary(cluster: GraphState['clusters'][string]) {
  const verdict = cluster.loopPolicy?.until?.whenReport.verdict;
  const maxIterations = cluster.loopPolicy?.maxIterations;
  const parts = [
    verdict ? `Review until ${verdict}` : undefined,
    cluster.loopPolicy?.onStop === 'freeze' ? 'Freeze on stop' : undefined,
    maxIterations ? `Max ${maxIterations}` : undefined,
  ].filter(Boolean);

  return parts.length ? parts.join(' · ') : undefined;
}

export function loopStateStatus(cluster: GraphState['clusters'][string] | undefined) {
  return cluster?.loopState?.status ?? 'stopped';
}

export function workflowTargetLabel(state: GraphState, targetId: string) {
  return state.sessions[targetId]?.label ?? state.clusters[targetId]?.label ?? compactId(targetId);
}

export function loopEventLabel(type: string) {
  switch (type) {
    case 'loop.started':
      return 'Loop started';
    case 'loop.stopped':
      return 'Loop stopped';
    case 'session.finished':
      return 'Chat finished';
    case 'session.failed':
      return 'Chat failed';
    case 'session.killed':
      return 'Chat stopped';
    case 'report.received':
      return 'Report received';
    case 'freeze.applied':
      return 'Freeze applied';
    case 'runtime.recovered':
      return 'Runtime recovered';
    default:
      return type.replaceAll('.', ' ');
  }
}

export function loopLastEvent(cluster: GraphState['clusters'][string] | undefined, state: GraphState) {
  const event = cluster?.loopState?.lastEvent;
  if (!event) {
    return 'none';
  }

  const subject = event.sessionId
    ? workflowTargetLabel(state, event.sessionId)
    : event.from
      ? workflowTargetLabel(state, event.from)
      : event.targetId
        ? workflowTargetLabel(state, event.targetId)
        : event.reportId
          ? compactId(event.reportId)
          : undefined;
  return [loopEventLabel(event.type), subject, formatClock(event.ts)].filter(Boolean).join(' · ');
}

export function clusterBoundaryNodes(state: GraphState): Node<ClusterNodeData>[] {
  return Object.values(state.clusters).flatMap((cluster) => {
    const managedNodes = cluster.nodeIds
      .map((nodeId) => state.nodes.find((node) => node.nodeId === nodeId))
      .filter((node): node is GraphState['nodes'][number] => Boolean(node));

    if (managedNodes.length === 0) {
      return [];
    }

    const nodeWidth = 300;
    const nodeHeight = 240;
    const padding = 36;
    const minX = Math.min(...managedNodes.map((node) => node.position.x)) - padding;
    const minY = Math.min(...managedNodes.map((node) => node.position.y)) - padding;
    const maxX = Math.max(...managedNodes.map((node) => node.position.x + nodeWidth)) + padding;
    const maxY = Math.max(...managedNodes.map((node) => node.position.y + nodeHeight)) + padding;
    const master = cluster.masterSessionId ? state.sessions[cluster.masterSessionId] : undefined;

    return [
      {
        id: `cluster:${cluster.clusterId}`,
        type: 'cluster',
        position: { x: minX, y: minY },
        selectable: false,
        draggable: false,
        zIndex: -10,
        style: {
          width: maxX - minX,
          height: maxY - minY,
          pointerEvents: 'none',
        },
        data: {
          label: cluster.label,
          nodeCount: managedNodes.length,
          masterLabel: master?.label,
          policySummary: loopPolicySummary(cluster),
          frozen: cluster.frozen,
          freezeReason: cluster.freezeReason,
        },
      },
    ];
  });
}

export function edgeReason(edge: GraphEdge) {
  return edge.freezeReason ?? edge.masterReason;
}

export function edgeSummary(edge: GraphEdge, reportsById: Map<string, Report>) {
  if (edge.summary) {
    return edge.summary;
  }

  if (edge.reportId) {
    const report = reportsById.get(edge.reportId);
    return report ? reportSummary(report) : undefined;
  }

  if (edge.kind === 'freeze') {
    return edge.freezeReason ?? 'freeze requested';
  }

  return undefined;
}

export function activityTitle(kind: ActivityEvent['kind']) {
  if (kind === 'report') {
    return 'report';
  }

  return edgeKindLabels[kind];
}

export function activityEvents(state: GraphState): ActivityEvent[] {
  const reportsById = new Map(state.reports.map((report) => [report.id, report]));
  const edgeEvents = state.edges.map((edge) => ({
    id: `edge:${edge.edgeId}`,
    kind: edge.kind,
    ts: edge.ts,
    title: `${sessionLabel(state, edge.source)} → ${sessionLabel(state, edge.target)}`,
    detail: edgeSummary(edge, reportsById) ?? edge.label ?? edge.kind,
    reason: edgeReason(edge),
  }));
  const reportEvents = state.reports.map((report) => ({
    id: `report:${report.id}`,
    kind: 'report' as const,
    ts: report.envelope.ts,
    title:
      report.payload.type === 'verdict'
        ? `${sessionLabel(state, report.from)} reported ${report.payload.verdict}`
        : `${sessionLabel(state, report.from)} reported ${report.payload.type}`,
    detail: report.payload.type === 'verdict' ? `${reportIssueCount(report)} issues · ${reportSummary(report)}` : reportSummary(report),
  }));

  return [...edgeEvents, ...reportEvents].sort((left, right) => left.ts.localeCompare(right.ts)).slice(-12);
}

export type NodePositionUpdate = UpdateNodePositionsInput['positions'][number];

export function isFinitePosition(position: { x: number; y: number }) {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

export function nodePositionUpdatesFromFlowNodes(nodes: Node[]): NodePositionUpdate[] {
  return nodes.flatMap((node) => {
    if (node.id.startsWith('cluster:') || !isFinitePosition(node.position)) {
      return [];
    }

    return [
      {
        nodeId: node.id,
        position: { x: node.position.x, y: node.position.y },
      },
    ];
  });
}

export function applyNodePositionUpdates(state: GraphState, updates: NodePositionUpdate[]) {
  if (updates.length === 0) {
    return state;
  }

  const updateById = new Map(updates.map((update) => [update.nodeId, update]));
  let changed = false;
  const nextNodes = state.nodes.map((node) => {
    const update = updateById.get(node.nodeId);
    if (!update || (node.position.x === update.position.x && node.position.y === update.position.y)) {
      return node;
    }

    changed = true;
    return {
      ...node,
      position: {
        x: update.position.x,
        y: update.position.y,
      },
    };
  });

  return changed ? { ...state, nodes: nextNodes } : state;
}

export function applyFlowNodePositionUpdates(nodes: Node[], updates: NodePositionUpdate[]) {
  if (updates.length === 0) {
    return nodes;
  }

  const updateById = new Map(updates.map((update) => [update.nodeId, update]));
  let changed = false;
  const nextNodes = nodes.map((node) => {
    const update = updateById.get(node.id);
    if (!update || (node.position.x === update.position.x && node.position.y === update.position.y)) {
      return node;
    }

    changed = true;
    return {
      ...node,
      position: {
        x: update.position.x,
        y: update.position.y,
      },
    };
  });

  return changed ? nextNodes : nodes;
}
