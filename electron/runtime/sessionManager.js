import electron from 'electron'
import { execFileSync } from 'node:child_process'
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
const validLoopStatuses = new Set(['running', 'stopped'])

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

function boundedText(value, maxLength = 50000) {
  if (typeof value !== 'string') {
    return ''
  }

  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}\n\n[truncated by Orrery]`
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
  #loopTasks = new Map()
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
    this.#recoverRunningLoops()
  }

  getState() {
    return clone(this.#state)
  }

  async createSession(input = {}) {
    const sessionId = randomUUID()
    const role = input.role === 'master' ? 'master' : 'worker'
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : undefined
    if (cluster && this.#state.clusters[cluster]?.frozen) {
      throw new Error(`Frozen cluster cannot create new sessions: ${cluster}`)
    }

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
      role,
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
      role,
      agent: 'claude-code',
      clusterId: cluster,
      status: 'pending',
      position: {
        x: 96 + (this.#state.nodes.length % 4) * 280,
        y: 96 + Math.floor(this.#state.nodes.length / 4) * 180,
      },
    })
    if (cluster) {
      this.#ensureCluster(cluster)
      if (role !== 'master') {
        this.#addNodeToCluster(sessionId, cluster)
      }
    }
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

    if (this.#isSessionFrozen(sessionId)) {
      throw new Error(`Frozen session cannot be resumed: ${sessionId}`)
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
      this.#emitRuntimeEvent({
        type: 'session.killed',
        sessionId,
        state: this.getState(),
      })
    }

    return { ok, state: this.getState() }
  }

  killAll() {
    for (const sessionId of this.#runs.keys()) {
      this.killSession(sessionId)
    }
    this.#bridge?.close()
  }

  upsertCluster(input = {}) {
    const nodeIds = this.#normalizeClusterNodeIds(input.nodeIds)
    if (nodeIds.length === 0) {
      throw new Error('Cluster requires at least one managed session node')
    }

    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : `cluster-${randomUUID().slice(0, 8)}`
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : clusterId
    const existing = this.#state.clusters[clusterId]

    this.#state.clusters[clusterId] = {
      ...(existing ?? {}),
      clusterId,
      label,
      nodeIds,
      loopPolicy:
        input.loopPolicy !== undefined
          ? this.#normalizeLoopPolicy(input.loopPolicy)
          : existing?.loopPolicy,
    }

    const masterSessionId = this.#state.clusters[clusterId].masterSessionId
    for (const node of this.#state.nodes) {
      if (
        node.clusterId === clusterId &&
        !nodeIds.includes(node.sessionId) &&
        node.sessionId !== masterSessionId
      ) {
        node.clusterId = undefined
      }
      if (nodeIds.includes(node.sessionId)) {
        node.clusterId = clusterId
      }
      if (node.sessionId === masterSessionId) {
        node.clusterId = clusterId
      }
    }

    for (const sessionId of nodeIds) {
      this.#removeNodeFromOtherClusters(sessionId, clusterId)
    }

    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { clusterId, state: this.getState() }
  }

  async createMasterForCluster(input = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const cluster = this.#state.clusters[clusterId]
    if (input.loopPolicy !== undefined) {
      cluster.loopPolicy = this.#normalizeLoopPolicy(input.loopPolicy)
    }

    if (cluster.masterSessionId) {
      if (this.#state.sessions[cluster.masterSessionId]) {
        this.#assignMaster(clusterId, cluster.masterSessionId)
        this.#touch()
        this.#broadcast({ type: 'runtime.state', state: this.getState() })
        return { sessionId: cluster.masterSessionId, state: this.getState() }
      }

      delete cluster.masterSessionId
    }

    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : this.#defaultMasterPrompt(clusterId)
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `${cluster.label} Master`

    const result = await this.createSession({
      agent: 'claude-code',
      prompt,
      label,
      cluster: clusterId,
      role: 'master',
    })
    this.#assignMaster(clusterId, result.sessionId)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { sessionId: result.sessionId, state: this.getState() }
  }

  assignMasterToCluster(input = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined

    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }
    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    this.#assignMaster(clusterId, sessionId)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { state: this.getState() }
  }

  setClusterLoopPolicy(input = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    this.#state.clusters[clusterId].loopPolicy = this.#normalizeLoopPolicy(
      input.loopPolicy
    )
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { state: this.getState() }
  }

  startMasterLoop(input = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const cluster = this.#state.clusters[clusterId]
    if (cluster.frozen) {
      throw new Error(`Frozen cluster cannot run a loop: ${clusterId}`)
    }

    if (!cluster.loopPolicy) {
      throw new Error(`Cluster has no LoopPolicy: ${clusterId}`)
    }

    if (!cluster.masterSessionId || !this.#state.sessions[cluster.masterSessionId]) {
      throw new Error(`Cluster has no master session: ${clusterId}`)
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      throw new Error(`Cluster has no managed worker session: ${clusterId}`)
    }

    const ts = now()
    cluster.loopState = {
      ...(cluster.loopState ?? {}),
      status: 'running',
      iterations: 0,
      coderSessionId,
      reviewerSessionId: this.#loopReviewerSessionId(cluster, coderSessionId),
      lastEvent: { type: 'loop.started', ts },
      lastProcessedEventKey: undefined,
      reason:
        typeof input.reason === 'string' && input.reason.trim().length > 0
          ? input.reason.trim()
          : 'Loop started by user.',
      startedAt: ts,
      stoppedAt: undefined,
    }

    this.#touch()
    this.#broadcast({
      type: 'loop.started',
      clusterId,
      state: this.getState(),
    })
    this.#queueLoopWakeup(clusterId, { type: 'loop.started', ts })
    return { state: this.getState() }
  }

  stopMasterLoop(input = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Loop stopped by user.'
    this.#stopLoop(clusterId, reason, {
      event: { type: 'loop.stopped', ts: now() },
      broadcast: true,
    })

    if (input.killRunning === true) {
      const cluster = this.#state.clusters[clusterId]
      const runningIds = [
        ...cluster.nodeIds,
        cluster.masterSessionId,
      ].filter((sessionId) => this.#runs.has(sessionId))
      for (const sessionId of runningIds) {
        this.killSession(sessionId)
      }
    }

    return { state: this.getState() }
  }

  freeze(input = {}) {
    const target =
      typeof input.target === 'string' && input.target.trim().length > 0
        ? input.target.trim()
        : typeof input.targetId === 'string' && input.targetId.trim().length > 0
          ? input.targetId.trim()
          : undefined
    if (!target) {
      throw new Error('freeze target is required')
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Frozen by user.'
    return this.#applyFreeze({
      targetId: target,
      reason,
      source: input.source,
      masterReason: input.masterReason,
    })
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
        this.#emitRuntimeEvent({
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
        this.#emitRuntimeEvent({
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
    this.#emitRuntimeEvent({
      type: 'session.failed',
      sessionId,
      error,
      state: this.getState(),
    })
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

  #ensureCluster(clusterId) {
    if (!this.#state.clusters[clusterId]) {
      this.#state.clusters[clusterId] = {
        clusterId,
        label: clusterId,
        nodeIds: [],
      }
    }

    return this.#state.clusters[clusterId]
  }

  #addNodeToCluster(sessionId, clusterId) {
    if (typeof clusterId !== 'string' || clusterId.trim().length === 0) {
      return
    }

    const normalizedClusterId = clusterId.trim()
    const cluster = this.#ensureCluster(normalizedClusterId)
    if (!cluster.nodeIds.includes(sessionId)) {
      cluster.nodeIds.push(sessionId)
    }
  }

  #removeNodeFromOtherClusters(sessionId, clusterId) {
    for (const [candidateId, cluster] of Object.entries(this.#state.clusters)) {
      if (candidateId === clusterId) {
        continue
      }
      cluster.nodeIds = cluster.nodeIds.filter((nodeId) => nodeId !== sessionId)
    }
  }

  #masterClusterId(sessionId) {
    return Object.values(this.#state.clusters).find(
      (cluster) => cluster.masterSessionId === sessionId
    )?.clusterId
  }

  #managedClusterId(sessionId) {
    return Object.values(this.#state.clusters).find((cluster) =>
      cluster.nodeIds.includes(sessionId)
    )?.clusterId
  }

  #managingMasterSessionId(sessionId) {
    const clusterId = this.#managedClusterId(sessionId)
    if (!clusterId) {
      return undefined
    }

    const masterSessionId = this.#state.clusters[clusterId]?.masterSessionId
    return masterSessionId && this.#state.sessions[masterSessionId]
      ? masterSessionId
      : undefined
  }

  #isSessionFrozen(sessionId) {
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    const clusterId = this.#managedClusterId(sessionId) ?? this.#masterClusterId(sessionId)
    return node?.frozen === true || this.#state.clusters[clusterId]?.frozen === true
  }

  #reportSummary(payload) {
    if (payload.type === 'verdict') {
      if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
        return payload.summary.trim()
      }

      if (Array.isArray(payload.issues) && payload.issues.length > 0) {
        return payload.issues
          .map((issue) =>
            issue.file ? `${issue.message} (${issue.file})` : issue.message
          )
          .join('\n')
      }

      return payload.verdict
    }

    if (payload.type === 'relationship') {
      return payload.nature ?? payload.target
    }

    try {
      return boundedText(JSON.stringify(payload.payload), 500)
    } catch {
      return 'info'
    }
  }

  #syncSessionRoleAndCluster(sessionId) {
    const session = this.#state.sessions[sessionId]
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    if (!session || !node) {
      return
    }

    const masterClusterId = this.#masterClusterId(sessionId)
    if (masterClusterId) {
      session.role = 'master'
      node.role = 'master'
      node.clusterId = masterClusterId
      session.updatedAt = now()
      return
    }

    session.role = 'worker'
    node.role = 'worker'
    node.clusterId = this.#managedClusterId(sessionId)
    session.updatedAt = now()
  }

  #normalizeClusterNodeIds(nodeIds) {
    if (!Array.isArray(nodeIds)) {
      return []
    }

    const seen = new Set()
    const normalized = []
    for (const nodeId of nodeIds) {
      if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
        continue
      }

      const sessionId = nodeId.trim()
      if (seen.has(sessionId)) {
        continue
      }

      const session = this.#state.sessions[sessionId]
      if (!session || session.role === 'master') {
        continue
      }

      seen.add(sessionId)
      normalized.push(sessionId)
    }

    return normalized
  }

  #assignMaster(clusterId, sessionId) {
    const cluster = this.#ensureCluster(clusterId)
    const session = this.#state.sessions[sessionId]
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)

    if (!session || !node) {
      throw new Error(`Unknown master session: ${sessionId}`)
    }

    const staleMasterIds = new Set()
    if (cluster.masterSessionId && cluster.masterSessionId !== sessionId) {
      staleMasterIds.add(cluster.masterSessionId)
    }

    for (const [candidateClusterId, candidateCluster] of Object.entries(
      this.#state.clusters
    )) {
      candidateCluster.nodeIds = candidateCluster.nodeIds.filter(
        (nodeId) => nodeId !== sessionId
      )

      if (
        candidateClusterId !== clusterId &&
        candidateCluster.masterSessionId === sessionId
      ) {
        delete candidateCluster.masterSessionId
      }
    }

    for (const candidateNode of this.#state.nodes) {
      if (
        candidateNode.clusterId === clusterId &&
        candidateNode.role === 'master' &&
        candidateNode.sessionId !== sessionId
      ) {
        staleMasterIds.add(candidateNode.sessionId)
      }
    }

    cluster.masterSessionId = sessionId
    cluster.nodeIds = cluster.nodeIds.filter((nodeId) => nodeId !== sessionId)
    session.role = 'master'
    session.updatedAt = now()
    node.role = 'master'
    node.clusterId = clusterId

    for (const staleMasterId of staleMasterIds) {
      this.#syncSessionRoleAndCluster(staleMasterId)
    }
  }

  #normalizeLoopPolicy(policy) {
    if (!isObject(policy)) {
      throw new Error('LoopPolicy must be an object')
    }

    if (policy.onStop !== 'freeze') {
      throw new Error('LoopPolicy onStop must be freeze')
    }

    let until
    const verdict = policy.until?.whenReport?.verdict
    if (typeof verdict === 'string' && verdict.trim().length > 0) {
      until = { whenReport: { verdict: verdict.trim() } }
    }

    let maxIterations
    if (policy.maxIterations !== undefined) {
      const value = Number(policy.maxIterations)
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error('LoopPolicy maxIterations must be an integer from 1 to 100')
      }
      maxIterations = value
    }

    return {
      ...(until ? { until } : {}),
      onStop: 'freeze',
      ...(maxIterations ? { maxIterations } : {}),
    }
  }

  #normalizeLoopState(loopState) {
    if (!isObject(loopState)) {
      return undefined
    }

    return {
      status: validLoopStatuses.has(loopState.status)
        ? loopState.status
        : 'stopped',
      iterations: Number.isInteger(loopState.iterations)
        ? Math.max(0, loopState.iterations)
        : 0,
      coderSessionId: nonEmptyString(loopState.coderSessionId)
        ? loopState.coderSessionId
        : undefined,
      reviewerSessionId: nonEmptyString(loopState.reviewerSessionId)
        ? loopState.reviewerSessionId
        : undefined,
      lastEvent: isObject(loopState.lastEvent)
        ? this.#serializeLoopEvent(loopState.lastEvent)
        : undefined,
      lastProcessedEventKey: nonEmptyString(loopState.lastProcessedEventKey)
        ? loopState.lastProcessedEventKey
        : undefined,
      reason: nonEmptyString(loopState.reason) ? loopState.reason : undefined,
      startedAt: nonEmptyString(loopState.startedAt)
        ? loopState.startedAt
        : undefined,
      stoppedAt: nonEmptyString(loopState.stoppedAt)
        ? loopState.stoppedAt
        : undefined,
    }
  }

  #defaultMasterPrompt(clusterId) {
    const cluster = this.#state.clusters[clusterId]
    const policy = cluster.loopPolicy
    const until = policy?.until?.whenReport?.verdict
      ? `until a report verdict is "${policy.until.whenReport.verdict}"`
      : 'until the authored stop condition is met'
    const maxIterations = policy?.maxIterations
      ? `Respect maxIterations=${policy.maxIterations}.`
      : 'Ask before continuing if the loop looks unbounded.'

    return [
      `You are the Orrery master session for cluster ${cluster.label}.`,
      'Read the graph as a blackboard and coordinate only the sessions in your cluster scope.',
      `The current LoopPolicy is: ${until}; onStop=freeze. ${maxIterations}`,
      'Do not execute an autonomous loop yet. Discuss the plan with the user and use Orrery membrane tools when asked to create, resume, or report agent work.',
    ].join('\n')
  }

  #recoverRunningLoops() {
    for (const cluster of Object.values(this.#state.clusters)) {
      if (cluster.loopState?.status === 'running' && !cluster.frozen) {
        this.#queueLoopWakeup(cluster.clusterId, {
          type: 'runtime.recovered',
          ts: now(),
        })
      }
    }
  }

  #emitRuntimeEvent(event) {
    this.#broadcast(event)
    this.#queueLoopWakeupsForRuntimeEvent(event)
  }

  #queueLoopWakeupsForRuntimeEvent(event) {
    const clusterIds = this.#clusterIdsForRuntimeEvent(event)
    for (const clusterId of clusterIds) {
      this.#queueLoopWakeup(clusterId, this.#loopEventFromRuntimeEvent(event))
    }
  }

  #clusterIdsForRuntimeEvent(event) {
    if (
      event.type === 'session.finished' ||
      event.type === 'session.failed' ||
      event.type === 'session.killed'
    ) {
      const clusterId =
        this.#managedClusterId(event.sessionId) ??
        (event.type === 'session.failed' || event.type === 'session.killed'
          ? this.#masterClusterId(event.sessionId)
          : undefined)
      return clusterId ? [clusterId] : []
    }

    if (event.type === 'report.received') {
      const clusterId = this.#managedClusterId(event.from)
      return clusterId ? [clusterId] : []
    }

    return []
  }

  #loopEventFromRuntimeEvent(event) {
    if (event.type === 'report.received') {
      return {
        type: event.type,
        ts: event.report.envelope.ts,
        from: event.from,
        reportId: event.report.id,
        report: event.report,
      }
    }

    return {
      type: event.type,
      ts: now(),
      sessionId: event.sessionId,
      error: event.error,
    }
  }

  #queueLoopWakeup(clusterId, event) {
    const previous = this.#loopTasks.get(clusterId) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() => this.#runLoopWakeup(clusterId, event))
      .catch((error) => this.#recordLoopError(clusterId, event, error))

    this.#loopTasks.set(clusterId, task)
    void task.finally(() => {
      if (this.#loopTasks.get(clusterId) === task) {
        this.#loopTasks.delete(clusterId)
      }
    })
  }

  async #runLoopWakeup(clusterId, event) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }

    const loopState = this.#ensureLoopState(cluster)
    if (loopState.status !== 'running') {
      return
    }

    const eventKey = this.#loopEventKey(event)
    if (eventKey && loopState.lastProcessedEventKey === eventKey) {
      return
    }

    loopState.lastEvent = this.#serializeLoopEvent(event)
    loopState.lastProcessedEventKey = eventKey
    loopState.reason = `Woke on ${event.type}.`
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    if (cluster.frozen) {
      this.#stopLoop(clusterId, 'Cluster is frozen; loop stopped.', {
        event,
        broadcast: true,
      })
      return
    }

    if (!cluster.loopPolicy) {
      this.#stopLoop(clusterId, 'Cluster has no LoopPolicy.', {
        event,
        broadcast: true,
      })
      return
    }

    const masterSessionId = cluster.masterSessionId
    const masterSession = masterSessionId
      ? this.#state.sessions[masterSessionId]
      : undefined
    if (!masterSessionId || !masterSession) {
      this.#stopLoop(clusterId, 'Cluster has no master session.', {
        event,
        broadcast: true,
      })
      return
    }

    if (
      masterSession.status === 'killed' ||
      masterSession.status === 'failed' ||
      this.#isSessionFrozen(masterSessionId)
    ) {
      this.#stopLoop(
        clusterId,
        `Master session cannot continue: ${masterSession.status}.`,
        { event, broadcast: true }
      )
      return
    }

    if (event.type === 'session.failed' || event.type === 'session.killed') {
      const killed = event.type === 'session.killed'
      this.#stopLoop(
        clusterId,
        killed
          ? 'Managed session was killed; loop stopped.'
          : event.error
            ? `Managed session failed: ${event.error}`
            : 'Managed session failed.',
        { event, broadcast: true }
      )
      return
    }

    if (event.type === 'report.received') {
      await this.#handleLoopReport(clusterId, event.report)
      return
    }

    if (
      event.type === 'session.finished' ||
      event.type === 'loop.started' ||
      event.type === 'runtime.recovered'
    ) {
      await this.#handleLoopSessionFinished(clusterId, event.sessionId)
    }
  }

  #recordLoopError(clusterId, event, error) {
    const message = error instanceof Error ? error.message : String(error)
    this.#stopLoop(clusterId, `Loop error: ${message}`, {
      event,
      broadcast: true,
    })
  }

  async #handleLoopSessionFinished(clusterId, finishedSessionId) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster || cluster.loopState?.status !== 'running') {
      return
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      this.#stopLoop(clusterId, 'Cluster has no coder session.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    const reviewerSessionId = this.#loopReviewerSessionId(cluster, coderSessionId)
    if (finishedSessionId && reviewerSessionId === finishedSessionId) {
      this.#setLoopReason(
        clusterId,
        'Reviewer finished; waiting for typed report.'
      )
      return
    }

    if (finishedSessionId && finishedSessionId !== coderSessionId) {
      this.#setLoopReason(clusterId, 'Finished session is outside the hero loop.')
      return
    }

    const coder = this.#state.sessions[coderSessionId]
    if (!coder) {
      this.#stopLoop(clusterId, 'Coder session is missing.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    if (coder.status === 'running' || coder.status === 'pending') {
      this.#setLoopReason(clusterId, 'Waiting for coder to finish.')
      return
    }

    if (
      coder.status === 'failed' ||
      coder.status === 'killed' ||
      this.#isSessionFrozen(coderSessionId)
    ) {
      this.#stopLoop(clusterId, 'Coder cannot be resumed by the loop.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    if (!reviewerSessionId) {
      await this.#createLoopReviewer(clusterId, coderSessionId)
      return
    }

    await this.#resumeLoopReviewer(clusterId, coderSessionId, reviewerSessionId)
  }

  async #handleLoopReport(clusterId, report) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster || cluster.loopState?.status !== 'running') {
      return
    }

    if (!report || report.payload?.type !== 'verdict') {
      this.#setLoopReason(clusterId, 'Report is not a verdict; loop is waiting.')
      return
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      this.#stopLoop(clusterId, 'Cluster has no coder session.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    if (report.from === coderSessionId) {
      this.#setLoopReason(clusterId, 'Coder report ignored for review loop.')
      return
    }

    cluster.loopState.reviewerSessionId =
      cluster.loopState.reviewerSessionId ?? report.from

    const stopVerdict = cluster.loopPolicy?.until?.whenReport?.verdict
    if (stopVerdict && report.payload.verdict === stopVerdict) {
      const reason = `Review verdict ${stopVerdict}; freezing loop scope.`
      this.#stopLoop(clusterId, reason, {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      this.#applyFreeze({
        targetId: clusterId,
        source: cluster.masterSessionId,
        reason,
        masterReason: reason,
      })
      return
    }

    const maxIterations = cluster.loopPolicy?.maxIterations
    const iterations = cluster.loopState.iterations ?? 0
    if (maxIterations && iterations >= maxIterations) {
      const reason = `maxIterations=${maxIterations} reached after verdict ${report.payload.verdict}.`
      this.#stopLoop(clusterId, reason, {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      this.#applyFreeze({
        targetId: clusterId,
        source: cluster.masterSessionId,
        reason,
        masterReason: reason,
      })
      return
    }

    await this.#resumeCoderFromReport(clusterId, coderSessionId, report)
  }

  async #createLoopReviewer(clusterId, coderSessionId) {
    const cluster = this.#state.clusters[clusterId]
    const masterSessionId = cluster?.masterSessionId
    if (!cluster || !masterSessionId) {
      return
    }

    const coder = this.#state.sessions[coderSessionId]
    const reason = `Coder ${coder?.label ?? coderSessionId} finished; create reviewer.`
    const result = await this.#membraneCreateSession(masterSessionId, {
      agent: 'claude-code',
      label: 'Reviewer',
      cluster: clusterId,
      prompt: this.#reviewerCreatePrompt(),
      context: this.#gitDiffForSession(coderSessionId),
      masterReason: reason,
    })

    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      reviewerSessionId: result.sessionId,
      reason,
    }
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  async #resumeLoopReviewer(clusterId, coderSessionId, reviewerSessionId) {
    const cluster = this.#state.clusters[clusterId]
    const masterSessionId = cluster?.masterSessionId
    const reviewer = this.#state.sessions[reviewerSessionId]
    if (!cluster || !masterSessionId || !reviewer) {
      return
    }

    if (reviewer.status === 'running' || reviewer.status === 'pending') {
      this.#setLoopReason(clusterId, 'Waiting for reviewer to finish.')
      return
    }

    if (
      reviewer.status === 'failed' ||
      reviewer.status === 'killed' ||
      this.#isSessionFrozen(reviewerSessionId)
    ) {
      this.#stopLoop(clusterId, 'Reviewer cannot be resumed by the loop.', {
        event: cluster.loopState?.lastEvent,
        broadcast: true,
      })
      return
    }

    const reason = `Coder finished fixes; resume reviewer ${reviewer.label}.`
    await this.#membraneResumeSession(masterSessionId, {
      sessionId: reviewerSessionId,
      message: this.#reviewerResumeMessage(),
      context: this.#gitDiffForSession(coderSessionId),
      masterReason: reason,
    })
    this.#setLoopReason(clusterId, reason)
  }

  async #resumeCoderFromReport(clusterId, coderSessionId, report) {
    const cluster = this.#state.clusters[clusterId]
    const masterSessionId = cluster?.masterSessionId
    const coder = this.#state.sessions[coderSessionId]
    if (!cluster || !masterSessionId || !coder) {
      return
    }

    if (coder.status === 'running' || coder.status === 'pending') {
      this.#setLoopReason(clusterId, 'Coder is already running; waiting.')
      return
    }

    if (
      coder.status === 'failed' ||
      coder.status === 'killed' ||
      this.#isSessionFrozen(coderSessionId)
    ) {
      this.#stopLoop(clusterId, 'Coder cannot be resumed by the loop.', {
        event: cluster.loopState?.lastEvent,
        broadcast: true,
      })
      return
    }

    const nextIteration = (cluster.loopState?.iterations ?? 0) + 1
    const reason = `Reviewer reported ${report.payload.verdict}; resume coder for iteration ${nextIteration}.`
    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      iterations: nextIteration,
      reason,
    }
    this.#touch()

    await this.#membraneResumeSession(masterSessionId, {
      sessionId: coderSessionId,
      message: this.#coderIssueMessage(report, nextIteration),
      masterReason: reason,
    })
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  #reviewerCreatePrompt() {
    return [
      'Review the latest diff for this Orrery hero review loop.',
      'Do not edit files.',
      'When finished, call mcp__orrery_membrane__report exactly once with type "verdict".',
      'Use verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain.',
    ].join('\n')
  }

  #reviewerResumeMessage() {
    return [
      'The coder has finished another turn.',
      'Review the latest diff again, preserving context from earlier findings.',
      'Call mcp__orrery_membrane__report exactly once with verdict "issues" or "clean".',
    ].join('\n')
  }

  #coderIssueMessage(report, iteration) {
    const issues = Array.isArray(report.payload.issues)
      ? report.payload.issues
      : []
    const issueText =
      issues.length > 0
        ? issues
            .map((issue) => {
              const location = [
                issue.file,
                Number.isFinite(issue.line) ? issue.line : undefined,
              ]
                .filter(Boolean)
                .join(':')
              return location
                ? `- ${issue.message} (${location})`
                : `- ${issue.message}`
            })
            .join('\n')
        : `- ${report.payload.summary ?? report.payload.verdict}`

    return [
      `Reviewer found issues for loop iteration ${iteration}.`,
      'Please fix them, then stop so the master loop can run the reviewer again.',
      '',
      issueText,
    ].join('\n')
  }

  #gitDiffForSession(sessionId) {
    const cwd = this.#state.sessions[sessionId]?.cwd ?? process.cwd()
    try {
      const stat = execFileSync('git', ['diff', '--stat'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }).trim()
      const diff = execFileSync('git', ['diff', '--'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
      }).trim()
      const content = [
        stat ? `Diff stat:\n${stat}` : undefined,
        diff ? `Patch:\n${diff}` : 'No current git diff.',
      ].filter(Boolean)

      return boundedText(content.join('\n\n'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Unable to read git diff for ${cwd}: ${message}`
    }
  }

  #loopCoderSessionId(cluster) {
    const existing = cluster.loopState?.coderSessionId
    if (existing && cluster.nodeIds.includes(existing) && this.#state.sessions[existing]) {
      return existing
    }

    return cluster.nodeIds.find((sessionId) => {
      const session = this.#state.sessions[sessionId]
      return session && session.role !== 'master'
    })
  }

  #loopReviewerSessionId(cluster, coderSessionId) {
    const existing = cluster.loopState?.reviewerSessionId
    if (
      existing &&
      existing !== coderSessionId &&
      cluster.nodeIds.includes(existing) &&
      this.#state.sessions[existing]
    ) {
      return existing
    }

    return cluster.nodeIds.find((sessionId) => {
      if (sessionId === coderSessionId) {
        return false
      }

      const session = this.#state.sessions[sessionId]
      return session && session.role !== 'master'
    })
  }

  #ensureLoopState(cluster) {
    const loopState = cluster.loopState ?? {}
    const iterations = Number.isInteger(loopState.iterations)
      ? Math.max(0, loopState.iterations)
      : 0
    cluster.loopState = {
      status: loopState.status === 'running' ? 'running' : 'stopped',
      iterations,
      coderSessionId: nonEmptyString(loopState.coderSessionId)
        ? loopState.coderSessionId
        : undefined,
      reviewerSessionId: nonEmptyString(loopState.reviewerSessionId)
        ? loopState.reviewerSessionId
        : undefined,
      lastEvent: isObject(loopState.lastEvent)
        ? this.#serializeLoopEvent(loopState.lastEvent)
        : undefined,
      lastProcessedEventKey: nonEmptyString(loopState.lastProcessedEventKey)
        ? loopState.lastProcessedEventKey
        : undefined,
      reason: nonEmptyString(loopState.reason) ? loopState.reason : undefined,
      startedAt: nonEmptyString(loopState.startedAt)
        ? loopState.startedAt
        : undefined,
      stoppedAt: nonEmptyString(loopState.stoppedAt)
        ? loopState.stoppedAt
        : undefined,
    }

    return cluster.loopState
  }

  #setLoopReason(clusterId, reason) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }

    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      reason,
    }
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  #stopLoop(clusterId, reason, { event, broadcast = false } = {}) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }

    const ts = now()
    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      status: 'stopped',
      reason,
      stoppedAt: ts,
      lastEvent: this.#serializeLoopEvent(event ?? { type: 'loop.stopped', ts }),
    }
    this.#touch()

    if (broadcast) {
      this.#broadcast({
        type: 'loop.stopped',
        clusterId,
        reason,
        state: this.getState(),
      })
    }
  }

  #applyFreeze({ targetId, reason, source, masterReason }) {
    const cluster = this.#state.clusters[targetId]
    const session = this.#state.sessions[targetId]
    const sourceSessionId =
      typeof source === 'string' && this.#state.sessions[source] ? source : undefined
    const finalReason = reason ?? masterReason ?? 'Frozen.'

    let targetSessionIds = []
    if (cluster) {
      cluster.frozen = true
      cluster.freezeReason = finalReason
      this.#stopLoop(cluster.clusterId, finalReason, {
        event: { type: 'freeze.applied', targetId, ts: now() },
      })
      targetSessionIds = [...cluster.nodeIds]
    } else if (session) {
      targetSessionIds = [session.sessionId]
      const clusterId =
        this.#managedClusterId(session.sessionId) ??
        this.#masterClusterId(session.sessionId)
      if (clusterId) {
        this.#stopLoop(clusterId, finalReason, {
          event: { type: 'freeze.applied', targetId, ts: now() },
        })
      }
    } else {
      throw new Error(`Unknown freeze target: ${targetId}`)
    }

    const envelope = sourceSessionId ? this.#createEnvelope(sourceSessionId) : undefined
    for (const targetSessionId of targetSessionIds) {
      const node = this.#state.nodes.find(
        (item) => item.sessionId === targetSessionId
      )
      if (node) {
        node.frozen = true
        node.freezeReason = finalReason
        node.masterReason =
          typeof masterReason === 'string' && masterReason.trim().length > 0
            ? masterReason.trim()
            : node.masterReason
      }

      if (envelope && this.#state.sessions[targetSessionId]) {
        this.#addEdge({
          source: sourceSessionId,
          target: targetSessionId,
          kind: 'freeze',
          envelope: { ...envelope, callId: randomUUID() },
          label: 'freeze',
          frozen: true,
          freezeReason: finalReason,
          masterReason,
        })
      }
    }

    this.#touch()
    this.#broadcast({
      type: 'freeze.applied',
      targetId,
      reason: finalReason,
      state: this.getState(),
    })
    return { ok: true, state: this.getState() }
  }

  #loopEventKey(event) {
    if (!event) {
      return undefined
    }

    if (event.type === 'report.received' && event.reportId) {
      return `${event.type}:${event.reportId}`
    }

    if (event.sessionId) {
      const session = this.#state.sessions[event.sessionId]
      return `${event.type}:${event.sessionId}:${
        session?.finishedAt ?? session?.updatedAt ?? event.ts ?? ''
      }`
    }

    return event.ts ? `${event.type}:${event.ts}` : undefined
  }

  #serializeLoopEvent(event) {
    if (!event || typeof event !== 'object') {
      return undefined
    }

    return {
      type: typeof event.type === 'string' ? event.type : 'unknown',
      ts: nonEmptyString(event.ts) ? event.ts : now(),
      sessionId: nonEmptyString(event.sessionId) ? event.sessionId : undefined,
      from: nonEmptyString(event.from) ? event.from : undefined,
      reportId: nonEmptyString(event.reportId) ? event.reportId : undefined,
      targetId: nonEmptyString(event.targetId) ? event.targetId : undefined,
      error: nonEmptyString(event.error) ? event.error : undefined,
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

    const masterSessionId = this.#managingMasterSessionId(source)
    if (masterSessionId && masterSessionId !== source) {
      this.#addEdge({
        source,
        target: masterSessionId,
        kind: 'report',
        envelope,
        label: payload.type,
        reportId: report.id,
        verdict: payload.type === 'verdict' ? payload.verdict : undefined,
        issueCount:
          payload.type === 'verdict' ? (payload.issues?.length ?? 0) : undefined,
        summary: this.#reportSummary(payload),
      })
    }

    this.#touch()
    this.#emitRuntimeEvent({
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

    const baseEdgeId = `${kind}:${envelope.callId}`
    const edgeId = this.#state.edges.some((edge) => edge.edgeId === baseEdgeId)
      ? `${baseEdgeId}:${randomUUID().slice(0, 8)}`
      : baseEdgeId

    this.#state.edges.push({
      edgeId,
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
        .map(([clusterId, cluster]) => {
          let loopPolicy
          try {
            loopPolicy = cluster.loopPolicy
              ? this.#normalizeLoopPolicy(cluster.loopPolicy)
              : undefined
          } catch {
            loopPolicy = undefined
          }

          const loopState = this.#normalizeLoopState(cluster.loopState)

          return [
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
              ...(nonEmptyString(cluster.masterSessionId)
                ? { masterSessionId: cluster.masterSessionId }
                : {}),
              ...(loopPolicy ? { loopPolicy } : {}),
              ...(loopState ? { loopState } : {}),
            },
          ]
        })
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
