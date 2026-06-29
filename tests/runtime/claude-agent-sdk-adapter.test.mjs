import assert from 'node:assert/strict'
import test from 'node:test'

import { ClaudeAgentSdkTurnRun } from '../../dist-electron/electron/runtime/providers/claudeAgentSdkAdapter.js'

function testRun() {
  const controller = {
    enqueue() {},
    killTurn() {
      return true
    },
  }
  return new ClaudeAgentSdkTurnRun(controller, {
    prompt: 'test',
    cwd: process.cwd(),
    sessionId: 'session-1',
    turnId: 'turn-1',
  })
}

test('ClaudeAgentSdkTurnRun resolves pending permission requests as canceled on abort', async () => {
  const run = testRun()
  const events = []
  run.on('providerEvent', (event) => events.push(event))
  const controller = new AbortController()

  const resultPromise = run.requestPermission({
    input: { command: 'echo hello' },
    options: {
      toolUseID: 'permission-1',
      signal: controller.signal,
    },
    toolName: 'Bash',
    turnId: 'turn-1',
    sessionId: 'session-1',
  })
  controller.abort()

  const result = await resultPromise
  assert.equal(result.behavior, 'deny')
  assert.equal(
    events.some(
      (event) =>
        event.type === 'request.resolved' &&
        event.requestId === 'permission-1' &&
        event.status === 'canceled'
    ),
    true
  )
})

test('ClaudeAgentSdkTurnRun marks pending permission and user-dialog requests canceled on close', async () => {
  const run = testRun()
  const events = []
  run.on('providerEvent', (event) => events.push(event))

  const permissionPromise = run.requestPermission({
    input: { file_path: 'README.md' },
    options: { toolUseID: 'permission-2' },
    toolName: 'Read',
    turnId: 'turn-1',
    sessionId: 'session-1',
  })
  const dialogPromise = run.requestUserDialog({
    request: {
      dialogKind: 'ask_user_question',
      toolUseID: 'dialog-1',
      payload: { question: 'Which branch?' },
    },
    options: {},
    turnId: 'turn-1',
    sessionId: 'session-1',
  })

  run.markClosed()

  const [permissionResult, dialogResult] = await Promise.all([
    permissionPromise,
    dialogPromise,
  ])
  assert.equal(permissionResult.behavior, 'deny')
  assert.equal(dialogResult.behavior, 'cancelled')
  assert.equal(
    events.some(
      (event) =>
        event.type === 'request.resolved' &&
        event.requestId === 'permission-2' &&
        event.status === 'canceled'
    ),
    true
  )
  assert.equal(
    events.some(
      (event) =>
        event.type === 'user-input.resolved' &&
        event.requestId === 'dialog-1' &&
        event.status === 'canceled'
    ),
    true
  )
})

test('ClaudeAgentSdkTurnRun answers ask_user_question with SDK result shape', async () => {
  const run = testRun()
  const resultPromise = run.requestUserDialog({
    request: {
      dialogKind: 'ask_user_question',
      toolUseID: 'dialog-2',
      payload: {
        questions: [
          {
            question: 'Which branch should Claude use?',
            header: 'Branch',
            options: [
              { label: 'main', description: 'Use main.' },
              { label: 'feature', description: 'Use feature.' },
            ],
            multiSelect: false,
          },
          {
            question: 'Which checks should run?',
            header: 'Checks',
            options: [
              { label: 'tests', description: 'Run tests.' },
              { label: 'build', description: 'Run build.' },
            ],
            multiSelect: true,
          },
        ],
      },
    },
    options: {},
    turnId: 'turn-1',
    sessionId: 'session-1',
  })

  run.answerUserInput({
    requestId: 'dialog-2',
    answer: 'feature',
  })

  const result = await resultPromise
  assert.equal(result.behavior, 'completed')
  assert.deepEqual(result.result.answers, {
    'Which branch should Claude use?': 'feature',
    'Which checks should run?': 'feature',
  })
  assert.equal(result.result.response, 'feature')
  assert.equal(result.result.questions.length, 2)
})
