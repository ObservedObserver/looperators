import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'graph-authoring-dynamic';
export const description =
  'Interaction P3 headless acceptance: current-result is an immediate command, next-completion ignores history, and a real completed Coder can be connected to a newly created Reviewer loop.';
export const timeoutMs = 900_000;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=orrery-acceptance', '-c', 'user.email=acceptance@orrery.local', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function providerInstanceId(providerKind) {
  return providerKind === 'codex' ? 'default-codex' : providerKind === 'grok' ? 'default-grok' : 'default-claude-sdk';
}

function target(provider, workDir, label, instruction) {
  return {
    kind: 'new',
    label,
    instruction,
    cwd: workDir,
    ...provider,
    providerInstanceId: providerInstanceId(provider.providerKind),
    runtimeSettings: { runtimeMode: 'full-access' },
  };
}

export async function run({ orrery, provider, workDir, artifactsDir, log }) {
  fs.writeFileSync(path.join(workDir, 'SPEC.md'), '# result.txt\n\nThe file must contain exactly two lines: `DONE` and `VERIFIED`.\n');
  fs.writeFileSync(path.join(workDir, 'result.txt'), 'TODO\n');
  git(workDir, 'init', '-b', 'main');
  git(workDir, 'add', '.');
  git(workDir, 'commit', '-m', 'baseline');

  const source = await orrery.createSession({
    label: 'Dynamic Coder',
    prompt: 'Change result.txt from TODO to DONE. Make only that edit, then stop.',
    cwd: workDir,
    workMode: 'local',
    ...provider,
    providerInstanceId: providerInstanceId(provider.providerKind),
    runtimeSettings: { runtimeMode: 'full-access' },
  });
  await orrery.waitForIdle(source.sessionId, { timeoutMs: 300_000 });

  const current = await orrery.connectAgents({
    sourceSessionId: source.sessionId,
    target: target(provider, workDir, 'Immediate Receiver', 'Read the delivered result and summarize it in one sentence. Do not edit files.'),
    timing: 'current-result',
    behavior: 'handoff-once',
    instruction: 'Use the current completed result now.',
  });
  assert.deepEqual(current.subscriptionIds, []);
  await orrery.waitForIdle(current.targetSessionId, { timeoutMs: 300_000 });
  log('current-result delivered and activated immediately with no standing subscription');

  const next = await orrery.connectAgents({
    sourceSessionId: source.sessionId,
    target: target(provider, workDir, 'Next-turn Reviewer', 'Review the next completed result in one sentence. Do not edit files.'),
    timing: 'next-completion',
    behavior: 'one-review',
    instruction: 'Review only the next completed turn.',
  });
  const [nextId] = next.subscriptionIds;
  const beforeNext = await orrery.state();
  assert.equal(beforeNext.subscriptions[nextId].firings, 0);
  assert.equal(
    beforeNext.sessions[next.targetSessionId].messages.some((message) => message.role === 'assistant'),
    false,
    'the old source finished fact is not replayed',
  );

  await orrery.resumeSession(source.sessionId, {
    message: 'Append a second line containing exactly VERIFIED to result.txt, then stop.',
  });
  await orrery.waitFor(
    'next-completion firing',
    async () => {
      const state = await orrery.state();
      return state.subscriptions[nextId]?.firings === 1 && state.sessions[next.targetSessionId]?.status === 'idle'
        ? { done: true }
        : { detail: `firings=${state.subscriptions[nextId]?.firings ?? 0}` };
    },
    { timeoutMs: 420_000 },
  );
  log('next-completion stayed at 0 on history and fired once after the new turn');

  const loop = await orrery.connectAgents({
    sourceSessionId: source.sessionId,
    target: target(provider, workDir, 'Dynamic Reviewer', 'Review the real workspace diff against SPEC.md and report a typed verdict.'),
    timing: 'current-result',
    behavior: 'review-loop',
    instruction: 'Review the implementation against SPEC.md and the delivered real diff. Treat an explicit SPEC violation as P1.',
    review: { blocking: { mode: 'p0-p1' }, maxLaps: 1 },
  });
  assert.equal(loop.subscriptionIds.length, 2);
  const [passId, fixId] = loop.subscriptionIds;
  await orrery.waitFor(
    'dynamic Reviewer turn',
    async () => {
      const state = await orrery.state();
      const reviewer = state.sessions[loop.targetSessionId];
      return state.subscriptions[passId]?.firings === 1 && reviewer?.status === 'idle'
        ? { done: true }
        : { detail: `pass=${state.subscriptions[passId]?.firings ?? 0}, reviewer=${reviewer?.status}` };
    },
    { timeoutMs: 420_000 },
  );
  const final = await orrery.state();
  assert.equal(
    final.sessions[loop.targetSessionId].messages.some((message) => message.role === 'assistant'),
    true,
  );
  assert.equal(final.subscriptions[passId].state, 'stopped');
  assert.equal(final.subscriptions[fixId].state, 'stopped');
  assert.equal(fs.readFileSync(path.join(workDir, 'result.txt'), 'utf8').trim(), 'DONE\nVERIFIED');

  const { events } = await orrery.kernelEvents({ limit: 5000 });
  fs.writeFileSync(
    path.join(artifactsDir, 'connection-events.json'),
    JSON.stringify(
      events.filter((event) =>
        ['relationship.started', 'subscription.authored', 'activation.pending', 'activated', 'subscription.stopped'].includes(event.type),
      ),
      null,
      2,
    ),
  );
  log('dynamic review loop authored both directions and ran a real Reviewer turn');
}
