import {
  Check,
  ClipboardCheck,
  Send,
  Square,
  X,
} from 'lucide-react'
import {
  Button,
} from '@/components/ui/button'
import {
  type RuntimeRequestDecision,
  type RuntimeRequest,
  type UserInputAnswerValue,
  type UserInputRequest,
} from '@/shared/provider-runtime'
import {
  formatClock,
} from '@/lib/format'

export type RuntimeInteractionPanelProps = {
  requests: RuntimeRequest[]
  userInputRequests: UserInputRequest[]
  userInputDrafts: Record<string, UserInputAnswerValue>
  pendingInteractionIds: Record<string, boolean>
  onRespond: (
    request: RuntimeRequest,
    decision: RuntimeRequestDecision
  ) => void
  onDraftChange: (requestId: string, value: UserInputAnswerValue) => void
  onAnswer: (request: UserInputRequest) => void
}

export const requestKindLabels: Record<RuntimeRequest['kind'], string> = {
  approval: 'Approval request',
  permission: 'Permission request',
  confirmation: 'Confirmation request',
}

export function userInputDraftKey(request: UserInputRequest, questionId?: string) {
  return questionId ? `${request.id}:${questionId}` : request.id
}

export function answerValueAsString(value: UserInputAnswerValue | undefined) {
  return Array.isArray(value) ? value.join(', ') : (value ?? '')
}

export function RuntimeInteractionPanel({
  requests,
  userInputRequests,
  userInputDrafts,
  pendingInteractionIds,
  onRespond,
  onDraftChange,
  onAnswer,
}: RuntimeInteractionPanelProps) {
  if (requests.length === 0 && userInputRequests.length === 0) {
    return null
  }

  return (
    <div className="shrink-0 border-b border-ink-line bg-ink px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2 font-mono">
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-amber">
          Action needed
        </span>
        <span className="ml-auto rounded border border-term-amber/30 bg-term-amber/10 px-1.5 py-0.5 text-[10px] tabular-nums text-term-amber">
          {requests.length + userInputRequests.length}
        </span>
      </div>

      <div className="space-y-2">
        {requests.map((request) => {
          const isPending = pendingInteractionIds[request.id] === true
          return (
            <div
              key={request.id}
              className="rounded-lg border border-term-amber/35 bg-term-amber/10 p-3 font-mono"
            >
              <div className="flex min-w-0 items-start gap-2">
                <span className="pt-0.5 text-term-amber">?</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-term-name">
                    {request.title}
                  </div>
                  {request.body ? (
                    <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] leading-5 text-term-dim">
                      {request.body}
                    </p>
                  ) : null}
                  <div className="mt-1 text-[10.5px] uppercase tracking-[0.08em] text-term-faint">
                    {requestKindLabels[request.kind]} ·{' '}
                    {formatClock(request.createdAt)}
                  </div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'accept')}
                >
                  <Check className="size-3.5" />
                  Allow once
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'acceptForSession')}
                >
                  <ClipboardCheck className="size-3.5" />
                  Allow session
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'decline')}
                >
                  <X className="size-3.5" />
                  Decline
                </Button>
                <Button
                  className="h-8 justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => onRespond(request, 'cancel')}
                >
                  <Square className="size-3.5" />
                  Cancel
                </Button>
              </div>
            </div>
          )
        })}

        {userInputRequests.map((request) => {
          const questions = request.questions ?? []
          const hasStructuredQuestions = questions.length > 0
          const draft = answerValueAsString(userInputDrafts[userInputDraftKey(request)])
          const isPending = pendingInteractionIds[request.id] === true
          return (
            <div
              key={request.id}
              className="rounded-lg border border-term-cyan/35 bg-term-cyan/10 p-3 font-mono"
            >
              <div className="text-[12.5px] font-medium text-term-name">
                Input requested
              </div>
              <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] leading-5 text-term-dim">
                {request.prompt}
              </p>
              {hasStructuredQuestions ? (
                <div className="mt-2 space-y-2.5">
                  {questions.map((question) => {
                    const draftKey = userInputDraftKey(request, question.id)
                    const questionDraft = userInputDrafts[draftKey]
                    const optionValues = Array.isArray(questionDraft)
                      ? questionDraft
                      : []
                    return (
                      <div
                        key={question.id}
                        className="rounded-md border border-ink-line/80 bg-ink/70 p-2.5"
                      >
                        <div className="text-[11px] uppercase tracking-[0.08em] text-term-faint">
                          {question.header ?? 'Question'}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-term-name">
                          {question.label}
                        </div>
                        {question.isSecret ? (
                          <div className="mt-1 text-[10.5px] leading-4 text-term-amber">
                            Secret input requested; the answer is stored in session
                            history.
                          </div>
                        ) : null}
                        {question.options?.length ? (
                          <div className="mt-2 space-y-1.5">
                            {question.options.map((option) => {
                              const checked = question.multiSelect
                                ? optionValues.includes(option.id)
                                : questionDraft === option.id
                              return (
                                <label
                                  key={option.id}
                                  className="flex cursor-pointer items-start gap-2 rounded border border-ink-line bg-ink px-2 py-1.5 text-[11.5px] leading-4 text-term-dim"
                                >
                                  <input
                                    className="mt-0.5 accent-lime-hi"
                                    type={question.multiSelect ? 'checkbox' : 'radio'}
                                    name={`${request.id}:${question.id}`}
                                    disabled={isPending}
                                    checked={checked}
                                    onChange={() => {
                                      if (question.multiSelect) {
                                        const next = checked
                                          ? optionValues.filter(
                                              (item) => item !== option.id
                                            )
                                          : [...optionValues, option.id]
                                        onDraftChange(draftKey, next)
                                        return
                                      }
                                      onDraftChange(draftKey, option.id)
                                    }}
                                  />
                                  <span>
                                    <span className="block text-term-name">
                                      {option.label}
                                    </span>
                                    {option.description ? (
                                      <span className="block text-term-faint">
                                        {option.description}
                                      </span>
                                    ) : null}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        ) : (
                          <>
                            {question.isSecret ? (
                              <input
                                className="mt-2 h-9 w-full rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                                type="password"
                                value={answerValueAsString(questionDraft)}
                                placeholder={
                                  question.placeholder ??
                                  request.placeholder ??
                                  'Type an answer'
                                }
                                disabled={isPending}
                                onChange={(event) =>
                                  onDraftChange(draftKey, event.target.value)
                                }
                              />
                            ) : (
                              <textarea
                                className="mt-2 max-h-24 min-h-12 w-full resize-y rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                                value={answerValueAsString(questionDraft)}
                                placeholder={
                                  question.placeholder ??
                                  request.placeholder ??
                                  'Type an answer'
                                }
                                disabled={isPending}
                                onChange={(event) =>
                                  onDraftChange(draftKey, event.target.value)
                                }
                              />
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <textarea
                  className="mt-2 max-h-28 min-h-16 w-full resize-y rounded-md border border-ink-line bg-ink px-2.5 py-2 text-[12px] leading-5 text-term-name outline-none placeholder:text-term-faint focus:border-lime-hi/55"
                  value={draft}
                  placeholder={request.placeholder ?? 'Type an answer'}
                  disabled={isPending}
                  onChange={(event) =>
                    onDraftChange(userInputDraftKey(request), event.target.value)
                  }
                />
              )}
              <Button
                className="mt-2 h-8 w-full justify-center font-mono text-[11px] uppercase tracking-[0.08em]"
                disabled={isPending}
                onClick={() => onAnswer(request)}
              >
                <Send className="size-3.5" />
                Send answer
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
