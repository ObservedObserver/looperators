// Classic workflow composers: draft/handoff/goal/connect presets, the
// workflow prompt texts, workflow-session checkpoints, and the durable
// deployment journal + recovery for automatic workflow deployments.
// Split out of sessionManager.ts; kernel access goes through WorkflowKernel.
import {
  compileAgentConnection,
  validateAgentConnection,
} from '../../../shared/agent-connection.js'
import {
  validateGoalWorkflowStart,
  validateHandoffWorkflowStart,
} from '../../../shared/classic-workflow.js'
import {
  compileDraftRelation,
  validateDraftGraph,
} from '../../../shared/draft-graph.js'
import {
  defaultCycleMaxFirings,
  loopsOf,
} from '../../../shared/graph-core/index.js'
import {
  coderActivationInstruction,
  coderFixInstruction,
  reviewerActivationInstruction,
  reviewerBootstrapInstruction,
} from '../../../shared/review-workflow.js'
import {
  clone,
  isObject,
  now,
  optionalTrimmedString,
  type JsonRecord,
} from '../runtimeCommon.js'
import {
  spawn,
} from 'node:child_process'
import {
  randomUUID,
} from 'node:crypto'
import type { WorkflowKernel } from './workflowKernel.js'
import {
  createGoalLoop,
} from './goalTemplates.js'
import {
  cleanupWorkflowResourceDescriptor,
  discardWorkflowSession,
  discardWorkflowSubscription,
  settleProviderStart,
  workflowResourceDescriptors,
} from './workflowShared.js'

export function reviewerBootstrapPrompt(m: WorkflowKernel) {
  return [
    'You are the Reviewer in an Orrery hero review loop.',
    'Your job on each activation: read the diff delivered in your context channel, then call mcp__orrery_membrane__report exactly once with type "verdict" — verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain.',
    'Do not edit files.',
    'For now, reply with exactly: ready. Then stop and wait for activations.',
  ].join('\n')
}

export function reviewerActivationNote(m: WorkflowKernel) {
  return [
    'Review the latest diff delivered in your context channel (file paths listed below).',
    'Do not edit files.',
    'Call mcp__orrery_membrane__report exactly once with type "verdict": verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain. Then stop.',
  ].join('\n')
}

export function coderActivationNote(m: WorkflowKernel) {
  return [
    'The reviewer reported issues; the review is delivered in your context channel (file paths listed below).',
    'Fix the listed issues, then stop so the loop can run the reviewer again.',
  ].join('\n')
}

// ---- L3 goal loop preset: one sentence compiles into a judge ring ----
//
// Not a new kernel verb: the preset expands into ordinary commands
// (create_session + author_subscription ×2), so the log records only
// regular facts and the loop stays a reading of subscriptions. The user's
// natural-language goal goes exclusively into the judge's prompts; the
// ruling stays typed (report verdict done|fail) and the runtime keeps
// deciding stop deterministically via whenReport + maxFirings (§6.2).

// The bootstrap stays goal-free on purpose: the goal sentence has exactly
// one home — the check edge's activation note, restated to the judge on
// every lap (which also survives judge-side context compaction).
export function goalJudgeBootstrapPrompt(m: WorkflowKernel, workerLabel: string) {
  return [
    `You are the goal judge for the session "${workerLabel}".`,
    'You will be activated after each of its turns; each activation carries the goal and the judging instructions.',
    'For now, reply "ready" and stop. Do not check anything yet.',
  ].join('\n')
}

export function goalJudgeActivationNote(m: WorkflowKernel, goal: string) {
  return [
    `Goal check. The goal: "${goal}"`,
    '',
    'Judge ONLY whether the goal is met right now:',
    '1. Prefer deterministic, executable checks — run the test suite, linter, build, or a script in the workspace — over impressions.',
    '2. Then CALL the mcp__orrery_membrane__report TOOL exactly once with a typed verdict:',
    '   - {"type":"verdict","verdict":"done","summary":"<one-line proof, e.g. the passing command>"} if the goal is met.',
    '   - {"type":"verdict","verdict":"fail","summary":"<what is missing>","issues":[{"message":"<concrete failure to fix>"}]} if not.',
    '3. The verdict only counts when submitted through that tool call — a verdict written as a plain chat message is discarded and the goal loop stalls.',
    '4. Do not fix anything yourself. Do not ask questions. Report via the tool, then stop.',
  ].join('\n')
}

// Deliberately goal-free: the worker acts on the judge's TYPED verdict
// and issues only — the user's natural language stays in judge prompts
// (design constraint 1), and the worker never re-interprets the goal.
export function goalWorkerRetryNote(m: WorkflowKernel) {
  return [
    'The goal judge reported the goal is not met yet.',
    'Its verdict and issues are delivered in your context channel. Fix exactly those failures, then finish your turn so the judge can check again.',
  ].join('\n')
}

// Concurrent-compile guard: the duplicate scan below is a read over live
// state, and judge creation awaits — two overlapping calls could both
// pass the scan and leave two rings on one worker (TOCTOU).
export function captureWorkflowSession(m: WorkflowKernel, sessionId: string) {
  return {
    session: clone(m.state.sessions[sessionId]),
    nodeStatus: m.state.nodes.find((node) => node.sessionId === sessionId)?.status,
    channel: m.channelStore.checkpoint(sessionId),
  }
}

export function restoreWorkflowSession(m: WorkflowKernel, sessionId: string, checkpoint) {
  const run = m.runs.get(sessionId)
  if (run) {
    m.workflowCompensatedRuns.add(sessionId)
    try {
      run.kill()
    } catch {
      // The failed provider may already be closing.
    }
  }
  m.runContext.delete(sessionId)
  m.state.sessions[sessionId] = checkpoint.session
  const node = m.state.nodes.find((candidate) => candidate.sessionId === sessionId)
  if (node && checkpoint.nodeStatus) node.status = checkpoint.nodeStatus
  m.channelStore.restore(sessionId, checkpoint.channel)
}

// A COMPILED goal ring, not just an id-prefix match: author_subscription
// accepts user-chosen ids, so the duplicate guard and the stop pairing
// demand the preset's full fingerprint — reciprocal session participants
// AND the compiled trigger/action/stop shape on both edges. (A pair that
// reproduces all of this by hand IS a goal loop in every observable
// respect, so treating it as one is the correct semantics, not a spoof.)
export function isGoalPairShape(m: WorkflowKernel, check, retry) {
  return Boolean(
    check &&
    retry &&
    /^goal-check-/.test(check.id ?? '') &&
    retry.id === check.id.replace(/^goal-check-/, 'goal-retry-') &&
    check.source?.kind === 'session' &&
    retry.source?.kind === 'session' &&
    retry.source.sessionId === check.target?.sessionId &&
    retry.target?.sessionId === check.source.sessionId &&
    check.on?.on === 'finished' &&
    retry.on?.on === 'report' &&
    retry.on?.match?.type === 'verdict' &&
    retry.on?.match?.verdict === 'fail' &&
    check.action?.kind === 'deliver+activate' &&
    retry.action?.kind === 'deliver+activate' &&
    check.stop?.whenReport?.verdict === 'done' &&
    retry.stop?.whenReport?.verdict === 'done',
  )
}

export function isCompiledGoalCheckEdge(m: WorkflowKernel, subscription) {
  if (
    subscription.state !== 'active' ||
    !/^goal-check-/.test(subscription.id ?? '')
  ) {
    return false
  }
  const retry =
    m.state.subscriptions?.[
      subscription.id.replace(/^goal-check-/, 'goal-retry-')
    ]
  return isGoalPairShape(m, subscription, retry)
}

// The L6 review-until-clean template's ring fingerprint, the goal-pair
// discipline applied to review edges: coder finished → reviewer, reviewer
// report(issues) → coder, both stopping at verdict clean. Without this,
// a cap-stopped review-pass leaves review-fix lingering active — the
// canvas badge says stopped while a zombie reverse edge pollutes lists.
export function isReviewPairShape(m: WorkflowKernel, pass, fix) {
  return Boolean(
    pass &&
    fix &&
    /^review-pass-/.test(pass.id ?? '') &&
    fix.id === pass.id.replace(/^review-pass-/, 'review-fix-') &&
    pass.source?.kind === 'session' &&
    fix.source?.kind === 'session' &&
    fix.source.sessionId === pass.target?.sessionId &&
    fix.target?.sessionId === pass.source.sessionId &&
    pass.on?.on === 'finished' &&
    fix.on?.on === 'report' &&
    fix.on?.match?.type === 'verdict' &&
    fix.on?.match?.verdict === 'issues' &&
    pass.action?.kind === 'deliver+activate' &&
    fix.action?.kind === 'deliver+activate' &&
    pass.stop?.whenReport?.verdict === 'clean' &&
    fix.stop?.whenReport?.verdict === 'clean',
  )
}

export function activeReviewPairRole(m: WorkflowKernel, sessionId) {
  for (const pass of Object.values(
    (m.state.subscriptions ?? {}) as JsonRecord,
  )) {
    if (
      pass.state !== 'active' ||
      pass.source?.kind !== 'session' ||
      !/^review-pass-/.test(pass.id ?? '')
    ) {
      continue
    }
    const fix =
      m.state.subscriptions?.[
        pass.id.replace(/^review-pass-/, 'review-fix-')
      ]
    if (fix?.state === 'active' && isReviewPairShape(m, pass, fix)) {
      if (pass.source.sessionId === sessionId) return 'Coder'
      if (pass.target?.sessionId === sessionId) return 'Reviewer'
    }
  }
  return undefined
}

// P3 static authoring compiler. The renderer sends its runtime-free Draft
// graph once; this command creates every new Agent in prepared state,
// installs every Relationship, and only then starts root Agents. Draft ids
// are returned as an explicit mapping and never enter the kernel log.
export async function startDraftWorkflow(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_draft_workflow',
      actor: { kind: 'human' },
      input,
    })
  }
  const graph = input.graph as any
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
  const validation = validateDraftGraph(graph, {
    sessions: sessionSummaries,
    providerInstanceIds: m.state.providerInstances.map(
      (instance) => instance.providerInstanceId,
    ),
  })
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => issue.message).join(' '))
  }
  const ctx = m.humanCtx()
  const createdSessionIds: string[] = []
  const subscriptionIds: string[] = []
  const nodeSessionIds = {}
  const relationSubscriptionIds = {}
  const preparedRuns = new Map()
  const existingCheckpoints = new Map()

  try {
    // Instantiate in graph dependency order, not visual creation order.
    // A new Review target must bind to the Coder's FINAL cwd (especially
    // after worktree creation), so its source has to exist first.
    const pendingNodeIds = new Set(graph.nodeOrder)
    const instantiationOrder: string[] = []
    while (pendingNodeIds.size > 0) {
      const ready = graph.nodeOrder.filter(
        (draftNodeId) =>
          pendingNodeIds.has(draftNodeId) &&
          graph.relationOrder.every((relationId) => {
            const relation = graph.relations[relationId]
            return (
              relation.targetNodeId !== draftNodeId ||
              !pendingNodeIds.has(relation.sourceNodeId)
            )
          }),
      )
      if (ready.length === 0) {
        throw new Error('Draft workflow needs an acyclic starting order.')
      }
      for (const draftNodeId of ready) {
        pendingNodeIds.delete(draftNodeId)
        instantiationOrder.push(draftNodeId)
      }
    }

    for (const draftNodeId of instantiationOrder) {
      const draftNode = graph.nodes[draftNodeId]
      const endpoint = draftNode.endpoint
      if (endpoint.kind === 'existing') {
        m.assertActivatable(endpoint.sessionId, ctx)
        nodeSessionIds[draftNodeId] = endpoint.sessionId
        existingCheckpoints.set(endpoint.sessionId, {
          session: clone(m.state.sessions[endpoint.sessionId]),
          nodeStatus: m.state.nodes.find(
            (node) => node.sessionId === endpoint.sessionId,
          )?.status,
        })
        continue
      }

      const sourceReview = graph.relationOrder
        .map((relationId) => graph.relations[relationId])
        .find(
          (relation) =>
            relation.kind === 'review-loop' &&
            relation.sourceNodeId === draftNodeId,
        )
      const targetReview = graph.relationOrder
        .map((relationId) => graph.relations[relationId])
        .find(
          (relation) =>
            relation.kind === 'review-loop' &&
            relation.targetNodeId === draftNodeId,
        )
      const prompt = sourceReview
        ? coderActivationInstruction(endpoint.prompt)
        : targetReview
          ? reviewerBootstrapInstruction(
              optionalTrimmedString(targetReview.instruction) ??
                endpoint.prompt,
            )
          : endpoint.prompt
      const reviewSourceSessionId = targetReview
        ? nodeSessionIds[targetReview.sourceNodeId]
        : undefined
      const reviewSource = reviewSourceSessionId
        ? m.state.sessions[reviewSourceSessionId]
        : undefined
      const created = await m.cmdCreateSession(
        {
          prompt,
          // P1 workspace contract: a Reviewer observes the exact checkout
          // the Coder changed. Its independent provider settings remain,
          // but workspace/worktree settings do not fork the review target.
          cwd: reviewSource?.cwd ?? endpoint.cwd,
          workMode: reviewSource ? 'local' : endpoint.workMode,
          branch: reviewSource ? undefined : endpoint.branch,
          label: endpoint.label,
          providerKind: endpoint.providerKind,
          providerInstanceId: endpoint.providerInstanceId,
          runtimeSettings: endpoint.runtimeSettings,
        },
        ctx,
        {
          deferStart: true,
          position: draftNode.position,
        },
      )
      nodeSessionIds[draftNodeId] = created.sessionId
      createdSessionIds.push(created.sessionId)
      preparedRuns.set(created.sessionId, created.preparedRun)
    }

    for (const relationId of graph.relationOrder) {
      const relation = graph.relations[relationId]
      if (relation.kind !== 'review-loop') continue
      const sourceSessionId = nodeSessionIds[relation.sourceNodeId]
      const targetSessionId = nodeSessionIds[relation.targetNodeId]
      if (
        m.state.sessions[sourceSessionId]?.cwd !==
        m.state.sessions[targetSessionId]?.cwd
      ) {
        throw new Error(
          'Coder and Reviewer must use the same workspace so the Reviewer can verify the diff.',
        )
      }
    }

    for (const relationId of graph.relationOrder) {
      const relation = graph.relations[relationId]
      const compiled = compileDraftRelation(graph, relationId)
      const sourceSessionId = nodeSessionIds[relation.sourceNodeId]
      const targetSessionId = nodeSessionIds[relation.targetNodeId]
      if (compiled.kind === 'subscription') {
        const subscriptionId = `draft-${randomUUID().slice(0, 8)}`
        subscriptionIds.push(subscriptionId)
        m.cmdAuthorSubscription(
          {
            id: subscriptionId,
            label: compiled.label,
            sourceSessionId,
            on: compiled.on,
            targetSessionId,
            action: compiled.action,
            gate: 'auto',
            concurrency: 'coalesce',
            stop: compiled.stop,
            onStop: 'freeze-edge',
          },
          ctx,
        )
        relationSubscriptionIds[relationId] = [subscriptionId]
        continue
      }

      const suffix = randomUUID().slice(0, 8)
      const passId = `review-pass-${suffix}`
      const fixId = `review-fix-${suffix}`
      subscriptionIds.push(passId, fixId)
      const stop = {
        whenReport: { verdict: 'clean' },
        maxFirings: compiled.input.maxLaps,
      }
      m.cmdAuthorSubscription(
        {
          id: passId,
          label: 'review pass',
          preset: 'review-workflow',
          sourceSessionId,
          on: { on: 'finished' },
          targetSessionId,
          action: {
            kind: 'deliver+activate',
            topic: 'diff',
            note: reviewerActivationInstruction(
              compiled.input.reviewer.instruction,
              compiled.input.blocking,
            ),
          },
          gate: 'auto',
          concurrency: 'coalesce',
          stop,
          onStop: 'freeze-edge',
        },
        ctx,
      )
      m.cmdAuthorSubscription(
        {
          id: fixId,
          label: 'blocking issues',
          preset: 'review-workflow',
          sourceSessionId: targetSessionId,
          on: {
            on: 'report',
            match: { type: 'verdict', verdict: 'issues' },
          },
          targetSessionId: sourceSessionId,
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
      relationSubscriptionIds[relationId] = [passId, fixId]
    }

    const targets = new Set(
      graph.relationOrder.map(
        (relationId) => graph.relations[relationId].targetNodeId,
      ),
    )
    const rootNodeIds = graph.nodeOrder.filter((id) => !targets.has(id))
    if (rootNodeIds.length === 0) {
      throw new Error('Draft workflow needs at least one starting Agent.')
    }
    for (const draftNodeId of rootNodeIds) {
      const endpoint = graph.nodes[draftNodeId].endpoint
      const sessionId = nodeSessionIds[draftNodeId]
      if (endpoint.kind === 'new') {
        const preparedRun = preparedRuns.get(sessionId)
        delete m.state.sessions[sessionId].prepared
        await m.startRun(sessionId, {
          ...preparedRun,
          runKind: 'create',
        })
      } else {
        const sourceReview = graph.relationOrder
          .map((relationId) => graph.relations[relationId])
          .some(
            (relation) =>
              relation.kind === 'review-loop' &&
              relation.sourceNodeId === draftNodeId,
          )
        await m.cmdResumeSession(
          {
            sessionId,
            message: sourceReview
              ? coderActivationInstruction(endpoint.prompt)
              : endpoint.prompt,
          },
          ctx,
        )
      }
      await settleProviderStart(m)
      if (m.state.sessions[sessionId]?.status === 'failed') {
        throw new Error(
          m.state.sessions[sessionId].error ??
            `The provider for ${draftNodeId} could not start.`,
        )
      }
    }

    return {
      mapping: {
        nodeSessionIds,
        relationSubscriptionIds,
      },
      createdSessionIds,
      subscriptionIds,
      state: m.getState(),
    }
  } catch (error) {
    for (const subscriptionId of subscriptionIds) {
      discardWorkflowSubscription(m, subscriptionId)
    }
    for (const sessionId of [...createdSessionIds].reverse()) {
      discardWorkflowSession(m, sessionId)
    }
    for (const [sessionId, checkpoint] of existingCheckpoints) {
      if (m.runs.has(sessionId)) continue
      m.state.sessions[sessionId] = checkpoint.session
      const node = m.state.nodes.find(
        (candidate) => candidate.sessionId === sessionId,
      )
      if (node && checkpoint.nodeStatus) node.status = checkpoint.nodeStatus
    }
    m.touch()
    m.broadcast({
      type: 'runtime.state',
      state: m.getState(),
    })
    throw error
  }
}

export async function startHandoffWorkflow(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_handoff_workflow',
      actor: { kind: 'human' },
      input,
    })
  }
  const sessions = Object.fromEntries(
    (Object.values(m.state.sessions) as JsonRecord[]).map((session) => [
      session.sessionId,
      {
        sessionId: session.sessionId,
        cwd: session.cwd,
        status: session.status,
        frozen: m.state.nodes.find((node) => node.sessionId === session.sessionId)?.frozen,
      },
    ]),
  )
  const validation = validateHandoffWorkflowStart(input as any, {
    sessions,
    providerInstanceIds: m.state.providerInstances.map((instance) => instance.providerInstanceId),
  })
  if (!validation.ok) throw new Error(validation.issues.map((issue) => issue.message).join(' '))

  const ctx = m.workflowCommandCtx()
  const createdSessionIds: string[] = []
  const subscriptionIds: string[] = []
  const deliveredTo: string[] = []
  const preparedRuns = new Map()
  const lockedSessionIds = [input.source, input.target]
    .filter((endpoint) => endpoint?.kind === 'existing')
    .map((endpoint) => endpoint.sessionId)
  if (lockedSessionIds.some((sessionId) => m.classicWorkflowInFlight.has(sessionId))) {
    throw new Error('One of these Agents is already being changed by another workflow; wait for it to finish.')
  }
  for (const sessionId of lockedSessionIds) m.classicWorkflowInFlight.add(sessionId)
  const existingCheckpoints = new Map(
    lockedSessionIds.map((sessionId) => [sessionId, captureWorkflowSession(m, sessionId)]),
  )
  const endpointSession = async (endpoint, role) => {
    if (endpoint.kind === 'existing') {
      m.assertActivatable(endpoint.sessionId, ctx)
      return endpoint.sessionId
    }
    const created = await m.cmdCreateSession(
      {
        prompt: endpoint.prompt,
        cwd: endpoint.cwd,
        workMode: endpoint.workMode,
        branch: endpoint.branch,
        label: endpoint.label || role,
        providerKind: endpoint.providerKind,
        providerInstanceId: endpoint.providerInstanceId,
        runtimeSettings: endpoint.runtimeSettings,
      },
      ctx,
      { deferStart: true },
    )
    createdSessionIds.push(created.sessionId)
    preparedRuns.set(created.sessionId, created.preparedRun)
    return created.sessionId
  }

  try {
    const sourceSessionId = await endpointSession(input.source, 'Source')
    const targetSessionId = await endpointSession(input.target, 'Receiver')
    const note = optionalTrimmedString(input.note)
    if (input.source.kind === 'new') {
      const subscriptionId = `handoff-once-${randomUUID().slice(0, 8)}`
      subscriptionIds.push(subscriptionId)
      m.cmdAuthorSubscription(
        {
          id: subscriptionId,
          label: 'handoff once',
          sourceSessionId,
          on: { on: 'finished' },
          targetSessionId,
          action: { kind: 'deliver+activate', topic: 'handoff', note },
          gate: 'auto',
          concurrency: 'coalesce',
          stop: { maxFirings: 1 },
          onStop: 'freeze-edge',
        },
        ctx,
      )
      delete m.state.sessions[sourceSessionId].prepared
      await m.startRun(sourceSessionId, {
        ...preparedRuns.get(sourceSessionId),
        runKind: 'create',
      })
      await settleProviderStart(m)
      if (m.state.sessions[sourceSessionId]?.status === 'failed') {
        throw new Error(m.state.sessions[sourceSessionId].error ?? 'The Source provider could not start.')
      }
    } else {
      m.assertActivatable(targetSessionId, ctx)
      m.cmdDeliver({ sessionId: targetSessionId, source: sourceSessionId, topic: 'handoff' }, ctx)
      await m.cmdActivate({ sessionId: targetSessionId, note, edgeSourceSessionId: sourceSessionId }, ctx)
      await settleProviderStart(m)
      if (m.state.sessions[targetSessionId]?.status === 'failed') {
        throw new Error(m.state.sessions[targetSessionId].error ?? 'The Receiver provider could not start.')
      }
      deliveredTo.push(targetSessionId)
    }
    return { sourceSessionId, targetSessionId, createdSessionIds, subscriptionIds, deliveredTo, state: m.getState() }
  } catch (error) {
    for (const id of subscriptionIds) discardWorkflowSubscription(m, id)
    for (const id of [...createdSessionIds].reverse()) discardWorkflowSession(m, id)
    for (const [sessionId, checkpoint] of existingCheckpoints) {
      restoreWorkflowSession(m, sessionId, checkpoint)
    }
    m.touch()
    m.broadcast({ type: 'runtime.state', state: m.getState() })
    throw error
  } finally {
    for (const sessionId of lockedSessionIds) m.classicWorkflowInFlight.delete(sessionId)
  }
}

export async function startGoalWorkflow(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'start_goal_workflow',
      actor: { kind: 'human' },
      input,
    })
  }
  const sessions = Object.fromEntries(
    (Object.values(m.state.sessions) as JsonRecord[]).map((session) => [
      session.sessionId,
      {
        sessionId: session.sessionId,
        cwd: session.cwd,
        status: session.status,
        frozen: m.state.nodes.find((node) => node.sessionId === session.sessionId)?.frozen,
      },
    ]),
  )
  const validation = validateGoalWorkflowStart(input as any, {
    sessions,
    providerInstanceIds: m.state.providerInstances.map((instance) => instance.providerInstanceId),
  })
  if (!validation.ok) throw new Error(validation.issues.map((issue) => issue.message).join(' '))

  const ctx = m.workflowCommandCtx()
  const createdSessionIds: string[] = []
  let workerSessionId
  let preparedRun
  let goalResult
  const lockedSessionIds = input.worker?.kind === 'existing' ? [input.worker.sessionId] : []
  if (lockedSessionIds.some((sessionId) => m.classicWorkflowInFlight.has(sessionId))) {
    throw new Error('This Worker is already being changed by another workflow; wait for it to finish.')
  }
  for (const sessionId of lockedSessionIds) m.classicWorkflowInFlight.add(sessionId)
  const existingCheckpoint = input.worker.kind === 'existing'
    ? captureWorkflowSession(m, input.worker.sessionId)
    : undefined
  try {
    if (input.worker.kind === 'new') {
      const created = await m.cmdCreateSession(
        {
          prompt: input.worker.prompt,
          cwd: input.worker.cwd,
          workMode: input.worker.workMode,
          branch: input.worker.branch,
          label: input.worker.label || 'Worker',
          providerKind: input.worker.providerKind,
          providerInstanceId: input.worker.providerInstanceId,
          runtimeSettings: input.worker.runtimeSettings,
        },
        ctx,
        { deferStart: true },
      )
      workerSessionId = created.sessionId
      preparedRun = created.preparedRun
      createdSessionIds.push(workerSessionId)
    } else {
      workerSessionId = input.worker.sessionId
      m.assertActivatable(workerSessionId, ctx)
    }
    goalResult = await createGoalLoop(m, {
      workerSessionId,
      goal: input.goal,
      maxLaps: input.maxLaps,
      judgeProviderInstanceId: input.judgeProviderInstanceId,
      judgeModel: input.judgeModel,
      judgeRuntimeSettings: input.judgeRuntimeSettings,
      preset: 'workflow:goal',
    })
    createdSessionIds.push(goalResult.judgeSessionId)
    if (input.worker.kind === 'new') {
      delete m.state.sessions[workerSessionId].prepared
      await m.startRun(workerSessionId, { ...preparedRun, runKind: 'create' })
    } else {
      await m.cmdResumeSession({ sessionId: workerSessionId, message: input.worker.prompt }, ctx)
    }
    await settleProviderStart(m)
    const workerSession = m.state.sessions[workerSessionId]
    if (!workerSession || workerSession.status === 'failed' || workerSession.status === 'killed') {
      throw new Error(workerSession?.error ?? `The Worker provider could not start (${workerSession?.status ?? 'missing'}).`)
    }
    const judgeSession = m.state.sessions[goalResult.judgeSessionId]
    if (!judgeSession || judgeSession.status === 'failed' || judgeSession.status === 'killed') {
      throw new Error(
        `The Judge provider could not start: ${judgeSession?.error ?? judgeSession?.status ?? 'missing session'}`,
      )
    }
    const subscriptionIds = [goalResult.checkSubscription.id, goalResult.retrySubscription.id]
    if (subscriptionIds.some((id) => m.state.subscriptions[id]?.state !== 'active')) {
      throw new Error('The Goal relationships stopped while the Worker and Judge were starting.')
    }
    return {
      workerSessionId,
      judgeSessionId: goalResult.judgeSessionId,
      createdSessionIds,
      subscriptionIds,
      loop: loopsOf(m.kernelView()).find((loop) => loop.subscriptionIds.includes(goalResult.checkSubscription.id)),
      state: m.getState(),
    }
  } catch (error) {
    if (goalResult) {
      discardWorkflowSubscription(m, goalResult.checkSubscription.id)
      discardWorkflowSubscription(m, goalResult.retrySubscription.id)
    }
    for (const id of [...createdSessionIds].reverse()) discardWorkflowSession(m, id)
    if (input.worker.kind === 'existing' && existingCheckpoint) {
      restoreWorkflowSession(m, input.worker.sessionId, existingCheckpoint)
    }
    m.touch()
    m.broadcast({ type: 'runtime.state', state: m.getState() })
    throw error
  } finally {
    for (const sessionId of lockedSessionIds) m.classicWorkflowInFlight.delete(sessionId)
  }
}

// P3 dynamic authoring compiler. Current-result is an immediate command;
// next-completion is standing intent. Both paths share one preflight and
// one compensation boundary so the renderer never assembles half a
// Relationship from low-level HTTP/IPC calls.
export async function connectAgents(m: WorkflowKernel, input: JsonRecord = {}) {
  if (!m.controlCommandContext.getStore()) {
    return m.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : undefined,
      kind: 'connect_agents',
      actor: { kind: 'human' },
      input,
    })
  }
  const validation = validateAgentConnection(
    input as any,
    m.state.providerInstances.map(
      (instance) => instance.providerInstanceId,
    ),
  )
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => issue.message).join(' '))
  }
  const sourceSessionId = optionalTrimmedString(input.sourceSessionId)
  const source = m.state.sessions[sourceSessionId]
  if (!source) throw new Error(`Unknown source Agent: ${sourceSessionId}`)
  if (source.status === 'killed')
    throw new Error('Killed Agent cannot be connected.')
  if (
    input.timing === 'current-result' &&
    (source.status === 'running' || source.status === 'pending')
  ) {
    throw new Error(
      'The source Agent is still working. Wait for next completion to avoid delivering a partial workspace.',
    )
  }

  const targetInput = input.target as JsonRecord
  const behavior = input.behavior
  const instruction = optionalTrimmedString(input.instruction)
  const compiled = compileAgentConnection(input as any)
  const ctx = m.humanCtx()
  const createdSessionIds: string[] = []
  const subscriptionIds: string[] = []
  let targetSessionId: string
  let existingCheckpoint

  try {
    if (targetInput.kind === 'new') {
      const reviewerLike = [
        'one-review',
        'keep-reviewing',
        'review-loop',
      ].includes(behavior)
      const created = await m.cmdCreateSession(
        {
          prompt:
            behavior === 'review-loop'
              ? reviewerBootstrapInstruction(instruction)
              : reviewerLike
                ? `You are a Reviewer connected from another Orrery Agent. ${instruction}`
                : instruction,
          cwd: optionalTrimmedString(targetInput.cwd) ?? source.cwd,
          workMode: 'local',
          label: targetInput.label,
          providerKind: targetInput.providerKind,
          providerInstanceId: targetInput.providerInstanceId,
          runtimeSettings: targetInput.runtimeSettings,
        },
        ctx,
        {
          deferStart: true,
          position: targetInput.position,
        },
      )
      targetSessionId = created.sessionId
      createdSessionIds.push(targetSessionId)
    } else {
      targetSessionId = optionalTrimmedString(targetInput.sessionId)
      m.assertActivatable(targetSessionId, ctx)
      existingCheckpoint = {
        session: clone(m.state.sessions[targetSessionId]),
        nodeStatus: m.state.nodes.find(
          (node) => node.sessionId === targetSessionId,
        )?.status,
      }
    }
    if (targetSessionId === sourceSessionId)
      throw new Error('Connect two different Agents.')
    if (
      ['one-review', 'keep-reviewing', 'review-loop'].includes(behavior) &&
      m.state.sessions[targetSessionId].cwd !== source.cwd
    ) {
      throw new Error(
        'Coder and Reviewer must use the same workspace so the Reviewer can verify the diff.',
      )
    }

    let forwardSubscriptionId
    if (compiled.relationships.length === 2) {
      const suffix = randomUUID().slice(0, 8)
      const passId = `review-pass-${suffix}`
      const fixId = `review-fix-${suffix}`
      subscriptionIds.push(passId, fixId)
      const review = (input.review as JsonRecord) ?? {
        blocking: { mode: 'p0-p1' },
        maxLaps: defaultCycleMaxFirings,
      }
      const stop = {
        whenReport: { verdict: 'clean' },
        maxFirings: Number(review.maxLaps),
      }
      m.cmdAuthorSubscription(
        {
          id: passId,
          label: 'review pass',
          preset: 'review-workflow',
          sourceSessionId,
          on: { on: 'finished' },
          targetSessionId,
          action: {
            kind: 'deliver+activate',
            topic: 'diff',
            note: reviewerActivationInstruction(
              instruction,
              review.blocking as any,
            ),
          },
          gate: 'auto',
          concurrency: 'coalesce',
          stop,
          onStop: 'freeze-edge',
        },
        ctx,
      )
      m.cmdAuthorSubscription(
        {
          id: fixId,
          label: 'blocking issues',
          preset: 'review-workflow',
          sourceSessionId: targetSessionId,
          on: {
            on: 'report',
            match: { type: 'verdict', verdict: 'issues' },
          },
          targetSessionId: sourceSessionId,
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
      forwardSubscriptionId = passId
    } else if (!compiled.immediate || behavior === 'keep-reviewing') {
      const subscriptionId = `connect-${randomUUID().slice(0, 8)}`
      subscriptionIds.push(subscriptionId)
      const reviewLike = behavior !== 'handoff-once'
      m.cmdAuthorSubscription(
        {
          id: subscriptionId,
          label:
            behavior === 'handoff-once'
              ? 'handoff once'
              : behavior === 'one-review'
                ? 'one review'
                : 'review future turns',
          sourceSessionId,
          on: { on: 'finished' },
          targetSessionId,
          action: {
            kind: 'deliver+activate',
            topic: reviewLike ? 'diff' : 'handoff',
            note: instruction,
          },
          gate: 'auto',
          concurrency: 'coalesce',
          ...(behavior === 'handoff-once' || behavior === 'one-review'
            ? { stop: { maxFirings: 1 } }
            : {}),
          onStop: 'freeze-edge',
        },
        ctx,
      )
      forwardSubscriptionId = subscriptionId
    }

    if (compiled.immediate) {
      if (forwardSubscriptionId) {
        const subscription = m.state.subscriptions[forwardSubscriptionId]
        const startedEvent = m.appendKernelEvent(
          'relationship.started',
          {
            sessionId: sourceSessionId,
            targetSessionId,
            subscriptionId: forwardSubscriptionId,
          },
          ctx,
          {
            reason:
              'The user connected the current result to this Relationship.',
          },
        )
        await m.createPendingActivation(
          {
            kind: 'pend-activation',
            subscriptionId: forwardSubscriptionId,
            target: targetSessionId,
            action: subscription.action,
            gate: subscription.gate,
            triggerEventId: startedEvent?.id,
          },
          startedEvent,
          m.subscriptionRuleCtx(forwardSubscriptionId, startedEvent?.id),
        )
        // Product transports wrap connect_agents in dispatchCommand and
        // drain only after the durable commit. The legacy in-process API
        // used by kernel tests has no outer command boundary, so it must
        // perform the equivalent drain here.
        if (!m.controlCommandContext.getStore()) {
          await m.drainApprovedSlots()
        }
      } else {
        m.cmdDeliver(
          {
            sessionId: targetSessionId,
            source: sourceSessionId,
            topic: behavior === 'handoff-once' ? 'handoff' : 'diff',
            note: instruction,
          },
          ctx,
        )
        await m.cmdActivate(
          {
            sessionId: targetSessionId,
            note: instruction,
            edgeSourceSessionId: sourceSessionId,
          },
          ctx,
        )
      }
    }

    return {
      targetSessionId,
      createdSessionIds,
      subscriptionIds,
      state: m.getState(),
    }
  } catch (error) {
    for (const subscriptionId of subscriptionIds)
      discardWorkflowSubscription(m, subscriptionId)
    for (const sessionId of [...createdSessionIds].reverse())
      discardWorkflowSession(m, sessionId)
    if (
      existingCheckpoint &&
      targetSessionId &&
      !m.runs.has(targetSessionId)
    ) {
      m.state.sessions[targetSessionId] = existingCheckpoint.session
      const node = m.state.nodes.find(
        (candidate) => candidate.sessionId === targetSessionId,
      )
      if (node && existingCheckpoint.nodeStatus)
        node.status = existingCheckpoint.nodeStatus
    }
    m.touch()
    m.broadcast({
      type: 'runtime.state',
      state: m.getState(),
    })
    throw error
  }
}

export function planCouncilHistory(m: WorkflowKernel, council, type, summary) {
  const ts = now()
  council.updatedAt = ts
  council.history.push({
    id: randomUUID(),
    type,
    ts,
    phase: council.phase,
    summary,
  })
}

export function advanceWorkflowDeployment(
  m: WorkflowKernel,
  deploymentId: string,
  stage: string,
  journal: JsonRecord = {},
  status = 'in_progress',
) {
  const transaction = m.controlCommandContext.getStore()
  if (transaction && transaction.closed !== true) {
    transaction.workflowDeploymentIds.add(deploymentId)
  }
  if (
    status === 'completed' &&
    transaction &&
    transaction.closed !== true
  ) {
    const current = m.kernelStore.getWorkflowDeployment(deploymentId)
    if (!current) throw new Error(`Unknown workflow deployment: ${deploymentId}`)
    transaction.deploymentFinalizations.push({
      deploymentId,
      stage,
      status,
      journal,
    })
    return {
      ...current,
      stage,
      status,
      journal: { ...current.journal, ...journal },
    }
  }
  const deployment = m.kernelStore.updateWorkflowDeployment(deploymentId, {
    stage,
    status,
    journal,
  })
  if (
    status === 'in_progress' &&
    m.workflowDeploymentCrashAfterStage === stage
  ) {
    const error = new Error(
      `Injected workflow deployment crash after ${stage}.`,
    ) as Error & { code?: string }
    error.code = 'ORRERY_DEPLOYMENT_CRASH'
    throw error
  }
  return deployment
}

export function automaticDeploymentExistingSessionIds(m: WorkflowKernel, kind: string, input: JsonRecord) {
  if (kind === 'commit_workflow') {
    const proposalId = optionalTrimmedString(input.proposalId)
    const proposal = proposalId ? m.state.workflowProposals?.[proposalId] : undefined
    const recipeInput = proposal?.proposedPlan?.recipeInput
    if (!recipeInput) return []
    if (proposal.patch) {
      const active = m.activeWorkflowPlan(proposal.workflowId)
      const councilId = active?.executionMapping?.productWorkflowId
      const council = councilId ? m.state.planCouncils?.[councilId] : undefined
      return [...new Set([
        ...Object.values(active?.executionMapping?.participantSessionIds ?? {}),
        council?.coordinatorSessionId,
      ].filter(Boolean))]
    }
    if (recipeInput.recipe === 'review') {
      return [recipeInput.input?.coder, recipeInput.input?.reviewer]
        .filter((endpoint) => endpoint?.kind === 'existing')
        .map((endpoint) => endpoint.sessionId)
    }
    if (recipeInput.recipe === 'goal') {
      return recipeInput.input?.worker?.kind === 'existing'
        ? [recipeInput.input.worker.sessionId]
        : []
    }
    if (recipeInput.recipe === 'handoff') {
      return [recipeInput.input?.source, recipeInput.input?.target]
        .filter((endpoint) => endpoint?.kind === 'existing')
        .map((endpoint) => endpoint.sessionId)
    }
    return optionalTrimmedString(recipeInput.input?.coordinatorSessionId)
      ? [recipeInput.input.coordinatorSessionId]
      : []
  }
  if (kind === 'resume_session' || kind === 'activate') {
    return optionalTrimmedString(input.sessionId) ? [input.sessionId] : []
  }
  if (kind === 'rule_execute_activation') {
    const slot = m.state.pendingActivations?.[input.slotKey]
    return slot?.target ? [slot.target] : []
  }
  if (kind === 'connect_agents') {
    return [
      optionalTrimmedString(input.sourceSessionId),
      input.target?.kind === 'existing'
        ? optionalTrimmedString(input.target.sessionId)
        : undefined,
    ].filter(Boolean)
  }
  if (
    kind === 'start_plan_council_cross_review' ||
    kind === 'start_plan_council_synthesis' ||
    kind === 'retry_plan_council_participant'
  ) {
    const workflowId = optionalTrimmedString(input.workflowId ?? input.runId)
    const council = workflowId
      ? m.state.planCouncils?.[workflowId] ??
        Object.values(m.state.planCouncils ?? {}).find(
          (candidate: JsonRecord) => candidate.runId === workflowId,
        )
      : undefined
    return council
      ? [...new Set([...council.participantOrder, council.coordinatorSessionId].filter(Boolean))]
      : []
  }
  if (kind === 'start_handoff_workflow') {
    return [input.source, input.target]
      .filter((endpoint) => endpoint?.kind === 'existing')
      .map((endpoint) => endpoint.sessionId)
  }
  if (kind === 'start_goal_workflow') {
    return input.worker?.kind === 'existing' ? [input.worker.sessionId] : []
  }
  if (kind === 'start_draft_workflow') {
    const graph = input.graph
    return Object.values(graph?.nodes ?? {})
      .map((node: JsonRecord) => node.endpoint)
      .filter((endpoint) => endpoint?.kind === 'existing')
      .map((endpoint) => endpoint.sessionId)
  }
  return []
}

export function journalPlannedWorkflowResource(m: WorkflowKernel, descriptor) {
  const transaction = m.controlCommandContext.getStore()
  if (!transaction || transaction.closed === true) return
  const deploymentIds = new Set([
    ...(transaction.workflowDeploymentIds ?? []),
    ...(transaction.automaticDeploymentId
      ? [transaction.automaticDeploymentId]
      : []),
  ])
  for (const deploymentId of deploymentIds) {
    const deployment = m.kernelStore.getWorkflowDeployment(deploymentId)
    if (!deployment || deployment.status !== 'in_progress') continue
    const createdSessionIds = [
      ...new Set([...(deployment.journal.createdSessionIds ?? []), descriptor.sessionId]),
    ]
    const resources = [
      ...(deployment.journal.createdSessionResources ?? []).filter(
        (candidate) => candidate.sessionId !== descriptor.sessionId,
      ),
      descriptor,
    ]
    m.kernelStore.updateWorkflowDeployment(deploymentId, {
      journal: {
        createdSessionIds,
        createdSessionResources: resources,
        resourceIntentAt: now(),
      },
    })
  }
}

export function updateAutomaticDeployment(m: WorkflowKernel, stage: string, journal: JsonRecord = {}) {
  const transaction = m.controlCommandContext.getStore()
  const deploymentId = transaction?.automaticDeploymentId
  if (!deploymentId || transaction.closed === true) return
  m.kernelStore.updateWorkflowDeployment(deploymentId, {
    stage,
    journal,
  })
  if (m.workflowDeploymentCrashAfterStage === stage) {
    const error = new Error(`Injected workflow deployment crash after ${stage}.`)
    ;(error as Error & { code?: string }).code = 'ORRERY_DEPLOYMENT_CRASH'
    throw error
  }
}

export function journalAutomaticDeploymentResources(m: WorkflowKernel) {
  const transaction = m.controlCommandContext.getStore()
  if (!transaction?.automaticDeploymentId || transaction.closed === true) return
  const deployment = m.kernelStore.getWorkflowDeployment(
    transaction.automaticDeploymentId,
  )
  const createdSessionIds = Object.keys(m.state.sessions).filter(
    (sessionId) => !m.committedStateDuringCommand?.sessions?.[sessionId],
  )
  const createdSubscriptionIds = Object.keys(m.state.subscriptions ?? {}).filter(
    (subscriptionId) =>
      !m.committedStateDuringCommand?.subscriptions?.[subscriptionId],
  )
  updateAutomaticDeployment(m, 
    createdSubscriptionIds.length > 0
      ? 'graph-committed'
      : createdSessionIds.length > 0
        ? 'resources-created'
        : deployment?.stage ?? 'prepared',
    {
      createdSessionIds,
      createdSessionResources: workflowResourceDescriptors(m, createdSessionIds),
      createdSubscriptionIds,
    },
  )
}

export function journalAutomaticDeploymentRunStarted(m: WorkflowKernel, sessionId: string) {
  const transaction = m.controlCommandContext.getStore()
  const deploymentId = transaction?.automaticDeploymentId
  if (!deploymentId || transaction.closed === true) return
  journalAutomaticDeploymentResources(m)
  const deployment = m.kernelStore.getWorkflowDeployment(deploymentId)
  updateAutomaticDeployment(m, 'roots-started', {
    startedSessionIds: [
      ...new Set([...(deployment?.journal?.startedSessionIds ?? []), sessionId]),
    ],
  })
}

export function recoverWorkflowDeployments(m: WorkflowKernel) {
  for (const deployment of m.kernelStore.listWorkflowDeployments({
    status: 'in_progress',
  })) {
    const journal = deployment.journal ?? {}
    for (const subscriptionId of journal.createdSubscriptionIds ?? []) {
      discardWorkflowSubscription(m, subscriptionId)
    }
    for (const sessionId of [...(journal.createdSessionIds ?? [])].reverse()) {
      const descriptor = (journal.createdSessionResources ?? []).find(
        (candidate) => candidate.sessionId === sessionId,
      )
      if (m.state.sessions[sessionId]) {
        discardWorkflowSession(m, sessionId)
      } else if (descriptor) {
        cleanupWorkflowResourceDescriptor(m, descriptor)
      }
    }
    for (const [sessionId, checkpoint] of Object.entries(
      journal.existingSessionCheckpoints ?? {},
    )) {
      if (isObject(checkpoint)) {
        restoreWorkflowSession(m, sessionId, checkpoint)
      }
    }
    for (const [sessionId, checkpoint] of Object.entries(journal.channelCheckpoints ?? {})) {
      if (Array.isArray(checkpoint)) m.channelStore.restore(sessionId, checkpoint as any)
    }
    if (journal.artifactWorkflowId) {
      delete m.state.planCouncils?.[journal.artifactWorkflowId]
      m.channelStore.removeArtifacts(journal.artifactWorkflowId)
    }
    const reason = `Recovered incomplete deployment from stage ${deployment.stage}; compensated created resources.`
    m.kernelStore.updateWorkflowDeployment(deployment.deploymentId, {
      stage: 'aborted',
      status: 'aborted',
      journal: { recoveredAt: now(), reason },
    })
    m.appendKernelEvent(
      'workflow.deployment.aborted',
      {
        deploymentId: deployment.deploymentId,
        workflowId: deployment.workflowId,
        previousStage: deployment.stage,
      },
      { actor: { kind: 'runtime' } },
      { reason },
    )
  }
}

export function reconcileDynamicTopology(m: WorkflowKernel) {
  const groups = m.state.dynamicSpawnGroups ?? {}
  for (const group of Object.values(groups) as JsonRecord[]) {
    const seenItems = new Set<string>()
    for (const child of group.children ?? []) {
      const session = m.state.sessions[child.sessionId]
      if (seenItems.has(child.itemKey)) {
        child.status = 'recycled'
        child.error = 'Duplicate dynamic item reconciled after restart.'
        if (session) session.archived = true
        continue
      }
      seenItems.add(child.itemKey)
      if (!session) {
        child.status = 'failed'
        child.error = 'Dynamic participant was missing during restart reconciliation.'
        group.status = 'failed'
        group.reason = child.error
      } else if (['prepared', 'running'].includes(child.status) && ['failed', 'killed'].includes(session.status)) {
        child.status = session.status === 'failed' ? 'failed' : 'cancelled'
        child.error = session.error ?? 'Dynamic participant was interrupted by restart.'
        group.status = 'failed'
        group.reason = child.error
      }
    }
    group.updatedAt = now()
  }
  for (const session of Object.values(m.state.sessions) as JsonRecord[]) {
    const topology = session.dynamicTopology
    if (!topology || groups[topology.groupId]) continue
    session.archived = true
    m.appendKernelEvent(
      'dynamic.orphan.reconciled',
      { sessionId: session.sessionId, missingGroupId: topology.groupId },
      { actor: { kind: 'runtime' } },
      { reason: 'Archived a dynamic participant whose durable spawn group is missing.' },
    )
  }
}

export function getWorkflowDeployments(m: WorkflowKernel, input: JsonRecord = {}) {
  return {
    deployments: m.kernelStore.listWorkflowDeployments({
      status: optionalTrimmedString(input.status),
    }),
  }
}

