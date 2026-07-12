// Product-facing workflow entry catalog.
//
// This module deliberately describes outcomes rather than kernel operators.
// It is shared by the renderer and deterministic tests so the first-run
// information architecture cannot drift into a second, UI-only registry.

export type WorkflowEntry = {
  id: string;
  name: string;
  summary: string;
  needs: string;
  result: string;
};

export const primaryWorkflowCatalog = [
  {
    id: 'plan-council',
    name: 'Compare plans',
    summary: 'Ask several independent Agents to plan, cross-review each other, and synthesize one final proposal.',
    needs: 'A planning task, one workspace, 2–4 Planner models, and a Synthesizer.',
    result: 'Comparable plans, peer reviews, and one traceable final implementation plan.',
  },
  {
    id: 'review-until-clean',
    name: 'Review until clean',
    summary: 'One Agent writes code. Another reviews it and sends blocking issues back until the work is clean.',
    needs: 'A Coder Agent, a Reviewer Agent, and a lap limit.',
    result: 'A review-and-fix loop that stops when the Reviewer reports clean.',
  },
  {
    id: 'handoff',
    name: 'Handoff',
    summary: "Send one Agent's current result to another Agent and start the receiver once.",
    needs: 'A source Agent, a receiving Agent, and an optional instruction.',
    result: 'One immediate transfer. No ongoing automation remains.',
  },
  {
    id: 'goal-loop',
    name: 'Run until goal',
    summary: 'Let an Agent keep working while an independent checker decides whether the goal is done.',
    needs: 'A Worker Agent, one sentence defining done, and a lap limit.',
    result: 'A work-and-check loop that stops at done or at the lap limit.',
  },
] as const satisfies readonly WorkflowEntry[];

export type PrimaryWorkflowId = (typeof primaryWorkflowCatalog)[number]['id'];

export const primaryWorkflowIds: readonly PrimaryWorkflowId[] = primaryWorkflowCatalog.map((entry) => entry.id);

const primaryOrder = new Map(primaryWorkflowIds.map((id, index) => [id, index]));

export function partitionWorkflowIds(ids: string[]) {
  const primary = ids
    .filter((id): id is PrimaryWorkflowId => primaryOrder.has(id as PrimaryWorkflowId))
    .sort((left, right) => (primaryOrder.get(left) ?? 0) - (primaryOrder.get(right) ?? 0));
  const more = ids.filter((id) => !primaryOrder.has(id as PrimaryWorkflowId));
  return { primary, more };
}

export function workflowEmptyState(sessionCount: number) {
  return {
    show: sessionCount === 0,
    actions: ['start-chat', 'build-workflow'] as const,
  };
}
