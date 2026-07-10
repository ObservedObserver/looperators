import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js';
import { deriveLoopProductView } from '../../dist-electron/shared/loop-product.js';

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
const prompt = readArg('-p') ?? ''
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
emit({ type: 'assistant', session_id: backendSessionId, message: { content: [{ type: 'text', text: 'handled: ' + prompt.slice(0, 80) }] } })
emit({ type: 'result', session_id: backendSessionId, result: 'done' })
`;

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

function harness(prefix, runtimeOptions = {}, providerSource = fakeClaudeSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fakeClaude = path.join(root, 'claude');
  fs.writeFileSync(fakeClaude, providerSource);
  fs.chmodSync(fakeClaude, 0o755);
  process.env.ORRERY_CLAUDE_BIN = fakeClaude;
  const runtime = new RuntimeSessionManager({ storageFile: path.join(root, 'state.json'), ...runtimeOptions });
  return {
    root,
    runtime,
    cleanup() {
      runtime.killAll();
      delete process.env.ORRERY_CLAUDE_BIN;
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
      providerKind: 'legacy-claude-cli',
      providerInstanceId: 'legacy-claude-cli',
      runtimeSettings: { runtimeMode: 'approval-required', model: 'coder-model' },
    },
    reviewer: {
      kind: 'new',
      label: 'Cold Reviewer',
      instruction: 'Review the real diff against SPEC.md.',
      providerKind: 'legacy-claude-cli',
      providerInstanceId: 'review-legacy',
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
      providerInstanceId: 'review-legacy',
      kind: 'legacy-claude-cli',
      label: 'Review legacy',
    });
    const started = await runtime.startReviewWorkflow(input(process.cwd()));
    assert.equal(started.createdSessionIds.length, 2);
    assert.equal(started.subscriptionIds.length, 2);
    assert.ok(started.loop);

    const initial = runtime.getState();
    assert.equal(initial.sessions[started.coderSessionId].runtimeSettings.model, 'coder-model');
    assert.equal(initial.sessions[started.reviewerSessionId].providerInstanceId, 'review-legacy');
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
      providerInstanceId: 'review-legacy',
      kind: 'legacy-claude-cli',
      label: 'Review legacy',
    });
    const before = runtime.getState();
    const invalidReviewerProvider = input(process.cwd());
    invalidReviewerProvider.reviewer.providerInstanceId = 'default-codex';
    await assert.rejects(
      runtime.startReviewWorkflow(invalidReviewerProvider),
      /default-codex is codex, not legacy-claude-cli/,
    );
    const after = runtime.getState();
    assert.deepEqual(Object.keys(after.sessions), Object.keys(before.sessions));
    assert.deepEqual(Object.keys(after.subscriptions ?? {}), Object.keys(before.subscriptions ?? {}));
    assert.equal(after.nodes.length, before.nodes.length);
  } finally {
    cleanup();
  }
});

test('a participant failure identifies the failed Reviewer and workflow phase headlessly', async () => {
  const failingReviewerSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
const prompt = readArg('-p') ?? ''
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (prompt.includes('Blocking rule:')) {
  process.stderr.write('review provider failed before verdict\\n')
  process.exitCode = 2
} else {
  emit({ type: 'assistant', session_id: backendSessionId, message: { content: [{ type: 'text', text: 'coder done' }] } })
  emit({ type: 'result', session_id: backendSessionId, result: 'done' })
}
`;
  const { runtime, cleanup } = harness('orrery-review-workflow-failure-', {}, failingReviewerSource);
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'review-legacy',
      kind: 'legacy-claude-cli',
      label: 'Review legacy',
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
