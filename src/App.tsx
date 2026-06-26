import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
  applyNodeChanges,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  getBezierPath,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Activity,
  Archive,
  ArchiveRestore,
  Bot,
  Braces,
  Check,
  ClipboardCheck,
  CirclePlay,
  FileText,
  FolderOpen,
  GitBranch,
  MessageSquarePlus,
  MessagesSquare,
  Moon,
  Orbit,
  Search,
  Send,
  Snowflake,
  Square,
  Sun,
  Terminal,
  TriangleAlert,
  X,
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
  TermChip,
  TermLabel,
  termInputCls,
  termTextareaCls,
} from '@/components/terminal'
import { ToolRunFeed } from '@/components/tool-run-feed'
import {
  parseToolTurns,
  toolTurnsFromRuntimeActivities,
  type ToolTurn,
} from '@/shared/tool-feed'
import {
  createEmptyGraphState,
  type AgentMessage,
  type AgentSession,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphState,
  type Report,
  type RuntimeStateDiagnostic,
  type SessionStatus,
  type UpdateNodePositionsInput,
} from '@/shared/graph-state'
import type {
  NativeProviderEvent,
  ProviderKind,
  ProviderRuntimeEvent,
  RuntimeRequest,
  UserInputRequest,
} from '@/shared/provider-runtime'
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
      return 'border-ink-line bg-foreground/[0.04] text-term-dim'
  }
}

// Chrome-friendly state pill for graph nodes (flips correctly in light mode).
function nodeStatePillCls(
  status: SessionStatus,
  role: 'worker' | 'master',
  frozen?: boolean
) {
  if (frozen) return 'border-border bg-muted text-muted-foreground'
  if (role === 'master')
    return 'border-term-amber/40 bg-term-amber/10 text-term-amber'
  switch (status) {
    case 'running':
    case 'pending':
      return 'border-term-amber/40 bg-term-amber/10 text-term-amber'
    case 'failed':
    case 'killed':
      return 'border-term-rose/40 bg-term-rose/10 text-term-rose'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

// Terminal action-button class presets (lime primary / chrome outline, mono).
const termActionBtnCls =
  'min-w-0 justify-start font-mono text-[11px] uppercase tracking-[0.06em]'

const edgeKindLabels: Record<GraphEdgeKind, string> = {
  'create-session': 'new chat',
  'resume-session': 'send',
  report: 'report',
  freeze: 'freeze',
}

const edgeKindClassNames: Record<GraphEdgeKind, string> = {
  'create-session':
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'resume-session':
    'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  report:
    'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  freeze:
    'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
}

const edgeKindStrokes: Record<GraphEdgeKind, string> = {
  'create-session': 'oklch(0.72 0.15 162)',
  'resume-session': 'oklch(0.75 0.15 75)',
  report: 'oklch(0.72 0.13 210)',
  freeze: 'oklch(0.6 0.02 240)',
}

function edgeDisplayLabel(edgeData: GraphEdgeData) {
  const label = edgeData.label.trim()
  if (
    !label ||
    label === edgeData.kind ||
    label === 'create_session' ||
    label === 'resume_session'
  ) {
    return edgeKindLabels[edgeData.kind]
  }

  return label
}

const providerOptions: {
  id: ProviderKind
  agent: 'claude-code' | 'codex'
  label: string
}[] = [
  { id: 'claude-code', agent: 'claude-code', label: 'Claude SDK' },
  { id: 'codex', agent: 'codex', label: 'Codex' },
  { id: 'legacy-claude-cli', agent: 'claude-code', label: 'Claude CLI' },
]

function providerOption(providerKind: ProviderKind) {
  return (
    providerOptions.find((option) => option.id === providerKind) ??
    providerOptions[0]
  )
}

function ProviderSegmentedControl({
  value,
  disabled,
  className,
  onChange,
}: {
  value: ProviderKind
  disabled?: boolean
  className?: string
  onChange: (value: ProviderKind) => void
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-3 gap-1 rounded-lg border border-ink-line bg-ink p-1 font-mono',
        disabled && 'opacity-60',
        className
      )}
    >
      {providerOptions.map((option) => {
        const isSelected = value === option.id
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            className={cn(
              'truncate rounded-md px-2 py-1.5 text-[10.5px] uppercase tracking-[0.06em] transition disabled:cursor-not-allowed',
              isSelected
                ? 'bg-lime/[0.12] text-lime ring-1 ring-lime/30'
                : 'text-term-dim hover:bg-foreground/[0.06] hover:text-term-name'
            )}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function sessionProviderLabel(session: AgentSession) {
  return providerOption(session.providerKind).label
}

function compactPath(value: string) {
  const withHome = value.replace(/^\/Users\/[^/]+/, '~')
  if (withHome.length <= 48) {
    return withHome
  }

  const parts = withHome.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  if (withHome.startsWith('~/')) {
    return `~/.../${tail}`
  }
  if (withHome.startsWith('/')) {
    return `/.../${tail}`
  }
  return `.../${tail}`
}

function compactId(value: string) {
  return value.length > 12 ? value.slice(0, 8) : value
}

function sessionChatId(session: AgentSession) {
  return (
    session.backendSessionId ??
    session.providerSessionId ??
    session.sessionId
  )
}

function parseTimestamp(value?: string) {
  if (!value) {
    return undefined
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatTimestamp(value?: string) {
  const date = parseTimestamp(value)
  if (!date) {
    return value ?? 'unknown'
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatClock(value?: string) {
  const date = parseTimestamp(value)
  if (!date) {
    return value?.slice(11, 16) ?? 'unknown'
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function SessionMetaPill({
  label,
  value,
  title,
  className,
}: {
  label: string
  value: string
  title?: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/55 px-2 py-1 font-mono text-[10.5px] leading-none',
        className
      )}
      title={title ?? value}
    >
      <span className="shrink-0 uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-foreground/85">{value}</span>
    </span>
  )
}

type ProjectCwdValidation = {
  ok: boolean
  message: string
}

type RecoveryTone = 'amber' | 'rose' | 'cyan' | 'muted'

type RecoveryState = {
  tone: RecoveryTone
  title: string
  detail: string
}

function defaultWorkspaceCwd() {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.orrery?.workspace?.defaultCwd ?? ''
}

function latestSessionCwd(sessions: AgentSession[]) {
  return sessions.find((session) => !session.archived)?.cwd ?? sessions[0]?.cwd
}

function validateProjectCwd(value: string): ProjectCwdValidation {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      message: 'Choose a project folder before starting.',
    }
  }

  if (trimmed !== '~' && !trimmed.startsWith('/') && !trimmed.startsWith('~/')) {
    return {
      ok: false,
      message: 'Use an absolute path or ~/path.',
    }
  }

  return {
    ok: true,
    message: `Selected cwd: ${compactPath(trimmed)}`,
  }
}

function diagnosticSessionId(diagnostic: RuntimeStateDiagnostic) {
  const sessionId = diagnostic.details?.sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

function diagnosticsForSession(
  diagnostics: RuntimeStateDiagnostic[],
  sessionId: string
) {
  return diagnostics.filter(
    (diagnostic) => diagnosticSessionId(diagnostic) === sessionId
  )
}

function diagnosticDisplay(diagnostic: RuntimeStateDiagnostic): RecoveryState {
  if (diagnostic.type === 'runtime.active_session_recovered') {
    return {
      tone: 'amber',
      title: 'Restored after restart',
      detail: 'The previous turn was interrupted. Review the last output and send a new message when ready.',
    }
  }

  if (diagnostic.type === 'storage.cwd_invalid') {
    const cwd = diagnostic.details?.cwd
    return {
      tone: 'rose',
      title: 'Project folder unavailable',
      detail:
        typeof cwd === 'string'
          ? `Restore ${compactPath(cwd)} or start a linked chat with a valid cwd.`
          : 'Restore the project folder or start a linked chat with a valid cwd.',
    }
  }

  if (diagnostic.type.includes('parse_failed')) {
    return {
      tone: 'rose',
      title: 'Saved state needed repair',
      detail: 'Orrery recovered from persisted state diagnostics. Open diagnostics for details if anything looks missing.',
    }
  }

  if (diagnostic.type.includes('repaired') || diagnostic.type.includes('created')) {
    return {
      tone: 'cyan',
      title: 'Saved state repaired',
      detail: diagnostic.message,
    }
  }

  return {
    tone: 'muted',
    title: 'Recovery diagnostic',
    detail: diagnostic.message,
  }
}

function messageLooksLikeCwdIssue(message: string) {
  return /Project (folder|cwd)|cwd|ENOTDIR|ENOENT/.test(message)
}

function messageLooksLikeProviderIssue(message: string) {
  return /provider|claude|codex|auth|login|spawn|command not found|not found/i.test(
    message
  )
}

function sessionRecoveryState({
  session,
  diagnostics,
  frozen,
}: {
  session: AgentSession
  diagnostics: RuntimeStateDiagnostic[]
  frozen?: boolean
}): RecoveryState | undefined {
  const sessionDiagnostics = diagnosticsForSession(diagnostics, session.sessionId)
  const cwdDiagnostic = sessionDiagnostics.find(
    (diagnostic) => diagnostic.type === 'storage.cwd_invalid'
  )
  if (cwdDiagnostic) {
    return diagnosticDisplay(cwdDiagnostic)
  }

  const recoveredDiagnostic = sessionDiagnostics.find(
    (diagnostic) => diagnostic.type === 'runtime.active_session_recovered'
  )
  if (recoveredDiagnostic) {
    return diagnosticDisplay(recoveredDiagnostic)
  }

  if (frozen) {
    return {
      tone: 'muted',
      title: 'Frozen by workflow',
      detail: 'This chat is paused by its graph scope. Unfreeze or start a linked chat to continue.',
    }
  }

  if (session.status === 'killed') {
    return {
      tone: 'amber',
      title: 'Stopped',
      detail: 'This turn was stopped and cannot be resumed directly. Start a linked chat to continue the thread.',
    }
  }

  if (session.status === 'failed') {
    const message = session.error ?? 'The provider run failed.'
    if (messageLooksLikeCwdIssue(message)) {
      return {
        tone: 'rose',
        title: 'Project folder unavailable',
        detail: message,
      }
    }

    if (messageLooksLikeProviderIssue(message)) {
      return {
        tone: 'rose',
        title: 'Provider unavailable',
        detail: message,
      }
    }

    return {
      tone: 'rose',
      title: 'Run failed',
      detail: message,
    }
  }

  return undefined
}

function recoveryToneClassName(tone: RecoveryTone) {
  switch (tone) {
    case 'rose':
      return 'border-term-rose/35 bg-term-rose/10 text-term-rose'
    case 'amber':
      return 'border-term-amber/35 bg-term-amber/10 text-term-amber'
    case 'cyan':
      return 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan'
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim'
  }
}

function recoveryDetailClassName(tone: RecoveryTone) {
  return tone === 'rose' ? 'text-term-dim' : 'text-term-dim2'
}

function RecoveryNotice({
  state,
  compact,
}: {
  state?: RecoveryState
  compact?: boolean
}) {
  if (!state) {
    return null
  }

  return (
    <div
      className={cn(
        'rounded-lg border px-2.5 py-2 font-mono',
        recoveryToneClassName(state.tone)
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em]">
        <TriangleAlert className="size-3 shrink-0" />
        <span className="truncate">{state.title}</span>
      </div>
      <p
        className={cn(
          compact ? 'line-clamp-2' : 'whitespace-pre-wrap',
          'mt-1 break-words text-[11.5px] leading-5',
          recoveryDetailClassName(state.tone)
        )}
      >
        {state.detail}
      </p>
    </div>
  )
}

function RuntimeDiagnosticsBanner({
  diagnostics,
}: {
  diagnostics: RuntimeStateDiagnostic[]
}) {
  const visibleDiagnostics = diagnostics.slice(-3).reverse()
  if (visibleDiagnostics.length === 0) {
    return null
  }

  return (
    <div className="app-region-no-drag mx-3 mb-2 space-y-1.5">
      {visibleDiagnostics.map((diagnostic) => {
        const state = diagnosticDisplay(diagnostic)
        return (
          <div
            key={diagnostic.id}
            className={cn(
              'rounded-lg border px-3 py-2 font-mono',
              recoveryToneClassName(state.tone)
            )}
            title={diagnostic.type}
          >
            <div className="flex min-w-0 items-center gap-2">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                {state.title}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums opacity-70">
                {formatClock(diagnostic.ts)}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-term-dim">
              {state.detail}
            </p>
          </div>
        )
      })}
    </div>
  )
}

function ProjectCwdField({
  value,
  validation,
  disabled,
  onChange,
}: {
  value: string
  validation: ProjectCwdValidation
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="block space-y-1.5 font-mono">
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-term-dim2">
        <FolderOpen className="size-3" />
        project cwd
      </span>
      <input
        className={cn(
          termInputCls,
          !validation.ok && 'border-term-rose/45 focus:border-term-rose/70'
        )}
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder="/path/to/project"
        onChange={(event) => onChange(event.target.value)}
      />
      <span
        className={cn(
          'block text-[10.5px] leading-4',
          validation.ok ? 'text-term-dim2' : 'text-term-rose'
        )}
      >
        {validation.message}
      </span>
    </label>
  )
}

const AgentNode = memo(function AgentNode({
  data,
  selected,
}: NodeProps<Node<AgentNodeData>>) {
  const isMaster = data.role === 'master'
  const marker = sessionMarker(data.status, selected ?? false, data.role)
  const freezeReason = data.freezeReason ?? data.masterReason
  return (
    <div
      className={cn(
        'w-[300px] rounded-xl border bg-card font-mono shadow-sm transition',
        data.frozen
          ? 'border-border bg-muted/50 opacity-75'
          : isMaster
            ? 'border-term-amber/50'
            : data.isManaged
              ? 'border-term-cyan/45'
              : 'border-border',
        selected && '!border-lime-hi/60 ring-2 ring-lime-hi/50'
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-0 !bg-lime-hi"
      />
      <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
        <span
          className={cn(
            'w-3.5 shrink-0 text-center text-[12px] leading-none',
            marker.cls
          )}
        >
          {marker.char}
        </span>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-accent-ink/25 bg-accent-ink/10 text-accent-ink">
          {isMaster ? <Bot className="size-4" /> : <Terminal className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-foreground">
            {data.label}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {data.agent}
          </div>
        </div>
        <span
          className={cn(
            statePillBase,
            nodeStatePillCls(data.status, data.role, data.frozen)
          )}
        >
          {data.frozen
            ? 'frozen'
            : isMaster
              ? 'master'
              : statusLabels[data.status].toLowerCase()}
        </span>
      </div>

      {data.clusterLabel || data.isManaged ? (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-2">
          {data.clusterLabel ? (
            <TermChip>{data.clusterLabel}</TermChip>
          ) : null}
          {data.isManaged ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10.5px] leading-none text-cyan-700 dark:text-cyan-300">
              managed
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="px-3.5 pb-3">
        <div className="rounded-lg border border-border bg-muted/40 px-2.5 py-2">
          <p className="line-clamp-2 break-words text-[11px] leading-5 text-muted-foreground">
            {data.description}
          </p>
        </div>

        {data.latestVerdict ? (
          <div className="mt-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em]">
              <span className="text-term-faint">└</span>
              <span className="text-muted-foreground">verdict</span>
              <span className="text-term-green">{data.latestVerdict}</span>
              {data.latestReportIssueCount !== undefined ? (
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {data.latestReportIssueCount} issues
                </span>
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
          <div className="mt-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <Snowflake className="size-3" />
              freeze
            </div>
            {freezeReason ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                {freezeReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
        <Activity className="size-3 text-accent-ink" />
        <span className="tabular-nums text-foreground/80">
          {data.messageCount}
        </span>
        messages
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-0 !bg-lime-hi"
      />
    </div>
  )
})

const ClusterBoundaryNode = memo(function ClusterBoundaryNode({
  data,
}: NodeProps<Node<ClusterNodeData>>) {
  return (
    <div
      className={cn(
        'h-full w-full rounded-xl border border-dashed border-cyan-500/45 bg-cyan-500/[0.04] px-3 py-2.5 font-mono shadow-sm',
        data.frozen && 'border-border bg-muted/30 opacity-70'
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
      {data.policySummary ? (
        <div className="mt-1.5 text-[10.5px] text-cyan-700/80 dark:text-cyan-300/80">
          {data.policySummary}
        </div>
      ) : null}
      {data.freezeReason ? (
        <div className="mt-1 line-clamp-1 text-[10.5px] text-muted-foreground">
          {data.freezeReason}
        </div>
      ) : null}
    </div>
  )
})

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
  const visibleDetail = reason ?? edgeData.summary

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
            'nodrag nopan pointer-events-auto absolute rounded-md border px-2 py-1 font-mono text-[10px] leading-4 shadow-sm backdrop-blur-sm',
            edgeKindClassNames[edgeData.kind],
            edgeData.recent && 'orrery-edge-label-recent'
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
            {edgeData.issueCount !== undefined ? (
              <span className="tabular-nums">· {edgeData.issueCount} iss</span>
            ) : null}
          </div>
          {visibleDetail ? (
            <div className="mt-0.5 max-w-[220px] truncate normal-case tracking-normal opacity-80">
              {visibleDetail}
            </div>
          ) : null}
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

function latestUserMessagePreview(session: AgentSession) {
  return (
    [...session.messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.trim())
      ?.content ?? session.prompt
  )
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
    verdict ? `Review until ${verdict}` : undefined,
    cluster.loopPolicy?.onStop === 'freeze' ? 'Freeze on stop' : undefined,
    maxIterations ? `Max ${maxIterations}` : undefined,
  ].filter(Boolean)

  return parts.length ? parts.join(' · ') : undefined
}

function loopStateStatus(cluster: GraphState['clusters'][string] | undefined) {
  return cluster?.loopState?.status ?? 'stopped'
}

function workflowTargetLabel(state: GraphState, targetId: string) {
  return (
    state.sessions[targetId]?.label ??
    state.clusters[targetId]?.label ??
    compactId(targetId)
  )
}

function loopEventLabel(type: string) {
  switch (type) {
    case 'loop.started':
      return 'Loop started'
    case 'loop.stopped':
      return 'Loop stopped'
    case 'session.finished':
      return 'Chat finished'
    case 'session.failed':
      return 'Chat failed'
    case 'session.killed':
      return 'Chat stopped'
    case 'report.received':
      return 'Report received'
    case 'freeze.applied':
      return 'Freeze applied'
    case 'runtime.recovered':
      return 'Runtime recovered'
    default:
      return type.replaceAll('.', ' ')
  }
}

function loopLastEvent(
  cluster: GraphState['clusters'][string] | undefined,
  state: GraphState
) {
  const event = cluster?.loopState?.lastEvent
  if (!event) {
    return 'none'
  }

  const subject = event.sessionId
    ? workflowTargetLabel(state, event.sessionId)
    : event.from
      ? workflowTargetLabel(state, event.from)
      : event.targetId
        ? workflowTargetLabel(state, event.targetId)
        : event.reportId
          ? compactId(event.reportId)
          : undefined
  return [loopEventLabel(event.type), subject, formatClock(event.ts)]
    .filter(Boolean)
    .join(' · ')
}

function clusterBoundaryNodes(state: GraphState): Node<ClusterNodeData>[] {
  return Object.values(state.clusters).flatMap((cluster) => {
    const managedNodes = cluster.nodeIds
      .map((nodeId) => state.nodes.find((node) => node.nodeId === nodeId))
      .filter((node): node is GraphState['nodes'][number] => Boolean(node))

    if (managedNodes.length === 0) {
      return []
    }

    const nodeWidth = 300
    const nodeHeight = 240
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

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function sessionSearchHaystack({
  session,
  latestReport,
  recovery,
}: {
  session: AgentSession
  latestReport?: Report
  recovery?: RecoveryState
}) {
  return normalizeSearchText(
    [
      session.label,
      session.sessionId,
      session.backendSessionId,
      session.providerSessionId,
      session.providerKind,
      sessionProviderLabel(session),
      session.agent,
      session.cwd,
      statusLabels[session.status],
      session.status,
      session.role,
      session.error,
      latestUserMessagePreview(session),
      lastMessagePreview(session),
      latestReport ? reportTitle(latestReport) : undefined,
      latestReport ? reportBody(latestReport) : undefined,
      recovery?.title,
      recovery?.detail,
    ]
      .filter(Boolean)
      .join(' ')
  )
}

function sessionMatchesSearch({
  session,
  latestReport,
  recovery,
  query,
}: {
  session: AgentSession
  latestReport?: Report
  recovery?: RecoveryState
  query: string
}) {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) {
    return true
  }

  return normalizedQuery
    .split(' ')
    .every((token) =>
      sessionSearchHaystack({ session, latestReport, recovery }).includes(token)
    )
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
    title: `${sessionLabel(state, edge.source)} → ${sessionLabel(
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

type NodePositionUpdate = UpdateNodePositionsInput['positions'][number]

function isFinitePosition(position: { x: number; y: number }) {
  return Number.isFinite(position.x) && Number.isFinite(position.y)
}

function nodePositionUpdatesFromFlowNodes(nodes: Node[]): NodePositionUpdate[] {
  return nodes.flatMap((node) => {
    if (node.id.startsWith('cluster:') || !isFinitePosition(node.position)) {
      return []
    }

    return [
      {
        nodeId: node.id,
        position: { x: node.position.x, y: node.position.y },
      },
    ]
  })
}

function applyNodePositionUpdates(
  state: GraphState,
  updates: NodePositionUpdate[]
) {
  if (updates.length === 0) {
    return state
  }

  const updateById = new Map(updates.map((update) => [update.nodeId, update]))
  let changed = false
  const nextNodes = state.nodes.map((node) => {
    const update = updateById.get(node.nodeId)
    if (
      !update ||
      node.position.x === update.position.x &&
        node.position.y === update.position.y
    ) {
      return node
    }

    changed = true
    return {
      ...node,
      position: {
        x: update.position.x,
        y: update.position.y,
      },
    }
  })

  return changed ? { ...state, nodes: nextNodes } : state
}

function applyFlowNodePositionUpdates(
  nodes: Node[],
  updates: NodePositionUpdate[]
) {
  if (updates.length === 0) {
    return nodes
  }

  const updateById = new Map(updates.map((update) => [update.nodeId, update]))
  let changed = false
  const nextNodes = nodes.map((node) => {
    const update = updateById.get(node.id)
    if (
      !update ||
      node.position.x === update.position.x &&
        node.position.y === update.position.y
    ) {
      return node
    }

    changed = true
    return {
      ...node,
      position: {
        x: update.position.x,
        y: update.position.y,
      },
    }
  })

  return changed ? nextNodes : nodes
}

type WorkflowStepStatus = 'done' | 'active' | 'blocked'

function workflowStepClassName(status: WorkflowStepStatus) {
  switch (status) {
    case 'done':
      return 'border-term-green/35 bg-term-green/10 text-term-green'
    case 'active':
      return 'border-lime-hi/35 bg-lime/[0.08] text-lime-hi'
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim2'
  }
}

function workflowStatusPillClassName(status: WorkflowStepStatus) {
  switch (status) {
    case 'done':
      return 'border-term-green/30 bg-term-green/10 text-term-green'
    case 'active':
      return 'border-term-amber/30 bg-term-amber/10 text-term-amber'
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim2'
  }
}

function WorkflowStep({
  index,
  title,
  detail,
  status,
}: {
  index: number
  title: string
  detail: string
  status: WorkflowStepStatus
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[28px_minmax(0,1fr)] gap-2 rounded-lg border px-2.5 py-2 font-mono',
        workflowStepClassName(status)
      )}
    >
      <span className="flex size-5 items-center justify-center rounded-md border border-current/25 text-[10px] tabular-nums">
        {status === 'done' ? <Check className="size-3" /> : index}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium">{title}</span>
        <span className="mt-0.5 block line-clamp-2 text-[10.5px] leading-4 opacity-75">
          {detail}
        </span>
      </span>
    </div>
  )
}

function WorkflowSummaryRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 text-[11.5px] leading-5">
      <span className="text-term-dim2">{label}</span>
      <span className="min-w-0 text-term-dim">{children}</span>
    </div>
  )
}

function assistantLabel(agent?: string) {
  return agent?.toLowerCase().includes('codex') ? 'codex' : 'assistant'
}

function ChatMessage({
  message,
  turn,
  agent,
}: {
  message: AgentMessage
  turn?: ToolTurn
  agent?: string
}) {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'
  const hasFeed = !isUser && Boolean(turn && turn.toolRuns.length > 0)
  const hasText = message.content.trim().length > 0
  const senderLabel = assistantLabel(agent)

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="mb-1.5 flex items-center gap-2">
        {isUser ? (
          <span className="text-[10px] uppercase tracking-[0.14em] text-term-dim">
            you
          </span>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-term-green shadow-[0_0_8px_var(--term-green)]" />
            <span className="text-[10px] uppercase tracking-[0.14em] text-term-emerald">
              {senderLabel}
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
          <span className="whitespace-pre-wrap break-words text-term-name">
            {message.content}
          </span>
        </div>
      ) : (
        <>
          {hasFeed && turn ? (
            <ToolRunFeed turn={turn} agent={agent} />
          ) : null}
          {hasText || (isStreaming && !hasFeed) ? (
            <div
              className={cn(
                'whitespace-pre-wrap break-words text-[13px] leading-6 text-term-name',
                hasFeed && 'mt-2'
              )}
            >
              {message.content}
              {isStreaming ? <span className="orrery-caret ml-1" /> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

type RuntimeInteractionPanelProps = {
  requests: RuntimeRequest[]
  userInputRequests: UserInputRequest[]
  userInputDrafts: Record<string, string>
  pendingInteractionIds: Record<string, boolean>
  onRespond: (
    request: RuntimeRequest,
    decision: 'approved' | 'denied'
  ) => void
  onDraftChange: (requestId: string, value: string) => void
  onAnswer: (request: UserInputRequest) => void
}

const requestKindLabels: Record<RuntimeRequest['kind'], string> = {
  approval: 'Approval request',
  permission: 'Permission request',
  confirmation: 'Confirmation request',
}

function RuntimeInteractionPanel({
  requests,
  userInputRequests,
  userInputDrafts,
  pendingInteractionIds,
  onRespond,
  onDraftChange,
  onAnswer,
}: RuntimeInteractionPanelProps) {
  if (requests.length === 0 && userInputRequests.length === 0) {
    return null
  }

  return (
    <div className="shrink-0 border-b border-ink-line bg-ink px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2 font-mono">
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-amber">
          Action needed
        </span>
        <span className="ml-auto rounded border border-term-amber/30 bg-term-amber/10 px-1.5 py-0.5 text-[10px] tabular-nums text-term-amber">
          {requests.length + userInputRequests.length}
        </span>
      </div>

      <div className="space-y-2">
        {requests.map((request) => {
          const isPending = pendingInteractionIds[request.id] === true
          return (
            <div
              key={request.id}
              className="rounded-lg border border-term-amber/35 bg-term-amber/10 p-3 font-mono"
            >
              <div className="flex min-w-0 items-start gap-2">
                <span className="pt-0.5 text-term-amber">?</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-term-name">
                    {request.title}
                  </div>
                  {request.body ? (
                    <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] leading-5 text-term-dim">
                      {request.body}
                    </p>
                  ) : null}
                  <div className="mt-1 text-[10.5px] uppercase tracking-[0.08em] text-term-faint">
                    {requestKindLabels[request.kind]} ·{' '}
                    {formatClock(request.createdAt)}
                  </div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'approved')}
                >
                  <Check className="size-3.5" />
                  Approve
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'denied')}
                >
                  <X className="size-3.5" />
                  Deny
                </Button>
              </div>
            </div>
          )
        })}

        {userInputRequests.map((request) => {
          const draft = userInputDrafts[request.id] ?? ''
          const isPending = pendingInteractionIds[request.id] === true
          return (
            <div
              key={request.id}
              className="rounded-lg border border-term-cyan/35 bg-term-cyan/10 p-3 font-mono"
            >
              <div className="text-[12.5px] font-medium text-term-name">
                Input requested
              </div>
              <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] leading-5 text-term-dim">
                {request.prompt}
              </p>
              <textarea
                className="mt-2 max-h-28 min-h-16 w-full resize-y rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                value={draft}
                placeholder={request.placeholder ?? 'Type an answer'}
                disabled={isPending}
                onChange={(event) => onDraftChange(request.id, event.target.value)}
              />
              <Button
                className="mt-2 h-8 w-full justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                disabled={isPending}
                onClick={() => onAnswer(request)}
              >
                <Send className="size-3.5" />
                Send answer
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function clampOneLine(value: string, max = 110) {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine
}

type ProviderEventEntry = {
  id: string
  ts: string
  channel: 'runtime' | 'native'
  title: string
  payload: unknown
}

function providerEventTitle(event: ProviderRuntimeEvent) {
  if (event.type === 'content.delta') {
    return `${event.type}:${event.streamKind}`
  }
  if (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  ) {
    return `${event.type}:${event.item.kind}`
  }
  return event.type
}

function nativeEventTitle(event: NativeProviderEvent) {
  return event.raw.method ?? event.raw.messageType ?? event.raw.source
}

function providerEventEntries(session: AgentSession): ProviderEventEntry[] {
  const runtime = (session.runtimeEvents ?? []).map((event) => ({
    id: event.id,
    ts: event.ts,
    channel: 'runtime' as const,
    title: providerEventTitle(event),
    payload: event.raw?.payload ?? event,
  }))
  const native = (session.nativeEvents ?? []).map((event) => ({
    id: event.id,
    ts: event.ts,
    channel: 'native' as const,
    title: nativeEventTitle(event),
    payload: event.raw.payload,
  }))

  return [...runtime, ...native]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, 40)
}

function stringifyEventPayload(payload: unknown) {
  let text: string
  try {
    text = JSON.stringify(payload, null, 2)
  } catch {
    text = String(payload)
  }

  return text.length > 6000 ? `${text.slice(0, 6000)}\n... truncated` : text
}

function ProviderEventDrawer({ session }: { session: AgentSession }) {
  const entries = providerEventEntries(session)

  return (
    <div className="border-b border-ink-line bg-ink px-3.5 py-3 font-mono">
      <div className="mb-2 flex items-center gap-2">
        <Braces className="size-3.5 text-term-cyan" />
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">
          diagnostics
        </span>
        <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">
          last {entries.length}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink-line p-3 text-[11.5px] text-term-dim2">
          No diagnostics captured yet.
        </p>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <details
              key={`${entry.channel}:${entry.id}`}
              className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2"
            >
              <summary className="cursor-pointer list-none">
                <span className="inline-flex min-w-0 items-center gap-2 text-[11px]">
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 uppercase tracking-[0.08em]',
                      entry.channel === 'native'
                        ? 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan'
                        : 'border-lime/30 bg-lime/[0.08] text-lime'
                    )}
                  >
                    {entry.channel}
                  </span>
                  <span className="truncate text-term-name">{entry.title}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-term-faint">
                    {entry.ts.slice(11, 19)}
                  </span>
                </span>
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink px-2.5 py-2 text-[10.5px] leading-4 text-term-dim">
                {stringifyEventPayload(entry.payload)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

function providerSetupHints(providerKind: ProviderKind) {
  switch (providerKind) {
    case 'claude-code':
      return [
        'Confirm Claude SDK auth is available to the desktop runtime.',
        'Check that this app can start @anthropic-ai/claude-agent-sdk.',
        'Use Legacy Claude CLI to isolate SDK setup from account setup.',
      ]
    case 'codex':
      return [
        'Confirm the Codex provider is enabled and authenticated.',
        'Check that the Codex app-server can access this workspace path.',
        'Restart the desktop runtime after auth or provider changes.',
      ]
    case 'legacy-claude-cli':
      return [
        'Install the claude CLI and make sure Electron can find it on PATH.',
        'Run claude login in the same user environment.',
        'Check shell startup files if Terminal works but Orrery cannot start it.',
      ]
  }
}

function ProviderSetupDiagnostics({
  isRuntimeAvailable,
  providerKind,
  runtimeError,
}: {
  isRuntimeAvailable: boolean
  providerKind: ProviderKind
  runtimeError?: string
}) {
  const provider = providerOption(providerKind)
  const hints = providerSetupHints(providerKind)

  return (
    <div className="border-b border-ink-line bg-ink px-3.5 py-3 font-mono">
      <div className="mb-2 flex items-center gap-2">
        <Braces className="size-3.5 text-term-cyan" />
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">
          Diagnostics
        </span>
        <span
          className={cn(
            'ml-auto rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em]',
            isRuntimeAvailable
              ? 'border-term-green/30 bg-term-green/10 text-term-green'
              : 'border-term-rose/30 bg-term-rose/10 text-term-rose'
          )}
        >
          {isRuntimeAvailable ? 'runtime ready' : 'runtime unavailable'}
        </span>
      </div>

      <div className="space-y-2">
        <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
          <div className="grid gap-1.5 text-[11.5px] leading-5">
            <div className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-term-dim2">runtime</span>
              <span className="min-w-0 text-term-name">
                {isRuntimeAvailable
                  ? 'Electron bridge connected'
                  : 'Open Orrery in the desktop runtime to create chats'}
              </span>
            </div>
            <div className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-term-dim2">provider</span>
              <span className="min-w-0 text-term-name">{provider.label}</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-term-dim2">
            Setup checks
          </div>
          <div className="space-y-1">
            {hints.map((hint, index) => (
              <div
                key={hint}
                className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[11.5px] leading-5"
              >
                <span className="text-center text-term-faint">
                  {index === hints.length - 1 ? '└' : '├'}
                </span>
                <span className="min-w-0 text-term-dim">{hint}</span>
              </div>
            ))}
          </div>
        </div>

        {runtimeError ? (
          <div className="rounded-lg border border-term-rose/35 bg-term-rose/10 px-2.5 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-term-rose">
              Last error
            </div>
            <p className="whitespace-pre-wrap break-words text-[11.5px] leading-5 text-term-dim">
              {runtimeError}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'sessions', label: 'Chats', icon: Terminal },
  { id: 'orchestrate', label: 'Orchestrate', icon: Orbit },
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

const demoMode =
  typeof window !== 'undefined' &&
  !window.orrery &&
  new URLSearchParams(window.location.search).has('demo')

function App() {
  const [runtimeState, setRuntimeState] = useState<GraphState>(
    demoMode ? createDemoGraphState : createEmptyGraphState
  )
  const [selectedSessionId, setSelectedSessionId] = useState<
    string | null | undefined
  >(demoMode ? 'sess-p1-accept' : undefined)
  const [activeTab, setActiveTab] = useState<RailTab>('chat')
  const [newProviderKind, setNewProviderKind] =
    useState<ProviderKind>('claude-code')
  const [newCwd, setNewCwd] = useState(defaultWorkspaceCwd)
  const [message, setMessage] = useState('')
  const [sessionSearch, setSessionSearch] = useState('')
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [showRawEvents, setShowRawEvents] = useState(false)
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>(
    {}
  )
  const [pendingInteractionIds, setPendingInteractionIds] = useState<
    Record<string, boolean>
  >({})
  const [isCreating, setIsCreating] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  const [archivingSessionIds, setArchivingSessionIds] = useState<
    Record<string, boolean>
  >({})
  const [isUpdatingCluster, setIsUpdatingCluster] = useState(false)
  const [isCreatingMaster, setIsCreatingMaster] = useState(false)
  const [isStartingLoop, setIsStartingLoop] = useState(false)
  const [isStoppingLoop, setIsStoppingLoop] = useState(false)
  const [isFreezingSelected, setIsFreezingSelected] = useState(false)
  const [isFreezingCluster, setIsFreezingCluster] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string>()
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<string[]>([])
  const [pendingLinkedSourceId, setPendingLinkedSourceId] = useState<
    string | null
  >(null)
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
  const pendingLinkedSource = pendingLinkedSourceId
    ? runtimeState.sessions[pendingLinkedSourceId]
    : undefined
  const selectedNode = selectedSessionId
    ? runtimeState.nodes.find((node) => node.sessionId === selectedSessionId)
    : undefined
  const selectedManagedCluster = selectedSessionId
    ? Object.values(runtimeState.clusters).find((cluster) =>
        cluster.nodeIds.includes(selectedSessionId)
      )
    : undefined
  const selectedSessionFrozen =
    selectedNode?.frozen === true || selectedManagedCluster?.frozen === true
  const openRuntimeRequests = (selectedSession?.runtimeRequests ?? []).filter(
    (request) => request.status === 'open'
  )
  const openUserInputRequests = (
    selectedSession?.runtimeUserInputRequests ?? []
  ).filter((request) => (request.status ?? 'open') === 'open')
  const sessions = Object.values(runtimeState.sessions).sort(sessionSort)
  const runtimeDiagnostics = runtimeState.diagnostics ?? []
  const newCwdValidation = useMemo(() => validateProjectCwd(newCwd), [newCwd])
  const runningSessions = sessions.filter(
    (session) => session.status === 'running' || session.status === 'pending'
  )
  const archivedSessionCount = sessions.filter((session) => session.archived).length
  const selectedRecoveryState =
    selectedSession !== undefined
      ? sessionRecoveryState({
          session: selectedSession,
          diagnostics: runtimeDiagnostics,
          frozen: selectedSessionFrozen,
        })
      : undefined
  const filteredSessions = sessions.filter((session) => {
    if (session.archived && !showArchivedSessions) {
      return false
    }

    const node = runtimeState.nodes.find(
      (candidate) => candidate.sessionId === session.sessionId
    )
    const managedCluster = Object.values(runtimeState.clusters).find((cluster) =>
      cluster.nodeIds.includes(session.sessionId)
    )
    const latestReport = latestReportForSession(
      runtimeState.reports,
      session.sessionId
    )
    const recovery = sessionRecoveryState({
      session,
      diagnostics: runtimeDiagnostics,
      frozen: node?.frozen === true || managedCluster?.frozen === true,
    })

    return sessionMatchesSearch({
      session,
      latestReport,
      recovery,
      query: sessionSearch,
    })
  })
  const reportsById = useMemo(
    () => new Map(runtimeState.reports.map((report) => [report.id, report])),
    [runtimeState.reports]
  )
  const graphActivity = useMemo(
    () => activityEvents(runtimeState),
    [runtimeState]
  )
  // Parse tool runs from the selected session's stream-json chunks and zip them
  // to assistant messages. Aligned from the END so chunk truncation (oldest
  // turns dropped) keeps recent turns matched to their messages.
  const transcript = useMemo(() => {
    const messages = selectedSession?.messages ?? []
    const runtimeTurnsByRunId = selectedSession?.runtimeActivities?.length
      ? toolTurnsFromRuntimeActivities(selectedSession.runtimeActivities)
      : new Map<string, ToolTurn>()
    const turns =
      selectedSession && runtimeTurnsByRunId.size === 0
        ? parseToolTurns(selectedSession.chunks)
        : []
    const assistantPositions: number[] = []
    messages.forEach((item, index) => {
      if (item.role === 'assistant') {
        assistantPositions.push(index)
      }
    })
    const offset = assistantPositions.length - turns.length
    const turnByIndex = new Map<number, ToolTurn>()
    turns.forEach((turn, turnIndex) => {
      const position = assistantPositions[offset + turnIndex]
      if (position !== undefined) {
        turnByIndex.set(position, turn)
      }
    })
    return messages.map((message, index) => {
      const runtimeTurn = message.runId
        ? runtimeTurnsByRunId.get(message.runId)
        : undefined
      return {
        message,
        turn: runtimeTurn ?? turnByIndex.get(index),
      }
    })
  }, [selectedSession])
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
  const clusters = Object.values(runtimeState.clusters).sort((left, right) =>
    left.label.localeCompare(right.label)
  )
  const activeCluster = activeClusterId
    ? runtimeState.clusters[activeClusterId]
    : undefined
  const workflowManagedNodeIds = useMemo(() => {
    if (selectedManagedNodeIds.length > 0 && selectedCanvasNodeIds.length > 0) {
      return selectedManagedNodeIds
    }

    if (activeCluster?.nodeIds.length) {
      return activeCluster.nodeIds
    }

    return selectedManagedNodeIds
  }, [activeCluster, selectedCanvasNodeIds.length, selectedManagedNodeIds])
  const activeManagedSessions = useMemo(
    () =>
      activeCluster?.nodeIds
        .map((sessionId) => runtimeState.sessions[sessionId])
        .filter((session): session is AgentSession => Boolean(session)) ?? [],
    [activeCluster, runtimeState.sessions]
  )
  const activeMasterSession = activeCluster?.masterSessionId
    ? runtimeState.sessions[activeCluster.masterSessionId]
    : undefined
  const activeLoopStatus = loopStateStatus(activeCluster)
  const activeLoopIterations = activeCluster?.loopState?.iterations ?? 0
  const activeLoopMaxIterations = activeCluster?.loopPolicy?.maxIterations ?? 6
  const activeLoopReason = activeCluster?.loopState?.reason
  const activeLoopLastEvent = loopLastEvent(activeCluster, runtimeState)
  const activeLoopCoder = activeCluster?.loopState?.coderSessionId
    ? runtimeState.sessions[activeCluster.loopState.coderSessionId]
    : activeManagedSessions[0]
  const activeLoopReviewer = activeCluster?.loopState?.reviewerSessionId
    ? runtimeState.sessions[activeCluster.loopState.reviewerSessionId]
    : activeManagedSessions.find(
        (session) => session.sessionId !== activeLoopCoder?.sessionId
      )
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
  const canFreezeSelectedSession =
    Boolean(selectedSession) && !selectedSessionFrozen
  const canFreezeActiveCluster =
    Boolean(activeCluster) && activeCluster?.frozen !== true
  const hasWorkerSelection = workflowManagedNodeIds.length > 0
  const setupSteps = [
    {
      title: 'Select worker chats',
      detail: hasWorkerSelection
        ? `${workflowManagedNodeIds.length} worker ${
            workflowManagedNodeIds.length === 1 ? 'chat' : 'chats'
          } selected`
        : 'Use the canvas selection or current worker chat',
      status: hasWorkerSelection ? 'done' : 'active',
    },
    {
      title: 'Save cluster',
      detail: activeCluster
        ? activeCluster.label
        : hasWorkerSelection
          ? 'Ready to save'
          : 'Waiting for worker selection',
      status: activeCluster ? 'done' : hasWorkerSelection ? 'active' : 'blocked',
    },
    {
      title: 'Create or open master',
      detail: activeMasterSession?.label ?? 'Master is a normal chat session',
      status: activeMasterSession
        ? 'done'
        : activeCluster
          ? 'active'
          : 'blocked',
    },
    {
      title: 'Run review loop',
      detail:
        activeLoopStatus === 'running'
          ? `${activeLoopIterations}/${activeLoopMaxIterations} iterations`
          : canStartLoop
            ? 'Ready to run'
            : 'Needs cluster, master, and policy',
      status:
        activeLoopStatus === 'running'
          ? 'active'
          : canStartLoop
            ? 'active'
            : activeCluster?.frozen
              ? 'done'
              : 'blocked',
    },
    {
      title: 'Freeze if needed',
      detail: activeCluster?.frozen
        ? activeCluster.freezeReason ?? 'Cluster frozen'
        : 'Available for selected chat or active cluster',
      status: activeCluster?.frozen ? 'done' : activeCluster ? 'active' : 'blocked',
    },
  ] satisfies {
    title: string
    detail: string
    status: WorkflowStepStatus
  }[]

  const startNewChat = useCallback(() => {
    setPendingLinkedSourceId(null)
    setSelectedSessionId(null)
    setNewCwd(latestSessionCwd(sessions) ?? defaultWorkspaceCwd())
    setActiveTab('chat')
    setShowRawEvents(false)
    setMessage('')
  }, [sessions])

  const startLinkedChat = useCallback(() => {
    if (!selectedSession) {
      return
    }

    setPendingLinkedSourceId(selectedSession.sessionId)
    setSelectedSessionId(null)
    setNewProviderKind(selectedSession.providerKind)
    setNewCwd(selectedSession.cwd)
    setActiveTab('chat')
    setShowRawEvents(false)
    setMessage('')
  }, [selectedSession])

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
  const [canvasNodes, setCanvasNodes] = useState<Node[]>(nodes)
  const isDraggingCanvasNodeRef = useRef(false)

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
    if (!isDraggingCanvasNodeRef.current) {
      setCanvasNodes(nodes)
    }
  }, [nodes])

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
          setSelectedSessionId((current) =>
            current === undefined ? state.nodes[0]?.sessionId : current
          )
          setNewCwd((current) => {
            if (current.trim().length > 0) {
              return current
            }

            const restoredSessions = Object.values(state.sessions).sort(sessionSort)
            return latestSessionCwd(restoredSessions) ?? defaultWorkspaceCwd()
          })
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        }
      })

    const unsubscribe = window.orrery.runtime.onEvent((event) => {
      setRuntimeState(event.state)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const createSessionFromPrompt = useCallback(
    async (
      prompt: string,
      options: { sourceSessionId?: string | null } = {}
    ) => {
      if (!window.orrery?.runtime) {
        setRuntimeError('Runtime is available only inside Electron.')
        return false
      }

      const trimmedPrompt = prompt.trim()
      if (trimmedPrompt.length === 0) {
        return false
      }

      const cwd = newCwd.trim()
      const cwdValidation = validateProjectCwd(cwd)
      if (!cwdValidation.ok) {
        setRuntimeError(cwdValidation.message)
        return false
      }

      const sourceSessionId =
        typeof options.sourceSessionId === 'string' &&
        options.sourceSessionId.trim().length > 0
          ? options.sourceSessionId.trim()
          : undefined
      if (sourceSessionId && !runtimeState.sessions[sourceSessionId]) {
        setRuntimeError('Linked chat source is no longer available.')
        return false
      }

      setIsCreating(true)
      setRuntimeError(undefined)

      try {
        const selectedProvider = providerOption(newProviderKind)
        const result = await window.orrery.runtime.createSession({
          prompt: trimmedPrompt,
          cwd,
          agent: selectedProvider.agent,
          providerKind: selectedProvider.id,
          label: `${sourceSessionId ? 'Linked Chat' : 'New Chat'} ${
            sessions.length + 1
          }`,
          ...(sourceSessionId
            ? {
                sourceSessionId,
                linkLabel: 'linked chat',
              }
            : {}),
        })
        setRuntimeState(result.state)
        setSelectedSessionId(result.sessionId)
        setPendingLinkedSourceId(null)
        setActiveTab('chat')
        return true
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setIsCreating(false)
      }
    },
    [newCwd, newProviderKind, runtimeState.sessions, sessions.length]
  )

  const sendChatMessage = useCallback(async () => {
    if (!window.orrery?.runtime) {
      setRuntimeError('Runtime is available only inside Electron.')
      return
    }

    const trimmed = message.trim()
    if (trimmed.length === 0) {
      return
    }

    if (!selectedSession || !selectedSessionId) {
      const created = await createSessionFromPrompt(trimmed, {
        sourceSessionId: pendingLinkedSourceId,
      })
      if (created) {
        setMessage('')
      }
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
  }, [
    createSessionFromPrompt,
    message,
    pendingLinkedSourceId,
    selectedSession,
    selectedSessionId,
  ])

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

  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (!window.orrery?.runtime) {
        setRuntimeError('Runtime is available only inside Electron.')
        return
      }

      setArchivingSessionIds((current) => ({
        ...current,
        [sessionId]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await window.orrery.runtime.archiveSession({
          sessionId,
          archived,
        })
        setRuntimeState(result.state)
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
      } finally {
        setArchivingSessionIds((current) => {
          const next = { ...current }
          delete next[sessionId]
          return next
        })
      }
    },
    []
  )

  const respondToRuntimeRequest = useCallback(
    async (request: RuntimeRequest, decision: 'approved' | 'denied') => {
      if (!window.orrery?.runtime) {
        setRuntimeError('Runtime is available only inside Electron.')
        return
      }

      setPendingInteractionIds((current) => ({
        ...current,
        [request.id]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await window.orrery.runtime.respondRuntimeRequest({
          sessionId: request.sessionId,
          requestId: request.id,
          decision,
        })
        setRuntimeState(result.state)
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
      } finally {
        setPendingInteractionIds((current) => {
          const next = { ...current }
          delete next[request.id]
          return next
        })
      }
    },
    []
  )

  const setUserInputDraft = useCallback((requestId: string, value: string) => {
    setUserInputDrafts((current) => ({
      ...current,
      [requestId]: value,
    }))
  }, [])

  const answerRuntimeUserInput = useCallback(
    async (request: UserInputRequest) => {
      if (!window.orrery?.runtime) {
        setRuntimeError('Runtime is available only inside Electron.')
        return
      }

      const answer = userInputDrafts[request.id] ?? ''

      setPendingInteractionIds((current) => ({
        ...current,
        [request.id]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await window.orrery.runtime.answerUserInput({
          sessionId: request.sessionId,
          requestId: request.id,
          answer,
        })
        setRuntimeState(result.state)
        setUserInputDrafts((current) => {
          const next = { ...current }
          delete next[request.id]
          return next
        })
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
      } finally {
        setPendingInteractionIds((current) => {
          const next = { ...current }
          delete next[request.id]
          return next
        })
      }
    },
    [userInputDrafts]
  )

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

  const upsertManagedCluster = useCallback(async () => {
    if (!window.orrery?.runtime) {
      setRuntimeError('Runtime is available only inside Electron.')
      return
    }

    if (workflowManagedNodeIds.length === 0) {
      setRuntimeError('Select at least one worker node for the cluster.')
      return
    }

    setIsUpdatingCluster(true)
    setRuntimeError(undefined)

    try {
      const result = await window.orrery.runtime.upsertCluster({
        clusterId: activeClusterId,
        label: clusterLabel,
        nodeIds: workflowManagedNodeIds,
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
    workflowManagedNodeIds,
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

    const cwd = newCwd.trim()
    const cwdValidation = validateProjectCwd(cwd)
    if (!cwdValidation.ok) {
      setRuntimeError(cwdValidation.message)
      return
    }

    setIsCreatingMaster(true)
    setRuntimeError(undefined)

    try {
      const selectedProvider = providerOption(newProviderKind)
      const result = await window.orrery.runtime.createMasterForCluster({
        clusterId: activeClusterId,
        prompt: masterPrompt,
        cwd,
        agent: selectedProvider.agent,
        providerKind: selectedProvider.id,
        label: `${runtimeState.clusters[activeClusterId]?.label ?? 'Cluster'} Master`,
        loopPolicy: currentLoopPolicy(),
      })
      setRuntimeState(result.state)
      setPendingLinkedSourceId(null)
      setSelectedSessionId(result.sessionId)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCreatingMaster(false)
    }
  }, [
    activeClusterId,
    currentLoopPolicy,
    masterPrompt,
    newCwd,
    newProviderKind,
    runtimeState.clusters,
  ])

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

  const freezeSelectedSession = useCallback(async () => {
    if (!window.orrery?.runtime || !selectedSessionId || !selectedSession) {
      return
    }

    setIsFreezingSelected(true)
    setRuntimeError(undefined)

    try {
      const reason = `Frozen from Workflows panel: ${selectedSession.label}`
      const source =
        activeMasterSession?.sessionId &&
        activeMasterSession.sessionId !== selectedSessionId
          ? activeMasterSession.sessionId
          : undefined
      const result = await window.orrery.runtime.freeze({
        target: selectedSessionId,
        reason,
        source,
        masterReason: source ? reason : undefined,
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsFreezingSelected(false)
    }
  }, [activeMasterSession, selectedSession, selectedSessionId])

  const freezeActiveCluster = useCallback(async () => {
    if (!window.orrery?.runtime || !activeClusterId || !activeCluster) {
      return
    }

    setIsFreezingCluster(true)
    setRuntimeError(undefined)

    try {
      const reason = `Frozen from Workflows panel: ${activeCluster.label}`
      const result = await window.orrery.runtime.freeze({
        target: activeClusterId,
        reason,
        source: activeMasterSession?.sessionId,
        masterReason: activeMasterSession ? reason : undefined,
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsFreezingCluster(false)
    }
  }, [activeCluster, activeClusterId, activeMasterSession])

  const updateCanvasNodePositions = useCallback((changes: NodeChange[]) => {
    setCanvasNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const beginCanvasNodeDrag = useCallback(() => {
    isDraggingCanvasNodeRef.current = true
  }, [])

  const persistCanvasNodePositions = useCallback(
    (
      _event: globalThis.MouseEvent | TouchEvent,
      node: Node,
      draggedNodes: Node[]
    ) => {
      isDraggingCanvasNodeRef.current = false
      const updates = nodePositionUpdatesFromFlowNodes(
        draggedNodes.length > 0 ? draggedNodes : [node]
      )
      if (updates.length === 0) {
        return
      }

      setCanvasNodes((current) => applyFlowNodePositionUpdates(current, updates))
      setRuntimeState((current) => applyNodePositionUpdates(current, updates))

      if (!window.orrery?.runtime?.updateNodePositions) {
        return
      }

      window.orrery.runtime
        .updateNodePositions({ positions: updates })
        .then((result) => setRuntimeState(result.state))
        .catch((error: unknown) => {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        })
    },
    []
  )

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

      const selectedClusterId = nextSelection
        .map(
          (nodeId) =>
            runtimeState.nodes.find((node) => node.nodeId === nodeId)?.clusterId
        )
        .find((clusterId): clusterId is string => Boolean(clusterId))
      if (selectedClusterId) {
        setActiveClusterId((current) =>
          current === selectedClusterId ? current : selectedClusterId
        )
      }
    },
    [runtimeState.nodes]
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
                  Code agent workspace
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

          <div className="app-region-no-drag shrink-0 px-3 pb-2">
            <Button
              className="h-9 w-full justify-center font-mono text-[12px] uppercase tracking-[0.08em]"
              onClick={startNewChat}
            >
              <MessageSquarePlus className="size-4" />
              New Chat
            </Button>
          </div>

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
            <div className="app-region-no-drag mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11.5px] leading-5 text-destructive">
              <span className="shrink-0">✗</span>
              <span className="min-w-0 break-words">{runtimeError}</span>
            </div>
          ) : null}

          <RuntimeDiagnosticsBanner diagnostics={runtimeDiagnostics} />

          <div className="app-region-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === 'orchestrate' ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
                <section className="space-y-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-mono text-[12px]">
                        <Orbit className="size-3.5 text-accent-ink" />
                        <span className="text-foreground">Workflows</span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        Review loop setup
                      </p>
                    </div>
                    <span
                      className={cn(
                        statePillBase,
                        activeLoopStatus === 'running'
                          ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
                          : activeCluster?.frozen
                            ? 'border-border bg-muted text-muted-foreground'
                            : 'border-ink-line bg-foreground/[0.04] text-term-dim'
                      )}
                    >
                      {activeCluster?.frozen ? 'frozen' : activeLoopStatus}
                    </span>
                  </div>

                  <div className="grid gap-2">
                    {setupSteps.map((step, index) => (
                      <WorkflowStep
                        key={step.title}
                        index={index + 1}
                        title={step.title}
                        detail={step.detail}
                        status={step.status}
                      />
                    ))}
                  </div>
                </section>

                <section className="space-y-2.5 rounded-lg border border-ink-line bg-ink p-3 font-mono">
                  <div className="flex items-center gap-2">
                    <ClipboardCheck className="size-3.5 text-term-cyan" />
                    <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                      Active workflow
                    </span>
                    <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">
                      {activeCluster ? activeManagedSessions.length : 0} managed
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <WorkflowSummaryRow label="cluster">
                      {activeCluster?.label ?? (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="workers">
                      {activeManagedSessions.length ? (
                        <span className="flex flex-wrap gap-1.5">
                          {activeManagedSessions.slice(0, 4).map((session) => (
                            <TermChip key={session.sessionId}>
                              {session.label}
                            </TermChip>
                          ))}
                          {activeManagedSessions.length > 4 ? (
                            <TermChip>
                              +{activeManagedSessions.length - 4}
                            </TermChip>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="master">
                      {activeMasterSession ? (
                        <button
                          type="button"
                          className="max-w-full truncate text-term-amber underline-offset-2 hover:underline"
                          onClick={() => {
                            setPendingLinkedSourceId(null)
                            setSelectedSessionId(activeMasterSession.sessionId)
                            setActiveTab('chat')
                          }}
                        >
                          {activeMasterSession.label}
                        </button>
                      ) : (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="policy">
                      {activeCluster ? (
                        loopPolicySummary(activeCluster) ?? (
                          <span className="text-term-faint">none</span>
                        )
                      ) : (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="loop">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            statePillBase,
                            activeLoopStatus === 'running'
                              ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
                              : 'border-ink-line bg-foreground/[0.04] text-term-dim'
                          )}
                        >
                          {activeLoopStatus}
                        </span>
                        <span className="tabular-nums text-term-cyan">
                          {activeLoopIterations}/{activeLoopMaxIterations}
                        </span>
                      </span>
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="coder">
                      {activeLoopCoder?.label ?? (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="reviewer">
                      {activeLoopReviewer?.label ?? (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="last">
                      <span className="truncate">{activeLoopLastEvent}</span>
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="reason">
                      {activeLoopReason ?? activeCluster?.freezeReason ?? (
                        <span className="text-term-faint">none</span>
                      )}
                    </WorkflowSummaryRow>
                    <WorkflowSummaryRow label="frozen">
                      {activeCluster?.frozen ? (
                        <span className="inline-flex items-center gap-1 text-term-amber">
                          <Snowflake className="size-3" />
                          {activeCluster.freezeReason ?? 'yes'}
                        </span>
                      ) : (
                        <span className="text-term-dim2">no</span>
                      )}
                    </WorkflowSummaryRow>
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 font-mono">
                    <GitBranch className="size-3.5 text-accent-ink" />
                    <span className="text-[12px] text-foreground">
                      1. Cluster scope
                    </span>
                    <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
                      {workflowManagedNodeIds.length} managed
                    </span>
                  </div>

                  <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
                    <label className="min-w-0 space-y-1.5">
                      <TermLabel>cluster name</TermLabel>
                      <input
                        className={termInputCls}
                        value={clusterLabel}
                        onChange={(event) => setClusterLabel(event.target.value)}
                      />
                    </label>
                    <label className="space-y-1.5">
                      <TermLabel>max turns</TermLabel>
                      <input
                        className={cn(termInputCls, 'tabular-nums')}
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
                    <TermChip tone="lime">Review until clean</TermChip>
                    <TermChip>Freeze on stop</TermChip>
                    <TermChip>Max {currentLoopPolicy().maxIterations}</TermChip>
                  </div>

                  <div className="rounded-lg border border-ink-line bg-ink px-3 py-2 font-mono">
                    <WorkflowSummaryRow label="workers">
                      {workflowManagedNodeIds.length ? (
                        <span className="flex flex-wrap gap-1.5">
                          {workflowManagedNodeIds.slice(0, 4).map((sessionId) => (
                            <TermChip key={sessionId}>
                              {runtimeState.sessions[sessionId]?.label ??
                                compactId(sessionId)}
                            </TermChip>
                          ))}
                          {workflowManagedNodeIds.length > 4 ? (
                            <TermChip>
                              +{workflowManagedNodeIds.length - 4}
                            </TermChip>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-term-faint">
                          canvas selection or current worker chat
                        </span>
                      )}
                    </WorkflowSummaryRow>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      className={termActionBtnCls}
                      variant="outline"
                      disabled={
                        !isElectron ||
                        isUpdatingCluster ||
                        workflowManagedNodeIds.length === 0
                      }
                      onClick={upsertManagedCluster}
                    >
                      <GitBranch className="size-4 shrink-0" />
                      <span className="truncate">Save cluster</span>
                    </Button>
                    <Button
                      className={termActionBtnCls}
                      variant="outline"
                      disabled={
                        !isElectron || isUpdatingCluster || !activeClusterId
                      }
                      onClick={saveLoopPolicy}
                    >
                      <ClipboardCheck className="size-4 shrink-0" />
                      <span className="truncate">Save policy</span>
                    </Button>
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 font-mono">
                    <Bot className="size-3.5 text-term-amber" />
                    <span className="text-[12px] text-foreground">
                      2. Master chat
                    </span>
                    <span className="ml-auto truncate text-[10.5px] text-muted-foreground">
                      {activeMasterSession?.label ?? 'none'}
                    </span>
                  </div>

                  <ProjectCwdField
                    value={newCwd}
                    validation={newCwdValidation}
                    disabled={isCreatingMaster}
                    onChange={setNewCwd}
                  />

                  <div className="space-y-1.5">
                    <TermLabel>provider</TermLabel>
                    <ProviderSegmentedControl
                      value={newProviderKind}
                      disabled={isCreatingMaster}
                      onChange={setNewProviderKind}
                    />
                  </div>

                  <label className="block space-y-1.5">
                    <TermLabel>master instructions</TermLabel>
                    <textarea
                      className={cn(
                        termTextareaCls,
                        'min-h-20 max-h-32 text-xs leading-5'
                      )}
                      value={masterPrompt}
                      onChange={(event) => setMasterPrompt(event.target.value)}
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      className={termActionBtnCls}
                      disabled={
                        !isElectron ||
                        isCreatingMaster ||
                        !activeClusterId ||
                        !newCwdValidation.ok
                      }
                      onClick={createMasterForCluster}
                    >
                      <Bot className="size-4 shrink-0" />
                      <span className="truncate">
                        {activeCluster?.masterSessionId
                          ? 'Open master'
                          : 'Create master'}
                      </span>
                    </Button>
                    <Button
                      className={termActionBtnCls}
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
                      <span className="truncate">Use selected</span>
                    </Button>
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 font-mono">
                    <CirclePlay className="size-3.5 text-accent-ink" />
                    <span className="text-[12px] text-foreground">
                      3. Run and freeze
                    </span>
                    <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
                      {activeLoopIterations}/{activeLoopMaxIterations}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      className={termActionBtnCls}
                      disabled={!isElectron || isStartingLoop || !canStartLoop}
                      onClick={startMasterLoop}
                    >
                      <CirclePlay className="size-4 shrink-0" />
                      <span className="truncate">
                        {isStartingLoop ? 'Starting...' : 'Run loop'}
                      </span>
                    </Button>
                    <Button
                      className={termActionBtnCls}
                      variant="outline"
                      disabled={!isElectron || isStoppingLoop || !canStopLoop}
                      onClick={stopMasterLoop}
                    >
                      <Square className="size-4 shrink-0" />
                      <span className="truncate">
                        {isStoppingLoop ? 'Stopping...' : 'Stop loop'}
                      </span>
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <div className="rounded-lg border border-ink-line bg-ink p-3 font-mono">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-term-name">
                          {selectedSession?.label ?? 'Selected chat'}
                        </span>
                        <span
                          className={cn(
                            statePillBase,
                            workflowStatusPillClassName(
                              !selectedSession
                                ? 'blocked'
                                : selectedSessionFrozen
                                  ? 'done'
                                  : 'active'
                            )
                          )}
                        >
                          {!selectedSession
                            ? 'no chat'
                            : selectedSessionFrozen
                              ? 'frozen'
                              : 'ready'}
                        </span>
                      </div>
                      <Button
                        className={cn(termActionBtnCls, 'mt-2 w-full')}
                        variant="outline"
                        disabled={
                          !isElectron ||
                          isFreezingSelected ||
                          !canFreezeSelectedSession
                        }
                        onClick={freezeSelectedSession}
                      >
                        <Snowflake className="size-4 shrink-0" />
                        <span className="truncate">
                          {isFreezingSelected ? 'Freezing...' : 'Freeze chat'}
                        </span>
                      </Button>
                    </div>

                    <div className="rounded-lg border border-ink-line bg-ink p-3 font-mono">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-term-name">
                          {activeCluster?.label ?? 'Active cluster'}
                        </span>
                        <span
                          className={cn(
                            statePillBase,
                            workflowStatusPillClassName(
                              !activeCluster
                                ? 'blocked'
                                : activeCluster.frozen
                                  ? 'done'
                                  : 'active'
                            )
                          )}
                        >
                          {!activeCluster
                            ? 'no cluster'
                            : activeCluster.frozen
                              ? 'frozen'
                              : 'ready'}
                        </span>
                      </div>
                      <Button
                        className={cn(termActionBtnCls, 'mt-2 w-full')}
                        variant="outline"
                        disabled={
                          !isElectron ||
                          isFreezingCluster ||
                          !canFreezeActiveCluster
                        }
                        onClick={freezeActiveCluster}
                      >
                        <Snowflake className="size-4 shrink-0" />
                        <span className="truncate">
                          {isFreezingCluster
                            ? 'Freezing...'
                            : 'Freeze cluster'}
                        </span>
                      </Button>
                    </div>
                  </div>
                </section>

                {clusters.length ? (
                  <section className="space-y-2">
                    <div className="flex items-center gap-2 font-mono">
                      <MessagesSquare className="size-3.5 text-accent-ink" />
                      <span className="text-[12px] text-foreground">
                        Saved workflows
                      </span>
                      <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
                        {clusters.length}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {clusters.map((cluster) => {
                        const isActive = activeClusterId === cluster.clusterId
                        const master = cluster.masterSessionId
                          ? runtimeState.sessions[cluster.masterSessionId]
                          : undefined
                        const loopStatus = loopStateStatus(cluster)
                        return (
                          <button
                            key={cluster.clusterId}
                            type="button"
                            className={cn(
                              'w-full rounded-lg border bg-ink px-3 py-2 text-left font-mono transition',
                              isActive
                                ? 'border-lime-hi/50 ring-1 ring-lime-hi/25'
                                : 'border-ink-line hover:border-foreground/20'
                            )}
                            onClick={() => {
                              setActiveClusterId(cluster.clusterId)
                              if (cluster.masterSessionId) {
                                setPendingLinkedSourceId(null)
                                setSelectedSessionId(cluster.masterSessionId)
                              }
                            }}
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              <span
                                className={cn(
                                  'w-3.5 shrink-0 text-center text-[12px] leading-none',
                                  isActive ? 'text-lime-hi' : 'text-term-dim2'
                                )}
                              >
                                {isActive ? '●' : '○'}
                              </span>
                              <span
                                className={cn(
                                  'min-w-0 flex-1 truncate text-[13px] font-medium',
                                  isActive ? 'text-lime-hi' : 'text-lime'
                                )}
                              >
                                {cluster.label}
                              </span>
                              {cluster.frozen ? (
                                <Snowflake className="size-3.5 shrink-0 text-term-amber" />
                              ) : null}
                              <span
                                className={cn(
                                  statePillBase,
                                  loopStatus === 'running'
                                    ? 'border-term-amber/30 bg-term-amber/10 text-term-amber'
                                    : 'border-ink-line bg-foreground/[0.04] text-term-dim'
                                )}
                              >
                                {cluster.frozen ? 'frozen' : loopStatus}
                              </span>
                            </div>
                            <div className="mt-1.5 grid gap-0.5 text-[11px]">
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">├</span>
                                <span className="w-14 shrink-0 text-term-dim2">
                                  nodes
                                </span>
                                <span className="truncate text-term-dim">
                                  {cluster.nodeIds.length} managed
                                  {master ? ` · ${master.label}` : ''}
                                </span>
                              </div>
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">└</span>
                                <span className="w-14 shrink-0 text-term-dim2">
                                  policy
                                </span>
                                <span className="truncate text-term-dim2">
                                  {loopPolicySummary(cluster) ?? 'no policy'}
                                </span>
                              </div>
                            </div>
                          </button>
                        )
                      })}
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
                    <span className="text-foreground">Chats</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {runningSessions.length} running · {sessions.length} total
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-ink-line bg-ink px-2.5 py-1.5">
                      <Search className="size-3.5 shrink-0 text-term-dim2" />
                      <input
                        className="min-w-0 flex-1 bg-transparent text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint"
                        value={sessionSearch}
                        spellCheck={false}
                        placeholder="Search label, id, provider, cwd, status, messages"
                        onChange={(event) => setSessionSearch(event.target.value)}
                      />
                      {sessionSearch.trim().length > 0 ? (
                        <button
                          type="button"
                          className="rounded p-1 text-term-dim2 hover:bg-foreground/[0.06] hover:text-term-name"
                          aria-label="Clear search"
                          onClick={() => setSessionSearch('')}
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      aria-pressed={showArchivedSessions}
                      className={cn(
                        'shrink-0 rounded-lg border px-2.5 py-2 text-[10.5px] uppercase tracking-[0.08em] transition',
                        showArchivedSessions
                          ? 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan'
                          : 'border-ink-line bg-ink text-term-dim hover:border-foreground/20'
                      )}
                      onClick={() =>
                        setShowArchivedSessions((current) => !current)
                      }
                    >
                      {showArchivedSessions
                        ? 'All'
                        : `Hidden ${archivedSessionCount}`}
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                  {sessions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-ink-line bg-ink p-5 text-center font-mono text-sm text-term-dim2">
                      No chats yet.
                    </div>
                  ) : null}

                  {sessions.length > 0 && filteredSessions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-ink-line bg-ink p-5 text-center font-mono text-sm text-term-dim2">
                      No chats match the current search.
                    </div>
                  ) : null}

                  {filteredSessions.map((session) => {
                    const latestReport = latestReportForSession(
                      runtimeState.reports,
                      session.sessionId
                    )
                    const latestVerdict =
                      latestReport?.payload.type === 'verdict'
                        ? latestReport.payload.verdict
                        : undefined
                    const node = runtimeState.nodes.find(
                      (candidate) => candidate.sessionId === session.sessionId
                    )
                    const managedCluster = Object.values(runtimeState.clusters).find(
                      (cluster) => cluster.nodeIds.includes(session.sessionId)
                    )
                    const recovery = sessionRecoveryState({
                      session,
                      diagnostics: runtimeDiagnostics,
                      frozen: node?.frozen === true || managedCluster?.frozen === true,
                    })

                    const isSel = selectedSessionId === session.sessionId
                    const marker = sessionMarker(
                      session.status,
                      isSel,
                      session.role
                    )
                    const idLabel = sessionChatId(session)
                    const preview = clampOneLine(lastMessagePreview(session), 140)
                    const canArchive =
                      session.status !== 'running' && session.status !== 'pending'
                    const archivePending =
                      archivingSessionIds[session.sessionId] === true

                    return (
                      <div
                        key={session.sessionId}
                        className={cn(
                          'relative rounded-lg border bg-ink font-mono transition',
                          isSel
                            ? 'border-lime-hi/50 ring-1 ring-lime-hi/25'
                            : 'border-ink-line hover:border-foreground/20'
                        )}
                      >
                        {isSel ? (
                          <span className="absolute bottom-2.5 left-0 top-2.5 w-0.5 rounded-full bg-lime-hi" />
                        ) : null}
                        <div className="flex items-start gap-2 p-3 pl-3.5">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setPendingLinkedSourceId(null)
                              setSelectedSessionId(session.sessionId)
                              setActiveTab('chat')
                            }}
                          >
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
                              {session.archived ? (
                                <span className="rounded border border-ink-line bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-term-dim">
                                  hidden
                                </span>
                              ) : null}
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
                            <div className="mt-2 grid gap-0.5 text-[11.5px]">
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">├</span>
                                <span className="w-[58px] shrink-0 text-term-dim2">
                                  id
                                </span>
                                <span className="truncate text-term-cyan">
                                  {idLabel}
                                </span>
                              </div>
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">├</span>
                                <span className="w-[58px] shrink-0 text-term-dim2">
                                  provider
                                </span>
                                <span className="truncate text-term-dim">
                                  {sessionProviderLabel(session)}
                                </span>
                              </div>
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">├</span>
                                <span className="w-[58px] shrink-0 text-term-dim2">
                                  cwd
                                </span>
                                <span
                                  className="truncate text-term-dim"
                                  title={session.cwd}
                                >
                                  {compactPath(session.cwd)}
                                </span>
                              </div>
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">├</span>
                                <span className="w-[58px] shrink-0 text-term-dim2">
                                  preview
                                </span>
                                <span className="truncate text-term-dim">
                                  {preview}
                                </span>
                              </div>
                              <div className="flex min-w-0 gap-2">
                                <span className="text-term-faint">└</span>
                                <span className="w-[58px] shrink-0 text-term-dim2">
                                  updated
                                </span>
                                <span className="truncate text-term-dim">
                                  <span className="text-term-cyan">
                                    {session.messages.length}
                                  </span>{' '}
                                  msgs · {formatTimestamp(session.updatedAt)}
                                </span>
                              </div>
                            </div>
                          </button>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="shrink-0 rounded-md border border-ink-line bg-background/35 p-1.5 text-term-dim transition hover:border-foreground/20 hover:text-term-name disabled:cursor-not-allowed disabled:opacity-45"
                                disabled={
                                  !isElectron || archivePending || !canArchive
                                }
                                aria-label={
                                  session.archived ? 'Restore chat' : 'Hide chat'
                                }
                                onClick={() =>
                                  setSessionArchived(
                                    session.sessionId,
                                    !session.archived
                                  )
                                }
                              >
                                {session.archived ? (
                                  <ArchiveRestore className="size-3.5" />
                                ) : (
                                  <Archive className="size-3.5" />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {session.archived ? 'Restore chat' : 'Hide chat'}
                            </TooltipContent>
                          </Tooltip>
                        </div>

                        <div className="px-3 pb-3">
                          {recovery ? (
                            <div className="mb-2">
                              <RecoveryNotice state={recovery} compact />
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-1.5">
                            <SessionMetaPill
                              label="created"
                              value={formatTimestamp(session.createdAt)}
                              title={session.createdAt}
                            />
                            <SessionMetaPill
                              label="status"
                              value={statusLabels[session.status]}
                            />
                            {session.exitCode !== undefined &&
                            session.exitCode !== null ? (
                              <SessionMetaPill
                                label="exit"
                                value={String(session.exitCode)}
                              />
                            ) : null}
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
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {activeTab === 'chat' ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b border-border bg-card px-3.5 py-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          Chat
                        </span>
                        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                          {selectedSession?.label ??
                            (pendingLinkedSource ? 'Linked Chat' : 'New Chat')}
                        </h2>
                        {!selectedSession ? (
                          <span className="shrink-0 font-mono text-[11px] text-accent-ink">
                            {providerOption(newProviderKind).label}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
                        {selectedSession ? (
                          <>
                            <span className="shrink-0 text-foreground/75">
                              {sessionProviderLabel(selectedSession)}
                            </span>
                            <span className="shrink-0 text-term-faint">|</span>
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={selectedSession.cwd}
                            >
                              {compactPath(selectedSession.cwd)}
                            </span>
                            <span className="shrink-0 text-term-faint">|</span>
                            <span
                              className="shrink-0 text-foreground/70"
                              title={sessionChatId(selectedSession)}
                            >
                              {compactId(sessionChatId(selectedSession))}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="shrink-0 text-foreground/75">
                              {providerOption(newProviderKind).label}
                            </span>
                            <span className="shrink-0 text-term-faint">|</span>
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={newCwd}
                            >
                              {newCwd.trim()
                                ? compactPath(newCwd.trim())
                                : 'cwd required'}
                            </span>
                            {pendingLinkedSource ? (
                              <>
                                <span className="shrink-0 text-term-faint">|</span>
                                <span
                                  className="min-w-0 flex-1 truncate text-foreground/70"
                                  title={pendingLinkedSource.sessionId}
                                >
                                  from {pendingLinkedSource.label}
                                </span>
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {selectedSession ? (
                        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              statusDotClassNames[selectedSession.status]
                            )}
                          />
                          {statusLabels[selectedSession.status]}
                        </span>
                      ) : null}
                      {selectedSession ? (
                        <Button
                          className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                          variant="outline"
                          size="sm"
                          disabled={!isElectron}
                          onClick={startLinkedChat}
                        >
                          <GitBranch className="size-3.5" />
                          Linked
                        </Button>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            className="app-region-no-drag size-7"
                            variant={showRawEvents ? 'secondary' : 'ghost'}
                            size="icon"
                            aria-label="Diagnostics"
                            onClick={() => setShowRawEvents((current) => !current)}
                          >
                            <Braces className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Diagnostics</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  {selectedRecoveryState ? (
                    <div className="mt-2">
                      <RecoveryNotice state={selectedRecoveryState} compact />
                    </div>
                  ) : null}
                </div>

                <RuntimeInteractionPanel
                  requests={openRuntimeRequests}
                  userInputRequests={openUserInputRequests}
                  userInputDrafts={userInputDrafts}
                  pendingInteractionIds={pendingInteractionIds}
                  onRespond={respondToRuntimeRequest}
                  onDraftChange={setUserInputDraft}
                  onAnswer={answerRuntimeUserInput}
                />

                {showRawEvents ? (
                  selectedSession ? (
                    <ProviderEventDrawer session={selectedSession} />
                  ) : (
                    <ProviderSetupDiagnostics
                      isRuntimeAvailable={isElectron}
                      providerKind={newProviderKind}
                      runtimeError={runtimeError}
                    />
                  )
                ) : null}

                <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
                  <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-ink-line-2 bg-ink px-4 py-2.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                      Messages
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] tabular-nums text-term-faint">
                      {selectedSession?.messages.length ?? 0} messages
                    </span>
                  </div>
                  {selectedSession?.messages.length ? (
                    transcript.map(({ message, turn }) => (
                      <ChatMessage
                        key={message.id}
                        message={message}
                        turn={turn}
                        agent={selectedSession.agent}
                      />
                    ))
                  ) : (
                    <div className="m-3.5 rounded-lg border border-dashed border-ink-line p-5 text-center font-mono text-sm text-term-dim2">
                      {selectedSession ? 'No messages yet.' : 'New Chat'}
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-border bg-card p-2.5">
                  {!selectedSession ? (
                    <div className="app-region-no-drag mb-2 space-y-2">
                      <ProviderSegmentedControl
                        value={newProviderKind}
                        disabled={isCreating}
                        onChange={setNewProviderKind}
                      />
                      <ProjectCwdField
                        value={newCwd}
                        validation={newCwdValidation}
                        disabled={isCreating}
                        onChange={setNewCwd}
                      />
                    </div>
                  ) : null}
                  <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-ink-line bg-ink px-3 py-2.5 transition focus-within:border-lime-hi/55 focus-within:ring-1 focus-within:ring-lime-hi/25">
                    <span className="pt-0.5 font-mono text-lime-hi">❯</span>
                    <textarea
                      className="max-h-28 min-h-9 w-full resize-y bg-transparent font-mono text-[13px] leading-6 text-term-name outline-none placeholder:text-term-faint disabled:opacity-60"
                      placeholder={
                        selectedSession
                          ? 'Message this chat'
                          : pendingLinkedSource
                            ? 'Start a linked chat'
                            : 'Start a new chat'
                      }
                      value={message}
                      disabled={
                        !isElectron ||
                        (selectedSession ? !canResume || isResuming : isCreating)
                      }
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Button
                      className="app-region-no-drag min-w-0 justify-center font-mono text-[12px] uppercase tracking-[0.08em]"
                      disabled={
                        !isElectron ||
                        (selectedSession
                          ? !canResume || isResuming
                          : isCreating || !newCwdValidation.ok) ||
                        message.trim().length === 0
                      }
                      onClick={sendChatMessage}
                    >
                      <Send className="size-4 shrink-0" />
                      <span className="truncate">
                        {!selectedSession && pendingLinkedSource
                          ? 'Create Linked Chat'
                          : 'Send'}
                      </span>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          className="app-region-no-drag"
                          variant="destructive"
                          size="icon"
                          disabled={!selectedSession || !canKill}
                          aria-label="Stop"
                          onClick={killSelectedSession}
                        >
                          <Square className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Stop</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <footer className="app-region-no-drag flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 font-mono text-[11px] tracking-[0.02em] text-muted-foreground">
            <span className="flex items-center gap-1.5" title="Running chats">
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
            <span className="flex items-center gap-1" title="Links">
              <GitBranch className="size-3" />
              <span className="tabular-nums">{runtimeState.edges.length}</span>
            </span>
            <span className="flex items-center gap-1" title="Reports">
              <FileText className="size-3" />
              <span className="tabular-nums">{runtimeState.reports.length}</span>
            </span>
          </footer>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 font-mono">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex shrink-0 items-center gap-2 text-[12px] text-foreground">
                <Activity className="size-4 text-accent-ink" />
                Session graph
              </span>
              <span className="truncate text-[12px] text-muted-foreground">
                Code-agent chats and handoffs
              </span>
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
            {graphActivity.length > 0 ? (
              <div className="pointer-events-none absolute bottom-3 right-3 z-10 w-[280px] max-w-[calc(100%-1.5rem)] opacity-80 transition-opacity hover:opacity-100">
                <div className="pointer-events-auto rounded-lg border border-border bg-background/88 font-mono shadow-sm backdrop-blur">
                  <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
                    <Activity className="size-3 shrink-0 text-accent-ink" />
                    <h2 className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Graph events
                    </h2>
                    <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">
                      {graphActivity.length}
                    </span>
                  </div>

                  <ol className="max-h-36 space-y-2 overflow-y-auto p-2.5">
                    {graphActivity.slice(-4).map((event, index) => (
                      <li
                        key={event.id}
                        className="grid grid-cols-[auto_1fr] gap-2.5 text-xs"
                      >
                        <span className="pt-0.5 text-[11px] tabular-nums text-term-faint">
                          {String(
                            graphActivity.length -
                              Math.min(graphActivity.length, 4) +
                              index +
                              1
                          ).padStart(2, '0')}
                        </span>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={cn(
                                'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em]',
                                event.kind === 'report'
                                  ? edgeKindClassNames.report
                                  : edgeKindClassNames[event.kind]
                              )}
                            >
                              {activityTitle(event.kind)}
                            </span>
                            <span className="truncate font-medium text-foreground/90">
                              {event.title}
                            </span>
                          </div>
                          {event.detail ? (
                            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
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
                </div>
              </div>
            ) : null}
            <ReactFlow
              colorMode={colorScheme}
              nodes={canvasNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={updateCanvasNodePositions}
              onNodeDragStart={beginCanvasNodeDrag}
              onNodeDragStop={persistCanvasNodePositions}
              onNodeClick={(_event, node) => {
                if (!node.id.startsWith('cluster:')) {
                  const graphNode = runtimeState.nodes.find(
                    (candidate) => candidate.nodeId === node.id
                  )
                  if (graphNode?.clusterId) {
                    setActiveClusterId(graphNode.clusterId)
                  }
                  setPendingLinkedSourceId(null)
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
