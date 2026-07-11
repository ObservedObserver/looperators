import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultProviderInstances,
  providerKinds,
} from '../../shared/provider-metadata.js'
import { ClaudeAgentSdkAdapter } from './providers/claudeAgentSdkAdapter.js'
import { CodexAppServerAdapter } from './providers/codexAppServerAdapter.js'
import { GrokAcpAdapter } from './providers/grokAcpAdapter.js'

type JsonRecord = Record<string, any>

type ProviderAdapter = {
  startTurn: (input: JsonRecord) => any
  closeAll?: () => void
}

const knownProviderKinds: ReadonlySet<string> = new Set(providerKinds)

function now() {
  return new Date().toISOString()
}

function defaultLogRoot() {
  return path.join(os.homedir(), '.orrery', 'provider-logs')
}

function safeLogPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unknown'
}

function appendNdjson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

export class ProviderService extends EventEmitter {
  #adapters: Map<string, ProviderAdapter>
  #instances = new Map<string, JsonRecord>()
  #bindings = new Map<string, JsonRecord>()
  #activeTurns = new Map<string, JsonRecord>()
  #logRoot: string

  constructor({
    adapters,
    providerInstances,
    logRoot,
  }: {
    adapters?: Map<string, ProviderAdapter>
    providerInstances?: JsonRecord[]
    logRoot?: string
  } = {}) {
    super()
    const defaultAdapters = new Map<string, ProviderAdapter>([
        ['claude-code', new ClaudeAgentSdkAdapter()],
        ['codex', new CodexAppServerAdapter()],
        ['grok', new GrokAcpAdapter()],
      ])
    this.#adapters = new Map([
      ...defaultAdapters,
      ...(adapters ?? new Map<string, ProviderAdapter>()),
    ])
    this.#logRoot =
      typeof logRoot === 'string' && logRoot.length > 0 ? logRoot : defaultLogRoot()

    for (const instance of providerInstances ?? defaultProviderInstances) {
      this.registerProviderInstance(instance)
    }
  }

  registerProviderInstance(instance: JsonRecord) {
    if (
      typeof instance.providerInstanceId !== 'string' ||
      instance.providerInstanceId.trim().length === 0
    ) {
      throw new Error('Provider instance id is required.')
    }
    if (typeof instance.kind !== 'string' || !knownProviderKinds.has(instance.kind)) {
      throw new Error(`Unsupported provider instance kind: ${String(instance.kind)}`)
    }

    this.#instances.set(instance.providerInstanceId, {
      ...instance,
      providerInstanceId: instance.providerInstanceId,
      kind: instance.kind,
      label:
        typeof instance.label === 'string' && instance.label.trim().length > 0
          ? instance.label.trim()
          : instance.providerInstanceId,
    })
  }

  listProviderInstances() {
    return [...this.#instances.values()].map((instance) => structuredClone(instance))
  }

  getBinding(sessionId: string) {
    const binding = this.#bindings.get(sessionId)
    return binding ? structuredClone(binding) : undefined
  }

  bindSession(input: JsonRecord) {
    const sessionId = input.sessionId
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('Provider session binding requires an Orrery session id.')
    }

    const existing = this.#bindings.get(sessionId)
    const ts = now()
    const binding = {
      ...(existing ?? {}),
      sessionId,
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
      resumeCursor: input.resumeCursor,
      cwd: input.cwd,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    }
    this.#bindings.set(sessionId, binding)
    this.emit('binding.updated', structuredClone(binding))
    return binding
  }

  startTurn(input: JsonRecord) {
    const providerKind = input.providerKind
    if (typeof providerKind !== 'string' || providerKind.length === 0) {
      throw new Error('Provider kind is required to start a turn')
    }
    const providerInstanceId =
      typeof input.providerInstanceId === 'string' && input.providerInstanceId
        ? input.providerInstanceId
        : this.#defaultInstanceIdForKind(providerKind)
    const instance = this.#instances.get(providerInstanceId)
    if (!instance) {
      throw new Error(`Unknown provider instance: ${providerInstanceId}`)
    }
    if (instance.kind !== providerKind) {
      throw new Error(
        `Provider instance ${providerInstanceId} is ${instance.kind}, not ${providerKind}`
      )
    }

    const adapter = this.#adapters.get(providerKind)
    if (!adapter) {
      throw new Error(`Provider runtime unavailable: ${providerKind}`)
    }

    this.bindSession({
      sessionId: input.sessionId,
      providerInstanceId,
      providerSessionId: input.backendSessionId,
      resumeCursor: input.providerResumeCursor,
      cwd: input.cwd,
    })

    const run = adapter.startTurn({
      ...input,
      providerInstance: instance,
      providerInstanceId,
    })
    this.#activeTurns.set(input.sessionId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerKind,
      providerInstanceId,
      startedAt: now(),
    })

    run.on?.('providerSession', (event) => {
      this.bindSession({
        sessionId: input.sessionId,
        providerInstanceId,
        providerSessionId: event.providerSessionId,
        resumeCursor: event.resumeCursor,
        cwd: input.cwd,
      })
    })
    run.on?.('native', (event) => {
      this.emit('provider.native', {
        sessionId: input.sessionId,
        event,
      })
    })
    run.on?.('providerEvent', (event) => {
      this.emit('provider.runtime', {
        sessionId: input.sessionId,
        event,
      })
    })
    run.on?.('close', () => {
      this.#activeTurns.delete(input.sessionId)
      this.emit('turn.closed', {
        sessionId: input.sessionId,
        turnId: input.turnId,
      })
    })

    return run
  }

  recordNativeEvent(event: JsonRecord) {
    this.#writeSessionLog(event.sessionId, 'native', event)
    this.emit('native.logged', event)
  }

  recordRuntimeEvent(sessionId: string, event: JsonRecord) {
    this.#writeSessionLog(sessionId, 'canonical', event)
    this.emit('runtime.logged', {
      sessionId,
      event,
    })
  }

  closeAll() {
    for (const adapter of this.#adapters.values()) {
      if (typeof adapter.closeAll === 'function') {
        adapter.closeAll()
      }
    }
    this.#activeTurns.clear()
  }

  #defaultInstanceIdForKind(providerKind: string) {
    const instance = [...this.#instances.values()].find(
      (candidate) => candidate.kind === providerKind
    )
    if (!instance) {
      throw new Error(`No provider instance registered for ${providerKind}`)
    }
    return instance.providerInstanceId
  }

  #writeSessionLog(sessionId: string, channel: 'native' | 'canonical', event: unknown) {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return
    }

    try {
      appendNdjson(
        path.join(this.#logRoot, safeLogPart(sessionId), `${channel}.ndjson`),
        event
      )
    } catch (error) {
      this.emit('log.error', {
        sessionId,
        channel,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
