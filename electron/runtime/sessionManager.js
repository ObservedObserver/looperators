import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createEmptyGraphState } from '../../shared/graph-state.js'
import { runClaudeCli } from './claudeCliAdapter.js'

const defaultPrompt =
  'You are running under Orrery P0 runtime verification. Reply with one short sentence confirming stream-json is working, then stop.'

function now() {
  return new Date().toISOString()
}

function clone(value) {
  return structuredClone(value)
}

function safeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return process.cwd()
  }

  return path.resolve(cwd)
}

export class RuntimeSessionManager {
  #state = createEmptyGraphState()
  #runs = new Map()

  getState() {
    return clone(this.#state)
  }

  createSession(input = {}) {
    const sessionId = randomUUID()
    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt
        : defaultPrompt
    const cwd = safeCwd(input.cwd)
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `Claude ${this.#state.nodes.length + 1}`
    const ts = now()

    this.#state.sessions[sessionId] = {
      sessionId,
      nodeId: sessionId,
      backend: 'claude-cli',
      agent: 'claude-code',
      label,
      prompt,
      cwd,
      role: 'worker',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
    }

    this.#state.nodes.push({
      nodeId: sessionId,
      sessionId,
      label,
      role: 'worker',
      agent: 'claude-code',
      status: 'pending',
      position: {
        x: 96 + (this.#state.nodes.length % 4) * 280,
        y: 96 + Math.floor(this.#state.nodes.length / 4) * 180,
      },
    })
    this.#touch()
    this.#broadcast({ type: 'session.created', sessionId, state: this.getState() })

    this.#startRun(sessionId)

    return { sessionId, state: this.getState() }
  }

  killSession(sessionId) {
    const run = this.#runs.get(sessionId)
    const session = this.#state.sessions[sessionId]

    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    if (!run) {
      return { ok: false, state: this.getState() }
    }

    const ok = run.kill()
    if (ok) {
      session.status = 'killed'
      session.updatedAt = now()
      this.#updateNodeStatus(sessionId, 'killed')
      this.#touch()
      this.#broadcast({ type: 'session.killed', sessionId, state: this.getState() })
    }

    return { ok, state: this.getState() }
  }

  killAll() {
    for (const sessionId of this.#runs.keys()) {
      this.killSession(sessionId)
    }
  }

  #startRun(sessionId) {
    const session = this.#state.sessions[sessionId]
    session.status = 'running'
    session.startedAt = now()
    session.updatedAt = session.startedAt
    this.#updateNodeStatus(sessionId, 'running')
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    let run
    try {
      run = runClaudeCli({ prompt: session.prompt, cwd: session.cwd })
    } catch (error) {
      this.#failSession(sessionId, error.message)
      return
    }

    this.#runs.set(sessionId, run)

    run.on('stream', (chunk) => this.#appendStreamChunk(sessionId, chunk))
    run.on('result', (event) => this.#recordResult(sessionId, event))
    run.on('error', (error) => this.#failSession(sessionId, error.message))
    run.on('close', ({ code, signal, killed }) => {
      this.#runs.delete(sessionId)

      const current = this.#state.sessions[sessionId]
      if (!current) {
        return
      }

      current.exitCode = code
      current.signal = signal
      current.finishedAt = now()
      current.updatedAt = current.finishedAt

      if (killed || current.status === 'killed') {
        current.status = 'killed'
        this.#updateNodeStatus(sessionId, 'killed')
        this.#touch()
        this.#broadcast({
          type: 'session.killed',
          sessionId,
          state: this.getState(),
        })
        return
      }

      if (code === 0 && current.status !== 'failed') {
        current.status = 'finished'
        this.#updateNodeStatus(sessionId, 'finished')
        this.#touch()
        this.#broadcast({
          type: 'session.finished',
          sessionId,
          state: this.getState(),
        })
        return
      }

      this.#failSession(
        sessionId,
        current.error ?? `Claude exited with code ${code ?? 'null'}`
      )
    })
  }

  #appendStreamChunk(sessionId, chunk) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    if (chunk.event?.type === 'system' && chunk.event?.session_id) {
      session.backendSessionId = chunk.event.session_id
    }

    const streamChunk = {
      id: randomUUID(),
      sessionId,
      ts: now(),
      stream: chunk.stream,
      raw: chunk.raw,
      eventType: chunk.eventType,
      text: chunk.text,
    }

    session.chunks.push(streamChunk)
    if (session.chunks.length > 500) {
      session.chunks.splice(0, session.chunks.length - 500)
    }

    session.updatedAt = streamChunk.ts
    this.#touch()
    this.#broadcast({
      type: 'session.stream',
      sessionId,
      chunk: streamChunk,
      state: this.getState(),
    })
  }

  #recordResult(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    session.backendSessionId = event.session_id ?? session.backendSessionId
    session.result = typeof event.result === 'string' ? event.result : undefined
    session.updatedAt = now()
    this.#touch()
  }

  #failSession(sessionId, error) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    session.status = 'failed'
    session.error = error
    session.finishedAt = now()
    session.updatedAt = session.finishedAt
    this.#updateNodeStatus(sessionId, 'failed')
    this.#touch()
    this.#broadcast({ type: 'session.failed', sessionId, error, state: this.getState() })
  }

  #updateNodeStatus(sessionId, status) {
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    if (node) {
      node.status = status
    }
  }

  #touch() {
    this.#state.updatedAt = now()
  }

  #broadcast(event) {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('orrery:runtime-event', event)
    }
  }
}
