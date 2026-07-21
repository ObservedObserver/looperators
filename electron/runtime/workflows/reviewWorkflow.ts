// Atomic review workflow composer (reviewer/coder ring).
// Split out of sessionManager.ts; kernel access goes through WorkflowKernel.
import {
  loopsOf,
} from '../../../shared/graph-core/index.js'
import {
  coderActivationInstruction,
  coderFixInstruction,
  reviewerActivationInstruction,
  reviewerBootstrapInstruction,
  validateReviewWorkflowStart,
} from '../../../shared/review-workflow.js'
import {
  clone,
  isObject,
  now,
  optionalTrimmedString,
  type JsonRecord,
} from '../runtimeCommon.js'
import {
  randomUUID,
} from 'node:crypto'
import type { WorkflowKernel } from './workflowKernel.js'
import {
  advanceWorkflowDeployment,
  captureWorkflowSession,
  restoreWorkflowSession,
} from './classicWorkflows.js'
import {
  discardWorkflowSession,
  discardWorkflowSubscription,
  settleProviderStart,
  workflowResourceDescriptors,
} from './workflowShared.js'

export async function startReviewWorkflow(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_review_workflow',
      actor: { kind: 'human' },
      input,
    })
  }
  const sessionSummaries = {}
  for (const session of Object.values(m.state.sessions as JsonRecord)) {
    const node = m.state.nodes.find(
      (candidate) => candidate.sessionId === session.sessionId,
    )
    sessionSummaries[session.sessionId] = {
      sessionId: session.sessionId,
      cwd: session.cwd,
      status: session.status,
      frozen: node?.frozen === true,
    }
  }
  const validation = validateReviewWorkflowStart(input as any, {
    sessions: sessionSummaries,
    providerInstanceIds: m.state.providerInstances.map(
      (instance) => instance.providerInstanceId,
    ),
  })
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => issue.message).join(' '))
  }

  const coderInput = input.coder as JsonRecord
  const reviewerInput = input.reviewer as JsonRecord
  if (
    coderInput.kind === 'existing' &&
    reviewerInput.kind === 'existing' &&
    coderInput.sessionId === reviewerInput.sessionId
  ) {
    throw new Error('Coder and Reviewer must be different Agents.')
  }

  const ctx = m.workflowCommandCtx()
  const deploymentCommandId =
    optionalTrimmedString(input.idempotencyKey) ??
    optionalTrimmedString(input.commandId) ??
    randomUUID()
  const previousDeployment =
    m.kernelStore.getWorkflowDeploymentByCommandId(deploymentCommandId)
  if (previousDeployment) {
    if (previousDeployment.status !== 'completed') {
      throw new Error(
        `Review Workflow command ${deploymentCommandId} previously ${previousDeployment.status} at ${previousDeployment.stage}.`,
      )
    }
    const result = previousDeployment.journal.result
    if (!isObject(result)) {
      throw new Error(
        `Completed Review Workflow deployment ${previousDeployment.deploymentId} has no durable result.`,
      )
    }
    return {
      ...clone(result),
      loop: loopsOf(m.kernelView()).find((loop) =>
        loop.subscriptionIds.includes(result.subscriptionIds?.[0]),
      ),
      state: m.getState(),
    }
  }
  const workflowId = `review-workflow-${randomUUID()}`
  const deploymentId = `deployment-${workflowId}`
  const createdSessionIds: string[] = []
  const subscriptionIds: string[] = []
  let coderSessionId: string
  let reviewerSessionId: string
  let preparedCoderRun
  let existingCoderCheckpoint
  const lockedSessionIds = [coderInput, reviewerInput]
    .filter((endpoint) => endpoint.kind === 'existing')
    .map((endpoint) => endpoint.sessionId)
  if (lockedSessionIds.some((sessionId) => m.classicWorkflowInFlight.has(sessionId))) {
    throw new Error('One of these Agents is already being changed by another workflow; wait for it to finish.')
  }
  for (const sessionId of lockedSessionIds) m.classicWorkflowInFlight.add(sessionId)

  m.kernelStore.createWorkflowDeployment({
    deploymentId,
    workflowId,
    commandId: deploymentCommandId,
    journal: {
      kind: 'review-workflow',
      createdSessionIds: [],
      createdSubscriptionIds: [],
      existingSessionCheckpoints: {},
    },
  })

  try {
    advanceWorkflowDeployment(m, deploymentId, 'prepared')
    if (coderInput.kind === 'new') {
      const created = await m.cmdCreateSession(
        {
          prompt: coderActivationInstruction(String(coderInput.prompt)),
          cwd: coderInput.cwd,
          workMode: coderInput.workMode,
          branch: coderInput.branch,
          label: optionalTrimmedString(coderInput.label) ?? 'Coder',
          providerKind: coderInput.providerKind,
          providerInstanceId: coderInput.providerInstanceId,
          runtimeSettings: coderInput.runtimeSettings,
        },
        ctx,
        { deferStart: true },
      )
      coderSessionId = created.sessionId
      preparedCoderRun = created.preparedRun
      createdSessionIds.push(coderSessionId)
      m.kernelStore.updateWorkflowDeployment(deploymentId, {
        journal: {
          createdSessionIds: [...createdSessionIds],
          createdSessionResources: workflowResourceDescriptors(m, createdSessionIds),
        },
      })
    } else {
      coderSessionId = optionalTrimmedString(coderInput.sessionId)
      m.assertActivatable(coderSessionId, ctx)
      existingCoderCheckpoint = captureWorkflowSession(m, coderSessionId)
      m.kernelStore.updateWorkflowDeployment(deploymentId, {
        journal: {
          existingSessionCheckpoints: {
            [coderSessionId]: existingCoderCheckpoint,
          },
        },
      })
    }

    const coder = m.state.sessions[coderSessionId]
    if (reviewerInput.kind === 'new') {
      const created = await m.cmdCreateSession(
        {
          prompt: reviewerBootstrapInstruction(reviewerInput.instruction),
          cwd: coder.cwd,
          workMode: 'local',
          label: optionalTrimmedString(reviewerInput.label) ?? 'Reviewer',
          providerKind: reviewerInput.providerKind,
          providerInstanceId: reviewerInput.providerInstanceId,
          runtimeSettings: reviewerInput.runtimeSettings,
          sourceSessionId: coderSessionId,
          linkLabel: 'review partner',
        },
        ctx,
        { deferStart: true },
      )
      reviewerSessionId = created.sessionId
      createdSessionIds.push(reviewerSessionId)
      m.kernelStore.updateWorkflowDeployment(deploymentId, {
        journal: {
          createdSessionIds: [...createdSessionIds],
          createdSessionResources: workflowResourceDescriptors(m, createdSessionIds),
        },
      })
    } else {
      reviewerSessionId = optionalTrimmedString(reviewerInput.sessionId)
      m.assertActivatable(reviewerSessionId, ctx)
      if (m.state.sessions[reviewerSessionId].cwd !== coder.cwd) {
        throw new Error(
          'Coder and Reviewer must use the same workspace so the Reviewer can verify the diff.',
        )
      }
    }

    advanceWorkflowDeployment(m, deploymentId, 'resources-created', {
      createdSessionIds: [...createdSessionIds],
      createdSessionResources: workflowResourceDescriptors(m, createdSessionIds),
    })

    const suffix = randomUUID().slice(0, 8)
    const passId = `review-pass-${suffix}`
    const fixId = `review-fix-${suffix}`
    // Track intended ids before authoring so compensation also reaches the
    // edge whose author command mutated state but failed while broadcasting.
    subscriptionIds.push(passId, fixId)
    const stop = {
      whenReport: { verdict: 'clean' },
      maxFirings: Number(input.maxLaps),
    }
    const pass = m.cmdAuthorSubscription(
      {
        id: passId,
        label: 'review pass',
        preset: 'review-workflow',
        sourceSessionId: coderSessionId,
        on: { on: 'finished' },
        targetSessionId: reviewerSessionId,
        action: {
          kind: 'deliver+activate',
          topic: 'diff',
          note: reviewerActivationInstruction(
            String(reviewerInput.instruction),
            input.blocking as any,
          ),
        },
        gate: 'auto',
        concurrency: 'coalesce',
        stop,
        onStop: 'freeze-edge',
      },
      ctx,
    )
    m.kernelStore.updateWorkflowDeployment(deploymentId, {
      journal: { createdSubscriptionIds: [passId] },
    })
    const fix = m.cmdAuthorSubscription(
      {
        id: fixId,
        label: 'blocking issues',
        preset: 'review-workflow',
        sourceSessionId: reviewerSessionId,
        on: {
          on: 'report',
          match: { type: 'verdict', verdict: 'issues' },
        },
        targetSessionId: coderSessionId,
        action: {
          kind: 'deliver+activate',
          topic: 'review',
          note: coderFixInstruction(),
        },
        gate: 'auto',
        concurrency: 'coalesce',
        stop,
        onStop: 'freeze-edge',
      },
      ctx,
    )
    m.kernelStore.updateWorkflowDeployment(deploymentId, {
      journal: { createdSubscriptionIds: [...subscriptionIds] },
    })
    // The normalized ids are pinned above; retain these assertions close to
    // the compiler boundary in case authoring ever rewrites explicit ids.
    if (pass.subscription.id !== passId || fix.subscription.id !== fixId) {
      throw new Error(
        'Review workflow relationship ids changed during authoring.',
      )
    }
    m.touch()
    advanceWorkflowDeployment(m, deploymentId, 'graph-committed', {
      createdSubscriptionIds: [...subscriptionIds],
    })

    // The first provider invocation is deliberately last. At this point
    // both endpoints and both guarded relationships are already visible to
    // the scheduler, so even an instant Coder finish cannot outrun the ring.
    if (coderInput.kind === 'new') {
      delete m.state.sessions[coderSessionId].prepared
      await m.startRun(coderSessionId, {
        ...preparedCoderRun,
        runKind: 'create',
      })
    } else {
      await m.cmdResumeSession(
        {
          sessionId: coderSessionId,
          message: coderActivationInstruction(String(coderInput.prompt)),
        },
        ctx,
      )
    }
    await settleProviderStart(m)
    if (m.state.sessions[coderSessionId]?.status === 'failed') {
      throw new Error(
        m.state.sessions[coderSessionId].error ??
          'The Coder provider could not start.',
      )
    }

    advanceWorkflowDeployment(m, deploymentId, 'roots-started')

    const state = m.getState()
    const loop = state.loops?.find((candidate) =>
      candidate.subscriptionIds.includes(passId),
    )
    const result = {
      coderSessionId,
      reviewerSessionId,
      createdSessionIds,
      subscriptionIds,
      loop,
      state,
    }
    advanceWorkflowDeployment(m, 
      deploymentId,
      'active',
      {
        result: {
          coderSessionId,
          reviewerSessionId,
          createdSessionIds: [...createdSessionIds],
          subscriptionIds: [...subscriptionIds],
        },
        activatedAt: now(),
      },
      'completed',
    )
    return { ...result, deploymentId }
  } catch (error) {
    if ((error as Error & { code?: string })?.code === 'ORRERY_DEPLOYMENT_CRASH') {
      throw error
    }
    // Compensation is renderer-clean: a failed one-click start must return
    // to the editable Draft, not leave a stopped half-ring or waiting
    // participant on the canvas. Kernel facts already emitted remain an
    // audit trail, but live intent/session state is removed atomically.
    for (const subscriptionId of subscriptionIds) {
      discardWorkflowSubscription(m, subscriptionId)
    }
    for (const sessionId of [...createdSessionIds].reverse()) {
      discardWorkflowSession(m, sessionId)
    }
    if (
      coderInput.kind === 'existing' &&
      coderSessionId &&
      existingCoderCheckpoint &&
      existingCoderCheckpoint
    ) {
      restoreWorkflowSession(m, coderSessionId, existingCoderCheckpoint)
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
    m.broadcast({
      type: 'runtime.state',
      state: m.getState(),
    })
    throw error
  } finally {
    for (const sessionId of lockedSessionIds) m.classicWorkflowInFlight.delete(sessionId)
  }
}

