import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

class DeterministicRun extends EventEmitter {
  #closed = false
  #timer

  constructor(input, { killOnStart = false } = {}) {
    super()
    setImmediate(() => {
      if (!this.#closed) {
        this.emit('providerSession', {
          providerSessionId: input.backendSessionId ?? input.sessionId,
        })
      }
    })
    const delay = input.prompt?.includes('ORRERY_SLEEP')
      ? 1200
      : input.prompt?.includes('ORRERY_DELAY')
        ? 500
        : 50
    this.#timer = setTimeout(() => this.#complete(input), delay)
    if (killOnStart) {
      setImmediate(() => this.kill())
    }
  }

  #complete(input) {
    if (this.#closed) return
    const providerSessionId = input.backendSessionId ?? input.sessionId
    const turnDiffFixture = path.join(input.cwd, 'README.md')
    if (
      fs.existsSync(turnDiffFixture) &&
      fs.readFileSync(turnDiffFixture, 'utf8').includes('# Turn diff test')
    ) {
      fs.appendFileSync(path.join(input.cwd, 'p1-turn-diff.txt'), 'changed by deterministic provider\n')
    }
    const ts = new Date().toISOString()
    if (input.prompt?.includes('ORRERY_TOOL_ACTIVITY')) {
      const itemId = `tool-${input.turnId}`
      this.emit('providerEvent', {
        id: `tool-start-${input.turnId}`,
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
      this.emit('providerEvent', {
        id: `tool-complete-${input.turnId}`,
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
    this.emit('providerEvent', {
      id: `content-${input.turnId}`,
      ts,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: 'content.delta',
      streamKind: 'assistant_text',
      text: `handled: ${input.prompt ?? ''}`,
    })
    this.emit('result', { session_id: providerSessionId, result: 'done' })
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

export class DeterministicProviderAdapter {
  kind
  startedTurns = []
  #failWhen
  #killWhen

  constructor({ failWhen, killWhen, kind = 'claude-code' } = {}) {
    this.#failWhen = failWhen
    this.#killWhen = killWhen
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
