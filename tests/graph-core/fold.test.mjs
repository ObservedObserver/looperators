import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyEvent,
  createEmptyKernelState,
  fold,
  pendingSlotKey,
} from '../../dist-electron/shared/graph-core/index.js'

let seq = 0
function event(type, payload = {}, { actor, causeId, reason } = {}) {
  seq += 1
  return {
    seq,
    id: `evt-${seq}`,
    ts: `2026-07-02T10:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    actor: actor ?? { kind: 'runtime' },
    causeId,
    reason,
    payload,
  }
}

function subscriptionFixture(overrides = {}) {
  return {
    id: 'sub-1',
    source: { kind: 'session', sessionId: 'coder' },
    on: { on: 'finished' },
    target: { kind: 'session', sessionId: 'reviewer' },
    action: { kind: 'deliver+activate', topic: 'diff' },
    gate: 'master',
    concurrency: 'coalesce',
    stop: { whenReport: { verdict: 'clean' }, maxFirings: 6 },
    onStop: 'freeze-cluster',
    state: 'active',
    firings: 0,
    ...overrides,
  }
}

test('fold projects session lifecycle, freeze, lineage, and archive', () => {
  seq = 0
  const state = fold([
    event('session.created', { sessionId: 'a', sourceSessionId: undefined }),
    event('session.finished', { sessionId: 'a', exitCode: 0 }),
    event('session.created', { sessionId: 'b', sourceSessionId: 'a' }),
    event('session.failed', { sessionId: 'b', error: 'boom' }),
    event('session.created', { sessionId: 'c' }),
    event('session.killed', { sessionId: 'c' }),
    event('session.archived', { sessionId: 'a', archived: true }),
    event(
      'freeze.applied',
      { targetId: 'a', targetSessionIds: ['a'] },
      { reason: 'freeze reason' }
    ),
  ])

  assert.equal(state.sessions.a.status, 'idle')
  assert.equal(state.sessions.a.archived, true)
  assert.equal(state.sessions.a.frozen, true)
  assert.equal(state.sessions.a.freezeReason, 'freeze reason')
  assert.equal(state.sessions.b.status, 'failed')
  assert.equal(state.sessions.b.createdBy, 'a')
  assert.equal(state.sessions.c.status, 'killed')
  assert.equal(state.lastSeq, 8)

  const lifted = applyEvent(
    state,
    event('freeze.lifted', { targetSessionIds: ['a'] })
  )
  assert.equal(lifted.sessions.a.frozen, false)
  assert.equal(lifted.sessions.a.freezeReason, undefined)
})

test('fold projects subscriptions, firings, and pending slots', () => {
  seq = 0
  const sub = subscriptionFixture()
  const state = fold([
    event('subscription.authored', { subscription: sub }),
    event('activation.pending', {
      subscriptionId: 'sub-1',
      target: 'reviewer',
      triggerEventId: 'evt-0',
    }),
  ])

  const slotKey = pendingSlotKey('sub-1', 'reviewer')
  assert.equal(state.subscriptions['sub-1'].state, 'active')
  assert.equal(state.pending[slotKey].status, 'pending')

  applyEvent(
    state,
    event(
      'activation.approved',
      { subscriptionId: 'sub-1', target: 'reviewer' },
      { actor: { kind: 'master', ref: 'm1' }, reason: 'Reviewed; proceed.' }
    )
  )
  assert.equal(state.pending[slotKey].status, 'approved')

  applyEvent(state, event('activated', { subscriptionId: 'sub-1', target: 'reviewer' }))
  assert.equal(state.pending[slotKey], undefined, 'activation consumes the slot')
  assert.equal(state.subscriptions['sub-1'].firings, 1)
  assert.equal(
    state.sessions.reviewer.status,
    'running',
    'an activation marks the target busy (the runtime emits activated for every turn start)'
  )

  applyEvent(
    state,
    event('activation.pending', { subscriptionId: 'sub-1', target: 'reviewer' })
  )
  applyEvent(
    state,
    event('activation.superseded', { subscriptionId: 'sub-1', target: 'reviewer' })
  )
  assert.equal(state.pending[slotKey], undefined, 'supersession frees the slot')

  applyEvent(
    state,
    event('activation.pending', { subscriptionId: 'sub-1', target: 'reviewer' })
  )
  applyEvent(
    state,
    event('activation.denied', { subscriptionId: 'sub-1', target: 'reviewer' })
  )
  assert.equal(state.pending[slotKey], undefined, 'denial frees the slot')

  applyEvent(
    state,
    event('activation.pending', { subscriptionId: 'sub-1', target: 'reviewer' })
  )
  applyEvent(
    state,
    event('activation.dropped', { subscriptionId: 'sub-1', target: 'reviewer' })
  )
  assert.equal(state.pending[slotKey], undefined, 'a dropped slot frees too')

  applyEvent(state, event('subscription.stopped', { subscriptionId: 'sub-1' }))
  assert.equal(state.subscriptions['sub-1'].state, 'stopped')
})

test('fold counts deliver-only firings on delivered, combined actions on activated', () => {
  seq = 0
  const deliverOnly = subscriptionFixture({
    id: 'sub-deliver',
    action: { kind: 'deliver', topic: 'progress' },
    stop: undefined,
    gate: 'auto',
  })
  const combined = subscriptionFixture({ id: 'sub-combined' })
  const state = fold([
    event('subscription.authored', { subscription: deliverOnly }),
    event('subscription.authored', { subscription: combined }),
    event('delivered', { subscriptionId: 'sub-deliver', target: 'b', topic: 'progress' }),
    // A deliver+activate firing emits both facts; it must count once.
    event('delivered', { subscriptionId: 'sub-combined', target: 'reviewer' }),
    event('activated', { subscriptionId: 'sub-combined', target: 'reviewer' }),
  ])

  assert.equal(state.subscriptions['sub-deliver'].firings, 1)
  assert.equal(state.subscriptions['sub-combined'].firings, 1)
})

test('fold projects scopes, master assignment, and links', () => {
  seq = 0
  const state = fold([
    event('scope.upserted', { clusterId: 'cluster-1', nodeIds: ['w1', 'w2'] }),
    event('role.assigned', { clusterId: 'cluster-1', masterSessionId: 'w1' }),
    event('edge.linked', { edgeId: 'link:1', source: 'w1', target: 'w2', label: 'reviews' }),
  ])

  assert.deepEqual(state.scopes['cluster-1'].members, ['w2'])
  assert.equal(state.scopes['cluster-1'].masterSessionId, 'w1')
  assert.equal(state.links['link:1'].label, 'reviews')

  applyEvent(state, event('edge.removed', { edgeId: 'link:1' }))
  assert.equal(state.links['link:1'], undefined)
})

test('re-upserting a scope keeps its master and never lists it as a member', () => {
  seq = 0
  const state = fold([
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['w1'] }),
    event('role.assigned', { clusterId: 'c1', masterSessionId: 'm1' }),
    // The UI redraws the cluster box around the master node: the upsert
    // carries the master in nodeIds and no masterSessionId field.
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['w1', 'w2', 'm1'] }),
  ])

  assert.equal(state.scopes.c1.masterSessionId, 'm1', 'upsert must not drop the master')
  assert.deepEqual(
    state.scopes.c1.members,
    ['w1', 'w2'],
    'the master is never a member of its own scope'
  )
})

test('replay is exact: same log folds to a byte-identical state', () => {
  seq = 0
  // A synthetic log that includes nondeterministic-in-origin facts (master
  // gate decisions) — once logged, replay must be deterministic.
  const log = [
    event('session.created', { sessionId: 'coder' }),
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['coder'] }),
    event('role.assigned', { clusterId: 'c1', masterSessionId: 'm1' }),
    event('subscription.authored', { subscription: subscriptionFixture() }),
    event('session.finished', { sessionId: 'coder', exitCode: 0 }),
    event('activation.pending', { subscriptionId: 'sub-1', target: 'reviewer' }),
    event(
      'activation.approved',
      { subscriptionId: 'sub-1', target: 'reviewer' },
      { actor: { kind: 'master', ref: 'm1' }, reason: 'LLM said yes.' }
    ),
    event('activated', { subscriptionId: 'sub-1', target: 'reviewer' }),
    event('session.created', { sessionId: 'reviewer', sourceSessionId: 'm1' }),
    event('report.received', {
      reportId: 'r1',
      from: 'reviewer',
      reportType: 'verdict',
      verdict: 'issues',
    }),
    event('freeze.applied', { targetSessionIds: ['coder', 'reviewer'] }),
  ]

  const first = fold(structuredClone(log))
  const second = fold(structuredClone(log))
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    'two replays of the same log must be byte-identical'
  )

  // Incremental folding must equal batch folding.
  const incremental = createEmptyKernelState()
  for (const item of structuredClone(log)) {
    applyEvent(incremental, item)
  }
  assert.equal(JSON.stringify(incremental), JSON.stringify(first))

  // Prefix determinism: replaying a prefix then the suffix equals the whole.
  const prefix = fold(structuredClone(log.slice(0, 6)))
  const resumed = fold(structuredClone(log.slice(6)), prefix)
  assert.equal(JSON.stringify(resumed), JSON.stringify(first))
})
