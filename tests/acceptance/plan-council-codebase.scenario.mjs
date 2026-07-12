import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'plan-council-codebase';
export const description =
  'M0A Plan Council: three real read-only Agent Sessions inspect a deterministic codebase, exchange proposals without human copy/paste, peer-review them, and synthesize one traceable final implementation plan.';
export const timeoutMs = 1_200_000;

function participant(key, label, provider) {
  return {
    key,
    label,
    providerKind: provider.providerKind,
    providerInstanceId:
      provider.providerKind === 'codex'
        ? 'default-codex'
        : provider.providerKind === 'grok'
          ? 'default-grok'
          : 'default-claude-sdk',
    runtimeSettings: {
      runtimeMode: 'approval-required',
      sandbox: 'read-only',
      interactionMode: 'plan',
    },
  };
}

export async function run({ orrery, provider, workDir, log }) {
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'README.md'),
    [
      '# Queue review fixture',
      '',
      'The service must process jobs durably after a crash.',
      'Requirements:',
      '- preserve FIFO order per account;',
      '- allow different accounts to run concurrently;',
      '- retry a failed job at most three times;',
      '- expose pending, running, succeeded, and failed counts;',
      '- migration must not lose the existing in-memory queue API.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workDir, 'src', 'queue.js'),
    [
      'const jobs = [];',
      'export function enqueue(job) { jobs.push(job); }',
      'export async function drain(run) {',
      '  while (jobs.length) await run(jobs.shift());',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2),
  );

  const started = await orrery.startPlanCouncil({
    objective: [
      'Review this small codebase and design the migration from its in-memory queue to a crash-durable implementation.',
      'The entire fixture consists only of README.md and src/queue.js; inspect exactly those two files with the Read tool.',
      'Do not invoke Bash, Glob, Grep, find, or any other discovery tool.',
      'Do not edit files. Compare at least two viable persistence approaches and give a staged implementation plan.',
    ].join(' '),
    cwd: workDir,
    reviewFocus:
      'Focus on crash consistency, per-account FIFO with cross-account concurrency, retry semantics, observability, backward compatibility, and deterministic tests.',
    planners: [
      participant('planner-a', 'Durability Planner', provider),
      participant('planner-b', 'Concurrency Planner', provider),
      participant('planner-c', 'Migration Planner', provider),
    ],
    synthesizer: participant('synthesizer', 'Council Synthesizer', provider),
  });
  assert.equal(Object.keys(started.participantSessionIds).length, 4);
  log(`Council ${started.workflowId}: three planners started`);

  const proposalsReady = await orrery.waitFor(
    'three independent Council proposals',
    async () => {
      const state = await orrery.state();
      const council = state.planCouncils?.[started.workflowId];
      const proposals = council?.artifacts.filter((artifact) => artifact.kind === 'proposal') ?? [];
      return council?.phase === 'ready-for-cross-review'
        ? { done: true, value: council }
        : { detail: `${council?.phase ?? 'missing'} · ${proposals.length}/3 proposals` };
    },
    { timeoutMs: 480_000 },
  );
  const proposalArtifacts = proposalsReady.artifacts.filter((artifact) => artifact.kind === 'proposal');
  assert.equal(proposalArtifacts.length, 3);
  assert.equal(new Set(proposalArtifacts.map((artifact) => artifact.digest)).size, 3, 'planners produce distinct proposals');
  log('human gate 1: all proposals ready; starting cross-review without copy/paste');

  await orrery.startPlanCouncilCrossReview(started.workflowId);
  const reviewsReady = await orrery.waitFor(
    'three peer reviews',
    async () => {
      const state = await orrery.state();
      const council = state.planCouncils?.[started.workflowId];
      const reviews = council?.artifacts.filter((artifact) => artifact.kind === 'peer-review') ?? [];
      return council?.phase === 'ready-for-synthesis'
        ? { done: true, value: council }
        : { detail: `${council?.phase ?? 'missing'} · ${reviews.length}/3 reviews` };
    },
    { timeoutMs: 480_000 },
  );
  const reviewArtifacts = reviewsReady.artifacts.filter((artifact) => artifact.kind === 'peer-review');
  assert.equal(reviewArtifacts.length, 3);
  const plannerLabels = reviewsReady.participantOrder
    .filter((sessionId) => reviewsReady.participants[sessionId].role === 'planner')
    .map((sessionId) => ({ sessionId, label: reviewsReady.participants[sessionId].label }));
  for (const artifact of reviewArtifacts) {
    const { content } = await orrery.getPlanCouncilArtifact(started.workflowId, artifact.artifactId);
    assert.match(content, /proposal|plan|approach/i, 'each reviewer discusses peer proposals');
    assert.match(content, /agree|conflict|missing|risk|recommend|change/i, 'each reviewer records a concrete comparison or recommendation');
    const peerLabels = plannerLabels
      .filter(({ sessionId }) => sessionId !== artifact.authorSessionId)
      .map(({ label }) => label);
    assert.ok(
      peerLabels.some((label) => content.toLowerCase().includes(label.toLowerCase())),
      'each reviewer identifies at least one peer proposal by planner label',
    );
    assert.match(
      content,
      /FIFO|crash|SQLite|Postgres|Redis|transaction|lease|idempoten|retry|migration/i,
      'each reviewer cites a concrete design claim from the fixture',
    );
  }
  log('human gate 2: every planner exchanged review material; starting synthesis');

  await orrery.startPlanCouncilSynthesis(started.workflowId);
  const completed = await orrery.waitFor(
    'final Council synthesis',
    async () => {
      const state = await orrery.state();
      const council = state.planCouncils?.[started.workflowId];
      return council?.phase === 'completed'
        ? { done: true, value: council }
        : { detail: council?.phase ?? 'missing' };
    },
    { timeoutMs: 480_000 },
  );
  const synthesis = completed.artifacts.find((artifact) => artifact.kind === 'synthesis');
  assert.ok(synthesis);
  const { content: finalPlan } = await orrery.getPlanCouncilArtifact(started.workflowId, synthesis.artifactId);
  for (const expected of ['consensus', 'disagreement', 'reason', 'implementation', 'verification']) {
    assert.match(finalPlan, new RegExp(expected, 'i'), `synthesis includes ${expected}`);
  }

  const state = await orrery.state();
  assert.equal(Object.keys(state.subscriptions ?? {}).length, 0, 'Council v1 adds no kernel operator/subscription');
  for (const sessionId of completed.participantOrder) {
    const session = state.sessions[sessionId];
    assert.equal(session.status === 'running' || session.status === 'pending', false, `${session.label} must settle`);
    assert.equal(session.runtimeSettings.sandbox, 'read-only');
  }
  assert.equal(completed.artifacts.length, 7);
  log('Plan Council verified: 3 proposals → 3 peer reviews → 1 synthesis, all sessions settled');
}
