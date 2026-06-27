import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import {
  buildPath,
  claudeCommand,
  cleanupMcpHandoff,
  createMcpHandoff,
  membraneSystemPrompt,
} from '../claudeCliAdapter.js'
import { legacyClaudeRuntimeEventsFromChunk } from './legacyClaudeRuntimeMapper.js'

function sdkMessageType(message) {
  if (message?.type === 'stream_event' && typeof message.event?.type === 'string') {
    return `${message.type}:${message.event.type}`
  }

  return message?.subtype ? `${message.type}:${message.subtype}` : message?.type
}

function sdkMessageToLegacyEvent(message) {
  if (message?.type === 'stream_event') {
    return {
      type: 'stream_event',
      event: message.event,
      session_id: message.session_id,
    }
  }

  return message
}

function mcpServersFromHandoff(handoff) {
  if (!handoff?.configPath) {
    return undefined
  }

  const config = JSON.parse(fs.readFileSync(handoff.configPath, 'utf8'))
  return config.mcpServers
}

function sdkUserMessage(prompt) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
    timestamp: new Date().toISOString(),
  }
}

const queueClosed = Symbol('queueClosed')

class PromptQueue {
  #items = []
  #waiters = []
  #closed = false

  push(item) {
    if (this.#closed) {
      throw new Error('Claude prompt queue is closed.')
    }

    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter(item)
      return
    }

    this.#items.push(item)
  }

  close() {
    if (this.#closed) {
      return
    }

    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter(queueClosed)
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.#items.shift()
      if (item) {
        yield item
        continue
      }

      if (this.#closed) {
        return
      }

      const next = await new Promise((resolve) => this.#waiters.push(resolve))
      if (next === queueClosed) {
        return
      }
      yield next
    }
  }
}

class ClaudeAgentSdkTurnRun extends EventEmitter {
  #controller
  #closed = false

  constructor(controller, input) {
    super()
    this.#controller = controller
    this.#controller.enqueue(this, input)
  }

  kill() {
    if (this.#closed) {
      return false
    }

    return this.#controller.killTurn(this)
  }

  markClosed() {
    this.#closed = true
  }
}

class ClaudeAgentSdkSessionController {
  #sessionKey
  #onClose
  #abortController = new AbortController()
  #queue = new PromptQueue()
  #query
  #queryReady
  #closed = false
  #killRequested = false
  #current
  #pending = []
  #draining = false
  #activeHandoff

  constructor({ sessionKey, input, onClose }) {
    this.#sessionKey = sessionKey
    this.#onClose = onClose
    this.#queryReady = this.#initialize(input)
  }

  enqueue(run, input) {
    if (this.#closed) {
      this.#emitRunErrorAndClose(run, new Error('Claude SDK session is closed.'))
      return
    }

    this.#pending.push({ run, input })
    void this.#drain()
  }

  killTurn(run) {
    const pendingIndex = this.#pending.findIndex((turn) => turn.run === run)
    if (pendingIndex >= 0) {
      const [turn] = this.#pending.splice(pendingIndex, 1)
      this.#closeRun(turn.run, { code: 0, signal: 'SIGTERM', killed: true })
      return true
    }

    if (this.#current?.run !== run) {
      return false
    }

    this.#killRequested = true
    this.close()
    return true
  }

  close() {
    if (this.#closed) {
      return false
    }

    this.#closed = true
    this.#queue.close()
    this.#abortController.abort()
    this.#query?.close?.()
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined

    if (this.#current) {
      this.#closeRun(this.#current.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
      this.#current = undefined
    }
    for (const turn of this.#pending.splice(0)) {
      this.#closeRun(turn.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
    }
    this.#onClose(this.#sessionKey)
    return true
  }

  async #initialize({ cwd, backendSessionId, membrane }) {
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      this.#query = query({
        prompt: this.#queue,
        options: {
          cwd,
          resume: backendSessionId,
          pathToClaudeCodeExecutable: claudeCommand(),
          includePartialMessages: true,
          strictMcpConfig: false,
          systemPrompt: membrane
            ? {
                type: 'preset',
                preset: 'claude_code',
                append: membraneSystemPrompt(),
              }
            : undefined,
          abortController: this.#abortController,
          env: {
            ...process.env,
            PATH: buildPath(),
            NO_COLOR: '1',
          },
        },
      })

      void this.#consume()
    } catch (error) {
      this.#failController(error)
      throw error
    }
  }

  async #consume() {
    try {
      for await (const message of this.#query) {
        this.#handleMessage(message)
      }
      this.#finishController()
    } catch (error) {
      if (this.#killRequested) {
        this.#finishController()
      } else {
        this.#failController(error)
      }
    }
  }

  async #drain() {
    if (this.#closed || this.#current || this.#draining) {
      return
    }

    this.#draining = true
    try {
      while (!this.#closed && !this.#current && this.#pending.length > 0) {
        const turn = this.#pending.shift()
        this.#current = turn
        try {
          await this.#queryReady
          await this.#configureMembrane(turn.input.membrane)
          this.#queue.push(sdkUserMessage(turn.input.prompt))
        } catch (error) {
          if (!this.#closed) {
            this.#emitRunErrorAndClose(turn.run, error)
          }
          this.#current = undefined
        }
      }
    } finally {
      this.#draining = false
    }

    if (!this.#current && this.#pending.length > 0) {
      void this.#drain()
    }
  }

  async #configureMembrane(membrane) {
    if (!membrane) {
      return
    }

    if (typeof this.#query?.setMcpServers !== 'function') {
      throw new Error('Claude Agent SDK does not support dynamic MCP servers.')
    }

    const handoff = createMcpHandoff(membrane)
    try {
      await this.#query.setMcpServers(mcpServersFromHandoff(handoff) ?? {})
    } catch (error) {
      cleanupMcpHandoff(handoff)
      throw error
    }

    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = handoff
  }

  #handleMessage(message) {
    const current = this.#current
    if (!current) {
      return
    }

    const { input, run } = current
    const providerSessionId =
      typeof message?.session_id === 'string'
        ? message.session_id
        : input.sessionId
    if (providerSessionId) {
      run.emit('providerSession', { providerSessionId })
    }

    const ts = new Date().toISOString()
    run.emit('native', {
      ts,
      providerKind: 'claude-code',
      turnId: input.turnId,
      raw: {
        source: 'claude.sdk',
        messageType: sdkMessageType(message),
        payload: message,
      },
    })

    const legacyEvent = sdkMessageToLegacyEvent(message)
    const events = legacyClaudeRuntimeEventsFromChunk({
      sessionId: input.sessionId,
      turnId: input.turnId,
      ts,
      chunk: {
        stream: 'stdout',
        event: legacyEvent,
      },
      rawSource: 'claude.sdk',
    })

    for (const event of events) {
      run.emit('providerEvent', event)
    }

    if (message?.type === 'result') {
      run.emit('result', message)
      this.#finishCurrentTurn()
    }
  }

  #finishCurrentTurn() {
    const current = this.#current
    if (!current) {
      return
    }

    this.#current = undefined
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined
    this.#closeRun(current.run, { code: 0, signal: null, killed: false })
    void this.#drain()
  }

  #finishController() {
    if (this.#closed) {
      return
    }

    this.#closed = true
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined
    if (this.#current) {
      this.#closeRun(this.#current.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
      this.#current = undefined
    }
    for (const turn of this.#pending.splice(0)) {
      this.#closeRun(turn.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
    }
    this.#onClose(this.#sessionKey)
  }

  #failController(error) {
    if (this.#closed) {
      return
    }

    this.#closed = true
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined
    if (this.#current) {
      this.#emitRunErrorAndClose(this.#current.run, error)
      this.#current = undefined
    }
    for (const turn of this.#pending.splice(0)) {
      this.#emitRunErrorAndClose(turn.run, error)
    }
    this.#onClose(this.#sessionKey)
  }

  #emitRunErrorAndClose(run, error) {
    run.emit('error', error)
    this.#closeRun(run, { code: 1, signal: null, killed: false })
  }

  #closeRun(run, event) {
    run.markClosed()
    run.emit('close', event)
  }
}

export class ClaudeAgentSdkAdapter {
  kind = 'claude-code'
  #sessions = new Map()

  startTurn(input) {
    const sessionKey = input.sessionId ?? input.backendSessionId
    if (!sessionKey) {
      throw new Error('Claude Agent SDK sessions require an Orrery session id.')
    }

    let controller = this.#sessions.get(sessionKey)
    if (!controller) {
      controller = new ClaudeAgentSdkSessionController({
        sessionKey,
        input,
        onClose: (closedSessionKey) => this.#sessions.delete(closedSessionKey),
      })
      this.#sessions.set(sessionKey, controller)
    }

    return new ClaudeAgentSdkTurnRun(controller, input)
  }

  closeAll() {
    for (const controller of this.#sessions.values()) {
      controller.close()
    }
    this.#sessions.clear()
  }
}
