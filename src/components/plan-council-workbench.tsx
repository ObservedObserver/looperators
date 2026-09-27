import { useEffect, useMemo, useState } from 'react';
import { Network, Play, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentMarkdown } from '@/components/agent-markdown';
import type { GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import type { PlanCouncil, PlanCouncilArtifactKind } from '@shared/plan-council';
import { planCouncilProductView } from '@shared/plan-council';
import { usageTotals } from '@shared/resource-governance';
import { parseCouncilBrief, councilReadableContent } from '@shared/council-brief';
import { CouncilFollowUp } from '@/components/council-follow-up';

const tabs = ['Overview', 'Plans', 'Reviews', 'Synthesis', 'Participants', 'History', 'Diagnostics'] as const;
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
  onContinueDiscussion,
}: {
  council: PlanCouncil;
  runtimeState: GraphState;
  runtimeApi: RuntimeApi | undefined;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onOpenGraph: () => void;
  onOpenParticipant: (sessionId: string) => void;
  onContinueDiscussion?: (context: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [note, setNote] = useState('');
  const [participantId, setParticipantId] = useState<string>();
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const view = planCouncilProductView(council);
  const phaseBarriers = Object.values(council.barrierIds ?? {})
    .map((barrierId) => runtimeState.barriers?.[barrierId])
    .filter(Boolean);
  const participantIds = new Set(council.participantOrder);
  const councilUsage = usageTotals(
    (runtimeState.usageFacts ?? []).filter((fact) => fact.execution?.workflowId === council.workflowId || participantIds.has(fact.sessionId)),
  );
  const activeLeases = (runtimeState.workspaceLeases ?? []).filter((lease) => lease.status === 'active' && participantIds.has(lease.sessionId));
  const queuedRuns = (runtimeState.runQueue ?? []).filter((run) => participantIds.has(run.sessionId));
  const scopeIds = [
    ...new Set(council.participantOrder.map((sessionId) => runtimeState.nodes.find((node) => node.sessionId === sessionId)?.clusterId ?? 'global')),
  ];

  const act = async (kind: 'cross-review' | 'synthesis' | 'retry' | 'stop') => {
    if (!runtimeApi || pending) return;
    setPending(kind);
    try {
      const result =
        kind === 'retry'
          ? ((await runtimeApi.dispatchCommand({
              kind: 'retry_plan_council_participant',
              reason: 'The user retried a blocked participant under the current resource policy.',
              input: { workflowId: council.workflowId },
            })) as { state: GraphState })
          : kind === 'cross-review'
            ? ((await runtimeApi.dispatchCommand({ kind: 'start_plan_council_cross_review', input: { workflowId: council.workflowId, note } })) as {
                state: GraphState;
              })
            : kind === 'synthesis'
              ? ((await runtimeApi.dispatchCommand({ kind: 'start_plan_council_synthesis', input: { workflowId: council.workflowId, note } })) as {
                  state: GraphState;
                })
              : await runtimeApi.stopPlanCouncil({ workflowId: council.workflowId });
      onStateChange(result.state);
      setNote('');
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
      missing.map(
        async (artifact) =>
          [
            artifact.artifactId,
            (await runtimeApi.getPlanCouncilArtifact({ workflowId: council.workflowId, artifactId: artifact.artifactId })).content,
          ] as const,
      ),
    )
      .then((entries) => active && setContents((current) => ({ ...current, ...Object.fromEntries(entries) })))
      .catch((error: unknown) => active && setLoadError(error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, [contents, council.artifacts, council.workflowId, runtimeApi]);

  const artifactsByKind = useMemo(
    () =>
      council.artifacts
        .filter((artifact) => !council.supersededArtifactIds?.includes(artifact.artifactId))
        .reduce<Record<PlanCouncilArtifactKind, typeof council.artifacts>>(
          (result, artifact) => {
            result[artifact.kind].push(artifact);
            return result;
          },
          { proposal: [], 'peer-review': [], synthesis: [] },
        ),
    [council.artifacts, council.supersededArtifactIds],
  );
  const latestSynthesis = artifactsByKind.synthesis.at(-1);
  const synthesisText = latestSynthesis ? contents[latestSynthesis.artifactId] : undefined;
  const brief = synthesisText ? parseCouncilBrief(synthesisText) : undefined;
  const selectedParticipant = participantId ? council.participants[participantId] : undefined;
  const artifactCards = (kind: PlanCouncilArtifactKind) => (
    <div className={kind === 'proposal' ? 'grid gap-3 xl:grid-cols-2 2xl:grid-cols-3' : 'grid gap-3 lg:grid-cols-2'}>
      {artifactsByKind[kind].map((artifact) => {
        const participant = council.participants[artifact.authorSessionId];
        return (
          <article key={artifact.artifactId} className="min-w-0 rounded-xl border border-border bg-card p-3">
            <button
              type="button"
              className="mb-2 text-left text-xs text-sky-600 hover:underline dark:text-sky-300"
              onClick={() => setParticipantId(artifact.authorSessionId)}
            >
              {participant?.label ?? artifact.authorSessionId} · {participant?.providerKind}
            </button>
            {contents[artifact.artifactId] ? (
              <AgentMarkdown className="text-sm" text={councilReadableContent(contents[artifact.artifactId])} />
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
          <h2 className="truncate text-sm font-semibold">Compare plans</h2>
          <p className="truncate text-xs text-muted-foreground">{council.objective}</p>
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
            <Play className="size-3" /> Retry member
          </Button>
        ) : null}
        {view.canStop ? (
          <Button variant="ghost" size="sm" className="h-7 text-[10px]" disabled={Boolean(pending)} onClick={() => void act('stop')}>
            <Square className="size-3" /> Stop
          </Button>
        ) : null}
        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={onOpenGraph}>
          Open graph
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close Plan Council" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <nav aria-label="Comparison views" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {tabs.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-current={tab === candidate ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-xs ${tab === candidate ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'text-muted-foreground'}`}
            onClick={() => setTab(candidate)}
          >
            {candidate}
          </button>
        ))}
      </nav>
      <details className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {council.phase.replaceAll('-', ' ')} · {councilUsage.turns} turns · {councilUsage.tokens.toLocaleString()} tokens
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {view.waitingGate ? (
            <span>
              Waiting: {view.waitingGate.phase} · {view.waitingGate.policy} gate
            </span>
          ) : (
            <span>Phase: {council.phase}</span>
          )}
          <span>
            Policy: cross-review · {council.advancement?.crossReview ?? 'human'}; synthesis · {council.advancement?.synthesis ?? 'human'}
          </span>
          <span data-testid="plan-council-resource-summary">
            Usage: {councilUsage.turns} turns · {councilUsage.tokens.toLocaleString()} tokens · {councilUsage.toolCalls} tools ·{' '}
            {(councilUsage.durationMs / 1000).toFixed(1)}s
          </span>
          <span>
            Admission: {activeLeases.length} active · {queuedRuns.length} queued
          </span>
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
      </details>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loadError ? <p className="mb-3 text-[11px] text-rose-600">{loadError}</p> : null}
        {council.failure ? (
          <p className="mb-3 rounded-lg border border-amber-500/30 p-3 text-sm" role="status">
            {council.failure}
            {council.phase === 'blocked' ? ' Adjust the resource limit in Usage before retrying. Existing results are retained.' : ''}
          </p>
        ) : null}
        {view.canStartCrossReview || view.canStartSynthesis ? (
          <label className="mb-4 block space-y-2 rounded-xl border border-sky-500/25 bg-sky-500/5 p-4 text-sm font-medium">
            Add context before the next stage <span className="font-normal text-muted-foreground">Optional</span>
            <textarea
              className="min-h-20 w-full rounded-lg border border-border bg-background p-3 text-sm font-normal"
              value={note}
              maxLength={8000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="A constraint to apply, a claim to challenge, or a tradeoff to prioritize"
            />
            <span className="block text-xs font-normal text-muted-foreground">This update is recorded and sent when you start the next stage.</span>
          </label>
        ) : null}
        {tab === 'Overview' ? (
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2 text-sm" aria-label="Comparison progress">
              {[
                ['Independent proposals', `${view.proposalsReady}/${view.plannerCount}`],
                ['Peer reviews', `${view.reviewsReady}/${view.reviewerCount}`],
                ['Recommendation', synthesisText ? 'Ready' : 'Waiting'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-2 font-medium">{value}</p>
                </div>
              ))}
            </div>
            {council.reviewTopology === 'hub-and-spoke' ? (
              <p className="text-xs text-muted-foreground">One synthesis Agent reviews all proposals in this comparison.</p>
            ) : null}
            {brief ? (
              <>
                <section className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-4">
                  <h3 className="text-sm font-semibold">Recommendation</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{brief.summary}</p>
                </section>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Decisions and evidence</h3>
                  {brief.decisions.map((decision, index) => (
                    <article key={index} className="rounded-xl border border-border p-4">
                      <h4 className="text-sm font-medium">{decision.title}</h4>
                      <p className="mt-2 text-sm leading-6">{decision.reason}</p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">Source cited by the decision writer: {decision.evidence}</p>
                    </article>
                  ))}
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Open questions</h3>
                  {brief.openQuestions.length ? (
                    brief.openQuestions.map((question, index) => (
                      <article key={index} className="rounded-xl border border-amber-500/25 p-4">
                        <p className="text-sm font-medium">{question.question}</p>
                        <p className="mt-2 text-sm text-muted-foreground">{question.whyItMatters}</p>
                      </article>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">The decision writer reported no open questions. This does not certify unanimous agreement.</p>
                  )}
                </section>
              </>
            ) : synthesisText ? (
              <AgentMarkdown className="text-sm" text={synthesisText} />
            ) : (
              <section className="rounded-xl border border-border p-4">
                <h3 className="text-sm font-medium">{view.waitingGate ? 'Ready for your input' : 'Independent work is in progress'}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Read each proposal in Plans, then compare the reviews. The recommendation will appear here with its decisions and remaining questions.
                </p>
                <Button className="mt-3" variant="outline" size="sm" onClick={() => setTab('Plans')}>
                  Read proposals
                </Button>
              </section>
            )}
            {synthesisText ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(councilReadableContent(synthesisText)).catch((error) => onError(String(error)))}
                >
                  Copy recommendation
                </Button>
                {onContinueDiscussion ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      onContinueDiscussion(
                        `Planning task: ${council.objective}\n\nPublished recommendation from ${latestSynthesis?.artifactId}:\n${councilReadableContent(synthesisText)}`,
                      )
                    }
                  >
                    Discuss this recommendation
                  </Button>
                ) : null}
              </div>
            ) : null}
            <CouncilFollowUp council={council} runtimeState={runtimeState} runtimeApi={runtimeApi} onStateChange={onStateChange} onError={onError} />
          </div>
        ) : null}
        {tab === 'Plans' ? artifactCards('proposal') : null}
        {tab === 'Reviews' ? artifactCards('peer-review') : null}
        {tab === 'Synthesis' ? artifactCards('synthesis') : null}
        {tab === 'Participants' ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {council.participantOrder.map((sessionId) => {
              const participant = council.participants[sessionId];
              const session = runtimeState.sessions[sessionId];
              return (
                <button
                  key={sessionId}
                  type="button"
                  className="rounded-xl border border-border bg-card p-3 text-left"
                  onClick={() => setParticipantId(sessionId)}
                >
                  <span className="block text-[12px] font-medium">{participant.label}</span>
                  <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                    {participant.role} · {participant.providerKind} · {participant.runtimeSettings.model ?? 'default model'} · {session?.status ?? 'missing'}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {tab === 'History' ? (
          <ol className="space-y-2">
            {council.history.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border bg-card p-2.5 text-[11px]">
                <span className="font-mono text-[9.5px] text-muted-foreground">
                  {entry.ts} · {entry.phase}
                </span>
                <p className="mt-1">{entry.summary}</p>
              </li>
            ))}
            {council.interventions?.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-sky-500/25 p-3 text-sm">
                <p className="text-xs text-muted-foreground">User update · {entry.createdAt}</p>
                <p className="mt-2 whitespace-pre-wrap">{entry.text}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {tab === 'Diagnostics' ? (
          <pre className="overflow-x-auto rounded-xl bg-ink p-3 text-[10px] text-term-dim">{JSON.stringify(council, null, 2)}</pre>
        ) : null}
      </div>
      {selectedParticipant ? (
        <aside
          className="absolute inset-y-0 right-0 z-10 flex w-[min(90%,520px)] flex-col border-l border-border bg-background shadow-2xl"
          aria-label="Participant details"
        >
          <header className="flex items-center gap-2 border-b border-border p-3">
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{selectedParticipant.label}</h3>
            <Button size="sm" variant="outline" onClick={() => onOpenParticipant(selectedParticipant.sessionId)}>
              Open full chat
            </Button>
            <Button size="icon" variant="ghost" aria-label="Close participant details" onClick={() => setParticipantId(undefined)}>
              <X className="size-4" />
            </Button>
          </header>
          <p className="border-b border-border p-3 text-xs text-muted-foreground">
            Private Agent activity. Opening this view does not share it with other participants.
          </p>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {(runtimeState.sessions[selectedParticipant.sessionId]?.messages ?? [])
              .filter((message) => message.role === 'assistant' || message.role === 'user')
              .map((message) => (
                <article key={message.id} className="rounded-lg border border-border p-3">
                  <p className="mb-2 text-xs text-muted-foreground">{message.role}</p>
                  <AgentMarkdown className="text-sm" text={message.content ?? ''} />
                </article>
              ))}
          </div>
        </aside>
      ) : null}
    </section>
  );
}
