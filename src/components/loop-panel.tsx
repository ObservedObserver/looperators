import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, FileDiff, RotateCw, Snowflake, Square, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatClock } from '@/lib/format';
import { kernelEventLabel, loopProductSessions } from '@/lib/graph-view';
import { sessionLabel } from '@/lib/session-display';
import type { GraphState, LoopHop, LoopLap, LoopTimelineResult, Report } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import { deriveLoopProductView, type LoopProductTone } from '@shared/loop-product';

const toneClasses: Record<LoopProductTone, string> = {
  active: 'border-lime-500/35 bg-lime-500/10 text-lime-800 dark:text-lime-200',
  waiting: 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  success: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  warning: 'border-orange-500/35 bg-orange-500/10 text-orange-800 dark:text-orange-200',
  danger: 'border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-200',
  neutral: 'border-border bg-muted/40 text-foreground',
};

export function LoopPanel({
  loopId,
  runtimeApi,
  runtimeState,
  latestKernelSeq,
  onClose,
  onStateChange,
  onOpenAgent,
  onOpenProviderSetup,
  onOpenDiff,
  onFreezeRing,
}: {
  loopId: string;
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  latestKernelSeq: number;
  onClose: () => void;
  onStateChange: (state: GraphState) => void;
  onOpenAgent: (sessionId: string) => void;
  onOpenProviderSetup: (sessionId: string) => void;
  onOpenDiff: (sessionId: string) => void;
  onFreezeRing: (memberSessionIds: string[]) => void;
}) {
  const [result, setResult] = useState<LoopTimelineResult>();
  const [error, setError] = useState<string>();
  const [isStopConfirming, setIsStopConfirming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  useEffect(() => {
    if (!runtimeApi) return;
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
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [loopId, runtimeApi, latestKernelSeq]);

  const loop = runtimeState.loops?.find((candidate) => candidate.loopId === loopId) ?? result?.loop;
  const timeline = result?.timeline;
  const product = useMemo(
    () =>
      loop
        ? deriveLoopProductView({
            loop,
            sessions: loopProductSessions(runtimeState),
            subscriptions: runtimeState.subscriptions,
            reports: runtimeState.reports,
            timeline,
          })
        : undefined,
    [loop, runtimeState, timeline],
  );
  const reportsById = useMemo(() => new Map(runtimeState.reports.map((report) => [report.id, report])), [runtimeState.reports]);
  const allFrozen = Boolean(loop && loop.memberSessionIds.every((sessionId) => runtimeState.nodes.find((node) => node.nodeId === sessionId)?.frozen));

  const stop = async () => {
    if (!runtimeApi || !loop || isStopping) return;
    setIsStopping(true);
    try {
      const stopped = await runtimeApi.stopLoop({
        loopId: loop.loopId,
        reason: 'Stopped by user from Loop panel.',
        killRunning: false,
      });
      onStateChange(stopped.state);
      setIsStopConfirming(false);
      setError(undefined);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <aside className="flex w-[390px] shrink-0 flex-col border-l border-border bg-background font-mono" aria-label="Loop details">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <RotateCw className={cn('size-4 text-accent-ink', product?.tone === 'active' && 'animate-spin [animation-duration:3s]')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-foreground">{product?.headline ?? 'Loading Loop…'}</div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {loop
              ? `${product?.lapLabel ?? loop.lapCount} laps · ${loop.memberSessionIds.map((sessionId) => sessionLabel(runtimeState, sessionId)).join(' ⇄ ')}`
              : loopId}
          </div>
        </div>
        {product?.canStop ? (
          <Button className="h-8 font-mono text-[10px] uppercase tracking-[0.05em]" variant="outline" size="sm" onClick={() => setIsStopConfirming(true)}>
            <Square className="size-3" />
            Stop loop
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="Close loop details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <p role="alert" className="mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        {isStopConfirming ? (
          <section
            aria-label="Confirm Stop loop"
            className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[10.5px] leading-4 text-amber-900 dark:text-amber-100"
          >
            <p className="font-semibold">Stop future handoffs?</p>
            <p className="mt-1">
              {loop?.subscriptionIds.length === 2 ? 'Both' : `All ${loop?.subscriptionIds.length ?? ''}`} Loop relationships stop together. Any Agent turn
              already running is not killed and may finish, but it cannot trigger another lap.
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" className="h-7 text-[10px]" disabled={isStopping} onClick={() => setIsStopConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" className="h-7 text-[10px]" disabled={isStopping} onClick={() => void stop()}>
                {isStopping ? 'Stopping…' : 'Stop future handoffs'}
              </Button>
            </div>
          </section>
        ) : null}

        {product ? (
          <section aria-live="polite" className={cn('rounded-xl border p-3', toneClasses[product.tone])} data-loop-phase={product.phase}>
            <div className="flex items-start gap-2">
              {product.tone === 'success' ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              ) : product.tone === 'danger' || product.tone === 'warning' ? (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              ) : (
                <RotateCw className="mt-0.5 size-4 shrink-0" />
              )}
              <div className="min-w-0">
                <h2 className="text-[12px] font-semibold">{product.headline}</h2>
                <p className="mt-1 text-[10.5px] leading-4 opacity-85">{product.detail}</p>
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-current/15 pt-2 text-[10px]">
              <div>
                <dt className="opacity-65">Lap</dt>
                <dd className="font-semibold tabular-nums">{product.lapLabel}</dd>
              </div>
              <div>
                <dt className="opacity-65">Now responsible</dt>
                <dd className="truncate font-semibold">{product.responsibleLabel ?? (product.canStop ? 'Workflow' : 'Complete')}</dd>
              </div>
              {product.lastVerdict ? (
                <div>
                  <dt className="opacity-65">Last verdict</dt>
                  <dd className="font-semibold">{product.lastVerdict}</dd>
                </div>
              ) : null}
              {product.stopReason ? (
                <div className="col-span-2">
                  <dt className="opacity-65">Why it stopped</dt>
                  <dd className="font-semibold">{product.stopReason}</dd>
                </div>
              ) : null}
            </dl>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {product.responsibleSessionId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 bg-background/70 text-[10px]"
                  onClick={() =>
                    product.recovery?.kind === 'open-provider-settings'
                      ? onOpenProviderSetup(product.responsibleSessionId!)
                      : onOpenAgent(product.responsibleSessionId!)
                  }
                >
                  <ExternalLink className="size-3" />
                  {product.recovery?.label ?? `Open ${product.responsibleLabel ?? 'Agent'}`}
                </Button>
              ) : null}
              {!product.canStop && product.coderSessionId ? (
                <Button size="sm" variant="outline" className="h-7 bg-background/70 text-[10px]" onClick={() => onOpenDiff(product.coderSessionId!)}>
                  <FileDiff className="size-3" />
                  Open final diff
                </Button>
              ) : null}
            </div>
            {product.recovery ? <p className="mt-2 border-t border-current/15 pt-2 text-[10px] leading-4 opacity-80">{product.recovery.guidance}</p> : null}
          </section>
        ) : null}

        {product?.blockingIssues.length ? (
          <section className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-2.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-rose-700 dark:text-rose-300">Latest blocking issues</h3>
            <IssueList issues={product.blockingIssues} />
          </section>
        ) : null}

        {result && (timeline?.laps.length ?? 0) === 0 ? <p className="mt-3 text-[11px] text-muted-foreground">No review lap has started yet.</p> : null}

        <ol className="mt-3 space-y-3">
          {[...(timeline?.laps ?? [])].reverse().map((lap) => (
            <LapCard key={lap.index} lap={lap} state={runtimeState} reportsById={reportsById} lapCap={loop?.lapCap} coderSessionId={product?.coderSessionId} />
          ))}
        </ol>

        {loop ? (
          <details className="mt-3 rounded-lg border border-border bg-muted/20 p-2.5 text-[10px] text-muted-foreground">
            <summary className="cursor-pointer font-semibold uppercase tracking-[0.08em] text-foreground/70">Diagnostics & advanced controls</summary>
            <dl className="mt-2 space-y-1 break-all">
              <div>loopId: {loop.loopId}</div>
              <div>
                raw status: {loop.status}
                {loop.statusDetail ? ` · ${loop.statusDetail}` : ''}
              </div>
              <div>subscriptions: {loop.subscriptionIds.join(', ')}</div>
              {(timeline?.laps ?? [])
                .flatMap((lap) => lap.hops)
                .map((hop) => (
                  <div key={hop.activatedEventId} className="border-t border-border/60 pt-1">
                    seq #{hop.activatedSeq} · activation {hop.activatedEventId}
                    {hop.causeId ? ` · cause ${hop.causeId}` : ''}
                    {hop.slotKey ? ` · slot ${hop.slotKey}` : ''}
                  </div>
                ))}
            </dl>
            <Button
              className="mt-2 h-7 font-mono text-[9.5px] uppercase"
              variant="outline"
              size="sm"
              disabled={allFrozen || !runtimeApi}
              onClick={() => onFreezeRing(loop.memberSessionIds)}
            >
              <Snowflake className="size-3" />
              {allFrozen ? 'Participants frozen' : 'Freeze participants'}
            </Button>
          </details>
        ) : null}
      </div>
    </aside>
  );
}

function IssueList({ issues }: { issues: Array<{ message: string; severity?: string; file?: string; line?: number }> }) {
  return (
    <ul className="mt-1.5 space-y-1.5 text-[10.5px] leading-4 text-foreground/85">
      {issues.map((issue, index) => (
        <li key={`${issue.file ?? ''}:${issue.line ?? ''}:${issue.message}:${index}`}>
          <span className="font-semibold text-rose-700 dark:text-rose-300">{issue.severity ?? 'issue'}</span>
          {' · '}
          {issue.message}
          {issue.file ? (
            <span className="block text-[9.5px] text-muted-foreground">
              {issue.file}
              {issue.line ? `:${issue.line}` : ''}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LapCard({
  lap,
  state,
  reportsById,
  lapCap,
  coderSessionId,
}: {
  lap: LoopLap;
  state: GraphState;
  reportsById: Map<string, Report>;
  lapCap?: number;
  coderSessionId?: string;
}) {
  const reportRefs = lap.hops.flatMap((hop) => hop.reports);
  const reports = reportRefs.map((ref) => (ref.reportId ? reportsById.get(ref.reportId) : undefined)).filter(Boolean) as Report[];
  const verdictReport = [...reports].reverse().find((report) => report.payload.type === 'verdict');
  const verdict = verdictReport?.payload.type === 'verdict' ? verdictReport.payload.verdict : reportRefs.at(-1)?.verdict;
  const issues = verdictReport?.payload.type === 'verdict' ? (verdictReport.payload.issues ?? []) : [];
  const coderFinished = lap.hops.some((hop) => hop.target === coderSessionId && hop.outcome?.type === 'finished');

  return (
    <li className="rounded-lg border border-border bg-card/60 p-2.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground/90">
        <span>Lap {lap.index}</span>
        {lapCap !== undefined ? <span className="text-muted-foreground">/ {lapCap}</span> : null}
        <span
          className={cn(
            'ml-auto',
            verdict === 'clean'
              ? 'text-emerald-600 dark:text-emerald-300'
              : verdict === 'issues'
                ? 'text-rose-600 dark:text-rose-300'
                : 'text-muted-foreground',
          )}
        >
          {verdict ? `verdict: ${verdict}` : coderFinished ? 'fix completed' : 'in progress'}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-term-faint">started {formatClock(lap.startTs)}</p>
      {issues.length ? <IssueList issues={issues} /> : null}
      {verdictReport?.payload.type === 'verdict' && verdictReport.payload.summary ? (
        <p className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground">{verdictReport.payload.summary}</p>
      ) : null}
      {coderFinished ? (
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">Coder completed a fix turn and handed the updated diff back for review.</p>
      ) : null}
      <details className="mt-2 border-t border-border/60 pt-1.5">
        <summary className="cursor-pointer text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">Activity details</summary>
        <ol className="mt-1.5 space-y-1.5">
          {lap.hops.map((hop) => (
            <HopRow key={hop.activatedEventId} hop={hop} state={state} />
          ))}
        </ol>
      </details>
    </li>
  );
}

function HopRow({ hop, state }: { hop: LoopHop; state: GraphState }) {
  const triggerText = hop.trigger?.type
    ? `${kernelEventLabel(hop.trigger.type)}${hop.trigger.sourceSessionId ? ` · ${sessionLabel(state, hop.trigger.sourceSessionId)}` : ''}`
    : 'trigger';
  return (
    <li className="rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-[10px] leading-4">
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
      {hop.reports.map((report, index) => (
        <p key={index} className="mt-0.5 text-muted-foreground">
          report{report.verdict ? ` ${report.verdict}` : ''}
          {report.summary ? ` — ${report.summary}` : ''}
        </p>
      ))}
    </li>
  );
}
