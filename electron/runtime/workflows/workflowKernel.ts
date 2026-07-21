// WorkflowKernel: the explicit, enumerated interface between the workflow
// orchestration modules (this directory) and RuntimeSessionManager.
//
// This is the honest write-down of the coupling that used to be implicit
// private-method access inside one 17k-line class. Every member here is a
// live view or a delegate into the manager; workflow modules must not gain
// state of their own or bypass this surface. If this interface needs to
// grow, that is a design signal — prefer routing new needs through existing
// command entries (cmd*) over adding raw state access.
import type { AsyncLocalStorage } from 'node:async_hooks'
import type { JsonRecord } from '../runtimeCommon.js'

export type WorkflowKernel = {
  // ---- live views of manager-owned state (never reassigned here) ----
  readonly state: JsonRecord
  readonly kernelStore: any
  readonly channelStore: any
  readonly controlCommandContext: AsyncLocalStorage<JsonRecord>
  readonly classicWorkflowInFlight: Set<string>
  readonly planCouncilInFlight: Set<string>
  readonly goalLoopInFlight: Set<string>
  readonly workflowCompensatedRuns: Set<string>
  readonly runs: Map<string, any>
  readonly runContext: Map<string, JsonRecord>
  // crash-injection test hooks (read-only)
  readonly workflowDeploymentCrashAfterStage: string | undefined
  readonly committedStateDuringCommand: JsonRecord | undefined

  // ---- public manager API ----
  getState(): JsonRecord
  dispatchCommand(command: JsonRecord): Promise<any>
  killSession(sessionId: string): any

  // ---- kernel command handlers (transaction-scoped; ctx comes from the
  // command context helpers below) ----
  cmdAuthorSubscription(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdCreateSession(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): Promise<any>
  cmdActivate(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): Promise<any>
  cmdDeliver(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdResumeSession(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): Promise<any>
  cmdStopSubscription(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdCreateBarrier(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdArriveBarrier(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdCancelBarrier(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdUnfreeze(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdSetResourcePolicy(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any
  cmdLinkSessions(input: JsonRecord, ctx: JsonRecord, opts?: JsonRecord): any

  // ---- command actor contexts ----
  workflowCommandCtx(): JsonRecord
  humanCtx(): JsonRecord
  subscriptionRuleCtx(subscriptionId: string, causeId?: string): JsonRecord

  // ---- kernel internals the composers still lean on ----
  touch(): void
  broadcast(event: JsonRecord): void
  appendKernelEvent(
    type: string,
    payload: JsonRecord,
    ctx: JsonRecord,
    opts?: JsonRecord,
  ): any
  assertActivatable(sessionId: string, ctx: JsonRecord): void
  kernelView(state?: JsonRecord): any
  readState(): JsonRecord
  startRun(sessionId: string, request: JsonRecord): Promise<any>
  resourcePolicy(scopeId: string): JsonRecord
  resourceScopeId(sessionId: string): string
  isSessionFrozen(sessionId: string): boolean
  drainApprovedSlots(): Promise<any>
  deliverToChannel(...args: any[]): any
  createPendingActivation(...args: any[]): Promise<any>
  clearTimer(subscriptionId: string): void
  activeWorkflowPlan(workflowId: string): JsonRecord | undefined
}
