import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

class DeterministicRun extends EventEmitter {
  #closed = false
  #timer

  constructor(input, { killOnStart = false, failAfterStart = false, noOutput = false, oversizedOutput = false, permissionRequest = false, toolActivityCount = 0 } = {}) {
    super()
    setImmediate(() => {
      if (!this.#closed) {
        this.emit('providerSession', {
          providerSessionId: input.backendSessionId ?? input.sessionId,
        })
      }
    })
    const delay = input.prompt?.includes('ORRERY_ZERO')
      ? 0
      : input.prompt?.includes('ORRERY_SLEEP')
      ? 1200
      : input.prompt?.includes('ORRERY_DELAY')
        ? 500
        : 50
    this.#timer = setTimeout(() => this.#complete(input, { failAfterStart, noOutput, oversizedOutput, permissionRequest, toolActivityCount }), delay)
    if (killOnStart) {
      setImmediate(() => this.kill())
    }
  }

  #complete(input, { failAfterStart = false, noOutput = false, oversizedOutput = false, permissionRequest = false, toolActivityCount = 0 } = {}) {
    if (this.#closed) return
    if (failAfterStart) {
      this.emit('error', new Error('Deterministic provider failed after start.'))
      this.#closed = true
      this.emit('close', { code: 1, signal: null, killed: false })
      return
    }
    const providerSessionId = input.backendSessionId ?? input.sessionId
    const turnDiffFixture = path.join(input.cwd, 'README.md')
    if (
      fs.existsSync(turnDiffFixture) &&
      fs.readFileSync(turnDiffFixture, 'utf8').includes('# Turn diff test')
    ) {
      fs.appendFileSync(path.join(input.cwd, 'p1-turn-diff.txt'), 'changed by deterministic provider\n')
    }
    const ts = new Date().toISOString()
    if (permissionRequest) {
      this.emit('providerEvent', {
        id: `permission-${input.turnId}`,
        ts,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: 'request.opened',
        request: {
          id: `permission-${input.turnId}`,
          kind: 'permission',
          title: 'Expand workspace write permission',
          body: 'The deterministic participant requests write access.',
          status: 'open',
          createdAt: ts,
        },
      })
    }
    const activityCount = toolActivityCount || (input.prompt?.includes('ORRERY_TOOL_ACTIVITY') ? 1 : 0)
    for (let index = 0; index < activityCount; index += 1) {
      const itemId = `tool-${input.turnId}-${index}`
      this.emit('providerEvent', {
        id: `tool-start-${input.turnId}-${index}`,
        ts,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: 'item.started',
        item: {
          id: itemId,
          kind: 'tool_call',
          providerName: 'DeterministicTool',
          status: 'running',
          startedAt: ts,
        },
      })
      if (this.#closed) return
      this.emit('providerEvent', {
        id: `tool-complete-${input.turnId}-${index}`,
        ts,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: 'item.completed',
        item: {
          id: itemId,
          kind: 'tool_call',
          providerName: 'DeterministicTool',
          status: 'completed',
          startedAt: ts,
          completedAt: ts,
          output: 'deterministic tool result',
        },
      })
    }
    if (!noOutput) {
      this.emit('providerEvent', {
        id: `content-${input.turnId}`,
        ts,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: 'content.delta',
        streamKind: 'assistant_text',
        text: oversizedOutput ? 'x'.repeat(129 * 1024) : `handled: ${input.prompt ?? ''}`,
      })
      this.emit('result', {
        session_id: providerSessionId,
        result: 'done',
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
        duration_ms: delayForUsage(input.prompt),
        num_turns: 1,
      })
    } else {
      this.emit('result', { session_id: providerSessionId, result: '' })
    }
    this.#closed = true
    this.emit('close', { code: 0, signal: null, killed: false })
  }

  kill() {
    if (this.#closed) return false
    clearTimeout(this.#timer)
    this.#closed = true
    queueMicrotask(() => this.emit('close', { code: null, signal: 'SIGTERM', killed: true }))
    return true
  }
}

function delayForUsage(prompt) {
  return prompt?.includes('ORRERY_SLEEP') ? 1200 : prompt?.includes('ORRERY_DELAY') ? 500 : 50
}

export class DeterministicProviderAdapter {
  kind
  startedTurns = []
  #failWhen
  #killWhen
  #noOutputWhen
  #oversizedOutputWhen
  #permissionWhen
  #toolActivityCount
  #failAfterStartWhen

  constructor({ failWhen, failAfterStartWhen, killWhen, noOutputWhen, oversizedOutputWhen, permissionWhen, toolActivityCount, kind = 'claude-code' } = {}) {
    this.#failWhen = failWhen
    this.#killWhen = killWhen
    this.#noOutputWhen = noOutputWhen
    this.#oversizedOutputWhen = oversizedOutputWhen
    this.#permissionWhen = permissionWhen
    this.#toolActivityCount = toolActivityCount
    this.#failAfterStartWhen = failAfterStartWhen
    this.kind = kind
  }

  startTurn(input) {
    this.startedTurns.push(input)
    const binaryPath = input.providerInstance?.binaryPath ?? process.env.ORRERY_CLAUDE_BIN
    const shouldFail =
      (binaryPath && !fs.existsSync(binaryPath)) ||
      this.#failWhen?.(input) === true
    if (shouldFail) {
      const run = new EventEmitter()
      run.kill = () => false
      queueMicrotask(() => {
        run.emit('error', new Error(`Deterministic provider failed: ${binaryPath ?? 'configured failure'}`))
        run.emit('close', { code: 1, signal: null, killed: false })
      })
      return run
    }
    return new DeterministicRun(input, {
      killOnStart: this.#killWhen?.(input) === true,
      failAfterStart: this.#failAfterStartWhen?.(input) === true,
      noOutput: this.#noOutputWhen?.(input) === true,
      oversizedOutput: this.#oversizedOutputWhen?.(input) === true,
      permissionRequest: this.#permissionWhen?.(input) === true,
      toolActivityCount: Number(this.#toolActivityCount?.(input) ?? 0),
    })
  }

  closeAll() {}
}

export function deterministicProviderAdapters(options) {
  return new Map([['claude-code', new DeterministicProviderAdapter(options)]])
}

export function withDeterministicProvider(input = {}) {
  return {
    ...input,
    providerAdapters: input.providerAdapters ?? deterministicProviderAdapters(),
  }
}

export function deterministicRuntimeSessionManager(BaseManager) {
  return class RuntimeSessionManagerWithDeterministicProvider extends BaseManager {
    constructor(input = {}) {
      super(withDeterministicProvider(input))
    }
  }
}
