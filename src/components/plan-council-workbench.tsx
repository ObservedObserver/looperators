import { useEffect, useMemo, useState } from 'react';
import { Network, Play, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentMarkdown } from '@/components/agent-markdown';
import type { GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import type { PlanCouncil, PlanCouncilArtifactKind } from '@shared/plan-council';
import { planCouncilProductView } from '@shared/plan-council';
import { usageTotals } from '@shared/resource-governance';

const tabs = ['Plans', 'Reviews', 'Synthesis', 'Participants', 'History', 'Diagnostics'] as const;
type Tab = (typeof tabs)[number];

export function PlanCouncilWorkbench({
  council,
  runtimeState,
  runtimeApi,
  onStateChange,
  onError,
  onClose,
  onOpenGraph,
  onOpenParticipant,
}: {
  council: PlanCouncil;
  runtimeState: GraphState;
  runtimeApi: RuntimeApi | undefined;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onOpenGraph: () => void;
  onOpenParticipant: (sessionId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('Plans');
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const view = planCouncilProductView(council);
  const phaseBarriers = Object.values(council.barrierIds ?? {})
    .map((barrierId) => runtimeState.barriers?.[barrierId])
    .filter(Boolean);
  const participantIds = new Set(council.participantOrder);
  const councilUsage = usageTotals((runtimeState.usageFacts ?? []).filter((fact) =>
    fact.execution?.workflowId === council.workflowId || participantIds.has(fact.sessionId),
  ));
  const activeLeases = (runtimeState.workspaceLeases ?? []).filter((lease) => lease.status === 'active' && participantIds.has(lease.sessionId));
  const queuedRuns = (runtimeState.runQueue ?? []).filter((run) => participantIds.has(run.sessionId));
  const scopeIds = [...new Set(council.participantOrder.map((sessionId) => runtimeState.nodes.find((node) => node.sessionId === sessionId)?.clusterId ?? 'global'))];

  const act = async (kind: 'cross-review' | 'synthesis' | 'retry' | 'stop') => {
    if (!runtimeApi || pending) return;
    setPending(kind);
    try {
      const result = kind === 'retry'
        ? await runtimeApi.dispatchCommand({
            kind: 'retry_plan_council_participant',
            reason: 'The human disabled consumption enforcement and retried the blocked Council participant.',
            input: { workflowId: council.workflowId, disableConsumptionBudget: true },
          }) as { state: GraphState }
        : kind === 'cross-review'
        ? await runtimeApi.startPlanCouncilCrossReview({ workflowId: council.workflowId })
        : kind === 'synthesis'
          ? await runtimeApi.startPlanCouncilSynthesis({ workflowId: council.workflowId })
          : await runtimeApi.stopPlanCouncil({ workflowId: council.workflowId });
      onStateChange(result.state);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(undefined);
    }
  };

  useEffect(() => {
    if (!runtimeApi) return;
    let active = true;
    const missing = council.artifacts.filter((artifact) => contents[artifact.artifactId] === undefined);
    if (!missing.length) return;
    Promise.all(
      missing.map(async (artifact) => [artifact.artifactId, (await runtimeApi.getPlanCouncilArtifact({ workflowId: council.workflowId, artifactId: artifact.artifactId })).content] as const),
    )
      .then((entries) => active && setContents((current) => ({ ...current, ...Object.fromEntries(entries) })))
      .catch((error: unknown) => active && setLoadError(error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, [contents, council.artifacts, council.workflowId, runtimeApi]);

  const artifactsByKind = useMemo(
    () =>
      council.artifacts.reduce<Record<PlanCouncilArtifactKind, typeof council.artifacts>>(
        (result, artifact) => {
          result[artifact.kind].push(artifact);
          return result;
        },
        { proposal: [], 'peer-review': [], synthesis: [] },
      ),
    [council.artifacts],
  );
  const artifactCards = (kind: PlanCouncilArtifactKind) => (
    <div className={kind === 'proposal' ? 'grid gap-3 xl:grid-cols-2 2xl:grid-cols-3' : 'grid gap-3 lg:grid-cols-2'}>
      {artifactsByKind[kind].map((artifact) => {
        const participant = council.participants[artifact.authorSessionId];
        return (
          <article key={artifact.artifactId} className="min-w-0 rounded-xl border border-border bg-card p-3">
            <button type="button" className="mb-2 text-left font-mono text-[10.5px] text-sky-600 hover:underline dark:text-sky-300" onClick={() => onOpenParticipant(artifact.authorSessionId)}>
              {participant?.label ?? artifact.authorSessionId} · {participant?.providerKind}
            </button>
            {contents[artifact.artifactId] ? (
              <AgentMarkdown className="text-[12px]" text={contents[artifact.artifactId]} />
            ) : (
              <p className="text-[11px] text-muted-foreground">Loading artifact…</p>
            )}
          </article>
        );
      })}
      {!artifactsByKind[kind].length ? <p className="text-[11px] text-muted-foreground">This phase has not produced artifacts yet.</p> : null}
    </div>
  );

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-border bg-background shadow-2xl">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Network className="size-4 text-sky-500" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[12px] uppercase tracking-[0.12em]">Plan Council Workbench</h2>
          <p className="truncate text-[10px] text-muted-foreground">{council.objective}</p>
        </div>
        {view.canStartCrossReview ? (
          <Button size="sm" className="h-7 text-[10px]" disabled={Boolean(pending)} onClick={() => void act('cross-review')}>
            <Play className="size-3" /> Start cross-review
          </Button>
        ) : null}
        {view.canStartSynthesis ? (
          <Button size="sm" className="h-7 text-[10px]" disabled={Boolean(pending)} onClick={() => void act('synthesis')}>
            <Play className="size-3" /> Synthesize final plan
          </Button>
        ) : null}
        {view.canRetryBlockedParticipant ? (
          <Button size="sm" className="h-7 text-[10px]" disabled={Boolean(pending)} onClick={() => void act('retry')}>
            <Play className="size-3" /> Disable scope budget & retry
          </Button>
        ) : null}
        {view.canStop ? (
          <Button variant="ghost" size="sm" className="h-7 text-[10px]" disabled={Boolean(pending)} onClick={() => void act('stop')}>
            <Square className="size-3" /> Stop
          </Button>
        ) : null}
        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={onOpenGraph}>Open graph</Button>
        <Button variant="ghost" size="icon" aria-label="Close Plan Council" onClick={onClose}><X className="size-4" /></Button>
      </header>
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {tabs.map((candidate) => (
          <button key={candidate} type="button" className={`rounded-md px-2 py-1 font-mono text-[10px] ${tab === candidate ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'text-muted-foreground'}`} onClick={() => setTab(candidate)}>
            {candidate}
          </button>
        ))}
      </nav>
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-border px-4 py-2 font-mono text-[9.5px] text-muted-foreground">
        {view.waitingGate ? <span>Waiting: {view.waitingGate.phase} · {view.waitingGate.policy} gate</span> : <span>Phase: {council.phase}</span>}
        <span>Policy: cross-review · {council.advancement?.crossReview ?? 'human'}; synthesis · {council.advancement?.synthesis ?? 'human'}</span>
        <span data-testid="plan-council-resource-summary">
          Usage: {councilUsage.turns} turns · {councilUsage.tokens.toLocaleString()} tokens · {councilUsage.toolCalls} tools · {(councilUsage.durationMs / 1000).toFixed(1)}s
        </span>
        <span>Admission: {activeLeases.length} active · {queuedRuns.length} queued</span>
        {scopeIds.map((scopeId) => {
          const policy = runtimeState.resourcePolicies?.[scopeId];
          return (
            <span key={scopeId}>
              Cap {scopeId}: {policy?.maxConcurrentSessions ?? 4} concurrent · consumption {policy?.consumptionEnforcement ?? 'off'}
              {policy?.maxTurns !== undefined ? ` · ${policy.maxTurns} turns` : ''}
              {policy?.maxTokens !== undefined ? ` · ${policy.maxTokens.toLocaleString()} tokens` : ''}
            </span>
          );
        })}
        {phaseBarriers.map((barrier) => (
          <span key={barrier!.barrierId} className="rounded border border-border px-1.5 py-0.5">
            {barrier!.phaseId} · {Object.keys(barrier!.arrivals).length}/{barrier!.expectedParticipantKeys.length} · {barrier!.status}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loadError ? <p className="mb-3 text-[11px] text-rose-600">{loadError}</p> : null}
        {tab === 'Plans' ? artifactCards('proposal') : null}
        {tab === 'Reviews' ? artifactCards('peer-review') : null}
        {tab === 'Synthesis' ? artifactCards('synthesis') : null}
        {tab === 'Participants' ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {council.participantOrder.map((sessionId) => {
              const participant = council.participants[sessionId];
              const session = runtimeState.sessions[sessionId];
              return (
                <button key={sessionId} type="button" className="rounded-xl border border-border bg-card p-3 text-left" onClick={() => onOpenParticipant(sessionId)}>
                  <span className="block text-[12px] font-medium">{participant.label}</span>
                  <span className="mt-1 block font-mono text-[10px] text-muted-foreground">{participant.role} · {participant.providerKind} · {participant.runtimeSettings.model ?? 'default model'} · {session?.status ?? 'missing'}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {tab === 'History' ? (
          <ol className="space-y-2">
            {council.history.map((entry) => <li key={entry.id} className="rounded-lg border border-border bg-card p-2.5 text-[11px]"><span className="font-mono text-[9.5px] text-muted-foreground">{entry.ts} · {entry.phase}</span><p className="mt-1">{entry.summary}</p></li>)}
          </ol>
        ) : null}
        {tab === 'Diagnostics' ? <pre className="overflow-x-auto rounded-xl bg-ink p-3 text-[10px] text-term-dim">{JSON.stringify(council, null, 2)}</pre> : null}
      </div>
    </section>
  );
}
