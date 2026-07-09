import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluate,
  externalIngestionDecision,
  fold,
  isValidExternalTopic,
  matchesPattern,
  sourceMinIntervalSeconds,
  staticCheck,
} from '../../dist-electron/shared/graph-core/index.js'

let seq = 0
const mkEvent = (type, payload = {}, ts = '2026-07-09T08:00:00.000Z') => {
  seq += 1
  return {
    seq,
    id: `evt-${seq}`,
    ts,
    type,
    actor: { kind: 'runtime' },
    payload,
  }
}

const mkSource = (overrides = {}) => ({
  id: 'src-git',
  kind: 'git',
  topic: 'git',
  config: { repoPath: '/tmp/repo' },
  ...overrides,
})

const externalSubscription = (overrides = {}) => ({
  id: 'sub-ext',
  source: { kind: 'external', sourceId: 'src-git' },
  on: { on: 'external', topic: 'git' },
  target: { kind: 'session', sessionId: 'reviewer' },
  action: { kind: 'deliver+activate', note: 'review the change' },
  gate: 'auto',
  concurrency: 'coalesce',
  onStop: 'freeze-edge',
  state: 'active',
  firings: 0,
  ...overrides,
})

// --- matchesPattern ---

test('external pattern matches external.<topic> facts and honors the topic filter', () => {
  const pattern = { on: 'external', topic: 'git' }
  assert.equal(matchesPattern(pattern, mkEvent('external.git', {})), true)
  assert.equal(matchesPattern(pattern, mkEvent('external.ci', {})), false)
  assert.equal(matchesPattern(pattern, mkEvent('session.finished', {})), false)
})

test('external pattern without topic matches any external fact except timer ticks', () => {
  const pattern = { on: 'external' }
  assert.equal(matchesPattern(pattern, mkEvent('external.git', {})), true)
  assert.equal(matchesPattern(pattern, mkEvent('external.ci', {})), true)
  assert.equal(matchesPattern(pattern, mkEvent('external.timer', {})), false)
})

test('external pattern match fields are strict string equality on the payload', () => {
  const pattern = { on: 'external', topic: 'ci', match: { status: 'failed' } }
  assert.equal(
    matchesPattern(pattern, mkEvent('external.ci', { status: 'failed' })),
    true
  )
  assert.equal(
    matchesPattern(pattern, mkEvent('external.ci', { status: 'passed' })),
    false
  )
  // Missing field and non-string value both fail closed.
  assert.equal(matchesPattern(pattern, mkEvent('external.ci', {})), false)
  assert.equal(matchesPattern(pattern, mkEvent('external.ci', { status: 1 })), false)
})

// --- topic validation ---

test('topic slugs are lowercase identifiers and timer is reserved', () => {
  assert.equal(isValidExternalTopic('git'), true)
  assert.equal(isValidExternalTopic('ci_status-2'), true)
  assert.equal(isValidExternalTopic('timer'), false)
  assert.equal(isValidExternalTopic('Git'), false)
  assert.equal(isValidExternalTopic('9lives'), false)
  assert.equal(isValidExternalTopic(''), false)
  assert.equal(isValidExternalTopic(undefined), false)
})

// --- fold: registry + ingestion anchors ---

test('fold registers sources, tombstones removals, and keeps them renderable', () => {
  const state = fold([
    mkEvent('source.registered', { source: mkSource() }),
    mkEvent('source.removed', { sourceId: 'src-git' }),
  ])
  const source = state.sources['src-git']
  assert.ok(source, 'removed source stays as a tombstone')
  assert.equal(source.state, 'removed')
  assert.equal(source.topic, 'git')
})

test('fold recovers ingestion anchors from accepted external facts', () => {
  const state = fold([
    mkEvent('source.registered', { source: mkSource() }),
    mkEvent(
      'external.git',
      { sourceId: 'src-git', dedupeKey: 'abc123', ref: 'refs/heads/main' },
      '2026-07-09T08:05:00.000Z'
    ),
  ])
  const source = state.sources['src-git']
  assert.equal(source.lastEventAt, '2026-07-09T08:05:00.000Z')
  assert.equal(source.lastDedupeKey, 'abc123')
})

test('fold clears the dedupe anchor on a key-less accepted fact', () => {
  const state = fold([
    mkEvent('source.registered', { source: mkSource() }),
    mkEvent('external.git', { sourceId: 'src-git', dedupeKey: 'abc' }),
    mkEvent('external.git', { sourceId: 'src-git' }),
  ])
  const source = state.sources['src-git']
  assert.equal(
    source.lastDedupeKey,
    undefined,
    'the anchor is the LAST accepted key, including its absence'
  )
})

test('fold ignores external facts for unknown sources and timer ticks', () => {
  const state = fold([
    mkEvent('source.registered', { source: mkSource() }),
    mkEvent('external.ci', { sourceId: 'src-nope' }),
    mkEvent('external.timer', { subscriptionId: 'sub-x' }),
  ])
  assert.equal(state.sources['src-git'].lastEventAt, undefined)
  assert.equal(state.sources['src-nope'], undefined)
})

// --- ingestion decision (choke-point math) ---

test('removed sources reject emits', () => {
  const decision = externalIngestionDecision(
    { kind: 'manual', state: 'removed' },
    {},
    Date.parse('2026-07-09T08:00:00.000Z')
  )
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /removed/i)
})

test('sampling drops too-soon emits measured from the last accepted event', () => {
  const source = {
    kind: 'git',
    state: 'active',
    minIntervalSeconds: 10,
    lastEventAt: '2026-07-09T08:00:00.000Z',
  }
  const at = (iso) => Date.parse(iso)
  // First emit (no anchor) always passes.
  assert.equal(
    externalIngestionDecision({ ...source, lastEventAt: undefined }, {}, at('2026-07-09T08:00:00.000Z')).ok,
    true
  )
  const tooSoon = externalIngestionDecision(source, {}, at('2026-07-09T08:00:05.000Z'))
  assert.equal(tooSoon.ok, false)
  assert.match(tooSoon.reason, /Sampling/)
  assert.equal(
    externalIngestionDecision(source, {}, at('2026-07-09T08:00:10.000Z')).ok,
    true
  )
})

test('consecutive dedupe suppresses repeats of the last accepted dedupeKey', () => {
  const source = {
    kind: 'manual',
    state: 'active',
    lastDedupeKey: 'head-1',
  }
  const now = Date.parse('2026-07-09T08:00:00.000Z')
  const repeat = externalIngestionDecision(source, { dedupeKey: 'head-1' }, now)
  assert.equal(repeat.ok, false)
  assert.match(repeat.reason, /Duplicate/)
  assert.equal(externalIngestionDecision(source, { dedupeKey: 'head-2' }, now).ok, true)
  assert.equal(externalIngestionDecision(source, {}, now).ok, true)
})

test('min interval falls back to conservative per-kind defaults', () => {
  assert.equal(sourceMinIntervalSeconds({ kind: 'git' }), 5)
  assert.equal(sourceMinIntervalSeconds({ kind: 'script' }), 1)
  assert.equal(sourceMinIntervalSeconds({ kind: 'manual' }), 0)
  // Explicit zero disables sampling; negative/garbage falls back.
  assert.equal(sourceMinIntervalSeconds({ kind: 'git', minIntervalSeconds: 0 }), 0)
  assert.equal(sourceMinIntervalSeconds({ kind: 'git', minIntervalSeconds: -3 }), 5)
})

// --- evaluate: emit identity and firing ---

const stateWithSubscription = (subscription) =>
  fold([
    mkEvent('source.registered', { source: mkSource() }),
    mkEvent('source.registered', {
      source: mkSource({ id: 'src-other', kind: 'script', topic: 'ci' }),
    }),
    mkEvent('subscription.authored', { subscription }),
  ])

test('an external emit pends activation for exactly the subscriptions of its source', () => {
  const state = stateWithSubscription(externalSubscription())
  const emit = mkEvent('external.git', {
    sourceId: 'src-git',
    dedupeKey: 'head-9',
  })
  fold([emit], state)
  const decisions = evaluate(state, emit)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'pend-activation')
  assert.equal(decisions[0].subscriptionId, 'sub-ext')
  assert.equal(decisions[0].target, 'reviewer')
})

test('emits from another source or failing the field match do not fire', () => {
  const state = stateWithSubscription(
    externalSubscription({ on: { on: 'external', topic: 'git', match: { ref: 'refs/heads/main' } } })
  )
  const wrongSource = mkEvent('external.git', { sourceId: 'src-other' })
  fold([wrongSource], state)
  assert.deepEqual(evaluate(state, wrongSource), [])
  const wrongField = mkEvent('external.git', {
    sourceId: 'src-git',
    ref: 'refs/heads/dev',
  })
  fold([wrongField], state)
  assert.deepEqual(evaluate(state, wrongField), [])
})

test('maxFirings stops an external edge at the fire attempt', () => {
  const state = stateWithSubscription(
    externalSubscription({ stop: { maxFirings: 2 }, firings: 2 })
  )
  const emit = mkEvent('external.git', { sourceId: 'src-git' })
  fold([emit], state)
  const decisions = evaluate(state, emit)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'stop-subscription')
  assert.match(decisions[0].reason, /maxFirings=2/)
})

// --- static check: external edges are pure entry points ---

test('external edges never count as cyclic; downstream session cycles still do', () => {
  const acyclic = stateWithSubscription(externalSubscription())
  const checkedAcyclic = staticCheck(acyclic)
  assert.equal(checkedAcyclic.ok, true)
  assert.deepEqual(checkedAcyclic.cyclicSubscriptionIds, [])

  // reviewer → fixer → reviewer downstream ring plus the external entry.
  const ring = fold(
    [
      mkEvent('subscription.authored', {
        subscription: externalSubscription({
          id: 'sub-a',
          source: { kind: 'session', sessionId: 'reviewer' },
          on: { on: 'finished' },
          target: { kind: 'session', sessionId: 'fixer' },
        }),
      }),
      mkEvent('subscription.authored', {
        subscription: externalSubscription({
          id: 'sub-b',
          source: { kind: 'session', sessionId: 'fixer' },
          on: { on: 'finished' },
          target: { kind: 'session', sessionId: 'reviewer' },
        }),
      }),
    ],
    stateWithSubscription(externalSubscription())
  )
  const checkedRing = staticCheck(ring)
  assert.deepEqual(
    [...checkedRing.cyclicSubscriptionIds].sort(),
    ['sub-a', 'sub-b'],
    'the external entry edge stays off the cycle'
  )
})
