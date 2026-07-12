import { useState } from 'react';
import { MessagesSquare, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import type { PlanCouncil } from '@shared/plan-council';
import { planCouncilProductView } from '@shared/plan-council';

export function PlanCouncilCard({
  council,
  runtimeApi,
  onStateChange,
  onError,
  onOpen,
}: {
  council: PlanCouncil;
  runtimeApi: RuntimeApi | undefined;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onOpen: () => void;
}) {
  const [pending, setPending] = useState<string>();
  const view = planCouncilProductView(council);
  const act = async (kind: 'cross-review' | 'synthesis' | 'stop') => {
    if (!runtimeApi || pending) return;
    setPending(kind);
    try {
      const result =
        kind === 'cross-review'
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

  return (
    <section className="m-3.5 rounded-xl border border-sky-500/30 bg-sky-500/[0.06] p-3 font-mono">
      <div className="flex items-center gap-2">
        <MessagesSquare className="size-4 text-sky-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold text-foreground">Plan Council</div>
          <div className="truncate text-[10px] text-muted-foreground">{council.objective}</div>
        </div>
        <span className="rounded-md border border-sky-500/25 px-1.5 py-0.5 text-[9.5px] uppercase text-sky-700 dark:text-sky-300">
          {council.phase.replaceAll('-', ' ')}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <span>{view.proposalsReady}/{view.plannerCount} plans</span>
        <span>·</span>
        <span>{view.reviewsReady}/{view.reviewerCount} reviews</span>
        <span>·</span>
        <span>{council.participantOrder.length} sessions</span>
        {view.waitingGate ? <><span>·</span><span>{view.waitingGate.phase} gate · {view.waitingGate.policy}</span></> : null}
      </div>
      {council.failure ? <p className="mt-2 text-[10.5px] text-rose-600 dark:text-rose-300">{council.failure}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={onOpen}>Open Council</Button>
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
        {view.canStop ? (
          <Button size="sm" variant="ghost" className="h-7 text-[10px]" disabled={Boolean(pending)} onClick={() => void act('stop')}>
            <Square className="size-3" /> Stop
          </Button>
        ) : null}
      </div>
    </section>
  );
}
