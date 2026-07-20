import { Archive, MessagesSquare, Orbit, type LucideIcon, ArchiveRestore, FileText, GitBranch, MessageSquarePlus, Search, Workflow, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { statusDotClassNames, sessionDisplayLabel, firstOpenRequests, lastMessagePreview } from '@/lib/session-display';
import { railSidebarWidth, type RailTab } from '@/lib/layout-prefs';
import { formatRelativeTime, formatTimestamp, firstContentLine } from '@/lib/format';
import { sessionRecoveryState } from '@/lib/diagnostics';
import { RecoveryNotice } from '@/components/recovery';
import { OrreryMark } from '@/components/orrery-mark';
import { demoMode } from '@/lib/workspace';
import { type Dispatch, type SetStateAction } from 'react';
import { type AgentSession } from '@/shared/graph-state';
import { type RuntimeRequest, type UserInputRequest } from '@/shared/provider-runtime';
import { type RuntimeCoreState } from '@/hooks/use-runtime-core';
import { type SessionListState } from '@/hooks/use-session-list';
import { type SessionActionsState } from '@/hooks/use-session-actions';
import { type InteractionsState } from '@/hooks/use-interactions';

const railTabs: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'orchestrate', label: 'Advanced', icon: Orbit },
];

type SidebarRailProps = {
  core: RuntimeCoreState;
  sessionList: SessionListState;
  actions: SessionActionsState;
  interactions: InteractionsState;
  activeTab: RailTab;
  setActiveTab: Dispatch<SetStateAction<RailTab>>;
  onStartWorkflow: () => void;
};

type SessionTier = 'attention' | 'running' | 'recent';

type SessionEntry = {
  session: AgentSession;
  recovery: ReturnType<typeof sessionRecoveryState>;
  openRequests: RuntimeRequest[];
  openInputs: UserInputRequest[];
  tier: SessionTier;
};

// "2m ago" reads fine in a card body but eats width in one-line rows.
function compactTime(value?: string) {
  return formatRelativeTime(value).replace(' ago', '');
}

function SectionHeader({ label, count, toneCls }: { label: string; count?: number; toneCls: string }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5 pt-3.5 font-mono text-[11px] first:pt-1">
      <span className={toneCls}>{label}</span>
      {count !== undefined ? <span className={cn('tabular-nums', toneCls)}>{count}</span> : null}
      <span className="h-px min-w-0 flex-1 bg-ink-line" />
    </div>
  );
}

export function SidebarRail({ core, sessionList, actions, interactions, activeTab, setActiveTab, onStartWorkflow }: SidebarRailProps) {
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
  } = core;
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
  } = sessionList;
  const { setPendingLinkedSourceId, startNewChat } = actions;
  const { respondToRuntimeRequest, pendingInteractionIds } = interactions;

  const selectSession = (sessionId: string) => {
    setPendingLinkedSourceId(null);
    setSelectedSessionId(sessionId);
    setActiveTab('chat');
  };

  const entries: SessionEntry[] = filteredSessions.map((session) => {
    const node = runtimeState.nodes.find((candidate) => candidate.sessionId === session.sessionId);
    const managedCluster = Object.values(runtimeState.clusters).find((cluster) => cluster.nodeIds.includes(session.sessionId));
    const recovery = sessionRecoveryState({
      session,
      diagnostics: runtimeDiagnostics,
      frozen: node?.frozen === true || managedCluster?.frozen === true,
    });
    const { openRequests, openInputs } = firstOpenRequests(session);
    // Failed/killed sessions are terminal, not actionable — they get a rose or
    // amber dot in Recent (their recovery notice still shows in the chat pane).
    // Only recovery states beyond plain failure (invalid cwd, frozen, recovered
    // runtime) pin a session to the attention tier.
    const actionableRecovery = recovery && session.status !== 'failed' && session.status !== 'killed' ? recovery : undefined;
    const tier: SessionTier =
      openRequests.length > 0 || openInputs.length > 0 || actionableRecovery
        ? 'attention'
        : session.status === 'running' || session.status === 'pending'
          ? 'running'
          : 'recent';
    return { session, recovery: actionableRecovery, openRequests, openInputs, tier };
  });

  const attentionEntries = entries.filter((entry) => entry.tier === 'attention');
  const runningEntries = entries.filter((entry) => entry.tier === 'running');
  const recentEntries = entries.filter((entry) => entry.tier === 'recent');

  const renderArchiveButton = (session: AgentSession, extraCls?: string) => {
    const canArchive = session.status !== 'running' && session.status !== 'pending';
    const archivePending = archivingSessionIds[session.sessionId] === true;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'shrink-0 rounded-md p-1 text-term-dim2 opacity-0 transition hover:bg-foreground/[0.07] hover:text-term-name focus-visible:opacity-100 disabled:cursor-not-allowed',
              extraCls,
            )}
            disabled={!isRuntimeAvailable || archivePending || !canArchive}
            aria-label={session.archived ? 'Restore chat' : 'Hide chat'}
            onClick={(event) => {
              event.stopPropagation();
              void setSessionArchived(session.sessionId, !session.archived);
            }}
          >
            {session.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{session.archived ? 'Restore chat' : 'Hide chat'}</TooltipContent>
      </Tooltip>
    );
  };

  const renderAttentionCard = (entry: SessionEntry) => {
    const { session, recovery, openRequests, openInputs } = entry;
    const request = openRequests[0];
    const input = openInputs[0];
    const isSel = selectedSessionId === session.sessionId;
    const requestPending = request ? pendingInteractionIds[request.id] === true : false;
    const extraCount = openRequests.length + openInputs.length - 1;

    const toneBorder = !request && input ? 'border-term-cyan/40 hover:border-term-cyan/60' : 'border-term-amber/40 hover:border-term-amber/60';
    const toneBg = !request && input ? 'bg-term-cyan/[0.06]' : 'bg-term-amber/[0.06]';

    return (
      <div
        key={session.sessionId}
        role="button"
        tabIndex={0}
        className={cn(
          'group/chat cursor-pointer rounded-lg border p-2.5 font-mono transition',
          toneBorder,
          toneBg,
          isSel && 'ring-1 ring-term-accent-hi/40',
          session.archived && 'opacity-60',
        )}
        onClick={() => selectSession(session.sessionId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSession(session.sessionId);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-1.5 shrink-0 rounded-full', !request && input ? 'bg-term-cyan' : 'bg-term-amber')} />
          <span
            className={cn('min-w-0 flex-1 truncate text-[12.5px] font-medium', isSel ? 'text-term-accent-hi' : 'text-term-name')}
            title={sessionDisplayLabel(session)}
          >
            {sessionDisplayLabel(session)}
          </span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-term-dim2">{compactTime(request?.createdAt ?? input?.createdAt ?? session.updatedAt)}</span>
          {renderArchiveButton(session, 'group-hover/chat:opacity-100 -my-1 -mr-1')}
        </div>

        {request || input ? (
          <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-4">
            {request ? (
              <>
                <span className="shrink-0 font-medium text-term-amber">Approve:</span>
                <span className="min-w-0 flex-1 truncate text-term-dim" title={request.title}>
                  {request.title}
                </span>
              </>
            ) : input ? (
              <>
                <span className="shrink-0 font-medium text-term-cyan">Asked:</span>
                <span className="min-w-0 flex-1 truncate text-term-dim" title={input.prompt}>
                  {firstContentLine(input.prompt) ?? input.prompt}
                </span>
              </>
            ) : null}
            {extraCount > 0 ? <span className="shrink-0 text-[10px] text-term-faint">+{extraCount} more</span> : null}
          </div>
        ) : null}

        {request ? (
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              className="text-[11px] text-term-amber transition hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!isRuntimeAvailable || requestPending}
              onClick={(event) => {
                event.stopPropagation();
                void respondToRuntimeRequest(request, 'accept');
              }}
            >
              ✓ Approve
            </button>
          </div>
        ) : input ? (
          <div className="mt-1 flex justify-end">
            <span className="text-[11px] text-term-cyan">Answer →</span>
          </div>
        ) : null}

        {recovery ? (
          <div className="mt-2">
            <RecoveryNotice state={recovery} compact />
          </div>
        ) : null}
      </div>
    );
  };

  const renderRunningCard = (entry: SessionEntry) => {
    const { session } = entry;
    const isSel = selectedSessionId === session.sessionId;
    const isPendingStart = session.status === 'pending';
    return (
      <div
        key={session.sessionId}
        role="button"
        tabIndex={0}
        className={cn(
          'group/chat cursor-pointer rounded-lg border border-ink-line bg-ink p-2.5 font-mono transition hover:border-foreground/20',
          isSel && 'border-term-accent-hi/50 ring-1 ring-term-accent-hi/25',
        )}
        onClick={() => selectSession(session.sessionId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSession(session.sessionId);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-1.5 shrink-0 animate-pulse rounded-full', isPendingStart ? 'bg-term-amber' : 'bg-term-green')} />
          <span
            className={cn('min-w-0 flex-1 truncate text-[12.5px] font-medium', isSel ? 'text-term-accent-hi' : 'text-term-name')}
            title={sessionDisplayLabel(session)}
          >
            {sessionDisplayLabel(session)}
          </span>
          {session.role === 'master' ? <span className="shrink-0 text-[9px] uppercase tracking-[0.1em] text-term-amber">master</span> : null}
          <span className="shrink-0 text-[10.5px] tabular-nums text-term-dim2" title={`Started ${formatTimestamp(session.startedAt ?? session.createdAt)}`}>
            {compactTime(session.startedAt ?? session.updatedAt)}
          </span>
        </div>
        <div className="mt-1.5 truncate text-[11px] leading-4 text-term-dim">
          {isPendingStart ? 'Starting…' : (firstContentLine(lastMessagePreview(session)) ?? '…')}
        </div>
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-foreground/[0.06]">
          <div
            className={cn(
              'h-full w-2/3 animate-pulse rounded-full bg-gradient-to-r to-transparent',
              isPendingStart ? 'from-term-amber/60' : 'from-term-green/60',
            )}
          />
        </div>
      </div>
    );
  };

  const renderRecentRow = (entry: SessionEntry) => {
    const { session } = entry;
    const isSel = selectedSessionId === session.sessionId;
    return (
      <div
        key={session.sessionId}
        role="button"
        tabIndex={0}
        className={cn(
          'group/chat flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] font-mono transition',
          isSel ? 'bg-term-accent-hi/10 ring-1 ring-inset ring-term-accent-hi/25' : 'hover:bg-foreground/[0.045]',
          session.archived && 'opacity-60',
        )}
        onClick={() => selectSession(session.sessionId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectSession(session.sessionId);
          }
        }}
      >
        {session.role === 'master' ? (
          <span className="w-1.5 shrink-0 text-center text-[7px] leading-none text-term-amber">◆</span>
        ) : (
          <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClassNames[session.status])} />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-[12px]', isSel ? 'text-term-accent-hi' : 'text-term-dim')} title={sessionDisplayLabel(session)}>
          {sessionDisplayLabel(session)}
        </span>
        {session.archived ? <span className="shrink-0 text-[9px] uppercase tracking-[0.1em] text-term-faint">hidden</span> : null}
        <span
          className="shrink-0 text-[10.5px] tabular-nums text-term-dim2 group-hover/chat:hidden"
          title={`Created ${formatTimestamp(session.createdAt)} · updated ${formatTimestamp(session.updatedAt)}`}
        >
          {compactTime(session.updatedAt)}
        </span>
        {renderArchiveButton(session, '-my-1 -mr-1 hidden group-hover/chat:block group-hover/chat:opacity-100')}
      </div>
    );
  };

  return (
    <aside
      className="orrery-sidebar flex h-dvh min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
      style={{ width: railSidebarWidth }}
    >
      <header className={cn('app-region-drag flex shrink-0 items-center justify-between gap-3 px-4 py-3', isElectron && 'pt-9')}>
        <div className="flex min-w-0 items-center gap-2.5">
          <OrreryMark />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight">looperators</h1>
            <p className="truncate font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">Agent workspace</p>
          </div>
        </div>
        <Badge
          variant={isRuntimeAvailable || demoMode ? 'outline' : 'destructive'}
          className="shrink-0"
          title={runtimeClient.kind === 'http' ? runtimeClient.runtimeUrl : undefined}
        >
          {runtimeModeLabel}
        </Badge>
      </header>
      <div className="app-region-no-drag grid shrink-0 gap-1.5 px-3 pb-2">
        <Button className="h-9 w-full justify-center font-mono text-[12px] uppercase tracking-[0.08em]" onClick={startNewChat}>
          <MessageSquarePlus className="size-4" />
          New Chat
        </Button>
        <Button className="h-9 w-full justify-center font-mono text-[12px] uppercase tracking-[0.08em]" variant="outline" onClick={onStartWorkflow}>
          <Workflow className="size-4" />
          New Workflow
        </Button>
      </div>
      <div className="app-region-no-drag shrink-0 px-3 pb-3 pt-1">
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-background/60 p-1">
          {railTabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const TabIcon = tab.icon;
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
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <TabIcon className="size-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="app-region-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-4 pb-2.5 pt-3 font-mono">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-term-accent-hi">❯</span>
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
                title={showArchivedSessions ? 'Showing hidden chats — click to hide them again' : 'Show hidden (archived) chats'}
                className={cn(
                  'shrink-0 rounded-lg border px-2.5 py-2 text-[10.5px] uppercase tracking-[0.08em] transition',
                  showArchivedSessions
                    ? 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan'
                    : 'border-ink-line bg-ink text-term-dim hover:border-foreground/20',
                )}
                onClick={() => setShowArchivedSessions((current) => !current)}
              >
                {showArchivedSessions ? 'All' : `Hidden ${archivedSessionCount}`}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {sessions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ink-line bg-ink p-5 text-center font-mono text-sm text-term-dim2">No chats yet.</div>
            ) : null}

            {sessions.length > 0 && filteredSessions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ink-line bg-ink p-5 text-center font-mono text-sm text-term-dim2">
                No chats match the current search.
              </div>
            ) : null}

            {attentionEntries.length > 0 ? (
              <>
                <SectionHeader label="Need attention" count={attentionEntries.length} toneCls="text-term-amber" />
                <div className="space-y-1.5">{attentionEntries.map(renderAttentionCard)}</div>
              </>
            ) : null}

            {runningEntries.length > 0 ? (
              <>
                <SectionHeader label="Working" count={runningEntries.length} toneCls="text-term-green" />
                <div className="space-y-1.5">{runningEntries.map(renderRunningCard)}</div>
              </>
            ) : null}

            {recentEntries.length > 0 ? (
              <>
                <SectionHeader label="Recent" toneCls="text-term-dim2" />
                <div className="space-y-px">{recentEntries.map(renderRecentRow)}</div>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <footer className="app-region-no-drag flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 font-mono text-[11px] tracking-[0.02em] text-muted-foreground">
        <span className="flex items-center gap-1.5" title="Running chats">
          <span className={cn('size-1.5 rounded-full', runningSessions.length ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          <span className="tabular-nums text-foreground/80">{runningSessions.length}</span>
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
  );
}
