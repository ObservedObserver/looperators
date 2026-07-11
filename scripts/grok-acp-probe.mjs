#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const grokPermissionCancelled = { outcome: { outcome: 'cancelled' } }
export const grokQuestionCancelled = { outcome: 'cancelled' }

export function grokRecoveryCapabilities(initializeResult = {}) {
  const capabilities = initializeResult.agentCapabilities ?? {}
  return {
    load: capabilities.loadSession === true,
    resume: capabilities.sessionCapabilities?.resume != null,
  }
}

export function selectGrokRecoveryMethod(initializeResult = {}) {
  const capabilities = grokRecoveryCapabilities(initializeResult)
  if (capabilities.resume) return 'session/resume'
  if (capabilities.load) return 'session/load'
  return undefined
}

export function selectPermissionOption(options = [], decision = 'allow') {
  const kinds =
    decision === 'allow'
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always']
  for (const kind of kinds) {
    const option = options.find((entry) => entry?.kind === kind)
    if (typeof option?.optionId === 'string' && option.optionId.length > 0) {
      return option.optionId
    }
  }
  return undefined
}

export function permissionProbeResponse(params = {}, allowPermissions = false) {
  if (!allowPermissions) return grokPermissionCancelled
  const optionId = selectPermissionOption(params.options, 'allow')
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : grokPermissionCancelled
}

export function questionProbeResponse(params = {}, answerQuestions = false) {
  if (!answerQuestions) return grokQuestionCancelled
  const payload = params.params ?? params
  const questions = Array.isArray(payload.questions) ? payload.questions : []
  if (questions.length === 0) return grokQuestionCancelled

  const answers = {}
  for (const question of questions) {
    if (typeof question?.question !== 'string' || question.question.length === 0) {
      return grokQuestionCancelled
    }
    const firstOption = Array.isArray(question.options)
      ? question.options.find((option) => typeof option?.label === 'string')
      : undefined
    answers[question.question] = [firstOption?.label ?? 'Orrery probe answer']
  }
  return { outcome: 'accepted', answers }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function writeNdjson(file, entry) {
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

function processRssKb(pid) {
  if (!Number.isInteger(pid)) return undefined
  try {
    const value = Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    )
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

class ProbeClient {
  constructor({
    binary,
    cwd,
    logFile,
    timeoutMs,
    allowPermissions = false,
    answerQuestions = false,
  }) {
    this.child = spawn(binary, ['agent', 'stdio'], {
      cwd,
      env: {
        ...process.env,
        GROK_OAUTH2_REFERRER: 'orrery',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.logFile = logFile
    this.timeoutMs = timeoutMs
    this.allowPermissions = allowPermissions
    this.answerQuestions = answerQuestions
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.stderr = []
    this.requestTimings = []
    this.closed = false
    this.lastMessageAt = performance.now()
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve
    })

    const stdout = readline.createInterface({ input: this.child.stdout })
    stdout.on('line', (line) => this.handleLine(line))
    const stderr = readline.createInterface({ input: this.child.stderr })
    stderr.on('line', (line) => {
      this.stderr.push(line)
      writeNdjson(this.logFile, { direction: 'stderr', line })
    })
    this.child.on('error', (error) => this.rejectAll(error))
    this.child.stdin.on('error', (error) => this.rejectAll(error))
    this.child.on('close', (code, signal) => {
      this.closed = true
      this.rejectAll(
        new Error(`Grok probe process closed with code ${code ?? 'null'} signal ${signal ?? 'null'}`),
      )
      this.resolveClose({ code, signal })
    })
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++
    const startedAt = performance.now()
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.requestTimings.push({
          method,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          ok: false,
          timedOut: true,
        })
        reject(new Error(`Grok probe request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer, startedAt })
      writeNdjson(this.logFile, { direction: 'send', message })
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  respond(id, result) {
    const message = { jsonrpc: '2.0', id, result }
    writeNdjson(this.logFile, { direction: 'send', message })
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  respondError(id, code, message) {
    const payload = { jsonrpc: '2.0', id, error: { code, message } }
    writeNdjson(this.logFile, { direction: 'send', message: payload })
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method, params }
    writeNdjson(this.logFile, { direction: 'send', message })
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  handleLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      writeNdjson(this.logFile, { direction: 'receive-invalid', line })
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      writeNdjson(this.logFile, { direction: 'receive-invalid-shape', message })
      return
    }
    this.lastMessageAt = performance.now()
    writeNdjson(this.logFile, { direction: 'receive', message })

    if (
      Object.hasOwn(message, 'id') &&
      (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    ) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(Number(message.id))
      this.requestTimings.push({
        method: pending.method,
        durationMs: Math.round((performance.now() - pending.startedAt) * 100) / 100,
        ok: !message.error,
      })
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      this.handleServerRequest(message)
      return
    }
    if (message.method) this.notifications.push(message)
  }

  handleServerRequest(message) {
    if (message.method === 'session/request_permission') {
      this.respond(
        message.id,
        permissionProbeResponse(message.params, this.allowPermissions),
      )
      return
    }
    if (
      message.method === 'x.ai/ask_user_question' ||
      message.method === '_x.ai/ask_user_question'
    ) {
      this.respond(
        message.id,
        questionProbeResponse(message.params, this.answerQuestions),
      )
      return
    }
    this.respondError(message.id, -32601, `Unsupported probe request: ${message.method}`)
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async waitForIdle(idleGapMs, totalTimeoutMs = this.timeoutMs) {
    const deadline = performance.now() + totalTimeoutMs
    while (!this.closed) {
      const idleFor = performance.now() - this.lastMessageAt
      if (idleFor >= idleGapMs) return
      if (performance.now() >= deadline) {
        throw new Error(`Grok probe stream did not become idle within ${totalTimeoutMs}ms.`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, idleGapMs)))
    }
  }

  async close() {
    if (this.closed) return this.closePromise
    this.child.kill('SIGTERM')
    const forceTimer = setTimeout(() => {
      if (!this.closed) this.child.kill('SIGKILL')
    }, 2_000)
    try {
      return await this.closePromise
    } finally {
      clearTimeout(forceTimer)
    }
  }
}

async function runProbe(options) {
  if (options.logFile) fs.rmSync(options.logFile, { force: true })
  const client = new ProbeClient(options)
  const promptId = `orrery-grok-probe-${randomUUID()}`
  try {
    const initialize = await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'orrery-probe', title: 'Orrery Probe', version: '0.0.0' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })
    const rssAfterInitializeKb = processRssKb(client.child.pid)
    const authMethod = process.env.XAI_API_KEY?.trim() ? 'xai.api_key' : 'cached_token'
    await client.request('authenticate', { methodId: authMethod })

    const requestedRecovery = options.sessionId
      ? selectGrokRecoveryMethod(initialize)
      : undefined
    const setupMethod = options.sessionId
      ? options.forceLoad
        ? 'session/load'
        : requestedRecovery
      : 'session/new'
    if (options.sessionId && !setupMethod) {
      throw new Error('Grok does not advertise session/load or session/resume.')
    }
    const notificationStart = client.notifications.length
    const setupStartedAt = performance.now()
    const setup = await client.request(setupMethod ?? 'session/new', {
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cwd: options.cwd,
      mcpServers: [],
    })
    const sessionId = setup.sessionId ?? options.sessionId
    if (!nonEmpty(sessionId)) throw new Error('Grok session setup returned no session id.')
    if (options.sessionId) {
      const remainingMs = Math.max(
        1,
        options.timeoutMs - (performance.now() - setupStartedAt),
      )
      await client.waitForIdle(options.idleGapMs, remainingMs)
    }
    const rssAfterSetupKb = processRssKb(client.child.pid)
    const setupNotifications = client.notifications.slice(notificationStart)

    if (nonEmpty(options.model) && options.model !== setup.models?.currentModelId) {
      await client.request('session/set_model', {
        sessionId,
        modelId: options.model,
      })
    }

    let promptResponse
    if (nonEmpty(options.prompt)) {
      const promptPromise = client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: options.prompt }],
        _meta: { promptId, requestId: promptId },
      })
      const cancelTimer = options.cancelAfterMs
        ? setTimeout(() => {
            client.notify('session/cancel', { sessionId })
          }, options.cancelAfterMs)
        : undefined
      try {
        promptResponse = await promptPromise
      } finally {
        if (cancelTimer) clearTimeout(cancelTimer)
      }
      await client.waitForIdle(options.idleGapMs)
    }
    const rssAfterPromptKb = processRssKb(client.child.pid)

    return {
      binary: options.binary,
      cwd: options.cwd,
      initialize,
      authMethod,
      setupMethod: setupMethod ?? 'session/new',
      setup,
      sessionId,
      promptId,
      promptResponse,
      setupReplay: {
        count: setupNotifications.filter((entry) => entry.method === 'session/update').length,
        updateKinds: [
          ...new Set(
            setupNotifications
              .filter((entry) => entry.method === 'session/update')
              .map((entry) => entry.params?.update?.sessionUpdate)
              .filter(nonEmpty),
          ),
        ],
      },
      processRssKb: {
        afterInitialize: rssAfterInitializeKb,
        afterSetup: rssAfterSetupKb,
        afterPrompt: rssAfterPromptKb,
      },
      notificationMethods: [...new Set(client.notifications.map((entry) => entry.method))],
      requestTimings: client.requestTimings,
      stderrTail: client.stderr.slice(-10),
    }
  } finally {
    await client.close()
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      cwd: { type: 'string' },
      log: { type: 'string' },
      prompt: { type: 'string' },
      'session-id': { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'string' },
      'idle-gap': { type: 'string' },
      'cancel-after': { type: 'string' },
      'allow-permissions': { type: 'boolean' },
      'answer-questions': { type: 'boolean' },
      'force-load': { type: 'boolean' },
    },
  })
  const result = await runProbe({
    binary: values.binary ?? process.env.ORRERY_GROK_BIN ?? 'grok',
    cwd: values.cwd
      ? path.resolve(values.cwd)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-probe-')),
    logFile: values.log ? path.resolve(values.log) : undefined,
    prompt: values.prompt,
    sessionId: values['session-id'],
    model: values.model,
    forceLoad: values['force-load'] === true,
    allowPermissions: values['allow-permissions'] === true,
    answerQuestions: values['answer-questions'] === true,
    idleGapMs: (() => {
      const idleGapMs = Number(values['idle-gap'] ?? 250)
      if (!Number.isFinite(idleGapMs) || idleGapMs <= 0) {
        throw new Error('--idle-gap must be a positive number of milliseconds.')
      }
      return idleGapMs
    })(),
    cancelAfterMs: (() => {
      if (values['cancel-after'] === undefined) return undefined
      const cancelAfterMs = Number(values['cancel-after'])
      if (!Number.isFinite(cancelAfterMs) || cancelAfterMs <= 0) {
        throw new Error('--cancel-after must be a positive number of milliseconds.')
      }
      return cancelAfterMs
    })(),
    timeoutMs: (() => {
      const timeoutMs = Number(values.timeout ?? 60_000)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds.')
      }
      return timeoutMs
    })(),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
