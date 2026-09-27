import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Pause, Play, RotateCcw } from 'lucide-react';
import type { CollaborationDiscussion, CollaborationSession } from '@shared/collaboration';
import type { GraphState } from '@/shared/graph-state';
import { Button } from '@/components/ui/button';
import { CollaborationTimeline } from '@/components/collaboration-timeline';
import { CollaborationMessageComposer } from '@/components/collaboration-message-composer';
import { collaborationFieldClass as fieldClass } from '@/components/collaboration-composer';
import { assessmentIsCurrent, threadEvents, type CollaborationCommand } from '@/lib/collaboration-display';

function ContinueTogetherForm({
  workspace,
  initialGoal,
  discussion,
  busy,
  onClose,
  onSave,
}: {
  workspace: CollaborationSession;
  initialGoal: string;
  discussion?: CollaborationDiscussion;
  busy: boolean;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [goal, setGoal] = useState(discussion?.goal ?? initialGoal);
  const [members, setMembers] = useState(discussion?.requiredMemberIds ?? workspace.members.map((member) => member.memberId));
  const [maxTurns, setMaxTurns] = useState(discussion?.maxTurns ?? 24);
  const [notes, setNotes] = useState(discussion?.acceptanceCriteria ?? '');
  return (
    <form
      className="space-y-4 border-b border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (goal.trim() && members.length >= 2 && Number.isInteger(maxTurns) && maxTurns >= 2 && maxTurns <= 1000 && !busy)
          void onSave({ goal: goal.trim(), requiredMemberIds: members, maxTurns, acceptanceCriteria: notes.trim() });
      }}
    >
      <label className="block space-y-2 text-sm font-medium">
        {discussion ? 'Update the goal' : 'What should the Agents work out together?'}
        <textarea
          autoFocus
          required
          className={fieldClass}
          rows={2}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="A question or goal for this thread"
        />
      </label>
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">Participants</legend>
        <div className="flex flex-wrap gap-2">
          {workspace.members.map((member) => (
            <label key={member.memberId} className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={members.includes(member.memberId)}
                onChange={(event) =>
                  setMembers((current) => (event.target.checked ? [...current, member.memberId] : current.filter((id) => id !== member.memberId)))
                }
              />
              {member.label}
            </label>
          ))}
        </div>
        {members.length < 2 ? <p className="mt-2 text-xs text-destructive">Choose at least two Agents.</p> : null}
      </fieldset>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Advanced options</summary>
        <div className="space-y-3 pt-3">
          <label className="block space-y-1 text-xs">
            Additional instructions
            <textarea className={fieldClass} rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <label className="flex items-center gap-3 text-xs">
            Agent turn limit
            <input
              className={`${fieldClass} w-24`}
              type="number"
              min={2}
              max={1000}
              required
              value={maxTurns}
              onChange={(event) => setMaxTurns(Number(event.target.value))}
            />
          </label>
          <p className="text-xs text-muted-foreground">Pauses when the limit is reached.</p>
        </div>
      </details>
      <p className="text-xs leading-5 text-muted-foreground">
        {discussion
          ? 'Changing the goal or participants asks everyone to assess again.'
          : 'They will read this thread and reply until everyone agrees, or the turn limit is reached.'}
      </p>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !goal.trim() || members.length < 2 || !Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 1000}>
          {discussion ? 'Save changes' : 'Start'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function CollaborationThreadPanel({
  workspace,
  threadId,
  legacyDiscussionId,
  runtimeState,
  busy,
  command,
  onClose,
  onOpenMember,
  onOpenDiscussion,
}: {
  workspace: CollaborationSession;
  threadId?: string;
  legacyDiscussionId?: string;
  runtimeState: GraphState;
  busy: boolean;
  command: CollaborationCommand;
  onClose: () => void;
  onOpenMember: (id: string) => void;
  onOpenDiscussion: (id: string) => void;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const stickToBottom = useRef(false);
  const root = threadId ? workspace.events.find((event) => event.eventId === threadId) : undefined;
  const related = Object.values(workspace.discussions).filter((discussion) =>
    threadId ? discussion.sourceThreadId === threadId : discussion.discussionId === legacyDiscussionId,
  );
  const discussion = related.find((item) => item.status === 'active' || item.status === 'paused');
  const latestDiscussion = discussion ?? related.at(-1);
  const otherActive = Object.values(workspace.discussions).find(
    (item) => ['active', 'paused'].includes(item.status) && item.discussionId !== discussion?.discussionId,
  );
  const events = threadId ? threadEvents(workspace, threadId) : workspace.events.filter((event) => event.discussionId === legacyDiscussionId);
  const members = discussion ? workspace.members.filter((member) => discussion.requiredMemberIds.includes(member.memberId)) : workspace.members;
  const agreed =
    discussion?.requiredMemberIds.filter(
      (id) => assessmentIsCurrent(discussion.assessments[id], discussion) && discussion.assessments[id]?.verdict === 'satisfied',
    ).length ?? 0;
  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events.length]);
  const update = async (action: string, input: Record<string, unknown> = {}) =>
    discussion
      ? command('update_collaboration_discussion', { sessionId: workspace.sessionId, discussionId: discussion.discussionId, action, ...input })
      : undefined;
  const detailsDiscussion = latestDiscussion;
  return (
    <section className="flex h-full min-h-0 flex-1 flex-col bg-background" aria-label="Thread">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Button ref={closeRef} variant="ghost" size="icon" aria-label="Back to group chat" onClick={onClose}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate font-semibold">{threadId ? 'Thread' : 'Discussion history'}</h2>
        {threadId && !discussion ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || workspace.archived || Boolean(otherActive)}
            onClick={() => {
              setEditing(false);
              setShowSetup((current) => !current);
            }}
          >
            Continue together
          </Button>
        ) : null}
      </header>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        }}
      >
        {root ? (
          <CollaborationTimeline events={[root]} members={workspace.members} root />
        ) : legacyDiscussionId && latestDiscussion ? (
          <div className="px-5 py-4 text-sm leading-6">{latestDiscussion.goal}</div>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">This message is no longer available.</p>
        )}
        {discussion ? (
          <div className="flex flex-wrap items-center gap-2 border-y border-border bg-muted/15 px-4 py-2 text-xs">
            <span className="min-w-0 flex-1">
              {discussion.status === 'paused' ? 'Paused' : 'Continuing together'} · {agreed}/{discussion.requiredMemberIds.length} agree
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || workspace.archived}
              onClick={() => void update(discussion.status === 'paused' ? 'resume' : 'pause')}
            >
              {discussion.status === 'paused' ? <Play className="size-3" /> : <Pause className="size-3" />}
              {discussion.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
          </div>
        ) : latestDiscussion ? (
          <p className="flex items-center gap-2 px-5 py-2 text-xs text-muted-foreground">
            {latestDiscussion.status === 'completed' ? <Check className="size-3.5" /> : null}
            {latestDiscussion.status === 'completed'
              ? 'Everyone agreed. You can keep chatting in this thread.'
              : 'The discussion was cancelled. Its messages remain here.'}
          </p>
        ) : null}
        {otherActive && !discussion ? (
          <p className="px-5 py-2 text-xs leading-5 text-muted-foreground">
            Agents are already continuing another discussion.{' '}
            <button className="rounded text-accent-ink underline focus-visible:ring-2" onClick={() => onOpenDiscussion(otherActive.discussionId)}>
              Open it
            </button>{' '}
            to finish or stop it before starting another.
          </p>
        ) : null}
        {showSetup ? (
          <ContinueTogetherForm
            key={editing ? discussion?.discussionId : 'new'}
            workspace={workspace}
            initialGoal={root?.content ?? ''}
            discussion={editing ? discussion : undefined}
            busy={busy}
            onClose={() => setShowSetup(false)}
            onSave={async (input) => {
              const result = editing
                ? await update('revise', input)
                : await command('start_collaboration_discussion', { sessionId: workspace.sessionId, sourceThreadId: threadId, ...input });
              if (result) {
                setShowSetup(false);
                stickToBottom.current = false;
              }
              return Boolean(result);
            }}
          />
        ) : null}
        {detailsDiscussion ? (
          <details className="border-b border-border px-5 py-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Goal & Agent updates{discussion?.health === 'degraded' ? ' · Needs attention' : ''}
            </summary>
            <div className="space-y-4 pt-3">
              <p className="whitespace-pre-wrap text-sm leading-6">{detailsDiscussion.goal}</p>
              {detailsDiscussion.acceptanceCriteria ? (
                <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{detailsDiscussion.acceptanceCriteria}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {detailsDiscussion.turnsUsed}/{detailsDiscussion.maxTurns} turns used · Goal revision {detailsDiscussion.goalRevision}
              </p>
              {detailsDiscussion.pauseReason ? <p className="text-xs text-amber-700 dark:text-amber-400">{detailsDiscussion.pauseReason}</p> : null}
              {detailsDiscussion.requiredMemberIds.map((id) => {
                const member = workspace.members.find((item) => item.memberId === id);
                if (!member) return null;
                const assessment = detailsDiscussion.assessments[id];
                const current = assessmentIsCurrent(assessment, detailsDiscussion);
                const session = runtimeState.sessions[member.sessionId];
                const working = ['pending', 'running'].includes(session?.status);
                const needsInput =
                  session?.runtimeRequests?.some((request) => request.status === 'open') ||
                  session?.runtimeUserInputRequests?.some((request) => request.status === 'open');
                return (
                  <div key={id} className="space-y-1 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="rounded font-medium hover:underline focus-visible:ring-2" onClick={() => onOpenMember(member.sessionId)}>
                        {member.label}
                      </button>
                      <span className="text-muted-foreground">
                        {working ? 'Working' : needsInput ? 'Needs your input' : member.attention ? 'Needs attention' : 'Waiting'}
                      </span>
                      {member.attention || session?.status === 'failed' || session?.status === 'killed' ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy || workspace.archived || !discussion}
                          onClick={() =>
                            void command('retry_collaboration_member', { sessionId: workspace.sessionId, memberId: id, ...(threadId ? { threadId } : {}) })
                          }
                        >
                          <RotateCcw className="size-3" />
                          Retry
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">
                      {!assessment
                        ? 'Has not assessed yet.'
                        : !current
                          ? 'Previous assessment needs updating.'
                          : assessment.verdict === 'satisfied'
                            ? 'Agrees.'
                            : assessment.verdict === 'blocked'
                              ? 'Blocked.'
                              : 'Not yet satisfied.'}{' '}
                      {assessment?.reason}
                    </p>
                    {member.attention ? <p className="text-destructive">{member.attention}</p> : null}
                  </div>
                );
              })}
              {Object.values(detailsDiscussion.issues)
                .filter((issue) => issue.status === 'open')
                .map((issue) => (
                  <p key={issue.issueId} className="text-xs leading-5">
                    Unresolved: {issue.summary}
                  </p>
                ))}
              {discussion ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || workspace.archived}
                    onClick={() => {
                      setEditing(true);
                      setShowSetup(true);
                    }}
                  >
                    Edit goal & participants
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy || workspace.archived} onClick={() => setCancelConfirm(true)}>
                    Stop discussion
                  </Button>
                </div>
              ) : null}
              {cancelConfirm ? (
                <div role="alert" className="space-y-2 text-xs">
                  <p>Stop this discussion? Its history stays in this thread.</p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void update('cancel').then((result) => {
                          if (result) setCancelConfirm(false);
                        })
                      }
                    >
                      Stop
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setCancelConfirm(false)}>
                      Keep going
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
        {events.length ? (
          <>
            <div className="px-5 pb-1 pt-4 text-xs text-muted-foreground">{events.filter((event) => event.kind === 'message').length} replies</div>
            <CollaborationTimeline events={events} members={workspace.members} />
          </>
        ) : (
          <p className="px-5 py-8 text-sm text-muted-foreground">Reply here to keep this conversation together. Use @ to ask an Agent to join.</p>
        )}
      </div>
      {(threadId && root) || discussion ? (
        <CollaborationMessageComposer
          members={members}
          label="Reply in thread"
          busy={busy}
          disabled={workspace.archived}
          hint={discussion ? `To all ${members.length} participants${discussion.status === 'paused' ? ' · Delivered when resumed' : ''}` : undefined}
          onSend={async (content, mentionedMemberIds) => {
            stickToBottom.current = true;
            const result = await command('post_collaboration_message', {
              sessionId: workspace.sessionId,
              scope: discussion ? 'discussion' : 'room',
              ...(discussion ? { discussionId: discussion.discussionId } : { threadId }),
              content,
              mentionedMemberIds,
            });
            if (result) stickToBottom.current = true;
            return Boolean(result);
          }}
        />
      ) : (
        <p className="border-t border-border p-4 text-xs text-muted-foreground">This discussion is closed. Return to the group chat to continue.</p>
      )}
    </section>
  );
}
