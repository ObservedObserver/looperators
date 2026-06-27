import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { CodexJsonRpcClient } from './codexJsonRpcClient.js'
import {
  codexRuntimeEventsFromMessage,
  codexRuntimeEventsFromRequest,
} from './codexRuntimeMapper.js'

function threadStartParams({ cwd }) {
  return {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    threadSource: 'user',
    sessionStartSource: 'startup',
    serviceName: 'Orrery',
  }
}

function turnStartParams({ threadId, prompt, cwd }) {
  return {
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    cwd,
    approvalPolicy: 'never',
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
  if (message.method === 'item/permissions/requestApproval') {
    if (decision !== 'approved') {
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
        typeof message.params?.scope === 'string' ? message.params.scope : 'turn',
      strictAutoReview: false,
    }
  }

  return { decision: decision === 'approved' ? 'accept' : 'decline' }
}

function userInputResponseForAnswer(message, answer) {
  const questions = Array.isArray(message.params?.questions)
    ? message.params.questions
    : []
  const answers = {}

  for (const [index, question] of questions.entries()) {
    const questionId =
      typeof question?.id === 'string' && question.id.length > 0
        ? question.id
        : typeof question?.questionId === 'string' && question.questionId.length > 0
          ? question.questionId
          : String(index)
    answers[questionId] = { answers: [answer] }
  }

  return { answers }
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

  constructor({ prompt, cwd, backendSessionId, sessionId, turnId }) {
    super()
    this.#threadId = backendSessionId
    this.#orreryTurnId = turnId
    this.#sessionId = sessionId
    void this.#run({ prompt, cwd })
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

  answerUserInput({ requestId, answer }) {
    const entry = this.#pendingRequests.get(String(requestId))
    if (!entry) {
      throw new Error(`Unknown Codex user input request: ${requestId}`)
    }

    this.#resolvePendingRequest(
      entry,
      userInputResponseForAnswer(entry.message, answer)
    )
  }

  async #run({ prompt, cwd }) {
    let code = 0
    let signal = null

    try {
      this.#client = new CodexJsonRpcClient({ cwd })
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

      const threadResult = this.#threadId
        ? await this.#client.request(
            'thread/resume',
            { ...threadStartParams({ cwd }), threadId: this.#threadId },
            { timeoutMs: 60000 }
          )
        : await this.#client.request('thread/start', threadStartParams({ cwd }), {
            timeoutMs: 90000,
          })

      this.#threadId = threadResult?.thread?.id ?? this.#threadId
      if (this.#threadId) {
        this.emit('providerSession', { providerSessionId: this.#threadId })
      }

      const turnResult = await this.#client.request(
        'turn/start',
        turnStartParams({ threadId: this.#threadId, prompt, cwd }),
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
