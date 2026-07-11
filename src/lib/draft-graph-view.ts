import { MarkerType, type Edge, type Node } from '@xyflow/react';

import type { DraftGraph, DraftValidationIssue } from '@shared/draft-graph';

export type DraftAgentNodeData = {
  draftNodeId: string;
  label: string;
  providerLabel: string;
  prompt: string;
  issueCount: number;
  [key: string]: unknown;
};

export type DraftEdgeData = {
  relationId: string;
  label: string;
  detail: string;
  returnPath?: boolean;
  inspect?: () => void;
  [key: string]: unknown;
};

export function draftCanvasNodes(graph: DraftGraph, issues: DraftValidationIssue[]): Node<DraftAgentNodeData>[] {
  return graph.nodeOrder.flatMap((id) => {
    const node = graph.nodes[id];
    if (!node) return [];
    const endpoint = node.endpoint;
    return [
      {
        id,
        type: 'draft-agent',
        position: node.position,
        zIndex: 30,
        selected: graph.selection?.kind === 'node' && graph.selection.id === id,
        data: {
          draftNodeId: id,
          label: endpoint.kind === 'new' ? endpoint.label || 'Untitled Agent' : `Existing Agent · ${endpoint.sessionId || 'not selected'}`,
          providerLabel: endpoint.kind === 'new' ? endpoint.providerKind : 'existing',
          prompt: endpoint.prompt,
          issueCount: issues.filter((issue) => issue.target === 'node' && issue.id === id).length,
        },
      },
    ];
  });
}

function relationLabel(kind: string) {
  if (kind === 'handoff-once') return 'Handoff once';
  if (kind === 'trigger-on-completion') return 'Trigger on completion';
  return 'Review until clean';
}

export function draftCanvasEdges(graph: DraftGraph): Edge<DraftEdgeData>[] {
  return graph.relationOrder.flatMap((id) => {
    const relation = graph.relations[id];
    if (!relation) return [];
    const base: Edge<DraftEdgeData> = {
      id: `draft-edge:${id}:forward`,
      type: 'draft',
      source: relation.sourceNodeId,
      target: relation.targetNodeId,
      markerEnd: { type: MarkerType.ArrowClosed },
      selected: graph.selection?.kind === 'relation' && graph.selection.id === id,
      zIndex: 20,
      data: {
        relationId: id,
        label: relationLabel(relation.kind),
        detail:
          relation.kind === 'review-loop'
            ? `${relation.review?.blocking.mode ?? 'p0-p1'} · max ${relation.review?.maxLaps ?? 6}`
            : relation.instruction || 'Configure this Relationship',
      },
    };
    if (relation.kind !== 'review-loop') return [base];
    return [
      base,
      {
        ...base,
        id: `draft-edge:${id}:return`,
        source: relation.targetNodeId,
        target: relation.sourceNodeId,
        data: {
          relationId: id,
          label: 'Blocking issues → fix',
          detail: `until clean · max ${relation.review?.maxLaps ?? 6}`,
          returnPath: true,
        },
      },
    ];
  });
}
