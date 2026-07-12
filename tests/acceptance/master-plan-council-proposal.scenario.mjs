import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'master-plan-council-proposal';
export const description =
  'M1 real-provider acceptance: one natural-language request makes a real Master inspect its Scope and create a typed Plan Council Proposal; human approval gates a versioned Master commit, then two real planners exchange reviews and produce a synthesis.';
export const timeoutMs = 1_200_000;

export async function run({ orrery, provider, modelPreset, workDir, log }) {
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'README.md'),
    [
      '# Durable job queue',
      '',
      'Plan a migration from the current in-memory queue.',
      'Constraints: crash recovery, FIFO per tenant, cross-tenant concurrency, three retries, and observable counts.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workDir, 'src', 'queue.js'),
    [
      'const jobs = [];',
      'export function enqueue(tenant, payload) { jobs.push({ tenant, payload }); }',
      'export async function drain(run) { while (jobs.length) await run(jobs.shift()); }',
      '',
    ].join('\n'),
  );

  const anchor = await orrery.createSession({
    ...provider,
    label: 'Project Anchor',
    cwd: workDir,
    prompt: 'Reply with exactly: project ready.',
  });
  await orrery.waitForIdle(anchor.sessionId);
  const cluster = await orrery.upsertCluster({
    label: 'Queue Migration Scope',
    nodeIds: [anchor.sessionId],
  });

  const master = await orrery.createMasterForCluster(cluster.clusterId, {
    ...provider,
    label: 'Queue Migration Master',
    cwd: workDir,
    prompt: [
      'Act as the project Master for this Scope.',
      'On this first turn, inspect your Scope and turn this one request into a durable Workflow Proposal:',
      '"Use two independent planners to inspect README.md and src/queue.js, compare crash-durable queue designs, cross-review each other once, and synthesize one staged implementation plan."',
      'Choose Plan Council, inherit your current provider and workspace for all participants, and use a stable idempotency key.',
      'Create the Proposal only. Do not commit it, do not create raw sessions, and stop after reporting the proposal id and any warnings.',
    ].join('\n'),
  });
  await orrery.waitForIdle(master.sessionId, { timeoutMs: 300_000 });

  const proposed = await orrery.waitFor(
    'Master-authored Plan Council Proposal',
    async () => {
      const state = await orrery.state();
      const proposal = Object.values(state.workflowProposals ?? {}).find(
        (candidate) =>
          candidate.createdBy?.kind === 'master' &&
          candidate.createdBy?.ref === master.sessionId &&
          candidate.proposedPlan?.recipe === 'plan-council',
      );
      return proposal
        ? { done: true, value: proposal }
        : { detail: `${Object.keys(state.workflowProposals ?? {}).length} proposals` };
    },
    { timeoutMs: 300_000 },
  );
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.validation.errors.length, 0);
  assert.equal(proposed.validation.requiresHumanApproval, true);
  assert.equal(proposed.proposedPlan.participants.filter((item) => item.role === 'Planner').length, 2);
  assert.ok(proposed.proposedPlan.participants.every((item) => item.workspace.access === 'read'));
  assert.ok(
    proposed.proposedPlan.participants.every(
      (item) => item.endpoint.kind === 'new' && item.endpoint.runtimeSettings.sandbox === 'read-only',
    ),
  );
  let state = await orrery.state();
  assert.equal(Object.keys(state.planCouncils ?? {}).length, 0, 'Proposal creates no live Council');
  assert.equal(Object.keys(state.sessions).length, 2, 'Proposal creates no participant sessions');
  log(`Master proposed ${proposed.proposalId} with ${proposed.graphDiff.participants.add.length} participants`);

  await orrery.dispatchCommand({
    commandId: `acceptance-approve-${proposed.proposalId}`,
    idempotencyKey: `acceptance-approve-${proposed.proposalId}`,
    kind: 'approve_workflow_proposal',
    reason: 'Acceptance human reviewed the typed graph diff and safety warnings.',
    input: { proposalId: proposed.proposalId, approvedBy: 'acceptance-human' },
  });
  await orrery.resumeSession(master.sessionId, {
    message: [
      `The Workflow Proposal ${proposed.proposalId} is now human-approved.`,
      `Call commit_workflow exactly once with expectedBaseVersion=${proposed.baseVersion} and idempotencyKey="acceptance-master-commit-${proposed.proposalId}".`,
      'Do not create, link, deliver, or activate raw sessions. After the commit tool returns, report the live workflow id and stop.',
    ].join('\n'),
  });
  await orrery.waitForIdle(master.sessionId, { timeoutMs: 300_000 });

  const committed = await orrery.waitFor(
    'Master commit',
    async () => {
      const current = await orrery.state();
      const proposal = current.workflowProposals?.[proposed.proposalId];
      return proposal?.status === 'committed'
        ? { done: true, value: proposal }
        : { detail: proposal?.status ?? 'missing' };
    },
    { timeoutMs: 300_000 },
  );
  const liveWorkflowId = committed.proposedPlan.executionMapping.productWorkflowId;
  assert.ok(liveWorkflowId);
  assert.equal(committed.proposedPlan.executionMapping.planVersion, 1);
  assert.equal(Object.keys(committed.proposedPlan.executionMapping.participantSessionIds).length, 3);
  log(`Master committed live Council ${liveWorkflowId}`);

  const proposalsReady = await orrery.waitFor(
    'two independent proposals',
    async () => {
      const current = await orrery.state();
      const council = current.planCouncils?.[liveWorkflowId];
      const artifacts = council?.artifacts.filter((item) => item.kind === 'proposal') ?? [];
      return council?.phase === 'ready-for-cross-review'
        ? { done: true, value: council }
        : { detail: `${council?.phase ?? 'missing'} · ${artifacts.length}/2 proposals` };
    },
    { timeoutMs: 420_000 },
  );
  assert.equal(proposalsReady.artifacts.filter((item) => item.kind === 'proposal').length, 2);
  await orrery.startPlanCouncilCrossReview(liveWorkflowId);
  const reviewsReady = await orrery.waitFor(
    'two peer reviews',
    async () => {
      const current = await orrery.state();
      const council = current.planCouncils?.[liveWorkflowId];
      const artifacts = council?.artifacts.filter((item) => item.kind === 'peer-review') ?? [];
      return council?.phase === 'ready-for-synthesis'
        ? { done: true, value: council }
        : { detail: `${council?.phase ?? 'missing'} · ${artifacts.length}/2 reviews` };
    },
    { timeoutMs: 420_000 },
  );
  for (const artifact of reviewsReady.artifacts.filter((item) => item.kind === 'peer-review')) {
    const { content } = await orrery.getPlanCouncilArtifact(liveWorkflowId, artifact.artifactId);
    assert.match(content, /proposal|plan|approach/i);
    assert.match(content, /crash|FIFO|queue|retry|transaction|SQLite|Redis|Postgres/i);
  }
  await orrery.startPlanCouncilSynthesis(liveWorkflowId);
  const completed = await orrery.waitFor(
    'Council synthesis',
    async () => {
      const current = await orrery.state();
      const council = current.planCouncils?.[liveWorkflowId];
      return council?.phase === 'completed'
        ? { done: true, value: council }
        : { detail: council?.phase ?? 'missing' };
    },
    { timeoutMs: 420_000 },
  );
  const synthesis = completed.artifacts.find((item) => item.kind === 'synthesis');
  assert.ok(synthesis);
  const { content: finalPlan } = await orrery.getPlanCouncilArtifact(liveWorkflowId, synthesis.artifactId);
  assert.match(finalPlan, /implementation|stage|phase/i);
  assert.match(finalPlan, /verification|test/i);

  state = await orrery.state();
  const scopedIds = new Set(state.clusters[cluster.clusterId].nodeIds);
  for (const sessionId of completed.participantOrder) assert.ok(scopedIds.has(sessionId));
  const presetModel = modelPreset?.[provider.providerKind]?.model;
  if (presetModel) {
    for (const sessionId of completed.participantOrder) {
      assert.equal(state.sessions[sessionId].runtimeSettings?.model, presetModel);
    }
  }
  const { events } = await orrery.kernelEvents({ limit: 3000 });
  const proposedEvent = events.find(
    (event) => event.type === 'workflow.proposed' && event.payload.proposalId === proposed.proposalId,
  );
  const approvedEvent = events.find(
    (event) => event.type === 'workflow.proposal.approved' && event.payload.proposalId === proposed.proposalId,
  );
  const committedEvent = events.find(
    (event) => event.type === 'workflow.committed' && event.payload.proposalId === proposed.proposalId,
  );
  assert.equal(proposedEvent.actor.kind, 'master');
  assert.equal(proposedEvent.actor.ref, master.sessionId);
  assert.equal(approvedEvent.actor.kind, 'human');
  assert.equal(committedEvent.actor.kind, 'master');
  assert.equal(committedEvent.actor.ref, master.sessionId);
  assert.equal(completed.artifacts.length, 5, '2 proposals → 2 reviews → 1 synthesis');
  log('M1 verified: intent → Proposal → human approval → versioned Master commit → 2→2→1 Council');
}
