import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluate,
  fold,
  governingMaster,
  pendingSlotKey,
  staticCheck,
} from '../../dist-electron/shared/graph-core/index.js'

let seq = 0
function event(type, payload = {}, overrides = {}) {
  seq += 1
  return {
    seq,
    id: `evt-${seq}`,
    ts: overrides.ts ?? `2026-07-06T09:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    actor: overrides.actor ?? { kind: 'runtime' },
    payload,
  }
}

function timerSubscription(overrides = {}) {
  return {
    id: 'tick-sub',
    source: { kind: 'timer' },
    on: { on: 'schedule', everySeconds: 60 },
    target: { kind: 'session', sessionId: 'summarizer' },
    action: { kind: 'deliver+activate', note: 'Scheduled activation.' },
    gate: 'auto',
    concurrency: 'coalesce',
    onStop: 'freeze-edge',
    state: 'active',
    firings: 0,
    ...overrides,
  }
}

function timerState(subscriptionOverrides = {}, extraEvents = []) {
  seq = 0
  return fold([
    event('session.created', { sessionId: 'summarizer' }),
    event('session.finished', { sessionId: 'summarizer' }),
    event('subscription.authored', {
      subscription: timerSubscription(subscriptionOverrides),
    }),
    ...extraEvents,
  ])
}

function tick(subscriptionId = 'tick-sub') {
  return event('external.timer', {
    subscriptionId,
    targetSessionId: 'summarizer',
    everySeconds: 60,
  })
}

test('a timer tick pends an activation for exactly its own subscription', () => {
  const state = timerState()
  const decisions = evaluate(state, tick())

  assert.equal(decisions.length, 1)
  const [decision] = decisions
  assert.equal(decision.kind, 'pend-activation')
  assert.equal(decision.subscriptionId, 'tick-sub')
  assert.equal(decision.target, 'summarizer')
  assert.equal(decision.gate, 'auto')
})

test('a tick for another subscription does not match', () => {
  const state = timerState()
  const decisions = evaluate(state, tick('someone-elses-sub'))
  assert.equal(decisions.length, 0)
})

test('a tick never matches session-source subscriptions', () => {
  seq = 0
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'summarizer' }),
    event('subscription.authored', {
      subscription: timerSubscription({
        id: 'watcher',
        source: { kind: 'session', sessionId: 'coder' },
        on: { on: 'finished' },
      }),
    }),
  ])
  const decisions = evaluate(state, tick('watcher'))
  assert.equal(
    decisions.length,
    0,
    'tick identity must not leak into session-source matching'
  )
})

test('coalesce: a tick landing on a live slot supersedes it', () => {
  const state = timerState({}, [
    event('activation.pending', {
      subscriptionId: 'tick-sub',
      target: 'summarizer',
      slotKey: pendingSlotKey('tick-sub', 'summarizer'),
    }),
  ])
  const decisions = evaluate(state, tick())
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'pend-activation')
  assert.equal(
    decisions[0].supersedes,
    pendingSlotKey('tick-sub', 'summarizer'),
    'the older pending tick yields to the newest one'
  )
})

test('deadline stops a schedule subscription before it fires', () => {
  const state = timerState({
    stop: { deadline: '2026-07-06T08:00:00.000Z' },
  })
  const decisions = evaluate(state, tick())
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
  assert.match(decisions[0].reason, /Deadline/)
})

test('maxFirings caps a schedule subscription', () => {
  const state = timerState({ stop: { maxFirings: 3 }, firings: 3 })
  const decisions = evaluate(state, tick())
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
  assert.match(decisions[0].reason, /maxFirings/)
})

test('whenReport only observes the target of a timer edge', () => {
  const state = timerState({ stop: { whenReport: { verdict: 'done' } } })

  const foreign = evaluate(
    state,
    event('report.received', {
      reportId: 'r1',
      from: 'unrelated-session',
      reportType: 'verdict',
      verdict: 'done',
    })
  )
  assert.equal(
    foreign.filter((decision) => decision.kind === 'stop-subscription').length,
    0,
    'an unrelated session cannot stop the schedule'
  )

  const own = evaluate(
    state,
    event('report.received', {
      reportId: 'r2',
      from: 'summarizer',
      reportType: 'verdict',
      verdict: 'done',
    })
  )
  assert.equal(own.length, 1)
  assert.equal(own[0].kind, 'stop-subscription')
})

test('static check: timer edges are entry points, never cycle members', () => {
  seq = 0
  const state = fold([
    event('session.created', { sessionId: 'summarizer' }),
    event('session.created', { sessionId: 'downstream' }),
    event('subscription.authored', { subscription: timerSubscription() }),
    event('subscription.authored', {
      subscription: timerSubscription({
        id: 'follow-up',
        source: { kind: 'session', sessionId: 'summarizer' },
        on: { on: 'finished' },
        target: { kind: 'session', sessionId: 'downstream' },
      }),
    }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.cyclicSubscriptionIds,
    [],
    'timer → A → B is acyclic; no forced guardrail'
  )
})

test('static check: a cycle behind a timer entry point still needs guards', () => {
  seq = 0
  const unguarded = {
    gate: 'auto',
    stop: undefined,
  }
  const state = fold([
    event('session.created', { sessionId: 'summarizer' }),
    event('session.created', { sessionId: 'downstream' }),
    event('subscription.authored', { subscription: timerSubscription() }),
    event('subscription.authored', {
      subscription: timerSubscription({
        id: 'a-to-b',
        source: { kind: 'session', sessionId: 'summarizer' },
        on: { on: 'finished' },
        target: { kind: 'session', sessionId: 'downstream' },
        ...unguarded,
      }),
    }),
    event('subscription.authored', {
      subscription: timerSubscription({
        id: 'b-to-a',
        source: { kind: 'session', sessionId: 'downstream' },
        on: { on: 'finished' },
        target: { kind: 'session', sessionId: 'summarizer' },
        ...unguarded,
      }),
    }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, false, 'the session cycle is still detected')
  assert.deepEqual(
    [...result.violations[0].subscriptionIds].sort(),
    ['a-to-b', 'b-to-a'],
    'only the session edges lie on the cycle — the timer edge does not'
  )
})

test('fold: external.timer anchors lastTickAt on the owning subscription only', () => {
  seq = 0
  const state = fold([
    event('session.created', { sessionId: 'summarizer' }),
    event('subscription.authored', { subscription: timerSubscription() }),
    event('subscription.authored', {
      subscription: timerSubscription({ id: 'other-timer' }),
    }),
    event(
      'external.timer',
      { subscriptionId: 'tick-sub', targetSessionId: 'summarizer', everySeconds: 60 },
      { ts: '2026-07-06T09:30:00.000Z' }
    ),
  ])
  assert.equal(
    state.subscriptions['tick-sub'].lastTickAt,
    '2026-07-06T09:30:00.000Z',
    'replay recovers the tick anchor from the log'
  )
  assert.equal(
    state.subscriptions['other-timer'].lastTickAt,
    undefined,
    'ticks never leak onto other subscriptions'
  )
})

test('R1 degenerates for timer sources: target chain governs', () => {
  seq = 0
  const state = fold([
    event('session.created', { sessionId: 'summarizer' }),
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['summarizer'] }),
    event('role.assigned', { clusterId: 'c1', masterSessionId: 'm1' }),
    event('subscription.authored', {
      subscription: timerSubscription({ gate: 'master' }),
    }),
  ])
  assert.equal(
    governingMaster(state, state.subscriptions['tick-sub']),
    'm1',
    "the target's cluster master governs a timer edge"
  )
})
