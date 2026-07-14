import { useState } from 'react';
import { Check, ChevronDown, GitCompareArrows, Lock, LockOpen, Play, RotateCcw, ShieldCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { RuntimeApi } from '@/runtime-client';
import type { GraphState } from '@/shared/graph-state';
import { cn } from '@/lib/utils';
import { workflowExecutionStatus, type WorkflowProposal } from '@shared/workflow-authoring';

const statusStyle: Record<WorkflowProposal['status'], string> = {
  proposed: 'border-term-amber/35 bg-term-amber/10 text-term-amber',
  approved: 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan',
  committed: 'border-term-accent-hi/35 bg-term-accent/10 text-term-accent-hi',
  rejected: 'border-destructive/35 bg-destructive/10 text-destructive',
  expired: 'border-ink-line bg-muted text-term-dim',
};

const executionStatusStyle = {
  running: 'border-term-accent-hi/35 bg-term-accent/10 text-term-accent-hi',
  completed: 'border-term-cyan/35 bg-term-cyan/10 text-term-cyan',
  failed: 'border-destructive/35 bg-destructive/10 text-destructive',
  stopped: 'border-ink-line bg-muted text-term-dim',
} as const;

export function WorkflowProposalCard({
  proposal,
  runtimeState,
  runtimeApi,
  onStateChange,
  onError,
  onOpenLive,
}: {
  proposal: WorkflowProposal;
  runtimeState: GraphState;
  runtimeApi?: RuntimeApi;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onOpenLive?: (workflowId: string) => void;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const plan = proposal.proposedPlan;
  const mapping = plan.executionMapping;
  const liveWorkflowId = mapping?.productWorkflowId;
  const executionStatus = workflowExecutionStatus(proposal, runtimeState);
  const visibleStatus = executionStatus ?? proposal.status;
  const visibleStatusStyle = executionStatus
    ? executionStatusStyle[executionStatus]
    : statusStyle[proposal.status];
  const patch = proposal.patch;

  const command = async (kind: string, input: Record<string, unknown>, reason: string) => {
    if (!runtimeApi || isBusy) return;
    setIsBusy(true);
    try {
      const nonce = globalThis.crypto.randomUUID();
      const result = await runtimeApi.dispatchCommand({
        commandId: `${kind}-${nonce}`,
        idempotencyKey: `${kind}-${proposal.proposalId}-${nonce}`,
        kind,
        reason,
        input,
      });
      onStateChange(result.state as GraphState);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const toggleLock = (kind: 'participant' | 'relationship', key: string, locked: boolean) =>
    command(
      'lock_workflow_item',
      { proposalId: proposal.proposalId, kind, key, locked: !locked },
      `${locked ? 'Unlock' : 'Lock'} ${kind} ${key} from the Master proposal card.`,
    );

  const diffGroups = [
    ['participants added', proposal.graphDiff.participants.add],
    ['participants changed', proposal.graphDiff.participants.update],
    ['participants removed', proposal.graphDiff.participants.remove],
    ['relationships added', proposal.graphDiff.relationships.add],
    ['relationships changed', proposal.graphDiff.relationships.update],
    ['relationships removed', proposal.graphDiff.relationships.remove],
  ] as const;
  const diffCount = diffGroups.reduce((sum, [, entries]) => sum + entries.length, 0);

  return (
    <section className="m-3.5 space-y-3 rounded-xl border border-ink-line bg-card/70 p-3.5 font-mono shadow-sm" data-testid={`workflow-proposal-${proposal.proposalId}`}>
      <header className="flex min-w-0 items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-term-accent-hi/25 bg-term-accent/[0.06] text-term-accent-hi">
          <GitCompareArrows className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] uppercase tracking-[0.13em] text-foreground">Workflow {patch ? 'patch' : 'proposal'}</h3>
            <span className={cn('rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em]', visibleStatusStyle)}>
              {visibleStatus}
            </span>
            <span className="text-[9.5px] text-term-faint">v{plan.version} · {plan.recipe}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-5 text-foreground/85">{plan.objective}</p>
          {plan.reason ? <p className="mt-1 text-[10px] leading-4 text-term-dim">Master reason · {plan.reason}</p> : null}
        </div>
      </header>

      {patch ? (
        <div className="rounded-lg border border-term-cyan/25 bg-term-cyan/[0.055] p-2.5 text-[10px] leading-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-term-cyan">
            <span>Incremental patch · base v{patch.baseVersion}</span>
            <span className="text-term-faint">{patch.operations.map((operation) => operation.op).join(' · ')}</span>
          </div>
          <p className="mt-1 text-foreground/80">{patch.reason}</p>
          <div className="mt-1.5 grid gap-1 text-term-dim @[40rem]:grid-cols-2">
            <span>
              Impact · +{patch.impact.addedParticipantKeys.length} participant · replace {patch.impact.replacedParticipantKeys.length} · stop {patch.impact.stoppedRelationshipKeys.length} edge
            </span>
            <span className="flex items-start gap-1">
              <RotateCcw className="mt-0.5 size-3 shrink-0" />
              Rollback · restore v{patch.rollback.baseVersion}; stop {patch.rollback.stopCreatedSessionKeys.length} created session
            </span>
          </div>
          {patch.wakeupIds.length > 0 ? (
            <p className="mt-1 break-words text-term-faint">Handles wakeup · {patch.wakeupIds.join(', ')}</p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2 @[40rem]:grid-cols-2">
        <div className="rounded-lg border border-ink-line-2 bg-ink/55 p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-term-dim2">Participants</div>
          <div className="space-y-1.5">
            {plan.participants.map((participant) => (
              <div key={participant.key} className="flex min-w-0 items-center gap-2 text-[10.5px]">
                <span className="min-w-0 flex-1 truncate text-foreground">{participant.label}</span>
                <span className="shrink-0 text-term-faint">{participant.role} · {participant.workspace.access}</span>
                {proposal.status === 'proposed' || proposal.status === 'approved' ? (
                  <button
                    type="button"
                    className="rounded p-0.5 text-term-dim hover:bg-foreground/5 hover:text-foreground"
                    aria-label={`${participant.lockedByHuman ? 'Unlock' : 'Lock'} participant ${participant.label}`}
                    disabled={isBusy}
                    onClick={() => toggleLock('participant', participant.key, participant.lockedByHuman === true)}
                  >
                    {participant.lockedByHuman ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-ink-line-2 bg-ink/55 p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-term-dim2">Relationships & stop</div>
          <div className="space-y-1.5">
            {plan.relationships.map((relationship) => (
              <div key={relationship.key} className="flex min-w-0 items-start gap-2 text-[10px] leading-4">
                <span className="min-w-0 flex-1 text-foreground/80">
                  {relationship.from} → {relationship.to} · {relationship.trigger}
                  {relationship.stop ? <span className="block text-term-faint">stop: {relationship.stop}</span> : null}
                  {relationship.disabledByHuman ? (
                    <span className="block text-term-amber">
                      disabled by human · {relationship.disabledByHuman.reason} · will not be rebuilt
                    </span>
                  ) : null}
                </span>
                <span className={cn('shrink-0', relationship.disabledByHuman ? 'text-term-amber' : 'text-term-faint')}>
                  {relationship.disabledByHuman ? 'disabled' : relationship.gate}
                </span>
                {proposal.status === 'proposed' || proposal.status === 'approved' ? (
                  <button
                    type="button"
                    className="rounded p-0.5 text-term-dim hover:bg-foreground/5 hover:text-foreground"
                    aria-label={`${relationship.lockedByHuman ? 'Unlock' : 'Lock'} relationship ${relationship.key}`}
                    disabled={isBusy}
                    onClick={() => toggleLock('relationship', relationship.key, relationship.lockedByHuman === true)}
                  >
                    {relationship.lockedByHuman ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-ink-line-2 bg-ink/40 p-2.5 text-[10px] leading-4">
        <div className="flex items-center gap-1.5 text-term-cyan">
          <ShieldCheck className="size-3" />
          <span>{plan.autonomyPolicy.mode}</span>
          <span className="text-term-faint">· max {plan.autonomyPolicy.maxSessions} sessions · concurrency {plan.autonomyPolicy.maxConcurrentSessions}</span>
        </div>
        {proposal.validation.errors.map((issue) => (
          <p key={`${issue.field}:${issue.message}`} className="mt-1 text-destructive">Error · {issue.message}</p>
        ))}
        {proposal.validation.warnings.map((issue) => (
          <p key={`${issue.field}:${issue.message}`} className="mt-1 text-term-amber">Warning · {issue.message}</p>
        ))}
        {proposal.validation.approvalReasons.map((reason) => (
          <p key={reason} className="mt-1 text-term-dim">Approval · {reason}</p>
        ))}
      </div>

      <div>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[10px] text-term-dim hover:text-foreground"
          aria-expanded={showDiff}
          onClick={() => setShowDiff((current) => !current)}
        >
          <ChevronDown className={cn('size-3 transition-transform', showDiff && 'rotate-180')} />
          Graph Diff · {diffCount} {diffCount === 1 ? 'change' : 'changes'}
        </button>
        {showDiff ? (
          <div className="mt-1 grid gap-1 rounded-lg border border-ink-line-2 bg-ink/45 p-2.5 text-[10px] text-term-dim">
            {diffGroups.filter(([, entries]) => entries.length > 0).map(([label, entries]) => (
              <div key={label} className="flex gap-2">
                <span className="w-36 shrink-0 text-term-faint">{label}</span>
                <span className="min-w-0 break-words text-foreground/75">{entries.map((entry) => entry.key).join(', ')}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-ink-line-2 pt-2.5">
        {proposal.status === 'proposed' ? (
          <>
            <Button
              size="sm"
              className="h-7 text-[10px]"
              disabled={isBusy || proposal.validation.errors.length > 0}
              onClick={() => command('approve_workflow_proposal', { proposalId: proposal.proposalId, approvedBy: 'proposal-card' }, 'Human approved the visible Workflow Proposal and Graph Diff.')}
            >
              <Check className="size-3" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[10px]"
              disabled={isBusy}
              onClick={() => command('reject_workflow_proposal', { proposalId: proposal.proposalId, reason: 'Rejected from Master Chat.' }, 'Human rejected the Workflow Proposal.')}
            >
              <X className="size-3" /> Reject
            </Button>
          </>
        ) : null}
        {proposal.status === 'approved' ? (
          <Button
            size="sm"
            className="h-7 text-[10px]"
            disabled={isBusy}
            onClick={() => {
              const nonce = globalThis.crypto.randomUUID();
              void command(
                'commit_workflow',
                { proposalId: proposal.proposalId, expectedBaseVersion: proposal.baseVersion, idempotencyKey: `proposal-card-${proposal.proposalId}-${nonce}` },
                'Human launched the approved Workflow Proposal from Master Chat.',
              );
            }}
          >
            <Play className="size-3" /> {patch ? 'Apply patch' : 'Run workflow'}
          </Button>
        ) : null}
        {proposal.status === 'committed' ? (
          <>
            <span className={cn('flex items-center gap-1 text-[10px]', executionStatus === 'failed' ? 'text-destructive' : executionStatus === 'running' ? 'text-term-accent-hi' : 'text-term-dim')}>
              <Check className="size-3" /> {executionStatus ?? 'failed'} workflow
            </span>
            {liveWorkflowId && plan.recipe === 'plan-council' && onOpenLive ? (
              <Button size="sm" variant="outline" className="ml-auto h-7 text-[10px]" onClick={() => onOpenLive(liveWorkflowId)}>
                Open Council
              </Button>
            ) : null}
          </>
        ) : null}
        <span className="ml-auto text-[9px] text-term-faint">{proposal.proposalId}</span>
      </footer>
    </section>
  );
}
