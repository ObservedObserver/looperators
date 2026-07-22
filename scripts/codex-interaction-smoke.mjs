import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-interaction-'))
const fakeCodex = path.join(tempRoot, 'codex')
const storageFile = path.join(tempRoot, 'orrery-runtime-state.json')
const interactionLog = path.join(tempRoot, 'codex-interactions.jsonl')
const managers = new Set()

const fakeCodexSource = `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')

const logFile = process.env.ORRERY_FAKE_CODEX_LOG
let mode = 'approval'
let requestSent = false

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}

function log(value) {
  if (logFile) {
    fs.appendFileSync(logFile, JSON.stringify(value) + '\\n')
  }
}

function promptFromTurnStart(params) {
  return (params?.input ?? [])
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .join('\\n')
}

function finishTurn(answerText) {
  send({
    method: 'item/agentMessage/delta',
    params: { itemId: 'assistant-message', delta: answerText },
  })
  send({ method: 'turn/completed', params: { turnId: 'fake-turn' } })
  setTimeout(() => process.exit(0), 25)
}

function sendInteractiveRequest() {
  if (requestSent) {
    return
  }
  requestSent = true

  if (mode === 'user-input' || mode === 'complex-user-input') {
    send({
      id: 9001,
      method: 'item/tool/requestUserInput',
      params: {
        questions:
          mode === 'complex-user-input'
            ? [
                {
                  id: 'question-1',
                  header: 'Branch',
                  question: 'Which branch should Codex use?',
                  isOther: true,
                  isSecret: false,
                  options: null,
                },
                {
                  id: 'question-2',
                  header: 'Token',
                  question: 'Provide a visible token placeholder.',
                  isOther: false,
                  isSecret: true,
                  options: [{ label: 'placeholder', description: 'Visible placeholder' }],
                },
              ]
            : [
                {
                  id: 'question-1',
                  header: 'Branch',
                  question: 'Which branch should Codex use?',
                  isOther: true,
                  isSecret: false,
                  options: null,
                },
              ],
      },
    })
    return
  }

  send({
    id: 9001,
    method: 'item/commandExecution/requestApproval',
    params: {
      command: 'echo interactive',
      reason: 'Codex wants to run a command.',
    },
  })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) {
    return
  }

  const message = JSON.parse(line)
  if (message.id === 9001 && Object.hasOwn(message, 'result')) {
    log({ mode, result: message.result })

    if (mode === 'user-input' || mode === 'complex-user-input') {
      const answer = message.result?.answers?.['question-1']?.answers?.[0]
      const expectedAnswer =
        mode === 'complex-user-input'
          ? 'visible-shared-answer'
          : 'feature/interactive'
      if (answer !== expectedAnswer) {
        console.error('unexpected user input response', JSON.stringify(message.result))
        process.exit(2)
      }
      if (
        mode === 'complex-user-input' &&
        message.result?.answers?.['question-2']?.answers?.[0] !== expectedAnswer
      ) {
        console.error('unexpected complex user input response', JSON.stringify(message.result))
        process.exit(2)
      }
      finishTurn('received branch ' + expectedAnswer)
      return
    }

    if (message.result?.decision !== 'accept') {
      console.error('unexpected approval response', JSON.stringify(message.result))
      process.exit(2)
    }
    finishTurn('approval accepted')
    return
  }

  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }

  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    log({ mode, method: message.method, params: message.params })
    send({ id: message.id, result: { thread: { id: 'fake-thread' } } })
    return
  }

  if (message.method === 'turn/start') {
    const prompt = promptFromTurnStart(message.params)
    mode = prompt.includes('COMPLEX_USER_INPUT')
      ? 'complex-user-input'
      : prompt.includes('USER_INPUT')
        ? 'user-input'
        : 'approval'
    log({ mode, method: message.method, params: message.params })
    send({ id: message.id, result: { turn: { id: 'fake-turn' } } })
    send({ method: 'turn/started', params: { turn: { id: 'fake-turn' } } })
    setTimeout(sendInteractiveRequest, 10)
    return
  }

  send({ id: message.id, result: {} })
})
`

function installFakeCodex() {
  fs.writeFileSync(fakeCodex, fakeCodexSource)
  fs.chmodSync(fakeCodex, 0o755)
  process.env.ORRERY_CODEX_BIN = fakeCodex
  process.env.ORRERY_FAKE_CODEX_LOG = interactionLog
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = predicate()
    if (result) {
      return result
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function manager(input) {
  const runtime = new RuntimeSessionManager(input)
  managers.add(runtime)
  return runtime
}

function interactionLogs() {
  if (!fs.existsSync(interactionLog)) {
    return []
  }
  return fs
    .readFileSync(interactionLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function turnStartLogForPrompt(logs, prompt) {
  return logs.find(
    (entry) =>
      entry.method === 'turn/start' &&
      (entry.params?.input ?? []).some((item) => item?.text?.includes(prompt))
  )
}

async function waitIdle(runtime, sessionId, label) {
  await waitFor(label, () => runtime.getState().sessions[sessionId]?.status === 'idle')
}

try {
  installFakeCodex()
  const runtime = manager({ storageFile })

  const approvalSession = await runtime.createSession({
    prompt: 'APPROVAL_REQUEST',
    providerKind: 'codex',
    agent: 'codex',
    cwd: process.cwd(),
    runtimeSettings: {
      runtimeMode: 'full-access',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      serviceTier: 'flex',
    },
  })
  const approvalSessionId = approvalSession.sessionId
  const approvalRequest = await waitFor('Codex approval request', () =>
    runtime
      .getState()
      .sessions[approvalSessionId]?.runtimeRequests.find(
        (request) => request.status === 'open'
      )
  )
  assert.equal(
    interactionLogs().filter((entry) => entry.result).length,
    0,
    'Orrery must not answer Codex approval requests automatically'
  )

  const approvalResult = runtime.respondRuntimeRequest({
    sessionId: approvalSessionId,
    requestId: approvalRequest.id,
    decision: 'approved',
  })
  assert.equal(approvalResult.ok, true)
  await waitIdle(runtime, approvalSessionId, 'approval session idle')
  const approvedState = runtime.getState()
  assert.equal(
    approvedState.sessions[approvalSessionId].runtimeRequests[0].status,
    'approved'
  )
  assert.match(
    approvedState.sessions[approvalSessionId].messages.at(-1).content,
    /approval accepted/
  )

  const inputSession = await runtime.createSession({
    prompt: 'USER_INPUT_REQUEST',
    providerKind: 'codex',
    agent: 'codex',
    cwd: process.cwd(),
  })
  const inputSessionId = inputSession.sessionId
  const inputRequest = await waitFor('Codex user input request', () =>
    runtime
      .getState()
      .sessions[inputSessionId]?.runtimeUserInputRequests.find(
        (request) => request.status === 'open'
      )
  )

  const inputResult = runtime.answerUserInput({
    sessionId: inputSessionId,
    requestId: inputRequest.id,
    answer: 'feature/interactive',
  })
  assert.equal(inputResult.ok, true)
  await waitIdle(runtime, inputSessionId, 'user input session idle')
  const inputState = runtime.getState()
  assert.equal(
    inputState.sessions[inputSessionId].runtimeUserInputRequests[0].status,
    'answered'
  )
  assert.match(
    inputState.sessions[inputSessionId].messages.at(-1).content,
    /feature\/interactive/
  )

  const autoEditSession = await runtime.createSession({
    prompt: 'AUTO_EDIT_REQUEST',
    providerKind: 'codex',
    agent: 'codex',
    cwd: process.cwd(),
    runtimeSettings: {
      runtimeMode: 'auto-accept-edits',
    },
  })
  const autoEditSessionId = autoEditSession.sessionId
  const autoEditRequest = await waitFor('Codex auto-edit approval request', () =>
    runtime
      .getState()
      .sessions[autoEditSessionId]?.runtimeRequests.find(
        (request) => request.status === 'open'
      )
  )
  const autoEditResult = runtime.respondRuntimeRequest({
    sessionId: autoEditSessionId,
    requestId: autoEditRequest.id,
    decision: 'approved',
  })
  assert.equal(autoEditResult.ok, true)
  await waitIdle(runtime, autoEditSessionId, 'auto-edit session idle')

  const validInteractionSession = await runtime.createSession({
    prompt: 'VALID_INTERACTION_MODE_REQUEST',
    providerKind: 'codex',
    agent: 'codex',
    cwd: process.cwd(),
    runtimeSettings: {
      runtimeMode: 'approval-required',
      interactionMode: 'plan',
      model: 'gpt-5-codex',
      reasoningEffort: 'low',
    },
  })
  const validInteractionSessionId = validInteractionSession.sessionId
  const validInteractionRequest = await waitFor('Codex valid interaction request', () =>
    runtime
      .getState()
      .sessions[validInteractionSessionId]?.runtimeRequests.find(
        (request) => request.status === 'open'
      )
  )
  const validInteractionResult = runtime.respondRuntimeRequest({
    sessionId: validInteractionSessionId,
    requestId: validInteractionRequest.id,
    decision: 'approved',
  })
  assert.equal(validInteractionResult.ok, true)
  await waitIdle(runtime, validInteractionSessionId, 'valid interaction session idle')

  const invalidInteractionSession = await runtime.createSession({
    prompt: 'INVALID_INTERACTION_MODE_REQUEST',
    providerKind: 'codex',
    agent: 'codex',
    cwd: process.cwd(),
    runtimeSettings: {
      runtimeMode: 'approval-required',
      interactionMode: 'unsupported-mode',
    },
  })
  const invalidInteractionSessionId = invalidInteractionSession.sessionId
  const invalidInteractionRequest = await waitFor(
    'Codex invalid interaction request',
    () =>
      runtime
        .getState()
        .sessions[invalidInteractionSessionId]?.runtimeRequests.find(
          (request) => request.status === 'open'
        )
  )
  const invalidInteractionResult = runtime.respondRuntimeRequest({
    sessionId: invalidInteractionSessionId,
    requestId: invalidInteractionRequest.id,
    decision: 'approved',
  })
  assert.equal(invalidInteractionResult.ok, true)
  await waitIdle(runtime, invalidInteractionSessionId, 'invalid interaction session idle')

  const complexInputSession = await runtime.createSession({
    prompt: 'COMPLEX_USER_INPUT_REQUEST',
    providerKind: 'codex',
    agent: 'codex',
    cwd: process.cwd(),
  })
  const complexInputSessionId = complexInputSession.sessionId
  const complexInputRequest = await waitFor('Codex complex user input request', () =>
    runtime
      .getState()
      .sessions[complexInputSessionId]?.runtimeUserInputRequests.find(
        (request) => request.status === 'open'
      )
  )
  assert.match(complexInputRequest.prompt, /Which branch should Codex use/)
  assert.match(complexInputRequest.prompt, /Provide a visible token placeholder/)
  assert.match(complexInputRequest.prompt, /Do not enter secrets/)
  assert.equal(
    complexInputRequest.placeholder,
    'Answer for Codex'
  )
  const complexInputResult = runtime.answerUserInput({
    sessionId: complexInputSessionId,
    requestId: complexInputRequest.id,
    answers: {
      'question-1': 'visible-shared-answer',
      'question-2': 'visible-shared-answer',
    },
  })
  assert.equal(complexInputResult.ok, true)
  await waitIdle(runtime, complexInputSessionId, 'complex user input session idle')

  const logs = interactionLogs()
  const approvalThreadStart = logs.find(
    (entry) => entry.method === 'thread/start' && entry.params?.model === 'gpt-5-codex'
  )
  const approvalTurnStart = logs.find(
    (entry) => entry.method === 'turn/start' && entry.params?.model === 'gpt-5-codex'
  )
  assert.equal(approvalThreadStart.params.approvalPolicy, 'never')
  assert.equal(approvalThreadStart.params.sandbox, 'danger-full-access')
  assert.equal(approvalThreadStart.params.serviceTier, 'flex')
  assert.equal(approvalTurnStart.params.approvalPolicy, 'never')
  assert.deepEqual(approvalTurnStart.params.sandboxPolicy, {
    type: 'dangerFullAccess',
  })
  assert.equal(approvalTurnStart.params.effort, 'high')
  const inputTurnStart = turnStartLogForPrompt(logs, 'USER_INPUT_REQUEST')
  assert.deepEqual(inputTurnStart.params.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  })
  const autoEditTurnStart = turnStartLogForPrompt(logs, 'AUTO_EDIT_REQUEST')
  assert.deepEqual(autoEditTurnStart.params.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  })
  const validInteractionTurnStart = turnStartLogForPrompt(
    logs,
    'VALID_INTERACTION_MODE_REQUEST'
  )
  assert.equal(
    Object.hasOwn(validInteractionTurnStart.params, 'collaborationMode'),
    false
  )
  assert.deepEqual(validInteractionTurnStart.params.sandboxPolicy, {
    type: 'readOnly',
    networkAccess: false,
  })
  assert.equal(validInteractionTurnStart.params.model, 'gpt-5-codex')
  assert.equal(validInteractionTurnStart.params.effort, 'low')
  const invalidInteractionTurnStart = turnStartLogForPrompt(
    logs,
    'INVALID_INTERACTION_MODE_REQUEST'
  )
  assert.equal(
    Object.hasOwn(invalidInteractionTurnStart.params, 'collaborationMode'),
    false
  )

  const approvalResponse = logs.find(
    (entry) => entry.mode === 'approval' && entry.result
  )
  const inputResponse = logs.find(
    (entry) => entry.mode === 'user-input' && entry.result
  )
  const complexInputResponse = logs.find(
    (entry) => entry.mode === 'complex-user-input' && entry.result
  )
  assert.deepEqual(approvalResponse, {
    mode: 'approval',
    result: { decision: 'accept' },
  })
  assert.equal(inputResponse.mode, 'user-input')
  assert.equal(
    inputResponse.result.answers['question-1'].answers[0],
    'feature/interactive'
  )
  assert.equal(
    complexInputResponse.result.answers['question-1'].answers[0],
    'visible-shared-answer'
  )
  assert.equal(
    complexInputResponse.result.answers['question-2'].answers[0],
    'visible-shared-answer'
  )

  console.log('[runtime:codex-interaction] approval and user-input round trips passed')
} finally {
  for (const runtime of managers) {
    try {
      runtime.killAll()
    } catch {
      // Best effort cleanup only.
    }
  }
  delete process.env.ORRERY_CODEX_BIN
  delete process.env.ORRERY_FAKE_CODEX_LOG
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
