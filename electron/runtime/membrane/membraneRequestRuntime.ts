import { providerKinds, providerMetadata } from '../../../shared/provider-metadata.js'
import { validateExecutionEnvelope } from '../../../shared/execution-envelope.js'
import {
  type JsonRecord,
  clone,
  isObject,
  optionalTrimmedString,
  validProviderKinds,
} from '../runtimeCommon.js'
import {
  defaultProviderInstanceForKind,
  defaultProviderRuntimeSettings,
} from '../providers/providerConfigNormalize.js'
import type { WorkflowKernel } from '../workflows/workflowKernel.js'
import { activeReviewPairRole } from '../workflows/classicWorkflows.js'
import { nextCouncilBarrierGeneration } from '../workflows/planCouncil.js'

export interface MembraneRequestRuntimeHost {
  state(): JsonRecord
  dispatchCommand(command: JsonRecord): Promise<JsonRecord>
  workflowKernel(): WorkflowKernel
  workflowActorScopeId(ctx: JsonRecord, requestedScopeId?: string): string
  inspectWorkflowScope(input: JsonRecord, source: string): unknown
  inspectWorkflowWakeups(input: JsonRecord, source: string): unknown
  explainWorkflow(input: JsonRecord, source: string): JsonRecord
  workflowProposal(proposalId: unknown): JsonRecord
  workflowProposalMembraneView(proposal: JsonRecord): JsonRecord
  runExecution(source: string): unknown
  masterClusterId(sessionId: string): string | undefined
}

export class MembraneRequestRuntime {
  #host: MembraneRequestRuntimeHost

  constructor(host: MembraneRequestRuntimeHost) {
    this.#host = host
  }

  async handleRequest({ tool, source, input }: JsonRecord) {
    if (!this.#host.state().sessions[source]) {
      throw new Error(`Unknown membrane source session: ${source}`)
    }

    const actor = this.membraneActor(source)
    const request = isObject(input) ? input : {}

    if (tool === 'inspect_scope') {
      return this.#host.inspectWorkflowScope(request, source)
    }

    if (tool === 'inspect_workflow_wakeups') {
      return this.#host.inspectWorkflowWakeups(request, source)
    }

    if (tool === 'acknowledge_workflow_wakeup') {
      const wakeupId = optionalTrimmedString(request.wakeupId)
      const result = await this.#host.dispatchCommand({
        commandId: optionalTrimmedString(request.commandId) ?? `ack-${wakeupId}-${source}`,
        idempotencyKey: optionalTrimmedString(request.idempotencyKey) ?? `ack:${wakeupId}:${source}`,
        kind: 'acknowledge_workflow_wakeup',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: request,
      })
      return { wakeup: result.wakeup }
    }

    if (tool === 'advance_plan_council') {
      if (actor.kind !== 'master') {
        throw new Error('advance_plan_council is available only to a governing Master.')
      }
      const workflowId = optionalTrimmedString(request.workflowId)
      const council = workflowId ? this.#host.state().planCouncils?.[workflowId] : undefined
      if (!council) throw new Error(`Unknown Plan Council: ${workflowId ?? ''}`)
      const activePlan = Object.values(this.#host.state().workflowPlans ?? {})
        .flatMap((versions: JsonRecord) => Object.values(versions) as JsonRecord[])
        .find(
          (plan: JsonRecord) =>
            plan.status === 'active' &&
            plan.executionMapping?.productWorkflowId === workflowId,
        ) as JsonRecord | undefined
      if (!activePlan) {
        throw new Error('Plan Council is not attached to an active governed Workflow Plan.')
      }
      this.#host.workflowActorScopeId({ actor }, activePlan.scopeId)
      const gate = council.phase === 'ready-for-cross-review'
        ? 'crossReview'
        : council.phase === 'ready-for-synthesis'
          ? 'synthesis'
          : undefined
      const requestedWakeupId = optionalTrimmedString(request.wakeupId)
      const wakeup = requestedWakeupId
        ? this.#host.state().workflowWakeups?.[requestedWakeupId]
        : [...Object.values(this.#host.state().workflowWakeups ?? {}) as JsonRecord[]]
            .reverse()
            .find((candidate) =>
              candidate.workflowId === activePlan.workflowId &&
              candidate.kind === 'workflow-milestone' &&
              ['pending', 'notified'].includes(candidate.status) &&
              String(candidate.summary ?? '').includes(council.workflowId),
            )
      if (
        requestedWakeupId &&
        (!wakeup || wakeup.workflowId !== activePlan.workflowId ||
          wakeup.kind !== 'workflow-milestone' ||
          !String(wakeup.summary ?? '').includes(council.workflowId))
      ) {
        throw new Error(`Workflow wakeup ${requestedWakeupId} does not govern Plan Council ${council.workflowId}.`)
      }
      const wakeupGate = String(wakeup?.summary ?? '').includes('crossReview')
        ? 'crossReview'
        : String(wakeup?.summary ?? '').includes('synthesis')
          ? 'synthesis'
          : undefined
      const acknowledgeGateWakeup = async (resolvedGate: string) => {
        if (!wakeup || !['pending', 'notified'].includes(wakeup.status)) return
        await this.#host.dispatchCommand({
          commandId: `ack-council-gate-${wakeup.wakeupId}-${source}`,
          idempotencyKey: `ack-council-gate:${wakeup.wakeupId}:${source}`,
          kind: 'acknowledge_workflow_wakeup',
          actor,
          reason: optionalTrimmedString(request.reason),
          input: {
            wakeupId: wakeup.wakeupId,
            reason: optionalTrimmedString(request.reason) ?? `Advanced Plan Council ${resolvedGate}.`,
          },
        })
      }
      if (!gate) {
        const alreadyAdvanced = wakeupGate === 'crossReview'
          ? ['reviewing-peers', 'ready-for-synthesis', 'synthesizing', 'completed'].includes(council.phase)
          : wakeupGate === 'synthesis'
            ? ['synthesizing', 'completed'].includes(council.phase)
            : false
        if (alreadyAdvanced && wakeup && ['pending', 'notified'].includes(wakeup.status)) {
          await acknowledgeGateWakeup(wakeupGate)
          return { council: clone(council), wakeup: clone(wakeup) }
        }
        throw new Error(`Plan Council is ${council.phase}; no phase is waiting for advancement.`)
      }
      if (wakeupGate && wakeupGate !== gate) {
        throw new Error(`Workflow wakeup ${wakeup.wakeupId} is for ${wakeupGate}, not ${gate}.`)
      }
      if ((council.advancement?.[gate] ?? 'human') !== 'master') {
        throw new Error(`Plan Council ${gate} advancement is not delegated to Master.`)
      }
      const kind = gate === 'crossReview'
        ? 'start_plan_council_cross_review'
        : 'start_plan_council_synthesis'
      const generation = nextCouncilBarrierGeneration(
        this.#host.workflowKernel(),
        council,
        gate === 'crossReview' ? 'peer-review' : 'synthesis',
      )
      const result = await this.#host.dispatchCommand({
        commandId: optionalTrimmedString(request.commandId),
        idempotencyKey: optionalTrimmedString(request.idempotencyKey) ??
          `council-master:${council.runId}:${gate}:g${generation}`,
        kind,
        actor,
        reason: optionalTrimmedString(request.reason),
        input: { workflowId },
      })
      await acknowledgeGateWakeup(gate)
      return { council: result.council, ...(wakeup ? { wakeup: clone(wakeup) } : {}) }
    }

    if (tool === 'explain_workflow') {
      const explained = this.#host.explainWorkflow(request, source)
      return this.#host.workflowProposalMembraneView(
        this.#host.workflowProposal(explained.proposalId),
      )
    }

    if (tool === 'propose_workflow') {
      const result = await this.#host.dispatchCommand({
        commandId: optionalTrimmedString(request.commandId),
        idempotencyKey: optionalTrimmedString(request.idempotencyKey),
        kind: 'propose_workflow',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: request,
      })
      return this.#host.workflowProposalMembraneView(result.proposal)
    }

    if (tool === 'propose_workflow_patch') {
      const result = await this.#host.dispatchCommand({
        commandId: optionalTrimmedString(request.commandId),
        idempotencyKey: optionalTrimmedString(request.idempotencyKey),
        kind: 'propose_workflow_patch',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: request,
      })
      return this.#host.workflowProposalMembraneView(result.proposal)
    }

    if (tool === 'revise_workflow') {
      const result = await this.#host.dispatchCommand({
        commandId: optionalTrimmedString(request.commandId),
        idempotencyKey: optionalTrimmedString(request.idempotencyKey),
        kind: 'revise_workflow',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: request,
      })
      return this.#host.workflowProposalMembraneView(result.proposal)
    }

    if (tool === 'commit_workflow') {
      const idempotencyKey = optionalTrimmedString(request.idempotencyKey)
      if (!idempotencyKey) throw new Error('commit_workflow idempotencyKey is required')
      const result = await this.#host.dispatchCommand({
        commandId: `workflow-commit-${idempotencyKey}`,
        idempotencyKey,
        kind: 'commit_workflow',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: request,
      })
      return this.#host.workflowProposalMembraneView(result.proposal)
    }

    if (tool === 'abort_workflow') {
      const result = await this.#host.dispatchCommand({
        commandId: optionalTrimmedString(request.commandId),
        idempotencyKey: optionalTrimmedString(request.idempotencyKey),
        kind: 'abort_workflow_proposal',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: request,
      })
      return this.#host.workflowProposalMembraneView(result.proposal)
    }

    if (tool === 'create_session') {
      if (actor.kind === 'master') {
        throw new Error(
          'Master sessions cannot create raw graph nodes. Use propose_workflow so capability checks, Graph Diff, approval, and atomic commit are enforced.',
        )
      }
      const reviewRole = activeReviewPairRole(this.#host.workflowKernel(), source)
      if (reviewRole) {
        throw new Error(
          `${reviewRole} is already assigned to an active Review until clean workflow. Do not create another session; continue your assigned work and finish so Orrery can advance the existing review pair.`,
        )
      }
      const result = await this.#host.dispatchCommand({
        kind: 'create_session',
        actor,
        input: this.membraneCreateInput(source, request),
      })
      return { sessionId: result.sessionId }
    }

    if (tool === 'resume_session') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('resume_session sessionId is required')
      }
      this.#assertMembraneTargetInScope(source, target)
      const message = optionalTrimmedString(request.message)
      if (!message) {
        throw new Error('resume_session message is required')
      }
      await this.#host.dispatchCommand({
        kind: 'resume_session',
        actor,
        input: {
          sessionId: target,
          message,
          context: request.context,
          edgeSourceSessionId: source,
          masterReason: request.masterReason,
          reason: request.reason,
        },
      })
      return { ok: true }
    }

    if (tool === 'deliver') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('deliver sessionId is required')
      }
      this.#assertMembraneTargetInScope(source, target)
      const result = await this.#host.dispatchCommand({
        kind: 'deliver',
        actor,
        input: {
          sessionId: target,
          topic: request.topic,
          note: request.note,
          content: request.content,
          filename: request.filename,
        },
      })
      return { ok: true, delivery: result.delivery }
    }

    if (tool === 'activate') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('activate sessionId is required')
      }
      this.#assertMembraneTargetInScope(source, target)
      await this.#host.dispatchCommand({
        kind: 'activate',
        actor,
        input: {
          sessionId: target,
          note: request.note,
          edgeSourceSessionId: source,
          masterReason: request.masterReason,
          reason: request.reason,
        },
      })
      return { ok: true }
    }

    if (tool === 'approve_activation') {
      this.#assertMembraneActivationInScope(source, request.slotKey)
      return this.#host.dispatchCommand({
        kind: 'approve_activation',
        actor,
        reason:
          optionalTrimmedString(request.note) ??
          optionalTrimmedString(request.reason),
        input: {
          slotKey: request.slotKey,
          note: request.note,
        },
      })
    }

    if (tool === 'deny_activation') {
      this.#assertMembraneActivationInScope(source, request.slotKey)
      return this.#host.dispatchCommand({
        kind: 'deny_activation',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: {
          slotKey: request.slotKey,
          reason: request.reason,
        },
      })
    }

    if (tool === 'report') {
      const execution = this.#host.runExecution(source)
      return this.#host.dispatchCommand({
        kind: 'report',
        actor,
        ...(validateExecutionEnvelope(execution) ? { execution: clone(execution) } : {}),
        input: request,
      })
    }

    if (tool === 'link_sessions') {
      if (actor.kind === 'master') {
        throw new Error(
          'Master sessions cannot author raw relationship edges. Use propose_workflow and commit an approved Proposal.',
        )
      }
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('link_sessions sessionId is required')
      }
      const { edge } = await this.#host.dispatchCommand({
        kind: 'link_sessions',
        actor,
        input: {
          source,
          target,
          label: request.label,
          reason: request.reason,
        },
      })
      return { ok: true, edgeId: edge.edgeId }
    }

    throw new Error(`Unknown membrane tool: ${tool}`)
  }

  membraneActor(source: string) {
    return {
      kind:
        this.#host.state().sessions[source]?.role === 'master' ? 'master' : 'agent',
      ref: source,
    }
  }

  // Maps a membrane create_session request onto the unified command input.
  // Same-provider children inherit the exact instance/settings; cross-provider
  // children use the target provider defaults so incompatible model/runtime
  // knobs never leak across provider boundaries.
  membraneCreateInput(source: string, input: JsonRecord = {}) {
    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : undefined
    if (!prompt) {
      throw new Error('create_session prompt is required')
    }

    const sourceNode = this.#host.state().nodes.find(
      (node) => node.sessionId === source,
    )
    const sourceSession = this.#host.state().sessions[source]
    const requestedAgent = optionalTrimmedString(input.agent)
    if (requestedAgent && !validProviderKinds.has(requestedAgent)) {
      throw new Error(
        `Unsupported membrane agent: ${requestedAgent}. Expected one of ${providerKinds.join(', ')}.`,
      )
    }
    // Preserve the pre-provider membrane contract for internal callers that
    // omitted agent; the MCP schema asks agents to choose explicitly.
    const requestedKind = requestedAgent ?? 'claude-code'
    const sameProvider = sourceSession?.providerKind === requestedKind
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : sourceNode?.clusterId
    const label = optionalTrimmedString(input.label)

    return {
      agent: providerMetadata[requestedKind].agent,
      providerKind: requestedKind,
      providerInstanceId:
        sameProvider
          ? sourceSession.providerInstanceId
          : defaultProviderInstanceForKind(requestedKind).providerInstanceId,
      prompt,
      cwd: sourceSession?.cwd,
      context: input.context,
      contextTopic: input.contextTopic,
      cluster,
      label: input.label,
      runtimeSettings:
        sameProvider
          ? sourceSession.runtimeSettings
          : defaultProviderRuntimeSettings,
      sourceSessionId: source,
      linkLabel: label ? `create: ${label}` : 'create_session',
      masterReason: input.masterReason,
      reason: input.reason,
    }
  }

  #assertMembraneTargetInScope(source: string, target: string) {
    if (this.#host.state().sessions[source]?.role !== 'master') return
    const scopeId = this.#host.masterClusterId(source)
    const cluster = scopeId ? this.#host.state().clusters[scopeId] : undefined
    if (!cluster || (target !== source && !cluster.nodeIds.includes(target))) {
      throw new Error(`Master ${source} cannot operate session ${target} outside its governed Scope.`)
    }
  }

  #assertMembraneActivationInScope(source: string, slotKey: unknown) {
    if (this.#host.state().sessions[source]?.role !== 'master') return
    const key = optionalTrimmedString(slotKey)
    const slot = key ? this.#host.state().pendingActivations?.[key] : undefined
    if (!slot) throw new Error(`Unknown pending activation: ${key ?? ''}`)
    this.#assertMembraneTargetInScope(source, slot.target)
  }
}
