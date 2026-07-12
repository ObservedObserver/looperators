export const workflowWakeupKinds = [
  'failure',
  'cap',
  'missing-report',
  'human-change',
  'permission-expansion',
  'workflow-milestone',
] as const

export const workflowWakeupStatuses = [
  'pending',
  'notified',
  'acknowledged',
  'superseded',
] as const

export type WorkflowWakeupKind = (typeof workflowWakeupKinds)[number]
export type WorkflowWakeupStatus = (typeof workflowWakeupStatuses)[number]

export type WorkflowMasterWakeup = {
  wakeupId: string
  workflowId: string
  workflowVersion: number
  scopeId: string
  masterSessionId: string
  kind: WorkflowWakeupKind
  status: WorkflowWakeupStatus
  summary: string
  sourceEventIds: string[]
  sourceSessionIds: string[]
  sourceSubscriptionIds: string[]
  firstObservedAt: string
  lastObservedAt: string
  occurrenceCount: number
  notifiedAt?: string
  notificationTurnId?: string
  notificationAttempts?: number
  lastNotificationInterruptedAt?: string
  acknowledgedAt?: string
  acknowledgedBy?: { kind: 'master' | 'human' | 'runtime'; ref?: string }
  acknowledgmentReason?: string
}

export function workflowWakeupCoalesceKey(
  wakeup: Pick<WorkflowMasterWakeup, 'workflowId' | 'workflowVersion' | 'kind' | 'status'>,
) {
  return wakeup.status === 'pending'
    ? `${wakeup.workflowId}:v${wakeup.workflowVersion}:${wakeup.kind}`
    : undefined
}

export function workflowWakeupPrompt(wakeup: WorkflowMasterWakeup) {
  return [
    `Workflow governance wakeup ${wakeup.wakeupId}.`,
    `Workflow ${wakeup.workflowId} v${wakeup.workflowVersion} needs judgment: ${wakeup.kind}.`,
    wakeup.summary,
    wakeup.occurrenceCount > 1
      ? `${wakeup.occurrenceCount} related facts were coalesced into this wakeup.`
      : undefined,
    'Inspect the current Scope and Workflow before acting. Mechanical turn routing remains owned by the Kernel.',
    wakeup.kind === 'workflow-milestone'
      ? 'If this is a Plan Council phase explicitly delegated to you, use advance_plan_council with the product Council workflow id named in the milestone; this is phase advancement, not a topology Patch.'
      : undefined,
    'If the plan must change, propose a versioned Workflow Patch with this wakeup id; do not mutate raw graph resources.',
    'If no plan change is needed, acknowledge this wakeup with a concise reason.',
  ].filter(Boolean).join('\n')
}
