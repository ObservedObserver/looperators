import { MessageSquare } from 'lucide-react';
import type { CollaborationEvent, CollaborationMember } from '@shared/collaboration';
import { AgentMarkdown } from '@/components/agent-markdown';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export function CollaborationTimeline({
  events,
  members,
  onOpenThread,
  replyCounts = {},
  root = false,
}: {
  events: CollaborationEvent[];
  members: CollaborationMember[];
  onOpenThread?: (eventId: string) => void;
  replyCounts?: Record<string, number>;
  root?: boolean;
}) {
  return (
    <div className="space-y-1" aria-label={root ? 'Original message' : 'Shared messages'}>
      {events.map((event) => {
        const author =
          event.author === 'human'
            ? 'You'
            : event.author === 'runtime'
              ? 'Chat'
              : (members.find((member) => member.memberId === event.author)?.label ?? 'Agent');
        if (event.kind !== 'message')
          return (
            <div key={event.eventId} className="px-5 py-2 text-xs leading-5 text-muted-foreground">
              {event.kind === 'assessment' ? (
                <details>
                  <summary className="cursor-pointer">{author} shared an assessment</summary>
                  <p className="whitespace-pre-wrap pt-1">{event.content}</p>
                </details>
              ) : (
                <p className="whitespace-pre-wrap">{event.content}</p>
              )}
            </div>
          );
        return (
          <article key={event.eventId} id={`shared-message-${event.eventId}`} className={cn('group flex gap-3 px-5 py-4', root && 'bg-muted/20')}>
            <div
              className={cn(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                event.author === 'human' ? 'bg-muted' : 'bg-accent text-accent-ink',
              )}
            >
              {author.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold">{author}</span>
                <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()} className="text-xs text-muted-foreground">
                  {formatRelativeTime(event.createdAt)}
                </time>
              </div>
              {event.mentionedMemberIds.length ? (
                <div className="mb-1 flex flex-wrap gap-2 text-xs text-accent-ink">
                  {event.mentionedMemberIds.map((id) => (
                    <span key={id}>@{members.find((member) => member.memberId === id)?.label ?? 'Agent'}</span>
                  ))}
                </div>
              ) : null}
              <AgentMarkdown text={event.content} className="text-[15px] leading-7" />
              {onOpenThread ? (
                <button
                  type="button"
                  onClick={() => onOpenThread(event.eventId)}
                  className={cn(
                    'mt-2 inline-flex items-center gap-1.5 rounded px-1 py-1 text-xs transition hover:bg-accent focus-visible:ring-2',
                    replyCounts[event.eventId] ? 'text-accent-ink' : 'text-muted-foreground',
                  )}
                >
                  <MessageSquare className="size-3.5" />
                  {replyCounts[event.eventId] ? `${replyCounts[event.eventId]} ${replyCounts[event.eventId] === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
