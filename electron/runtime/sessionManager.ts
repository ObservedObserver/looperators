// RuntimeSessionManager: the runtime kernel's stateful orchestration core.
// This file is deliberately large because it holds one causal chain --
// command dispatch -> transaction -> scheduler -> run execution -> commit --
// plus (for now) the product workflow composers built on top of it.
//
// Section guide (approximate order):
//   1. Constants + command kinds
//   2. RuntimeSessionManager class
//      - command dispatch, control transactions, compensation
//      - subscription scheduler: firing -> pending activation -> gate -> execute
//      - external event sources
//      - session lifecycle: create/resume/deliver/activate/archive/kill
//      - cluster/master/loop control
//      - workflow proposals, wakeups, barriers
//      - resource policy, run queue, launchRun, provider event stream
//      - checkpoints/diffs, reports, persistence triggers
//
// Split-out knowledge domains (import, don't re-add here):
//   runtimeCommon.ts                      shared value helpers + validation sets
//   workspace/gitWorkspace.ts             git/worktree/branch/checkpoint-ref/diff
//   workspace/workspaceFiles.ts           workspace file tree + open-in-app
//   workspace/workspaceService.ts         public workspace reads + open facade
//   providers/providerConfigNormalize.ts  provider instance/runtime config
//   sessions/sessionInteraction.ts        attachments + request/input normalization
//   persistence/runtimeStateRecovery.ts   state load/normalize/migrate/repair
//   terminal/terminalService.ts           embedded terminal subsystem
//   subscriptionAuthoring.ts              author_subscription input validation
//   workspace/sessionCheckpoints.ts       per-turn git checkpoints + diffs
//   providers/providerSetupStatus.ts      provider CLI/model-catalog probing
//   control/commandRegistry.ts             command kind + handler/policy registry
//   control/commandExecutor.ts             serialized transaction + effect authority
//   clusters/clusterControlRuntime.ts      Scope/Master/Loop/freeze topology control
//   membrane/membraneRequestRuntime.ts     sanctioned agent control-surface dispatch
//   scheduler/schedulerRuntime.ts           fact -> gate -> activation + timer lifecycle
//   sessions/sessionRuntimeController.ts    admission + provider turn lifecycle
//   reports/reportFormatting.ts            report/prompt render + payload validation
//   queries/runtimeQueries.ts               read-only state/kernel projections
//   external/externalIngestionService.ts    source registry, adapters + ingestion
//   workflows/workflowKernel.ts           the explicit kernel surface below
//   workflows/governanceRuntime.ts        wakeup + Barrier state machines
//   workflows/proposalRuntime.ts          Proposal/Patch authoring + commit
//   workflows/classicWorkflows.ts         draft/handoff/goal/connect + deployments
//   workflows/planCouncil.ts              plan council orchestration
//   workflows/reviewWorkflow.ts           review ring composer
//   workflows/goalTemplates.ts            goal loop + template library
//   workflows/workflowShared.ts           workflow resource compensation
//
// Growth stopline: new product workflows must not add new knowledge domains
// to this class; register the domain here and put the implementation in its
// own module (see design-docs/session-manager-split-plan.md).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEmptyGraphState } from '../../shared/graph-state.js'
import { providerEnvKeyIsSensitive } from '../../shared/provider-setup.js'
import { ContextChannelStore, activationPreamble } from './contextChannel.js'
import { ExternalIngestionService } from './external/externalIngestionService.js'
import {
  KernelStore,
  kernelDatabaseFileFor,
} from './kernelStore.js'
import { MembraneBridge } from './membraneBridge.js'
import { ProviderService } from './providerService.js'
import { validateExecutionEnvelope } from '../../shared/execution-envelope.js'
import {
  type JsonRecord,
  clone,
  diagnostic,
  isObject,
  nonEmptyString,
  now,
  optionalTrimmedString,
  truncateForLog,
  validProviderKinds,
  validRuntimeRequestDecisions,
} from './runtimeCommon.js'
import {
  createPlannedSessionWorktree,
  localSessionWorkspace,
  normalizeWorkMode,
  planSessionWorktree,
  validateRunnableCwd,
} from './workspace/gitWorkspace.js'
import { WorkspaceService } from './workspace/workspaceService.js'
import {
  defaultProviderInstanceForKind,
  normalizeProviderInstance,
  normalizeProviderRuntimeSettings,
  providerConfig,
} from './providers/providerConfigNormalize.js'
import {
  firstUserInputAnswer,
  normalizeChatAttachments,
  normalizeRuntimeRequestDecision,
  normalizeUserInputAnswers,
  runtimeRequestStatusForDecision,
  userInputQuestionsAreComplete,
} from './sessions/sessionInteraction.js'
import {
  loadLegacyJsonState,
  normalizeState,
  withDiagnostics,
} from './persistence/runtimeStateRecovery.js'
import {
  type CheckpointHost,
  checkpointDiffForSession,
  gitDiffForSession,
} from './workspace/sessionCheckpoints.js'
import {
  type ProviderSetupHost,
  getProviderSetupStatus,
} from './providers/providerSetupStatus.js'
import { TerminalService } from './terminal/terminalService.js'
import {
  createKernelCommandRegistry,
  type KernelCommandHandlers,
} from './control/commandRegistry.js'
import {
  CommandExecutor,
  type RecoveryControlCommand,
} from './control/commandExecutor.js'
import { ClusterControlRuntime } from './clusters/clusterControlRuntime.js'
import { MembraneRequestRuntime } from './membrane/membraneRequestRuntime.js'
import { SchedulerRuntime } from './scheduler/schedulerRuntime.js'
import {
  SessionRuntimeController,
  type RuntimeRun,
} from './sessions/sessionRuntimeController.js'
import {
  masterReasonFromInput,
  normalizeReportPayload,
  reportSummary,
} from './reports/reportFormatting.js'
import { RuntimeQueries } from './queries/runtimeQueries.js'
import type { WorkflowKernel } from './workflows/workflowKernel.js'
import { WorkflowGovernanceRuntime } from './workflows/governanceRuntime.js'
import { WorkflowProposalRuntime } from './workflows/proposalRuntime.js'
import {
  automaticDeploymentExistingSessionIds,
  captureWorkflowSession,
  coderActivationNote,
  connectAgents,
  getWorkflowDeployments,
  isGoalPairShape,
  isReviewPairShape,
  journalAutomaticDeploymentResources,
  journalAutomaticDeploymentRunStarted,
  journalPlannedWorkflowResource,
  reconcileDynamicTopology,
  recoverWorkflowDeployments,
  reviewerActivationNote,
  reviewerBootstrapPrompt,
  startDraftWorkflow,
  startGoalWorkflow,
  startHandoffWorkflow,
} from './workflows/classicWorkflows.js'
import {
  cmdRetryPlanCouncilParticipant,
  commitPlanCouncilPatch,
  getPlanCouncil,
  getPlanCouncilArtifact,
  planCouncilFailed,
  planCouncilFinished,
  planCouncilForSession,
  reconcileInterruptedPlanCouncils,
  startPlanCouncil,
  startPlanCouncilCrossReview,
  startPlanCouncilSynthesis,
  stopPlanCouncil,
} from './workflows/planCouncil.js'
import { startReviewWorkflow } from './workflows/reviewWorkflow.js'
import { discardWorkflowSession } from './workflows/workflowShared.js'
import {
  applyTemplate,
  createGoalLoop,
  listTemplates,
  removeTemplate,
  saveTemplate,
} from './workflows/goalTemplates.js'

const defaultPrompt =
  'You are running under Orrery P1 live session verification. Reply with one short sentence confirming the provider connection is working, then stop.'

function messageContent(message, context) {
  if (typeof context === 'string' && context.trim().length > 0) {
    return `${message}\n\nContext:\n${context}`
  }

  return message
}

function providerPromptContent(input) {
  return messageContent(input.message, input.context)
}

export class RuntimeSessionManager {
  #state: JsonRecord = createEmptyGraphState()
  #runs = new Map<string, RuntimeRun>()
  #runContext = new Map<string, JsonRecord>()
  #terminalService = new TerminalService({
    broadcast: (event) => this.#broadcast(event),
    resolveSession: (sessionId) => this.#state.sessions[sessionId],
  })
  #storageFile: string | undefined
  #kernelStore: KernelStore
  #channelStore: ContextChannelStore
  #legacyImportKind: 'migration' | 'fossil-rollback' | undefined
  #restartInterruptedSessionIds: string[] = []
  #bridge: MembraneBridge
  #providerService: ProviderService
  #planCouncilInFlight = new Set<string>()
  // Concurrent-compile guards for workflow composers (see workflows/).
  #goalLoopInFlight = new Set<string>()
  #classicWorkflowInFlight = new Set<string>()
  #workflowCompensatedRuns = new Set<string>()
  #commandExecutor: CommandExecutor
  #queries = new RuntimeQueries({
    liveState: () => this.#state,
    readState: () => this.#readState(),
    listKernelEvents: (input) => this.#kernelStore.listEvents(input),
    latestKernelSeq: () => this.#kernelStore.latestSeq(),
  })
  #workspaceService = new WorkspaceService({
    readState: () => this.#readState(),
    checkpointHost: () => this.#checkpointHost(),
  })
  #externalIngestion = new ExternalIngestionService({
    liveState: () => this.#state,
    appendKernelEvent: (type, payload, ctx, options) =>
      this.#appendKernelEvent(type, payload, ctx, options),
    stopSubscription: (input, ctx) =>
      this.#scheduler.cmdStopSubscription(input, ctx),
    latestEventWithPayloadValue: (type, payloadKey, payloadValue) =>
      this.#kernelStore.latestEventWithPayloadValue(
        type,
        payloadKey,
        payloadValue,
      ),
    touch: () => this.#touch(),
    broadcastState: () =>
      this.#broadcast({ type: 'runtime.state', state: this.getState() }),
    stagePostCommitEffect: (label, run) =>
      this.#commandExecutor.stagePostCommitEffect({ label, run }),
  })
  #clusterControl = new ClusterControlRuntime({
    state: () => this.#state,
    humanCtx: () => this.#humanCtx(),
    reviveDirectProviderRuntime: () => this.#reviveDirectProviderRuntime(),
    getState: () => this.getState(),
    appendKernelEvent: (type, payload, ctx, options) =>
      this.#appendKernelEvent(type, payload, ctx, options),
    touch: () => this.#touch(),
    broadcast: (event) => this.#broadcast(event),
    cmdCreateSession: (input, ctx, options) =>
      this.#cmdCreateSession(input, ctx, options),
    loopSubscriptionsForCluster: (clusterId) =>
      this.#scheduler.loopSubscriptionsForCluster(clusterId),
    cmdAuthorSubscription: (input, ctx, options) =>
      this.#scheduler.cmdAuthorSubscription(input, ctx, options),
    cmdStopSubscription: (input, ctx) =>
      this.#scheduler.cmdStopSubscription(input, ctx),
    membraneCreateInput: (source, input) =>
      this.#membraneRequests.membraneCreateInput(source, input),
    reviewerBootstrapPrompt: () => reviewerBootstrapPrompt(this.#wf()),
    reviewerActivationNote: () => reviewerActivationNote(this.#wf()),
    coderActivationNote: () => coderActivationNote(this.#wf()),
    enqueueSchedulerWork: (run, onError) =>
      this.#scheduler.enqueueWork(run, onError),
    createPendingActivation: (decision, event, ctx) =>
      this.#scheduler.createPendingActivation(decision, event, ctx),
    schedulerRuleContext: (subscriptionId, causeId) =>
      this.#scheduler.ruleContext(subscriptionId, causeId),
    hasRun: (sessionId) => this.#runs.has(sessionId),
    cmdKillSession: (input, ctx) => this.#cmdKillSession(input, ctx),
    kernelView: () => this.#queries.kernelView(),
    createEnvelope: (source) => this.#createEnvelope(source),
    addEdge: (input) => this.#addEdge(input),
  })
  #sessionRuntime = new SessionRuntimeController({
    state: () => this.#state,
    runs: () => this.#runs,
    runContext: () => this.#runContext,
    workflowCompensatedRuns: () => this.#workflowCompensatedRuns,
    bridge: () => this.#bridge,
    providerService: () => this.#providerService,
    channelStore: () => this.#channelStore,
    queries: () => this.#queries,
    checkpointHost: () => this.#checkpointHost(),
    dispatchCommand: (command) => this.dispatchCommand(command),
    appendKernelEvent: (type, payload, ctx, options) => this.#appendKernelEvent(type, payload, ctx, options),
    touch: () => this.#touch(),
    touchDeferred: () => this.#touchDeferred(),
    broadcast: (event) => this.#broadcast(event),
    emitRuntimeEvent: (event) => this.#emitRuntimeEvent(event),
    getState: () => this.getState(),
    isSessionFrozen: (sessionId) => this.#isSessionFrozen(sessionId),
    updateNodeStatus: (sessionId, status) => this.#updateNodeStatus(sessionId, status),
    planCouncilForSession: (sessionId) => planCouncilForSession(this.#wf(), sessionId),
    planCouncilFinished: (sessionId, runId, eventId) => planCouncilFinished(this.#wf(), sessionId, runId, eventId),
    planCouncilFailed: (sessionId, error) => planCouncilFailed(this.#wf(), sessionId, error),
    journalAutomaticDeploymentRunStarted: (sessionId) => journalAutomaticDeploymentRunStarted(this.#wf(), sessionId),
    commandLifecycleEpoch: () => {
      const transaction = this.#commandExecutor.currentTransaction()
      return transaction?.actor.kind !== 'runtime'
        ? transaction?.lifecycleEpochs?.runQueue
        : undefined
    },
  })
  #governance = new WorkflowGovernanceRuntime({
    state: () => this.#state,
    readState: () => this.#readState(),
    allKernelEvents: () => this.#queries.allKernelEvents(),
    dispatchCommand: (command) => this.dispatchCommand(command),
    appendKernelEvent: (type, payload, ctx, options) =>
      this.#appendKernelEvent(type, payload, ctx, options),
    touch: () => this.#touch(),
    broadcast: (event) => this.#broadcast(event),
    getState: () => this.getState(),
    masterClusterId: (sessionId) => this.#masterClusterId(sessionId),
    cmdActivate: (input, ctx) => this.#cmdActivate(input, ctx),
    isSessionFrozen: (sessionId) => this.#isSessionFrozen(sessionId),
  })
  #proposals = new WorkflowProposalRuntime({
    state: () => this.#state,
    currentCommandIdempotencyKey: () =>
      this.#commandExecutor.currentTransaction()?.idempotencyKey,
    workflowActorScopeId: (ctx, requestedScopeId) =>
      this.#workflowActorScopeId(ctx, requestedScopeId),
    isSessionFrozen: (sessionId) => this.#isSessionFrozen(sessionId),
    appendKernelEvent: (type, payload, ctx, options) =>
      this.#appendKernelEvent(type, payload, ctx, options),
    touch: () => this.#touch(),
    broadcast: (event) => this.#broadcast(event),
    getState: () => this.getState(),
    membraneActor: (source) => this.#membraneRequests.membraneActor(source),
    cmdCreateSession: (input, ctx, options) =>
      this.#cmdCreateSession(input, ctx, options),
    startRun: (sessionId, request) =>
      this.#sessionRuntime.startRun(sessionId, request),
    cmdStopSubscription: (input, ctx) =>
      this.#scheduler.cmdStopSubscription(input, ctx),
    cmdAuthorSubscription: (input, ctx, options) =>
      this.#scheduler.cmdAuthorSubscription(input, ctx, options),
    cmdKillSession: (input, ctx) => this.#cmdKillSession(input, ctx),
    commitPlanCouncilPatch: (proposal, base, ctx) =>
      commitPlanCouncilPatch(this.#wf(), proposal, base, ctx),
    startReviewWorkflow: (input) => this.startReviewWorkflow(input),
    startGoalWorkflow: (input) => this.startGoalWorkflow(input),
    startHandoffWorkflow: (input) => this.startHandoffWorkflow(input),
    startPlanCouncil: (input) => this.startPlanCouncil(input),
  })
  #scheduler = new SchedulerRuntime({
    state: () => this.#state,
    runs: () => this.#runs,
    queries: () => this.#queries,
    kernelStore: () => this.#kernelStore,
    dispatchCommand: (command) => this.dispatchCommand(command),
    dispatchRecoveryCommandSync: (input) =>
      this.#dispatchRecoveryCommandSync(input),
    appendKernelEvent: (type, payload, ctx, options) =>
      this.#appendKernelEvent(type, payload, ctx, options),
    touch: () => this.#touch(),
    broadcast: (event) => this.#broadcast(event),
    getState: () => this.getState(),
    cmdDeliver: (input, ctx) => this.#cmdDeliver(input, ctx),
    cmdActivate: (input, ctx) => this.#cmdActivate(input, ctx),
    deliverToChannel: (input, ctx) => this.#deliverToChannel(input, ctx),
    runActivation: (sessionId, input) => this.#runActivation(sessionId, input),
    artifactBundleEntries: (sessionId) => this.#artifactBundleEntries(sessionId),
    isSessionFrozen: (sessionId) => this.#isSessionFrozen(sessionId),
    managedClusterId: (sessionId) => this.#managedClusterId(sessionId),
    masterClusterId: (sessionId) => this.#masterClusterId(sessionId),
    workflowCapability: (scopeId, options) =>
      this.#workflowCapability(scopeId, options),
    resourcePolicy: (scopeId) => this.#sessionRuntime.resourcePolicy(scopeId),
    cmdCreateSession: (input, ctx, options) =>
      this.#cmdCreateSession(input, ctx, options),
    startRun: (sessionId, request) => this.#sessionRuntime.startRun(sessionId, request),
    journalAutomaticDeploymentResources: () =>
      journalAutomaticDeploymentResources(this.#wf()),
    isGoalPairShape: (check, retry) =>
      isGoalPairShape(this.#wf(), check, retry),
    isReviewPairShape: (pass, fix) =>
      isReviewPairShape(this.#wf(), pass, fix),
    activeWorkflowPlans: () => this.#activeWorkflowPlans(),
    storeWorkflowPlan: (plan) => this.#storeWorkflowPlan(plan),
    cmdKillSession: (input, ctx) => this.#cmdKillSession(input, ctx),
    cmdArchiveSession: (input, ctx) => this.#cmdArchiveSession(input, ctx),
    applyFreeze: (input, ctx) => this.#applyFreeze(input, ctx),
  })
  #membraneRequests = new MembraneRequestRuntime({
    state: () => this.#state,
    dispatchCommand: (command) => this.dispatchCommand(command),
    workflowKernel: () => this.#wf(),
    workflowActorScopeId: (ctx, requestedScopeId) =>
      this.#workflowActorScopeId(ctx, requestedScopeId),
    inspectWorkflowScope: (input, source) =>
      this.inspectWorkflowScope(input, source),
    inspectWorkflowWakeups: (input, source) =>
      this.inspectWorkflowWakeups(input, source),
    explainWorkflow: (input, source) => this.explainWorkflow(input, source),
    workflowProposal: (proposalId) =>
      this.#proposals.workflowProposal(proposalId),
    workflowProposalMembraneView: (proposal) =>
      this.#proposals.workflowProposalMembraneView(proposal),
    runExecution: (source) => this.#runContext.get(source)?.execution,
    masterClusterId: (sessionId) => this.#masterClusterId(sessionId),
  })
  #commandRegistry = createKernelCommandRegistry({
    create_session: (input, ctx) => this.#cmdCreateSession(input, ctx),
    resume_session: (input, ctx) => this.#cmdResumeSession(input, ctx),
    deliver: (input, ctx) => this.#cmdDeliver(input, ctx),
    activate: (input, ctx) => this.#cmdActivate(input, ctx),
    archive_session: (input, ctx) => this.#cmdArchiveSession(input, ctx),
    kill_session: (input, ctx) => this.#cmdKillSession(input, ctx),
    respond_runtime_request: (input, ctx) =>
      this.#cmdRespondRuntimeRequest(input, ctx),
    answer_user_input: (input, ctx) => this.#cmdAnswerUserInput(input, ctx),
    upsert_scope: (input, ctx) => this.#cmdUpsertCluster(input, ctx),
    create_master: (input, ctx) =>
      this.#cmdCreateMasterForCluster(input, ctx),
    assign_master: (input, ctx) => this.#cmdAssignMaster(input, ctx),
    set_loop_policy: (input, ctx) => this.#cmdSetLoopPolicy(input, ctx),
    update_node_positions: (input, ctx) =>
      this.#cmdUpdateNodePositions(input, ctx),
    start_loop: (input, ctx) => this.#cmdStartLoop(input, ctx),
    stop_loop: (input, ctx) => this.#cmdStopLoop(input, ctx),
    freeze: (input, ctx) => this.#cmdFreeze(input, ctx),
    unfreeze: (input, ctx) => this.#cmdUnfreeze(input, ctx),
    link_sessions: (input, ctx) => this.#cmdLinkSessions(input, ctx),
    remove_edge: (input, ctx) => this.#cmdRemoveEdge(input, ctx),
    report: (input, ctx) => this.#cmdReport(input, ctx),
    upsert_provider_instance: (input, ctx) =>
      this.#cmdUpsertProviderInstance(input, ctx),
    author_subscription: (input, ctx) =>
      this.#scheduler.cmdAuthorSubscription(input, ctx),
    stop_subscription: (input, ctx) =>
      this.#scheduler.cmdStopSubscription(input, ctx),
    approve_activation: (input, ctx) =>
      this.#scheduler.cmdApproveActivation(input, ctx),
    deny_activation: (input, ctx) => this.#scheduler.cmdDenyActivation(input, ctx),
    cleanup_channels: (input, ctx) => this.#cmdCleanupChannels(input, ctx),
    propose_workflow: (input, ctx) => this.#cmdProposeWorkflow(input, ctx),
    propose_workflow_patch: (input, ctx) =>
      this.#cmdProposeWorkflowPatch(input, ctx),
    revise_workflow: (input, ctx) => this.#cmdReviseWorkflow(input, ctx),
    approve_workflow_proposal: (input, ctx) =>
      this.#cmdApproveWorkflowProposal(input, ctx),
    reject_workflow_proposal: (input, ctx) =>
      this.#cmdRejectWorkflowProposal(input, ctx),
    expire_workflow_proposal: (input, ctx) =>
      this.#cmdExpireWorkflowProposal(input, ctx),
    commit_workflow: (input, ctx) => this.#cmdCommitWorkflow(input, ctx),
    abort_workflow_proposal: (input, ctx) =>
      this.#cmdAbortWorkflowProposal(input, ctx),
    lock_workflow_item: (input, ctx) =>
      this.#cmdLockWorkflowItem(input, ctx),
    record_workflow_wakeup: (input, ctx) =>
      this.#governance.cmdRecordWorkflowWakeup(input, ctx),
    notify_workflow_wakeup: (input, ctx) =>
      this.#governance.cmdNotifyWorkflowWakeup(input, ctx),
    acknowledge_workflow_wakeup: (input, ctx) =>
      this.#governance.cmdAcknowledgeWorkflowWakeup(input, ctx),
    create_barrier: (input, ctx) => this.#governance.cmdCreateBarrier(input, ctx),
    arrive_barrier: (input, ctx) => this.#governance.cmdArriveBarrier(input, ctx),
    cancel_barrier: (input, ctx) => this.#governance.cmdCancelBarrier(input, ctx),
    expire_barrier: (input, ctx) => this.#governance.cmdExpireBarrier(input, ctx),
    provider_complete_run: (input, ctx) =>
      this.#sessionRuntime.cmdCompleteProviderRun(input, ctx),
    set_resource_policy: (input, ctx) =>
      this.#sessionRuntime.cmdSetResourcePolicy(input, ctx),
    merge_worktree_changes: (input, ctx) =>
      this.#sessionRuntime.cmdMergeWorktreeChanges(input, ctx),
    cleanup_worktree: (input, ctx) => this.#sessionRuntime.cmdCleanupWorktree(input, ctx),
    create_goal_loop: (input) => this.createGoalLoop(input),
    start_review_workflow: (input) => this.startReviewWorkflow(input),
    start_plan_council: (input) => this.startPlanCouncil(input),
    start_plan_council_cross_review: (input) =>
      this.startPlanCouncilCrossReview(input),
    start_plan_council_synthesis: (input) =>
      this.startPlanCouncilSynthesis(input),
    retry_plan_council_participant: (input, ctx) =>
      cmdRetryPlanCouncilParticipant(this.#wf(), input, ctx),
    stop_plan_council: (input) => this.stopPlanCouncil(input),
    start_draft_workflow: (input) => this.startDraftWorkflow(input),
    start_handoff_workflow: (input) => this.startHandoffWorkflow(input),
    start_goal_workflow: (input) => this.startGoalWorkflow(input),
    connect_agents: (input) => this.connectAgents(input),
    apply_template: (input) => this.applyTemplate(input),
    save_template: (input) => this.saveTemplate(input),
    remove_template: (input) => this.removeTemplate(input),
    register_external_source: (input) => this.registerExternalSource(input),
    remove_external_source: (input) => this.removeExternalSource(input),
    rule_stop_for_event: (input, ctx) =>
      this.#scheduler.stopSubscriptionWithOnStop(input.decision, ctx),
    rule_deliver_for_event: (input, ctx) =>
      this.#scheduler.deliverSubscriptionFiring(input, ctx),
    rule_pend_activation: (input, ctx) =>
      this.#scheduler.createPendingActivation(input.decision, input.event, ctx),
    rule_execute_activation: (input) =>
      this.#scheduler.cmdRuleExecuteActivation(input),
    rule_drop_activation: (input, ctx) =>
      this.#scheduler.cmdRuleDropActivation(input, ctx),
    rule_stop_killed_subscriptions: (input) =>
      this.#scheduler.cmdRuleStopKilledSubscriptions(input),
  } satisfies KernelCommandHandlers)
  #workflowDeploymentCrashAfterStage: string | undefined
  #workflowDeploymentCrashAfterResourceCreate = false
  constructor({
    storageFile,
    broadcastRuntimeEvent,
    emitRuntimeEvent,
    broadcast,
    emit,
    snapshotPersistDelayMs,
    providerAdapters,
    workflowDeploymentCrashAfterStage,
    workflowDeploymentCrashAfterResourceCreate = false,
    controlCommandCrashBeforeEffectDrain = false,
    controlCommandCommitDelayMs,
  }: JsonRecord = {}) {
    this.#storageFile =
      typeof storageFile === 'string' && storageFile.length > 0
        ? storageFile
        : undefined
    const emitRuntimeEventToHost =
      typeof broadcastRuntimeEvent === 'function'
        ? broadcastRuntimeEvent
        : typeof emitRuntimeEvent === 'function'
          ? emitRuntimeEvent
          : typeof broadcast === 'function'
            ? broadcast
            : typeof emit === 'function'
              ? emit
              : undefined
    const resolvedSnapshotPersistDelayMs =
      Number.isFinite(snapshotPersistDelayMs) &&
      snapshotPersistDelayMs >= 0
        ? Number(snapshotPersistDelayMs)
        : 750
    this.#workflowDeploymentCrashAfterStage = optionalTrimmedString(
      workflowDeploymentCrashAfterStage,
    )
    this.#workflowDeploymentCrashAfterResourceCreate =
      workflowDeploymentCrashAfterResourceCreate === true
    const resolvedControlCommandCommitDelayMs =
      Number.isFinite(controlCommandCommitDelayMs) &&
      controlCommandCommitDelayMs > 0
        ? Number(controlCommandCommitDelayMs)
        : 0
    this.#kernelStore = new KernelStore({
      databaseFile: this.#storageFile
        ? kernelDatabaseFileFor(this.#storageFile)
        : undefined,
    })
    // Per-session inbox directories live next to the storage (outside any
    // project repo, §4.2.5); storage-less managers get an isolated temp root.
    this.#channelStore = new ContextChannelStore({
      root: this.#storageFile
        ? path.join(path.dirname(this.#storageFile), 'channels')
        : fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channels-')),
    })
    this.#commandExecutor = new CommandExecutor({
      kernelStore: this.#kernelStore,
      channelStore: this.#channelStore,
      registry: this.#commandRegistry,
      snapshotPersistDelayMs: resolvedSnapshotPersistDelayMs,
      crashBeforeEffectDrain: controlCommandCrashBeforeEffectDrain === true,
      commitDelayMs: resolvedControlCommandCommitDelayMs,
      host: {
        getState: () => this.#state,
        setState: (state) => {
          this.#state = state
        },
        getPublicState: () => this.getState(),
        getRuns: () => this.#runs,
        getRunContext: () => this.#runContext,
        getWorkflowCompensatedRuns: () => this.#workflowCompensatedRuns,
        automaticDeploymentExistingSessionIds: (kind, input) =>
          automaticDeploymentExistingSessionIds(this.#wf(), kind, input),
        captureWorkflowSession: (sessionId) =>
          captureWorkflowSession(this.#wf(), sessionId),
        discardWorkflowSession: (sessionId) =>
          discardWorkflowSession(this.#wf(), sessionId),
        workflowDeploymentCrashAfterStage: () =>
          this.#workflowDeploymentCrashAfterStage,
        reviveAutonomousDrains: () => {
          this.#governance.resumeWakeupDrain()
          return {
            runQueue: this.#sessionRuntime.lifecycleEpoch(),
            externalAdapters: this.#externalIngestion.adapterLifecycleEpoch(),
          }
        },
        onAuthorizedCommandCommitted: (actor, lifecycleEpochs) => {
          if (
            lifecycleEpochs !== undefined &&
            actor.kind !== 'runtime'
          ) {
            this.#sessionRuntime.resumeQueueDrain(lifecycleEpochs.runQueue)
            this.#externalIngestion.resumeAdapters(
              lifecycleEpochs.externalAdapters,
            )
          }
        },
        onControlKernelEvent: (event) => {
          this.#scheduler.enqueueSchedulerEvent(event)
          this.#governance.queueWorkflowWakeupsForKernelEvent(event)
        },
        onEffectKernelEvent: (event) => this.#scheduler.enqueueSchedulerEvent(event),
        drainWorkflowWakeups: () => this.#governance.drainWorkflowWakeups(),
        drainApprovedSlots: () => this.#scheduler.drainApprovedSlots(),
        emitRuntimeEvent: emitRuntimeEventToHost,
      },
    })
    this.#state = this.#loadState()
    for (const lease of this.#state.workspaceLeases ?? []) {
      if (lease.status === 'active') {
        lease.status = 'revoked'
        lease.releasedAt = now()
        lease.releaseReason = 'runtime-restart'
      }
    }
    if (this.#legacyImportKind === 'migration') {
      this.#appendKernelEvent(
        'storage.migrated',
        { fromFile: this.#storageFile },
        { actor: { kind: 'runtime' } },
        {
          reason: 'Imported legacy JSON snapshot into the SQLite kernel store.',
        },
      )
    } else if (this.#legacyImportKind === 'fossil-rollback') {
      this.#appendKernelEvent(
        'storage.restored-from-fossil',
        { fromFile: this.#storageFile },
        { actor: { kind: 'runtime' } },
        {
          reason:
            'Kernel store was corrupt; restored the legacy JSON snapshot. State may have rolled back to the migration point.',
        },
      )
    }
    for (const sessionId of this.#restartInterruptedSessionIds) {
      this.#sessionRuntime.recordInterruptedUsageFact(sessionId)
      // Sessions that were mid-run when the previous runtime stopped are
      // flipped to failed on load; without this fact their causal chain in
      // the kernel log would simply stop dead.
      this.#appendKernelEvent(
        'session.failed',
        { sessionId, interruptedByRestart: true },
        { actor: { kind: 'runtime' } },
        { reason: 'Interrupted by runtime restart.' },
      )
    }
    const restartInterruptedSessionIds = new Set(this.#restartInterruptedSessionIds)
    reconcileInterruptedPlanCouncils(this.#wf(), restartInterruptedSessionIds)
    this.#governance.recoverInterruptedWorkflowWakeups(
      restartInterruptedSessionIds,
    )
    this.#restartInterruptedSessionIds = []
    this.#bridge = new MembraneBridge({
      handler: (request) => this.handleMembraneRequest(request),
    })
    this.#providerService = new ProviderService({
      providerInstances: this.#state.providerInstances,
      adapters: providerAdapters instanceof Map ? providerAdapters : undefined,
    })
    recoverWorkflowDeployments(this.#wf())
    reconcileDynamicTopology(this.#wf())
    this.#commandExecutor.drainDurableEffects()
    this.#persistState()
    this.#scheduler.sweepKilledParticipantSubscriptions()
    this.#scheduler.sweepExhaustedSubscriptions()
    this.#recoverSchedulerState()
    this.#scheduler.recoverTimers()
    this.#externalIngestion.recoverSourceAnchors()
    this.#governance.recoverWorkflowWakeupsFromKernelLog()
    this.#governance.recoverBarrierTimers()
    queueMicrotask(() => this.#governance.drainWorkflowWakeups())
    queueMicrotask(() => void this.#sessionRuntime.drainRunQueue())
  }

  #readState() {
    return this.#commandExecutor.readState()
  }

  getState() {
    return this.#queries.getState()
  }

  // Unified command channel (kernel doc §7.5). All mutating entry points --
  // human (IPC/HTTP wrappers), master/agent (membrane), rule (loop automation)
  // -- converge in CommandExecutor.
  async dispatchCommand(command: JsonRecord = {}): Promise<any> {
    return this.#commandExecutor.dispatch(command)
  }

  #reviveDirectProviderRuntime() {
    if (!this.#commandExecutor.currentTransaction()) {
      this.#sessionRuntime.resumeQueueDrain()
    }
  }

  #dispatchRecoveryCommandSync(input: RecoveryControlCommand) {
    return this.#commandExecutor.dispatchRecoveryCommandSync(input)
  }

  getKernelEvents(input: JsonRecord = {}) {
    return this.#queries.getKernelEvents(input)
  }

  getLoopTimeline(input: JsonRecord = {}) {
    return this.#queries.getLoopTimeline(input)
  }

  #humanCtx() {
    return { actor: { kind: 'human' } }
  }

  #workflowCommandCtx() {
    const transaction = this.#commandExecutor.currentTransaction()
    return transaction
      ? {
          actor: clone(transaction.actor),
          ...(transaction.causeId ? { causeId: transaction.causeId } : {}),
        }
      : this.#humanCtx()
  }

  // --- L2 external event sources: the ingestion choke point (§2.4) ---
  //
  // A source is an explicitly registered entity; adapters (script, git,
  // webhook) are thin translators that all converge on emitExternalEvent.
  // The choke point owns validation, source-side sampling, and dedupe; an
  // accepted emit appends one `external.<topic>` fact and everything
  // downstream (matching, gate, concurrency, stop) is the ordinary
  // scheduler path — exactly the L1 timer pattern, generalized.

  registerExternalSource(input: JsonRecord = {}) {
    return this.#externalIngestion.registerExternalSource(input)
  }

  removeExternalSource(input: JsonRecord = {}) {
    return this.#externalIngestion.removeExternalSource(input)
  }

  // Accept-or-drop for one emit. Dropped emits return {ok:false} and append
  // NOTHING — sampling exists to keep a chatty source out of the log; the
  // adapter re-emits current state on its next beat.
  emitExternalEvent(input: JsonRecord = {}) {
    return this.#externalIngestion.emitExternalEvent(input)
  }

  // Transport-layer auth for the HTTP ingestion path: sources without a
  // token accept unauthenticated local emits; sources with one require it.
  verifyExternalSourceToken(sourceId, token) {
    return this.#externalIngestion.verifyExternalSourceToken(sourceId, token)
  }

  #appendKernelEvent(
    type,
    payload,
    ctx,
    options: JsonRecord = {},
  ) {
    return this.#commandExecutor.appendKernelEvent(
      type,
      payload,
      ctx,
      options,
    )
  }

  listSessionSummaries() {
    return this.#queries.listSessionSummaries()
  }

  getSessionView(input: JsonRecord = {}) {
    return this.#queries.getSessionView(input)
  }

  getGraphTopology() {
    return this.#queries.getGraphTopology()
  }

  getSessionEvents(input: JsonRecord = {}) {
    return this.#queries.getSessionEvents(input)
  }

  getProjectContext(input: JsonRecord = {}) {
    return this.#queries.getProjectContext(input)
  }

  async openWorkspace(input: JsonRecord = {}) {
    return this.#workspaceService.openWorkspace(input)
  }

  // Embedded terminal lifecycle lives in TerminalService (terminal/).
  createTerminal(input: JsonRecord = {}) {
    return this.#terminalService.createTerminal(input)
  }

  getTerminal(input: JsonRecord = {}) {
    return this.#terminalService.getTerminal(input)
  }

  runTerminalCommand(input: JsonRecord = {}) {
    return this.#terminalService.runTerminalCommand(input)
  }

  writeTerminalInput(input: JsonRecord = {}) {
    return this.#terminalService.writeTerminalInput(input)
  }

  clearTerminal(input: JsonRecord = {}) {
    return this.#terminalService.clearTerminal(input)
  }

  closeTerminal(input: JsonRecord = {}) {
    return this.#terminalService.closeTerminal(input)
  }

  async getProviderSetupStatus(input: JsonRecord = {}) {
    return getProviderSetupStatus(this.#providerSetupHost(), input)
  }

  upsertProviderInstance(input: JsonRecord = {}) {
    return this.#cmdUpsertProviderInstance(input, this.#humanCtx())
  }

  #cmdUpsertProviderInstance(input: JsonRecord = {}, ctx: JsonRecord) {
    if (!validProviderKinds.has(input.kind)) {
      throw new Error(
        `Unsupported provider instance kind: ${String(input.kind)}`,
      )
    }
    const sensitiveEnvKey = isObject(input.env)
      ? Object.keys(input.env).find(providerEnvKeyIsSensitive)
      : undefined
    if (sensitiveEnvKey?.trim().toUpperCase() === 'XAI_API_KEY') {
      throw new Error(
        'XAI_API_KEY cannot be persisted in a provider profile. Set it in the Orrery runtime environment instead.',
      )
    }
    if (sensitiveEnvKey) {
      throw new Error(
        `${sensitiveEnvKey} looks sensitive and cannot be persisted in a provider profile. Set it in the Orrery runtime environment instead.`,
      )
    }
    const requestedId = optionalTrimmedString(input.providerInstanceId)
    const existing = requestedId
      ? this.#state.providerInstances.find(
          (instance) => instance.providerInstanceId === requestedId,
        )
      : undefined
    const normalizedInput = {
      ...input,
      providerInstanceId:
        requestedId ??
        defaultProviderInstanceForKind(input.kind).providerInstanceId,
    }
    const providerInstance = normalizeProviderInstance(
      normalizedInput,
      existing,
      {
        reuseOptionalFallback: false,
      },
    )
    const nextInstances = [...this.#state.providerInstances]
    const index = nextInstances.findIndex(
      (instance) =>
        instance.providerInstanceId === providerInstance.providerInstanceId,
    )
    if (index >= 0) {
      nextInstances[index] = providerInstance
    } else {
      nextInstances.push(providerInstance)
    }

    this.#state.providerInstances = nextInstances
    if (isObject(this.#state.providerModelCatalogs)) {
      delete this.#state.providerModelCatalogs[
        providerInstance.providerInstanceId
      ]
    }
    this.#providerService.registerProviderInstance(providerInstance)
    this.#appendKernelEvent(
      'provider.instance-upserted',
      {
        providerInstanceId: providerInstance.providerInstanceId,
        kind: providerInstance.kind,
      },
      ctx,
    )
    this.#touch()
    this.#broadcast({
      type: 'provider.instances.updated',
      state: this.getState(),
    })
    return {
      providerInstance: clone(providerInstance),
      state: this.getState(),
    }
  }

  async createSession(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return this.#cmdCreateSession(input, this.#humanCtx())
  }

  async #cmdCreateSession(
    input: JsonRecord = {},
    ctx: JsonRecord,
    options: JsonRecord = {},
  ) {
    const deferStart = options.deferStart === true
    const sessionId = randomUUID()
    const role = input.role === 'master' ? 'master' : 'worker'
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : undefined
    if (cluster && this.#state.clusters[cluster]?.frozen) {
      throw new Error(`Frozen cluster cannot create new sessions: ${cluster}`)
    }
    const sourceSessionId =
      typeof input.sourceSessionId === 'string' &&
      input.sourceSessionId.trim().length > 0
        ? input.sourceSessionId.trim()
        : undefined
    if (sourceSessionId && !this.#state.sessions[sourceSessionId]) {
      throw new Error(`Unknown linked chat source session: ${sourceSessionId}`)
    }

    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt
        : defaultPrompt
    const attachments = normalizeChatAttachments(input.attachments)
    const provider = providerConfig(input, this.#state.providerInstances)
    // Everything that can reject the command must run before the channel is
    // written: a failed create must not leave an orphan delivery with no
    // `delivered` fact behind it (events are the truth, files follow).
    const runtimeSettings = normalizeProviderRuntimeSettings(
      input.runtimeSettings,
    )
    let workspace
    if (normalizeWorkMode(input.workMode) === 'worktree') {
      const worktreePlan = planSessionWorktree(input.cwd, sessionId, input.branch)
      journalPlannedWorkflowResource(this.#wf(), {
        sessionId,
        cwd: worktreePlan.workspace.cwd,
        project: clone(worktreePlan.workspace.project),
      })
      workspace = createPlannedSessionWorktree(worktreePlan)
      if (this.#workflowDeploymentCrashAfterResourceCreate) {
        const error = new Error('Injected workflow deployment crash after worktree resource creation.')
        ;(error as Error & { code?: string }).code = 'ORRERY_DEPLOYMENT_CRASH'
        throw error
      }
    } else {
      workspace = localSessionWorkspace(input.cwd, input.branch)
    }
    const cwd = workspace.cwd

    // Handoff content is pre-seeded into the new session's channel instead
    // of being inlined into the prompt (§4.1 create_session): the chat
    // history starts with a short bootstrap plus the delivery listing, and
    // large payloads never scroll out of the context window.
    const handoffContext =
      typeof input.context === 'string' && input.context.trim().length > 0
        ? input.context
        : undefined
    let handoffDelivery
    if (handoffContext) {
      this.#checkpointChannelMutation(sessionId)
      handoffDelivery = this.#channelStore.deliver({
        target: sessionId,
        from: sourceSessionId ?? 'human',
        fromLabel: sourceSessionId
          ? this.#state.sessions[sourceSessionId]?.label
          : undefined,
        topic: optionalTrimmedString(input.contextTopic) ?? 'handoff',
        entries: [{ name: 'context.md', content: handoffContext }],
      })
    }
    const preamble = handoffDelivery
      ? activationPreamble(this.#channelStore.unread(sessionId), {
          channelDir: this.#channelStore.channelDir(sessionId),
        })
      : undefined
    const initialContent = [prompt, preamble].filter(Boolean).join('\n\n')
    const providerPrompt = providerPromptContent({
      providerKind: provider.providerKind,
      message: initialContent,
      context: undefined,
      attachments,
    })
    if (handoffDelivery) {
      this.#checkpointChannelMutation(sessionId)
      this.#channelStore.markRead(sessionId, handoffDelivery.seq)
    }
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `${provider.labelPrefix} ${this.#state.nodes.length + 1}`
    const ts = now()

    this.#state.sessions[sessionId] = {
      sessionId,
      nodeId: sessionId,
      backend: provider.backend,
      backendSessionId: undefined,
      providerKind: provider.providerKind,
      providerInstanceId: provider.providerInstanceId,
      providerSessionId: undefined,
      agent: provider.agent,
      label,
      prompt: initialContent,
      cwd,
      project: workspace.project,
      role,
      status: deferStart ? 'idle' : 'pending',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
      nativeEvents: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
      runtimeSettings,
      ...(deferStart ? { prepared: true } : {}),
      messages: [
        {
          id: randomUUID(),
          sessionId,
          role: 'user',
          content: initialContent,
          attachments,
          ts,
          runId: undefined,
          status: 'complete',
        },
      ],
    }

    this.#state.nodes.push({
      nodeId: sessionId,
      sessionId,
      label,
      role,
      agent: provider.agent,
      clusterId: cluster,
      status: deferStart ? 'idle' : 'pending',
      position:
        options.position &&
        Number.isFinite(options.position.x) &&
        Number.isFinite(options.position.y)
          ? { x: options.position.x, y: options.position.y }
          : {
              x: 96 + (this.#state.nodes.length % 4) * 280,
              y: 96 + Math.floor(this.#state.nodes.length / 4) * 180,
            },
    })
    if (cluster) {
      this.#ensureCluster(cluster)
      if (role !== 'master') {
        this.#addNodeToCluster(sessionId, cluster)
      }
    }
    if (sourceSessionId) {
      const linkLabel =
        typeof input.linkLabel === 'string' && input.linkLabel.trim().length > 0
          ? input.linkLabel.trim()
          : 'linked chat'
      this.#addEdge({
        source: sourceSessionId,
        target: sessionId,
        kind: 'create-session',
        envelope: this.#createEnvelope(sourceSessionId),
        label: linkLabel,
        masterReason: masterReasonFromInput(
          this.#state,
          sourceSessionId,
          input,
        ),
      })
    }
    journalAutomaticDeploymentResources(this.#wf())
    const createdEvent = this.#appendKernelEvent(
      'session.created',
      {
        sessionId,
        label,
        role,
        providerKind: provider.providerKind,
        agent: provider.agent,
        clusterId: cluster,
        sourceSessionId,
        cwd,
      },
      ctx,
      {
        reason:
          ctx.reason ??
            masterReasonFromInput(this.#state, sourceSessionId, input),
      },
    )
    if (handoffDelivery) {
      // The channel write happened before message composition; the fact
      // lands after session.created so the log reads create → deliver (§8.1).
      this.#appendKernelEvent(
        'delivered',
        {
          source: sourceSessionId ?? 'human',
          target: sessionId,
          topic: handoffDelivery.topic,
          channelSeq: handoffDelivery.seq,
          files: handoffDelivery.files,
        },
        {
          ...ctx,
          causeId: createdEvent?.id ?? ctx.causeId,
        },
      )
    }
    this.#touch()
    this.#broadcast({
      type: 'session.created',
      sessionId,
      state: this.getState(),
    })

    if (deferStart) {
      return {
        sessionId,
        state: this.getState(),
        preparedRun: {
          prompt: providerPrompt,
          attachments,
          userMessageId: this.#state.sessions[sessionId].messages[0].id,
          activationEventId: createdEvent?.id,
          channelReadSeqs: handoffDelivery ? [handoffDelivery.seq] : [],
          ...(validateExecutionEnvelope(ctx.execution)
            ? { execution: clone(ctx.execution) }
            : {}),
        },
      }
    }

    await this.#sessionRuntime.startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: 'create',
      userMessageId: this.#state.sessions[sessionId].messages[0].id,
      activationEventId: createdEvent?.id,
      // Same rollback contract as activations: if the first run dies before
      // producing output, the pre-seeded handoff becomes unread again.
      channelReadSeqs: handoffDelivery ? [handoffDelivery.seq] : [],
      ...(validateExecutionEnvelope(ctx.execution)
        ? { execution: clone(ctx.execution) }
        : {}),
    })

    return { sessionId, state: this.getState() }
  }

  async resumeSession(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return this.#cmdResumeSession(input, this.#humanCtx())
  }

  deliverToSession(input: JsonRecord = {}) {
    return this.#cmdDeliver(input, this.#humanCtx())
  }

  async activateSession(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return this.#cmdActivate(input, this.#humanCtx())
  }

  // resume = deliver + activate (kernel doc §4.1). The external verb stays
  // compatible: context (when present) lands in the target's channel as a
  // delivery instead of being inlined into the chat message, and the
  // activation message is the note plus the deterministic channel preamble.
  async #cmdResumeSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = input.sessionId
    this.#assertActivatable(sessionId, ctx)

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('Resume message is required')
    }

    const context =
      typeof input.context === 'string' && input.context.trim().length > 0
        ? input.context
        : undefined
    if (context) {
      this.#deliverToChannel(
        {
          target: sessionId,
          from:
            optionalTrimmedString(input.edgeSourceSessionId) ??
            optionalTrimmedString(ctx.actor?.ref),
          topic: optionalTrimmedString(input.contextTopic) ?? 'context',
          entries: [{ name: 'context.md', content: context }],
        },
        ctx,
      )
    }

    return this.#runActivation(sessionId, {
      note: message,
      attachments: normalizeChatAttachments(input.attachments),
      edgeSourceSessionId: optionalTrimmedString(input.edgeSourceSessionId),
      edgeInput: input,
      ctx,
    })
  }

  // Pure data-plane delivery (§4.1 deliver): writes to the target's channel
  // and records the `delivered` fact. Never activates.
  #cmdDeliver(input: JsonRecord = {}, ctx: JsonRecord) {
    const target =
      optionalTrimmedString(input.sessionId) ??
      optionalTrimmedString(input.target)
    if (!target || !this.#state.sessions[target]) {
      throw new Error(`Unknown session: ${target ?? ''}`)
    }

    const topic = optionalTrimmedString(input.topic)
    const note = optionalTrimmedString(input.note)
    const content =
      typeof input.content === 'string' ? input.content : undefined
    // Attribution: a caller session (membrane actor.ref) cannot be spoofed;
    // rule actors reference a subscription rather than a session, so
    // subscription firings pass the trigger source explicitly instead.
    const actorRef = optionalTrimmedString(ctx.actor?.ref)
    const from =
      (actorRef && this.#state.sessions[actorRef] ? actorRef : undefined) ??
      optionalTrimmedString(input.source)

    let entries
    if (content) {
      entries = [
        {
          name: optionalTrimmedString(input.filename) ?? 'content.md',
          content,
        },
      ]
    } else if (from && this.#state.sessions[from]) {
      // No explicit payload: forward the source's artifact bundle — the
      // fixed convention for machine-fired deliveries (§4.2.6). Report
      // triggers additionally carry the rendered report.
      entries = this.#scheduler.firingEntries(from, optionalTrimmedString(input.reportId))
    }
    if ((!entries || entries.length === 0) && !note) {
      throw new Error(
        'deliver requires content, a note, or a session source with artifacts',
      )
    }

    const delivery = this.#deliverToChannel(
      {
        target,
        from,
        topic,
        note,
        entries,
        subscriptionId: input.subscriptionId,
      },
      ctx,
    )
    return {
      ok: true,
      delivery: {
        seq: delivery.seq,
        topic: delivery.topic,
        files: delivery.files,
      },
    }
  }

  // Pure activation (§4.1 activate): run one turn on the target with a
  // deterministically assembled message (note + unread channel preamble).
  async #cmdActivate(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = optionalTrimmedString(input.sessionId)
    this.#assertActivatable(sessionId, ctx)

    const note = optionalTrimmedString(input.note)
    const unread = this.#channelStore.unread(sessionId)
    if (!note && unread.current.length === 0) {
      throw new Error('activate requires a note or pending channel deliveries')
    }

    return this.#runActivation(sessionId, {
      note,
      attachments: normalizeChatAttachments(input.attachments),
      edgeSourceSessionId: optionalTrimmedString(input.edgeSourceSessionId),
      edgeInput: input,
      ctx,
    })
  }

  #assertActivatable(sessionId, ctx: JsonRecord) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (this.#runs.has(sessionId)) {
      throw new Error(`Session is already running: ${sessionId}`)
    }
    if ((this.#state.runQueue ?? []).some((item) => item.sessionId === sessionId)) {
      throw new Error(`Session already has a queued provider turn: ${sessionId}`)
    }
    if (session.status === 'killed') {
      throw new Error(`Killed session cannot be resumed: ${sessionId}`)
    }
    if (this.#isSessionFrozen(sessionId)) {
      throw new Error(`Frozen session cannot be resumed: ${sessionId}`)
    }
    this.#sessionRuntime.assertBudgetAvailable(sessionId, ctx)
    try {
      session.cwd = validateRunnableCwd(session.cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#sessionRuntime.failSession(sessionId, message, {
        actor: { kind: 'runtime' },
        causeId: ctx.causeId,
      })
      throw error
    }
  }

  #deliverToChannel(
    {
      target,
      from,
      fromLabel,
      topic,
      note,
      entries,
      subscriptionId,
      execution = undefined,
    }: JsonRecord,
    ctx: JsonRecord,
  ) {
    const sourceSession = from ? this.#state.sessions[from] : undefined
    this.#checkpointChannelMutation(target)
    const delivery = this.#channelStore.deliver({
      target,
      from: from ?? 'human',
      fromLabel: fromLabel ?? sourceSession?.label,
      topic,
      note,
      entries,
      execution: execution ?? ctx?.execution,
    })
    this.#appendKernelEvent(
      'delivered',
      {
        source: from ?? 'human',
        target,
        topic,
        channelSeq: delivery.seq,
        files: delivery.files,
        notePreview: truncateForLog(note, 200),
        // Provenance for subscription-fired deliveries; fold counts a
        // deliver-only subscription's firings from this field.
        subscriptionId: optionalTrimmedString(subscriptionId),
        ...((execution ?? ctx?.execution) ? { execution: clone(execution ?? ctx.execution) } : {}),
      },
      ctx,
    )
    return delivery
  }

  // Assembles the source session's artifact bundle on demand: the last
  // assistant turn summary plus the workspace diff when there is one.
  #artifactBundleEntries(sessionId) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return []
    }
    const entries = []
    // Only completed turns feed the bundle (§4.2.6): a mid-stream delivery
    // must not snapshot a half-written assistant message.
    const lastAssistant = [...(session.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'complete' &&
          message.content,
      )
    const summary = lastAssistant?.content ?? session.result
    if (typeof summary === 'string' && summary.trim().length > 0) {
      entries.push({
        name: 'turn-summary.md',
        content: summary,
      })
    }
    try {
      const checkpoint = lastAssistant?.runId
        ? checkpointDiffForSession(this.#checkpointHost(), sessionId, { turnId: lastAssistant.runId })
        : undefined
      const diff = checkpoint
        ? [
            `Project cwd: ${checkpoint.cwd}`,
            checkpoint.files?.length
              ? `Diff stat:\n${checkpoint.files.map((file) => `${file.path} | +${file.additions} -${file.deletions}`).join('\n')}`
              : undefined,
            checkpoint.patch ? `Patch:\n${checkpoint.patch}` : 'No changes in the completed turn.',
          ].filter(Boolean).join('\n\n')
        : gitDiffForSession(this.#checkpointHost(), sessionId)
      if (typeof diff === 'string' && diff.trim().length > 0 && !diff.endsWith('No changes in the completed turn.')) {
        entries.push({
          name: 'workspace-diff.patch',
          content: diff,
        })
      }
      // An empty diff (no git repo / no changes) is a normal case: no file.
    } catch (error) {
      entries.push({
        name: 'workspace-diff-unavailable.md',
        content: `Workspace diff could not be captured: ${error instanceof Error ? error.message : String(error)}\n`,
      })
    }
    return entries
  }

  async #runActivation(
    sessionId,
    {
      note,
      attachments = [],
      edgeSourceSessionId,
      edgeInput = {},
      ctx,
      subscriptionId,
      slotKey,
    }: JsonRecord,
  ) {
    const session = this.#state.sessions[sessionId]
    const unread = this.#channelStore.unread(sessionId)
    const preamble = activationPreamble(unread, {
      channelDir: this.#channelStore.channelDir(sessionId),
    })
    const content = [note, preamble].filter(Boolean).join('\n\n')
    const firstPreparedTurn = session.prepared === true
    const providerMessage = firstPreparedTurn
      ? [session.prompt, content].filter(Boolean).join('\n\n')
      : content
    const providerPrompt = providerPromptContent({
      providerKind: session.providerKind,
      message: providerMessage,
      context: undefined,
      attachments,
    })

    const ts = now()
    const userMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content,
      attachments,
      ts,
      runId: undefined,
      status: 'complete',
    }
    session.messages.push(userMessage)
    session.prompt = content
    session.status = 'pending'
    session.error = undefined
    session.exitCode = undefined
    session.signal = undefined
    session.updatedAt = ts
    this.#updateNodeStatus(sessionId, 'pending')

    const deliveredSeqs = unread.current.map((entry) => entry.seq)
    // Everything this activation's preamble listed counts as seen. If the
    // run turns out to never start (spawn-level failure produces no output),
    // failSession rolls exactly these seqs back to unread — the agent
    // never saw the listing. Marked before the run to stay deterministic
    // against the async arrival of spawn errors.
    const listedSeqs = [
      ...unread.current.map((entry) => entry.seq),
      ...unread.superseded.map((entry) => entry.seq),
    ]
    if (listedSeqs.length > 0) {
      this.#checkpointChannelMutation(sessionId)
      this.#channelStore.markRead(sessionId, Math.max(...listedSeqs))
    }

    if (edgeSourceSessionId && this.#state.sessions[edgeSourceSessionId]) {
      this.#addEdge({
        source: edgeSourceSessionId,
        target: sessionId,
        kind: 'resume-session',
        envelope: this.#createEnvelope(edgeSourceSessionId),
        label: 'resume_session',
        masterReason: masterReasonFromInput(
          this.#state,
          edgeSourceSessionId,
          edgeInput,
        ),
      })
    }

    const activatedEvent = this.#appendKernelEvent(
      'activated',
      {
        target: sessionId,
        sessionId,
        edgeSourceSessionId,
        notePreview: truncateForLog(note, 200),
        deliveries: deliveredSeqs,
        // Present when a subscription firing executed this activation; fold
        // counts the subscription's firings from it and frees the slot.
        subscriptionId: optionalTrimmedString(subscriptionId),
        slotKey: optionalTrimmedString(slotKey),
      },
      ctx,
      {
        reason:
          ctx.reason ??
          masterReasonFromInput(
            this.#state,
            edgeSourceSessionId,
            edgeInput,
          ),
      },
    )
    this.#touch()
    // Broadcast keeps the runtime-plane name the renderer already consumes.
    this.#broadcast({
      type: 'session.resumed',
      sessionId,
      state: this.getState(),
    })

    if (firstPreparedTurn) {
      delete session.prepared
    }
    const runId = await this.#sessionRuntime.startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: firstPreparedTurn ? 'create' : 'resume',
      userMessageId: userMessage.id,
      activationEventId: activatedEvent?.id,
      channelReadSeqs: listedSeqs,
      ...(validateExecutionEnvelope(ctx.execution)
        ? { execution: clone(ctx.execution) }
        : {}),
    })

    return { ok: true, runId, state: this.getState() }
  }

  archiveSession(input: JsonRecord | string = {}) {
    const normalized = typeof input === 'string' ? { sessionId: input } : input
    return this.#cmdArchiveSession(normalized, this.#humanCtx())
  }

  #cmdArchiveSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const archived = input.archived === false ? false : true
    this.#state.sessions[sessionId].archived = archived
    this.#appendKernelEvent('session.archived', { sessionId, archived }, ctx)
    this.#touch()
    this.#broadcast({
      type: 'runtime.state',
      state: this.getState(),
    })
    return { ok: true, state: this.getState() }
  }

  getWorkingTreeDiff(input: JsonRecord | string = {}) {
    return this.#workspaceService.getWorkingTreeDiff(input)
  }

  getWorkspaceFiles(input: JsonRecord | string = {}) {
    return this.#workspaceService.getWorkspaceFiles(input)
  }

  getWorkspaceFileContent(input: JsonRecord = {}) {
    return this.#workspaceService.getWorkspaceFileContent(input)
  }

  killSession(sessionId) {
    return this.#cmdKillSession({ sessionId }, this.#humanCtx())
  }

  #cmdKillSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = input.sessionId
    const run = this.#runs.get(sessionId)
    const session = this.#state.sessions[sessionId]

    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    if (!run) {
      const queued = (this.#state.runQueue ?? []).find((item) => item.sessionId === sessionId)
      if (queued) {
        const queuedTurns = this.#state.runQueue.filter((item) => item.sessionId === sessionId).map((item) => item.turnId)
        this.#state.runQueue = this.#state.runQueue.filter((item) => item.sessionId !== sessionId)
        session.status = 'killed'
        session.updatedAt = now()
        this.#updateNodeStatus(sessionId, 'killed')
        const killedEvent = this.#appendKernelEvent('session.killed', { sessionId, turnId: queued.turnId, queuedTurnIds: queuedTurns, queued: true }, ctx)
        planCouncilFailed(this.#wf(), sessionId, 'Queued provider run was cancelled.')
        this.#sessionRuntime.settleDynamicSpawnChild(sessionId, 'cancelled', 'Queued provider run was cancelled.')
        this.#touch()
        return { ok: true, kernelEventId: killedEvent?.id, state: this.getState() }
      }
      return { ok: false, state: this.getState() }
    }

    const context = this.#runContext.get(sessionId)
    if (context) {
      // Mark intent before provider teardown: close/error events may arrive
      // synchronously or race the state update below.
      context.killRequested = true
    }
    const ok = run.kill()
    if (!ok && context) {
      delete context.killRequested
    }
    if (ok) {
      session.status = 'killed'
      session.updatedAt = now()
      this.#sessionRuntime.markActiveAssistant(sessionId, 'failed')
      this.#updateNodeStatus(sessionId, 'killed')
      this.#sessionRuntime.appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts: session.updatedAt,
        type: 'session.state',
        sessionId,
        status: 'killed',
      })
      this.#sessionRuntime.cancelOpenRuntimeInteractions(sessionId, session.updatedAt)
      const killedEvent = this.#appendKernelEvent(
        'session.killed',
        { sessionId },
        ctx,
      )
      if (context) {
        // The provider run's close handler re-broadcasts session.killed once
        // the process actually exits; point it at this kernel fact.
        context.killedEventId = killedEvent?.id
      }
      this.#sessionRuntime.settleDynamicSpawnChild(
        sessionId,
        'cancelled',
        'Dynamic participant was killed.',
      )
      this.#touch()
      this.#emitRuntimeEvent({
        type: 'session.killed',
        sessionId,
        state: this.getState(),
        kernelEventId: killedEvent?.id,
      })
    }

    return { ok, state: this.getState() }
  }

  killAll() {
    // Commands already queued before shutdown may still finish recording
    // durable facts, but they must not launch a fresh Governor turn after
    // every provider has been closed. A later command from any non-runtime
    // control plane revives draining on this reusable manager instance.
    this.#governance.suspendWakeupDrain()
    this.#sessionRuntime.suspendQueueDrain()
    this.#persistState()
    for (const sessionId of this.#runs.keys()) {
      this.killSession(sessionId)
    }
    for (const terminalId of this.#terminalService.runningTerminalIds()) {
      this.closeTerminal({ terminalId })
    }
    // Armed timers die with the runtime; construction re-arms them from the
    // persisted subscriptions (with a single catch-up tick if overdue).
    this.#scheduler.clearAllTimers()
    this.#governance.clearBarrierTimers()
    // Source adapters likewise: construction restarts them from the
    // persisted registry (ExternalIngestionService.recoverSourceAnchors).
    this.#externalIngestion.suspendAdapters()
    this.#providerService?.closeAll?.()
    this.#bridge?.close()
    // The kernel store intentionally stays open: killAll is revivable (the
    // bridge and provider service relaunch lazily), and a closed store would
    // silently drop later kernel events. If a newer runtime takes over the
    // same store, this connection's snapshot writes are dropped by the
    // snapshot-owner check instead of clobbering the newer state.
  }

  respondRuntimeRequest(input: JsonRecord = {}) {
    return this.#cmdRespondRuntimeRequest(input, this.#humanCtx())
  }

  #cmdRespondRuntimeRequest(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const decision = input.decision

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('Runtime request id is required')
    }
    if (!validRuntimeRequestDecisions.has(decision)) {
      throw new Error(
        'Runtime request decision must be accept, acceptForSession, decline, or cancel',
      )
    }
    const normalizedDecision = normalizeRuntimeRequestDecision(decision)

    const session = this.#state.sessions[sessionId]
    const request = session.runtimeRequests?.find(
      (item) => item.id === requestId,
    )
    if (!request) {
      throw new Error(`Unknown runtime request: ${requestId}`)
    }
    if (request.status !== 'open') {
      return { ok: false, state: this.getState() }
    }
    const run = this.#runs.get(sessionId)
    if (typeof run?.respondRuntimeRequest !== 'function') {
      throw new Error(
        `Session cannot respond to runtime requests: ${sessionId}`,
      )
    }

    const providerResult = run.respondRuntimeRequest({
      requestId,
      decision: normalizedDecision,
    })
    const providerDecision = isObject(providerResult)
      ? providerResult.decision
      : undefined
    const appliedDecision = validRuntimeRequestDecisions.has(providerDecision)
      ? normalizeRuntimeRequestDecision(providerDecision)
      : normalizedDecision
    const event = {
      id: randomUUID(),
      ts: now(),
      type: 'request.resolved',
      sessionId,
      requestId,
      status: runtimeRequestStatusForDecision(appliedDecision, request),
    }
    this.#sessionRuntime.appendExternalProviderRuntimeEvent(sessionId, event)
    this.#appendKernelEvent(
      'interaction.responded',
      {
        sessionId,
        requestId,
        decision: appliedDecision,
      },
      ctx,
    )
    return { ok: true, state: this.getState() }
  }

  answerUserInput(input: JsonRecord = {}) {
    return this.#cmdAnswerUserInput(input, this.#humanCtx())
  }

  #cmdAnswerUserInput(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const answer = typeof input.answer === 'string' ? input.answer : undefined
    const answers = normalizeUserInputAnswers(input.answers)
    const primaryAnswer = firstUserInputAnswer(answer, answers)

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('User input request id is required')
    }
    if (primaryAnswer === undefined && !answers) {
      throw new Error('User input answer is required')
    }

    const session = this.#state.sessions[sessionId]
    const request = session.runtimeUserInputRequests?.find(
      (item) => item.id === requestId,
    )
    if (!request) {
      throw new Error(`Unknown user input request: ${requestId}`)
    }
    if (request.status !== 'open') {
      return { ok: false, state: this.getState() }
    }
    if (!userInputQuestionsAreComplete(request, answer, answers)) {
      throw new Error('Every user input question requires a non-empty answer')
    }

    const run = this.#runs.get(sessionId)
    if (typeof run?.answerUserInput !== 'function') {
      throw new Error(`Session cannot answer user input requests: ${sessionId}`)
    }

    const providerResult = run.answerUserInput({
      requestId,
      answer: primaryAnswer,
      answers,
    })
    const canceled =
      isObject(providerResult) && providerResult.outcome === 'cancelled'
    const event = canceled
      ? {
          id: randomUUID(),
          ts: now(),
          type: 'user-input.resolved',
          sessionId,
          requestId,
          status: 'canceled',
        }
      : {
          id: randomUUID(),
          ts: now(),
          type: 'user-input.answered',
          sessionId,
          requestId,
          answer: primaryAnswer,
          ...(answers ? { answers } : {}),
        }
    this.#sessionRuntime.appendExternalProviderRuntimeEvent(sessionId, event)
    this.#appendKernelEvent(
      'interaction.answered',
      { sessionId, requestId, outcome: canceled ? 'cancelled' : 'answered' },
      ctx,
    )
    return { ok: true, state: this.getState() }
  }

  upsertCluster(input: JsonRecord = {}) {
    return this.#clusterControl.upsertCluster(input)
  }

  #cmdUpsertCluster(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdUpsertCluster(input, ctx)
  }

  createMasterForCluster(input: JsonRecord = {}) {
    return this.#clusterControl.createMasterForCluster(input)
  }

  #cmdCreateMasterForCluster(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdCreateMasterForCluster(input, ctx)
  }

  assignMasterToCluster(input: JsonRecord = {}) {
    return this.#clusterControl.assignMasterToCluster(input)
  }

  #cmdAssignMaster(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdAssignMaster(input, ctx)
  }

  setClusterLoopPolicy(input: JsonRecord = {}) {
    return this.#clusterControl.setClusterLoopPolicy(input)
  }

  #cmdSetLoopPolicy(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdSetLoopPolicy(input, ctx)
  }

  updateNodePositions(input: JsonRecord = {}) {
    return this.#clusterControl.updateNodePositions(input)
  }

  #cmdUpdateNodePositions(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdUpdateNodePositions(input, ctx)
  }

  startMasterLoop(input: JsonRecord = {}) {
    return this.#clusterControl.startMasterLoop(input)
  }

  #cmdStartLoop(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdStartLoop(input, ctx)
  }

  stopMasterLoop(input: JsonRecord = {}) {
    return this.#clusterControl.stopMasterLoop(input)
  }

  stopLoop(input: JsonRecord = {}) {
    return this.#clusterControl.stopLoop(input)
  }

  #cmdStopLoop(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdStopLoop(input, ctx)
  }

  authorSubscription(input: JsonRecord = {}) {
    return this.#scheduler.cmdAuthorSubscription(input, this.#humanCtx())
  }

  // ---- workflow orchestration lives in workflows/ ----
  // These delegates keep the public API stable; implementations access the
  // kernel through the explicit WorkflowKernel surface (#wf()).
  #providerSetupHostCache: ProviderSetupHost | undefined

  #providerSetupHost(): ProviderSetupHost {
    if (this.#providerSetupHostCache) return this.#providerSetupHostCache
    const self = this
    this.#providerSetupHostCache = {
      get state() {
        return self.#state
      },
      getState: () => this.getState(),
      touchDeferred: () => this.#touchDeferred(),
      broadcast: (event) => this.#broadcast(event),
    }
    return this.#providerSetupHostCache
  }

  #checkpointHostCache: CheckpointHost | undefined

  #checkpointHost(): CheckpointHost {
    if (this.#checkpointHostCache) return this.#checkpointHostCache
    const self = this
    this.#checkpointHostCache = {
      get state() {
        return self.#state
      },
      get runContext() {
        return self.#runContext
      },
      appendProviderRuntimeEvent: (sessionId, event) =>
        this.#sessionRuntime.appendProviderRuntimeEvent(sessionId, event),
    }
    return this.#checkpointHostCache
  }

  #wfKernel: WorkflowKernel | undefined

  #wf(): WorkflowKernel {
    if (this.#wfKernel) return this.#wfKernel
    const self = this
    this.#wfKernel = {
      get state() {
        return self.#state
      },
      get kernelStore() {
        return self.#kernelStore
      },
      get channelStore() {
        return self.#channelStore
      },
      get controlCommandContext() {
        return self.#commandExecutor.context
      },
      get classicWorkflowInFlight() {
        return self.#classicWorkflowInFlight
      },
      get planCouncilInFlight() {
        return self.#planCouncilInFlight
      },
      get goalLoopInFlight() {
        return self.#goalLoopInFlight
      },
      get workflowCompensatedRuns() {
        return self.#workflowCompensatedRuns
      },
      get runs() {
        return self.#runs
      },
      get runContext() {
        return self.#runContext
      },
      get workflowDeploymentCrashAfterStage() {
        return self.#workflowDeploymentCrashAfterStage
      },
      get committedStateDuringCommand() {
        return self.#commandExecutor.committedStateDuringCommand
      },
      getState: () => this.getState(),
      dispatchCommand: (command) => this.dispatchCommand(command),
      killSession: (sessionId) => this.killSession(sessionId),
      cmdAuthorSubscription: (input, ctx) =>
        this.#scheduler.cmdAuthorSubscription(input, ctx),
      cmdCreateSession: (input, ctx, opts) =>
        (this.#cmdCreateSession as any)(input, ctx, opts),
      cmdActivate: (input, ctx, opts) =>
        (this.#cmdActivate as any)(input, ctx, opts),
      cmdDeliver: (input, ctx, opts) =>
        (this.#cmdDeliver as any)(input, ctx, opts),
      cmdResumeSession: (input, ctx, opts) =>
        (this.#cmdResumeSession as any)(input, ctx, opts),
      cmdStopSubscription: (input, ctx) => this.#scheduler.cmdStopSubscription(input, ctx),
      cmdCreateBarrier: (input, ctx) => this.#governance.cmdCreateBarrier(input, ctx),
      cmdArriveBarrier: (input, ctx) => this.#governance.cmdArriveBarrier(input, ctx),
      cmdCancelBarrier: (input, ctx) => this.#governance.cmdCancelBarrier(input, ctx),
      cmdUnfreeze: (input, ctx) => this.#cmdUnfreeze(input, ctx),
      cmdSetResourcePolicy: (input, ctx) =>
        this.#sessionRuntime.cmdSetResourcePolicy(input, ctx),
      cmdLinkSessions: (input, ctx) => this.#cmdLinkSessions(input, ctx),
      workflowCommandCtx: () => this.#workflowCommandCtx(),
      humanCtx: () => this.#humanCtx(),
      subscriptionRuleCtx: (subscriptionId, causeId) =>
        this.#scheduler.ruleContext(subscriptionId, causeId),
      touch: () => this.#touch(),
      broadcast: (event) => this.#broadcast(event),
      appendKernelEvent: (type, payload, ctx, opts) =>
        this.#appendKernelEvent(type, payload, ctx, opts),
      assertActivatable: (sessionId, ctx) =>
        this.#assertActivatable(sessionId, ctx),
      kernelView: (state) => this.#queries.kernelView(state),
      readState: () => this.#readState(),
      startRun: (sessionId, request) => this.#sessionRuntime.startRun(sessionId, request),
      resourcePolicy: (scopeId) => this.#sessionRuntime.resourcePolicy(scopeId),
      resourceScopeId: (sessionId) => this.#sessionRuntime.resourceScopeId(sessionId),
      isSessionFrozen: (sessionId) => this.#isSessionFrozen(sessionId),
      drainApprovedSlots: () => this.#scheduler.drainApprovedSlots(),
      deliverToChannel: (...args: any[]) =>
        (this.#deliverToChannel as any)(...args),
      createPendingActivation: (...args: any[]) =>
        (this.#scheduler.createPendingActivation as any)(...args),
      clearTimer: (subscriptionId) => this.#scheduler.clearTimer(subscriptionId),
      activeWorkflowPlan: (workflowId) => this.#activeWorkflowPlan(workflowId),
    }
    return this.#wfKernel
  }

  async startDraftWorkflow(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startDraftWorkflow(this.#wf(), input)
  }

  async startHandoffWorkflow(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startHandoffWorkflow(this.#wf(), input)
  }

  async startGoalWorkflow(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startGoalWorkflow(this.#wf(), input)
  }

  async connectAgents(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return connectAgents(this.#wf(), input)
  }

  getWorkflowDeployments(input: JsonRecord = {}) {
    return getWorkflowDeployments(this.#wf(), input)
  }

  getPlanCouncil(input: JsonRecord | string = {}) {
    return getPlanCouncil(this.#wf(), input)
  }

  getPlanCouncilArtifact(input: JsonRecord = {}) {
    return getPlanCouncilArtifact(this.#wf(), input)
  }

  async startPlanCouncil(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startPlanCouncil(this.#wf(), input)
  }

  async startPlanCouncilCrossReview(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startPlanCouncilCrossReview(this.#wf(), input)
  }

  async startPlanCouncilSynthesis(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startPlanCouncilSynthesis(this.#wf(), input)
  }

  stopPlanCouncil(input: JsonRecord = {}) {
    return stopPlanCouncil(this.#wf(), input)
  }

  async startReviewWorkflow(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return startReviewWorkflow(this.#wf(), input)
  }

  async createGoalLoop(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return createGoalLoop(this.#wf(), input)
  }

  listTemplates() {
    return listTemplates(this.#wf())
  }

  async applyTemplate(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return applyTemplate(this.#wf(), input)
  }

  saveTemplate(input: JsonRecord = {}) {
    return saveTemplate(this.#wf(), input)
  }

  removeTemplate(input: JsonRecord = {}) {
    return removeTemplate(this.#wf(), input)
  }

  cleanupChannels(input: JsonRecord = {}) {
    return this.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion)
        ? input.expectedVersion
        : undefined,
      kind: 'cleanup_channels',
      actor: { kind: 'human' },
      reason: optionalTrimmedString(input.reason),
      input,
    })
  }

  #cmdCleanupChannels(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionIds = optionalTrimmedString(input.sessionId)
      ? [this.#queries.requireSession(input.sessionId).sessionId]
      : Object.keys(this.#state.sessions)
    const policy = {
        maxReadAgeDays: Number.isFinite(input.maxReadAgeDays)
          ? Number(input.maxReadAgeDays)
          : undefined,
        maxReadEntries: Number.isInteger(input.maxReadEntries)
          ? Number(input.maxReadEntries)
          : undefined,
        keepLatestReadPerTopic: input.keepLatestReadPerTopic !== false,
      }
    const transaction = this.#commandExecutor.currentTransaction()
    const results = sessionIds.map((sessionId) =>
      this.#channelStore.cleanup(sessionId, {
        ...policy,
        dryRun: Boolean(transaction),
      }),
    )
    if (transaction) {
      transaction.outboxEffects.push({
        effectId: `channel-cleanup:${transaction.commandId}`,
        kind: 'channel-cleanup',
        payload: { sessionIds, policy },
      })
    }
    const removedDeliveries = results.reduce(
      (sum, result) => sum + result.removedDeliveries,
      0,
    )
    const removedBytes = results.reduce(
      (sum, result) => sum + result.removedBytes,
      0,
    )
    this.#appendKernelEvent(
      'channel.cleanup.scheduled',
      { sessionIds, removedDeliveries, removedBytes },
      ctx,
      { reason: optionalTrimmedString(input.reason) },
    )
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { ok: true, results, removedDeliveries, removedBytes, state: this.getState() }
  }

  stopSubscription(input: JsonRecord = {}) {
    return {
      ...this.#scheduler.cmdStopSubscription(input, this.#humanCtx()),
      state: this.getState(),
    }
  }

  async approveActivation(input: JsonRecord = {}) {
    this.#reviveDirectProviderRuntime()
    return this.#scheduler.cmdApproveActivation(input, this.#humanCtx())
  }

  denyActivation(input: JsonRecord = {}) {
    return this.#scheduler.cmdDenyActivation(input, this.#humanCtx())
  }

  freeze(input: JsonRecord = {}) {
    return this.#cmdFreeze(input, this.#humanCtx())
  }

  unfreeze(input: JsonRecord = {}) {
    return this.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      expectedVersion: Number.isInteger(input.expectedVersion)
        ? input.expectedVersion
        : undefined,
      kind: 'unfreeze',
      actor: { kind: 'human' },
      reason: optionalTrimmedString(input.reason),
      input,
    })
  }

  mergeWorktreeChanges(input: JsonRecord = {}) {
    return this.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      kind: 'merge_worktree_changes',
      actor: { kind: 'human' },
      input,
    })
  }

  cleanupWorktree(input: JsonRecord = {}) {
    return this.dispatchCommand({
      commandId: optionalTrimmedString(input.commandId),
      idempotencyKey: optionalTrimmedString(input.idempotencyKey),
      kind: 'cleanup_worktree',
      actor: { kind: 'human' },
      input,
    })
  }

  #cmdFreeze(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdFreeze(input, ctx)
  }

  #cmdUnfreeze(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#clusterControl.cmdUnfreeze(input, ctx)
  }

  linkSessions(input: JsonRecord = {}) {
    return this.#cmdLinkSessions(input, this.#humanCtx())
  }

  #cmdLinkSessions(input: JsonRecord = {}, ctx: JsonRecord) {
    const request = isObject(input) ? input : {}
    const source = this.#queries.requireSession(request.source).sessionId
    const target = this.#queries.requireSession(request.target).sessionId
    if (source === target) {
      throw new Error('Cannot link a session to itself')
    }

    const label = nonEmptyString(request.label) ? request.label.trim() : 'link'
    const reason = nonEmptyString(request.reason)
      ? request.reason.trim()
      : undefined

    const existing = this.#state.edges.find(
      (edge) =>
        edge.kind === 'link' &&
        edge.source === source &&
        edge.target === target &&
        edge.label === label,
    )
    if (existing) {
      // Idempotent on source+target+label, but a fresh reason replaces the
      // stored detail so re-declaring a link never silently drops rationale.
      if (reason && existing.summary !== reason) {
        existing.summary = reason
        this.#appendKernelEvent(
          'edge.linked',
          {
            edgeId: existing.edgeId,
            source,
            target,
            label,
            refreshedReason: true,
          },
          ctx,
          {
            reason: ctx.reason ?? reason,
          },
        )
        this.#touch()
        this.#broadcast({
          type: 'runtime.state',
          state: this.getState(),
        })
      }
      return { edge: clone(existing) }
    }

    const envelope = this.#createEnvelope(source)
    this.#addEdge({
      source,
      target,
      kind: 'link',
      envelope,
      label,
      summary: reason,
    })
    const edge = this.#state.edges.at(-1)
    this.#appendKernelEvent(
      'edge.linked',
      { edgeId: edge.edgeId, source, target, label },
      ctx,
      { reason: ctx.reason ?? reason },
    )
    this.#touch()
    this.#broadcast({
      type: 'edge.created',
      edgeId: edge.edgeId,
      state: this.getState(),
    })
    return { edge: clone(edge) }
  }

  removeEdge(input: JsonRecord = {}) {
    return this.#cmdRemoveEdge(input, this.#humanCtx())
  }

  #cmdRemoveEdge(input: JsonRecord = {}, ctx: JsonRecord) {
    const request = isObject(input) ? input : {}
    const edgeId = nonEmptyString(request.edgeId)
      ? request.edgeId.trim()
      : undefined
    if (!edgeId) {
      throw new Error('removeEdge edgeId is required')
    }

    const index = this.#state.edges.findIndex((edge) => edge.edgeId === edgeId)
    if (index < 0) {
      throw new Error(`Unknown edge: ${edgeId}`)
    }

    const edge = this.#state.edges[index]
    if (edge.kind !== 'link') {
      // Runtime-semantic edges (create/resume/report/freeze) are history of
      // what actually happened; only declared relationships are removable.
      throw new Error(
        `Only link edges can be removed, ${edgeId} is ${edge.kind}`,
      )
    }

    this.#state.edges.splice(index, 1)
    this.#appendKernelEvent(
      'edge.removed',
      { edgeId, source: edge.source, target: edge.target },
      ctx,
    )
    this.#touch()
    this.#broadcast({
      type: 'edge.removed',
      edgeId,
      state: this.getState(),
    })
    return { ok: true }
  }

  #workflowActorScopeId(ctx: JsonRecord, requestedScopeId?: string) {
    const actor = ctx?.actor
    if (actor?.kind === 'master') {
      const session = this.#state.sessions[actor.ref]
      if (!session || session.role !== 'master') {
        throw new Error('Workflow authoring tools require a real Master session.')
      }
      const scopeId = this.#masterClusterId(actor.ref)
      if (!scopeId) {
        throw new Error('This Master is not assigned to a Scope.')
      }
      if (requestedScopeId && requestedScopeId !== scopeId) {
        throw new Error(`Master ${actor.ref} cannot author outside Scope ${scopeId}.`)
      }
      return scopeId
    }
    if (actor?.kind !== 'human' && actor?.kind !== 'runtime') {
      throw new Error('Only a human or Scope Master can author workflows.')
    }
    return requestedScopeId || 'global'
  }

  #workflowCapability(scopeId: string, options: JsonRecord = {}) {
    return this.#proposals.workflowCapability(scopeId, options)
  }

  #activeWorkflowPlans() {
    return this.#governance.activeWorkflowPlans()
  }

  inspectWorkflowWakeups(input: JsonRecord = {}, source?: string) {
    const scopeId = source
      ? this.#workflowActorScopeId({
          actor: this.#membraneRequests.membraneActor(source),
        })
      : optionalTrimmedString(input.scopeId)
    return this.#governance.inspectWorkflowWakeups(input, scopeId)
  }

  #activeWorkflowPlan(workflowId: string) {
    return this.#proposals.activeWorkflowPlan(workflowId)
  }

  #storeWorkflowPlan(plan: JsonRecord) {
    return this.#proposals.storeWorkflowPlan(plan)
  }

  #cmdProposeWorkflow(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdProposeWorkflow(input, ctx)
  }

  #cmdProposeWorkflowPatch(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdProposeWorkflowPatch(input, ctx)
  }

  #cmdReviseWorkflow(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdReviseWorkflow(input, ctx)
  }

  #cmdApproveWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdApproveWorkflowProposal(input, ctx)
  }

  #cmdRejectWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdRejectWorkflowProposal(input, ctx)
  }

  #cmdExpireWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdExpireWorkflowProposal(input, ctx)
  }

  #cmdAbortWorkflowProposal(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdAbortWorkflowProposal(input, ctx)
  }

  #cmdLockWorkflowItem(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdLockWorkflowItem(input, ctx)
  }

  #cmdCommitWorkflow(input: JsonRecord = {}, ctx: JsonRecord) {
    return this.#proposals.cmdCommitWorkflow(input, ctx)
  }

  inspectWorkflowScope(input: JsonRecord = {}, source?: string) {
    return this.#proposals.inspectWorkflowScope(input, source)
  }

  explainWorkflow(input: JsonRecord = {}, source?: string) {
    return this.#proposals.explainWorkflow(input, source)
  }

  async handleMembraneRequest(request: JsonRecord) {
    return this.#membraneRequests.handleRequest(request)
  }

  #updateNodeStatus(sessionId, status) {
    return this.#clusterControl.updateNodeStatus(sessionId, status)
  }

  #ensureCluster(clusterId) {
    return this.#clusterControl.ensureCluster(clusterId)
  }

  #addNodeToCluster(sessionId, clusterId) {
    return this.#clusterControl.addNodeToCluster(sessionId, clusterId)
  }

  #masterClusterId(sessionId) {
    return this.#clusterControl.masterClusterId(sessionId)
  }

  #managedClusterId(sessionId) {
    return this.#clusterControl.managedClusterId(sessionId)
  }

  #managingMasterSessionId(sessionId) {
    return this.#clusterControl.managingMasterSessionId(sessionId)
  }

  #isSessionFrozen(sessionId) {
    return this.#clusterControl.isSessionFrozen(sessionId)
  }

  // Restart recovery for the intent layer: subscriptions and pending slots
  // persist in the snapshot; approved slots drain once targets are free.
  // Master-gated slots that were pending at shutdown stay approvable via
  // membrane/HTTP (they are not re-notified automatically).
  #recoverSchedulerState() {
    this.#scheduler.enqueueWork(
      () => this.#scheduler.drainApprovedSlots(),
      (error) => {
        console.error(
          `Scheduler recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
  }

  #emitRuntimeEvent(event) {
    this.#broadcast(event)
  }

  #applyFreeze(input: JsonRecord, ctx: JsonRecord) {
    return this.#clusterControl.applyFreeze(input, ctx)
  }

  #cmdReport(input: JsonRecord = {}, ctx: JsonRecord) {
    const source = ctx.actor?.ref
    if (!source || !this.#state.sessions[source]) {
      throw new Error(`Unknown report source session: ${source ?? ''}`)
    }

    const payload = normalizeReportPayload(input)
    const envelope = this.#createEnvelope(source)
    const runContext = this.#runContext.get(source)
    const turnId = runContext?.runId
    const reportCtx = !validateExecutionEnvelope(ctx.execution) && validateExecutionEnvelope(runContext?.execution)
      ? { ...ctx, execution: clone(runContext.execution) }
      : ctx
    const report = {
      id: randomUUID(),
      from: source,
      envelope,
      payload,
      ...(turnId ? { turnId } : {}),
    }

    this.#state.reports.push(report)
    if (this.#state.reports.length > 250) {
      this.#state.reports.splice(0, this.#state.reports.length - 250)
    }

    if (
      payload.type === 'relationship' &&
      typeof payload.sessionRef === 'string' &&
      this.#state.sessions[payload.sessionRef]
    ) {
      this.#addEdge({
        source,
        target: payload.sessionRef,
        kind: 'report',
        envelope,
        label: payload.nature ?? 'relationship',
        reportId: report.id,
        summary: payload.target,
      })
    }

    const masterSessionId = this.#managingMasterSessionId(source)
    if (masterSessionId && masterSessionId !== source) {
      this.#addEdge({
        source,
        target: masterSessionId,
        kind: 'report',
        envelope,
        label: payload.type,
        reportId: report.id,
        verdict: payload.type === 'verdict' ? payload.verdict : undefined,
        issueCount:
          payload.type === 'verdict'
            ? (payload.issues?.length ?? 0)
            : undefined,
        summary: reportSummary(payload),
      })
    }

    const reportEvent = this.#appendKernelEvent(
      'report.received',
      {
        reportId: report.id,
        from: source,
        reportType: payload.type,
        verdict: payload.type === 'verdict' ? payload.verdict : undefined,
        summary: truncateForLog(reportSummary(payload), 200),
        turnId,
      },
      reportCtx,
    )
    this.#touch()
    this.#emitRuntimeEvent({
      type: 'report.received',
      from: source,
      report,
      state: this.getState(),
      kernelEventId: reportEvent?.id,
    })
    return { ok: true }
  }

  #createEnvelope(source) {
    return {
      callId: randomUUID(),
      source,
      ts: now(),
    }
  }

  #addEdge({
    source,
    target,
    kind,
    envelope,
    label,
    reportId,
    verdict,
    issueCount,
    summary,
    masterReason,
    frozen,
    freezeReason,
  }: JsonRecord) {
    if (!this.#state.sessions[source]) {
      throw new Error(`Unknown edge source session: ${source}`)
    }

    if (!this.#state.sessions[target]) {
      throw new Error(`Unknown edge target session: ${target}`)
    }

    const baseEdgeId = `${kind}:${envelope.callId}`
    const edgeId = this.#state.edges.some((edge) => edge.edgeId === baseEdgeId)
      ? `${baseEdgeId}:${randomUUID().slice(0, 8)}`
      : baseEdgeId

    this.#state.edges.push({
      edgeId,
      source,
      target,
      kind,
      call: envelope,
      label,
      ts: envelope.ts,
      reportId,
      verdict,
      issueCount,
      summary,
      masterReason,
      frozen,
      freezeReason,
    })
  }

  #checkpointChannelMutation(sessionId: string) {
    this.#commandExecutor.checkpointChannelMutation(sessionId)
  }

  #touch() {
    this.#commandExecutor.touch()
  }

  #touchDeferred() {
    this.#commandExecutor.touchDeferred()
  }

  #broadcast(event) {
    this.#commandExecutor.broadcast(event)
  }

  #persistState() {
    this.#commandExecutor.persistState()
  }

  #kernelStoreDiagnostics() {
    return this.#kernelStore.diagnostics.map((item) =>
      diagnostic(item.code, item.message, item.context ?? {}),
    )
  }

  #loadState() {
    const durable = this.#kernelStore.loadDurableState()
    const storeDiagnostics = this.#kernelStoreDiagnostics()
    if (durable) {
      return normalizeState(durable.state, storeDiagnostics, this.#restartInterruptedSessionIds)
    }
    const snapshot = this.#kernelStore.loadSnapshot()
    if (snapshot) {
      return normalizeState(snapshot.state, storeDiagnostics, this.#restartInterruptedSessionIds)
    }

    // No snapshot. Distinguish first-run migration from corruption recovery:
    // after a preserved-corrupt store, the JSON file is a stale fossil -- we
    // still restore it (better than empty), but the rollback must be loud.
    const storeWasCorrupted = this.#kernelStore.diagnostics.some((item) =>
      String(item.code ?? '').startsWith('kernel-store.'),
    )
    const fossilExists = this.#storageFile && fs.existsSync(this.#storageFile)
    if (storeWasCorrupted && fossilExists) {
      let fossilModifiedAt
      try {
        fossilModifiedAt = fs.statSync(this.#storageFile).mtime.toISOString()
      } catch {
        fossilModifiedAt = undefined
      }
      storeDiagnostics.push(
        diagnostic(
          'storage.state_rolled_back',
          'Kernel store was corrupt; state was restored from the legacy JSON snapshot and may be older than your latest work.',
          {
            storageFile: this.#storageFile,
            fossilModifiedAt,
          },
        ),
      )
    }

    const legacy = loadLegacyJsonState(
      this.#storageFile,
      storeDiagnostics,
      this.#restartInterruptedSessionIds,
    )
    if (legacy) {
      if (legacy.imported) {
        this.#legacyImportKind = storeWasCorrupted
          ? 'fossil-rollback'
          : 'migration'
      }
      return legacy.state
    }

    if (storeDiagnostics.length > 0) {
      return withDiagnostics(createEmptyGraphState(), storeDiagnostics)
    }
    return createEmptyGraphState()
  }

}
