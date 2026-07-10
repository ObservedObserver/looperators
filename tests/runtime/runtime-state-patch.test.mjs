import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js';
import { applyLightweightRuntimeEvent, applyProviderRuntimeEventToState } from '../../dist-electron/shared/runtime-state-patch.js';

function stateWithSessions() {
  const state = createEmptyGraphState();
  const ts = '2026-07-10T10:00:00.000Z';
  const session = (sessionId) => ({
    sessionId,
    nodeId: sessionId,
    backend: 'local-cli',
    providerKind: 'claude-code',
    providerInstanceId: 'default-claude-sdk',
    agent: 'claude-code',
    label: sessionId,
    prompt: 'test',
    cwd: process.cwd(),
    role: 'worker',
    status: 'running',
    createdAt: ts,
    updatedAt: ts,
    chunks: [],
    messages: [],
    nativeEvents: [],
    runtimeEvents: [],
    runtimeActivities: [],
    runtimeRequests: [],
    runtimeUserInputRequests: [],
    runtimePlans: [],
  });
  state.sessions = {
    alpha: session('alpha'),
    beta: session('beta'),
  };
  state.nodes = [
    {
      nodeId: 'alpha',
      sessionId: 'alpha',
      label: 'alpha',
      role: 'worker',
      agent: 'claude-code',
      status: 'running',
      position: { x: 0, y: 0 },
    },
  ];
  return state;
}

function delta(id, text, options = {}) {
  return {
    id,
    ts: `2026-07-10T10:00:0${id}.000Z`,
    type: 'content.delta',
    sessionId: 'alpha',
    turnId: 'turn-1',
    itemId: 'message-1',
    streamKind: 'assistant_text',
    text,
    ...options,
  };
}

test('lightweight provider deltas patch only the target session', () => {
  const state = stateWithSessions();
  const next = applyProviderRuntimeEventToState(state, 'alpha', delta('1', 'hello'));

  assert.notEqual(next, state);
  assert.notEqual(next.sessions.alpha, state.sessions.alpha);
  assert.equal(next.sessions.beta, state.sessions.beta);
  assert.equal(next.nodes, state.nodes);
  assert.equal(next.sessions.alpha.runtimeEvents.length, 1);
  assert.equal(next.sessions.alpha.messages[0].content, 'hello');
  assert.equal(next.sessions.alpha.messages[0].status, 'streaming');
});

test('snapshot deltas replace until a real delta arrives and completion wins', () => {
  let state = stateWithSessions();
  state = applyProviderRuntimeEventToState(state, 'alpha', delta('1', 'hel', { isSnapshot: true }));
  state = applyProviderRuntimeEventToState(state, 'alpha', delta('2', 'hello', { isSnapshot: true }));
  state = applyProviderRuntimeEventToState(state, 'alpha', delta('3', '!'));
  state = applyProviderRuntimeEventToState(state, 'alpha', delta('4', 'stale snapshot', { isSnapshot: true }));
  assert.equal(state.sessions.alpha.messages[0].content, 'hello!');

  state = applyProviderRuntimeEventToState(state, 'alpha', {
    id: 'completed',
    ts: '2026-07-10T10:00:05.000Z',
    type: 'message.completed',
    sessionId: 'alpha',
    message: {
      id: 'alpha:message-1:assistant',
      sessionId: 'alpha',
      role: 'assistant',
      content: 'final answer',
      ts: '2026-07-10T10:00:05.000Z',
      runId: 'turn-1',
      providerItemId: 'message-1',
      status: 'complete',
    },
  });
  assert.equal(state.sessions.alpha.messages[0].content, 'final answer');
  assert.equal(state.sessions.alpha.messages[0].status, 'complete');
});

test('legacy stream events carry normalized provider events without a state snapshot', () => {
  const state = stateWithSessions();
  const event = {
    type: 'session.stream',
    sessionId: 'alpha',
    chunk: {
      id: 'chunk-1',
      sessionId: 'alpha',
      ts: '2026-07-10T10:00:01.000Z',
      stream: 'stdout',
      raw: 'hello',
      text: 'hello',
    },
    providerEvents: [delta('1', 'hello')],
  };
  const next = applyLightweightRuntimeEvent(state, event);

  assert.equal('state' in event, false);
  assert.equal(next.sessions.alpha.chunks.length, 1);
  assert.equal(next.sessions.alpha.runtimeEvents.length, 1);
  assert.equal(next.sessions.alpha.messages[0].content, 'hello');
});
