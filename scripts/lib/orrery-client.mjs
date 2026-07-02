import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { modelPresets } from './model-presets.mjs'

const defaultRuntimeBaseUrl = 'http://127.0.0.1:48274'
const defaultPollIntervalMs = 250
const defaultWaitTimeoutMs = 300_000
const defaultReadyTimeoutMs = 15_000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function trimmedString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

const validProviderKinds = new Set(['legacy-claude-cli', 'claude-code', 'codex'])

// Accepts either a named preset ('cheap') or an already-resolved
// { providerKind: runtimeSettings } object. Unknown names fail loudly:
// silently skipping a preset would run acceptance sessions on default
// (expensive) models, which is exactly what presets exist to prevent.
function resolveModelPreset(modelPreset) {
  if (modelPreset === undefined) {
    return undefined
  }
  if (typeof modelPreset === 'string') {
    const preset = modelPresets[modelPreset]
    if (!preset) {
      throw new Error(
        `Unknown model preset: ${modelPreset}. Known presets: ${Object.keys(modelPresets).join(', ')}`
      )
    }
    return preset
  }
  return modelPreset
}

// Mirrors the requested-kind resolution in sessionManager providerConfig
// (same precedence, no trimming, same validation fallback) so model presets
// attach to the provider the runtime will actually select.
export function resolveRequestedProviderKind(input = {}, providerInstances = []) {
  const requestedInstanceId = trimmedString(input.providerInstanceId)
  const requested =
    input.providerKind ??
    (input.agent === 'codex' ? 'codex' : undefined) ??
    (requestedInstanceId
      ? providerInstances.find(
          (instance) => instance.providerInstanceId === requestedInstanceId
        )?.kind
      : undefined)
  return validProviderKinds.has(requested) ? requested : 'legacy-claude-cli'
}

export class OrreryClient {
  #baseUrl
  #modelPreset

  constructor({ baseUrl, modelPreset } = {}) {
    this.#baseUrl = (trimmedString(baseUrl) ?? defaultRuntimeBaseUrl).replace(/\/$/, '')
    this.#modelPreset = resolveModelPreset(modelPreset)
  }

  static attach(baseUrl, options = {}) {
    return new OrreryClient({ ...options, baseUrl })
  }

  get baseUrl() {
    return this.#baseUrl
  }

  get modelPreset() {
    return this.#modelPreset
  }

  async #request(method, requestPath, body) {
    const response = await fetch(`${this.#baseUrl}${requestPath}`, {
      method,
      ...(body !== undefined
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      const detail = parsed?.error ?? text.trim() ?? ''
      throw new Error(`${method} ${requestPath} failed (${response.status}): ${detail}`)
    }
    return parsed
  }

  config() {
    return this.#request('GET', '/api/runtime/config')
  }

  state() {
    return this.#request('GET', '/api/runtime/state')
  }

  graph() {
    return this.#request('GET', '/api/runtime/graph')
  }

  async sessions() {
    const result = await this.#request('GET', '/api/runtime/sessions')
    return result.sessions
  }

  session(sessionId, view = 'summary') {
    return this.#request(
      'GET',
      `/api/runtime/sessions/${encodeURIComponent(sessionId)}?view=${encodeURIComponent(view)}`
    )
  }

  async transcript(sessionId) {
    const result = await this.session(sessionId, 'transcript')
    return result.projection
  }

  events(sessionId, since) {
    const query = since ? `?since=${encodeURIComponent(since)}` : ''
    return this.#request(
      'GET',
      `/api/runtime/sessions/${encodeURIComponent(sessionId)}/events${query}`
    )
  }

  async createSession(input = {}) {
    let payload = input
    if (this.#modelPreset) {
      const needsInstanceLookup =
        input.providerKind === undefined &&
        input.agent !== 'codex' &&
        input.providerInstanceId !== undefined
      const providerInstances = needsInstanceLookup
        ? (await this.state()).providerInstances ?? []
        : []
      const preset =
        this.#modelPreset[resolveRequestedProviderKind(input, providerInstances)]
      if (preset) {
        payload = { ...input, runtimeSettings: { ...preset, ...input.runtimeSettings } }
      }
    }
    return this.#request('POST', '/api/runtime/sessions', payload)
  }

  resumeSession(sessionId, input = {}) {
    return this.#request(
      'POST',
      `/api/runtime/sessions/${encodeURIComponent(sessionId)}/resume`,
      input
    )
  }

  killSession(sessionId) {
    return this.#request(
      'POST',
      `/api/runtime/sessions/${encodeURIComponent(sessionId)}/kill`
    )
  }

  archiveSession(sessionId, archived = true) {
    return this.#request(
      'POST',
      `/api/runtime/sessions/${encodeURIComponent(sessionId)}/archive`,
      { archived }
    )
  }

  respondRequest(requestId, input = {}) {
    return this.#request(
      'POST',
      `/api/runtime/requests/${encodeURIComponent(requestId)}/respond`,
      input
    )
  }

  answerUserInput(requestId, input = {}) {
    return this.#request(
      'POST',
      `/api/runtime/user-input/${encodeURIComponent(requestId)}/answer`,
      input
    )
  }

  linkSessions(source, target, options = {}) {
    return this.#request('POST', '/api/runtime/edges', {
      source,
      target,
      ...(options.label ? { label: options.label } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    })
  }

  removeEdge(edgeId) {
    return this.#request(
      'POST',
      `/api/runtime/edges/${encodeURIComponent(edgeId)}/remove`
    )
  }

  upsertProviderInstance(input = {}) {
    return this.#request('POST', '/api/runtime/provider-instances', input)
  }

  upsertCluster(input = {}) {
    return this.#request('POST', '/api/runtime/clusters', input)
  }

  createMasterForCluster(clusterId, input = {}) {
    return this.#request(
      'POST',
      `/api/runtime/clusters/${encodeURIComponent(clusterId)}/master`,
      input
    )
  }

  assignMasterToCluster(clusterId, sessionId) {
    return this.#request(
      'POST',
      `/api/runtime/clusters/${encodeURIComponent(clusterId)}/assign-master`,
      { sessionId }
    )
  }

  setClusterLoopPolicy(clusterId, loopPolicy) {
    return this.#request(
      'POST',
      `/api/runtime/clusters/${encodeURIComponent(clusterId)}/loop-policy`,
      { loopPolicy }
    )
  }

  startMasterLoop(clusterId, input = {}) {
    return this.#request(
      'POST',
      `/api/runtime/clusters/${encodeURIComponent(clusterId)}/start-loop`,
      input
    )
  }

  stopMasterLoop(clusterId, input = {}) {
    return this.#request(
      'POST',
      `/api/runtime/clusters/${encodeURIComponent(clusterId)}/stop-loop`,
      input
    )
  }

  freeze(input = {}) {
    return this.#request('POST', '/api/runtime/freeze', input)
  }

  async waitFor(label, probe, options = {}) {
    const timeoutMs = options.timeoutMs ?? defaultWaitTimeoutMs
    const intervalMs = options.intervalMs ?? defaultPollIntervalMs
    const startedAt = Date.now()
    let lastDetail
    while (Date.now() - startedAt < timeoutMs) {
      const result = await probe()
      if (result?.done) {
        return result.value
      }
      lastDetail = result?.detail
      await delay(intervalMs)
    }
    const detail = lastDetail ? ` (last: ${lastDetail})` : ''
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${detail}`)
  }

  waitForStatus(sessionId, statuses, options = {}) {
    const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses])
    return this.waitFor(
      `session ${sessionId} status ${[...wanted].join('|')}`,
      async () => {
        const { session } = await this.session(sessionId)
        if (wanted.has(session.status)) {
          return { done: true, value: session }
        }
        if (session.status === 'failed' && !wanted.has('failed')) {
          throw new Error(
            `Session ${sessionId} failed: ${session.error ?? 'unknown error'}`
          )
        }
        if (session.status === 'killed' && !wanted.has('killed')) {
          throw new Error(`Session ${sessionId} was killed`)
        }
        return { detail: `status=${session.status}` }
      },
      options
    )
  }

  waitForIdle(sessionId, options = {}) {
    return this.waitForStatus(sessionId, 'idle', options)
  }

  // Rejects when a session fails or is killed while the report is pending;
  // sessions already dead when the wait starts are ignored (opt out with
  // failOnSessionFailure: false). options.trigger runs after the dead-session
  // snapshot, so failures it causes are always attributed to this wait.
  async waitForReport(match = {}, options = {}) {
    const describeMatch =
      Object.entries(match)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ') || 'any report'
    const deadSessionIds = (state) =>
      Object.values(state.sessions ?? {})
        .filter(
          (session) => session.status === 'failed' || session.status === 'killed'
        )
        .map((session) => session.sessionId)
    const deadAtStart = new Set(deadSessionIds(await this.state()))
    if (options.trigger) {
      await options.trigger()
    }
    return this.waitFor(
      `report ${describeMatch}`,
      async () => {
        const state = await this.state()
        if (options.failOnSessionFailure !== false) {
          const casualties = Object.values(state.sessions ?? {}).filter(
            (session) =>
              (session.status === 'failed' || session.status === 'killed') &&
              !deadAtStart.has(session.sessionId)
          )
          if (casualties.length > 0) {
            const detail = casualties
              .map(
                (session) =>
                  `${session.sessionId} ${session.status}` +
                  (session.error ? `: ${session.error}` : '')
              )
              .join('; ')
            throw new Error(
              `Session died while waiting for report ${describeMatch} — ${detail}`
            )
          }
        }
        const report = (state.reports ?? []).find(
          (candidate) =>
            (match.type === undefined || candidate.payload?.type === match.type) &&
            (match.verdict === undefined ||
              candidate.payload?.verdict === match.verdict) &&
            (match.from === undefined || candidate.from === match.from)
        )
        if (report) {
          return { done: true, value: report }
        }
        return { detail: `${state.reports?.length ?? 0} reports` }
      },
      options
    )
  }

  subscribeEvents(onEvent) {
    const controller = new AbortController()
    let markReady
    // Resolves once the server has registered this SSE client (it does so in
    // the same synchronous block that flushes the response headers), so
    // callers can safely trigger actions without losing their first events.
    const ready = new Promise((resolve) => {
      markReady = resolve
    })
    const done = (async () => {
      const response = await fetch(`${this.#baseUrl}/api/runtime/events`, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`GET /api/runtime/events failed (${response.status})`)
      }
      markReady()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.indexOf('\n\n')
        while (separator >= 0) {
          const block = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          separator = buffer.indexOf('\n\n')
          const payload = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('\n')
          if (payload.length === 0) {
            continue
          }
          try {
            onEvent(JSON.parse(payload))
          } catch {
            // Skip malformed frames; the stream itself stays healthy.
          }
        }
      }
    })()
    done.catch(() => {
      // Bare subscribers may never await done; waitForEvent attaches its own
      // handlers. This no-op only prevents unhandled-rejection crashes.
    })
    return {
      stop: () => controller.abort(),
      done,
      ready,
    }
  }

  // options.trigger: async callback invoked once the subscription is live, so
  // the action that produces the event cannot race ahead of the SSE stream:
  //   await client.waitForEvent((e) => e.type === 'session.created', {
  //     trigger: () => client.createSession({ ... }),
  //   })
  // Rejects on session.failed / session.killed events the predicate did not
  // claim (opt out with failOnSessionFailure: false, e.g. when waiting for a
  // failure on purpose alongside other conditions).
  waitForEvent(predicate, options = {}) {
    const timeoutMs = options.timeoutMs ?? defaultWaitTimeoutMs
    const label = options.label ?? 'runtime event'
    const trigger = options.trigger
    const failOnSessionFailure = options.failOnSessionFailure !== false
    return new Promise((resolve, reject) => {
      let settled = false
      let subscription
      const finish = (settle, value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        subscription?.stop()
        settle(value)
      }
      const timer = setTimeout(
        () => finish(reject, new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)),
        timeoutMs
      )
      let triggerPromise = Promise.resolve()
      subscription = this.subscribeEvents((event) => {
        let matched
        try {
          matched = predicate(event)
        } catch (error) {
          finish(reject, error)
          return
        }
        if (matched) {
          // The runtime broadcasts events while the triggering request is
          // still in flight; resolve only after the trigger has settled so
          // callers can rely on its side effects (e.g. the createSession
          // response) once waitForEvent returns.
          triggerPromise.then(
            () => finish(resolve, event),
            () => {}
          )
          return
        }
        if (
          failOnSessionFailure &&
          (event.type === 'session.failed' || event.type === 'session.killed')
        ) {
          finish(
            reject,
            new Error(
              `Session ${event.sessionId} ${
                event.type === 'session.failed' ? 'failed' : 'was killed'
              } while waiting for ${label}` +
                (event.error ? `: ${event.error}` : '')
            )
          )
        }
      })
      subscription.done.then(
        () =>
          finish(
            reject,
            new Error(`Event stream closed while waiting for ${label}`)
          ),
        (error) => {
          if (error?.name === 'AbortError') {
            return
          }
          finish(reject, error)
        }
      )
      if (trigger) {
        triggerPromise = subscription.ready.then(() =>
          settled ? undefined : trigger()
        )
        triggerPromise.catch((error) => finish(reject, error))
      }
    })
  }
}

export class OrreryHarness extends OrreryClient {
  #child
  #tempRoot

  constructor({ baseUrl, modelPreset, child, tempRoot, storageFile }) {
    super({ baseUrl, modelPreset })
    this.#child = child
    this.#tempRoot = tempRoot
    this.storageFile = storageFile
  }

  static async start(options = {}) {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..'
    )
    const cliPath =
      options.cliPath ??
      path.join(repoRoot, 'dist-electron', 'electron', 'runtimeHttpServerCli.js')
    if (!fs.existsSync(cliPath)) {
      throw new Error(
        `Runtime CLI not found at ${cliPath}. Run \`npm run build:electron\` first.`
      )
    }

    const tempRoot =
      options.storageFile === undefined
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-headless-'))
        : undefined
    const storageFile =
      options.storageFile ?? path.join(tempRoot, 'orrery-runtime-state.json')

    const child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        ORRERY_RUNTIME_HTTP_PORT: String(options.port ?? 0),
        ORRERY_RUNTIME_STORAGE_FILE: storageFile,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const maxDiagnosticBytes = 8192
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-maxDiagnosticBytes)
    })

    const readyTimeoutMs = options.readyTimeoutMs ?? defaultReadyTimeoutMs
    const baseUrl = await new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        if (tempRoot) {
          fs.rmSync(tempRoot, { recursive: true, force: true })
        }
        reject(error)
      }
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `Runtime server not ready after ${readyTimeoutMs}ms. stderr: ${stderr}`
            )
          ),
        readyTimeoutMs
      )
      child.once('error', (error) =>
        fail(new Error(`Runtime server failed to spawn: ${error.message}`))
      )
      child.once('exit', (code) =>
        fail(new Error(`Runtime server exited with code ${code}. stderr: ${stderr}`))
      )
      const onStdout = (chunk) => {
        stdout = (stdout + String(chunk)).slice(-maxDiagnosticBytes)
        const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) {
          settled = true
          clearTimeout(timer)
          child.stdout.removeListener('data', onStdout)
          resolve(match[1])
        }
      }
      child.stdout.on('data', onStdout)
    })

    return new OrreryHarness({
      baseUrl,
      modelPreset: options.modelPreset,
      child,
      tempRoot,
      storageFile,
    })
  }

  async close() {
    if (this.#child && this.#child.exitCode === null && !this.#child.killed) {
      const exited = new Promise((resolve) => this.#child.once('exit', resolve))
      this.#child.kill('SIGTERM')
      const forceKill = setTimeout(() => this.#child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(forceKill)
    }
    if (this.#tempRoot) {
      fs.rmSync(this.#tempRoot, { recursive: true, force: true })
      this.#tempRoot = undefined
    }
  }
}
