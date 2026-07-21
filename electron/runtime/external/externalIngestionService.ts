// L2 external-source registration, ingestion, adapter lifecycle, and replay
// anchor recovery. The service receives explicit control-plane callbacks so
// durable state and command transactions remain owned by the manager.
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  externalIngestionDecision,
  externalSourceKinds,
  externalSourceSummary,
  isValidExternalTopic,
} from '../../../shared/graph-core/index.js'
import { createExternalSourceAdapter } from '../externalSourceAdapters.js'
import {
  clone,
  isObject,
  now,
  optionalTrimmedString,
  type JsonRecord,
} from '../runtimeCommon.js'

const externalPayloadMaxBytes = 16 * 1024

export type ExternalIngestionHost = {
  liveState: () => JsonRecord
  appendKernelEvent: (
    type: string,
    payload: JsonRecord,
    ctx: JsonRecord,
    options?: JsonRecord,
  ) => JsonRecord | undefined
  stopSubscription: (input: JsonRecord, ctx: JsonRecord) => unknown
  latestEventWithPayloadValue: (
    type: string,
    payloadKey: string,
    payloadValue: string,
  ) => JsonRecord | undefined
  touch: () => void
  broadcastState: () => void
}

export class ExternalIngestionService {
  #host: ExternalIngestionHost
  #adapters = new Map<string, { start: () => void; stop: () => void }>()

  constructor(host: ExternalIngestionHost) {
    this.#host = host
  }

  registerExternalSource(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const kind = optionalTrimmedString(request.kind)
    if (!kind || !externalSourceKinds.has(kind)) {
      throw new Error(
        `External source kind must be one of ${[...externalSourceKinds].join('|')}`,
      )
    }
    const topic = optionalTrimmedString(request.topic) ?? kind
    if (!isValidExternalTopic(topic)) {
      throw new Error(
        'External source topic must be a lowercase slug ([a-z][a-z0-9_-]*); "timer" is reserved',
      )
    }
    const state = this.#host.liveState()
    const id =
      optionalTrimmedString(request.id) ?? `src-${randomUUID().slice(0, 8)}`
    if (state.sources?.[id]) {
      throw new Error(`External source id already exists: ${id}`)
    }
    let minIntervalSeconds
    if (request.minIntervalSeconds !== undefined) {
      minIntervalSeconds = Number(request.minIntervalSeconds)
      if (!Number.isFinite(minIntervalSeconds) || minIntervalSeconds < 0) {
        throw new Error(
          'External source minIntervalSeconds must be a number >= 0',
        )
      }
    }
    const config = isObject(request.config) ? clone(request.config) : {}
    if (kind === 'script') {
      if (!optionalTrimmedString(config.command)) {
        throw new Error('A script source requires config.command')
      }
      if (
        config.args !== undefined &&
        (!Array.isArray(config.args) ||
          config.args.some((arg) => typeof arg !== 'string'))
      ) {
        throw new Error('Script source config.args must be an array of strings')
      }
      const mode = config.mode ?? 'lines'
      if (mode !== 'lines' && mode !== 'exit') {
        throw new Error('Script source config.mode must be "lines" or "exit"')
      }
      if (mode === 'exit') {
        const everySeconds = Number(config.everySeconds ?? 60)
        if (!Number.isInteger(everySeconds) || everySeconds < 5) {
          throw new Error(
            'Script source config.everySeconds must be an integer >= 5',
          )
        }
        config.everySeconds = everySeconds
      }
      config.mode = mode
    }
    if (kind === 'git') {
      const repoPath = optionalTrimmedString(config.repoPath)
      if (!repoPath || !fs.existsSync(repoPath)) {
        throw new Error(
          'A git source requires config.repoPath pointing at an existing repository',
        )
      }
      config.repoPath = repoPath
      if (config.pollSeconds !== undefined) {
        const pollSeconds = Number(config.pollSeconds)
        if (!Number.isFinite(pollSeconds) || pollSeconds < 1) {
          throw new Error('Git source config.pollSeconds must be a number >= 1')
        }
        config.pollSeconds = pollSeconds
      }
    }
    const source = {
      id,
      kind,
      topic,
      label: optionalTrimmedString(request.label),
      config,
      ...(minIntervalSeconds !== undefined ? { minIntervalSeconds } : {}),
      state: 'active',
      createdAt: now(),
    }
    // Transport secrets are runtime-plane, not kernel facts: the ingestion
    // decision never reads the token, so it stays out of the event log.
    // Webhook-kind sources get one by default (their endpoint faces out).
    const token =
      optionalTrimmedString(request.token) ??
      (kind === 'webhook' ? randomUUID() : undefined)
    if (token) {
      state.sourceTokens = state.sourceTokens ?? {}
      state.sourceTokens[id] = token
    }
    state.sources = state.sources ?? {}
    state.sources[id] = source
    this.#host.appendKernelEvent(
      'source.registered',
      { source: clone(source) },
      { actor: { kind: 'human' } },
      { reason: optionalTrimmedString(request.reason) },
    )
    this.#syncAdapterForSource(source)
    this.#host.touch()
    this.#host.broadcastState()
    return {
      source: clone(source),
      ...(token ? { token } : {}),
    }
  }

  removeExternalSource(input: JsonRecord = {}) {
    const state = this.#host.liveState()
    const sourceId = optionalTrimmedString(input.sourceId)
    const source = sourceId ? state.sources?.[sourceId] : undefined
    if (!source) {
      throw new Error(`Unknown external source: ${sourceId ?? ''}`)
    }
    if (source.state === 'removed') {
      return { ok: true, source: clone(source) }
    }
    source.state = 'removed'
    this.#host.appendKernelEvent(
      'source.removed',
      { sourceId },
      { actor: { kind: 'human' } },
      { reason: optionalTrimmedString(input.reason) },
    )
    // Participant parity with killed sessions: an edge whose source is gone
    // can never fire again, so leaving it active would only mislead.
    for (const subscription of Object.values(
      (state.subscriptions ?? {}) as JsonRecord,
    )) {
      if (
        subscription.state === 'active' &&
        subscription.source?.kind === 'external' &&
        subscription.source.sourceId === sourceId
      ) {
        this.#host.stopSubscription(
          {
            subscriptionId: subscription.id,
            reason: 'External source was removed.',
          },
          { actor: { kind: 'runtime' } },
        )
      }
    }
    this.#syncAdapterForSource(source)
    if (state.sourceTokens) {
      delete state.sourceTokens[sourceId]
    }
    this.#host.touch()
    this.#host.broadcastState()
    return { ok: true, source: clone(source) }
  }

  // Accept-or-drop for one emit. Dropped emits return {ok:false} and append
  // NOTHING — sampling exists to keep a chatty source out of the log; the
  // adapter re-emits current state on its next beat.
  emitExternalEvent(input: JsonRecord = {}) {
    const state = this.#host.liveState()
    const sourceId = optionalTrimmedString(input.sourceId)
    const source = sourceId ? state.sources?.[sourceId] : undefined
    if (!source) {
      throw new Error(`Unknown external source: ${sourceId ?? ''}`)
    }
    const topic = optionalTrimmedString(input.topic)
    if (topic !== undefined && topic !== source.topic) {
      throw new Error(
        `Emit topic must match the source's declared topic (${source.topic})`,
      )
    }
    const payload = input.payload === undefined ? {} : input.payload
    if (!isObject(payload)) {
      throw new Error('Emit payload must be a JSON object')
    }
    for (const reserved of [
      'sourceId',
      'dedupeKey',
      'subscriptionId',
      'sessionId',
    ]) {
      if (payload[reserved] !== undefined) {
        throw new Error(
          `Emit payload must not use the reserved key "${reserved}"`,
        )
      }
    }
    if (
      Buffer.byteLength(JSON.stringify(payload), 'utf8') >
      externalPayloadMaxBytes
    ) {
      throw new Error(
        `Emit payload exceeds ${externalPayloadMaxBytes} bytes; deliver a pointer (path/URL), not the artifact`,
      )
    }
    const dedupeKey = optionalTrimmedString(input.dedupeKey)

    const decision = externalIngestionDecision(
      source,
      { dedupeKey },
      Date.now(),
    )
    if (decision.ok !== true) {
      return {
        ok: false,
        dropped: true,
        reason: decision.reason,
      }
    }

    const event = this.#host.appendKernelEvent(
      `external.${source.topic}`,
      {
        ...clone(payload),
        sourceId: source.id,
        ...(dedupeKey ? { dedupeKey } : {}),
      },
      { actor: { kind: 'runtime' } },
      {
        reason: `External emit (${externalSourceSummary(source)}).`,
      },
    )
    // Snapshot anchors are caches of the appended fact (fold derives the
    // same values on replay). lastDedupeKey tracks the last accepted
    // event's key INCLUDING its absence — a key-less accepted event breaks
    // the "consecutive" chain, so a later repeat of an older key passes.
    source.lastEventAt = event?.ts ?? now()
    source.lastDedupeKey = dedupeKey
    this.#host.touch()
    return {
      ok: true,
      eventId: event?.id,
      type: `external.${source.topic}`,
    }
  }

  // Transport-layer auth for the HTTP ingestion path: sources without a
  // token accept unauthenticated local emits; sources with one require it.
  verifyExternalSourceToken(sourceId, token) {
    const required = this.#host.liveState().sourceTokens?.[sourceId]
    if (!required) {
      return true
    }
    return typeof token === 'string' && token === required
  }

  // Adapter lifecycle: script/git sources run a watcher owned by the
  // runtime; webhook and manual sources are pure ingestion-endpoint
  // consumers. Adapter failures land on source.lastError (runtime-plane
  // operational status, never a kernel fact).
  #syncAdapterForSource(source) {
    const existing = this.#adapters.get(source.id)
    if (existing) {
      existing.stop()
      this.#adapters.delete(source.id)
    }
    if (source.state !== 'active') {
      return
    }
    const adapter = createExternalSourceAdapter(source, {
      emit: (input) => {
        const result = this.emitExternalEvent({
          sourceId: source.id,
          ...input,
        })
        if (result.ok) {
          const live = this.#host.liveState().sources?.[source.id]
          if (live?.lastError) {
            delete live.lastError
            this.#host.touch()
          }
        }
        return result
      },
      onError: (message) => this.#recordSourceError(source.id, message),
    })
    if (adapter) {
      this.#adapters.set(source.id, adapter)
      adapter.start()
    }
  }

  #recordSourceError(sourceId, message) {
    const source = this.#host.liveState().sources?.[sourceId]
    if (source && source.lastError !== message) {
      source.lastError = message
      this.#host.touch()
    }
  }

  stopAllAdapters() {
    for (const adapter of this.#adapters.values()) {
      try {
        adapter.stop()
      } catch {
        // Best-effort teardown.
      }
    }
    this.#adapters.clear()
  }

  // Reconcile ingestion anchors from the event log before adapters start:
  // the snapshot may be older than the last appended fact (events are
  // truth). Exact per-source lookup, mirroring timer recovery.
  recoverSourceAnchors() {
    for (const source of Object.values(
      (this.#host.liveState().sources ?? {}) as JsonRecord,
    )) {
      const logged = this.#host.latestEventWithPayloadValue(
        `external.${source.topic}`,
        'sourceId',
        source.id,
      )
      if (logged) {
        // Unconditional: both anchors are caches of appended facts, so the
        // log's latest accepted event is always at least as fresh as any
        // snapshot copy — and the dedupe anchor is that event's key
        // INCLUDING its absence (a key-less accepted event breaks the
        // "consecutive" chain). A freshness guard here would let a stale
        // snapshot key with an equal timestamp survive recovery.
        source.lastEventAt = logged.ts
        source.lastDedupeKey = optionalTrimmedString(logged.payload?.dedupeKey)
      }
      // Adapters restart regardless of emit history — a source registered
      // just before shutdown has no logged event yet and must still wake.
      if (source.state === 'active') {
        this.#syncAdapterForSource(source)
      }
    }
  }
}
