import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  cn,
} from '@/lib/utils'
import {
  type AgentSession,
  type RuntimeStateDiagnostic,
} from '@/shared/graph-state'
import {
  formatClock,
} from '@/lib/format'
import {
  type RecoveryState,
  recoveryToneClassName,
  recoveryDetailClassName,
  runtimeDiagnosticNotices,
} from '@/lib/diagnostics'

export function RecoveryNotice({
  state,
  compact,
}: {
  state?: RecoveryState
  compact?: boolean
}) {
  if (!state) {
    return null
  }

  return (
    <div
      className={cn(
        'rounded-lg border px-2.5 py-2 font-mono',
        recoveryToneClassName(state.tone)
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em]">
        <TriangleAlert className="size-3 shrink-0" />
        <span className="truncate">{state.title}</span>
      </div>
      <p
        className={cn(
          compact ? 'line-clamp-2' : 'whitespace-pre-wrap',
          'mt-1 break-words text-[11.5px] leading-5',
          recoveryDetailClassName(state.tone)
        )}
      >
        {state.detail}
      </p>
    </div>
  )
}

export function RuntimeDiagnosticsToast({
  diagnostics,
  sessions,
}: {
  diagnostics: RuntimeStateDiagnostic[]
  sessions: AgentSession[]
}) {
  const notices = useMemo(
    () => runtimeDiagnosticNotices({ diagnostics, sessions }),
    [diagnostics, sessions]
  )
  const [hiddenNoticeIds, setHiddenNoticeIds] = useState<Set<string>>(
    () => new Set()
  )
  const visibleNotices = notices.filter((notice) => !hiddenNoticeIds.has(notice.id))

  useEffect(() => {
    if (notices.length === 0) {
      return
    }

    const timers = notices.map((notice) =>
      window.setTimeout(() => {
        setHiddenNoticeIds((current) => {
          if (current.has(notice.id)) {
            return current
          }

          const next = new Set(current)
          next.add(notice.id)
          return next
        })
      }, 8000)
    )

    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [notices])

  if (visibleNotices.length === 0) {
    return null
  }

  return (
    <div className="app-region-no-drag pointer-events-none absolute right-4 top-16 z-40 w-[min(380px,calc(100%-2rem))] space-y-2">
      {visibleNotices.map((notice) => {
        return (
          <div
            key={notice.id}
            className={cn(
              'pointer-events-auto rounded-lg border px-3 py-2 font-mono shadow-lg backdrop-blur',
              recoveryToneClassName(notice.tone)
            )}
            title={notice.titleText}
          >
            <div className="flex min-w-0 items-center gap-2">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                {notice.title}
              </span>
              {notice.count && notice.count > 1 ? (
                <span className="shrink-0 rounded border border-current/20 px-1.5 py-0.5 text-[10px] tabular-nums opacity-80">
                  {notice.count}
                </span>
              ) : null}
              <span className="shrink-0 text-[10px] tabular-nums opacity-70">
                {formatClock(notice.ts)}
              </span>
              <button
                type="button"
                className="rounded p-0.5 opacity-65 transition hover:bg-foreground/[0.08] hover:opacity-100"
                aria-label={`Dismiss ${notice.title}`}
                onClick={() =>
                  setHiddenNoticeIds((current) => {
                    const next = new Set(current)
                    next.add(notice.id)
                    return next
                  })
                }
              >
                <X className="size-3" />
              </button>
            </div>
            <p className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-term-dim">
              {notice.detail}
            </p>
          </div>
        )
      })}
    </div>
  )
}
