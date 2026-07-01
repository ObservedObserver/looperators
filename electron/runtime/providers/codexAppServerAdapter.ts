import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { CodexJsonRpcClient } from './codexJsonRpcClient.js'
import {
  codexRuntimeEventsFromMessage,
  codexRuntimeEventsFromRequest,
} from './codexRuntimeMapper.js'

type RuntimeSettings = Record<string, any>

function runtimeModeToCodexConfig(runtimeSettings: RuntimeSettings = {}) {
  if (runtimeSettings.approvalPolicy && runtimeSettings.sandbox) {
    return {
      approvalPolicy: runtimeSettings.approvalPolicy,
      sandbox: runtimeSettings.sandbox,
    }
  }

  switch (runtimeSettings.runtimeMode) {
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      }
    case 'auto-accept-edits':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      }
    case 'approval-required':
    default:
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
      }
  }
}

function codexModeLabel(runtimeSettings: RuntimeSettings = {}) {
  switch (runtimeSettings.runtimeMode) {
    case 'full-access':
      return 'Full access'
    case 'auto-accept-edits':
      return 'Auto edits'
    case 'approval-required':
    default:
      return 'Supervised'
  }
}

function effectiveCodexRuntimeConfig(runtimeSettings: RuntimeSettings = {}) {
  const config = runtimeModeToCodexConfig(runtimeSettings)
  return {
    providerKind: 'codex',
    runtimeMode: runtimeSettings.runtimeMode ?? 'approval-required',
    modeLabel: codexModeLabel(runtimeSettings),
    ...(runtimeSettings?.model ? { model: runtimeSettings.model } : {}),
    ...(runtimeSettings?.reasoningEffort
      ? { reasoningEffort: runtimeSettings.reasoningEffort }
      : {}),
    native: {
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
      ...(runtimeSettings?.serviceTier
        ? { serviceTier: runtimeSettings.serviceTier }
        : {}),
    },
  }
}

function sandboxPolicyForCodex(sandbox, cwd) {
  switch (sandbox) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    case 'read-only':
    default:
      return { type: 'readOnly', networkAccess: false }
  }
}

function threadStartParams({ cwd, runtimeSettings }) {
  const config = runtimeModeToCodexConfig(runtimeSettings)
  return {
    cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    threadSource: 'user',
    sessionStartSource: 'startup',
    serviceName: 'Orrery',
    ...(runtimeSettings?.model ? { model: runtimeSettings.model } : {}),
    ...(runtimeSettings?.serviceTier
      ? { serviceTier: runtimeSettings.serviceTier }
      : {}),
  }
}

function codexAttachmentText(attachment) {
  const header = [
    `Attachment: ${attachment.name}`,
    `Type: ${attachment.mediaType}`,
    `Size: ${attachment.size} bytes`,
    `Kind: ${attachment.kind}`,
  ].join('\n')

  if (attachment.kind === 'text' && typeof attachment.text === 'string') {
    return `${header}\nText content${
      attachment.truncated ? ' (truncated)' : ''
    }:\n${attachment.text}`
  }

  return `${header}\nContent not inlined; only metadata is available.`
}

function codexInputItems({ prompt, attachments = [] }) {
  const input: any[] = [{ type: 'text', text: prompt, text_elements: [] }]

  for (const attachment of attachments) {
    if (attachment?.kind === 'image' && typeof attachment.dataUrl === 'string') {
      input.push({
        type: 'image',
        url: attachment.dataUrl,
      })
      continue
    }

    input.push({
      type: 'text',
      text: codexAttachmentText(attachment),
      text_elements: [],
    })
  }

  return input
}

export function codexInputItemsForTest(input) {
  return codexInputItems(input)
}

function turnStartParams({ threadId, prompt, attachments, cwd, runtimeSettings }) {
  const config = runtimeModeToCodexConfig(runtimeSettings)
  return {
    threadId,
    input: codexInputItems({ prompt, attachments }),
    cwd,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: sandboxPolicyForCodex(config.sandbox, cwd),
    ...(runtimeSettings?.model ? { model: runtimeSettings.model } : {}),
    ...(runtimeSettings?.serviceTier
      ? { serviceTier: runtimeSettings.serviceTier }
      : {}),
    ...(runtimeSettings?.reasoningEffort
      ? { effort: runtimeSettings.reasoningEffort }
      : {}),
  }
}

function autoResponseForRequest(message) {
  switch (message.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'item/permissions/requestApproval':
      return {
        permissions: {},
        scope: 'turn',
        strictAutoReview: false,
      }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    default:
      return {}
  }
}

function approvalResponseForDecision(message, decision) {
  const normalizedDecision =
    decision === 'approved' ? 'accept' : decision === 'denied' ? 'decline' : decision
  if (message.method === 'item/permissions/requestApproval') {
    if (normalizedDecision !== 'accept' && normalizedDecision !== 'acceptForSession') {
      return {
        permissions: {},
        scope: 'turn',
        strictAutoReview: false,
      }
    }

    return {
      permissions:
        message.params?.permissions && typeof message.params.permissions === 'object'
          ? message.params.permissions
          : {},
      scope:
        normalizedDecision === 'acceptForSession'
          ? 'session'
          : typeof message.params?.scope === 'string'
            ? message.params.scope
            : 'turn',
      strictAutoReview: false,
    }
  }

  if (normalizedDecision === 'accept') {
    return { decision: 'accept' }
  }
  if (normalizedDecision === 'acceptForSession') {
    return { decision: 'acceptForSession' }
  }
  if (normalizedDecision === 'cancel') {
    return { decision: 'cancel' }
  }
  return { decision: 'decline' }
}

export function codexApprovalResponseForTest(message, decision) {
  return approvalResponseForDecision(message, decision)
}

function codexQuestionId(question, index) {
  if (typeof question?.id === 'string' && question.id.length > 0) {
    return question.id
  }
  if (typeof question?.questionId === 'string' && question.questionId.length > 0) {
    return question.questionId
  }
  return String(index)
}

function codexQuestionLabel(question, index) {
  return typeof question?.question === 'string' && question.question.trim().length > 0
    ? question.question.trim()
    : `Question ${index + 1}`
}

function userInputAnswerValues(question, index, answer, answers) {
  const questionId = codexQuestionId(question, index)
  const value = answers?.[questionId] ?? answers?.[codexQuestionLabel(question, index)] ?? answer
  if (Array.isArray(value)) {
    return value.map((item) => String(item))
  }
  if (typeof value === 'string') {
    return [value]
  }
  return ['']
}

function userInputResponseForAnswer(message, answer, answersByQuestion) {
  const questions = Array.isArray(message.params?.questions)
    ? message.params.questions
    : []
  const answers = {}

  for (const [index, question] of questions.entries()) {
    const questionId = codexQuestionId(question, index)
    answers[questionId] = {
      answers: userInputAnswerValues(question, index, answer, answersByQuestion),
    }
  }

  return { answers }
}

export function codexUserInputResponseForTest(message, answer, answers) {
  return userInputResponseForAnswer(message, answer, answers)
}

function rawEnvelope(message) {
  return {
    source: 'codex.app-server.request',
    method: message.method,
    payload: message,
  }
}

const requestTimeoutMs = 30 * 60 * 1000

export class CodexAppServerRun extends EventEmitter {
  #client
  #closed = false
  #killRequested = false
  #threadId
  #codexTurnId
  #orreryTurnId
  #sessionId
  #turnCompleted = false
  #pendingRequests = new Map()
  #providerInstance

  constructor({
    prompt,
    cwd,
    backendSessionId,
    sessionId,
    turnId,
    runtimeSettings,
    attachments,
    providerInstance,
  }) {
    super()
    this.#threadId = backendSessionId
    this.#orreryTurnId = turnId
    this.#sessionId = sessionId
    this.#providerInstance = providerInstance
    void this.#run({ prompt, attachments, cwd, runtimeSettings })
  }

  kill() {
    if (this.#closed) {
      return false
    }

    this.#killRequested = true
    if (this.#threadId && this.#codexTurnId) {
      void this.#client
        ?.request(
          'turn/interrupt',
          { threadId: this.#threadId, turnId: this.#codexTurnId },
          { timeoutMs: 5000 }
        )
        .catch(() => undefined)
    }
    this.#client?.close()
    return true
  }

  respondRuntimeRequest({ requestId, decision }) {
    const entry = this.#pendingRequests.get(String(requestId))
    if (!entry) {
      throw new Error(`Unknown Codex runtime request: ${requestId}`)
    }

    this.#resolvePendingRequest(
      entry,
      approvalResponseForDecision(entry.message, decision)
    )
  }

  answerUserInput({ requestId, answer, answers }) {
    const entry = this.#pendingRequests.get(String(requestId))
    if (!entry) {
      throw new Error(`Unknown Codex user input request: ${requestId}`)
    }

    this.#resolvePendingRequest(
      entry,
      userInputResponseForAnswer(entry.message, answer, answers)
    )
  }

  async #run({ prompt, attachments, cwd, runtimeSettings }) {
    let code = 0
    let signal = null

    try {
      this.#client = new CodexJsonRpcClient({
        cwd,
        providerInstance: this.#providerInstance,
      })
      this.#wireClient()
      await this.#client.request(
        'initialize',
        {
          clientInfo: {
            name: 'orrery',
            title: 'Orrery',
            version: '0.0.0',
          },
          capabilities: null,
        },
        { timeoutMs: 15000 }
      )
      this.emit('providerEvent', {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: 'runtime.configured',
        sessionId: this.#sessionId,
        effectiveRuntimeConfig: effectiveCodexRuntimeConfig(runtimeSettings),
      })

      const threadResult = this.#threadId
        ? await this.#client.request(
            'thread/resume',
            {
              ...threadStartParams({ cwd, runtimeSettings }),
              threadId: this.#threadId,
            },
            { timeoutMs: 60000 }
          )
        : await this.#client.request(
            'thread/start',
            threadStartParams({ cwd, runtimeSettings }),
            {
              timeoutMs: 90000,
            }
          )

      this.#threadId = threadResult?.thread?.id ?? this.#threadId
      if (this.#threadId) {
        this.emit('providerSession', { providerSessionId: this.#threadId })
      }

      const turnResult = await this.#client.request(
        'turn/start',
        turnStartParams({
          threadId: this.#threadId,
          prompt,
          attachments,
          cwd,
          runtimeSettings,
        }),
        { timeoutMs: 30000 }
      )
      this.#codexTurnId = turnResult?.turn?.id

      if (!this.#turnCompleted) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Timed out waiting for Codex turn completion.')),
            30 * 60 * 1000
          )
          this.once('turnCompleted', () => {
            clearTimeout(timeout)
            resolve()
          })
          this.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
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
      this.#clearPendingRequests()
      this.#client?.close()
      this.emit('close', {
        code,
        signal,
        killed: this.#killRequested,
      })
    }
  }

  #wireClient() {
    this.#client.on('message', (message) => this.#emitNative(message))
    this.#client.on('stderr', (data) => this.emit('stderr', data))
    this.#client.on('error', (error) => this.emit('error', error))
    this.#client.on('notification', (message) => this.#handleNotification(message))
    this.#client.on('request', (message) => this.#handleRequest(message))
  }

  #emitNative(message) {
    this.emit('native', {
      ts: new Date().toISOString(),
      providerKind: 'codex',
      turnId: this.#orreryTurnId,
      raw: {
        source: message.method
          ? Object.hasOwn(message, 'id')
            ? 'codex.app-server.request'
            : 'codex.app-server.notification'
          : 'codex.app-server.notification',
        method: message.method,
        payload: message,
      },
    })
  }

  #handleNotification(message) {
    if (message.method === 'turn/started') {
      this.#codexTurnId = message.params?.turn?.id ?? this.#codexTurnId
    }

    for (const event of codexRuntimeEventsFromMessage({
      sessionId: this.#sessionId,
      turnId: this.#orreryTurnId,
      message,
    })) {
      this.emit('providerEvent', event)
    }

    if (message.method === 'turn/completed') {
      this.#turnCompleted = true
      this.emit('turnCompleted')
    }
  }

  #handleRequest(message) {
    const events = codexRuntimeEventsFromRequest({
      sessionId: this.#sessionId,
      turnId: this.#orreryTurnId,
      message,
    })
    for (const event of events) {
      this.emit('providerEvent', event)
    }

    if (events.length === 0) {
      this.#client.respond(message.id, autoResponseForRequest(message))
      return
    }

    const requestId = String(message.id)
    const timeout = setTimeout(() => {
      const entry = this.#pendingRequests.get(requestId)
      if (!entry) {
        return
      }

      this.#resolvePendingRequest(entry, autoResponseForRequest(message), {
        timedOut: true,
      })
    }, requestTimeoutMs)

    this.#pendingRequests.set(requestId, {
      id: requestId,
      message,
      timeout,
    })
  }

  #resolvePendingRequest(entry, result, { timedOut = false } = {}) {
    if (!this.#pendingRequests.has(entry.id)) {
      return
    }

    clearTimeout(entry.timeout)
    this.#pendingRequests.delete(entry.id)
    this.#client.respond(entry.message.id, result)

    if (!timedOut) {
      return
    }

    const ts = new Date().toISOString()
    if (entry.message.method === 'item/tool/requestUserInput') {
      this.emit('providerEvent', {
        id: randomUUID(),
        ts,
        type: 'user-input.answered',
        sessionId: this.#sessionId,
        requestId: entry.id,
        answer: '',
        raw: rawEnvelope(entry.message),
      })
      return
    }

    this.emit('providerEvent', {
      id: randomUUID(),
      ts,
      type: 'request.resolved',
      sessionId: this.#sessionId,
      requestId: entry.id,
      status: 'denied',
      raw: rawEnvelope(entry.message),
    })
  }

  #clearPendingRequests() {
    for (const entry of this.#pendingRequests.values()) {
      clearTimeout(entry.timeout)
    }
    this.#pendingRequests.clear()
  }
}

export class CodexAppServerAdapter {
  kind = 'codex'

  startTurn(input) {
    return new CodexAppServerRun(input)
  }
}
