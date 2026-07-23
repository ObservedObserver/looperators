import assert from 'node:assert/strict'
import test from 'node:test'

import { createBatchedRuntimeEventEmitter } from '../../dist-electron/electron/runtime/runtimeEventDelivery.js'

test('runtime event delivery batches consecutive provider events without reordering Sessions', () => {
  const emitted = []
  const publish = createBatchedRuntimeEventEmitter(
    (event) => emitted.push(event),
    { batchMs: 60_000 },
  )

  publish({
    type: 'provider.runtime',
    sessionId: 'session-a',
    providerEvent: { id: 'a1', type: 'content.delta' },
  })
  publish({
    type: 'provider.runtime',
    sessionId: 'session-b',
    providerEvent: { id: 'b1', type: 'content.delta' },
  })
  publish({
    type: 'provider.runtime',
    sessionId: 'session-a',
    providerEvent: { id: 'a2', type: 'item.completed' },
  })
  publish.flush()

  assert.deepEqual(emitted, [
    {
      type: 'session.stream',
      sessionId: 'session-a',
      providerEvents: [{ id: 'a1', type: 'content.delta' }],
    },
    {
      type: 'session.stream',
      sessionId: 'session-b',
      providerEvents: [{ id: 'b1', type: 'content.delta' }],
    },
    {
      type: 'session.stream',
      sessionId: 'session-a',
      providerEvents: [{ id: 'a2', type: 'item.completed' }],
    },
  ])
})

test('state boundaries discard provider batches already covered by the snapshot', () => {
  const emitted = []
  const publish = createBatchedRuntimeEventEmitter(
    (event) => emitted.push(event),
    { batchMs: 60_000 },
  )
  publish({
    type: 'provider.runtime',
    sessionId: 'session-a',
    providerEvent: { id: 'a1', type: 'content.delta' },
  })
  publish({ type: 'session.finished', sessionId: 'session-a', state: { version: 1 } })

  assert.deepEqual(emitted, [
    { type: 'session.finished', sessionId: 'session-a', state: { version: 1 } },
  ])
})
