import { randomUUID } from 'node:crypto'
import {
  type KernelState,
  defaultCycleMaxFirings,
  loopsOf,
} from '../../../shared/graph-core/index.js'
import {
  type JsonRecord,
  clone,
  isObject,
  now,
  optionalTrimmedString,
  validProviderKinds,
} from '../runtimeCommon.js'
import { normalizeLoopPolicy } from '../persistence/runtimeStateRecovery.js'
import { defaultMasterPrompt } from '../reports/reportFormatting.js'

export interface ClusterControlRuntimeHost {
  state(): JsonRecord
  humanCtx(): JsonRecord
  reviveDirectProviderRuntime(): void
  getState(): JsonRecord
  appendKernelEvent(
    type: string,
    payload: JsonRecord,
    ctx?: JsonRecord,
    options?: JsonRecord,
  ): JsonRecord | undefined
  touch(): void
  broadcast(event: JsonRecord): void
  cmdCreateSession(
    input: JsonRecord,
    ctx: JsonRecord,
    options?: JsonRecord,
  ): Promise<JsonRecord> | JsonRecord
  loopSubscriptionsForCluster(clusterId: string): JsonRecord[]
  cmdAuthorSubscription(
    input: JsonRecord,
    ctx: JsonRecord,
    options?: JsonRecord,
  ): JsonRecord
  cmdStopSubscription(input: JsonRecord, ctx: JsonRecord): JsonRecord
  membraneCreateInput(source: string, input?: JsonRecord): JsonRecord
  reviewerBootstrapPrompt(): string
  reviewerActivationNote(): string
  coderActivationNote(): string
  enqueueSchedulerWork(
    run: () => unknown,
    onError?: (error: unknown) => void,
  ): void
  createPendingActivation(
    decision: JsonRecord,
    event: JsonRecord,
    ctx: JsonRecord,
  ): unknown
  schedulerRuleContext(subscriptionId: string, causeId?: string): JsonRecord
  hasRun(sessionId: string): boolean
  cmdKillSession(input: JsonRecord, ctx: JsonRecord): unknown
  kernelView(): KernelState
  createEnvelope(source: string): JsonRecord
  addEdge(input: JsonRecord): unknown
}

export class ClusterControlRuntime {
  #host: ClusterControlRuntimeHost

  constructor(host: ClusterControlRuntimeHost) {
    this.#host = host
  }

  upsertCluster(input: JsonRecord = {}) {
    return this.cmdUpsertCluster(input, this.#host.humanCtx())
  }

  cmdUpsertCluster(input: JsonRecord = {}, ctx: JsonRecord) {
    const nodeIds = this.normalizeClusterNodeIds(input.nodeIds)
    if (nodeIds.length === 0) {
      throw new Error('Cluster requires at least one managed session node')
    }

    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : `cluster-${randomUUID().slice(0, 8)}`
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : clusterId
    const existing = this.#host.state().clusters[clusterId]

    this.#host.state().clusters[clusterId] = {
      ...(existing ?? {}),
      clusterId,
      label,
      nodeIds,
      loopPolicy:
        input.loopPolicy !== undefined
          ? normalizeLoopPolicy(input.loopPolicy)
          : existing?.loopPolicy,
    }

    const masterSessionId = this.#host.state().clusters[clusterId].masterSessionId
    for (const node of this.#host.state().nodes) {
      if (
        node.clusterId === clusterId &&
        !nodeIds.includes(node.sessionId) &&
        node.sessionId !== masterSessionId
      ) {
        node.clusterId = undefined
      }
      if (nodeIds.includes(node.sessionId)) {
        node.clusterId = clusterId
      }
      if (node.sessionId === masterSessionId) {
        node.clusterId = clusterId
      }
    }

    for (const sessionId of nodeIds) {
      this.removeNodeFromOtherClusters(sessionId, clusterId)
    }

    this.#host.appendKernelEvent(
      'scope.upserted',
      { clusterId, label, nodeIds },
      ctx,
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'runtime.state',
      state: this.#host.getState(),
    })
    return { clusterId, state: this.#host.getState() }
  }

  async createMasterForCluster(input: JsonRecord = {}) {
    this.#host.reviveDirectProviderRuntime()
    return this.cmdCreateMasterForCluster(input, this.#host.humanCtx())
  }

  async cmdCreateMasterForCluster(input: JsonRecord = {}, ctx: JsonRecord) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#host.state().clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const cluster = this.#host.state().clusters[clusterId]
    if (input.loopPolicy !== undefined) {
      cluster.loopPolicy = normalizeLoopPolicy(input.loopPolicy)
      this.#host.appendKernelEvent(
        'loop.policy-set',
        { clusterId, policy: clone(cluster.loopPolicy) },
        ctx,
      )
    }

    if (cluster.masterSessionId) {
      if (this.#host.state().sessions[cluster.masterSessionId]) {
        this.assignMaster(clusterId, cluster.masterSessionId, ctx)
        this.#host.touch()
        this.#host.broadcast({
          type: 'runtime.state',
          state: this.#host.getState(),
        })
        return {
          sessionId: cluster.masterSessionId,
          state: this.#host.getState(),
        }
      }

      delete cluster.masterSessionId
    }

    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : defaultMasterPrompt(this.#host.state(), clusterId)
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `${cluster.label} Master`

    const result = await this.#host.cmdCreateSession(
      {
        agent: validProviderKinds.has(input.agent) ? input.agent : undefined,
        providerKind: input.providerKind,
        providerInstanceId: input.providerInstanceId,
        prompt,
        cwd: input.cwd,
        label,
        cluster: clusterId,
        role: 'master',
        runtimeSettings: input.runtimeSettings,
      },
      ctx,
    )
    this.assignMaster(clusterId, result.sessionId, ctx)
    this.#host.touch()
    this.#host.broadcast({
      type: 'runtime.state',
      state: this.#host.getState(),
    })
    return {
      sessionId: result.sessionId,
      state: this.#host.getState(),
    }
  }

  assignMasterToCluster(input: JsonRecord = {}) {
    return this.cmdAssignMaster(input, this.#host.humanCtx())
  }

  cmdAssignMaster(input: JsonRecord = {}, ctx: JsonRecord) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined

    if (!clusterId || !this.#host.state().clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }
    if (!sessionId || !this.#host.state().sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    this.assignMaster(clusterId, sessionId, ctx)
    this.#host.touch()
    this.#host.broadcast({
      type: 'runtime.state',
      state: this.#host.getState(),
    })
    return { state: this.#host.getState() }
  }

  setClusterLoopPolicy(input: JsonRecord = {}) {
    return this.cmdSetLoopPolicy(input, this.#host.humanCtx())
  }

  cmdSetLoopPolicy(input: JsonRecord = {}, ctx: JsonRecord) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#host.state().clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    this.#host.state().clusters[clusterId].loopPolicy = normalizeLoopPolicy(
      input.loopPolicy,
    )
    this.#host.appendKernelEvent(
      'loop.policy-set',
      {
        clusterId,
        policy: clone(this.#host.state().clusters[clusterId].loopPolicy),
      },
      ctx,
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'runtime.state',
      state: this.#host.getState(),
    })
    return { state: this.#host.getState() }
  }

  updateNodePositions(input: JsonRecord = {}) {
    return this.cmdUpdateNodePositions(input, this.#host.humanCtx())
  }

  // Canvas layout is view-layer state, not a kernel fact: the command still
  // flows through the unified channel, but no kernel event is appended.
  cmdUpdateNodePositions(input: JsonRecord = {}, _ctx: JsonRecord) {
    const positions = Array.isArray(input.positions) ? input.positions : []
    const appliedPositions: JsonRecord[] = []

    for (const item of positions) {
      if (!isObject(item) || !isObject(item.position)) {
        continue
      }

      const nodeId =
        typeof item.nodeId === 'string' && item.nodeId.trim().length > 0
          ? item.nodeId.trim()
          : undefined
      const x = item.position.x
      const y = item.position.y
      if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
        continue
      }

      const node = this.#host.state().nodes.find(
        (candidate) => candidate.nodeId === nodeId,
      )
      if (!node) {
        continue
      }

      if (node.position.x === x && node.position.y === y) {
        continue
      }

      node.position = { x, y }
      appliedPositions.push({
        nodeId,
        position: { x, y },
      })
    }

    if (appliedPositions.length > 0) {
      this.#host.touch()
      const updatedAt = this.#host.state().updatedAt
      this.#host.broadcast({
        type: 'node.positions.updated',
        positions: appliedPositions,
        updatedAt,
      })
      return { ok: true, positions: appliedPositions, updatedAt }
    }

    return {
      ok: true,
      positions: appliedPositions,
      updatedAt: this.#host.state().updatedAt,
    }
  }

  startMasterLoop(input: JsonRecord = {}) {
    this.#host.reviveDirectProviderRuntime()
    return this.cmdStartLoop(input, this.#host.humanCtx())
  }

  // LoopPolicy is a preset (kernel doc §6.2): starting the loop compiles it
  // into the two hero-loop subscriptions of §8.2 —
  //   S1: coder finished        → deliver diff  + activate reviewer (gate master)
  //   S2: reviewer verdict=issues → deliver review + activate coder  (gate master,
  //       stop at whenReport verdict / maxFirings, onStop freeze-cluster)
  // The runtime does the clerical work (matching, stop guards, deliveries,
  // message assembly); the master only approves or denies each firing.
  async cmdStartLoop(input: JsonRecord = {}, ctx: JsonRecord) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#host.state().clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const cluster = this.#host.state().clusters[clusterId]
    if (cluster.frozen) {
      throw new Error(`Frozen cluster cannot run a loop: ${clusterId}`)
    }

    if (!cluster.loopPolicy) {
      throw new Error(`Cluster has no LoopPolicy: ${clusterId}`)
    }

    const masterSessionId = cluster.masterSessionId
    if (!masterSessionId || !this.#host.state().sessions[masterSessionId]) {
      throw new Error(`Cluster has no master session: ${clusterId}`)
    }

    const coderSessionId = this.loopCoderSessionId(cluster)
    if (!coderSessionId) {
      throw new Error(`Cluster has no managed worker session: ${clusterId}`)
    }

    if (
      this.#host.loopSubscriptionsForCluster(clusterId).some(
        (subscription) => subscription.state === 'active',
      )
    ) {
      throw new Error(`Cluster loop is already running: ${clusterId}`)
    }

    const ts = now()
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Loop started by user.'

    // The reviewer exists up front (§8.2 subscriptions connect existing
    // nodes; the in-subscription create action lands in a later version).
    const reviewer = await this.#host.cmdCreateSession(
      this.#host.membraneCreateInput(masterSessionId, {
        agent: this.#host.state().sessions[masterSessionId].providerKind,
        label: 'Reviewer',
        cluster: clusterId,
        prompt: this.#host.reviewerBootstrapPrompt(),
        masterReason: 'Loop preset created the reviewer.',
      }),
      ctx,
    )
    const reviewerSessionId = reviewer.sessionId

    const policy = cluster.loopPolicy
    const s1 = this.#host.cmdAuthorSubscription(
      {
        label: 'S1',
        preset: `hero-loop:${clusterId}`,
        sourceSessionId: coderSessionId,
        on: { on: 'finished' },
        targetSessionId: reviewerSessionId,
        action: {
          kind: 'deliver+activate',
          topic: 'diff',
          note: this.#host.reviewerActivationNote(),
        },
        gate: 'master',
        concurrency: 'coalesce',
      },
      ctx,
    )
    const s2 = this.#host.cmdAuthorSubscription(
      {
        label: 'S2',
        preset: `hero-loop:${clusterId}`,
        sourceSessionId: reviewerSessionId,
        on: {
          on: 'report',
          match: { type: 'verdict', verdict: 'issues' },
        },
        targetSessionId: coderSessionId,
        action: {
          kind: 'deliver+activate',
          topic: 'review',
          note: this.#host.coderActivationNote(),
        },
        gate: 'master',
        concurrency: 'coalesce',
        stop: {
          ...(optionalTrimmedString(policy.until?.whenReport?.verdict)
            ? {
                whenReport: {
                  verdict: policy.until.whenReport.verdict,
                },
              }
            : {}),
          maxFirings: policy.maxIterations ?? defaultCycleMaxFirings,
        },
        onStop: 'freeze-cluster',
      },
      ctx,
    )

    cluster.loopState = {
      status: 'running',
      iterations: 0,
      coderSessionId,
      reviewerSessionId,
      lastEvent: { type: 'loop.started', ts },
      reason,
      startedAt: ts,
      stoppedAt: undefined,
    }

    const startedEvent = this.#host.appendKernelEvent(
      'loop.started',
      {
        clusterId,
        coderSessionId,
        reviewerSessionId,
        subscriptionIds: [s1.subscription.id, s2.subscription.id],
      },
      ctx,
      { reason: ctx.reason ?? reason },
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'loop.started',
      clusterId,
      state: this.#host.getState(),
      kernelEventId: startedEvent?.id,
    })

    // Kick the first review: if the coder already finished its work, the
    // loop starts by reviewing the current state (same as the old wakeup).
    const coder = this.#host.state().sessions[coderSessionId]
    if (coder && coder.status === 'idle') {
      const syntheticTrigger = {
        id: startedEvent?.id,
        type: 'loop.started',
        payload: { sessionId: coderSessionId },
      }
      this.#host.enqueueSchedulerWork(
        () =>
          this.#host.createPendingActivation(
            {
              kind: 'pend-activation',
              subscriptionId: s1.subscription.id,
              target: reviewerSessionId,
              action: s1.subscription.action,
              gate: s1.subscription.gate,
              masterSessionId:
                s1.subscription.gate === 'master' ? masterSessionId : undefined,
              triggerEventId: startedEvent?.id,
            },
            syntheticTrigger,
            this.#host.schedulerRuleContext(s1.subscription.id, startedEvent?.id),
          ),
        (error) => {
          console.error(
            `Loop kick failed for ${clusterId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
    }

    return { state: this.#host.getState() }
  }

  stopMasterLoop(input: JsonRecord = {}) {
    return this.cmdStopLoop(input, this.#host.humanCtx())
  }

  stopLoop(input: JsonRecord = {}) {
    return this.cmdStopLoop(input, this.#host.humanCtx())
  }

  cmdStopLoop(input: JsonRecord = {}, ctx: JsonRecord) {
    const loopId = optionalTrimmedString(input.loopId)
    if (loopId) {
      const loop = loopsOf(this.#host.kernelView()).find(
        (candidate) => candidate.loopId === loopId,
      )
      if (!loop) {
        throw new Error(`Unknown loop: ${loopId}`)
      }
      const reason =
        optionalTrimmedString(input.reason) ??
        'Stopped by user from Loop panel.'
      for (const subscriptionId of loop.subscriptionIds) {
        const subscription = this.#host.state().subscriptions?.[subscriptionId]
        if (subscription?.state === 'active') {
          this.#host.cmdStopSubscription({ subscriptionId, reason }, ctx)
        }
      }
      if (input.killRunning === true) {
        for (const sessionId of loop.memberSessionIds) {
          if (this.#host.hasRun(sessionId)) {
            this.#host.cmdKillSession({ sessionId }, ctx)
          }
        }
      }
      return { state: this.#host.getState() }
    }

    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#host.state().clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Loop stopped by user.'
    this.stopClusterLoopSubscriptions(clusterId, reason, ctx)

    if (input.killRunning === true) {
      const cluster = this.#host.state().clusters[clusterId]
      const runningIds = [...cluster.nodeIds, cluster.masterSessionId].filter(
        (sessionId) => this.#host.hasRun(sessionId),
      )
      for (const sessionId of runningIds) {
        this.#host.cmdKillSession({ sessionId }, ctx)
      }
    }

    return { state: this.#host.getState() }
  }

  stopClusterLoopSubscriptions(clusterId, reason, ctx) {
    const active = this.#host.loopSubscriptionsForCluster(clusterId).filter(
      (subscription) => subscription.state === 'active',
    )
    for (const subscription of active) {
      this.#host.cmdStopSubscription(
        { subscriptionId: subscription.id, reason },
        ctx,
      )
    }
    const cluster = this.#host.state().clusters[clusterId]
    if (cluster?.loopState && active.length > 0) {
      cluster.loopState = {
        ...cluster.loopState,
        status: 'stopped',
        lastEvent: { type: 'loop.stopped', ts: now() },
        reason,
        stoppedAt: now(),
      }
      this.#host.appendKernelEvent('loop.stopped', { clusterId }, ctx, { reason })
      this.#host.touch()
      this.#host.broadcast({
        type: 'loop.stopped',
        clusterId,
        reason,
        state: this.#host.getState(),
      })
    }
  }


  cmdFreeze(input: JsonRecord = {}, ctx: JsonRecord) {
    const target =
      typeof input.target === 'string' && input.target.trim().length > 0
        ? input.target.trim()
        : typeof input.targetId === 'string' && input.targetId.trim().length > 0
          ? input.targetId.trim()
          : undefined
    if (!target) {
      throw new Error('freeze target is required')
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Frozen by user.'
    return this.applyFreeze(
      {
        targetId: target,
        reason,
        source: input.source,
        masterReason: input.masterReason,
      },
      ctx,
    )
  }

  cmdUnfreeze(input: JsonRecord = {}, ctx: JsonRecord) {
    const target = optionalTrimmedString(input.target ?? input.targetId)
    if (!target) throw new Error('unfreeze target is required')
    const cluster = this.#host.state().clusters[target]
    const session = this.#host.state().sessions[target]
    if (!cluster && !session) throw new Error(`Unknown unfreeze target: ${target}`)
    if (session) {
      const inheritedCluster = Object.values(this.#host.state().clusters as JsonRecord).find(
        (candidate) =>
          candidate.frozen === true && candidate.nodeIds.includes(session.sessionId),
      )
      if (inheritedCluster) {
        throw new Error(
          `Session ${session.sessionId} inherits freeze from cluster ${inheritedCluster.clusterId}; unfreeze the cluster.`,
        )
      }
    }

    const targetSessionIds = cluster ? [...cluster.nodeIds] : [session.sessionId]
    if (cluster) {
      cluster.frozen = false
      delete cluster.freezeReason
    }
    for (const sessionId of targetSessionIds) {
      const node = this.#host.state().nodes.find((item) => item.sessionId === sessionId)
      if (!node) continue
      node.frozen = false
      delete node.freezeReason
      delete node.masterReason
    }
    const reason = optionalTrimmedString(input.reason) ?? 'Unfrozen by user.'
    const liftedEvent = this.#host.appendKernelEvent(
      'freeze.lifted',
      { targetId: target, targetSessionIds },
      ctx,
      { reason },
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'freeze.lifted',
      targetId: target,
      reason,
      state: this.#host.getState(),
      kernelEventId: liftedEvent?.id,
    })
    return { ok: true, state: this.#host.getState() }
  }


  updateNodeStatus(sessionId, status) {
    const node = this.#host.state().nodes.find((item) => item.sessionId === sessionId)
    if (node) {
      node.status = status
    }
  }

  ensureCluster(clusterId) {
    if (!this.#host.state().clusters[clusterId]) {
      this.#host.state().clusters[clusterId] = {
        clusterId,
        label: clusterId,
        nodeIds: [],
      }
    }

    return this.#host.state().clusters[clusterId]
  }

  addNodeToCluster(sessionId, clusterId) {
    if (typeof clusterId !== 'string' || clusterId.trim().length === 0) {
      return
    }

    const normalizedClusterId = clusterId.trim()
    const cluster = this.ensureCluster(normalizedClusterId)
    if (!cluster.nodeIds.includes(sessionId)) {
      cluster.nodeIds.push(sessionId)
    }
  }

  removeNodeFromOtherClusters(sessionId, clusterId) {
    for (const [candidateId, cluster] of Object.entries(
      this.#host.state().clusters as JsonRecord,
    )) {
      if (candidateId === clusterId) {
        continue
      }
      cluster.nodeIds = cluster.nodeIds.filter((nodeId) => nodeId !== sessionId)
    }
  }

  masterClusterId(sessionId) {
    return Object.values(this.#host.state().clusters as JsonRecord).find(
      (cluster) => cluster.masterSessionId === sessionId,
    )?.clusterId
  }

  managedClusterId(sessionId) {
    return Object.values(this.#host.state().clusters as JsonRecord).find((cluster) =>
      cluster.nodeIds.includes(sessionId),
    )?.clusterId
  }

  managingMasterSessionId(sessionId) {
    const clusterId = this.managedClusterId(sessionId)
    if (!clusterId) {
      return undefined
    }

    const masterSessionId = this.#host.state().clusters[clusterId]?.masterSessionId
    return masterSessionId && this.#host.state().sessions[masterSessionId]
      ? masterSessionId
      : undefined
  }

  isSessionFrozen(sessionId) {
    const node = this.#host.state().nodes.find((item) => item.sessionId === sessionId)
    const clusterId = this.managedClusterId(sessionId)
    return (
      node?.frozen === true || this.#host.state().clusters[clusterId]?.frozen === true
    )
  }

  syncSessionRoleAndCluster(sessionId) {
    const session = this.#host.state().sessions[sessionId]
    const node = this.#host.state().nodes.find((item) => item.sessionId === sessionId)
    if (!session || !node) {
      return
    }

    const masterClusterId = this.masterClusterId(sessionId)
    if (masterClusterId) {
      session.role = 'master'
      node.role = 'master'
      node.clusterId = masterClusterId
      session.updatedAt = now()
      return
    }

    session.role = 'worker'
    node.role = 'worker'
    node.clusterId = this.managedClusterId(sessionId)
    session.updatedAt = now()
  }

  normalizeClusterNodeIds(nodeIds) {
    if (!Array.isArray(nodeIds)) {
      return []
    }

    const seen = new Set()
    const normalized = []
    for (const nodeId of nodeIds) {
      if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
        continue
      }

      const sessionId = nodeId.trim()
      if (seen.has(sessionId)) {
        continue
      }

      const session = this.#host.state().sessions[sessionId]
      if (!session || session.role === 'master') {
        continue
      }

      seen.add(sessionId)
      normalized.push(sessionId)
    }

    return normalized
  }

  assignMaster(clusterId, sessionId, ctx: JsonRecord = undefined) {
    const cluster = this.ensureCluster(clusterId)
    const session = this.#host.state().sessions[sessionId]
    const node = this.#host.state().nodes.find((item) => item.sessionId === sessionId)

    if (!session || !node) {
      throw new Error(`Unknown master session: ${sessionId}`)
    }

    const alreadyAssigned = cluster.masterSessionId === sessionId

    const staleMasterIds = new Set()
    if (cluster.masterSessionId && cluster.masterSessionId !== sessionId) {
      staleMasterIds.add(cluster.masterSessionId)
    }

    for (const [candidateClusterId, candidateCluster] of Object.entries(
      this.#host.state().clusters as JsonRecord,
    )) {
      candidateCluster.nodeIds = candidateCluster.nodeIds.filter(
        (nodeId) => nodeId !== sessionId,
      )

      if (
        candidateClusterId !== clusterId &&
        candidateCluster.masterSessionId === sessionId
      ) {
        delete candidateCluster.masterSessionId
      }
    }

    for (const candidateNode of this.#host.state().nodes) {
      if (
        candidateNode.clusterId === clusterId &&
        candidateNode.role === 'master' &&
        candidateNode.sessionId !== sessionId
      ) {
        staleMasterIds.add(candidateNode.sessionId)
      }
    }

    cluster.masterSessionId = sessionId
    cluster.nodeIds = cluster.nodeIds.filter((nodeId) => nodeId !== sessionId)
    session.role = 'master'
    session.updatedAt = now()
    node.role = 'master'
    node.clusterId = clusterId

    for (const staleMasterId of staleMasterIds) {
      this.syncSessionRoleAndCluster(staleMasterId)
    }

    if (!alreadyAssigned) {
      this.#host.appendKernelEvent(
        'role.assigned',
        { clusterId, masterSessionId: sessionId },
        ctx ?? { actor: { kind: 'runtime' } },
      )
    }
  }

  loopCoderSessionId(cluster) {
    const existing = cluster.loopState?.coderSessionId
    if (
      existing &&
      cluster.nodeIds.includes(existing) &&
      this.#host.state().sessions[existing]
    ) {
      return existing
    }

    return cluster.nodeIds.find((sessionId) => {
      const session = this.#host.state().sessions[sessionId]
      return session && session.role !== 'master'
    })
  }

  applyFreeze(
    { targetId, reason, source, masterReason }: JsonRecord,
    ctx: JsonRecord,
  ) {
    const cluster = this.#host.state().clusters[targetId]
    const session = this.#host.state().sessions[targetId]
    const sourceSessionId =
      typeof source === 'string' && this.#host.state().sessions[source]
        ? source
        : undefined
    const finalReason = reason ?? masterReason ?? 'Frozen.'

    let targetSessionIds = []
    if (cluster) {
      cluster.frozen = true
      cluster.freezeReason = finalReason
      this.stopClusterLoopSubscriptions(cluster.clusterId, finalReason, ctx)
      targetSessionIds = [...cluster.nodeIds]
    } else if (session) {
      targetSessionIds = [session.sessionId]
      const clusterId =
        this.managedClusterId(session.sessionId) ??
        this.masterClusterId(session.sessionId)
      if (clusterId) {
        this.stopClusterLoopSubscriptions(clusterId, finalReason, ctx)
      }
    } else {
      throw new Error(`Unknown freeze target: ${targetId}`)
    }

    const envelope = sourceSessionId
      ? this.#host.createEnvelope(sourceSessionId)
      : undefined
    for (const targetSessionId of targetSessionIds) {
      const node = this.#host.state().nodes.find(
        (item) => item.sessionId === targetSessionId,
      )
      if (node) {
        node.frozen = true
        node.freezeReason = finalReason
        node.masterReason =
          typeof masterReason === 'string' && masterReason.trim().length > 0
            ? masterReason.trim()
            : node.masterReason
      }

      if (envelope && this.#host.state().sessions[targetSessionId]) {
        this.#host.addEdge({
          source: sourceSessionId,
          target: targetSessionId,
          kind: 'freeze',
          envelope: { ...envelope, callId: randomUUID() },
          label: 'freeze',
          frozen: true,
          freezeReason: finalReason,
          masterReason,
        })
      }
    }

    this.#host.appendKernelEvent(
      'freeze.applied',
      { targetId, targetSessionIds, sourceSessionId },
      ctx,
      { reason: finalReason },
    )
    this.#host.touch()
    this.#host.broadcast({
      type: 'freeze.applied',
      targetId,
      reason: finalReason,
      state: this.#host.getState(),
    })
    return { ok: true, state: this.#host.getState() }
  }

}
