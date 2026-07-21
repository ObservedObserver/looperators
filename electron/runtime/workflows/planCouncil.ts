// Plan Council orchestration: phase machine, artifact materialization,
// cross-review/synthesis fan-out, participant retry, council patch commit.
// Split out of sessionManager.ts; kernel access goes through WorkflowKernel.
import path from 'node:path'
import {
  executionCorrelationKey,
  validateExecutionEnvelope,
} from '../../../shared/execution-envelope.js'
import {
  crossReviewPrompt,
  plannerPrompt,
  synthesizerPrompt,
  validatePlanCouncilStart,
} from '../../../shared/plan-council.js'
import {
  clone,
  nonEmptyString,
  now,
  optionalTrimmedString,
  planCouncilArtifactMaxBytes,
  truncateForLog,
  type JsonRecord,
} from '../runtimeCommon.js'
import {
  createHash,
  randomUUID,
} from 'node:crypto'
import type { WorkflowKernel } from './workflowKernel.js'
import {
  advanceWorkflowDeployment,
  planCouncilHistory,
} from './classicWorkflows.js'
import {
  discardWorkflowSession,
  settleProviderStart,
  workflowResourceDescriptors,
} from './workflowShared.js'

export function setPlanCouncilPhase(m: WorkflowKernel, council, phase, summary) {
  council.phase = phase
  planCouncilHistory(m, council, 'phase-changed', summary)
}

export function nextCouncilBarrierGeneration(m: WorkflowKernel, council: JsonRecord, phaseId: string) {
  return Object.values(m.state.barriers ?? {}).filter(
    (barrier: JsonRecord) =>
      barrier.runId === council.runId && barrier.phaseId === phaseId,
  ).length + 1
}

export function maybeAdvancePlanCouncil(m: WorkflowKernel, council: JsonRecord, gate: 'crossReview' | 'synthesis') {
  const policy = council.advancement?.[gate] ?? 'human'
  if (policy === 'auto') {
    const kind = gate === 'crossReview'
      ? 'start_plan_council_cross_review'
      : 'start_plan_council_synthesis'
    const generation = nextCouncilBarrierGeneration(m, 
      council,
      gate === 'crossReview' ? 'peer-review' : 'synthesis',
    )
    queueMicrotask(() => {
      void m.dispatchCommand({
        commandId: `council-auto-${council.runId}-${gate}-g${generation}`,
        idempotencyKey: `council-auto:${council.runId}:${gate}:g${generation}`,
        kind,
        actor: { kind: 'runtime' },
        input: { workflowId: council.workflowId },
      }).catch((error) => failPlanCouncil(m, council, `Automatic ${gate} advancement failed: ${error instanceof Error ? error.message : String(error)}`))
    })
  } else if (policy === 'master') {
    m.appendKernelEvent('workflow.milestone', {
      workflowId: council.workflowId,
      runId: council.runId,
      milestone: gate === 'crossReview' ? 'council-proposals-ready' : 'council-reviews-ready',
      summary: `Plan Council ${council.workflowId} ${gate} phase is ready for Master judgment.`,
    }, { actor: { kind: 'runtime' } })
  }
}

export function cancelPendingCouncilBarriers(m: WorkflowKernel, council: JsonRecord, reason: string, causeId?: string) {
  for (const barrierId of Object.values(council.barrierIds ?? {}) as string[]) {
    if (m.state.barriers?.[barrierId]?.status !== 'pending') continue
    m.cmdCancelBarrier(
      { barrierId, reason },
      { actor: { kind: 'runtime' }, causeId },
    )
  }
}

export function failPlanCouncil(m: WorkflowKernel, council, message, causeId?: string) {
  if (!council || ['completed', 'stopped', 'failed'].includes(council.phase)) {
    return
  }
  if (council.phase === 'blocked' && /Resource budget exhausted:/i.test(String(message ?? ''))) return
  if (council.phase === 'blocked') {
    council.phase = council.blockedFromPhase ?? council.phase
    delete council.blockedAt
    delete council.blockedFromPhase
    delete council.blockedParticipantId
    delete council.blockedParticipantIds
    delete council.blockReason
    delete council.blockKind
  }
  council.failure = String(message ?? 'Plan Council failed.')
  cancelPendingCouncilBarriers(m, council, council.failure, causeId)
  setPlanCouncilPhase(m, council, 'failed', council.failure)
  m.appendKernelEvent(
    'council.failed',
    {
      workflowId: council.workflowId,
      runId: council.runId,
      error: truncateForLog(council.failure, 400),
    },
    { actor: { kind: 'runtime' }, causeId },
  )
  m.touch()
  m.broadcast({
    type: 'plan-council.updated',
    workflowId: council.workflowId,
    state: m.getState(),
  })
}

export function reconcileInterruptedPlanCouncils(m: WorkflowKernel, interruptedSessionIds: Set<string>) {
  if (interruptedSessionIds.size === 0) return
  for (const council of Object.values(m.state.planCouncils ?? {}) as JsonRecord[]) {
    if (['completed', 'stopped', 'failed'].includes(council.phase)) continue
    const participant = council.participantOrder
      ?.map((sessionId) => council.participants?.[sessionId])
      .find(
        (candidate) =>
          candidate?.expectedTurnId &&
          interruptedSessionIds.has(candidate.sessionId),
      )
    if (!participant) continue
    failPlanCouncil(m, 
      council,
      `${participant.label} was interrupted by runtime restart; restart this Plan Council from a new run.`,
    )
  }
}

export function planCouncilForSession(m: WorkflowKernel, sessionId: string) {
  return Object.values(m.state.planCouncils ?? {}).find(
    (council: JsonRecord) => council.participants?.[sessionId],
  ) as JsonRecord | undefined
}

export function completedAssistantContent(m: WorkflowKernel, sessionId: string, expectedTurnId: string) {
  const session = m.state.sessions[sessionId]
  const message = [...(session?.messages ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.role === 'assistant' &&
        candidate.status === 'complete' &&
        candidate.runId === expectedTurnId &&
        nonEmptyString(candidate.content),
    )
  return optionalTrimmedString(message?.content)
}

export function materializePlanCouncilArtifact(
  m: WorkflowKernel,
  council: JsonRecord,
  participant: JsonRecord,
  kind: 'proposal' | 'peer-review' | 'synthesis',
  expectedTurnId: string,
  causeId?: string,
) {
  const content = completedAssistantContent(m, 
    participant.sessionId,
    expectedTurnId,
  )
  if (!content) {
    throw new Error(
      `${participant.label} finished without a readable ${kind} response.`,
    )
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8')
  if (sizeBytes > planCouncilArtifactMaxBytes) {
    throw new Error(
      `${participant.label} produced a ${kind} artifact of ${sizeBytes} bytes; the Plan Council limit is ${planCouncilArtifactMaxBytes} bytes.`,
    )
  }
  const artifactId = `council-${kind}-${randomUUID()}`
  const execution = validateExecutionEnvelope(participant.expectedExecutionEnvelope)
    ? clone(participant.expectedExecutionEnvelope)
    : undefined
  const transaction = m.controlCommandContext.getStore()
  const contentRef = m.channelStore.artifactRef(council.workflowId, artifactId)
  if (transaction && transaction.closed !== true) {
    transaction.outboxEffects.push({
      effectId: `council-artifact:${artifactId}`,
      kind: 'council-artifact-write',
      payload: {
        workflowId: council.workflowId,
        artifactId,
        content,
        ...(execution ? { execution: clone(execution) } : {}),
      },
    })
  } else {
    m.channelStore.writeArtifact(council.workflowId, artifactId, content)
  }
  const artifactVersion = Math.max(0, ...council.artifacts
    .filter((artifact) => artifact.kind === kind && artifact.authorSessionId === participant.sessionId)
    .map((artifact) => Number(artifact.version) || 0)) + 1
  const artifact = {
    artifactId,
    kind,
    workflowId: council.workflowId,
    runId: council.runId,
    phaseId: kind,
    round: 1,
    version: artifactVersion,
    authorSessionId: participant.sessionId,
    contentRef,
    digest: createHash('sha256').update(content).digest('hex'),
    sizeBytes,
    createdAt: now(),
    ...(execution ? { execution } : {}),
    ...(execution && execution.workflowId !== council.workflowId
      ? { governingWorkflowId: execution.workflowId }
      : {}),
  }
  council.artifacts.push(artifact)
  delete participant.expectedTurnId
  delete participant.expectedArtifactKind
  delete participant.expectedExecutionEnvelope
  m.appendKernelEvent(
    'council.artifact.created',
    {
      workflowId: council.workflowId,
      runId: council.runId,
      artifactId,
      kind,
      authorSessionId: participant.sessionId,
      contentRef,
      digest: artifact.digest,
      sizeBytes,
      ...(execution ? { execution } : {}),
    },
    { actor: { kind: 'runtime' }, causeId },
  )
  planCouncilHistory(m, 
    council,
    'artifact-created',
    `${participant.label} produced ${kind}.`,
  )
}

export function planCouncilFinished(m: WorkflowKernel, sessionId: string, turnId: string, causeId?: string) {
  const council = planCouncilForSession(m, sessionId)
  if (!council || ['completed', 'stopped', 'failed'].includes(council.phase)) {
    return
  }
  const participant = council.participants[sessionId]
  if (
    participant.expectedTurnId !== turnId ||
    !participant.expectedArtifactKind
  ) {
    return
  }
  try {
    const artifactKind = participant.expectedArtifactKind
    const execution = clone(participant.expectedExecutionEnvelope)
    materializePlanCouncilArtifact(m, 
      council,
      participant,
      participant.expectedArtifactKind,
      turnId,
      causeId,
    )
    const barrierKey = artifactKind === 'proposal'
      ? 'proposal'
      : artifactKind === 'peer-review'
        ? 'peer-review'
        : 'synthesis'
    const barrierId = council.barrierIds?.[barrierKey]
    const barrierArrival = barrierId && execution
      ? m.cmdArriveBarrier({
          barrierId,
          participantKey: participant.key,
          eventId: causeId ?? `artifact:${participant.sessionId}:${turnId}`,
          envelope: execution,
        }, { actor: { kind: 'runtime' }, causeId })
      : undefined
    if (
      council.phase === 'drafting-plans' &&
      barrierArrival?.released
    ) {
      setPlanCouncilPhase(m, 
        council,
        'ready-for-cross-review',
        council.advancement?.crossReview === 'auto'
          ? 'All independent plans are ready. Automatic cross-review advancement is queued.'
          : council.advancement?.crossReview === 'master'
            ? 'All independent plans are ready. Waiting for Master judgment to start cross-review.'
            : 'All independent plans are ready. Waiting for human approval to start cross-review.',
      )
      maybeAdvancePlanCouncil(m, council, 'crossReview')
    } else if (
      council.phase === 'reviewing-peers' &&
      barrierArrival?.released
    ) {
      setPlanCouncilPhase(m, 
        council,
        'ready-for-synthesis',
        council.advancement?.synthesis === 'auto'
          ? 'All peer reviews are ready. Automatic synthesis advancement is queued.'
          : council.advancement?.synthesis === 'master'
            ? 'All peer reviews are ready. Waiting for Master judgment to synthesize.'
            : 'All peer reviews are ready. Waiting for human approval to synthesize.',
      )
      maybeAdvancePlanCouncil(m, council, 'synthesis')
    } else if (
      council.phase === 'synthesizing' &&
      participant.role === 'synthesizer' &&
      barrierArrival?.released
    ) {
      setPlanCouncilPhase(m, 
        council,
        'completed',
        'The final synthesis is ready.',
      )
      const synthesis = [...council.artifacts].reverse().find(
        (artifact) => artifact.kind === 'synthesis',
      )
      m.appendKernelEvent(
        'workflow.milestone',
        {
          workflowId: council.workflowId,
          runId: council.runId,
          milestone: 'plan-council-synthesis-completed',
          summary: 'Plan Council completed and its final synthesis is ready for an implementation Workflow Proposal.',
          artifactId: synthesis?.artifactId,
          contentRef: synthesis?.contentRef,
        },
        {
          actor: { kind: 'runtime' },
          causeId,
          ...(synthesis?.execution
            ? { execution: clone(synthesis.execution) }
            : {}),
        },
      )
      if (
        council.coordinatorSessionId &&
        council.coordinatorSessionId !== participant.sessionId &&
        m.state.sessions[council.coordinatorSessionId]
      ) {
        const content = completedAssistantContent(m, 
          participant.sessionId,
          turnId,
        )
        if (content) {
          m.deliverToChannel(
            {
              target: council.coordinatorSessionId,
              from: participant.sessionId,
              topic: `plan-council:${council.workflowId}:synthesis`,
              note: 'Plan Council completed. The final synthesis is attached.',
              entries: [{ name: 'final-plan.md', content }],
            },
            {
              actor: { kind: 'runtime' },
              causeId,
              ...(synthesis?.execution
                ? { execution: clone(synthesis.execution) }
                : {}),
            },
          )
        }
      }
    }
  } catch (error) {
    failPlanCouncil(m, 
      council,
      error instanceof Error ? error.message : String(error),
      causeId,
    )
  }
}

export function planCouncilFailed(m: WorkflowKernel, sessionId: string, error: string) {
  const council = planCouncilForSession(m, sessionId)
  if (!council || ['completed', 'stopped', 'failed'].includes(council.phase)) {
    return
  }
  const participant = council.participants[sessionId]
  if (!participant?.expectedTurnId) return
  if (/Resource budget exhausted:/i.test(error)) {
    const firstBlock = council.phase !== 'blocked'
    if (firstBlock) {
      council.blockedAt = now()
      council.blockedFromPhase = council.phase
      council.blockedParticipantIds = []
    }
    council.blockedParticipantIds ??= council.blockedParticipantId ? [council.blockedParticipantId] : []
    if (!council.blockedParticipantIds.includes(sessionId)) council.blockedParticipantIds.push(sessionId)
    council.blockedParticipantId = council.blockedParticipantIds[0]
    const blockedLabels = council.blockedParticipantIds.map((id) => council.participants[id]?.label ?? id)
    council.blockReason = `${blockedLabels.join(', ')} reached a configured resource budget. Adjust or disable the budget, then retry.`
    council.blockKind = 'resource-budget'
    council.failure = council.blockReason
    if (firstBlock) setPlanCouncilPhase(m, council, 'blocked', council.blockReason)
    else planCouncilHistory(m, council, 'blocked', council.blockReason)
    m.appendKernelEvent(
      'council.blocked',
      {
        workflowId: council.workflowId,
        runId: council.runId,
        participantSessionId: sessionId,
        reason: truncateForLog(council.blockReason, 400),
        kind: council.blockKind,
      },
      { actor: { kind: 'runtime' } },
    )
    m.touch()
    m.broadcast({ type: 'plan-council.updated', workflowId: council.workflowId, state: m.getState() })
    return
  }
  failPlanCouncil(m, council, `${participant.label} failed: ${error}`)
}

export async function cmdRetryPlanCouncilParticipant(m: WorkflowKernel, input: JsonRecord = {}, ctx: JsonRecord) {
  if (ctx.actor?.kind !== 'human') throw new Error('Only a human can retry a blocked Plan Council participant.')
  const workflowId = optionalTrimmedString(input.workflowId)
  const council = workflowId ? m.state.planCouncils?.[workflowId] : undefined
  if (!council) throw new Error(`Unknown Plan Council: ${workflowId ?? ''}`)
  if (council.phase !== 'blocked' || !council.blockedParticipantId || !council.blockedFromPhase) {
    throw new Error(`Plan Council ${workflowId} is not blocked on a retryable participant.`)
  }
  const sessionId = council.blockedParticipantId
  const participant = council.participants?.[sessionId]
  const session = m.state.sessions[sessionId]
  if (!participant || !session || !participant.expectedArtifactKind || !participant.expectedExecutionEnvelope) {
    throw new Error('Blocked Plan Council participant is missing retry provenance.')
  }
  const scopeId = m.resourceScopeId(sessionId)
  if (input.disableConsumptionBudget === true) {
    m.cmdSetResourcePolicy({ scopeId, consumptionEnforcement: 'off' }, ctx)
  }
  const policy = m.resourcePolicy(scopeId)
  if (policy.consumptionEnforcement === 'hard') {
    throw new Error('The consumption budget is still enforced. Disable it or raise its limits before retrying.')
  }
  if (m.isSessionFrozen(sessionId)) {
    m.cmdUnfreeze({ target: sessionId, reason: 'Retrying the blocked Plan Council participant.' }, ctx)
  }
  const previousExecution = clone(participant.expectedExecutionEnvelope)
  const attempt = Number(previousExecution.attempt) + 1
  const execution = {
    ...previousExecution,
    activationId: `${council.workflowId}:${previousExecution.phaseId}:retry-pending:${attempt}`,
    attempt,
  }
  const note = participant.expectedArtifactKind === 'proposal'
    ? plannerPrompt(council.objective, council.reviewFocus, participant.label)
    : participant.expectedArtifactKind === 'peer-review'
      ? crossReviewPrompt(council.reviewFocus)
      : synthesizerPrompt(council.objective, council.reviewFocus)
  const restoredPhase = council.blockedFromPhase
  delete participant.expectedTurnId
  const activated = await m.cmdActivate({ sessionId, note }, { ...ctx, execution })
  participant.expectedTurnId = activated.runId
  participant.expectedExecutionEnvelope = { ...execution, activationId: activated.runId }
  const remainingBlocked = (council.blockedParticipantIds ?? [sessionId]).filter((id) => id !== sessionId)
  if (remainingBlocked.length > 0) {
    council.blockedParticipantIds = remainingBlocked
    council.blockedParticipantId = remainingBlocked[0]
    const blockedLabels = remainingBlocked.map((id) => council.participants[id]?.label ?? id)
    council.blockReason = `${blockedLabels.join(', ')} still require a resource-budget retry.`
    council.failure = council.blockReason
  } else {
    council.phase = restoredPhase
    delete council.blockedAt
    delete council.blockedFromPhase
    delete council.blockedParticipantId
    delete council.blockedParticipantIds
    delete council.blockReason
    delete council.blockKind
    delete council.failure
  }
  planCouncilHistory(m, council, 'retried', `${participant.label} was retried as attempt ${attempt}.`)
  m.appendKernelEvent(
    'council.participant-retried',
    { workflowId: council.workflowId, runId: council.runId, participantSessionId: sessionId, attempt },
    { ...ctx, execution: clone(participant.expectedExecutionEnvelope) },
  )
  m.touch()
  m.broadcast({ type: 'plan-council.updated', workflowId: council.workflowId, state: m.getState() })
  return { council: clone(council), state: m.getState() }
}

export function getPlanCouncil(m: WorkflowKernel, input: JsonRecord | string = {}) {
  const workflowId =
    typeof input === 'string'
      ? input
      : optionalTrimmedString(input.workflowId ?? input.runId)
  const state = m.readState()
  const council = workflowId
    ? state.planCouncils?.[workflowId] ??
      Object.values(state.planCouncils ?? {}).find(
        (candidate: JsonRecord) => candidate.runId === workflowId,
      )
    : undefined
  if (!council) throw new Error(`Unknown Plan Council: ${workflowId ?? ''}`)
  return { council: clone(council) }
}

export function getPlanCouncilArtifact(m: WorkflowKernel, input: JsonRecord = {}) {
  const { council } = getPlanCouncil(m, input)
  const artifactId = optionalTrimmedString(input.artifactId)
  const artifact = council.artifacts.find(
    (candidate) => candidate.artifactId === artifactId,
  )
  if (!artifact) throw new Error(`Unknown Plan Council artifact: ${artifactId ?? ''}`)
  return { artifact, content: m.channelStore.readArtifact(artifact.contentRef) }
}

export async function startPlanCouncil(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    const requestKey = optionalTrimmedString(input.idempotencyKey) ??
      optionalTrimmedString(input.commandId)
    const previous = requestKey
      ? m.kernelStore.getWorkflowDeploymentByCommandId(requestKey)
      : undefined
    const existingCouncil = previous?.status === 'completed'
      ? m.state.planCouncils?.[previous.workflowId]
      : undefined
    if (existingCouncil) {
      return {
        workflowId: existingCouncil.workflowId,
        runId: existingCouncil.runId,
        deploymentId: previous.deploymentId,
        participantSessionIds: Object.fromEntries(
          existingCouncil.participantOrder.map((id) => [existingCouncil.participants[id].key, id]),
        ),
        synthesizerSessionId: existingCouncil.synthesizerSessionId,
        council: clone(existingCouncil),
        state: m.getState(),
      }
    }
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_plan_council',
      actor: { kind: 'human' },
      input,
    })
  }
  const validation = validatePlanCouncilStart(input as any, {
    providerInstanceIds: m.state.providerInstances.map(
      (instance) => instance.providerInstanceId,
    ),
    sessionIds: Object.keys(m.state.sessions),
  })
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => issue.message).join(' '))
  }
  const councilResourcePolicy = m.resourcePolicy('global')
  if (input.planners.length > councilResourcePolicy.maxFanout) {
    throw new Error(`Plan Council fan-out ${input.planners.length} exceeds global resource policy ${councilResourcePolicy.maxFanout}.`)
  }
  const ctx = m.workflowCommandCtx()
  const requestedDeploymentCommandId =
    optionalTrimmedString(input.idempotencyKey) ??
    optionalTrimmedString(input.commandId)
  if (requestedDeploymentCommandId) {
    const previous = m.kernelStore.getWorkflowDeploymentByCommandId(
      requestedDeploymentCommandId,
    )
    if (previous) {
      if (previous.status !== 'completed') {
        throw new Error(
          `Plan Council command ${requestedDeploymentCommandId} previously ${previous.status} at ${previous.stage}.`,
        )
      }
      const council = m.state.planCouncils?.[previous.workflowId]
      if (!council) {
        throw new Error(
          `Completed Plan Council deployment ${previous.deploymentId} is missing its durable projection.`,
        )
      }
      return {
        workflowId: council.workflowId,
        runId: council.runId,
        deploymentId: previous.deploymentId,
        participantSessionIds: Object.fromEntries(
          council.participantOrder.map((id) => [council.participants[id].key, id]),
        ),
        synthesizerSessionId: council.synthesizerSessionId,
        council: clone(council),
        state: m.getState(),
      }
    }
  }
  const workflowId = `plan-council-${randomUUID()}`
  const runId = randomUUID()
  const deploymentId = `deployment-${workflowId}`
  const deploymentCommandId = requestedDeploymentCommandId ?? randomUUID()
  const createdSessionIds: string[] = []
  const preparedRuns = new Map<string, JsonRecord>()
  const participants = {}
  const participantOrder: string[] = []
  const createParticipant = async (spec, role) => {
    const created = await m.cmdCreateSession(
      {
        prompt:
          role === 'planner'
            ? plannerPrompt(input.objective, input.reviewFocus, spec.label)
            : synthesizerPrompt(input.objective, input.reviewFocus),
        cwd: input.cwd,
        workMode: 'local',
        label: spec.label,
        providerKind: spec.providerKind,
        providerInstanceId: spec.providerInstanceId,
        runtimeSettings: {
          ...spec.runtimeSettings,
          runtimeMode: 'approval-required',
          sandbox: 'read-only',
        },
        ...(input.coordinatorSessionId
          ? {
              sourceSessionId: input.coordinatorSessionId,
              linkLabel: `Plan Council ${role}`,
            }
          : {}),
      },
      ctx,
      { deferStart: true },
    )
    createdSessionIds.push(created.sessionId)
    m.kernelStore.updateWorkflowDeployment(deploymentId, {
      journal: {
        createdSessionIds: [...createdSessionIds],
        createdSessionResources: workflowResourceDescriptors(m, createdSessionIds),
      },
    })
    preparedRuns.set(created.sessionId, created.preparedRun)
    participants[created.sessionId] = {
      ...clone(spec),
      runtimeSettings: {
        ...clone(spec.runtimeSettings),
        runtimeMode: 'approval-required',
        sandbox: 'read-only',
      },
      role,
      sessionId: created.sessionId,
    }
    participantOrder.push(created.sessionId)
    return created.sessionId
  }

  m.kernelStore.createWorkflowDeployment({
    deploymentId,
    workflowId,
    commandId: deploymentCommandId,
    stage: 'prepared',
    journal: {
      kind: 'plan-council',
      artifactWorkflowId: workflowId,
      createdSessionIds: [],
      createdSubscriptionIds: [],
    },
  })
  try {
    advanceWorkflowDeployment(m, deploymentId, 'prepared')
    for (const planner of input.planners) {
      await createParticipant(planner, 'planner')
    }
    const synthesizerSessionId = await createParticipant(
      input.synthesizer,
      'synthesizer',
    )
    advanceWorkflowDeployment(m, deploymentId, 'resources-created', {
      createdSessionIds: [...createdSessionIds],
      createdSessionResources: workflowResourceDescriptors(m, createdSessionIds),
    })
    if (!input.coordinatorSessionId) {
      input.coordinatorSessionId = synthesizerSessionId
    }
    for (const plannerSessionId of participantOrder.filter(
      (id) => id !== synthesizerSessionId,
    )) {
      m.cmdLinkSessions(
        {
          source: plannerSessionId,
          target: synthesizerSessionId,
          label: 'Plan Council participant',
          reason: 'Independent plan flows to the Council synthesizer.',
        },
        ctx,
      )
    }
    const ts = now()
    const council = {
      workflowId,
      runId,
      objective: input.objective.trim(),
      cwd: path.resolve(input.cwd),
      ...(optionalTrimmedString(input.reviewFocus)
        ? { reviewFocus: input.reviewFocus.trim() }
        : {}),
      phase: 'configured',
      round: 1,
      coordinatorSessionId: input.coordinatorSessionId,
      synthesizerSessionId,
      reviewTopology: input.reviewTopology === 'hub-and-spoke' ? 'hub-and-spoke' : 'full-mesh',
      participantOrder,
      participants,
      artifacts: [],
      history: [],
      createdAt: ts,
      updatedAt: ts,
      advancement: {
        crossReview: ['human', 'master', 'auto'].includes(input.advancement?.crossReview)
          ? input.advancement.crossReview
          : 'human',
        synthesis: ['human', 'master', 'auto'].includes(input.advancement?.synthesis)
          ? input.advancement.synthesis
          : 'human',
      },
      barrierIds: {} as Record<string, string>,
    }
    m.state.planCouncils[workflowId] = council
    const authoringWorkflowId = optionalTrimmedString(input.workflowPlanRef?.workflowId) ?? workflowId
    const authoringWorkflowVersion = Number.isSafeInteger(input.workflowPlanRef?.version)
      ? input.workflowPlanRef.version
      : 1
    const proposalCorrelationKey = executionCorrelationKey({
      workflowId: authoringWorkflowId,
      workflowVersion: authoringWorkflowVersion,
      runId,
      phaseId: 'proposal',
    })
    const proposalBarrier = m.cmdCreateBarrier({
      barrierId: `${workflowId}:proposal:1`,
      mode: 'all',
      expectedParticipantKeys: participantOrder
        .filter((id) => id !== synthesizerSessionId)
        .map((id) => participants[id].key),
      envelope: {
        workflowId: authoringWorkflowId,
        workflowVersion: authoringWorkflowVersion,
        runId,
        phaseId: 'proposal',
        activationId: `${workflowId}:proposal:setup`,
        attempt: 1,
        correlationKey: proposalCorrelationKey,
      },
    }, ctx).barrier
    council.barrierIds.proposal = proposalBarrier.barrierId
    planCouncilHistory(m, 
      council,
      'started',
      'Council prepared all participants before starting any planner.',
    )
    setPlanCouncilPhase(m, 
      council,
      'drafting-plans',
      'Independent planners started in parallel.',
    )
    m.touch()
    advanceWorkflowDeployment(m, deploymentId, 'graph-committed')
    for (const sessionId of participantOrder) {
      if (sessionId === synthesizerSessionId) continue
      delete m.state.sessions[sessionId].prepared
      participants[sessionId].expectedArtifactKind = 'proposal'
      const preparedRun = preparedRuns.get(sessionId)
      if (!preparedRun) throw new Error(`Missing prepared run for ${sessionId}.`)
      const turnId = await m.startRun(sessionId, {
        prompt: preparedRun.prompt,
        attachments: preparedRun.attachments,
        runKind: 'create',
        userMessageId: preparedRun.userMessageId,
        activationEventId: preparedRun.activationEventId,
        channelReadSeqs: preparedRun.channelReadSeqs,
        execution: {
          workflowId: authoringWorkflowId,
          workflowVersion: authoringWorkflowVersion,
          runId,
          phaseId: 'proposal',
          activationId: `${workflowId}:proposal:pending`,
          attempt: 1,
          correlationKey: proposalCorrelationKey,
        },
      })
      participants[sessionId].expectedTurnId = turnId
      participants[sessionId].expectedExecutionEnvelope = {
        workflowId: authoringWorkflowId,
        workflowVersion: authoringWorkflowVersion,
        runId,
        phaseId: 'proposal',
        activationId: turnId,
        attempt: 1,
        correlationKey: proposalCorrelationKey,
      }
    }
    await settleProviderStart(m)
    const failed = participantOrder
      .filter((id) => id !== synthesizerSessionId)
      .map((id) => m.state.sessions[id])
      .find((session) => session?.status === 'failed')
    if (failed) throw new Error(failed.error ?? `${failed.label} could not start.`)
    advanceWorkflowDeployment(m, deploymentId, 'roots-started')
    m.touch()
    advanceWorkflowDeployment(m, 
      deploymentId,
      'active',
      {
        activatedAt: now(),
        participantSessionIds: Object.fromEntries(
          participantOrder.map((id) => [participants[id].key, id]),
        ),
        synthesizerSessionId,
      },
      'completed',
    )
    m.broadcast({ type: 'plan-council.updated', workflowId, state: m.getState() })
    return {
      workflowId,
      runId,
      deploymentId,
      participantSessionIds: Object.fromEntries(
        participantOrder.map((id) => [participants[id].key, id]),
      ),
      synthesizerSessionId,
      council: clone(council),
      state: m.getState(),
    }
  } catch (error) {
    if ((error as Error & { code?: string })?.code === 'ORRERY_DEPLOYMENT_CRASH') {
      throw error
    }
    delete m.state.planCouncils?.[workflowId]
    m.channelStore.removeArtifacts(workflowId)
    for (const sessionId of [...createdSessionIds].reverse()) {
      discardWorkflowSession(m, sessionId)
    }
    m.touch()
    m.kernelStore.updateWorkflowDeployment(deploymentId, {
      stage: 'aborted',
      status: 'aborted',
      journal: {
        reason: error instanceof Error ? error.message : String(error),
        abortedAt: now(),
      },
    })
    m.broadcast({ type: 'runtime.state', state: m.getState() })
    throw error
  }
}

export async function startPlanCouncilCrossReview(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_plan_council_cross_review',
      actor: { kind: 'human' },
      input,
    })
  }
  const workflowId = optionalTrimmedString(input.workflowId ?? input.runId)
  const council = m.state.planCouncils?.[workflowId]
  if (!council) throw new Error(`Unknown Plan Council: ${workflowId ?? ''}`)
  if (['reviewing-peers', 'ready-for-synthesis', 'synthesizing', 'completed'].includes(council.phase)) {
    return { council: clone(council), state: m.getState() }
  }
  if (council.phase !== 'ready-for-cross-review') {
    throw new Error(`Plan Council is ${council.phase}; all proposals must be ready before cross-review.`)
  }
  if (m.planCouncilInFlight.has(workflowId)) throw new Error('This Plan Council phase is already starting.')
  m.planCouncilInFlight.add(workflowId)
  const phaseCtx: JsonRecord = m.workflowCommandCtx()
  try {
    const reviewerIds = council.reviewTopology === 'hub-and-spoke'
      ? [council.synthesizerSessionId]
      : council.participantOrder.filter(
          (id) => ['planner', 'reviewer'].includes(council.participants[id].role),
        )
    for (const sessionId of reviewerIds) m.assertActivatable(sessionId, phaseCtx)
    const proposalBarrier = m.state.barriers?.[council.barrierIds?.proposal]
    const correlationKey = executionCorrelationKey({
      workflowId: proposalBarrier?.workflowId ?? council.workflowId,
      workflowVersion: proposalBarrier?.workflowVersion ?? 1,
      runId: council.runId,
      phaseId: 'peer-review',
      generation: nextCouncilBarrierGeneration(m, council, 'peer-review'),
    })
    const reviewGeneration = nextCouncilBarrierGeneration(m, council, 'peer-review')
    const reviewBarrier = m.cmdCreateBarrier({
      barrierId: `${council.workflowId}:peer-review:g${reviewGeneration}`,
      mode: 'all',
      expectedParticipantKeys: reviewerIds.map((id) => council.participants[id].key),
      envelope: {
        workflowId: proposalBarrier?.workflowId ?? council.workflowId,
        workflowVersion: proposalBarrier?.workflowVersion ?? 1,
        runId: council.runId,
        phaseId: 'peer-review', activationId: `${council.workflowId}:peer-review:setup`,
        attempt: 1, correlationKey,
      },
    }, phaseCtx).barrier
    phaseCtx.execution = {
      workflowId: reviewBarrier.workflowId,
      workflowVersion: reviewBarrier.workflowVersion,
      runId: council.runId,
      phaseId: 'peer-review',
      activationId: `${council.workflowId}:peer-review:delivery`,
      attempt: 1,
      correlationKey,
    }
    council.barrierIds['peer-review'] = reviewBarrier.barrierId
    const supersededArtifactIds = new Set(council.supersededArtifactIds ?? [])
    const proposals = council.artifacts.filter(
      (artifact) => artifact.kind === 'proposal' && !supersededArtifactIds.has(artifact.artifactId),
    )
    for (const reviewerId of reviewerIds) {
      for (const artifact of proposals) {
        if (artifact.authorSessionId === reviewerId) continue
        m.cmdDeliver(
          {
            sessionId: reviewerId,
            source: artifact.authorSessionId,
            topic: `proposal:${artifact.authorSessionId}`,
            filename: `proposal-${artifact.authorSessionId}.md`,
            content: m.channelStore.readArtifact(artifact.contentRef),
          },
          phaseCtx,
        )
      }
    }
    const advancingActor = phaseCtx.actor?.kind === 'master'
      ? 'Master'
      : phaseCtx.actor?.kind === 'runtime'
        ? 'Automatic policy'
        : 'Human'
    setPlanCouncilPhase(m, council, 'reviewing-peers', `${advancingActor} advanced the cross-review phase.`)
    for (const sessionId of reviewerIds) {
      council.participants[sessionId].expectedArtifactKind = 'peer-review'
      const result = await m.cmdActivate(
        {
          sessionId,
          note: crossReviewPrompt(council.reviewFocus),
        },
        phaseCtx,
      )
      council.participants[sessionId].expectedTurnId = result.runId
      council.participants[sessionId].expectedExecutionEnvelope = {
        workflowId: reviewBarrier.workflowId,
        workflowVersion: reviewBarrier.workflowVersion,
        runId: council.runId,
        phaseId: 'peer-review', activationId: result.runId, attempt: 1, correlationKey,
      }
    }
    await settleProviderStart(m)
    const failed = reviewerIds
      .map((id) => m.state.sessions[id])
      .find((session) => session?.status === 'failed')
    if (failed) throw new Error(failed.error ?? `${failed.label} could not start cross-review.`)
    m.touch()
    m.broadcast({ type: 'plan-council.updated', workflowId, state: m.getState() })
    return { council: clone(council), state: m.getState() }
  } catch (error) {
    failPlanCouncil(m, 
      council,
      error instanceof Error ? error.message : String(error),
    )
    m.touch()
    m.broadcast({ type: 'plan-council.updated', workflowId, state: m.getState() })
    ;(error as Error & { commitState?: boolean }).commitState = true
    throw error
  } finally {
    m.planCouncilInFlight.delete(workflowId)
  }
}

export async function startPlanCouncilSynthesis(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_plan_council_synthesis',
      actor: { kind: 'human' },
      input,
    })
  }
  const workflowId = optionalTrimmedString(input.workflowId ?? input.runId)
  const council = m.state.planCouncils?.[workflowId]
  if (!council) throw new Error(`Unknown Plan Council: ${workflowId ?? ''}`)
  if (['synthesizing', 'completed'].includes(council.phase)) {
    return { council: clone(council), state: m.getState() }
  }
  if (council.phase !== 'ready-for-synthesis') {
    throw new Error(`Plan Council is ${council.phase}; all peer reviews must be ready before synthesis.`)
  }
  const phaseCtx: JsonRecord = m.workflowCommandCtx()
  try {
    const synthesizerId = council.synthesizerSessionId
    m.assertActivatable(synthesizerId, phaseCtx)
    const proposalBarrier = m.state.barriers?.[council.barrierIds?.proposal]
    const correlationKey = executionCorrelationKey({
      workflowId: proposalBarrier?.workflowId ?? council.workflowId,
      workflowVersion: proposalBarrier?.workflowVersion ?? 1,
      runId: council.runId,
      phaseId: 'synthesis',
      generation: nextCouncilBarrierGeneration(m, council, 'synthesis'),
    })
    const synthesisGeneration = nextCouncilBarrierGeneration(m, council, 'synthesis')
    const synthesisBarrier = m.cmdCreateBarrier({
      barrierId: `${council.workflowId}:synthesis:g${synthesisGeneration}`,
      mode: 'all', expectedParticipantKeys: [council.participants[synthesizerId].key],
      envelope: {
        workflowId: proposalBarrier?.workflowId ?? council.workflowId,
        workflowVersion: proposalBarrier?.workflowVersion ?? 1,
        runId: council.runId, phaseId: 'synthesis',
        activationId: `${council.workflowId}:synthesis:setup`, attempt: 1, correlationKey,
      },
    }, phaseCtx).barrier
    phaseCtx.execution = {
      workflowId: synthesisBarrier.workflowId,
      workflowVersion: synthesisBarrier.workflowVersion,
      runId: council.runId,
      phaseId: 'synthesis',
      activationId: `${council.workflowId}:synthesis:delivery`,
      attempt: 1,
      correlationKey,
    }
    council.barrierIds.synthesis = synthesisBarrier.barrierId
    const supersededArtifactIds = new Set(council.supersededArtifactIds ?? [])
    for (const artifact of council.artifacts.filter(
      (item) => item.kind !== 'synthesis' && !supersededArtifactIds.has(item.artifactId),
    )) {
      m.cmdDeliver(
        {
          sessionId: synthesizerId,
          source: artifact.authorSessionId,
          topic: `${artifact.kind}:${artifact.authorSessionId}`,
          filename: `${artifact.kind}-${artifact.authorSessionId}.md`,
          content: m.channelStore.readArtifact(artifact.contentRef),
        },
        phaseCtx,
      )
    }
    const advancingActor = phaseCtx.actor?.kind === 'master'
      ? 'Master'
      : phaseCtx.actor?.kind === 'runtime'
        ? 'Automatic policy'
        : 'Human'
    setPlanCouncilPhase(m, council, 'synthesizing', `${advancingActor} advanced final synthesis.`)
    council.participants[synthesizerId].expectedArtifactKind = 'synthesis'
    const result = await m.cmdActivate(
      {
        sessionId: synthesizerId,
        note: synthesizerPrompt(council.objective, council.reviewFocus),
      },
      phaseCtx,
    )
    council.participants[synthesizerId].expectedTurnId = result.runId
    council.participants[synthesizerId].expectedExecutionEnvelope = {
      workflowId: synthesisBarrier.workflowId,
      workflowVersion: synthesisBarrier.workflowVersion,
      runId: council.runId, phaseId: 'synthesis', activationId: result.runId,
      attempt: 1, correlationKey,
    }
    await settleProviderStart(m)
    const failed = m.state.sessions[synthesizerId]
    if (failed?.status === 'failed') {
      throw new Error(failed.error ?? `${failed.label} could not start synthesis.`)
    }
    m.touch()
    m.broadcast({ type: 'plan-council.updated', workflowId, state: m.getState() })
    return { council: clone(council), state: m.getState() }
  } catch (error) {
    failPlanCouncil(m, 
      council,
      error instanceof Error ? error.message : String(error),
    )
    m.touch()
    m.broadcast({ type: 'plan-council.updated', workflowId, state: m.getState() })
    ;(error as Error & { commitState?: boolean }).commitState = true
    throw error
  }
}

export function stopPlanCouncil(m: WorkflowKernel, input: JsonRecord = {}) {
  const workflowId = optionalTrimmedString(input.workflowId ?? input.runId)
  const council = m.state.planCouncils?.[workflowId]
  if (!council) throw new Error(`Unknown Plan Council: ${workflowId ?? ''}`)
  if (['completed', 'stopped', 'failed'].includes(council.phase)) {
    return { council: clone(council), state: m.getState() }
  }
  council.stoppedAt = now()
  cancelPendingCouncilBarriers(m, 
    council,
    optionalTrimmedString(input.reason) ?? 'Human stopped the Plan Council.',
  )
  setPlanCouncilPhase(m, 
    council,
    'stopped',
    'Human stopped the Council. Running turns may settle, but no new phase can start.',
  )
  m.appendKernelEvent(
    'council.stopped',
    { workflowId, runId: council.runId },
    m.humanCtx(),
    { reason: optionalTrimmedString(input.reason) },
  )
  m.touch()
  m.broadcast({ type: 'plan-council.updated', workflowId, state: m.getState() })
  return { council: clone(council), state: m.getState() }
}

// Product-facing Review until clean compiler. Unlike the older template
// path, this accepts new or existing endpoints and commits the whole ring
// before the first Coder turn. New Reviewers stay provider-cold until the
// first diff arrives; there is no synthetic "ready" turn.

export function deliverCouncilArtifacts(
  m: WorkflowKernel,
  council: JsonRecord,
  targetSessionId: string,
  kinds: string[],
  ctx: JsonRecord = { actor: { kind: 'runtime' } },
) {
  const superseded = new Set(council.supersededArtifactIds ?? [])
  for (const artifact of council.artifacts.filter(
    (item: JsonRecord) => kinds.includes(item.kind) && !superseded.has(item.artifactId),
  )) {
    m.cmdDeliver({
      sessionId: targetSessionId,
      source: artifact.authorSessionId,
      topic: `${artifact.kind}:${artifact.authorSessionId}:v${artifact.version}`,
      filename: `${artifact.kind}-${artifact.authorSessionId}-v${artifact.version}.md`,
      content: m.channelStore.readArtifact(artifact.contentRef),
    }, ctx)
  }
}

export function createCouncilPatchBarrier(
  m: WorkflowKernel,
  council: JsonRecord,
  participant: JsonRecord,
  kind: 'proposal' | 'peer-review' | 'synthesis',
) {
  const phaseId = kind
  const proposalBarrier = m.state.barriers?.[council.barrierIds?.proposal]
  const matching = Object.values(m.state.barriers ?? {}).filter(
    (barrier: JsonRecord) =>
      barrier.runId === council.runId && barrier.phaseId === phaseId,
  )
  const generation = matching.length + 1
  const workflowId = proposalBarrier?.workflowId ?? council.workflowId
  const workflowVersion = proposalBarrier?.workflowVersion ?? 1
  const correlationKey = executionCorrelationKey({
    workflowId,
    workflowVersion,
    runId: council.runId,
    phaseId,
    generation,
  })
  const barrier = m.cmdCreateBarrier({
    barrierId: `${council.workflowId}:${phaseId}:patch:${generation}`,
    mode: 'all',
    expectedParticipantKeys: [participant.key],
    envelope: {
      workflowId,
      workflowVersion,
      runId: council.runId,
      phaseId,
      activationId: `${council.workflowId}:${phaseId}:patch-setup:${generation}`,
      attempt: 1,
      correlationKey,
    },
  }, { actor: { kind: 'runtime' } }).barrier
  council.barrierIds ??= {}
  council.barrierIds[phaseId] = barrier.barrierId
  return { barrier, correlationKey }
}

export async function activateCouncilPatchParticipant(
  m: WorkflowKernel,
  council: JsonRecord,
  participant: JsonRecord,
  kind: 'proposal' | 'peer-review' | 'synthesis',
) {
  const sessionId = participant.sessionId
  const { barrier, correlationKey } = createCouncilPatchBarrier(m, 
    council,
    participant,
    kind,
  )
  const execution = {
    workflowId: barrier.workflowId,
    workflowVersion: barrier.workflowVersion,
    runId: council.runId,
    phaseId: kind,
    activationId: `${council.workflowId}:${kind}:patch-pending`,
    attempt: 1,
    correlationKey,
  }
  const phaseCtx = { actor: { kind: 'runtime' }, execution }
  delete m.state.sessions[sessionId].prepared
  if (kind === 'peer-review') deliverCouncilArtifacts(m, council, sessionId, ['proposal'], phaseCtx)
  if (kind === 'synthesis') deliverCouncilArtifacts(m, council, sessionId, ['proposal', 'peer-review'], phaseCtx)
  const note = kind === 'proposal'
    ? plannerPrompt(council.objective, council.reviewFocus)
    : kind === 'peer-review'
      ? crossReviewPrompt(council.reviewFocus)
      : synthesizerPrompt(council.objective, council.reviewFocus)
  participant.expectedArtifactKind = kind
  const activated = await m.cmdActivate({ sessionId, note }, phaseCtx)
  participant.expectedTurnId = activated.runId
  participant.expectedExecutionEnvelope = {
    ...execution,
    activationId: activated.runId,
  }
}

export async function commitPlanCouncilPatch(m: WorkflowKernel, proposal: JsonRecord, base: JsonRecord, ctx: JsonRecord) {
  const councilId = base.executionMapping?.productWorkflowId
  const council = councilId ? m.state.planCouncils?.[councilId] : undefined
  if (!council) throw new Error('Active Plan Council execution is unavailable.')
  const mapping = clone(base.executionMapping)
  mapping.planVersion = proposal.proposedPlan.version
  mapping.committedAt = now()
  const createdSessionIds: string[] = []
  const createdSubscriptionIds: string[] = []
  for (const operation of proposal.patch.operations ?? []) {
    if (!['add-verifier', 'replace-participant', 'resynthesize'].includes(operation.op)) {
      throw new Error(`Plan Council does not support ${operation.op} at product-phase runtime.`)
    }
    if (operation.op === 'resynthesize') {
      if (!['completed', 'ready-for-synthesis'].includes(council.phase)) {
        throw new Error(`Plan Council is ${council.phase}; resynthesis requires completed reviews.`)
      }
      const synthesizer = council.participants[council.synthesizerSessionId]
      setPlanCouncilPhase(m, council, 'synthesizing', `Workflow Patch requested resynthesis: ${operation.reason}`)
      await activateCouncilPatchParticipant(m, council, synthesizer, 'synthesis')
      continue
    }

    if (['reviewing-peers', 'synthesizing'].includes(council.phase)) {
      throw new Error(`Plan Council is ${council.phase}; participant topology cannot change during an active phase.`)
    }

    const participantKey = operation.op === 'add-verifier'
      ? operation.verifier.key
      : operation.participantKey
    const spec = proposal.proposedPlan.participants.find(
      (candidate: JsonRecord) => candidate.key === participantKey,
    )
    if (!spec) throw new Error(`Plan Council patch participant is missing: ${participantKey}`)
    let sessionId
    if (spec.endpoint.kind === 'existing') {
      sessionId = spec.endpoint.sessionId
    } else {
      const created = await m.cmdCreateSession({
        prompt: spec.prompt,
        label: spec.label,
        cwd: spec.workspace.cwd,
        workMode: spec.workspace.workMode,
        branch: spec.workspace.branch,
        providerKind: spec.endpoint.providerKind,
        providerInstanceId: spec.endpoint.providerInstanceId,
        runtimeSettings: spec.endpoint.runtimeSettings,
        cluster: proposal.proposedPlan.scopeId === 'global' ? undefined : proposal.proposedPlan.scopeId,
      }, ctx, { deferStart: true })
      sessionId = created.sessionId
      createdSessionIds.push(sessionId)
    }
    const councilParticipant = {
      key: participantKey.replace(/^(planner|synthesizer):/, ''),
      label: spec.label,
      providerKind: spec.endpoint.kind === 'new'
        ? spec.endpoint.providerKind
        : m.state.sessions[sessionId].providerKind,
      providerInstanceId: spec.endpoint.kind === 'new'
        ? spec.endpoint.providerInstanceId
        : m.state.sessions[sessionId].providerInstanceId,
      runtimeSettings: clone(spec.endpoint.kind === 'new'
        ? spec.endpoint.runtimeSettings
        : m.state.sessions[sessionId].runtimeSettings),
      role: operation.op === 'add-verifier' ? 'reviewer' : undefined,
      sessionId,
    }
    if (operation.op === 'add-verifier') {
      council.participants[sessionId] = councilParticipant
      council.participantOrder.push(sessionId)
      mapping.participantSessionIds[participantKey] = sessionId
      for (const relationship of proposal.proposedPlan.relationships.filter(
        (candidate: JsonRecord) => candidate.to === participantKey,
      )) {
        mapping.relationshipRuntimeRefs[relationship.key] = {
          kind: 'product-phase',
          ref: `${council.workflowId}:${relationship.key}`,
        }
      }
      if (['ready-for-synthesis', 'completed'].includes(council.phase)) {
        councilParticipant.role = 'reviewer'
        setPlanCouncilPhase(m, council, 'reviewing-peers', 'A Workflow Patch added a specialist reviewer.')
        await activateCouncilPatchParticipant(m, council, councilParticipant, 'peer-review')
      } else {
        delete m.state.sessions[sessionId].prepared
      }
      continue
    }

    const oldSessionId = mapping.participantSessionIds[participantKey]
    const oldParticipant = council.participants[oldSessionId]
    if (!oldParticipant) throw new Error(`Plan Council participant mapping is stale: ${participantKey}`)
    councilParticipant.role = oldParticipant.role
    council.supersededArtifactIds ??= []
    council.supersededParticipantIds ??= []
    council.supersededParticipantIds.push(oldSessionId)
    council.supersededArtifactIds.push(...council.artifacts
      .filter((artifact: JsonRecord) => artifact.authorSessionId === oldSessionId)
      .map((artifact: JsonRecord) => artifact.artifactId))
    council.participantOrder = council.participantOrder.map(
      (candidate: string) => candidate === oldSessionId ? sessionId : candidate,
    )
    delete council.participants[oldSessionId]
    council.participants[sessionId] = councilParticipant
    mapping.participantSessionIds[participantKey] = sessionId
    if (council.synthesizerSessionId === oldSessionId) council.synthesizerSessionId = sessionId
    const artifactKind = councilParticipant.role === 'planner'
      ? 'proposal'
      : councilParticipant.role === 'reviewer'
        ? 'peer-review'
        : 'synthesis'
    setPlanCouncilPhase(m, 
      council,
      artifactKind === 'proposal' ? 'drafting-plans' : artifactKind === 'peer-review' ? 'reviewing-peers' : 'synthesizing',
      `Workflow Patch replaced ${oldParticipant.label}.`,
    )
    await activateCouncilPatchParticipant(m, council, councilParticipant, artifactKind)
  }
  m.touch()
  m.broadcast({ type: 'plan-council.updated', workflowId: council.workflowId, state: m.getState() })
  return { mapping, createdSessionIds, createdSubscriptionIds }
}

