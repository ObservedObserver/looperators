// Session interaction input normalization: chat attachments, runtime
// permission request decisions, and structured user-input answers.
// Split out of sessionManager.ts (move-only).
import { randomUUID } from 'node:crypto'
import {
  type JsonRecord,
  boundedText,
  isObject,
  nonEmptyString,
} from '../runtimeCommon.js'

export const attachmentTextMaxLength = 12_000
export const attachmentImageMaxBytes = 1_500_000
export const supportedAttachmentImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])
export function normalizeChatAttachments(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isObject).map((attachment) => {
    const mediaType = nonEmptyString(attachment.mediaType)
      ? attachment.mediaType.trim()
      : nonEmptyString(attachment.type)
        ? attachment.type.trim()
        : 'application/octet-stream'
    const requestedKind =
      attachment.kind === 'image'
        ? 'image'
        : attachment.kind === 'text' || attachment.kind === 'file'
          ? 'text'
          : 'binary'
    const size = Number.isFinite(attachment.size)
      ? Math.max(0, attachment.size)
      : 0
    const kind =
      requestedKind === 'image' &&
      supportedAttachmentImageMimeTypes.has(mediaType) &&
      size <= attachmentImageMaxBytes
        ? 'image'
        : requestedKind === 'image'
          ? 'binary'
          : requestedKind
    const text =
      typeof attachment.text === 'string'
        ? boundedText(attachment.text, attachmentTextMaxLength)
        : undefined
    const dataUrl =
      kind === 'image' &&
      typeof attachment.dataUrl === 'string' &&
      attachment.dataUrl.length <= attachmentImageMaxBytes * 2
        ? attachment.dataUrl
        : undefined

    return {
      id: nonEmptyString(attachment.id) ? attachment.id : randomUUID(),
      name: nonEmptyString(attachment.name)
        ? attachment.name.trim()
        : 'attachment',
      mediaType,
      size,
      kind,
      ...(text !== undefined ? { text } : {}),
      ...(dataUrl !== undefined ? { dataUrl } : {}),
      truncated: attachment.truncated === true,
    }
  })
}

export function normalizeRuntimeRequestDecision(decision) {
  if (decision === 'approved') {
    return 'accept'
  }
  if (decision === 'denied') {
    return 'decline'
  }
  return decision
}

export function runtimeRequestSupportsCancellation(request) {
  return !(
    request?.raw?.source === 'codex.app-server.request' &&
    request.raw.method === 'item/permissions/requestApproval'
  )
}

export function runtimeRequestStatusForDecision(decision, request) {
  switch (decision) {
    case 'accept':
      return 'approved'
    case 'acceptForSession':
      return 'approved_for_session'
    case 'cancel':
      return runtimeRequestSupportsCancellation(request) ? 'canceled' : 'denied'
    case 'decline':
    default:
      return 'denied'
  }
}

export function normalizeUserInputAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .map(([key, answer]) => {
      const trimmedKey = String(key).trim()
      if (!trimmedKey) {
        return undefined
      }
      if (Array.isArray(answer)) {
        return [
          trimmedKey,
          answer
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ]
      }
      if (typeof answer === 'string') {
        return [trimmedKey, answer]
      }
      return undefined
    })
    .filter(Boolean)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function firstUserInputAnswer(answer, answers) {
  if (typeof answer === 'string') {
    return answer
  }
  const value = Object.values(answers ?? {})[0]
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  return typeof value === 'string' ? value : undefined
}

export function userInputAnswerHasContent(value) {
  return Array.isArray(value)
    ? value.some((item) => typeof item === 'string' && item.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0
}

export function userInputQuestionsAreComplete(request, answer, answers) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (questions.length === 0) return true
  if (questions.length === 1 && userInputAnswerHasContent(answer)) return true
  return questions.every((question) =>
    userInputAnswerHasContent(answers?.[question.id] ?? answers?.[question.label]),
  )
}

