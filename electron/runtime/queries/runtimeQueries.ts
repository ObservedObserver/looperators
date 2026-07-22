import {
  loopsOf,
  loopTimelineOf,
} from '../../../shared/graph-core/index.js'
import type {
  GraphEvent,
  KernelState,
} from '../../../shared/graph-core/index.js'
import { projectRuntimeUsage } from '../../../shared/resource-governance.js'
import { projectSession } from '../../../shared/session-projection.js'
import {
  gitProjectContext,
  projectNameFromCwd,
  safeCwd,
} from '../workspace/gitWorkspace.js'
import {
  clone,
  isObject,
  optionalTrimmedString,
  type JsonRecord,
} from '../runtimeCommon.js'

export type RuntimeQueriesHost = {
  liveState: () => JsonRecord
  readState: () => JsonRecord
  listKernelEvents: (input: JsonRecord) => JsonRecord[]
  latestKernelSeq: () => number
}

// Read-only runtime projections. The only mutable member is a derived terminal
// fact cache; durable state and the kernel log remain owned by the control plane.
export class RuntimeQueries {
  #host: RuntimeQueriesHost
  #loopTerminalFacts = new Map<string, JsonRecord>()

  constructor(host: RuntimeQueriesHost) {
    this.#host = host
  }

  clearLoopTerminalFacts() {
    this.#loopTerminalFacts.clear()
  }

  getState() {
    const source = this.#host.readState()
    const state = clone(source)
    // Transport secrets persist in the runtime snapshot but never leave via a
    // read API or state broadcast.
    delete state.sourceTokens
    state.loops = this.loopViewsWithTerminalFacts(this.kernelView(source))
    const sessionToLoopIds = Object.fromEntries(
      Object.keys(state.sessions).map((sessionId) => [
        sessionId,
        state.loops
          .filter((loop) => loop.memberSessionIds?.includes(sessionId))
          .map((loop) => loop.loopId),
      ]),
    )
    state.usage = projectRuntimeUsage(state.usageFacts ?? [], {
      sessionToLoopIds,
    })
    return state
  }

  getKernelEvents(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    return {
      events: this.#host.listKernelEvents({
        sinceSeq: Number(request.since ?? request.sinceSeq ?? 0) || 0,
        limit: Number(request.limit ?? 0) || undefined,
        type: optionalTrimmedString(request.type),
        tail: request.tail === true || request.tail === 'true',
      }),
      latestSeq: this.#host.latestKernelSeq(),
    }
  }

  // listEvents caps one page at 2000 rows. Page by the last seq so a loop
  // timeline never silently drops early laps.
  allKernelEvents() {
    const events: JsonRecord[] = []
    let sinceSeq = 0
    for (;;) {
      const batch = this.#host.listKernelEvents({ sinceSeq, limit: 2000 })
      events.push(...batch)
      if (batch.length < 2000) return events
      sinceSeq = batch[batch.length - 1].seq
    }
  }

  loopViewsWithTerminalFacts(
    view: KernelState,
    events: JsonRecord[] | undefined = undefined,
  ) {
    const loops = loopsOf(view)
    const stopped = loops.filter((loop) => loop.status === 'stopped')
    if (stopped.length === 0) return loops
    const keyOf = (loop: JsonRecord) =>
      `${loop.loopId}\u0000${[...loop.subscriptionIds].sort().join('\u0000')}`
    const missing = stopped.filter(
      (loop) =>
        events !== undefined || !this.#loopTerminalFacts.has(keyOf(loop)),
    )
    if (missing.length > 0) {
      const authoritativeEvents = events ?? this.allKernelEvents()
      for (const loop of missing) {
        const terminal = loopTimelineOf(
          view,
          authoritativeEvents as GraphEvent[],
          loop,
        ).stops.at(-1)
        if (terminal) this.#loopTerminalFacts.set(keyOf(loop), terminal)
      }
    }
    return loops.map((loop) => {
      const terminal = this.#loopTerminalFacts.get(keyOf(loop))
      return terminal ? { ...loop, terminal } : loop
    })
  }

  getLoopTimeline(input: JsonRecord = {}) {
    const loopId = optionalTrimmedString(input.loopId)
    if (!loopId) throw new Error('getLoopTimeline requires a loopId')
    const view = this.kernelView(this.#host.readState())
    const events = this.allKernelEvents()
    const loop = this.loopViewsWithTerminalFacts(view, events).find(
      (candidate) => candidate.loopId === loopId,
    )
    if (!loop) throw new Error(`Unknown loop: ${loopId}`)
    return {
      loop,
      timeline: loopTimelineOf(view, events as GraphEvent[], loop),
    }
  }

  // Build the graph-core view from live runtime state. Callers inside an open
  // command intentionally see the live mutable state; public reads use
  // readState(), which preserves committed-read isolation.
  kernelView(state: JsonRecord = this.#host.liveState()): KernelState {
    const sessions: JsonRecord = {}
    for (const session of Object.values(state.sessions as JsonRecord)) {
      const node = state.nodes.find(
        (item) => item.sessionId === session.sessionId,
      )
      sessions[session.sessionId] = {
        sessionId: session.sessionId,
        status: session.status,
        frozen: node?.frozen === true,
        freezeReason: node?.freezeReason,
        archived: session.archived === true,
        createdBy: undefined,
      }
    }
    const scopes: JsonRecord = {}
    for (const cluster of Object.values(state.clusters as JsonRecord)) {
      scopes[cluster.clusterId] = {
        scopeId: cluster.clusterId,
        kind: 'cluster',
        parentId: undefined,
        members: cluster.nodeIds.filter(
          (id) => id !== cluster.masterSessionId,
        ),
        masterSessionId: cluster.masterSessionId,
      }
    }
    const pending: JsonRecord = {}
    for (const slot of Object.values(
      (state.pendingActivations ?? {}) as JsonRecord,
    )) {
      pending[slot.slotKey] = {
        slotKey: slot.slotKey,
        subscriptionId: slot.subscriptionId,
        target: slot.target,
        triggerEventId: slot.triggerEventId,
        status: slot.status,
        createdAtSeq: Number.isFinite(slot.orderSeq) ? slot.orderSeq : 0,
      }
    }
    return {
      lastSeq: this.#host.latestKernelSeq(),
      sessions,
      subscriptions: clone(state.subscriptions ?? {}),
      scopes,
      pending,
      links: {},
      sources: clone(state.sources ?? {}),
    }
  }

  listSessionSummaries() {
    const state = this.#host.readState()
    const sessions = Object.values(state.sessions ?? {})
      .map((session) => this.sessionSummary(session, state))
      .sort((left, right) =>
        String(right.updatedAt ?? '').localeCompare(
          String(left.updatedAt ?? ''),
        ),
      )
    return { sessions }
  }

  getSessionView(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const state = this.#host.readState()
    const session = this.requireSession(request.sessionId, state)
    const view = optionalTrimmedString(request.view) ?? 'summary'
    if (view === 'summary') {
      return { view, session: this.sessionSummary(session, state) }
    }
    if (view === 'raw') return { view, session: clone(session) }
    if (view === 'transcript') {
      return {
        view,
        session: this.sessionSummary(session, state),
        projection: projectSession(clone(session)),
      }
    }
    throw new Error(`Unknown session view: ${view}`)
  }

  getGraphTopology() {
    const state = this.#host.readState()
    return clone({
      version: state.version,
      updatedAt: state.updatedAt,
      nodes: state.nodes,
      edges: state.edges,
      clusters: state.clusters,
    })
  }

  getSessionEvents(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const session = this.requireSession(
      request.sessionId,
      this.#host.readState(),
    )
    const events = session.runtimeEvents ?? []
    const since = optionalTrimmedString(request.since)
    let startIndex = 0
    let reset = false
    if (since) {
      const sinceIndex = events.findIndex((event) => event.id === since)
      if (sinceIndex >= 0) startIndex = sinceIndex + 1
      else reset = true
    }
    return {
      sessionId: session.sessionId,
      status: session.status,
      events: clone(events.slice(startIndex)),
      cursor: events.at(-1)?.id,
      reset,
    }
  }

  requireSession(
    sessionId: unknown,
    state: JsonRecord = this.#host.readState(),
  ) {
    const id = optionalTrimmedString(sessionId)
    const session = id ? state.sessions[id] : undefined
    if (!session) throw new Error(`Unknown session: ${sessionId ?? ''}`)
    return session
  }

  sessionSummary(
    session: JsonRecord,
    state: JsonRecord = this.#host.readState(),
  ) {
    const node = state.nodes.find(
      (candidate) => candidate.sessionId === session.sessionId,
    )
    return {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      label: session.label,
      role: session.role,
      status: session.status,
      providerKind: session.providerKind,
      providerInstanceId: session.providerInstanceId,
      agent: session.agent,
      cwd: session.cwd,
      project: clone(session.project),
      clusterId: node?.clusterId,
      frozen: node?.frozen,
      archived: session.archived,
      error: session.error,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      finishedAt: session.finishedAt,
      messageCount: Array.isArray(session.messages)
        ? session.messages.length
        : 0,
      runtimeSettings: clone(session.runtimeSettings),
    }
  }

  getProjectContext(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    try {
      return gitProjectContext(request.cwd)
    } catch (error) {
      const cwd = safeCwd(request.cwd)
      return {
        cwd,
        projectName: projectNameFromCwd(cwd),
        isGitRepo: false,
        branches: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
