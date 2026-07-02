import {
  Archive,
  MessagesSquare,
  Orbit,
  type LucideIcon,
  ArchiveRestore,
  FileText,
  GitBranch,
  MessageSquarePlus,
  Search,
  X,
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
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  cn,
} from '@/lib/utils'
import {
  statusLabels,
  sessionMarker,
  statePillBase,
  statePillCls,
  sessionProviderLabel,
  sessionDisplayLabel,
  shortAgentName,
  lastMessagePreview,
} from '@/lib/session-display'
import {
  railSidebarWidth,
  type RailTab,
} from '@/lib/layout-prefs'
import {
  formatTimestamp,
  formatRelativeTime,
  firstContentLine,
} from '@/lib/format'
import {
  sessionRecoveryState,
} from '@/lib/diagnostics'
import {
  RecoveryNotice,
} from '@/components/recovery'
import {
  OrreryMark,
} from '@/components/orrery-mark'
import {
  demoMode,
} from '@/lib/workspace'
import {
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  type RuntimeCoreState,
} from '@/hooks/use-runtime-core'
import {
  type SessionListState,
} from '@/hooks/use-session-list'
import {
  type SessionActionsState,
} from '@/hooks/use-session-actions'

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'orchestrate', label: 'Orchestrate', icon: Orbit },
]

type SidebarRailProps = {
  core: RuntimeCoreState
  sessionList: SessionListState
  actions: SessionActionsState
  activeTab: RailTab
  setActiveTab: Dispatch<SetStateAction<RailTab>>
}

export function SidebarRail({
  core,
  sessionList,
  actions,
  activeTab,
  setActiveTab,
}: SidebarRailProps) {
  const {
    runtimeClient,
    isRuntimeAvailable,
    isElectron,
    runtimeModeLabel,
    runtimeState,
    selectedSessionId,
    setSelectedSessionId,
    sessions,
    runtimeDiagnostics,
  } = core
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
  } = sessionList
  const {
    setPendingLinkedSourceId,
    startNewChat,
  } = actions
  return (
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
  )
}
