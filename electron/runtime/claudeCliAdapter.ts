import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const membraneServerPath = path.join(__dirname, 'membraneMcpServer.js')

const commonCliPaths = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/Users/observedobserver/.local/bin',
]

export function buildPath() {
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

function extractStreamText(event) {
  if (
    event?.type === 'stream_event' &&
    event.event?.type === 'content_block_delta' &&
    event.event?.delta?.type === 'text_delta' &&
    typeof event.event.delta.text === 'string'
  ) {
    return event.event.delta.text
  }

  return extractAssistantText(event)
}

function getEventType(event) {
  if (event?.type === 'stream_event' && typeof event.event?.type === 'string') {
    return `${event.type}:${event.event.type}`
  }

  return event?.type
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function expandHomePath(value) {
  if (!nonEmptyString(value)) {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed === '~') {
    return os.homedir()
  }
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

function providerBinaryPath(providerInstance) {
  return nonEmptyString(providerInstance?.binaryPath)
    ? providerInstance.binaryPath.trim()
    : claudeCommand()
}

function providerLaunchArgs(providerInstance) {
  return Array.isArray(providerInstance?.launchArgs)
    ? providerInstance.launchArgs.filter(nonEmptyString).map((arg) => arg.trim())
    : []
}

function providerEnv(providerInstance) {
  const homePath = expandHomePath(providerInstance?.homePath)
  return {
    ...process.env,
    ...(providerInstance?.env ?? {}),
    PATH: buildPath(),
    NO_COLOR: '1',
    ...(homePath ? { HOME: homePath } : {}),
  }
}

export function membraneSystemPrompt() {
  return [
    'You are running inside Orrery.',
    'Use the orrery_membrane MCP tools when you need to affect the agent graph:',
    '- mcp__orrery_membrane__create_session creates a real downstream session/node.',
    '- mcp__orrery_membrane__resume_session appends a user message to an existing session/node and resumes it.',
    '- mcp__orrery_membrane__report submits typed verdict, relationship, or info data to the graph blackboard.',
    'Do not invent session ids. Use ids returned by create_session or provided in the user prompt.',
  ].join('\n')
}

function writeJson0600(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.chmodSync(filePath, 0o600)
}

export function createMcpHandoff(membrane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-membrane-'))
  fs.chmodSync(dir, 0o700)

  const bootstrapPath = path.join(dir, 'bootstrap.json')
  const configPath = path.join(dir, 'mcp-config.json')

  writeJson0600(bootstrapPath, {
    bridgeUrl: membrane.bridgeUrl,
    token: membrane.token,
  })

  writeJson0600(configPath, {
    mcpServers: {
      orrery_membrane: {
        command: process.execPath,
        args: [membraneServerPath],
        env: {
          ORRERY_MEMBRANE_BOOTSTRAP_FILE: bootstrapPath,
        },
      },
    },
  })

  return { dir, configPath }
}

export function cleanupMcpHandoff(handoff) {
  if (!handoff) {
    return
  }

  fs.rmSync(handoff.dir, { recursive: true, force: true })
}

function buildClaudeArgs({ prompt, backendSessionId, sessionId, mcpConfigPath }) {
  const args = []

  if (backendSessionId) {
    args.push('--resume', backendSessionId)
  } else if (sessionId) {
    args.push('--session-id', sessionId)
  }

  args.push(
    '-p',
    prompt,
    '--output-format=stream-json',
    '--verbose',
    '--include-partial-messages'
  )

  if (mcpConfigPath) {
    args.push(
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
      '--append-system-prompt',
      membraneSystemPrompt()
    )
  }

  return args
}

export function claudeCommand() {
  return process.env.ORRERY_CLAUDE_BIN || 'claude'
}

export class ClaudeCliRun extends EventEmitter {
  #child
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #killRequested = false
  #closed = false
  #killTimer
  #mcpHandoff

  constructor({ prompt, cwd, backendSessionId, sessionId, membrane, providerInstance }) {
    super()

    this.#mcpHandoff = membrane ? createMcpHandoff(membrane) : undefined

    try {
      this.#child = spawn(
        providerBinaryPath(providerInstance),
        [
          ...providerLaunchArgs(providerInstance),
          ...buildClaudeArgs({
            prompt,
            backendSessionId,
            sessionId,
            mcpConfigPath: this.#mcpHandoff?.configPath,
          }),
        ],
        {
          cwd,
          env: providerEnv(providerInstance),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
    } catch (error) {
      cleanupMcpHandoff(this.#mcpHandoff)
      throw error
    }

    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')

    this.#child.stdout.on('data', (data) => this.#handleStdout(data))
    this.#child.stderr.on('data', (data) => this.#handleStderr(data))
    this.#child.on('error', (error) => {
      cleanupMcpHandoff(this.#mcpHandoff)
      this.emit('error', error)
    })
    this.#child.on('close', (code, signal) => {
      this.#closed = true
      if (this.#killTimer) {
        clearTimeout(this.#killTimer)
      }
      this.#flushStdout()
      this.#flushStderr()
      cleanupMcpHandoff(this.#mcpHandoff)
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
      eventType: getEventType(event),
      text: extractStreamText(event),
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
