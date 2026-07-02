import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fold,
  governingMaster,
  lowestCommonScope,
  graphScopeId,
  reportRoute,
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

// Scope forest: graph (master gm) ⊃ cluster c1 (master m1, members w1 w2)
// and cluster c2 (no master, members w3).
function forestState({ withGraphMaster = true, withClusterMaster = true } = {}) {
  seq = 0
  const events = [
    event('scope.upserted', { clusterId: 'c1', nodeIds: ['w1', 'w2'] }),
    event('scope.upserted', { clusterId: 'c2', nodeIds: ['w3'] }),
  ]
  if (withClusterMaster) {
    events.push(event('role.assigned', { clusterId: 'c1', masterSessionId: 'm1' }))
  }
  if (withGraphMaster) {
    events.push(
      event('scope.upserted', {
        scopeId: 'scope:root',
        kind: 'graph',
        nodeIds: [],
        masterSessionId: 'gm',
      })
    )
  }
  return fold(events)
}

function sub(sourceSessionId, targetSessionId, overrides = {}) {
  return {
    id: 'sub',
    source: { kind: 'session', sessionId: sourceSessionId },
    on: { on: 'finished' },
    target: { kind: 'session', sessionId: targetSessionId },
    action: { kind: 'deliver+activate' },
    gate: 'master',
    concurrency: 'coalesce',
    onStop: 'freeze-edge',
    state: 'active',
    firings: 0,
    ...overrides,
  }
}

test('R1: intra-cluster subscriptions route to the cluster master, never the graph master', () => {
  const state = forestState()
  assert.equal(lowestCommonScope(state, 'w1', 'w2'), 'c1')
  assert.equal(governingMaster(state, sub('w1', 'w2')), 'm1')
})

test('R1: cross-cluster subscriptions escalate to the graph master', () => {
  const state = forestState()
  assert.equal(lowestCommonScope(state, 'w1', 'w3'), graphScopeId)
  assert.equal(governingMaster(state, sub('w1', 'w3')), 'gm')
})

test('R1: a cluster without a master escalates upward; nothing above means human/UI', () => {
  const withGraph = forestState({ withClusterMaster: false })
  assert.equal(
    governingMaster(withGraph, sub('w1', 'w2')),
    'gm',
    'masterless cluster escalates to the graph master'
  )

  const bare = forestState({ withClusterMaster: false, withGraphMaster: false })
  assert.equal(
    governingMaster(bare, sub('w1', 'w2')),
    undefined,
    'no master anywhere → governance falls to the human/UI'
  )
})

test('R1: cluster-source subscriptions use the cluster scope for the LCA', () => {
  const state = forestState()
  const clusterSub = sub('w1', 'w2', {
    source: { kind: 'cluster', clusterId: 'c1' },
  })
  assert.equal(governingMaster(state, clusterSub), 'm1')

  const outbound = sub('w1', 'w3', {
    source: { kind: 'cluster', clusterId: 'c1' },
    target: { kind: 'session', sessionId: 'w3' },
  })
  assert.equal(governingMaster(state, outbound), 'gm')
})

test('R2: reports route to the nearest ancestor scope with a master', () => {
  const state = forestState()
  assert.equal(reportRoute(state, 'w1'), 'm1')
  assert.equal(
    reportRoute(state, 'w3'),
    'gm',
    'a masterless cluster routes reports upward'
  )
})

test('a session outside every scope routes reports to the graph master or human', () => {
  const state = forestState()
  assert.equal(reportRoute(state, 'loner'), 'gm')
  const bare = forestState({ withGraphMaster: false })
  assert.equal(reportRoute(bare, 'loner'), undefined)
})

test('a cyclic parentId chain terminates deterministically', () => {
  seq = 0
  const state = fold([
    event('scope.upserted', { scopeId: 'c1', nodeIds: ['w1'], parentId: 'c2' }),
    event('scope.upserted', { scopeId: 'c2', nodeIds: [], parentId: 'c1' }),
  ])
  // No master anywhere on the (cyclic) chain: must terminate and fall to
  // the human/UI rather than loop forever.
  assert.equal(governingMaster(state, sub('w1', 'w1')), undefined)
  assert.equal(reportRoute(state, 'w1'), undefined)
})

test("R2: a master's own report never routes to itself", () => {
  const state = forestState()
  assert.equal(
    reportRoute(state, 'm1'),
    'gm',
    'the cluster master reports upward, not to itself'
  )

  const bare = forestState({ withGraphMaster: false })
  assert.equal(
    reportRoute(bare, 'm1'),
    undefined,
    'with nothing above, the master reports to the human/UI'
  )
})
