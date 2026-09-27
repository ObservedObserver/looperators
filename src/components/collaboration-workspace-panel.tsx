import { useEffect, useRef, useState } from 'react';
import { Archive, GitCompareArrows, MessageSquare, MoreHorizontal, RotateCcw, ShieldCheck, Users } from 'lucide-react';
import type { CollaborationSession } from '@shared/collaboration';
import type { PlanCouncilAgentSpec } from '@shared/plan-council';
import type { GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import { Button } from '@/components/ui/button';
import { CollaborationComposer } from '@/components/collaboration-composer';
import { CollaborationTimeline } from '@/components/collaboration-timeline';
import { CollaborationMessageComposer } from '@/components/collaboration-message-composer';
import { CollaborationThreadPanel } from '@/components/collaboration-thread-panel';
import { PlanCouncilComposer } from '@/components/plan-council-composer';
import { threadReplyCounts, type CollaborationCommand } from '@/lib/collaboration-display';
import { cn } from '@/lib/utils';

type WorkspaceProps = {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  defaultCwd: string;
  workspaceId?: string;
  initialMessage?: string;
  onInitialMessageConsumed?: () => void;
  onSelectWorkspace: (id: string) => void;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onOpenMember: (sessionId: string) => void;
  onOpenCouncil: (councilId: string) => void;
};

export function CollaborationWorkspacePanel(props: WorkspaceProps) {
  const [busy, setBusy] = useState(false);
  const sendingRef = useRef(false);
  const workspace = props.workspaceId ? props.runtimeState.collaborationSessions?.[props.workspaceId] : undefined;
  const command: CollaborationCommand = async (kind, input) => {
    if (!props.runtimeApi || sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true);
    try {
      const nonce = crypto.randomUUID();
      const result = await props.runtimeApi.dispatchCommand({ kind, commandId: nonce, idempotencyKey: nonce, input });
      props.onStateChange((result.state as GraphState | undefined) ?? (await props.runtimeApi.getState()));
      return result;
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  };
  if (!workspace)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CollaborationComposer
          runtimeState={props.runtimeState}
          defaultCwd={props.defaultCwd}
          busy={busy || !props.runtimeApi}
          onCreate={async (input) => {
            const result = await command('create_collaboration_session', input);
            if (result?.sessionId) props.onSelectWorkspace(String(result.sessionId));
          }}
        />
      </div>
    );
  return <WorkspaceDetail key={workspace.sessionId} {...props} workspace={workspace} busy={busy || !props.runtimeApi} command={command} />;
}

function WorkspaceDetail({
  workspace,
  runtimeState,
  runtimeApi,
  initialMessage,
  onInitialMessageConsumed,
  busy,
  command,
  onOpenMember,
  onOpenCouncil,
  onStateChange,
  onError,
}: WorkspaceProps & { workspace: CollaborationSession; busy: boolean; command: CollaborationCommand }) {
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [legacyDiscussionId, setLegacyDiscussionId] = useState<string>();
  const [showMembers, setShowMembers] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCouncil, setShowCouncil] = useState(false);
  const [councilDirty, setCouncilDirty] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const roomScrollRef = useRef<HTMLDivElement>(null);
  const roomStickToBottom = useRef(true);
  const roomEvents = workspace.events.filter((event) => event.scope === 'room' && !event.threadId);
  const replyCounts = threadReplyCounts(workspace);
  const threadOpen = Boolean(selectedThreadId || legacyDiscussionId);
  const attentionCount = workspace.members.filter((member) => {
    const session = runtimeState.sessions[member.sessionId];
    return (
      member.attention ||
      session?.runtimeRequests?.some((request) => request.status === 'open') ||
      session?.runtimeUserInputRequests?.some((request) => request.status === 'open')
    );
  }).length;
  useEffect(() => {
    if (initialMessage) {
      setSelectedThreadId(undefined);
      setLegacyDiscussionId(undefined);
    }
  }, [initialMessage]);
  useEffect(() => {
    if (roomStickToBottom.current && roomScrollRef.current) roomScrollRef.current.scrollTop = roomScrollRef.current.scrollHeight;
  }, [roomEvents.length]);
  useEffect(() => {
    if (!showCouncil) return;
    const previous = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [showCouncil]);
  const openThread = (id: string) => {
    setSelectedThreadId(id);
    setLegacyDiscussionId(undefined);
  };
  const openDiscussion = (id: string) => {
    const discussion = workspace.discussions[id];
    if (!discussion) return;
    if (discussion.sourceThreadId) openThread(discussion.sourceThreadId);
    else {
      setLegacyDiscussionId(id);
      setSelectedThreadId(undefined);
    }
    setShowHistory(false);
  };
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };
  const councilAgents = workspace.members.flatMap((member): PlanCouncilAgentSpec[] => {
    const session = runtimeState.sessions[member.sessionId];
    return session
      ? [
          {
            key: member.memberId,
            label: member.label,
            instructions: member.role,
            providerKind: session.providerKind,
            providerInstanceId: session.providerInstanceId,
            runtimeSettings: { ...session.runtimeSettings, runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
          },
        ]
      : [];
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <header className="shrink-0 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{workspace.title}</h1>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {workspace.archived ? 'Archived · ' : ''}
              {workspace.members.map((member) => member.label).join(', ')}
            </p>
          </div>
          <Button variant="ghost" size="sm" aria-expanded={showMembers} onClick={() => setShowMembers((current) => !current)}>
            <Users className="size-4" />
            {workspace.members.length}
            {attentionCount ? <span className="text-destructive">· {attentionCount} need attention</span> : null}
          </Button>
          <details ref={menuRef} className="relative">
            <summary
              className="flex size-8 cursor-pointer list-none items-center justify-center rounded-lg hover:bg-accent focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
              aria-label="More chat options"
            >
              <MoreHorizontal className="size-4" />
            </summary>
            <div className="absolute right-0 top-10 z-30 w-56 space-y-1 rounded-xl border border-border bg-background p-2 shadow-xl">
              <Button
                className="w-full justify-start"
                variant="ghost"
                onClick={() => {
                  setShowHistory((current) => !current);
                  closeMenu();
                }}
              >
                Threads & discussion history
              </Button>
              <Button
                className="w-full justify-start"
                variant="ghost"
                disabled={busy || workspace.archived}
                onClick={() => {
                  setShowCouncil(true);
                  closeMenu();
                }}
              >
                <GitCompareArrows className="size-4" />
                Compare plans
              </Button>
              <Button
                className="w-full justify-start"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  closeMenu();
                  if (workspace.archived) void command('archive_collaboration_session', { sessionId: workspace.sessionId, archived: false });
                  else setConfirmArchive(true);
                }}
              >
                <Archive className="size-4" />
                {workspace.archived ? 'Restore chat' : 'Archive chat'}
              </Button>
            </div>
          </details>
        </div>
        {showMembers ? (
          <section className="mt-4 space-y-3 border-t border-border pt-3" aria-label="Chat members">
            {workspace.members.map((member) => {
              const session = runtimeState.sessions[member.sessionId];
              const input =
                session?.runtimeRequests?.some((request) => request.status === 'open') ||
                session?.runtimeUserInputRequests?.some((request) => request.status === 'open');
              const status = input
                ? 'Needs your input'
                : member.attention
                  ? 'Needs attention'
                  : ['running', 'pending'].includes(session?.status)
                    ? 'Working'
                    : 'Waiting';
              return (
                <div key={member.memberId} className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded text-sm font-medium hover:underline focus-visible:ring-2"
                    onClick={() => onOpenMember(member.sessionId)}
                  >
                    {member.label}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {session?.runtimeSettings?.model || 'Provider default'} · {status}
                  </span>
                  <Button className="ml-auto" variant="ghost" size="xs" onClick={() => onOpenMember(member.sessionId)}>
                    Private chat
                  </Button>
                  {member.attention || session?.status === 'failed' || session?.status === 'killed' ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy || workspace.archived}
                      onClick={() => void command('retry_collaboration_member', { sessionId: workspace.sessionId, memberId: member.memberId })}
                    >
                      <RotateCcw className="size-3" />
                      Retry
                    </Button>
                  ) : null}
                  {member.attention ? <p className="w-full break-words text-xs text-destructive">{member.attention}</p> : null}
                </div>
              );
            })}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              Read-only · Private chats and tool activity stay private
            </p>
            <p className="break-all text-xs text-muted-foreground">{workspace.cwd}</p>
          </section>
        ) : null}
        {confirmArchive ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-3 text-xs">
            <span className="flex-1">Archive this chat? Any ongoing discussion will pause.</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>
              Keep chat
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void command('archive_collaboration_session', { sessionId: workspace.sessionId, archived: true }).then((result) => {
                  if (result) setConfirmArchive(false);
                })
              }
            >
              Archive
            </Button>
          </div>
        ) : null}
      </header>
      {showHistory ? (
        <section className="max-h-64 shrink-0 space-y-1 overflow-y-auto border-b border-border bg-muted/10 p-3" aria-label="Chat history">
          <h2 className="px-2 py-1 text-xs font-semibold text-muted-foreground">Threads & discussions</h2>
          {roomEvents
            .filter((event) => event.kind === 'message' && replyCounts[event.eventId])
            .map((event) => (
              <button
                key={event.eventId}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  openThread(event.eventId);
                  setShowHistory(false);
                }}
              >
                <MessageSquare className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{event.content}</span>
                <span className="text-xs text-muted-foreground">{replyCounts[event.eventId]} replies</span>
              </button>
            ))}
          {Object.values(workspace.discussions).map((discussion) => (
            <button
              type="button"
              key={discussion.discussionId}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-accent"
              onClick={() => openDiscussion(discussion.discussionId)}
            >
              <span className="min-w-0 flex-1 truncate">{discussion.goal}</span>
              <span className="text-xs text-muted-foreground">{discussion.status}</span>
            </button>
          ))}
          {!Object.keys(replyCounts).length && !Object.keys(workspace.discussions).length ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Reply to a message to start a thread.</p>
          ) : null}
          {workspace.councilIds.length ? <h3 className="px-2 pb-1 pt-3 text-xs font-semibold text-muted-foreground">Plan comparisons</h3> : null}
          {workspace.councilIds.map((id) => (
            <button
              type="button"
              key={id}
              className="block w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-accent"
              onClick={() => onOpenCouncil(id)}
            >
              {runtimeState.planCouncils?.[id]?.objective ?? 'Plan comparison'}
            </button>
          ))}
        </section>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <section className={cn('min-w-0 flex-1 flex-col', threadOpen ? 'hidden xl:flex' : 'flex')} aria-label="Group chat">
          <div
            ref={roomScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              const node = event.currentTarget;
              roomStickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
            }}
          >
            <div className="mx-auto max-w-3xl py-4">
              {roomEvents.some((event) => event.kind === 'message') ? (
                <CollaborationTimeline events={roomEvents} members={workspace.members} replyCounts={replyCounts} onOpenThread={openThread} />
              ) : (
                <div className="px-6 py-14">
                  <MessageSquare className="mb-4 size-7 text-muted-foreground" />
                  <h2 className="text-xl font-semibold">Say hello to your Agents</h2>
                  <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                    Ask a question with @{workspace.members[0]?.label ?? 'Agent'}, or mention several Agents. Open a thread on any message to keep the replies
                    together.
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl">
            <CollaborationMessageComposer
              members={workspace.members}
              label="Message group"
              busy={busy}
              disabled={workspace.archived}
              initialText={initialMessage}
              onInitialTextConsumed={onInitialMessageConsumed}
              onSend={async (content, mentionedMemberIds) => {
                roomStickToBottom.current = true;
                return Boolean(await command('post_collaboration_message', { sessionId: workspace.sessionId, scope: 'room', content, mentionedMemberIds }));
              }}
            />
          </div>
        </section>
        {threadOpen ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col xl:w-[min(44%,600px)] xl:flex-none xl:border-l xl:border-border">
            <CollaborationThreadPanel
              key={selectedThreadId ?? legacyDiscussionId}
              workspace={workspace}
              threadId={selectedThreadId}
              legacyDiscussionId={legacyDiscussionId}
              runtimeState={runtimeState}
              busy={busy}
              command={command}
              onClose={() => {
                setSelectedThreadId(undefined);
                setLegacyDiscussionId(undefined);
              }}
              onOpenMember={onOpenMember}
              onOpenDiscussion={openDiscussion}
            />
          </div>
        ) : null}
      </div>
      {showCouncil ? (
        <div
          ref={dialogRef}
          className="absolute inset-0 z-40 flex flex-col overflow-hidden bg-background"
          role="dialog"
          aria-modal="true"
          aria-label="Compare plans"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !councilDirty) setShowCouncil(false);
            if (event.key === 'Tab') {
              const focusable = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
                ),
              ).filter((element) => element.getClientRects().length > 0);
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">Compare plans</h2>
            <Button
              variant="ghost"
              onClick={() => {
                if (!councilDirty || window.confirm('Discard the plan comparison setup?')) setShowCouncil(false);
              }}
            >
              Close
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <PlanCouncilComposer
              runtimeApi={runtimeApi}
              runtimeState={runtimeState}
              defaultCwd={workspace.cwd}
              initialPlanners={councilAgents.slice(0, 4)}
              initialSynthesizer={
                councilAgents[0]
                  ? {
                      ...councilAgents[0],
                      key: 'workspace-synthesizer',
                      label: 'Decision writer',
                      instructions: 'Reconcile the plans and preserve disagreements.',
                    }
                  : undefined
              }
              onStateChange={onStateChange}
              onError={onError}
              onDirtyChange={setCouncilDirty}
              onStarted={(result) => {
                void command('attach_collaboration_council', { sessionId: workspace.sessionId, workflowId: result.workflowId }).then((attached) => {
                  if (attached) {
                    setShowCouncil(false);
                    onOpenCouncil(result.workflowId);
                  }
                });
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
