import type { AgentStreamChunk } from './graph-state'
import type { RuntimeActivity } from './provider-runtime'

/**
 * Parses Claude CLI `--output-format=stream-json` chunks (as stored on
 * `AgentSession.chunks[].raw`) into a structured tool run-feed.
 *
 * Only the consolidated `assistant` / `user` / `result` events are inspected;
 * `stream_event` partials are ignored (the tool_use is fully present on the
 * consolidated `assistant` event). The transcript zips the resulting turns to
 * assistant messages in order — see `App.tsx`.
 */

export type ToolRunStatus = 'running' | 'ok' | 'error'

export type ToolSubline = {
  key?: string
  value: string
}

export type ToolRun = {
  /** tool_use id (`toolu_…`). */
  id: string
  /** raw Claude tool name (`Read`, `Bash`, `mcp__orrery_membrane__report`). */
  name: string
  /** terminalized command label (`read_file`, `bash`, `membrane.report`). */
  command: string
  /** short argument summary shown after the command. */
  args?: string
  /** optional detail lines parsed from the tool result. */
  sublines: ToolSubline[]
  status: ToolRunStatus
  durationMs?: number
}

export type ToolTurnResult = {
  durationMs?: number
  numTurns?: number
  isError?: boolean
  text?: string
}

/** One `claude -p` invocation worth of tool activity. */
export type ToolTurn = {
  turnId?: string
  toolRuns: ToolRun[]
  result?: ToolTurnResult
}

type ParsedEvent = Record<string, unknown>

function parseRaw(raw: string): ParsedEvent | undefined {
  if (!raw || raw[0] !== '{') {
    return undefined
  }
  try {
    return JSON.parse(raw) as ParsedEvent
  } catch {
    return undefined
  }
}

function basename(value: string): string {
  const cleaned = value.split(/[?#]/)[0].replace(/\/+$/, '')
  const parts = cleaned.split('/')
  return parts[parts.length - 1] || cleaned
}

function hostname(value: string): string {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(value)
  return match ? match[1].replace(/^www\./, '') : value
}

function clamp(value: string, max = 52): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Maps a Claude tool name to a terminal-style command label. */
export function toolCommand(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = (parts[1] ?? '').replace(/^orrery_/, '')
    const tool = parts.slice(2).join('_') || parts[1] || name
    return server ? `${server}.${tool}` : tool
  }
  switch (name) {
    case 'Read':
      return 'read_file'
    case 'Edit':
    case 'MultiEdit':
      return 'apply_patch'
    case 'Write':
      return 'write_file'
    case 'NotebookEdit':
      return 'notebook_edit'
    case 'Bash':
      return 'bash'
    case 'BashOutput':
      return 'bash_output'
    case 'Grep':
      return 'grep'
    case 'Glob':
      return 'glob'
    case 'Task':
      return 'task'
    case 'WebFetch':
      return 'web.fetch'
    case 'WebSearch':
      return 'web.search'
    case 'TodoWrite':
      return 'todo_write'
    default:
      return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .toLowerCase()
  }
}

/** Extracts a short argument summary from a tool's input. */
export function toolArgs(name: string, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined
  }
  const obj = input as Record<string, unknown>

  if (name === 'Read' || name === 'Write' || name === 'NotebookEdit') {
    const file = asString(obj.file_path ?? obj.notebook_path ?? obj.path)
    return file ? basename(file) : undefined
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const file = asString(obj.file_path)
    return file ? basename(file) : undefined
  }
  if (name === 'Bash') {
    const cmd = asString(obj.command)
    return cmd ? clamp(cmd, 56) : undefined
  }
  if (name === 'Grep') {
    const pattern = asString(obj.pattern)
    const path = asString(obj.path)
    const where = path ? ` ${basename(path)}` : ''
    return pattern ? clamp(`"${pattern}"${where}`) : undefined
  }
  if (name === 'Glob') {
    return asString(obj.pattern)
  }
  if (name === 'Task') {
    return clamp(asString(obj.description ?? obj.prompt) ?? '')
  }
  if (name === 'WebFetch') {
    const url = asString(obj.url)
    return url ? hostname(url) : undefined
  }
  if (name === 'WebSearch') {
    return clamp(asString(obj.query) ?? '')
  }
  if (name === 'TodoWrite') {
    const todos = obj.todos
    return Array.isArray(todos) ? `${todos.length} items` : undefined
  }
  if (name.startsWith('mcp__')) {
    const label =
      asString(obj.label) ??
      asString(obj.verdict) ??
      asString(obj.type) ??
      asString(obj.agent) ??
      asString(obj.sessionId)
    return label ? clamp(label, 40) : undefined
  }

  // Generic: first short string field.
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.length > 0) {
      return clamp(value)
    }
  }
  return undefined
}

/** Flattens a tool_result `content` (string | block[]) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const text = (block as Record<string, unknown>).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

/** Turns a short tool result into at most three tree sublines. */
function resultSublines(text: string): ToolSubline[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return []
  }
  if (lines.length <= 3 && lines.every((line) => line.length <= 60)) {
    return lines.map((line) => ({ value: line }))
  }
  return [{ value: clamp(lines[0], 60) }]
}

function durationMs(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined
  }
  return end - start
}

/** Formats a duration for display (`40ms`, `1.2s`). */
export function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

/**
 * Parses a session's chunks into ordered turns (one per `claude -p` run).
 * A turn is closed by its `result` event; a trailing turn with pending tools
 * is left open (its unmatched tools render as `running`).
 */
export function parseToolTurns(chunks: AgentStreamChunk[]): ToolTurn[] {
  const turns: ToolTurn[] = []
  let current: ToolTurn = { toolRuns: [] }
  // tool_use id -> { run, startedAt } for matching results within the run.
  let pending = new Map<string, { run: ToolRun; startedAt?: string }>()

  const closeTurn = (result?: ToolTurnResult) => {
    if (result) current.result = result
    if (current.toolRuns.length > 0 || result) {
      turns.push(current)
    }
    current = { toolRuns: [] }
    pending = new Map()
  }

  for (const chunk of chunks) {
    if (chunk.stream !== 'stdout') continue
    const type = chunk.eventType
    if (type !== 'assistant' && type !== 'user' && type !== 'result') {
      continue
    }
    const event = parseRaw(chunk.raw)
    if (!event) continue

    if (type === 'assistant') {
      const message = event.message as ParsedEvent | undefined
      const content = message?.content
      if (!Array.isArray(content)) continue
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as ParsedEvent).type === 'tool_use'
        ) {
          const block = item as Record<string, unknown>
          const id = asString(block.id) ?? `tool-${current.toolRuns.length}`
          const name = asString(block.name) ?? 'tool'
          const run: ToolRun = {
            id,
            name,
            command: toolCommand(name),
            args: toolArgs(name, block.input),
            sublines: [],
            status: 'running',
          }
          current.toolRuns.push(run)
          pending.set(id, { run, startedAt: chunk.ts })
        }
      }
      continue
    }

    if (type === 'user') {
      const message = event.message as ParsedEvent | undefined
      const content = message?.content
      if (!Array.isArray(content)) continue
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as ParsedEvent).type === 'tool_result'
        ) {
          const block = item as Record<string, unknown>
          const refId = asString(block.tool_use_id)
          if (!refId) continue
          const match = pending.get(refId)
          if (!match) continue
          const isError = block.is_error === true
          match.run.status = isError ? 'error' : 'ok'
          match.run.durationMs = durationMs(match.startedAt, chunk.ts)
          match.run.sublines = resultSublines(toolResultText(block.content))
          pending.delete(refId)
        }
      }
      continue
    }

    // type === 'result' — closes the turn.
    closeTurn({
      durationMs:
        typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
      numTurns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
      isError: event.is_error === true,
      text: asString(event.result),
    })
  }

  // Flush a trailing open turn (still-running tools).
  if (current.toolRuns.length > 0) {
    turns.push(current)
  }

  return turns
}

function activityStatus(status: RuntimeActivity['status']): ToolRunStatus {
  if (status === 'completed') {
    return 'ok'
  }
  if (status === 'failed') {
    return 'error'
  }
  return 'running'
}

export function toolTurnsFromRuntimeActivities(
  activities: RuntimeActivity[]
): Map<string, ToolTurn> {
  const turns = new Map<string, ToolTurn>()

  for (const activity of activities) {
    if (!activity.turnId) {
      continue
    }

    const turn = turns.get(activity.turnId) ?? {
      turnId: activity.turnId,
      toolRuns: [],
    }
    const existing = turn.toolRuns.find((run) => run.id === activity.id)
    const run: ToolRun = {
      id: activity.id,
      name: activity.providerName ?? activity.title,
      command: activity.command ?? toolCommand(activity.providerName ?? activity.title),
      args: activity.args,
      sublines: activity.sublines ?? [],
      status: activityStatus(activity.status),
      durationMs: activity.durationMs,
    }

    if (existing) {
      Object.assign(existing, run)
    } else {
      turn.toolRuns.push(run)
    }

    turns.set(activity.turnId, turn)
  }

  return turns
}
