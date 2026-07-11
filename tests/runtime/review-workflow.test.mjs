import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js';
import { deriveLoopProductView } from '../../dist-electron/shared/loop-product.js';
import { deterministicProviderAdapters } from './support/deterministic-provider.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function harness(prefix, runtimeOptions = {}, failReviewer = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = new BaseRuntimeSessionManager({
    storageFile: path.join(root, 'state.json'),
    providerAdapters: deterministicProviderAdapters({
      failWhen: (input) => failReviewer && input.prompt?.includes('Blocking rule:'),
    }),
    ...runtimeOptions,
  });
  return {
    root,
    runtime,
    cleanup() {
      runtime.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function input(cwd, overrides = {}) {
  return {
    coder: {
      kind: 'new',
      label: 'Cold Coder',
      prompt: 'Implement the change.',
      cwd,
      workMode: 'local',
      providerKind: 'claude-code',
      providerInstanceId: 'default-claude-sdk',
      runtimeSettings: { runtimeMode: 'approval-required', model: 'coder-model' },
    },
    reviewer: {
      kind: 'new',
      label: 'Cold Reviewer',
      instruction: 'Review the real diff against SPEC.md.',
      providerKind: 'claude-code',
      providerInstanceId: 'review-sdk',
      runtimeSettings: { runtimeMode: 'full-access', model: 'review-model' },
    },
    blocking: { mode: 'p0-p1' },
    maxLaps: 6,
    ...overrides,
  };
}

test('cold start installs the full ring before Coder runs and Reviewer has no ready turn', async () => {
  const { runtime, cleanup } = harness('orrery-review-workflow-');
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'review-sdk',
      kind: 'claude-code',
      label: 'Review SDK',
    });
    const started = await runtime.startReviewWorkflow(input(process.cwd()));
    assert.equal(started.createdSessionIds.length, 2);
    assert.equal(started.subscriptionIds.length, 2);
    assert.ok(started.loop);

    const initial = runtime.getState();
    assert.equal(initial.sessions[started.coderSessionId].runtimeSettings.model, 'coder-model');
    assert.equal(initial.sessions[started.reviewerSessionId].providerInstanceId, 'review-sdk');
    assert.equal(initial.sessions[started.reviewerSessionId].providerKind, 'claude-code');
    assert.equal(initial.sessions[started.reviewerSessionId].backend, 'claude-agent-sdk');
    assert.equal(initial.sessions[started.reviewerSessionId].runtimeSettings.model, 'review-model');
    assert.match(
      initial.sessions[started.coderSessionId].messages.find((message) => message.role === 'user')?.content ?? '',
      /already created and connected the Reviewer/,
    );

    await assert.rejects(
      runtime.handleMembraneRequest({
        tool: 'create_session',
        source: started.coderSessionId,
        input: { prompt: 'Create a redundant reviewer.' },
      }),
      /already assigned to an active Review until clean workflow/,
    );
    assert.equal(Object.keys(runtime.getState().sessions).length, 2, 'the review pair cannot spawn a third session');

    await waitFor('Reviewer first real review turn', () => {
      const session = runtime.getState().sessions[started.reviewerSessionId];
      return session?.status === 'idle' && session.messages.some((message) => message.role === 'assistant');
    });
    const state = runtime.getState();
    const reviewer = state.sessions[started.reviewerSessionId];
    assert.equal(reviewer.messages.filter((message) => message.role === 'assistant').length, 1, 'the only Reviewer turn is the diff review; no ready turn ran');
    assert.match(reviewer.messages.find((message) => message.role === 'user' && /Blocking rule/.test(message.content))?.content ?? '', /Only P0 or P1/);

    const events = runtime.getKernelEvents({ limit: 500 }).events;
    const authoredSeqs = events
      .filter((event) => event.type === 'subscription.authored' && started.subscriptionIds.includes(event.payload?.subscription?.id))
      .map((event) => event.seq);
    const coderFinished = events.find((event) => event.type === 'session.finished' && event.payload?.sessionId === started.coderSessionId);
    assert.equal(authoredSeqs.length, 2);
    assert.ok(coderFinished);
    assert.ok(Math.max(...authoredSeqs) < coderFinished.seq, 'both relationships precede the first Coder finish');
  } finally {
    cleanup();
  }
});

test('a start failure after the first participant exists unwinds the live graph', async () => {
  const { runtime, cleanup } = harness('orrery-review-workflow-unwind-');
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'review-sdk',
      kind: 'claude-code',
      label: 'Review SDK',
    });
    const before = runtime.getState();
    const invalidReviewerProvider = input(process.cwd());
    invalidReviewerProvider.reviewer.providerInstanceId = 'default-codex';
    await assert.rejects(
      runtime.startReviewWorkflow(invalidReviewerProvider),
      /default-codex is codex, not claude-code/,
    );
    const after = runtime.getState();
    assert.deepEqual(Object.keys(after.sessions), Object.keys(before.sessions));
    assert.deepEqual(Object.keys(after.subscriptions ?? {}), Object.keys(before.subscriptions ?? {}));
    assert.equal(after.nodes.length, before.nodes.length);
  } finally {
    cleanup();
  }
});

test('parallel Review starts lock shared existing Agents before creating a second ring', async () => {
  const { runtime, cleanup } = harness('orrery-review-workflow-lock-');
  try {
    runtime.upsertProviderInstance({ providerInstanceId: 'review-sdk', kind: 'claude-code', label: 'Review SDK' });
    const existing = await runtime.createSession({
      prompt: 'Prepare the workspace.', cwd: process.cwd(),
      providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk',
    });
    await waitFor('existing Coder becomes idle', () => runtime.getState().sessions[existing.sessionId]?.status === 'idle');
    const reviewInput = input(process.cwd(), {
      coder: { kind: 'existing', sessionId: existing.sessionId, prompt: 'Implement the change.' },
    });
    const results = await Promise.allSettled([
      runtime.startReviewWorkflow(reviewInput),
      runtime.startReviewWorkflow(reviewInput),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /already being changed/);
    assert.equal(runtime.getState().loops.filter((loop) => loop.kind === 'review').length, 1);
  } finally {
    cleanup();
  }
});

test('a participant failure identifies the failed Reviewer and workflow phase headlessly', async () => {
  const { runtime, cleanup } = harness('orrery-review-workflow-failure-', {}, true);
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'review-sdk',
      kind: 'claude-code',
      label: 'Review SDK',
    });
    const started = await runtime.startReviewWorkflow(input(process.cwd()));
    await waitFor(
      'Reviewer failure',
      () => runtime.getState().sessions[started.reviewerSessionId]?.status === 'failed',
    );
    const state = runtime.getState();
    const loop = state.loops.find((candidate) => candidate.loopId === started.loop.loopId);
    const timeline = runtime.getLoopTimeline({ loopId: loop.loopId }).timeline;
    const product = deriveLoopProductView({
      loop,
      sessions: state.sessions,
      subscriptions: state.subscriptions,
      reports: state.reports,
      timeline,
    });
    assert.equal(product.phase, 'failed');
    assert.equal(product.responsibleSessionId, started.reviewerSessionId);
    assert.match(product.headline, /Reviewer failed/);
    assert.equal(product.canRetry, false);
  } finally {
    cleanup();
  }
});
