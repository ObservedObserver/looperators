// The runtime's single command authority. Keep this causal chain together:
// serialize -> validate/replay -> journal -> run handler -> atomic commit ->
// publish -> post-commit effects -> durable outbox -> scheduler drains.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { validateExecutionEnvelope } from '../../../shared/execution-envelope.js'
import type { KernelActor } from '../../../shared/graph-core/index.js'
import { ContextChannelStore } from '../contextChannel.js'
import {
  ControlVersionConflictError,
  KernelStore,
  kernelActorKinds,
} from '../kernelStore.js'
import {
  clone,
  isObject,
  now,
  optionalTrimmedString,
  type JsonRecord,
} from '../runtimeCommon.js'
import {
  commandRegistryEntry,
  type KernelCommandRegistry,
} from './commandRegistry.js'
import type {
  AutonomousLifecycleEpochs,
  ControlTransaction,
  PostCommitEffect,
} from './controlTransaction.js'

type RunHandle = { kill: () => unknown }

export type RecoveryControlCommand = {
  commandId: string
  idempotencyKey: string
  kind: string
  execute: (ctx: JsonRecord) => JsonRecord | undefined
}

export type CommandExecutorHost = {
  getState: () => JsonRecord
  setState: (state: JsonRecord) => void
  getPublicState: () => JsonRecord
  getRuns: () => Map<string, RunHandle>
  getRunContext: () => Map<string, JsonRecord>
  getWorkflowCompensatedRuns: () => Set<string>
  automaticDeploymentExistingSessionIds: (
    kind: string,
    input: JsonRecord,
  ) => string[]
  captureWorkflowSession: (sessionId: string) => JsonRecord
  discardWorkflowSession: (sessionId: string) => void
  workflowDeploymentCrashAfterStage: () => string | undefined
  reviveAutonomousDrains: () => AutonomousLifecycleEpochs
  onAuthorizedCommandCommitted: (
    actor: KernelActor,
    lifecycleEpochs: AutonomousLifecycleEpochs | undefined,
  ) => void
  onControlKernelEvent: (event: JsonRecord) => void
  onEffectKernelEvent: (event: JsonRecord) => void
  drainWorkflowWakeups: () => void
  drainApprovedSlots: () => Promise<unknown>
  emitRuntimeEvent?: (event: JsonRecord) => void
}

export type CommandExecutorOptions = {
  kernelStore: KernelStore
  channelStore: ContextChannelStore
  registry: KernelCommandRegistry
  host: CommandExecutorHost
  snapshotPersistDelayMs?: number
  crashBeforeEffectDrain?: boolean
  commitDelayMs?: number
}

export class CommandExecutor {
  #kernelStore: KernelStore
  #channelStore: ContextChannelStore
  #registry: KernelCommandRegistry
  #host: CommandExecutorHost
  #context = new AsyncLocalStorage<ControlTransaction>()
  #chain: Promise<void> = Promise.resolve()
  #committedStateDuringCommand: JsonRecord | undefined
  #snapshotPersistTimer: ReturnType<typeof setTimeout> | undefined
  #snapshotPersistDelayMs: number
  #crashBeforeEffectDrain: boolean
  #commitDelayMs: number

  constructor({
    kernelStore,
    channelStore,
    registry,
    host,
    snapshotPersistDelayMs = 750,
    crashBeforeEffectDrain = false,
    commitDelayMs = 0,
  }: CommandExecutorOptions) {
    this.#kernelStore = kernelStore
    this.#channelStore = channelStore
    this.#registry = registry
    this.#host = host
    this.#snapshotPersistDelayMs = snapshotPersistDelayMs
    this.#crashBeforeEffectDrain = crashBeforeEffectDrain
    this.#commitDelayMs = commitDelayMs
  }

  get context() {
    return this.#context
  }

  get committedStateDuringCommand() {
    return this.#committedStateDuringCommand
  }

  currentTransaction() {
    const transaction = this.#context.getStore()
    return transaction && transaction.closed !== true
      ? transaction
      : undefined
  }

  readState() {
    return this.currentTransaction()
      ? this.#host.getState()
      : (this.#committedStateDuringCommand ?? this.#host.getState())
  }

  async dispatch(command: JsonRecord = {}): Promise<any> {
    const actorKind = command?.actor?.kind
    // Preserve the manager's reusable-runtime contract for every command
    // plane (human, master, agent, and rule). The captured lifecycle epoch
    // still prevents work submitted before killAll from reviving controllers
    // after that shutdown boundary.
    const lifecycleEpochs =
      actorKind && actorKind !== 'runtime'
        ? this.#host.reviveAutonomousDrains()
        : undefined
    const run = this.#chain.then(() => this.#dispatch(command, lifecycleEpochs))
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #dispatch(
    command: JsonRecord = {},
    lifecycleEpochs?: AutonomousLifecycleEpochs,
  ): Promise<any> {
    const kind = optionalTrimmedString(command.kind)
    const commandEntry = commandRegistryEntry(this.#registry, kind)
    if (!kind || !commandEntry) {
      throw new Error(`Unknown kernel command: ${kind ?? ''}`)
    }

    const actor = isObject(command.actor) ? command.actor : undefined
    if (!actor || !kernelActorKinds.has(actor.kind)) {
      throw new Error(
        `Kernel command requires a valid actor: ${JSON.stringify(command.actor)}`,
      )
    }
    if (
      (actor.kind === 'master' || actor.kind === 'agent') &&
      !this.#host.getState().sessions[optionalTrimmedString(actor.ref) ?? '']
    ) {
      throw new Error(
        `Kernel command actor session is unknown: ${actor.ref ?? ''}`,
      )
    }

    if (
      command.execution !== undefined &&
      !validateExecutionEnvelope(command.execution)
    ) {
      throw new Error(
        'Kernel command execution must be a valid ExecutionEnvelope.',
      )
    }
    const ctx = {
      actor: {
        kind: actor.kind,
        ref: optionalTrimmedString(actor.ref),
      },
      causeId: optionalTrimmedString(command.causeId),
      reason: optionalTrimmedString(command.reason),
      ...(validateExecutionEnvelope(command.execution)
        ? { execution: clone(command.execution) }
        : {}),
    }
    const input = isObject(command.input) ? command.input : {}
    const commandId = optionalTrimmedString(command.commandId) ?? randomUUID()
    const idempotencyKey = optionalTrimmedString(command.idempotencyKey)
    const expectedVersion = Number.isInteger(command.expectedVersion)
      ? Number(command.expectedVersion)
      : undefined
    const duplicate = this.#kernelStore.getCommandRecord({
      commandId,
      idempotencyKey,
    })
    if (duplicate) {
      const sameActor =
        duplicate.actor?.kind === ctx.actor.kind &&
        (duplicate.actor?.ref ?? undefined) === (ctx.actor.ref ?? undefined)
      const sameExecution =
        JSON.stringify(duplicate.execution ?? null) ===
        JSON.stringify(ctx.execution ?? null)
      if (duplicate.kind !== kind || !sameActor || !sameExecution) {
        throw new Error(
          `Command replay identity mismatch: ${duplicate.commandId} belongs to ${duplicate.actor?.kind}${duplicate.actor?.ref ? `:${duplicate.actor.ref}` : ''} ${duplicate.kind} with its original execution correlation.`,
        )
      }
      this.drainDurableEffects()
      this.#runAuthorizedCommandCommitEffect(ctx.actor, lifecycleEpochs)
      return clone(duplicate.result)
    }
    const currentVersion = this.#kernelStore.getControlVersion()
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new ControlVersionConflictError(expectedVersion, currentVersion)
    }
    const durableCommand = {
      commandId,
      idempotencyKey,
      kind,
      actor: ctx.actor,
      expectedVersion,
      ...(ctx.execution ? { execution: clone(ctx.execution) } : {}),
      ...(commandEntry.affectsControlVersion === false
        ? { affectsControlVersion: false }
        : {}),
    }

    let automaticDeploymentId
    if (commandEntry.automaticallyJournaledWorkflow === true) {
      const previous =
        this.#kernelStore.getWorkflowDeploymentByCommandId(commandId)
      if (previous && previous.status !== 'aborted') {
        throw new Error(
          `Workflow command ${commandId} previously ${previous.status} at ${previous.stage}.`,
        )
      }
      automaticDeploymentId =
        previous?.deploymentId ?? `deployment-${commandId}`
      const existingSessionCheckpoints = Object.fromEntries(
        this.#host
          .automaticDeploymentExistingSessionIds(kind, input)
          .filter((sessionId) => this.#host.getState().sessions[sessionId])
          .map((sessionId) => [
            sessionId,
            this.#host.captureWorkflowSession(sessionId),
          ]),
      )
      if (previous) {
        this.#kernelStore.updateWorkflowDeployment(automaticDeploymentId, {
          stage: 'prepared',
          status: 'in_progress',
          journal: { kind, existingSessionCheckpoints, retriedAt: now() },
        })
      } else {
        this.#kernelStore.createWorkflowDeployment({
          deploymentId: automaticDeploymentId,
          workflowId: `workflow-${commandId}`,
          commandId,
          stage: 'prepared',
          journal: { kind, existingSessionCheckpoints },
        })
      }
      if (this.#host.workflowDeploymentCrashAfterStage() === 'prepared') {
        const error = new Error(
          'Injected workflow deployment crash after prepared.',
        )
        ;(error as Error & { code?: string }).code = 'ORRERY_DEPLOYMENT_CRASH'
        throw error
      }
    }

    const checkpoint = clone(this.#host.getState())
    this.#committedStateDuringCommand = checkpoint
    const transaction = this.#newTransaction({
      commandId,
      idempotencyKey,
      kind,
      actor: ctx.actor,
      expectedVersion,
      automaticDeploymentId,
      lifecycleEpochs,
    })

    try {
      const result = await this.#context.run(transaction, () =>
        commandEntry.handler(input, ctx),
      )
      if (automaticDeploymentId) {
        const durableResult = isObject(result)
          ? Object.fromEntries(
              Object.entries(result).filter(([key]) => key !== 'state'),
            )
          : {}
        transaction.deploymentFinalizations.push({
          deploymentId: automaticDeploymentId,
          stage: 'active',
          status: 'completed',
          journal: { activatedAt: now(), result: durableResult },
        })
      }
      if (this.#commitDelayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.#commitDelayMs),
        )
      }
      const committed = this.#kernelStore.commitControlCommand({
        state: this.#host.getState(),
        events: transaction.events,
        command: durableCommand,
        result: isObject(result) ? result : { value: result },
        deploymentFinalizations: transaction.deploymentFinalizations,
        outboxEffects: transaction.outboxEffects,
      })
      this.#clearSnapshotPersistTimer()
      transaction.closed = true
      this.#host.getState().controlVersion =
        committed.record.committedVersion
      this.#committedStateDuringCommand = undefined
      this.#publishCommittedEvents(committed.events)
      this.#runPostCommitEffects(transaction.postCommitEffects)
      this.#publishDeferredBroadcasts(transaction.broadcasts)
      if (
        transaction.outboxEffects.length > 0 &&
        this.#crashBeforeEffectDrain
      ) {
        const error = new Error(
          'Injected control crash before durable effect drain.',
        )
        ;(error as Error & { code?: string }).code =
          'ORRERY_EFFECT_DRAIN_CRASH'
        throw error
      }
      this.drainDurableEffects()
      this.#runAuthorizedCommandCommitEffect(ctx.actor, lifecycleEpochs)
      queueMicrotask(() => this.#host.drainWorkflowWakeups())
      if (commandEntry.drainApprovedSlotsAfterCommit === true) {
        queueMicrotask(() => {
          void this.#host.drainApprovedSlots()
        })
      }
      return clone(committed.record.result)
    } catch (error) {
      transaction.closed = true
      if (
        (error as Error & { code?: string })?.code ===
        'ORRERY_EFFECT_DRAIN_CRASH'
      ) {
        throw error
      }
      if (
        (error as Error & { code?: string })?.code ===
        'ORRERY_DEPLOYMENT_CRASH'
      ) {
        this.#committedStateDuringCommand = undefined
        throw error
      }
      if ((error as Error & { commitState?: boolean })?.commitState === true) {
        const failureFinalizations = automaticDeploymentId
          ? [
              {
                deploymentId: automaticDeploymentId,
                stage: 'failed',
                status: 'completed',
                journal: {
                  failedAt: now(),
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
              },
            ]
          : []
        const committed = this.#kernelStore.commitControlCommand({
          state: this.#host.getState(),
          events: transaction.events,
          command: durableCommand,
          result: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          deploymentFinalizations: failureFinalizations,
        })
        this.#clearSnapshotPersistTimer()
        this.#host.getState().controlVersion =
          committed.record.committedVersion
        this.#committedStateDuringCommand = undefined
        this.#publishCommittedEvents(committed.events)
        this.#runPostCommitEffects(transaction.postCommitEffects)
        this.#publishDeferredBroadcasts(transaction.broadcasts)
        this.#runAuthorizedCommandCommitEffect(ctx.actor, lifecycleEpochs)
        queueMicrotask(() => this.#host.drainWorkflowWakeups())
        throw error
      }
      this.#compensateFailedControlCommand(transaction, checkpoint)
      if (automaticDeploymentId) {
        try {
          this.#kernelStore.updateWorkflowDeployment(automaticDeploymentId, {
            stage: 'aborted',
            status: 'aborted',
            journal: {
              abortedAt: now(),
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        } catch {
          // A new owner will reconcile the still-in-progress journal.
        }
      }
      for (const finalization of transaction.deploymentFinalizations) {
        if (finalization.deploymentId === automaticDeploymentId) continue
        try {
          this.#kernelStore.updateWorkflowDeployment(
            finalization.deploymentId,
            {
              stage: 'aborted',
              status: 'aborted',
              journal: {
                abortedAt: now(),
                reason:
                  error instanceof Error ? error.message : String(error),
              },
            },
          )
        } catch {
          // A new owner will reconcile an in-progress deployment.
        }
      }
      this.#host.setState(checkpoint)
      this.#committedStateDuringCommand = undefined
      throw error
    }
  }

  dispatchRecoveryCommandSync({
    commandId,
    idempotencyKey,
    kind,
    execute,
  }: RecoveryControlCommand) {
    const duplicate = this.#kernelStore.getCommandRecord({
      commandId,
      idempotencyKey,
    })
    if (duplicate) return clone(duplicate.result)
    const checkpoint = clone(this.#host.getState())
    this.#committedStateDuringCommand = checkpoint
    const actor = { kind: 'runtime' as const }
    const ctx = { actor }
    const transaction = this.#newTransaction({
      commandId,
      idempotencyKey,
      kind,
      actor,
    })
    try {
      const result =
        this.#context.run(transaction, () => execute(ctx)) ?? {}
      const committed = this.#kernelStore.commitControlCommand({
        state: this.#host.getState(),
        events: transaction.events,
        command: { commandId, idempotencyKey, kind, actor },
        result,
      })
      this.#clearSnapshotPersistTimer()
      transaction.closed = true
      this.#host.getState().controlVersion =
        committed.record.committedVersion
      this.#committedStateDuringCommand = undefined
      this.#publishCommittedEvents(committed.events)
      this.#runPostCommitEffects(transaction.postCommitEffects)
      this.#publishDeferredBroadcasts(transaction.broadcasts)
      queueMicrotask(() => this.#host.drainWorkflowWakeups())
      return clone(committed.record.result)
    } catch (error) {
      transaction.closed = true
      this.#compensateFailedControlCommand(transaction, checkpoint)
      this.#host.setState(checkpoint)
      this.#committedStateDuringCommand = undefined
      throw error
    }
  }

  #newTransaction({
    commandId,
    idempotencyKey,
    kind,
    actor,
    expectedVersion,
    automaticDeploymentId,
    lifecycleEpochs,
  }: {
    commandId: string
    idempotencyKey?: string
    kind: string
    actor: KernelActor
    expectedVersion?: number
    automaticDeploymentId?: string
    lifecycleEpochs?: AutonomousLifecycleEpochs
  }): ControlTransaction {
    return {
      commandId,
      idempotencyKey,
      kind,
      actor,
      expectedVersion,
      lifecycleEpochs,
      events: [],
      broadcasts: [],
      channelCheckpoints: new Map(),
      runSessionIdsBefore: new Set(this.#host.getRuns().keys()),
      deploymentFinalizations: [],
      outboxEffects: [],
      postCommitEffects: [],
      workflowDeploymentIds: new Set(),
      automaticDeploymentId,
      baseEventSeq: this.#kernelStore.latestSeq(),
      closed: false,
    }
  }

  stagePostCommitEffect(effect: PostCommitEffect) {
    const transaction = this.currentTransaction()
    if (!transaction) {
      effect.run()
      return
    }
    transaction.postCommitEffects.push(effect)
  }

  #runPostCommitEffects(effects: PostCommitEffect[]) {
    for (const effect of effects) {
      try {
        effect.run()
      } catch (error) {
        // The state/event transaction is already committed. Process-local
        // controllers reconcile from durable state on restart, so an effect
        // failure is operational diagnostics, never a false rollback.
        console.error(
          `Post-commit effect failed (${effect.label}): ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  #runAuthorizedCommandCommitEffect(
    actor: KernelActor,
    lifecycleEpochs: AutonomousLifecycleEpochs | undefined,
  ) {
    try {
      this.#host.onAuthorizedCommandCommitted(actor, lifecycleEpochs)
    } catch (error) {
      // This process-local reconciliation happens after the durable command
      // commit. It must never turn a committed result into a false rollback.
      console.error(
        `Post-commit controller reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  appendKernelEvent(
    type: string,
    payload: JsonRecord,
    ctx: JsonRecord,
    { reason }: JsonRecord = {},
  ) {
    const eventPayload =
      ctx?.execution && !payload?.execution
        ? { ...payload, execution: clone(ctx.execution) }
        : payload
    const transaction = this.currentTransaction()
    if (transaction) {
      const event = {
        id: randomUUID(),
        ts: now(),
        type,
        actor: ctx?.actor ?? { kind: 'runtime' },
        causeId: ctx?.causeId,
        reason: reason ?? ctx?.reason,
        payload: eventPayload,
      }
      transaction.events.push(event)
      return {
        seq: transaction.baseEventSeq + transaction.events.length,
        ...event,
      }
    }
    const event = this.#kernelStore.appendEvent({
      type,
      actor: ctx?.actor ?? { kind: 'runtime' },
      causeId: ctx?.causeId,
      reason: reason ?? ctx?.reason,
      payload: eventPayload,
    })
    if (event) {
      this.#emit({ type: 'kernel.event', event })
      this.#host.onControlKernelEvent(event)
      queueMicrotask(() => this.#host.drainWorkflowWakeups())
    }
    return event
  }

  broadcast(event: JsonRecord) {
    const transaction = this.currentTransaction()
    if (transaction) {
      transaction.broadcasts.push(event)
      return
    }
    this.#emit(event)
  }

  #emit(event: JsonRecord) {
    try {
      this.#host.emitRuntimeEvent?.(event)
    } catch (error) {
      // Host observers are outside the command transaction. A renderer/SSE
      // notification failure must never turn a committed mutation into a
      // thrown command (or strand resources before compensation can see ids).
      console.error(
        `Runtime event broadcast failed (${event?.type ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  #publishCommittedEvents(events: JsonRecord[]) {
    for (const event of events) {
      this.#emit({ type: 'kernel.event', event })
      this.#host.onControlKernelEvent(event)
    }
  }

  #publishDeferredBroadcasts(broadcasts: JsonRecord[]) {
    for (const deferred of broadcasts) {
      this.#emit(
        isObject(deferred) && 'state' in deferred
          ? { ...deferred, state: this.#host.getPublicState() }
          : deferred,
      )
    }
  }

  checkpointChannelMutation(sessionId: string) {
    const transaction = this.currentTransaction()
    if (!transaction || transaction.channelCheckpoints.has(sessionId)) return
    const checkpoint = this.#channelStore.checkpoint(sessionId)
    transaction.channelCheckpoints.set(sessionId, checkpoint)
    if (transaction.automaticDeploymentId) {
      const deployment = this.#kernelStore.getWorkflowDeployment(
        transaction.automaticDeploymentId,
      )
      if (deployment?.status === 'in_progress') {
        this.#kernelStore.updateWorkflowDeployment(
          transaction.automaticDeploymentId,
          {
            journal: {
              channelCheckpoints: {
                ...(deployment.journal?.channelCheckpoints ?? {}),
                [sessionId]: checkpoint,
              },
            },
          },
        )
      }
    }
  }

  drainDurableEffects() {
    for (const effect of this.#kernelStore.listPendingEffects()) {
      if (effect.kind === 'council-artifact-write') {
        try {
          this.#channelStore.writeArtifact(
            effect.payload.workflowId,
            effect.payload.artifactId,
            effect.payload.content,
          )
          const completedEvent = this.#kernelStore.completeEffectWithEvent(
            effect.effectId,
            {
              type: 'council.artifact.materialized',
              actor: { kind: 'runtime' },
              payload: {
                effectId: effect.effectId,
                commandId: effect.commandId,
                workflowId: effect.payload.workflowId,
                artifactId: effect.payload.artifactId,
                ...(validateExecutionEnvelope(effect.payload.execution)
                  ? { execution: clone(effect.payload.execution) }
                  : {}),
              },
            },
          )
          if (completedEvent) {
            this.#emit({ type: 'kernel.event', event: completedEvent })
            this.#host.onEffectKernelEvent(completedEvent)
          }
        } catch (error) {
          console.error(
            `Durable Council artifact ${effect.effectId} remains replayable: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        continue
      }
      if (effect.kind !== 'channel-cleanup') {
        console.error(`Unknown durable effect kind: ${effect.kind}`)
        continue
      }
      const sessionIds = Array.isArray(effect.payload.sessionIds)
        ? effect.payload.sessionIds
        : []
      const policy = isObject(effect.payload.policy)
        ? effect.payload.policy
        : {}
      try {
        const results = sessionIds.map((sessionId) =>
          this.#channelStore.cleanup(sessionId, policy),
        )
        const completedEvent = this.#kernelStore.completeEffectWithEvent(
          effect.effectId,
          {
            type: 'channel.cleanup.completed',
            actor: { kind: 'runtime' },
            payload: {
              effectId: effect.effectId,
              commandId: effect.commandId,
              sessionIds,
              removedDeliveries: results.reduce(
                (sum, result) => sum + result.removedDeliveries,
                0,
              ),
            },
          },
        )
        if (completedEvent) {
          this.#emit({ type: 'kernel.event', event: completedEvent })
          this.#host.onEffectKernelEvent(completedEvent)
        }
      } catch (error) {
        console.error(
          `Durable effect ${effect.effectId} could not commit completion and remains replayable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  #compensateFailedControlCommand(
    transaction: ControlTransaction,
    checkpoint: JsonRecord,
  ) {
    const runs = this.#host.getRuns()
    const runContext = this.#host.getRunContext()
    for (const [sessionId, run] of runs) {
      if (transaction.runSessionIdsBefore.has(sessionId)) continue
      this.#host.getWorkflowCompensatedRuns().add(sessionId)
      runs.delete(sessionId)
      runContext.delete(sessionId)
      try {
        run.kill()
      } catch {
        // Best-effort Saga compensation; state/channel restoration continues.
      }
    }

    const checkpointSessionIds = new Set(
      Object.keys(checkpoint.sessions ?? {}),
    )
    for (const sessionId of Object.keys(
      this.#host.getState().sessions ?? {},
    )) {
      if (!checkpointSessionIds.has(sessionId)) {
        this.#host.discardWorkflowSession(sessionId)
      }
    }
    for (const [sessionId, channelCheckpoint] of
      transaction.channelCheckpoints) {
      this.#channelStore.restore(sessionId, channelCheckpoint)
    }
  }

  touch() {
    this.#host.getState().updatedAt = now()
    if (this.currentTransaction()) return
    this.persistState()
  }

  touchDeferred() {
    this.#host.getState().updatedAt = now()
    if (this.currentTransaction() || this.#snapshotPersistTimer) return
    this.#snapshotPersistTimer = setTimeout(() => {
      this.#snapshotPersistTimer = undefined
      this.persistState()
    }, this.#snapshotPersistDelayMs)
    this.#snapshotPersistTimer.unref?.()
  }

  persistState() {
    this.#clearSnapshotPersistTimer()
    this.#kernelStore.saveSnapshot(this.#host.getState())
  }

  #clearSnapshotPersistTimer() {
    if (!this.#snapshotPersistTimer) return
    clearTimeout(this.#snapshotPersistTimer)
    this.#snapshotPersistTimer = undefined
  }
}
