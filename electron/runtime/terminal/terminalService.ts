// Embedded session terminal subsystem: PTY-less shell process lifecycle,
// command sentinels, output chunk buffering, and terminal projections.
// Split out of sessionManager.ts (move-only). Owns its terminal maps; talks
// to the runtime only through the injected broadcast/resolveSession hooks.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type JsonRecord,
  clone,
  isObject,
  nonEmptyString,
  now,
  optionalTrimmedString,
  validRuntimeTerminalStreams,
} from '../runtimeCommon.js'
import { validateRunnableCwd } from '../workspace/gitWorkspace.js'

const runtimeTerminalMaxChunks = 1000
const runtimeTerminalSentinelPrefix = '__ORRERY_COMMAND_DONE_'
const runtimeTerminalSentinelPattern =
  /^__ORRERY_COMMAND_DONE_([0-9a-f-]+):(-?\d+)__\s*$/
type RuntimeTerminalRun = {
  child: ReturnType<typeof spawn>
  terminal: JsonRecord
  stdoutLineBuffer: string
}
function defaultTerminalShell() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: [],
    }
  }

  if (process.platform === 'darwin' && fs.existsSync('/bin/zsh')) {
    return { command: '/bin/zsh', args: ['-f'] }
  }

  const configuredShell = nonEmptyString(process.env.SHELL)
    ? process.env.SHELL.trim()
    : undefined
  return {
    command: configuredShell || '/bin/sh',
    args: [],
  }
}

function terminalShellLabel(command, args = []) {
  return [command, ...args].join(' ')
}

function terminalPrompt(cwd) {
  const username = os.userInfo().username || 'user'
  const host = os.hostname().split('.')[0] || 'localhost'
  const folder = path.basename(cwd) || cwd
  const suffix = process.platform === 'win32' ? '>' : '%'
  return `${username}@${host} ${folder} ${suffix} `
}

function terminalCommandSentinel(commandId) {
  if (process.platform === 'win32') {
    return `echo ${runtimeTerminalSentinelPrefix}${commandId}:%ERRORLEVEL%__`
  }

  return `printf '\\n${runtimeTerminalSentinelPrefix}${commandId}:%s__\\n' "$?"`
}

function truncateTerminalChunks(chunks) {
  if (chunks.length > runtimeTerminalMaxChunks) {
    chunks.splice(0, chunks.length - runtimeTerminalMaxChunks)
  }
}

export class TerminalService {
  #terminals = new Map<string, JsonRecord>()
  #terminalRuns = new Map<string, RuntimeTerminalRun>()
  #broadcast: (event: JsonRecord) => void
  #resolveSession: (sessionId: string) => JsonRecord | undefined

  constructor({
    broadcast,
    resolveSession,
  }: {
    broadcast: (event: JsonRecord) => void
    resolveSession: (sessionId: string) => JsonRecord | undefined
  }) {
    this.#broadcast = broadcast
    this.#resolveSession = resolveSession
  }

  // killAll() closes every running terminal via these ids; killSession()
  // intentionally does not (existing behavior, kept as-is).
  runningTerminalIds() {
    return [...this.#terminalRuns.keys()]
  }

  createTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const sessionId = optionalTrimmedString(request.sessionId)
    const session = sessionId ? this.#resolveSession(sessionId) : undefined
    if (!session) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const cwd = validateRunnableCwd(request.cwd ?? session.cwd)
    const existing = this.#runningTerminalForSession(sessionId, cwd)
    if (existing) {
      return {
        ok: true,
        terminal: this.#cloneTerminal(existing.terminalId),
      }
    }

    const shell = defaultTerminalShell()
    const terminalId = randomUUID()
    const ts = now()
    const terminal = {
      terminalId,
      sessionId,
      cwd,
      shell: terminalShellLabel(shell.command, shell.args),
      prompt: terminalPrompt(cwd),
      status: 'running',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
    }
    const child = spawn(shell.command, shell.args, {
      cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? 'xterm-256color',
        ORRERY_SESSION_ID: sessionId,
        ORRERY_TERMINAL_ID: terminalId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const run = {
      child,
      terminal,
      stdoutLineBuffer: '',
    }

    this.#terminals.set(terminalId, terminal)
    this.#terminalRuns.set(terminalId, run)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data) =>
      this.#appendTerminalStdout(terminalId, String(data)),
    )
    child.stderr.on('data', (data) =>
      this.#appendTerminalChunk(terminalId, 'stderr', String(data)),
    )
    child.once('error', (error) => {
      this.#appendTerminalChunk(
        terminalId,
        'system',
        `Terminal failed: ${error.message}\n`,
      )
    })
    child.once('close', (code, signal) =>
      this.#handleTerminalClose(terminalId, code, signal),
    )

    this.#broadcast({
      type: 'terminal.created',
      terminal: this.#cloneTerminal(terminalId),
    })
    this.#appendTerminalChunk(
      terminalId,
      'system',
      `Orrery terminal attached to ${cwd}\n`,
    )

    return {
      ok: true,
      terminal: this.#cloneTerminal(terminalId),
    }
  }

  getTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const terminal = this.#terminalById(request.terminalId)
    return {
      ok: true,
      terminal: this.#cloneTerminal(terminal.terminalId),
    }
  }

  runTerminalCommand(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const run = this.#runningTerminalRun(request.terminalId)
    const terminal = run.terminal
    if (typeof request.command !== 'string') {
      throw new Error('Terminal command must be a string.')
    }
    const command = request.command
    if (terminal.currentCommand?.status === 'running') {
      throw new Error('Terminal command is already running.')
    }

    const commandId = randomUUID()
    const ts = now()
    terminal.currentCommand = {
      commandId,
      command,
      status: 'running',
      startedAt: ts,
    }
    terminal.updatedAt = ts
    this.#appendTerminalChunk(
      terminal.terminalId,
      'stdin',
      `${terminal.prompt ?? terminalPrompt(terminal.cwd)}${command}\n`,
    )
    run.child.stdin.write(`${command}\n${terminalCommandSentinel(commandId)}\n`)

    return {
      ok: true,
      commandId,
      terminal: this.#cloneTerminal(terminal.terminalId),
    }
  }

  writeTerminalInput(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const run = this.#runningTerminalRun(request.terminalId)
    if (typeof request.input !== 'string') {
      throw new Error('Terminal stdin input must be a string.')
    }

    run.child.stdin.write(request.input)
    run.terminal.updatedAt = now()
    return {
      ok: true,
      terminal: this.#cloneTerminal(run.terminal.terminalId),
    }
  }

  clearTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const terminal = this.#terminalById(request.terminalId)
    terminal.chunks = []
    terminal.updatedAt = now()
    this.#broadcast({
      type: 'terminal.cleared',
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      terminal: this.#cloneTerminal(terminal.terminalId),
    })
    return {
      ok: true,
      terminal: this.#cloneTerminal(terminal.terminalId),
    }
  }

  closeTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const terminal = this.#terminalById(request.terminalId)
    const run = this.#terminalRuns.get(terminal.terminalId)
    terminal.status = 'closed'
    terminal.updatedAt = now()

    if (run) {
      try {
        run.child.stdin.end()
      } catch {
        // Process may already have closed stdin.
      }
      try {
        run.child.kill()
      } catch {
        // Closing is best-effort once the shell process is already gone.
      }
    }

    this.#broadcast({
      type: 'terminal.closed',
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      terminal: this.#cloneTerminal(terminal.terminalId),
    })
    return {
      ok: true,
      terminal: this.#cloneTerminal(terminal.terminalId),
    }
  }

  #runningTerminalForSession(sessionId, cwd) {
    for (const terminal of this.#terminals.values()) {
      if (
        terminal.sessionId === sessionId &&
        terminal.cwd === cwd &&
        terminal.status === 'running'
      ) {
        return terminal
      }
    }

    return undefined
  }

  #terminalById(terminalId) {
    const id =
      typeof terminalId === 'string' && terminalId.trim().length > 0
        ? terminalId.trim()
        : undefined
    const terminal = id ? this.#terminals.get(id) : undefined
    if (!terminal) {
      throw new Error(`Unknown terminal: ${id ?? ''}`)
    }

    return terminal
  }

  #runningTerminalRun(terminalId) {
    const terminal = this.#terminalById(terminalId)
    const run = this.#terminalRuns.get(terminal.terminalId)
    if (!run || terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${terminal.terminalId}`)
    }

    return run
  }

  #cloneTerminal(terminalId) {
    return clone(this.#terminalById(terminalId))
  }

  #appendTerminalChunk(terminalId, stream, text) {
    const terminal = this.#terminals.get(terminalId)
    if (!terminal || typeof text !== 'string' || text.length === 0) {
      return
    }

    const chunk = {
      id: randomUUID(),
      terminalId,
      sessionId: terminal.sessionId,
      ts: now(),
      stream: validRuntimeTerminalStreams.has(stream) ? stream : 'system',
      text,
    }
    terminal.chunks.push(chunk)
    truncateTerminalChunks(terminal.chunks)
    terminal.updatedAt = chunk.ts
    this.#broadcast({
      type: 'terminal.output',
      terminalId,
      sessionId: terminal.sessionId,
      chunk,
      terminal: this.#cloneTerminal(terminalId),
    })
  }

  #appendTerminalStdout(terminalId, text) {
    const run = this.#terminalRuns.get(terminalId)
    if (!run || typeof text !== 'string' || text.length === 0) {
      return
    }

    const buffer = `${run.stdoutLineBuffer}${text}`
    let lineStart = 0

    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index]
      if (char !== '\n' && char !== '\r') {
        continue
      }

      let ending = char
      if (char === '\r' && buffer[index + 1] === '\n') {
        ending = '\r\n'
        index += 1
      }

      const line = buffer.slice(lineStart, index - ending.length + 1)
      this.#appendTerminalStdoutLine(terminalId, line, ending)
      lineStart = index + 1
    }

    run.stdoutLineBuffer = buffer.slice(lineStart)
    if (run.stdoutLineBuffer.length > 8192) {
      this.#appendTerminalChunk(terminalId, 'stdout', run.stdoutLineBuffer)
      run.stdoutLineBuffer = ''
    }
  }

  #appendTerminalStdoutLine(terminalId, line, ending = '\n') {
    const sentinelMatch = runtimeTerminalSentinelPattern.exec(line.trim())
    if (sentinelMatch) {
      this.#finishTerminalCommand(
        terminalId,
        sentinelMatch[1],
        Number(sentinelMatch[2]),
      )
      return
    }

    this.#appendTerminalChunk(terminalId, 'stdout', `${line}${ending}`)
  }

  #finishTerminalCommand(terminalId, commandId, exitCode) {
    const terminal = this.#terminals.get(terminalId)
    if (!terminal) {
      return
    }

    const current = terminal.currentCommand
    if (!current || current.commandId !== commandId) {
      return
    }

    const finished = {
      ...current,
      status: 'finished',
      finishedAt: now(),
      exitCode,
    }
    terminal.lastCommand = finished
    delete terminal.currentCommand
    terminal.updatedAt = finished.finishedAt
    this.#broadcast({
      type: 'terminal.command.finished',
      terminalId,
      sessionId: terminal.sessionId,
      command: finished,
      terminal: this.#cloneTerminal(terminalId),
    })
  }

  #handleTerminalClose(terminalId, code, signal) {
    const terminal = this.#terminals.get(terminalId)
    const run = this.#terminalRuns.get(terminalId)
    if (!terminal) {
      return
    }

    if (run?.stdoutLineBuffer) {
      const line = run.stdoutLineBuffer
      run.stdoutLineBuffer = ''
      this.#appendTerminalStdoutLine(terminalId, line, '')
    }

    this.#terminalRuns.delete(terminalId)
    const ts = now()
    const wasClosedByUser = terminal.status === 'closed'
    terminal.status = wasClosedByUser ? 'closed' : 'exited'
    terminal.exitCode = code
    terminal.signal = signal
    terminal.updatedAt = ts

    if (terminal.currentCommand?.status === 'running') {
      const finished = {
        ...terminal.currentCommand,
        status: 'finished',
        finishedAt: ts,
        exitCode: Number.isInteger(code) ? code : undefined,
      }
      terminal.lastCommand = finished
      delete terminal.currentCommand
      this.#broadcast({
        type: 'terminal.command.finished',
        terminalId,
        sessionId: terminal.sessionId,
        command: finished,
        terminal: this.#cloneTerminal(terminalId),
      })
    }

    if (!wasClosedByUser) {
      this.#broadcast({
        type: 'terminal.exited',
        terminalId,
        sessionId: terminal.sessionId,
        terminal: this.#cloneTerminal(terminalId),
      })
    }
  }
}
