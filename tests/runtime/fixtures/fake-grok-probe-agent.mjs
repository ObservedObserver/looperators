#!/usr/bin/env node

import fs from 'node:fs'
import readline from 'node:readline'

const scenario = process.env.FAKE_GROK_SCENARIO ?? 'happy'
const captureFile = process.env.FAKE_GROK_CAPTURE
const input = readline.createInterface({ input: process.stdin })
let promptRequestId
let promptId
let sessionId = 'fake-grok-session'

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function capture(value) {
  if (captureFile) fs.appendFileSync(captureFile, `${JSON.stringify(value)}\n`)
}

input.on('line', (line) => {
  const message = JSON.parse(line)
  capture(message)
  if (message.method === 'initialize') {
    if (scenario === 'early-exit') process.exit(7)
    if (scenario === 'timeout') return
    if (scenario === 'malformed') {
      process.stdout.write('not-json\nnull\n')
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'cached_token' }],
      },
    })
    return
  }
  if (message.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    if (scenario === 'exit-after-auth') setImmediate(() => process.exit(0))
    return
  }
  if (message.method === 'session/new' || message.method === 'session/load') {
    sessionId = message.params.sessionId ?? sessionId
    const replay = () => {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed' },
          },
          _meta: { isReplay: true },
        },
      })
    }
    const setupResponse = () => send({
      jsonrpc: '2.0',
      id: message.id,
      result: { sessionId, models: { currentModelId: 'fake-grok' } },
    })
    if (message.method === 'session/load' && scenario !== 'late-replay') replay()
    setupResponse()
    if (message.method === 'session/load' && scenario === 'late-replay') {
      setTimeout(replay, 75)
    }
    return
  }
  if (message.method === 'session/prompt') {
    promptRequestId = message.id
    promptId = message.params?._meta?.promptId
    if (scenario === 'cancel') return
    send({
      jsonrpc: '2.0',
      id: 91,
      method: 'session/request_permission',
      params: {
        sessionId,
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    })
    return
  }
  if (message.id === 91 && message.result) {
    send({
      jsonrpc: '2.0',
      id: 92,
      method: '_x.ai/ask_user_question',
      params: {
        sessionId,
        toolCallId: 'fake-tool',
        questions: [
          {
            id: 'choice',
            question: 'Continue?',
            options: [{ id: 'yes', label: 'Yes' }],
          },
        ],
        mode: 'default',
      },
    })
    return
  }
  if (message.id === 92 && message.result) {
    const privateCompletion = () => send({
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId, promptId, stopReason: 'end_turn', agentResult: null },
    })
    const standardCompletion = () => {
      send({
        jsonrpc: '2.0',
        id: promptRequestId,
        result: { stopReason: 'end_turn', _meta: { sessionId, promptId } },
      })
    }
    if (scenario === 'late-private') {
      standardCompletion()
      setTimeout(privateCompletion, 75)
    } else {
      privateCompletion()
      setTimeout(standardCompletion, scenario === 'late-response' ? 75 : 0)
    }
    return
  }
  if (message.method === 'session/cancel') {
    send({
      jsonrpc: '2.0',
      id: promptRequestId,
      result: { stopReason: 'cancelled', _meta: { sessionId, promptId } },
    })
  }
})

process.on('SIGTERM', () => {
  if (scenario === 'ignore-term') return
  setTimeout(() => process.exit(0), scenario === 'delayed-exit' ? 100 : 0)
})
