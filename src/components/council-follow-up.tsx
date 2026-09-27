import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { WorkflowProposalCard } from '@/components/workflow-proposal-card';
import type { GraphState } from '@/shared/graph-state';
import type { RuntimeApi } from '@/runtime-client';
import type { PlanCouncil } from '@shared/plan-council';

export function CouncilFollowUp({
  council,
  runtimeState,
  runtimeApi,
  onStateChange,
  onError,
}: {
  council: PlanCouncil;
  runtimeState: GraphState;
  runtimeApi?: RuntimeApi;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
}) {
  const [focus, setFocus] = useState('');
  const [kind, setKind] = useState<'verify' | 'resynthesize'>('verify');
  const [busy, setBusy] = useState(false);
  const [proposalId, setProposalId] = useState<string>();
  const plan = Object.values(runtimeState.workflowPlans ?? {})
    .flatMap((versions) => Object.values(versions))
    .filter((item) => item.status === 'active' && item.executionMapping?.productWorkflowId === council.workflowId)
    .sort((a, b) => b.version - a.version)[0];
  const proposal = proposalId ? runtimeState.workflowProposals?.[proposalId] : undefined;
  if (!plan || !['ready-for-synthesis', 'completed'].includes(council.phase)) return null;
  const preview = async () => {
    if (!runtimeApi || !focus.trim() || busy) return;
    setBusy(true);
    try {
      const nonce = globalThis.crypto.randomUUID();
      const synthesizer = council.participants[council.synthesizerSessionId];
      const operations =
        kind === 'resynthesize'
          ? [{ op: 'resynthesize', reason: focus.trim() }]
          : [
              {
                op: 'add-verifier',
                verifier: {
                  key: `specialist-${nonce}`,
                  label: 'Evidence reviewer',
                  role: 'Verifier',
                  prompt: focus.trim(),
                  endpoint: {
                    kind: 'new',
                    providerKind: synthesizer.providerKind,
                    providerInstanceId: synthesizer.providerInstanceId,
                    runtimeSettings: { ...synthesizer.runtimeSettings, sandbox: 'read-only' },
                  },
                  workspace: { cwd: council.cwd, access: 'read', workMode: 'local' },
                },
                observes: plan.participants.filter((item) => item.role === 'Planner').map((item) => item.key),
              },
            ];
      const result = await runtimeApi.dispatchCommand({
        kind: 'propose_workflow_patch',
        commandId: `council-follow-up-${nonce}`,
        idempotencyKey: `council-follow-up-${nonce}`,
        reason: focus.trim(),
        input: { workflowId: plan.workflowId, baseVersion: plan.version, reason: focus.trim(), operations },
      });
      onStateChange(result.state as GraphState);
      setProposalId((result.proposal as { proposalId: string }).proposalId);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-xl border border-border p-4" data-testid="council-follow-up">
      <h3 className="text-sm font-medium">Resolve a question</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        Request a focused evidence check, or ask the decision writer to reconsider with your constraints. Previewing does not start an Agent.
      </p>
      <label className="block space-y-1 text-xs">
        Follow-up action
        <select
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="verify">Verify a disputed fact · one specialist turn</option>
          <option value="resynthesize">Revise the recommendation · one synthesis turn</option>
        </select>
      </label>
      <label className="block space-y-1 text-xs">
        Question or new constraint
        <textarea
          className="min-h-20 w-full rounded-md border border-border bg-background p-3 text-sm"
          maxLength={8000}
          value={focus}
          onChange={(event) => setFocus(event.target.value)}
          placeholder="Which claim needs checking, and what evidence would resolve it?"
        />
      </label>
      <Button
        variant="outline"
        disabled={!runtimeApi || !focus.trim() || busy || Boolean(proposal && ['proposed', 'approved'].includes(proposal.status))}
        onClick={() => void preview()}
      >
        {busy ? 'Preparing preview…' : 'Preview follow-up'}
      </Button>
      {proposal ? (
        <WorkflowProposalCard proposal={proposal} runtimeState={runtimeState} runtimeApi={runtimeApi} onStateChange={onStateChange} onError={onError} />
      ) : null}
    </section>
  );
}
