import '@xyflow/react/dist/style.css'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useState,
} from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
} from '@xyflow/react'
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowUp,
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
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  RefreshCw,
  Search,
  Snowflake,
  Square,
  Sun,
  Terminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  Badge,
} from '@/components/ui/badge'
import {
  Button,
} from '@/components/ui/button'
import {
  Separator,
} from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  cn,
} from '@/lib/utils'
import {
  TermChip,
  TermLabel,
  termInputCls,
  termTextareaCls,
  termActionBtnCls,
} from '@/components/terminal'
import {
  statusLabels,
  statusDotClassNames,
  sessionMarker,
  statePillBase,
  statePillCls,
  sessionProviderLabel,
  sessionChatId,
  sessionDisplayLabel,
  shortAgentName,
  lastMessagePreview,
} from '@/lib/session-display'
import {
  chatPanelMinWidth,
  canvasPanelMinWidth,
  railSidebarWidth,
} from '@/lib/layout-prefs'
import {
  edgeKindClassNames,
  loopPolicySummary,
  loopStateStatus,
  activityTitle,
} from '@/lib/graph-view'
import {
  providerOption,
  runtimeConfigSummary,
} from '@/lib/provider-catalog'
import {
  ProviderSegmentedControl,
  ProjectCwdField,
  OpenWorkspaceSplitButton,
  NewChatSetupBar,
} from '@/components/new-chat-setup'
import {
  compactPath,
  compactId,
  formatTimestamp,
  formatRelativeTime,
  firstContentLine,
} from '@/lib/format'
import {
  sessionRecoveryState,
} from '@/lib/diagnostics'
import {
  RecoveryNotice,
  RuntimeDiagnosticsToast,
} from '@/components/recovery'
import {
  SessionTerminalPanel,
} from '@/components/session-terminal-panel'
import {
  nodeTypes,
  edgeTypes,
} from '@/components/canvas'
import {
  workflowStatusPillClassName,
  WorkflowStep,
  WorkflowSummaryRow,
} from '@/components/workflow'
import {
  SessionTimeline,
} from '@/components/timeline'
import {
  RuntimeInteractionPanel,
} from '@/components/runtime-interaction-panel'
import {
  ProviderEventDrawer,
} from '@/components/provider-event-drawer'
import {
  WorkingTreeDiffPanel,
} from '@/components/working-tree-diff-panel'
import {
  ProviderSetupDiagnostics,
} from '@/components/provider-settings'
import {
  ComposerAttachmentPill,
} from '@/components/composer-attachment-pill'
import {
  OrreryMark,
} from '@/components/orrery-mark'

import { demoMode } from '@/lib/workspace'
import { type RailTab } from '@/lib/layout-prefs'
import { useRuntimeCore } from '@/hooks/use-runtime-core'
import { useLayoutPrefs } from '@/hooks/use-layout-prefs'
import { useComposer } from '@/hooks/use-composer'
import { useNewChatSetup } from '@/hooks/use-new-chat-setup'
import { useSessionList } from '@/hooks/use-session-list'
import { useTerminalPanel } from '@/hooks/use-terminal-panel'
import { useRuntimeSubscription } from '@/hooks/use-runtime-subscription'
import { useSessionActions } from '@/hooks/use-session-actions'
import { useInteractions } from '@/hooks/use-interactions'
import { useDiffPanel } from '@/hooks/use-diff-panel'
import { useCanvas } from '@/hooks/use-canvas'
import { useOrchestration } from '@/hooks/use-orchestration'

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'orchestrate', label: 'Orchestrate', icon: Orbit },
]

const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

const sendShortcutHint = isMacPlatform ? '⌘⏎' : 'Ctrl+⏎'

function App() {
  const [activeTab, setActiveTab] = useState<RailTab>('chat')
  const [showRawEvents, setShowRawEvents] = useState(false)
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<string[]>([])
  const [activeClusterId, setActiveClusterId] = useState<string>()

  const {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    isElectron,
    runtimeHostPlatform,
    runtimeModeLabel,
    runtimeStatusText,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    runtimeError,
    setRuntimeError,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionProjection,
    selectedSessionFrozen,
    selectedSessionIsMaster,
    openRuntimeRequests,
    openUserInputRequests,
    sessions,
    providerInstances,
    runtimeDiagnostics,
    invalidProjectCwds,
    selectedRecoveryState,
    reportsById,
    graphActivity,
    canResume,
    canKill,
    canActOnPlan,
  } = useRuntimeCore()

  const {
    splitContainerRef,
    chatPanelWidth,
    isResizingChatPanel,
    setIsResizingChatPanel,
    setGraphCollapsed,
    colorScheme,
    setColorScheme,
    openWorkspaceTarget,
    setOpenWorkspaceTarget,
    adjustChatPanelWidth,
    graphForcedCollapsed,
    effectiveGraphCollapsed,
  } = useLayoutPrefs()

  const {
    message,
    setMessage,
    composerAttachments,
    isComposerDragActive,
    setIsComposerDragActive,
    composerEditorRef,
    composerFileInputRef,
    setComposerText,
    clearComposer,
    addComposerFiles,
    removeComposerAttachment,
    handleComposerPaste,
    handleComposerDrop,
    composerHasPayload,
  } = useComposer({ setRuntimeError })

  const {
    newProviderKind,
    newCwd,
    setNewCwd,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    setNewRuntimeMode,
    newModel,
    setNewModel,
    newReasoningEffort,
    setNewReasoningEffort,
    providerSetupStatus,
    isLoadingProviderSetupStatus,
    savingProviderInstanceId,
    providerInstanceError,
    newProviderInstance,
    changeNewProviderKind,
    newCwdValidation,
    newChatProjects,
    chooseNewChatProject,
    saveProviderInstance,
    restoreCwdFallback,
  } = useNewChatSetup({
    runtimeApi,
    runtimeClient,
    runtimeUnavailableText,
    setRuntimeState,
    setRuntimeError,
    sessions,
    invalidProjectCwds,
    providerInstances,
    selectedSession,
    showRawEvents,
  })

  const {
    sessionSearch,
    setSessionSearch,
    showArchivedSessions,
    setShowArchivedSessions,
    archivingSessionIds,
    runningSessions,
    archivedSessionCount,
    filteredSessions,
    setSessionArchived,
  } = useSessionList({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    sessions,
    runtimeDiagnostics,
  })

  const {
    isTerminalPanelOpen,
    isOpeningTerminal,
    isSendingTerminalCommand,
    selectedTerminal,
    canOpenSelectedTerminal,
    syncTerminalFromEvent,
    openSelectedTerminal,
    runSelectedTerminalCommand,
    clearSelectedTerminal,
    closeSelectedTerminal,
  } = useTerminalPanel({
    runtimeApi,
    runtimeUnavailableText,
    setRuntimeError,
    selectedSession,
    isRuntimeAvailable,
  })

  useRuntimeSubscription({
    runtimeApi,
    setRuntimeState,
    setSelectedSessionId,
    setRuntimeError,
    syncTerminalFromEvent,
    restoreCwdFallback,
  })

  const {
    isCreating,
    isResuming,
    setPendingLinkedSourceId,
    pendingLinkedSource,
    openingWorkspaceTarget,
    composerDisabled,
    canOpenSelectedWorkspace,
    startNewChat,
    startLinkedChat,
    sendChatMessage,
    killSelectedSession,
    openSelectedWorkspace,
    continueRuntimePlan,
    reviseRuntimePlan,
  } = useSessionActions({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    isRuntimeAvailable,
    canResume,
    invalidProjectCwds,
    setActiveTab,
    setShowRawEvents,
    composer: {
      message,
      composerAttachments,
      clearComposer,
      setComposerText,
      composerEditorRef,
    },
    newChat: {
      newCwd,
      setNewCwd,
      newWorkMode,
      setNewWorkMode,
      newBranch,
      setNewBranch,
      newProviderKind,
      newRuntimeMode,
      newModel,
      newReasoningEffort,
      newProviderInstance,
      changeNewProviderKind,
    },
  })

  const {
    userInputDrafts,
    setUserInputDraft,
    pendingInteractionIds,
    respondToRuntimeRequest,
    answerRuntimeUserInput,
  } = useInteractions({
    runtimeApi,
    runtimeUnavailableText,
    setRuntimeState,
    setRuntimeError,
  })

  const {
    isDiffPanelOpen,
    setIsDiffPanelOpen,
    isLoadingDiff,
    selectedWorkingTreeDiff,
    diffPanelError,
    canOpenDiffPanel,
    loadSelectedWorkingTreeDiff,
    openWorkingTreeDiff,
    openTurnDiff,
  } = useDiffPanel({
    runtimeApi,
    runtimeUnavailableText,
    isRuntimeAvailable,
    selectedSession,
    selectedSessionId,
  })

  const {
    edges,
    canvasNodes,
    updateCanvasNodePositions,
    beginCanvasNodeDrag,
    persistCanvasNodePositions,
    updateCanvasSelection,
  } = useCanvas({
    runtimeApi,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    reportsById,
    setSelectedCanvasNodeIds,
    setActiveClusterId,
  })

  const {
    clusterLabel,
    setClusterLabel,
    maxIterations,
    setMaxIterations,
    masterPrompt,
    setMasterPrompt,
    isUpdatingCluster,
    isCreatingMaster,
    isStartingLoop,
    isStoppingLoop,
    isFreezingSelected,
    isFreezingCluster,
    clusters,
    activeCluster,
    activeManagedSessions,
    activeMasterSession,
    activeLoopStatus,
    activeLoopIterations,
    activeLoopMaxIterations,
    activeLoopReason,
    activeLoopLastEvent,
    activeLoopCoder,
    activeLoopReviewer,
    canStartLoop,
    canStopLoop,
    canFreezeSelectedSession,
    canFreezeActiveCluster,
    workflowManagedNodeIds,
    setupSteps,
    currentLoopPolicy,
    upsertManagedCluster,
    saveLoopPolicy,
    createMasterForCluster,
    assignSelectedAsMaster,
    startMasterLoop,
    stopMasterLoop,
    freezeSelectedSession,
    freezeActiveCluster,
  } = useOrchestration({
    runtimeApi,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    setRuntimeError,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    selectedSessionFrozen,
    selectedCanvasNodeIds,
    activeClusterId,
    setActiveClusterId,
    setPendingLinkedSourceId,
    newChat: {
      newCwd,
      newProviderKind,
      newRuntimeMode,
      newModel,
      newReasoningEffort,
      newProviderInstance,
    },
  })

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
                  Agent workspace
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
                      'relative flex items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 font-mono text-xs font-medium transition-colors',
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
                        placeholder="Search chats"
                        title="Search by label, id, provider, cwd, status, or messages"
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
                      title={
                        showArchivedSessions
                          ? 'Showing hidden chats — click to hide them again'
                          : 'Show hidden (archived) chats'
                      }
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
                                title={sessionDisplayLabel(session)}
                              >
                                {sessionDisplayLabel(session)}
                              </span>
                              {session.role === 'master' ||
                              session.status !== 'idle' ? (
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
                              ) : null}
                            </div>
                            <div className="mt-1 truncate text-[11px] leading-4 text-term-dim">
                              {firstContentLine(lastMessagePreview(session)) ??
                                '…'}
                            </div>
                            <div className="mt-1 flex items-center gap-1 text-[11px] text-term-dim2">
                              <span className="shrink-0">
                                {shortAgentName(sessionProviderLabel(session))}
                              </span>
                              <span className="shrink-0 text-term-faint">·</span>
                              <span
                                className="truncate"
                                title={`Created ${formatTimestamp(session.createdAt)} · updated ${formatTimestamp(session.updatedAt)}`}
                              >
                                {formatRelativeTime(session.updatedAt)}
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
            'relative flex min-h-0 flex-col overflow-hidden bg-background',
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
          <RuntimeDiagnosticsToast
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
                      onChange={changeNewProviderKind}
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
                <div className="@container shrink-0 border-b border-border bg-card px-3.5 py-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          Chat
                        </span>
                        <h2
                          className="min-w-0 flex-1 truncate text-[14px] font-semibold"
                          title={
                            selectedSession
                              ? sessionDisplayLabel(selectedSession)
                              : undefined
                          }
                        >
                          {selectedSession
                            ? sessionDisplayLabel(selectedSession)
                            : pendingLinkedSource
                              ? 'Linked Chat'
                              : 'New Chat'}
                        </h2>
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
                        <OpenWorkspaceSplitButton
                          target={openWorkspaceTarget}
                          platform={runtimeHostPlatform}
                          disabled={!canOpenSelectedWorkspace}
                          pendingTarget={openingWorkspaceTarget}
                          onTargetChange={setOpenWorkspaceTarget}
                          onOpen={openSelectedWorkspace}
                        />
                      ) : null}
                      {selectedSession ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                              variant={
                                isTerminalPanelOpen && selectedTerminal
                                  ? 'secondary'
                                  : 'outline'
                              }
                              size="sm"
                              disabled={
                                !canOpenSelectedTerminal || isOpeningTerminal
                              }
                              aria-label="Open Terminal"
                              onClick={openSelectedTerminal}
                            >
                              {isOpeningTerminal ? (
                                <RefreshCw className="size-3.5 animate-spin" />
                              ) : (
                                <Terminal className="size-3.5" />
                              )}
                              <span className="hidden @[34rem]:inline">
                                Terminal
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Open Terminal</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {selectedSession ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              className="app-region-no-drag h-7 px-2 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                              variant="outline"
                              size="sm"
                              disabled={!isRuntimeAvailable}
                              aria-label="Start linked chat"
                              onClick={startLinkedChat}
                            >
                              <GitBranch className="size-3.5" />
                              <span className="hidden @[34rem]:inline">
                                Linked
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Start a linked chat from this chat
                          </TooltipContent>
                        </Tooltip>
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
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
                        {selectedSession ? (
                          <>
                            <span className="shrink-0 text-foreground/75">
                              {sessionProviderLabel(selectedSession)}
                            </span>
                            <span className="shrink-0 text-term-faint">·</span>
                            <span className="shrink-0 text-foreground/55">
                              {runtimeConfigSummary(
                                selectedSession.providerKind,
                                selectedSession.runtimeSettings,
                                selectedSession.effectiveRuntimeConfig
                              )}
                            </span>
                            <span className="shrink-0 text-term-faint">|</span>
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={selectedSession.cwd || undefined}
                            >
                              {selectedSession.cwd.trim()
                                ? compactPath(selectedSession.cwd)
                                : 'no project'}
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
                            <span className="shrink-0 text-term-faint">·</span>
                            <span className="shrink-0 text-foreground/55">
                              {runtimeConfigSummary(newProviderKind, {
                                runtimeMode: newRuntimeMode,
                                model: newModel,
                                reasoningEffort: newReasoningEffort,
                              })}
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

                {isTerminalPanelOpen && selectedTerminal ? (
                  <SessionTerminalPanel
                    terminal={selectedTerminal}
                    isOpening={isOpeningTerminal}
                    isSending={isSendingTerminalCommand}
                    onSubmit={runSelectedTerminalCommand}
                    onClear={clearSelectedTerminal}
                    onClose={closeSelectedTerminal}
                  />
                ) : null}

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
                        providerKind={newProviderKind}
                        workMode={newWorkMode}
                        branch={newBranch}
                        runtimeMode={newRuntimeMode}
                        model={newModel}
                        reasoningEffort={newReasoningEffort}
                        disabled={isCreating || !isRuntimeAvailable}
                        canChooseProject={isElectron}
                        onProjectChange={setNewCwd}
                        onChooseProject={chooseNewChatProject}
                        onProviderKindChange={changeNewProviderKind}
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
                      'app-region-no-drag @container mb-2 rounded-xl border border-ink-line bg-ink transition focus-within:border-lime-hi/55 focus-within:ring-1 focus-within:ring-lime-hi/25',
                      isComposerDragActive &&
                        'border-lime-hi/60 bg-lime/[0.05] ring-1 ring-lime-hi/25'
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
                      <div className="grid gap-1.5 border-b border-ink-line-2 px-2.5 py-2">
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
                    <div
                      className="flex cursor-text gap-2 px-3.5 pb-1 pt-3"
                      onClick={() => composerEditorRef.current?.focus()}
                    >
                      <span
                        className={cn(
                          'select-none font-mono text-[13px] leading-6 transition-colors',
                          composerDisabled ? 'text-term-faint' : 'text-lime-hi'
                        )}
                        aria-hidden="true"
                      >
                        ❯
                      </span>
                      <div
                        ref={composerEditorRef}
                        className="orrery-composer-editor max-h-40 min-h-6 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono text-[13px] leading-6 text-term-name outline-none"
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
                    </div>
                    <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            className="size-8 shrink-0 text-term-dim hover:text-term-name"
                            variant="ghost"
                            size="icon-sm"
                            disabled={composerDisabled}
                            aria-label="Attach files"
                            onClick={() => composerFileInputRef.current?.click()}
                          >
                            <Paperclip className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Attach files — or drag and drop, or paste
                        </TooltipContent>
                      </Tooltip>
                      <div className="ml-auto flex items-center gap-2">
                        {composerHasPayload && !canKill ? (
                          <span className="hidden font-mono text-[10px] text-term-faint @[26rem]:inline">
                            {sendShortcutHint}
                          </span>
                        ) : null}
                        {canKill ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                className="size-8 shrink-0 rounded-full"
                                variant="destructive"
                                size="icon-sm"
                                disabled={
                                  !isRuntimeAvailable ||
                                  !selectedSession ||
                                  !canKill
                                }
                                aria-label="Stop"
                                onClick={killSelectedSession}
                              >
                                <Square className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Stop this run</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                className="size-8 shrink-0 rounded-full"
                                size="icon-sm"
                                disabled={
                                  !isRuntimeAvailable ||
                                  (selectedSession
                                    ? !canResume || isResuming
                                    : isCreating || !newCwdValidation.ok) ||
                                  !composerHasPayload
                                }
                                aria-label={
                                  !selectedSession && pendingLinkedSource
                                    ? 'Create linked chat'
                                    : 'Send'
                                }
                                onClick={sendChatMessage}
                              >
                                <ArrowUp className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {!selectedSession && pendingLinkedSource
                                ? `Create linked chat · ${sendShortcutHint}`
                                : `Send · ${sendShortcutHint}`}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
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
                <div className="pointer-events-none absolute bottom-3 left-14 z-10 w-[280px] max-w-[calc(100%-4.5rem)] opacity-80 transition-opacity hover:opacity-100">
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
                <MiniMap
                  pannable
                  zoomable
                  bgColor="var(--card)"
                  maskColor="color-mix(in oklch, var(--background) 55%, transparent)"
                  nodeColor="var(--muted)"
                  nodeStrokeColor="var(--border)"
                />
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
