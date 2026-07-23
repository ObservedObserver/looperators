import { randomUUID } from 'node:crypto'
import { barrierIsSatisfied } from '../../../shared/barrier.js'
import { validateExecutionEnvelope } from '../../../shared/execution-envelope.js'
import { workflowWakeupPrompt } from '../../../shared/workflow-governance.js'
import {
  clone,
  nonEmptyString,
  now,
  optionalTrimmedString,
  validBarrierModes,
  validWorkflowWakeupKinds,
  validWorkflowWakeupStatuses,
  type JsonRecord,
} from '../runtimeCommon.js'

export type WorkflowGovernanceHost = {
  state: () => JsonRecord
  readState: () => JsonRecord
  allKernelEvents: () => JsonRecord[]
  dispatchCommand: (command: JsonRecord) => Promise<unknown>
  appendKernelEvent: (
    type: string,
    payload: JsonRecord,
    ctx: JsonRecord,
    options?: JsonRecord,
  ) => JsonRecord | undefined
  touch: () => void
  broadcast: (event: JsonRecord) => void
  getState: () => JsonRecord
  masterClusterId: (sessionId: string) => string | undefined
  cmdActivate: (input: JsonRecord, ctx: JsonRecord) => Promise<JsonRecord>
  isSessionFrozen: (sessionId: string) => boolean
}

// Owns the durable Workflow wakeup and Barrier state machines together with
// their process-local notification drain and deadline timers.
export class WorkflowGovernanceRuntime {
  #host: WorkflowGovernanceHost
  #workflowWakeupDrainEnabled = true
  #barrierTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(host: WorkflowGovernanceHost) {
    this.#host = host
  }

  resumeWakeupDrain() {
    this.#workflowWakeupDrainEnabled = true
  }

  suspendWakeupDrain() {
    this.#workflowWakeupDrainEnabled = false
  }

  clearBarrierTimers() {
    for (const timer of this.#barrierTimers.values()) clearTimeout(timer)
    this.#barrierTimers.clear()
  }

  activeWorkflowPlans() {
    return Object.values(this.#host.state().workflowPlans ?? {})
      .flatMap((versions: JsonRecord) => Object.values(versions ?? {}))
      .filter((plan: JsonRecord) => plan?.status === 'active' && plan.executionMapping)
  }

  #workflowPlansForKernelEvent(event: JsonRecord) {
    const payload = event?.payload ?? {}
    const sessionIds = new Set(
      [payload.sessionId, payload.from, payload.target]
        .map(optionalTrimmedString)
        .filter(Boolean),
    )
    const subscriptionId = optionalTrimmedString(payload.subscriptionId)
    const productWorkflowId = optionalTrimmedString(payload.workflowId)
    return this.activeWorkflowPlans().filter((plan: JsonRecord) => {
      const mapping = plan.executionMapping ?? {}
      if (
        nonEmptyString(mapping.committedAt) &&
        nonEmptyString(event.ts) &&
        Date.parse(event.ts) < Date.parse(mapping.committedAt)
      ) return false
      if (
        productWorkflowId &&
        (mapping.productWorkflowId === productWorkflowId || plan.workflowId === productWorkflowId)
      ) return true
      if (
        subscriptionId &&
        Object.values(mapping.relationshipSubscriptionIds ?? {}).includes(subscriptionId)
      ) return true
      return Object.values(mapping.participantSessionIds ?? {}).some((sessionId) =>
        sessionIds.has(sessionId),
      )
    })
  }

  #workflowWakeupClassification(event: JsonRecord, plan: JsonRecord) {
    const payload = event.payload ?? {}
    if (event.type === 'session.failed') {
      return {
        kind: 'failure',
        summary: `Participant ${payload.sessionId ?? 'unknown'} failed: ${payload.error ?? event.reason ?? 'unknown failure'}.`,
      }
    }
    if (
      event.type === 'subscription.stopped' &&
      /maxFirings=/i.test(event.reason ?? '')
    ) {
      return {
        kind: 'cap',
        summary: `Relationship ${payload.subscriptionId ?? 'unknown'} reached its firing cap.`,
      }
    }
    if (event.type === 'session.finished' && payload.turnId) {
      const participant = Object.entries(plan.executionMapping?.participantSessionIds ?? {})
        .find(([, sessionId]) => sessionId === payload.sessionId)
      if (participant && ['reviewer', 'judge'].includes(participant[0])) {
        const reported = (this.#host.state().reports ?? []).some((report: JsonRecord) =>
          report.from === payload.sessionId && report.turnId === payload.turnId,
        )
        if (!reported) {
          return {
            kind: 'missing-report',
            summary: `${participant[0]} ${payload.sessionId} finished turn ${payload.turnId} without the required typed report.`,
          }
        }
      }
    }
    if (
      event.actor?.kind === 'human' &&
      ['subscription.stopped', 'session.killed', 'workflow.item.locked', 'edge.removed'].includes(event.type)
    ) {
      return {
        kind: 'human-change',
        summary: `A human changed the running workflow via ${event.type}; preserve the change unless a new Proposal explicitly addresses it.`,
      }
    }
    if (event.type === 'permission.requested') {
      return {
        kind: 'permission-expansion',
        summary: `Participant ${payload.sessionId ?? 'unknown'} requested ${payload.requestKind ?? 'permission'}: ${payload.title ?? 'provider permission expansion'}.`,
      }
    }
    if (event.type === 'workflow.milestone') {
      return {
        kind: 'workflow-milestone',
        summary: optionalTrimmedString(payload.summary) ?? `Workflow reached milestone ${payload.milestone ?? 'unknown'}.`,
      }
    }
    return undefined
  }

  queueWorkflowWakeupsForKernelEvent(event: JsonRecord) {
    if (!event?.id || String(event.type ?? '').startsWith('workflow.master-wakeup.')) return
    for (const plan of this.#workflowPlansForKernelEvent(event)) {
      const classified = this.#workflowWakeupClassification(event, plan)
      if (!classified) continue
      const masterSessionId = plan.masterSessionId ??
        this.#host.state().clusters?.[plan.scopeId]?.masterSessionId
      if (!masterSessionId || !this.#host.state().sessions[masterSessionId]) continue
      void this.#host.dispatchCommand({
        commandId: `record-wakeup-${event.id}-${plan.workflowId}-v${plan.version}`,
        idempotencyKey: `workflow-wakeup:${event.id}:${plan.workflowId}:v${plan.version}`,
        kind: 'record_workflow_wakeup',
        actor: { kind: 'runtime' },
        causeId: event.id,
        input: {
          workflowId: plan.workflowId,
          workflowVersion: plan.version,
          scopeId: plan.scopeId,
          masterSessionId,
          wakeupKind: classified.kind,
          summary: classified.summary,
          sourceEventId: event.id,
          sourceSessionId: optionalTrimmedString(event.payload?.sessionId ?? event.payload?.from),
          sourceSubscriptionId: optionalTrimmedString(event.payload?.subscriptionId),
          observedAt: event.ts,
        },
      }).catch((error) => {
        console.error(`Workflow wakeup record failed for ${event.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  recoverWorkflowWakeupsFromKernelLog() {
    const relevant = new Set([
      'session.failed',
      'session.finished',
      'subscription.stopped',
      'session.killed',
      'workflow.item.locked',
      'edge.removed',
      'permission.requested',
      'workflow.milestone',
    ])
    for (const event of this.#host.allKernelEvents()) {
      if (relevant.has(event.type)) this.queueWorkflowWakeupsForKernelEvent(event)
    }
  }

  cmdRecordWorkflowWakeup(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'runtime') throw new Error('Only the runtime can record Workflow wakeups.')
    const workflowId = optionalTrimmedString(input.workflowId)
    const workflowVersion = Number(input.workflowVersion)
    const kind = optionalTrimmedString(input.wakeupKind)
    const plan = workflowId && Number.isSafeInteger(workflowVersion)
      ? this.#host.state().workflowPlans?.[workflowId]?.[String(workflowVersion)]
      : undefined
    if (!plan || plan.status !== 'active') throw new Error('Workflow wakeup requires an active Workflow Plan version.')
    if (!kind || !validWorkflowWakeupKinds.has(kind)) throw new Error(`Unknown Workflow wakeup kind: ${kind ?? ''}`)
    const masterSessionId = optionalTrimmedString(input.masterSessionId)
    if (!masterSessionId || plan.masterSessionId !== masterSessionId || this.#host.masterClusterId(masterSessionId) !== plan.scopeId) {
      throw new Error('Workflow wakeup Master no longer governs the Plan Scope.')
    }
    const observedAt = optionalTrimmedString(input.observedAt) ?? now()
    const existing = Object.values(this.#host.state().workflowWakeups ?? {}).find((wakeup: JsonRecord) =>
      wakeup.workflowId === workflowId &&
      wakeup.workflowVersion === workflowVersion &&
      wakeup.kind === kind &&
      wakeup.status === 'pending',
    ) as JsonRecord | undefined
    const sourceEventId = optionalTrimmedString(input.sourceEventId)
    if (existing) {
      if (sourceEventId && !existing.sourceEventIds.includes(sourceEventId)) {
        existing.sourceEventIds.push(sourceEventId)
        existing.occurrenceCount += 1
      }
      const sourceSessionId = optionalTrimmedString(input.sourceSessionId)
      if (sourceSessionId && !existing.sourceSessionIds.includes(sourceSessionId)) existing.sourceSessionIds.push(sourceSessionId)
      const sourceSubscriptionId = optionalTrimmedString(input.sourceSubscriptionId)
      if (sourceSubscriptionId && !existing.sourceSubscriptionIds.includes(sourceSubscriptionId)) existing.sourceSubscriptionIds.push(sourceSubscriptionId)
      existing.summary = optionalTrimmedString(input.summary) ?? existing.summary
      existing.lastObservedAt = observedAt
      this.#host.appendKernelEvent(
        'workflow.master-wakeup.coalesced',
        { wakeupId: existing.wakeupId, workflowId, workflowVersion, kind, occurrenceCount: existing.occurrenceCount, sourceEventId },
        ctx,
      )
      this.#host.touch()
      this.#host.broadcast({ type: 'workflow.wakeup.updated', wakeupId: existing.wakeupId, state: this.#host.getState() })
      return { wakeup: clone(existing), state: this.#host.getState() }
    }
    const wakeupId = `wakeup-${randomUUID()}`
    const wakeup = {
      wakeupId,
      workflowId,
      workflowVersion,
      scopeId: plan.scopeId,
      masterSessionId,
      kind,
      status: 'pending',
      summary: optionalTrimmedString(input.summary) ?? `${kind} requires Master judgment.`,
      sourceEventIds: sourceEventId ? [sourceEventId] : [],
      sourceSessionIds: optionalTrimmedString(input.sourceSessionId) ? [input.sourceSessionId.trim()] : [],
      sourceSubscriptionIds: optionalTrimmedString(input.sourceSubscriptionId) ? [input.sourceSubscriptionId.trim()] : [],
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      occurrenceCount: 1,
    }
    this.#host.state().workflowWakeups ??= {}
    this.#host.state().workflowWakeups[wakeupId] = wakeup
    this.#host.appendKernelEvent(
      'workflow.master-wakeup.recorded',
      { wakeupId, workflowId, workflowVersion, kind, masterSessionId, sourceEventId },
      ctx,
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.wakeup.updated', wakeupId, state: this.#host.getState() })
    return { wakeup: clone(wakeup), state: this.#host.getState() }
  }

  async cmdNotifyWorkflowWakeup(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'runtime') throw new Error('Only the runtime can notify a Workflow wakeup.')
    const wakeupId = optionalTrimmedString(input.wakeupId)
    const wakeup = wakeupId ? this.#host.state().workflowWakeups?.[wakeupId] : undefined
    if (!wakeup) throw new Error(`Unknown Workflow wakeup: ${wakeupId ?? ''}`)
    if (wakeup.status !== 'pending') return { wakeup: clone(wakeup), state: this.#host.getState() }
    // A runtime notification may already be serialized behind another
    // command when killAll disables autonomous work. Preserve the durable
    // pending fact, but never launch a fresh Governor after shutdown. Reject
    // instead of committing a no-op command so the deterministic notify key
    // remains retryable when autonomous draining is revived.
    if (!this.#workflowWakeupDrainEnabled) {
      throw new Error('Workflow wakeup draining is disabled; wakeup remains pending.')
    }
    const master = this.#host.state().sessions[wakeup.masterSessionId]
    if (!master || master.role !== 'master' || this.#host.masterClusterId(master.sessionId) !== wakeup.scopeId) {
      throw new Error('Workflow wakeup Master no longer governs its Scope.')
    }
    if (master.status !== 'idle') throw new Error(`Workflow Master is ${master.status}; wakeup remains pending.`)
    const result = await this.#host.cmdActivate(
      { sessionId: master.sessionId, note: workflowWakeupPrompt(wakeup) },
      { ...ctx, reason: `Governor wakeup: ${wakeup.kind}.` },
    )
    wakeup.status = 'notified'
    wakeup.notifiedAt = now()
    wakeup.notificationTurnId = result.runId
    wakeup.notificationAttempts = (wakeup.notificationAttempts ?? 0) + 1
    this.#host.appendKernelEvent(
      'workflow.master-wakeup.notified',
      { wakeupId, workflowId: wakeup.workflowId, workflowVersion: wakeup.workflowVersion, kind: wakeup.kind, notificationTurnId: result.runId },
      ctx,
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.wakeup.updated', wakeupId, state: this.#host.getState() })
    return { wakeup: clone(wakeup), state: this.#host.getState() }
  }

  recoverInterruptedWorkflowWakeups(interruptedSessionIds: Set<string>) {
    if (interruptedSessionIds.size === 0) return
    for (const wakeup of Object.values(this.#host.state().workflowWakeups ?? {}) as JsonRecord[]) {
      if (wakeup.status !== 'notified' || !interruptedSessionIds.has(wakeup.masterSessionId)) continue
      wakeup.status = 'pending'
      wakeup.lastNotificationInterruptedAt = now()
      delete wakeup.notifiedAt
      delete wakeup.notificationTurnId
      this.#host.appendKernelEvent(
        'workflow.master-wakeup.notification-interrupted',
        { wakeupId: wakeup.wakeupId, workflowId: wakeup.workflowId, workflowVersion: wakeup.workflowVersion },
        { actor: { kind: 'runtime' } },
        { reason: 'Governor notification turn was interrupted by runtime restart; wakeup returned to pending.' },
      )
    }
  }

  cmdAcknowledgeWorkflowWakeup(input: JsonRecord = {}, ctx: JsonRecord) {
    const wakeupId = optionalTrimmedString(input.wakeupId)
    const wakeup = wakeupId ? this.#host.state().workflowWakeups?.[wakeupId] : undefined
    if (!wakeup) throw new Error(`Unknown Workflow wakeup: ${wakeupId ?? ''}`)
    if (!['master', 'human', 'runtime'].includes(ctx.actor?.kind)) throw new Error('Only the governing Master, runtime, or a human can acknowledge a Workflow wakeup.')
    if (ctx.actor.kind === 'master' && ctx.actor.ref !== wakeup.masterSessionId) {
      throw new Error(`Master ${ctx.actor.ref ?? ''} cannot acknowledge another Scope's Workflow wakeup.`)
    }
    if (wakeup.status === 'acknowledged') return { wakeup: clone(wakeup), state: this.#host.getState() }
    wakeup.status = 'acknowledged'
    wakeup.acknowledgedAt = now()
    wakeup.acknowledgedBy = clone(ctx.actor)
    wakeup.acknowledgmentReason = optionalTrimmedString(input.reason) ?? ctx.reason
    this.#host.appendKernelEvent(
      'workflow.master-wakeup.acknowledged',
      { wakeupId, workflowId: wakeup.workflowId, workflowVersion: wakeup.workflowVersion, kind: wakeup.kind },
      ctx,
      { reason: wakeup.acknowledgmentReason },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.wakeup.updated', wakeupId, state: this.#host.getState() })
    return { wakeup: clone(wakeup), state: this.#host.getState() }
  }

  inspectWorkflowWakeups(
    input: JsonRecord = {},
    scopeId: string | undefined = optionalTrimmedString(input.scopeId),
  ) {
    const statuses = Array.isArray(input.statuses)
      ? new Set(input.statuses.filter((status) => validWorkflowWakeupStatuses.has(status)))
      : undefined
    const wakeups = Object.values(this.#host.readState().workflowWakeups ?? {})
      .filter((wakeup: JsonRecord) => (!scopeId || wakeup.scopeId === scopeId) && (!statuses || statuses.has(wakeup.status)))
      .sort((left: JsonRecord, right: JsonRecord) => right.lastObservedAt.localeCompare(left.lastObservedAt))
    return { wakeups: clone(wakeups) }
  }

  drainWorkflowWakeups() {
    if (!this.#workflowWakeupDrainEnabled) return
    const pending = (Object.values(this.#host.state().workflowWakeups ?? {}) as JsonRecord[])
      .filter((wakeup: JsonRecord) => wakeup.status === 'pending')
      .sort((left: JsonRecord, right: JsonRecord) => left.firstObservedAt.localeCompare(right.firstObservedAt))
    for (const wakeup of pending) {
      if (
        this.#host.state().sessions[wakeup.masterSessionId]?.status !== 'idle' ||
        this.#host.isSessionFrozen(wakeup.masterSessionId)
      ) continue
      void this.#host.dispatchCommand({
        commandId: `notify-${wakeup.wakeupId}-${wakeup.occurrenceCount}`,
        idempotencyKey: `notify:${wakeup.wakeupId}:${wakeup.occurrenceCount}`,
        kind: 'notify_workflow_wakeup',
        actor: { kind: 'runtime' },
        input: { wakeupId: wakeup.wakeupId },
      }).catch((error) => {
        console.error(`Workflow wakeup notification failed for ${wakeup.wakeupId}: ${error instanceof Error ? error.message : String(error)}`)
      })
      break
    }
  }

  #scheduleBarrierTimeout(barrier: JsonRecord) {
    const previous = this.#barrierTimers.get(barrier.barrierId)
    if (previous) clearTimeout(previous)
    this.#barrierTimers.delete(barrier.barrierId)
    if (barrier.status !== 'pending' || !barrier.deadline) return
    const delay = Math.max(0, Date.parse(barrier.deadline) - Date.now())
    const timer = setTimeout(() => {
      this.#barrierTimers.delete(barrier.barrierId)
      void this.#host.dispatchCommand({
        commandId: `expire-barrier-${barrier.barrierId}-${barrier.correlationKey}`,
        idempotencyKey: `expire-barrier:${barrier.barrierId}:${barrier.correlationKey}`,
        kind: 'expire_barrier',
        actor: { kind: 'runtime' },
        input: { barrierId: barrier.barrierId, correlationKey: barrier.correlationKey },
      }).catch((error) => console.error(`Barrier timeout failed: ${error instanceof Error ? error.message : String(error)}`))
    }, Math.min(delay, 2_147_483_647))
    timer.unref?.()
    this.#barrierTimers.set(barrier.barrierId, timer)
  }

  recoverBarrierTimers() {
    for (const barrier of Object.values(this.#host.state().barriers ?? {}) as JsonRecord[]) {
      if (barrier.status === 'pending') this.#scheduleBarrierTimeout(barrier)
    }
  }

  cmdCreateBarrier(input: JsonRecord = {}, ctx: JsonRecord) {
    const barrierId = optionalTrimmedString(input.barrierId) ?? `barrier-${randomUUID()}`
    if (this.#host.state().barriers?.[barrierId]) throw new Error(`Barrier already exists: ${barrierId}`)
    const mode = validBarrierModes.has(input.mode) ? input.mode : 'all'
    const expectedParticipantKeys = [...new Set(
      (Array.isArray(input.expectedParticipantKeys) ? input.expectedParticipantKeys : [])
        .map(optionalTrimmedString).filter(Boolean),
    )]
    if (expectedParticipantKeys.length === 0) throw new Error('Barrier requires expectedParticipantKeys.')
    const quorum = mode === 'quorum' ? Number(input.quorum) : undefined
    if (mode === 'quorum' && (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > expectedParticipantKeys.length)) {
      throw new Error(`Barrier quorum must be between 1 and ${expectedParticipantKeys.length}.`)
    }
    const envelope = input.envelope
    if (!validateExecutionEnvelope(envelope)) throw new Error('Barrier requires a valid ExecutionEnvelope.')
    if (envelope.correlationKey !== input.correlationKey && input.correlationKey !== undefined) {
      throw new Error('Barrier correlationKey must match its ExecutionEnvelope.')
    }
    const deadline = optionalTrimmedString(input.deadline)
    if (deadline && !Number.isFinite(Date.parse(deadline))) throw new Error('Barrier deadline must be ISO-8601.')
    const barrier = {
      barrierId,
      workflowId: envelope.workflowId,
      workflowVersion: envelope.workflowVersion,
      runId: envelope.runId,
      phaseId: envelope.phaseId,
      correlationKey: envelope.correlationKey,
      mode,
      expectedParticipantKeys,
      ...(quorum ? { quorum } : {}),
      status: 'pending',
      arrivals: {},
      createdAt: now(),
      ...(deadline ? { deadline } : {}),
    }
    this.#host.state().barriers ??= {}
    this.#host.state().barriers[barrierId] = barrier
    this.#host.appendKernelEvent('barrier.created', { barrier: clone(barrier), execution: clone(envelope) }, ctx)
    this.#scheduleBarrierTimeout(barrier)
    this.#host.touch()
    return { barrier: clone(barrier), state: this.#host.getState() }
  }

  cmdArriveBarrier(input: JsonRecord = {}, ctx: JsonRecord) {
    const barrierId = optionalTrimmedString(input.barrierId)
    const barrier = barrierId ? this.#host.state().barriers?.[barrierId] : undefined
    if (!barrier) throw new Error(`Unknown Barrier: ${barrierId ?? ''}`)
    const envelope = input.envelope
    if (
      !validateExecutionEnvelope(envelope) ||
      envelope.correlationKey !== barrier.correlationKey ||
      envelope.workflowId !== barrier.workflowId ||
      envelope.workflowVersion !== barrier.workflowVersion ||
      envelope.runId !== barrier.runId ||
      envelope.phaseId !== barrier.phaseId
    ) {
      throw new Error('Barrier arrival correlation does not match the active generation.')
    }
    const participantKey = optionalTrimmedString(input.participantKey)
    if (!participantKey || !barrier.expectedParticipantKeys.includes(participantKey)) {
      throw new Error(`Barrier does not expect participant: ${participantKey ?? ''}`)
    }
    const eventId = optionalTrimmedString(input.eventId)
    if (!eventId) throw new Error('Barrier arrival requires eventId.')
    if (barrier.status !== 'pending') {
      return {
        barrier: clone(barrier),
        released: false,
        alreadyReleased: barrier.status === 'released',
        state: this.#host.getState(),
      }
    }
    const existing = barrier.arrivals[participantKey]
    if (!existing || envelope.attempt > existing.attempt) {
      barrier.arrivals[participantKey] = {
        participantKey,
        attempt: envelope.attempt,
        eventId,
        arrivedAt: now(),
        envelope: clone(envelope),
      }
      this.#host.appendKernelEvent('barrier.arrived', {
        barrierId, participantKey, eventId, arrivalCount: Object.keys(barrier.arrivals).length,
        execution: clone(envelope),
      }, ctx)
    }
    let released = false
    if (barrierIsSatisfied(barrier)) {
      barrier.status = 'released'
      barrier.releasedAt = now()
      const releaseEvent = this.#host.appendKernelEvent('barrier.released', {
        barrierId, workflowId: barrier.workflowId, runId: barrier.runId,
        phaseId: barrier.phaseId, correlationKey: barrier.correlationKey,
        participantKeys: Object.keys(barrier.arrivals), execution: clone(envelope),
      }, ctx)
      barrier.releasedEventId = releaseEvent?.id
      const timer = this.#barrierTimers.get(barrierId)
      if (timer) clearTimeout(timer)
      this.#barrierTimers.delete(barrierId)
      released = true
    }
    this.#host.touch()
    return { barrier: clone(barrier), released, state: this.#host.getState() }
  }

  cmdCancelBarrier(input: JsonRecord = {}, ctx: JsonRecord) {
    const barrierId = optionalTrimmedString(input.barrierId)
    const barrier = barrierId ? this.#host.state().barriers?.[barrierId] : undefined
    if (!barrier) throw new Error(`Unknown Barrier: ${barrierId ?? ''}`)
    if (barrier.status !== 'pending') return { barrier: clone(barrier), state: this.#host.getState() }
    barrier.status = 'cancelled'
    barrier.cancelledAt = now()
    barrier.terminalReason = optionalTrimmedString(input.reason) ?? ctx.reason ?? 'Barrier cancelled.'
    this.#host.appendKernelEvent('barrier.cancelled', {
      barrierId,
      correlationKey: barrier.correlationKey,
      execution: {
        workflowId: barrier.workflowId, workflowVersion: barrier.workflowVersion,
        runId: barrier.runId, phaseId: barrier.phaseId,
        activationId: `barrier-cancel:${barrierId}`, attempt: 1,
        correlationKey: barrier.correlationKey,
      },
    }, ctx, { reason: barrier.terminalReason })
    const timer = this.#barrierTimers.get(barrierId)
    if (timer) clearTimeout(timer)
    this.#barrierTimers.delete(barrierId)
    this.#host.touch()
    return { barrier: clone(barrier), state: this.#host.getState() }
  }

  cmdExpireBarrier(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'runtime') throw new Error('Only runtime can expire a Barrier.')
    const barrierId = optionalTrimmedString(input.barrierId)
    const barrier = barrierId ? this.#host.state().barriers?.[barrierId] : undefined
    if (!barrier) throw new Error(`Unknown Barrier: ${barrierId ?? ''}`)
    if (barrier.status !== 'pending') return { barrier: clone(barrier), state: this.#host.getState() }
    if (input.correlationKey !== barrier.correlationKey) throw new Error('Barrier timeout correlation mismatch.')
    if (barrier.deadline && Date.parse(barrier.deadline) > Date.now()) {
      this.#scheduleBarrierTimeout(barrier)
      return { barrier: clone(barrier), state: this.#host.getState() }
    }
    barrier.status = 'timed-out'
    barrier.timedOutAt = now()
    barrier.terminalReason = 'Barrier deadline elapsed before the required arrivals.'
    this.#host.appendKernelEvent('barrier.timed-out', {
      barrierId,
      correlationKey: barrier.correlationKey,
      execution: {
        workflowId: barrier.workflowId, workflowVersion: barrier.workflowVersion,
        runId: barrier.runId, phaseId: barrier.phaseId,
        activationId: `barrier-timeout:${barrierId}`, attempt: 1,
        correlationKey: barrier.correlationKey,
      },
    }, ctx, { reason: barrier.terminalReason })
    this.#host.touch()
    return { barrier: clone(barrier), state: this.#host.getState() }
  }
}
