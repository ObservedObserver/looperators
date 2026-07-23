import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js';
import {
  applyLightweightRuntimeEvent,
  applyLightweightRuntimeEvents,
  applyNodePositionUpdates,
  applyProviderRuntimeEventToState,
  lightweightRuntimeEventsRequireRootRender,
  preferRuntimeSnapshot,
} from '../../dist-electron/shared/runtime-state-patch.js';
import { createRuntimeStateStore } from '../../dist-electron/shared/runtime-state-store.js';

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

test('provider runtime events carry normalized provider events without a state snapshot', () => {
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

test('stale POST snapshots cannot overwrite newer SSE workflow state', () => {
  const current = { controlVersion: 4, updatedAt: '2026-07-12T14:00:02.000Z', marker: 'barrier released' };
  const stalePost = { controlVersion: 4, updatedAt: '2026-07-12T14:00:01.000Z', marker: 'drafting' };
  assert.equal(preferRuntimeSnapshot(current, stalePost), current);
  const newerControl = { controlVersion: 5, updatedAt: '2026-07-12T13:59:00.000Z', marker: 'human command' };
  assert.equal(preferRuntimeSnapshot(current, newerControl), newerControl);
});

test('position patches advance state time so a late snapshot cannot roll back a drag', () => {
  const state = stateWithSessions();
  state.updatedAt = '2026-07-12T14:00:01.000Z';
  const patched = applyNodePositionUpdates(
    state,
    [{ nodeId: 'alpha', position: { x: 320, y: 240 } }],
    '2026-07-12T14:00:03.000Z',
  );
  const staleSnapshot = structuredClone(state);
  staleSnapshot.updatedAt = '2026-07-12T14:00:02.000Z';

  assert.deepEqual(patched.nodes[0].position, { x: 320, y: 240 });
  assert.equal(patched.updatedAt, '2026-07-12T14:00:03.000Z');
  assert.equal(preferRuntimeSnapshot(patched, staleSnapshot), patched);
});

test('interleaved Session events cannot move the global state clock backwards', () => {
  const state = stateWithSessions();
  state.updatedAt = '2026-07-10T10:00:00.000Z';
  const next = applyLightweightRuntimeEvents(state, [
    {
      type: 'provider.runtime',
      sessionId: 'alpha',
      providerEvent: delta('1', 'a1'),
    },
    {
      type: 'provider.runtime',
      sessionId: 'beta',
      providerEvent: {
        ...delta('2', 'b1'),
        id: 'beta-2',
        sessionId: 'beta',
        ts: '2026-07-10T10:00:02.000Z',
      },
    },
    {
      type: 'provider.runtime',
      sessionId: 'alpha',
      providerEvent: {
        ...delta('3', 'a2'),
        ts: '2026-07-10T10:00:03.000Z',
      },
    },
  ]);

  assert.equal(next.updatedAt, '2026-07-10T10:00:03.000Z');
  const lateBeta = applyProviderRuntimeEventToState(next, 'beta', {
    ...delta('4', 'old'),
    id: 'beta-old',
    sessionId: 'beta',
    ts: '2026-07-10T10:00:02.500Z',
  });
  assert.equal(lateBeta.updatedAt, '2026-07-10T10:00:03.000Z');
});

test('content batches notify only the affected Session without requesting an App root render', () => {
  let projectionCalls = 0;
  const store = createRuntimeStateStore(stateWithSessions(), {
    projectSession: (session, _previousSession, previousProjection) => {
      projectionCalls += 1;
      return {
        sessionId: session.sessionId,
        content: session.messages.at(-1)?.content ?? '',
        revision: (previousProjection?.revision ?? 0) + 1,
      };
    },
  });
  let alphaNotifications = 0;
  let betaNotifications = 0;
  const unsubscribeAlpha = store.subscribeSession('alpha', () => {
    alphaNotifications += 1;
  });
  const unsubscribeBeta = store.subscribeSession('beta', () => {
    betaNotifications += 1;
  });
  const initialView = store.getSessionView('alpha');
  const events = ['a', 'b', 'c', 'd'].map((text, index) => ({
    type: 'provider.runtime',
    sessionId: 'alpha',
    providerEvent: {
      ...delta(String(index + 1), text),
      id: `batch-${index + 1}`,
    },
  }));

  const result = store.applyStreamEvents(events);
  assert.equal(
    projectionCalls,
    1,
    'store notification must not synchronously project before React schedules transition work',
  );
  const nextView = store.getSessionView('alpha');

  assert.equal(result.requiresRootRender, false);
  assert.equal(alphaNotifications, 1);
  assert.equal(betaNotifications, 0);
  assert.equal(result.state.sessions.alpha.messages[0].content, 'abcd');
  assert.equal(nextView.projection.content, 'abcd');
  assert.equal(nextView.projection.revision, 2);
  assert.equal(projectionCalls, 2);
  assert.notEqual(nextView, initialView);
  assert.equal(store.getSessionView('alpha'), nextView, 'session view snapshots must remain cached between updates');

  unsubscribeAlpha();
  unsubscribeBeta();
});

test('control-facing provider events still request an App root render', () => {
  const requestEvent = {
    type: 'provider.runtime',
    sessionId: 'alpha',
    providerEvent: {
      id: 'request-1',
      ts: '2026-07-10T10:00:08.000Z',
      type: 'request.opened',
      sessionId: 'alpha',
      request: {
        id: 'request-1',
        sessionId: 'alpha',
        kind: 'approval',
        title: 'Approve command',
        createdAt: '2026-07-10T10:00:08.000Z',
      },
    },
  };

  assert.equal(lightweightRuntimeEventsRequireRootRender([requestEvent]), true);
});

test('provider event classification isolates transcript events and escalates control events', () => {
  const isolatedTypes = [
    'content.delta',
    'item.started',
    'item.updated',
    'item.completed',
    'turn.started',
    'turn.completed',
    'turn.diff.updated',
  ];
  const controlTypes = [
    'message.completed',
    'request.opened',
    'request.resolved',
    'user-input.requested',
    'user-input.answered',
    'user-input.resolved',
    'plan.updated',
    'session.state',
    'runtime.configured',
  ];
  const wrapper = (type) => ({
    type: 'provider.runtime',
    sessionId: 'alpha',
    providerEvent: {
      id: `event-${type}`,
      ts: '2026-07-10T10:00:08.000Z',
      type,
      sessionId: 'alpha',
    },
  });

  for (const type of isolatedTypes) {
    assert.equal(lightweightRuntimeEventsRequireRootRender([wrapper(type)]), false, type);
  }
  for (const type of controlTypes) {
    assert.equal(lightweightRuntimeEventsRequireRootRender([wrapper(type)]), true, type);
  }
});

test('a mixed Session batch notifies each changed Session once', () => {
  const store = createRuntimeStateStore(stateWithSessions());
  let alphaNotifications = 0;
  let betaNotifications = 0;
  const unsubscribeAlpha = store.subscribeSession('alpha', () => {
    alphaNotifications += 1;
  });
  const unsubscribeBeta = store.subscribeSession('beta', () => {
    betaNotifications += 1;
  });

  const result = store.applyStreamEvents([
    {
      type: 'provider.runtime',
      sessionId: 'alpha',
      providerEvent: delta('1', 'alpha'),
    },
    {
      type: 'provider.runtime',
      sessionId: 'beta',
      providerEvent: {
        ...delta('2', 'beta'),
        id: 'beta-delta',
        sessionId: 'beta',
      },
    },
  ]);

  assert.equal(result.requiresRootRender, false);
  assert.equal(alphaNotifications, 1);
  assert.equal(betaNotifications, 1);
  assert.equal(result.state.sessions.alpha.messages[0].content, 'alpha');
  assert.equal(result.state.sessions.beta.messages[0].content, 'beta');

  unsubscribeAlpha();
  unsubscribeBeta();
});

test('append-only assistant batches preserve sequential semantics at the event cap', () => {
  const state = stateWithSessions();
  const historicalEvents = Array.from({ length: 1995 }, (_, index) => ({
    id: `history-${index}`,
    ts: new Date(Date.parse('2026-07-10T10:00:00.000Z') + index).toISOString(),
    type: 'content.delta',
    sessionId: 'alpha',
    turnId: 'turn-1',
    itemId: 'message-1',
    streamKind: 'assistant_text',
    text: 'x',
  }));
  state.sessions.alpha.runtimeEvents = historicalEvents;
  state.sessions.alpha.messages = [
    {
      id: 'alpha:message-1:assistant',
      sessionId: 'alpha',
      role: 'assistant',
      content: 'x'.repeat(historicalEvents.length),
      ts: historicalEvents.at(-1).ts,
      runId: 'turn-1',
      providerItemId: 'message-1',
      status: 'streaming',
    },
  ];
  const events = Array.from({ length: 20 }, (_, index) => ({
    type: 'provider.runtime',
    sessionId: 'alpha',
    providerEvent: {
      id: `batch-${index}`,
      ts: new Date(Date.parse('2026-07-10T10:01:00.000Z') + index).toISOString(),
      type: 'content.delta',
      sessionId: 'alpha',
      turnId: 'turn-1',
      itemId: 'message-1',
      streamKind: 'assistant_text',
      text: String(index % 10),
    },
  }));

  const sequential = events.reduce(
    (current, event) => applyLightweightRuntimeEvent(current, event),
    state,
  );
  const batched = applyLightweightRuntimeEvents(state, events);

  assert.deepEqual(batched, sequential);
  assert.equal(batched.sessions.alpha.runtimeEvents.length, 2000);
  assert.equal(
    batched.sessions.alpha.messages[0].content,
    `${'x'.repeat(historicalEvents.length)}${events.map((event) => event.providerEvent.text).join('')}`,
  );
});

test('main-process session.stream batches retain append-only delta semantics', () => {
  const state = stateWithSessions();
  const providerEvents = ['a', 'b', 'c'].map((text, index) => ({
    ...delta(String(index + 1), text),
    id: `transport-batch-${index}`,
  }));
  const sequential = providerEvents.reduce(
    (current, providerEvent) =>
      applyProviderRuntimeEventToState(current, 'alpha', providerEvent),
    state,
  );
  const batched = applyLightweightRuntimeEvents(state, [
    {
      type: 'session.stream',
      sessionId: 'alpha',
      providerEvents,
    },
  ]);

  assert.deepEqual(batched, sequential);
  assert.equal(batched.sessions.alpha.messages[0].content, 'abc');
});

test('assistant deltas without a provider identity retain the canonical sequential fallback', () => {
  const state = stateWithSessions();
  const events = ['first', 'second'].map((text, index) => ({
    type: 'provider.runtime',
    sessionId: 'alpha',
    providerEvent: {
      id: `identity-free-${index}`,
      ts: new Date(Date.parse('2026-07-10T10:02:00.000Z') + index).toISOString(),
      type: 'content.delta',
      sessionId: 'alpha',
      streamKind: 'assistant_text',
      text,
    },
  }));

  const sequential = events.reduce(
    (current, event) => applyLightweightRuntimeEvent(current, event),
    state,
  );
  assert.deepEqual(applyLightweightRuntimeEvents(state, events), sequential);
});

test('an authoritative state snapshot invalidates the incremental Session projection cache', () => {
  const store = createRuntimeStateStore(stateWithSessions(), {
    projectSession: (session, _previousSession, previousProjection) => ({
      content: session.messages.at(-1)?.content ?? '',
      generation: (previousProjection?.generation ?? 0) + 1,
    }),
  });
  const initialView = store.getSessionView('alpha');
  assert.equal(initialView.projection.generation, 1);

  store.setState((current) => ({
    ...current,
    controlVersion: Number(current.controlVersion ?? 0) + 1,
    updatedAt: '2026-07-10T10:00:09.000Z',
    sessions: {
      ...current.sessions,
      alpha: {
        ...current.sessions.alpha,
        updatedAt: '2026-07-10T10:00:09.000Z',
        messages: [
          {
            id: 'authoritative-message',
            sessionId: 'alpha',
            role: 'assistant',
            content: 'authoritative',
            ts: '2026-07-10T10:00:09.000Z',
            status: 'complete',
          },
        ],
      },
    },
  }));
  const nextView = store.getSessionView('alpha');

  assert.notEqual(nextView, initialView);
  assert.equal(nextView.projection.content, 'authoritative');
  assert.equal(nextView.projection.generation, 1, 'full snapshots must not reuse an incremental projection');
});
