import electron from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  createEmptyGraphState,
  graphEdgeKinds,
  graphStateVersion,
} from '../../shared/graph-state.js'
import { runClaudeCli } from './claudeCliAdapter.js'
import { MembraneBridge } from './membraneBridge.js'

const { BrowserWindow } =
  electron && typeof electron === 'object' && 'BrowserWindow' in electron
    ? electron
    : { BrowserWindow: undefined }

const defaultPrompt =
  'You are running under Orrery P1 live session verification. Reply with one short sentence confirming stream-json is working, then stop.'

const storageBackupSuffix = '.bak'
const recoverableActiveStatuses = new Set(['pending', 'running'])
const validSessionStatuses = new Set(['pending', 'running', 'idle', 'failed', 'killed'])
const validMessageStatuses = new Set(['streaming', 'complete', 'failed'])
const validGraphEdgeKinds = new Set(graphEdgeKinds)

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

function truncateChunks(chunks) {
  if (chunks.length > 1000) {
    chunks.splice(0, chunks.length - 1000)
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function diagnostic(type, message, details = {}) {
  return {
    id: randomUUID(),
    type,
    message,
    details,
    ts: now(),
  }
}

function backupFileFor(storageFile) {
  return `${storageFile}${storageBackupSuffix}`
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, error }
  }
}

function preserveCorruptFile(storageFile) {
  if (!fs.existsSync(storageFile)) {
    return undefined
  }

  const corruptFile = `${storageFile}.corrupt.${Date.now()}`
  try {
    fs.copyFileSync(storageFile, corruptFile)
    return corruptFile
  } catch {
    return undefined
  }
}

function writeJsonAtomically(storageFile, value) {
  fs.mkdirSync(path.dirname(storageFile), { recursive: true })

  if (fs.existsSync(storageFile)) {
    if (readJsonFile(storageFile).ok) {
      fs.copyFileSync(storageFile, backupFileFor(storageFile))
    } else {
      preserveCorruptFile(storageFile)
    }
  }

  const tempFile = `${storageFile}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tempFile, storageFile)
  } catch (error) {
    try {
      fs.rmSync(tempFile, { force: true })
    } catch {
      // Best-effort cleanup only; the next load ignores orphan temp files.
    }
    throw error
  }
}

function messageContent(message, context) {
  if (typeof context === 'string' && context.trim().length > 0) {
    return `${message}\n\nContext:\n${context}`
  }

  return message
}

export class RuntimeSessionManager {
  #state = createEmptyGraphState()
  #runs = new Map()
  #runContext = new Map()
  #storageFile
  #bridge

  constructor({ storageFile } = {}) {
    this.#storageFile =
      typeof storageFile === 'string' && storageFile.length > 0
        ? storageFile
        : undefined
    this.#state = this.#loadState()
    this.#bridge = new MembraneBridge({
      handler: (request) => this.handleMembraneRequest(request),
    })
    this.#persistState()
  }

  getState() {
    return clone(this.#state)
  }

  async createSession(input = {}) {
    const sessionId = randomUUID()
    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt
        : defaultPrompt
    const initialContent = messageContent(prompt, input.context)
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
      backendSessionId: sessionId,
      agent: 'claude-code',
      label,
      prompt: initialContent,
      cwd,
      role: 'worker',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
      messages: [
        {
          id: randomUUID(),
          sessionId,
          role: 'user',
          content: initialContent,
          ts,
          runId: undefined,
          status: 'complete',
        },
      ],
    }

    this.#state.nodes.push({
      nodeId: sessionId,
      sessionId,
      label,
      role: 'worker',
      agent: 'claude-code',
      clusterId:
        typeof input.cluster === 'string' && input.cluster.trim().length > 0
          ? input.cluster.trim()
          : undefined,
      status: 'pending',
      position: {
        x: 96 + (this.#state.nodes.length % 4) * 280,
        y: 96 + Math.floor(this.#state.nodes.length / 4) * 180,
      },
    })
    this.#addNodeToCluster(sessionId, input.cluster)
    this.#touch()
    this.#broadcast({ type: 'session.created', sessionId, state: this.getState() })

    await this.#startRun(sessionId, {
      prompt: initialContent,
      runKind: 'create',
      userMessageId: this.#state.sessions[sessionId].messages[0].id,
    })

    return { sessionId, state: this.getState() }
  }

  async resumeSession(input = {}) {
    const sessionId = input.sessionId
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    if (this.#runs.has(sessionId)) {
      throw new Error(`Session is already running: ${sessionId}`)
    }

    if (session.status === 'killed') {
      throw new Error(`Killed session cannot be resumed: ${sessionId}`)
    }

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('Resume message is required')
    }

    const content = messageContent(message, input.context)
    const ts = now()
    const userMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content,
      ts,
      runId: undefined,
      status: 'complete',
    }
    session.messages.push(userMessage)
    session.prompt = content
    session.status = 'pending'
    session.error = undefined
    session.exitCode = undefined
    session.signal = undefined
    session.updatedAt = ts
    this.#updateNodeStatus(sessionId, 'pending')
    this.#touch()
    this.#broadcast({ type: 'session.resumed', sessionId, state: this.getState() })

    await this.#startRun(sessionId, {
      prompt: content,
      runKind: 'resume',
      userMessageId: userMessage.id,
    })

    return { ok: true, state: this.getState() }
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
      this.#markActiveAssistant(sessionId, 'failed')
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
    this.#bridge?.close()
  }

  async handleMembraneRequest({ tool, source, input }) {
    if (!this.#state.sessions[source]) {
      throw new Error(`Unknown membrane source session: ${source}`)
    }

    if (tool === 'create_session') {
      return this.#membraneCreateSession(source, input)
    }

    if (tool === 'resume_session') {
      return this.#membraneResumeSession(source, input)
    }

    if (tool === 'report') {
      return this.#membraneReport(source, input)
    }

    throw new Error(`Unknown membrane tool: ${tool}`)
  }

  async #startRun(sessionId, { prompt, runKind, userMessageId }) {
    const session = this.#state.sessions[sessionId]
    const runId = randomUUID()
    const bridgeUrl = await this.#bridge.start()
    const membraneToken = this.#bridge.createRunToken(sessionId)
    session.status = 'running'
    session.startedAt = now()
    session.finishedAt = undefined
    session.updatedAt = session.startedAt
    this.#updateMessageRunId(session, userMessageId, runId)
    this.#updateNodeStatus(sessionId, 'running')
    this.#runContext.set(sessionId, {
      runId,
      runKind,
      assistantMessageId: undefined,
      sawTextDelta: false,
    })
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    let run
    try {
      run = runClaudeCli({
        prompt,
        cwd: session.cwd,
        backendSessionId: runKind === 'resume' ? session.backendSessionId : undefined,
        sessionId: runKind === 'create' ? sessionId : undefined,
        membrane: {
          bridgeUrl,
          token: membraneToken,
        },
      })
    } catch (error) {
      this.#bridge.revokeRunToken(membraneToken)
      this.#failSession(sessionId, error.message)
      return
    }

    this.#runs.set(sessionId, run)

    run.on('stream', (chunk) => this.#appendStreamChunk(sessionId, chunk))
    run.on('result', (event) => this.#recordResult(sessionId, event))
    run.on('error', (error) => this.#failSession(sessionId, error.message))
    run.on('close', ({ code, signal, killed }) => {
      this.#runs.delete(sessionId)
      this.#bridge.revokeRunToken(membraneToken)

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
        this.#markActiveAssistant(sessionId, 'failed')
        this.#updateNodeStatus(sessionId, 'killed')
        this.#runContext.delete(sessionId)
        this.#touch()
        this.#broadcast({
          type: 'session.killed',
          sessionId,
          state: this.getState(),
        })
        return
      }

      if (code === 0 && current.status !== 'failed') {
        current.status = 'idle'
        this.#markActiveAssistant(sessionId, 'complete')
        this.#updateNodeStatus(sessionId, 'idle')
        this.#runContext.delete(sessionId)
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

    const backendSessionId = chunk.event?.session_id ?? chunk.event?.event?.session_id
    if (typeof backendSessionId === 'string') {
      session.backendSessionId = backendSessionId
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
    truncateChunks(session.chunks)

    this.#appendAssistantMessage(sessionId, chunk)
    session.updatedAt = streamChunk.ts
    this.#touch()
    this.#broadcast({
      type: 'session.stream',
      sessionId,
      chunk: streamChunk,
      state: this.getState(),
    })
  }

  #appendAssistantMessage(sessionId, chunk) {
    const session = this.#state.sessions[sessionId]
    const context = this.#runContext.get(sessionId)
    if (!session || !context || chunk.stream !== 'stdout') {
      return
    }

    if (
      chunk.event?.type === 'stream_event' &&
      chunk.event.event?.type === 'content_block_delta' &&
      typeof chunk.text === 'string'
    ) {
      const message = this.#ensureAssistantMessage(session, context)
      message.content += chunk.text
      message.status = 'streaming'
      context.sawTextDelta = true
      return
    }

    if (chunk.event?.type === 'assistant' && typeof chunk.text === 'string') {
      const message = this.#ensureAssistantMessage(session, context)
      if (!context.sawTextDelta || message.content.trim().length === 0) {
        message.content = chunk.text
      }
      message.status = 'streaming'
    }
  }

  #ensureAssistantMessage(session, context) {
    let message = context.assistantMessageId
      ? session.messages.find((item) => item.id === context.assistantMessageId)
      : undefined

    if (!message) {
      message = {
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'assistant',
        content: '',
        ts: now(),
        runId: context.runId,
        status: 'streaming',
      }
      session.messages.push(message)
      context.assistantMessageId = message.id
    }

    return message
  }

  #recordResult(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    session.backendSessionId = event.session_id ?? session.backendSessionId
    session.result = typeof event.result === 'string' ? event.result : undefined
    if (session.result) {
      const context = this.#runContext.get(sessionId)
      if (context) {
        const message = this.#ensureAssistantMessage(session, context)
        if (!context.sawTextDelta || message.content.trim().length === 0) {
          message.content = session.result
        }
      }
    }
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
    this.#markActiveAssistant(sessionId, 'failed')
    this.#updateNodeStatus(sessionId, 'failed')
    this.#runContext.delete(sessionId)
    this.#touch()
    this.#broadcast({ type: 'session.failed', sessionId, error, state: this.getState() })
  }

  #markActiveAssistant(sessionId, status) {
    const session = this.#state.sessions[sessionId]
    const context = this.#runContext.get(sessionId)
    if (!session || !context?.assistantMessageId) {
      return
    }

    const message = session.messages.find(
      (item) => item.id === context.assistantMessageId
    )
    if (message) {
      message.status = status
    }
  }

  #updateMessageRunId(session, messageId, runId) {
    const message = session.messages.find((item) => item.id === messageId)
    if (message) {
      message.runId = runId
    }
  }

  #updateNodeStatus(sessionId, status) {
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    if (node) {
      node.status = status
    }
  }

  #addNodeToCluster(sessionId, clusterId) {
    if (typeof clusterId !== 'string' || clusterId.trim().length === 0) {
      return
    }

    const normalizedClusterId = clusterId.trim()
    if (!this.#state.clusters[normalizedClusterId]) {
      this.#state.clusters[normalizedClusterId] = {
        clusterId: normalizedClusterId,
        label: normalizedClusterId,
        nodeIds: [],
      }
    }

    const cluster = this.#state.clusters[normalizedClusterId]
    if (!cluster.nodeIds.includes(sessionId)) {
      cluster.nodeIds.push(sessionId)
    }
  }

  async #membraneCreateSession(source, input = {}) {
    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : undefined
    if (!prompt) {
      throw new Error('create_session prompt is required')
    }

    if (input.agent && input.agent !== 'claude-code') {
      throw new Error(`Unsupported agent for P2 membrane: ${input.agent}`)
    }

    const sourceNode = this.#state.nodes.find((node) => node.sessionId === source)
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : sourceNode?.clusterId
    const envelope = this.#createEnvelope(source)
    const result = await this.createSession({
      agent: 'claude-code',
      prompt,
      context: input.context,
      cluster,
      label: input.label,
    })
    this.#addEdge({
      source,
      target: result.sessionId,
      kind: 'create-session',
      envelope,
      label: input.label ? `create: ${input.label}` : 'create_session',
      masterReason: this.#masterReasonFromInput(source, input),
    })
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { sessionId: result.sessionId }
  }

  async #membraneResumeSession(source, input = {}) {
    const target = input.sessionId
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new Error('resume_session sessionId is required')
    }

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('resume_session message is required')
    }

    const envelope = this.#createEnvelope(source)
    await this.resumeSession({
      sessionId: target,
      message,
      context: input.context,
    })

    this.#addEdge({
      source,
      target,
      kind: 'resume-session',
      envelope,
      label: 'resume_session',
      masterReason: this.#masterReasonFromInput(source, input),
    })
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    return { ok: true }
  }

  #membraneReport(source, input = {}) {
    const payload = this.#normalizeReportPayload(input)
    const envelope = this.#createEnvelope(source)
    const report = {
      id: randomUUID(),
      from: source,
      envelope,
      payload,
    }

    this.#state.reports.push(report)
    if (this.#state.reports.length > 250) {
      this.#state.reports.splice(0, this.#state.reports.length - 250)
    }

    if (
      payload.type === 'relationship' &&
      typeof payload.sessionRef === 'string' &&
      this.#state.sessions[payload.sessionRef]
    ) {
      this.#addEdge({
        source,
        target: payload.sessionRef,
        kind: 'report',
        envelope,
        label: payload.nature ?? 'relationship',
        reportId: report.id,
        summary: payload.target,
      })
    }

    this.#touch()
    this.#broadcast({
      type: 'report.received',
      from: source,
      report,
      state: this.getState(),
    })
    return { ok: true }
  }

  #createEnvelope(source) {
    return {
      callId: randomUUID(),
      source,
      ts: now(),
    }
  }

  #addEdge({
    source,
    target,
    kind,
    envelope,
    label,
    reportId,
    verdict,
    issueCount,
    summary,
    masterReason,
    frozen,
    freezeReason,
  }) {
    if (!this.#state.sessions[source]) {
      throw new Error(`Unknown edge source session: ${source}`)
    }

    if (!this.#state.sessions[target]) {
      throw new Error(`Unknown edge target session: ${target}`)
    }

    this.#state.edges.push({
      edgeId: `${kind}:${envelope.callId}`,
      source,
      target,
      kind,
      call: envelope,
      label,
      ts: envelope.ts,
      reportId,
      verdict,
      issueCount,
      summary,
      masterReason,
      frozen,
      freezeReason,
    })
  }

  #masterReasonFromInput(source, input) {
    if (this.#state.sessions[source]?.role !== 'master') {
      return undefined
    }

    const reason = input?.masterReason ?? input?.reason
    return typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : undefined
  }

  #normalizeReportPayload(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('report payload is required')
    }

    if (input.type === 'verdict') {
      if (typeof input.verdict !== 'string' || input.verdict.trim().length === 0) {
        throw new Error('report verdict is required')
      }

      let issues
      if (input.issues !== undefined) {
        if (!Array.isArray(input.issues)) {
          throw new Error('verdict report issues must be an array')
        }

        issues = input.issues.map((issue, index) => {
          if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
            throw new Error(`verdict issue ${index} must be an object`)
          }

          if (
            typeof issue.message !== 'string' ||
            issue.message.trim().length === 0
          ) {
            throw new Error(`verdict issue ${index} message is required`)
          }

          if (issue.file !== undefined && typeof issue.file !== 'string') {
            throw new Error(`verdict issue ${index} file must be a string`)
          }

          if (
            issue.line !== undefined &&
            (typeof issue.line !== 'number' || !Number.isFinite(issue.line))
          ) {
            throw new Error(`verdict issue ${index} line must be a finite number`)
          }

          if (
            issue.severity !== undefined &&
            !['info', 'warn', 'error'].includes(issue.severity)
          ) {
            throw new Error(
              `verdict issue ${index} severity must be info, warn, or error`
            )
          }

          return {
            message: issue.message.trim(),
            file: issue.file,
            line: issue.line,
            severity: issue.severity,
          }
        })
      }

      if (input.summary !== undefined && typeof input.summary !== 'string') {
        throw new Error('verdict report summary must be a string')
      }

      return {
        type: 'verdict',
        verdict: input.verdict.trim(),
        issues,
        summary: input.summary,
      }
    }

    if (input.type === 'relationship') {
      if (typeof input.target !== 'string' || input.target.trim().length === 0) {
        throw new Error('relationship report target is required')
      }

      return {
        type: 'relationship',
        target: input.target.trim(),
        nature: this.#optionalString(input.nature, 'relationship nature'),
        sessionRef: this.#optionalString(
          input.sessionRef,
          'relationship sessionRef'
        ),
      }
    }

    if (input.type === 'info') {
      if (!Object.hasOwn(input, 'payload')) {
        throw new Error('info report payload is required')
      }

      return {
        type: 'info',
        payload: input.payload,
      }
    }

    throw new Error(`Unknown report type: ${input.type}`)
  }

  #optionalString(value, label) {
    if (value === undefined) {
      return undefined
    }

    if (typeof value !== 'string') {
      throw new Error(`${label} must be a string`)
    }

    return value
  }

  #touch() {
    this.#state.updatedAt = now()
    this.#persistState()
  }

  #broadcast(event) {
    if (!BrowserWindow) {
      return
    }

    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('orrery:runtime-event', event)
    }
  }

  #persistState() {
    if (!this.#storageFile) {
      return
    }

    writeJsonAtomically(this.#storageFile, this.#state)
  }

  #loadState() {
    if (!this.#storageFile || !fs.existsSync(this.#storageFile)) {
      return createEmptyGraphState()
    }

    const primary = readJsonFile(this.#storageFile)
    if (primary.ok) {
      return this.#normalizeState(primary.value)
    }

    const diagnostics = [
      diagnostic(
        'storage.primary_parse_failed',
        'Primary Orrery runtime state could not be parsed.',
        {
          storageFile: this.#storageFile,
          error: primary.error.message,
          preservedFile: preserveCorruptFile(this.#storageFile),
        }
      ),
    ]

    const backupFile = backupFileFor(this.#storageFile)
    if (fs.existsSync(backupFile)) {
      const backup = readJsonFile(backupFile)
      if (backup.ok) {
        diagnostics.push(
          diagnostic(
            'storage.recovered_from_backup',
            'Recovered Orrery runtime state from the last valid backup.',
            { backupFile }
          )
        )
        return this.#normalizeState(backup.value, diagnostics)
      }

      diagnostics.push(
        diagnostic(
          'storage.backup_parse_failed',
          'Backup Orrery runtime state could not be parsed.',
          { backupFile, error: backup.error.message }
        )
      )
    }

    console.error(
      `Failed to load Orrery runtime state: ${primary.error.message}; starting with an empty recoverable state.`
    )
    return this.#withDiagnostics(createEmptyGraphState(), diagnostics)
  }

  #normalizeState(value, diagnostics = []) {
    const fallback = createEmptyGraphState()
    const source = isObject(value) ? value : {}
    const state = {
      ...fallback,
      ...source,
      version: graphStateVersion,
      updatedAt: nonEmptyString(source.updatedAt) ? source.updatedAt : fallback.updatedAt,
      nodes: [],
      edges: Array.isArray(source.edges)
        ? source.edges.map((edge) => this.#normalizeEdge(edge))
        : [],
      sessions: {},
      clusters: isObject(source.clusters) ? this.#normalizeClusters(source.clusters) : {},
      reports: Array.isArray(source.reports)
        ? source.reports.map((report) => this.#normalizeReport(report))
        : [],
    }

    const sourceSessions = isObject(source.sessions) ? source.sessions : {}
    for (const [storageKey, sessionValue] of Object.entries(sourceSessions)) {
      if (!isObject(sessionValue)) {
        diagnostics.push(
          diagnostic('storage.session_skipped', 'Skipped an invalid session record.', {
            storageKey,
          })
        )
        continue
      }
      const session = this.#normalizeSession(storageKey, sessionValue, diagnostics)
      state.sessions[session.sessionId] = session
    }

    const seenNodeSessionIds = new Set()
    const sourceNodes = Array.isArray(source.nodes) ? source.nodes : []
    for (const nodeValue of sourceNodes) {
      if (!isObject(nodeValue)) {
        diagnostics.push(
          diagnostic('storage.node_skipped', 'Skipped an invalid graph node record.')
        )
        continue
      }

      const nodeSessionId = this.#nodeSessionId(nodeValue)
      if (!nodeSessionId || seenNodeSessionIds.has(nodeSessionId)) {
        diagnostics.push(
          diagnostic('storage.node_skipped', 'Skipped a duplicate or unidentified graph node.', {
            nodeId: nodeValue.nodeId,
            sessionId: nodeValue.sessionId,
          })
        )
        continue
      }

      if (!state.sessions[nodeSessionId]) {
        diagnostics.push(
          diagnostic(
            'storage.placeholder_session_created',
            'Created a failed placeholder session for a graph node without a session record.',
            { sessionId: nodeSessionId }
          )
        )
        state.sessions[nodeSessionId] = this.#placeholderSessionFromNode(
          nodeSessionId,
          nodeValue
        )
      }

      const session = state.sessions[nodeSessionId]
      state.nodes.push(this.#normalizeNode(nodeValue, session, diagnostics))
      seenNodeSessionIds.add(nodeSessionId)
    }

    for (const session of Object.values(state.sessions)) {
      if (seenNodeSessionIds.has(session.sessionId)) {
        continue
      }

      diagnostics.push(
        diagnostic(
          'storage.node_created',
          'Created a graph node for a session without a node record.',
          { sessionId: session.sessionId }
        )
      )
      state.nodes.push(this.#nodeFromSession(session))
    }

    return this.#withDiagnostics(state, diagnostics)
  }

  #withDiagnostics(state, diagnostics) {
    if (diagnostics.length === 0) {
      return state
    }

    return {
      ...state,
      diagnostics: [
        ...(Array.isArray(state.diagnostics) ? state.diagnostics : []),
        ...diagnostics,
      ].slice(-50),
    }
  }

  #normalizeSession(storageKey, value, diagnostics) {
    const sessionId = nonEmptyString(value.sessionId)
      ? value.sessionId
      : nonEmptyString(storageKey)
        ? storageKey
        : randomUUID()
    const ts = now()
    const status = this.#normalizeSessionStatus(sessionId, value, diagnostics)
    const session = {
      ...value,
      sessionId,
      nodeId: sessionId,
      backend: nonEmptyString(value.backend) ? value.backend : 'claude-cli',
      backendSessionId: nonEmptyString(value.backendSessionId)
        ? value.backendSessionId
        : sessionId,
      agent: nonEmptyString(value.agent) ? value.agent : 'claude-code',
      label: nonEmptyString(value.label) ? value.label : `Claude ${sessionId.slice(0, 8)}`,
      prompt: typeof value.prompt === 'string' ? value.prompt : '',
      cwd: safeCwd(value.cwd),
      role: value.role === 'master' ? 'master' : 'worker',
      status,
      createdAt: nonEmptyString(value.createdAt) ? value.createdAt : ts,
      updatedAt: nonEmptyString(value.updatedAt) ? value.updatedAt : ts,
      chunks: Array.isArray(value.chunks)
        ? value.chunks.map((chunk) => this.#normalizeChunk(sessionId, chunk))
        : [],
      messages: Array.isArray(value.messages)
        ? value.messages.map((message) =>
            this.#normalizeMessage(sessionId, message, status, diagnostics)
          )
        : this.#messagesFromLegacySession({ ...value, sessionId }),
    }

    if (value.nodeId !== sessionId) {
      diagnostics.push(
        diagnostic(
          'storage.session_identity_repaired',
          'Repaired a session whose nodeId did not match sessionId.',
          { sessionId, previousNodeId: value.nodeId }
        )
      )
    }

    return session
  }

  #normalizeSessionStatus(sessionId, session, diagnostics) {
    if (recoverableActiveStatuses.has(session.status)) {
      diagnostics.push(
        diagnostic(
          'runtime.active_session_recovered',
          'Recovered a session that was active when the previous runtime stopped.',
          { sessionId, previousStatus: session.status }
        )
      )
      session.error =
        session.error ??
        `Interrupted by runtime restart while ${session.status}; review the last messages and resume when ready.`
      session.finishedAt = session.finishedAt ?? now()
      return 'failed'
    }

    if (session.status === 'finished') {
      diagnostics.push(
        diagnostic(
          'storage.legacy_status_migrated',
          'Migrated legacy finished status to idle.',
          { sessionId }
        )
      )
      return 'idle'
    }

    if (validSessionStatuses.has(session.status)) {
      return session.status
    }

    diagnostics.push(
      diagnostic(
        'storage.invalid_status_repaired',
        'Repaired a session with an unknown status.',
        { sessionId, previousStatus: session.status }
      )
    )
    session.error =
      session.error ?? `Recovered unknown persisted status: ${String(session.status)}`
    return 'failed'
  }

  #normalizeChunk(sessionId, value) {
    if (!isObject(value)) {
      return {
        id: randomUUID(),
        sessionId,
        ts: now(),
        stream: 'stderr',
        raw: String(value ?? ''),
      }
    }

    return {
      ...value,
      id: nonEmptyString(value.id) ? value.id : randomUUID(),
      sessionId,
      ts: nonEmptyString(value.ts) ? value.ts : now(),
      stream: value.stream === 'stderr' ? 'stderr' : 'stdout',
      raw: typeof value.raw === 'string' ? value.raw : '',
    }
  }

  #normalizeMessage(sessionId, value, sessionStatus, diagnostics) {
    const message = isObject(value) ? value : { content: String(value ?? '') }
    const status = validMessageStatuses.has(message.status)
      ? message.status
      : message.status === undefined
        ? undefined
        : 'failed'
    const normalized = {
      ...message,
      id: nonEmptyString(message.id) ? message.id : randomUUID(),
      sessionId,
      role:
        message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
      content: typeof message.content === 'string' ? message.content : '',
      ts: nonEmptyString(message.ts) ? message.ts : now(),
      status,
    }

    if (message.status === 'streaming' && sessionStatus === 'failed') {
      normalized.status = 'failed'
      diagnostics.push(
        diagnostic(
          'runtime.streaming_message_recovered',
          'Marked an interrupted streaming assistant message as failed.',
          { sessionId, messageId: normalized.id }
        )
      )
    }

    return normalized
  }

  #nodeSessionId(node) {
    if (nonEmptyString(node.sessionId)) {
      return node.sessionId
    }
    if (nonEmptyString(node.nodeId)) {
      return node.nodeId
    }
    return undefined
  }

  #normalizeNode(node, session, diagnostics) {
    if (node.nodeId !== session.sessionId || node.sessionId !== session.sessionId) {
      diagnostics.push(
        diagnostic(
          'storage.node_identity_repaired',
          'Repaired a graph node so nodeId equals sessionId.',
          {
            sessionId: session.sessionId,
            previousNodeId: node.nodeId,
            previousSessionId: node.sessionId,
          }
        )
      )
    }

    return {
      ...node,
      nodeId: session.sessionId,
      sessionId: session.sessionId,
      label: nonEmptyString(node.label) ? node.label : session.label,
      role: session.role,
      agent: nonEmptyString(node.agent) ? node.agent : session.agent,
      status: session.status,
      position: isObject(node.position)
        ? {
            x: Number.isFinite(node.position.x) ? node.position.x : 96,
            y: Number.isFinite(node.position.y) ? node.position.y : 96,
          }
        : { x: 96, y: 96 },
      frozen: node.frozen === true,
      freezeReason: nonEmptyString(node.freezeReason) ? node.freezeReason : undefined,
      masterReason: nonEmptyString(node.masterReason) ? node.masterReason : undefined,
    }
  }

  #nodeFromSession(session) {
    return {
      nodeId: session.sessionId,
      sessionId: session.sessionId,
      label: session.label,
      role: session.role,
      agent: session.agent,
      status: session.status,
      position: {
        x: 96,
        y: 96,
      },
      frozen: false,
    }
  }

  #placeholderSessionFromNode(sessionId, node) {
    const ts = now()
    return {
      sessionId,
      nodeId: sessionId,
      backend: 'claude-cli',
      backendSessionId: sessionId,
      agent: nonEmptyString(node.agent) ? node.agent : 'claude-code',
      label: nonEmptyString(node.label) ? node.label : `Recovered ${sessionId.slice(0, 8)}`,
      prompt: '',
      cwd: process.cwd(),
      role: node.role === 'master' ? 'master' : 'worker',
      status: 'failed',
      createdAt: ts,
      updatedAt: ts,
      finishedAt: ts,
      error: 'Recovered graph node without a persisted session record.',
      chunks: [],
      messages: [],
    }
  }

  #normalizeEdge(value) {
    if (!isObject(value)) {
      return {
        edgeId: randomUUID(),
        source: '',
        target: '',
        kind: 'create-session',
        ts: now(),
      }
    }

    const kind = validGraphEdgeKinds.has(value.kind) ? value.kind : 'create-session'

    return {
      ...value,
      edgeId: nonEmptyString(value.edgeId) ? value.edgeId : randomUUID(),
      source: nonEmptyString(value.source) ? value.source : '',
      target: nonEmptyString(value.target) ? value.target : '',
      kind,
      ts: nonEmptyString(value.ts) ? value.ts : now(),
      reportId: nonEmptyString(value.reportId) ? value.reportId : undefined,
      verdict: nonEmptyString(value.verdict) ? value.verdict : undefined,
      issueCount: Number.isFinite(value.issueCount) ? value.issueCount : undefined,
      summary: nonEmptyString(value.summary) ? value.summary : undefined,
      masterReason: nonEmptyString(value.masterReason)
        ? value.masterReason
        : nonEmptyString(value.reason)
          ? value.reason
          : undefined,
      frozen: value.frozen === true,
      freezeReason: nonEmptyString(value.freezeReason)
        ? value.freezeReason
        : undefined,
    }
  }

  #normalizeReport(value) {
    if (!isObject(value)) {
      return {
        id: randomUUID(),
        from: '',
        payload: { type: 'info', payload: value },
      }
    }

    return {
      ...value,
      id: nonEmptyString(value.id) ? value.id : randomUUID(),
    }
  }

  #normalizeClusters(clusters) {
    return Object.fromEntries(
      Object.entries(clusters)
        .filter(([, cluster]) => isObject(cluster))
        .map(([clusterId, cluster]) => [
          clusterId,
          {
            ...cluster,
            clusterId: nonEmptyString(cluster.clusterId) ? cluster.clusterId : clusterId,
            label: nonEmptyString(cluster.label) ? cluster.label : clusterId,
            nodeIds: Array.isArray(cluster.nodeIds)
              ? cluster.nodeIds.filter(nonEmptyString)
              : [],
            frozen: cluster.frozen === true,
            freezeReason: nonEmptyString(cluster.freezeReason)
              ? cluster.freezeReason
              : undefined,
          },
        ])
    )
  }

  #messagesFromLegacySession(session) {
    const messages = []
    if (typeof session.prompt === 'string' && session.prompt.length > 0) {
      messages.push({
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'user',
        content: session.prompt,
        ts: session.createdAt ?? now(),
        status: 'complete',
      })
    }
    if (typeof session.result === 'string' && session.result.length > 0) {
      messages.push({
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'assistant',
        content: session.result,
        ts: session.finishedAt ?? session.updatedAt ?? now(),
        status: 'complete',
      })
    }
    return messages
  }
}
