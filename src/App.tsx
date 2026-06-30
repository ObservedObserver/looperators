import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  ChevronDown,
  ClipboardCheck,
  CirclePlay,
  FileText,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  MessageSquarePlus,
  MessagesSquare,
  Moon,
  Orbit,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  RefreshCw,
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
import { AgentMarkdown } from '@/components/agent-markdown'
import { ToolRunFeed } from '@/components/tool-run-feed'
import {
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
  type ProjectContext,
  type ProviderSetupStatus,
  type Report,
  type RuntimeStateDiagnostic,
  type SessionStatus,
  type WorkMode,
  type UpdateNodePositionsInput,
  type WorkingTreeDiffResult,
} from '@/shared/graph-state'
import type {
  ChatAttachment,
  NativeProviderEvent,
  ProviderInstance,
  ProviderKind,
  ProviderReasoningEffort,
  ProviderRuntimeEvent,
  ProviderRuntimeMode,
  ProviderRuntimeSettings,
  RuntimeRequestDecision,
  RuntimeActivity,
  RuntimePlan,
  RuntimeRequest,
  SessionTimelineEntry,
  TurnDiffSummary,
  UserInputAnswerMap,
  UserInputAnswerValue,
  UserInputRequest,
} from '@/shared/provider-runtime'
import {
  chatAttachmentImageMaxBytes,
  chatAttachmentTextMaxLength,
  isSupportedChatAttachmentImageMimeType,
} from '@/shared/provider-runtime'
import { projectSession } from '@/shared/session-projection'
import { createDemoGraphState } from '@/shared/demo-state'
import {
  getActiveRuntimeClient,
  useRuntimeClient,
} from '@/runtime-client'

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

const chatPanelWidthStorageKey = 'orrery.chatPanelWidth.v1'
const defaultChatPanelWidth = 440
const chatPanelMinWidth = 360
const canvasPanelMinWidth = 520
const chatCanvasSeparatorWidth = 8
const railSidebarWidth = 264
const expandedGraphLayoutMinWidth =
  railSidebarWidth + chatPanelMinWidth + chatCanvasSeparatorWidth + canvasPanelMinWidth
const graphCollapsedStorageKey = 'orrery.graphCollapsed.v1'
const attachmentTextPreviewLimit = chatAttachmentTextMaxLength

function initialChatPanelWidth() {
  if (typeof window === 'undefined') {
    return defaultChatPanelWidth
  }

  try {
    const stored = Number(window.localStorage.getItem(chatPanelWidthStorageKey))
    return Number.isFinite(stored) && stored > 0
      ? stored
      : defaultChatPanelWidth
  } catch {
    return defaultChatPanelWidth
  }
}

function initialGraphCollapsed() {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(graphCollapsedStorageKey) === '1'
  } catch {
    return false
  }
}

function initialViewportWidth() {
  if (typeof window === 'undefined') {
    return expandedGraphLayoutMinWidth
  }

  return window.innerWidth
}

function clampChatPanelWidth(width: number, totalWidth?: number) {
  const maxWidth =
    totalWidth && totalWidth > 0
      ? Math.max(
          chatPanelMinWidth,
          totalWidth -
            railSidebarWidth -
            canvasPanelMinWidth -
            chatCanvasSeparatorWidth
        )
      : Number.POSITIVE_INFINITY
  return Math.min(Math.max(width, chatPanelMinWidth), maxWidth)
}

function createAttachmentId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function fileLooksText(file: File) {
  if (file.type.startsWith('text/')) {
    return true
  }

  return /\.(c|cc|cpp|css|csv|go|h|html|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|ts|tsx|txt|xml|yaml|yml)$/i.test(
    file.name
  )
}

function readBlobAsText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'))
    reader.readAsText(blob)
  })
}

function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image.'))
    reader.readAsDataURL(blob)
  })
}

async function composerAttachmentFromFile(file: File): Promise<ChatAttachment> {
  const canUseNativeImage =
    file.type.startsWith('image/') &&
    isSupportedChatAttachmentImageMimeType(file.type) &&
    file.size <= chatAttachmentImageMaxBytes
  const kind = canUseNativeImage
    ? 'image'
    : fileLooksText(file)
      ? 'text'
      : 'binary'
  const attachment: ChatAttachment = {
    id: createAttachmentId(),
    name: file.name || (kind === 'image' ? 'pasted-image.png' : 'attachment'),
    mediaType: file.type || 'application/octet-stream',
    size: file.size,
    kind,
  }

  if (kind === 'image') {
    return {
      ...attachment,
      dataUrl: await readBlobAsDataUrl(file),
    }
  }

  if (kind === 'text') {
    const slice = file.slice(0, attachmentTextPreviewLimit)
    return {
      ...attachment,
      text: await readBlobAsText(slice),
      truncated: file.size > attachmentTextPreviewLimit,
    }
  }

  return attachment
}

function insertPlainTextAtCaret(text: string) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return false
  }

  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.setEndAfter(node)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
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

function defaultProviderInstanceIdForKind(providerKind: ProviderKind) {
  switch (providerKind) {
    case 'codex':
      return 'default-codex'
    case 'legacy-claude-cli':
      return 'legacy-claude-cli'
    case 'claude-code':
    default:
      return 'default-claude-sdk'
  }
}

function fallbackProviderInstance(providerKind: ProviderKind): ProviderInstance {
  const provider = providerOption(providerKind)
  return {
    providerInstanceId: defaultProviderInstanceIdForKind(providerKind),
    kind: providerKind,
    label: provider.label,
  }
}

function providerInstanceForKind(
  providerInstances: ProviderInstance[],
  providerKind: ProviderKind
) {
  return (
    providerInstances.find((instance) => instance.kind === providerKind) ??
    fallbackProviderInstance(providerKind)
  )
}

function launchArgsText(instance: ProviderInstance) {
  return (instance.launchArgs ?? []).join('\n')
}

function providerInstanceFromDraft(input: {
  instance: ProviderInstance
  label: string
  binaryPath: string
  homePath: string
  shadowHomePath: string
  launchArgs: string
}): ProviderInstance {
  const launchArgs = input.launchArgs
    .split('\n')
    .map((arg) => arg.trim())
    .filter(Boolean)
  return {
    providerInstanceId: input.instance.providerInstanceId,
    kind: input.instance.kind,
    label: input.label.trim() || input.instance.label,
    ...(input.binaryPath.trim() ? { binaryPath: input.binaryPath.trim() } : {}),
    ...(input.homePath.trim() ? { homePath: input.homePath.trim() } : {}),
    ...(input.shadowHomePath.trim()
      ? { shadowHomePath: input.shadowHomePath.trim() }
      : {}),
    ...(launchArgs.length ? { launchArgs } : {}),
    ...(input.instance.env ? { env: input.instance.env } : {}),
  }
}

function providerRuntimeSettingsDraft({
  runtimeMode,
  model,
  reasoningEffort,
}: {
  runtimeMode: ProviderRuntimeMode
  model: string
  reasoningEffort: ProviderReasoningEffort
}): ProviderRuntimeSettings {
  const trimmedModel = model.trim()
  return {
    runtimeMode,
    reasoningEffort,
    ...(trimmedModel ? { model: trimmedModel } : {}),
  }
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

function ProviderInlineSelect({
  value,
  disabled,
  onChange,
}: {
  value: ProviderKind
  disabled?: boolean
  onChange: (value: ProviderKind) => void
}) {
  return (
    <label className="relative shrink-0">
      <span className="sr-only">Provider</span>
      <select
        className="app-region-no-drag h-7 appearance-none rounded-md border border-border bg-background/60 py-1 pl-2 pr-7 font-mono text-[10.5px] text-accent-ink outline-none transition focus:border-lime-hi/55 focus:ring-1 focus:ring-lime-hi/25 disabled:opacity-55"
        value={value}
        disabled={disabled}
        aria-label="Provider"
        onChange={(event) => onChange(event.target.value as ProviderKind)}
      >
        {providerOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </label>
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

function diffPatchLineClassName(line: string) {
  if (line.startsWith('diff --git') || line.startsWith('index ')) {
    return 'text-term-cyan'
  }
  if (line.startsWith('@@')) {
    return 'bg-term-cyan/10 text-term-cyan'
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-term-dim'
  }
  if (line.startsWith('+')) {
    return 'bg-term-green/10 text-term-green'
  }
  if (line.startsWith('-')) {
    return 'bg-term-rose/10 text-term-rose'
  }
  return 'text-term-dim'
}

function diffRangeLabel(diff: WorkingTreeDiffResult) {
  if (diff.range.kind === 'working-tree') {
    return `${diff.range.base} -> ${diff.range.target}`
  }

  const from =
    diff.range.fromTurnCount !== undefined
      ? `turn ${diff.range.fromTurnCount}`
      : diff.range.fromCheckpointRef
  const to =
    diff.range.toTurnCount !== undefined
      ? `turn ${diff.range.toTurnCount}`
      : diff.range.toCheckpointRef
  return `${from} -> ${to}`
}

type ProjectCwdValidation = {
  ok: boolean
  message: string
}

type NewChatProjectOption = {
  id: string
  name: string
  cwd: string
  isGitRepo?: boolean
  currentBranch?: string
  branches: string[]
  error?: string
}

const workModeOptions: { id: WorkMode; label: string }[] = [
  { id: 'local', label: 'Work locally' },
  { id: 'worktree', label: 'New worktree' },
]
const runtimeModeOptions: { id: ProviderRuntimeMode; label: string }[] = [
  { id: 'approval-required', label: 'Supervised' },
  { id: 'auto-accept-edits', label: 'Auto edits' },
  { id: 'full-access', label: 'Full access' },
]
const reasoningEffortOptions: { id: ProviderReasoningEffort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
]
const chooseProjectOptionValue = '__orrery_choose_project__'

type RecoveryTone = 'amber' | 'rose' | 'cyan' | 'muted'

type RecoveryState = {
  tone: RecoveryTone
  title: string
  detail: string
}

type RuntimeDiagnosticNotice = RecoveryState & {
  id: string
  ts: string
  titleText: string
}

function isDemoModeRequested() {
  if (typeof window === 'undefined') {
    return false
  }

  const value = new URLSearchParams(window.location.search).get('demo')
  return value === '1' || value === 'true'
}

function defaultWorkspaceCwd() {
  if (isDemoModeRequested()) {
    return ''
  }

  return getActiveRuntimeClient().workspace.defaultCwd ?? ''
}

function latestSessionCwd(
  sessions: AgentSession[],
  invalidCwds = new Set<string>()
) {
  const latestSession =
    sessions.find((session) => {
      const cwd = session.project?.cwd ?? session.cwd
      return !session.archived && !invalidCwds.has(cwd)
    }) ??
    sessions.find((session) => {
      const cwd = session.project?.cwd ?? session.cwd
      return !invalidCwds.has(cwd)
    })
  return latestSession?.project?.cwd ?? latestSession?.cwd
}

function projectNameFromCwd(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) {
    return 'Project'
  }

  const parts = trimmed.split('/').filter(Boolean)
  const name = parts[parts.length - 1]
  if (!name || name === '~') {
    return compactPath(trimmed)
  }

  return name
}

function uniqueStrings(values: (string | undefined)[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  )
}

function branchCandidatesForSession(session: AgentSession) {
  const project = session.project
  if (!project) {
    return []
  }

  return uniqueStrings([
    project.baseBranch,
    project.workMode === 'local' ? project.branch : undefined,
  ])
}

function projectOptionsFromSessions(
  sessions: AgentSession[],
  selectedCwd: string,
  fallbackCwd: string,
  projectContext?: ProjectContext,
  invalidCwds = new Set<string>()
): NewChatProjectOption[] {
  const projects = new Map<string, NewChatProjectOption>()

  function addProject({
    cwd,
    name,
    isGitRepo,
    currentBranch,
    branches = [],
    error,
  }: {
    cwd?: string
    name?: string
    isGitRepo?: boolean
    currentBranch?: string
    branches?: string[]
    error?: string
  }) {
    const normalizedCwd = cwd?.trim()
    if (!normalizedCwd) {
      return
    }

    const existing = projects.get(normalizedCwd)
    if (existing) {
      existing.branches = uniqueStrings([...existing.branches, ...branches])
      existing.isGitRepo = existing.isGitRepo ?? isGitRepo
      existing.currentBranch = existing.currentBranch ?? currentBranch
      existing.error = existing.error ?? error
      return
    }

    projects.set(normalizedCwd, {
      id: normalizedCwd,
      name: name?.trim() || projectNameFromCwd(normalizedCwd),
      cwd: normalizedCwd,
      isGitRepo,
      currentBranch,
      branches: uniqueStrings(branches),
      error,
    })
  }

  addProject({ cwd: selectedCwd })
  addProject({ cwd: fallbackCwd })
  addProject({
    cwd: projectContext?.cwd,
    name: projectContext?.projectName,
    isGitRepo: projectContext?.isGitRepo,
    currentBranch: projectContext?.currentBranch,
    branches: uniqueStrings([
      projectContext?.currentBranch,
      ...(projectContext?.branches ?? []),
    ]),
    error: projectContext?.error,
  })

  sessions.forEach((session) => {
    const sessionProjectCwd = session.project?.cwd ?? session.cwd
    if (invalidCwds.has(sessionProjectCwd)) {
      return
    }

    addProject({
      cwd: sessionProjectCwd,
      name: session.project?.name,
      isGitRepo: session.project?.repoRoot ? true : undefined,
      currentBranch:
        session.project?.workMode === 'local' ? session.project.branch : undefined,
      branches: branchCandidatesForSession(session),
    })
  })

  return Array.from(projects.values())
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

function diagnosticCwd(diagnostic: RuntimeStateDiagnostic) {
  if (diagnostic.type !== 'storage.cwd_invalid') {
    return undefined
  }

  const cwd = diagnostic.details?.cwd
  return typeof cwd === 'string' ? cwd : undefined
}

function invalidCwdsFromDiagnostics(diagnostics: RuntimeStateDiagnostic[]) {
  return new Set(diagnostics.flatMap((diagnostic) => diagnosticCwd(diagnostic) ?? []))
}

function formatAffectedChats(labels: string[], fallbackCount: number) {
  const uniqueLabels = Array.from(new Set(labels)).filter(Boolean)
  const count = uniqueLabels.length || fallbackCount
  if (uniqueLabels.length === 0) {
    return `${count} ${count === 1 ? 'chat' : 'chats'}`
  }

  const visibleLabels = uniqueLabels.slice(0, 2)
  const remaining = uniqueLabels.length - visibleLabels.length
  return `${visibleLabels.join(', ')}${remaining > 0 ? ` +${remaining} more` : ''}`
}

function affectedChatCount(labels: string[], fallbackCount: number) {
  return Array.from(new Set(labels)).filter(Boolean).length || fallbackCount
}

function latestDiagnosticTs(diagnostics: RuntimeStateDiagnostic[]) {
  return diagnostics.reduce((latest, diagnostic) => {
    const latestMs = parseTimestamp(latest)?.getTime() ?? 0
    const diagnosticMs = parseTimestamp(diagnostic.ts)?.getTime() ?? 0
    return diagnosticMs > latestMs ? diagnostic.ts : latest
  }, diagnostics[0]?.ts ?? '')
}

function runtimeDiagnosticNotices({
  diagnostics,
  sessions,
}: {
  diagnostics: RuntimeStateDiagnostic[]
  sessions: AgentSession[]
}): RuntimeDiagnosticNotice[] {
  const sessionById = new Map(
    sessions.map((session) => [session.sessionId, session])
  )
  const cwdGroups = new Map<string, RuntimeStateDiagnostic[]>()
  const notices: RuntimeDiagnosticNotice[] = []

  diagnostics.forEach((diagnostic) => {
    const cwd = diagnosticCwd(diagnostic)
    if (!cwd) {
      const state = diagnosticDisplay(diagnostic)
      notices.push({
        ...state,
        id: diagnostic.id,
        ts: diagnostic.ts,
        titleText: diagnostic.type,
      })
      return
    }

    const group = cwdGroups.get(cwd) ?? []
    group.push(diagnostic)
    cwdGroups.set(cwd, group)
  })

  cwdGroups.forEach((group, cwd) => {
    const labels = group.flatMap((diagnostic) => {
      const sessionId = diagnosticSessionId(diagnostic)
      if (!sessionId) {
        return []
      }

      return [sessionById.get(sessionId)?.label ?? compactId(sessionId)]
    })
    const affected = formatAffectedChats(labels, group.length)
    const affectedCount = affectedChatCount(labels, group.length)
    const usesVerb = affectedCount === 1 ? 'uses' : 'use'
    notices.push({
      id: `storage.cwd_invalid:${cwd}`,
      ts: latestDiagnosticTs(group),
      titleText: `storage.cwd_invalid ${cwd}`,
      tone: 'rose',
      title:
        affectedCount === 1
          ? 'Project folder unavailable'
          : `${affectedCount} chats need a valid cwd`,
      detail: `${affected} ${usesVerb} ${compactPath(cwd)}. Restore the folder or start linked chats with a valid cwd.`,
    })
  })

  return notices
    .sort((a, b) => {
      const aMs = parseTimestamp(a.ts)?.getTime() ?? 0
      const bMs = parseTimestamp(b.ts)?.getTime() ?? 0
      return bMs - aMs
    })
    .slice(0, 3)
}

function RuntimeDiagnosticsBanner({
  diagnostics,
  sessions,
}: {
  diagnostics: RuntimeStateDiagnostic[]
  sessions: AgentSession[]
}) {
  const visibleNotices = runtimeDiagnosticNotices({ diagnostics, sessions })
  if (visibleNotices.length === 0) {
    return null
  }

  return (
    <div className="app-region-no-drag mx-3 mb-2 space-y-1.5">
      {visibleNotices.map((notice) => {
        return (
          <div
            key={notice.id}
            className={cn(
              'rounded-lg border px-3 py-2 font-mono',
              recoveryToneClassName(notice.tone)
            )}
            title={notice.titleText}
          >
            <div className="flex min-w-0 items-center gap-2">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                {notice.title}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums opacity-70">
                {formatClock(notice.ts)}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-term-dim">
              {notice.detail}
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

function NewChatSetupPill({
  icon: Icon,
  label,
  value,
  disabled,
  className,
  children,
  onChange,
}: {
  icon: LucideIcon
  label: string
  value: string
  disabled?: boolean
  className?: string
  children: ReactNode
  onChange: (value: string) => void
}) {
  return (
    <label
      className={cn(
        'relative flex min-w-0 items-center gap-2 rounded-full border border-accent-ink/30 bg-ink px-3 py-2 font-mono shadow-sm transition focus-within:border-lime-hi/60 focus-within:ring-1 focus-within:ring-lime-hi/25',
        disabled && 'opacity-55',
        className
      )}
    >
      <Icon className="size-3.5 shrink-0 text-lime-hi" />
      <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-term-dim2">
        {label}
      </span>
      <select
        className="min-w-0 flex-1 appearance-none bg-transparent pr-5 text-[12px] font-semibold text-term-name outline-none disabled:cursor-not-allowed"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 size-3.5 text-term-dim2" />
    </label>
  )
}

function NewChatSetupBar({
  projects,
  projectCwd,
  validation,
  workMode,
  branch,
  runtimeMode,
  model,
  reasoningEffort,
  disabled,
  canChooseProject,
  onProjectChange,
  onChooseProject,
  onWorkModeChange,
  onBranchChange,
  onRuntimeModeChange,
  onModelChange,
  onReasoningEffortChange,
}: {
  projects: NewChatProjectOption[]
  projectCwd: string
  validation: ProjectCwdValidation
  workMode: WorkMode
  branch: string
  runtimeMode: ProviderRuntimeMode
  model: string
  reasoningEffort: ProviderReasoningEffort
  disabled?: boolean
  canChooseProject?: boolean
  onProjectChange: (cwd: string) => void
  onChooseProject: () => void
  onWorkModeChange: (workMode: WorkMode) => void
  onBranchChange: (branch: string) => void
  onRuntimeModeChange: (runtimeMode: ProviderRuntimeMode) => void
  onModelChange: (model: string) => void
  onReasoningEffortChange: (reasoningEffort: ProviderReasoningEffort) => void
}) {
  const selectedProject =
    projects.find((project) => project.cwd === projectCwd.trim()) ?? projects[0]
  const branchOptions = uniqueStrings([
    selectedProject?.currentBranch,
    ...(selectedProject?.branches ?? []),
  ])
  const currentBranch = selectedProject?.currentBranch ?? branchOptions[0]
  const localBranchValue = currentBranch ?? ''
  const worktreeBranchValue =
    branch && branchOptions.includes(branch) ? branch : localBranchValue
  const branchValue =
    workMode === 'worktree' ? worktreeBranchValue : localBranchValue
  const isKnownNonGitProject = selectedProject?.isGitRepo === false
  const canPickBranch = workMode === 'worktree' && branchOptions.length > 0

  return (
    <div className="app-region-no-drag mb-2 space-y-1.5">
      <ProjectCwdField
        value={projectCwd}
        validation={validation}
        disabled={disabled}
        onChange={(nextCwd) => {
          onProjectChange(nextCwd)
          onBranchChange('')
        }}
      />
      <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-[minmax(0,1.15fr)_minmax(128px,0.85fr)]">
        <NewChatSetupPill
          icon={FolderOpen}
          label="Project"
          value={selectedProject?.cwd ?? ''}
          disabled={disabled || projects.length === 0}
          className="min-[380px]:col-span-2"
          onChange={(nextCwd) => {
            if (nextCwd === chooseProjectOptionValue) {
              onChooseProject()
              return
            }
            onProjectChange(nextCwd)
            onBranchChange('')
          }}
        >
          {projects.length === 0 ? (
            <option value="">Choose project</option>
          ) : (
            projects.map((project) => (
              <option key={project.id} value={project.cwd}>
                {project.name} - {compactPath(project.cwd)}
              </option>
            ))
          )}
          {canChooseProject ? (
            <option value={chooseProjectOptionValue}>
              Choose project...
            </option>
          ) : null}
        </NewChatSetupPill>

        <NewChatSetupPill
          icon={Terminal}
          label="Work"
          value={workMode}
          disabled={disabled}
          onChange={(nextWorkMode) => {
            const normalized =
              nextWorkMode === 'worktree' ? 'worktree' : 'local'
            onWorkModeChange(normalized)
            if (normalized === 'local') {
              onBranchChange('')
            }
          }}
        >
          {workModeOptions.map((option) => (
            <option
              key={option.id}
              value={option.id}
              disabled={option.id === 'worktree' && isKnownNonGitProject}
            >
              {option.label}
            </option>
          ))}
        </NewChatSetupPill>

        <NewChatSetupPill
          icon={GitBranch}
          label="Branch"
          value={branchValue}
          disabled={disabled || !canPickBranch}
          onChange={onBranchChange}
        >
          {branchValue ? null : <option value="">Current branch</option>}
          {branchOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NewChatSetupPill>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        <NewChatSetupPill
          icon={ClipboardCheck}
          label="Mode"
          value={runtimeMode}
          disabled={disabled}
          onChange={(nextRuntimeMode) =>
            onRuntimeModeChange(nextRuntimeMode as ProviderRuntimeMode)
          }
        >
          {runtimeModeOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </NewChatSetupPill>

        <NewChatSetupPill
          icon={Activity}
          label="Think"
          value={reasoningEffort}
          disabled={disabled}
          onChange={(nextReasoningEffort) =>
            onReasoningEffortChange(nextReasoningEffort as ProviderReasoningEffort)
          }
        >
          {reasoningEffortOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </NewChatSetupPill>

        <label
          className={cn(
            'relative flex min-w-0 items-center gap-2 rounded-full border border-accent-ink/30 bg-ink px-3 py-2 font-mono shadow-sm transition focus-within:border-lime-hi/60 focus-within:ring-1 focus-within:ring-lime-hi/25',
            disabled && 'opacity-55'
          )}
        >
          <Bot className="size-3.5 shrink-0 text-lime-hi" />
          <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-term-dim2">
            Model
          </span>
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] font-semibold text-term-name outline-none placeholder:text-term-faint disabled:cursor-not-allowed"
            value={model}
            disabled={disabled}
            placeholder="provider default"
            aria-label="Model"
            onChange={(event) => onModelChange(event.target.value)}
          />
        </label>
      </div>
      {!validation.ok ? (
        <div className="flex items-center gap-1.5 px-1 font-mono text-[10.5px] leading-4 text-term-rose">
          <TriangleAlert className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{validation.message}</span>
        </div>
      ) : selectedProject?.error ? (
        <div className="flex items-center gap-1.5 px-1 font-mono text-[10.5px] leading-4 text-term-amber">
          <TriangleAlert className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{selectedProject.error}</span>
        </div>
      ) : null}
    </div>
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

function MessageAttachmentStrip({ attachments }: { attachments?: ChatAttachment[] }) {
  if (!attachments?.length) {
    return null
  }

  return (
    <div className="mt-2 grid gap-1.5">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-ink-line bg-foreground/[0.04] px-2 py-1.5 text-[11px]"
        >
          <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded border border-ink-line bg-ink-soft text-term-cyan">
            {attachment.kind === 'image' && attachment.dataUrl ? (
              <img
                className="size-full object-cover"
                src={attachment.dataUrl}
                alt=""
              />
            ) : attachment.kind === 'image' ? (
              <ImageIcon className="size-3.5" />
            ) : (
              <FileText className="size-3.5" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-term-name">{attachment.name}</span>
            <span className="block truncate text-[10px] text-term-dim2">
              {attachment.mediaType} · {formatFileSize(attachment.size)}
              {attachment.truncated ? ' · truncated' : ''}
            </span>
          </span>
          <span className="rounded border border-ink-line bg-background/45 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-term-dim2">
            {attachment.kind}
          </span>
        </div>
      ))}
    </div>
  )
}

function ChatMessage({
  message,
  agent,
}: {
  message: AgentMessage
  agent?: string
}) {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'
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
        <>
          <div className="flex gap-2 text-[13px] leading-6">
            <span className="shrink-0 text-lime-hi">❯</span>
            <span className="whitespace-pre-wrap break-words text-term-name">
              {message.content}
            </span>
          </div>
          <MessageAttachmentStrip attachments={message.attachments} />
        </>
      ) : (
        <>
          {hasText || isStreaming ? (
            <div className="text-[13px] leading-6 text-term-name">
              <AgentMarkdown text={message.content} streaming={isStreaming} />
              {isStreaming ? <span className="orrery-caret ml-1" /> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function TurnBoundaryRow({
  entry,
}: {
  entry: Extract<SessionTimelineEntry, { kind: 'turn' }>
}) {
  return (
    <div className="border-t border-ink-line-2 px-4 py-2 font-mono first:border-t-0">
      <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em] text-term-faint">
        <span className="h-px flex-1 bg-ink-line" />
        <span>{entry.status === 'started' ? 'Turn started' : 'Turn completed'}</span>
        <span className="text-term-dim2">{formatClock(entry.ts)}</span>
        <span className="h-px flex-1 bg-ink-line" />
      </div>
    </div>
  )
}

function ActivityTimelineRow({ activity }: { activity: RuntimeActivity }) {
  const hasDetails =
    Boolean(activity.output && activity.output.trim().length > 0) ||
    Boolean(activity.error && activity.error.trim().length > 0) ||
    Boolean(activity.sublines?.length)
  const statusMarker =
    activity.status === 'failed'
      ? { char: '✗', cls: 'text-term-rose' }
      : activity.status === 'completed'
        ? { char: '●', cls: 'text-term-green' }
        : { char: '◌', cls: 'text-term-amber animate-pulse' }
  const command = activity.command ?? activity.title

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5">
        <span
          className={cn('text-center text-[11px] leading-6', statusMarker.cls)}
        >
          {statusMarker.char}
        </span>
        <span className="min-w-0 leading-6">
          <span className="font-medium text-lime">{command}</span>
          {activity.args ? (
            <span className="ml-2 break-words text-term-dim">
              {activity.args}
            </span>
          ) : null}
          <span className="ml-2 text-[11px] text-term-dim2">
            {activity.kind}
          </span>
        </span>
        <span className="whitespace-nowrap text-[10.5px] uppercase tracking-[0.08em] text-term-faint">
          {activity.startedAt ? formatClock(activity.startedAt) : activity.status}
        </span>
      </div>
      {hasDetails ? (
        <details className="mt-1 pl-[26px]" open={activity.status === 'failed'}>
          <summary className="cursor-pointer list-none text-[10.5px] uppercase tracking-[0.12em] text-term-dim2 transition hover:text-term-name">
            details
          </summary>
          <div className="mt-1.5 grid gap-1 border-l border-ink-line pl-3">
            {activity.sublines?.slice(0, 8).map((line, index) => (
              <div
                key={`${line.key ?? index}:${line.value.slice(0, 20)}`}
                className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-4"
              >
                <span className="truncate text-term-dim2">
                  {line.key ?? 'output'}
                </span>
                <span className="truncate text-term-dim">{line.value}</span>
              </div>
            ))}
            {activity.output ? (
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-term-dim">
                {activity.output}
              </pre>
            ) : null}
            {activity.error ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-term-rose">
                {activity.error}
              </pre>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function ToolRunTimelineRow({
  turn,
  agent,
}: {
  turn: ToolTurn
  agent?: string
}) {
  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <ToolRunFeed turn={turn} agent={agent} />
    </div>
  )
}

function PlanTimelineRow({
  plan,
  onContinue,
  onRevise,
  canAct,
}: {
  plan: RuntimePlan
  onContinue: (plan: RuntimePlan) => void
  onRevise: (plan: RuntimePlan) => void
  canAct: boolean
}) {
  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <ClipboardCheck className="size-3.5 shrink-0 text-term-cyan" />
        <span className="text-[10px] uppercase tracking-[0.14em] text-term-cyan">
          plan
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-term-name">
          {plan.title ?? 'Proposed plan'}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-term-faint">
          {formatClock(plan.updatedAt)}
        </span>
      </div>
      {plan.items.length ? (
        <ol className="mt-2 grid gap-1">
          {plan.items.map((item, index) => (
            <li
              key={item.id}
              className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5 text-[11.5px] leading-5"
            >
              <span className="text-term-faint">
                {index === plan.items.length - 1 ? '└' : '├'}
              </span>
              <span className="min-w-0 break-words text-term-dim">
                {item.title}
              </span>
              <span className="text-[10px] uppercase tracking-[0.08em] text-term-dim2">
                {item.status.replace('_', ' ')}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-2 border-l border-dashed border-ink-line pl-3 text-[11.5px] text-term-dim2">
          No plan items were provided.
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2 pl-[26px]">
        <Button
          className={cn(
            termActionBtnCls,
            'h-8 justify-center text-[11px] tracking-[0.08em]'
          )}
          disabled={!canAct}
          onClick={() => onContinue(plan)}
        >
          <Check className="size-3.5" />
          Continue
        </Button>
        <Button
          className={cn(
            termActionBtnCls,
            'h-8 justify-center text-[11px] tracking-[0.08em]'
          )}
          variant="outline"
          disabled={!canAct}
          onClick={() => onRevise(plan)}
        >
          <RefreshCw className="size-3.5" />
          Revise
        </Button>
      </div>
    </div>
  )
}

function RequestTimelineRow({
  entry,
}: {
  entry:
    | Extract<SessionTimelineEntry, { kind: 'request' }>
    | Extract<SessionTimelineEntry, { kind: 'user-input' }>
}) {
  const isUserInput = entry.kind === 'user-input'
  const title = isUserInput ? 'Input requested' : entry.request.title
  const body = isUserInput ? entry.request.prompt : entry.request.body
  const status = entry.request.status

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-term-amber" />
        <span className="text-[10px] uppercase tracking-[0.14em] text-term-amber">
          {isUserInput ? 'input' : requestKindLabels[entry.request.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-term-name">
          {title}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-term-amber">
          {status}
        </span>
      </div>
      {body ? (
        <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words border-l border-ink-line pl-3 text-[11.5px] leading-5 text-term-dim">
          {body}
        </p>
      ) : null}
      <div className="mt-1 pl-[26px] text-[10.5px] uppercase tracking-[0.08em] text-term-faint">
        {formatClock(entry.ts)}
      </div>
    </div>
  )
}

function TurnDiffTimelineRow({
  diff,
  onOpen,
}: {
  diff: TurnDiffSummary
  onOpen: (turnId: string) => void
}) {
  const hasChanges = diff.totals.files > 0
  const diffTone = diff.error ? 'text-term-amber' : 'text-term-green'

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <FileText className={cn('size-3.5 shrink-0', diffTone)} />
        <span
          className={cn(
            'text-[10px] uppercase tracking-[0.14em]',
            diffTone
          )}
        >
          diff
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-term-name">
          Turn changed files
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-term-faint">
          {formatClock(diff.generatedAt)}
        </span>
      </div>
      {diff.error ? (
        <p className="mt-2 whitespace-pre-wrap break-words border-l border-ink-line pl-3 text-[11.5px] leading-5 text-term-amber">
          {diff.error}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-3 pl-[26px] text-[10.5px] uppercase tracking-[0.08em]">
            <span className="text-term-dim">
              {diff.totals.files} files
            </span>
            <span className="text-term-green">
              +{diff.totals.additions}
            </span>
            <span className="text-term-rose">
              -{diff.totals.deletions}
            </span>
          </div>
          {hasChanges ? (
            <div className="mt-2 grid gap-1">
              {diff.files.slice(0, 6).map((file, index) => (
                <button
                  key={`${file.changeType}:${file.path}`}
                  type="button"
                  className="grid grid-cols-[16px_minmax(0,1fr)_auto_auto] items-center gap-2.5 text-left text-[11.5px] leading-5 transition hover:text-lime"
                  onClick={() => onOpen(diff.turnId)}
                >
                  <span className="text-term-faint">
                    {index === Math.min(diff.files.length, 6) - 1
                      ? '└'
                      : '├'}
                  </span>
                  <span className="min-w-0 truncate text-term-name">
                    {file.path}
                  </span>
                  <span className="tabular-nums text-term-green">
                    +{file.additions}
                  </span>
                  <span className="tabular-nums text-term-rose">
                    -{file.deletions}
                  </span>
                </button>
              ))}
              {diff.files.length > 6 ? (
                <button
                  type="button"
                  className="pl-[26px] text-left text-[11.5px] leading-5 text-term-dim2 transition hover:text-term-name"
                  onClick={() => onOpen(diff.turnId)}
                >
                  {diff.files.length - 6} more files
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 border-l border-dashed border-ink-line pl-3 text-[11.5px] text-term-dim2">
              No file changes in this turn.
            </div>
          )}
          <Button
            className={cn(
              termActionBtnCls,
              'mt-2 h-8 w-full justify-center text-[11px] tracking-[0.08em]'
            )}
            variant="outline"
            onClick={() => onOpen(diff.turnId)}
          >
            <FileText className="size-3.5" />
            Open patch
          </Button>
        </>
      )}
    </div>
  )
}

function SessionTimeline({
  entries,
  agent,
  canActOnPlan,
  onContinuePlan,
  onRevisePlan,
  onOpenTurnDiff,
}: {
  entries: SessionTimelineEntry[]
  agent?: string
  canActOnPlan: boolean
  onContinuePlan: (plan: RuntimePlan) => void
  onRevisePlan: (plan: RuntimePlan) => void
  onOpenTurnDiff: (turnId: string) => void
}) {
  const toolTurnsByTurnId = useMemo(() => {
    const activities = entries.flatMap((entry) =>
      entry.kind === 'activity' ? [entry.activity] : []
    )
    return toolTurnsFromRuntimeActivities(activities)
  }, [entries])
  const renderedToolTurnIds = new Set<string>()

  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'turn') {
          return <TurnBoundaryRow key={entry.id} entry={entry} />
        }
        if (entry.kind === 'message') {
          return (
            <ChatMessage
              key={entry.id}
              message={entry.message}
              agent={agent}
            />
          )
        }
        if (entry.kind === 'activity') {
          const turnId = entry.activity.turnId
          const turn = turnId ? toolTurnsByTurnId.get(turnId) : undefined
          if (turnId && turn?.toolRuns.length) {
            if (renderedToolTurnIds.has(turnId)) {
              return null
            }
            renderedToolTurnIds.add(turnId)
            return (
              <ToolRunTimelineRow
                key={`tool-run:${turnId}`}
                turn={turn}
                agent={agent}
              />
            )
          }
          return (
            <ActivityTimelineRow key={entry.id} activity={entry.activity} />
          )
        }
        if (entry.kind === 'plan') {
          return (
            <PlanTimelineRow
              key={entry.id}
              plan={entry.plan}
              canAct={canActOnPlan}
              onContinue={onContinuePlan}
              onRevise={onRevisePlan}
            />
          )
        }
        if (entry.kind === 'request' || entry.kind === 'user-input') {
          return <RequestTimelineRow key={entry.id} entry={entry} />
        }
        return (
          <TurnDiffTimelineRow
            key={entry.id}
            diff={entry.diff}
            onOpen={onOpenTurnDiff}
          />
        )
      })}
    </>
  )
}

type RuntimeInteractionPanelProps = {
  requests: RuntimeRequest[]
  userInputRequests: UserInputRequest[]
  userInputDrafts: Record<string, UserInputAnswerValue>
  pendingInteractionIds: Record<string, boolean>
  onRespond: (
    request: RuntimeRequest,
    decision: RuntimeRequestDecision
  ) => void
  onDraftChange: (requestId: string, value: UserInputAnswerValue) => void
  onAnswer: (request: UserInputRequest) => void
}

const requestKindLabels: Record<RuntimeRequest['kind'], string> = {
  approval: 'Approval request',
  permission: 'Permission request',
  confirmation: 'Confirmation request',
}

function userInputDraftKey(request: UserInputRequest, questionId?: string) {
  return questionId ? `${request.id}:${questionId}` : request.id
}

function answerValueAsString(value: UserInputAnswerValue | undefined) {
  return Array.isArray(value) ? value.join(', ') : (value ?? '')
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
                  onClick={() => onRespond(request, 'accept')}
                >
                  <Check className="size-3.5" />
                  Allow once
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'acceptForSession')}
                >
                  <ClipboardCheck className="size-3.5" />
                  Allow session
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'decline')}
                >
                  <X className="size-3.5" />
                  Decline
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'cancel')}
                >
                  <Square className="size-3.5" />
                  Cancel
                </Button>
              </div>
            </div>
          )
        })}

        {userInputRequests.map((request) => {
          const questions = request.questions ?? []
          const hasStructuredQuestions = questions.length > 0
          const draft = answerValueAsString(userInputDrafts[userInputDraftKey(request)])
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
              {hasStructuredQuestions ? (
                <div className="mt-2 space-y-2.5">
                  {questions.map((question) => {
                    const draftKey = userInputDraftKey(request, question.id)
                    const questionDraft = userInputDrafts[draftKey]
                    const optionValues = Array.isArray(questionDraft)
                      ? questionDraft
                      : []
                    return (
                      <div
                        key={question.id}
                        className="rounded-md border border-ink-line/80 bg-ink/70 p-2.5"
                      >
                        <div className="text-[11px] uppercase tracking-[0.08em] text-term-faint">
                          {question.header ?? 'Question'}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-term-name">
                          {question.label}
                        </div>
                        {question.isSecret ? (
                          <div className="mt-1 text-[10.5px] leading-4 text-term-amber">
                            Secret input requested; the answer is stored in session
                            history.
                          </div>
                        ) : null}
                        {question.options?.length ? (
                          <div className="mt-2 space-y-1.5">
                            {question.options.map((option) => {
                              const checked = question.multiSelect
                                ? optionValues.includes(option.id)
                                : questionDraft === option.id
                              return (
                                <label
                                  key={option.id}
                                  className="flex cursor-pointer items-start gap-2 rounded border border-ink-line bg-ink px-2 py-1.5 text-[11.5px] leading-4 text-term-dim"
                                >
                                  <input
                                    className="mt-0.5 accent-lime-hi"
                                    type={question.multiSelect ? 'checkbox' : 'radio'}
                                    name={`${request.id}:${question.id}`}
                                    disabled={isPending}
                                    checked={checked}
                                    onChange={() => {
                                      if (question.multiSelect) {
                                        const next = checked
                                          ? optionValues.filter(
                                              (item) => item !== option.id
                                            )
                                          : [...optionValues, option.id]
                                        onDraftChange(draftKey, next)
                                        return
                                      }
                                      onDraftChange(draftKey, option.id)
                                    }}
                                  />
                                  <span>
                                    <span className="block text-term-name">
                                      {option.label}
                                    </span>
                                    {option.description ? (
                                      <span className="block text-term-faint">
                                        {option.description}
                                      </span>
                                    ) : null}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        ) : (
                          <>
                            {question.isSecret ? (
                              <input
                                className="mt-2 h-9 w-full rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                                type="password"
                                value={answerValueAsString(questionDraft)}
                                placeholder={
                                  question.placeholder ??
                                  request.placeholder ??
                                  'Type an answer'
                                }
                                disabled={isPending}
                                onChange={(event) =>
                                  onDraftChange(draftKey, event.target.value)
                                }
                              />
                            ) : (
                              <textarea
                                className="mt-2 max-h-24 min-h-12 w-full resize-y rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                                value={answerValueAsString(questionDraft)}
                                placeholder={
                                  question.placeholder ??
                                  request.placeholder ??
                                  'Type an answer'
                                }
                                disabled={isPending}
                                onChange={(event) =>
                                  onDraftChange(draftKey, event.target.value)
                                }
                              />
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <textarea
                  className="mt-2 max-h-28 min-h-16 w-full resize-y rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                  value={draft}
                  placeholder={request.placeholder ?? 'Type an answer'}
                  disabled={isPending}
                  onChange={(event) =>
                    onDraftChange(userInputDraftKey(request), event.target.value)
                  }
                />
              )}
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

function WorkingTreeDiffPanel({
  session,
  diff,
  isLoading,
  error,
  onRefresh,
  onClose,
}: {
  session?: AgentSession
  diff?: WorkingTreeDiffResult
  isLoading: boolean
  error?: string
  onRefresh: () => void
  onClose: () => void
}) {
  const hasChanges = Boolean(diff && diff.files.length > 0)
  const patchLines = diff?.patch ? diff.patch.split('\n') : []
  const title = diff?.range.kind === 'checkpoint' ? 'Turn changes' : 'Uncommitted changes'

  return (
    <aside className="flex h-full w-[min(460px,38vw)] min-w-[360px] shrink-0 flex-col border-l border-border bg-sidebar font-mono">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="size-3.5 shrink-0 text-accent-ink" />
            <h2 className="truncate text-[12px] font-semibold text-foreground">
              {title}
            </h2>
          </div>
          <p
            className="mt-1 truncate text-[10.5px] text-muted-foreground"
            title={session?.cwd}
          >
            {session ? compactPath(session.cwd) : 'No chat selected'}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="size-7 shrink-0"
              variant="ghost"
              size="icon"
              disabled={!session || isLoading}
              aria-label="Refresh diff"
              onClick={onRefresh}
            >
              <RefreshCw
                className={cn('size-3.5', isLoading && 'animate-spin')}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh diff</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="size-7 shrink-0"
              variant="ghost"
              size="icon"
              aria-label="Close diff panel"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close diff panel</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!session ? (
          <div className="m-3 rounded-lg border border-dashed border-ink-line bg-ink p-4 text-[12px] leading-5 text-term-dim2">
            Select a chat node to inspect its project folder.
          </div>
        ) : null}

        {error ? (
          <div className="m-3 rounded-lg border border-term-rose/35 bg-term-rose/10 p-3 text-[11.5px] leading-5 text-term-rose">
            {error}
          </div>
        ) : null}

        {isLoading && !diff ? (
          <div className="m-3 rounded-lg border border-ink-line bg-ink p-4 text-[12px] text-term-dim2">
            Loading diff...
          </div>
        ) : null}

        {diff ? (
          <>
            <section className="border-b border-border px-3 py-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border border-ink-line bg-ink px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-term-faint">
                    files
                  </div>
                  <div className="mt-1 text-[18px] leading-none text-term-name">
                    {diff.totals.files}
                  </div>
                </div>
                <div className="rounded-lg border border-term-green/25 bg-term-green/10 px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-term-green">
                    added
                  </div>
                  <div className="mt-1 text-[18px] leading-none text-term-green">
                    +{diff.totals.additions}
                  </div>
                </div>
                <div className="rounded-lg border border-term-rose/25 bg-term-rose/10 px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-term-rose">
                    removed
                  </div>
                  <div className="mt-1 text-[18px] leading-none text-term-rose">
                    -{diff.totals.deletions}
                  </div>
                </div>
              </div>

              <div className="mt-2 grid gap-1.5 text-[11px] leading-5">
                <div className="flex min-w-0 gap-2">
                  <span className="w-14 shrink-0 text-term-dim2">range</span>
                  <span className="truncate text-term-cyan">
                    {diffRangeLabel(diff)}
                  </span>
                </div>
                <div className="flex min-w-0 gap-2">
                  <span className="w-14 shrink-0 text-term-dim2">updated</span>
                  <span className="truncate text-term-dim">
                    {formatTimestamp(diff.generatedAt)}
                  </span>
                </div>
              </div>
            </section>

            {diff.statusEntries.length ? (
              <section className="border-b border-border px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                  Git status
                </div>
                <pre className="max-h-28 overflow-auto rounded-lg border border-ink-line bg-ink px-2.5 py-2 text-[11px] leading-5 text-term-dim">
                  {diff.statusEntries.join('\n')}
                </pre>
              </section>
            ) : null}

            <section className="border-b border-border px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                  Files
                </span>
                <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">
                  {diff.files.length}
                </span>
              </div>

              {hasChanges ? (
                <div className="space-y-1.5">
                  {diff.files.map((file) => (
                    <div
                      key={`${file.changeType}:${file.path}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-ink-line bg-ink px-2.5 py-2 text-[11.5px]"
                    >
                      <span className="min-w-0 truncate text-term-name">
                        {file.path}
                      </span>
                      <span className="tabular-nums text-term-green">
                        +{file.additions}
                      </span>
                      <span className="tabular-nums text-term-rose">
                        -{file.deletions}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-ink-line bg-ink p-4 text-center text-[12px] text-term-dim2">
                  No uncommitted changes in this project folder.
                </div>
              )}
            </section>

            <section className="px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                  Patch
                </span>
                {diff.truncated ? (
                  <span className="ml-auto rounded border border-term-amber/30 bg-term-amber/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-term-amber">
                    truncated
                  </span>
                ) : null}
              </div>

              {patchLines.length ? (
                <pre className="max-h-[52vh] overflow-auto rounded-lg border border-ink-line bg-ink py-2 text-[11px] leading-5">
                  {patchLines.map((line, index) => (
                    <span
                      key={`${index}:${line.slice(0, 16)}`}
                      className={cn(
                        'block min-w-max px-3',
                        diffPatchLineClassName(line)
                      )}
                    >
                      {line.length ? line : ' '}
                    </span>
                  ))}
                </pre>
              ) : (
                <div className="rounded-lg border border-dashed border-ink-line bg-ink p-4 text-center text-[12px] text-term-dim2">
                  No patch to show.
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </aside>
  )
}

function providerSetupHints(providerKind: ProviderKind) {
  switch (providerKind) {
    case 'claude-code':
      return [
        'Confirm Claude SDK auth is available to the runtime.',
        'Check that this app can start @anthropic-ai/claude-agent-sdk.',
        'Use Legacy Claude CLI to isolate SDK setup from account setup.',
      ]
    case 'codex':
      return [
        'Confirm the Codex provider is enabled and authenticated.',
        'Check that the Codex app-server can access this workspace path.',
        'Restart the runtime after auth or provider changes.',
      ]
    case 'legacy-claude-cli':
      return [
        'Install the claude CLI and make sure the runtime can find it on PATH.',
        'Run claude login in the same user environment.',
        'Check shell startup files if Terminal works but Orrery cannot start it.',
      ]
  }
}

function providerSetupCheckClassName(status: ProviderSetupStatus['checks'][number]['status']) {
  switch (status) {
    case 'ok':
      return 'border-term-green/30 bg-term-green/10 text-term-green'
    case 'warning':
      return 'border-term-amber/30 bg-term-amber/10 text-term-amber'
    case 'error':
      return 'border-term-rose/35 bg-term-rose/10 text-term-rose'
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim2'
  }
}

function ProviderInstanceSettingsPanel({
  providerKind,
  providerInstances,
  disabled,
  savingInstanceId,
  error,
  onSave,
}: {
  providerKind: ProviderKind
  providerInstances: ProviderInstance[]
  disabled?: boolean
  savingInstanceId?: string
  error?: string
  onSave: (instance: ProviderInstance) => void
}) {
  const instance = providerInstanceForKind(providerInstances, providerKind)
  const instanceId = instance.providerInstanceId
  const instanceLabel = instance.label
  const instanceBinaryPath = instance.binaryPath ?? ''
  const instanceHomePath = instance.homePath ?? ''
  const instanceShadowHomePath = instance.shadowHomePath ?? ''
  const instanceLaunchArgs = launchArgsText(instance)
  const [label, setLabel] = useState(instanceLabel)
  const [binaryPath, setBinaryPath] = useState(instanceBinaryPath)
  const [homePath, setHomePath] = useState(instanceHomePath)
  const [shadowHomePath, setShadowHomePath] = useState(instanceShadowHomePath)
  const [launchArgs, setLaunchArgs] = useState(instanceLaunchArgs)
  const isSaving = savingInstanceId === instance.providerInstanceId

  useEffect(() => {
    setLabel(instanceLabel)
    setBinaryPath(instanceBinaryPath)
    setHomePath(instanceHomePath)
    setShadowHomePath(instanceShadowHomePath)
    setLaunchArgs(instanceLaunchArgs)
  }, [
    instanceBinaryPath,
    instanceHomePath,
    instanceId,
    instanceLabel,
    instanceLaunchArgs,
    instanceShadowHomePath,
  ])

  return (
    <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Bot className="size-3.5 shrink-0 text-lime-hi" />
        <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-[0.12em] text-term-dim2">
          Provider profile
        </span>
        <span className="truncate text-[10.5px] text-term-faint" title={instance.providerInstanceId}>
          {instance.providerInstanceId}
        </span>
      </div>

      <div className="grid gap-2">
        <label className="grid gap-1">
          <TermLabel>label</TermLabel>
          <input
            className={termInputCls}
            value={label}
            disabled={disabled || isSaving}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>

        <label className="grid gap-1">
          <TermLabel>binary path</TermLabel>
          <input
            className={termInputCls}
            value={binaryPath}
            disabled={disabled || isSaving}
            placeholder={providerKind === 'codex' ? 'codex' : 'claude'}
            onChange={(event) => setBinaryPath(event.target.value)}
          />
        </label>

        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
          <label className="grid gap-1">
            <TermLabel>home path</TermLabel>
            <input
              className={termInputCls}
              value={homePath}
              disabled={disabled || isSaving}
              placeholder="provider default"
              onChange={(event) => setHomePath(event.target.value)}
            />
          </label>

          <label className="grid gap-1">
            <TermLabel>{providerKind === 'codex' ? 'shadow home' : 'state path'}</TermLabel>
            <input
              className={termInputCls}
              value={shadowHomePath}
              disabled={disabled || isSaving || providerKind !== 'codex'}
              placeholder={providerKind === 'codex' ? 'optional' : 'Codex only'}
              onChange={(event) => setShadowHomePath(event.target.value)}
            />
          </label>
        </div>

        <label className="grid gap-1">
          <TermLabel>launch args</TermLabel>
          <textarea
            className={cn(termTextareaCls, 'min-h-16 resize-y text-[11.5px] leading-5')}
            value={launchArgs}
            disabled={disabled || isSaving}
            placeholder="one argument per line"
            onChange={(event) => setLaunchArgs(event.target.value)}
          />
        </label>

        {error ? (
          <div className="rounded-md border border-term-rose/35 bg-term-rose/10 px-2 py-1.5 text-[11px] leading-4 text-term-rose">
            {error}
          </div>
        ) : null}

        <Button
          className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
          size="sm"
          disabled={disabled || isSaving}
          onClick={() =>
            onSave(
              providerInstanceFromDraft({
                instance,
                label,
                binaryPath,
                homePath,
                shadowHomePath: providerKind === 'codex' ? shadowHomePath : '',
                launchArgs,
              })
            )
          }
        >
          <Check className="size-3.5" />
          <span>{isSaving ? 'Saving...' : 'Save profile'}</span>
        </Button>
      </div>
    </div>
  )
}

function ProviderSetupDiagnostics({
  isRuntimeAvailable,
  runtimeStatusText,
  providerKind,
  providerInstances,
  runtimeError,
  setupStatus,
  isLoadingSetupStatus,
  savingProviderInstanceId,
  providerInstanceError,
  onSaveProviderInstance,
}: {
  isRuntimeAvailable: boolean
  runtimeStatusText: string
  providerKind: ProviderKind
  providerInstances: ProviderInstance[]
  runtimeError?: string
  setupStatus?: ProviderSetupStatus
  isLoadingSetupStatus?: boolean
  savingProviderInstanceId?: string
  providerInstanceError?: string
  onSaveProviderInstance: (instance: ProviderInstance) => void
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
        <ProviderInstanceSettingsPanel
          providerKind={providerKind}
          providerInstances={providerInstances}
          disabled={!isRuntimeAvailable}
          savingInstanceId={savingProviderInstanceId}
          error={providerInstanceError}
          onSave={onSaveProviderInstance}
        />

        <div className="rounded-lg border border-ink-line bg-background/35 px-2.5 py-2">
          <div className="grid gap-1.5 text-[11.5px] leading-5">
            <div className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-term-dim2">runtime</span>
              <span className="min-w-0 text-term-name">
                {isRuntimeAvailable
                  ? runtimeStatusText
                  : 'Start a runtime to create chats'}
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
          {setupStatus?.checks.length ? (
            <div className="space-y-1.5">
              {setupStatus.checks.map((check) => (
                <div
                  key={check.id}
                  className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 rounded-md bg-ink px-2 py-1.5 text-[11.5px] leading-5"
                >
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-center text-[10px] uppercase tracking-[0.06em]',
                      providerSetupCheckClassName(check.status)
                    )}
                  >
                    {check.status}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-term-name">
                      {check.label}
                    </span>
                    <span className="block break-words text-term-dim">
                      {check.message}
                    </span>
                    {check.detail ? (
                      <span className="mt-0.5 block truncate text-[10.5px] text-term-faint">
                        {check.detail}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : isLoadingSetupStatus ? (
            <div className="rounded-md border border-dashed border-ink-line p-3 text-[11.5px] text-term-dim2">
              Loading setup checks...
            </div>
          ) : (
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
          )}
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

function ComposerAttachmentPill({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: ChatAttachment
  disabled?: boolean
  onRemove: (id: string) => void
}) {
  return (
    <div className="group/attachment grid min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-ink-line bg-foreground/[0.04] px-2 py-2 font-mono">
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-line bg-ink-soft text-term-cyan">
        {attachment.kind === 'image' && attachment.dataUrl ? (
          <img
            className="size-full object-cover"
            src={attachment.dataUrl}
            alt=""
          />
        ) : attachment.kind === 'image' ? (
          <ImageIcon className="size-4" />
        ) : (
          <FileText className="size-4" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-term-name">
          {attachment.name}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-term-dim2">
          {attachment.mediaType} · {formatFileSize(attachment.size)}
          {attachment.truncated ? ' · truncated' : ''}
        </span>
      </span>
      <button
        type="button"
        className="rounded-md p-1 text-term-dim2 transition hover:bg-foreground/[0.06] hover:text-term-name disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled}
        aria-label={`Remove ${attachment.name}`}
        onClick={() => onRemove(attachment.id)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
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

const demoMode = isDemoModeRequested()

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
  const [newWorkMode, setNewWorkMode] = useState<WorkMode>('local')
  const [newBranch, setNewBranch] = useState('')
  const [newRuntimeMode, setNewRuntimeMode] =
    useState<ProviderRuntimeMode>('approval-required')
  const [newModel, setNewModel] = useState('')
  const [newReasoningEffort, setNewReasoningEffort] =
    useState<ProviderReasoningEffort>('medium')
  const [newProjectContext, setNewProjectContext] = useState<ProjectContext>()
  const [providerSetupStatus, setProviderSetupStatus] =
    useState<ProviderSetupStatus>()
  const [isLoadingProviderSetupStatus, setIsLoadingProviderSetupStatus] =
    useState(false)
  const [savingProviderInstanceId, setSavingProviderInstanceId] = useState<string>()
  const [providerInstanceError, setProviderInstanceError] = useState<string>()
  const [message, setMessage] = useState('')
  const [composerAttachments, setComposerAttachments] = useState<
    ChatAttachment[]
  >([])
  const [isComposerDragActive, setIsComposerDragActive] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [showRawEvents, setShowRawEvents] = useState(false)
  const [userInputDrafts, setUserInputDrafts] = useState<
    Record<string, UserInputAnswerValue>
  >({})
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
  const [isDiffPanelOpen, setIsDiffPanelOpen] = useState(false)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)
  const [workingTreeDiff, setWorkingTreeDiff] =
    useState<WorkingTreeDiffResult>()
  const [diffTurnId, setDiffTurnId] = useState<string>()
  const [diffPanelError, setDiffPanelError] = useState<string>()
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
  const [chatPanelWidth, setChatPanelWidth] = useState(initialChatPanelWidth)
  const [isResizingChatPanel, setIsResizingChatPanel] = useState(false)
  const [graphCollapsed, setGraphCollapsed] = useState(initialGraphCollapsed)
  const [viewportWidth, setViewportWidth] = useState(initialViewportWidth)
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => {
    if (typeof window === 'undefined') {
      return 'dark'
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })
  const runtimeClient = useRuntimeClient({ disabled: demoMode })
  const runtimeApi = demoMode ? undefined : runtimeClient.runtime
  const isRuntimeAvailable = Boolean(runtimeApi)
  const isElectron = !demoMode && runtimeClient.kind === 'electron'
  const runtimeModeLabel = demoMode
    ? 'demo'
    : runtimeClient.kind === 'electron'
      ? 'electron'
      : runtimeClient.kind === 'http'
        ? 'web runtime'
        : runtimeClient.kind === 'connecting'
          ? 'connecting'
        : 'no runtime'
  const runtimeStatusText =
    runtimeClient.kind === 'http'
      ? `Web runtime ${runtimeClient.runtimeUrl}`
      : runtimeClient.kind === 'electron'
        ? 'Electron runtime'
        : runtimeClient.kind === 'connecting'
          ? `Connecting to web runtime ${runtimeClient.runtimeUrl}`
          : runtimeClient.kind === 'unavailable' && runtimeClient.runtimeUrl
            ? `No runtime at ${runtimeClient.runtimeUrl}`
        : demoMode
          ? 'Demo graph'
          : 'No runtime client'
  const runtimeUnavailableText = demoMode
    ? 'Demo mode uses sample data. Remove ?demo=1 to connect to a runtime.'
    : runtimeClient.kind === 'unavailable' && runtimeClient.error
      ? runtimeClient.error
      : runtimeClient.kind === 'connecting'
        ? `Connecting to web runtime at ${runtimeClient.runtimeUrl}.`
        : 'Runtime is unavailable. Start the desktop app or the web runtime server.'
  const splitContainerRef = useRef<HTMLElement | null>(null)
  const composerEditorRef = useRef<HTMLDivElement | null>(null)
  const composerFileInputRef = useRef<HTMLInputElement | null>(null)
  const diffRequestSeqRef = useRef(0)
  const projectContextSeqRef = useRef(0)
  const providerSetupSeqRef = useRef(0)

  const selectedSession = selectedSessionId
    ? runtimeState.sessions[selectedSessionId]
    : undefined
  const selectedSessionProjection = useMemo(
    () => (selectedSession ? projectSession(selectedSession) : undefined),
    [selectedSession]
  )
  const selectedWorkingTreeDiff =
    workingTreeDiff?.sessionId === selectedSessionId ? workingTreeDiff : undefined
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
  const openRuntimeRequests = selectedSessionProjection?.openRequests ?? []
  const openUserInputRequests = selectedSessionProjection?.userInputRequests ?? []
  const sessions = Object.values(runtimeState.sessions).sort(sessionSort)
  const providerInstances = runtimeState.providerInstances ?? []
  const newProviderInstance = providerInstanceForKind(
    providerInstances,
    newProviderKind
  )
  const runtimeDiagnostics = useMemo(
    () => runtimeState.diagnostics ?? [],
    [runtimeState.diagnostics]
  )
  const invalidProjectCwds = useMemo(
    () => invalidCwdsFromDiagnostics(runtimeDiagnostics),
    [runtimeDiagnostics]
  )
  const newCwdValidation = useMemo(() => validateProjectCwd(newCwd), [newCwd])
  const newChatProjects = useMemo(
    () =>
      projectOptionsFromSessions(
        sessions,
        newCwd,
        defaultWorkspaceCwd(),
        newProjectContext,
        invalidProjectCwds
      ),
    [invalidProjectCwds, newCwd, newProjectContext, sessions]
  )
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
  const composerDisabled =
    !isRuntimeAvailable || (selectedSession ? !canResume || isResuming : isCreating)
  const composerHasPayload =
    message.trim().length > 0 || composerAttachments.length > 0
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
  const canOpenDiffPanel = Boolean(isRuntimeAvailable && selectedSession)
  const canActOnPlan = Boolean(isRuntimeAvailable && selectedSession && canResume)
  const graphForcedCollapsed = viewportWidth < expandedGraphLayoutMinWidth
  const effectiveGraphCollapsed = graphCollapsed || graphForcedCollapsed
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

  const setComposerText = useCallback((text: string) => {
    setMessage(text)
    if (composerEditorRef.current) {
      composerEditorRef.current.textContent = text
    }
  }, [])

  const clearComposer = useCallback(() => {
    setComposerText('')
    setComposerAttachments([])
  }, [setComposerText])

  const addComposerFiles = useCallback(async (files: FileList | File[]) => {
    const fileList = Array.from(files).filter((file) => file.size >= 0)
    if (fileList.length === 0) {
      return
    }

    const results = await Promise.allSettled(
      fileList.map((file) => composerAttachmentFromFile(file))
    )
    const attachments = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    const firstError = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )

    if (attachments.length > 0) {
      setComposerAttachments((current) => [...current, ...attachments])
    }
    if (firstError) {
      setRuntimeError(
        firstError.reason instanceof Error
          ? firstError.reason.message
          : String(firstError.reason)
      )
    }
  }, [])

  const removeComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((current) =>
      current.filter((attachment) => attachment.id !== id)
    )
  }, [])

  const handleComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files).filter(
        (file) => file.size > 0 || file.type.startsWith('image/')
      )
      if (files.length > 0) {
        event.preventDefault()
        void addComposerFiles(files)
        return
      }

      const text = event.clipboardData.getData('text/plain')
      if (text.length > 0) {
        event.preventDefault()
        if (insertPlainTextAtCaret(text)) {
          setMessage(event.currentTarget.innerText)
        }
      }
    },
    [addComposerFiles]
  )

  const handleComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) {
        return
      }

      event.preventDefault()
      setIsComposerDragActive(false)
      void addComposerFiles(files)
    },
    [addComposerFiles]
  )

  const adjustChatPanelWidth = useCallback((delta: number) => {
    const totalWidth =
      splitContainerRef.current?.getBoundingClientRect().width ??
      (typeof window !== 'undefined' ? window.innerWidth : undefined)
    setChatPanelWidth((current) =>
      clampChatPanelWidth(current + delta, totalWidth)
    )
  }, [])

  const startNewChat = useCallback(() => {
    setPendingLinkedSourceId(null)
    setSelectedSessionId(null)
    setNewCwd(latestSessionCwd(sessions, invalidProjectCwds) ?? defaultWorkspaceCwd())
    setNewWorkMode('local')
    setNewBranch('')
    setActiveTab('chat')
    setShowRawEvents(false)
    clearComposer()
  }, [clearComposer, invalidProjectCwds, sessions])

  const startLinkedChat = useCallback(() => {
    if (!selectedSession) {
      return
    }

    const sourceCwd =
      invalidProjectCwds.has(selectedSession.cwd)
        ? latestSessionCwd(sessions, invalidProjectCwds) ?? defaultWorkspaceCwd()
        : selectedSession.cwd

    setPendingLinkedSourceId(selectedSession.sessionId)
    setSelectedSessionId(null)
    setNewProviderKind(selectedSession.providerKind)
    setNewCwd(sourceCwd)
    setNewWorkMode('local')
    setNewBranch('')
    setActiveTab('chat')
    setShowRawEvents(false)
    clearComposer()
  }, [clearComposer, invalidProjectCwds, selectedSession, sessions])

  const chooseNewChatProject = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText)
      return
    }

    try {
      const result = await runtimeApi.chooseProjectFolder()
      if (result.canceled || !result.cwd) {
        return
      }

      setNewCwd(result.cwd)
      setNewWorkMode('local')
      setNewBranch('')
      setRuntimeError(undefined)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    }
  }, [runtimeApi, runtimeUnavailableText])

  const saveProviderInstance = useCallback(
    async (providerInstance: ProviderInstance) => {
      if (!runtimeApi) {
        setProviderInstanceError(runtimeUnavailableText)
        return
      }

      setSavingProviderInstanceId(providerInstance.providerInstanceId)
      setProviderInstanceError(undefined)
      try {
        const result = await runtimeApi.upsertProviderInstance(providerInstance)
        setRuntimeState(result.state)
      } catch (error) {
        setProviderInstanceError(error instanceof Error ? error.message : String(error))
      } finally {
        setSavingProviderInstanceId(undefined)
      }
    },
    [runtimeApi, runtimeUnavailableText]
  )

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
            agent: session ? sessionProviderLabel(session) : node.agent,
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
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        chatPanelWidthStorageKey,
        String(Math.round(chatPanelWidth))
      )
    } catch {
      // Width persistence is best-effort; resizing still works without storage.
    }
  }, [chatPanelWidth])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        graphCollapsedStorageKey,
        graphCollapsed ? '1' : '0'
      )
    } catch {
      // Collapse persistence is best-effort.
    }
  }, [graphCollapsed])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      const totalWidth =
        splitContainerRef.current?.getBoundingClientRect().width ??
        window.innerWidth
      setViewportWidth(totalWidth)
      setChatPanelWidth((current) =>
        clampChatPanelWidth(current, totalWidth)
      )
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!isResizingChatPanel) {
      return
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent) => {
      const rect = splitContainerRef.current?.getBoundingClientRect()
      if (!rect) {
        return
      }

      setChatPanelWidth(
        clampChatPanelWidth(
          event.clientX - rect.left - railSidebarWidth,
          rect.width
        )
      )
    }

    const stopResizing = () => setIsResizingChatPanel(false)

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing, { once: true })
    window.addEventListener('pointercancel', stopResizing, { once: true })

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  }, [isResizingChatPanel])

  useEffect(() => {
    const editor = composerEditorRef.current
    if (!editor) {
      return
    }

    if (
      message.length === 0 ||
      (typeof document !== 'undefined' && document.activeElement !== editor)
    ) {
      if (editor.textContent !== message) {
        editor.textContent = message
      }
    }
  }, [message])

  useEffect(() => {
    if (demoMode || runtimeClient.kind !== 'http') {
      return
    }

    let isMounted = true
    runtimeClient
      .getConfig()
      .then((config) => {
        const defaultCwd = config.workspace?.defaultCwd
        if (!isMounted || !defaultCwd) {
          return
        }

        setNewCwd((current) =>
          current.trim().length > 0 ? current : defaultCwd
        )
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      isMounted = false
    }
  }, [runtimeClient])

  useEffect(() => {
    if (!runtimeApi || !newCwdValidation.ok) {
      setNewProjectContext(undefined)
      return
    }

    const requestId = projectContextSeqRef.current + 1
    projectContextSeqRef.current = requestId
    const cwd = newCwd.trim()
    let isMounted = true

    runtimeApi
      .getProjectContext({ cwd })
      .then((context) => {
        if (isMounted && projectContextSeqRef.current === requestId) {
          setNewProjectContext(context)
        }
      })
      .catch((error: unknown) => {
        if (isMounted && projectContextSeqRef.current === requestId) {
          setNewProjectContext({
            cwd,
            projectName: projectNameFromCwd(cwd),
            isGitRepo: false,
            branches: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

    return () => {
      isMounted = false
    }
  }, [newCwd, newCwdValidation.ok, runtimeApi])

  useEffect(() => {
    if (!showRawEvents || selectedSession || !runtimeApi) {
      setProviderSetupStatus(undefined)
      setIsLoadingProviderSetupStatus(false)
      return
    }

    const requestId = providerSetupSeqRef.current + 1
    providerSetupSeqRef.current = requestId
    let isMounted = true
    setIsLoadingProviderSetupStatus(true)

    runtimeApi
      .getProviderSetupStatus({
        providerKind: newProviderKind,
        providerInstanceId: newProviderInstance.providerInstanceId,
        cwd: newCwd.trim() || undefined,
      })
      .then((status) => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setProviderSetupStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setProviderSetupStatus({
            providerKind: newProviderKind,
            providerInstanceId: newProviderInstance.providerInstanceId,
            generatedAt: new Date().toISOString(),
            checks: [
              {
                id: 'setup-status',
                label: 'Setup status',
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          })
        }
      })
      .finally(() => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setIsLoadingProviderSetupStatus(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [
    newCwd,
    newProviderInstance.binaryPath,
    newProviderInstance.providerInstanceId,
    newProviderKind,
    runtimeApi,
    selectedSession,
    showRawEvents,
  ])

  useEffect(() => {
    if (
      newWorkMode === 'worktree' &&
      newProjectContext?.cwd === newCwd.trim() &&
      newProjectContext.isGitRepo === false
    ) {
      setNewWorkMode('local')
      setNewBranch('')
    }
  }, [newCwd, newProjectContext, newWorkMode])

  useEffect(() => {
    setDiffTurnId(undefined)
    setWorkingTreeDiff(undefined)
    setDiffPanelError(undefined)
  }, [selectedSessionId])

  useEffect(() => {
    if (!activeCluster) {
      return
    }

    setClusterLabel(activeCluster.label)
    setMaxIterations(String(activeCluster.loopPolicy?.maxIterations ?? 6))
  }, [activeCluster])

  useEffect(() => {
    if (!runtimeApi) {
      return
    }

    let isMounted = true
    runtimeApi
      .getState()
      .then((state) => {
        if (isMounted) {
          setRuntimeState(state)
          setSelectedSessionId((current) =>
            current === undefined ? null : current
          )
          setNewCwd((current) => {
            if (current.trim().length > 0) {
              return current
            }

            const restoredSessions = Object.values(state.sessions).sort(sessionSort)
            return (
              latestSessionCwd(
                restoredSessions,
                invalidCwdsFromDiagnostics(state.diagnostics ?? [])
              ) ?? defaultWorkspaceCwd()
            )
          })
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        }
      })

    const unsubscribe = runtimeApi.onEvent((event) => {
      setRuntimeState(event.state)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [runtimeApi])

  const createSessionFromPrompt = useCallback(
    async (
      prompt: string,
      options: {
        sourceSessionId?: string | null
        context?: string
        attachments?: ChatAttachment[]
      } = {}
    ) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText)
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
        const result = await runtimeApi.createSession({
          prompt: trimmedPrompt,
          context: options.context,
          attachments: options.attachments,
          cwd,
          workMode: newWorkMode,
          ...(newWorkMode === 'worktree' && newBranch.trim().length > 0
            ? { branch: newBranch.trim() }
            : {}),
          agent: selectedProvider.agent,
          providerKind: selectedProvider.id,
          providerInstanceId: newProviderInstance.providerInstanceId,
          runtimeSettings: providerRuntimeSettingsDraft({
            runtimeMode: newRuntimeMode,
            model: newModel,
            reasoningEffort: newReasoningEffort,
          }),
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
    [
      newBranch,
      newCwd,
      newModel,
      newProviderInstance.providerInstanceId,
      newProviderKind,
      newReasoningEffort,
      newRuntimeMode,
      newWorkMode,
      runtimeApi,
      runtimeState.sessions,
      runtimeUnavailableText,
      sessions.length,
    ]
  )

  const sendChatMessage = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText)
      return
    }

    const trimmed = message.trim()
    if (trimmed.length === 0 && composerAttachments.length === 0) {
      return
    }
    const prompt = trimmed.length > 0 ? trimmed : 'Please review the attached files.'

    if (!selectedSession || !selectedSessionId) {
      const created = await createSessionFromPrompt(prompt, {
        sourceSessionId: pendingLinkedSourceId,
        attachments: composerAttachments,
      })
      if (created) {
        clearComposer()
      }
      return
    }

    setIsResuming(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.resumeSession({
        sessionId: selectedSessionId,
        message: prompt,
        attachments: composerAttachments,
      })
      setRuntimeState(result.state)
      clearComposer()
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsResuming(false)
    }
  }, [
    clearComposer,
    composerAttachments,
    createSessionFromPrompt,
    message,
    pendingLinkedSourceId,
    runtimeApi,
    runtimeUnavailableText,
    selectedSession,
    selectedSessionId,
  ])

  const killSelectedSession = useCallback(async () => {
    if (!runtimeApi || !selectedSessionId) {
      return
    }

    try {
      const result = await runtimeApi.killSession(selectedSessionId)
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    }
  }, [runtimeApi, selectedSessionId])

  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText)
        return
      }

      setArchivingSessionIds((current) => ({
        ...current,
        [sessionId]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await runtimeApi.archiveSession({
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
    [runtimeApi, runtimeUnavailableText]
  )

  const respondToRuntimeRequest = useCallback(
    async (request: RuntimeRequest, decision: RuntimeRequestDecision) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText)
        return
      }

      setPendingInteractionIds((current) => ({
        ...current,
        [request.id]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await runtimeApi.respondRuntimeRequest({
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
    [runtimeApi, runtimeUnavailableText]
  )

  const setUserInputDraft = useCallback(
    (requestId: string, value: UserInputAnswerValue) => {
      setUserInputDrafts((current) => ({
        ...current,
        [requestId]: value,
      }))
    },
    []
  )

  const answerRuntimeUserInput = useCallback(
    async (request: UserInputRequest) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText)
        return
      }

      const questions = request.questions ?? []
      const answers: UserInputAnswerMap | undefined = questions.length
        ? Object.fromEntries(
            questions.map((question) => {
              const value = userInputDrafts[userInputDraftKey(request, question.id)]
              if (Array.isArray(value)) {
                return [question.id, value]
              }
              return [question.id, typeof value === 'string' ? value : '']
            })
          )
        : undefined
      const answer =
        questions.length > 0
          ? undefined
          : answerValueAsString(userInputDrafts[userInputDraftKey(request)])

      setPendingInteractionIds((current) => ({
        ...current,
        [request.id]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await runtimeApi.answerUserInput({
          sessionId: request.sessionId,
          requestId: request.id,
          ...(answer !== undefined ? { answer } : {}),
          ...(answers ? { answers } : {}),
        })
        setRuntimeState(result.state)
        setUserInputDrafts((current) => {
          const next = { ...current }
          delete next[userInputDraftKey(request)]
          for (const question of questions) {
            delete next[userInputDraftKey(request, question.id)]
          }
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
    [runtimeApi, runtimeUnavailableText, userInputDrafts]
  )

  const continueRuntimePlan = useCallback(
    async (plan: RuntimePlan) => {
      if (!runtimeApi || !selectedSessionId) {
        setRuntimeError(runtimeUnavailableText)
        return
      }

      const planText = plan.items
        .map((item, index) => `${index + 1}. ${item.title}`)
        .join('\n')
      const messageText = [
        'Proceed with this proposed plan.',
        planText ? `\nPlan:\n${planText}` : undefined,
      ]
        .filter(Boolean)
        .join('\n')

      setIsResuming(true)
      setRuntimeError(undefined)

      try {
        const result = await runtimeApi.resumeSession({
          sessionId: selectedSessionId,
          message: messageText,
        })
        setRuntimeState(result.state)
        clearComposer()
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
      } finally {
        setIsResuming(false)
      }
    },
    [
      clearComposer,
      runtimeApi,
      runtimeUnavailableText,
      selectedSessionId,
    ]
  )

  const reviseRuntimePlan = useCallback(
    (plan: RuntimePlan) => {
      const title = plan.title ?? 'this plan'
      setComposerText(`Revise ${title}: `)
      composerEditorRef.current?.focus()
    },
    [setComposerText]
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
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText)
      return
    }

    if (workflowManagedNodeIds.length === 0) {
      setRuntimeError('Select at least one worker node for the cluster.')
      return
    }

    setIsUpdatingCluster(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.upsertCluster({
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
    runtimeApi,
    runtimeUnavailableText,
    workflowManagedNodeIds,
  ])

  const saveLoopPolicy = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return
    }

    setIsUpdatingCluster(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.setClusterLoopPolicy({
        clusterId: activeClusterId,
        loopPolicy: currentLoopPolicy(),
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsUpdatingCluster(false)
    }
  }, [activeClusterId, currentLoopPolicy, runtimeApi])

  const createMasterForCluster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
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
      const result = await runtimeApi.createMasterForCluster({
        clusterId: activeClusterId,
        prompt: masterPrompt,
        cwd,
        agent: selectedProvider.agent,
        providerKind: selectedProvider.id,
        providerInstanceId: newProviderInstance.providerInstanceId,
        runtimeSettings: providerRuntimeSettingsDraft({
          runtimeMode: newRuntimeMode,
          model: newModel,
          reasoningEffort: newReasoningEffort,
        }),
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
    newModel,
    newProviderInstance.providerInstanceId,
    newProviderKind,
    newReasoningEffort,
    newRuntimeMode,
    runtimeApi,
    runtimeState.clusters,
  ])

  const assignSelectedAsMaster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId || !selectedSessionId) {
      return
    }

    setIsCreatingMaster(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.assignMasterToCluster({
        clusterId: activeClusterId,
        sessionId: selectedSessionId,
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCreatingMaster(false)
    }
  }, [activeClusterId, runtimeApi, selectedSessionId])

  const startMasterLoop = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return
    }

    setIsStartingLoop(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.startMasterLoop({
        clusterId: activeClusterId,
        reason: 'Loop started from Orrery controls.',
      })
      setRuntimeState(result.state)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsStartingLoop(false)
    }
  }, [activeClusterId, runtimeApi])

  const stopMasterLoop = useCallback(async () => {
    if (!runtimeApi || !activeClusterId) {
      return
    }

    setIsStoppingLoop(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.stopMasterLoop({
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
  }, [activeClusterId, runtimeApi])

  const freezeSelectedSession = useCallback(async () => {
    if (!runtimeApi || !selectedSessionId || !selectedSession) {
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
      const result = await runtimeApi.freeze({
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
  }, [activeMasterSession, runtimeApi, selectedSession, selectedSessionId])

  const freezeActiveCluster = useCallback(async () => {
    if (!runtimeApi || !activeClusterId || !activeCluster) {
      return
    }

    setIsFreezingCluster(true)
    setRuntimeError(undefined)

    try {
      const reason = `Frozen from Workflows panel: ${activeCluster.label}`
      const result = await runtimeApi.freeze({
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
  }, [activeCluster, activeClusterId, activeMasterSession, runtimeApi])

  const loadSelectedWorkingTreeDiff = useCallback(
    async (requestedTurnId = diffTurnId) => {
      if (!selectedSessionId) {
        diffRequestSeqRef.current += 1
        setWorkingTreeDiff(undefined)
        setDiffPanelError(undefined)
        setIsLoadingDiff(false)
        return
      }

      if (!runtimeApi) {
        diffRequestSeqRef.current += 1
        setWorkingTreeDiff(undefined)
        setIsLoadingDiff(false)
        setDiffPanelError(runtimeUnavailableText)
        return
      }

      const requestSeq = diffRequestSeqRef.current + 1
      diffRequestSeqRef.current = requestSeq
      const requestedSessionId = selectedSessionId
      setWorkingTreeDiff((current) =>
        current?.sessionId === requestedSessionId ? current : undefined
      )
      setIsLoadingDiff(true)
      setDiffPanelError(undefined)

      try {
        const result = await runtimeApi.getWorkingTreeDiff({
          sessionId: requestedSessionId,
          ...(requestedTurnId ? { turnId: requestedTurnId } : {}),
        })
        if (
          diffRequestSeqRef.current !== requestSeq ||
          result.sessionId !== requestedSessionId
        ) {
          return
        }
        setWorkingTreeDiff(result)
      } catch (error) {
        if (diffRequestSeqRef.current !== requestSeq) {
          return
        }
        setDiffPanelError(error instanceof Error ? error.message : String(error))
      } finally {
        if (diffRequestSeqRef.current === requestSeq) {
          setIsLoadingDiff(false)
        }
      }
    },
    [diffTurnId, runtimeApi, runtimeUnavailableText, selectedSessionId]
  )

  useEffect(() => {
    if (!isDiffPanelOpen) {
      return
    }

    void loadSelectedWorkingTreeDiff(diffTurnId)
  }, [diffTurnId, isDiffPanelOpen, loadSelectedWorkingTreeDiff])

  const openWorkingTreeDiff = useCallback(() => {
    setDiffTurnId(undefined)
    if (isDiffPanelOpen) {
      void loadSelectedWorkingTreeDiff(undefined)
      return
    }
    setIsDiffPanelOpen(true)
  }, [isDiffPanelOpen, loadSelectedWorkingTreeDiff])

  const openTurnDiff = useCallback(
    (turnId: string) => {
      setDiffTurnId(turnId)
      if (isDiffPanelOpen) {
        void loadSelectedWorkingTreeDiff(turnId)
        return
      }
      setIsDiffPanelOpen(true)
    },
    [isDiffPanelOpen, loadSelectedWorkingTreeDiff]
  )

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

      if (!runtimeApi) {
        return
      }

      runtimeApi
        .updateNodePositions({ positions: updates })
        .then((result) => setRuntimeState(result.state))
        .catch((error: unknown) => {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        })
    },
    [runtimeApi]
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
      <main
        ref={splitContainerRef}
        className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground"
      >
        {/* ===== Sidebar: nav + chat list ===== */}
        <aside
          className="orrery-sidebar flex h-dvh min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
          style={{ width: railSidebarWidth }}
        >
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
              variant={isRuntimeAvailable || demoMode ? 'outline' : 'destructive'}
              className="shrink-0"
              title={
                runtimeClient.kind === 'http' ? runtimeClient.runtimeUrl : undefined
              }
            >
              {runtimeModeLabel}
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
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-background/60 p-1">
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
                  </button>
                )
              })}
            </div>
          </div>
          <div className="app-region-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
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
                    const node = runtimeState.nodes.find(
                      (candidate) => candidate.sessionId === session.sessionId
                    )
                    const managedCluster = Object.values(
                      runtimeState.clusters
                    ).find((cluster) =>
                      cluster.nodeIds.includes(session.sessionId)
                    )
                    const recovery = sessionRecoveryState({
                      session,
                      diagnostics: runtimeDiagnostics,
                      frozen:
                        node?.frozen === true || managedCluster?.frozen === true,
                    })

                    const isSel = selectedSessionId === session.sessionId
                    const marker = sessionMarker(
                      session.status,
                      isSel,
                      session.role
                    )
                    const canArchive =
                      session.status !== 'running' &&
                      session.status !== 'pending'
                    const archivePending =
                      archivingSessionIds[session.sessionId] === true

                    return (
                      <div
                        key={session.sessionId}
                        className={cn(
                          'group/chat relative rounded-lg border bg-ink font-mono transition',
                          isSel
                            ? 'border-lime-hi/50 ring-1 ring-lime-hi/25'
                            : 'border-ink-line hover:border-foreground/20',
                          session.archived && 'opacity-60'
                        )}
                      >
                        {isSel ? (
                          <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-lime-hi" />
                        ) : null}
                        <div className="flex items-center gap-1.5 py-2 pl-3 pr-2">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setPendingLinkedSourceId(null)
                              setSelectedSessionId(session.sessionId)
                              setActiveTab('chat')
                            }}
                          >
                            <div className="flex items-center gap-2">
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
                                  'min-w-0 flex-1 truncate text-[12.5px] font-medium',
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
                            <div className="mt-1 flex items-center gap-1.5 pl-[1.375rem] text-[11px] text-term-dim2">
                              <span
                                className="truncate"
                                title={`Created ${session.createdAt}`}
                              >
                                {formatTimestamp(session.createdAt)}
                              </span>
                              <span className="shrink-0 text-term-faint">·</span>
                              <span className="shrink-0 whitespace-nowrap">
                                <span className="tabular-nums text-term-dim">
                                  {session.messages.length}
                                </span>{' '}
                                msgs
                              </span>
                              {session.archived ? (
                                <>
                                  <span className="shrink-0 text-term-faint">
                                    ·
                                  </span>
                                  <span className="shrink-0 uppercase tracking-[0.08em]">
                                    hidden
                                  </span>
                                </>
                              ) : null}
                            </div>
                          </button>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="shrink-0 rounded-md border border-ink-line bg-background/35 p-1.5 text-term-dim opacity-0 transition hover:border-foreground/20 hover:text-term-name focus-visible:opacity-100 group-hover/chat:opacity-100 disabled:cursor-not-allowed"
                                disabled={
                                  !isRuntimeAvailable ||
                                  archivePending ||
                                  !canArchive
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

                        {recovery ? (
                          <div className="px-2.5 pb-2.5 pl-3">
                            <RecoveryNotice state={recovery} compact />
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
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

        {/* ===== Detail: selected chat or orchestrate ===== */}
        <section
          className={cn(
            'flex min-h-0 flex-col overflow-hidden bg-background',
            effectiveGraphCollapsed ? 'flex-1' : 'shrink-0'
          )}
          style={
            effectiveGraphCollapsed
              ? undefined
              : { width: chatPanelWidth, minWidth: chatPanelMinWidth }
          }
        >
          {runtimeError ? (
            <div className="app-region-no-drag mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11.5px] leading-5 text-destructive">
              <span className="shrink-0">✗</span>
              <span className="min-w-0 break-words">{runtimeError}</span>
            </div>
          ) : null}
          <RuntimeDiagnosticsBanner
            diagnostics={runtimeDiagnostics}
            sessions={sessions}
          />
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
                        !isRuntimeAvailable ||
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
                        !isRuntimeAvailable || isUpdatingCluster || !activeClusterId
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
                        !isRuntimeAvailable ||
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
                        !isRuntimeAvailable ||
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
                      disabled={
                        !isRuntimeAvailable || isStartingLoop || !canStartLoop
                      }
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
                      disabled={
                        !isRuntimeAvailable || isStoppingLoop || !canStopLoop
                      }
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
                          !isRuntimeAvailable ||
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
                          !isRuntimeAvailable ||
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
                          <ProviderInlineSelect
                            value={newProviderKind}
                            disabled={isCreating || !isRuntimeAvailable}
                            onChange={setNewProviderKind}
                          />
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
                                : 'project required'}
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
                          disabled={!isRuntimeAvailable}
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
                      isRuntimeAvailable={isRuntimeAvailable}
                      runtimeStatusText={runtimeStatusText}
                      providerKind={newProviderKind}
                      providerInstances={providerInstances}
                      runtimeError={runtimeError}
                      setupStatus={providerSetupStatus}
                      isLoadingSetupStatus={isLoadingProviderSetupStatus}
                      savingProviderInstanceId={savingProviderInstanceId}
                      providerInstanceError={providerInstanceError}
                      onSaveProviderInstance={saveProviderInstance}
                    />
                  )
                ) : null}

                <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
                  <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-ink-line-2 bg-ink px-4 py-2.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-term-dim2">
                      Timeline
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] tabular-nums text-term-faint">
                      {selectedSessionProjection?.timeline.length ?? 0} entries
                    </span>
                  </div>
                  {selectedSessionProjection?.timeline.length ? (
                    <SessionTimeline
                      entries={selectedSessionProjection.timeline}
                      agent={selectedSession?.agent ?? 'claude-code'}
                      canActOnPlan={canActOnPlan}
                      onContinuePlan={continueRuntimePlan}
                      onRevisePlan={reviseRuntimePlan}
                      onOpenTurnDiff={openTurnDiff}
                    />
                  ) : (
                    <div className="m-3.5 rounded-lg border border-dashed border-ink-line p-5 text-center font-mono text-sm text-term-dim2">
                      {selectedSession ? 'No messages yet.' : 'New Chat'}
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-border bg-card p-2.5">
                  {!selectedSession ? (
                    <>
                      {!isRuntimeAvailable ? (
                        <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
                          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                          <span className="min-w-0">
                            {runtimeUnavailableText}
                          </span>
                        </div>
                      ) : runtimeClient.kind === 'http' ? (
                        <div className="app-region-no-drag mb-2 flex items-start gap-2 rounded-lg border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
                          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                          <span className="min-w-0">
                            Folder picker is unavailable in web runtime. Enter a
                            project path manually.
                          </span>
                        </div>
                      ) : null}
                      <NewChatSetupBar
                        projects={newChatProjects}
                        projectCwd={newCwd}
                        validation={newCwdValidation}
                        workMode={newWorkMode}
                        branch={newBranch}
                        runtimeMode={newRuntimeMode}
                        model={newModel}
                        reasoningEffort={newReasoningEffort}
                        disabled={isCreating || !isRuntimeAvailable}
                        canChooseProject={isElectron}
                        onProjectChange={setNewCwd}
                        onChooseProject={chooseNewChatProject}
                        onWorkModeChange={setNewWorkMode}
                        onBranchChange={setNewBranch}
                        onRuntimeModeChange={setNewRuntimeMode}
                        onModelChange={setNewModel}
                        onReasoningEffortChange={setNewReasoningEffort}
                      />
                    </>
                  ) : null}
                  <input
                    ref={composerFileInputRef}
                    className="hidden"
                    type="file"
                    multiple
                    onChange={(event) => {
                      if (event.currentTarget.files) {
                        void addComposerFiles(event.currentTarget.files)
                      }
                      event.currentTarget.value = ''
                    }}
                  />
                  <div
                    className={cn(
                      'app-region-no-drag mb-2 rounded-lg border border-ink-line bg-ink transition focus-within:border-lime-hi/55 focus-within:ring-1 focus-within:ring-lime-hi/25',
                      isComposerDragActive &&
                        'border-lime-hi/60 ring-1 ring-lime-hi/25'
                    )}
                    onDragEnter={(event) => {
                      if (event.dataTransfer.types.includes('Files')) {
                        setIsComposerDragActive(true)
                      }
                    }}
                    onDragOver={(event) => {
                      if (event.dataTransfer.types.includes('Files')) {
                        event.preventDefault()
                      }
                    }}
                    onDragLeave={(event) => {
                      const nextTarget = event.relatedTarget
                      if (
                        !(nextTarget instanceof Node) ||
                        !event.currentTarget.contains(nextTarget)
                      ) {
                        setIsComposerDragActive(false)
                      }
                    }}
                    onDrop={handleComposerDrop}
                  >
                    {composerAttachments.length > 0 ? (
                      <div className="grid gap-1.5 border-b border-ink-line-2 p-2">
                        {composerAttachments.map((attachment) => (
                          <ComposerAttachmentPill
                            key={attachment.id}
                            attachment={attachment}
                            disabled={composerDisabled}
                            onRemove={removeComposerAttachment}
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="flex items-start gap-2 px-3 py-2.5">
                      <span className="pt-1 font-mono text-lime-hi">❯</span>
                      <div
                        ref={composerEditorRef}
                        className="orrery-composer-editor max-h-32 min-h-9 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent py-0.5 font-mono text-[13px] leading-6 text-term-name outline-none"
                        role="textbox"
                        aria-multiline="true"
                        aria-disabled={composerDisabled}
                        contentEditable={!composerDisabled}
                        data-placeholder={
                          selectedSession
                            ? 'Message this chat'
                            : pendingLinkedSource
                              ? 'Start a linked chat'
                              : 'Start a new chat'
                        }
                        suppressContentEditableWarning
                        onInput={(event) =>
                          setMessage(event.currentTarget.innerText)
                        }
                        onPaste={handleComposerPaste}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            (event.metaKey || event.ctrlKey)
                          ) {
                            event.preventDefault()
                            void sendChatMessage()
                          }
                        }}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            className="mt-0.5 size-7 shrink-0"
                            variant="ghost"
                            size="icon"
                            disabled={composerDisabled}
                            aria-label="Attach files"
                            onClick={() => composerFileInputRef.current?.click()}
                          >
                            <Paperclip className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Attach files</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Button
                      className="app-region-no-drag min-w-0 justify-center font-mono text-[12px] uppercase tracking-[0.08em]"
                      disabled={
                        !isRuntimeAvailable ||
                        (selectedSession
                          ? !canResume || isResuming
                          : isCreating || !newCwdValidation.ok) ||
                        !composerHasPayload
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
                          disabled={!isRuntimeAvailable || !selectedSession || !canKill}
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
        </section>

        {/* ===== Resize handle (chat width) — only when graph visible ===== */}
        {effectiveGraphCollapsed ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          tabIndex={0}
          className={cn(
            'app-region-no-drag group/split relative z-20 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center bg-background outline-none transition focus-visible:bg-accent',
            isResizingChatPanel && 'bg-accent'
          )}
          onPointerDown={(event) => {
            event.preventDefault()
            setIsResizingChatPanel(true)
          }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            const step = event.shiftKey ? 48 : 24
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              adjustChatPanelWidth(-step)
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              adjustChatPanelWidth(step)
            }
          }}
        >
          <span className="h-10 w-px rounded-full bg-border transition group-hover/split:bg-accent-ink group-focus-visible/split:bg-accent-ink" />
        </div>
        )}

        {/* ===== Session graph (collapsible) ===== */}
        {effectiveGraphCollapsed ? (
          <div className="flex h-dvh shrink-0 flex-col items-center gap-3 border-l border-border bg-background px-1.5 py-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Show session graph"
                  onClick={() => setGraphCollapsed(false)}
                >
                  <PanelRightOpen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {graphForcedCollapsed
                  ? 'Widen window to show session graph'
                  : 'Show session graph'}
              </TooltipContent>
            </Tooltip>
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground [writing-mode:vertical-rl]">
              <Activity className="size-3.5 text-accent-ink" />
              Session graph
            </span>
          </div>
        ) : (
        <section
          className="flex min-w-0 flex-1 flex-col bg-background"
          style={{ minWidth: canvasPanelMinWidth }}
        >
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

            <div className="flex shrink-0 items-center gap-2">
              <Button
                className="h-8 font-mono text-[11px] uppercase tracking-[0.08em]"
                variant={isDiffPanelOpen ? 'secondary' : 'outline'}
                size="sm"
                disabled={!canOpenDiffPanel}
                onClick={openWorkingTreeDiff}
              >
                <FileText className="size-3.5" />
                <span className="truncate">Diff</span>
              </Button>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Hide session graph"
                    onClick={() => setGraphCollapsed(true)}
                  >
                    <PanelRightClose className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Hide session graph</TooltipContent>
              </Tooltip>

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
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
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

            {isDiffPanelOpen ? (
              <WorkingTreeDiffPanel
                session={selectedSession}
                diff={selectedWorkingTreeDiff}
                isLoading={isLoadingDiff}
                error={diffPanelError}
                onRefresh={() => void loadSelectedWorkingTreeDiff()}
                onClose={() => setIsDiffPanelOpen(false)}
              />
            ) : null}
          </div>
        </section>
        )}
      </main>
    </TooltipProvider>
  )
}

export default App
