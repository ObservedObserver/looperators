import type { RuntimeApi } from '@/runtime-client';
import { defaultProviderRuntimeSettings } from '@/shared/provider-runtime';
import type { GraphState, StartPlanCouncilInput } from '@/shared/graph-state';
import {
  compileWorkflowPlan,
  defaultScopeWorkflowCapability,
  validateWorkflowPlan,
  type WorkflowProposal,
  type WorkflowRecipe,
} from '@shared/workflow-authoring';

/** Cold preview for the same global scope used by standalone human proposals. */
export function previewPlanCouncilWorkflow(state: GraphState, input: StartPlanCouncilInput) {
  const providerInstanceIds = state.providerInstances.map((instance) => instance.providerInstanceId);
  const capability = state.workflowCapabilities?.global ?? defaultScopeWorkflowCapability('global', providerInstanceIds, state.updatedAt);
  const scopeSessionIds = Object.keys(state.sessions);
  // Council always creates fresh participants. Keep every existing session in
  // scope, including archived sessions, just as the runtime validator does.
  const context = {
    capability,
    providerInstanceIds,
    scopeSessionIds,
    sessions: Object.fromEntries(
      Object.values(state.sessions).map((session) => [
        session.sessionId,
        {
          sessionId: session.sessionId,
          label: session.label,
          cwd: session.cwd,
          status: session.status,
          providerKind: session.providerKind,
          providerInstanceId: session.providerInstanceId,
          runtimeSettings: { ...(session.runtimeSettings ?? defaultProviderRuntimeSettings) },
        },
      ]),
    ),
  };
  const plan = compileWorkflowPlan(
    {
      workflowId: 'comparison-preview',
      version: 1,
      objective: input.objective,
      recipeInput: { recipe: 'plan-council', input },
      scopeId: 'global',
      autonomyPolicy: capability.policy,
      createdAt: state.updatedAt,
      createdBy: { kind: 'human' },
    },
    context,
  );
  return {
    validation: validateWorkflowPlan(plan, context),
    existingSessionCount: scopeSessionIds.length,
    newSessionCount: plan.participants.length,
    sessionLimit: capability.policy.maxSessions,
  };
}

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
  const proposal = proposed.proposal as WorkflowProposal;
  if (proposal.validation.errors.length) {
    throw new Error(`Workflow preview is blocked: ${proposal.validation.errors.map((issue) => issue.message).join(' ')}`);
  }
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
