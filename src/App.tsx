import '@xyflow/react/dist/style.css'
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
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
  createEmptyGraphState,
  type AgentSession,
  type GraphState,
  type OpenWorkspaceTarget,
  type ProjectContext,
  type ProviderSetupStatus,
  type RuntimeTerminal,
  type WorkMode,
  type WorkingTreeDiffResult,
} from '@/shared/graph-state'
import {
  type ChatAttachment,
  type ProviderInstance,
  type ProviderKind,
  type ProviderReasoningEffort,
  type ProviderRuntimeMode,
  type RuntimeRequestDecision,
  type RuntimePlan,
  type RuntimeRequest,
  type UserInputAnswerMap,
  type UserInputAnswerValue,
  type UserInputRequest,
  providerCapability,
  providerRuntimeModeCapability,
} from '@/shared/provider-runtime'
import {
  projectSession,
} from '@/shared/session-projection'
import {
  createDemoGraphState,
} from '@/shared/demo-state'
import {
  useRuntimeClient,
} from '@/runtime-client'
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
  sessionMatchesSearch,
  sessionSort,
} from '@/lib/session-display'
import {
  chatPanelWidthStorageKey,
  chatPanelMinWidth,
  canvasPanelMinWidth,
  railSidebarWidth,
  expandedGraphLayoutMinWidth,
  graphCollapsedStorageKey,
  openWorkspaceTargetStorageKey,
  initialChatPanelWidth,
  initialOpenWorkspaceTarget,
  initialGraphCollapsed,
  initialViewportWidth,
  clampChatPanelWidth,
} from '@/lib/layout-prefs'
import {
  composerAttachmentFromFile,
  insertPlainTextAtCaret,
} from '@/lib/attachments'
import {
  edgeKindClassNames,
  loopPolicySummary,
  loopStateStatus,
  loopLastEvent,
  clusterBoundaryNodes,
  edgeSummary,
  activityTitle,
  activityEvents,
  nodePositionUpdatesFromFlowNodes,
  applyNodePositionUpdates,
  applyFlowNodePositionUpdates,
} from '@/lib/graph-view'
import {
  providerOption,
  providerInstanceForKind,
  providerRuntimeSettingsDraft,
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
  isDemoModeRequested,
  defaultWorkspaceCwd,
  latestSessionCwd,
  projectNameFromCwd,
  projectOptionsFromSessions,
  validateProjectCwd,
} from '@/lib/workspace'
import {
  sessionRecoveryState,
  invalidCwdsFromDiagnostics,
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
  latestReportForSession,
  reportIssueCount,
  reportSummary,
} from '@/lib/reports'
import {
  type WorkflowStepStatus,
  workflowStatusPillClassName,
  WorkflowStep,
  WorkflowSummaryRow,
} from '@/components/workflow'
import {
  SessionTimeline,
} from '@/components/timeline'
import {
  userInputDraftKey,
  answerValueAsString,
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

type ColorScheme = 'dark' | 'light'

type RailTab = 'orchestrate' | 'sessions' | 'chat'

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function sameStringList(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  )
}

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'orchestrate', label: 'Orchestrate', icon: Orbit },
]

const demoMode = isDemoModeRequested()

const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

const sendShortcutHint = isMacPlatform ? '⌘⏎' : 'Ctrl+⏎'

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
  const [openWorkspaceTarget, setOpenWorkspaceTarget] =
    useState<OpenWorkspaceTarget>(initialOpenWorkspaceTarget)
  const [openingWorkspaceTarget, setOpeningWorkspaceTarget] =
    useState<OpenWorkspaceTarget>()
  const [terminalPanel, setTerminalPanel] = useState<RuntimeTerminal>()
  const [isTerminalPanelOpen, setIsTerminalPanelOpen] = useState(false)
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false)
  const [isSendingTerminalCommand, setIsSendingTerminalCommand] =
    useState(false)
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
  const runtimeHostPlatform =
    runtimeClient.kind === 'electron' || runtimeClient.kind === 'http'
      ? runtimeClient.platform
      : undefined
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

  const changeNewProviderKind = useCallback((providerKind: ProviderKind) => {
    setNewProviderKind(providerKind)
    setNewModel('')
    const runtimeModes = providerCapability(providerKind).runtimeModes
    setNewRuntimeMode((current) =>
      providerRuntimeModeCapability(providerKind, current)
        ? current
        : runtimeModes[0]?.id ?? 'approval-required'
    )
  }, [])

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
  const canOpenSelectedWorkspace = Boolean(
    isRuntimeAvailable && selectedSession?.cwd.trim()
  )
  const selectedTerminal =
    terminalPanel?.sessionId === selectedSession?.sessionId
      ? terminalPanel
      : undefined
  const canOpenSelectedTerminal = Boolean(
    isRuntimeAvailable && selectedSession?.sessionId && selectedSession?.cwd.trim()
  )
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
    changeNewProviderKind(selectedSession.providerKind)
    setNewCwd(sourceCwd)
    setNewWorkMode('local')
    setNewBranch('')
    setActiveTab('chat')
    setShowRawEvents(false)
    clearComposer()
  }, [changeNewProviderKind, clearComposer, invalidProjectCwds, selectedSession, sessions])

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
            label: session ? sessionDisplayLabel(session) : node.label,
            description: lastMessagePreview(session),
            agent: shortAgentName(
              session ? sessionProviderLabel(session) : node.agent
            ),
            role: node.role,
            status: node.status,
            messageCount: session?.messages.length ?? 0,
            lastActivityTs: session?.updatedAt,
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

    try {
      window.localStorage.setItem(
        openWorkspaceTargetStorageKey,
        openWorkspaceTarget
      )
    } catch {
      // Open-target persistence is best-effort.
    }
  }, [openWorkspaceTarget])

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
      if ('state' in event) {
        setRuntimeState(event.state)
      }
      if ('terminal' in event) {
        setTerminalPanel((current) =>
          current?.terminalId === event.terminal.terminalId
            ? event.terminal
            : current
        )
      }
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

  const openSelectedWorkspace = useCallback(
    async (target: OpenWorkspaceTarget) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText)
        return
      }
      if (!selectedSession) {
        return
      }

      setOpeningWorkspaceTarget(target)
      setRuntimeError(undefined)

      try {
        await runtimeApi.openWorkspace({
          cwd: selectedSession.cwd,
          target,
        })
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
      } finally {
        setOpeningWorkspaceTarget(undefined)
      }
    },
    [runtimeApi, runtimeUnavailableText, selectedSession]
  )

  const openSelectedTerminal = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText)
      return undefined
    }
    if (!selectedSession) {
      return undefined
    }

    setIsOpeningTerminal(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.createTerminal({
        sessionId: selectedSession.sessionId,
        cwd: selectedSession.cwd,
      })
      setTerminalPanel(result.terminal)
      setIsTerminalPanelOpen(true)
      return result.terminal
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
      return undefined
    } finally {
      setIsOpeningTerminal(false)
    }
  }, [runtimeApi, runtimeUnavailableText, selectedSession])

  const runSelectedTerminalCommand = useCallback(async (command: string) => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText)
      return
    }

    const terminal =
      selectedTerminal?.status === 'running'
        ? selectedTerminal
        : await openSelectedTerminal()
    if (!terminal) {
      return
    }

    setIsSendingTerminalCommand(true)
    setRuntimeError(undefined)

    try {
      const result = await runtimeApi.runTerminalCommand({
        terminalId: terminal.terminalId,
        command,
      })
      setTerminalPanel(result.terminal)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const currentCommand = result.terminal.currentCommand
        if (!currentCommand || currentCommand.commandId !== result.commandId) {
          break
        }

        await wait(100)
        const refreshed = await runtimeApi.getTerminal({
          terminalId: terminal.terminalId,
        })
        setTerminalPanel(refreshed.terminal)
        const finished = refreshed.terminal.lastCommand
        if (
          finished?.commandId === result.commandId ||
          refreshed.terminal.currentCommand?.commandId !== result.commandId
        ) {
          break
        }
      }
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSendingTerminalCommand(false)
    }
  }, [
    openSelectedTerminal,
    runtimeApi,
    runtimeUnavailableText,
    selectedTerminal,
  ])

  const clearSelectedTerminal = useCallback(async () => {
    if (!runtimeApi || !selectedTerminal) {
      return
    }

    try {
      const result = await runtimeApi.clearTerminal({
        terminalId: selectedTerminal.terminalId,
      })
      setTerminalPanel(result.terminal)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    }
  }, [runtimeApi, selectedTerminal])

  const closeSelectedTerminal = useCallback(async () => {
    if (!runtimeApi || !selectedTerminal) {
      setIsTerminalPanelOpen(false)
      return
    }

    try {
      const result = await runtimeApi.closeTerminal({
        terminalId: selectedTerminal.terminalId,
      })
      setTerminalPanel(result.terminal)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsTerminalPanelOpen(false)
    }
  }, [runtimeApi, selectedTerminal])

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
