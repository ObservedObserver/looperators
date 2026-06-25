import { cn } from '@/lib/utils'
import {
  formatDuration,
  type ToolRun,
  type ToolTurn,
} from '@/shared/tool-feed'

/**
 * Terminal tool-call run-feed (mockup "image-1" language): rows on ink, no
 * window chrome. Rendered inside the dark transcript console, so it uses the
 * constant `term-*` palette (dark in both themes).
 */

const gutterByStatus: Record<ToolRun['status'], { char: string; cls: string }> =
  {
    ok: { char: '●', cls: 'text-term-green' },
    running: { char: '◌', cls: 'text-term-amber animate-pulse' },
    error: { char: '✗', cls: 'text-term-rose' },
  }

function headElapsed(turn: ToolTurn): string | undefined {
  if (turn.result?.durationMs !== undefined) {
    return formatDuration(turn.result.durationMs)
  }
  const total = turn.toolRuns.reduce(
    (sum, run) => sum + (run.durationMs ?? 0),
    0
  )
  return total > 0 ? formatDuration(total) : undefined
}

function ToolRow({ run }: { run: ToolRun }) {
  const gutter = gutterByStatus[run.status]
  return (
    <>
      <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5">
        <span
          className={cn('text-center text-[11px] leading-6', gutter.cls)}
        >
          {gutter.char}
        </span>
        <span className="min-w-0 leading-6">
          <span className="font-medium text-lime">{run.command}</span>
          {run.args ? (
            <span className="ml-2 break-words text-term-dim">{run.args}</span>
          ) : null}
        </span>
        <span className="whitespace-nowrap text-[11px] leading-6">
          {run.status === 'ok' ? (
            <span className="text-term-green">
              ✓
              {run.durationMs !== undefined ? (
                <span className="ml-1.5 text-term-faint">
                  {formatDuration(run.durationMs)}
                </span>
              ) : null}
            </span>
          ) : run.status === 'error' ? (
            <span className="text-term-rose">✗ error</span>
          ) : (
            <span className="text-term-amber">
              running
              <span className="orrery-caret ml-1.5" />
            </span>
          )}
        </span>
      </div>
      {run.sublines.length > 0 ? (
        <div className="grid gap-0.5 py-0.5">
          {run.sublines.map((sub, index) => (
            <div
              key={index}
              className="grid grid-cols-[14px_minmax(0,1fr)] gap-2.5 pl-[26px] text-[11.5px]"
            >
              <span className="text-term-faint">
                {index === run.sublines.length - 1 ? '└' : '├'}
              </span>
              <span className="min-w-0 break-words">
                {sub.key ? (
                  <span className="mr-2 inline-block w-[88px] text-term-dim2">
                    {sub.key}
                  </span>
                ) : null}
                <span className="text-term-dim">{sub.value}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function ToolRunFeed({
  turn,
  agent = 'claude-code',
}: {
  turn: ToolTurn
  agent?: string
}) {
  if (turn.toolRuns.length === 0) {
    return null
  }
  const elapsed = headElapsed(turn)

  return (
    <div className="my-1 font-mono">
      <div className="flex items-center gap-2.5 pb-2">
        <span className="text-[10px] uppercase tracking-[0.16em] text-term-dim2">
          agent run
        </span>
        <span className="rounded-full border border-lime/25 bg-lime/[0.07] px-2 py-0.5 text-[10px] tracking-[0.04em] text-lime">
          {agent}
        </span>
        {elapsed ? (
          <span className="ml-auto text-[10.5px] tabular-nums text-term-faint">
            {elapsed}
          </span>
        ) : null}
      </div>

      <div className="grid gap-0.5">
        {turn.toolRuns.map((run) => (
          <ToolRow key={run.id} run={run} />
        ))}
      </div>

      {turn.result?.text || turn.result?.numTurns ? (
        <div className="mt-1.5 flex items-center gap-2 border-t border-ink-line-2 pt-2 text-[11px] text-term-dim2">
          <span
            className={cn(
              turn.result.isError ? 'text-term-rose' : 'text-term-green'
            )}
          >
            {turn.result.isError ? '✗' : '●'}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {turn.result.text
              ? turn.result.text
              : `${turn.result.numTurns} turns`}
          </span>
          {turn.result.numTurns && turn.result.text ? (
            <span className="shrink-0 tabular-nums text-term-faint">
              {turn.result.numTurns} turns
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
