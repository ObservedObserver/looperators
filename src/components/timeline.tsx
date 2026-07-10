import { memo, useMemo } from 'react';
import { Check, ClipboardCheck, FileText, Image as ImageIcon, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AgentMarkdown } from '@/components/agent-markdown';
import { ToolRunFeed } from '@/components/tool-run-feed';
import { toolTurnsFromRuntimeActivities, type ToolTurn } from '@/shared/tool-feed';
import { type AgentMessage } from '@/shared/graph-state';
import { type ChatAttachment, type RuntimeActivity, type RuntimePlan, type SessionTimelineEntry, type TurnDiffSummary } from '@/shared/provider-runtime';
import { formatFileSize, formatClock, formatClockSeconds } from '@/lib/format';
import { termActionBtnCls } from '@/components/terminal';
import { requestKindLabels } from '@/components/runtime-interaction-panel';

export function assistantLabel(agent?: string) {
  const value = agent?.toLowerCase() ?? '';
  if (value.includes('codex')) return 'codex';
  if (value.includes('claude')) return 'claude';
  return 'assistant';
}

export function MessageAttachmentStrip({ attachments }: { attachments?: ChatAttachment[] }) {
  if (!attachments?.length) {
    return null;
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
              <img className="size-full object-cover" src={attachment.dataUrl} alt="" />
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
  );
}

type ChatMessageProps = { message: AgentMessage; agent?: string };

function sameMessageAttachments(left: AgentMessage, right: AgentMessage) {
  const leftAttachments = left.attachments ?? [];
  const rightAttachments = right.attachments ?? [];
  return leftAttachments.length === rightAttachments.length && leftAttachments.every((attachment, index) => attachment.id === rightAttachments[index]?.id);
}

export const ChatMessage = memo(
  function ChatMessage({ message, agent }: ChatMessageProps) {
    const isUser = message.role === 'user';
    const isStreaming = message.status === 'streaming';
    const hasText = message.content.trim().length > 0;
    const senderLabel = assistantLabel(agent);
    const isCommentary = message.phase === 'commentary';

    return (
      <div
        className={cn('border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0', isCommentary ? 'bg-ink-soft/25 text-term-dim' : undefined)}
        data-message-phase={message.phase}
      >
        <div className="mb-1.5 flex items-center gap-2">
          {isUser ? (
            <span className="text-[11px] text-term-faint">you</span>
          ) : (
            <>
              <span className="size-1.5 rounded-full bg-term-green shadow-[0_0_8px_var(--term-green)]" />
              <span className={cn('text-[11px]', isCommentary ? 'text-term-dim2' : 'text-term-emerald')}>{senderLabel}</span>
            </>
          )}
          {isStreaming ? <span className="text-[10px] text-term-amber">streaming</span> : null}
          <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">{formatClockSeconds(message.ts)}</span>
        </div>
        {isUser ? (
          <>
            <div className="flex gap-2 text-[13px] leading-6">
              <span className="shrink-0 text-lime-hi">❯</span>
              <span className="whitespace-pre-wrap break-words text-term-name">{message.content}</span>
            </div>
            <MessageAttachmentStrip attachments={message.attachments} />
          </>
        ) : (
          <>
            {hasText || isStreaming ? (
              <div className={cn('text-[13px] leading-6', isCommentary ? 'text-term-dim' : 'text-term-name')}>
                <AgentMarkdown text={message.content} streaming={isStreaming} />
                {isStreaming ? <span className="orrery-caret ml-1" /> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  },
  (previous, next) => {
    const left = previous.message;
    const right = next.message;
    return (
      previous.agent === next.agent &&
      left.id === right.id &&
      left.content === right.content &&
      left.status === right.status &&
      left.phase === right.phase &&
      left.ts === right.ts &&
      sameMessageAttachments(left, right)
    );
  },
);

export function TurnBoundaryRow({ entry }: { entry: Extract<SessionTimelineEntry, { kind: 'turn' }> }) {
  return (
    <div className="border-t border-ink-line-2 px-4 py-2 font-mono first:border-t-0">
      <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em] text-term-faint">
        <span className="h-px flex-1 bg-ink-line" />
        <span>{entry.status === 'started' ? 'Turn started' : 'Turn completed'}</span>
        <span className="text-term-dim2">{formatClock(entry.ts)}</span>
        <span className="h-px flex-1 bg-ink-line" />
      </div>
    </div>
  );
}

export function ActivityTimelineRow({ activity }: { activity: RuntimeActivity }) {
  const hasDetails =
    Boolean(activity.output && activity.output.trim().length > 0) ||
    Boolean(activity.error && activity.error.trim().length > 0) ||
    Boolean(activity.sublines?.length);
  const statusMarker =
    activity.status === 'failed'
      ? { char: '✗', cls: 'text-term-rose' }
      : activity.status === 'completed'
        ? { char: '●', cls: 'text-term-green' }
        : { char: '◌', cls: 'text-term-amber animate-pulse' };
  const command = activity.command ?? activity.title;

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5">
        <span className={cn('text-center text-[11px] leading-6', statusMarker.cls)}>{statusMarker.char}</span>
        <span className="min-w-0 text-[12px] leading-6">
          <span className="font-medium text-lime">{command}</span>
          {activity.args ? <span className="ml-2 break-words text-term-dim">{activity.args}</span> : null}
          <span className="ml-2 text-[11px] text-term-dim2">{activity.kind}</span>
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
              <div key={`${line.key ?? index}:${line.value.slice(0, 20)}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-4">
                <span className="truncate text-term-dim2">{line.key ?? 'output'}</span>
                <span className="truncate text-term-dim">{line.value}</span>
              </div>
            ))}
            {activity.output ? (
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-term-dim">{activity.output}</pre>
            ) : null}
            {activity.error ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-term-rose">{activity.error}</pre>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function ToolRunTimelineRow({ turn, agent }: { turn: ToolTurn; agent?: string }) {
  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <ToolRunFeed turn={turn} agent={agent} />
    </div>
  );
}

export function PlanTimelineRow({
  plan,
  onContinue,
  onRevise,
  canAct,
}: {
  plan: RuntimePlan;
  onContinue: (plan: RuntimePlan) => void;
  onRevise: (plan: RuntimePlan) => void;
  canAct: boolean;
}) {
  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <ClipboardCheck className="size-3.5 shrink-0 text-term-cyan" />
        <span className="text-[10px] uppercase tracking-[0.14em] text-term-cyan">plan</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-term-name">{plan.title ?? 'Proposed plan'}</span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-term-faint">{formatClock(plan.updatedAt)}</span>
      </div>
      {plan.items.length ? (
        <ol className="mt-2 grid gap-1">
          {plan.items.map((item, index) => (
            <li key={item.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5 text-[11.5px] leading-5">
              <span className="text-term-faint">{index === plan.items.length - 1 ? '└' : '├'}</span>
              <span className="min-w-0 break-words text-term-dim">{item.title}</span>
              <span className="text-[10px] uppercase tracking-[0.08em] text-term-dim2">{item.status.replace('_', ' ')}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-2 border-l border-dashed border-ink-line pl-3 text-[11.5px] text-term-dim2">No plan items were provided.</div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2 pl-[26px]">
        <Button className={cn(termActionBtnCls, 'h-8 justify-center text-[11px] tracking-[0.08em]')} disabled={!canAct} onClick={() => onContinue(plan)}>
          <Check className="size-3.5" />
          Continue
        </Button>
        <Button
          className={cn(termActionBtnCls, 'h-8 justify-center text-[11px] tracking-[0.08em]')}
          variant="outline"
          disabled={!canAct}
          onClick={() => onRevise(plan)}
        >
          <RefreshCw className="size-3.5" />
          Revise
        </Button>
      </div>
    </div>
  );
}

export function RequestTimelineRow({
  entry,
}: {
  entry: Extract<SessionTimelineEntry, { kind: 'request' }> | Extract<SessionTimelineEntry, { kind: 'user-input' }>;
}) {
  const isUserInput = entry.kind === 'user-input';
  const title = isUserInput ? 'Input requested' : entry.request.title;
  const body = isUserInput ? entry.request.prompt : entry.request.body;
  const status = entry.request.status;

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-term-amber" />
        <span className="text-[10px] uppercase tracking-[0.14em] text-term-amber">{isUserInput ? 'input' : requestKindLabels[entry.request.kind]}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-term-name">{title}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-term-amber">{status}</span>
      </div>
      {body ? (
        <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words border-l border-ink-line pl-3 text-[11.5px] leading-5 text-term-dim">
          {body}
        </p>
      ) : null}
      <div className="mt-1 pl-[26px] text-[10.5px] uppercase tracking-[0.08em] text-term-faint">{formatClock(entry.ts)}</div>
    </div>
  );
}

export function TurnDiffTimelineRow({ diff, onOpen }: { diff: TurnDiffSummary; onOpen: (turnId: string) => void }) {
  const hasChanges = diff.totals.files > 0;
  const diffTone = diff.error ? 'text-term-amber' : 'text-term-green';

  return (
    <div className="border-t border-ink-line-2 px-4 py-2.5 font-mono first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <FileText className={cn('size-3.5 shrink-0', diffTone)} />
        <span className={cn('text-[10px] uppercase tracking-[0.14em]', diffTone)}>diff</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-term-name">Turn changed files</span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-term-faint">{formatClock(diff.generatedAt)}</span>
      </div>
      {diff.error ? (
        <p className="mt-2 whitespace-pre-wrap break-words border-l border-ink-line pl-3 text-[11.5px] leading-5 text-term-amber">{diff.error}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-3 pl-[26px] text-[10.5px] uppercase tracking-[0.08em]">
            <span className="text-term-dim">{diff.totals.files} files</span>
            <span className="text-term-green">+{diff.totals.additions}</span>
            <span className="text-term-rose">-{diff.totals.deletions}</span>
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
                  <span className="text-term-faint">{index === Math.min(diff.files.length, 6) - 1 ? '└' : '├'}</span>
                  <span className="min-w-0 truncate text-term-name">{file.path}</span>
                  <span className="tabular-nums text-term-green">+{file.additions}</span>
                  <span className="tabular-nums text-term-rose">-{file.deletions}</span>
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
            <div className="mt-2 border-l border-dashed border-ink-line pl-3 text-[11.5px] text-term-dim2">No file changes in this turn.</div>
          )}
          <Button
            className={cn(termActionBtnCls, 'mt-2 h-8 w-full justify-center text-[11px] tracking-[0.08em]')}
            variant="outline"
            onClick={() => onOpen(diff.turnId)}
          >
            <FileText className="size-3.5" />
            Open patch
          </Button>
        </>
      )}
    </div>
  );
}

export function SessionTimeline({
  entries,
  agent,
  canActOnPlan,
  onContinuePlan,
  onRevisePlan,
  onOpenTurnDiff,
}: {
  entries: SessionTimelineEntry[];
  agent?: string;
  canActOnPlan: boolean;
  onContinuePlan: (plan: RuntimePlan) => void;
  onRevisePlan: (plan: RuntimePlan) => void;
  onOpenTurnDiff: (turnId: string) => void;
}) {
  const toolTurnsByTurnId = useMemo(() => {
    const activities = entries.flatMap((entry) => (entry.kind === 'activity' ? [entry.activity] : []));
    return toolTurnsFromRuntimeActivities(activities);
  }, [entries]);
  const renderedToolTurnIds = new Set<string>();

  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'turn') {
          return <TurnBoundaryRow key={entry.id} entry={entry} />;
        }
        if (entry.kind === 'message') {
          return <ChatMessage key={entry.id} message={entry.message} agent={agent} />;
        }
        if (entry.kind === 'activity') {
          const turnId = entry.activity.turnId;
          const turn = turnId ? toolTurnsByTurnId.get(turnId) : undefined;
          if (turnId && turn?.toolRuns.length) {
            if (renderedToolTurnIds.has(turnId)) {
              return null;
            }
            renderedToolTurnIds.add(turnId);
            return <ToolRunTimelineRow key={`tool-run:${turnId}`} turn={turn} agent={agent} />;
          }
          return <ActivityTimelineRow key={entry.id} activity={entry.activity} />;
        }
        if (entry.kind === 'plan') {
          return <PlanTimelineRow key={entry.id} plan={entry.plan} canAct={canActOnPlan} onContinue={onContinuePlan} onRevise={onRevisePlan} />;
        }
        if (entry.kind === 'request' || entry.kind === 'user-input') {
          return <RequestTimelineRow key={entry.id} entry={entry} />;
        }
        return <TurnDiffTimelineRow key={entry.id} diff={entry.diff} onOpen={onOpenTurnDiff} />;
      })}
    </>
  );
}
