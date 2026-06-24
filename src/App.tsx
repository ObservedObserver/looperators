import { useCallback, useEffect, useMemo, useState } from 'react'
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
  Clock,
  GitBranch,
  MessageSquarePlus,
  Moon,
  PanelsTopLeft,
  RefreshCw,
  Send,
  Snowflake,
  Square,
  Sun,
  Terminal,
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

type ColorScheme = 'dark' | 'light'

type AgentNodeData = {
  label: string
  description: string
  agent: string
  status: SessionStatus
  messageCount: number
  latestVerdict?: string
  latestReportIssueCount?: number
  latestReportSummary?: string
  frozen?: boolean
  freezeReason?: string
  masterReason?: string
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
  'You are running under Orrery P2 membrane verification. Reply with one short sentence confirming this node is a resumable Claude session.'

function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  return (
    <div
      className={cn(
        'min-w-[260px] max-w-[300px] rounded-lg border bg-card px-4 py-3 shadow-sm transition',
        data.frozen
          ? 'border-zinc-500/60 bg-muted/60 opacity-70 grayscale'
          : statusClassNames[data.status],
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
          {data.frozen ? 'Frozen' : statusLabels[data.status]}
        </Badge>
      </div>
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

const nodeTypes = {
  agent: AgentNode,
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

function ChatMessage({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-lg border px-3 py-2 text-sm leading-6',
          isUser
            ? 'border-primary/30 bg-primary text-primary-foreground'
            : 'border-border bg-background'
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-normal opacity-70">
          {isUser ? 'You' : 'Claude'}
          {message.status === 'streaming' ? (
            <span className="normal-case">streaming</span>
          ) : null}
        </div>
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    </div>
  )
}

function App() {
  const [runtimeState, setRuntimeState] =
    useState<GraphState>(createEmptyGraphState)
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [newPrompt, setNewPrompt] = useState(defaultPrompt)
  const [message, setMessage] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string>()
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
  const canResume =
    Boolean(selectedSession) &&
    selectedSession?.status !== 'running' &&
    selectedSession?.status !== 'pending' &&
    selectedSession?.status !== 'killed'
  const canKill =
    selectedSession?.status === 'running' || selectedSession?.status === 'pending'

  const nodes: Node<AgentNodeData>[] = useMemo(
    () =>
      runtimeState.nodes.map((node) => {
        const session = runtimeState.sessions[node.sessionId]
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
          data: {
            label: node.label,
            description: lastMessagePreview(session),
            agent: node.agent,
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
          },
        }
      }),
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

  return (
    <TooltipProvider>
      <main className="flex h-screen min-h-[720px] overflow-hidden bg-background text-foreground">
        <aside className="flex w-[440px] shrink-0 flex-col border-r border-border bg-sidebar">
          <header
            className={cn(
              'app-region-drag space-y-4 px-5 pb-4 pt-5',
              isElectron && 'pt-16'
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-background">
                  <PanelsTopLeft className="size-4" />
                </div>
                <div>
                  <h1 className="text-base font-semibold tracking-normal">
                    Orrery
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    P2 membrane sessions
                  </p>
                </div>
              </div>
              <Badge variant={isElectron ? 'outline' : 'destructive'}>
                {isElectron ? 'electron' : 'web only'}
              </Badge>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="new-session-prompt"
                className="text-xs font-medium uppercase tracking-normal text-muted-foreground"
              >
                New session
              </label>
              <textarea
                id="new-session-prompt"
                className="app-region-no-drag min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-ring"
                value={newPrompt}
                onChange={(event) => setNewPrompt(event.target.value)}
              />
              <Button
                className="app-region-no-drag w-full justify-start"
                disabled={
                  !isElectron || isCreating || newPrompt.trim().length === 0
                }
                onClick={createSession}
              >
                <CirclePlay className="size-4" />
                Start Claude Session
              </Button>
            </div>

            {runtimeError ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                {runtimeError}
              </div>
            ) : null}
          </header>

          <Separator />

          <section className="max-h-52 shrink-0 overflow-y-auto px-3 py-4">
            <div className="mb-3 flex items-center justify-between px-2">
              <h2 className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
                Sessions
              </h2>
              <Badge variant="secondary">{sessions.length}</Badge>
            </div>

            <div className="space-y-2">
              {sessions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No sessions yet.
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

                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    className={cn(
                      'app-region-no-drag w-full rounded-lg border border-border bg-background/60 p-3 text-left transition hover:bg-accent',
                      selectedSessionId === session.sessionId && 'border-primary'
                    )}
                    onClick={() => setSelectedSessionId(session.sessionId)}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Terminal className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">
                          {session.label}
                        </span>
                      </div>
                      <Badge variant="secondary" className="shrink-0">
                        {statusLabels[session.status]}
                      </Badge>
                    </div>
                    <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {lastMessagePreview(session)}
                    </p>
                    {latestVerdict ? (
                      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <ClipboardCheck className="size-3" />
                        {latestVerdict}
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>

          <Separator />

          <section className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
                  <h2 className="truncate text-sm font-semibold">
                    {selectedSession?.label ?? 'Agent Chat Session'}
                  </h2>
                </div>
                {selectedSession ? (
                  <Badge variant="secondary">
                    {statusLabels[selectedSession.status]}
                  </Badge>
                ) : null}
              </div>
              <p className="break-all text-xs leading-5 text-muted-foreground">
                {selectedSession?.backendSessionId ??
                  selectedSession?.sessionId ??
                  'Select a graph node.'}
              </p>
              {selectedReports.length ? (
                <div className="mt-3 space-y-2">
                  {selectedReports.slice(0, 3).map((report) => (
                    <div
                      key={report.id}
                      className="rounded-md border border-border bg-background/70 p-2"
                    >
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-normal">
                        <ClipboardCheck className="size-3" />
                        {reportTitle(report)}
                      </div>
                      <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                        {reportBody(report)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {selectedSession?.messages.length ? (
                selectedSession.messages.map((item) => (
                  <ChatMessage key={item.id} message={item} />
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No chat history.
                </div>
              )}
            </div>

            <div className="border-t border-border p-3">
              <textarea
                className="app-region-no-drag mb-2 min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-ring"
                placeholder="Message selected session"
                value={message}
                disabled={!selectedSession || !canResume || isResuming}
                onChange={(event) => setMessage(event.target.value)}
              />
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Button
                  className="app-region-no-drag justify-start"
                  disabled={
                    !selectedSession ||
                    !canResume ||
                    isResuming ||
                    message.trim().length === 0
                  }
                  onClick={resumeSelectedSession}
                >
                  <Send className="size-4" />
                  Resume Session
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="app-region-no-drag"
                      variant="outline"
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
          </section>

          <Separator />

          <footer className="grid grid-cols-5 gap-2 p-3">
            {[
              {
                icon: Activity,
                label: `${runningSessions.length} running`,
              },
              {
                icon: Braces,
                label: `schema v${graphStateSchema.version}`,
              },
              {
                icon: RefreshCw,
                label: `updated ${runtimeState.updatedAt.slice(11, 19)}`,
              },
              {
                icon: GitBranch,
                label: `${runtimeState.edges.length} edges`,
              },
              {
                icon: Clock,
                label: `${runtimeState.reports.length} reports`,
              },
            ].map((item) => (
              <Tooltip key={item.label}>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={item.label}>
                    <item.icon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{item.label}</TooltipContent>
              </Tooltip>
            ))}
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
              onNodeClick={(_event, node) => setSelectedSessionId(node.id)}
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
