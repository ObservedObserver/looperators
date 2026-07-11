import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'review-workflow-cold-start';
export const description =
  'Interaction P1 acceptance: from an empty runtime, one Review Workflow start payload creates a Coder and a provider-cold Reviewer, installs both guarded relationships before the first Coder turn, then honestly runs issues → fix → clean against a real git diff.';
export const timeoutMs = 900_000;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=orrery-acceptance', '-c', 'user.email=acceptance@orrery.local', ...args], { cwd, encoding: 'utf8' }).trim();
}

export async function run({ orrery, provider, workDir, log }) {
  fs.writeFileSync(
    path.join(workDir, 'SPEC.md'),
    [
      '# greet.js spec',
      '',
      'greet(name) must return exactly: `Hello, <NAME>!`',
      '- The prefix is "Hello, " — the word Hello, a comma, one space.',
      '- `<NAME>` is the name argument converted to UPPER CASE.',
      '- The string ends with exactly one exclamation mark.',
      '',
      "Example: greet('Ada') === 'Hello, ADA!'",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(workDir, 'greet.js'), "export function greet(name) {\n  return 'Hi ' + name;\n}\n");
  git(workDir, 'init', '-b', 'main');
  git(workDir, 'add', '.');
  git(workDir, 'commit', '-m', 'baseline: greet.js violates SPEC.md');

  const before = await orrery.state();
  assert.equal(Object.keys(before.sessions ?? {}).length, 0, 'the scenario starts with no Session');

  const started = await orrery.startReviewWorkflow({
    coder: {
      kind: 'new',
      label: 'Cold-start Coder',
      prompt: [
        'Step 1 of a two-step refactor: in greet.js, change the greeting word from Hi to Hello.',
        'Make ONLY this change in this turn — the remaining spec work in SPEC.md is intentionally left for review. Do not touch anything else.',
        'Then reply with one line: step 1 done, SPEC.md defines the remaining requirements. And stop.',
      ].join('\n'),
      cwd: workDir,
      workMode: 'local',
      ...provider,
      providerInstanceId:
        provider.providerKind === 'codex' ? 'default-codex' : provider.providerKind === 'claude-code' ? 'default-claude-sdk' : 'claude-code',
      runtimeSettings: { runtimeMode: 'full-access' },
    },
    reviewer: {
      kind: 'new',
      label: 'Cold-start Reviewer',
      instruction: [
        'Review the implementation against SPEC.md and the real delivered workspace diff.',
        'A failure to satisfy any explicit SPEC.md requirement is a P1 correctness issue. Run focused checks if useful.',
      ].join('\n'),
      ...provider,
      providerInstanceId:
        provider.providerKind === 'codex' ? 'default-codex' : provider.providerKind === 'claude-code' ? 'default-claude-sdk' : 'claude-code',
      runtimeSettings: { runtimeMode: 'full-access' },
    },
    blocking: { mode: 'p0-p1' },
    maxLaps: 4,
  });

  assert.equal(started.createdSessionIds.length, 2);
  assert.equal(started.subscriptionIds.length, 2);
  assert.ok(started.loop, 'the atomic result includes the loop projection');
  const coderId = started.coderSessionId;
  const reviewerId = started.reviewerSessionId;
  const [passId, fixId] = started.subscriptionIds;
  assert.equal(fixId, passId.replace('review-pass-', 'review-fix-'));
  log(`atomic start: coder ${coderId}, reviewer ${reviewerId}, edges ${passId} / ${fixId}`);

  const state0 = await orrery.state();
  assert.equal(state0.sessions[reviewerId].cwd, state0.sessions[coderId].cwd);
  assert.equal(
    state0.sessions[reviewerId].messages.filter((message) => message.role === 'assistant').length,
    0,
    'Reviewer has no synthetic ready response at workflow start',
  );
  for (const id of [passId, fixId]) {
    assert.deepEqual(state0.subscriptions[id].stop, {
      whenReport: { verdict: 'clean' },
      maxFirings: 4,
    });
  }
  assert.match(state0.subscriptions[passId].action.note, /Only P0 or P1 issues are blocking/);

  const issuesReport = await orrery.waitForReport({ verdict: 'issues' }, { timeoutMs: 420_000 });
  assert.equal(issuesReport.from, reviewerId);
  log('lap 1: Reviewer reported earned P1 issues from the real diff');

  const cleanReport = await orrery.waitFor(
    'clean verdict before cap',
    async () => {
      const state = await orrery.state();
      const clean = (state.reports ?? []).find((report) => report.from === reviewerId && report.payload?.verdict === 'clean');
      if (clean) return { done: true, value: clean };
      if (state.subscriptions[passId]?.state === 'stopped' && state.subscriptions[fixId]?.state === 'stopped') {
        throw new Error('review ring reached its cap without a clean verdict');
      }
      return {
        detail: `${state.subscriptions[passId]?.state}/${state.subscriptions[fixId]?.state}`,
      };
    },
    { timeoutMs: 600_000 },
  );
  assert.equal(cleanReport.from, reviewerId);

  await orrery.waitFor('paired edges stop', async () => {
    const state = await orrery.state();
    return state.subscriptions[passId]?.state === 'stopped' && state.subscriptions[fixId]?.state === 'stopped'
      ? { done: true }
      : { detail: 'waiting for paired stop' };
  });

  for (const session of Object.values((await orrery.state()).sessions)) {
    if (session.status === 'running' || session.status === 'pending') {
      await orrery.waitForIdle(session.sessionId);
    }
  }

  fs.writeFileSync(
    path.join(workDir, 'check.mjs'),
    [
      "import assert from 'node:assert/strict'",
      "import { greet } from './greet.js'",
      "assert.equal(greet('Ada'), 'Hello, ADA!')",
      "console.log('spec check passed')",
      '',
    ].join('\n'),
  );
  execFileSync('node', ['check.mjs'], { cwd: workDir, stdio: 'pipe' });

  const state = await orrery.state();
  const ring = (state.loops ?? []).find((candidate) => candidate.loopId === started.loop.loopId);
  assert.equal(ring?.status, 'stopped');
  assert.ok(ring.lapCount <= 4);
  const reviewerAssistantTurns = state.sessions[reviewerId].messages.filter((message) => message.role === 'assistant');
  assert.equal(reviewerAssistantTurns.length, 2, 'Reviewer ran only issues and clean turns');

  const { events } = await orrery.kernelEvents({ limit: 5000 });
  const authoredSeqs = events
    .filter((event) => event.type === 'subscription.authored' && started.subscriptionIds.includes(event.payload?.subscription?.id))
    .map((event) => event.seq);
  const firstCoderFinished = events.find((event) => event.type === 'session.finished' && event.payload?.sessionId === coderId);
  assert.equal(authoredSeqs.length, 2);
  assert.ok(Math.max(...authoredSeqs) < firstCoderFinished.seq);

  for (const session of Object.values(state.sessions)) {
    assert.equal(session.status === 'running' || session.status === 'pending', false, `session ${session.label} must be settled before pass`);
  }
  log(`cold-start ring verified: issues → fix → clean in ${ring.lapCount} lap(s)`);
}
