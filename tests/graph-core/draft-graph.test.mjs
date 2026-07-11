import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileDraftRelation,
  draftNodePositionUpdates,
  emptyDraftGraph,
  reduceDraftGraph,
  validateDraftGraph,
} from '../../dist-electron/shared/draft-graph.js'

function newAgent(label, prompt, overrides = {}) {
  return {
    position: { x: 100, y: 120 },
    endpoint: {
      kind: 'new',
      label,
      prompt,
      cwd: '/workspace',
      workMode: 'local',
      providerKind: 'claude-code',
      providerInstanceId: 'claude-main',
      runtimeSettings: { runtimeMode: 'approval-required' },
      ...overrides,
    },
  }
}

function twoNodeGraph() {
  let graph = emptyDraftGraph()
  graph = reduceDraftGraph(graph, { type: 'add-node', id: 'coder', node: newAgent('Coder', 'Implement the requested change.') })
  graph = reduceDraftGraph(graph, {
    type: 'add-node',
    id: 'reviewer',
    node: newAgent('Reviewer', 'Review the implementation.', {
      providerKind: 'codex',
      providerInstanceId: 'codex-reviewer',
    }),
  })
  return graph
}

test('draft graph reducer adds, selects, edits, and removes nodes and relations', () => {
  let graph = twoNodeGraph()
  assert.deepEqual(graph.nodeOrder, ['coder', 'reviewer'])
  assert.deepEqual(graph.selection, { kind: 'node', id: 'reviewer' })

  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'review',
    relation: {
      kind: 'review-loop',
      sourceNodeId: 'coder',
      targetNodeId: 'reviewer',
      instruction: 'Review against SPEC.md.',
      review: { blocking: { mode: 'p0-p1' }, maxLaps: 6 },
    },
  })
  assert.deepEqual(graph.selection, { kind: 'relation', id: 'review' })

  graph = reduceDraftGraph(graph, {
    type: 'update-node',
    id: 'coder',
    patch: { position: { x: 420, y: 240 } },
  })
  graph = reduceDraftGraph(graph, {
    type: 'update-relation',
    id: 'review',
    patch: { review: { blocking: { mode: 'any-issue' }, maxLaps: 4 } },
  })
  assert.deepEqual(graph.nodes.coder.position, { x: 420, y: 240 })
  assert.equal(graph.relations.review.review.maxLaps, 4)

  graph = reduceDraftGraph(graph, { type: 'remove-node', id: 'reviewer' })
  assert.equal(graph.nodes.reviewer, undefined)
  assert.equal(graph.relations.review, undefined, 'incident relations are removed with the node')
  assert.equal(graph.selection, undefined)
})

test('draft validation localizes node and relation errors', () => {
  let graph = emptyDraftGraph()
  graph = reduceDraftGraph(graph, {
    type: 'add-node',
    id: 'broken',
    node: newAgent('', '', { cwd: '', providerInstanceId: '' }),
  })
  graph = reduceDraftGraph(graph, { type: 'add-node', id: 'target', node: newAgent('Target', 'Do work.') })
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'self',
    relation: {
      kind: 'handoff-once',
      sourceNodeId: 'broken',
      targetNodeId: 'broken',
      instruction: '',
    },
  })

  const result = validateDraftGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.target === 'node' && issue.id === 'broken' && issue.field === 'prompt'))
  assert.ok(result.issues.some((issue) => issue.target === 'node' && issue.id === 'broken' && issue.field === 'cwd'))
  assert.ok(result.issues.some((issue) => issue.target === 'relation' && issue.id === 'self' && issue.field === 'targetNodeId'))
  assert.ok(result.issues.some((issue) => issue.target === 'node' && issue.id === 'target' && issue.field === 'relationship'))
})

test('relation compiler maps classic choices and reuses the P1 review payload', () => {
  let graph = twoNodeGraph()
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'handoff',
    relation: {
      kind: 'handoff-once',
      sourceNodeId: 'coder',
      targetNodeId: 'reviewer',
      instruction: 'Continue from this result.',
    },
  })
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'trigger',
    relation: {
      kind: 'trigger-on-completion',
      sourceNodeId: 'reviewer',
      targetNodeId: 'coder',
      instruction: 'Handle every future completion.',
    },
  })
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'review',
    relation: {
      kind: 'review-loop',
      sourceNodeId: 'coder',
      targetNodeId: 'reviewer',
      instruction: 'Review against SPEC.md.',
      review: { blocking: { mode: 'p0-p1' }, maxLaps: 5 },
    },
  })

  const handoff = compileDraftRelation(graph, 'handoff')
  assert.equal(handoff.kind, 'subscription')
  assert.deepEqual(handoff.stop, { maxFirings: 1 })
  const trigger = compileDraftRelation(graph, 'trigger')
  assert.equal(trigger.kind, 'subscription')
  assert.equal(trigger.stop, undefined)
  const review = compileDraftRelation(graph, 'review')
  assert.equal(review.kind, 'review-workflow')
  assert.equal(review.input.coder.prompt, 'Implement the requested change.')
  assert.equal(review.input.reviewer.instruction, 'Review the implementation.\n\nReview against SPEC.md.')
  assert.equal(review.input.blocking.mode, 'p0-p1')
  assert.equal(review.input.maxLaps, 5)
})

test('draft ids map to runtime session ids without changing canvas positions', () => {
  const graph = twoNodeGraph()
  const mapping = {
    nodeSessionIds: { coder: 'session-a', reviewer: 'session-b' },
    relationSubscriptionIds: {},
  }
  assert.deepEqual(draftNodePositionUpdates(graph, mapping), [
    { nodeId: 'session-a', position: { x: 100, y: 120 } },
    { nodeId: 'session-b', position: { x: 100, y: 120 } },
  ])
})

test('draft validation rejects manually reversed cycles and unavailable endpoints', () => {
  let graph = twoNodeGraph()
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'forward',
    relation: { kind: 'trigger-on-completion', sourceNodeId: 'coder', targetNodeId: 'reviewer', instruction: '' },
  })
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'reverse',
    relation: { kind: 'trigger-on-completion', sourceNodeId: 'reviewer', targetNodeId: 'coder', instruction: '' },
  })
  const validation = validateDraftGraph(graph, { providerInstanceIds: ['claude-main'] })
  assert.ok(validation.issues.some((issue) => issue.target === 'graph' && issue.field === 'cycle'))
  assert.ok(validation.issues.some((issue) => issue.target === 'node' && issue.id === 'reviewer' && issue.field === 'providerInstanceId'))
})

test('static Draft directs existing Agents to the atomic dynamic connection path', () => {
  let graph = twoNodeGraph()
  graph = reduceDraftGraph(graph, {
    type: 'update-node',
    id: 'reviewer',
    patch: { endpoint: { kind: 'existing', sessionId: 'reviewer-session', prompt: 'Review the implementation.' } },
  })
  graph = reduceDraftGraph(graph, {
    type: 'add-relation',
    id: 'review',
    relation: {
      kind: 'review-loop',
      sourceNodeId: 'coder',
      targetNodeId: 'reviewer',
      instruction: 'Review against SPEC.md.',
      review: { blocking: { mode: 'p0-p1' }, maxLaps: 6 },
    },
  })
  const validation = validateDraftGraph(graph, {
    sessions: { 'reviewer-session': { sessionId: 'reviewer-session', cwd: '/workspace', status: 'idle' } },
  })
  assert.ok(validation.issues.some((issue) => issue.field === 'sessionId' && /connect dynamically/.test(issue.message)))
})
