import { type Node } from '@xyflow/react';
import {
  type ExternalSource,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphState,
  type KernelEvent,
  type LoopViewStatus,
  type LoopView,
  type Report,
  type SessionStatus,
  type Subscription,
  type UpdateNodePositionsInput,
} from '@/shared/graph-state';
import { compactId, formatClock } from '@/lib/format';
import { reportIssueCount, reportSummary } from '@/lib/reports';
import { sessionLabel } from '@/lib/session-display';
import { type ProviderKind } from '@shared/provider-metadata';
import { deriveLoopProductView, type LoopProductView } from '@shared/loop-product';

export type AgentNodeData = {
  label: string;
  description: string;
  agent: string;
  providerKind?: ProviderKind;
  model?: string;
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

// Canvas edge kinds: the four runtime-history kinds + declared links from
// the state's edge list, plus intent edges derived from subscriptions
// (kernel doc §3 — the canvas's primary structure).
export type CanvasEdgeKind = GraphEdgeKind | 'subscription';

export type GraphEdgeData = {
  edgeId?: string;
  subscriptionId?: string;
  kind: CanvasEdgeKind;
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
  // Subscription (intent edge) badges: gate icon, firing counter, stop
  // condition, and the live pending-slot indicator.
  gate?: Subscription['gate'];
  firings?: number;
  maxFirings?: number;
  untilSummary?: string;
  subscriptionState?: Subscription['state'];
  pendingStatus?: 'pending' | 'approved';
  inspect?: () => void;
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

export const edgeKindLabels: Record<CanvasEdgeKind, string> = {
  'create-session': 'new chat',
  'resume-session': 'send',
  report: 'report',
  freeze: 'freeze',
  link: 'link',
  subscription: 'when',
};

export const edgeKindClassNames: Record<CanvasEdgeKind, string> = {
  'create-session': 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'resume-session': 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  report: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  freeze: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  link: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  subscription: 'border-lime-600/50 bg-lime-500/10 text-lime-700 dark:text-lime-300',
};

export const edgeKindStrokes: Record<CanvasEdgeKind, string> = {
  'create-session': 'oklch(0.72 0.15 162)',
  'resume-session': 'oklch(0.75 0.15 75)',
  report: 'oklch(0.72 0.13 210)',
  freeze: 'oklch(0.6 0.02 240)',
  link: 'oklch(0.65 0.19 300)',
  subscription: 'oklch(0.78 0.2 130)',
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

// Intent-edge view models (kernel doc §3): subscriptions render as the
// dashed primary structure with operator badges — gate, stop condition,
// `firings n/max` — plus the live pending-slot indicator.
export function subscriptionPatternLabel(subscription: Subscription) {
  const on = subscription.on;
  if (on.on === 'report') {
    return on.match?.verdict ? `on ${on.match.verdict}` : 'on report';
  }
  if (on.on === 'delivered') {
    return on.topic ? `on delivered(${on.topic})` : 'on delivered';
  }
  if (on.on === 'schedule') {
    if (on.dailyAt) {
      return `daily ${on.dailyAt}`;
    }
    const everySeconds = on.everySeconds ?? 0;
    return everySeconds % 60 === 0 ? `every ${everySeconds / 60}m` : `every ${everySeconds}s`;
  }
  if (on.on === 'external') {
    const topic = on.topic ? `external.${on.topic}` : 'external';
    const match = on.match
      ? Object.entries(on.match)
          .map(([key, value]) => `${key}=${value}`)
          .join(',')
      : undefined;
    return match ? `on ${topic}(${match})` : `on ${topic}`;
  }
  return `on ${on.on}`;
}

export function subscriptionUntilSummary(subscription: Subscription) {
  const stop = subscription.stop;
  if (!stop) {
    return undefined;
  }
  const parts = [stop.whenReport ? `until ${stop.whenReport.verdict}` : undefined, stop.deadline ? `until ${formatClock(stop.deadline)}` : undefined].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// A cluster-source subscription anchors to the cluster boundary node; when
// the cluster has no managed members (no boundary node is rendered), fall
// back to its master session so the edge never dangles on a missing node.
export function subscriptionSourceNodeId(state: GraphState, subscription: Subscription) {
  if (subscription.source.kind === 'timer') {
    // The clock renders as its own canvas node (L4); one per subscription.
    return `timer:${subscription.id}`;
  }
  if (subscription.source.kind === 'external') {
    // External sources render as one shared canvas node per source (L2).
    return `source:${subscription.source.sourceId}`;
  }
  if (subscription.source.kind !== 'cluster') {
    return subscription.source.sessionId;
  }
  const cluster = state.clusters[subscription.source.clusterId];
  const hasBoundary = Boolean(cluster && cluster.nodeIds.some((nodeId) => state.nodes.some((node) => node.nodeId === nodeId)));
  if (hasBoundary) {
    return `cluster:${subscription.source.clusterId}`;
  }
  return cluster?.masterSessionId;
}

// L3 goal loop fingerprint — mirrors the runtime's #isGoalPairShape: a
// compiled goal ring is identified by reciprocal session participants AND
// the preset's trigger/action/stop shape on both edges, never by id alone.
export function isCompiledGoalPair(check: Subscription | undefined, retry: Subscription | undefined) {
  return Boolean(
    check &&
    retry &&
    check.id.startsWith('goal-check-') &&
    retry.id === check.id.replace(/^goal-check-/, 'goal-retry-') &&
    check.source.kind === 'session' &&
    retry.source.kind === 'session' &&
    retry.source.sessionId === check.target.sessionId &&
    retry.target.sessionId === check.source.sessionId &&
    check.on.on === 'finished' &&
    retry.on.on === 'report' &&
    retry.on.match?.type === 'verdict' &&
    retry.on.match?.verdict === 'fail' &&
    check.action.kind === 'deliver+activate' &&
    retry.action.kind === 'deliver+activate' &&
    check.stop?.whenReport?.verdict === 'done' &&
    retry.stop?.whenReport?.verdict === 'done',
  );
}

export function activeGoalCheckEdge(subscriptions: Record<string, Subscription> | undefined, sessionId: string) {
  return Object.values(subscriptions ?? {}).find((subscription) => {
    if (!subscription.id.startsWith('goal-check-') || subscription.state !== 'active') {
      return false;
    }
    if (subscription.source.kind !== 'session' || subscription.source.sessionId !== sessionId) {
      return false;
    }
    return isCompiledGoalPair(subscription, subscriptions?.[subscription.id.replace(/^goal-check-/, 'goal-retry-')]);
  });
}

// Clock source nodes (L4, closing L1's rendering tail): one small canvas
// node per timer subscription, parked left of its target. Not draggable —
// positions derive from the target so they are never persisted.
export type TimerNodeData = {
  label: string;
  lastTickAt?: string;
  stopped: boolean;
};

export function timerNodes(state: GraphState): Node<TimerNodeData>[] {
  const perTarget = new Map<string, number>();
  return Object.values(state.subscriptions ?? {}).flatMap((subscription) => {
    if (subscription.source.kind !== 'timer') {
      return [];
    }
    const targetNode = state.nodes.find((node) => node.nodeId === subscription.target.sessionId);
    if (!targetNode) {
      return [];
    }
    const stacked = perTarget.get(targetNode.nodeId) ?? 0;
    perTarget.set(targetNode.nodeId, stacked + 1);
    return [
      {
        id: `timer:${subscription.id}`,
        type: 'clock' as const,
        position: { x: targetNode.position.x - 240, y: targetNode.position.y + 12 + stacked * 92 },
        draggable: false,
        selectable: false,
        zIndex: 8,
        data: {
          subscriptionId: subscription.id,
          label: subscriptionPatternLabel(subscription),
          lastTickAt: subscription.lastTickAt,
          stopped: subscription.state === 'stopped',
        },
      },
    ];
  });
}

// External source nodes (L2): one canvas node per registered source that
// backs at least one subscription edge (stopped edges keep their origin —
// tombstoned sources still render). Parked left of the first target,
// stacked below any clock nodes on the same target; not draggable, so
// positions derive from the target and are never persisted.
export type SourceNodeData = {
  source: ExternalSource;
  removed: boolean;
};

export function sourceNodes(state: GraphState): Node<SourceNodeData>[] {
  const subscriptions = Object.values(state.subscriptions ?? {});
  // Clock nodes occupy the first stack slots per target (timerNodes above).
  const perTarget = new Map<string, number>();
  for (const subscription of subscriptions) {
    if (subscription.source.kind === 'timer') {
      const target = subscription.target.sessionId;
      if (state.nodes.some((node) => node.nodeId === target)) {
        perTarget.set(target, (perTarget.get(target) ?? 0) + 1);
      }
    }
  }
  const placed = new Set<string>();
  return subscriptions.flatMap((subscription) => {
    if (subscription.source.kind !== 'external' || placed.has(subscription.source.sourceId)) {
      return [];
    }
    const source = state.sources?.[subscription.source.sourceId];
    if (!source) {
      return [];
    }
    const targetNode = state.nodes.find((node) => node.nodeId === subscription.target.sessionId);
    if (!targetNode) {
      return [];
    }
    placed.add(source.id);
    const stacked = perTarget.get(targetNode.nodeId) ?? 0;
    perTarget.set(targetNode.nodeId, stacked + 1);
    return [
      {
        id: `source:${source.id}`,
        type: 'source' as const,
        position: { x: targetNode.position.x - 240, y: targetNode.position.y + 12 + stacked * 92 },
        draggable: false,
        selectable: false,
        zIndex: 8,
        data: {
          source,
          removed: source.state === 'removed',
        },
      },
    ];
  });
}

// Ring badges (L4): one per loop projection, floated above the bounding box
// of the ring's member nodes. Click opens the per-lap timeline.
export type LoopBadgeData = {
  loop: LoopView;
  product: LoopProductView;
};

export const loopStatusLabels: Record<LoopViewStatus, string> = {
  spinning: 'spinning',
  'waiting-gate': 'waiting gate',
  frozen: 'frozen',
  stopped: 'stopped',
  idle: 'idle',
};

export function loopBadgeLabel(loop: LoopView) {
  const laps = loop.lapCap !== undefined ? `${loop.lapCount}/${loop.lapCap}` : `${loop.lapCount}`;
  return `${laps} · ${loopStatusLabels[loop.status]}`;
}

export function loopProductSessions(state: GraphState) {
  return Object.fromEntries(
    Object.values(state.sessions).map((session) => {
      const node = state.nodes.find((candidate) => candidate.sessionId === session.sessionId);
      return [
        session.sessionId,
        {
          ...session,
          frozen: node?.frozen,
          freezeReason: node?.freezeReason,
        },
      ];
    }),
  );
}

export function loopBadgeNodes(state: GraphState): Node<LoopBadgeData>[] {
  return (state.loops ?? []).flatMap((loop) => {
    const members = loop.memberSessionIds
      .map((sessionId) => state.nodes.find((node) => node.nodeId === sessionId))
      .filter((node): node is GraphState['nodes'][number] => Boolean(node));
    if (members.length === 0) {
      return [];
    }
    const nodeWidth = 300;
    const minX = Math.min(...members.map((node) => node.position.x));
    const maxX = Math.max(...members.map((node) => node.position.x + nodeWidth));
    const minY = Math.min(...members.map((node) => node.position.y));
    return [
      {
        id: `loop:${loop.loopId}`,
        type: 'loop' as const,
        position: { x: (minX + maxX) / 2 - 110, y: minY - 76 },
        draggable: false,
        selectable: false,
        zIndex: 30,
        data: {
          loop,
          product: deriveLoopProductView({
            loop,
            sessions: loopProductSessions(state),
            subscriptions: state.subscriptions,
            reports: state.reports,
          }),
        },
      },
    ];
  });
}

export function subscriptionEdgeDescriptors(state: GraphState) {
  const slots = Object.values(state.pendingActivations ?? {});
  return Object.values(state.subscriptions ?? {}).flatMap((subscription) => {
    const source = subscriptionSourceNodeId(state, subscription);
    if (!source) {
      return [];
    }
    const slot = slots.find((candidate) => candidate.subscriptionId === subscription.id);
    return [
      {
        id: `sub:${subscription.id}`,
        source,
        target: subscription.target.sessionId,
        subscription,
        pendingStatus: slot?.status,
      },
    ];
  });
}

// --- Kernel event timeline (kernel doc §9 G4: every delivery/activation/
// report/freeze in occurrence order, with the gate decision and reason
// readable per firing). ---

export function kernelEventLabel(type: string) {
  switch (type) {
    case 'session.created':
      return 'created';
    case 'session.finished':
      return 'finished';
    case 'session.failed':
      return 'failed';
    case 'session.killed':
      return 'killed';
    case 'session.archived':
      return 'archived';
    case 'activated':
      return 'activate';
    case 'delivered':
      return 'deliver';
    case 'report.received':
      return 'report';
    case 'subscription.authored':
      return 'subscribed';
    case 'subscription.stopped':
      return 'unsubscribed';
    case 'subscription.guarded':
      return 'guarded';
    case 'activation.pending':
      return 'pending';
    case 'activation.approved':
      return 'approved';
    case 'activation.denied':
      return 'denied';
    case 'activation.superseded':
      return 'superseded';
    case 'activation.dropped':
      return 'dropped';
    case 'freeze.applied':
      return 'freeze';
    case 'freeze.lifted':
      return 'unfreeze';
    case 'loop.started':
      return 'loop start';
    case 'loop.stopped':
      return 'loop stop';
    case 'edge.linked':
      return 'link';
    case 'edge.removed':
      return 'unlink';
    case 'external.timer':
      return 'tick';
    default:
      return type.replaceAll('.', ' ');
  }
}

export function kernelActorLabel(state: GraphState, actor: KernelEvent['actor']) {
  if (actor.kind === 'master' || actor.kind === 'agent') {
    return actor.ref ? sessionLabel(state, actor.ref) : actor.kind;
  }
  if (actor.kind === 'rule') {
    const subscription = actor.ref ? state.subscriptions?.[actor.ref] : undefined;
    return subscription?.label ? `rule ${subscription.label}` : 'rule';
  }
  return actor.kind;
}

export function kernelEventSubject(state: GraphState, event: KernelEvent) {
  const payload = event.payload ?? {};
  const gateSuffix = event.type === 'activation.pending' && typeof payload.gate === 'string' ? ` · gate ${payload.gate}` : '';
  const target = typeof payload.target === 'string' ? payload.target : undefined;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const source = typeof payload.source === 'string' ? payload.source : undefined;
  const from = typeof payload.from === 'string' ? payload.from : undefined;
  if (event.type === 'delivered' && source && target) {
    return `${sessionLabel(state, source)} → ${sessionLabel(state, target)}`;
  }
  if (from) {
    return sessionLabel(state, from);
  }
  const subject = target ?? sessionId;
  if (subject) {
    return `${sessionLabel(state, subject)}${gateSuffix}`;
  }
  const clusterId = typeof payload.clusterId === 'string' ? payload.clusterId : undefined;
  if (clusterId) {
    return state.clusters[clusterId]?.label ?? compactId(clusterId);
  }
  const targetId = typeof payload.targetId === 'string' ? payload.targetId : undefined;
  if (targetId) {
    return workflowTargetLabel(state, targetId);
  }
  return undefined;
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
    // Synthetic canvas nodes (cluster boundaries, clocks, ring badges)
    // derive their positions; only session nodes persist theirs.
    if (
      node.id.startsWith('cluster:') ||
      node.id.startsWith('timer:') ||
      node.id.startsWith('loop:') ||
      node.id.startsWith('source:') ||
      !isFinitePosition(node.position)
    ) {
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
