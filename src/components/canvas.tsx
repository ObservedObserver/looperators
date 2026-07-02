import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, Handle, type Edge, type EdgeProps, type Node, type NodeProps, Position, getBezierPath } from '@xyflow/react';
import { Activity, Snowflake } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TermChip } from '@/components/terminal';
import { type AgentNodeData, type GraphEdgeData, type ClusterNodeData, edgeKindClassNames, edgeKindStrokes, edgeDisplayLabel } from '@/lib/graph-view';
import { statusLabels, sessionMarker, statePillBase, nodeStatePillCls } from '@/lib/session-display';
import { formatClock } from '@/lib/format';

export const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  const isMaster = data.role === 'master';
  const marker = sessionMarker(data.status, selected ?? false, data.role);
  const freezeReason = data.freezeReason ?? data.masterReason;
  return (
    <div
      className={cn(
        'w-[300px] rounded-xl border bg-card font-mono shadow-sm transition',
        data.frozen ? 'border-border bg-muted/50 opacity-75' : isMaster ? 'border-term-amber/50' : data.isManaged ? 'border-term-cyan/45' : 'border-border',
        selected && '!border-lime-hi/60 ring-2 ring-lime-hi/50',
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-2.5 !border-0 !bg-lime-hi" />
      <div className="flex items-center gap-2 px-3.5 pb-2.5 pt-3">
        <span className={cn('w-3.5 shrink-0 text-center text-[12px] leading-none', marker.cls)}>{marker.char}</span>
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground" title={data.label}>
          {data.label}
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[9.5px] leading-none text-muted-foreground">{data.agent}</span>
        {data.frozen || isMaster || data.status !== 'idle' ? (
          <span className={cn(statePillBase, nodeStatePillCls(data.status, data.role, data.frozen))}>
            {data.frozen ? 'frozen' : isMaster ? 'master' : statusLabels[data.status].toLowerCase()}
          </span>
        ) : null}
      </div>

      {data.clusterLabel || data.isManaged ? (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-2">
          {data.clusterLabel ? <TermChip>{data.clusterLabel}</TermChip> : null}
          {data.isManaged ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10.5px] leading-none text-cyan-700 dark:text-cyan-300">
              managed
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="px-3.5 pb-3">
        {data.latestVerdict ? (
          <>
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[10.5px] font-semibold tracking-[0.04em]',
                data.latestVerdict === 'clean' ? 'border-lime/30 bg-lime/10 text-lime' : 'border-term-amber/40 bg-term-amber/10 text-term-amber',
              )}
            >
              <span>{data.latestVerdict === 'clean' ? '✓' : '!'}</span>
              <span className="truncate">
                {data.latestVerdict}
                {data.latestReportIssueCount !== undefined ? ` · ${data.latestReportIssueCount} issues` : ''}
              </span>
            </div>
            {data.latestReportSummary ? (
              <p className="mt-1.5 truncate text-[11px] leading-4 text-muted-foreground" title={data.latestReportSummary}>
                {data.latestReportSummary}
              </p>
            ) : null}
          </>
        ) : (
          <div className="rounded-lg border border-border bg-muted/40 px-2.5 py-2">
            <p className="line-clamp-2 break-words text-[11px] leading-5 text-muted-foreground">{data.description}</p>
          </div>
        )}

        {data.frozen ? (
          <div className="mt-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <Snowflake className="size-3" />
              freeze
            </div>
            {freezeReason ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{freezeReason}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
        <Activity className="size-3 text-accent-ink" />
        <span className="tabular-nums text-foreground/80">{data.messageCount}</span>
        msgs
        {data.lastActivityTs ? (
          <span className="ml-auto tabular-nums text-term-faint" title="Last activity">
            {formatClock(data.lastActivityTs)}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!size-2.5 !border-0 !bg-lime-hi" />
    </div>
  );
});

export const ClusterBoundaryNode = memo(function ClusterBoundaryNode({ data }: NodeProps<Node<ClusterNodeData>>) {
  return (
    <div
      className={cn(
        'h-full w-full rounded-xl border border-dashed border-cyan-500/45 bg-cyan-500/[0.04] px-3 py-2.5 font-mono shadow-sm',
        data.frozen && 'border-border bg-muted/30 opacity-70',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
          <span className="opacity-70">❯</span>
          {data.label}
        </span>
        <span className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] tabular-nums text-cyan-700 dark:text-cyan-300">
          {data.nodeCount} managed
        </span>
        {data.masterLabel ? (
          <span className="rounded-md border border-term-amber/30 bg-term-amber/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-term-amber">
            ◆ {data.masterLabel}
          </span>
        ) : null}
        {data.frozen ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            <Snowflake className="size-2.5" />
            frozen
          </span>
        ) : null}
      </div>
      {data.policySummary ? <div className="mt-1.5 text-[10.5px] text-cyan-700/80 dark:text-cyan-300/80">{data.policySummary}</div> : null}
      {data.freezeReason ? <div className="mt-1 line-clamp-1 text-[10.5px] text-muted-foreground">{data.freezeReason}</div> : null}
    </div>
  );
});

export const nodeTypes = {
  agent: AgentNode,
  cluster: ClusterBoundaryNode,
};

export function ReadabilityEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<Edge<GraphEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeData = data as GraphEdgeData;
  const reason = edgeData.freezeReason ?? edgeData.masterReason;
  const visibleDetail = reason ?? edgeData.summary;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: edgeKindStrokes[edgeData.kind],
          strokeWidth: selected ? 2.5 : 1.7,
          strokeDasharray:
            edgeData.kind === 'resume-session'
              ? '6 4'
              : edgeData.kind === 'report'
                ? '2 4'
                : edgeData.kind === 'freeze'
                  ? '8 5'
                  : edgeData.kind === 'link'
                    ? '3 3'
                    : undefined,
          opacity: edgeData.frozen ? 0.55 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            'nodrag nopan pointer-events-auto absolute rounded-md border px-2 py-1 font-mono text-[10px] leading-4 shadow-sm backdrop-blur-sm',
            edgeKindClassNames[edgeData.kind],
            edgeData.recent && 'orrery-edge-label-recent',
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          title={[edgeData.summary, reason].filter(Boolean).join('\n')}
        >
          <div className="flex items-center gap-1.5 whitespace-nowrap uppercase tracking-[0.06em]">
            <span className="tabular-nums opacity-70">#{edgeData.sequence}</span>
            <span>{edgeDisplayLabel(edgeData)}</span>
            {edgeData.verdict ? <span>· {edgeData.verdict}</span> : null}
            {edgeData.issueCount !== undefined ? <span className="tabular-nums">· {edgeData.issueCount} iss</span> : null}
          </div>
          {visibleDetail ? <div className="mt-0.5 max-w-[220px] truncate normal-case tracking-normal opacity-80">{visibleDetail}</div> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = {
  readability: ReadabilityEdge,
};
