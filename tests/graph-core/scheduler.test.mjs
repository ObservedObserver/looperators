import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluate,
  fold,
  pendingSlotKey,
} from '../../dist-electron/shared/graph-core/index.js'

let seq = 0
function event(type, payload = {}, overrides = {}) {
  seq += 1
  return {
    seq,
    id: `evt-${seq}`,
    ts: overrides.ts ?? `2026-07-02T10:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    actor: overrides.actor ?? { kind: 'runtime' },
    payload,
  }
}

function subscription(overrides = {}) {
  return {
    id: 'sub',
    source: { kind: 'session', sessionId: 'coder' },
    on: { on: 'finished' },
    target: { kind: 'session', sessionId: 'reviewer' },
    action: { kind: 'deliver+activate', topic: 'diff' },
    gate: 'auto',
    concurrency: 'coalesce',
    onStop: 'freeze-edge',
    state: 'active',
    firings: 0,
    ...overrides,
  }
}

// The hero review loop from kernel doc §8.2: S1 coder→reviewer on finished,
// S2 reviewer→coder on report(verdict=issues) with stop at verdict=clean.
function reviewLoopState({ s2Firings = 0, maxFirings = 6 } = {}) {
  seq = 0
  const s1 = subscription({
    id: 's1',
    gate: 'master',
    action: { kind: 'deliver+activate', topic: 'diff' },
  })
  const s2 = subscription({
    id: 's2',
    source: { kind: 'session', sessionId: 'reviewer' },
    on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
    target: { kind: 'session', sessionId: 'coder' },
    action: { kind: 'deliver+activate', topic: 'review' },
    gate: 'master',
    stop: { whenReport: { verdict: 'clean' }, maxFirings },
    onStop: 'freeze-cluster',
    firings: s2Firings,
  })
  return fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'reviewer' }),
    event('session.finished', { sessionId: 'coder' }),
    event('session.finished', { sessionId: 'reviewer' }),
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['coder', 'reviewer'] }),
    event('role.assigned', { clusterId: 'c1', masterSessionId: 'm1' }),
    event('subscription.authored', { subscription: s1 }),
    event('subscription.authored', { subscription: s2 }),
  ])
}

test('S1 fires on coder finish and routes the gate to the LCA master', () => {
  const state = reviewLoopState()
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))

  assert.equal(decisions.length, 1)
  const [decision] = decisions
  assert.equal(decision.kind, 'pend-activation')
  assert.equal(decision.subscriptionId, 's1')
  assert.equal(decision.target, 'reviewer')
  assert.equal(decision.gate, 'master')
  assert.equal(
    decision.masterSessionId,
    'm1',
    'R1: intra-cluster subscription routes to the cluster master'
  )
})

test('S2 fires on an issues verdict and stops on clean without firing', () => {
  const state = reviewLoopState()

  const issues = evaluate(
    state,
    event('report.received', {
      reportId: 'r1',
      from: 'reviewer',
      reportType: 'verdict',
      verdict: 'issues',
    })
  )
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'pend-activation')
  assert.equal(issues[0].target, 'coder')

  const clean = evaluate(
    state,
    event('report.received', {
      reportId: 'r2',
      from: 'reviewer',
      reportType: 'verdict',
      verdict: 'clean',
    })
  )
  assert.equal(clean.length, 1)
  assert.equal(clean[0].kind, 'stop-subscription', 'stop is decided before any firing')
  assert.equal(clean[0].subscriptionId, 's2')
  assert.equal(clean[0].onStop, 'freeze-cluster')
  assert.match(clean[0].reason, /clean/)
})

test('maxFirings stops the subscription instead of firing past the cap', () => {
  const state = reviewLoopState({ s2Firings: 2, maxFirings: 2 })
  const decisions = evaluate(
    state,
    event('report.received', {
      reportId: 'r3',
      from: 'reviewer',
      reportType: 'verdict',
      verdict: 'issues',
    })
  )
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
  assert.match(decisions[0].reason, /maxFirings=2/)
})

test('deadline stop wins over a matching event', () => {
  seq = 0
  const sub = subscription({
    id: 'deadline-sub',
    stop: { deadline: '2026-07-02T10:00:00.000Z' },
  })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('subscription.authored', { subscription: sub }),
  ])
  const decisions = evaluate(
    state,
    event('session.finished', { sessionId: 'coder' }, { ts: '2026-07-02T11:00:00.000Z' })
  )
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
  assert.match(decisions[0].reason, /Deadline/)
})

test('coalesce supersedes the existing pending slot when the target is busy (§8.3)', () => {
  seq = 0
  const watcher = subscription({
    id: 's3',
    target: { kind: 'session', sessionId: 'acceptor' },
    action: { kind: 'deliver+activate', topic: 'changeset' },
    gate: 'auto',
    concurrency: 'coalesce',
  })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'acceptor' }),
    event('subscription.authored', { subscription: watcher }),
    // The acceptor is mid-run and a pending activation already exists.
    event('activation.pending', { subscriptionId: 's3', target: 'acceptor' }),
  ])

  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'pend-activation')
  assert.equal(
    decisions[0].supersedes,
    pendingSlotKey('s3', 'acceptor'),
    'coalesce keeps only the latest pending context'
  )
  assert.equal(decisions[0].gate, 'auto')
  assert.equal(decisions[0].masterSessionId, undefined)
})

test('drop discards the firing while the target is busy', () => {
  seq = 0
  const sub = subscription({ id: 'drop-sub', concurrency: 'drop' })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'reviewer' }),
    event('session.resumed', { sessionId: 'reviewer' }), // reviewer busy
    event('subscription.authored', { subscription: sub }),
  ])
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'drop-firing')
})

test('interrupt asks for a target interrupt and still pends the activation', () => {
  seq = 0
  const sub = subscription({ id: 'int-sub', concurrency: 'interrupt' })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'reviewer' }),
    event('session.resumed', { sessionId: 'reviewer' }),
    event('subscription.authored', { subscription: sub }),
  ])
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  assert.deepEqual(
    decisions.map((decision) => decision.kind),
    ['interrupt-target', 'pend-activation']
  )
})

test('deliver-only subscriptions produce data-plane deliveries: no gate, no slot', () => {
  seq = 0
  const progress = subscription({
    id: 'progress-sub',
    target: { kind: 'session', sessionId: 'b' },
    action: { kind: 'deliver', topic: 'progress' },
    gate: 'auto',
  })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'b' }),
    event('session.resumed', { sessionId: 'b' }), // busy must not matter
    event('subscription.authored', { subscription: progress }),
  ])
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  assert.equal(decisions.length, 1)
  assert.deepEqual(decisions[0], {
    kind: 'deliver',
    subscriptionId: 'progress-sub',
    target: 'b',
    topic: 'progress',
    triggerEventId: decisions[0].triggerEventId,
  })
})

test('cluster sources match member sessions only', () => {
  seq = 0
  const sub = subscription({
    id: 'cluster-sub',
    source: { kind: 'cluster', clusterId: 'c1' },
    target: { kind: 'session', sessionId: 'acceptor' },
  })
  const state = fold([
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['w1'] }),
    event('session.created', { sessionId: 'w1' }),
    event('session.created', { sessionId: 'outsider' }),
    event('session.created', { sessionId: 'acceptor' }),
    event('session.finished', { sessionId: 'acceptor' }),
    event('subscription.authored', { subscription: sub }),
  ])

  const member = evaluate(state, event('session.finished', { sessionId: 'w1' }))
  assert.equal(member.length, 1)
  const outsider = evaluate(
    state,
    event('session.finished', { sessionId: 'outsider' })
  )
  assert.equal(outsider.length, 0)
})

test('an event that both matches on and satisfies stop only stops (§2.2)', () => {
  seq = 0
  const sub = subscription({
    id: 'race-sub',
    source: { kind: 'session', sessionId: 'reviewer' },
    on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
    target: { kind: 'session', sessionId: 'coder' },
    stop: { whenReport: { verdict: 'issues' } },
  })
  const state = fold([
    event('session.created', { sessionId: 'reviewer' }),
    event('session.created', { sessionId: 'coder' }),
    event('subscription.authored', { subscription: sub }),
  ])
  const decisions = evaluate(
    state,
    event('report.received', {
      reportId: 'r1',
      from: 'reviewer',
      reportType: 'verdict',
      verdict: 'issues',
    })
  )
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
})

test('whenReport observes both edge participants but not strangers', () => {
  seq = 0
  // S1-style edge: coder → reviewer; the stop verdict comes from the
  // reviewer (the target), which a user would naturally configure.
  const sub = subscription({
    id: 's1-stop',
    stop: { whenReport: { verdict: 'clean' } },
  })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'reviewer' }),
    event('session.created', { sessionId: 'stranger' }),
    event('subscription.authored', { subscription: sub }),
  ])

  const fromTarget = evaluate(
    state,
    event('report.received', {
      reportId: 'r1',
      from: 'reviewer',
      reportType: 'verdict',
      verdict: 'clean',
    })
  )
  assert.equal(fromTarget.length, 1)
  assert.equal(
    fromTarget[0].kind,
    'stop-subscription',
    "the target's clean verdict stops the edge"
  )

  const fromStranger = evaluate(
    state,
    event('report.received', {
      reportId: 'r2',
      from: 'stranger',
      reportType: 'verdict',
      verdict: 'clean',
    })
  )
  assert.equal(
    fromStranger.length,
    0,
    "an unrelated session's verdict must not stop the edge"
  )
})

test('deadline is time-based: any later event stops the subscription', () => {
  seq = 0
  const sub = subscription({
    id: 'deadline-any',
    // Offset-bearing deadline: 2026-07-02T16:00Z expressed in +08:00.
    stop: { deadline: '2026-07-03T00:00:00+08:00' },
  })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'unrelated' }),
    event('subscription.authored', { subscription: sub }),
  ])
  // An event from an unrelated session, after the deadline instant.
  const decisions = evaluate(
    state,
    event(
      'session.finished',
      { sessionId: 'unrelated' },
      { ts: '2026-07-02T20:00:00.000Z' }
    )
  )
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
  assert.match(decisions[0].reason, /Deadline/)
})

test('on: failed and on: delivered(topic) patterns match their events', () => {
  seq = 0
  const onFailed = subscription({ id: 'on-failed', on: { on: 'failed' } })
  const onDelivered = subscription({
    id: 'on-delivered',
    on: { on: 'delivered', topic: 'diff' },
  })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('subscription.authored', { subscription: onFailed }),
    event('subscription.authored', { subscription: onDelivered }),
  ])

  const failed = evaluate(
    state,
    event('session.failed', { sessionId: 'coder', error: 'boom' })
  )
  assert.deepEqual(
    failed.map((decision) => decision.subscriptionId),
    ['on-failed']
  )

  const matchingTopic = evaluate(
    state,
    event('delivered', { source: 'coder', target: 'x', topic: 'diff' })
  )
  assert.deepEqual(
    matchingTopic.map((decision) => decision.subscriptionId),
    ['on-delivered']
  )

  const otherTopic = evaluate(
    state,
    event('delivered', { source: 'coder', target: 'x', topic: 'progress' })
  )
  assert.equal(otherTopic.length, 0)
})

test('gate=master with no master anywhere yields the human/UI fallback', () => {
  seq = 0
  const sub = subscription({ id: 'ungoverned', gate: 'master' })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('subscription.authored', { subscription: sub }),
  ])
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].gate, 'master')
  assert.equal(
    decisions[0].masterSessionId,
    undefined,
    'no master in the forest → governance falls to the human/UI'
  )
})

test('interrupt supersedes an existing slot instead of silently overwriting it', () => {
  seq = 0
  const sub = subscription({ id: 'int-slot', concurrency: 'interrupt' })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('session.created', { sessionId: 'reviewer' }),
    event('session.resumed', { sessionId: 'reviewer' }),
    event('subscription.authored', { subscription: sub }),
    event('activation.pending', { subscriptionId: 'int-slot', target: 'reviewer' }),
  ])
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  const pend = decisions.find((decision) => decision.kind === 'pend-activation')
  assert.equal(pend.supersedes, pendingSlotKey('int-slot', 'reviewer'))
})

test('stopped subscriptions never fire', () => {
  seq = 0
  const sub = subscription({ id: 'stopped-sub', state: 'stopped' })
  const state = fold([
    event('session.created', { sessionId: 'coder' }),
    event('subscription.authored', { subscription: sub }),
    event('subscription.stopped', { subscriptionId: 'stopped-sub' }),
  ])
  const decisions = evaluate(state, event('session.finished', { sessionId: 'coder' }))
  assert.equal(decisions.length, 0)
})
