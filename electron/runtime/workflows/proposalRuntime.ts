import { randomUUID } from 'node:crypto'
import {
  applyWorkflowPatch,
  compileWorkflowPlan,
  defaultScopeWorkflowCapability,
  lockedPlanConflicts,
  validateWorkflowPlan,
  workflowGraphDiff,
  workflowRecipes,
} from '../../../shared/workflow-authoring.js'
import { validateDynamicCreateAction } from '../../../shared/dynamic-topology.js'
import {
  type JsonRecord,
  clone,
  isObject,
  now,
  optionalTrimmedString,
  validProviderKinds,
  validWorkflowRecipes,
} from '../runtimeCommon.js'
import { isValidCwd } from '../workspace/gitWorkspace.js'
import { defaultProviderRuntimeSettings } from '../providers/providerConfigNormalize.js'

export interface WorkflowProposalRuntimeHost {
  state(): JsonRecord
  currentCommandIdempotencyKey(): string | undefined
  workflowActorScopeId(ctx: JsonRecord, requestedScopeId?: string): string
  isSessionFrozen(sessionId: string): boolean
  appendKernelEvent(
    type: string,
    payload: JsonRecord,
    ctx?: JsonRecord,
    options?: JsonRecord,
  ): JsonRecord
  touch(): void
  broadcast(event: JsonRecord): void
  getState(): JsonRecord
  membraneActor(source: string): JsonRecord
  cmdCreateSession(
    input: JsonRecord,
    ctx: JsonRecord,
    options?: JsonRecord,
  ): Promise<JsonRecord> | JsonRecord
  startRun(sessionId: string, request: JsonRecord): Promise<unknown>
  cmdStopSubscription(input: JsonRecord, ctx: JsonRecord): JsonRecord
  cmdAuthorSubscription(
    input: JsonRecord,
    ctx: JsonRecord,
    options?: JsonRecord,
  ): JsonRecord
  cmdKillSession(input: JsonRecord, ctx: JsonRecord): JsonRecord
  commitPlanCouncilPatch(
    proposal: JsonRecord,
    base: JsonRecord,
    ctx: JsonRecord,
  ): Promise<JsonRecord> | JsonRecord
  startReviewWorkflow(input: JsonRecord): Promise<JsonRecord>
  startGoalWorkflow(input: JsonRecord): Promise<JsonRecord>
  startHandoffWorkflow(input: JsonRecord): Promise<JsonRecord>
  startPlanCouncil(input: JsonRecord): Promise<JsonRecord>
}

export class WorkflowProposalRuntime {
  #host: WorkflowProposalRuntimeHost

  constructor(host: WorkflowProposalRuntimeHost) {
    this.#host = host
  }

  workflowCapability(scopeId: string, { persist = false } = {}) {
    const existing = this.#host.state().workflowCapabilities?.[scopeId]
    if (existing) return existing
    const capability = defaultScopeWorkflowCapability(
      scopeId,
      this.#host.state().providerInstances.map((instance) => instance.providerInstanceId),
      now(),
    )
    if (persist) {
      this.#host.state().workflowCapabilities ??= {}
      this.#host.state().workflowCapabilities[scopeId] = capability
    }
    return capability
  }

  workflowAuthoringContext(scopeId: string, { persistCapability = false } = {}) {
    const cluster = scopeId === 'global' ? undefined : this.#host.state().clusters[scopeId]
    const scopeSessionIds = scopeId === 'global'
      ? Object.keys(this.#host.state().sessions)
      : [...new Set([
          ...(cluster?.nodeIds ?? []),
          ...(cluster?.masterSessionId ? [cluster.masterSessionId] : []),
        ])]
    const visibleSessionIds = new Set(scopeSessionIds)
    const sessions = Object.fromEntries(
      (Object.values(this.#host.state().sessions) as JsonRecord[])
        .filter((session) => visibleSessionIds.has(session.sessionId))
        .map((session) => [
        session.sessionId,
        {
          sessionId: session.sessionId,
          label: session.label,
          cwd: session.cwd,
          status: session.status,
          frozen: this.#host.isSessionFrozen(session.sessionId),
          providerKind: session.providerKind,
          providerInstanceId: session.providerInstanceId,
          runtimeSettings: clone(session.runtimeSettings ?? defaultProviderRuntimeSettings),
        },
      ]),
    )
    return {
      sessions,
      scopeSessionIds,
      providerInstanceIds: this.#host.state().providerInstances.map(
        (instance) => instance.providerInstanceId,
      ),
      capability: this.workflowCapability(scopeId, { persist: persistCapability }),
    }
  }

  latestWorkflowPlan(workflowId: string) {
    const versions = this.#host.state().workflowPlans?.[workflowId]
    if (!isObject(versions)) return undefined
    return Object.values(versions as JsonRecord)
      .filter((plan) => isObject(plan) && Number.isSafeInteger(plan.version))
      .sort((left: JsonRecord, right: JsonRecord) => right.version - left.version)[0]
  }

  activeWorkflowPlan(workflowId: string) {
    const versions = this.#host.state().workflowPlans?.[workflowId]
    if (!isObject(versions)) return undefined
    return Object.values(versions as JsonRecord)
      .filter((plan) => isObject(plan) && plan.status === 'active' && Number.isSafeInteger(plan.version))
      .sort((left: JsonRecord, right: JsonRecord) => right.version - left.version)[0]
  }

  workflowProposal(proposalId: unknown) {
    const id = optionalTrimmedString(proposalId)
    const proposal = id ? this.#host.state().workflowProposals?.[id] : undefined
    if (!proposal) throw new Error(`Unknown Workflow Proposal: ${id ?? ''}`)
    return proposal
  }

  assertWorkflowProposalMutable(proposal: JsonRecord) {
    if (!['proposed', 'approved'].includes(proposal.status)) {
      throw new Error(`Workflow Proposal ${proposal.proposalId} is ${proposal.status} and cannot be revised.`)
    }
    if (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now()) {
      throw new Error(`Workflow Proposal ${proposal.proposalId} has expired.`)
    }
  }

  workflowRecipeInput(input: JsonRecord) {
    const recipeInput = isObject(input.recipeInput)
      ? input.recipeInput
      : validWorkflowRecipes.has(input.recipe) && isObject(input.input)
        ? { recipe: input.recipe, input: input.input }
        : undefined
    if (!recipeInput || !validWorkflowRecipes.has(recipeInput.recipe) || !isObject(recipeInput.input)) {
      throw new Error(`Workflow recipe must be one of: ${workflowRecipes.join(', ')}.`)
    }
    return clone(recipeInput)
  }

  applyMasterWorkflowDefaults(recipeInput: JsonRecord, masterSessionId?: string) {
    const master = masterSessionId ? this.#host.state().sessions[masterSessionId] : undefined
    if (!master) return recipeInput
    const providerFor = (spec: JsonRecord = {}, { readOnly = false } = {}) => {
      const requestedInstanceId = optionalTrimmedString(spec.providerInstanceId)
      const providerInstance = requestedInstanceId
        ? this.#host.state().providerInstances.find((instance) => instance.providerInstanceId === requestedInstanceId)
        : this.#host.state().providerInstances.find((instance) => instance.providerInstanceId === master.providerInstanceId)
      const providerKind = providerInstance?.kind ??
        (validProviderKinds.has(spec.providerKind) ? spec.providerKind : master.providerKind)
      const inheritedSettings = clone(master.runtimeSettings ?? defaultProviderRuntimeSettings)
      if (providerKind !== master.providerKind) delete inheritedSettings.model
      return {
        ...spec,
        providerKind,
        providerInstanceId: requestedInstanceId ?? providerInstance?.providerInstanceId ?? master.providerInstanceId,
        runtimeSettings: {
          ...inheritedSettings,
          ...(isObject(spec.runtimeSettings) ? spec.runtimeSettings : {}),
          runtimeMode: 'approval-required',
          ...(readOnly ? { sandbox: 'read-only' } : {}),
        },
      }
    }
    const endpoint = (spec: JsonRecord = {}, { readOnly = false, label }: { readOnly?: boolean; label: string }) => {
      if (spec.kind === 'existing') return spec
      const configured = providerFor(spec, { readOnly })
      return {
        ...configured,
        kind: 'new',
        label: optionalTrimmedString(spec.label) ?? label,
        prompt: optionalTrimmedString(spec.prompt) ?? '',
        cwd: optionalTrimmedString(spec.cwd) ?? master.cwd,
        workMode: ['local', 'worktree'].includes(spec.workMode) ? spec.workMode : 'local',
      }
    }
    const value = recipeInput.input
    if (recipeInput.recipe === 'plan-council') {
      value.cwd = optionalTrimmedString(value.cwd) ?? master.cwd
      value.planners = Array.isArray(value.planners)
        ? value.planners.map((planner, index) => ({
            ...providerFor(planner, { readOnly: true }),
            key: optionalTrimmedString(planner?.key) ?? `planner-${index + 1}`,
            label: optionalTrimmedString(planner?.label) ?? `Planner ${index + 1}`,
            runtimeSettings: {
              ...providerFor(planner, { readOnly: true }).runtimeSettings,
              interactionMode: 'plan',
            },
          }))
        : []
      value.synthesizer = {
        ...providerFor(value.synthesizer, { readOnly: true }),
        key: optionalTrimmedString(value.synthesizer?.key) ?? 'synthesizer',
        label: optionalTrimmedString(value.synthesizer?.label) ?? 'Synthesizer',
        runtimeSettings: {
          ...providerFor(value.synthesizer, { readOnly: true }).runtimeSettings,
          interactionMode: 'plan',
        },
      }
      return recipeInput
    }
    if (recipeInput.recipe === 'review') {
      value.coder = endpoint(value.coder, { label: 'Coder' })
      value.reviewer = value.reviewer?.kind === 'existing'
        ? value.reviewer
        : {
            ...providerFor(value.reviewer, { readOnly: true }),
            kind: 'new',
            label: optionalTrimmedString(value.reviewer?.label) ?? 'Reviewer',
            instruction: optionalTrimmedString(value.reviewer?.instruction) ?? '',
          }
      return recipeInput
    }
    if (recipeInput.recipe === 'goal') {
      value.worker = endpoint(value.worker, { label: 'Worker' })
      return recipeInput
    }
    value.source = endpoint(value.source, { label: 'Source' })
    value.target = endpoint(value.target, { label: 'Target' })
    return recipeInput
  }

  storeWorkflowPlan(plan: JsonRecord) {
    this.#host.state().workflowPlans ??= {}
    this.#host.state().workflowPlans[plan.workflowId] ??= {}
    this.#host.state().workflowPlans[plan.workflowId][String(plan.version)] = clone(plan)
  }

  validateWorkflowProposalPlan(plan: JsonRecord, context: JsonRecord, patch?: JsonRecord) {
    const active = this.activeWorkflowPlan(plan.workflowId)
    const replacedKeys = new Set<string>(patch?.impact?.replacedParticipantKeys ?? [])
    const validationContext = active && plan.supersedesVersion === active.version
      ? {
          ...context,
          existingParticipantKeys: (active.participants ?? [])
            .filter((participant: JsonRecord) => active.executionMapping?.participantSessionIds?.[participant.key])
            .filter((participant: JsonRecord) => !replacedKeys.has(participant.key))
            .map((participant: JsonRecord) => participant.key),
        }
      : context
    const validation = validateWorkflowPlan(plan as any, validationContext as any)
    if (patch && active?.executionMapping) {
      const sessionClaims = new Map<string, string>()
      for (const participant of plan.participants ?? []) {
        const sessionId = participant.endpoint?.kind === 'existing'
          ? participant.endpoint.sessionId
          : !replacedKeys.has(participant.key)
            ? active.executionMapping.participantSessionIds?.[participant.key]
            : undefined
        if (!sessionId) continue
        const claimedBy = sessionClaims.get(sessionId)
        if (claimedBy && claimedBy !== participant.key) {
          validation.errors.push({
            field: `participants.${participant.key}.endpoint.sessionId`,
            message: `Session ${sessionId} is already mapped to Workflow participant ${claimedBy}; participant mappings must be one-to-one.`,
            code: 'participant-session-collision',
          })
        } else {
          sessionClaims.set(sessionId, participant.key)
        }
        if (sessionId === plan.masterSessionId) {
          validation.errors.push({
            field: `participants.${participant.key}.endpoint.sessionId`,
            message: 'The governing Master/Coordinator cannot also be a Workflow participant.',
            code: 'master-participant-collision',
          })
        }
      }
    }
    if (patch && plan.recipe === 'plan-council') {
      const unsupported = (patch.operations ?? []).filter(
        (operation: JsonRecord) => !['add-verifier', 'replace-participant', 'resynthesize'].includes(operation.op),
      )
      for (const operation of unsupported) {
        validation.errors.push({
          field: 'patch.operations',
          message: `Plan Council does not support ${operation.op} at product-phase runtime.`,
          code: 'patch-operation-unsupported',
        })
      }
      const councilId = active?.executionMapping?.productWorkflowId
      const council = councilId ? this.#host.state().planCouncils?.[councilId] : undefined
      if (
        ['reviewing-peers', 'synthesizing'].includes(council?.phase) &&
        (patch.operations ?? []).some((operation: JsonRecord) =>
          ['add-verifier', 'replace-participant'].includes(operation.op),
        )
      ) {
        validation.errors.push({
          field: 'patch.operations',
          message: `Plan Council is ${council.phase}; participant topology cannot change during an active phase. Wait for the phase boundary or stop the Council.`,
          code: 'patch-phase-incompatible',
        })
      }
      if (
        (patch.operations ?? []).some((operation: JsonRecord) => operation.op === 'resynthesize') &&
        !['completed', 'ready-for-synthesis'].includes(council?.phase)
      ) {
        validation.errors.push({
          field: 'patch.operations',
          message: `Plan Council is ${council?.phase ?? 'unavailable'}; resynthesis requires completed reviews.`,
          code: 'patch-phase-incompatible',
        })
      }
    }
    for (const participant of plan.participants ?? []) {
      if (!participant.workspace?.cwd || !isValidCwd(participant.workspace.cwd)) {
        validation.errors.push({
          field: `participants.${participant.key}.workspace.cwd`,
          message: `${participant.label} workspace does not exist: ${participant.workspace?.cwd ?? ''}`,
          code: 'workspace-unavailable',
        })
      }
    }
    return validation
  }

  workflowIdempotencyKey(input: JsonRecord, operation: string) {
    const idempotencyKey = optionalTrimmedString(
      this.#host.currentCommandIdempotencyKey(),
    ) ?? optionalTrimmedString(input.idempotencyKey)
    if (!idempotencyKey) {
      throw new Error(`${operation} requires an idempotencyKey.`)
    }
    return idempotencyKey
  }

  cmdProposeWorkflow(input: JsonRecord = {}, ctx: JsonRecord) {
    const scopeId = this.#host.workflowActorScopeId(ctx, optionalTrimmedString(input.scopeId))
    const idempotencyKey = this.workflowIdempotencyKey(input, 'propose_workflow')
    const context = this.workflowAuthoringContext(scopeId, { persistCapability: true })
    const recipeInput = this.applyMasterWorkflowDefaults(
      this.workflowRecipeInput(input),
      ctx.actor.kind === 'master' ? ctx.actor.ref : undefined,
    )
    if (
      recipeInput.recipe === 'plan-council' &&
      ctx.actor.kind === 'master' &&
      !optionalTrimmedString(recipeInput.input.coordinatorSessionId)
    ) {
      recipeInput.input.coordinatorSessionId = ctx.actor.ref
    }
    const workflowId = optionalTrimmedString(input.workflowId) ?? `workflow-${randomUUID()}`
    const latest = this.latestWorkflowPlan(workflowId)
    const active = this.activeWorkflowPlan(workflowId)
    const baseVersion = active?.version ?? 0
    const openProposal = (Object.values(this.#host.state().workflowProposals ?? {}) as JsonRecord[]).find(
      (candidate: JsonRecord) =>
        candidate.workflowId === workflowId && ['proposed', 'approved'].includes(candidate.status),
    )
    if (openProposal) {
      throw new Error(`Workflow ${workflowId} already has open Proposal ${openProposal.proposalId}. Revise or abort it first.`)
    }
    const objective = optionalTrimmedString(input.objective) ??
      optionalTrimmedString(recipeInput.input.objective) ??
      optionalTrimmedString(recipeInput.input.goal) ??
      optionalTrimmedString(recipeInput.input.note) ?? ''
    const createdAt = now()
    const plan = compileWorkflowPlan({
      workflowId,
      version: (latest?.version ?? 0) + 1,
      objective,
      recipeInput: recipeInput as any,
      masterSessionId: ctx.actor.kind === 'master'
        ? ctx.actor.ref
        : optionalTrimmedString(input.masterSessionId),
      scopeId,
      autonomyPolicy: context.capability.policy,
      createdAt,
      createdBy: clone(ctx.actor),
      reason: optionalTrimmedString(input.reason),
      ...(baseVersion > 0 ? { supersedesVersion: baseVersion } : {}),
    }, context as any)
    const validation = this.validateWorkflowProposalPlan(plan, context)
    const proposalId = optionalTrimmedString(input.proposalId) ?? `proposal-${randomUUID()}`
    if (this.#host.state().workflowProposals?.[proposalId]) {
      throw new Error(`Workflow Proposal already exists: ${proposalId}`)
    }
    const expiresAt = optionalTrimmedString(input.expiresAt)
    const proposal = {
      proposalId,
      workflowId,
      baseVersion,
      proposedPlan: plan,
      graphDiff: workflowGraphDiff(active, plan),
      validation,
      status: 'proposed',
      idempotencyKey,
      createdAt,
      createdBy: clone(ctx.actor),
      updatedAt: createdAt,
      ...(expiresAt ? { expiresAt } : {}),
    }
    this.#host.state().workflowProposals ??= {}
    this.#host.state().workflowProposals[proposalId] = proposal
    this.storeWorkflowPlan(plan)
    this.#host.appendKernelEvent(
      'workflow.proposed',
      {
        proposalId,
        workflowId,
        version: plan.version,
        recipe: plan.recipe,
        scopeId,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
        requiresHumanApproval: validation.requiresHumanApproval,
      },
      ctx,
      { reason: plan.reason },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  workflowPatchParticipant(
    value: JsonRecord,
    key: string,
    fallback: JsonRecord | undefined,
    defaults: JsonRecord = {},
  ) {
    if (!isObject(value)) throw new Error(`Workflow Patch participant ${key} is required.`)
    const endpointValue = isObject(value.endpoint) ? value.endpoint : value
    const endpointKind = endpointValue.kind === 'existing' ? 'existing' : 'new'
    let endpoint
    if (endpointKind === 'existing') {
      const sessionId = optionalTrimmedString(endpointValue.sessionId)
      if (!sessionId) throw new Error(`Workflow Patch participant ${key} requires sessionId.`)
      if (!this.#host.state().sessions[sessionId]) throw new Error(`Unknown Workflow Patch session: ${sessionId}`)
      endpoint = { kind: 'existing', sessionId }
    } else {
      const providerKind = optionalTrimmedString(endpointValue.providerKind) ??
        (fallback?.endpoint?.kind === 'new' ? fallback.endpoint.providerKind : undefined)
      const providerInstanceId = optionalTrimmedString(endpointValue.providerInstanceId) ??
        (fallback?.endpoint?.kind === 'new' ? fallback.endpoint.providerInstanceId : undefined)
      if (!['claude-code', 'codex', 'grok'].includes(providerKind) || !providerInstanceId) {
        throw new Error(`Workflow Patch participant ${key} requires providerKind and providerInstanceId.`)
      }
      endpoint = {
        kind: 'new',
        providerKind,
        providerInstanceId,
        runtimeSettings: clone(
          isObject(endpointValue.runtimeSettings)
            ? endpointValue.runtimeSettings
            : fallback?.endpoint?.runtimeSettings ?? {},
        ),
      }
    }
    const existingSession = endpoint.kind === 'existing' ? this.#host.state().sessions[endpoint.sessionId] : undefined
    const workspaceValue = isObject(value.workspace) ? value.workspace : {}
    const requestedAccess = workspaceValue.access === 'write'
      ? 'write'
      : workspaceValue.access === 'read'
        ? 'read'
        : defaults.access ?? fallback?.workspace?.access ?? 'read'
    const access = existingSession
      ? existingSession.runtimeSettings?.sandbox === 'read-only' ? 'read' : 'write'
      : requestedAccess
    if (existingSession && requestedAccess === 'read' && access !== 'read') {
      throw new Error(`Workflow Patch participant ${key} requires read-only access, but Session ${existingSession.sessionId} can write.`)
    }
    if (endpoint.kind === 'new' && access === 'read') {
      endpoint.runtimeSettings = {
        ...endpoint.runtimeSettings,
        runtimeMode: 'approval-required',
        sandbox: 'read-only',
      }
    }
    return {
      key,
      role: optionalTrimmedString(value.role) ?? defaults.role ?? fallback?.role ?? 'Verifier',
      label: optionalTrimmedString(value.label) ?? defaults.label ?? fallback?.label ?? key,
      endpoint,
      prompt: optionalTrimmedString(value.prompt) ?? defaults.prompt ?? fallback?.prompt ?? '',
      workspace: {
        cwd: existingSession?.cwd ?? optionalTrimmedString(workspaceValue.cwd) ?? fallback?.workspace?.cwd,
        access,
        workMode: existingSession ? 'local' : workspaceValue.workMode === 'worktree'
          ? 'worktree'
          : fallback?.workspace?.workMode ?? 'local',
        ...(optionalTrimmedString(workspaceValue.branch) || fallback?.workspace?.branch
          ? { branch: optionalTrimmedString(workspaceValue.branch) ?? fallback?.workspace?.branch }
          : {}),
      },
      managedBy: 'master',
    }
  }

  cmdProposeWorkflowPatch(input: JsonRecord = {}, ctx: JsonRecord) {
    const workflowId = optionalTrimmedString(input.workflowId)
    if (!workflowId) throw new Error('propose_workflow_patch requires workflowId.')
    this.workflowIdempotencyKey(input, 'propose_workflow_patch')
    const active = this.activeWorkflowPlan(workflowId)
    if (!active) throw new Error(`Workflow has no active plan: ${workflowId}`)
    this.#host.workflowActorScopeId(ctx, active.scopeId)
    const baseVersion = Number(input.baseVersion)
    if (!Number.isSafeInteger(baseVersion) || baseVersion !== active.version) {
      throw new Error(`Workflow Patch baseVersion must match active v${active.version}.`)
    }
    const openProposal = (Object.values(this.#host.state().workflowProposals ?? {}) as JsonRecord[]).find(
      (candidate: JsonRecord) => candidate.workflowId === workflowId && ['proposed', 'approved'].includes(candidate.status),
    )
    if (openProposal) {
      throw new Error(`Workflow ${workflowId} already has open Proposal ${openProposal.proposalId}.`)
    }
    const reason = optionalTrimmedString(input.reason)
    if (!reason) throw new Error('Workflow Patch requires reason.')
    const rawOperations = Array.isArray(input.operations) ? input.operations : []
    const operations = rawOperations.map((raw: JsonRecord) => {
      if (!isObject(raw)) throw new Error('Workflow Patch operations must be objects.')
      if (raw.op === 'replace-participant') {
        const participantKey = optionalTrimmedString(raw.participantKey)
        const previous = active.participants.find((item) => item.key === participantKey)
        if (!participantKey || !previous) throw new Error(`Unknown Workflow participant: ${participantKey ?? ''}`)
        return {
          op: 'replace-participant',
          participantKey,
          replacement: this.workflowPatchParticipant(raw.replacement, participantKey, previous),
        }
      }
      if (raw.op === 'add-verifier') {
        const verifierValue = isObject(raw.verifier) ? raw.verifier : {}
        const key = optionalTrimmedString(verifierValue.key)
        if (!key) throw new Error('add-verifier requires verifier.key.')
        const reference = active.participants.find((item) => raw.observes?.includes?.(item.key)) ?? active.participants[0]
        return {
          op: 'add-verifier',
          verifier: this.workflowPatchParticipant(verifierValue, key, reference, {
            role: 'Verifier',
            label: optionalTrimmedString(verifierValue.label) ?? 'Verifier',
            access: 'read',
            prompt: optionalTrimmedString(verifierValue.prompt) ?? 'Verify the delivered result and report concrete findings.',
          }),
          observes: Array.isArray(raw.observes) ? raw.observes : reference ? [reference.key] : [],
          ...(raw.trigger === 'report' ? { trigger: 'report' } : {}),
          ...(['auto', 'master', 'human'].includes(raw.gate) ? { gate: raw.gate } : {}),
          ...(optionalTrimmedString(raw.stop) ? { stop: optionalTrimmedString(raw.stop) } : {}),
        }
      }
      if (raw.op === 'add-dynamic-triage') {
        const validation = validateDynamicCreateAction(raw.action, {
          providerInstanceIds: this.#host.state().providerInstances.map((instance) => instance.providerInstanceId),
        })
        if (!validation.ok) throw new Error(validation.errors.join(' '))
        const maxFirings = Number(raw.maxFirings)
        if (!Number.isSafeInteger(maxFirings) || maxFirings < 1) {
          throw new Error('add-dynamic-triage maxFirings must be a positive integer.')
        }
        return {
          op: 'add-dynamic-triage',
          relationshipKey: optionalTrimmedString(raw.relationshipKey) ?? '',
          sourceParticipantKey: optionalTrimmedString(raw.sourceParticipantKey) ?? '',
          ownerParticipantKey: optionalTrimmedString(raw.ownerParticipantKey) ?? '',
          action: clone(raw.action),
          maxFirings,
          ...(['auto', 'master', 'human'].includes(raw.gate) ? { gate: raw.gate } : {}),
        }
      }
      if (raw.op === 'stop-branch') {
        return {
          op: 'stop-branch',
          relationshipKeys: Array.isArray(raw.relationshipKeys) ? raw.relationshipKeys : [],
          reason: optionalTrimmedString(raw.reason) ?? reason,
        }
      }
      if (raw.op === 'change-relationship-policy') {
        return {
          op: 'change-relationship-policy',
          relationshipKey: optionalTrimmedString(raw.relationshipKey) ?? '',
          ...(['auto', 'master', 'human'].includes(raw.gate) ? { gate: raw.gate } : {}),
          ...(typeof raw.stop === 'string' ? { stop: raw.stop.trim() } : {}),
        }
      }
      if (raw.op === 'resynthesize') {
        return { op: 'resynthesize', reason: optionalTrimmedString(raw.reason) ?? reason }
      }
      throw new Error(`Unsupported Workflow Patch operation: ${String(raw.op)}`)
    })
    const wakeupIds = Array.isArray(input.wakeupIds)
      ? [...new Set(input.wakeupIds.map(optionalTrimmedString).filter(Boolean))]
      : []
    for (const wakeupId of wakeupIds) {
      const wakeup = this.#host.state().workflowWakeups?.[wakeupId]
      if (!wakeup || wakeup.workflowId !== workflowId || wakeup.workflowVersion !== baseVersion) {
        throw new Error(`Workflow wakeup does not govern ${workflowId} v${baseVersion}: ${wakeupId}`)
      }
    }
    const createdAt = now()
    const { plan, patch } = applyWorkflowPatch(active as any, {
      version: active.version + 1,
      createdAt,
      createdBy: clone(ctx.actor),
      reason,
      wakeupIds,
      operations: operations as any,
    })
    const context = this.workflowAuthoringContext(active.scopeId)
    const validation = this.validateWorkflowProposalPlan(plan, context, patch)
    const proposalId = optionalTrimmedString(input.proposalId) ?? `proposal-${randomUUID()}`
    if (this.#host.state().workflowProposals?.[proposalId]) {
      throw new Error(`Workflow Proposal already exists: ${proposalId}`)
    }
    const proposal = {
      proposalId,
      workflowId,
      baseVersion,
      proposedPlan: plan,
      graphDiff: workflowGraphDiff(active, plan),
      patch,
      validation,
      status: 'proposed',
      idempotencyKey: this.workflowIdempotencyKey(input, 'propose_workflow_patch'),
      createdAt,
      createdBy: clone(ctx.actor),
      updatedAt: createdAt,
    }
    this.#host.state().workflowProposals ??= {}
    this.#host.state().workflowProposals[proposalId] = proposal
    this.storeWorkflowPlan(plan)
    this.#host.appendKernelEvent('workflow.patch.proposed', {
      proposalId,
      workflowId,
      baseVersion,
      version: plan.version,
      wakeupIds,
      operations: operations.map((operation) => operation.op),
      impact: patch.impact,
      rollback: patch.rollback,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    }, ctx, { reason })
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  cmdReviseWorkflow(input: JsonRecord = {}, ctx: JsonRecord) {
    const proposal = this.workflowProposal(input.proposalId)
    this.assertWorkflowProposalMutable(proposal)
    if (proposal.patch) {
      throw new Error('Workflow Patch operations are immutable; abort this Patch and propose a new versioned Patch.')
    }
    this.#host.workflowActorScopeId(ctx, proposal.proposedPlan.scopeId)
    const recipeInput = input.recipeInput || input.recipe || input.input
      ? this.workflowRecipeInput(input)
      : clone(proposal.proposedPlan.recipeInput)
    const context = this.workflowAuthoringContext(proposal.proposedPlan.scopeId)
    const objective = optionalTrimmedString(input.objective) ?? proposal.proposedPlan.objective
    const revised = compileWorkflowPlan({
      workflowId: proposal.workflowId,
      version: proposal.proposedPlan.version,
      objective,
      recipeInput,
      masterSessionId: proposal.proposedPlan.masterSessionId,
      scopeId: proposal.proposedPlan.scopeId,
      autonomyPolicy: context.capability.policy,
      createdAt: proposal.proposedPlan.createdAt,
      createdBy: proposal.proposedPlan.createdBy,
      reason: optionalTrimmedString(input.reason) ?? proposal.proposedPlan.reason,
      ...(proposal.baseVersion > 0 ? { supersedesVersion: proposal.baseVersion } : {}),
    }, context as any)

    const previousParticipants = new Map<string, JsonRecord>(
      proposal.proposedPlan.participants.map((item) => [item.key, item]),
    )
    const previousRelationships = new Map<string, JsonRecord>(
      proposal.proposedPlan.relationships.map((item) => [item.key, item]),
    )
    for (const participant of revised.participants) {
      if (previousParticipants.get(participant.key)?.lockedByHuman) participant.lockedByHuman = true
    }
    for (const relationship of revised.relationships) {
      if (previousRelationships.get(relationship.key)?.lockedByHuman) relationship.lockedByHuman = true
    }
    const lockErrors = ctx.actor.kind === 'master'
      ? lockedPlanConflicts(proposal.proposedPlan, revised)
      : []
    if (lockErrors.length > 0) throw new Error(lockErrors.map((issue) => issue.message).join(' '))

    const latestCommitted = proposal.baseVersion > 0
      ? this.#host.state().workflowPlans?.[proposal.workflowId]?.[String(proposal.baseVersion)]
      : undefined
    const validation = this.validateWorkflowProposalPlan(revised, context)
    proposal.proposedPlan = revised
    proposal.graphDiff = workflowGraphDiff(latestCommitted, revised)
    proposal.validation = validation
    proposal.status = 'proposed'
    proposal.updatedAt = now()
    delete proposal.approvedAt
    delete proposal.approvedBy
    this.storeWorkflowPlan(revised)
    this.#host.appendKernelEvent(
      'workflow.revised',
      {
        proposalId: proposal.proposalId,
        workflowId: proposal.workflowId,
        version: revised.version,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
      },
      ctx,
      { reason: optionalTrimmedString(input.reason) },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  cmdApproveWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor.kind !== 'human') throw new Error('Only a human can approve a Workflow Proposal.')
    const proposal = this.workflowProposal(input.proposalId)
    this.assertWorkflowProposalMutable(proposal)
    const context = this.workflowAuthoringContext(proposal.proposedPlan.scopeId)
    proposal.validation = this.validateWorkflowProposalPlan(proposal.proposedPlan, context, proposal.patch)
    if (proposal.validation.errors.length > 0) {
      throw new Error(`Workflow Proposal has validation errors: ${proposal.validation.errors.map((issue) => issue.message).join(' ')}`)
    }
    proposal.status = 'approved'
    proposal.approvedAt = now()
    proposal.approvedBy = optionalTrimmedString(input.approvedBy) ?? 'human'
    proposal.updatedAt = proposal.approvedAt
    this.#host.appendKernelEvent(
      'workflow.proposal.approved',
      { proposalId: proposal.proposalId, workflowId: proposal.workflowId, version: proposal.proposedPlan.version },
      ctx,
      { reason: optionalTrimmedString(input.reason) },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  cmdRejectWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor.kind !== 'human') throw new Error('Only a human can reject a Workflow Proposal.')
    const proposal = this.workflowProposal(input.proposalId)
    this.assertWorkflowProposalMutable(proposal)
    proposal.status = 'rejected'
    proposal.rejectedAt = now()
    proposal.rejectionReason = optionalTrimmedString(input.reason) ?? 'Rejected by human.'
    proposal.updatedAt = proposal.rejectedAt
    proposal.proposedPlan.status = 'aborted'
    this.storeWorkflowPlan(proposal.proposedPlan)
    this.#host.appendKernelEvent(
      'workflow.proposal.rejected',
      { proposalId: proposal.proposalId, workflowId: proposal.workflowId },
      ctx,
      { reason: proposal.rejectionReason },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  cmdExpireWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    if (!['human', 'runtime'].includes(ctx.actor.kind)) {
      throw new Error('Only the runtime or a human can expire a Workflow Proposal.')
    }
    const proposal = this.workflowProposal(input.proposalId)
    this.assertWorkflowProposalMutable(proposal)
    proposal.status = 'expired'
    proposal.updatedAt = now()
    proposal.proposedPlan.status = 'aborted'
    this.storeWorkflowPlan(proposal.proposedPlan)
    this.#host.appendKernelEvent(
      'workflow.proposal.expired',
      { proposalId: proposal.proposalId, workflowId: proposal.workflowId },
      ctx,
      { reason: optionalTrimmedString(input.reason) ?? 'Proposal expired.' },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  cmdAbortWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    const proposal = this.workflowProposal(input.proposalId)
    this.assertWorkflowProposalMutable(proposal)
    this.#host.workflowActorScopeId(ctx, proposal.proposedPlan.scopeId)
    proposal.status = 'rejected'
    proposal.rejectedAt = now()
    proposal.rejectionReason = optionalTrimmedString(input.reason) ?? 'Author aborted proposal.'
    proposal.updatedAt = proposal.rejectedAt
    proposal.proposedPlan.status = 'aborted'
    this.storeWorkflowPlan(proposal.proposedPlan)
    this.#host.appendKernelEvent(
      'workflow.proposal.aborted',
      { proposalId: proposal.proposalId, workflowId: proposal.workflowId },
      ctx,
      { reason: proposal.rejectionReason },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  cmdLockWorkflowItem(input: JsonRecord = {}, ctx: JsonRecord) {
    if (ctx.actor.kind !== 'human') throw new Error('Only a human can lock Workflow Proposal items.')
    const proposal = this.workflowProposal(input.proposalId)
    this.assertWorkflowProposalMutable(proposal)
    const collectionName = input.kind === 'relationship' ? 'relationships' : input.kind === 'participant' ? 'participants' : undefined
    const key = optionalTrimmedString(input.key)
    if (!collectionName || !key) throw new Error('lock_workflow_item requires kind and key.')
    const item = proposal.proposedPlan[collectionName].find((candidate) => candidate.key === key)
    if (!item) throw new Error(`Unknown Workflow Proposal ${input.kind}: ${key}`)
    item.lockedByHuman = input.locked !== false
    proposal.updatedAt = now()
    this.storeWorkflowPlan(proposal.proposedPlan)
    this.#host.appendKernelEvent(
      'workflow.item.locked',
      { proposalId: proposal.proposalId, workflowId: proposal.workflowId, kind: input.kind, key, locked: item.lockedByHuman },
      ctx,
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return { proposal: clone(proposal), state: this.#host.getState() }
  }

  workflowExecutionMapping(plan: JsonRecord, result: JsonRecord) {
    const participantSessionIds: JsonRecord = {}
    const relationshipSubscriptionIds: JsonRecord = {}
    const relationshipRuntimeRefs: JsonRecord = {}
    if (plan.recipe === 'review') {
      participantSessionIds.coder = result.coderSessionId
      participantSessionIds.reviewer = result.reviewerSessionId
      relationshipSubscriptionIds['review-request'] = result.subscriptionIds?.[0]
      relationshipSubscriptionIds['review-fix'] = result.subscriptionIds?.[1]
    } else if (plan.recipe === 'goal') {
      participantSessionIds.worker = result.workerSessionId
      participantSessionIds.judge = result.judgeSessionId
      relationshipSubscriptionIds['goal-check'] = result.subscriptionIds?.[0]
      relationshipSubscriptionIds['goal-retry'] = result.subscriptionIds?.[1]
    } else if (plan.recipe === 'handoff') {
      participantSessionIds.source = result.sourceSessionId
      participantSessionIds.target = result.targetSessionId
      if (result.subscriptionIds?.[0]) relationshipSubscriptionIds.handoff = result.subscriptionIds[0]
    } else {
      for (const planner of plan.recipeInput.input.planners ?? []) {
        participantSessionIds[`planner:${planner.key}`] = result.participantSessionIds?.[planner.key]
      }
      participantSessionIds[`synthesizer:${plan.recipeInput.input.synthesizer.key}`] =
        result.participantSessionIds?.[plan.recipeInput.input.synthesizer.key] ?? result.synthesizerSessionId
    }
    for (const key of Object.keys(relationshipSubscriptionIds)) {
      if (!relationshipSubscriptionIds[key]) delete relationshipSubscriptionIds[key]
      else relationshipRuntimeRefs[key] = { kind: 'subscription', ref: relationshipSubscriptionIds[key] }
    }
    if (plan.recipe === 'handoff' && !relationshipRuntimeRefs.handoff) {
      relationshipRuntimeRefs.handoff = {
        kind: 'one-shot',
        ref: `${plan.workflowId}:v${plan.version}:handoff`,
      }
    }
    if (plan.recipe === 'plan-council') {
      for (const relationship of plan.relationships ?? []) {
        relationshipRuntimeRefs[relationship.key] = {
          kind: 'product-phase',
          ref: `${result.workflowId}:${relationship.key}`,
        }
      }
    }
    return {
      planVersion: plan.version,
      participantSessionIds,
      relationshipSubscriptionIds,
      relationshipRuntimeRefs,
      scopeIds: [plan.scopeId],
      productWorkflowId: optionalTrimmedString(result.workflowId),
      runId: optionalTrimmedString(result.runId),
      committedAt: now(),
    }
  }

  attachWorkflowExecutionToScope(scopeId: string, mapping: JsonRecord, plan: JsonRecord, ctx: JsonRecord) {
    if (scopeId === 'global') return
    const cluster = this.#host.state().clusters[scopeId]
    if (!cluster) throw new Error(`Unknown Workflow Scope: ${scopeId}`)
    const addedSessionIds = []
    const participantsByKey = new Map(
      (plan.participants ?? []).map((participant: JsonRecord) => [participant.key, participant]),
    )
    for (const [participantKey, sessionIdValue] of Object.entries(mapping.participantSessionIds ?? {})) {
      const sessionId = optionalTrimmedString(sessionIdValue)
      if (!sessionId) continue
      if (!this.#host.state().sessions[sessionId]) continue
      const participant = participantsByKey.get(participantKey) as JsonRecord | undefined
      if (participant?.endpoint?.kind === 'existing') {
        if (sessionId !== cluster.masterSessionId && !cluster.nodeIds.includes(sessionId)) {
          throw new Error(`Existing participant ${sessionId} is outside Workflow Scope ${scopeId}.`)
        }
        continue
      }
      if (!cluster.nodeIds.includes(sessionId) && sessionId !== cluster.masterSessionId) {
        cluster.nodeIds.push(sessionId)
        addedSessionIds.push(sessionId)
      }
      const node = this.#host.state().nodes.find((candidate) => candidate.sessionId === sessionId)
      if (node) node.clusterId = scopeId
    }
    if (addedSessionIds.length > 0) {
      this.#host.appendKernelEvent(
        'scope.workflow-participants-added',
        { scopeId, workflowId: mapping.productWorkflowId, sessionIds: addedSessionIds },
        ctx,
      )
    }
  }

  workflowPatchStopSpec(stop: unknown) {
    const text = optionalTrimmedString(stop)
    if (!text) return undefined
    const max = text.match(/max\D+(\d+)/i)
    const spec: JsonRecord = {}
    if (max) spec.maxFirings = Number(max[1])
    if (/clean/i.test(text)) spec.whenReport = { verdict: 'clean' }
    else if (/done/i.test(text)) spec.whenReport = { verdict: 'done' }
    return Object.keys(spec).length > 0 ? spec : undefined
  }

  workflowPatchSubscriptionInput(
    relationship: JsonRecord,
    mapping: JsonRecord,
    version: number,
    workflowId: string,
  ) {
    const sourceSessionId = mapping.participantSessionIds?.[relationship.from]
    const targetSessionId = mapping.participantSessionIds?.[relationship.to]
    if (!sourceSessionId || !targetSessionId) {
      throw new Error(`Workflow Patch relationship ${relationship.key} has no live participant mapping.`)
    }
    const trigger = String(relationship.trigger ?? 'finished')
    const on = trigger.startsWith('report')
      ? {
          on: 'report',
          ...(trigger.includes(':')
            ? { match: { type: 'verdict', verdict: trigger.split(':')[1] } }
            : {}),
        }
      : { on: 'finished' }
    return {
      id: `workflow-${version}-${relationship.key.replace(/[^a-zA-Z0-9_-]/g, '-')}-${randomUUID().slice(0, 8)}`,
      label: relationship.key,
      preset: `workflow-patch:${relationship.recipe}`,
      sourceSessionId,
      on,
      targetSessionId,
      executionRef: {
        workflowId,
        workflowVersion: version,
        runId: optionalTrimmedString(mapping.runId) ?? workflowId,
        phaseId: relationship.key,
      },
      action: isObject(relationship.action)
        ? clone(relationship.action)
        : {
            kind: relationship.action,
            topic: relationship.recipe || 'workflow-patch',
            note: `Workflow ${relationship.key}: ${relationship.trigger}.`,
          },
      gate: relationship.gate,
      concurrency: relationship.concurrency,
      ...((relationship.runtimeStop ?? this.workflowPatchStopSpec(relationship.stop))
        ? { stop: clone(relationship.runtimeStop ?? this.workflowPatchStopSpec(relationship.stop)) }
        : {}),
      onStop: 'freeze-edge',
    }
  }

  async commitWorkflowPatch(proposal: JsonRecord, base: JsonRecord, ctx: JsonRecord) {
    const patch = proposal.patch
    if (!patch || patch.baseVersion !== base.version) {
      throw new Error('Workflow Patch metadata does not match the active base plan.')
    }
    if (base.recipe === 'plan-council') return this.#host.commitPlanCouncilPatch(proposal, base, ctx)
    const mapping = clone(base.executionMapping)
    if (!mapping) throw new Error('Active Workflow has no execution mapping to patch.')
    mapping.planVersion = proposal.proposedPlan.version
    mapping.committedAt = now()
    const createdSessionIds: string[] = []
    const createdSubscriptionIds: string[] = []
    const replacedKeys = new Set<string>(patch.impact.replacedParticipantKeys ?? [])
    const addedKeys = new Set<string>(patch.impact.addedParticipantKeys ?? [])
    const relationshipKeysToReplace = new Set<string>([
      ...(patch.impact.updatedRelationshipKeys ?? []),
      ...(proposal.proposedPlan.relationships ?? [])
        .filter((relationship: JsonRecord) =>
          !relationship.disabledByHuman &&
          (replacedKeys.has(relationship.from) || replacedKeys.has(relationship.to)))
        .map((relationship: JsonRecord) => relationship.key),
    ])
    try {
      for (const participantKey of [...replacedKeys, ...addedKeys]) {
        const participant = proposal.proposedPlan.participants.find(
          (candidate: JsonRecord) => candidate.key === participantKey,
        )
        if (!participant) throw new Error(`Workflow Patch participant vanished: ${participantKey}`)
        if (participant.endpoint.kind === 'existing') {
          mapping.participantSessionIds[participantKey] = participant.endpoint.sessionId
          continue
        }
        const created = await this.#host.cmdCreateSession({
          prompt: participant.prompt,
          label: participant.label,
          cwd: participant.workspace.cwd,
          workMode: participant.workspace.workMode,
          branch: participant.workspace.branch,
          providerKind: participant.endpoint.providerKind,
          providerInstanceId: participant.endpoint.providerInstanceId,
          runtimeSettings: participant.endpoint.runtimeSettings,
          cluster: proposal.proposedPlan.scopeId === 'global' ? undefined : proposal.proposedPlan.scopeId,
        }, ctx, { deferStart: true })
        mapping.participantSessionIds[participantKey] = created.sessionId
        createdSessionIds.push(created.sessionId)
        if (replacedKeys.has(participantKey)) {
          delete this.#host.state().sessions[created.sessionId].prepared
          await this.#host.startRun(created.sessionId, { ...created.preparedRun, runKind: 'create' })
        }
      }

      const stopKeys = new Set<string>([
        ...(patch.impact.stoppedRelationshipKeys ?? []),
        ...relationshipKeysToReplace,
      ])
      for (const relationshipKey of stopKeys) {
        const subscriptionId = mapping.relationshipSubscriptionIds?.[relationshipKey]
        if (subscriptionId && this.#host.state().subscriptions?.[subscriptionId]?.state === 'active') {
          this.#host.cmdStopSubscription({
            subscriptionId,
            reason: `Superseded by Workflow Patch v${proposal.proposedPlan.version}.`,
          }, ctx)
        }
        delete mapping.relationshipSubscriptionIds?.[relationshipKey]
        delete mapping.relationshipRuntimeRefs?.[relationshipKey]
      }

      const addKeys = new Set<string>([
        ...(patch.impact.addedRelationshipKeys ?? []),
        ...relationshipKeysToReplace,
      ])
      for (const relationshipKey of addKeys) {
        const relationship = proposal.proposedPlan.relationships.find(
          (candidate: JsonRecord) => candidate.key === relationshipKey,
        )
        if (!relationship) continue
        const authored = this.#host.cmdAuthorSubscription(
          this.workflowPatchSubscriptionInput(
            relationship,
            mapping,
            proposal.proposedPlan.version,
            proposal.proposedPlan.workflowId,
          ),
          ctx,
          { allowExecutionRef: true },
        )
        const subscriptionId = authored.subscription.id
        createdSubscriptionIds.push(subscriptionId)
        mapping.relationshipSubscriptionIds[relationshipKey] = subscriptionId
        mapping.relationshipRuntimeRefs[relationshipKey] = { kind: 'subscription', ref: subscriptionId }
      }
      return { mapping, createdSessionIds, createdSubscriptionIds }
    } catch (error) {
      for (const subscriptionId of createdSubscriptionIds) {
        if (this.#host.state().subscriptions?.[subscriptionId]?.state === 'active') {
          try {
            this.#host.cmdStopSubscription({ subscriptionId, reason: 'Workflow Patch rollback.' }, { actor: { kind: 'runtime' } })
          } catch {}
        }
      }
      for (const sessionId of createdSessionIds) {
        if (this.#host.state().sessions[sessionId] && !['failed', 'killed'].includes(this.#host.state().sessions[sessionId].status)) {
          try {
            this.#host.cmdKillSession({ sessionId, reason: 'Workflow Patch rollback.' }, { actor: { kind: 'runtime' } })
          } catch {}
        }
      }
      throw error
    }
  }

  async cmdCommitWorkflow(input: JsonRecord = {}, ctx: JsonRecord) {
    this.workflowIdempotencyKey(input, 'commit_workflow')
    const proposal = this.workflowProposal(input.proposalId)
    const expectedBaseVersion = Number(input.expectedBaseVersion)
    if (!Number.isSafeInteger(expectedBaseVersion) || expectedBaseVersion !== proposal.baseVersion) {
      throw new Error(`Workflow Proposal base version is ${proposal.baseVersion}; received ${String(input.expectedBaseVersion)}.`)
    }
    this.#host.workflowActorScopeId(ctx, proposal.proposedPlan.scopeId)
    if (proposal.status === 'committed') {
      throw new Error(`Workflow Proposal ${proposal.proposalId} is already committed; replay the original idempotency key to retrieve its result.`)
    }
    if (proposal.status !== 'approved') {
      throw new Error(`Workflow Proposal must be approved before commit; current status is ${proposal.status}.`)
    }
    const currentActive = this.activeWorkflowPlan(proposal.workflowId)
    const activeVersion = currentActive?.version ?? 0
    if (activeVersion !== proposal.baseVersion) {
      throw new Error(`Workflow ${proposal.workflowId} changed after this proposal was created.`)
    }
    const context = this.workflowAuthoringContext(proposal.proposedPlan.scopeId)
    proposal.validation = this.validateWorkflowProposalPlan(proposal.proposedPlan, context, proposal.patch)
    if (proposal.validation.errors.length > 0) {
      throw new Error(`Workflow Proposal is no longer valid: ${proposal.validation.errors.map((issue) => issue.message).join(' ')}`)
    }
    proposal.proposedPlan.status = 'committing'
    this.storeWorkflowPlan(proposal.proposedPlan)
    if (proposal.patch) {
      const patched = await this.commitWorkflowPatch(proposal, currentActive, ctx)
      const mapping = patched.mapping
      this.attachWorkflowExecutionToScope(proposal.proposedPlan.scopeId, mapping, proposal.proposedPlan, ctx)
      currentActive.status = 'superseded'
      this.storeWorkflowPlan(currentActive)
      proposal.proposedPlan.status = 'active'
      proposal.proposedPlan.executionMapping = mapping
      proposal.status = 'committed'
      proposal.committedAt = mapping.committedAt
      proposal.updatedAt = mapping.committedAt
      this.storeWorkflowPlan(proposal.proposedPlan)
      for (const wakeupId of proposal.patch.wakeupIds ?? []) {
        const wakeup = this.#host.state().workflowWakeups?.[wakeupId]
        if (wakeup && !['acknowledged', 'superseded'].includes(wakeup.status)) {
          wakeup.status = 'acknowledged'
          wakeup.acknowledgedAt = mapping.committedAt
          wakeup.acknowledgedBy = clone(ctx.actor)
          wakeup.acknowledgmentReason = `Handled by Workflow Patch ${proposal.proposalId}.`
        }
      }
      for (const wakeup of Object.values(this.#host.state().workflowWakeups ?? {}) as JsonRecord[]) {
        if (
          wakeup.workflowId === proposal.workflowId &&
          wakeup.workflowVersion === proposal.baseVersion &&
          ['pending', 'notified'].includes(wakeup.status)
        ) {
          wakeup.status = 'superseded'
          wakeup.acknowledgedAt = mapping.committedAt
          wakeup.acknowledgedBy = clone(ctx.actor)
          wakeup.acknowledgmentReason = `Superseded by committed Workflow Patch ${proposal.proposalId}.`
          this.#host.appendKernelEvent(
            'workflow.master-wakeup.superseded',
            { wakeupId: wakeup.wakeupId, workflowId: wakeup.workflowId, workflowVersion: wakeup.workflowVersion },
            ctx,
            { reason: wakeup.acknowledgmentReason },
          )
        }
      }
      this.#host.appendKernelEvent('workflow.patch.committed', {
        proposalId: proposal.proposalId,
        workflowId: proposal.workflowId,
        baseVersion: proposal.baseVersion,
        version: proposal.proposedPlan.version,
        impact: proposal.patch.impact,
        rollback: proposal.patch.rollback,
        executionMapping: mapping,
        createdSessionIds: patched.createdSessionIds,
        createdSubscriptionIds: patched.createdSubscriptionIds,
      }, ctx, { reason: optionalTrimmedString(input.reason) ?? proposal.patch.reason })
      this.#host.touch()
      this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
      return {
        proposal: clone(proposal),
        plan: clone(proposal.proposedPlan),
        executionMapping: clone(mapping),
        result: {
          incremental: true,
          createdSessionIds: patched.createdSessionIds,
          createdSubscriptionIds: patched.createdSubscriptionIds,
        },
        state: this.#host.getState(),
      }
    }

    const recipeInput = clone(proposal.proposedPlan.recipeInput.input)
    if (proposal.proposedPlan.recipe === 'goal') {
      const judge = proposal.proposedPlan.participants.find(
        (participant) => participant.key === 'judge' && participant.endpoint.kind === 'new',
      )
      if (judge?.endpoint.runtimeSettings) {
        recipeInput.judgeRuntimeSettings = clone(judge.endpoint.runtimeSettings)
      }
    }
    if (proposal.proposedPlan.recipe === 'review') {
      const reviewer = proposal.proposedPlan.participants.find(
        (participant) => participant.key === 'reviewer' && participant.endpoint.kind === 'new',
      )
      if (reviewer?.endpoint.runtimeSettings && recipeInput.reviewer?.kind === 'new') {
        recipeInput.reviewer.runtimeSettings = clone(reviewer.endpoint.runtimeSettings)
      }
    }
    if (proposal.proposedPlan.recipe === 'plan-council') {
      recipeInput.workflowPlanRef = {
        workflowId: proposal.workflowId,
        version: proposal.proposedPlan.version,
      }
    }
    recipeInput.idempotencyKey = `workflow-commit:${proposal.proposalId}`
    let result
    if (proposal.proposedPlan.recipe === 'review') result = await this.#host.startReviewWorkflow(recipeInput)
    else if (proposal.proposedPlan.recipe === 'goal') result = await this.#host.startGoalWorkflow(recipeInput)
    else if (proposal.proposedPlan.recipe === 'handoff') result = await this.#host.startHandoffWorkflow(recipeInput)
    else result = await this.#host.startPlanCouncil(recipeInput)

    const mapping = this.workflowExecutionMapping(proposal.proposedPlan, result)
    this.attachWorkflowExecutionToScope(proposal.proposedPlan.scopeId, mapping, proposal.proposedPlan, ctx)
    if (currentActive && currentActive.version !== proposal.proposedPlan.version) {
      currentActive.status = 'superseded'
      this.storeWorkflowPlan(currentActive)
    }
    proposal.proposedPlan.status = 'active'
    proposal.proposedPlan.executionMapping = mapping
    proposal.status = 'committed'
    proposal.committedAt = mapping.committedAt
    proposal.updatedAt = mapping.committedAt
    this.storeWorkflowPlan(proposal.proposedPlan)
    this.#host.appendKernelEvent(
      'workflow.committed',
      {
        proposalId: proposal.proposalId,
        workflowId: proposal.workflowId,
        version: proposal.proposedPlan.version,
        recipe: proposal.proposedPlan.recipe,
        executionMapping: mapping,
      },
      ctx,
      { reason: optionalTrimmedString(input.reason) ?? proposal.proposedPlan.reason },
    )
    this.#host.touch()
    this.#host.broadcast({ type: 'workflow.proposal.updated', proposalId: proposal.proposalId, state: this.#host.getState() })
    return {
      proposal: clone(proposal),
      plan: clone(proposal.proposedPlan),
      executionMapping: clone(mapping),
      result: Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'state')),
      state: this.#host.getState(),
    }
  }

  inspectWorkflowScope(input: JsonRecord = {}, source?: string) {
    const ctx = source
      ? { actor: this.#host.membraneActor(source) }
      : { actor: { kind: 'human' } }
    const scopeId = this.#host.workflowActorScopeId(ctx, optionalTrimmedString(input.scopeId))
    const cluster = scopeId === 'global' ? undefined : this.#host.state().clusters[scopeId]
    if (scopeId !== 'global' && !cluster) throw new Error(`Unknown Scope: ${scopeId}`)
    const allSessionIds = scopeId === 'global'
      ? Object.keys(this.#host.state().sessions)
      : [...new Set([...(cluster.nodeIds ?? []), cluster.masterSessionId].filter(Boolean))]
    const pageSize = Math.max(1, Math.min(50, Number.isSafeInteger(input.pageSize) ? input.pageSize : 20))
    const offset = Math.max(0, Number.isSafeInteger(Number(input.cursor)) ? Number(input.cursor) : 0)
    const sessionRefs = allSessionIds.slice(offset, offset + pageSize).map((sessionId) => {
      const session = this.#host.state().sessions[sessionId]
      return {
        sessionId,
        label: session?.label,
        role: session?.role,
        status: session?.status,
        providerKind: session?.providerKind,
        providerInstanceId: session?.providerInstanceId,
        runtimeSettings: clone(session?.runtimeSettings ?? {}),
        cwd: session?.cwd,
        frozen: this.#host.isSessionFrozen(sessionId),
      }
    })
    const proposals = Object.values(this.#host.state().workflowProposals ?? {})
      .filter((proposal: JsonRecord) => proposal.proposedPlan?.scopeId === scopeId)
      .map((proposal: JsonRecord) => ({
        proposalId: proposal.proposalId,
        workflowId: proposal.workflowId,
        version: proposal.proposedPlan.version,
        recipe: proposal.proposedPlan.recipe,
        objective: proposal.proposedPlan.objective,
        status: proposal.status,
        ...(proposal.proposedPlan.executionMapping?.productWorkflowId
          ? {
              productWorkflowId: proposal.proposedPlan.executionMapping.productWorkflowId,
              planVersion: proposal.proposedPlan.executionMapping.planVersion,
            }
          : {}),
      }))
    return {
      scope: {
        scopeId,
        label: cluster?.label ?? 'All sessions',
        masterSessionId: cluster?.masterSessionId,
        frozen: cluster?.frozen === true,
      },
      capability: clone(this.workflowCapability(scopeId)),
      summary: {
        sessionCount: allSessionIds.length,
        proposalCount: proposals.length,
        activeWorkflowCount: proposals.filter((proposal) => proposal.status === 'committed').length,
      },
      sessionRefs,
      providerRefs: this.#host.state().providerInstances.map((instance) => ({
        providerInstanceId: instance.providerInstanceId,
        kind: instance.kind,
        label: instance.label,
      })),
      workflowRefs: proposals,
      nextCursor: offset + pageSize < allSessionIds.length ? String(offset + pageSize) : undefined,
    }
  }

  explainWorkflow(input: JsonRecord = {}, source?: string) {
    const proposal = this.workflowProposal(input.proposalId)
    if (source) this.#host.workflowActorScopeId({ actor: this.#host.membraneActor(source) }, proposal.proposedPlan.scopeId)
    return {
      proposalId: proposal.proposalId,
      workflowId: proposal.workflowId,
      version: proposal.proposedPlan.version,
      objective: proposal.proposedPlan.objective,
      recipe: proposal.proposedPlan.recipe,
      status: proposal.status,
      participants: clone(proposal.proposedPlan.participants),
      relationships: clone(proposal.proposedPlan.relationships),
      autonomyPolicy: clone(proposal.proposedPlan.autonomyPolicy),
      graphDiff: clone(proposal.graphDiff),
      validation: clone(proposal.validation),
    }
  }

  workflowProposalMembraneView(proposal: JsonRecord) {
    const plan = proposal.proposedPlan
    const diffKeys = (group: JsonRecord = {}) => ({
      add: (group.add ?? []).map((entry) => entry.key),
      update: (group.update ?? []).map((entry) => entry.key),
      remove: (group.remove ?? []).map((entry) => entry.key),
    })
    return {
      proposalId: proposal.proposalId,
      workflowId: proposal.workflowId,
      baseVersion: proposal.baseVersion,
      version: plan.version,
      status: proposal.status,
      recipe: plan.recipe,
      objective: plan.objective,
      scopeId: plan.scopeId,
      participants: plan.participants.map((participant) => ({
        key: participant.key,
        label: participant.label,
        role: participant.role,
        endpoint: participant.endpoint.kind === 'existing'
          ? { kind: 'existing', sessionId: participant.endpoint.sessionId }
          : {
              kind: 'new',
              providerKind: participant.endpoint.providerKind,
              providerInstanceId: participant.endpoint.providerInstanceId,
            },
        workspace: participant.workspace,
        lockedByHuman: participant.lockedByHuman === true,
      })),
      relationships: plan.relationships.map((relationship) => ({
        key: relationship.key,
        from: relationship.from,
        to: relationship.to,
        trigger: relationship.trigger,
        action: relationship.action,
        gate: relationship.gate,
        stop: relationship.stop,
        lockedByHuman: relationship.lockedByHuman === true,
        ...(relationship.disabledByHuman ? { disabledByHuman: clone(relationship.disabledByHuman) } : {}),
      })),
      graphDiff: {
        participants: diffKeys(proposal.graphDiff.participants),
        relationships: diffKeys(proposal.graphDiff.relationships),
      },
      ...(proposal.patch ? { patch: clone(proposal.patch) } : {}),
      validation: clone(proposal.validation),
      ...(plan.executionMapping ? { executionMapping: clone(plan.executionMapping) } : {}),
    }
  }

}
