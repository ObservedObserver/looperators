import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeRuntimeEventsFromMessage } from '../../dist-electron/electron/runtime/providers/claudeRuntimeMapper.js'

const base = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  ts: '2026-07-11T00:00:00.000Z',
}

test('Claude mapper emits text deltas and suppresses a later text snapshot', () => {
  const delta = claudeRuntimeEventsFromMessage({
    ...base,
    message: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    },
  })
  assert.equal(delta.length, 1)
  assert.equal(delta[0].type, 'content.delta')
  assert.equal(delta[0].text, 'hello')

  const snapshot = claudeRuntimeEventsFromMessage({
    ...base,
    sawTextDelta: true,
    message: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    },
  })
  assert.deepEqual(snapshot, [])
})

test('Claude mapper pairs tool start and tool result by provider id', () => {
  const started = claudeRuntimeEventsFromMessage({
    ...base,
    message: {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.ts' } }],
      },
    },
  })
  assert.equal(started[0].type, 'item.started')
  assert.equal(started[0].item.id, 'tool-1')
  assert.equal(started[0].item.command, 'read_file')

  const completed = claudeRuntimeEventsFromMessage({
    ...base,
    message: {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      },
    },
  })
  assert.equal(completed[0].type, 'item.completed')
  assert.equal(completed[0].item.id, 'tool-1')
})

test('Claude mapper completes results and ignores malformed or unknown messages', () => {
  const completed = claudeRuntimeEventsFromMessage({
    ...base,
    message: { type: 'result', result: 'done' },
  })
  assert.equal(completed[0].type, 'turn.completed')
  assert.deepEqual(claudeRuntimeEventsFromMessage({ ...base, message: undefined }), [])
  assert.deepEqual(claudeRuntimeEventsFromMessage({ ...base, message: { type: 'unknown' } }), [])
})
