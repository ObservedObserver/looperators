import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { AgentEdgeData } from './graph-model';

const edgeLabels = {
  governs: 'governs',
  handoff: 'handoff',
  feedback: 'feedback',
  verdict: 'verdict',
} as const;

function routedPath({
  route,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: {
  route: AgentEdgeData['route'];
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: EdgeProps['sourcePosition'];
  targetPosition: EdgeProps['targetPosition'];
}) {
  if (route === 'direct') {
    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      curvature: 0.32,
    });
    return { path, labelX, labelY };
  }
  if (route === 'lower') {
    const depth = Math.max(sourceY, targetY) + 88;
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX} ${depth}, ${targetX} ${depth}, ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: depth - 8,
    };
  }
  const direction = route === 'right' ? 1 : -1;
  const depth =
    (route === 'right'
      ? Math.max(sourceX, targetX)
      : Math.min(sourceX, targetX)) +
    direction * 96;
  return {
    path: `M ${sourceX} ${sourceY} C ${depth} ${sourceY}, ${depth} ${targetY}, ${targetX} ${targetY}`,
    labelX:
      (route === 'right'
        ? Math.max(sourceX, targetX)
        : Math.min(sourceX, targetX)) -
      direction * 28,
    labelY: (sourceY + targetY) / 2,
  };
}

export function AgentRelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<Edge<AgentEdgeData>>) {
  const edgeData = data as AgentEdgeData;
  const { edge, route, latestReport } = edgeData;
  const { path, labelX, labelY } = routedPath({
    route,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const reportLabel =
    latestReport?.verdict === 'issues'
      ? `${latestReport.issueCount} issues`
      : latestReport?.verdict === 'clean'
        ? 'clean'
        : undefined;
  const displayLabel = edge.label ?? edgeLabels[edge.kind];
  const tooltip = [
    displayLabel,
    edge.summary,
    edge.gate ? `gate ${edge.gate}` : undefined,
    edge.stopWhen,
    edge.pending ? 'pending' : undefined,
  ].filter(Boolean).join('\n');
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className="lag-edge-path"
        data-kind={edge.kind}
        data-active={edge.active ? 'true' : 'false'}
        data-recent={edge.recent ? 'true' : 'false'}
        data-pending={edge.pending ? 'true' : 'false'}
        style={{
          strokeWidth: selected ? 3 : edge.active ? 2.6 : 1.8,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="lag-edge-label nodrag nopan"
          data-kind={edge.kind}
          data-active={edge.active ? 'true' : 'false'}
          data-selected={selected ? 'true' : 'false'}
          data-recent={edge.recent ? 'true' : 'false'}
          data-pending={edge.pending ? 'true' : 'false'}
          data-testid={`graph-edge-${edge.kind}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          aria-label={`Inspect Relationship: ${displayLabel}, ${edge.reportCount} reports`}
          title={tooltip}
          onClick={(event) => {
            event.stopPropagation();
            edgeData.onSelect?.(id);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            edgeData.onSelect?.(id);
          }}
        >
          <strong>{displayLabel}</strong>
          {edge.pending ? <span>pending</span> : null}
          {reportLabel ? <span>{reportLabel}</span> : null}
          {edge.reportCount > 0 ? <span>{edge.reportCount}</span> : null}
          {edge.maxFirings !== undefined ? <span>{edge.firings ?? 0}/{edge.maxFirings}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
