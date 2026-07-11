import { randomUUID } from 'node:crypto'
import type { GrokAcpMessage, GrokAcpSessionUpdate } from './grokAcpTypes.js'

function now() {
  return new Date().toISOString()
}

function rawEnvelope(message: GrokAcpMessage, source: string) {
  return { source, method: message.method, payload: message }
}

function base(sessionId: string, turnId: string | undefined, raw: any) {
  return {
    id: randomUUID(),
    ts: now(),
    sessionId,
    ...(turnId ? { turnId } : {}),
    raw,
  }
}

function textContent(content: any) {
  if (typeof content === 'string') return content
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
}

function jsonText(value: unknown) {
  if (typeof value === 'string') return value
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function itemStatus(status: unknown) {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'pending') return 'pending'
  return 'running'
}

function toolItem({
  sessionId,
  turnId,
  update,
  raw,
}: {
  sessionId: string
  turnId?: string
  update: GrokAcpSessionUpdate
  raw: any
}) {
  const ts = now()
  const status = itemStatus(update.status)
  const providerName =
    typeof update._meta?.['x.ai/tool'] === 'object' &&
    typeof (update._meta['x.ai/tool'] as any).name === 'string'
      ? (update._meta['x.ai/tool'] as any).name
      : typeof update.kind === 'string'
        ? update.kind
        : 'grok.tool'
  return {
    id: typeof update.toolCallId === 'string' ? update.toolCallId : randomUUID(),
    sessionId,
    ...(turnId ? { turnId } : {}),
    kind: 'tool_call',
    providerName,
    command: providerName,
    title: typeof update.title === 'string' && update.title.trim() ? update.title : providerName,
    status,
    input: update.rawInput,
    output: jsonText(update.rawOutput ?? update.content),
    startedAt: ts,
    updatedAt: ts,
    ...(status === 'completed' || status === 'failed' ? { completedAt: ts } : {}),
    raw,
  }
}

function planStatus(value: unknown) {
  if (value === 'completed') return 'completed'
  if (value === 'in_progress' || value === 'inProgress') return 'in_progress'
  return 'pending'
}

function questionOptions(question: any) {
  if (!Array.isArray(question?.options)) return undefined
  const options = question.options
    .map((option: any, index: number) => {
      const label = typeof option?.label === 'string' ? option.label.trim() : ''
      if (!label) return undefined
      return {
        id: typeof option.id === 'string' && option.id ? option.id : String(index),
        label,
        ...(typeof option.description === 'string' && option.description.trim()
          ? { description: option.description.trim() }
          : {}),
      }
    })
    .filter(Boolean)
  return options.length > 0 ? options : undefined
}

function questionParams(message: GrokAcpMessage) {
  const params = message.params ?? {}
  return params?.params && Array.isArray(params.params.questions) ? params.params : params
}

export function grokRuntimeEventsFromNotification({
  sessionId,
  turnId,
  message,
}: {
  sessionId: string
  turnId?: string
  message: GrokAcpMessage
}) {
  const raw = rawEnvelope(
    message,
    message.method?.startsWith('_x.ai/') ? 'grok.xai.extension' : 'grok.acp.notification',
  )
  const eventBase = base(sessionId, turnId, raw)

  if (message.params?._meta?.isReplay === true) return []

  if (message.method === '_x.ai/session/prompt_complete') {
    return turnId
      ? [{ ...eventBase, type: 'turn.completed', turnId }]
      : []
  }
  if (message.method !== 'session/update') return []
  const update: GrokAcpSessionUpdate | undefined = message.params?.update
  if (!update || typeof update.sessionUpdate !== 'string') return []

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textContent(update.content)
      return text
        ? [{ ...eventBase, type: 'content.delta', streamKind: 'assistant_text', text }]
        : []
    }
    case 'agent_thought_chunk':
    case 'user_message_chunk':
    case 'available_commands_update':
      return []
    case 'tool_call': {
      const item = toolItem({ sessionId, turnId, update, raw })
      return [{ ...eventBase, type: 'item.started', item }]
    }
    case 'tool_call_update': {
      const item = toolItem({ sessionId, turnId, update, raw })
      return [
        {
          ...eventBase,
          type: item.status === 'completed' || item.status === 'failed' ? 'item.completed' : 'item.updated',
          item,
        },
      ]
    }
    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries : []
      return [
        {
          ...eventBase,
          type: 'plan.updated',
          plan: {
            id: `grok-plan-${turnId ?? sessionId}`,
            sessionId,
            ...(turnId ? { turnId } : {}),
            title: typeof update.title === 'string' ? update.title : 'Grok plan',
            items: entries.map((entry: any, index: number) => ({
              id: typeof entry?.id === 'string' ? entry.id : String(index),
              title:
                typeof entry?.content === 'string'
                  ? entry.content
                  : typeof entry?.title === 'string'
                    ? entry.title
                    : `Step ${index + 1}`,
              status: planStatus(entry?.status),
            })),
            updatedAt: eventBase.ts,
            raw,
          },
        },
      ]
    }
    default:
      return []
  }
}

export function grokRuntimeEventsFromRequest({
  sessionId,
  turnId,
  message,
}: {
  sessionId: string
  turnId?: string
  message: GrokAcpMessage
}) {
  const isQuestion =
    message.method === 'x.ai/ask_user_question' ||
    message.method === '_x.ai/ask_user_question'
  const raw = rawEnvelope(
    message,
    isQuestion ? 'grok.xai.extension' : 'grok.acp.request',
  )
  const eventBase = base(sessionId, turnId, raw)
  const requestId = String(message.id ?? randomUUID())

  if (message.method === 'session/request_permission') {
    const params = message.params ?? {}
    const options = Array.isArray(params.options) ? params.options : []
    return [
      {
        ...eventBase,
        type: 'request.opened',
        request: {
          id: requestId,
          sessionId,
          ...(turnId ? { turnId } : {}),
          kind: 'permission',
          title:
            typeof params.toolCall?.title === 'string'
              ? params.toolCall.title
              : 'Grok requested permission',
          body: options
            .map((option: any) => option?.name ?? option?.label ?? option?.kind ?? option?.optionId)
            .filter(Boolean)
            .join(', ') || undefined,
          status: 'open',
          createdAt: eventBase.ts,
          raw,
        },
      },
    ]
  }

  if (isQuestion) {
    const params = questionParams(message)
    const questions = Array.isArray(params.questions)
      ? params.questions.map((question: any, index: number) => ({
          id:
            typeof question?.id === 'string' && question.id.trim()
              ? question.id.trim()
              : typeof question?.question === 'string' && question.question.trim()
                ? question.question.trim()
                : `question-${index + 1}`,
          label:
            typeof question?.question === 'string' && question.question.trim()
              ? question.question.trim()
              : `Question ${index + 1}`,
          ...(question?.multiSelect === true ? { multiSelect: true } : {}),
          ...(questionOptions(question) ? { options: questionOptions(question) } : {}),
        }))
      : []
    return [
      {
        ...eventBase,
        type: 'user-input.requested',
        request: {
          id: requestId,
          sessionId,
          ...(turnId ? { turnId } : {}),
          prompt:
            questions.length === 1
              ? questions[0].label
              : `Grok requested ${questions.length || ''} inputs.`.replace('  ', ' '),
          placeholder: 'Answer for Grok',
          ...(questions.length > 0 ? { questions } : {}),
          status: 'open',
          createdAt: eventBase.ts,
          raw,
        },
      },
    ]
  }

  return []
}
