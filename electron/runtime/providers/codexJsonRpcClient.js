import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

function codexCommand() {
  return process.env.ORRERY_CODEX_BIN || 'codex'
}

function buildPath() {
  const currentPath = process.env.PATH ?? ''
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/Users/observedobserver/.nvs/default/bin',
    currentPath,
  ]
    .filter(Boolean)
    .join(':')
}

export class CodexJsonRpcClient extends EventEmitter {
  #child
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #closed = false

  constructor({ cwd } = {}) {
    super()
    this.#child = spawn(codexCommand(), ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: {
        ...process.env,
        PATH: buildPath(),
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (data) => this.#handleStdout(data))
    this.#child.stderr.on('data', (data) => this.emit('stderr', data))
    this.#child.on('error', (error) => this.emit('error', error))
    this.#child.on('close', (code, signal) => {
      this.#closed = true
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer)
        reject(new Error(`Codex app-server closed before response: ${code}`))
      }
      this.#pending.clear()
      this.emit('close', { code, signal })
    })
  }

  request(method, params, { timeoutMs = 60000 } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error('Codex app-server is closed.'))
    }

    const id = this.#nextId++
    const payload = { id, method, params }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Timed out waiting for Codex response: ${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`)
      this.emit('sent', payload)
    })
  }

  respond(id, result) {
    if (this.#closed) {
      return
    }

    this.#child.stdin.write(`${JSON.stringify({ id, result })}\n`)
    this.emit('sent', { id, result })
  }

  close() {
    if (this.#closed) {
      return false
    }

    this.#child.kill('SIGTERM')
    return true
  }

  #handleStdout(data) {
    this.#buffer += data
    let newlineIndex = this.#buffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex)
      this.#buffer = this.#buffer.slice(newlineIndex + 1)
      this.#handleLine(line)
      newlineIndex = this.#buffer.indexOf('\n')
    }
  }

  #handleLine(line) {
    if (line.trim().length === 0) {
      return
    }

    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.emit('error', new Error(`Invalid Codex JSON-RPC line: ${error.message}`))
      return
    }

    this.emit('message', message)

    if (
      Object.hasOwn(message, 'id') &&
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
            `Codex ${pending.method} failed: ${
              message.error.message ?? JSON.stringify(message.error)
            }`
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      this.emit('request', message)
      return
    }

    if (message.method) {
      this.emit('notification', message)
    }
  }
}
