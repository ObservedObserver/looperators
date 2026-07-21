// Subscription authoring input validation: normalizes and statically checks
// author_subscription command input (patterns, gates, schedules, dynamic
// create actions) before it becomes a persisted subscription.
// Split out of sessionManager.ts (move-only; state passed explicitly).
import { randomUUID } from 'node:crypto'
import {
  defaultCycleMaxFirings,
  eventSourceSession,
  externalSourceKinds,
  governingMaster,
  isValidExternalTopic,
  externalSourceSummary,
  normalizeDailyAt,
  scheduleSummary,
} from '../../shared/graph-core/index.js'
import { validateDynamicCreateAction } from '../../shared/dynamic-topology.js'
import {
  type JsonRecord,
  clone,
  isObject,
  nonEmptyString,
  now,
  optionalTrimmedString,
  validSubscriptionConcurrencies,
  validSubscriptionGates,
  validSubscriptionOnStops,
  validSubscriptionPatterns,
} from './runtimeCommon.js'

// Source-side minimum interval for timer subscriptions (L1): the guardrail
// against high-frequency runaway lives on the source, not on the operator.
// Overridable for tests via ORRERY_TIMER_MIN_INTERVAL_SECONDS.
const defaultTimerMinIntervalSeconds = 15
export function timerMinIntervalSeconds() {
  const fromEnv = Number(process.env.ORRERY_TIMER_MIN_INTERVAL_SECONDS)
  return Number.isFinite(fromEnv) && fromEnv >= 1
  ? fromEnv
  : defaultTimerMinIntervalSeconds
}
export function normalizeSubscriptionInput(
  state: JsonRecord,
  input: JsonRecord = {},
) {
  const sourceSessionId = optionalTrimmedString(input.sourceSessionId)
  const sourceClusterId = optionalTrimmedString(input.sourceClusterId)
  let source = isObject(input.source) ? input.source : undefined
  if (!source && sourceSessionId) {
    source = {
      kind: 'session',
      sessionId: sourceSessionId,
    }
  }
  if (!source && sourceClusterId) {
    source = {
      kind: 'cluster',
      clusterId: sourceClusterId,
    }
  }
  if (
    !source ||
    (source.kind === 'session' && !state.sessions[source.sessionId]) ||
    (source.kind === 'cluster' && !state.clusters[source.clusterId]) ||
    (source.kind !== 'session' &&
      source.kind !== 'cluster' &&
      source.kind !== 'timer' &&
      source.kind !== 'external')
  ) {
    throw new Error(
      'Subscription source must be an existing session or cluster, {kind:"timer"}, or {kind:"external",sourceId}',
    )
  }
  let externalSource
  if (source.kind === 'external') {
    const sourceId = optionalTrimmedString(source.sourceId)
    externalSource = sourceId ? state.sources?.[sourceId] : undefined
    if (!externalSource || externalSource.state !== 'active') {
      throw new Error(
        `Subscription external source must be a registered, active source (got: ${sourceId ?? ''})`,
      )
    }
  }

  const targetSessionId =
    optionalTrimmedString(input.targetSessionId) ??
    (isObject(input.target)
      ? optionalTrimmedString(input.target.sessionId)
      : undefined)
  if (!targetSessionId || !state.sessions[targetSessionId]) {
    throw new Error('Subscription target must be an existing session')
  }

  const on = isObject(input.on) ? input.on : { on: input.on }
  if (!validSubscriptionPatterns.has(on.on)) {
    throw new Error(
      `Subscription pattern must be one of finished|failed|report|delivered|schedule|external`,
    )
  }
  // Timer source ⟺ schedule pattern: a clock emits nothing but ticks, and
  // a schedule can be driven by nothing but a clock.
  if ((source.kind === 'timer') !== (on.on === 'schedule')) {
    throw new Error(
      'A schedule pattern requires source {kind:"timer"}, and a timer source requires the schedule pattern',
    )
  }
  // Same pairing for L2: an external source emits nothing but its own
  // facts, and the external pattern can be driven by nothing else.
  if ((source.kind === 'external') !== (on.on === 'external')) {
    throw new Error(
      'An external pattern requires source {kind:"external",sourceId}, and an external source requires the external pattern',
    )
  }
  const pattern: JsonRecord = { on: on.on }
  if (on.on === 'report' && isObject(on.match)) {
    pattern.match = {
      ...(optionalTrimmedString(on.match.type)
        ? { type: on.match.type.trim() }
        : {}),
      ...(optionalTrimmedString(on.match.verdict)
        ? { verdict: on.match.verdict.trim() }
        : {}),
    }
  }
  if (on.on === 'delivered' && optionalTrimmedString(on.topic)) {
    pattern.topic = on.topic.trim()
  }
  if (on.on === 'external') {
    // Topic narrows by fact name; it is optional but must agree with the
    // source's declared topic when present (one topic per source in v1 —
    // a mismatch would be a subscription that can never fire).
    const topic = optionalTrimmedString(on.topic)
    if (topic !== undefined) {
      if (topic !== externalSource.topic) {
        throw new Error(
          `Subscription external topic must match the source's topic (${externalSource.topic})`,
        )
      }
      pattern.topic = topic
    }
    if (on.match !== undefined) {
      if (!isObject(on.match)) {
        throw new Error(
          'Subscription external match must be an object of string fields',
        )
      }
      const match = {}
      for (const [key, value] of Object.entries(on.match)) {
        if (typeof value !== 'string' || value.length === 0 || !key.trim()) {
          throw new Error(
            'Subscription external match values must be non-empty strings',
          )
        }
        match[key.trim()] = value
      }
      if (Object.keys(match).length > 0) {
        pattern.match = match
      }
    }
  }
  if (on.on === 'schedule') {
    // Exactly one schedule form: an interval or a wall-clock daily time
    // (the cron-shaped case the proposal's morning-report scenario needs).
    const hasInterval = on.everySeconds !== undefined
    const hasDailyAt = optionalTrimmedString(on.dailyAt) !== undefined
    if (hasInterval === hasDailyAt) {
      throw new Error(
        'Subscription schedule requires exactly one of everySeconds or dailyAt',
      )
    }
    if (hasDailyAt) {
      const dailyAt = normalizeDailyAt(on.dailyAt.trim())
      if (!dailyAt) {
        throw new Error(
          'Subscription schedule.dailyAt must be HH:MM (24h, runtime-host local time)',
        )
      }
      pattern.dailyAt = dailyAt
    } else {
      const everySeconds = Number(on.everySeconds)
      const minimum = timerMinIntervalSeconds()
      if (!Number.isInteger(everySeconds) || everySeconds < minimum) {
        throw new Error(
          `Subscription schedule.everySeconds must be an integer >= ${minimum}`,
        )
      }
      pattern.everySeconds = everySeconds
    }
  }

  const action = isObject(input.action)
    ? input.action
    : { kind: input.action }
  if (action.kind === 'create') {
    const validation = validateDynamicCreateAction(action, {
      providerInstanceIds: state.providerInstances.map((instance) => instance.providerInstanceId),
    })
    if (!validation.ok) throw new Error(validation.errors.join(' '))
    if (on.on !== 'report') {
      throw new Error('Dynamic create subscriptions require a report trigger.')
    }
    if (!isObject(input.stop) || !Number.isSafeInteger(Number(input.stop.maxFirings))) {
      throw new Error('Dynamic create subscriptions require a bounded stop.maxFirings.')
    }
  } else if (action.kind !== 'deliver' && action.kind !== 'deliver+activate') {
    throw new Error('Subscription action must be deliver, deliver+activate, or validated create')
  }
  if (source.kind === 'timer' && action.kind !== 'deliver+activate') {
    // A clock has no artifacts to forward; a deliver-only schedule would
    // fire empty deliveries forever.
    throw new Error('A timer subscription requires action deliver+activate')
  }
  if (source.kind === 'external' && action.kind !== 'deliver+activate') {
    // The emit payload is delivered as part of the activation; a
    // deliver-only external edge has no source session to bundle from.
    throw new Error(
      'An external subscription requires action deliver+activate',
    )
  }

  const gate = optionalTrimmedString(input.gate)
  if (gate && !validSubscriptionGates.has(gate)) {
    throw new Error('Subscription gate must be auto, master, or human')
  }
  const concurrency = optionalTrimmedString(input.concurrency) ?? 'coalesce'
  if (!validSubscriptionConcurrencies.has(concurrency)) {
    throw new Error(
      'Subscription concurrency must be coalesce, queue, drop, or interrupt',
    )
  }
  if (source.kind === 'timer' && concurrency === 'queue') {
    // Ticks are fungible: a backlog of stale ticks is exactly the
    // anti-pattern §6.1 warns about, so timer edges never queue even
    // though session/cluster edges may keep an ordered backlog.
    throw new Error(
      'A timer subscription cannot use queue concurrency; ticks coalesce (or drop/interrupt)',
    )
  }
  const onStop = optionalTrimmedString(input.onStop) ?? 'freeze-edge'
  if (!validSubscriptionOnStops.has(onStop)) {
    throw new Error(
      'Subscription onStop must be freeze-edge, freeze-target, or freeze-cluster',
    )
  }

  let stop
  if (isObject(input.stop)) {
    stop = {}
    if (
      isObject(input.stop.whenReport) &&
      optionalTrimmedString(input.stop.whenReport.verdict)
    ) {
      stop.whenReport = {
        verdict: input.stop.whenReport.verdict.trim(),
      }
    }
    if (input.stop.maxFirings !== undefined) {
      const maxFirings = Number(input.stop.maxFirings)
      if (!Number.isInteger(maxFirings) || maxFirings <= 0) {
        throw new Error(
          'Subscription stop.maxFirings must be a positive integer',
        )
      }
      stop.maxFirings = maxFirings
    }
    if (optionalTrimmedString(input.stop.deadline)) {
      if (Number.isNaN(Date.parse(input.stop.deadline))) {
        throw new Error(
          'Subscription stop.deadline must be a parseable date-time',
        )
      }
      stop.deadline = input.stop.deadline.trim()
    }
    if (Object.keys(stop).length === 0) {
      stop = undefined
    }
  }

  // A scheduled activation carries no upstream artifacts, so the note is
  // the whole activation message; default to a deterministic template.
  const note = action.kind === 'create' ? undefined :
    optionalTrimmedString(action.note) ??
    (source.kind === 'timer'
      ? `Scheduled activation: this session runs on a timer (${scheduleSummary(pattern as { on: 'schedule' })}).`
      : source.kind === 'external'
        ? `External activation: triggered by ${externalSourceSummary(externalSource)}. The triggering event is in your channel as external-event.md.`
        : undefined)

  return {
    id: optionalTrimmedString(input.id) ?? `sub-${randomUUID().slice(0, 8)}`,
    source:
      source.kind === 'session'
        ? { kind: 'session', sessionId: source.sessionId }
        : source.kind === 'timer'
          ? { kind: 'timer' }
          : source.kind === 'external'
            ? {
                kind: 'external',
                sourceId: externalSource.id,
              }
            : {
                kind: 'cluster',
                clusterId: source.clusterId,
              },
    on: pattern,
    target: {
      kind: 'session',
      sessionId: targetSessionId,
    },
    action: action.kind === 'create'
      ? {
          kind: 'create',
          template: {
            templateId: action.template.templateId.trim(),
            labelPrefix: action.template.labelPrefix.trim(),
            role: 'triage',
            prompt: action.template.prompt.trim(),
            providerKind: action.template.providerKind,
            providerInstanceId: action.template.providerInstanceId.trim(),
            ...(isObject(action.template.runtimeSettings)
              ? { runtimeSettings: clone(action.template.runtimeSettings) }
              : {}),
            workspace: {
              access: action.template.workspace.access,
              workMode: action.template.workspace.workMode,
            },
            retention: action.template.retention,
          },
          forEach: { kind: 'report-issues' },
          limits: {
            maxGenerationDepth: Number(action.limits.maxGenerationDepth),
            maxSessions: Number(action.limits.maxSessions),
            maxFanOut: Number(action.limits.maxFanOut),
            maxPlanVersions: Number(action.limits.maxPlanVersions),
          },
        }
      : {
          kind: action.kind,
          ...(optionalTrimmedString(action.topic)
            ? { topic: action.topic.trim() }
            : {}),
          ...(note ? { note } : {}),
        },
    ...(isObject(input.executionRef) &&
        optionalTrimmedString(input.executionRef.workflowId) &&
        Number.isSafeInteger(Number(input.executionRef.workflowVersion)) &&
        Number(input.executionRef.workflowVersion) > 0 &&
        optionalTrimmedString(input.executionRef.runId) &&
        optionalTrimmedString(input.executionRef.phaseId)
      ? {
          executionRef: {
            workflowId: input.executionRef.workflowId.trim(),
            workflowVersion: Number(input.executionRef.workflowVersion),
            runId: input.executionRef.runId.trim(),
            phaseId: input.executionRef.phaseId.trim(),
          },
        }
      : {}),
    gate: gate ?? undefined,
    concurrency,
    stop,
    onStop,
    state: 'active',
    firings: 0,
    label: optionalTrimmedString(input.label),
    preset: optionalTrimmedString(input.preset),
    createdAt: now(),
  }
  }

