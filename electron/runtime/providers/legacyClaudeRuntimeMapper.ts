import { randomUUID } from 'node:crypto'

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

function basename(value) {
  const cleaned = value.split(/[?#]/)[0].replace(/\/+$/, '')
  const parts = cleaned.split('/')
  return parts[parts.length - 1] || cleaned
}

function hostname(value) {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(value)
  return match ? match[1].replace(/^www\./, '') : value
}

function clamp(value, max = 52) {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}...` : oneLine
}

export function toolCommand(name) {
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

function toolArgs(name, input) {
  if (input === null || typeof input !== 'object') {
    return undefined
  }

  if (name === 'Read' || name === 'Write' || name === 'NotebookEdit') {
    const file = asString(input.file_path ?? input.notebook_path ?? input.path)
    return file ? basename(file) : undefined
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const file = asString(input.file_path)
    return file ? basename(file) : undefined
  }
  if (name === 'Bash') {
    const cmd = asString(input.command)
    return cmd ? clamp(cmd, 56) : undefined
  }
  if (name === 'Grep') {
    const pattern = asString(input.pattern)
    const path = asString(input.path)
    const where = path ? ` ${basename(path)}` : ''
    return pattern ? clamp(`"${pattern}"${where}`) : undefined
  }
  if (name === 'Glob') {
    return asString(input.pattern)
  }
  if (name === 'Task') {
    return clamp(asString(input.description ?? input.prompt) ?? '')
  }
  if (name === 'WebFetch') {
    const url = asString(input.url)
    return url ? hostname(url) : undefined
  }
  if (name === 'WebSearch') {
    return clamp(asString(input.query) ?? '')
  }
  if (name === 'TodoWrite') {
    return Array.isArray(input.todos) ? `${input.todos.length} items` : undefined
  }
  if (name.startsWith('mcp__')) {
    const label =
      asString(input.label) ??
      asString(input.verdict) ??
      asString(input.type) ??
      asString(input.agent) ??
      asString(input.sessionId)
    return label ? clamp(label, 40) : undefined
  }

  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) {
      return clamp(value)
    }
  }
  return undefined
}

function toolResultText(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block
      }
      if (block && typeof block === 'object') {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    })
    .join('')
}

export function resultSublines(text) {
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

function rawEnvelope(event, source = 'legacy.claude-cli.stream-json') {
  return {
    source,
    messageType:
      event?.type === 'stream_event' && typeof event.event?.type === 'string'
        ? `${event.type}:${event.event.type}`
        : event?.type,
    payload: event,
  }
}

function providerEvent(base, raw) {
  return {
    id: randomUUID(),
    ts: base.ts,
    sessionId: base.sessionId,
    raw,
  }
}

function runtimeItemFromToolUse(base, raw, block) {
  const providerName = asString(block.name) ?? 'tool'
  const id = asString(block.id) ?? randomUUID()
  const command = toolCommand(providerName)

  return {
    id,
    sessionId: base.sessionId,
    turnId: base.turnId,
    kind: 'tool_call',
    providerName,
    command,
    args: toolArgs(providerName, block.input),
    title: command,
    status: 'running',
    input: block.input,
    startedAt: base.ts,
    updatedAt: base.ts,
    raw,
  }
}

function runtimeItemFromToolResult(base, raw, block) {
  const id = asString(block.tool_use_id) ?? randomUUID()
  const output = toolResultText(block.content)
  const isError = block.is_error === true

  return {
    id,
    sessionId: base.sessionId,
    turnId: base.turnId,
    kind: 'tool_call',
    title: id,
    status: isError ? 'failed' : 'completed',
    output,
    error: isError ? output || 'Tool failed.' : undefined,
    updatedAt: base.ts,
    completedAt: base.ts,
    raw,
  }
}

export function legacyClaudeRuntimeEventsFromChunk({
  sessionId,
  turnId,
  ts,
  chunk,
  sawTextDelta = false,
  rawSource = 'legacy.claude-cli.stream-json',
}) {
  const event = chunk?.event
  if (!event || chunk.stream !== 'stdout') {
    return []
  }

  const raw = rawEnvelope(event, rawSource)
  const base = { sessionId, turnId, ts }
  const eventBase = providerEvent(base, raw)
  const events = []

  if (
    event.type === 'stream_event' &&
    event.event?.type === 'content_block_delta' &&
    event.event?.delta?.type === 'text_delta' &&
    typeof event.event.delta.text === 'string'
  ) {
    events.push({
      ...eventBase,
      type: 'content.delta',
      turnId,
      streamKind: 'assistant_text',
      text: event.event.delta.text,
    })
    return events
  }

  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (!block || typeof block !== 'object') {
        continue
      }

      if (block.type === 'text' && typeof block.text === 'string' && !sawTextDelta) {
        events.push({
          ...providerEvent(base, raw),
          type: 'content.delta',
          turnId,
          streamKind: 'assistant_text',
          text: block.text,
          isSnapshot: true,
        })
      }

      if (block.type === 'tool_use') {
        const item = runtimeItemFromToolUse(base, raw, block)
        events.push({
          ...providerEvent(base, raw),
          type: 'item.started',
          item,
        })
      }
    }
    return events
  }

  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') {
        continue
      }

      const item = runtimeItemFromToolResult(base, raw, block)
      events.push({
        ...providerEvent(base, raw),
        type: 'item.completed',
        item,
      })
    }
    return events
  }

  if (event.type === 'result') {
    events.push({
      ...eventBase,
      type: 'turn.completed',
      turnId,
    })
  }

  return events
}
