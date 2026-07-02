import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultCycleMaxFirings,
  fold,
  staticCheck,
} from '../../dist-electron/shared/graph-core/index.js'

let seq = 0
function event(type, payload = {}) {
  seq += 1
  return {
    seq,
    id: `evt-${seq}`,
    ts: `2026-07-02T10:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    actor: { kind: 'runtime' },
    payload,
  }
}

function sub(id, source, target, overrides = {}) {
  return {
    id,
    source: { kind: 'session', sessionId: source },
    on: { on: 'finished' },
    target: { kind: 'session', sessionId: target },
    action: { kind: 'deliver+activate' },
    gate: 'auto',
    concurrency: 'coalesce',
    onStop: 'freeze-edge',
    state: 'active',
    firings: 0,
    ...overrides,
  }
}

function stateWith(subscriptions, extraEvents = []) {
  seq = 0
  return fold([
    ...extraEvents,
    ...subscriptions.map((subscription) =>
      event('subscription.authored', { subscription })
    ),
  ])
}

test('the hero loop (S1+S2, guarded) passes and is marked cyclic', () => {
  const state = stateWith([
    sub('s1', 'coder', 'reviewer', { gate: 'master' }),
    sub('s2', 'reviewer', 'coder', {
      on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
      gate: 'master',
      stop: { whenReport: { verdict: 'clean' }, maxFirings: 6 },
      onStop: 'freeze-cluster',
    }),
  ])

  const result = staticCheck(state)
  assert.equal(result.ok, true)
  assert.deepEqual(result.cyclicSubscriptionIds.sort(), ['s1', 's2'])
  // Cyclic subscriptions without maxFirings get the default guardrail
  // regardless of gate (§6.4).
  assert.deepEqual(result.needsDefaultMaxFirings, ['s1'])
  assert.equal(defaultCycleMaxFirings, 6)
})

test('the acceptance watcher (S3, acyclic, no until) is a legal permanent listener', () => {
  const state = stateWith([
    sub('s3', 'coder', 'acceptor', { gate: 'auto' }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, true)
  assert.deepEqual(result.cyclicSubscriptionIds, [])
  assert.deepEqual(result.needsDefaultMaxFirings, [])
})

test('closing the watcher into an unguarded loop (S3+S4, all auto, no stop) is illegal', () => {
  const state = stateWith([
    sub('s3', 'coder', 'acceptor', { gate: 'auto' }),
    sub('s4', 'acceptor', 'coder', { gate: 'auto' }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.deepEqual(result.violations[0].subscriptionIds.sort(), ['s3', 's4'])
  assert.deepEqual(result.needsDefaultMaxFirings.sort(), ['s3', 's4'])
})

test('one guarded edge on the cycle satisfies the rule', () => {
  const byStop = stateWith([
    sub('s3', 'coder', 'acceptor', { gate: 'auto' }),
    sub('s4', 'acceptor', 'coder', {
      gate: 'auto',
      stop: { maxFirings: 3 },
    }),
  ])
  assert.equal(staticCheck(byStop).ok, true)

  const byGate = stateWith([
    sub('s3', 'coder', 'acceptor', { gate: 'auto' }),
    sub('s4', 'acceptor', 'coder', { gate: 'master' }),
  ])
  assert.equal(staticCheck(byGate).ok, true)
})

test('deliver-only edges do not participate in cycles (§6.4)', () => {
  const state = stateWith([
    sub('forward', 'a', 'b', { gate: 'auto' }),
    sub('back', 'b', 'a', {
      gate: 'auto',
      action: { kind: 'deliver', topic: 'progress' },
    }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, true, 'a deliver-only back-edge cannot close a loop')
  assert.deepEqual(result.cyclicSubscriptionIds, [])
})

test('self-loops are cycles', () => {
  const state = stateWith([sub('self', 'a', 'a', { gate: 'auto' })])
  const result = staticCheck(state)
  assert.equal(result.ok, false)
  assert.deepEqual(result.violations[0].subscriptionIds, ['self'])
})

test('cluster sources expand to member edges so hidden cycles are caught', () => {
  const state = stateWith(
    [
      sub('watch', 'w1', 'acceptor', {
        source: { kind: 'cluster', clusterId: 'c1' },
        gate: 'auto',
      }),
      sub('respond', 'acceptor', 'w1', { gate: 'auto' }),
    ],
    [event('scope.upserted', { clusterId: 'c1', nodeIds: ['w1'] })]
  )
  const result = staticCheck(state)
  assert.equal(result.ok, false, 'the cycle through the cluster member must be caught')
  assert.deepEqual(result.violations[0].subscriptionIds.sort(), ['respond', 'watch'])
})

test('a guarded big cycle does not excuse a pure unguarded cycle in the same SCC', () => {
  // a→b (guarded), b→a (unguarded), b↔c (both unguarded). Every cycle
  // through a has a guard, but b↔c is an all-unguarded cycle — violation,
  // attributed precisely to the b↔c edges (not b→a, which only lies on
  // guarded cycles... b→a lies on the a-cycle which is guarded).
  const state = stateWith([
    sub('ab', 'a', 'b', { gate: 'master' }),
    sub('ba', 'b', 'a', { gate: 'auto' }),
    sub('bc', 'b', 'c', { gate: 'auto' }),
    sub('cb', 'c', 'b', { gate: 'auto' }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.deepEqual(
    result.violations[0].subscriptionIds.sort(),
    ['bc', 'cb'],
    'attribution reports only edges on some all-unguarded cycle'
  )
})

test('a bridge between two cycles is not itself cyclic', () => {
  // Two guarded 2-cycles a↔b and c↔d joined by bridge b→c.
  const state = stateWith([
    sub('ab', 'a', 'b', { gate: 'master' }),
    sub('ba', 'b', 'a', { gate: 'auto' }),
    sub('cd', 'c', 'd', { gate: 'master' }),
    sub('dc', 'd', 'c', { gate: 'auto' }),
    sub('bridge', 'b', 'c', { gate: 'auto' }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, true)
  assert.ok(!result.cyclicSubscriptionIds.includes('bridge'))
  assert.deepEqual(result.cyclicSubscriptionIds.sort(), ['ab', 'ba', 'cd', 'dc'])
})

test('a guarded parallel edge does not excuse its unguarded twin', () => {
  // Two subscriptions on the same a→b direction (one guarded, one not),
  // plus an unguarded back-edge: the unguarded pair still forms a cycle.
  const state = stateWith([
    sub('ab-guarded', 'a', 'b', { gate: 'master' }),
    sub('ab-unguarded', 'a', 'b', { gate: 'auto' }),
    sub('ba', 'b', 'a', { gate: 'auto' }),
  ])
  const result = staticCheck(state)
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.violations[0].subscriptionIds.sort(),
    ['ab-unguarded', 'ba']
  )
})

test('stopped subscriptions leave the intent graph', () => {
  // Authoring always activates (fold sets state to active); stopping is a
  // separate logged fact.
  const state = fold(
    [event('subscription.stopped', { subscriptionId: 's4' })],
    stateWith([
      sub('s3', 'coder', 'acceptor', { gate: 'auto' }),
      sub('s4', 'acceptor', 'coder', { gate: 'auto' }),
    ])
  )
  const result = staticCheck(state)
  assert.equal(result.ok, true, 'stopped edges cannot close a loop')
  assert.deepEqual(result.cyclicSubscriptionIds, [])
})
