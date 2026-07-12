import type { RuntimeApi } from '@/runtime-client';
import type { GraphState } from '@/shared/graph-state';
import type { WorkflowRecipe } from '@shared/workflow-authoring';

export type AuthorAndCommitWorkflowResult<T> = {
  proposal: Record<string, unknown>;
  plan: Record<string, unknown>;
  executionMapping: Record<string, unknown>;
  result: T;
  state: GraphState;
};

export async function authorAndCommitWorkflow<T>(
  runtimeApi: RuntimeApi,
  input: {
    recipe: WorkflowRecipe;
    objective: string;
    recipeInput: Record<string, unknown>;
    reason: string;
    scopeId?: string;
  },
) {
  const nonce = globalThis.crypto.randomUUID();
  const proposalId = `proposal-${nonce}`;
  const proposed = await runtimeApi.dispatchCommand({
    commandId: `standalone-propose-${nonce}`,
    idempotencyKey: `standalone-propose-${nonce}`,
    kind: 'propose_workflow',
    reason: input.reason,
    input: {
      proposalId,
      objective: input.objective,
      recipe: input.recipe,
      input: input.recipeInput,
      reason: input.reason,
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    },
  });
  const proposal = proposed.proposal as { baseVersion: number };
  await runtimeApi.dispatchCommand({
    commandId: `standalone-approve-${nonce}`,
    idempotencyKey: `standalone-approve-${nonce}`,
    kind: 'approve_workflow_proposal',
    reason: 'The human explicitly reviewed the standalone composer and chose Run workflow.',
    input: { proposalId, approvedBy: 'standalone-composer' },
  });
  return runtimeApi.dispatchCommand({
    commandId: `standalone-commit-${nonce}`,
    idempotencyKey: `standalone-commit-${nonce}`,
    kind: 'commit_workflow',
    reason: input.reason,
    input: { proposalId, expectedBaseVersion: proposal.baseVersion },
  }) as Promise<AuthorAndCommitWorkflowResult<T>>;
}
