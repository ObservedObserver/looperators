import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'master-governor-review-patch';
export const description =
  'M2 real-provider acceptance: a real Master inspects an active Review Workflow, proposes an add-verifier Workflow Patch, waits for human approval, and commits only the incremental verifier resources with durable impact and rollback metadata.';
export const timeoutMs = 900_000;

export async function run({ orrery, provider, workDir, log }) {
  fs.writeFileSync(path.join(workDir, 'README.md'), '# Queue API\n\nThe current API is intentionally small.\n');
  fs.writeFileSync(path.join(workDir, 'queue.js'), 'export function enqueue(job) { return { accepted: true, job }; }\n');

  const providerInstanceId = provider.providerKind === 'codex'
    ? 'default-codex'
    : provider.providerKind === 'grok'
      ? 'default-grok'
      : 'default-claude-sdk';
  const anchor = await orrery.createSession({
    ...provider, providerInstanceId, label: 'Patch Project Anchor', cwd: workDir,
    prompt: 'Reply with exactly: project ready.',
  });
  await orrery.waitForIdle(anchor.sessionId, { timeoutMs: 300_000 });
  const cluster = await orrery.upsertCluster({ label: 'Patch Scope', nodeIds: [anchor.sessionId] });
  const master = await orrery.createMasterForCluster(cluster.clusterId, {
    ...provider, providerInstanceId, label: 'Patch Governor', cwd: workDir,
    prompt: 'Reply with exactly: governor ready. Do not create a Workflow yet.',
  });
  await orrery.waitForIdle(master.sessionId, { timeoutMs: 300_000 });

  const initial = await orrery.dispatchCommand({
    commandId: 'm2-acceptance-propose-review', idempotencyKey: 'm2-acceptance-propose-review',
    kind: 'propose_workflow', reason: 'Acceptance fixture creates the governed base version.',
    input: {
      proposalId: 'm2-acceptance-review', scopeId: cluster.clusterId,
      masterSessionId: master.sessionId, recipe: 'review', objective: 'Check the Queue API once.',
      input: {
        coder: {
          kind: 'new', label: 'Queue Coder',
          prompt: 'Read README.md and queue.js, make no changes, summarize the current API, then stop. If reads use a shell-backed tool, issue exactly one sed or rg file-read command per tool call; do not use shell control operators, formatting commands, checksums, stat, or git status.',
          cwd: workDir, workMode: 'local', ...provider, providerInstanceId,
          runtimeSettings: { runtimeMode: 'approval-required' },
        },
        reviewer: {
          kind: 'new', label: 'Queue Reviewer',
          instruction: 'Verify the delivered summary against README.md and queue.js. Report a typed clean verdict through the Orrery membrane, then stop.',
          ...provider, providerInstanceId,
          runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
        },
        blocking: { mode: 'any-issue' }, maxLaps: 1,
      },
    },
  });
  await orrery.dispatchCommand({
    commandId: 'm2-acceptance-approve-review', idempotencyKey: 'm2-acceptance-approve-review',
    kind: 'approve_workflow_proposal', input: { proposalId: initial.proposal.proposalId },
  });
  const base = await orrery.dispatchCommand({
    commandId: 'm2-acceptance-commit-review', idempotencyKey: 'm2-acceptance-commit-review',
    kind: 'commit_workflow', input: {
      proposalId: initial.proposal.proposalId, expectedBaseVersion: 0,
    },
  });
  const baseMapping = base.executionMapping;
  await orrery.waitForIdle(baseMapping.participantSessionIds.coder, { timeoutMs: 300_000 });
  await orrery.waitForIdle(baseMapping.participantSessionIds.reviewer, { timeoutMs: 300_000 });
  // Reaching the base Review lap cap emits a Governor wakeup and can activate
  // the Master while the Reviewer is still finishing. Do not race that
  // governed turn with the explicit patch-authoring instruction below.
  await orrery.waitForIdle(master.sessionId, { timeoutMs: 300_000 });
  const beforePatch = await orrery.state();
  const beforeSessionCount = Object.keys(beforePatch.sessions).length;

  await orrery.resumeSession(master.sessionId, {
    message: [
      `Inspect your Scope and active Workflow ${base.plan.workflowId} v1.`,
      'Propose, but do not commit, one versioned Workflow Patch that adds a read-only specialist verifier named security-verifier observing the coder.',
      'The verifier should inspect queue.js for unsafe input handling. Inherit your current provider and workspace.',
      'You must actually call mcp__orrery_membrane__propose_workflow_patch exactly once. Printing or describing a JSON patch is not a Proposal.',
      'Use operations=[{op:"add-verifier", verifier:{key:"security-verifier", label:"security-verifier", prompt:"Inspect queue.js for unsafe input handling."}, observes:["coder"]}]. Keep all verifier fields nested under verifier; the operation discriminator is op, not type.',
      'Use reason "Add an independent security check" and idempotencyKey "m2-real-add-verifier".',
      'Do not mutate raw sessions or relationships. Stop after reporting the Patch impact and rollback.',
    ].join('\n'),
  });
  await orrery.waitForIdle(master.sessionId, { timeoutMs: 300_000 });
  const patchProposal = await orrery.waitFor(
    'real Master Workflow Patch Proposal',
    async () => {
      const state = await orrery.state();
      const proposal = Object.values(state.workflowProposals ?? {}).find(
        (candidate) => candidate.workflowId === base.plan.workflowId && candidate.patch,
      );
      return proposal ? { done: true, value: proposal } : { detail: 'no patch proposal yet' };
    },
    { timeoutMs: 300_000 },
  );
  assert.equal(patchProposal.baseVersion, 1);
  assert.equal(patchProposal.status, 'proposed');
  assert.deepEqual(patchProposal.patch.impact.addedParticipantKeys, ['security-verifier']);
  assert.equal(patchProposal.patch.rollback.baseVersion, 1);
  assert.equal(Object.keys((await orrery.state()).sessions).length, beforeSessionCount, 'unapproved patch is authoring-only');
  log(`Master proposed patch ${patchProposal.proposalId} with rollback to v1`);

  await orrery.dispatchCommand({
    commandId: 'm2-acceptance-approve-patch', idempotencyKey: 'm2-acceptance-approve-patch',
    kind: 'approve_workflow_proposal', input: { proposalId: patchProposal.proposalId },
  });
  await orrery.resumeSession(master.sessionId, {
    message: [
      `Patch Proposal ${patchProposal.proposalId} is human-approved.`,
      `Commit it exactly once with expectedBaseVersion=1 and idempotencyKey="m2-real-commit-${patchProposal.proposalId}".`,
      'Do not create or connect raw sessions yourself. Stop after the commit tool returns.',
    ].join('\n'),
  });
  await orrery.waitForIdle(master.sessionId, { timeoutMs: 300_000 });
  const committed = await orrery.waitFor(
    'real Master incremental Patch commit',
    async () => {
      const state = await orrery.state();
      const proposal = state.workflowProposals?.[patchProposal.proposalId];
      return proposal?.status === 'committed'
        ? { done: true, value: proposal }
        : { detail: proposal?.status ?? 'missing' };
    },
    { timeoutMs: 300_000 },
  );
  const mapping = committed.proposedPlan.executionMapping;
  assert.equal(mapping.planVersion, 2);
  assert.equal(mapping.participantSessionIds.coder, baseMapping.participantSessionIds.coder);
  assert.equal(mapping.participantSessionIds.reviewer, baseMapping.participantSessionIds.reviewer);
  assert.ok(mapping.participantSessionIds['security-verifier']);
  const finalState = await orrery.state();
  assert.equal(Object.keys(finalState.sessions).length, beforeSessionCount + 1);
  assert.equal(finalState.workflowPlans[base.plan.workflowId]['1'].status, 'superseded');
  assert.equal(finalState.workflowPlans[base.plan.workflowId]['2'].status, 'active');
  const { events } = await orrery.kernelEvents({ limit: 3000 });
  assert.ok(events.some((event) =>
    event.type === 'workflow.patch.proposed' && event.payload.proposalId === patchProposal.proposalId));
  assert.ok(events.some((event) =>
    event.type === 'workflow.patch.committed' && event.payload.proposalId === patchProposal.proposalId));
  log('M2 verified: real Master → reviewable Patch → human approval → incremental commit; base sessions preserved');
}
