// Goal-loop preset and the template library (list/apply/save/remove).
// Split out of sessionManager.ts; kernel access goes through WorkflowKernel.
import {
  resolveGoalJudgeRuntime,
  validateGoalWorkflowStart,
  validateHandoffWorkflowStart,
} from '../../../shared/classic-workflow.js'
import {
  defaultCycleMaxFirings,
  externalSourceSummary,
  loopsOf,
} from '../../../shared/graph-core/index.js'
import {
  validateReviewWorkflowStart,
} from '../../../shared/review-workflow.js'
import {
  compileBuiltinTemplate,
  compileSavedTemplate,
  parameterizeSubscriptions,
  templateDescriptors,
} from '../../../shared/templates.js'
import {
  normalizeProviderRuntimeSettings,
} from '../providers/providerConfigNormalize.js'
import {
  clone,
  isObject,
  now,
  optionalTrimmedString,
  type JsonRecord,
  validSubscriptionGates,
  validSubscriptionOnStops,
} from '../runtimeCommon.js'
import {
  randomUUID,
} from 'node:crypto'
import type { WorkflowKernel } from './workflowKernel.js'
import {
  goalJudgeActivationNote,
  goalJudgeBootstrapPrompt,
  goalWorkerRetryNote,
  isCompiledGoalCheckEdge,
} from './classicWorkflows.js'

export async function createGoalLoop(m: WorkflowKernel, input: JsonRecord = {}) {
  const ctx = m.workflowCommandCtx()
  const workerSessionId = optionalTrimmedString(input.workerSessionId)
  const worker = workerSessionId
    ? m.state.sessions[workerSessionId]
    : undefined
  if (!worker) {
    throw new Error(
      `Unknown goal loop worker session: ${workerSessionId ?? ''}`,
    )
  }
  if (worker.status === 'killed') {
    throw new Error('Cannot set a goal on a killed session')
  }
  const goal = optionalTrimmedString(input.goal)
  if (!goal) {
    throw new Error('A goal loop requires a non-empty goal sentence')
  }
  const maxLaps =
    input.maxLaps === undefined
      ? defaultCycleMaxFirings
      : Number(input.maxLaps)
  if (!Number.isInteger(maxLaps) || maxLaps < 1 || maxLaps > 99) {
    throw new Error('Goal loop maxLaps must be an integer between 1 and 99')
  }
  const gate = optionalTrimmedString(input.gate) ?? 'auto'
  if (!validSubscriptionGates.has(gate)) {
    throw new Error('Goal loop gate must be auto, master, or human')
  }
  // Everything is validated BEFORE the judge session exists: an invalid
  // input must never leave a half-compiled preset behind.
  const onStop = optionalTrimmedString(input.onStop) ?? 'freeze-edge'
  if (!validSubscriptionOnStops.has(onStop)) {
    throw new Error(
      'Goal loop onStop must be freeze-edge, freeze-target, or freeze-cluster',
    )
  }
  const duplicate = Object.values(
    (m.state.subscriptions ?? {}) as JsonRecord,
  ).find(
    (subscription) =>
      subscription.source?.kind === 'session' &&
      subscription.source.sessionId === worker.sessionId &&
      isCompiledGoalCheckEdge(m, subscription),
  )
  if (duplicate) {
    throw new Error(
      `Session already has an active goal loop (${duplicate.id}); stop it before setting a new goal`,
    )
  }
  if (m.goalLoopInFlight.has(worker.sessionId)) {
    throw new Error(
      'A goal loop is already being created for this session; wait for it to finish',
    )
  }
  m.goalLoopInFlight.add(worker.sessionId)

  try {
    const workerLabel = worker.label ?? worker.sessionId
    // Cross-provider Judges keep the Worker's trust/reasoning policy, but
    // provider-specific model ids are cleared by the shared resolver.
    const judgeRuntime = resolveGoalJudgeRuntime(
      worker,
      m.state.providerInstances,
      optionalTrimmedString(input.judgeProviderInstanceId),
      optionalTrimmedString(input.judgeModel),
    )
    const judgeRuntimeSettings = isObject(input.judgeRuntimeSettings)
      ? normalizeProviderRuntimeSettings(input.judgeRuntimeSettings)
      : judgeRuntime.runtimeSettings
    const created = await m.cmdCreateSession(
      {
        prompt: goalJudgeBootstrapPrompt(m, workerLabel),
        cwd: worker.cwd,
        label: `${workerLabel} · judge`,
        providerKind: judgeRuntime.providerKind,
        providerInstanceId: judgeRuntime.providerInstanceId,
        // The judge inherits the worker's runtime settings: its checks run
        // in the same workspace under the same declared trust level (a
        // read-only judge could not even run the test suite the goal
        // demands), and the same model unless a provider override says so.
        ...(judgeRuntimeSettings
          ? {
              runtimeSettings: judgeRuntimeSettings,
            }
          : {}),
        sourceSessionId: worker.sessionId,
        linkLabel: 'goal judge',
      },
      ctx,
    )
    const judgeSessionId = created.sessionId

    // The worker was only validated before the awaited judge creation; a
    // kill landing inside that gap would otherwise leave an active ring
    // on a dead worker that the earlier kill sweep never saw. Everything
    // from here to the second authoring is synchronous, so this recheck
    // closes the gap.
    const workerNow = m.state.sessions[worker.sessionId]
    if (!workerNow || workerNow.status === 'killed') {
      try {
        m.killSession(judgeSessionId)
      } catch {
        // Best-effort cleanup; the throw below is the real signal.
      }
      throw new Error(
        'The worker session was killed while the goal loop was being created',
      )
    }

    // Neutral labels on purpose: the goal sentence would otherwise persist
    // in subscription.authored facts — it belongs in judge prompts only
    // (the check edge's note IS the judge's activation prompt).
    const suffix = randomUUID().slice(0, 8)
    const stop = {
      whenReport: { verdict: 'done' },
      maxFirings: maxLaps,
    }
    // Optional provenance tag (the L6 template library passes
    // `template:goal-loop`); pairing/stop logic never reads it.
    const preset = optionalTrimmedString(input.preset)
    // Compile compensation: authoring can fail after the judge exists
    // (static-check refusal, invalid input on a delegated call). Without
    // the unwind below, a half-compiled ring strands an orphan judge —
    // and the template executor's own rollback cannot reach resources it
    // never got ids for.
    let check
    let retry
    try {
      check = m.cmdAuthorSubscription(
        {
          id: `goal-check-${suffix}`,
          label: 'goal check',
          ...(preset ? { preset } : {}),
          sourceSessionId: worker.sessionId,
          on: { on: 'finished' },
          targetSessionId: judgeSessionId,
          action: {
            kind: 'deliver+activate',
            note: goalJudgeActivationNote(m, goal),
          },
          gate,
          stop,
          onStop,
        },
        ctx,
      )
      retry = m.cmdAuthorSubscription(
        {
          id: `goal-retry-${suffix}`,
          label: 'goal retry',
          ...(preset ? { preset } : {}),
          sourceSessionId: judgeSessionId,
          on: {
            on: 'report',
            match: { type: 'verdict', verdict: 'fail' },
          },
          targetSessionId: worker.sessionId,
          action: {
            kind: 'deliver+activate',
            note: goalWorkerRetryNote(m),
          },
          gate,
          stop,
          onStop,
        },
        ctx,
      )
    } catch (error) {
      if (check) {
        try {
          m.cmdStopSubscription(
            {
              subscriptionId: check.subscription.id,
              reason: 'Goal loop compile aborted before completing the ring.',
            },
            { actor: { kind: 'runtime' } },
          )
        } catch {
          // Best-effort cleanup; the rethrow below is the real signal.
        }
      }
      try {
        m.killSession(judgeSessionId)
      } catch {
        // Best-effort cleanup only.
      }
      throw error
    }

    return {
      judgeSessionId,
      checkSubscription: check.subscription,
      retrySubscription: retry.subscription,
      state: m.getState(),
    }
  } finally {
    m.goalLoopInFlight.delete(worker.sessionId)
  }
}

// ---- L6 template library: pick a template, fill slots, land real edges ----
//
// Templates are compilers, not entities (proposal §L6): applying one
// expands into the same ordinary commands a hand-authored relation would
// use, so what lands on the canvas IS the compiled truth the user can
// learn from. Saved templates are runtime-plane config — the scheduler
// never reads them, so they live in the snapshot, never the kernel log.

export function listTemplates(m: WorkflowKernel) {
  return {
    templates: templateDescriptors(m.readState().templates),
  }
}

export async function applyTemplate(m: WorkflowKernel, input: JsonRecord = {}) {
  const templateId = optionalTrimmedString(input.templateId)
  if (!templateId) {
    throw new Error('applyTemplate requires a templateId')
  }
  const params = isObject(input.params) ? input.params : {}
  const saved = m.state.templates?.[templateId]
  const plan = saved
    ? compileSavedTemplate(saved, params)
    : compileBuiltinTemplate(templateId, params)

  // Validate every literal endpoint BEFORE creating anything: a stale id
  // in one slot must not leave an orphan created session or half a ring.
  const requireSession = (sessionId: string, role: string) => {
    const session = m.state.sessions[sessionId]
    if (!session || session.status === 'killed') {
      throw new Error(
        `Template ${role} must be an existing session (got: ${sessionId})`,
      )
    }
  }
  for (const step of plan.steps) {
    if (step.kind === 'create-session') {
      requireSession(step.inheritFromSessionId, 'session to inherit from')
    } else if (step.kind === 'goal-loop') {
      requireSession(step.input.workerSessionId, 'worker')
    } else if (step.kind === 'handoff') {
      for (const [endpoint, role] of [
        [step.source, 'handoff source'],
        [step.target, 'handoff target'],
      ] as const) {
        if ('session' in endpoint) {
          requireSession(endpoint.session, role)
        }
      }
    } else {
      for (const [endpoint, role] of [
        [step.input.source, 'source'],
        [step.input.target, 'target'],
      ] as const) {
        if ('session' in endpoint) {
          requireSession(endpoint.session, role)
        } else if ('external' in endpoint) {
          const source = m.state.sources?.[endpoint.external]
          if (!source || source.state !== 'active') {
            throw new Error(
              `Template ${role} must be a registered, active external source (got: ${endpoint.external})`,
            )
          }
        }
      }
    }
  }

  // Shared suffix keeps paired edges from one apply visibly siblings
  // (the goal-check/goal-retry precedent). Duplicate prefixes within one
  // apply (a saved template can hold two same-shaped edges) fall back to
  // runtime-generated ids instead of overwriting each other.
  const suffix = randomUUID().slice(0, 8)
  const assignedIds = new Set<string>()
  const templateEdgeId = (idPrefix?: string) => {
    if (!idPrefix) {
      return undefined
    }
    const id = `${idPrefix}-${suffix}`
    if (assignedIds.has(id) || m.state.subscriptions?.[id]) {
      return undefined
    }
    assignedIds.add(id)
    return id
  }
  const refs = new Map<string, string>()
  const createdSessionIds = []
  const subscriptionIds = []
  // Sessions that received a one-shot handoff (kernel doc §8.1: a
  // command, not a subscription) — reported so the UI can say what
  // actually happened when nothing standing was created.
  const deliveredTo = []
  let judgeSessionId

  const resolveSession = (endpoint) => {
    if ('session' in endpoint) return endpoint.session
    if ('ref' in endpoint) {
      const sessionId = refs.get(endpoint.ref)
      if (!sessionId) {
        throw new Error(
          `Template plan step references "${endpoint.ref}" before creating it`,
        )
      }
      return sessionId
    }
    throw new Error('Template endpoint cannot be resolved to a session')
  }

  // Any mid-plan failure unwinds everything this apply created so far —
  // not just the killed-participant case: a saved multi-step template can
  // fail on its Nth step (for example the goal-loop duplicate guard) and
  // must not strand earlier sessions or edges on the canvas.
  const unwind = () => {
    for (const createdId of createdSessionIds) {
      try {
        m.killSession(createdId)
      } catch {
        // Best-effort cleanup; the rethrow below is the real signal.
      }
    }
    for (const authoredId of subscriptionIds) {
      try {
        m.cmdStopSubscription(
          {
            subscriptionId: authoredId,
            reason: 'Template apply aborted before completing its plan.',
          },
          { actor: { kind: 'runtime' } },
        )
      } catch {
        // The kill sweep may have stopped it already.
      }
    }
  }

  try {
    for (const step of plan.steps) {
      if (step.kind === 'create-session') {
        // The created participant inherits the anchor session's provider,
        // workspace, and trust level — the goal-judge precedent: a reviewer
        // in a different sandbox could not even read the work it reviews.
        const from = m.state.sessions[step.inheritFromSessionId]
        const created = await m.cmdCreateSession(
          {
            prompt: step.prompt,
            cwd: from.cwd,
            label: step.label,
            providerKind: from.providerKind,
            providerInstanceId: from.providerInstanceId,
            ...(isObject(from.runtimeSettings)
              ? {
                  runtimeSettings: clone(from.runtimeSettings),
                }
              : {}),
            sourceSessionId: from.sessionId,
            ...(step.linkLabel ? { linkLabel: step.linkLabel } : {}),
          },
          m.humanCtx(),
        )
        refs.set(step.ref, created.sessionId)
        createdSessionIds.push(created.sessionId)
      } else if (step.kind === 'handoff') {
        // The kernel §8.1 one-shot: deliver the source's artifact bundle,
        // activate the target once, leave NOTHING standing. An idle
        // source hands off immediately — this is a command, so there is
        // no edge to linger as active afterwards.
        const from = resolveSession(step.source)
        const to = resolveSession(step.target)
        for (const sessionId of [from, to]) {
          const session = m.state.sessions[sessionId]
          if (!session || session.status === 'killed') {
            throw new Error(
              'A participant session was killed while the template was being applied',
            )
          }
        }
        // Handoff is one logical command even though the kernel records its
        // two facts separately. Preflight before writing the channel so a
        // busy/frozen target cannot make Apply reject after leaving an
        // invisible partial delivery. #cmdActivate checks again immediately
        // after delivery, closing the normal command-level TOCTOU window.
        const ctx = m.humanCtx()
        m.assertActivatable(to, ctx)
        m.cmdDeliver(
          {
            sessionId: to,
            source: from,
            topic: step.topic,
          },
          ctx,
        )
        await m.cmdActivate({ sessionId: to, note: step.note }, ctx)
        deliveredTo.push(to)
      } else if (step.kind === 'goal-loop') {
        // Whole-ring delegation: the L3 preset owns judge creation, the
        // duplicate guard, and the paired stop; the preset tag keeps the
        // template provenance on the compiled edges.
        const result = await createGoalLoop(m, {
          ...(step.input as JsonRecord),
          preset: `template:${templateId}`,
        })
        judgeSessionId = result.judgeSessionId
        createdSessionIds.push(result.judgeSessionId)
        subscriptionIds.push(
          result.checkSubscription.id,
          result.retrySubscription.id,
        )
      } else {
        const body = step.input
        const source =
          'timer' in body.source
            ? { kind: 'timer' }
            : 'external' in body.source
              ? {
                  kind: 'external',
                  sourceId: body.source.external,
                }
              : {
                  kind: 'session',
                  sessionId: resolveSession(body.source),
                }
        const targetSessionId = resolveSession(body.target)
        // Endpoint liveness recheck: the pre-validation above ran before
        // any awaited session creation, so a kill landing inside that gap
        // would otherwise leave an orphan created participant plus edges
        // anchored to a dead session that the kill sweep never saw (the
        // goal-loop recheck precedent). Authoring itself is synchronous,
        // so a recheck per author step closes every interleaving.
        const participants = [
          ...(source.kind === 'session' ? [source.sessionId] : []),
          targetSessionId,
        ]
        for (const sessionId of participants) {
          const session = m.state.sessions[sessionId]
          if (!session || session.status === 'killed') {
            throw new Error(
              'A participant session was killed while the template was being applied',
            )
          }
        }
        const edgeId = templateEdgeId(body.idPrefix)
        const authored = m.cmdAuthorSubscription(
          {
            ...(edgeId ? { id: edgeId } : {}),
            ...(body.label ? { label: body.label } : {}),
            preset: `template:${templateId}`,
            source,
            on: clone(body.on),
            targetSessionId,
            action: clone(body.action),
            ...(body.gate ? { gate: body.gate } : {}),
            ...(body.concurrency ? { concurrency: body.concurrency } : {}),
            ...(body.stop ? { stop: clone(body.stop) } : {}),
            ...(body.onStop ? { onStop: body.onStop } : {}),
          },
          m.humanCtx(),
        )
        subscriptionIds.push(authored.subscription.id)
      }
    }
  } catch (error) {
    unwind()
    throw error
  }

  return {
    templateId,
    createdSessionIds,
    subscriptionIds,
    ...(deliveredTo.length > 0 ? { deliveredTo } : {}),
    ...(judgeSessionId ? { judgeSessionId } : {}),
    state: m.getState(),
  }
}

export function saveTemplate(m: WorkflowKernel, input: JsonRecord = {}) {
  const name = optionalTrimmedString(input.name)
  if (!name) {
    throw new Error('saveTemplate requires a name')
  }
  const workflowSpec = isObject(input.workflowSpec) ? input.workflowSpec : undefined
  if (workflowSpec) {
    const workflowValidationContext = {
      sessions: Object.fromEntries(
        (Object.values(m.state.sessions) as JsonRecord[]).map((session) => [
          session.sessionId,
          {
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
            frozen: m.state.nodes.find((node) => node.sessionId === session.sessionId)?.frozen,
          },
        ]),
      ),
      providerInstanceIds: m.state.providerInstances.map((instance) => instance.providerInstanceId),
    }
    const validation =
      workflowSpec.version !== 1
        ? { ok: false, issues: [{ message: 'Saved workflow version is unsupported.' }] }
        : workflowSpec.kind === 'handoff'
          ? validateHandoffWorkflowStart(workflowSpec.input, {
              ...workflowValidationContext,
            })
          : workflowSpec.kind === 'goal-loop'
            ? validateGoalWorkflowStart(workflowSpec.input, {
                ...workflowValidationContext,
              })
            : workflowSpec.kind === 'review-until-clean'
              ? validateReviewWorkflowStart(workflowSpec.input, {
                  ...workflowValidationContext,
                })
            : { ok: false, issues: [{ message: 'Saved workflow kind is unsupported.' }] }
    if (!validation.ok) throw new Error(validation.issues.map((issue) => issue.message).join(' '))
  }
  const ids = Array.isArray(input.subscriptionIds)
    ? input.subscriptionIds
        .map((id) => optionalTrimmedString(id))
        .filter(Boolean)
    : []
  const subscriptions = ids.map((id) => {
    const subscription = m.state.subscriptions?.[id]
    if (!subscription) {
      throw new Error(`Unknown subscription: ${id}`)
    }
    return subscription
  })
  const body = workflowSpec ? { slots: [], subscriptions: [] } : parameterizeSubscriptions(subscriptions, {
    session: (sessionId) => m.state.sessions[sessionId]?.label,
    source: (sourceId) => {
      const source = m.state.sources?.[sourceId]
      return source ? externalSourceSummary(source) : undefined
    },
  })
  const savedLoop = loopsOf(m.kernelView()).find(
    (loop) =>
      loop.subscriptionIds.length === ids.length &&
      loop.subscriptionIds.every((id) => ids.includes(id)),
  )
  const savedFields = workflowSpec
    ? {
        kind: workflowSpec.kind === 'goal-loop' ? 'goal' : workflowSpec.kind === 'review-until-clean' ? 'review' : 'relationship',
        relationshipCount: workflowSpec.kind === 'handoff' ? 1 : 2,
        ...(workflowSpec.kind !== 'handoff' ? { maxLaps: workflowSpec.input.maxLaps } : {}),
        instructions: [
          workflowSpec.kind === 'goal-loop'
            ? workflowSpec.input.goal
            : workflowSpec.kind === 'review-until-clean'
              ? [
                  workflowSpec.input.reviewer.instruction,
                  ...(workflowSpec.input.blocking.mode === 'custom'
                    ? [workflowSpec.input.blocking.customCriteria]
                    : []),
                ]
              : workflowSpec.input.note,
        ].flat().filter(Boolean),
      }
    : {
    kind:
      savedLoop?.kind === 'review'
        ? 'review'
        : savedLoop?.kind === 'goal'
          ? 'goal'
          : 'relationship',
    relationshipCount: subscriptions.length,
    ...(savedLoop?.lapCap ? { maxLaps: savedLoop.lapCap } : {}),
    instructions: [
      ...new Set(
        subscriptions
          .map((subscription) => optionalTrimmedString(subscription.action?.note))
          .filter(Boolean),
      ),
    ],
      }
  const template = {
    id: `tpl-${randomUUID().slice(0, 8)}`,
    name,
    ...(optionalTrimmedString(input.tagline)
      ? { tagline: input.tagline.trim() }
      : {}),
    createdAt: now(),
    savedFields,
    ...(workflowSpec ? { workflowSpec: clone(workflowSpec) } : {}),
    ...body,
  }
  m.state.templates = m.state.templates ?? {}
  m.state.templates[template.id] = template
  m.touch()
  m.broadcast({
    type: 'runtime.state',
    state: m.getState(),
  })
  return {
    template: clone(template),
    state: m.getState(),
  }
}

export function removeTemplate(m: WorkflowKernel, input: JsonRecord = {}) {
  const templateId = optionalTrimmedString(input.templateId)
  const template = templateId
    ? m.state.templates?.[templateId]
    : undefined
  if (!template) {
    throw new Error(`Unknown template: ${templateId ?? ''}`)
  }
  // No tombstone: nothing on the graph references a template after it
  // compiled — removed means gone (unlike sources, which stopped edges
  // still point at).
  delete m.state.templates[templateId]
  m.touch()
  m.broadcast({
    type: 'runtime.state',
    state: m.getState(),
  })
  return { ok: true, state: m.getState() }
}

