// SessionRuntimeController owns provider-turn admission, queueing, launch,
// stream projection, completion/failure, usage accounting, workspace leases,
// and worktree merge/cleanup. Durable mutations still commit through the
// manager-owned CommandExecutor via the explicit host port below.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateExecutionEnvelope } from '../../../shared/execution-envelope.js'
import {
  budgetExceeded,
  defaultRuntimeResourcePolicy,
  leaseCompatible,
  normalizeProviderUsage,
  runtimeConsumptionBudgetKeys,
  selectFairQueuedRun,
} from '../../../shared/resource-governance.js'
import { resultSublines } from '../providers/claudeRuntimeMapper.js'
import { normalizeProviderEffectiveRuntimeConfig } from '../providers/providerConfigNormalize.js'
import type { ContextChannelStore } from '../contextChannel.js'
import type { MembraneBridge } from '../membraneBridge.js'
import type { ProviderService } from '../providerService.js'
import type { RuntimeQueries } from '../queries/runtimeQueries.js'
import {
  type JsonRecord,
  clone,
  compactProviderRuntimeEvent,
  compactRuntimeItem,
  compactRuntimePlan,
  isObject,
  nonEmptyString,
  now,
  optionalTrimmedString,
  truncateActivities,
  truncateChunks,
  truncateEvents,
  truncateForLog,
  validProviderKinds,
} from '../runtimeCommon.js'
import {
  type CheckpointHost,
  captureTurnCheckpoint,
  checkpointDiffForSession,
  completedTurnCount,
  pruneTurnCheckpointRefs,
  recordTurnCheckpointDiff,
} from '../workspace/sessionCheckpoints.js'
import { gitOutput } from '../workspace/gitWorkspace.js'

function createLifecycleAbortSignal() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export type RuntimeRun = JsonRecord & {
  kill: () => boolean
  on: (event: string, listener: (...args: any[]) => void) => RuntimeRun
  respondRuntimeRequest?: (input: JsonRecord) => JsonRecord | void
  answerUserInput?: (input: JsonRecord) => JsonRecord | void
}

export type SessionRuntimeHost = {
  state(): JsonRecord
  runs(): Map<string, RuntimeRun>
  runContext(): Map<string, JsonRecord>
  workflowCompensatedRuns(): Set<string>
  bridge(): MembraneBridge
  providerService(): ProviderService
  channelStore(): ContextChannelStore
  queries(): RuntimeQueries
  checkpointHost(): CheckpointHost
  dispatchCommand(command: JsonRecord): Promise<any>
  appendKernelEvent(type: string, payload: JsonRecord, ctx: JsonRecord, options?: JsonRecord): any
  touch(): void
  touchDeferred(): void
  broadcast(event: JsonRecord): void
  emitRuntimeEvent(event: JsonRecord): void
  getState(): JsonRecord
  isSessionFrozen(sessionId: string): boolean
  updateNodeStatus(sessionId: string, status: string): void
  planCouncilForSession(sessionId: string): JsonRecord | undefined
  planCouncilFinished(sessionId: string, runId: string, eventId?: string): void
  planCouncilFailed(sessionId: string, error: string): void
  journalAutomaticDeploymentRunStarted(sessionId: string): void
  commandLifecycleEpoch(): number | undefined
}

export class SessionRuntimeController {
  #host: SessionRuntimeHost
  #runQueueDrainInFlight = false
  #runQueueDrainEnabled = true
  #runQueueLifecycleEpoch = 0
  #runQueueLaunchAbort = createLifecycleAbortSignal()
  #runBudgetTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(host: SessionRuntimeHost) {
    this.#host = host
  }

  private get state() {
    return this.#host.state()
  }
  private get runs() {
    return this.#host.runs()
  }
  private get runContext() {
    return this.#host.runContext()
  }
  private get workflowCompensatedRuns() {
    return this.#host.workflowCompensatedRuns()
  }
  private get bridge() {
    return this.#host.bridge()
  }
  private get providerService() {
    return this.#host.providerService()
  }
  private get channelStore() {
    return this.#host.channelStore()
  }
  private get queries() {
    return this.#host.queries()
  }
  private checkpointHost() {
    return this.#host.checkpointHost()
  }
  private dispatchCommand(command: JsonRecord) {
    return this.#host.dispatchCommand(command)
  }
  private appendKernelEvent(
    type: string,
    payload: JsonRecord,
    ctx: JsonRecord,
    options: JsonRecord = {},
  ) {
    return this.#host.appendKernelEvent(type, payload, ctx, options)
  }
  private touch() {
    this.#host.touch()
  }
  private touchDeferred() {
    this.#host.touchDeferred()
  }
  private broadcast(event: JsonRecord) {
    this.#host.broadcast(event)
  }
  private emitRuntimeEvent(event: JsonRecord) {
    this.#host.emitRuntimeEvent(event)
  }
  private getState() {
    return this.#host.getState()
  }
  private isSessionFrozen(sessionId: string) {
    return this.#host.isSessionFrozen(sessionId)
  }
  private updateNodeStatus(sessionId: string, status: string) {
    this.#host.updateNodeStatus(sessionId, status)
  }
  private planCouncilForSession(sessionId: string) {
    return this.#host.planCouncilForSession(sessionId)
  }
  private planCouncilFinished(sessionId: string, runId: string, eventId?: string) {
    this.#host.planCouncilFinished(sessionId, runId, eventId)
  }
  private planCouncilFailed(sessionId: string, error: string) {
    this.#host.planCouncilFailed(sessionId, error)
  }
  private journalAutomaticDeploymentRunStarted(sessionId: string) {
    this.#host.journalAutomaticDeploymentRunStarted(sessionId)
  }
  private commandLifecycleEpoch() {
    return this.#host.commandLifecycleEpoch()
  }

  lifecycleEpoch() {
    return this.#runQueueLifecycleEpoch
  }

  resumeQueueDrain(expectedLifecycleEpoch?: number) {
    if (
      expectedLifecycleEpoch !== undefined &&
      expectedLifecycleEpoch !== this.#runQueueLifecycleEpoch
    ) {
      return false
    }
    this.#runQueueDrainEnabled = true
    queueMicrotask(() => void this.drainRunQueue())
    return true
  }
  suspendQueueDrain() {
    this.#runQueueDrainEnabled = false
    const previousAbort = this.#runQueueLaunchAbort
    this.#runQueueLifecycleEpoch += 1
    this.#runQueueLaunchAbort = createLifecycleAbortSignal()
    previousAbort.resolve()
  }

  resourceScopeId(sessionId) {
    const node = this.state.nodes.find((candidate) => candidate.sessionId === sessionId)
    return optionalTrimmedString(node?.clusterId) ?? 'global'
  }

  resourcePolicy(scopeId) {
    this.state.resourcePolicies ??= {}
    if (!this.state.resourcePolicies[scopeId])
      this.state.resourcePolicies[scopeId] = {
        scopeId,
        ...defaultRuntimeResourcePolicy,
        updatedAt: this.state.updatedAt,
        updatedBy: 'runtime',
        budgetStartedAt: this.state.updatedAt,
      }
    return this.state.resourcePolicies[scopeId]
  }

  private resourceReservations(policy) {
    if (policy.consumptionEnforcement !== 'hard') return {}
    const minimum = (...values) => {
      const limits = values.filter((value) => Number.isSafeInteger(value) && value > 0)
      return limits.length > 0 ? Math.min(...limits) : undefined
    }
    return {
      reservedTokens: minimum(policy.maxTokensPerTurn, policy.maxTokens),
      reservedDurationMs: minimum(policy.maxDurationPerTurnMs, policy.maxDurationMs),
      reservedToolCalls: minimum(policy.maxToolCallsPerTurn, policy.maxToolCalls),
    }
  }

  private applyResourceReservations(target, policy) {
    const reservations = this.resourceReservations(policy)
    for (const key of ['reservedTokens', 'reservedDurationMs', 'reservedToolCalls']) {
      if (reservations[key] === undefined) delete target[key]
      else target[key] = reservations[key]
    }
  }

  private runResource(sessionId, turnId) {
    const session = this.state.sessions[sessionId]
    const scopeId = this.resourceScopeId(sessionId)
    let workspaceKey = path.resolve(session?.cwd ?? process.cwd())
    try {
      workspaceKey = fs.realpathSync(workspaceKey)
    } catch {
      /* validated at provider launch */
    }
    const policy = this.resourcePolicy(scopeId)
    const reservations = this.resourceReservations(policy)
    return {
      turnId,
      sessionId,
      scopeId,
      workspaceKey,
      leaseMode:
        session?.runtimeSettings?.sandbox === 'read-only' ||
        session?.runtimeSettings?.interactionMode === 'plan'
          ? 'reader'
          : 'writer',
      providerInstanceId: session?.providerInstanceId,
      ...Object.fromEntries(
        Object.entries(reservations).filter(([, value]) => value !== undefined),
      ),
    }
  }

  private admissionReason(resource) {
    const policy = this.resourcePolicy(resource.scopeId)
    const globalPolicy = this.resourcePolicy('global')
    const active = (this.state.workspaceLeases ?? []).filter((lease) => lease.status === 'active')
    if (
      active.filter((lease) => lease.scopeId === resource.scopeId).length >=
      policy.maxConcurrentSessions
    )
      return 'scope-cap'
    if (
      active.filter((lease) => lease.providerInstanceId === resource.providerInstanceId).length >=
      globalPolicy.maxConcurrentPerProvider
    )
      return 'provider-cap'
    if (
      active.filter(
        (lease) =>
          lease.scopeId === resource.scopeId &&
          lease.providerInstanceId === resource.providerInstanceId,
      ).length >= policy.maxConcurrentPerProvider
    )
      return 'provider-cap'
    if (
      globalPolicy.serializeWorkspaceAccess &&
      !leaseCompatible(this.state.workspaceLeases ?? [], {
        ...resource,
        mode: resource.leaseMode,
      })
    )
      return 'workspace-lease'
    return undefined
  }

  private budgetExceededFor(resource, excludeTurnId = undefined) {
    const policy = this.resourcePolicy(resource.scopeId)
    if (policy.consumptionEnforcement !== 'hard') return undefined
    const budgetStartedAt = Date.parse(policy.budgetStartedAt ?? '')
    const facts = (this.state.usageFacts ?? []).filter(
      (fact) =>
        fact.scopeId === resource.scopeId &&
        (!Number.isFinite(budgetStartedAt) || Date.parse(fact.completedAt) >= budgetStartedAt),
    )
    const completed = new Set(facts.map((fact) => fact.turnId))
    const reservedTurnIds = new Set(
      [
        ...(this.state.workspaceLeases ?? [])
          .filter((lease) => lease.status === 'active' && lease.scopeId === resource.scopeId)
          .map((lease) => lease.turnId),
        ...(this.state.runQueue ?? [])
          .filter((item) => item.scopeId === resource.scopeId)
          .map((item) => item.turnId),
      ].filter((turnId) => turnId !== excludeTurnId && !completed.has(turnId)),
    )
    const reservations = [...reservedTurnIds].map((turnId) => ({
      turnId,
      totalTokens: 0,
      durationMs: 0,
      toolCalls: 0,
    }))
    for (const reservation of reservations) {
      const source = [...(this.state.workspaceLeases ?? []), ...(this.state.runQueue ?? [])].find(
        (item) => item.turnId === reservation.turnId,
      )
      reservation.totalTokens = Number(source?.reservedTokens ?? 0)
      reservation.durationMs = Number(source?.reservedDurationMs ?? 0)
      reservation.toolCalls = Number(source?.reservedToolCalls ?? 0)
    }
    const existing = [...facts, ...reservations] as any[]
    const exceeded = budgetExceeded(policy, existing as any)
    if (exceeded) return exceeded
    const totals = existing.reduce(
      (sum, item) => ({
        turns: sum.turns + 1,
        tokens: sum.tokens + Number(item.totalTokens ?? 0),
        durationMs: sum.durationMs + Number(item.durationMs ?? 0),
        toolCalls: sum.toolCalls + Number(item.toolCalls ?? 0),
      }),
      { turns: 0, tokens: 0, durationMs: 0, toolCalls: 0 },
    )
    const projected = {
      turns: totals.turns + 1,
      tokens: totals.tokens + Number(resource.reservedTokens ?? 0),
      durationMs: totals.durationMs + Number(resource.reservedDurationMs ?? 0),
      toolCalls: totals.toolCalls + Number(resource.reservedToolCalls ?? 0),
    }
    if (policy.maxTurns !== undefined && projected.turns > policy.maxTurns)
      return { dimension: 'turns', used: projected.turns, limit: policy.maxTurns }
    if (policy.maxTokens !== undefined && projected.tokens > policy.maxTokens)
      return { dimension: 'tokens', used: projected.tokens, limit: policy.maxTokens }
    if (policy.maxDurationMs !== undefined && projected.durationMs > policy.maxDurationMs)
      return { dimension: 'durationMs', used: projected.durationMs, limit: policy.maxDurationMs }
    if (policy.maxToolCalls !== undefined && projected.toolCalls > policy.maxToolCalls)
      return { dimension: 'toolCalls', used: projected.toolCalls, limit: policy.maxToolCalls }
    return undefined
  }

  private freezeForBudget(sessionId, exceeded, ctx: JsonRecord = { actor: { kind: 'runtime' } }) {
    const node = this.state.nodes.find((candidate) => candidate.sessionId === sessionId)
    const reason = `Resource budget exhausted: ${exceeded.dimension} ${exceeded.used}/${exceeded.limit}`
    if (node) {
      node.frozen = true
      node.freezeReason = reason
    }
    const session = this.state.sessions[sessionId]
    if (session && session.status === 'pending') session.status = 'idle'
    this.appendKernelEvent('resource.budget-exhausted', { sessionId, ...exceeded }, ctx, { reason })
    this.touch()
    const error = new Error(`${reason}. Reset or raise the resource policy and unfreeze to resume.`)
    ;(error as Error & { commitState?: boolean; code?: string }).commitState = true
    ;(error as Error & { commitState?: boolean; code?: string }).code =
      'ORRERY_RESOURCE_BUDGET_EXHAUSTED'
    return error
  }

  assertBudgetAvailable(sessionId: string, ctx: JsonRecord) {
    const exceeded = this.budgetExceededFor(
      this.runResource(sessionId, `preflight:${randomUUID()}`),
    )
    if (exceeded) throw this.freezeForBudget(sessionId, exceeded, ctx)
  }

  async startRun(sessionId, request) {
    const allowWhileQueueSuspended =
      !this.#runQueueDrainEnabled &&
      this.commandLifecycleEpoch() === this.#runQueueLifecycleEpoch
    if (!this.#runQueueDrainEnabled && !allowWhileQueueSuspended) {
      throw new Error('Provider run launch is suspended after runtime shutdown.')
    }
    if (
      (this.state.runQueue ?? []).some((item) => item.sessionId === sessionId) ||
      this.runs.has(sessionId)
    ) {
      throw new Error(`Session already has an active or queued provider turn: ${sessionId}`)
    }
    const runId = randomUUID()
    const resource = this.runResource(sessionId, runId)
    const policy = this.resourcePolicy(resource.scopeId)
    const exceeded = this.budgetExceededFor(resource)
    if (exceeded) {
      throw this.freezeForBudget(sessionId, exceeded)
    }
    const reason = this.admissionReason(resource)
    if (!reason)
      return this.launchRun(
        sessionId,
        request,
        runId,
        resource,
        allowWhileQueueSuspended,
      )
    if (
      (this.state.runQueue ?? []).filter((item) => item.scopeId === resource.scopeId).length >=
      policy.maxQueuedRuns
    ) {
      this.state.schedulerMetrics.rejectedTotal += 1
      throw new Error(`Run queue is full for ${resource.scopeId} (${policy.maxQueuedRuns}).`)
    }
    const queuedAt = now()
    this.state.runQueue.push({
      queueId: randomUUID(),
      ...resource,
      priority: Number.isFinite(request?.priority) ? Number(request.priority) : 0,
      order: this.state.schedulerMetrics.queuedTotal + 1,
      queuedAt,
      reason,
      request: clone(request),
      ...(request?.execution ? { execution: clone(request.execution) } : {}),
    })
    this.state.schedulerMetrics.queuedTotal += 1
    this.state.schedulerMetrics.maxQueueDepth = Math.max(
      this.state.schedulerMetrics.maxQueueDepth,
      this.state.runQueue.length,
    )
    this.state.schedulerMetrics.byReason[reason] =
      (this.state.schedulerMetrics.byReason[reason] ?? 0) + 1
    const session = this.state.sessions[sessionId]
    if (session) {
      session.status = 'pending'
      session.updatedAt = queuedAt
      this.updateMessageRunId(session, request?.userMessageId, runId)
      const council = this.planCouncilForSession(sessionId)
      const participant = council?.participants?.[sessionId]
      if (participant?.expectedArtifactKind && !participant.expectedTurnId)
        participant.expectedTurnId = runId
    }
    this.appendKernelEvent(
      'run.queued',
      { sessionId, turnId: runId, scopeId: resource.scopeId, reason },
      { actor: { kind: 'runtime' } },
    )
    this.touch()
    return runId
  }

  private releaseWorkspaceLease(turnId, reason) {
    const lease = (this.state.workspaceLeases ?? []).find(
      (candidate) => candidate.turnId === turnId && candidate.status === 'active',
    )
    if (!lease) return
    lease.status = reason === 'revoked' ? 'revoked' : 'released'
    lease.releasedAt = now()
    lease.releaseReason = reason
    queueMicrotask(() => void this.drainRunQueue())
  }

  async drainRunQueue() {
    if (this.#runQueueDrainInFlight || !this.#runQueueDrainEnabled) return
    this.#runQueueDrainInFlight = true
    try {
      while (this.#runQueueDrainEnabled && this.state.runQueue?.length) {
        const candidate = selectFairQueuedRun(this.state.runQueue, Date.now(), (item) => {
          const session = this.state.sessions[item.sessionId]
          return Boolean(
            session &&
            session.status !== 'killed' &&
            !this.isSessionFrozen(item.sessionId) &&
            !this.runs.has(item.sessionId) &&
            !this.admissionReason(item),
          )
        })
        if (!candidate) break
        this.state.runQueue = this.state.runQueue.filter(
          (item) => item.queueId !== candidate.queueId,
        )
        const exceeded = this.budgetExceededFor(candidate, candidate.turnId)
        if (exceeded) {
          const error = this.freezeForBudget(candidate.sessionId, exceeded)
          this.planCouncilFailed(candidate.sessionId, error.message)
          this.settleDynamicSpawnChild(candidate.sessionId, 'failed', error.message)
          continue
        }
        this.state.schedulerMetrics.admittedTotal += 1
        this.state.schedulerMetrics.lastAdmittedScopeId = candidate.scopeId
        this.state.schedulerMetrics.lastAdmissionAt = now()
        try {
          await this.launchRun(
            candidate.sessionId,
            candidate.request as any,
            candidate.turnId,
            candidate,
          )
        } catch (error) {
          if (this.state.sessions[candidate.sessionId]?.status !== 'failed') {
            this.failSession(
              candidate.sessionId,
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      }
    } finally {
      this.#runQueueDrainInFlight = false
      this.touch()
    }
  }

  private async launchRun(
    sessionId,
    {
      prompt,
      attachments = [],
      runKind,
      userMessageId,
      activationEventId,
      channelReadSeqs = [],
      execution = undefined,
    },
    runId,
    resource,
    allowWhileQueueSuspended = false,
  ) {
    const launchLifecycleEpoch = this.#runQueueLifecycleEpoch
    const launchAbort = this.#runQueueLaunchAbort.promise
    const session = this.state.sessions[sessionId]
    const council = this.planCouncilForSession(sessionId)
    const participant = council?.participants?.[sessionId]
    const runExecution = validateExecutionEnvelope(execution)
      ? { ...clone(execution), activationId: runId }
      : undefined
    if (participant?.expectedArtifactKind && !participant.expectedTurnId) {
      participant.expectedTurnId = runId
      if (runExecution) participant.expectedExecutionEnvelope = clone(runExecution)
    }
    const lease = {
      leaseId: randomUUID(),
      ...resource,
      mode: resource.leaseMode,
      status: 'active',
      acquiredAt: now(),
      baseline: {},
    }
    try {
      lease.baseline.head = gitOutput(session.cwd, ['rev-parse', 'HEAD'])
      lease.baseline.statusDigest = createHash('sha256')
        .update(gitOutput(session.cwd, ['status', '--porcelain=v1']))
        .digest('hex')
    } catch {
      /* non-git workspaces still receive mutual exclusion */
    }
    this.state.workspaceLeases.push(lease)
    let bridgeResult:
      | { status: 'started'; bridgeUrl: string }
      | { status: 'aborted' }
    try {
      bridgeResult = await Promise.race([
        this.bridge
          .start()
          .then((bridgeUrl) => ({ status: 'started' as const, bridgeUrl })),
        launchAbort.then(() => ({ status: 'aborted' as const })),
      ])
    } catch (error) {
      this.releaseWorkspaceLease(runId, 'membrane-start-failed')
      throw error
    }
    if (
      bridgeResult.status === 'aborted' ||
      launchLifecycleEpoch !== this.#runQueueLifecycleEpoch ||
      (!this.#runQueueDrainEnabled && !allowWhileQueueSuspended)
    ) {
      const error = new Error('Provider run launch was cancelled by runtime shutdown.')
      this.releaseWorkspaceLease(runId, 'runtime-shutdown')
      this.failSession(sessionId, error.message, {
        actor: { kind: 'runtime' },
        causeId: activationEventId,
        ...(runExecution ? { execution: clone(runExecution) } : {}),
      })
      throw error
    }
    const bridgeUrl = bridgeResult.bridgeUrl
    const membraneToken = this.bridge.createRunToken(sessionId)
    const fromTurnCount = completedTurnCount(this.checkpointHost(), session)
    let turnCheckpoint
    session.status = 'running'
    session.startedAt = now()
    session.finishedAt = undefined
    session.updatedAt = session.startedAt
    try {
      turnCheckpoint = {
        ...captureTurnCheckpoint(this.checkpointHost(), {
          sessionId,
          turnId: runId,
          turnCount: fromTurnCount,
          stage: 'before',
        }),
        fromTurnCount,
      }
    } catch (error) {
      turnCheckpoint = {
        fromTurnCount,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.updateMessageRunId(session, userMessageId, runId)
    this.updateNodeStatus(sessionId, 'running')
    this.runContext.set(sessionId, {
      runId,
      runKind,
      assistantMessageId: undefined,
      sawTextDelta: false,
      turnCheckpoint,
      turnDiffRecorded: false,
      // Kernel event id of the session.created/activated fact that started
      // this run; provider lifecycle facts chain to it via causeId.
      activationEventId,
      // Channel deliveries listed in this run's activation message; rolled
      // back to unread if the run dies without ever producing output.
      channelReadSeqs,
      runProducedOutput: false,
      resource: { ...resource, admitted: true, startedAt: session.startedAt },
      ...(runExecution ? { execution: runExecution } : {}),
    })
    this.appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.startedAt,
      type: 'turn.started',
      sessionId,
      turnId: runId,
      activationEventId,
      ...(runExecution ? { execution: clone(runExecution) } : {}),
    })
    this.appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.startedAt,
      type: 'session.state',
      sessionId,
      status: 'running',
    })
    this.touch()
    this.broadcast({
      type: 'runtime.state',
      state: this.getState(),
    })
    this.journalAutomaticDeploymentRunStarted(sessionId)

    let run
    try {
      run = this.providerService.startTurn({
        providerKind: session.providerKind,
        providerInstanceId: session.providerInstanceId,
        turnId: runId,
        prompt,
        attachments,
        cwd: session.cwd,
        backendSessionId:
          runKind === 'resume'
            ? (session.providerSessionId ?? session.backendSessionId)
            : undefined,
        providerResumeCursor: session.providerResumeCursor,
        sessionId,
        runtimeSettings: session.runtimeSettings,
        // The session's own inbox: providers grant read access up front so
        // channel deliveries never stall on a permission prompt (§4.2.5).
        // ensureChannelDir: the dir must exist (and be canonical) when the
        // provider session controller initializes its allowlist.
        channelDir: this.channelStore.ensureChannelDir(sessionId),
        membrane: {
          bridgeUrl,
          token: membraneToken,
        },
      })
    } catch (error) {
      this.bridge.revokeRunToken(membraneToken)
      this.releaseWorkspaceLease(runId, 'provider-start-failed')
      this.failSession(sessionId, error.message)
      throw error
    }

    this.runs.set(sessionId, run)
    this.scheduleRunDurationBudgetTimer(sessionId)

    run.on('native', (event) => this.appendNativeProviderEnvelope(sessionId, event))
    run.on('providerEvent', (event) => this.appendExternalProviderRuntimeEvent(sessionId, event))
    run.on('providerSession', (event) => this.recordProviderSession(sessionId, event))
    run.on('stderr', (data) => this.appendProviderStderr(sessionId, data))
    run.on('result', (event) => this.recordResult(sessionId, event))
    run.on('error', (error) => {
      if (this.workflowCompensatedRuns.has(sessionId)) return
      const current = this.state.sessions[sessionId]
      const context = this.runContext.get(sessionId)
      if (current?.status === 'killed' || context?.killRequested === true) {
        return
      }
      this.failSession(sessionId, error.message)
    })
    run.on('close', ({ code, signal, killed }) => {
      this.runs.delete(sessionId)
      const budgetTimer = this.#runBudgetTimers.get(sessionId)
      if (budgetTimer) clearTimeout(budgetTimer)
      this.#runBudgetTimers.delete(sessionId)
      this.bridge.revokeRunToken(membraneToken)

      if (this.workflowCompensatedRuns.delete(sessionId)) return

      const current = this.state.sessions[sessionId]
      if (!current) {
        return
      }

      const context = this.runContext.get(sessionId)
      if (!context && ['idle', 'failed', 'killed'].includes(current.status)) return
      current.exitCode = code
      current.signal = signal
      current.finishedAt = now()
      current.updatedAt = current.finishedAt
      recordTurnCheckpointDiff(this.checkpointHost(), sessionId, current.finishedAt)
      this.appendTurnCompletedIfMissing(sessionId, current.finishedAt)
      this.cancelOpenRuntimeInteractions(sessionId, current.finishedAt)

      if (context?.resourceViolation) {
        this.failSession(sessionId, context.resourceViolation.message)
        return
      }

      if (killed || current.status === 'killed') {
        current.status = 'killed'
        this.markActiveAssistant(sessionId, 'failed')
        this.updateNodeStatus(sessionId, 'killed')
        this.appendProviderRuntimeEvent(sessionId, {
          id: randomUUID(),
          ts: current.updatedAt,
          type: 'session.state',
          sessionId,
          status: 'killed',
        })
        this.recordUsageFact(sessionId, current.finishedAt)
        if (context?.runId) this.releaseWorkspaceLease(context.runId, 'revoked')
        this.runContext.delete(sessionId)
        this.touch()
        this.emitRuntimeEvent({
          type: 'session.killed',
          sessionId,
          state: this.getState(),
          // The kernel fact was appended by the kill command; the process
          // exit is only its completion, not a second fact.
          kernelEventId: context?.killedEventId,
        })
        return
      }

      // The provider error event is the terminal authority for a failed run.
      // It already called failSession (and emitted exactly one kernel fact);
      // close only supplies process metadata and must not fail the same turn a
      // second time, because `on: failed` relationships observe those facts.
      if (current.status === 'failed') {
        this.touch()
        return
      }

      if (code === 0 && current.status !== 'failed') {
        const runId = context?.runId
        void this.dispatchCommand({
          commandId: `provider-complete:${sessionId}:${runId}`,
          idempotencyKey: `provider-complete:${sessionId}:${runId}`,
          kind: 'provider_complete_run',
          actor: { kind: 'provider', ref: sessionId },
          causeId: context?.activationEventId,
          ...(context?.execution ? { execution: clone(context.execution) } : {}),
          input: { sessionId, runId, exitCode: code, signal },
        })
          .then((result) => {
            this.emitRuntimeEvent({
              type: 'session.finished',
              sessionId,
              state: this.getState(),
              kernelEventId: result.kernelEventId,
            })
          })
          .catch((error) => {
            if ((error as Error & { code?: string })?.code !== 'ORRERY_EFFECT_DRAIN_CRASH') {
              this.failSession(sessionId, error instanceof Error ? error.message : String(error))
            }
          })
        return
      }

      this.failSession(sessionId, current.error ?? `Claude exited with code ${code ?? 'null'}`)
    })
    return runId
  }

  private appendNativeProviderEnvelope(sessionId, event) {
    const session = this.state.sessions[sessionId]
    if (!session || !event?.raw) {
      return
    }

    this.markRunProducedOutput(sessionId)
    session.nativeEvents ??= []
    const nativeEvent = {
      id: randomUUID(),
      ts: nonEmptyString(event.ts) ? event.ts : now(),
      sessionId,
      providerKind: validProviderKinds.has(event.providerKind)
        ? event.providerKind
        : session.providerKind,
      turnId: nonEmptyString(event.turnId) ? event.turnId : this.runContext.get(sessionId)?.runId,
      raw: event.raw,
    }
    session.nativeEvents.push(nativeEvent)
    this.providerService.recordNativeEvent(nativeEvent)
    if (session.nativeEvents.length > 40) {
      session.nativeEvents.splice(0, session.nativeEvents.length - 40)
    }
  }

  private recordProviderSession(sessionId, event) {
    const session = this.state.sessions[sessionId]
    if (!session || !nonEmptyString(event?.providerSessionId)) {
      return
    }

    const providerSessionId = event.providerSessionId.trim()
    const resumeCursor = nonEmptyString(event.resumeCursor)
      ? event.resumeCursor
      : undefined
    if (
      session.providerSessionId === providerSessionId &&
      session.backendSessionId === providerSessionId &&
      (resumeCursor === undefined ||
        session.providerResumeCursor === resumeCursor)
    ) {
      return
    }

    session.providerSessionId = providerSessionId
    session.backendSessionId = providerSessionId
    if (resumeCursor !== undefined) session.providerResumeCursor = resumeCursor
    session.updatedAt = now()
    // The first upstream handle must survive an immediate app crash so the
    // provider can resume. Adapter/controller deduplication guarantees this
    // synchronous durability boundary runs once per distinct binding, not
    // once per streamed SDK message.
    this.touch()
  }

  appendExternalProviderRuntimeEvent(sessionId, event) {
    const session = this.state.sessions[sessionId]
    if (!session) {
      return
    }

    this.markRunProducedOutput(sessionId)
    const normalizedEvent = {
      ...event,
      sessionId,
    }
    const compactEvent = this.appendProviderRuntimeEvent(sessionId, normalizedEvent)
    if (!compactEvent) {
      return
    }

    if (compactEvent.type === 'content.delta') {
      this.appendContentDeltaMessage(sessionId, compactEvent)
    }

    session.updatedAt = compactEvent.ts ?? now()
    this.touchDeferred()
    this.broadcast({
      type: 'provider.runtime',
      sessionId,
      providerEvent: compactEvent,
    })
    if (normalizedEvent.type === 'item.started') {
      const context = this.runContext.get(sessionId)
      const policy = context?.resource ? this.resourcePolicy(context.resource.scopeId) : undefined
      const toolCalls = (session.runtimeActivities ?? []).filter(
        (activity) =>
          activity.kind === 'tool_call' &&
          Date.parse(activity.startedAt ?? session.startedAt) >=
            Date.parse(context?.resource?.startedAt ?? session.startedAt),
      ).length
      const toolCallLimit =
        policy?.consumptionEnforcement === 'hard'
          ? context?.resource?.reservedToolCalls
          : policy?.maxToolCallsPerTurn
      if (toolCallLimit !== undefined && toolCalls > toolCallLimit) {
        const exceeded = { dimension: 'toolCalls', used: toolCalls, limit: toolCallLimit }
        if (policy.consumptionEnforcement === 'hard')
          this.markRunBudgetViolation(sessionId, exceeded)
        else if (policy.consumptionEnforcement === 'warn')
          this.markRunBudgetWarning(sessionId, exceeded)
      }
    }
  }

  private appendContentDeltaMessage(sessionId, event) {
    if (event.streamKind !== 'assistant_text' || typeof event.text !== 'string') {
      return
    }

    const session = this.state.sessions[sessionId]
    const context = this.runContext.get(sessionId)
    if (!session || !context) {
      return
    }

    const message = this.ensureAssistantMessage(session, context)
    if (event.isSnapshot) {
      if (!context.sawTextDelta || message.content.trim().length === 0) {
        message.content = event.text
      }
    } else {
      message.content += event.text
      context.sawTextDelta = true
    }
    message.status = 'streaming'
  }

  private appendProviderStderr(sessionId, data) {
    const session = this.state.sessions[sessionId]
    if (!session || typeof data !== 'string' || data.length === 0) {
      return
    }

    const chunk = {
      id: randomUUID(),
      sessionId,
      ts: now(),
      stream: 'stderr',
      raw: data,
      text: data,
    }
    session.chunks.push(chunk)
    truncateChunks(session.chunks)
  }

  appendProviderRuntimeEvent(sessionId, event) {
    const session = this.state.sessions[sessionId]
    if (!session) {
      return undefined
    }

    // Log the lossless provider event, but only place its compact semantic
    // projection in the hot state and renderer transport.
    this.providerService.recordRuntimeEvent(sessionId, event)
    const compactEvent = compactProviderRuntimeEvent(event)
    session.runtimeEvents ??= []
    session.runtimeEvents.push(compactEvent)
    const removedEvents = truncateEvents(session.runtimeEvents)
    const removedDiffEvent = removedEvents.some(
      (removedEvent) => removedEvent.type === 'turn.diff.updated',
    )
    if (compactEvent.type === 'turn.diff.updated' || removedDiffEvent) {
      pruneTurnCheckpointRefs(this.checkpointHost(), sessionId)
    }

    if (compactEvent.type === 'runtime.configured') {
      session.effectiveRuntimeConfig = normalizeProviderEffectiveRuntimeConfig(
        compactEvent.effectiveRuntimeConfig,
        session.providerKind,
        session.runtimeSettings,
      )
      return compactEvent
    }

    if (
      compactEvent.type === 'item.started' ||
      compactEvent.type === 'item.updated' ||
      compactEvent.type === 'item.completed'
    ) {
      this.upsertRuntimeActivity(session, compactEvent.item)
      return compactEvent
    }

    if (compactEvent.type === 'request.opened') {
      session.runtimeRequests ??= []
      const existing = session.runtimeRequests.find((item) => item.id === compactEvent.request.id)
      if (existing) {
        Object.assign(existing, compactEvent.request)
      } else {
        session.runtimeRequests.push(compactEvent.request)
        if (compactEvent.request.kind === 'permission' || compactEvent.request.kind === 'confirmation') {
          this.appendKernelEvent(
            'permission.requested',
            {
              sessionId,
              requestId: compactEvent.request.id,
              requestKind: compactEvent.request.kind,
              title: truncateForLog(String(compactEvent.request.title ?? compactEvent.request.body ?? ''), 200),
            },
            { actor: { kind: 'provider', ref: session.providerInstanceId } },
          )
        }
      }
      truncateActivities(session.runtimeRequests)
      return compactEvent
    }

    if (compactEvent.type === 'request.resolved') {
      session.runtimeRequests ??= []
      const request = session.runtimeRequests.find((item) => item.id === compactEvent.requestId)
      if (request) {
        request.status = compactEvent.status ?? 'resolved'
        request.resolvedAt = compactEvent.ts
      }
      return compactEvent
    }

    if (compactEvent.type === 'user-input.requested') {
      session.runtimeUserInputRequests ??= []
      const existing = session.runtimeUserInputRequests.find((item) => item.id === compactEvent.request.id)
      const nextRequest = {
        status: 'open',
        ...compactEvent.request,
      }
      if (existing) {
        Object.assign(existing, nextRequest)
      } else {
        session.runtimeUserInputRequests.push(nextRequest)
      }
      truncateActivities(session.runtimeUserInputRequests)
      return compactEvent
    }

    if (compactEvent.type === 'user-input.answered') {
      session.runtimeUserInputRequests ??= []
      const request = session.runtimeUserInputRequests.find((item) => item.id === compactEvent.requestId)
      if (request) {
        request.status = 'answered'
        request.answeredAt = compactEvent.ts
        request.answer = compactEvent.answer
        request.answers = compactEvent.answers
      }
      return compactEvent
    }

    if (compactEvent.type === 'user-input.resolved') {
      session.runtimeUserInputRequests ??= []
      const request = session.runtimeUserInputRequests.find((item) => item.id === compactEvent.requestId)
      if (request) {
        request.status = compactEvent.status ?? 'resolved'
        request.answeredAt = compactEvent.ts
      }
      return compactEvent
    }

    if (compactEvent.type === 'plan.updated') {
      session.runtimePlans ??= []
      const plan = compactRuntimePlan(compactEvent.plan)
      const index = session.runtimePlans.findIndex((candidate) => candidate.id === plan.id)
      if (index >= 0) {
        session.runtimePlans[index] = plan
      } else {
        session.runtimePlans.push(plan)
      }
      truncateActivities(session.runtimePlans)
    }
    return compactEvent
  }

  cancelOpenRuntimeInteractions(sessionId, ts) {
    const session = this.state.sessions[sessionId]
    if (!session) {
      return
    }

    const openRequests = (session.runtimeRequests ?? []).filter(
      (request) => request.status === 'open',
    )
    for (const request of openRequests) {
      this.appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'request.resolved',
        sessionId,
        requestId: request.id,
        status: 'canceled',
      })
    }

    const openUserInputRequests = (session.runtimeUserInputRequests ?? []).filter(
      (request) => request.status === 'open',
    )
    for (const request of openUserInputRequests) {
      this.appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'user-input.resolved',
        sessionId,
        requestId: request.id,
        status: 'canceled',
      })
    }
  }

  private appendTurnCompletedIfMissing(sessionId, ts) {
    const session = this.state.sessions[sessionId]
    const turnId = this.runContext.get(sessionId)?.runId
    if (!session || !turnId) {
      return
    }

    const alreadyCompleted = session.runtimeEvents?.some(
      (event) => event.type === 'turn.completed' && event.turnId === turnId,
    )
    if (alreadyCompleted) {
      return
    }

    this.appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts,
      type: 'turn.completed',
      sessionId,
      turnId,
    })
  }

  private upsertRuntimeActivity(session, item) {
    item = compactRuntimeItem(item)
    session.runtimeActivities ??= []
    const existing = session.runtimeActivities.find((activity) => activity.id === item.id)
    const next = {
      ...(existing ?? {}),
      ...item,
      sessionId: session.sessionId,
      title: item.title ?? existing?.title ?? item.command ?? item.providerName ?? item.id,
      status: item.status ?? existing?.status ?? (item.completedAt ? 'completed' : 'running'),
      startedAt: existing?.startedAt ?? item.startedAt,
      updatedAt: item.updatedAt ?? item.completedAt ?? now(),
    }

    if (item.completedAt) {
      next.completedAt = item.completedAt
    }
    if (next.startedAt && next.completedAt && next.durationMs === undefined) {
      const start = Date.parse(next.startedAt)
      const end = Date.parse(next.completedAt)
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        next.durationMs = end - start
      }
    }
    if (typeof next.output === 'string') {
      next.sublines = resultSublines(next.output)
    }

    if (existing) {
      Object.assign(existing, next)
    } else {
      session.runtimeActivities.push(next)
      truncateActivities(session.runtimeActivities)
    }
  }

  private ensureAssistantMessage(session, context) {
    let message = context.assistantMessageId
      ? session.messages.find((item) => item.id === context.assistantMessageId)
      : undefined

    if (!message) {
      message = {
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'assistant',
        content: '',
        ts: now(),
        runId: context.runId,
        status: 'streaming',
      }
      session.messages.push(message)
      context.assistantMessageId = message.id
    }

    return message
  }

  private recordResult(sessionId, event) {
    const session = this.state.sessions[sessionId]
    if (!session) {
      return
    }

    session.backendSessionId = event.session_id ?? session.backendSessionId
    session.providerSessionId = event.session_id ?? session.providerSessionId
    const context = this.runContext.get(sessionId)
    if (context) {
      context.providerUsage = normalizeProviderUsage(event.usage)
      context.providerUsageSource = isObject(event.usage) ? 'provider' : 'unavailable'
      context.providerTurns = Number.isFinite(event.num_turns) ? Number(event.num_turns) : 0
      context.providerDurationMs = Number.isFinite(event.duration_ms)
        ? Number(event.duration_ms)
        : undefined
      const policy = context.resource ? this.resourcePolicy(context.resource.scopeId) : undefined
      const tokenLimit =
        policy?.consumptionEnforcement === 'hard'
          ? context.resource?.reservedTokens
          : policy?.maxTokensPerTurn
      if (tokenLimit !== undefined && context.providerUsage.totalTokens > tokenLimit) {
        const exceeded = {
          dimension: 'tokens',
          used: context.providerUsage.totalTokens,
          limit: tokenLimit,
        }
        if (policy.consumptionEnforcement === 'hard')
          this.markRunBudgetViolation(sessionId, exceeded)
        else if (policy.consumptionEnforcement === 'warn')
          this.markRunBudgetWarning(sessionId, exceeded)
      }
    }
    session.result = typeof event.result === 'string' ? event.result : undefined
    if (session.result) {
      if (context) {
        const message = this.ensureAssistantMessage(session, context)
        if (!context.sawTextDelta || message.content.trim().length === 0) {
          message.content = session.result
        }
      }
    }
    session.updatedAt = now()
    this.touchDeferred()
  }

  private markRunProducedOutput(sessionId) {
    const context = this.runContext.get(sessionId)
    if (context) {
      context.runProducedOutput = true
    }
  }

  private markRunBudgetViolation(sessionId, exceeded) {
    const context = this.runContext.get(sessionId)
    if (!context || context.resourceViolation) return
    const error = this.freezeForBudget(sessionId, exceeded)
    context.resourceViolation = { ...exceeded, message: error.message }
    try {
      this.runs.get(sessionId)?.kill()
    } catch {
      /* close/error path remains authoritative */
    }
  }

  private scheduleRunDurationBudgetTimer(sessionId) {
    const existing = this.#runBudgetTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.#runBudgetTimers.delete(sessionId)
    const context = this.runContext.get(sessionId)
    const policy = context?.resource ? this.resourcePolicy(context.resource.scopeId) : undefined
    const durationLimit =
      policy?.consumptionEnforcement === 'hard'
        ? context?.resource?.reservedDurationMs
        : policy?.maxDurationPerTurnMs
    if (
      !context ||
      !policy ||
      policy.consumptionEnforcement === 'off' ||
      durationLimit === undefined
    )
      return
    const startedAtMs = Date.parse(context.resource?.startedAt ?? '')
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0
    const remainingMs = durationLimit - elapsedMs
    if (remainingMs <= 0) {
      const exceeded = { dimension: 'durationMs', used: elapsedMs, limit: durationLimit }
      if (policy.consumptionEnforcement === 'hard') this.markRunBudgetViolation(sessionId, exceeded)
      else this.markRunBudgetWarning(sessionId, exceeded)
      return
    }
    const timer = setTimeout(() => this.scheduleRunDurationBudgetTimer(sessionId), remainingMs)
    timer.unref?.()
    this.#runBudgetTimers.set(sessionId, timer)
  }

  private markRunBudgetWarning(sessionId, exceeded) {
    const context = this.runContext.get(sessionId)
    if (!context) return
    context.resourceWarnings ??= {}
    if (context.resourceWarnings[exceeded.dimension]) return
    context.resourceWarnings[exceeded.dimension] = clone(exceeded)
    this.appendKernelEvent(
      'resource.budget-warning',
      { sessionId, turnId: context.runId, ...exceeded },
      {
        actor: { kind: 'runtime' },
        ...(context.execution ? { execution: clone(context.execution) } : {}),
      },
      {
        reason: `Resource budget warning: ${exceeded.dimension} ${exceeded.used}/${exceeded.limit}`,
      },
    )
    this.touch()
  }

  private recordUsageFact(sessionId, completedAt) {
    const session = this.state.sessions[sessionId]
    const context = this.runContext.get(sessionId)
    if (
      !session ||
      !context?.runId ||
      (this.state.usageFacts ?? []).some((fact) => fact.turnId === context.runId)
    )
      return
    const usage = context.providerUsage ?? normalizeProviderUsage(undefined)
    const startedAt = context.resource?.startedAt ?? session.startedAt ?? completedAt
    const measured = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    const toolCalls = (session.runtimeActivities ?? []).filter(
      (activity) =>
        activity.turnId === context.runId ||
        (!activity.turnId &&
          Date.parse(activity.startedAt ?? completedAt) >= Date.parse(startedAt)),
    ).length
    const loopIds = this.queries
      .loopViewsWithTerminalFacts(this.queries.kernelView(this.state))
      .filter((loop) => loop.memberSessionIds?.includes(sessionId))
      .map((loop) => loop.loopId)
    const fact = {
      usageId: randomUUID(),
      sessionId,
      turnId: context.runId,
      providerKind: session.providerKind,
      providerInstanceId: session.providerInstanceId,
      scopeId: context.resource?.scopeId ?? this.resourceScopeId(sessionId),
      startedAt,
      completedAt,
      durationMs: context.providerDurationMs ?? measured,
      ...usage,
      toolCalls,
      providerTurns: context.providerTurns ?? 0,
      source: context.providerUsageSource ?? 'unavailable',
      ...(loopIds.length ? { loopIds } : {}),
      ...(context.execution ? { execution: clone(context.execution) } : {}),
    }
    this.state.usageFacts.push(fact)
    this.appendKernelEvent('usage.recorded', fact, {
      actor: { kind: 'runtime' },
      ...(context.execution ? { execution: clone(context.execution) } : {}),
    })
    const policy = this.resourcePolicy(fact.scopeId)
    if (policy.consumptionEnforcement === 'warn') {
      const budgetStartedAt = Date.parse(policy.budgetStartedAt ?? '')
      const scopedFacts = this.state.usageFacts.filter(
        (candidate) =>
          candidate.scopeId === fact.scopeId &&
          (!Number.isFinite(budgetStartedAt) ||
            Date.parse(candidate.completedAt) >= budgetStartedAt),
      )
      const exceeded = budgetExceeded(policy, scopedFacts)
      if (exceeded) this.markRunBudgetWarning(sessionId, exceeded)
    }
  }

  recordInterruptedUsageFact(sessionId) {
    const session = this.state.sessions[sessionId]
    const started = [...(session?.runtimeEvents ?? [])]
      .reverse()
      .find((event) => event.type === 'turn.started' && event.turnId)
    if (
      !session ||
      !started?.turnId ||
      (this.state.usageFacts ?? []).some((fact) => fact.turnId === started.turnId)
    )
      return
    const completedAt = now()
    const startedAt = started.ts ?? session.startedAt ?? completedAt
    const council = this.planCouncilForSession(sessionId)
    const participant = council?.participants?.[sessionId]
    const terminalCause = started.activationEventId
      ? this.queries.allKernelEvents().find((event) => event.id === started.activationEventId)
      : undefined
    const execution =
      participant?.expectedTurnId === started.turnId &&
      validateExecutionEnvelope(participant.expectedExecutionEnvelope)
        ? participant.expectedExecutionEnvelope
        : validateExecutionEnvelope(session.dynamicTopology?.execution)
          ? session.dynamicTopology.execution
          : validateExecutionEnvelope(started.execution)
            ? started.execution
            : terminalCause &&
                validateExecutionEnvelope(
                  terminalCause.execution ?? terminalCause.payload?.execution,
                )
              ? (terminalCause.execution ?? terminalCause.payload.execution)
              : undefined
    const loopIds = this.queries
      .loopViewsWithTerminalFacts(this.queries.kernelView(this.state))
      .filter((loop) => loop.memberSessionIds?.includes(sessionId))
      .map((loop) => loop.loopId)
    const fact = {
      usageId: randomUUID(),
      sessionId,
      turnId: started.turnId,
      providerKind: session.providerKind,
      providerInstanceId: session.providerInstanceId,
      scopeId: this.resourceScopeId(sessionId),
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      toolCalls: (session.runtimeActivities ?? []).filter(
        (activity) => activity.turnId === started.turnId,
      ).length,
      providerTurns: 0,
      source: 'unavailable',
      ...(execution ? { execution: clone(execution) } : {}),
      ...(loopIds.length ? { loopIds } : {}),
    }
    this.state.usageFacts.push(fact)
    this.appendKernelEvent(
      'usage.recorded',
      fact,
      { actor: { kind: 'runtime' } },
      {
        reason: 'Provider turn was interrupted by runtime restart; token counters are unavailable.',
      },
    )
  }

  cmdSetResourcePolicy(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human') throw new Error('Only a human can change resource policy.')
    const scopeId = optionalTrimmedString(input.scopeId) ?? 'global'
    const current = this.resourcePolicy(scopeId)
    const next = { ...current, scopeId, updatedAt: now(), updatedBy: 'human' }
    if (input.resetUsage === true) next.budgetStartedAt = next.updatedAt
    if (input.consumptionEnforcement !== undefined) {
      if (!['off', 'warn', 'hard'].includes(input.consumptionEnforcement)) {
        throw new Error('consumptionEnforcement must be off, warn, or hard.')
      }
      next.consumptionEnforcement = input.consumptionEnforcement
    } else if (
      runtimeConsumptionBudgetKeys.some((key) => input[key] !== undefined && input[key] !== null)
    ) {
      next.consumptionEnforcement = 'hard'
    }
    if (input.serializeWorkspaceAccess !== undefined) {
      if (typeof input.serializeWorkspaceAccess !== 'boolean') {
        throw new Error('serializeWorkspaceAccess must be a boolean.')
      }
      next.serializeWorkspaceAccess = input.serializeWorkspaceAccess
    }
    for (const key of [
      'maxConcurrentSessions',
      'maxConcurrentPerProvider',
      'maxQueuedRuns',
      'maxFanout',
    ]) {
      if (input[key] === undefined) continue
      const value = Number(input[key])
      if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value))
        throw new Error(`${key} must be a positive integer.`)
      next[key] = value
    }
    for (const key of runtimeConsumptionBudgetKeys) {
      if (input[key] === undefined) continue
      if (input[key] === null) {
        delete next[key]
        continue
      }
      const value = Number(input[key])
      if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value))
        throw new Error(`${key} must be a positive integer or null.`)
      next[key] = value
    }
    this.state.resourcePolicies[scopeId] = next
    for (const lease of this.state.workspaceLeases ?? []) {
      if (lease.status === 'active' && lease.scopeId === scopeId)
        this.applyResourceReservations(lease, next)
    }
    for (const queued of this.state.runQueue ?? []) {
      if (queued.scopeId === scopeId) this.applyResourceReservations(queued, next)
    }
    for (const context of this.runContext.values()) {
      if (context.resource?.scopeId === scopeId)
        this.applyResourceReservations(context.resource, next)
    }
    this.appendKernelEvent('resource.policy.updated', { scopeId, policy: clone(next) }, ctx)
    this.touch()
    for (const [sessionId, context] of this.runContext) {
      if (context.resource?.scopeId === scopeId && this.runs.has(sessionId))
        this.scheduleRunDurationBudgetTimer(sessionId)
    }
    queueMicrotask(() => void this.drainRunQueue())
    return { policy: clone(next), state: this.getState() }
  }

  cmdMergeWorktreeChanges(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human') throw new Error('Only a human can merge worktree changes.')
    const sessionId = optionalTrimmedString(input.sessionId)
    const session = sessionId ? this.state.sessions[sessionId] : undefined
    if (!session || session.project?.workMode !== 'worktree' || !session.project.repoRoot) {
      throw new Error(`Session is not backed by a managed worktree: ${sessionId ?? ''}`)
    }
    if (
      this.runs.has(sessionId) ||
      (this.state.runQueue ?? []).some((item) => item.sessionId === sessionId)
    ) {
      throw new Error('Cannot merge changes while the worktree session is running or queued.')
    }
    const lastAssistant = [...(session.messages ?? [])]
      .reverse()
      .find(
        (message) => message.role === 'assistant' && message.status === 'complete' && message.runId,
      )
    if (!lastAssistant) throw new Error('No completed worktree turn is available to merge.')
    if (session.project.mergedTurnId === lastAssistant.runId) {
      return { ok: true, applied: false, alreadyApplied: true, state: this.getState() }
    }
    let changeset
    try {
      changeset = checkpointDiffForSession(this.checkpointHost(), sessionId, {
        turnId: lastAssistant.runId,
        unbounded: true,
      })
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error)
      const conflict = {
        kind: 'workflow-conflict',
        code: /maxBuffer|ENOBUFS|buffer/i.test(detail)
          ? 'changeset-too-large'
          : 'changeset-unavailable',
        sessionId,
        detail: truncateForLog(detail, 1200),
      }
      this.appendKernelEvent('worktree.merge-conflicted', conflict, ctx)
      return { ok: false, conflict, state: this.getState() }
    }
    if (!changeset.patch?.trim())
      return { ok: true, applied: false, changeset, state: this.getState() }
    if (changeset.truncated) {
      const conflict = {
        kind: 'workflow-conflict',
        code: 'changeset-truncated',
        sessionId,
        detail: 'The stable changeset exceeds the merge-safe patch limit; no files were applied.',
      }
      this.appendKernelEvent('worktree.merge-conflicted', conflict, ctx)
      return { ok: false, conflict, changeset, state: this.getState() }
    }
    let workspaceKey = path.resolve(session.project.repoRoot)
    try {
      workspaceKey = fs.realpathSync(workspaceKey)
    } catch {
      /* git validation below remains authoritative */
    }
    const mergeTurnId = `merge:${sessionId}:${lastAssistant.runId}`
    const resource = {
      sessionId,
      turnId: mergeTurnId,
      scopeId: this.resourceScopeId(sessionId),
      providerInstanceId: 'runtime:worktree-merge',
      workspaceKey,
      leaseMode: 'writer',
    }
    if (!leaseCompatible(this.state.workspaceLeases ?? [], { ...resource, mode: 'writer' })) {
      const conflict = {
        kind: 'workflow-conflict',
        code: 'workspace-busy',
        sessionId,
        workspaceKey,
        detail: 'The target workspace currently has an active reader or writer lease.',
      }
      this.appendKernelEvent('worktree.merge-conflicted', conflict, ctx)
      return { ok: false, conflict, changeset, state: this.getState() }
    }
    this.state.workspaceLeases.push({
      leaseId: randomUUID(),
      ...resource,
      mode: 'writer',
      status: 'active',
      acquiredAt: now(),
      baseline: {},
    })
    const patchFile = path.join(os.tmpdir(), `orrery-merge-${sessionId}-${randomUUID()}.patch`)
    try {
      fs.writeFileSync(patchFile, `${changeset.patch.replace(/\n?$/, '')}\n`)
      try {
        execFileSync(
          'git',
          ['-C', session.project.repoRoot, 'apply', '--check', '--whitespace=nowarn', patchFile],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      } catch (error) {
        const detail = String(error?.stderr ?? error?.message ?? error)
        const files = [...detail.matchAll(/patch failed: ([^:]+):/g)].map((match) => match[1])
        const conflict = {
          kind: 'workflow-conflict',
          code: 'changeset-conflict',
          sessionId,
          forkPoint: session.project.forkPoint,
          targetHead: (() => {
            try {
              return gitOutput(session.project.repoRoot, ['rev-parse', 'HEAD'])
            } catch {
              return undefined
            }
          })(),
          files: [...new Set(files)],
          detail: truncateForLog(detail, 1200),
        }
        this.appendKernelEvent('worktree.merge-conflicted', conflict, ctx)
        return { ok: false, conflict, changeset, state: this.getState() }
      }
      execFileSync(
        'git',
        ['-C', session.project.repoRoot, 'apply', '--whitespace=nowarn', patchFile],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      session.project.mergedAt = now()
      session.project.mergedTurnId = lastAssistant.runId
      session.project.cleanupStatus = 'ready'
      this.appendKernelEvent(
        'worktree.changeset-applied',
        {
          sessionId,
          turnId: lastAssistant.runId,
          forkPoint: session.project.forkPoint,
          targetHead: gitOutput(session.project.repoRoot, ['rev-parse', 'HEAD']),
          files: changeset.files?.map((file) => file.path) ?? [],
        },
        ctx,
      )
      this.touch()
      return { ok: true, applied: true, changeset, state: this.getState() }
    } finally {
      fs.rmSync(patchFile, { force: true })
      this.releaseWorkspaceLease(mergeTurnId, 'merge-finished')
    }
  }

  cmdCleanupWorktree(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'human')
      throw new Error('Only a human can clean up a managed worktree.')
    const sessionId = optionalTrimmedString(input.sessionId)
    const session = sessionId ? this.state.sessions[sessionId] : undefined
    if (!session || session.project?.workMode !== 'worktree' || !session.project.repoRoot) {
      throw new Error(`Session is not backed by a managed worktree: ${sessionId ?? ''}`)
    }
    if (session.project.cleanupStatus === 'cleaned')
      return { ok: true, alreadyCleaned: true, state: this.getState() }
    if (
      this.runs.has(sessionId) ||
      (this.state.runQueue ?? []).some((item) => item.sessionId === sessionId)
    ) {
      throw new Error('Cannot clean up a running or queued worktree session.')
    }
    if (!session.project.mergedTurnId && input.discardUnmerged !== true) {
      const conflict = {
        kind: 'workflow-conflict',
        code: 'unmerged-worktree',
        sessionId,
        detail:
          'This worktree has not been merged. Set discardUnmerged=true to explicitly discard it.',
      }
      this.appendKernelEvent('worktree.cleanup-conflicted', conflict, ctx)
      return { ok: false, conflict, state: this.getState() }
    }
    try {
      if (fs.existsSync(session.cwd)) {
        execFileSync(
          'git',
          ['-C', session.project.repoRoot, 'worktree', 'remove', '--force', session.cwd],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      }
      if (session.project.branch?.startsWith('orrery/')) {
        let branchExists = false
        try {
          gitOutput(session.project.repoRoot, [
            'show-ref',
            '--verify',
            `refs/heads/${session.project.branch}`,
          ])
          branchExists = true
        } catch {
          /* already removed is idempotent */
        }
        if (branchExists) {
          execFileSync(
            'git',
            ['-C', session.project.repoRoot, 'branch', '-D', session.project.branch],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
        }
      }
    } catch (error) {
      const conflict = {
        kind: 'workflow-conflict',
        code: 'cleanup-failed',
        sessionId,
        detail: truncateForLog(String(error?.stderr ?? error?.message ?? error), 1200),
      }
      this.appendKernelEvent('worktree.cleanup-conflicted', conflict, ctx)
      return { ok: false, conflict, state: this.getState() }
    }
    try {
      fs.rmSync(this.channelStore.channelDir(sessionId), { recursive: true, force: true })
    } catch {
      /* non-critical channel cleanup */
    }
    session.project.cleanupStatus = 'cleaned'
    session.project.cleanedAt = now()
    session.archived = true
    this.appendKernelEvent(
      'worktree.cleaned',
      { sessionId, branch: session.project.branch, mergedTurnId: session.project.mergedTurnId },
      ctx,
    )
    this.touch()
    return { ok: true, state: this.getState() }
  }

  cmdCompleteProviderRun(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor?.kind !== 'provider') {
      throw new Error('Only a provider can complete a provider run.')
    }
    const sessionId = optionalTrimmedString(input.sessionId)
    const runId = optionalTrimmedString(input.runId)
    const session = sessionId ? this.state.sessions[sessionId] : undefined
    const context = sessionId ? this.runContext.get(sessionId) : undefined
    if (!session || !runId || context?.runId !== runId) {
      throw new Error(
        `Provider completion does not match the active run: ${sessionId ?? ''}:${runId ?? ''}`,
      )
    }
    session.exitCode = input.exitCode ?? null
    session.signal = input.signal ?? null
    session.status = 'idle'
    session.finishedAt = session.finishedAt ?? now()
    session.updatedAt = session.finishedAt
    this.markActiveAssistant(sessionId, 'complete')
    this.updateNodeStatus(sessionId, 'idle')
    this.appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.updatedAt,
      type: 'session.state',
      sessionId,
      status: 'idle',
    })
    const finishedEvent = this.appendKernelEvent(
      'session.finished',
      { sessionId, exitCode: session.exitCode, turnId: runId },
      {
        ...ctx,
        causeId: context.activationEventId ?? ctx.causeId,
        ...(context.execution ? { execution: clone(context.execution) } : {}),
      },
    )
    this.planCouncilFinished(sessionId, runId, finishedEvent?.id)
    this.settleDynamicSpawnChild(sessionId, 'completed')
    this.recordUsageFact(sessionId, session.finishedAt)
    this.releaseWorkspaceLease(runId, 'completed')
    this.runContext.delete(sessionId)
    this.touch()
    return { ok: true, sessionId, kernelEventId: finishedEvent?.id }
  }

  failSession(sessionId, error, ctx: JsonRecord = undefined) {
    const session = this.state.sessions[sessionId]
    if (!session) {
      return
    }

    const context = this.runContext.get(sessionId)
    if (
      context &&
      context.runProducedOutput === false &&
      Array.isArray(context.channelReadSeqs) &&
      context.channelReadSeqs.length > 0
    ) {
      // The run died before producing any output: the agent never saw the
      // activation message, so its listed deliveries become unread again.
      this.channelStore.unmarkRead(sessionId, context.channelReadSeqs)
    }
    session.status = 'failed'
    session.error = error
    session.finishedAt = now()
    session.updatedAt = session.finishedAt
    this.markActiveAssistant(sessionId, 'failed')
    this.updateNodeStatus(sessionId, 'failed')
    recordTurnCheckpointDiff(this.checkpointHost(), sessionId, session.finishedAt)
    this.appendTurnCompletedIfMissing(sessionId, session.finishedAt)
    this.cancelOpenRuntimeInteractions(sessionId, session.finishedAt)
    this.appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.finishedAt,
      type: 'session.state',
      sessionId,
      status: 'failed',
    })
    this.recordUsageFact(sessionId, session.finishedAt)
    if (context?.runId) this.releaseWorkspaceLease(context.runId, 'failed')
    this.runContext.delete(sessionId)
    const failedEvent = this.appendKernelEvent(
      'session.failed',
      {
        sessionId,
        error: truncateForLog(String(error ?? ''), 400),
        turnId: context?.runId,
      },
      ctx ?? {
        actor: { kind: 'provider' },
        causeId: context?.activationEventId,
        ...(context?.execution ? { execution: clone(context.execution) } : {}),
      },
    )
    this.planCouncilFailed(sessionId, String(error ?? 'Unknown provider error'))
    this.settleDynamicSpawnChild(sessionId, 'failed', String(error ?? 'Unknown provider error'))
    this.touch()
    this.emitRuntimeEvent({
      type: 'session.failed',
      sessionId,
      error,
      state: this.getState(),
      kernelEventId: failedEvent?.id,
    })
  }

  settleDynamicSpawnChild(
    sessionId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ) {
    const metadata = this.state.sessions[sessionId]?.dynamicTopology
    const group = metadata ? this.state.dynamicSpawnGroups?.[metadata.groupId] : undefined
    if (!group) return
    const child = group.children?.find((candidate) => candidate.sessionId === sessionId)
    if (!child || ['completed', 'failed', 'cancelled', 'recycled'].includes(child.status)) return
    child.status = status
    if (error) child.error = error
    const terminal = group.children.every((candidate) =>
      ['completed', 'failed', 'cancelled', 'recycled'].includes(candidate.status),
    )
    if (terminal) {
      group.status = group.children.some((candidate) => candidate.status === 'failed')
        ? 'failed'
        : group.children.some((candidate) => candidate.status === 'cancelled')
          ? 'cancelled'
          : group.status === 'capped'
            ? 'capped'
            : 'completed'
    }
    group.updatedAt = now()
  }

  markActiveAssistant(sessionId, status) {
    const session = this.state.sessions[sessionId]
    const context = this.runContext.get(sessionId)
    if (!session || !context?.assistantMessageId) {
      return
    }

    const message = session.messages.find((item) => item.id === context.assistantMessageId)
    if (message) {
      message.status = status
    }
  }

  private updateMessageRunId(session, messageId, runId) {
    const message = session.messages.find((item) => item.id === messageId)
    if (message) {
      message.runId = runId
    }
  }
}
