import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js';
import { deterministicProviderAdapters } from './support/deterministic-provider.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, predicate, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function harness(prefix, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(root, 'state.json'),
    providerAdapters: deterministicProviderAdapters(options),
  });
  return {
    runtime,
    root,
    cleanup() {
      runtime.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function agent(key, providerInstanceId = 'default-claude-sdk') {
  return {
    key,
    label: key,
    providerKind: 'claude-code',
    providerInstanceId,
    runtimeSettings: {
      runtimeMode: 'approval-required',
      sandbox: 'read-only',
      model: `${key}-model`,
      reasoningEffort: 'high',
    },
  };
}

function input(cwd) {
  return {
    objective: 'Review this codebase and propose a staged implementation.',
    cwd,
    reviewFocus: 'Architecture and verification.',
    planners: [agent('Planner A'), agent('Planner B'), agent('Planner C')],
    synthesizer: agent('Synthesizer'),
  };
}

test('Plan Council prepares all sessions, materializes artifacts, gates phases, and completes without subscriptions', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-');
  try {
    const councilInput = input(process.cwd());
    councilInput.idempotencyKey = 'plan-council-primary-once';
    const started = await runtime.startPlanCouncil(councilInput);
    assert.equal(Object.keys(started.participantSessionIds).length, 4);
    assert.ok(
      ['drafting-plans', 'ready-for-cross-review'].includes(started.council.phase),
      'fast providers may finish before the atomic start command returns',
    );
    assert.equal(Object.keys(started.state.subscriptions ?? {}).length, 0);
    for (const sessionId of Object.values(started.participantSessionIds)) {
      assert.equal(started.state.sessions[sessionId].runtimeSettings.sandbox, 'read-only');
    }

    const proposalsReady = await waitFor('all proposals', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'ready-for-cross-review' ? council : undefined;
    });
    const repeatedStart = await runtime.startPlanCouncil(councilInput);
    assert.equal(repeatedStart.workflowId, started.workflowId);
    assert.equal(Object.keys(runtime.getState().sessions).length, 4);
    assert.equal(repeatedStart.council.artifacts.length, 3, 'start retry does not duplicate artifacts');
    assert.equal(proposalsReady.artifacts.filter((artifact) => artifact.kind === 'proposal').length, 3);
    const proposals = proposalsReady.artifacts.filter((artifact) => artifact.kind === 'proposal');
    assert.ok(proposals.every((artifact) => artifact.version === 1));
    assert.equal(new Set(proposals.map((artifact) => artifact.contentRef)).size, proposals.length);
    await assert.rejects(
      runtime.startPlanCouncilSynthesis({ workflowId: started.workflowId }),
      /peer reviews must be ready/,
    );

    await runtime.startPlanCouncilCrossReview({ workflowId: started.workflowId });
    const repeatedCrossReview = await runtime.startPlanCouncilCrossReview({ workflowId: started.workflowId });
    assert.ok(
      ['reviewing-peers', 'ready-for-synthesis'].includes(repeatedCrossReview.council.phase),
    );
    const reviewsReady = await waitFor('all peer reviews', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'ready-for-synthesis' ? council : undefined;
    });
    assert.equal(reviewsReady.artifacts.filter((artifact) => artifact.kind === 'peer-review').length, 3);
    const plannerIds = reviewsReady.participantOrder.filter(
      (id) => reviewsReady.participants[id].role === 'planner',
    );
    for (const plannerId of plannerIds) {
      const reviewArtifact = reviewsReady.artifacts.find(
        (artifact) => artifact.kind === 'peer-review' && artifact.authorSessionId === plannerId,
      );
      const content = runtime.getPlanCouncilArtifact({
        workflowId: started.workflowId,
        artifactId: reviewArtifact.artifactId,
      }).content;
      assert.match(content, /proposal:/, 'activation includes peer proposal deliveries');
      for (const peerId of plannerIds.filter((id) => id !== plannerId)) {
        assert.match(content, new RegExp(`proposal:${peerId}`), 'each peer topic remains independently addressable');
      }
    }

    await runtime.startPlanCouncilSynthesis({ workflowId: started.workflowId });
    const completed = await waitFor('synthesis', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'completed' ? council : undefined;
    });
    assert.equal(completed.artifacts.filter((artifact) => artifact.kind === 'synthesis').length, 1);
    assert.equal(runtime.getState().sessions[completed.synthesizerSessionId].status, 'idle');
    const councilUsage = runtime.getState().usageFacts.filter((fact) => completed.participantOrder.includes(fact.sessionId));
    assert.equal(councilUsage.length, 7, 'each Plan Council provider turn has a durable usage fact');
    assert.equal(councilUsage.reduce((sum, fact) => sum + fact.totalTokens, 0), 126);
    assert.equal(runtime.getState().runQueue.length, 0);
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 0);
    const repeatedSynthesis = await runtime.startPlanCouncilSynthesis({ workflowId: started.workflowId });
    assert.equal(repeatedSynthesis.council.artifacts.length, 7);

    const events = runtime.getKernelEvents({ limit: 500 }).events;
    assert.equal(events.filter((event) => event.type === 'council.artifact.created').length, 7);
    assert.equal(Object.keys(runtime.getState().subscriptions ?? {}).length, 0);
  } finally {
    cleanup();
  }
});

test('auto-gated Council advances proposal through review and synthesis with one correlated release per phase', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-auto-');
  try {
    const councilInput = input(process.cwd());
    councilInput.planners = councilInput.planners.slice(0, 2);
    councilInput.advancement = { crossReview: 'auto', synthesis: 'auto' };
    const started = await runtime.startPlanCouncil(councilInput);
    const completed = await waitFor('auto Council completion', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'completed' ? council : undefined;
    });
    assert.deepEqual(completed.advancement, { crossReview: 'auto', synthesis: 'auto' });
    assert.equal(completed.artifacts.length, 5);
    assert.ok(completed.artifacts.every((artifact) => artifact.execution?.correlationKey));
    const barriers = Object.values(runtime.getState().barriers).filter(
      (barrier) => barrier.runId === completed.runId,
    );
    assert.deepEqual(
      barriers.map((barrier) => barrier.phaseId).sort(),
      ['peer-review', 'proposal', 'synthesis'],
    );
    assert.ok(barriers.every((barrier) => barrier.status === 'released'));
    const releases = runtime.getKernelEvents({ type: 'barrier.released' }).events.filter(
      (event) => event.payload.runId === completed.runId,
    );
    assert.equal(releases.length, 3);
  } finally {
    cleanup();
  }
});

test('Plan Council obeys the global resource fan-out policy before creating participants', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-fanout-');
  try {
    await runtime.dispatchCommand({ commandId: 'council-fanout-cap', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxFanout: 1 } });
    await assert.rejects(runtime.startPlanCouncil(input(process.cwd())), /fan-out 3 exceeds global resource policy 1/);
    assert.equal(Object.keys(runtime.getState().sessions).length, 0);
  } finally { cleanup(); }
});

test('a hard budget blocks Council without discarding peers and human retry resumes the same Barrier', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-budget-retry-', {
    toolActivityCount: (turn) => turn.runtimeSettings?.model === 'Planner C-model' ? 2 : 0,
  });
  try {
    await runtime.dispatchCommand({
      commandId: 'council-hard-budget', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxToolCallsPerTurn: 1, consumptionEnforcement: 'hard' },
    });
    const started = await runtime.startPlanCouncil(input(process.cwd()));
    const blocked = await waitFor('budget-blocked Council', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'blocked' ? council : undefined;
    });
    const proposalBarrierId = blocked.barrierIds.proposal;
    assert.equal(runtime.getState().barriers[proposalBarrierId].status, 'pending');
    assert.match(blocked.blockReason, /configured resource budget/i);
    await waitFor('successful peer artifacts survive', () =>
      runtime.getState().planCouncils[started.workflowId].artifacts.filter((artifact) => artifact.kind === 'proposal').length === 2,
    );
    assert.equal(runtime.getState().planCouncils[started.workflowId].phase, 'blocked');

    await runtime.dispatchCommand({
      commandId: 'retry-budget-participant', kind: 'retry_plan_council_participant', actor: { kind: 'human' },
      input: { workflowId: started.workflowId, disableConsumptionBudget: true },
    });
    const recovered = await waitFor('retried proposal Barrier release', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'ready-for-cross-review' ? council : undefined;
    });
    assert.equal(recovered.artifacts.filter((artifact) => artifact.kind === 'proposal').length, 3);
    assert.equal(runtime.getState().barriers[proposalBarrierId].status, 'released', 'retry continues the original generation');
    assert.equal(runtime.getState().resourcePolicies.global.consumptionEnforcement, 'off');
    assert.equal(runtime.getKernelEvents({ type: 'council.participant-retried' }).events.length, 1);
  } finally { cleanup(); }
});

test('an ordinary provider failure while Council is budget-blocked remains terminal and cancels the Barrier', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-mixed-failure-', {
    toolActivityCount: (turn) => turn.prompt?.includes('Cross-review') && turn.runtimeSettings?.model === 'Planner A-model' ? 2 : 0,
    failAfterStartWhen: (turn) => turn.prompt?.includes('Cross-review') && turn.runtimeSettings?.model === 'Planner C-model',
  });
  try {
    await runtime.dispatchCommand({
      commandId: 'mixed-hard-budget', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxToolCallsPerTurn: 1, consumptionEnforcement: 'hard' },
    });
    const started = await runtime.startPlanCouncil(input(process.cwd()));
    await waitFor('proposals before mixed cross-review failure', () =>
      runtime.getState().planCouncils[started.workflowId]?.phase === 'ready-for-cross-review');
    try {
      await runtime.startPlanCouncilCrossReview({ workflowId: started.workflowId });
    } catch (error) {
      assert.match(String(error), /Resource budget exhausted|failed after start/i);
    }
    const failed = await waitFor('mixed failure Council terminal state', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'failed' ? council : undefined;
    });
    assert.match(failed.failure, /Planner C.*failed|configured failure/i);
    assert.equal(runtime.getState().barriers[failed.barrierIds['peer-review']].status, 'cancelled');
    assert.equal(runtime.getKernelEvents({ type: 'council.failed' }).events.length, 1);
  } finally { cleanup(); }
});

test('large Council uses one synthesizer review hub instead of planner full mesh', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-hub-');
  try {
    const councilInput = input(process.cwd());
    councilInput.planners = ['A', 'B', 'C', 'D', 'E'].map((key) => agent(`Planner ${key}`));
    councilInput.reviewTopology = 'hub-and-spoke';
    councilInput.advancement = { crossReview: 'auto', synthesis: 'auto' };
    const started = await runtime.startPlanCouncil(councilInput);
    const completed = await waitFor('hub Council completion', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'completed' ? council : undefined;
    });
    assert.equal(completed.reviewTopology, 'hub-and-spoke');
    assert.equal(completed.artifacts.filter((artifact) => artifact.kind === 'proposal').length, 5);
    const reviews = completed.artifacts.filter((artifact) => artifact.kind === 'peer-review');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].authorSessionId, completed.synthesizerSessionId);
    assert.equal(completed.artifacts.filter((artifact) => artifact.kind === 'synthesis').length, 1);
    const reviewBarrier = runtime.getState().barriers[completed.barrierIds['peer-review']];
    assert.deepEqual(reviewBarrier.expectedParticipantKeys, [completed.participants[completed.synthesizerSessionId].key]);
  } finally {
    cleanup();
  }
});

test('zero-latency Council providers receive their envelope before completion can arrive', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-zero-');
  try {
    const councilInput = input(process.cwd());
    councilInput.objective += ' ORRERY_ZERO';
    councilInput.planners = councilInput.planners.slice(0, 2);
    councilInput.advancement = { crossReview: 'auto', synthesis: 'auto' };
    const started = await runtime.startPlanCouncil(councilInput);
    const completed = await waitFor('zero-latency Council completion', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'completed' ? council : undefined;
    });
    assert.equal(completed.artifacts.length, 5);
    assert.ok(completed.artifacts.every((artifact) => artifact.execution?.activationId));
  } finally {
    cleanup();
  }
});

test('Council artifact and Barrier release commit atomically before artifact outbox recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-plan-council-artifact-outbox-'));
  const storageFile = path.join(root, 'state.json');
  let runtime = new RuntimeSessionManager({
    storageFile,
    providerAdapters: deterministicProviderAdapters(),
    controlCommandCrashBeforeEffectDrain: true,
  });
  try {
    const councilInput = input(process.cwd());
    councilInput.planners = councilInput.planners.slice(0, 2);
    const started = await runtime.startPlanCouncil(councilInput);
    await waitFor('committed proposal Barrier despite effect-drain crash', () =>
      runtime.getState().planCouncils[started.workflowId]?.phase === 'ready-for-cross-review');
    const releaseCount = runtime.getKernelEvents({ type: 'barrier.released' }).events.filter(
      (event) => event.payload.runId === started.runId,
    ).length;
    assert.equal(releaseCount, 1);
    runtime.killAll();
    runtime = new RuntimeSessionManager({
      storageFile,
      providerAdapters: deterministicProviderAdapters(),
    });
    const restored = runtime.getState().planCouncils[started.workflowId];
    assert.equal(restored.phase, 'ready-for-cross-review');
    assert.equal(
      runtime.getKernelEvents({ type: 'barrier.released' }).events.filter(
        (event) => event.payload.runId === started.runId,
      ).length,
      1,
    );
    for (const artifact of restored.artifacts) {
      assert.match(runtime.getPlanCouncilArtifact({
        workflowId: started.workflowId,
        artifactId: artifact.artifactId,
      }).content, /handled:/);
    }
    const materialized = runtime.getKernelEvents({ type: 'council.artifact.materialized' }).events;
    assert.equal(materialized.length, restored.artifacts.length);
    assert.ok(materialized.every((event) => event.payload.execution?.correlationKey));
  } finally {
    runtime.killAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plan Council start failure unwinds every prepared and already-started session', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-unwind-');
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'broken-planner',
      kind: 'claude-code',
      label: 'Broken planner',
      binaryPath: '/definitely/missing/orrery-provider',
    });
    const councilInput = input(process.cwd());
    councilInput.planners[1] = agent('Broken', 'broken-planner');
    await assert.rejects(runtime.startPlanCouncil(councilInput), /failed|could not start/i);
    const state = runtime.getState();
    assert.equal(Object.keys(state.sessions).length, 0);
    assert.equal(Object.keys(state.planCouncils ?? {}).length, 0);
    assert.equal(state.nodes.length, 0);
  } finally {
    cleanup();
  }
});

test('stopped Plan Council never starts another phase and ignores settling turns', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-stop-');
  try {
    const councilInput = input(process.cwd());
    councilInput.objective += ' ORRERY_DELAY';
    const started = await runtime.startPlanCouncil(councilInput);
    const stopped = runtime.stopPlanCouncil({ workflowId: started.workflowId });
    assert.equal(stopped.council.phase, 'stopped');
    await assert.rejects(
      runtime.startPlanCouncilCrossReview({ workflowId: started.workflowId }),
      /all proposals must be ready/,
    );
    await delay(650);
    assert.equal(runtime.getState().planCouncils[started.workflowId].phase, 'stopped');
    assert.equal(runtime.getState().planCouncils[started.workflowId].artifacts.length, 0);
  } finally {
    cleanup();
  }
});

test('completed Council projection and artifact references survive a runtime restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-plan-council-restart-'));
  const storageFile = path.join(root, 'state.json');
  let runtime = new RuntimeSessionManager({
    storageFile,
    providerAdapters: deterministicProviderAdapters(),
  });
  try {
    const councilInput = input(process.cwd());
    councilInput.planners = councilInput.planners.slice(0, 2);
    const started = await runtime.startPlanCouncil(councilInput);
    await waitFor('restart proposals', () => runtime.getState().planCouncils[started.workflowId]?.phase === 'ready-for-cross-review');
    await runtime.startPlanCouncilCrossReview({ workflowId: started.workflowId });
    await waitFor('restart reviews', () => runtime.getState().planCouncils[started.workflowId]?.phase === 'ready-for-synthesis');
    await runtime.startPlanCouncilSynthesis({ workflowId: started.workflowId });
    const completed = await waitFor('restart synthesis', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'completed' ? council : undefined;
    });
    const synthesis = completed.artifacts.find((artifact) => artifact.kind === 'synthesis');
    runtime.killAll();
    runtime = new RuntimeSessionManager({
      storageFile,
      providerAdapters: deterministicProviderAdapters(),
    });
    assert.equal(runtime.getState().planCouncils[started.workflowId].phase, 'completed');
    assert.match(
      runtime.getPlanCouncilArtifact({ workflowId: started.workflowId, artifactId: synthesis.artifactId }).content,
      /Synthesizer/,
    );
  } finally {
    runtime.killAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross-review startup failure rejects the gate action and fails the Council', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-phase-fail-', {
    failWhen: ({ prompt }) => prompt?.includes('Cross-review the other planners'),
  });
  try {
    const started = await runtime.startPlanCouncil(input(process.cwd()));
    await waitFor('proposals before failed cross-review', () =>
      runtime.getState().planCouncils[started.workflowId]?.phase === 'ready-for-cross-review');
    await assert.rejects(
      runtime.startPlanCouncilCrossReview({ workflowId: started.workflowId }),
      /configured failure/i,
    );
    const council = runtime.getState().planCouncils[started.workflowId];
    assert.equal(council.phase, 'failed');
    assert.match(council.failure, /configured failure/i);
  } finally {
    cleanup();
  }
});

test('a completed turn without current assistant text cannot reuse an older session result', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-empty-', {
    noOutputWhen: ({ prompt }) => prompt?.includes('independent Planner'),
  });
  try {
    const started = await runtime.startPlanCouncil(input(process.cwd()));
    const failed = await waitFor('empty proposal failure', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'failed' ? council : undefined;
    });
    assert.match(failed.failure, /without a readable proposal response/i);
    assert.equal(failed.artifacts.length, 0);
  } finally {
    cleanup();
  }
});

test('oversized Council artifacts fail the Council instead of entering the artifact store', async () => {
  const { runtime, cleanup } = harness('orrery-plan-council-oversized-', {
    oversizedOutputWhen: ({ prompt }) => prompt?.includes('independent Planner'),
  });
  try {
    const started = await runtime.startPlanCouncil(input(process.cwd()));
    const failed = await waitFor('oversized proposal failure', () => {
      const council = runtime.getState().planCouncils[started.workflowId];
      return council?.phase === 'failed' ? council : undefined;
    });
    assert.match(failed.failure, /limit is 131072 bytes/i);
    assert.equal(failed.artifacts.length, 0);
  } finally {
    cleanup();
  }
});

test('runtime restart fails a Council whose expected participant turn was interrupted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-plan-council-interrupted-'));
  const storageFile = path.join(root, 'state.json');
  const first = new RuntimeSessionManager({
    storageFile,
    providerAdapters: deterministicProviderAdapters(),
  });
  let recovered;
  try {
    const councilInput = input(process.cwd());
    councilInput.objective += ' ORRERY_SLEEP';
    const started = await first.startPlanCouncil(councilInput);
    assert.equal(first.getState().planCouncils[started.workflowId].phase, 'drafting-plans');
    recovered = new RuntimeSessionManager({
      storageFile,
      providerAdapters: deterministicProviderAdapters(),
    });
    const council = recovered.getState().planCouncils[started.workflowId];
    assert.equal(council.phase, 'failed');
    assert.match(council.failure, /interrupted by runtime restart/i);
    assert.ok(
      recovered.getKernelEvents({ limit: 200 }).events.some(
        (event) => event.type === 'council.failed' && event.payload.workflowId === started.workflowId,
      ),
    );
  } finally {
    recovered?.killAll();
    first.killAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid persisted Plan Council records are skipped with a recovery diagnostic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-plan-council-corrupt-'));
  const storageFile = path.join(root, 'state.json');
  let runtime = new RuntimeSessionManager({
    storageFile,
    providerAdapters: deterministicProviderAdapters(),
  });
  try {
    runtime.killAll();
    const database = new DatabaseSync(storageFile.replace(/\.json$/, '.sqlite'));
    const row = database.prepare('SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1').get();
    const state = JSON.parse(row.state);
    state.planCouncils = {
      corrupt: {
        workflowId: 'corrupt',
        runId: 'run-corrupt',
        objective: 'bad persisted record',
        cwd: process.cwd(),
        phase: 'not-a-phase',
        participantOrder: ['missing'],
        participants: {},
        artifacts: [{ kind: 'proposal', sizeBytes: 999999 }],
        history: [],
      },
    };
    database.prepare('UPDATE snapshots SET state = ? WHERE seq = ?').run(JSON.stringify(state), row.seq);
    database.prepare('UPDATE runtime_state SET state = ? WHERE singleton = 1').run(JSON.stringify(state));
    database.close();
    runtime = new RuntimeSessionManager({
      storageFile,
      providerAdapters: deterministicProviderAdapters(),
    });
    assert.deepEqual(runtime.getState().planCouncils, {});
    assert.ok(runtime.getState().diagnostics.some((item) => item.type === 'storage.plan_council_skipped'));
  } finally {
    runtime.killAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['prepared', 'resources-created', 'graph-committed', 'roots-started']) {
  test(`Plan Council restart reconciliation fully aborts a deployment interrupted after ${stage}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `orrery-plan-council-deployment-${stage}-`));
    const storageFile = path.join(root, 'state.json');
    const first = new RuntimeSessionManager({
      storageFile,
      providerAdapters: deterministicProviderAdapters(),
      workflowDeploymentCrashAfterStage: stage,
    });
    let recovered;
    try {
      const councilInput = input(process.cwd());
      councilInput.objective += ' ORRERY_SLEEP';
      await assert.rejects(
        first.startPlanCouncil(councilInput),
        new RegExp(`Injected workflow deployment crash after ${stage}`),
      );
      const inProgress = first.getWorkflowDeployments({ status: 'in_progress' }).deployments;
      assert.equal(inProgress.length, 1);
      assert.equal(inProgress[0].stage, stage);

      recovered = new RuntimeSessionManager({
        storageFile,
        providerAdapters: deterministicProviderAdapters(),
      });
      const state = recovered.getState();
      assert.equal(Object.keys(state.planCouncils ?? {}).length, 0);
      assert.equal(Object.keys(state.sessions).length, 0);
      assert.equal(state.nodes.length, 0);
      assert.equal(state.edges.length, 0);
      const deployments = recovered.getWorkflowDeployments().deployments;
      assert.equal(deployments.length, 1);
      assert.equal(deployments[0].status, 'aborted');
      assert.equal(deployments[0].stage, 'aborted');
      assert.ok(
        recovered.getKernelEvents({ limit: 500 }).events.some(
          (event) =>
            event.type === 'workflow.deployment.aborted' &&
            event.payload.deploymentId === deployments[0].deploymentId,
        ),
      );
    } finally {
      recovered?.killAll();
      first.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
