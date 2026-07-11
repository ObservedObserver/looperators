import { Link2, OctagonX, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { GraphEdgeData } from '@/lib/graph-view';
import type { GraphState, Subscription } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';

function sourceLabel(state: GraphState, subscription: Subscription) {
  if (subscription.source.kind === 'session') return state.sessions[subscription.source.sessionId]?.label ?? subscription.source.sessionId;
  if (subscription.source.kind === 'cluster') return state.clusters[subscription.source.clusterId]?.label ?? subscription.source.clusterId;
  if (subscription.source.kind === 'external') return state.sources?.[subscription.source.sourceId]?.label ?? subscription.source.sourceId;
  return 'Clock';
}

function patternText(subscription: Subscription) {
  const on = subscription.on.on;
  if (on === 'report' && subscription.on.match) {
    return `report ${Object.values(subscription.on.match).join(' · ')}`;
  }
  if (on === 'external') return `external.${subscription.on.topic ?? 'event'}`;
  return on;
}

export function RelationshipInspectorPanel({
  data,
  runtimeState,
  runtimeApi,
  onClose,
  onStateChange,
  onError,
}: {
  data: GraphEdgeData;
  runtimeState: GraphState;
  runtimeApi: RuntimeApi | undefined;
  onClose: () => void;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
}) {
  const subscription = data.subscriptionId ? runtimeState.subscriptions?.[data.subscriptionId] : undefined;
  const history = data.edgeId ? runtimeState.edges.find((edge) => edge.edgeId === data.edgeId) : undefined;

  const stop = async () => {
    if (!runtimeApi || !subscription || subscription.state !== 'active') return;
    try {
      const result = await runtimeApi.stopSubscription({
        subscriptionId: subscription.id,
        reason: 'Stopped by the user from the Relationship inspector.',
      });
      onStateChange(result.state);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <aside className="absolute right-3 top-3 z-35 flex max-h-[calc(100%-1.5rem)] w-[340px] flex-col overflow-hidden rounded-xl border border-border bg-background/97 shadow-xl backdrop-blur">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Link2 className="size-3.5 text-accent-ink" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em]">Relationship</h2>
          <p className="truncate text-[10px] text-muted-foreground">{subscription?.label ?? history?.label ?? data.label}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close Relationship inspector" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[11px]">
        {subscription ? (
          <>
            <div className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-2 rounded-lg border border-border bg-card p-2.5">
              <span className="text-muted-foreground">From</span>
              <span>{sourceLabel(runtimeState, subscription)}</span>
              <span className="text-muted-foreground">When</span>
              <span>{patternText(subscription)}</span>
              <span className="text-muted-foreground">Then</span>
              <span>
                {subscription.action.kind.replaceAll('-', ' ')} → {runtimeState.sessions[subscription.target.sessionId]?.label ?? subscription.target.sessionId}
              </span>
              <span className="text-muted-foreground">Delivery</span>
              <span>{subscription.action.topic ?? 'none'}</span>
              <span className="text-muted-foreground">Gate</span>
              <span>
                {subscription.gate} · {subscription.concurrency}
              </span>
              <span className="text-muted-foreground">State</span>
              <span>
                {subscription.state} · {subscription.firings}
                {subscription.stop?.maxFirings ? `/${subscription.stop.maxFirings}` : ''} firings
              </span>
              <span className="text-muted-foreground">Stop when</span>
              <span>
                {subscription.stop?.whenReport?.verdict ? `report is ${subscription.stop.whenReport.verdict}` : ''}
                {subscription.stop?.whenReport?.verdict && subscription.stop?.maxFirings ? ' or ' : ''}
                {subscription.stop?.maxFirings ? `${subscription.stop.maxFirings} firings` : 'manually stopped'}
              </span>
            </div>
            {subscription.action.note ? (
              <div className="rounded-lg border border-border bg-muted/35 p-2.5">
                <div className="mb-1 text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Instruction</div>
                <p className="whitespace-pre-wrap leading-5">{subscription.action.note}</p>
              </div>
            ) : null}
            <Button className="w-full" variant="destructive" disabled={!runtimeApi || subscription.state !== 'active'} onClick={() => void stop()}>
              <OctagonX className="size-3.5" />
              {subscription.state === 'active' ? 'Stop automation' : 'Automation stopped'}
            </Button>
          </>
        ) : history ? (
          <>
            <div className="rounded-lg border border-border bg-card p-2.5 leading-5">
              <div>
                {runtimeState.sessions[history.source]?.label ?? history.source} → {runtimeState.sessions[history.target]?.label ?? history.target}
              </div>
              <div className="text-muted-foreground">
                {history.kind.replaceAll('-', ' ')} · {new Date(history.ts).toLocaleString()}
              </div>
            </div>
            {data.summary ? <p className="rounded-lg border border-border bg-muted/35 p-2.5 leading-5">{data.summary}</p> : null}
            <p className="text-[10.5px] leading-4 text-muted-foreground">
              This edge is a historical fact. It records something that already happened, so it cannot be stopped or edited.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">This Relationship is no longer present in the current graph state.</p>
        )}
      </div>
    </aside>
  );
}
