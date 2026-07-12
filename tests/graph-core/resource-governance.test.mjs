import assert from 'node:assert/strict'
import test from 'node:test'

import {
  budgetExceeded,
  leaseCompatible,
  normalizeProviderUsage,
  projectRuntimeUsage,
  selectFairQueuedRun,
  usageTotals,
} from '../../dist-electron/shared/resource-governance.js'

test('workspace leases allow readers together and serialize every writer', () => {
  const activeReader = { workspaceKey: '/repo', mode: 'reader', turnId: 'a', status: 'active' }
  assert.equal(leaseCompatible([activeReader], { workspaceKey: '/repo', mode: 'reader', turnId: 'b' }), true)
  assert.equal(leaseCompatible([activeReader], { workspaceKey: '/repo', mode: 'writer', turnId: 'b' }), false)
  assert.equal(leaseCompatible([{ ...activeReader, mode: 'writer' }], { workspaceKey: '/repo', mode: 'reader', turnId: 'b' }), false)
  assert.equal(leaseCompatible([activeReader], { workspaceKey: '/other', mode: 'writer', turnId: 'b' }), true)
})

test('usage projects from immutable run facts to node, loop, workflow, and scope views', () => {
  const facts = [
    { turnId: 'r1', sessionId: 'n1', scopeId: 's1', totalTokens: 10, durationMs: 20, toolCalls: 1, execution: { workflowId: 'w1' }, loopIds: ['l1'] },
    { turnId: 'r2', sessionId: 'n1', scopeId: 's1', totalTokens: 5, durationMs: 10, toolCalls: 0, execution: { workflowId: 'w1' }, loopIds: ['l1'] },
  ]
  const projection = projectRuntimeUsage(facts, { sessionToLoopIds: { n1: ['l1'] } })
  assert.deepEqual(projection.runs.r1, { turns: 1, tokens: 10, durationMs: 20, toolCalls: 1 })
  assert.deepEqual(projection.nodes.n1, { turns: 2, tokens: 15, durationMs: 30, toolCalls: 1 })
  assert.deepEqual(projection.loops.l1, projection.nodes.n1)
  assert.deepEqual(projection.workflows.w1, projection.nodes.n1)
  assert.deepEqual(projection.scopes.s1, projection.nodes.n1)
})

test('fair queue uses priority, age, then stable FIFO order', () => {
  const now = Date.parse('2026-07-12T00:01:00.000Z')
  const queued = [
    { queueId: 'new-high', priority: 30, order: 2, queuedAt: '2026-07-12T00:00:50.000Z' },
    { queueId: 'old-low', priority: 0, order: 1, queuedAt: '2026-07-12T00:00:00.000Z' },
  ]
  assert.equal(selectFairQueuedRun(queued, now, () => true).queueId, 'old-low', 'aging prevents starvation')
  assert.equal(selectFairQueuedRun(queued, now, (item) => item.queueId !== 'old-low').queueId, 'new-high')
})

test('usage facts remain price-free and support deterministic budget projections', () => {
  const usage = normalizeProviderUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 })
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, totalTokens: 14 })
  const facts = [{ totalTokens: 14, durationMs: 100, toolCalls: 2 }, { totalTokens: 6, durationMs: 50, toolCalls: 0 }]
  assert.deepEqual(usageTotals(facts), { turns: 2, tokens: 20, durationMs: 150, toolCalls: 2 })
  assert.deepEqual(budgetExceeded({ maxTurns: 2, maxTokens: 100, maxDurationMs: 1000, maxToolCalls: 10 }, facts), { dimension: 'turns', used: 2, limit: 2 })
  assert.equal('cost' in usage, false)
})
