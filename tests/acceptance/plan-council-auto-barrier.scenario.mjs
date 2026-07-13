import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'plan-council-auto-barrier';
export const description =
  'M3/M5 real-provider acceptance: capped read-only planners automatically cross-review and synthesize through durable Barriers with provider usage facts.';
export const timeoutMs = 900_000;

function participant(key, label, provider) {
  return {
    key,
    label,
    providerKind: provider.providerKind,
    providerInstanceId: provider.providerKind === 'codex'
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
  fs.writeFileSync(path.join(workDir, 'README.md'), [
    '# Correlated release fixture',
    '',
    'Design a staged migration to a durable per-tenant job queue.',
    'Preserve FIFO per tenant, allow cross-tenant concurrency, and recover after crashes.',
  ].join('\n'));
  fs.writeFileSync(path.join(workDir, 'src', 'queue.js'), [
    'const pending = [];',
    'export const enqueue = (tenant, job) => pending.push({ tenant, job });',
    'export async function drain(run) { while (pending.length) await run(pending.shift()); }',
  ].join('\n'));

  const started = await orrery.startPlanCouncil({
    objective: [
      'Read README.md and src/queue.js and propose a crash-durable queue migration.',
      'Do not edit files. Produce a concrete staged plan and deterministic verification strategy.',
    ].join(' '),
    cwd: workDir,
    reviewFocus: 'Crash consistency, per-tenant FIFO, concurrency, and migration safety.',
    planners: [
      participant('durability', 'Durability Planner', provider),
      participant('concurrency', 'Concurrency Planner', provider),
    ],
    synthesizer: participant('synthesizer', 'Barrier Synthesizer', provider),
    advancement: { crossReview: 'auto', synthesis: 'auto' },
  });
  log(`Council ${started.workflowId} started with automatic phase advancement`);

  const completed = await orrery.waitFor(
    'automatic proposal, review, and synthesis barriers',
    async () => {
      const state = await orrery.state();
      const council = state.planCouncils?.[started.workflowId];
      return council?.phase === 'completed'
        ? { done: true, value: { council, state } }
        : { detail: `${council?.phase ?? 'missing'} · ${council?.artifacts.length ?? 0} artifacts` };
    },
    { timeoutMs: 720_000 },
  );

  const { council, state } = completed;
  assert.deepEqual(council.advancement, { crossReview: 'auto', synthesis: 'auto' });
  assert.equal(council.artifacts.filter((item) => item.kind === 'proposal').length, 2);
  assert.equal(council.artifacts.filter((item) => item.kind === 'peer-review').length, 2);
  assert.equal(council.artifacts.filter((item) => item.kind === 'synthesis').length, 1);
  assert.ok(council.artifacts.every((item) => item.execution?.correlationKey));
  const barriers = Object.values(state.barriers).filter((item) => item.runId === council.runId);
  assert.equal(barriers.length, 3);
  assert.deepEqual(barriers.map((item) => item.phaseId).sort(), ['peer-review', 'proposal', 'synthesis']);
  assert.ok(barriers.every((item) => item.status === 'released' && item.releasedEventId));
  const participantIds = new Set(council.participantOrder);
  const usageFacts = state.usageFacts.filter((fact) => participantIds.has(fact.sessionId));
  assert.equal(usageFacts.length, 5, '2 proposal + 2 review + 1 synthesis turns are metered');
  assert.ok(usageFacts.every((fact) => fact.source === 'provider' || fact.source === 'unavailable'));
  assert.equal(usageFacts.some((fact) => 'cost' in fact || 'totalCostUsd' in fact), false, 'pricing remains separate from objective usage');
  assert.equal(state.resourcePolicies.global.maxConcurrentSessions, 4);
  assert.equal(state.resourcePolicies.global.consumptionEnforcement, 'off');
  assert.equal(state.runQueue.length, 0);
  assert.equal(state.workspaceLeases.filter((lease) => lease.status === 'active').length, 0);
  const { events } = await orrery.kernelEvents({ limit: 3000 });
  assert.equal(events.filter((item) => item.type === 'barrier.released' && item.payload.runId === council.runId).length, 3);
  const synthesis = council.artifacts.find((item) => item.kind === 'synthesis');
  const { content } = await orrery.getPlanCouncilArtifact(council.workflowId, synthesis.artifactId);
  assert.match(content, /implementation|stage|phase/i);
  assert.match(content, /test|verification/i);
  log('verified capped read-only 2 proposals → 2 reviews → 1 synthesis with five durable usage facts and no leaked leases');
}
