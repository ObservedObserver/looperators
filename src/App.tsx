import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  MarkerType,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  Position,
  getBezierPath,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Activity,
  Bot,
  Braces,
  ClipboardCheck,
  CirclePlay,
  FileText,
  GitBranch,
  MessageSquarePlus,
  MessagesSquare,
  Moon,
  Orbit,
  RefreshCw,
  Send,
  Snowflake,
  Square,
  Sun,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  createEmptyGraphState,
  graphStateSchema,
  type AgentMessage,
  type AgentSession,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphState,
  type Report,
  type SessionStatus,
} from '@/shared/graph-state'
import { createDemoGraphState } from '@/shared/demo-state'

type ColorScheme = 'dark' | 'light'

type RailTab = 'orchestrate' | 'sessions' | 'chat'

type AgentNodeData = {
  label: string
  description: string
  agent: string
  role: 'worker' | 'master'
  status: SessionStatus
  messageCount: number
  latestVerdict?: string
  latestReportIssueCount?: number
  latestReportSummary?: string
  frozen?: boolean
  freezeReason?: string
  masterReason?: string
  clusterLabel?: string
  isManaged?: boolean
}

type GraphEdgeData = {
  kind: GraphEdgeKind
  label: string
  sequence: number
  ts: string
  verdict?: string
  issueCount?: number
  summary?: string
  masterReason?: string
  frozen?: boolean
  freezeReason?: string
  recent?: boolean
}

type ActivityEvent = {
  id: string
  kind: GraphEdgeKind | 'report'
  ts: string
  title: string
  detail?: string
  reason?: string
}

type ClusterNodeData = {
  label: string
  nodeCount: number
  masterLabel?: string
  policySummary?: string
  frozen?: boolean
  freezeReason?: string
}

const statusLabels: Record<SessionStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  idle: 'Idle',
  failed: 'Failed',
  killed: 'Killed',
}

const statusClassNames: Record<SessionStatus, string> = {
  pending: 'border-sky-500/70 bg-sky-500/10',
  running: 'border-emerald-500/70 bg-emerald-500/10',
  idle: 'border-zinc-500/70 bg-zinc-500/10',
  failed: 'border-red-500/70 bg-red-500/10',
  killed: 'border-amber-500/70 bg-amber-500/10',
}

const statusDotClassNames: Record<SessionStatus, string> = {
  pending: 'bg-term-amber',
  running: 'bg-term-green',
  idle: 'bg-term-dim2',
  failed: 'bg-term-rose',
  killed: 'bg-term-amber',
}

// Terminal status marker (gutter glyph) for a session row.
function sessionMarker(
  status: SessionStatus,
  isSelected: boolean,
  role: 'worker' | 'master'
): { char: string; cls: string } {
  if (isSelected) return { char: '●', cls: 'text-lime-hi' }
  if (role === 'master') return { char: '◆', cls: 'text-term-amber' }
  switch (status) {
    case 'running':
      return { char: '◌', cls: 'text-term-amber animate-pulse' }
    case 'pending':
      return { char: '◌', cls: 'text-term-amber' }
    case 'failed':
      return { char: '✗', cls: 'text-term-rose' }
    case 'killed':
      return { char: '✗', cls: 'text-term-amber' }
    default:
      return { char: '○', cls: 'text-term-dim2' }
  }
}

const statePillBase =
  'shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]'

function statePillCls(status: SessionStatus, role: 'worker' | 'master') {
  if (role === 'master')
    return 'border-term-amber/30 bg-term-amber/10 text-term-amber'
  switch (status) {
    case 'running':
    case 'pending':
    case 'killed':
      return 'border-term-amber/30 bg-term-amber/10 text-term-amber'
    case 'failed':
      return 'border-term-rose/30 bg-term-rose/10 text-term-rose'
    default:
      return 'border-ink-line bg-white/[0.03] text-term-dim'
  }
}

const edgeKindLabels: Record<GraphEdgeKind, string> = {
  'create-session': 'create',
  'resume-session': 'resume',
  report: 'report',
  freeze: 'freeze',
}

const edgeKindClassNames: Record<GraphEdgeKind, string> = {
  'create-session': 'border-teal-500/40 bg-teal-500/10 text-teal-950 dark:text-teal-100',
  'resume-session':
    'border-amber-500/50 bg-amber-500/10 text-amber-950 dark:text-amber-100',
  report:
    'border-indigo-500/40 bg-indigo-500/10 text-indigo-950 dark:text-indigo-100',
  freeze: 'border-zinc-500/50 bg-zinc-500/10 text-zinc-800 dark:text-zinc-100',
}

const edgeKindStrokes: Record<GraphEdgeKind, string> = {
  'create-session': 'oklch(0.55 0.14 182)',
  'resume-session': 'oklch(0.67 0.16 70)',
  report: 'oklch(0.56 0.18 275)',
  freeze: 'oklch(0.55 0 0)',
}

const defaultPrompt =
  'You are running under Orrery live session verification. Reply with one short sentence confirming this node is a resumable Claude session.'

function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  const isMaster = data.role === 'master'
  return (
    <div
      className={cn(
        'min-w-[260px] max-w-[300px] rounded-lg border bg-card px-4 py-3 shadow-sm transition',
        data.frozen
          ? 'border-zinc-500/60 bg-muted/60 opacity-70 grayscale'
          : statusClassNames[data.status],
        data.isManaged && 'border-cyan-500/70 bg-cyan-500/10',
        isMaster && 'border-amber-500/80 bg-amber-500/10 shadow-amber-500/10',
        selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-background !bg-muted-foreground"
      />
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{data.label}</div>
            <div className="text-[11px] uppercase tracking-normal text-muted-foreground">
              {data.agent}
            </div>
          </div>
        </div>
        <Badge variant="secondary" className="h-5 shrink-0">
          {data.frozen ? 'Frozen' : isMaster ? 'Master' : statusLabels[data.status]}
        </Badge>
      </div>
      {data.clusterLabel || data.isManaged ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {data.clusterLabel ? (
            <Badge variant="outline" className="h-5">
              {data.clusterLabel}
            </Badge>
          ) : null}
          {data.isManaged ? (
            <Badge variant="secondary" className="h-5">
              Managed
            </Badge>
          ) : null}
        </div>
      ) : null}
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
        {data.description}
      </p>
      {data.latestVerdict ? (
        <div className="mt-3 rounded-md border border-border bg-background/70 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-normal">
            <span className="flex min-w-0 items-center gap-1.5">
              <ClipboardCheck className="size-3 shrink-0" />
              <span className="truncate">verdict: {data.latestVerdict}</span>
            </span>
            {data.latestReportIssueCount !== undefined ? (
              <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                {data.latestReportIssueCount} issues
              </Badge>
            ) : null}
          </div>
          {data.latestReportSummary ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
              {data.latestReportSummary}
            </p>
          ) : null}
        </div>
      ) : null}
      {data.frozen ? (
        <div className="mt-3 rounded-md border border-zinc-500/30 bg-background/70 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-normal">
            <Snowflake className="size-3" />
            freeze
          </div>
          {data.freezeReason || data.masterReason ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
              {data.freezeReason ?? data.masterReason}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Activity className="size-3" />
        {data.messageCount} messages
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-background !bg-primary"
      />
    </div>
  )
}

function ClusterBoundaryNode({
  data,
}: NodeProps<Node<ClusterNodeData>>) {
  return (
    <div
      className={cn(
        'h-full w-full rounded-lg border border-dashed border-cyan-500/70 bg-cyan-500/5 px-3 py-2 text-cyan-950 shadow-sm dark:text-cyan-100',
        data.frozen && 'border-zinc-500/60 bg-zinc-500/10 opacity-70 grayscale'
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="border-cyan-500/50 bg-background/80">
          {data.label}
        </Badge>
        <Badge variant="secondary" className="bg-background/80">
          {data.nodeCount} managed
        </Badge>
        {data.masterLabel ? (
          <Badge variant="secondary" className="bg-amber-500/15 text-amber-950 dark:text-amber-100">
            {data.masterLabel}
          </Badge>
        ) : null}
        {data.frozen ? (
          <Badge variant="secondary" className="bg-background/80">
            Frozen
          </Badge>
        ) : null}
      </div>
      {data.policySummary ? (
        <div className="mt-1 text-[11px] text-cyan-900/80 dark:text-cyan-100/80">
          {data.policySummary}
        </div>
      ) : null}
      {data.freezeReason ? (
        <div className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
          {data.freezeReason}
        </div>
      ) : null}
    </div>
  )
}

const nodeTypes = {
  agent: AgentNode,
  cluster: ClusterBoundaryNode,
}

function ReadabilityEdge({
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
  })
  const edgeData = data as GraphEdgeData
  const reason = edgeData.freezeReason ?? edgeData.masterReason

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
                  : undefined,
          opacity: edgeData.frozen ? 0.55 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            'nodrag nopan pointer-events-auto absolute rounded-md border px-2 py-1 text-[10px] leading-4 shadow-sm backdrop-blur-sm',
            edgeKindClassNames[edgeData.kind],
            edgeData.recent && 'orrery-edge-label-recent'
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          title={[edgeData.summary, reason].filter(Boolean).join('\n')}
        >
          <div className="flex items-center gap-1.5 whitespace-nowrap font-medium uppercase tracking-normal">
            <span className="tabular-nums">#{edgeData.sequence}</span>
            <span>{edgeKindLabels[edgeData.kind]}</span>
            {edgeData.verdict ? <span>{edgeData.verdict}</span> : null}
            {edgeData.issueCount !== undefined ? (
              <span>{edgeData.issueCount} issues</span>
            ) : null}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const edgeTypes = {
  readability: ReadabilityEdge,
}

function lastMessagePreview(session: AgentSession | undefined) {
  const message = session?.messages.at(-1)
  if (message?.content) {
    return message.content
  }

  return session?.prompt ?? 'Runtime session'
}

function latestReportForSession(reports: Report[], sessionId: string) {
  return reports
    .filter((report) => report.from === sessionId)
    .sort((left, right) => right.envelope.ts.localeCompare(left.envelope.ts))[0]
}

function loopPolicySummary(cluster: GraphState['clusters'][string]) {
  const verdict = cluster.loopPolicy?.until?.whenReport.verdict
  const maxIterations = cluster.loopPolicy?.maxIterations
  const parts = [
    verdict ? `until verdict=${verdict}` : undefined,
    cluster.loopPolicy?.onStop ? `then ${cluster.loopPolicy.onStop}` : undefined,
    maxIterations ? `max ${maxIterations}` : undefined,
  ].filter(Boolean)

  return parts.length ? parts.join(' · ') : undefined
}

function loopStateStatus(cluster: GraphState['clusters'][string] | undefined) {
  return cluster?.loopState?.status ?? 'stopped'
}

function loopLastEvent(cluster: GraphState['clusters'][string] | undefined) {
  const event = cluster?.loopState?.lastEvent
  if (!event) {
    return 'none'
  }

  return event.sessionId
    ? `${event.type} ${event.sessionId.slice(0, 8)}`
    : event.reportId
      ? `${event.type} ${event.reportId.slice(0, 8)}`
      : event.type
}

function clusterBoundaryNodes(state: GraphState): Node<ClusterNodeData>[] {
  return Object.values(state.clusters).flatMap((cluster) => {
    const managedNodes = cluster.nodeIds
      .map((nodeId) => state.nodes.find((node) => node.nodeId === nodeId))
      .filter((node): node is GraphState['nodes'][number] => Boolean(node))

    if (managedNodes.length === 0) {
      return []
    }

    const nodeWidth = 280
    const nodeHeight = 176
    const padding = 36
    const minX = Math.min(...managedNodes.map((node) => node.position.x)) - padding
    const minY = Math.min(...managedNodes.map((node) => node.position.y)) - padding
    const maxX =
      Math.max(...managedNodes.map((node) => node.position.x + nodeWidth)) +
      padding
    const maxY =
      Math.max(...managedNodes.map((node) => node.position.y + nodeHeight)) +
      padding
    const master = cluster.masterSessionId
      ? state.sessions[cluster.masterSessionId]
      : undefined

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
    ]
  })
}

function reportTitle(report: Report) {
  if (report.payload.type === 'verdict') {
    return `verdict: ${report.payload.verdict}`
  }

  if (report.payload.type === 'relationship') {
    return `relationship: ${report.payload.target}`
  }

  return 'info'
}

function reportBody(report: Report) {
  if (report.payload.type === 'verdict') {
    if (report.payload.summary) {
      return report.payload.summary
    }

    if (report.payload.issues?.length) {
      return report.payload.issues
        .map((issue) => issue.file ? `${issue.message} (${issue.file})` : issue.message)
        .join('\n')
    }

    return 'No issues listed.'
  }

  if (report.payload.type === 'relationship') {
    return report.payload.nature ?? report.payload.sessionRef ?? 'relationship'
  }

  return JSON.stringify(report.payload.payload)
}

function reportIssueCount(report: Report) {
  if (report.payload.type !== 'verdict') {
    return undefined
  }

  return report.payload.issues?.length ?? 0
}

function reportSummary(report: Report) {
  const body = reportBody(report)
  return body.length > 180 ? `${body.slice(0, 177)}...` : body
}

function edgeReason(edge: GraphEdge) {
  return edge.freezeReason ?? edge.masterReason
}

function edgeSummary(edge: GraphEdge, reportsById: Map<string, Report>) {
  if (edge.summary) {
    return edge.summary
  }

  if (edge.reportId) {
    const report = reportsById.get(edge.reportId)
    return report ? reportSummary(report) : undefined
  }

  if (edge.kind === 'freeze') {
    return edge.freezeReason ?? 'freeze requested'
  }

  return undefined
}

function sessionLabel(state: GraphState, sessionId: string) {
  return state.sessions[sessionId]?.label ?? sessionId.slice(0, 8)
}

function activityTitle(kind: ActivityEvent['kind']) {
  if (kind === 'report') {
    return 'report'
  }

  return edgeKindLabels[kind]
}

function activityEvents(state: GraphState): ActivityEvent[] {
  const reportsById = new Map(state.reports.map((report) => [report.id, report]))
  const edgeEvents = state.edges.map((edge) => ({
    id: `edge:${edge.edgeId}`,
    kind: edge.kind,
    ts: edge.ts,
    title: `${sessionLabel(state, edge.source)} -> ${sessionLabel(
      state,
      edge.target
    )}`,
    detail: edgeSummary(edge, reportsById) ?? edge.label ?? edge.kind,
    reason: edgeReason(edge),
  }))
  const reportEvents = state.reports.map((report) => ({
    id: `report:${report.id}`,
    kind: 'report' as const,
    ts: report.envelope.ts,
    title:
      report.payload.type === 'verdict'
        ? `${sessionLabel(state, report.from)} reported ${
            report.payload.verdict
          }`
        : `${sessionLabel(state, report.from)} reported ${report.payload.type}`,
    detail:
      report.payload.type === 'verdict'
        ? `${reportIssueCount(report)} issues · ${reportSummary(report)}`
        : reportSummary(report),
  }))

  return [...edgeEvents, ...reportEvents]
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .slice(-12)
}

function sessionSort(left: AgentSession, right: AgentSession) {
  return right.updatedAt.localeCompare(left.updatedAt)
}

function sameStringList(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  )
}

function ChatMessage({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="mb-1.5 flex items-center gap-2">
        {isUser ? (
          <span className="text-[10px] uppercase tracking-[0.14em] text-term-dim">
            you
          </span>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-term-green shadow-[0_0_8px_#5fd394]" />
            <span className="text-[10px] uppercase tracking-[0.14em] text-term-emerald">
              claude
            </span>
          </>
        )}
        {isStreaming ? (
          <span className="text-[10px] text-term-amber">streaming</span>
        ) : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">
          {message.ts.slice(11, 19)}
        </span>
      </div>
      {isUser ? (
        <div className="flex gap-2 text-[13px] leading-6">
          <span className="shrink-0 text-lime-hi">❯</span>
          <span className="whitespace-pre-wrap break-words text-[#cfd6dd]">
            {message.content}
          </span>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-term-name">
          {message.content}
          {isStreaming ? <span className="orrery-caret ml-1" /> : null}
        </div>
      )}
    </div>
  )
}

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'orchestrate', label: 'Orchestrate', icon: Orbit },
  { id: 'sessions', label: 'Sessions', icon: Terminal },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
]

function OrreryMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background text-primary',
        className
      )}
    >
      <svg viewBox="0 0 32 32" className="size-6" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="9" stroke="currentColor" strokeOpacity="0.22" />
        <circle cx="16" cy="16" r="5.3" stroke="currentColor" strokeOpacity="0.16" />
        <circle cx="16" cy="16" r="2.4" fill="currentColor" />
        <g className="orrery-orbit">
          <circle cx="25" cy="16" r="1.8" fill="currentColor" />
        </g>
        <g className="orrery-orbit-rev">
          <circle cx="10.7" cy="16" r="1.3" fill="currentColor" fillOpacity="0.75" />
        </g>
      </svg>
    </span>
  )
}

function TabHeading({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="truncate text-sm font-semibold tracking-tight">{title}</h3>
        {hint ? (
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
      {action ?? null}
    </div>
  )
}

const demoMode =
  typeof window !== 'undefined' &&
  !window.orrery &&
  new URLSearchParams(window.location.search).has('demo')

function App() {
  const [runtimeState, setRuntimeState] = useState<GraphState>(
    demoMode ? createDemoGraphState : createEmptyGraphState
  )
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(
    demoMode ? 'sess-p1-accept' : undefined
  )
  const [activeTab, setActiveTab] = useState<RailTab>(
    demoMode ? 'chat' : 'orchestrate'
  )
  const [newPrompt, setNewPrompt] = useState(defaultPrompt)
  const [message, setMessage] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  const [isUpdatingCluster, setIsUpdatingCluster] = useState(false)
  const [isCreatingMaster, setIsCreatingMaster] = useState(false)
  const [isStartingLoop, setIsStartingLoop] = useState(false)
  const [isStoppingLoop, setIsStoppingLoop] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string>()
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<string[]>([])
  const [activeClusterId, setActiveClusterId] = useState<string>()
  const [clusterLabel, setClusterLabel] = useState('Review loop')
  const [maxIterations, setMaxIterations] = useState('6')
  const [masterPrompt, setMasterPrompt] = useState(
    'You are the Orrery master for this cluster. Help author and later run a review loop: create or resume worker sessions through the Orrery membrane, read verdict reports, and stop when verdict=clean then freeze.'
  )
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => {
    if (typeof window === 'undefined') {
      return 'dark'
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })
  const runtimeApi = typeof window === 'undefined' ? undefined : window.orrery
  const isElectron = useMemo(() => Boolean(runtimeApi), [runtimeApi])

  const selectedSession = selectedSessionId
    ? runtimeState.sessions[selectedSessionId]
    : undefined
  const selectedNode = selectedSessionId
    ? runtimeState.nodes.find((node) => node.sessionId === selectedSessionId)
    : undefined
  const selectedSessionFrozen =
    selectedNode?.frozen === true ||
    (selectedNode?.clusterId
      ? runtimeState.clusters[selectedNode.clusterId]?.frozen === true
      : false)
  const selectedReports = selectedSessionId
    ? runtimeState.reports
        .filter((report) => report.from === selectedSessionId)
        .sort((left, right) => right.envelope.ts.localeCompare(left.envelope.ts))
    : []
  const sessions = Object.values(runtimeState.sessions).sort(sessionSort)
  const runningSessions = sessions.filter(
    (session) => session.status === 'running' || session.status === 'pending'
  )
  const reportsById = useMemo(
    () => new Map(runtimeState.reports.map((report) => [report.id, report])),
    [runtimeState.reports]
  )
  const graphActivity = useMemo(
    () => activityEvents(runtimeState),
    [runtimeState]
  )
  const clusters = Object.values(runtimeState.clusters).sort((left, right) =>
    left.label.localeCompare(right.label)
  )
  const activeCluster = activeClusterId
    ? runtimeState.clusters[activeClusterId]
    : undefined
  const activeLoopStatus = loopStateStatus(activeCluster)
  const activeLoopIterations = activeCluster?.loopState?.iterations ?? 0
  const activeLoopMaxIterations = activeCluster?.loopPolicy?.maxIterations ?? 6
  const activeLoopReason = activeCluster?.loopState?.reason
  const activeLoopLastEvent = loopLastEvent(activeCluster)
  const selectedSessionIsMaster = selectedSession?.role === 'master'
  const canResume =
    Boolean(selectedSession) &&
    selectedSession?.status !== 'running' &&
    selectedSession?.status !== 'pending' &&
    selectedSession?.status !== 'killed' &&
    !selectedSessionFrozen
  const canKill =
    selectedSession?.status === 'running' || selectedSession?.status === 'pending'
  const canStartLoop =
    Boolean(activeCluster) &&
    Boolean(activeCluster?.masterSessionId) &&
    Boolean(activeCluster?.loopPolicy) &&
    activeLoopStatus !== 'running' &&
    activeCluster?.frozen !== true
  const canStopLoop = Boolean(activeCluster) && activeLoopStatus === 'running'

  const nodes: Node[] = useMemo(
    () => [
      ...clusterBoundaryNodes(runtimeState),
      ...runtimeState.nodes.map((node) => {
        const session = runtimeState.sessions[node.sessionId]
        const cluster = node.clusterId
          ? runtimeState.clusters[node.clusterId]
          : undefined
        const latestReport = latestReportForSession(
          runtimeState.reports,
          node.sessionId
        )
        const latestVerdict =
          latestReport?.payload.type === 'verdict'
            ? latestReport.payload.verdict
            : undefined
        const latestIssueCount = latestReport
          ? reportIssueCount(latestReport)
          : undefined
        return {
          id: node.nodeId,
          type: 'agent',
          position: node.position,
          zIndex: node.role === 'master' ? 20 : 10,
          data: {
            label: node.label,
            description: lastMessagePreview(session),
            agent: node.agent,
            role: node.role,
            status: node.status,
            messageCount: session?.messages.length ?? 0,
            latestVerdict,
            latestReportIssueCount: latestIssueCount,
            latestReportSummary: latestReport
              ? reportSummary(latestReport)
              : undefined,
            frozen: node.frozen,
            freezeReason: node.freezeReason,
            masterReason: node.masterReason,
            clusterLabel: cluster?.label,
            isManaged: Boolean(cluster?.nodeIds.includes(node.nodeId)),
          },
        }
      }),
    ],
    [runtimeState]
  )

  const edges: Edge[] = useMemo(
    () => {
      const sorted = [...runtimeState.edges].sort((left, right) =>
        left.ts.localeCompare(right.ts)
      )
      const sequenceById = new Map(
        sorted.map((edge, index) => [edge.edgeId, index + 1])
      )
      const recentEdgeIds = new Set(sorted.slice(-3).map((edge) => edge.edgeId))

      return runtimeState.edges.map((edge) => {
        const report = edge.reportId ? reportsById.get(edge.reportId) : undefined
        return {
          id: edge.edgeId,
          type: 'readability',
          source: edge.source,
          target: edge.target,
          animated:
            edge.kind === 'create-session' || edge.kind === 'resume-session',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            kind: edge.kind,
            label: edge.label ?? edge.kind,
            sequence: sequenceById.get(edge.edgeId) ?? 0,
            ts: edge.ts,
            verdict:
              edge.verdict ??
              (report?.payload.type === 'verdict'
                ? report.payload.verdict
                : undefined),
            issueCount:
              edge.issueCount ?? (report ? reportIssueCount(report) : undefined),
            summary: edgeSummary(edge, reportsById),
            masterReason: edge.masterReason,
            frozen: edge.frozen,
            freezeReason: edge.freezeReason,
            recent: recentEdgeIds.has(edge.edgeId),
          },
        }
      })
    },
    [reportsById, runtimeState.edges]
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', colorScheme === 'dark')
  }, [colorScheme])

  useEffect(() => {
    if (!activeCluster) {
      return
    }

    setClusterLabel(activeCluster.label)
    setMaxIterations(String(activeCluster.loopPolicy?.maxIterations ?? 6))
  }, [activeCluster])

  useEffect(() => {
    if (!window.orrery?.runtime) {
      return
    }

    let isMounted = true
    window.orrery.runtime
      .getState()
      .then((state) => {
        if (isMounted) {
          setRuntimeState(state)
          setSelectedSessionId((current) => current ?? state.nodes[0]?.sessionId)
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        }
      })

    const unsubscribe = window.orrery.runtime.onEvent((event) => {
      setRuntimeState(event.state)
      if (event.type === 'session.created' || event.type === 'session.resumed') {
        setSelectedSessionId(event.sessionId)
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const createSession = useCallback(async () => {
    if (!window.orrery?.runtime) {
      setRuntimeError('Runtime is available only inside Electron.')
      return
    }

    setIsCreating(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.createSession({
        prompt: newPrompt,
        agent: 'claude-code',
        label: `Claude ${sessions.length + 1}`,
      })
      setRuntimeState(result.state)
      setSelectedSessionId(result.sessionId)
      setActiveTab('chat')
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCreating(false)
    }
  }, [newPrompt, sessions.length])

  const resumeSelectedSession = useCallback(async () => {
    if (!window.orrery?.runtime || !selectedSessionId) {
      return
    }

    const trimmed = message.trim()
    if (trimmed.length === 0) {
      return
    }

    setIsResuming(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.resumeSession({
        sessionId: selectedSessionId,
        message: trimmed,
      })
      setRuntimeState(result.state)
      setMessage('')
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsResuming(false)
    }
  }, [message, selectedSessionId])

  const killSelectedSession = useCallback(async () => {
    if (!window.orrery?.runtime || !selectedSessionId) {
      return
    }

    try {
      const result = await window.orrery.runtime.killSession(selectedSessionId)
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    }
  }, [selectedSessionId])

  const currentLoopPolicy = useCallback(() => {
    const parsedMaxIterations = Number(maxIterations)
    return {
      until: { whenReport: { verdict: 'clean' } },
      onStop: 'freeze' as const,
      maxIterations:
        Number.isInteger(parsedMaxIterations) && parsedMaxIterations > 0
          ? parsedMaxIterations
          : 6,
    }
  }, [maxIterations])

  const selectedManagedNodeIds = useMemo(() => {
    const canvasSelection = selectedCanvasNodeIds.filter((nodeId) => {
      const session = runtimeState.sessions[nodeId]
      return session && session.role !== 'master'
    })

    if (canvasSelection.length > 0) {
      return canvasSelection
    }

    if (selectedSession && selectedSession.role !== 'master') {
      return [selectedSession.sessionId]
    }

    return []
  }, [runtimeState.sessions, selectedCanvasNodeIds, selectedSession])

  const upsertManagedCluster = useCallback(async () => {
    if (!window.orrery?.runtime) {
      setRuntimeError('Runtime is available only inside Electron.')
      return
    }

    if (selectedManagedNodeIds.length === 0) {
      setRuntimeError('Select at least one worker node for the cluster.')
      return
    }

    setIsUpdatingCluster(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.upsertCluster({
        clusterId: activeClusterId,
        label: clusterLabel,
        nodeIds: selectedManagedNodeIds,
        loopPolicy: currentLoopPolicy(),
      })
      setRuntimeState(result.state)
      setActiveClusterId(result.clusterId)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsUpdatingCluster(false)
    }
  }, [
    activeClusterId,
    clusterLabel,
    currentLoopPolicy,
    selectedManagedNodeIds,
  ])

  const saveLoopPolicy = useCallback(async () => {
    if (!window.orrery?.runtime || !activeClusterId) {
      return
    }

    setIsUpdatingCluster(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.setClusterLoopPolicy({
        clusterId: activeClusterId,
        loopPolicy: currentLoopPolicy(),
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsUpdatingCluster(false)
    }
  }, [activeClusterId, currentLoopPolicy])

  const createMasterForCluster = useCallback(async () => {
    if (!window.orrery?.runtime || !activeClusterId) {
      return
    }

    setIsCreatingMaster(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.createMasterForCluster({
        clusterId: activeClusterId,
        prompt: masterPrompt,
        label: `${runtimeState.clusters[activeClusterId]?.label ?? 'Cluster'} Master`,
        loopPolicy: currentLoopPolicy(),
      })
      setRuntimeState(result.state)
      setSelectedSessionId(result.sessionId)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCreatingMaster(false)
    }
  }, [activeClusterId, currentLoopPolicy, masterPrompt, runtimeState.clusters])

  const assignSelectedAsMaster = useCallback(async () => {
    if (!window.orrery?.runtime || !activeClusterId || !selectedSessionId) {
      return
    }

    setIsCreatingMaster(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.assignMasterToCluster({
        clusterId: activeClusterId,
        sessionId: selectedSessionId,
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCreatingMaster(false)
    }
  }, [activeClusterId, selectedSessionId])

  const startMasterLoop = useCallback(async () => {
    if (!window.orrery?.runtime || !activeClusterId) {
      return
    }

    setIsStartingLoop(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.startMasterLoop({
        clusterId: activeClusterId,
        reason: 'Loop started from Orrery controls.',
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsStartingLoop(false)
    }
  }, [activeClusterId])

  const stopMasterLoop = useCallback(async () => {
    if (!window.orrery?.runtime || !activeClusterId) {
      return
    }

    setIsStoppingLoop(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.stopMasterLoop({
        clusterId: activeClusterId,
        reason: 'Loop killed from Orrery controls.',
        killRunning: true,
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsStoppingLoop(false)
    }
  }, [activeClusterId])

  const updateCanvasSelection = useCallback(
    ({ nodes: selectedNodes }: { nodes: Node[] }) => {
      const nextSelection = selectedNodes
        .map((node) => node.id)
        .filter((nodeId) => !nodeId.startsWith('cluster:'))

      setSelectedCanvasNodeIds((previousSelection) =>
        sameStringList(previousSelection, nextSelection)
          ? previousSelection
          : nextSelection
      )
    },
    []
  )

  return (
    <TooltipProvider>
      <main className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <aside className="orrery-sidebar flex h-dvh min-h-0 w-[min(440px,100vw)] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar">
          <header
            className={cn(
              'app-region-drag flex shrink-0 items-center justify-between gap-3 px-4 py-3',
              isElectron && 'pt-9'
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <OrreryMark />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold leading-tight">
                  Orrery
                </h1>
                <p className="truncate font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                  P3 master loops
                </p>
              </div>
            </div>
            <Badge
              variant={isElectron ? 'outline' : 'destructive'}
              className="shrink-0"
            >
              {isElectron ? 'electron' : 'web only'}
            </Badge>
          </header>

          <div className="app-region-no-drag shrink-0 px-3 pb-3 pt-1">
            <div
              className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-background/60 p-1"
            >
              {railTabs.map((tab) => {
                const isActive = activeTab === tab.id
                const TabIcon = tab.icon
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'relative flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-mono text-xs font-medium transition-colors',
                      isActive
                        ? 'bg-accent-ink/12 text-accent-ink ring-1 ring-inset ring-accent-ink/30'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <TabIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{tab.label}</span>
                    {tab.id === 'sessions' && sessions.length ? (
                      <span className="tabular-nums text-[10px] opacity-70">
                        {sessions.length}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>

          {runtimeError ? (
            <div className="app-region-no-drag mx-3 mb-2 shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
              {runtimeError}
            </div>
          ) : null}

          <div className="app-region-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === 'orchestrate' ? (
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
                <section className="space-y-2.5">
                  <TabHeading icon={CirclePlay} title="New session" />
                  <textarea
                    id="new-session-prompt"
                    className="min-h-20 max-h-40 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-ring"
                    value={newPrompt}
                    onChange={(event) => setNewPrompt(event.target.value)}
                  />
                  <Button
                    className="w-full justify-center"
                    disabled={
                      !isElectron || isCreating || newPrompt.trim().length === 0
                    }
                    onClick={createSession}
                  >
                    <CirclePlay className="size-4" />
                    Start Claude Session
                  </Button>
                </section>

                <Separator />

                <section className="space-y-3">
                  <TabHeading
                    icon={Orbit}
                    title="Cluster"
                    hint={`${selectedManagedNodeIds.length} ${
                      selectedManagedNodeIds.length === 1 ? 'node' : 'nodes'
                    } selected`}
                    action={
                      <Badge variant="outline" className="shrink-0">
                        {clusters.length}{' '}
                        {clusters.length === 1 ? 'cluster' : 'clusters'}
                      </Badge>
                    }
                  />

                  <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
                    <label className="min-w-0 space-y-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Cluster
                      </span>
                      <input
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none transition focus:ring-2 focus:ring-ring"
                        value={clusterLabel}
                        onChange={(event) => setClusterLabel(event.target.value)}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Max iter
                      </span>
                      <input
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none transition focus:ring-2 focus:ring-ring"
                        inputMode="numeric"
                        min={1}
                        max={100}
                        type="number"
                        value={maxIterations}
                        onChange={(event) => setMaxIterations(event.target.value)}
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">until verdict=clean</Badge>
                    <Badge variant="secondary">onStop freeze</Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      className="min-w-0 justify-start"
                      variant="outline"
                      disabled={
                        !isElectron ||
                        isUpdatingCluster ||
                        selectedManagedNodeIds.length === 0
                      }
                      onClick={upsertManagedCluster}
                    >
                      <GitBranch className="size-4 shrink-0" />
                      <span className="truncate">Save Cluster</span>
                    </Button>
                    <Button
                      className="min-w-0 justify-start"
                      variant="outline"
                      disabled={
                        !isElectron || isUpdatingCluster || !activeClusterId
                      }
                      onClick={saveLoopPolicy}
                    >
                      <ClipboardCheck className="size-4 shrink-0" />
                      <span className="truncate">Save Policy</span>
                    </Button>
                  </div>
                </section>

                <section className="space-y-2.5">
                  <TabHeading icon={Bot} title="Master" />
                  <textarea
                    className="min-h-16 max-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs leading-5 outline-none transition focus:ring-2 focus:ring-ring"
                    value={masterPrompt}
                    onChange={(event) => setMasterPrompt(event.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      className="min-w-0 justify-start"
                      disabled={
                        !isElectron || isCreatingMaster || !activeClusterId
                      }
                      onClick={createMasterForCluster}
                    >
                      <Bot className="size-4 shrink-0" />
                      <span className="truncate">
                        {activeCluster?.masterSessionId
                          ? 'Open Master'
                          : 'Start Master'}
                      </span>
                    </Button>
                    <Button
                      className="min-w-0 justify-start"
                      variant="outline"
                      disabled={
                        !isElectron ||
                        isCreatingMaster ||
                        !activeClusterId ||
                        !selectedSession ||
                        selectedSessionIsMaster
                      }
                      onClick={assignSelectedAsMaster}
                    >
                      <MessageSquarePlus className="size-4 shrink-0" />
                      <span className="truncate">Assign Master</span>
                    </Button>
                  </div>
                </section>

                <section className="space-y-2.5">
                  <TabHeading
                    icon={Activity}
                    title="Loop"
                    action={
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Badge
                          variant={
                            activeLoopStatus === 'running'
                              ? 'default'
                              : 'secondary'
                          }
                        >
                          {activeLoopStatus}
                        </Badge>
                        <Badge variant="outline">
                          iter {activeLoopIterations}/{activeLoopMaxIterations}
                        </Badge>
                        {activeCluster?.frozen ? (
                          <Badge variant="secondary">
                            <Snowflake className="size-3" />
                            frozen
                          </Badge>
                        ) : null}
                      </div>
                    }
                  />
                  <div className="space-y-2.5 rounded-lg border border-border bg-background/60 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        className="min-w-0 justify-start"
                        disabled={!isElectron || isStartingLoop || !canStartLoop}
                        onClick={startMasterLoop}
                      >
                        <CirclePlay className="size-4 shrink-0" />
                        <span className="truncate">Run Loop</span>
                      </Button>
                      <Button
                        className="min-w-0 justify-start"
                        variant="outline"
                        disabled={!isElectron || isStoppingLoop || !canStopLoop}
                        onClick={stopMasterLoop}
                      >
                        <Square className="size-4 shrink-0" />
                        <span className="truncate">Stop Loop</span>
                      </Button>
                    </div>
                    <div className="space-y-1 text-[11px] leading-4 text-muted-foreground">
                      <div className="truncate">last: {activeLoopLastEvent}</div>
                      {activeLoopReason ? (
                        <div className="line-clamp-2 break-words">
                          reason: {activeLoopReason}
                        </div>
                      ) : null}
                      {activeCluster?.freezeReason ? (
                        <div className="line-clamp-2 break-words">
                          freeze: {activeCluster.freezeReason}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>

                {clusters.length ? (
                  <section className="space-y-2">
                    <TabHeading icon={GitBranch} title="Clusters" />
                    <div className="space-y-1.5">
                      {clusters.map((cluster) => (
                        <button
                          key={cluster.clusterId}
                          type="button"
                          className={cn(
                            'w-full rounded-md border border-border bg-background/60 px-2.5 py-2 text-left transition hover:bg-accent',
                            activeClusterId === cluster.clusterId &&
                              'border-primary/70 bg-primary/5'
                          )}
                          onClick={() => {
                            setActiveClusterId(cluster.clusterId)
                            if (cluster.masterSessionId) {
                              setSelectedSessionId(cluster.masterSessionId)
                            }
                          }}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium">
                              {cluster.label}
                            </span>
                            <Badge variant="secondary" className="shrink-0">
                              {cluster.nodeIds.length}
                            </Badge>
                          </div>
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            {loopPolicySummary(cluster) ?? 'No policy'}
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {activeTab === 'sessions' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="shrink-0 px-4 pb-2.5 pt-3 font-mono">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-lime-hi">❯</span>
                    <span className="text-foreground">orrery sessions</span>
                    <span className="text-accent-ink">--watch</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {runningSessions.length} running · {sessions.length} total
                    </span>
                  </div>
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                  {sessions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-ink-line bg-ink p-5 text-center font-mono text-sm text-term-dim2">
                      No sessions yet. Start one from the Orchestrate tab.
                    </div>
                  ) : null}

                  {sessions.map((session) => {
                    const latestReport = latestReportForSession(
                      runtimeState.reports,
                      session.sessionId
                    )
                    const latestVerdict =
                      latestReport?.payload.type === 'verdict'
                        ? latestReport.payload.verdict
                        : undefined

                    const isSel = selectedSessionId === session.sessionId
                    const marker = sessionMarker(
                      session.status,
                      isSel,
                      session.role
                    )
                    const idLabel =
                      session.backendSessionId ?? session.sessionId

                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        className={cn(
                          'relative w-full rounded-lg border bg-ink p-3 pl-3.5 text-left font-mono transition',
                          isSel
                            ? 'border-lime-hi/50 ring-1 ring-lime-hi/25'
                            : 'border-ink-line hover:border-white/20'
                        )}
                        onClick={() => {
                          setSelectedSessionId(session.sessionId)
                          setActiveTab('chat')
                        }}
                      >
                        {isSel ? (
                          <span className="absolute bottom-2.5 left-0 top-2.5 w-0.5 rounded-full bg-lime-hi" />
                        ) : null}
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              'w-3.5 shrink-0 text-center text-[12px] leading-none',
                              marker.cls
                            )}
                          >
                            {marker.char}
                          </span>
                          <span
                            className={cn(
                              'flex-1 truncate text-[13px] font-medium',
                              isSel ? 'text-lime-hi' : 'text-lime'
                            )}
                          >
                            {session.label}
                          </span>
                          <span
                            className={cn(
                              statePillBase,
                              statePillCls(session.status, session.role)
                            )}
                          >
                            {session.role === 'master'
                              ? 'master'
                              : statusLabels[session.status].toLowerCase()}
                          </span>
                        </div>
                        <div className="mt-2 space-y-0.5 text-[11.5px]">
                          <div className="flex gap-2">
                            <span className="text-term-faint">├</span>
                            <span className="w-[52px] shrink-0 text-term-dim2">
                              id
                            </span>
                            <span className="truncate text-term-cyan">
                              {idLabel}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <span className="text-term-faint">├</span>
                            <span className="w-[52px] shrink-0 text-term-dim2">
                              agent
                            </span>
                            <span className="text-term-dim">{session.agent}</span>
                          </div>
                          <div className="flex gap-2">
                            <span className="text-term-faint">└</span>
                            <span className="w-[52px] shrink-0 text-term-dim2">
                              io
                            </span>
                            <span className="text-term-dim">
                              <span className="text-term-cyan">
                                {session.messages.length}
                              </span>{' '}
                              msgs · updated {session.updatedAt.slice(11, 16)}
                            </span>
                          </div>
                        </div>
                        {latestVerdict ? (
                          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-term-dim2">
                            <ClipboardCheck className="size-3 shrink-0" />
                            <span className="truncate">
                              verdict{' '}
                              <span className="text-term-green">
                                {latestVerdict}
                              </span>
                            </span>
                          </div>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {activeTab === 'chat' ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b border-border bg-card px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      Selected session
                    </span>
                    {selectedSession ? (
                      <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                        <span
                          className={cn(
                            'size-1.5 rounded-full',
                            statusDotClassNames[selectedSession.status]
                          )}
                        />
                        {statusLabels[selectedSession.status]}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <h2 className="truncate text-[15px] font-semibold">
                      {selectedSession?.label ?? 'No session selected'}
                    </h2>
                    {selectedSession ? (
                      <span className="shrink-0 font-mono text-xs text-accent-ink">
                        {selectedSession.agent}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] leading-5 text-muted-foreground">
                    {selectedSession ? (
                      <>
                        marker{' '}
                        <span className="text-accent-ink">
                          {selectedSession.backendSessionId ??
                            selectedSession.sessionId}
                        </span>
                      </>
                    ) : (
                      'Select a node on the graph or a session.'
                    )}
                  </p>
                  <div
                    className="relative mt-2.5 h-2 overflow-hidden opacity-60"
                    style={{
                      backgroundImage:
                        'repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 13px)',
                      WebkitMaskImage:
                        'linear-gradient(90deg, #000 55%, transparent)',
                    }}
                  >
                    <span className="absolute left-[38%] top-0 h-full w-px bg-primary" />
                  </div>
                  {selectedReports.length ? (
                    <div className="mt-3 max-h-36 space-y-2 overflow-y-auto pr-1">
                      {selectedReports.slice(0, 3).map((report) => (
                        <div
                          key={report.id}
                          className="rounded-md border border-border bg-background/70 p-2"
                        >
                          <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
                            <ClipboardCheck className="size-3 shrink-0" />
                            <span className="truncate">
                              {reportTitle(report)}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                            {reportBody(report)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
                  <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-ink-line-2 bg-ink px-4 py-2.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                      session transcript
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] tabular-nums text-term-faint">
                      {selectedSession?.messages.length ?? 0} messages
                    </span>
                  </div>
                  {selectedSession?.messages.length ? (
                    selectedSession.messages.map((item) => (
                      <ChatMessage key={item.id} message={item} />
                    ))
                  ) : (
                    <div className="m-3.5 rounded-lg border border-dashed border-ink-line p-5 text-center font-mono text-sm text-term-dim2">
                      No chat history.
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-border bg-card p-2.5">
                  <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-ink-line bg-ink px-3 py-2.5 transition focus-within:border-lime-hi/55 focus-within:ring-1 focus-within:ring-lime-hi/25">
                    <span className="pt-0.5 font-mono text-lime-hi">❯</span>
                    <textarea
                      className="max-h-28 min-h-9 w-full resize-y bg-transparent font-mono text-[13px] leading-6 text-term-name outline-none placeholder:text-term-faint disabled:opacity-60"
                      placeholder="Message selected session"
                      value={message}
                      disabled={!selectedSession || !canResume || isResuming}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Button
                      className="app-region-no-drag min-w-0 justify-center font-mono text-[12px] uppercase tracking-[0.08em]"
                      disabled={
                        !selectedSession ||
                        !canResume ||
                        isResuming ||
                        message.trim().length === 0
                      }
                      onClick={resumeSelectedSession}
                    >
                      <Send className="size-4 shrink-0" />
                      <span className="truncate">Resume session</span>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          className="app-region-no-drag"
                          variant="destructive"
                          size="icon"
                          disabled={!selectedSession || !canKill}
                          aria-label="Kill selected session"
                          onClick={killSelectedSession}
                        >
                          <Square className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Kill selected session</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <footer className="app-region-no-drag flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 font-mono text-[11px] tracking-[0.02em] text-muted-foreground">
            <span className="flex items-center gap-1.5" title="Running sessions">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  runningSessions.length
                    ? 'bg-emerald-500'
                    : 'bg-muted-foreground/40'
                )}
              />
              <span className="tabular-nums text-foreground/80">
                {runningSessions.length}
              </span>
              running
            </span>
            <Separator orientation="vertical" className="h-3" />
            <span className="flex items-center gap-1" title="Graph edges">
              <GitBranch className="size-3" />
              <span className="tabular-nums">{runtimeState.edges.length}</span>
            </span>
            <span className="flex items-center gap-1" title="Reports">
              <FileText className="size-3" />
              <span className="tabular-nums">{runtimeState.reports.length}</span>
            </span>
            <span className="ml-auto flex items-center gap-2.5">
              <span
                className="flex items-center gap-1"
                title={`Graph schema v${graphStateSchema.version}`}
              >
                <Braces className="size-3" />
                <span className="text-accent-ink">
                  v{graphStateSchema.version}
                </span>
              </span>
              <span
                className="flex items-center gap-1 tabular-nums"
                title="Last updated"
              >
                <RefreshCw className="size-3" />
                {runtimeState.updatedAt.slice(11, 19)}
              </span>
            </span>
          </footer>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex min-w-0 items-center gap-3">
              <Badge variant="outline" className="gap-1.5">
                <Activity className="size-3" />
                Runtime graph
              </Badge>
              <p className="truncate text-sm text-muted-foreground">
                nodeId === sessionId
              </p>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Switch to ${
                    colorScheme === 'dark' ? 'light' : 'dark'
                  } mode`}
                  onClick={() =>
                    setColorScheme((current) =>
                      current === 'dark' ? 'light' : 'dark'
                    )
                  }
                >
                  {colorScheme === 'dark' ? (
                    <Sun className="size-4" />
                  ) : (
                    <Moon className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}
              </TooltipContent>
            </Tooltip>
          </header>

          <div className="relative min-h-0 flex-1">
            <div className="pointer-events-none absolute bottom-4 left-16 z-10 w-[340px] max-w-[calc(100%-5rem)]">
              <div className="pointer-events-auto rounded-lg border border-border bg-background/92 p-3 shadow-sm backdrop-blur">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                    <h2 className="truncate text-xs font-medium uppercase tracking-normal text-muted-foreground">
                      Graph events
                    </h2>
                  </div>
                  <Badge variant="secondary">{graphActivity.length}</Badge>
                </div>

                {graphActivity.length === 0 ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    No graph events yet.
                  </p>
                ) : (
                  <ol className="max-h-[240px] space-y-2 overflow-y-auto pr-1">
                    {graphActivity.map((event, index) => (
                      <li
                        key={event.id}
                        className="grid grid-cols-[auto_1fr] gap-2 text-xs"
                      >
                        <Badge
                          variant="outline"
                          className="h-5 min-w-8 justify-center px-1.5 text-[10px] tabular-nums"
                        >
                          {index + 1}
                        </Badge>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={cn(
                                'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-normal',
                                event.kind === 'report'
                                  ? edgeKindClassNames.report
                                  : edgeKindClassNames[event.kind]
                              )}
                            >
                              {activityTitle(event.kind)}
                            </span>
                            <span className="truncate font-medium">
                              {event.title}
                            </span>
                          </div>
                          {event.detail ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                              {event.detail}
                            </p>
                          ) : null}
                          {event.reason ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                              reason: {event.reason}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
            <ReactFlow
              colorMode={colorScheme}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={(_event, node) => {
                if (!node.id.startsWith('cluster:')) {
                  setSelectedSessionId(node.id)
                  setActiveTab('chat')
                }
              }}
              onSelectionChange={updateCanvasSelection}
              selectionOnDrag
              fitView
              fitViewOptions={{ padding: 0.24 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </section>
      </main>
    </TooltipProvider>
  )
}

export default App
