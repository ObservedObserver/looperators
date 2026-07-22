import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeAgentSdkTurnRun,
  automaticClaudePermissionResult,
  claudePermissionModeForRuntime,
  claudeRuntimeOptions,
  effectiveClaudeRuntimeConfig,
} from '../../dist-electron/electron/runtime/providers/claudeAgentSdkAdapter.js'

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

test('Claude runtime mode maps to SDK permissionMode options', () => {
  assert.equal(
    claudePermissionModeForRuntime({ runtimeMode: 'approval-required' }),
    'default'
  )
  assert.deepEqual(
    claudeRuntimeOptions({ runtimeMode: 'auto-accept-edits' }),
    { permissionMode: 'acceptEdits' }
  )
  assert.deepEqual(claudeRuntimeOptions({ runtimeMode: 'auto' }), {
    permissionMode: 'auto',
  })
  assert.deepEqual(claudeRuntimeOptions({ runtimeMode: 'full-access' }), {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  })
})

test('Claude effective runtime config records provider-native permission mode', () => {
  assert.deepEqual(
    effectiveClaudeRuntimeConfig({ runtimeMode: 'auto' }).native,
    { permissionMode: 'auto' }
  )
  assert.deepEqual(
    effectiveClaudeRuntimeConfig({
      runtimeMode: 'full-access',
      model: 'claude-sonnet-4-6',
    }).native,
    {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    }
  )
})

test('Claude runtime mode controls automatic permission decisions', () => {
  assert.deepEqual(
    automaticClaudePermissionResult(
      { runtimeMode: 'full-access' },
      'Bash',
      { toolUseID: 'tool-1' },
      { command: 'ls' }
    ),
    {
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      toolUseID: 'tool-1',
      decisionClassification: 'user_permanent',
    }
  )
  assert.deepEqual(
    automaticClaudePermissionResult(
      { runtimeMode: 'auto-accept-edits' },
      'Edit',
      { toolUseID: 'tool-2' }
    ),
    {
      behavior: 'allow',
      updatedInput: {},
      toolUseID: 'tool-2',
      decisionClassification: 'user_permanent',
    }
  )
  assert.equal(
    automaticClaudePermissionResult(
      { runtimeMode: 'auto-accept-edits' },
      'Bash',
      { toolUseID: 'tool-3' }
    ),
    undefined
  )
  assert.equal(
    automaticClaudePermissionResult(
      { runtimeMode: 'auto' },
      'Bash',
      { toolUseID: 'tool-4' }
    ),
    undefined,
    'Claude owns classification in native auto mode'
  )
})

test('membrane tools are auto-allowed in every runtime mode (sanctioned control surface)', () => {
  // Headless runs cannot answer permission prompts; the bridge token already
  // authenticates the session. Without this, the first gate=master approval
  // (approve_activation via the SDK provider) wedges forever.
  for (const toolName of [
    'mcp__orrery_membrane__approve_activation',
    'mcp__orrery_membrane__deny_activation',
    'mcp__orrery_membrane__report',
    'mcp__orrery_membrane__create_session',
    'mcp__orrery_membrane__resume_session',
    'mcp__orrery_membrane__deliver',
    'mcp__orrery_membrane__activate',
    'mcp__orrery_membrane__link_sessions',
    'mcp__orrery_membrane__inspect_scope',
    'mcp__orrery_membrane__propose_workflow',
    'mcp__orrery_membrane__revise_workflow',
    'mcp__orrery_membrane__explain_workflow',
    'mcp__orrery_membrane__commit_workflow',
    'mcp__orrery_membrane__abort_workflow',
  ]) {
    assert.deepEqual(
      automaticClaudePermissionResult(
        { runtimeMode: 'approval-required' },
        toolName,
        { toolUseID: 'tool-m' },
        { slotKey: 'sub-1→target' }
      ),
      {
        behavior: 'allow',
        updatedInput: { slotKey: 'sub-1→target' },
        toolUseID: 'tool-m',
        decisionClassification: 'user_permanent',
      },
      `${toolName} must not hit the permission gate`
    )
  }
  // Non-membrane MCP tools stay gated.
  assert.equal(
    automaticClaudePermissionResult(
      { runtimeMode: 'approval-required' },
      'mcp__other_server__do_thing',
      { toolUseID: 'tool-4' }
    ),
    undefined
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

test('ClaudeAgentSdkTurnRun maps session permission approval to SDK permanent result', async () => {
  const run = testRun()
  const suggestions = [
    {
      type: 'setMode',
      mode: 'default',
      destination: 'session',
    },
  ]
  const resultPromise = run.requestPermission({
    input: { command: 'npm test' },
    options: {
      toolUseID: 'permission-session',
      suggestions,
    },
    toolName: 'Bash',
    turnId: 'turn-1',
    sessionId: 'session-1',
  })

  run.respondRuntimeRequest({
    requestId: 'permission-session',
    decision: 'acceptForSession',
  })

  const result = await resultPromise
  assert.equal(result.behavior, 'allow')
  assert.equal(result.decisionClassification, 'user_permanent')
  assert.deepEqual(result.updatedPermissions, suggestions)
})

test('ClaudeAgentSdkTurnRun maps canceled permission approval to SDK denial interrupt', async () => {
  const run = testRun()
  const resultPromise = run.requestPermission({
    input: { command: 'rm -rf build' },
    options: { toolUseID: 'permission-cancel' },
    toolName: 'Bash',
    turnId: 'turn-1',
    sessionId: 'session-1',
  })

  run.respondRuntimeRequest({
    requestId: 'permission-cancel',
    decision: 'cancel',
  })

  const result = await resultPromise
  assert.equal(result.behavior, 'deny')
  assert.equal(result.interrupt, true)
  assert.equal(result.decisionClassification, 'user_reject')
})

test('ClaudeAgentSdkTurnRun answers ask_user_question with SDK result shape', async () => {
  const run = testRun()
  const events = []
  run.on('providerEvent', (event) => events.push(event))
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
    answers: {
      'Which branch should Claude use?': 'feature',
      'Which checks should run?': ['tests', 'build'],
    },
  })

  const result = await resultPromise
  assert.equal(result.behavior, 'completed')
  assert.deepEqual(result.result.answers, {
    'Which branch should Claude use?': 'feature',
    'Which checks should run?': 'tests, build',
  })
  assert.equal(result.result.response, 'feature')
  assert.equal(result.result.questions.length, 2)
  const requested = events.find((event) => event.type === 'user-input.requested')
  assert.equal(requested.request.questions.length, 2)
  assert.equal(requested.request.questions[0].options[1].label, 'feature')
  assert.equal(requested.request.questions[1].multiSelect, true)
})
