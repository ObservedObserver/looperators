import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager } from '../electron/runtime/sessionManager.js'

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

  if (mode === 'user-input') {
    send({
      id: 9001,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'question-1',
            question: 'Which branch should Codex use?',
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

    if (mode === 'user-input') {
      const answer = message.result?.answers?.['question-1']?.answers?.[0]
      if (answer !== 'feature/interactive') {
        console.error('unexpected user input response', JSON.stringify(message.result))
        process.exit(2)
      }
      finishTurn('received branch feature/interactive')
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
    send({ id: message.id, result: { thread: { id: 'fake-thread' } } })
    return
  }

  if (message.method === 'turn/start') {
    mode = promptFromTurnStart(message.params).includes('USER_INPUT')
      ? 'user-input'
      : 'approval'
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
    interactionLogs().length,
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

  const logs = interactionLogs()
  assert.deepEqual(logs[0], { mode: 'approval', result: { decision: 'accept' } })
  assert.equal(logs[1].mode, 'user-input')
  assert.equal(
    logs[1].result.answers['question-1'].answers[0],
    'feature/interactive'
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
