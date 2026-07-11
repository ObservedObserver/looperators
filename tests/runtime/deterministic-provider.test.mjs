import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { DeterministicProviderAdapter } from './support/deterministic-provider.mjs'

test('deterministic adapter emits canonical tool start and result activity', async () => {
  const adapter = new DeterministicProviderAdapter()
  const events = []
  const run = adapter.startTurn({
    sessionId: 'session-tool',
    turnId: 'turn-tool',
    prompt: 'ORRERY_TOOL_ACTIVITY',
    cwd: process.cwd(),
  })
  run.on('providerEvent', (event) => events.push(event))

  await once(run, 'close')

  assert.deepEqual(
    events.map((event) => event.type),
    ['item.started', 'item.completed', 'content.delta'],
  )
  assert.equal(events[0].item.id, events[1].item.id)
  assert.equal(events[0].item.kind, 'tool_call')
  assert.equal(events[1].item.kind, 'tool_call')
  assert.equal(events[1].item.output, 'deterministic tool result')
})
