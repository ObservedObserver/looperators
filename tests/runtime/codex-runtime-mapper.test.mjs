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
        turnId: 'provider-turn-1',
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
  assert.equal(events[0].message.providerTurnId, 'provider-turn-1')
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

test('codex mapper projects valid thread goal updates and clears', () => {
  const goal = {
    threadId: 'thread-1',
    objective: 'Finish safely',
    status: 'paused',
    tokenBudget: 40000,
    tokensUsed: 120,
    timeUsedSeconds: 8,
    createdAt: 100,
    updatedAt: 105,
  }
  const [updated] = codexRuntimeEventsFromMessage({
    sessionId: 'session-1',
    turnId: 'run-1',
    message: { method: 'thread/goal/updated', params: { threadId: 'thread-1', goal } },
  })
  assert.equal(updated.type, 'thread.goal.updated')
  assert.deepEqual(updated.goal, goal)

  const [cleared] = codexRuntimeEventsFromMessage({
    sessionId: 'session-1',
    turnId: 'run-1',
    message: { method: 'thread/goal/cleared', params: { threadId: 'thread-1' } },
  })
  assert.equal(cleared.type, 'thread.goal.cleared')

  assert.deepEqual(codexRuntimeEventsFromMessage({
    sessionId: 'session-1',
    turnId: 'run-1',
    message: { method: 'thread/goal/updated', params: { goal: { ...goal, status: 'bad' } } },
  }), [])
})
