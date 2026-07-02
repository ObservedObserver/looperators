import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react'
import {
  Button,
} from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  cn,
} from '@/lib/utils'
import {
  type RuntimeTerminal,
  type RuntimeTerminalChunk,
  type RuntimeTerminalStatus,
} from '@/shared/graph-state'
import {
  statePillBase,
} from '@/lib/session-display'
import {
  compactPath,
} from '@/lib/format'

export function terminalStatusPillCls(status: RuntimeTerminalStatus) {
  switch (status) {
    case 'running':
      return 'border-term-green/35 bg-term-green/10 text-term-green'
    case 'exited':
      return 'border-term-amber/35 bg-term-amber/10 text-term-amber'
    case 'closed':
    default:
      return 'border-ink-line bg-foreground/[0.04] text-term-dim'
  }
}

export function terminalChunkClassName(chunk: RuntimeTerminalChunk) {
  switch (chunk.stream) {
    case 'stdin':
      return 'text-lime-hi'
    case 'stderr':
      return 'text-term-rose'
    case 'system':
      return 'text-term-dim2'
    case 'stdout':
    default:
      return 'text-term-name'
  }
}

export function SessionTerminalPanel({
  terminal,
  isOpening,
  isSending,
  onSubmit,
  onClear,
  onClose,
}: {
  terminal: RuntimeTerminal
  isOpening?: boolean
  isSending?: boolean
  onSubmit: (command: string) => void
  onClear: () => void
  onClose: () => void
}) {
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const commandRunning = terminal.currentCommand?.status === 'running'
  const inputDisabled = isOpening || isSending || terminal.status !== 'running'
  const canEdit = !inputDisabled && !commandRunning
  const cursorChar = draft[cursorIndex] ?? ' '
  const beforeCursor = draft.slice(0, cursorIndex)
  const afterCursor = draft.slice(Math.min(cursorIndex + 1, draft.length))

  useEffect(() => {
    const terminalSurface = terminalRef.current
    if (!terminalSurface) {
      return
    }

    terminalSurface.scrollTop = terminalSurface.scrollHeight
  }, [cursorIndex, draft, terminal.chunks.length, terminal.updatedAt])

  useEffect(() => {
    setDraft('')
    setCursorIndex(0)
    setHistoryIndex(null)
    window.setTimeout(() => terminalRef.current?.focus(), 0)
  }, [terminal.terminalId])

  const insertDraftText = useCallback(
    (text: string) => {
      if (!canEdit || text.length === 0) {
        return
      }

      const normalized = text.replace(/\r\n?/g, '\n')
      const nextDraft = `${draft.slice(0, cursorIndex)}${normalized}${draft.slice(
        cursorIndex
      )}`
      setDraft(nextDraft)
      setCursorIndex(cursorIndex + normalized.length)
      setHistoryIndex(null)
    },
    [canEdit, cursorIndex, draft]
  )

  const submitDraft = useCallback(() => {
    if (!canEdit) {
      return
    }

    const command = draft
    setDraft('')
    setCursorIndex(0)
    setHistoryIndex(null)
    if (command.trim().length > 0) {
      setHistory((current) => [...current, command].slice(-100))
    }
    onSubmit(command)
  }, [canEdit, draft, onSubmit])

  const recallHistory = useCallback(
    (direction: -1 | 1) => {
      if (!canEdit || history.length === 0) {
        return
      }

      let nextIndex: number | null
      if (historyIndex === null) {
        nextIndex = direction < 0 ? history.length - 1 : null
      } else {
        const candidate = historyIndex + direction
        nextIndex =
          candidate < 0
            ? 0
            : candidate >= history.length
              ? null
              : candidate
      }

      setHistoryIndex(nextIndex)
      const nextDraft = nextIndex === null ? '' : history[nextIndex]
      setDraft(nextDraft)
      setCursorIndex(nextDraft.length)
    },
    [canEdit, history, historyIndex]
  )

  const handleTerminalKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!canEdit) {
        return
      }
      if (event.metaKey || event.altKey) {
        return
      }

      if (event.ctrlKey) {
        if (event.key.toLowerCase() === 'l') {
          event.preventDefault()
          onClear()
        }
        return
      }

      switch (event.key) {
        case 'Enter':
          event.preventDefault()
          submitDraft()
          return
        case 'Backspace':
          event.preventDefault()
          if (cursorIndex > 0) {
            setDraft(`${draft.slice(0, cursorIndex - 1)}${draft.slice(cursorIndex)}`)
            setCursorIndex(cursorIndex - 1)
            setHistoryIndex(null)
          }
          return
        case 'Delete':
          event.preventDefault()
          if (cursorIndex < draft.length) {
            setDraft(`${draft.slice(0, cursorIndex)}${draft.slice(cursorIndex + 1)}`)
            setHistoryIndex(null)
          }
          return
        case 'ArrowLeft':
          event.preventDefault()
          setCursorIndex((current) => Math.max(0, current - 1))
          return
        case 'ArrowRight':
          event.preventDefault()
          setCursorIndex((current) => Math.min(draft.length, current + 1))
          return
        case 'Home':
          event.preventDefault()
          setCursorIndex(0)
          return
        case 'End':
          event.preventDefault()
          setCursorIndex(draft.length)
          return
        case 'ArrowUp':
          event.preventDefault()
          recallHistory(-1)
          return
        case 'ArrowDown':
          event.preventDefault()
          recallHistory(1)
          return
        case 'Tab':
          event.preventDefault()
          insertDraftText('  ')
          return
        default:
          break
      }

      if (event.key.length === 1) {
        event.preventDefault()
        insertDraftText(event.key)
      }
    },
    [
      canEdit,
      cursorIndex,
      draft,
      insertDraftText,
      onClear,
      recallHistory,
      submitDraft,
    ]
  )

  return (
    <section
      className="shrink-0 border-t border-ink-line-2 bg-ink font-mono"
      aria-label="Session terminal"
    >
      <div className="flex h-9 min-w-0 items-center gap-2 border-b border-ink-line-2 px-3">
        <Terminal className="size-3.5 shrink-0 text-lime-hi" />
        <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-term-dim2">
          Terminal
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-term-dim"
          title={terminal.cwd}
        >
          {compactPath(terminal.cwd)}
        </span>
        {terminal.lastCommand ? (
          <span className="hidden shrink-0 text-[10.5px] tabular-nums text-term-dim2 min-[1180px]:inline">
            exit {terminal.lastCommand.exitCode ?? 'n/a'}
          </span>
        ) : null}
        <span className={cn(statePillBase, terminalStatusPillCls(terminal.status))}>
          {commandRunning ? 'running' : terminal.status}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="size-7 shrink-0"
              variant="ghost"
              size="icon-sm"
              disabled={terminal.chunks.length === 0}
              aria-label="Clear Terminal"
              onClick={onClear}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="size-7 shrink-0"
              variant="ghost"
              size="icon-sm"
              aria-label="Close Terminal"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>

      <div
        ref={terminalRef}
        className="h-56 cursor-text overflow-y-auto overscroll-contain px-3 py-2 text-[12px] leading-5 outline-none focus:ring-1 focus:ring-inset focus:ring-lime-hi/25"
        role="textbox"
        tabIndex={0}
        aria-label="Terminal"
        aria-multiline="true"
        onClick={() => terminalRef.current?.focus()}
        onKeyDown={handleTerminalKeyDown}
        onPaste={(event) => {
          if (!canEdit) {
            return
          }

          const text = event.clipboardData.getData('text/plain')
          if (text.length > 0) {
            event.preventDefault()
            insertDraftText(text)
          }
        }}
      >
        <pre className="min-h-full whitespace-pre-wrap break-words font-mono text-term-name">
          {terminal.chunks.map((chunk) => (
            <span key={chunk.id} className={terminalChunkClassName(chunk)}>
              {chunk.text}
            </span>
          ))}
          {canEdit ? (
            <span>
              <span className="text-term-dim">{terminal.prompt}</span>
              <span>{beforeCursor}</span>
              <span className="animate-pulse bg-term-name text-ink">
                {cursorChar}
              </span>
              <span>{afterCursor}</span>
            </span>
          ) : terminal.status === 'running' ? (
            <span className="text-term-faint">
              {commandRunning ? 'command running...' : ''}
            </span>
          ) : (
            <span className="text-term-faint">{terminal.status}</span>
          )}
        </pre>
      </div>
    </section>
  )
}
