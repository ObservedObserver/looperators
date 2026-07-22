import { externalSourceSummary } from '../../../shared/graph-core/index.js'
import { boundedText, type JsonRecord } from '../runtimeCommon.js'

export function pendingRequestText(
  state: JsonRecord,
  slot: JsonRecord,
  subscription: JsonRecord | undefined,
) {
  // External triggers have no source session: name the registered source and
  // show the event itself so the gate decision is informed.
  const external = slot.externalEvent
  const externalSource = external
    ? state.sources?.[external.payload?.sourceId]
    : undefined
  const sourceLabel = slot.sourceSessionId
    ? (state.sessions[slot.sourceSessionId]?.label ?? slot.sourceSessionId)
    : externalSource
      ? externalSourceSummary(externalSource)
      : external
        ? (external.payload?.sourceId ?? 'external source')
        : 'unknown'
  const targetLabel = state.sessions[slot.target]?.label ?? slot.target
  const trigger = slot.reportId
    ? `report ${slot.reportId}`
    : external
      ? `external event ${external.type}`
      : 'a finished turn'
  let eventLine
  if (external) {
    const { sourceId: _sourceId, ...payload } = external.payload ?? {}
    const rendered = JSON.stringify(payload)
    eventLine = `Event payload: ${rendered.length > 600 ? `${rendered.slice(0, 600)}…` : rendered}`
  }
  return [
    `Pending activation requires your decision (slotKey: ${slot.slotKey}).`,
    `Subscription ${subscription?.label ?? slot.subscriptionId}: ${sourceLabel} → ${targetLabel}, triggered by ${trigger} from ${sourceLabel}.`,
    ...(eventLine ? [eventLine] : []),
    `To allow it, call mcp__orrery_membrane__approve_activation exactly once with {"slotKey":"${slot.slotKey}"} — you may add "note" with extra instructions for the target.`,
    `To reject it, call mcp__orrery_membrane__deny_activation exactly once with {"slotKey":"${slot.slotKey}","reason":"..."}.`,
    'Then stop.',
  ].join('\n')
}

export function renderReportMarkdown(state: JsonRecord, report: JsonRecord) {
  const payload = report.payload ?? {}
  const lines = [
    `# Report from ${state.sessions[report.from]?.label ?? report.from}`,
  ]
  if (payload.type === 'verdict') {
    lines.push(`Verdict: ${payload.verdict}`)
    if (payload.summary) lines.push('', String(payload.summary))
    const issues = Array.isArray(payload.issues) ? payload.issues : []
    if (issues.length > 0) {
      lines.push('', '## Issues')
      for (const issue of issues) {
        const location = [
          issue.file,
          Number.isFinite(issue.line) ? issue.line : undefined,
        ]
          .filter(Boolean)
          .join(':')
        lines.push(`- ${issue.message}${location ? ` (${location})` : ''}`)
      }
    }
  } else {
    lines.push('', JSON.stringify(payload, null, 2))
  }
  return `${lines.join('\n')}\n`
}

export function renderExternalEventMarkdown(
  state: JsonRecord,
  externalEvent: JsonRecord,
) {
  const payload = { ...(externalEvent.payload ?? {}) }
  const sourceId = payload.sourceId
  delete payload.sourceId
  const source = sourceId ? state.sources?.[sourceId] : undefined
  const lines = [
    `# External event: ${externalEvent.type}`,
    `Source: ${source ? externalSourceSummary(source) : (sourceId ?? 'unknown')}`,
    `At: ${externalEvent.ts}`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ]
  return `${lines.join('\n')}\n`
}

export function reportSummary(payload: JsonRecord) {
  if (payload.type === 'verdict') {
    if (
      typeof payload.summary === 'string' &&
      payload.summary.trim().length > 0
    ) {
      return payload.summary.trim()
    }
    if (Array.isArray(payload.issues) && payload.issues.length > 0) {
      return payload.issues
        .map((issue) =>
          issue.file ? `${issue.message} (${issue.file})` : issue.message,
        )
        .join('\n')
    }
    return payload.verdict
  }
  if (payload.type === 'relationship') {
    return payload.nature ?? payload.target
  }
  try {
    return boundedText(JSON.stringify(payload.payload), 500)
  } catch {
    return 'info'
  }
}

export function defaultMasterPrompt(state: JsonRecord, clusterId: string) {
  const cluster = state.clusters[clusterId]
  const policy = cluster.loopPolicy
  const until = policy?.until?.whenReport?.verdict
    ? `until a report verdict is "${policy.until.whenReport.verdict}"`
    : 'until the authored stop condition is met'
  const maxIterations = policy?.maxIterations
    ? `Respect maxIterations=${policy.maxIterations}.`
    : 'Ask before continuing if the loop looks unbounded.'

  return [
    `You are the Orrery master session for cluster ${cluster.label}.`,
    'Read the graph as a blackboard and coordinate only the sessions in your cluster scope.',
    `The current LoopPolicy is: ${until}; onStop=freeze. ${maxIterations}`,
    'When the loop runs, the runtime will activate you with pending activation requests (each has a slotKey).',
    'For each request, decide once: call mcp__orrery_membrane__approve_activation with {"slotKey": ...} to allow it (optionally add "note" with extra instructions), or mcp__orrery_membrane__deny_activation with a reason to reject it. Then stop.',
    'When the user asks for a Review, Goal loop, Handoff, or multi-model Plan Council, first call inspect_scope, then call propose_workflow with a complete high-level recipe input and a concise reason.',
    'For new participants you may omit provider, model, cwd, and runtime settings when they should inherit your current provider/workspace. Plan Council participants are always normalized to read-only plan mode.',
    'A Workflow Proposal is the only allowed authoring path: it creates no runtime sessions or relationships. Do not emulate a workflow with create_session, resume_session, activate, deliver, or link_sessions.',
    'After proposing, explain the visible participants, relationships, stop conditions, safety policy, warnings, and Graph Diff, then stop and wait for human approval.',
    'Workflow tool results are compact JSON summaries. Read their proposalId/status directly from the tool result; never use shell commands to locate or parse MCP tool-result files.',
    'Only after the proposal status is approved may you call commit_workflow with proposalId, expectedBaseVersion, and a stable idempotencyKey. Human locks are authoritative and must survive every revision.',
    'The runtime handles mechanical transitions (deliveries, activation, message assembly, and deterministic stop conditions). You compile intent, explain proposals, govern judgment points, and surface exceptions; do not route every turn yourself.',
    'Governor wakeups are durable and limited to failures, caps, missing reports, human changes, permission expansion, and workflow milestones. Inspect the wakeup, propose a versioned Patch when the plan must change, or acknowledge it with a reason; never recreate a human-deleted or human-locked item automatically.',
  ].join('\n')
}

export function masterReasonFromInput(
  state: JsonRecord,
  source: string,
  input: JsonRecord,
) {
  if (state.sessions[source]?.role !== 'master') return undefined
  const reason = input?.masterReason ?? input?.reason
  return typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim()
    : undefined
}

function optionalString(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

export function normalizeReportPayload(input: JsonRecord) {
  if (!input || typeof input !== 'object') {
    throw new Error('report payload is required')
  }
  if (input.type === 'verdict') {
    if (
      typeof input.verdict !== 'string' ||
      input.verdict.trim().length === 0
    ) {
      throw new Error('report verdict is required')
    }
    let issues
    if (input.issues !== undefined) {
      if (!Array.isArray(input.issues)) {
        throw new Error('verdict report issues must be an array')
      }
      issues = input.issues.map((issue, index) => {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
          throw new Error(`verdict issue ${index} must be an object`)
        }
        if (
          typeof issue.message !== 'string' ||
          issue.message.trim().length === 0
        ) {
          throw new Error(`verdict issue ${index} message is required`)
        }
        if (issue.file !== undefined && typeof issue.file !== 'string') {
          throw new Error(`verdict issue ${index} file must be a string`)
        }
        if (
          issue.line !== undefined &&
          (typeof issue.line !== 'number' || !Number.isFinite(issue.line))
        ) {
          throw new Error(`verdict issue ${index} line must be a finite number`)
        }
        if (
          issue.severity !== undefined &&
          !['info', 'warn', 'error'].includes(issue.severity)
        ) {
          throw new Error(
            `verdict issue ${index} severity must be info, warn, or error`,
          )
        }
        return {
          message: issue.message.trim(),
          file: issue.file,
          line: issue.line,
          severity: issue.severity,
        }
      })
    }
    if (input.summary !== undefined && typeof input.summary !== 'string') {
      throw new Error('verdict report summary must be a string')
    }
    return {
      type: 'verdict',
      verdict: input.verdict.trim(),
      issues,
      summary: input.summary,
    }
  }
  if (input.type === 'relationship') {
    if (
      typeof input.target !== 'string' ||
      input.target.trim().length === 0
    ) {
      throw new Error('relationship report target is required')
    }
    return {
      type: 'relationship',
      target: input.target.trim(),
      nature: optionalString(input.nature, 'relationship nature'),
      sessionRef: optionalString(
        input.sessionRef,
        'relationship sessionRef',
      ),
    }
  }
  if (input.type === 'info') {
    if (!Object.hasOwn(input, 'payload')) {
      throw new Error('info report payload is required')
    }
    return { type: 'info', payload: input.payload }
  }
  throw new Error(`Unknown report type: ${input.type}`)
}
