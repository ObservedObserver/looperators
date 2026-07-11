import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, Handle, type Edge, type EdgeProps, type Node, type NodeProps, Position, getBezierPath } from '@xyflow/react';
import { CircleDashed } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { DraftAgentNodeData, DraftEdgeData } from '@/lib/draft-graph-view';

export const DraftAgentNode = memo(function DraftAgentNode({ data, selected }: NodeProps<Node<DraftAgentNodeData>>) {
  return (
    <div
      className={cn(
        'w-[300px] rounded-xl border-2 border-dashed bg-card/95 font-mono shadow-md transition',
        data.issueCount > 0 ? 'border-amber-500/70' : 'border-violet-500/55',
        selected && 'ring-2 ring-violet-400/45',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3.5 !border-2 !border-card !bg-violet-500"
        aria-label={`Connect into Draft ${data.label}`}
      />
      <div className="flex items-center gap-2 border-b border-dashed border-border px-3.5 py-2.5">
        <CircleDashed className="size-3.5 text-violet-500" />
        <span className="rounded border border-violet-500/35 bg-violet-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-violet-700 dark:text-violet-300">
          Draft
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold" title={data.label}>
          {data.label}
        </span>
        <span className="shrink-0 text-[9.5px] text-muted-foreground">{data.providerLabel}</span>
      </div>
      <div className="px-3.5 py-3">
        <p className={cn('line-clamp-3 text-[11px] leading-5', data.prompt ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300')}>
          {data.prompt || 'Add a Prompt before running.'}
        </p>
      </div>
      <div className="flex items-center border-t border-dashed border-border px-3.5 py-2 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        Configure first · no Agent running
        {data.issueCount > 0 ? <span className="ml-auto text-amber-700 dark:text-amber-300">{data.issueCount} missing</span> : null}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-3.5 !border-2 !border-card !bg-violet-500"
        aria-label={`Connect from Draft ${data.label}`}
      />
    </div>
  );
});

export function DraftRelationshipEdge({
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
}: EdgeProps<Edge<DraftEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const edgeData = data as DraftEdgeData;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: '#8b5cf6',
          strokeWidth: selected ? 2.8 : 2.2,
          strokeDasharray: edgeData.returnPath ? '4 5' : '10 5',
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="nodrag nopan pointer-events-auto absolute rounded-md border border-violet-500/40 bg-background/95 px-2 py-1 font-mono text-[10px] leading-4 text-violet-700 shadow-sm dark:text-violet-300"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            zIndex: 40,
          }}
          aria-label={`Edit Draft Relationship: ${edgeData.label}`}
          onClick={(event) => {
            event.stopPropagation();
            edgeData.inspect?.();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            edgeData.inspect?.();
          }}
        >
          <span className="block whitespace-nowrap uppercase tracking-[0.06em]">Draft · {edgeData.label}</span>
          <span className="block max-w-[210px] truncate normal-case tracking-normal text-muted-foreground">{edgeData.detail}</span>
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
