#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'

const scenario = process.env.FAKE_GROK_SCENARIO ?? 'normal'
const logFile = process.env.FAKE_GROK_LOG

function log(value) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`)
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

log({
  startup: {
    argv: process.argv.slice(2),
    custom: process.env.FAKE_GROK_CUSTOM,
    referrer: process.env.GROK_OAUTH2_REFERRER,
  },
})

if (scenario === 'stderr-exit') {
  process.stderr.write('diagnostic without credentials\n')
  process.exit(7)
}

if (scenario === 'stderr-many') {
  for (let index = 0; index < 25; index += 1) {
    process.stderr.write(`diagnostic-${index}\n`)
  }
  process.exit(8)
}

if (scenario === 'ignore-term') {
  process.on('SIGTERM', () => {})
}
if (scenario === 'delayed-exit') {
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150))
}

let pendingServerRequest
let activePrompt
let lateReplaySentAt
let interactionPrompt

function completeInteractionPrompt() {
  if (!interactionPrompt) return
  send({
    jsonrpc: '2.0',
    id: interactionPrompt.id,
    result: { stopReason: 'end_turn' },
  })
  interactionPrompt = undefined
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  log(message)

  if (message.id !== undefined && message.method === undefined) {
    if (message.id === 910) {
      if (scenario === 'interaction-flow') {
        send({
          jsonrpc: '2.0',
          id: 911,
          method: '_x.ai/ask_user_question',
          params: {
            sessionId: 'fake-grok-session',
            toolCallId: 'fake-question-tool',
            questions: [
              {
                id: 'choice',
                question: 'Pick one',
                options: [
                  { id: 'alpha-id', label: 'Alpha', preview: 'Alpha preview' },
                  { id: 'beta-id', label: 'Beta' },
                ],
              },
              {
                id: 'many',
                question: 'Pick many',
                multiSelect: true,
                options: [
                  { id: 'docs-id', label: 'Docs' },
                  { id: 'tests-id', label: 'Tests' },
                ],
              },
            ],
            mode: 'default',
          },
        })
      } else {
        completeInteractionPrompt()
      }
      return
    }
    if (message.id === 911) {
      completeInteractionPrompt()
      return
    }
    if (pendingServerRequest === message.id) pendingServerRequest = undefined
    return
  }

  const result = (value) => send({ jsonrpc: '2.0', id: message.id, result: value })
  const error = (text) =>
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: text } })

  if (scenario === 'early-exit') process.exit(3)
  if (scenario === 'malformed') {
    process.stdout.write('not json\n')
  }
  if (scenario === 'timeout') return
  if (scenario === 'rpc-error') {
    error('fake request rejected')
    return
  }

  switch (message.method) {
    case 'initialize':
      const initializeResult = {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: scenario !== 'no-load',
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        ...(scenario === 'probe-models'
          ? {
              _meta: {
                modelState: {
                  currentModelId: 'grok-default',
                  availableModels: [
                    {
                      modelId: 'grok-default',
                      name: 'Grok Default',
                      _meta: {
                        supportsReasoningEffort: true,
                        reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
                        unknownCapability: 'preserved',
                      },
                    },
                    {
                      modelId: 'grok-no-reasoning',
                      name: 'Grok No Reasoning',
                      _meta: { supportsReasoningEffort: false },
                    },
                  ],
                },
              },
            }
          : {}),
      }
      if (scenario === 'slow-setup-budget') {
        setTimeout(() => result(initializeResult), 250)
        return
      }
      result(initializeResult)
      if (scenario === 'unknown-request') {
        pendingServerRequest = 900
        send({ jsonrpc: '2.0', id: 900, method: 'unknown/method', params: {} })
      }
      if (scenario === 'known-request') {
        pendingServerRequest = 901
        send({
          jsonrpc: '2.0',
          id: 901,
          method: 'session/request_permission',
          params: { toolCall: { title: 'Known request' }, options: [] },
        })
      }
      if (scenario === 'orphan-response') {
        send({ jsonrpc: '2.0', id: 999, result: { orphan: true } })
      }
      return
    case 'authenticate':
      if (scenario === 'auth-fail') {
        error('fake auth failed')
      } else if (scenario === 'slow-setup-budget') {
        setTimeout(() => result({}), 250)
      } else {
        result({})
      }
      return
    case 'session/new':
      if (scenario === 'setup-hang' || scenario === 'slow-setup-budget') return
      if (scenario === 'session-new-fail') {
        error('fake session/new failed')
      } else {
        result({
          sessionId: 'fake-grok-session',
          models: {
            currentModelId: 'grok-default',
            availableModels: [{ modelId: 'grok-default', name: 'Grok Default' }],
          },
        })
      }
      return
    case 'session/load': {
      const replay = () => {
        lateReplaySentAt = Date.now()
        log({ marker: 'replay-sent', at: lateReplaySentAt })
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params?.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'REPLAY_MUST_NOT_PROJECT' },
            },
            _meta: { isReplay: true },
          },
        })
      }
      if (scenario === 'late-replay' || scenario === 'delayed-load-late-replay') {
        const finishLoad = () => {
          result({ sessionId: message.params?.sessionId, models: { currentModelId: 'grok-default' } })
          setTimeout(replay, 15)
        }
        if (scenario === 'delayed-load-late-replay') setTimeout(finishLoad, 80)
        else finishLoad()
      } else {
        replay()
        result({ sessionId: message.params?.sessionId, models: { currentModelId: 'grok-default' } })
      }
      return
    }
    case 'session/set_model':
      if (scenario === 'set-model-fail') error('fake set_model failed')
      else result({})
      return
    case 'session/prompt':
      if (
        scenario === 'delayed-load-late-replay' &&
        (!lateReplaySentAt || Date.now() - lateReplaySentAt < 35)
      ) {
        error('prompt arrived before the post-replay quiet window elapsed')
        return
      }
      if (scenario === 'delayed-load-late-replay') {
        log({ marker: 'prompt-after-replay', at: Date.now() })
      }
      if (scenario === 'prompt-fail') {
        error('fake prompt failed')
        return
      }
      if (scenario === 'hang') {
        activePrompt = message
        return
      }
      if (
        scenario === 'interaction-flow' ||
        scenario === 'full-access-permission' ||
        scenario === 'auto-edit-permission' ||
        scenario === 'auto-execute-permission' ||
        scenario === 'permission-no-always'
      ) {
        interactionPrompt = message
        send({
          jsonrpc: '2.0',
          id: 910,
          method: 'session/request_permission',
          params: {
            sessionId: message.params?.sessionId,
            toolCall: {
              toolCallId: 'fake-permission-tool',
              title: 'Structured fake tool',
              kind: scenario === 'auto-edit-permission' ? 'edit' : 'execute',
            },
            options: [
              { optionId: 'allow-once', kind: 'allow_once' },
              ...(scenario === 'permission-no-always'
                ? []
                : [{ optionId: 'allow-session', kind: 'allow_always' }]),
              { optionId: 'reject-once', kind: 'reject_once' },
            ],
          },
        })
        return
      }
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'FAKE_GROK_TEXT' },
          },
        },
      })
      if (scenario === 'private-only') {
        send({
          jsonrpc: '2.0',
          method: '_x.ai/session/prompt_complete',
          params: {
            sessionId: message.params?.sessionId,
            promptId: message.params?._meta?.promptId,
            stopReason: 'end_turn',
          },
        })
        return
      }
      result({ stopReason: 'end_turn' })
      if (scenario === 'duplicate-completion') {
        send({
          jsonrpc: '2.0',
          method: '_x.ai/session/prompt_complete',
          params: {
            sessionId: message.params?.sessionId,
            promptId: message.params?._meta?.promptId,
            stopReason: 'end_turn',
          },
        })
      }
      return
    case 'session/cancel':
      if (activePrompt) {
        send({ jsonrpc: '2.0', id: activePrompt.id, result: { stopReason: 'cancelled' } })
        activePrompt = undefined
      }
      return
    default:
      result({ ok: true })
  }
})

setInterval(() => {}, 1000)
