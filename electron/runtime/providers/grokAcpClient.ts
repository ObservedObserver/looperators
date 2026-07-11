import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { buildPath } from '../claudeRuntimeShared.js'
import type {
  GrokAcpId,
  GrokAcpMessage,
  GrokAcpProviderInstance,
} from './grokAcpTypes.js'

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const stderrTailMaxLines = 20
const stderrLineMaxLength = 16 * 1024

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function launchArgs(providerInstance?: GrokAcpProviderInstance) {
  return Array.isArray(providerInstance?.launchArgs)
    ? providerInstance.launchArgs.filter(nonEmptyString).map((arg) => arg.trim())
    : []
}

function grokEnv(providerInstance?: GrokAcpProviderInstance) {
  return {
    ...process.env,
    ...(providerInstance?.env ?? {}),
    PATH: buildPath(),
    NO_COLOR: '1',
    GROK_OAUTH2_REFERRER: 'orrery',
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function secretValuesFromEnv(env: NodeJS.ProcessEnv) {
  return Object.entries(env)
    .filter(([key, value]) => /(?:token|key|secret|password|credential)/i.test(key) && nonEmptyString(value))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4)
}

function redactDiagnostic(value: string, secrets: string[]) {
  return secrets.reduce(
    (current, secret) => current.split(secret).join('[REDACTED]'),
    value,
  )
}

function redactProtocolValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactDiagnostic(value, secrets)
  if (Array.isArray(value)) {
    return value.map((entry) => redactProtocolValue(entry, secrets))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactProtocolValue(entry, secrets),
      ]),
    )
  }
  return value
}

type StderrState = {
  buffer: string
  discardingLine: boolean
  secrets: string[]
  tail: string[]
}

function recordStderrLine(state: StderrState, line: string) {
  const redacted = redactDiagnostic(line, state.secrets)
  state.tail.push(redacted)
  if (state.tail.length > stderrTailMaxLines) state.tail.shift()
  return redacted
}

function drainStderr(state: StderrState, chunk: string, final = false) {
  const emitted: string[] = []
  let input = chunk
  if (state.discardingLine) {
    const newline = input.search(/\r?\n/)
    if (newline < 0) return emitted
    input = input.slice(newline + (input[newline] === '\r' ? 2 : 1))
    state.discardingLine = false
  }
  state.buffer += input
  let newline = state.buffer.search(/\r?\n/)
  while (newline >= 0) {
    const line = state.buffer.slice(0, newline)
    const width = state.buffer[newline] === '\r' ? 2 : 1
    state.buffer = state.buffer.slice(newline + width)
    if (line) {
      emitted.push(
        recordStderrLine(
          state,
          line.length > stderrLineMaxLength ? '[stderr line omitted: too long]' : line,
        ),
      )
    }
    newline = state.buffer.search(/\r?\n/)
  }
  if (state.buffer.length > stderrLineMaxLength) {
    state.buffer = ''
    state.discardingLine = true
    emitted.push(recordStderrLine(state, '[stderr line omitted: too long]'))
  } else if (final && state.buffer) {
    emitted.push(recordStderrLine(state, state.buffer))
    state.buffer = ''
  }
  return emitted
}

export function redactGrokDiagnosticForTest(value: string, env: NodeJS.ProcessEnv) {
  return redactDiagnostic(value, secretValuesFromEnv(env))
}

export function collectGrokStderrForTest(chunks: string[], env: NodeJS.ProcessEnv) {
  const state: StderrState = {
    buffer: '',
    discardingLine: false,
    secrets: secretValuesFromEnv(env),
    tail: [],
  }
  const emitted = chunks.flatMap((chunk) => drainStderr(state, chunk))
  emitted.push(...drainStderr(state, '', true))
  return { emitted, tail: state.tail }
}

export class GrokAcpClient extends EventEmitter {
  #child: ChildProcessWithoutNullStreams
  #buffer = ''
  #nextId = 1
  #pending = new Map<GrokAcpId, PendingRequest>()
  #stderrState: StderrState
  #closed = false
  #closeTimer?: NodeJS.Timeout
  #closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  #resolveClose!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void

  constructor({
    cwd,
    providerInstance,
    agentArgs = [],
  }: {
    cwd?: string
    providerInstance?: GrokAcpProviderInstance
    agentArgs?: string[]
  } = {}) {
    super()
    this.#closePromise = new Promise((resolve) => {
      this.#resolveClose = resolve
    })
    const command = nonEmptyString(providerInstance?.binaryPath)
      ? providerInstance.binaryPath.trim()
      : process.env.ORRERY_GROK_BIN || 'grok'
    const childEnv = grokEnv(providerInstance)
    this.#stderrState = {
      buffer: '',
      discardingLine: false,
      secrets: secretValuesFromEnv(childEnv),
      tail: [],
    }
    this.#child = spawn(
      command,
      ['agent', ...launchArgs(providerInstance), ...agentArgs, 'stdio'],
      {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#handleStdout(chunk))
    this.#child.stderr.on('data', (chunk) => this.#handleStderr(chunk))
    this.#child.stdin.on('error', (error) => {
      if (!this.#closed) this.#failTransport(error)
    })
    this.#child.on('error', (error) => this.#failTransport(error))
    this.#child.on('close', (code, signal) => this.#handleClose(code, signal))
  }

  get stderrTail() {
    return [...this.#stderrState.tail]
  }

  request<T = unknown>(method: string, params?: unknown, { timeoutMs = 60_000 } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error('Grok ACP client is closed.'))
    }
    const id = this.#nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`Grok ACP request timed out: ${method} after ${timeoutMs}ms.`))
        }
      }, timeoutMs)
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      this.#write(message).catch((error) => {
        const pending = this.#pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method: string, params?: unknown) {
    return this.#write({ jsonrpc: '2.0', method, params })
  }

  respond(id: GrokAcpId, result: unknown) {
    return this.#write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: GrokAcpId, code: number, message: string, data?: unknown) {
    return this.#write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    })
  }

  close({ graceMs = 250 } = {}) {
    if (this.#closed) return false
    this.#closed = true
    this.#rejectAll(new Error('Grok ACP client closed.'))
    this.#child.kill('SIGTERM')
    this.#closeTimer = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill('SIGKILL')
      }
    }, graceMs)
    this.#closeTimer.unref?.()
    return true
  }

  waitForClose() {
    return this.#closePromise
  }

  async #write(message: unknown) {
    if (this.#closed || this.#child.stdin.destroyed) {
      throw new Error('Grok ACP client is closed.')
    }
    const line = `${JSON.stringify(message)}\n`
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
    })
    this.emit('sent', message)
  }

  #handleStdout(chunk: string) {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      this.#handleLine(line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  #handleLine(line: string) {
    if (!line.trim()) return
    let message: GrokAcpMessage
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.emit('protocolError', new Error(`Invalid Grok ACP JSON line: ${errorMessage(error)}`))
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.emit('protocolError', new Error('Invalid Grok ACP message: expected an object.'))
      return
    }
    message = redactProtocolValue(
      message,
      this.#stderrState.secrets,
    ) as GrokAcpMessage
    this.emit('message', message)
    if (
      message.id !== undefined &&
      (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    ) {
      const pending = this.#pending.get(message.id)
      if (!pending) {
        this.emit('orphanResponse', message)
        return
      }
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new Error(
            `Grok ACP ${pending.method} failed (${message.error.code ?? 'unknown'}): ${message.error.message ?? 'Unknown error'}`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      if (!this.emit('request', message)) {
        void this.respondError(
          message.id,
          -32601,
          `Method '${message.method}' is not supported by this client.`,
        ).catch((error) => this.#failTransport(error))
      }
      return
    }
    if (typeof message.method === 'string') this.emit('notification', message)
  }

  #handleStderr(chunk: string) {
    for (const line of drainStderr(this.#stderrState, chunk)) {
      this.emit('stderr', line)
    }
  }

  #failTransport(error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    this.#rejectAll(normalized)
    this.emit('transportError', normalized)
  }

  #handleClose(code: number | null, signal: NodeJS.Signals | null) {
    if (this.#closeTimer) clearTimeout(this.#closeTimer)
    for (const line of drainStderr(this.#stderrState, '', true)) {
      this.emit('stderr', line)
    }
    const stderrTail = this.#stderrState.tail
    const suffix = stderrTail.length > 0 ? ` Recent stderr: ${stderrTail.join(' | ')}` : ''
    this.#rejectAll(
      new Error(`Grok ACP process closed before response (code=${code ?? 'null'}, signal=${signal ?? 'null'}).${suffix}`),
    )
    this.#closed = true
    this.#resolveClose({ code, signal })
    this.emit('close', { code, signal, stderrTail: [...stderrTail] })
  }

  #rejectAll(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
