import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import {
  buildPath,
  claudeCommand,
  cleanupMcpHandoff,
  createMcpHandoff,
  expandHomePath,
  membraneSystemPrompt,
  membraneToolNames,
} from '../claudeRuntimeShared.js'
import { claudeRuntimeEventsFromMessage } from './claudeRuntimeMapper.js'

/**
 * @typedef {'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'} ClaudePermissionMode
 */

function sdkMessageType(message) {
  if (message?.type === 'stream_event' && typeof message.event?.type === 'string') {
    return `${message.type}:${message.event.type}`
  }

  return message?.subtype ? `${message.type}:${message.subtype}` : message?.type
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function providerExtraArgs(providerInstance) {
  const args = Array.isArray(providerInstance?.launchArgs)
    ? providerInstance.launchArgs.filter(nonEmptyString).map((arg) => arg.trim())
    : []
  const extraArgs = {}
  const extraArgName = (arg) => {
    const normalized = arg.replace(/^-+/, '').trim()
    return normalized.length > 0 ? normalized : undefined
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const equalsIndex = arg.indexOf('=')
    if (equalsIndex > 0) {
      const name = extraArgName(arg.slice(0, equalsIndex))
      if (name) {
        extraArgs[name] = arg.slice(equalsIndex + 1)
      }
      continue
    }

    const name = extraArgName(arg)
    if (!name) {
      continue
    }
    const nextArg = args[index + 1]
    if (nextArg && !nextArg.startsWith('-')) {
      extraArgs[name] = nextArg
      index += 1
      continue
    }

    extraArgs[name] = null
  }

  return Object.keys(extraArgs).length > 0 ? extraArgs : undefined
}

function providerEnv(providerInstance) {
  const homePath = expandHomePath(providerInstance?.homePath)
  return {
    ...process.env,
    ...(providerInstance?.env ?? {}),
    PATH: buildPath(),
    NO_COLOR: '1',
    ...(homePath ? { HOME: homePath } : {}),
  }
}

function providerClaudeCommand(providerInstance) {
  return nonEmptyString(providerInstance?.binaryPath)
    ? providerInstance.binaryPath.trim()
    : claudeCommand()
}

/**
 * @returns {ClaudePermissionMode}
 */
export function claudePermissionModeForRuntime(runtimeSettings) {
  const settings = runtimeSettings ?? {}
  switch (settings.runtimeMode) {
    case 'full-access':
      return 'bypassPermissions'
    case 'auto-accept-edits':
      return 'acceptEdits'
    case 'approval-required':
    default:
      return 'default'
  }
}

function claudeModeLabel(runtimeSettings) {
  const settings = runtimeSettings ?? {}
  switch (settings.runtimeMode) {
    case 'full-access':
      return 'Full access'
    case 'auto-accept-edits':
      return 'Auto edits'
    case 'approval-required':
    default:
      return 'Supervised'
  }
}

/**
 * @returns {{
 *   permissionMode: ClaudePermissionMode,
 *   allowDangerouslySkipPermissions?: boolean
 * }}
 */
export function claudeRuntimeOptions(runtimeSettings) {
  const permissionMode = claudePermissionModeForRuntime(runtimeSettings)
  if (permissionMode === 'bypassPermissions') {
    return /** @type {{ permissionMode: ClaudePermissionMode, allowDangerouslySkipPermissions?: boolean }} */ ({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
  }
  if (permissionMode === 'acceptEdits') {
    return /** @type {{ permissionMode: ClaudePermissionMode, allowDangerouslySkipPermissions?: boolean }} */ ({
      permissionMode: 'acceptEdits',
    })
  }
  return /** @type {{ permissionMode: ClaudePermissionMode, allowDangerouslySkipPermissions?: boolean }} */ ({
    permissionMode: 'default',
  })
}

export function effectiveClaudeRuntimeConfig(runtimeSettings) {
  const settings = runtimeSettings ?? {}
  const native = claudeRuntimeOptions(runtimeSettings)
  return {
    providerKind: 'claude-code',
    runtimeMode: settings.runtimeMode ?? 'approval-required',
    modeLabel: claudeModeLabel(settings),
    ...(nonEmptyString(settings.model)
      ? { model: settings.model.trim() }
      : {}),
    native,
    notes: [
      'Claude Code permissions are implemented through Claude SDK permissionMode.',
    ],
  }
}

function isClaudeEditTool(toolName) {
  return [
    'Edit',
    'MultiEdit',
    'Write',
    'NotebookEdit',
  ].includes(String(toolName))
}

/**
 * @param {{ toolUseID?: string }} [options]
 * @param {Record<string, unknown>} [toolInput]
 */
export function automaticClaudePermissionResult(
  runtimeSettings,
  toolName,
  options,
  toolInput
) {
  const sdkOptions = options ?? {}
  // The SDK's runtime validation requires `updatedInput` on allow results
  // even though the type marks it optional; echo the original input.
  const allow = {
    behavior: 'allow',
    updatedInput: toolInput ?? {},
    toolUseID: sdkOptions.toolUseID,
    decisionClassification: 'user_permanent',
  }
  // Membrane tools are the sanctioned control surface: the bridge token
  // already authenticates the session, and headless runs cannot answer
  // permission prompts. Without this exemption, the first gate=master approval
  // (approve_activation via the SDK provider) wedges on an unanswerable
  // canUseTool request.
  if (membraneToolNames.includes(String(toolName))) {
    return allow
  }
  const runtimeMode = runtimeSettings?.runtimeMode ?? 'approval-required'
  if (
    runtimeMode === 'full-access' ||
    (runtimeMode === 'auto-accept-edits' && isClaudeEditTool(toolName))
  ) {
    return allow
  }
  return undefined
}

function sdkMessageForRuntimeMapper(message) {
  if (message?.type === 'stream_event') {
    return {
      type: 'stream_event',
      event: message.event,
      session_id: message.session_id,
    }
  }

  return message
}

function mcpServersFromHandoff(handoff) {
  if (!handoff?.configPath) {
    return undefined
  }

  const config = JSON.parse(fs.readFileSync(handoff.configPath, 'utf8'))
  return config.mcpServers
}

function dataUrlImageSource(dataUrl, fallbackMediaType) {
  if (typeof dataUrl !== 'string') {
    return undefined
  }

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) {
    return undefined
  }

  return {
    type: 'base64',
    media_type: match[1] || fallbackMediaType || 'image/png',
    data: match[2],
  }
}

function attachmentTextBlock(attachment) {
  const header = [
    `Attachment: ${attachment.name}`,
    `Type: ${attachment.mediaType}`,
    `Size: ${attachment.size} bytes`,
    `Kind: ${attachment.kind}`,
  ].join('\n')

  if (attachment.kind === 'text' && typeof attachment.text === 'string') {
    return {
      type: 'text',
      text: `${header}\nText content${
        attachment.truncated ? ' (truncated)' : ''
      }:\n${attachment.text}`,
    }
  }

  return {
    type: 'text',
    text: `${header}\nContent not inlined; only metadata is available.`,
  }
}

function sdkContentBlocks(prompt, attachments = []) {
  const blocks: any[] = [{ type: 'text', text: prompt }]

  for (const attachment of attachments) {
    if (attachment?.kind === 'image') {
      const source = dataUrlImageSource(attachment.dataUrl, attachment.mediaType)
      if (source) {
        blocks.push({
          type: 'image',
          source,
        })
        continue
      }
    }

    blocks.push(attachmentTextBlock(attachment))
  }

  return blocks
}

function sdkUserMessage(prompt, attachments = []) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: sdkContentBlocks(prompt, attachments),
    },
    timestamp: new Date().toISOString(),
  }
}

function contentBlocksFromSdkMessage(message) {
  const content = message?.message?.content
  return Array.isArray(content) ? content : []
}

function planItemsFromText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, '').trim())
    .filter(Boolean)
    .map((title, index) => ({
      id: `plan-item-${index + 1}`,
      title,
      status: 'pending',
    }))
}

function questionLabel(question, index) {
  return typeof question?.question === 'string' && question.question.trim().length > 0
    ? question.question.trim()
    : `Question ${index + 1}`
}

function questionId(question, index) {
  if (typeof question?.id === 'string' && question.id.trim().length > 0) {
    return question.id.trim()
  }
  if (
    typeof question?.questionId === 'string' &&
    question.questionId.trim().length > 0
  ) {
    return question.questionId.trim()
  }
  return questionLabel(question, index)
}

function questionOptions(question) {
  if (!Array.isArray(question?.options)) {
    return undefined
  }

  const options = question.options
    .map((option) => {
      const label =
        typeof option?.label === 'string' && option.label.trim().length > 0
          ? option.label.trim()
          : undefined
      if (!label) {
        return undefined
      }

      return {
        id:
          typeof option?.id === 'string' && option.id.trim().length > 0
            ? option.id.trim()
            : label,
        label,
        ...(typeof option?.description === 'string' &&
        option.description.trim().length > 0
          ? { description: option.description.trim() }
          : {}),
      }
    })
    .filter(Boolean)

  return options.length > 0 ? options : undefined
}

function questionPromptLine(question, index) {
  const header =
    typeof question?.header === 'string' && question.header.trim().length > 0
      ? `${question.header.trim()}: `
      : ''
  const options = Array.isArray(question?.options)
    ? question.options
        .map((option) =>
          typeof option?.label === 'string' && option.label.trim().length > 0
            ? option.label.trim()
            : undefined
        )
        .filter(Boolean)
    : []
  const optionText = options.length > 0 ? ` Options: ${options.join(', ')}` : ''
  const multiSelectText = question?.multiSelect === true ? ' [multi-select]' : ''

  return `${index + 1}. ${header}${questionLabel(question, index)}${multiSelectText}${optionText}`
}

function askUserQuestions(payload) {
  return Array.isArray(payload?.questions) ? payload.questions : []
}

function normalizedUserInputQuestions(payload) {
  return askUserQuestions(payload).map((question, index) => ({
    id: questionId(question, index),
    label: questionLabel(question, index),
    ...(typeof question?.header === 'string' && question.header.trim().length > 0
      ? { header: question.header.trim() }
      : {}),
    ...(typeof question?.placeholder === 'string' &&
    question.placeholder.trim().length > 0
      ? { placeholder: question.placeholder.trim() }
      : {}),
    ...(question?.multiSelect === true ? { multiSelect: true } : {}),
    ...(question?.isSecret === true ? { isSecret: true } : {}),
    ...(questionOptions(question) ? { options: questionOptions(question) } : {}),
  }))
}

function userDialogPrompt({ request }) {
  const questions = askUserQuestions(request.payload)
  if (questions.length === 0) {
    return {
      prompt:
        typeof request.payload?.question === 'string'
          ? request.payload.question
          : typeof request.payload?.prompt === 'string'
            ? request.payload.prompt
            : `${request.dialogKind} requested input.`,
      placeholder: 'Answer for Claude',
    }
  }

  const lines = questions.map((question, index) => questionPromptLine(question, index))
  const isComplex =
    questions.length > 1 ||
    questions.some(
      (question) =>
        question?.multiSelect === true ||
        (Array.isArray(question?.options) && question.options.length > 0)
    )

  if (!isComplex) {
    return {
      prompt: lines[0]?.replace(/^1\. /, '') ?? 'Claude requested user input.',
      placeholder: 'Answer for Claude',
    }
  }

  return {
    prompt: [
      `Claude requested ${questions.length} inputs.`,
      '',
      ...lines,
    ].join('\n'),
    placeholder: 'Answer for Claude',
  }
}

function answerValueForQuestion(question, index, answer, answers) {
  const id = questionId(question, index)
  const label = questionLabel(question, index)
  const value = answers?.[id] ?? answers?.[label] ?? answer ?? ''
  return Array.isArray(value) ? value.join(', ') : String(value)
}

function firstAnswerValue(answer, answers) {
  if (typeof answer === 'string') {
    return answer
  }
  const value = Object.values(answers ?? {})[0]
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  return typeof value === 'string' ? value : ''
}

function userDialogResultForAnswer(request, answer, answers) {
  const questions = askUserQuestions(request.payload)
  if (questions.length === 0) {
    return firstAnswerValue(answer, answers)
  }

  return {
    questions,
    answers: Object.fromEntries(
      questions.map((question, index) => [
        questionLabel(question, index),
        answerValueForQuestion(question, index, answer, answers),
      ])
    ),
    response: firstAnswerValue(answer, answers),
  }
}

const queueClosed = Symbol('queueClosed')

class PromptQueue {
  #items = []
  #waiters = []
  #closed = false

  push(item) {
    if (this.#closed) {
      throw new Error('Claude prompt queue is closed.')
    }

    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter(item)
      return
    }

    this.#items.push(item)
  }

  close() {
    if (this.#closed) {
      return
    }

    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter(queueClosed)
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.#items.shift()
      if (item) {
        yield item
        continue
      }

      if (this.#closed) {
        return
      }

      const next = await new Promise((resolve) => this.#waiters.push(resolve))
      if (next === queueClosed) {
        return
      }
      yield next
    }
  }
}

export class ClaudeAgentSdkTurnRun extends EventEmitter {
  #controller
  #closed = false
  #pendingRuntimeRequests = new Map()
  #pendingUserInputRequests = new Map()

  constructor(controller, input) {
    super()
    this.#controller = controller
    this.#controller.enqueue(this, input)
  }

  kill() {
    if (this.#closed) {
      return false
    }

    return this.#controller.killTurn(this)
  }

  requestPermission({ input, options, toolName, turnId, sessionId }) {
    if (this.#closed) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Orrery turn is closed.',
        interrupt: true,
        toolUseID: options.toolUseID,
        decisionClassification: 'user_reject',
      })
    }

    const requestId = options.toolUseID || randomUUID()
    if (options.signal?.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Permission request was interrupted.',
        interrupt: true,
        toolUseID: options.toolUseID,
        decisionClassification: 'user_reject',
      })
    }

    const title =
      options.title ||
      options.displayName ||
      `Claude wants to use ${toolName}`
    const body = [
      options.description,
      options.decisionReason,
      options.blockedPath ? `Blocked path: ${options.blockedPath}` : undefined,
      Object.keys(input ?? {}).length > 0
        ? JSON.stringify(input, null, 2)
        : undefined,
    ]
      .filter(Boolean)
      .join('\n\n')

    const request = {
      id: requestId,
      sessionId,
      turnId,
      kind: 'permission',
      title,
      body,
      status: 'open',
      createdAt: new Date().toISOString(),
      raw: {
        source: 'claude.sdk.permission',
        messageType: 'canUseTool',
        payload: {
          toolName,
          input,
          options,
        },
      },
    }
    this.emit('providerEvent', {
      id: randomUUID(),
      ts: request.createdAt,
      type: 'request.opened',
      sessionId,
      request,
      raw: request.raw,
    })

    return new Promise((resolve) => {
      let settled = false
      const abort = () => {
        if (settled) {
          return
        }
        settled = true
        this.#pendingRuntimeRequests.delete(requestId)
        this.emit('providerEvent', {
          id: randomUUID(),
          ts: new Date().toISOString(),
          type: 'request.resolved',
          sessionId,
          requestId,
          status: 'canceled',
          raw: request.raw,
        })
        resolve({
          behavior: 'deny',
          message: 'Permission request was interrupted.',
          interrupt: true,
          toolUseID: options.toolUseID,
          decisionClassification: 'user_reject',
        })
      }

      const abortListener = () => abort()
      options.signal?.addEventListener('abort', abortListener, { once: true })
      this.#pendingRuntimeRequests.set(requestId, {
        resolve: (decision) => {
          if (settled) {
            return
          }
          settled = true
          options.signal?.removeEventListener('abort', abortListener)
          if (decision === 'accept' || decision === 'approved') {
            resolve({
              behavior: 'allow',
              // The SDK's runtime validation requires updatedInput on allow
              // results; echo the original tool input.
              updatedInput: input ?? {},
              toolUseID: options.toolUseID,
              decisionClassification: 'user_temporary',
            })
            return
          }
          if (decision === 'acceptForSession') {
            resolve({
              behavior: 'allow',
              updatedInput: input ?? {},
              ...(Array.isArray(options.suggestions) &&
              options.suggestions.length > 0
                ? { updatedPermissions: options.suggestions }
                : {}),
              toolUseID: options.toolUseID,
              decisionClassification: 'user_permanent',
            })
            return
          }
          if (decision === 'cancel') {
            resolve({
              behavior: 'deny',
              message: 'Canceled in Orrery.',
              interrupt: true,
              toolUseID: options.toolUseID,
              decisionClassification: 'user_reject',
            })
            return
          }
          resolve({
            behavior: 'deny',
            message: 'Denied in Orrery.',
            interrupt: false,
            toolUseID: options.toolUseID,
            decisionClassification: 'user_reject',
          })
        },
        cancel: abort,
      })
    })
  }

  requestUserDialog({ request, options, turnId, sessionId }) {
    if (this.#closed) {
      return Promise.resolve({ behavior: 'cancelled' })
    }

    const requestId = request.toolUseID || randomUUID()
    if (options.signal?.aborted) {
      return Promise.resolve({ behavior: 'cancelled' })
    }

    const prompt = userDialogPrompt({ request })
    const runtimeRequest = {
      id: requestId,
      sessionId,
      turnId,
      prompt: prompt.prompt,
      placeholder: prompt.placeholder,
      questions: normalizedUserInputQuestions(request.payload),
      status: 'open',
      createdAt: new Date().toISOString(),
      raw: {
        source: 'claude.sdk.user-dialog',
        messageType: request.dialogKind,
        payload: request,
      },
    }
    this.emit('providerEvent', {
      id: randomUUID(),
      ts: runtimeRequest.createdAt,
      type: 'user-input.requested',
      sessionId,
      request: runtimeRequest,
      raw: runtimeRequest.raw,
    })

    return new Promise((resolve) => {
      let settled = false
      const abort = () => {
        if (settled) {
          return
        }
        settled = true
        this.#pendingUserInputRequests.delete(requestId)
        this.emit('providerEvent', {
          id: randomUUID(),
          ts: new Date().toISOString(),
          type: 'user-input.resolved',
          sessionId,
          requestId,
          status: 'canceled',
          raw: runtimeRequest.raw,
        })
        resolve({ behavior: 'cancelled' })
      }

      const abortListener = () => abort()
      options.signal?.addEventListener('abort', abortListener, { once: true })
      this.#pendingUserInputRequests.set(requestId, {
        resolve: ({ answer, answers }) => {
          if (settled) {
            return
          }
          settled = true
          options.signal?.removeEventListener('abort', abortListener)
          resolve({
            behavior: 'completed',
            result: userDialogResultForAnswer(request, answer, answers),
          })
        },
        cancel: abort,
      })
    })
  }

  respondRuntimeRequest({ requestId, decision }) {
    const pending = this.#pendingRuntimeRequests.get(String(requestId))
    if (!pending) {
      throw new Error(`Unknown Claude SDK runtime request: ${requestId}`)
    }
    this.#pendingRuntimeRequests.delete(String(requestId))
    pending.resolve(decision)
  }

  answerUserInput({ requestId, answer, answers }) {
    const pending = this.#pendingUserInputRequests.get(String(requestId))
    if (!pending) {
      throw new Error(`Unknown Claude SDK user input request: ${requestId}`)
    }
    this.#pendingUserInputRequests.delete(String(requestId))
    pending.resolve({ answer, answers })
  }

  markClosed() {
    this.#closed = true
    for (const pending of [...this.#pendingRuntimeRequests.values()]) {
      pending.cancel()
    }
    for (const pending of [...this.#pendingUserInputRequests.values()]) {
      pending.cancel()
    }
  }
}

class ClaudeAgentSdkSessionController {
  #sessionKey
  #onClose
  #abortController = new AbortController()
  #queue = new PromptQueue()
  #query
  #queryReady
  #closed = false
  #killRequested = false
  #current
  #pending = []
  #draining = false
  #activeHandoff

  constructor({ sessionKey, input, onClose }) {
    this.#sessionKey = sessionKey
    this.#onClose = onClose
    this.#queryReady = this.#initialize(input)
  }

  enqueue(run, input) {
    if (this.#closed) {
      this.#emitRunErrorAndClose(run, new Error('Claude SDK session is closed.'))
      return
    }

    this.#pending.push({ run, input })
    void this.#drain()
  }

  killTurn(run) {
    const pendingIndex = this.#pending.findIndex((turn) => turn.run === run)
    if (pendingIndex >= 0) {
      const [turn] = this.#pending.splice(pendingIndex, 1)
      this.#closeRun(turn.run, { code: 0, signal: 'SIGTERM', killed: true })
      return true
    }

    if (this.#current?.run !== run) {
      return false
    }

    this.#killRequested = true
    this.close()
    return true
  }

  close() {
    if (this.#closed) {
      return false
    }

    this.#closed = true
    this.#queue.close()
    this.#abortController.abort()
    this.#query?.close?.()
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined

    if (this.#current) {
      this.#closeRun(this.#current.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
      this.#current = undefined
    }
    for (const turn of this.#pending.splice(0)) {
      this.#closeRun(turn.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
    }
    this.#onClose(this.#sessionKey)
    return true
  }

  async #initialize({
    cwd,
    backendSessionId,
    membrane,
    providerInstance,
    runtimeSettings,
    channelDir,
  }) {
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const permissionMode = claudePermissionModeForRuntime(runtimeSettings)
      /** @type {any} */
      const sdkOptions = {
        cwd,
        resume: backendSessionId,
        // The session's own context-channel inbox (runtime-owned data plane):
        // reading delivered files must not stall on a permission prompt.
        ...(nonEmptyString(channelDir)
          ? { additionalDirectories: [channelDir] }
          : {}),
        pathToClaudeCodeExecutable: providerClaudeCommand(providerInstance),
        ...(providerExtraArgs(providerInstance)
          ? { extraArgs: providerExtraArgs(providerInstance) }
          : {}),
        ...(nonEmptyString(runtimeSettings?.model)
          ? { model: runtimeSettings.model.trim() }
          : {}),
        permissionMode: /** @type {import('@anthropic-ai/claude-agent-sdk').PermissionMode} */ (
          permissionMode
        ),
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        includePartialMessages: true,
        strictMcpConfig: false,
        canUseTool: (toolName, toolInput, options) =>
          this.#handleCanUseTool(toolName, toolInput, options),
        onUserDialog: (request, options) =>
          this.#handleUserDialog(request, options),
        supportedDialogKinds: ['ask_user_question'],
        systemPrompt: membrane
          ? {
              type: 'preset',
              preset: 'claude_code',
              append: membraneSystemPrompt(),
            }
          : undefined,
        abortController: this.#abortController,
        env: providerEnv(providerInstance),
      }
      this.#query = query(/** @type {any} */ ({
        prompt: this.#queue,
        // checkJs widens permissionMode through object construction; the value is
        // constrained by claudePermissionModeForRuntime before crossing the SDK boundary.
        // @ts-expect-error see comment above
        options: sdkOptions,
      }))

      void this.#consume()
    } catch (error) {
      this.#failController(error)
      throw error
    }
  }

  async #consume() {
    try {
      for await (const message of this.#query) {
        this.#handleMessage(message)
      }
      this.#finishController()
    } catch (error) {
      if (this.#killRequested) {
        this.#finishController()
      } else {
        this.#failController(error)
      }
    }
  }

  async #drain() {
    if (this.#closed || this.#current || this.#draining) {
      return
    }

    this.#draining = true
    try {
      while (!this.#closed && !this.#current && this.#pending.length > 0) {
        const turn = this.#pending.shift()
        this.#current = turn
        try {
          await this.#queryReady
          await this.#configureRuntimeForTurn(turn)
          await this.#configureMembrane(turn.input.membrane)
          this.#queue.push(
            sdkUserMessage(turn.input.prompt, turn.input.attachments)
          )
        } catch (error) {
          if (!this.#closed) {
            this.#emitRunErrorAndClose(turn.run, error)
          }
          this.#current = undefined
        }
      }
    } finally {
      this.#draining = false
    }

    if (!this.#current && this.#pending.length > 0) {
      void this.#drain()
    }
  }

  #handleCanUseTool(toolName, toolInput, options) {
    const current = this.#current
    if (!current) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'No active Orrery turn can answer this permission request.',
        interrupt: true,
        toolUseID: options.toolUseID,
        decisionClassification: 'user_reject',
      })
    }

    const automaticDecision = automaticClaudePermissionResult(
      current.input.runtimeSettings,
      toolName,
      options,
      toolInput
    )
    if (automaticDecision) {
      return Promise.resolve(automaticDecision)
    }

    return current.run.requestPermission({
      toolName,
      input: toolInput,
      options,
      turnId: current.input.turnId,
      sessionId: current.input.sessionId,
    })
  }

  async #configureRuntimeForTurn(turn) {
    const runtimeSettings = turn.input.runtimeSettings ?? {}
    const effectiveRuntimeConfig = effectiveClaudeRuntimeConfig(runtimeSettings)
    turn.run.emit('providerEvent', {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'runtime.configured',
      sessionId: turn.input.sessionId,
      effectiveRuntimeConfig,
    })

    const permissionMode = effectiveRuntimeConfig.native.permissionMode
    if (
      typeof permissionMode === 'string' &&
      typeof this.#query?.setPermissionMode === 'function'
    ) {
      await this.#query.setPermissionMode(permissionMode)
    }
  }

  #handleUserDialog(request, options) {
    const current = this.#current
    if (!current || request.dialogKind !== 'ask_user_question') {
      return Promise.resolve({ behavior: 'cancelled' })
    }

    return current.run.requestUserDialog({
      request,
      options,
      turnId: current.input.turnId,
      sessionId: current.input.sessionId,
    })
  }

  async #configureMembrane(membrane) {
    if (!membrane) {
      return
    }

    if (typeof this.#query?.setMcpServers !== 'function') {
      throw new Error('Claude Agent SDK does not support dynamic MCP servers.')
    }

    const handoff = createMcpHandoff(membrane)
    try {
      await this.#query.setMcpServers(mcpServersFromHandoff(handoff) ?? {})
    } catch (error) {
      cleanupMcpHandoff(handoff)
      throw error
    }

    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = handoff
  }

  #handleMessage(message) {
    const current = this.#current
    if (!current) {
      return
    }

    const { input, run } = current
    const providerSessionId =
      typeof message?.session_id === 'string'
        ? message.session_id
        : input.sessionId
    if (providerSessionId) {
      run.emit('providerSession', { providerSessionId })
    }

    const ts = new Date().toISOString()
    run.emit('native', {
      ts,
      providerKind: 'claude-code',
      turnId: input.turnId,
      raw: {
        source: 'claude.sdk',
        messageType: sdkMessageType(message),
        payload: message,
      },
    })
    this.#emitSemanticToolEvents({ message, input, run, ts })

    const events = claudeRuntimeEventsFromMessage({
      sessionId: input.sessionId,
      turnId: input.turnId,
      ts,
      message: sdkMessageForRuntimeMapper(message),
      rawSource: 'claude.sdk',
    })

    for (const event of events) {
      run.emit('providerEvent', event)
    }

    if (message?.type === 'result') {
      run.emit('result', message)
      this.#finishCurrentTurn()
    }
  }

  #emitSemanticToolEvents({ message, input, run, ts }) {
    for (const block of contentBlocksFromSdkMessage(message)) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') {
        continue
      }

      if (block.name === 'ExitPlanMode') {
        const text =
          typeof block.input?.plan === 'string'
            ? block.input.plan
            : typeof block.input?.summary === 'string'
              ? block.input.summary
              : JSON.stringify(block.input ?? {}, null, 2)
        const plan = {
          id: block.id ?? `plan-${input.turnId}`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          title: 'Proposed plan',
          items: planItemsFromText(text),
          updatedAt: ts,
          raw: {
            source: 'claude.sdk',
            messageType: 'ExitPlanMode',
            payload: block,
          },
        }
        run.emit('providerEvent', {
          id: randomUUID(),
          ts,
          type: 'plan.updated',
          sessionId: input.sessionId,
          plan,
          raw: plan.raw,
        })
      }
    }
  }

  #finishCurrentTurn() {
    const current = this.#current
    if (!current) {
      return
    }

    this.#current = undefined
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined
    this.#closeRun(current.run, { code: 0, signal: null, killed: false })
    void this.#drain()
  }

  #finishController() {
    if (this.#closed) {
      return
    }

    this.#closed = true
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined
    if (this.#current) {
      this.#closeRun(this.#current.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
      this.#current = undefined
    }
    for (const turn of this.#pending.splice(0)) {
      this.#closeRun(turn.run, {
        code: 0,
        signal: this.#killRequested ? 'SIGTERM' : null,
        killed: this.#killRequested,
      })
    }
    this.#onClose(this.#sessionKey)
  }

  #failController(error) {
    if (this.#closed) {
      return
    }

    this.#closed = true
    cleanupMcpHandoff(this.#activeHandoff)
    this.#activeHandoff = undefined
    if (this.#current) {
      this.#emitRunErrorAndClose(this.#current.run, error)
      this.#current = undefined
    }
    for (const turn of this.#pending.splice(0)) {
      this.#emitRunErrorAndClose(turn.run, error)
    }
    this.#onClose(this.#sessionKey)
  }

  #emitRunErrorAndClose(run, error) {
    run.emit('error', error)
    this.#closeRun(run, { code: 1, signal: null, killed: false })
  }

  #closeRun(run, event) {
    run.markClosed()
    run.emit('close', event)
  }
}

export class ClaudeAgentSdkAdapter {
  kind = 'claude-code'
  #sessions = new Map()

  startTurn(input) {
    const sessionKey = input.sessionId ?? input.backendSessionId
    if (!sessionKey) {
      throw new Error('Claude Agent SDK sessions require an Orrery session id.')
    }

    let controller = this.#sessions.get(sessionKey)
    if (!controller) {
      controller = new ClaudeAgentSdkSessionController({
        sessionKey,
        input,
        onClose: (closedSessionKey) => this.#sessions.delete(closedSessionKey),
      })
      this.#sessions.set(sessionKey, controller)
    }

    return new ClaudeAgentSdkTurnRun(controller, input)
  }

  closeAll() {
    for (const controller of this.#sessions.values()) {
      controller.close()
    }
    this.#sessions.clear()
  }
}
