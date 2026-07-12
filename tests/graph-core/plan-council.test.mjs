import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planCouncilProductView,
  plannerPrompt,
  validatePlanCouncilStart,
} from '../../dist-electron/shared/plan-council.js';

function agent(key) {
  return {
    key,
    label: key,
    providerKind: 'claude-code',
    providerInstanceId: 'default-claude-sdk',
    runtimeSettings: {
      runtimeMode: 'approval-required',
      sandbox: 'read-only',
      model: `${key}-model`,
    },
  };
}

test('Plan Council validates 2-4 independently configured read-only planners', () => {
  const base = {
    objective: 'Compare implementation plans.',
    cwd: process.cwd(),
    planners: [agent('a'), agent('b'), agent('c')],
    synthesizer: agent('synth'),
  };
  assert.equal(
    validatePlanCouncilStart(base, {
      providerInstanceIds: ['default-claude-sdk'],
    }).ok,
    true,
  );
  assert.equal(validatePlanCouncilStart({ ...base, planners: [agent('a')] }).ok, false);
  assert.equal(validatePlanCouncilStart({ ...base, planners: [...base.planners, agent('d'), agent('e')] }).ok, false);
  const writable = structuredClone(base);
  writable.planners[0].runtimeSettings.sandbox = 'workspace-write';
  assert.match(
    validatePlanCouncilStart(writable).issues.find((issue) => issue.field.includes('sandbox'))?.message ?? '',
    /read-only/,
  );
});

test('Plan Council product view derives human gate actions from durable phase', () => {
  const participants = {
    a: { ...agent('a'), role: 'planner', sessionId: 'a' },
    b: { ...agent('b'), role: 'planner', sessionId: 'b' },
    synth: { ...agent('synth'), role: 'synthesizer', sessionId: 'synth' },
  };
  const council = {
    workflowId: 'council-1',
    runId: 'run-1',
    objective: 'Plan',
    cwd: process.cwd(),
    phase: 'ready-for-cross-review',
    round: 1,
    synthesizerSessionId: 'synth',
    participantOrder: ['a', 'b', 'synth'],
    participants,
    artifacts: [
      { kind: 'proposal', authorSessionId: 'a' },
      { kind: 'proposal', authorSessionId: 'b' },
    ],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    advancement: { crossReview: 'human', synthesis: 'human' },
  };
  assert.deepEqual(planCouncilProductView(council), {
    plannerCount: 2,
    reviewerCount: 2,
    proposalsReady: 2,
    reviewsReady: 0,
    canStartCrossReview: true,
    canStartSynthesis: false,
    waitingGate: { phase: 'cross-review', policy: 'human' },
    canStop: true,
    terminal: false,
  });
  council.advancement.crossReview = 'master';
  assert.equal(planCouncilProductView(council).canStartCrossReview, false);
  assert.equal(planCouncilProductView(council).waitingGate.policy, 'master');
  council.phase = 'stopped';
  assert.equal(planCouncilProductView(council).canStop, false);
});

test('Councils above four planners require and project hub-and-spoke review', () => {
  const planners = ['a', 'b', 'c', 'd', 'e'].map(agent);
  const input = {
    objective: 'Compare a large set of plans.', cwd: process.cwd(), planners,
    synthesizer: agent('synth'), reviewTopology: 'hub-and-spoke',
  };
  assert.equal(validatePlanCouncilStart(input).ok, true);
  assert.equal(validatePlanCouncilStart({ ...input, reviewTopology: 'full-mesh' }).ok, false);
  const participants = Object.fromEntries([
    ...planners.map((item) => [item.key, { ...item, role: 'planner', sessionId: item.key }]),
    ['synth', { ...agent('synth'), role: 'synthesizer', sessionId: 'synth' }],
  ]);
  const view = planCouncilProductView({
    workflowId: 'large', runId: 'run', objective: 'Plan', cwd: process.cwd(),
    phase: 'reviewing-peers', round: 1, synthesizerSessionId: 'synth',
    reviewTopology: 'hub-and-spoke', participantOrder: [...planners.map((item) => item.key), 'synth'],
    participants, artifacts: [], history: [], createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), advancement: { crossReview: 'auto', synthesis: 'auto' },
  });
  assert.equal(view.plannerCount, 5);
  assert.equal(view.reviewerCount, 1);
});

test('independent planner prompt forbids premature channel discovery', () => {
  const prompt = plannerPrompt('Plan a migration.', 'Crash safety.', 'Durability');
  assert.match(prompt, /No peer proposal has been delivered yet/);
  assert.match(prompt, /Never inspect Orrery channel\/inbox directories/);
  assert.match(prompt, /Do not run shell commands/);
});
