import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import {
  cleanupMcpHandoff,
  createMcpHandoff,
  membraneSystemPrompt,
} from '../claudeRuntimeShared.js'
import { GrokAcpClient } from './grokAcpClient.js'
import {
  grokRuntimeEventsFromNotification,
  grokRuntimeEventsFromRequest,
} from './grokRuntimeMapper.js'
import type { GrokAcpMessage } from './grokAcpTypes.js'
import { cachedGrokModelCatalog } from './grokAcpProbeService.js'

const defaultTimeouts = {
  initializeMs: 15_000,
  setupMs: 90_000,
  promptMs: 30 * 60_000,
  replayIdleMs: 250,
  closeGraceMs: 2_000,
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function remaining(deadline: number, label: string) {
  const value = deadline - Date.now()
  if (value <= 0) throw new Error(`Timed out during Grok ${label}.`)
  return value
}

function resumeCursor(sessionId: string) {
  return JSON.stringify({ version: 1, method: 'session/load', sessionId })
}

function promptBlocks(
  prompt: string,
  attachments: any[],
  capabilities: any,
  guidance?: string,
) {
  const blocks: any[] = [
    ...(guidance ? [{ type: 'text', text: guidance }] : []),
    { type: 'text', text: prompt },
  ]
  for (const attachment of attachments ?? []) {
    if (attachment?.kind === 'image') {
      if (capabilities?.image !== true) {
        throw new Error('This Grok ACP runtime does not support image attachments.')
      }
      blocks.push({ type: 'image', data: attachment.dataUrl, mimeType: attachment.mediaType })
      continue
    }
    const header = `Attachment: ${attachment?.name ?? 'unnamed'} (${attachment?.mediaType ?? 'unknown'})`
    blocks.push({
      type: 'text',
      text:
        attachment?.kind === 'text' && typeof attachment.text === 'string'
          ? `${header}\n${attachment.text}`
          : `${header}\nBinary content is not inlined.`,
    })
  }
  return blocks
}

function effectiveRuntimeConfig(
  runtimeSettings: any = {},
  appliedReasoningEffort?: string,
  reasoningSuppressed = false,
) {
  const runtimeMode = runtimeSettings.runtimeMode ?? 'approval-required'
  return {
    providerKind: 'grok',
    runtimeMode,
    modeLabel:
      runtimeSettings.runtimeMode === 'full-access'
        ? 'Full access'
        : runtimeSettings.runtimeMode === 'auto-accept-edits'
          ? 'Auto edits'
          : 'Supervised',
    ...(runtimeSettings.model ? { model: runtimeSettings.model } : {}),
    ...(appliedReasoningEffort
      ? { reasoningEffort: appliedReasoningEffort }
      : {}),
    native: {
      transport: 'acp',
      recovery: 'session/load',
      permissionPolicy:
        runtimeMode === 'full-access'
          ? 'allow-when-wire-option-exists'
          : runtimeMode === 'auto-accept-edits'
            ? 'allow-structured-edit-only'
            : 'prompt',
    },
    notes: [
      'Grok permissions are selected only through same-direction ACP options.',
      ...(runtimeMode === 'auto-accept-edits'
        ? ['Unknown or non-edit tool kinds remain supervised.']
        : []),
      ...(reasoningSuppressed
        ? ['The selected Grok model does not support the requested reasoning effort; the flag was not sent.']
        : []),
    ],
  }
}

function permissionOptionId(message: GrokAcpMessage, decision: string) {
  const expectedKind =
    decision === 'acceptForSession'
      ? 'allow_always'
      : decision === 'accept'
        ? 'allow_once'
        : decision === 'decline'
          ? 'reject_once'
          : undefined
  if (!expectedKind) return undefined
  const option = Array.isArray(message.params?.options)
    ? message.params.options.find((entry: any) => entry?.kind === expectedKind)
    : undefined
  return nonEmptyString(option?.optionId) ? option.optionId.trim() : undefined
}

export function grokPermissionResponseForDecision(
  message: GrokAcpMessage,
  decision: string,
) {
  const optionId = permissionOptionId(message, decision)
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

function automaticPermissionDecision(message: GrokAcpMessage, runtimeSettings: any = {}) {
  if (runtimeSettings.runtimeMode === 'full-access') {
    return permissionOptionId(message, 'acceptForSession')
      ? 'acceptForSession'
      : permissionOptionId(message, 'accept')
        ? 'accept'
        : undefined
  }
  if (
    runtimeSettings.runtimeMode === 'auto-accept-edits' &&
    message.params?.toolCall?.kind === 'edit' &&
    permissionOptionId(message, 'accept')
  ) {
    return 'accept'
  }
  return undefined
}

function questionParams(message: GrokAcpMessage) {
  const params = message.params ?? {}
  return params?.params && Array.isArray(params.params.questions) ? params.params : params
}

function answerValues(value: unknown) {
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => typeof entry === 'string')
    .map((entry) => String(entry).trim())
    .filter(Boolean)
}

export function grokQuestionResponseForAnswer(
  message: GrokAcpMessage,
  answer?: string,
  answers: Record<string, string | string[]> = {},
) {
  const questions = Array.isArray(questionParams(message).questions)
    ? questionParams(message).questions
    : []
  const normalized = questions.flatMap((question: any, index: number) => {
    const questionId = nonEmptyString(question?.id)
      ? question.id.trim()
      : nonEmptyString(question?.question)
        ? question.question.trim()
        : `question-${index + 1}`
    const questionText = nonEmptyString(question?.question)
      ? question.question.trim()
      : `Question ${index + 1}`
    const values = answerValues(answers[questionId] ?? answers[questionText] ?? answer)
    if (values.length === 0) return []
    const options = Array.isArray(question?.options) ? question.options : []
    const resolved = values.map((value) => ({
      value,
      option: options.find(
        (option: any) => option?.id === value || option?.label === value,
      ),
    }))
    const selectedLabels = resolved.flatMap(({ option }: any) =>
      nonEmptyString(option?.label) ? [option.label.trim()] : [],
    )
    const notes = resolved.flatMap(({ option, value }: any) =>
      option ? [] : [value],
    )
    const preview =
      question?.multiSelect === true
        ? undefined
        : resolved
            .map(({ option }: any) =>
              nonEmptyString(option?.preview) ? option.preview.trim() : undefined,
            )
            .find(Boolean)
    return [
      {
        questionText,
        selectedLabels: [
          ...selectedLabels,
          ...(notes.length > 0 ? ['Other'] : []),
        ],
        ...(preview || notes.length > 0
          ? {
              annotation: {
                ...(preview ? { preview } : {}),
                ...(notes.length > 0 ? { notes: notes.join('\n') } : {}),
              },
            }
          : {}),
      },
    ]
  })
  if (normalized.length !== questions.length) return { outcome: 'cancelled' }
  const annotations = Object.fromEntries(
    normalized.flatMap((entry: any) =>
      entry.annotation ? [[entry.questionText, entry.annotation]] : [],
    ),
  )
  return {
    outcome: 'accepted',
    answers: Object.fromEntries(
      normalized.map((entry: any) => [entry.questionText, entry.selectedLabels]),
    ),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  }
}

function mcpServersFromHandoff(handoff: any) {
  if (!handoff?.configPath) return []
  const config = JSON.parse(fs.readFileSync(handoff.configPath, 'utf8'))
  return Object.entries(config?.mcpServers ?? {}).flatMap(([name, value]: any) =>
    nonEmptyString(value?.command)
      ? [
          {
            type: 'stdio',
            name,
            command: value.command,
            args: Array.isArray(value.args) ? value.args : [],
            env: Object.entries(value.env ?? {}).map(([envName, envValue]) => ({
              name: envName,
              value: String(envValue),
            })),
          },
        ]
      : [],
  )
}

export function grokMcpServersFromHandoffForTest(handoff: any) {
  return mcpServersFromHandoff(handoff)
}

export class GrokAcpRun extends EventEmitter {
  #client?: GrokAcpClient
  #closed = false
  #killRequested = false
  #settled = false
  #providerSessionId?: string
  #promptId = randomUUID()
  #orrerySessionId: string
  #turnId: string
  #replaying = false
  #lastReplayUpdateAt = 0
  #timeouts: typeof defaultTimeouts
  #cancelPromise?: Promise<unknown>
  #pendingPermissions = new Map<string, GrokAcpMessage>()
  #pendingQuestions = new Map<string, GrokAcpMessage>()
  #runtimeSettings: any
  #mcpHandoff?: any
  #appliedReasoningEffort?: string
  #reasoningSuppressed = false

  constructor(input: any, timeouts: Partial<typeof defaultTimeouts> = {}) {
    super()
    this.#orrerySessionId = input.sessionId
    this.#turnId = input.turnId
    this.#runtimeSettings = input.runtimeSettings ?? {}
    this.#timeouts = { ...defaultTimeouts, ...timeouts }
    setImmediate(() => void this.#run(input))
  }

  kill() {
    if (this.#closed || this.#killRequested) return false
    this.#killRequested = true
    const client = this.#client
    if (!client) return true
    const cancelRequests = this.#cancelPendingRequests()
    if (this.#providerSessionId) {
      this.#cancelPromise = cancelRequests
        .then(() =>
          client.notify('session/cancel', { sessionId: this.#providerSessionId }),
        )
        .catch(() => undefined)
        .then(() => delay(Math.min(50, this.#timeouts.closeGraceMs)))
        .finally(() => client.close({ graceMs: this.#timeouts.closeGraceMs }))
    } else {
      this.#cancelPromise = cancelRequests.finally(() =>
        client.close({ graceMs: this.#timeouts.closeGraceMs }),
      )
    }
    return true
  }

  respondRuntimeRequest({ requestId, decision }: any) {
    const key = String(requestId)
    const message = this.#pendingPermissions.get(key)
    if (!message) throw new Error(`Unknown Grok ACP runtime request: ${requestId}`)
    this.#pendingPermissions.delete(key)
    const response = grokPermissionResponseForDecision(message, decision)
    void this.#client
      ?.respond(message.id!, response)
      .catch(() => undefined)
    return {
      decision:
        response.outcome.outcome === 'selected' ? decision : 'cancel',
    }
  }

  answerUserInput({ requestId, answer, answers }: any) {
    const key = String(requestId)
    const message = this.#pendingQuestions.get(key)
    if (!message) throw new Error(`Unknown Grok ACP user input request: ${requestId}`)
    this.#pendingQuestions.delete(key)
    const response = grokQuestionResponseForAnswer(message, answer, answers)
    void this.#client
      ?.respond(message.id!, response)
      .catch(() => undefined)
    return { outcome: response.outcome }
  }

  async #run(input: any) {
    let code = 0
    let signal: NodeJS.Signals | null = null
    const setupDeadline = Date.now() + this.#timeouts.setupMs
    try {
      if (this.#killRequested) throw new Error('Grok turn was cancelled before start.')
      if (input.runtimeSettings?.reasoningEffort === 'xhigh') {
        throw new Error('Grok does not support xhigh reasoning effort.')
      }
      const catalog = cachedGrokModelCatalog(input.providerInstance, input.cwd)
      const selectedModelId = input.runtimeSettings?.model ?? catalog?.currentModelId
      const selectedModel = catalog?.availableModels.find(
        (model) => model.modelId === selectedModelId,
      )
      const requestedEffort = input.runtimeSettings?.reasoningEffort
      this.#reasoningSuppressed = Boolean(
        requestedEffort &&
          selectedModel &&
          (selectedModel.supportsReasoningEffort === false ||
            (Array.isArray(selectedModel.reasoningEfforts) &&
              !selectedModel.reasoningEfforts.includes(requestedEffort))),
      )
      this.#appliedReasoningEffort = this.#reasoningSuppressed
        ? undefined
        : requestedEffort
      this.#client = new GrokAcpClient({
        cwd: input.cwd,
        providerInstance: input.providerInstance,
        agentArgs: this.#appliedReasoningEffort
          ? ['--reasoning-effort', this.#appliedReasoningEffort]
          : [],
      })
      if (input.membrane) {
        this.#mcpHandoff = createMcpHandoff(input.membrane, { keepBootstrap: true })
      }
      const mcpServers = mcpServersFromHandoff(this.#mcpHandoff)
      this.#wireClient()
      const initialize: any = await this.#client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'orrery', title: 'Orrery', version: '0.0.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        {
          timeoutMs: Math.min(
            this.#timeouts.initializeMs,
            remaining(setupDeadline, 'initialize'),
          ),
        },
      )
      const authMethod =
        nonEmptyString(input.providerInstance?.env?.XAI_API_KEY) ||
        nonEmptyString(process.env.XAI_API_KEY)
          ? 'xai.api_key'
          : 'cached_token'
      await this.#client.request(
        'authenticate',
        { methodId: authMethod },
        {
          timeoutMs: Math.min(
            this.#timeouts.initializeMs,
            remaining(setupDeadline, 'authenticate'),
          ),
        },
      )
      this.emit('providerEvent', {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: 'runtime.configured',
        sessionId: this.#orrerySessionId,
        effectiveRuntimeConfig: effectiveRuntimeConfig(
          input.runtimeSettings,
          this.#appliedReasoningEffort,
          this.#reasoningSuppressed,
        ),
      })

      let setup: any
      if (nonEmptyString(input.backendSessionId)) {
        this.#providerSessionId = input.backendSessionId
        if (initialize?.agentCapabilities?.loadSession !== true) {
          throw new Error('This Grok ACP runtime does not support session/load recovery.')
        }
        this.#replaying = true
        this.#lastReplayUpdateAt = Date.now()
        setup = await this.#client.request(
          'session/load',
          { sessionId: input.backendSessionId, cwd: input.cwd, mcpServers },
          { timeoutMs: remaining(setupDeadline, 'session/load') },
        )
        this.#lastReplayUpdateAt = Date.now()
        await this.#waitForReplayIdle(setupDeadline)
        this.#replaying = false
      } else {
        setup = await this.#client.request(
          'session/new',
          { cwd: input.cwd, mcpServers },
          { timeoutMs: remaining(setupDeadline, 'session/new') },
        )
      }
      this.#providerSessionId = setup?.sessionId ?? input.backendSessionId
      if (!nonEmptyString(this.#providerSessionId)) {
        throw new Error('Grok session setup returned no session id.')
      }
      this.emit('providerSession', {
        providerSessionId: this.#providerSessionId,
        resumeCursor: resumeCursor(this.#providerSessionId),
      })
      if (this.#killRequested) throw new Error('Grok turn was cancelled.')

      const requestedModel = input.runtimeSettings?.model
      if (
        nonEmptyString(requestedModel) &&
        requestedModel !== setup?.models?.currentModelId
      ) {
        await this.#client.request(
          'session/set_model',
          { sessionId: this.#providerSessionId, modelId: requestedModel },
          { timeoutMs: remaining(setupDeadline, 'session/set_model') },
        )
      }

      const blocks = promptBlocks(
        input.prompt,
        input.attachments,
        initialize?.agentCapabilities?.promptCapabilities ?? initialize?.promptCapabilities,
        !input.backendSessionId && this.#mcpHandoff ? membraneSystemPrompt() : undefined,
      )
      const completion = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for Grok prompt completion.')),
          this.#timeouts.promptMs,
        )
        const settle = (error?: unknown, result?: any) => {
          if (this.#settled) return
          this.#settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(result)
        }
        this.once('privateCompletion', (result) => settle(undefined, result))
        this.#client!
          .request(
            'session/prompt',
            {
              sessionId: this.#providerSessionId,
              prompt: blocks,
              _meta: { promptId: this.#promptId, requestId: this.#promptId },
            },
            { timeoutMs: this.#timeouts.promptMs },
          )
          .then((result) => settle(undefined, result))
          .catch((error) => settle(error))
      })
      const result = await completion
      if (!this.#killRequested) {
        this.emit('result', {
          session_id: this.#providerSessionId,
          result: result?.agentResult ?? result?.stopReason ?? 'done',
        })
      }
    } catch (error) {
      if (this.#killRequested) {
        signal = 'SIGTERM'
      } else {
        code = 1
        this.emit('error', error)
      }
    } finally {
      this.#closed = true
      await this.#cancelPendingRequests()
      if (this.#client) {
        if (this.#killRequested && this.#cancelPromise) {
          await this.#cancelPromise
        } else {
          this.#client.close({ graceMs: this.#timeouts.closeGraceMs })
        }
        await Promise.race([
          this.#client.waitForClose(),
          delay(this.#timeouts.closeGraceMs + 250),
        ])
      }
      cleanupMcpHandoff(this.#mcpHandoff)
      this.#mcpHandoff = undefined
      this.emit('close', { code, signal, killed: this.#killRequested })
    }
  }

  #wireClient() {
    this.#client!.on('message', (message) => this.#emitNative(message))
    this.#client!.on('stderr', (line) => this.emit('stderr', line))
    this.#client!.on('notification', (message) => this.#handleNotification(message))
    this.#client!.on('request', (message) => this.#handleRequest(message))
  }

  #emitNative(message: GrokAcpMessage) {
    this.emit('native', {
      ts: new Date().toISOString(),
      providerKind: 'grok',
      turnId: this.#turnId,
      raw: {
        source: message.method
          ? message.id !== undefined
            ? message.method.startsWith('_x.ai/')
              ? 'grok.xai.extension'
              : 'grok.acp.request'
            : message.method.startsWith('_x.ai/')
              ? 'grok.xai.extension'
              : 'grok.acp.notification'
          : 'grok.acp.response',
        method: message.method,
        payload: message,
      },
    })
  }

  #handleNotification(message: GrokAcpMessage) {
    if (this.#replaying && message.method === 'session/update') {
      this.#lastReplayUpdateAt = Date.now()
    }
    for (const event of grokRuntimeEventsFromNotification({
      sessionId: this.#orrerySessionId,
      turnId: this.#turnId,
      message,
    })) {
      if (message.method !== '_x.ai/session/prompt_complete') {
        this.emit('providerEvent', event)
      }
    }
    if (
      message.method === '_x.ai/session/prompt_complete' &&
      (!message.params?.promptId || message.params.promptId === this.#promptId)
    ) {
      this.emit('privateCompletion', message.params)
    }
  }

  #handleRequest(message: GrokAcpMessage) {
    if (message.id === undefined) return
    if (message.method === 'session/request_permission') {
      const automaticDecision = automaticPermissionDecision(
        message,
        this.#runtimeSettings,
      )
      if (automaticDecision) {
        void this.#client
          ?.respond(
            message.id,
            grokPermissionResponseForDecision(message, automaticDecision),
          )
          .catch(() => undefined)
        return
      }
      this.#pendingPermissions.set(String(message.id), message)
      for (const event of grokRuntimeEventsFromRequest({
        sessionId: this.#orrerySessionId,
        turnId: this.#turnId,
        message,
      })) {
        this.emit('providerEvent', event)
      }
      return
    }
    if (
      message.method === 'x.ai/ask_user_question' ||
      message.method === '_x.ai/ask_user_question'
    ) {
      this.#pendingQuestions.set(String(message.id), message)
      for (const event of grokRuntimeEventsFromRequest({
        sessionId: this.#orrerySessionId,
        turnId: this.#turnId,
        message,
      })) {
        this.emit('providerEvent', event)
      }
      return
    }
    void this.#client
      ?.respondError(message.id, -32601, `Method '${message.method}' is not supported by Orrery.`)
      .catch(() => undefined)
  }

  async #cancelPendingRequests() {
    for (const [requestId, message] of this.#pendingPermissions) {
      this.emit('providerEvent', {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: 'request.resolved',
        sessionId: this.#orrerySessionId,
        requestId,
        status: 'canceled',
        raw: {
          source: 'grok.acp.request',
          method: message.method,
          payload: message,
        },
      })
    }
    for (const [requestId, message] of this.#pendingQuestions) {
      this.emit('providerEvent', {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: 'user-input.resolved',
        sessionId: this.#orrerySessionId,
        requestId,
        status: 'canceled',
        raw: {
          source: 'grok.xai.extension',
          method: message.method,
          payload: message,
        },
      })
    }
    const responses = [
      ...[...this.#pendingPermissions.values()].map((message) =>
        this.#client?.respond(message.id!, { outcome: { outcome: 'cancelled' } }),
      ),
      ...[...this.#pendingQuestions.values()].map((message) =>
        this.#client?.respond(message.id!, { outcome: 'cancelled' }),
      ),
    ]
    this.#pendingPermissions.clear()
    this.#pendingQuestions.clear()
    await Promise.all(responses.map((response) => response?.catch(() => undefined)))
  }

  async #waitForReplayIdle(deadline: number) {
    while (true) {
      const quietFor = Date.now() - this.#lastReplayUpdateAt
      if (quietFor >= this.#timeouts.replayIdleMs) return
      await delay(
        Math.min(this.#timeouts.replayIdleMs - quietFor, remaining(deadline, 'replay')),
      )
    }
  }
}

export class GrokAcpAdapter {
  kind = 'grok'
  #timeouts: Partial<typeof defaultTimeouts>
  #runs = new Set<GrokAcpRun>()

  constructor({ timeouts = {} }: { timeouts?: Partial<typeof defaultTimeouts> } = {}) {
    this.#timeouts = timeouts
  }

  startTurn(input: any) {
    const run = new GrokAcpRun(input, this.#timeouts)
    this.#runs.add(run)
    run.once('close', () => this.#runs.delete(run))
    return run
  }

  closeAll() {
    for (const run of this.#runs) run.kill()
  }
}
