import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  grokRuntimeEventsFromNotification,
  grokRuntimeEventsFromRequest,
} from '../../dist-electron/electron/runtime/providers/grokRuntimeMapper.js'

const wire = JSON.parse(
  fs.readFileSync('tests/runtime/fixtures/grok-acp-0.2.93-wire.json', 'utf8')
).messages.map((entry) => entry.message)

function notificationForUpdate(kind) {
  return wire.find(
    (message) =>
      message.method === 'session/update' &&
      message.params?.update?.sessionUpdate === kind
  )
}

const context = { sessionId: 'session-1', turnId: 'turn-1' }

test('Grok mapper converts text and tool lifecycle from pinned real wire', () => {
  const text = grokRuntimeEventsFromNotification({
    ...context,
    message: notificationForUpdate('agent_message_chunk'),
  })
  assert.equal(text[0].type, 'content.delta')
  assert.equal(text[0].streamKind, 'assistant_text')
  assert.match(text[0].text, /Created probe\.txt/)
  assert.equal(text[0].raw.source, 'grok.acp.notification')

  const started = grokRuntimeEventsFromNotification({
    ...context,
    message: notificationForUpdate('tool_call'),
  })
  assert.equal(started[0].type, 'item.started')
  assert.equal(started[0].item.id, '$TOOL_CALL_ID')
  assert.equal(started[0].item.providerName, 'write')
  assert.equal(started[0].item.status, 'running')

  const completed = grokRuntimeEventsFromNotification({
    ...context,
    message: notificationForUpdate('tool_call_update'),
  })
  assert.equal(completed[0].type, 'item.completed')
  assert.equal(completed[0].item.status, 'completed')
  assert.match(completed[0].item.output, /created/)
})

test('Grok mapper converts plans and ignores thought/replay-only chunks', () => {
  const plan = grokRuntimeEventsFromNotification({
    ...context,
    message: {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'plan',
          entries: [
            { id: 'one', content: 'Inspect', status: 'completed' },
            { id: 'two', content: 'Implement', status: 'in_progress' },
          ],
        },
      },
    },
  })
  assert.equal(plan[0].type, 'plan.updated')
  assert.deepEqual(plan[0].plan.items.map((item) => item.status), [
    'completed',
    'in_progress',
  ])

  for (const sessionUpdate of ['agent_thought_chunk', 'user_message_chunk', 'unknown']) {
    assert.deepEqual(
      grokRuntimeEventsFromNotification({
        ...context,
        message: { method: 'session/update', params: { update: { sessionUpdate } } },
      }),
      []
    )
  }

  const replayFrames = wire.filter(
    (message) =>
      message.method === 'session/update' && message.params?._meta?.isReplay === true
  )
  assert.ok(replayFrames.length > 0, 'pinned wire must contain real replay frames')
  for (const message of replayFrames) {
    assert.deepEqual(
      grokRuntimeEventsFromNotification({ ...context, message }),
      [],
      `replay ${message.params.update.sessionUpdate} must not enter canonical projection`
    )
  }
})

test('Grok mapper converts permission and structured question requests', () => {
  const permission = grokRuntimeEventsFromRequest({
    ...context,
    message: {
      id: 10,
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 'call-1', title: 'Run tests' },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    },
  })
  assert.equal(permission[0].type, 'request.opened')
  assert.equal(permission[0].request.id, '10')
  assert.equal(permission[0].request.title, 'Run tests')
  assert.match(permission[0].request.body, /allow_once/)

  const questionMessage = wire.find(
    (message) => message.method === '_x.ai/ask_user_question'
  )
  const question = grokRuntimeEventsFromRequest({ ...context, message: questionMessage })
  assert.equal(question[0].type, 'user-input.requested')
  assert.equal(question[0].request.questions[0].id, 'choice')
  assert.equal(question[0].request.questions[0].options[1].label, 'Beta')
  assert.equal(question[0].raw.source, 'grok.xai.extension')

  const noId = grokRuntimeEventsFromRequest({
    ...context,
    message: {
      id: 11,
      method: '_x.ai/ask_user_question',
      params: { questions: [{ id: '   ', question: 'Stable question text', options: [] }] },
    },
  })
  assert.equal(noId[0].request.questions[0].id, 'Stable question text')
})

test('Grok mapper recognizes private completion and leaves unknown traffic native-only', () => {
  const completion = wire.find(
    (message) => message.method === '_x.ai/session/prompt_complete'
  )
  const events = grokRuntimeEventsFromNotification({ ...context, message: completion })
  assert.equal(events[0].type, 'turn.completed')
  assert.equal(events[0].raw.source, 'grok.xai.extension')

  assert.deepEqual(
    grokRuntimeEventsFromNotification({
      ...context,
      message: { method: '_x.ai/unknown', params: { future: true } },
    }),
    []
  )
  assert.deepEqual(
    grokRuntimeEventsFromRequest({
      ...context,
      message: { id: 99, method: 'future/request', params: {} },
    }),
    []
  )
})
