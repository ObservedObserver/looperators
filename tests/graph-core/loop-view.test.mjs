import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loopsOf,
  loopTimelineOf,
} from '../../dist-electron/shared/graph-core/index.js'

// Hand-built kernel states: loopsOf is a pure projection over KernelState,
// so the fixtures spell out exactly the shape under test.

function session(sessionId, overrides = {}) {
  return { sessionId, status: 'idle', frozen: false, archived: false, ...overrides }
}

function sub(id, from, to, overrides = {}) {
  return {
    id,
    source: { kind: 'session', sessionId: from },
    on: { on: 'finished' },
    target: { kind: 'session', sessionId: to },
    action: { kind: 'deliver+activate' },
    gate: 'auto',
    concurrency: 'coalesce',
    onStop: 'freeze-edge',
    state: 'active',
    firings: 0,
    stop: { maxFirings: 6 },
    ...overrides,
  }
}

function kernelState({ sessions = [], subscriptions = [], pending = [] } = {}) {
  return {
    lastSeq: 0,
    sessions: Object.fromEntries(sessions.map((item) => [item.sessionId, item])),
    subscriptions: Object.fromEntries(subscriptions.map((item) => [item.id, item])),
    scopes: {},
    pending: Object.fromEntries(pending.map((item) => [item.slotKey, item])),
    links: {},
  }
}

function ringState(overridesA = {}, overridesB = {}, extras = {}) {
  return kernelState({
    sessions: [
      session('coder', extras.coder),
      session('reviewer', extras.reviewer),
    ],
    subscriptions: [
      sub('sub-a', 'coder', 'reviewer', { firings: 2, ...overridesA }),
      sub('sub-b', 'reviewer', 'coder', {
        on: { on: 'report' },
        firings: 1,
        ...overridesB,
      }),
    ],
    pending: extras.pending ?? [],
  })
}

test('a two-session ring projects one loop with laps and cap', () => {
  const loops = loopsOf(ringState())
  assert.equal(loops.length, 1)
  const [loop] = loops
  assert.equal(loop.loopId, 'coder+reviewer')
  assert.deepEqual(loop.memberSessionIds, ['coder', 'reviewer'])
  assert.deepEqual(loop.subscriptionIds, ['sub-a', 'sub-b'])
  assert.equal(loop.designatedSubscriptionId, 'sub-a', 'max firings designates')
  assert.equal(loop.lapCount, 2)
  assert.equal(loop.lapCap, 6)
  assert.equal(loop.status, 'idle')
  assert.match(loop.stopSummary, /max 6/)
})

test('acyclic edges and deliver-only edges never form a loop', () => {
  const chain = kernelState({
    sessions: [session('a'), session('b')],
    subscriptions: [sub('one-way', 'a', 'b')],
  })
  assert.deepEqual(loopsOf(chain), [])

  const deliverRing = kernelState({
    sessions: [session('a'), session('b')],
    subscriptions: [
      sub('d1', 'a', 'b', { action: { kind: 'deliver' } }),
      sub('d2', 'b', 'a', { action: { kind: 'deliver' } }),
    ],
  })
  assert.deepEqual(loopsOf(deliverRing), [], 'deliver-only edges activate nobody')
})

test('a timer feeding a ring member stays outside the ring', () => {
  const state = ringState()
  state.subscriptions['tick'] = sub('tick', undefined, 'coder', {
    source: { kind: 'timer' },
    on: { on: 'schedule', everySeconds: 60 },
  })
  const loops = loopsOf(state)
  assert.equal(loops.length, 1)
  assert.deepEqual(loops[0].subscriptionIds, ['sub-a', 'sub-b'])
})

test('status: a running member spins the ring', () => {
  const loops = loopsOf(ringState({}, {}, { coder: { status: 'running' } }))
  assert.equal(loops[0].status, 'spinning')
})

test('status: a pending slot on a ring edge waits at the gate', () => {
  const loops = loopsOf(
    ringState(
      { gate: 'master' },
      {},
      {
        pending: [
          {
            slotKey: 'sub-a→reviewer',
            subscriptionId: 'sub-a',
            target: 'reviewer',
            triggerEventId: 'evt-1',
            status: 'pending',
            createdAtSeq: 1,
          },
        ],
      }
    )
  )
  assert.equal(loops[0].status, 'waiting-gate')
  assert.equal(loops[0].statusDetail, 'gate master')
})

test('status: an approved slot counts as spinning, not waiting', () => {
  const loops = loopsOf(
    ringState({}, {}, {
      pending: [
        {
          slotKey: 'sub-a→reviewer',
          subscriptionId: 'sub-a',
          target: 'reviewer',
          triggerEventId: 'evt-1',
          status: 'approved',
          createdAtSeq: 1,
        },
      ],
    })
  )
  assert.equal(loops[0].status, 'spinning')
})

test('status: a frozen member freezes the ring and surfaces the reason', () => {
  const loops = loopsOf(
    ringState({}, {}, { reviewer: { frozen: true, freezeReason: 'budget' } })
  )
  assert.equal(loops[0].status, 'frozen')
  assert.equal(loops[0].statusDetail, 'budget')
})

test('status: one stopped edge ends the ring but keeps its face', () => {
  const loops = loopsOf(ringState({ state: 'stopped' }))
  assert.equal(loops.length, 1, 'the stopped ring still projects')
  assert.equal(loops[0].status, 'stopped')
  assert.deepEqual(loops[0].subscriptionIds, ['sub-a', 'sub-b'])
})

test('status: a fully stopped ring is stopped', () => {
  const loops = loopsOf(ringState({ state: 'stopped' }, { state: 'stopped' }))
  assert.equal(loops[0].status, 'stopped')
})

// --- Per-lap timeline grouping ---

let seq = 0
function evt(type, payload = {}, overrides = {}) {
  seq += 1
  return {
    seq,
    id: overrides.id ?? `evt-${seq}`,
    ts: overrides.ts ?? `2026-07-08T09:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    actor: overrides.actor ?? { kind: 'runtime' },
    causeId: overrides.causeId,
    reason: overrides.reason,
    payload,
  }
}

function ringLoop() {
  return {
    loopId: 'coder+reviewer',
    memberSessionIds: ['coder', 'reviewer'],
    subscriptionIds: ['sub-a', 'sub-b'],
    designatedSubscriptionId: 'sub-a',
  }
}

test('loopTimelineOf groups hops into laps at the designated edge', () => {
  seq = 0
  const finishedA = evt('session.finished', { sessionId: 'coder' })
  const events = [
    finishedA,
    evt('activation.pending', { subscriptionId: 'sub-a', target: 'reviewer', slotKey: 'k-a' }),
    evt(
      'activation.approved',
      { subscriptionId: 'sub-a', target: 'reviewer', slotKey: 'k-a' },
      { actor: { kind: 'rule', ref: 'sub-a' }, reason: 'Auto gate: approved deterministically.' }
    ),
    evt(
      'activated',
      { target: 'reviewer', sessionId: 'reviewer', subscriptionId: 'sub-a', slotKey: 'k-a' },
      { id: 'act-1', causeId: finishedA.id, actor: { kind: 'rule', ref: 'sub-a' } }
    ),
    evt('report.received', { reportId: 'r1', from: 'reviewer', verdict: 'dirty', summary: 'two issues' }),
    evt(
      'activation.approved',
      { subscriptionId: 'sub-b', target: 'coder', slotKey: 'k-b' },
      { actor: { kind: 'master', ref: 'boss' }, reason: 'Only fix P0.' }
    ),
    evt(
      'activated',
      { target: 'coder', sessionId: 'coder', subscriptionId: 'sub-b', slotKey: 'k-b' },
      { id: 'act-2', causeId: 'evt-5' }
    ),
    evt('session.finished', { sessionId: 'coder' }, { causeId: 'act-2' }),
    evt(
      'activation.approved',
      { subscriptionId: 'sub-a', target: 'reviewer', slotKey: 'k-a' },
      { actor: { kind: 'rule', ref: 'sub-a' } }
    ),
    evt(
      'activated',
      { target: 'reviewer', sessionId: 'reviewer', subscriptionId: 'sub-a', slotKey: 'k-a' },
      { id: 'act-3', causeId: 'evt-8' }
    ),
  ]

  const timeline = loopTimelineOf(kernelState(), events, ringLoop())
  assert.equal(timeline.laps.length, 2, 'two designated activations, two laps')

  const [lap1, lap2] = timeline.laps
  assert.equal(lap1.index, 1)
  assert.equal(lap1.hops.length, 2, 'lap 1 = coder→reviewer hop + lap-back hop')

  const [hop1, hop2] = lap1.hops
  assert.equal(hop1.subscriptionId, 'sub-a')
  assert.equal(hop1.target, 'reviewer')
  assert.equal(hop1.trigger.type, 'session.finished')
  assert.equal(hop1.trigger.sourceSessionId, 'coder')
  assert.match(hop1.gate.reason, /Auto gate/)
  assert.equal(hop1.reports.length, 1)
  assert.equal(hop1.reports[0].verdict, 'dirty')

  assert.equal(hop2.subscriptionId, 'sub-b')
  assert.equal(hop2.gate.actor.kind, 'master', 'the master approval is readable')
  assert.equal(hop2.gate.reason, 'Only fix P0.')
  assert.equal(hop2.outcome.type, 'finished', 'causeId chains the terminal fact')

  assert.equal(lap2.index, 2)
  assert.equal(lap2.hops.length, 1)
  assert.equal(lap2.hops[0].subscriptionId, 'sub-a')
})

test('a causeId-less terminal fact closes the open hop of its own target, even after another hop started', () => {
  seq = 0
  const events = [
    evt(
      'activated',
      { target: 'reviewer', sessionId: 'reviewer', subscriptionId: 'sub-a', slotKey: 'k-a' },
      { id: 'act-1' }
    ),
    evt(
      'activated',
      { target: 'coder', sessionId: 'coder', subscriptionId: 'sub-b', slotKey: 'k-b' },
      { id: 'act-2' }
    ),
    // No causeId: e.g. a manually resumed turn's finish. The reviewer hop is
    // no longer the newest, but it is the open hop for this target.
    evt('session.finished', { sessionId: 'reviewer' }),
  ]
  const timeline = loopTimelineOf(kernelState(), events, ringLoop())
  const hops = timeline.laps.flatMap((lap) => lap.hops)
  const reviewerHop = hops.find((hop) => hop.target === 'reviewer')
  const coderHop = hops.find((hop) => hop.target === 'coder')
  assert.equal(reviewerHop.outcome?.type, 'finished')
  assert.equal(coderHop.outcome, undefined, 'the other target stays open')
})

test('loopTimelineOf collects refusals and stop facts', () => {
  seq = 0
  const events = [
    evt(
      'activation.denied',
      { subscriptionId: 'sub-a', target: 'reviewer', slotKey: 'k-a' },
      { actor: { kind: 'master', ref: 'boss' }, reason: 'Not now.' }
    ),
    evt(
      'subscription.stopped',
      { subscriptionId: 'sub-b' },
      { reason: 'Stop condition met: maxFirings 6 reached.' }
    ),
    evt('activation.denied', { subscriptionId: 'unrelated', slotKey: 'k-x' }),
  ]
  const timeline = loopTimelineOf(kernelState(), events, ringLoop())
  assert.equal(timeline.laps.length, 0)
  assert.equal(timeline.refusals.length, 1, 'foreign subscriptions stay out')
  assert.equal(timeline.refusals[0].type, 'denied')
  assert.equal(timeline.refusals[0].reason, 'Not now.')
  assert.equal(timeline.stops.length, 1)
  assert.match(timeline.stops[0].reason, /maxFirings/)
})
