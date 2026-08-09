import { memo } from 'react';
import type { RuntimePlan } from '@/shared/provider-runtime';
import type { AgentMessage, AgentSession } from '@/shared/graph-state';
import { SessionTimeline } from '@/components/timeline';
import { useRuntimeSessionProjection } from '@/hooks/use-runtime-session-view';
import type { RuntimeStateStore } from '@shared/runtime-state-store';

type LiveSessionTimelineProps = {
  runtimeStateStore: RuntimeStateStore;
  sessionId: string | null | undefined;
  session?: AgentSession;
  agent?: string;
  canActOnPlan: boolean;
  onContinuePlan: (plan: RuntimePlan) => void;
  onRevisePlan: (plan: RuntimePlan) => void;
  onOpenTurnDiff: (turnId: string) => void;
  forkingMessageId?: string;
  canForkSession: boolean;
  onForkMessage: (message: AgentMessage) => void;
};

export const LiveSessionTimeline = memo(function LiveSessionTimeline({
  runtimeStateStore,
  sessionId,
  session,
  agent,
  canActOnPlan,
  onContinuePlan,
  onRevisePlan,
  onOpenTurnDiff,
  forkingMessageId,
  canForkSession,
  onForkMessage,
}: LiveSessionTimelineProps) {
  const projection = useRuntimeSessionProjection(runtimeStateStore, sessionId);
  const timeline = projection?.timeline ?? [];
  const latestForkableMessageId = projection?.messages.findLast(
    (message) => message.role === 'assistant' && message.status !== 'streaming' && message.status !== 'failed',
  )?.id;

  return (
    <>
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-ink-line-2 bg-ink px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-term-dim2">Timeline</span>
        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-term-faint">{timeline.length} entries</span>
      </div>
      {timeline.length ? (
        <SessionTimeline
          entries={timeline}
          activities={projection?.activities}
          agent={agent ?? 'claude-code'}
          canActOnPlan={canActOnPlan}
          onContinuePlan={onContinuePlan}
          onRevisePlan={onRevisePlan}
          onOpenTurnDiff={onOpenTurnDiff}
          providerKind={session?.providerKind}
          providerSessionReady={Boolean(session?.providerSessionId ?? session?.backendSessionId)}
          sourceSessionIdle={session?.status === 'idle'}
          managedWorktree={session?.project?.workMode === 'worktree'}
          latestForkableMessageId={latestForkableMessageId}
          sessionForkedAt={session?.forkedFrom?.createdAt}
          canForkSession={canForkSession}
          forkingMessageId={forkingMessageId}
          onForkMessage={onForkMessage}
        />
      ) : (
        <div className="m-3.5 rounded-lg border border-dashed border-ink-line p-5 text-center font-mono text-sm text-term-dim2">
          {sessionId ? 'No messages yet.' : 'New Chat'}
        </div>
      )}
    </>
  );
});
