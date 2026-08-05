import { MarkerType, Position, type Edge, type Node } from '@xyflow/react';

export const agentGraphStatuses = [
  'draft',
  'running',
  'paused',
  'interrupted',
  'succeeded',
  'capped',
  'cancelled',
  'failed',
] as const;

export const agentGraphNodeStates = [
  'active',
  'waiting',
  'bound',
  'unbound',
  'terminal',
] as const;

export const agentGraphEdgeKinds = [
  'governs',
  'handoff',
  'feedback',
  'verdict',
] as const;

export type AgentGraphStatus = (typeof agentGraphStatuses)[number];
export type AgentGraphNodeState = (typeof agentGraphNodeStates)[number];
export type AgentGraphEdgeKind = (typeof agentGraphEdgeKinds)[number];
export type AgentGraphRole = 'root' | 'implementer' | 'reviewer';
export type AgentGraphOrientation = 'horizontal' | 'vertical';

export type AgentGraphNode = {
  id: string;
  kind: 'root' | 'worker-role';
  role: AgentGraphRole;
  label: string;
  state: AgentGraphNodeState;
  nativeAgentId?: string;
  nativeAgentType?: string;
  runtimeLabel?: string;
  model?: string;
  description?: string;
  activityCount?: number;
  lastActivityAt?: string;
};

export type AgentGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: AgentGraphEdgeKind;
  active: boolean;
  reportCount: number;
  label?: string;
  summary?: string;
  recent?: boolean;
  pending?: boolean;
  gate?: string;
  firings?: number;
  maxFirings?: number;
  stopWhen?: string;
};

export type AgentGraphIssue = {
  message: string;
  severity?: 'info' | 'warn' | 'error';
  file?: string;
  line?: number;
};

export type AgentGraphReport = {
  fromRole: 'implementer' | 'reviewer';
  type: 'info' | 'verdict';
  verdict?: 'issues' | 'clean';
  issueCount: number;
  summary?: string;
  issues?: AgentGraphIssue[];
};

export type AgentGraphPending = {
  role: 'implementer' | 'reviewer';
  kind: 'activate-implementer' | 'activate-reviewer';
  lap: number;
};

export type AgentGraphTimelineItem = {
  id: string;
  at: string;
  label: string;
  kind: 'event' | 'report' | 'transition' | 'governor-decision' | 'recovery';
  role?: 'implementer' | 'reviewer';
};

export type AgentGraphLap = {
  index: number;
  status: 'running' | 'issues' | 'clean' | 'capped' | 'interrupted';
  at?: string;
  implementerSummary?: string;
  reviewerSummary?: string;
  verdict?: 'issues' | 'clean';
  issues: AgentGraphIssue[];
};

export type AgentGraphModel = {
  identity: {
    runId: string;
    revision: number;
    projectionDigest: string;
    integrity: 'verified';
  };
  status: AgentGraphStatus;
  currentLap: number;
  lapCap: number;
  lease: {
    granted: number;
    consumed: number;
  };
  cancelRequested: boolean;
  needsHuman: boolean;
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  pending?: AgentGraphPending;
  latestReport?: AgentGraphReport;
  recovery?: {
    reason: string;
    guidance?: string;
  };
  responsibleRole?: AgentGraphRole;
  stopReason?: string;
  laps?: AgentGraphLap[];
  timeline: AgentGraphTimelineItem[];
};

export type AgentGraphSelection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string };

export type AgentGraphFollowUpKind =
  | 'explain'
  | 'pause'
  | 'resume'
  | 'cancel';

export type AgentGraphFollowUpIntent = {
  kind: AgentGraphFollowUpKind;
  runId: string;
  selection?: AgentGraphSelection;
};

export type AgentNodeData = {
  node: AgentGraphNode;
  latestReport?: AgentGraphReport;
  pending: boolean;
} & Record<string, unknown>;

export type AgentEdgeRoute = 'direct' | 'lower' | 'left' | 'right';

export type AgentEdgeData = {
  edge: AgentGraphEdge;
  route: AgentEdgeRoute;
  latestReport?: AgentGraphReport;
  onSelect?: (edgeId: string) => void;
} & Record<string, unknown>;

export type LoopSummaryData = {
  model: AgentGraphModel;
  onOpen?: () => void;
} & Record<string, unknown>;

const digestPattern = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  path: string,
  options: { max?: number; pattern?: RegExp } = {},
) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > (options.max ?? 256) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new TypeError(`${path} must be a bounded string`);
  }
}

function requireInteger(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
) {
  if (
    !Number.isSafeInteger(value) ||
    (options.min !== undefined && Number(value) < options.min) ||
    (options.max !== undefined && Number(value) > options.max)
  ) {
    throw new TypeError(`${path} must be a bounded integer`);
  }
}

export function assertAgentGraphModel(value: unknown): AgentGraphModel {
  if (!isRecord(value)) {
    throw new TypeError('agent graph model must be an object');
  }
  if (!isRecord(value.identity)) {
    throw new TypeError('agent graph model identity must be an object');
  }
  requireString(value.identity.runId, 'identity.runId', { max: 128 });
  requireInteger(value.identity.revision, 'identity.revision', { min: 0 });
  requireString(value.identity.projectionDigest, 'identity.projectionDigest', {
    max: 64,
    pattern: digestPattern,
  });
  if (value.identity.integrity !== 'verified') {
    throw new TypeError('identity.integrity must be verified');
  }
  if (!agentGraphStatuses.includes(value.status as AgentGraphStatus)) {
    throw new TypeError('agent graph model status is invalid');
  }
  requireInteger(value.currentLap, 'currentLap', { min: 0, max: 6 });
  requireInteger(value.lapCap, 'lapCap', { min: 1, max: 6 });
  if (Number(value.currentLap) > Number(value.lapCap)) {
    throw new TypeError('currentLap cannot exceed lapCap');
  }
  if (!isRecord(value.lease)) {
    throw new TypeError('agent graph model lease must be an object');
  }
  requireInteger(value.lease.granted, 'lease.granted', { min: 0, max: 6 });
  requireInteger(value.lease.consumed, 'lease.consumed', { min: 0, max: 6 });
  if (Number(value.lease.consumed) > Number(value.lease.granted)) {
    throw new TypeError('lease.consumed cannot exceed lease.granted');
  }
  if (
    typeof value.cancelRequested !== 'boolean' ||
    typeof value.needsHuman !== 'boolean'
  ) {
    throw new TypeError('agent graph model flags must be boolean');
  }
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length !== 3 ||
    !Array.isArray(value.edges) ||
    value.edges.length !== 4 ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > 32
  ) {
    throw new TypeError('agent graph model cardinality is invalid');
  }
  const nodeIds = new Set<string>();
  for (const [index, candidate] of value.nodes.entries()) {
    if (!isRecord(candidate)) {
      throw new TypeError(`nodes[${index}] must be an object`);
    }
    requireString(candidate.id, `nodes[${index}].id`, { max: 96 });
    requireString(candidate.label, `nodes[${index}].label`, { max: 80 });
    if (!['root', 'worker-role'].includes(String(candidate.kind))) {
      throw new TypeError(`nodes[${index}].kind is invalid`);
    }
    if (!['root', 'implementer', 'reviewer'].includes(String(candidate.role))) {
      throw new TypeError(`nodes[${index}].role is invalid`);
    }
    if (!agentGraphNodeStates.includes(candidate.state as AgentGraphNodeState)) {
      throw new TypeError(`nodes[${index}].state is invalid`);
    }
    if (nodeIds.has(String(candidate.id))) {
      throw new TypeError('agent graph node ids must be unique');
    }
    nodeIds.add(String(candidate.id));
    for (const key of ['runtimeLabel', 'model', 'description', 'lastActivityAt'] as const) {
      if (candidate[key] !== undefined) {
        requireString(candidate[key], `nodes[${index}].${key}`, { max: 512 });
      }
    }
    if (candidate.activityCount !== undefined) {
      requireInteger(candidate.activityCount, `nodes[${index}].activityCount`, {
        min: 0,
      });
    }
  }
  for (const [index, candidate] of value.edges.entries()) {
    if (!isRecord(candidate)) {
      throw new TypeError(`edges[${index}] must be an object`);
    }
    requireString(candidate.id, `edges[${index}].id`, { max: 96 });
    requireString(candidate.source, `edges[${index}].source`, { max: 96 });
    requireString(candidate.target, `edges[${index}].target`, { max: 96 });
    if (!agentGraphEdgeKinds.includes(candidate.kind as AgentGraphEdgeKind)) {
      throw new TypeError(`edges[${index}].kind is invalid`);
    }
    if (
      !nodeIds.has(String(candidate.source)) ||
      !nodeIds.has(String(candidate.target))
    ) {
      throw new TypeError(`edges[${index}] references an unknown node`);
    }
    if (typeof candidate.active !== 'boolean') {
      throw new TypeError(`edges[${index}].active must be boolean`);
    }
    requireInteger(candidate.reportCount, `edges[${index}].reportCount`, {
      min: 0,
    });
    for (const key of ['label', 'summary', 'gate', 'stopWhen'] as const) {
      if (candidate[key] !== undefined) {
        requireString(candidate[key], `edges[${index}].${key}`, { max: 512 });
      }
    }
    for (const key of ['firings', 'maxFirings'] as const) {
      if (candidate[key] !== undefined) {
        requireInteger(candidate[key], `edges[${index}].${key}`, { min: 0 });
      }
    }
    if (
      (candidate.recent !== undefined && typeof candidate.recent !== 'boolean') ||
      (candidate.pending !== undefined && typeof candidate.pending !== 'boolean')
    ) {
      throw new TypeError(`edges[${index}] flags must be boolean`);
    }
  }
  if (value.latestReport !== undefined) {
    if (!isRecord(value.latestReport)) {
      throw new TypeError('latestReport must be an object');
    }
    if (value.latestReport.summary !== undefined) {
      requireString(value.latestReport.summary, 'latestReport.summary', { max: 1024 });
    }
    if (value.latestReport.issues !== undefined) {
      if (!Array.isArray(value.latestReport.issues) || value.latestReport.issues.length > 32) {
        throw new TypeError('latestReport.issues must be bounded');
      }
      for (const [index, issue] of value.latestReport.issues.entries()) {
        if (!isRecord(issue)) throw new TypeError(`latestReport.issues[${index}] must be an object`);
        requireString(issue.message, `latestReport.issues[${index}].message`, { max: 1024 });
      }
    }
  }
  if (value.laps !== undefined) {
    if (!Array.isArray(value.laps) || value.laps.length > 6) {
      throw new TypeError('laps must be a bounded array');
    }
    for (const [index, lap] of value.laps.entries()) {
      if (!isRecord(lap)) throw new TypeError(`laps[${index}] must be an object`);
      requireInteger(lap.index, `laps[${index}].index`, { min: 0, max: 6 });
      if (!['running', 'issues', 'clean', 'capped', 'interrupted'].includes(String(lap.status))) {
        throw new TypeError(`laps[${index}].status is invalid`);
      }
      if (!Array.isArray(lap.issues) || lap.issues.length > 32) {
        throw new TypeError(`laps[${index}].issues must be bounded`);
      }
    }
  }
  return value as AgentGraphModel;
}

const horizontalPositions: Record<AgentGraphRole, { x: number; y: number }> = {
  root: { x: 30, y: 82 },
  implementer: { x: 370, y: 82 },
  reviewer: { x: 710, y: 82 },
};

const verticalPositions: Record<AgentGraphRole, { x: number; y: number }> = {
  root: { x: 130, y: 22 },
  implementer: { x: 130, y: 232 },
  reviewer: { x: 130, y: 442 },
};

const wideHandles: Record<
  AgentGraphEdgeKind,
  { sourceHandle: string; targetHandle: string; route: AgentEdgeRoute }
> = {
  governs: {
    sourceHandle: 'right-out-upper',
    targetHandle: 'left-in-upper',
    route: 'direct',
  },
  handoff: {
    sourceHandle: 'right-out-upper',
    targetHandle: 'left-in-upper',
    route: 'direct',
  },
  feedback: {
    sourceHandle: 'left-out-lower',
    targetHandle: 'right-in-lower',
    route: 'lower',
  },
  verdict: {
    sourceHandle: 'bottom-out',
    targetHandle: 'bottom-in',
    route: 'lower',
  },
};

const narrowHandles: typeof wideHandles = {
  governs: {
    sourceHandle: 'bottom-out',
    targetHandle: 'top-in',
    route: 'direct',
  },
  handoff: {
    sourceHandle: 'bottom-out',
    targetHandle: 'top-in',
    route: 'direct',
  },
  feedback: {
    sourceHandle: 'right-out-lower',
    targetHandle: 'right-in-lower',
    route: 'right',
  },
  verdict: {
    sourceHandle: 'left-out-lower',
    targetHandle: 'left-in-lower',
    route: 'left',
  },
};

export function createAgentLoopFlowElements(
  modelValue: AgentGraphModel,
  orientation: AgentGraphOrientation,
): {
  nodes: Node<AgentNodeData>[];
  edges: Edge<AgentEdgeData>[];
} {
  const model = assertAgentGraphModel(modelValue);
  const positions =
    orientation === 'horizontal' ? horizontalPositions : verticalPositions;
  const handles = orientation === 'horizontal' ? wideHandles : narrowHandles;
  return {
    nodes: model.nodes.map((node) => ({
      id: node.id,
      type: 'agent-role',
      position: positions[node.role],
      draggable: false,
      selectable: true,
      data: {
        node,
        pending: model.pending?.role === node.role,
        ...(model.latestReport?.fromRole === node.role
          ? { latestReport: model.latestReport }
          : {}),
      },
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      type: 'agent-relationship',
      source: edge.source,
      target: edge.target,
      sourceHandle: handles[edge.kind].sourceHandle,
      targetHandle: handles[edge.kind].targetHandle,
      animated: edge.active,
      focusable: true,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
      },
      data: {
        edge,
        route: handles[edge.kind].route,
        ...(model.latestReport &&
        ((edge.kind === 'feedback' &&
          model.latestReport.verdict === 'issues') ||
          (edge.kind === 'verdict' &&
            model.latestReport.verdict === 'clean'))
          ? { latestReport: model.latestReport }
          : {}),
      },
    })),
  };
}

export function orientationForWidth(width: number): AgentGraphOrientation {
  return width < 720 ? 'vertical' : 'horizontal';
}

export function statusTone(
  status: AgentGraphStatus,
): 'active' | 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'running') return 'active';
  if (status === 'succeeded') return 'success';
  if (['paused', 'interrupted', 'capped'].includes(status)) return 'warning';
  if (['failed', 'cancelled'].includes(status)) return 'danger';
  return 'neutral';
}

export function positionForHandle(handleId: string): Position {
  if (handleId.startsWith('left')) return Position.Left;
  if (handleId.startsWith('right')) return Position.Right;
  if (handleId.startsWith('top')) return Position.Top;
  return Position.Bottom;
}
