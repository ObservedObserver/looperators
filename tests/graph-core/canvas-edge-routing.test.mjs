import assert from 'node:assert/strict'
import test from 'node:test'

import { routeRuntimeAgentEdges } from '../../dist-electron/shared/canvas-edge-routing.js'

function agent(id, x, y = 0) {
  return { id, type: 'agent', position: { x, y } }
}

function readability(id, source, target) {
  return { id, type: 'readability', source, target }
}

test('reciprocal Agent edges use distinct same-side channels', () => {
  const nodes = [agent('left', 0), agent('right', 600)]
  const edges = [readability('outbound', 'left', 'right'), readability('return', 'right', 'left')]

  assert.deepEqual(routeRuntimeAgentEdges(edges, nodes), [
    { ...edges[0], sourceHandle: 'source-right', targetHandle: 'target-right' },
    { ...edges[1], sourceHandle: 'source-left', targetHandle: 'target-left' },
  ])
})

test('reciprocal vertical Agent edges still get stable opposite channels', () => {
  const nodes = [agent('top', 100, 0), agent('bottom', 100, 500)]
  const edges = [readability('down', 'top', 'bottom'), readability('up', 'bottom', 'top')]

  const routed = routeRuntimeAgentEdges(edges, nodes)
  assert.equal(routed[0].sourceHandle, 'source-right')
  assert.equal(routed[0].targetHandle, 'target-right')
  assert.equal(routed[1].sourceHandle, 'source-left')
  assert.equal(routed[1].targetHandle, 'target-left')
})

test('one-way Agent edges use nearest facing ports', () => {
  const nodes = [agent('left', 0), agent('right', 600)]
  const edges = [readability('forward', 'left', 'right')]

  assert.deepEqual(routeRuntimeAgentEdges(edges, nodes), [
    { ...edges[0], sourceHandle: 'source-right', targetHandle: 'target-left' },
  ])
})

test('synthetic endpoints retain their own handles while the Agent endpoint is routed', () => {
  const nodes = [
    { id: 'clock', type: 'clock', position: { x: 0, y: 0 } },
    agent('worker', 500),
  ]
  const edge = readability('scheduled', 'clock', 'worker')

  assert.deepEqual(routeRuntimeAgentEdges([edge], nodes), [
    { ...edge, targetHandle: 'target-left' },
  ])
})

test('Agent self-loops use an explicit same-side channel', () => {
  const node = agent('worker', 0)
  const edge = readability('retry-self', 'worker', 'worker')

  assert.deepEqual(routeRuntimeAgentEdges([edge], [node]), [
    { ...edge, sourceHandle: 'source-right', targetHandle: 'target-right' },
  ])
})

test('draft, missing-node, and non-Agent edges are left untouched', () => {
  const nodes = [
    agent('agent', 0),
    { id: 'draft', type: 'draft-agent', position: { x: 500, y: 0 } },
    { id: 'clock', type: 'clock', position: { x: -500, y: 0 } },
  ]
  const edges = [
    { id: 'draft-edge', type: 'draft', source: 'agent', target: 'draft' },
    readability('missing', 'missing', 'agent'),
    readability('synthetic', 'clock', 'draft'),
  ]

  const routed = routeRuntimeAgentEdges(edges, nodes)
  assert.deepEqual(routed, edges)
  assert.ok(routed.every((edge, index) => edge === edges[index]))
})
