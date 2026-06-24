import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

const commonCliPaths = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/Users/observedobserver/.local/bin',
]

function buildPath() {
  const currentPath = process.env.PATH ?? ''
  return [...commonCliPaths, currentPath].filter(Boolean).join(':')
}

function extractAssistantText(event) {
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) {
    return undefined
  }

  const text = event.message.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')

  return text.length > 0 ? text : undefined
}

export class ClaudeCliRun extends EventEmitter {
  #child
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #killRequested = false
  #closed = false
  #killTimer

  constructor({ prompt, cwd }) {
    super()

    this.#child = spawn(
      'claude',
      ['-p', prompt, '--output-format=stream-json', '--verbose'],
      {
        cwd,
        env: {
          ...process.env,
          PATH: buildPath(),
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')

    this.#child.stdout.on('data', (data) => this.#handleStdout(data))
    this.#child.stderr.on('data', (data) => this.#handleStderr(data))
    this.#child.on('error', (error) => this.emit('error', error))
    this.#child.on('close', (code, signal) => {
      this.#closed = true
      if (this.#killTimer) {
        clearTimeout(this.#killTimer)
      }
      this.#flushStdout()
      this.#flushStderr()
      this.emit('close', {
        code,
        signal,
        killed: this.#killRequested,
      })
    })
  }

  kill() {
    if (this.#child.killed) {
      return false
    }

    this.#killRequested = true
    const didSignal = this.#child.kill('SIGTERM')
    this.#killTimer = setTimeout(() => {
      if (!this.#closed) {
        this.#child.kill('SIGKILL')
      }
    }, 2000)

    return didSignal
  }

  #handleStdout(data) {
    this.#stdoutBuffer += data
    let newlineIndex = this.#stdoutBuffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex)
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1)
      this.#emitStdoutLine(line)
      newlineIndex = this.#stdoutBuffer.indexOf('\n')
    }
  }

  #handleStderr(data) {
    this.#stderrBuffer += data
    let newlineIndex = this.#stderrBuffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = this.#stderrBuffer.slice(0, newlineIndex)
      this.#stderrBuffer = this.#stderrBuffer.slice(newlineIndex + 1)
      this.#emitStderrLine(line)
      newlineIndex = this.#stderrBuffer.indexOf('\n')
    }
  }

  #flushStdout() {
    if (this.#stdoutBuffer.length === 0) {
      return
    }

    this.#emitStdoutLine(this.#stdoutBuffer)
    this.#stdoutBuffer = ''
  }

  #flushStderr() {
    if (this.#stderrBuffer.length === 0) {
      return
    }

    this.#emitStderrLine(this.#stderrBuffer)
    this.#stderrBuffer = ''
  }

  #emitStdoutLine(line) {
    if (line.trim().length === 0) {
      return
    }

    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      this.emit('stream', {
        stream: 'stdout',
        raw: line,
        parseError: error.message,
      })
      return
    }

    this.emit('stream', {
      stream: 'stdout',
      raw: line,
      event,
      eventType: event.type,
      text: extractAssistantText(event),
    })

    if (event.type === 'result') {
      this.emit('result', event)
    }
  }

  #emitStderrLine(line) {
    if (line.trim().length === 0) {
      return
    }

    this.emit('stream', {
      stream: 'stderr',
      raw: line,
      text: line,
    })
  }
}

export function runClaudeCli(input) {
  return new ClaudeCliRun(input)
}
