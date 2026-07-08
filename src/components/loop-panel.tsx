import { useEffect, useState } from 'react';
import { RotateCw, Snowflake, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatClock } from '@/lib/format';
import { kernelEventLabel, loopBadgeLabel } from '@/lib/graph-view';
import { sessionLabel } from '@/lib/session-display';
import type { GraphState, LoopHop, LoopTimelineResult } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

// The per-lap loop timeline (L4): read a whole night of revolutions in one
// panel — who triggered each lap, who let it through the gate and why, and
// what report came out — without opening any session's chat history.
export function LoopPanel({
  loopId,
  runtimeApi,
  runtimeState,
  latestKernelSeq,
  onClose,
  onFreezeRing,
}: {
  loopId: string;
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  latestKernelSeq: number;
  onClose: () => void;
  onFreezeRing: (memberSessionIds: string[]) => void;
}) {
  const [result, setResult] = useState<LoopTimelineResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!runtimeApi) {
      return;
    }
    let cancelled = false;
    runtimeApi
      .getLoopTimeline({ loopId })
      .then((next) => {
        if (!cancelled) {
          setResult(next);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loopId, runtimeApi, latestKernelSeq]);

  const loop = result?.loop;
  const laps = result?.timeline.laps ?? [];
  const allFrozen = Boolean(loop && loop.memberSessionIds.every((sessionId) => runtimeState.nodes.find((node) => node.nodeId === sessionId)?.frozen));

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-background font-mono">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <RotateCw className="size-4 text-accent-ink" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-foreground">Loop {loop ? loopBadgeLabel(loop) : '…'}</div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {loop ? loop.memberSessionIds.map((sessionId) => sessionLabel(runtimeState, sessionId)).join(' ⇄ ') : loopId}
          </div>
        </div>
        <Button
          className="h-8 font-mono text-[10.5px] uppercase tracking-[0.06em]"
          variant="outline"
          size="sm"
          disabled={!loop || allFrozen || !runtimeApi}
          onClick={() => loop && onFreezeRing(loop.memberSessionIds)}
        >
          <Snowflake className="size-3.5" />
          {allFrozen ? 'frozen' : 'freeze ring'}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close loop timeline" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <p className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">{error}</p> : null}

        {loop?.stopSummary || loop?.statusDetail ? (
          <p className="mb-3 text-[10.5px] text-muted-foreground">{[loop.statusDetail, loop.stopSummary].filter(Boolean).join(' · ')}</p>
        ) : null}

        {result && laps.length === 0 ? <p className="text-[11px] text-muted-foreground">No laps yet — the ring has not fired.</p> : null}

        <ol className="space-y-3">
          {[...laps].reverse().map((lap) => (
            <li key={lap.index} className="rounded-lg border border-border bg-card/60 p-2.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground/90">
                <span>Lap {lap.index}</span>
                {loop?.lapCap !== undefined ? <span className="text-muted-foreground">/ {loop.lapCap}</span> : null}
                <span className="ml-auto tabular-nums text-[10px] text-term-faint">{formatClock(lap.startTs)}</span>
              </div>
              <ol className="mt-1.5 space-y-2">
                {lap.hops.map((hop) => (
                  <HopRow key={hop.activatedEventId} hop={hop} state={runtimeState} />
                ))}
              </ol>
            </li>
          ))}
        </ol>

        {result && (result.timeline.refusals.length > 0 || result.timeline.stops.length > 0) ? (
          <div className="mt-3 space-y-1.5 border-t border-border/70 pt-2.5">
            {result.timeline.stops.map((stop, index) => (
              <p key={`stop-${index}`} className="text-[10.5px] text-muted-foreground">
                <span className="text-rose-700 dark:text-rose-300">{stop.type === 'subscription.guarded' ? 'guarded' : 'stopped'}</span>
                {' · '}
                {formatClock(stop.ts)}
                {stop.reason ? ` — ${stop.reason}` : ''}
              </p>
            ))}
            {result.timeline.refusals.map((refusal, index) => (
              <p key={`refusal-${index}`} className="text-[10.5px] text-muted-foreground">
                <span className="text-term-amber">{refusal.type}</span>
                {' · '}
                {formatClock(refusal.ts)}
                {refusal.reason ? ` — ${refusal.reason}` : ''}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function actorLabel(state: GraphState, actor: { kind: string; ref?: string }) {
  if ((actor.kind === 'master' || actor.kind === 'agent') && actor.ref) {
    return sessionLabel(state, actor.ref);
  }
  return actor.kind;
}

function HopRow({ hop, state }: { hop: LoopHop; state: GraphState }) {
  const triggerText = hop.trigger?.type
    ? `${kernelEventLabel(hop.trigger.type)}${hop.trigger.sourceSessionId ? ` · ${sessionLabel(state, hop.trigger.sourceSessionId)}` : ''}`
    : 'trigger';
  return (
    <li className="rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-[10.5px] leading-4">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{triggerText}</span>
        <span className="text-term-faint">→</span>
        <span className="font-medium text-foreground/90">{sessionLabel(state, hop.target)}</span>
        <span
          className={cn(
            'ml-auto',
            hop.outcome?.type === 'failed' ? 'text-rose-700 dark:text-rose-300' : hop.outcome ? 'text-lime-700 dark:text-lime-300' : 'text-term-amber',
          )}
        >
          {hop.outcome?.type ?? 'running'}
        </span>
      </div>
      {hop.gate ? (
        <p className="mt-0.5 text-muted-foreground">
          gate: {actorLabel(state, hop.gate.actor)}
          {hop.gate.reason ? ` — ${hop.gate.reason}` : ''}
        </p>
      ) : null}
      {hop.reports.map((report, index) => (
        <p key={index} className="mt-0.5 text-muted-foreground">
          report{report.verdict ? ` ${report.verdict}` : ''}
          {report.from ? ` · ${sessionLabel(state, report.from)}` : ''}
          {report.summary ? ` — ${report.summary}` : ''}
        </p>
      ))}
    </li>
  );
}
