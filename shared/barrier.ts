import type { ExecutionEnvelope } from './execution-envelope.js'

export const barrierModes = ['all', 'any', 'quorum'] as const
export const barrierStatuses = ['pending', 'released', 'timed-out', 'cancelled'] as const

export type BarrierMode = (typeof barrierModes)[number]
export type BarrierStatus = (typeof barrierStatuses)[number]

export type BarrierArrival = {
  participantKey: string
  attempt: number
  eventId: string
  arrivedAt: string
  envelope: ExecutionEnvelope
}

export type WorkflowBarrier = {
  barrierId: string
  workflowId: string
  workflowVersion: number
  runId: string
  phaseId: string
  correlationKey: string
  mode: BarrierMode
  expectedParticipantKeys: string[]
  quorum?: number
  status: BarrierStatus
  arrivals: Record<string, BarrierArrival>
  createdAt: string
  deadline?: string
  releasedAt?: string
  releasedEventId?: string
  timedOutAt?: string
  cancelledAt?: string
  terminalReason?: string
}

export function barrierRequiredCount(barrier: Pick<WorkflowBarrier, 'mode' | 'expectedParticipantKeys' | 'quorum'>) {
  if (barrier.mode === 'any') return 1
  if (barrier.mode === 'all') return barrier.expectedParticipantKeys.length
  return barrier.quorum ?? barrier.expectedParticipantKeys.length
}

export function barrierIsSatisfied(barrier: WorkflowBarrier) {
  return Object.keys(barrier.arrivals).length >= barrierRequiredCount(barrier)
}
