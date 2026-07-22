// Shared value helpers and schema validation sets for the runtime session
// manager and the modules split out of it. Everything here is pure data or
// side-effect-free helpers; keep runtime orchestration out of this file.
import { randomUUID } from 'node:crypto'
import {
  graphEdgeKinds,
  openWorkspaceTargetIds,
  runtimeTerminalStreams,
} from '../../shared/graph-state.js'
import {
  providerKinds,
  providerMetadata,
} from '../../shared/provider-metadata.js'
import {
  workflowPlanStatuses,
  workflowProposalStatuses,
  workflowRecipes,
} from '../../shared/workflow-authoring.js'
import {
  workflowWakeupKinds,
  workflowWakeupStatuses,
} from '../../shared/workflow-governance.js'
import { barrierModes, barrierStatuses } from '../../shared/barrier.js'

export const validSubscriptionGates = new Set(['auto', 'master', 'human'])
export const validSubscriptionConcurrencies = new Set([
  'coalesce',
  'queue',
  'drop',
  'interrupt',
])
export const validSubscriptionOnStops = new Set([
  'freeze-edge',
  'freeze-target',
  'freeze-cluster',
])
export const validSubscriptionPatterns = new Set([
  'finished',
  'failed',
  'report',
  'delivered',
  'schedule',
  'external',
])
export const validWorkflowRecipes = new Set(workflowRecipes)
export const validWorkflowPlanStatuses = new Set(workflowPlanStatuses)
export const validWorkflowProposalStatuses = new Set(workflowProposalStatuses)
export const validWorkflowWakeupKinds = new Set(workflowWakeupKinds)
export const validWorkflowWakeupStatuses = new Set(workflowWakeupStatuses)
export const validBarrierModes = new Set(barrierModes)
export const validBarrierStatuses = new Set(barrierStatuses)
export const recoverableActiveStatuses = new Set(['pending', 'running'])
export const validSessionStatuses = new Set([
  'pending',
  'running',
  'idle',
  'failed',
  'killed',
])
export const validMessageStatuses = new Set(['streaming', 'complete', 'failed'])
export const validProviderKinds: ReadonlySet<string> = new Set(providerKinds)
export const validAgentBackends = new Set(
  Object.values(providerMetadata).map((metadata) => metadata.backend),
)
export const validWorkModes = new Set(['local', 'worktree'])
export const validRuntimeItemStatuses = new Set([
  'pending',
  'running',
  'completed',
  'failed',
])
export const validRuntimeRequestDecisions = new Set([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
  'approved',
  'denied',
])
export const validRuntimeRequestStatuses = new Set([
  'open',
  'approved',
  'approved_for_session',
  'denied',
  'resolved',
  'stale',
  'canceled',
])
export const validUserInputRequestStatuses = new Set([
  'open',
  'answered',
  'resolved',
  'stale',
  'canceled',
])
export const validProviderRuntimeModes = new Set([
  'approval-required',
  'auto',
  'auto-accept-edits',
  'full-access',
])
export const validProviderApprovalPolicies = new Set([
  'untrusted',
  'on-request',
  'never',
])
export const validProviderSandboxModes = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
export const validProviderReasoningEfforts = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
])
export const validProviderInteractionModes = new Set(['default', 'plan'])
export const validGraphEdgeKinds = new Set(graphEdgeKinds)
export const validOpenWorkspaceTargets = new Set(openWorkspaceTargetIds)
export const validRuntimeTerminalStreams = new Set(runtimeTerminalStreams)
export const validLoopStatuses = new Set(['running', 'stopped'])
export type JsonRecord = Record<string, any>
export type RuntimeEventEmitter = (event: JsonRecord) => void
export function now() {
  return new Date().toISOString()
}

export function clone(value) {
  return structuredClone(value)
}

export function truncateChunks(chunks) {
  if (chunks.length > 1000) {
    chunks.splice(0, chunks.length - 1000)
  }
}

export function truncateEvents(events) {
  if (events.length > 2000) {
    const removed = events.length - 2000
    return events.splice(0, removed)
  }
  return []
}

export function truncateActivities(activities) {
  if (activities.length > 500) {
    activities.splice(0, activities.length - 500)
  }
}

export function isObject(value): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function boundedText(value, maxLength = 50000) {
  if (typeof value !== 'string') {
    return ''
  }

  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}\n\n[truncated by Orrery]`
}

export function truncateForLog(value, maxLength = 200) {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

export function diagnostic(type, message, details = {}) {
  return {
    id: randomUUID(),
    type,
    message,
    details,
    ts: now(),
  }
}

export function optionalTrimmedString(value) {
  return nonEmptyString(value) ? value.trim() : undefined
}


export const planCouncilArtifactMaxBytes = 128 * 1024
