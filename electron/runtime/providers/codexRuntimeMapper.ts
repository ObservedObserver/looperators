import { randomUUID } from 'node:crypto'

function isoFromMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
}

function rawEnvelope(message, source) {
  return {
    source,
    method: message.method,
    payload: message,
  }
}

function eventBase({ sessionId, turnId, ts, raw }) {
  return {
    id: randomUUID(),
    ts,
    sessionId,
    ...(turnId ? { turnId } : {}),
    raw,
  }
}

function runtimeStatus(status) {
  if (status?.type === 'active') {
    return 'running'
  }
  if (status?.type === 'systemError') {
    return 'failed'
  }
  return 'idle'
}

function itemStatus(item) {
  const status = item?.status
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'failed' || status === 'declined') {
    return 'failed'
  }
  return 'running'
}

function commandArgs(item) {
  if (typeof item?.command === 'string' && item.command.length > 0) {
    return item.command.length > 56
      ? `${item.command.slice(0, 55)}...`
      : item.command
  }
  if (typeof item?.query === 'string') {
    return item.query
  }
  return undefined
}

function outputFromItem(item) {
  if (typeof item?.aggregatedOutput === 'string') {
    return item.aggregatedOutput
  }
  if (item?.result) {
    try {
      return JSON.stringify(item.result)
    } catch {
      return String(item.result)
    }
  }
  if (item?.error) {
    try {
      return JSON.stringify(item.error)
    } catch {
      return String(item.error)
    }
  }
  return undefined
}

function contentBlockText(block) {
  if (typeof block === 'string') {
    return block
  }
  if (!block || typeof block !== 'object') {
    return ''
  }
  if (typeof block.text === 'string') {
    return block.text
  }
  if (typeof block.content === 'string') {
    return block.content
  }
  return ''
}

function agentMessageText(item) {
  if (typeof item?.text === 'string') {
    return item.text
  }
  if (typeof item?.content === 'string') {
    return item.content
  }
  if (Array.isArray(item?.content)) {
    return item.content.map(contentBlockText).join('')
  }
  if (typeof item?.message === 'string') {
    return item.message
  }
  if (typeof item?.message?.content === 'string') {
    return item.message.content
  }
  if (Array.isArray(item?.message?.content)) {
    return item.message.content.map(contentBlockText).join('')
  }
  return ''
}

function questionText(question, index) {
  const header =
    typeof question?.header === 'string' && question.header.trim().length > 0
      ? `${question.header.trim()}: `
      : ''
  const text =
    typeof question?.question === 'string' && question.question.trim().length > 0
      ? question.question.trim()
      : `Question ${index + 1}`
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
  const secretText = question?.isSecret === true ? ' [secret requested]' : ''

  return `${index + 1}. ${header}${text}${secretText}${optionText}`
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
  return String(index)
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

function normalizedUserInputQuestions(params) {
  if (!Array.isArray(params.questions)) {
    return []
  }

  return params.questions.map((question, index) => ({
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

function codexUserInputPrompt(params) {
  if (!Array.isArray(params.questions) || params.questions.length === 0) {
    return {
      prompt: 'Codex requested user input.',
      placeholder: 'Answer for Codex',
    }
  }

  const questions = params.questions
  const lines = questions.map((question, index) => questionText(question, index))
  const hasOptions = questions.some(
    (question) => Array.isArray(question?.options) && question.options.length > 0
  )
  const hasSecret = questions.some((question) => question?.isSecret === true)
  const isComplex = questions.length > 1 || hasOptions || hasSecret

  if (!isComplex) {
    return {
      prompt: lines[0]?.replace(/^1\. /, '') ?? 'Codex requested user input.',
      placeholder: 'Answer for Codex',
    }
  }

  return {
    prompt: [
      `Codex requested ${questions.length} inputs.`,
      hasSecret
        ? 'Do not enter secrets unless you are comfortable storing them in session history.'
        : undefined,
      '',
      ...lines,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
    placeholder: 'Answer for Codex',
  }
}

function runtimeItemFromThreadItem({ sessionId, turnId, ts, item, raw }) {
  const type = item?.type
  const id = typeof item?.id === 'string' ? item.id : randomUUID()

  if (type === 'commandExecution') {
    return {
      id,
      sessionId,
      turnId,
      kind: 'command',
      providerName: 'commandExecution',
      command: 'shell',
      args: commandArgs(item),
      title: item.command ?? 'command',
      status: itemStatus(item),
      input: { command: item.command, cwd: item.cwd },
      output: outputFromItem(item),
      startedAt: ts,
      updatedAt: ts,
      completedAt: item.status === 'inProgress' ? undefined : ts,
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : undefined,
      raw,
    }
  }

  if (type === 'fileChange') {
    return {
      id,
      sessionId,
      turnId,
      kind: 'file_change',
      providerName: 'fileChange',
      command: 'apply_patch',
      args: Array.isArray(item.changes) ? `${item.changes.length} changes` : undefined,
      title: 'file change',
      status: itemStatus(item),
      input: item.changes,
      startedAt: ts,
      updatedAt: ts,
      completedAt: item.status === 'inProgress' ? undefined : ts,
      raw,
    }
  }

  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const providerName =
      type === 'mcpToolCall'
        ? `${item.server}.${item.tool}`
        : [item.namespace, item.tool].filter(Boolean).join('.')
    return {
      id,
      sessionId,
      turnId,
      kind: 'tool_call',
      providerName,
      command: providerName,
      args: commandArgs(item),
      title: providerName,
      status: itemStatus(item),
      input: item.arguments,
      output: outputFromItem(item),
      startedAt: ts,
      updatedAt: ts,
      completedAt: item.status === 'inProgress' ? undefined : ts,
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : undefined,
      raw,
    }
  }

  if (type === 'webSearch') {
    return {
      id,
      sessionId,
      turnId,
      kind: 'tool_call',
      providerName: 'webSearch',
      command: 'web.search',
      args: item.query,
      title: 'web search',
      status: 'completed',
      input: item,
      startedAt: ts,
      updatedAt: ts,
      completedAt: ts,
      raw,
    }
  }

  return undefined
}

export function codexRuntimeEventsFromMessage({
  sessionId,
  turnId,
  message,
  source = 'codex.app-server.notification',
}) {
  const method = message?.method
  const params = message?.params ?? {}
  const raw = rawEnvelope(message, source)
  const ts = new Date().toISOString()
  const base = eventBase({ sessionId, turnId, ts, raw })

  switch (method) {
    case 'turn/started':
      return [
        {
          ...base,
          type: 'turn.started',
          turnId,
        },
      ]
    case 'turn/completed':
      return [
        {
          ...base,
          type: 'turn.completed',
          turnId,
        },
      ]
    case 'thread/status/changed':
      return [
        {
          ...base,
          type: 'session.state',
          status: runtimeStatus(params.status),
        },
      ]
    case 'item/agentMessage/delta':
      return [
        {
          ...base,
          type: 'content.delta',
          itemId: params.itemId,
          streamKind: 'assistant_text',
          text: typeof params.delta === 'string' ? params.delta : '',
        },
      ]
    case 'item/reasoning/textDelta':
      return [
        {
          ...base,
          type: 'content.delta',
          itemId: params.itemId,
          streamKind: 'reasoning_text',
          text: typeof params.delta === 'string' ? params.delta : '',
        },
      ]
    case 'item/reasoning/summaryTextDelta':
      return [
        {
          ...base,
          type: 'content.delta',
          itemId: params.itemId,
          streamKind: 'reasoning_summary_text',
          text: typeof params.delta === 'string' ? params.delta : '',
        },
      ]
    case 'item/commandExecution/outputDelta':
      return [
        {
          ...base,
          type: 'content.delta',
          itemId: params.itemId,
          streamKind: 'command_output',
          text: typeof params.delta === 'string' ? params.delta : '',
        },
      ]
    case 'item/fileChange/outputDelta':
      return [
        {
          ...base,
          type: 'content.delta',
          itemId: params.itemId,
          streamKind: 'file_change_output',
          text: typeof params.delta === 'string' ? params.delta : '',
        },
      ]
    case 'turn/plan/updated':
      return [
        {
          ...base,
          type: 'plan.updated',
          plan: {
            id: params.turnId ?? turnId,
            sessionId,
            turnId,
            title: params.explanation ?? undefined,
            items: Array.isArray(params.plan)
              ? params.plan.map((item, index) => ({
                  id: item.id ?? `${turnId}:plan:${index}`,
                  title: item.text ?? item.title ?? '',
                  status:
                    item.status === 'in_progress'
                      ? 'in_progress'
                      : item.status === 'completed'
                        ? 'completed'
                        : 'pending',
                }))
              : [],
            updatedAt: ts,
            raw,
          },
        },
      ]
    case 'item/started': {
      const startedTs = isoFromMs(params.startedAtMs)
      const item = runtimeItemFromThreadItem({
        sessionId,
        turnId,
        ts: startedTs,
        item: params.item,
        raw,
      })
      return item
        ? [
            {
              ...eventBase({ sessionId, turnId, ts: startedTs, raw }),
              type: 'item.started',
              item,
            },
          ]
        : []
    }
    case 'item/completed': {
      const completedTs = isoFromMs(params.completedAtMs)
      if (params.item?.type === 'agentMessage') {
        const providerItemId =
          typeof params.item.id === 'string' ? params.item.id : params.itemId
        return [
          {
            ...eventBase({ sessionId, turnId, ts: completedTs, raw }),
            type: 'message.completed',
            message: {
              id: providerItemId
                ? `${sessionId}:${providerItemId}:assistant`
                : `${sessionId}:${turnId}:assistant`,
              sessionId,
              role: 'assistant',
              content: agentMessageText(params.item),
              ts: completedTs,
              runId: turnId,
              providerItemId,
              ...(typeof params.item.phase === 'string'
                ? { phase: params.item.phase }
                : {}),
              status: 'complete',
            },
          },
        ]
      }

      const item = runtimeItemFromThreadItem({
        sessionId,
        turnId,
        ts: completedTs,
        item: params.item,
        raw,
      })
      return item
        ? [
            {
              ...eventBase({ sessionId, turnId, ts: completedTs, raw }),
              type: 'item.completed',
              item: {
                ...item,
                completedAt: completedTs,
              },
            },
          ]
        : []
    }
    default:
      return []
  }
}

export function codexRuntimeEventsFromRequest({ sessionId, turnId, message }) {
  const raw = rawEnvelope(message, 'codex.app-server.request')
  const ts = new Date().toISOString()
  const params = message?.params ?? {}
  const requestId = String(message?.id ?? randomUUID())

  if (message?.method === 'item/tool/requestUserInput') {
    const inputPrompt = codexUserInputPrompt(params)
    return [
      {
        ...eventBase({ sessionId, turnId, ts, raw }),
        type: 'user-input.requested',
        request: {
          id: requestId,
          sessionId,
          turnId,
          prompt: inputPrompt.prompt,
          placeholder: inputPrompt.placeholder,
          questions: normalizedUserInputQuestions(params),
          status: 'open',
          createdAt: ts,
          raw,
        },
      },
    ]
  }

  if (
    message?.method === 'item/commandExecution/requestApproval' ||
    message?.method === 'item/fileChange/requestApproval' ||
    message?.method === 'item/permissions/requestApproval'
  ) {
    return [
      {
        ...eventBase({ sessionId, turnId, ts, raw }),
        type: 'request.opened',
        request: {
          id: requestId,
          sessionId,
          turnId,
          kind:
            message.method === 'item/permissions/requestApproval'
              ? 'permission'
              : 'approval',
          title:
            params.command ??
            params.toolName ??
            params.type ??
            message.method,
          body:
            params.reason ??
            params.description ??
            (Array.isArray(params.permissions)
              ? params.permissions.join('\n')
              : undefined),
          status: 'open',
          createdAt: ts,
          raw,
        },
      },
    ]
  }

  return []
}
