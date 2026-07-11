#!/usr/bin/env node
// Debug CLI for the Orrery runtime. Attaches to a running runtime HTTP server
// (dev instance by default) and drives it headlessly: inspect sessions and
// the graph, create/resume/kill sessions, tail live events.
//
//   node scripts/orrery-cli.mjs sessions
//   node scripts/orrery-cli.mjs session create --prompt "..." --cwd . --wait
//   node scripts/orrery-cli.mjs session show <id-or-prefix>
//   node scripts/orrery-cli.mjs session tail <id-or-prefix>
//   node scripts/orrery-cli.mjs graph
//
// Writes are allowed by default (real acceptance flows need them); pass
// --readonly to guard a session against accidental mutations.

import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { OrreryClient } from './lib/orrery-client.mjs'

const usage = `Usage: node scripts/orrery-cli.mjs [global flags] <command>

Commands:
  sessions [--all]                      List session summaries (--all includes archived)
  session create --prompt <text>        Create a session
    [--cwd <dir>] [--provider claude-code|codex|grok]
    [--model <model>] [--preset <name>] [--label <text>]
    [--link <session>] [--link-label <text>] [--wait] [--timeout <ms>]
  session show <id> [--view transcript|summary|raw] [--json]
  session tail <id> [--all] [--max-events <n>]
  session resume <id> --message <text> [--wait] [--timeout <ms>]
  session deliver <id>                  Write into the target's context channel (no activation)
    [--topic <key>] [--note <text>] [--content <text>] [--filename <name>]
    [--from <session>]                  Forward the source's artifact bundle when no content
  session activate <id> [--note <text>] [--wait]
                                        Run one turn: note + unread channel deliveries
  session kill <id>
  session archive <id> [--restore]
  events <id> [--since <cursor>]        Incremental provider events as JSON
  kernel [--since <seq>] [--limit <n>]  Kernel event log (actor + causeId per fact)
    [--type <eventType>] [--json]
  edge add <source> <target>            Declare a link edge between two sessions
    [--label <text>] [--reason <text>]
  edge remove <edgeId>                  Remove a link edge (other kinds are history)
  subs [--json]                         Intent layer: subscriptions + pending activations
  sub add --spec <json>                 Author a subscription (JSON per kernel doc §7.3)
  sub stop <id前缀> [--reason <text>]   Stop a subscription
  activation approve <slotKey> [--note <text>]
  activation deny <slotKey> [--reason <text>]
  graph [--json]                        Topology: clusters, nodes, edges
  state [--json]                        Runtime state (summary unless --json)

Global flags:
  --url <baseUrl>   Runtime server (default: $ORRERY_RUNTIME_URL or http://127.0.0.1:48274)
  --readonly        Reject commands that mutate runtime state
  --json            Machine-readable output where supported
`

const colorize = process.stdout.isTTY
const colors = {
  green: (text) => (colorize ? `\u001b[32m${text}\u001b[39m` : text),
  yellow: (text) => (colorize ? `\u001b[33m${text}\u001b[39m` : text),
  red: (text) => (colorize ? `\u001b[31m${text}\u001b[39m` : text),
  magenta: (text) => (colorize ? `\u001b[35m${text}\u001b[39m` : text),
  dim: (text) => (colorize ? `\u001b[2m${text}\u001b[22m` : text),
  bold: (text) => (colorize ? `\u001b[1m${text}\u001b[22m` : text),
}

function statusLabel(status) {
  switch (status) {
    case 'idle':
      return colors.green(status)
    case 'running':
      return colors.yellow(status)
    case 'failed':
      return colors.red(status)
    case 'killed':
      return colors.magenta(status)
    default:
      return colors.dim(status ?? 'unknown')
  }
}

function shortId(id) {
  return String(id ?? '').slice(0, 8)
}

function formatTable(rows) {
  if (rows.length === 0) {
    return ''
  }
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => stripAnsi(String(row[column] ?? '')).length))
  )
  return rows
    .map((row) =>
      row
        .map((cell, column) => {
          const text = String(cell ?? '')
          return text + ' '.repeat(widths[column] - stripAnsi(text).length)
        })
        .join('  ')
        .trimEnd()
    )
    .join('\n')
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(exitCode)
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function resolveSessionId(client, idOrPrefix) {
  if (!idOrPrefix) {
    fail('Missing session id', 2)
  }
  const sessions = await client.sessions()
  const exact = sessions.find((session) => session.sessionId === idOrPrefix)
  if (exact) {
    return exact.sessionId
  }
  const matches = sessions.filter((session) =>
    session.sessionId.startsWith(idOrPrefix)
  )
  if (matches.length === 1) {
    return matches[0].sessionId
  }
  if (matches.length === 0) {
    fail(`No session matches "${idOrPrefix}"`)
  }
  fail(
    `Ambiguous session prefix "${idOrPrefix}":\n${matches
      .map((session) => `  ${session.sessionId} (${session.label})`)
      .join('\n')}`
  )
}

function assertWritable(values, command) {
  if (values.readonly) {
    fail(`--readonly: refusing to run "${command}" (it mutates runtime state)`)
  }
}

// Misparsed numeric flags must error, not silently fall back: a typo like
// --timeout 5s degrading to the 5-minute default wedges scripted runs.
function positiveIntFlag(values, name) {
  const raw = values[name]
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    fail(`--${name} must be a positive integer, got "${raw}"`, 2)
  }
  return value
}

function nonNegativeIntFlag(values, name) {
  const raw = values[name]
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    fail(`--${name} must be a non-negative integer, got "${raw}"`, 2)
  }
  return value
}

function waitTimeout(values) {
  return positiveIntFlag(values, 'timeout') ?? 300_000
}

async function commandSessions(client, values) {
  const sessions = await client.sessions()
  const visible = values.all
    ? sessions
    : sessions.filter((session) => !session.archived)
  if (values.json) {
    printJson(visible)
    return
  }
  if (visible.length === 0) {
    process.stdout.write('No sessions.\n')
    return
  }
  const rows = [
    ['ID', 'LABEL', 'PROVIDER', 'ROLE', 'STATUS', 'UPDATED'].map(colors.bold),
    ...visible.map((session) => [
      shortId(session.sessionId),
      session.label + (session.archived ? colors.dim(' [archived]') : ''),
      session.providerKind,
      session.role ?? '',
      statusLabel(session.status),
      session.updatedAt ?? '',
    ]),
  ]
  process.stdout.write(`${formatTable(rows)}\n`)
}

const providerKinds = ['claude-code', 'codex', 'grok']

async function commandSessionCreate(client, values) {
  assertWritable(values, 'session create')
  if (!values.prompt) {
    fail('session create requires --prompt', 2)
  }
  if (values.provider && !providerKinds.includes(values.provider)) {
    // Fail before reaching the runtime so a typo cannot launch another provider.
    fail(`--provider must be one of: ${providerKinds.join(', ')}`, 2)
  }
  const sourceSessionId = values.link
    ? await resolveSessionId(client, values.link)
    : undefined
  const input = {
    prompt: values.prompt,
    cwd: values.cwd ?? process.cwd(),
    ...(values.provider ? { providerKind: values.provider } : {}),
    ...(values.label ? { label: values.label } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(values['link-label'] ? { linkLabel: values['link-label'] } : {}),
    ...(values.model ? { runtimeSettings: { model: values.model } } : {}),
  }
  const created = await client.createSession(input)
  process.stdout.write(`${created.sessionId}\n`)
  if (values.wait) {
    const summary = await client.waitForIdle(created.sessionId, {
      timeoutMs: waitTimeout(values),
    })
    process.stdout.write(`status: ${statusLabel(summary.status)}\n`)
    const projection = await client.transcript(created.sessionId)
    const lastAssistant = projection.messages.findLast(
      (message) => message.role === 'assistant'
    )
    if (lastAssistant) {
      process.stdout.write(`${lastAssistant.content}\n`)
    }
  }
}

function renderTimelineEntry(entry) {
  if (entry.kind === 'message') {
    const role =
      entry.message.role === 'assistant'
        ? colors.green(`[${entry.message.role}]`)
        : colors.bold(`[${entry.message.role}]`)
    const status =
      entry.message.status && entry.message.status !== 'complete'
        ? colors.dim(` (${entry.message.status})`)
        : ''
    return `${role}${status}\n${entry.message.content}\n`
  }
  if (entry.kind === 'activity') {
    const activity = entry.activity
    const title = activity.title ?? activity.detail ?? activity.kind ?? 'activity'
    return colors.dim(`  · ${activity.kind ?? 'activity'}: ${title} ${activity.status ?? ''}`.trimEnd())
  }
  if (entry.kind === 'request') {
    return colors.yellow(
      `  ? request ${entry.request.id} ${entry.request.status ?? 'open'}`
    )
  }
  if (entry.kind === 'user-input') {
    return colors.yellow(
      `  ? user-input ${entry.request.id} ${entry.request.status ?? 'open'}`
    )
  }
  if (entry.kind === 'plan') {
    return colors.dim(`  ▸ plan updated (${entry.plan.id})`)
  }
  if (entry.kind === 'turn-diff') {
    const files = entry.diff?.files?.length
    return colors.dim(`  Δ working-tree diff${files ? ` (${files} files)` : ''}`)
  }
  if (entry.kind === 'turn') {
    return entry.status === 'started'
      ? colors.dim(`── turn ${shortId(entry.turnId)} ──`)
      : undefined
  }
  return undefined
}

async function commandSessionShow(client, values, idOrPrefix) {
  const sessionId = await resolveSessionId(client, idOrPrefix)
  const view = values.view ?? 'transcript'
  const result = await client.session(sessionId, view)
  if (values.json || view === 'raw') {
    printJson(result)
    return
  }
  const summary = result.session
  const header = [
    `${colors.bold(summary.label)} ${colors.dim(summary.sessionId)}`,
    `provider: ${summary.providerKind}  role: ${summary.role ?? '-'}  status: ${statusLabel(summary.status)}`,
    `cwd: ${summary.cwd}`,
    ...(summary.runtimeSettings?.model
      ? [`model: ${summary.runtimeSettings.model}`]
      : []),
    ...(summary.error ? [colors.red(`error: ${summary.error}`)] : []),
  ]
  process.stdout.write(`${header.join('\n')}\n`)
  if (view !== 'transcript') {
    return
  }
  process.stdout.write('\n')
  for (const entry of result.projection.timeline) {
    const line = renderTimelineEntry(entry)
    if (line !== undefined) {
      process.stdout.write(`${line}\n`)
    }
  }
}

function renderRuntimeEventLine(event) {
  const id = event.sessionId ? shortId(event.sessionId) : '--------'
  switch (event.type) {
    case 'runtime.state':
    case 'provider.instances.updated':
      return undefined
    case 'session.stream':
      return undefined
    case 'provider.runtime': {
      const providerEvent = event.providerEvent ?? {}
      if (
        providerEvent.type === 'content.delta' &&
        providerEvent.streamKind === 'assistant_text' &&
        typeof providerEvent.text === 'string'
      ) {
        return { stream: providerEvent.text }
      }
      return colors.dim(`[${id}] ${providerEvent.type ?? 'provider.runtime'}`)
    }
    case 'session.failed':
      return colors.red(
        `[${id}] session.failed${event.error ? `: ${event.error}` : ''}`
      )
    case 'session.killed':
      return colors.magenta(`[${id}] session.killed`)
    default:
      return `[${id}] ${event.type}`
  }
}

// Renders tailed runtime events under a --max-events budget. A streamed
// assistant reply counts as ONE event: it claims its slot at segment start,
// keeps printing until the segment closes, and the close is where the limit
// finally stops the tail. Without this, SDK/Codex sessions (assistant output
// arrives purely as content.delta) could stream unbounded text past the
// limit. Exported for focused unit tests of the tailing contract.
export function createTailEventPrinter({ sessionId, eventLimit, write, stop }) {
  let printed = 0
  let streamingText = false
  const limitReached = () => eventLimit !== undefined && printed >= eventLimit

  const handle = (event) => {
    if (sessionId && event.sessionId !== sessionId) {
      return
    }
    const line = renderRuntimeEventLine(event)
    if (line === undefined) {
      return
    }

    if (typeof line === 'object' && line.stream) {
      if (!streamingText) {
        if (limitReached()) {
          return
        }
        printed += 1
        streamingText = true
      }
      write(line.stream)
      return
    }

    if (streamingText) {
      write('\n')
      streamingText = false
      if (limitReached()) {
        stop()
        return
      }
    }
    // stop() only interrupts the next read; events already buffered in the
    // current SSE chunk still dispatch synchronously, so re-check the limit.
    if (limitReached()) {
      return
    }
    write(`${line}\n`)
    printed += 1
    if (limitReached()) {
      stop()
    }
  }

  // Terminates a dangling streamed segment (e.g. tail stopped mid-stream).
  const flush = () => {
    if (streamingText) {
      write('\n')
      streamingText = false
    }
  }

  return { handle, flush }
}

async function commandSessionTail(client, values, idOrPrefix) {
  if (values.all && idOrPrefix) {
    fail('session tail takes either an id or --all, not both', 2)
  }
  const eventLimit = positiveIntFlag(values, 'max-events')
  const sessionId = values.all
    ? undefined
    : await resolveSessionId(client, idOrPrefix)
  const session = sessionId ? (await client.session(sessionId)).session : undefined

  const printer = createTailEventPrinter({
    sessionId,
    eventLimit,
    write: (text) => process.stdout.write(text),
    stop: () => subscription.stop(),
  })
  const subscription = client.subscribeEvents(printer.handle)

  process.on('SIGINT', () => {
    subscription.stop()
  })

  // The header doubles as a ready signal: once printed, the SSE stream is
  // registered server-side and no triggered event can be missed.
  await Promise.race([subscription.ready, subscription.done])
  if (session) {
    process.stdout.write(
      `Tailing ${colors.bold(session.label)} ${colors.dim(sessionId)} (status: ${statusLabel(session.status)}) — Ctrl+C to stop\n`
    )
  } else {
    process.stdout.write('Tailing all runtime events — Ctrl+C to stop\n')
  }

  try {
    await subscription.done
  } catch (error) {
    if (error?.name !== 'AbortError') {
      throw error
    }
  }
  printer.flush()
}

async function commandSessionDeliver(client, values, idOrPrefix) {
  assertWritable(values, 'session deliver')
  if (!values.content && !values.note && !values.from) {
    fail('session deliver requires --content, --note, or --from <session>', 2)
  }
  const sessionId = await resolveSessionId(client, idOrPrefix)
  const source = values.from
    ? await resolveSessionId(client, values.from)
    : undefined
  const result = await client.deliverToSession(sessionId, {
    topic: values.topic,
    note: values.note,
    content: values.content,
    filename: values.filename,
    source,
  })
  process.stdout.write(
    `delivered #${result.delivery.seq}${
      result.delivery.topic ? ` (topic ${result.delivery.topic})` : ''
    } -> ${sessionId}\n`
  )
  for (const file of result.delivery.files) {
    process.stdout.write(`  ${file}\n`)
  }
}

async function commandSessionActivate(client, values, idOrPrefix) {
  assertWritable(values, 'session activate')
  const sessionId = await resolveSessionId(client, idOrPrefix)
  await client.activateSession(sessionId, {
    note: values.note,
  })
  process.stdout.write(`activated ${sessionId}\n`)
  if (values.wait) {
    const summary = await client.waitForIdle(sessionId, {
      timeoutMs: waitTimeout(values),
    })
    process.stdout.write(`status: ${statusLabel(summary.status)}\n`)
  }
}

async function commandSessionResume(client, values, idOrPrefix) {
  assertWritable(values, 'session resume')
  if (!values.message) {
    fail('session resume requires --message', 2)
  }
  const sessionId = await resolveSessionId(client, idOrPrefix)
  await client.resumeSession(sessionId, { message: values.message })
  process.stdout.write(`resumed ${sessionId}\n`)
  if (values.wait) {
    const summary = await client.waitForIdle(sessionId, {
      timeoutMs: waitTimeout(values),
    })
    process.stdout.write(`status: ${statusLabel(summary.status)}\n`)
    const projection = await client.transcript(sessionId)
    const lastAssistant = projection.messages.findLast(
      (message) => message.role === 'assistant'
    )
    if (lastAssistant) {
      process.stdout.write(`${lastAssistant.content}\n`)
    }
  }
}

async function commandSessionKill(client, values, idOrPrefix) {
  assertWritable(values, 'session kill')
  const sessionId = await resolveSessionId(client, idOrPrefix)
  const result = await client.killSession(sessionId)
  process.stdout.write(
    result.ok ? `killed ${sessionId}\n` : `no active run to kill for ${sessionId}\n`
  )
}

async function commandSessionArchive(client, values, idOrPrefix) {
  assertWritable(values, 'session archive')
  const sessionId = await resolveSessionId(client, idOrPrefix)
  const archived = !values.restore
  await client.archiveSession(sessionId, archived)
  process.stdout.write(`${archived ? 'archived' : 'restored'} ${sessionId}\n`)
}

async function commandEvents(client, values, idOrPrefix) {
  const sessionId = await resolveSessionId(client, idOrPrefix)
  const result = await client.events(sessionId, values.since)
  printJson(result)
}

function describeSubscriptionSource(source) {
  return source?.kind === 'cluster'
    ? `cluster:${source.clusterId.slice(0, 8)}`
    : source?.sessionId?.slice(0, 8) ?? '?'
}

async function commandSubs(client, values) {
  const state = await client.state()
  const subscriptions = Object.values(state.subscriptions ?? {})
  const pending = Object.values(state.pendingActivations ?? {})
  if (values.json) {
    printJson({ subscriptions, pendingActivations: pending })
    return
  }
  if (subscriptions.length === 0) {
    process.stdout.write('No subscriptions.\n')
  }
  for (const sub of subscriptions) {
    const stop = sub.stop
      ? Object.entries(sub.stop)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(' ')
      : 'none'
    process.stdout.write(
      `${sub.id} ${colors.bold(sub.label ?? '')} [${sub.state}] ` +
        `${describeSubscriptionSource(sub.source)} --${sub.on.on}--> ${sub.target.sessionId.slice(0, 8)} ` +
        `gate=${sub.gate} ${sub.concurrency} firings=${sub.firings} stop: ${stop}\n`
    )
  }
  for (const slot of pending) {
    process.stdout.write(
      colors.dim(
        `pending ${slot.slotKey} [${slot.status}]${
          slot.masterSessionId ? ` master=${slot.masterSessionId.slice(0, 8)}` : ''
        }\n`
      )
    )
  }
}

async function commandSubAdd(client, values) {
  assertWritable(values, 'sub add')
  if (!values.spec) {
    fail('sub add requires --spec <json>', 2)
  }
  let spec
  try {
    spec = JSON.parse(values.spec)
  } catch (error) {
    fail(`sub add --spec is not valid JSON: ${error.message}`, 2)
  }
  const result = await client.authorSubscription(spec)
  printJson(result)
}

async function commandSubStop(client, values, idOrPrefix) {
  assertWritable(values, 'sub stop')
  if (!idOrPrefix) {
    fail('sub stop requires a subscription id', 2)
  }
  const state = await client.state()
  const ids = Object.keys(state.subscriptions ?? {}).filter((id) =>
    id.startsWith(idOrPrefix)
  )
  if (ids.length === 0) {
    fail(`No subscription matches: ${idOrPrefix}`)
  }
  if (ids.length > 1) {
    fail(`Ambiguous subscription prefix ${idOrPrefix}: ${ids.join(', ')}`)
  }
  await client.stopSubscription(ids[0], { reason: values.reason })
  process.stdout.write(`stopped ${ids[0]}\n`)
}

async function commandActivationDecision(client, values, decision, slotKey) {
  assertWritable(values, `activation ${decision}`)
  if (!slotKey) {
    fail(`activation ${decision} requires a slotKey`, 2)
  }
  if (decision === 'approve') {
    await client.approveActivation({ slotKey, note: values.note })
  } else {
    await client.denyActivation({ slotKey, reason: values.reason })
  }
  process.stdout.write(`${decision}d ${slotKey}\n`)
}

function kernelActorLabel(actor) {
  if (!actor || typeof actor !== 'object') {
    return 'unknown'
  }
  return actor.ref ? `${actor.kind}:${actor.ref}` : `${actor.kind ?? 'unknown'}`
}

async function commandKernel(client, values) {
  const result = await client.kernelEvents({
    since: nonNegativeIntFlag(values, 'since'),
    limit: positiveIntFlag(values, 'limit'),
    type: values.type,
  })

  if (values.json) {
    printJson(result)
    return
  }

  if (result.events.length === 0) {
    process.stdout.write(`No kernel events (latestSeq=${result.latestSeq}).\n`)
    return
  }

  for (const event of result.events) {
    const cause = event.causeId ? ` cause=${event.causeId.slice(0, 8)}` : ''
    const reason = event.reason ? ` ${colors.dim(`# ${event.reason}`)}` : ''
    const payload = colors.dim(JSON.stringify(event.payload))
    process.stdout.write(
      `${String(event.seq).padStart(5)} ${colors.dim(event.ts)} ${colors.bold(event.type)} ` +
        `actor=${kernelActorLabel(event.actor)} id=${event.id.slice(0, 8)}${cause}${reason}\n` +
        `      ${payload}\n`
    )
  }
  process.stdout.write(colors.dim(`latestSeq=${result.latestSeq}\n`))
}

async function resolveEdgeId(client, idOrPrefix) {
  if (!idOrPrefix) {
    fail('Missing edge id', 2)
  }
  const graph = await client.graph()
  const exact = graph.edges.find((edge) => edge.edgeId === idOrPrefix)
  if (exact) {
    return exact.edgeId
  }
  const matches = graph.edges.filter((edge) => edge.edgeId.startsWith(idOrPrefix))
  if (matches.length === 1) {
    return matches[0].edgeId
  }
  if (matches.length === 0) {
    fail(`No edge matches "${idOrPrefix}"`)
  }
  fail(
    `Ambiguous edge prefix "${idOrPrefix}":\n${matches
      .map((edge) => `  ${edge.edgeId} (${edge.kind} ${shortId(edge.source)} -> ${shortId(edge.target)})`)
      .join('\n')}`
  )
}

async function commandEdgeAdd(client, values, sourceArg, targetArg) {
  assertWritable(values, 'edge add')
  const source = await resolveSessionId(client, sourceArg)
  const target = await resolveSessionId(client, targetArg)
  const { edge } = await client.linkSessions(source, target, {
    label: values.label,
    reason: values.reason,
  })
  process.stdout.write(
    `${edge.edgeId}\n${shortId(edge.source)} -[${edge.kind}${edge.label ? ` "${edge.label}"` : ''}]-> ${shortId(edge.target)}\n`
  )
}

async function commandEdgeRemove(client, values, idOrPrefix) {
  assertWritable(values, 'edge remove')
  const edgeId = await resolveEdgeId(client, idOrPrefix)
  await client.removeEdge(edgeId)
  process.stdout.write(`removed ${edgeId}\n`)
}

async function commandGraph(client, values) {
  const graph = await client.graph()
  if (values.json) {
    printJson(graph)
    return
  }
  const clusters = Object.values(graph.clusters ?? {})
  const clusteredNodeIds = new Set()
  const nodeLine = (node) => {
    const marker = node.role === 'master' ? '●' : '○'
    const frozen = node.frozen ? colors.dim(' [frozen]') : ''
    return `  ${marker} ${shortId(node.sessionId)} ${node.label} (${statusLabel(node.status)})${frozen}`
  }

  for (const cluster of clusters) {
    const frozen = cluster.frozen ? colors.dim(' [frozen]') : ''
    process.stdout.write(
      `${colors.bold(`Cluster ${cluster.label ?? cluster.clusterId}`)}${frozen}\n`
    )
    const memberIds = new Set([
      ...(cluster.masterSessionId ? [cluster.masterSessionId] : []),
      ...(cluster.nodeIds ?? []),
    ])
    for (const node of graph.nodes) {
      if (memberIds.has(node.sessionId)) {
        clusteredNodeIds.add(node.sessionId)
        process.stdout.write(`${nodeLine(node)}\n`)
      }
    }
  }

  const standalone = graph.nodes.filter(
    (node) => !clusteredNodeIds.has(node.sessionId)
  )
  if (standalone.length > 0) {
    if (clusters.length > 0) {
      process.stdout.write(`${colors.bold('Standalone')}\n`)
    }
    for (const node of standalone) {
      process.stdout.write(`${nodeLine(node)}\n`)
    }
  }
  if (graph.nodes.length === 0) {
    process.stdout.write('No nodes.\n')
  }

  if ((graph.edges ?? []).length > 0) {
    process.stdout.write(`${colors.bold('Edges')}\n`)
    for (const edge of graph.edges) {
      const label = edge.label ? ` "${edge.label}"` : ''
      // Link edges are the removable kind, so show an id prefix usable with
      // `edge remove`.
      const edgeRef =
        edge.kind === 'link' ? colors.dim(`  (${edge.edgeId.slice(0, 13)}…)`) : ''
      process.stdout.write(
        `  ${shortId(edge.source)} -[${edge.kind}${label}]-> ${shortId(edge.target)}${edgeRef}\n`
      )
    }
  }
}

async function commandState(client, values) {
  const state = await client.state()
  if (values.json) {
    printJson(state)
    return
  }
  const sessions = Object.values(state.sessions ?? {})
  const byStatus = {}
  for (const session of sessions) {
    byStatus[session.status] = (byStatus[session.status] ?? 0) + 1
  }
  const statusSummary =
    Object.entries(byStatus)
      .map(([status, count]) => `${status}=${count}`)
      .join(' ') || 'none'
  process.stdout.write(
    [
      `version: ${state.version}  updated: ${state.updatedAt}`,
      `sessions: ${sessions.length} (${statusSummary})`,
      `nodes: ${state.nodes.length}  edges: ${state.edges.length}  clusters: ${Object.keys(state.clusters ?? {}).length}  reports: ${(state.reports ?? []).length}`,
      `providers: ${(state.providerInstances ?? [])
        .map((instance) => instance.providerInstanceId)
        .join(', ')}`,
    ].join('\n') + '\n'
  )
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      readonly: { type: 'boolean' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      prompt: { type: 'string' },
      cwd: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      preset: { type: 'string' },
      label: { type: 'string' },
      reason: { type: 'string' },
      link: { type: 'string' },
      'link-label': { type: 'string' },
      view: { type: 'string' },
      message: { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      restore: { type: 'boolean' },
      since: { type: 'string' },
      limit: { type: 'string' },
      type: { type: 'string' },
      topic: { type: 'string' },
      note: { type: 'string' },
      spec: { type: 'string' },
      content: { type: 'string' },
      filename: { type: 'string' },
      from: { type: 'string' },
      'max-events': { type: 'string' },
      help: { type: 'boolean' },
    },
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    process.exit(positionals.length === 0 && !values.help ? 2 : 0)
  }

  const baseUrl =
    values.url ?? process.env.ORRERY_RUNTIME_URL ?? 'http://127.0.0.1:48274'
  const client = OrreryClient.attach(baseUrl, {
    ...(values.preset ? { modelPreset: values.preset } : {}),
  })

  const [command, subcommand, target, extra] = positionals

  if (command === 'sessions') {
    return commandSessions(client, values)
  }
  if (command === 'graph') {
    return commandGraph(client, values)
  }
  if (command === 'state') {
    return commandState(client, values)
  }
  if (command === 'events') {
    return commandEvents(client, values, subcommand)
  }
  if (command === 'kernel') {
    return commandKernel(client, values)
  }
  if (command === 'subs') {
    return commandSubs(client, values)
  }
  if (command === 'sub') {
    switch (subcommand) {
      case 'add':
        return commandSubAdd(client, values)
      case 'stop':
        return commandSubStop(client, values, target)
      default:
        fail(`Unknown sub subcommand: ${subcommand ?? ''}\n\n${usage}`, 2)
    }
  }
  if (command === 'activation') {
    switch (subcommand) {
      case 'approve':
      case 'deny':
        return commandActivationDecision(client, values, subcommand, target)
      default:
        fail(`Unknown activation subcommand: ${subcommand ?? ''}\n\n${usage}`, 2)
    }
  }
  if (command === 'edge') {
    switch (subcommand) {
      case 'add':
        return commandEdgeAdd(client, values, target, extra)
      case 'remove':
        return commandEdgeRemove(client, values, target)
      default:
        fail(`Unknown edge subcommand: ${subcommand ?? ''}\n\n${usage}`, 2)
    }
  }
  if (command === 'session') {
    switch (subcommand) {
      case 'create':
        return commandSessionCreate(client, values)
      case 'show':
        return commandSessionShow(client, values, target)
      case 'tail':
        return commandSessionTail(client, values, target)
      case 'deliver':
        return commandSessionDeliver(client, values, target)
      case 'activate':
        return commandSessionActivate(client, values, target)
      case 'resume':
        return commandSessionResume(client, values, target)
      case 'kill':
        return commandSessionKill(client, values, target)
      case 'archive':
        return commandSessionArchive(client, values, target)
      default:
        fail(`Unknown session subcommand: ${subcommand ?? ''}\n\n${usage}`, 2)
    }
  }
  fail(`Unknown command: ${command}\n\n${usage}`, 2)
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  // Piping into head/grep closes stdout early; treat that as a clean exit
  // instead of an unhandled EPIPE crash.
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') {
      process.exit(0)
    }
    throw error
  })
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error)
    if (/fetch failed/i.test(detail)) {
      fail(
        `Cannot reach the runtime server. Is it running? Start one with:\n  npm run runtime:http\n(${detail})`
      )
    }
    fail(detail)
  })
}
