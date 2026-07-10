import assert from 'node:assert/strict'
import test from 'node:test'

import { codexRuntimeEventsFromMessage } from '../../dist-electron/electron/runtime/providers/codexRuntimeMapper.js'

test('codex mapper emits completed agentMessage as an authoritative message with phase', () => {
  const events = codexRuntimeEventsFromMessage({
    sessionId: 'session-1',
    turnId: 'turn-1',
    message: {
      method: 'item/completed',
      params: {
        completedAtMs: Date.parse('2026-07-08T00:00:00.000Z'),
        item: {
          id: 'codex-message-1',
          type: 'agentMessage',
          text: 'final answer',
          phase: 'final_answer',
          status: 'completed',
        },
      },
    },
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'message.completed')
  assert.equal(events[0].message.providerItemId, 'codex-message-1')
  assert.equal(events[0].message.content, 'final answer')
  assert.equal(events[0].message.phase, 'final_answer')
  assert.equal(events[0].message.runId, 'turn-1')
})

test('codex mapper keeps reasoning transcript items out of generic activity', () => {
  const events = codexRuntimeEventsFromMessage({
    sessionId: 'session-1',
    turnId: 'turn-1',
    message: {
      method: 'item/completed',
      params: {
        completedAtMs: Date.parse('2026-07-08T00:00:00.000Z'),
        item: {
          id: 'reasoning-1',
          type: 'reasoning',
          summary: ['internal note'],
          status: 'completed',
        },
      },
    },
  })

  assert.deepEqual(events, [])
})
