export type ExecutionEnvelope = {
  workflowId: string
  workflowVersion: number
  runId: string
  phaseId: string
  activationId: string
  attempt: number
  correlationKey: string
}

export function executionCorrelationKey(input: {
  workflowId: string
  workflowVersion: number
  runId: string
  phaseId: string
  generation?: number
}) {
  return [
    input.workflowId,
    `v${input.workflowVersion}`,
    input.runId,
    input.phaseId,
    `g${input.generation ?? 1}`,
  ].join(':')
}

export function validateExecutionEnvelope(value: unknown): value is ExecutionEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return ['workflowId', 'runId', 'phaseId', 'activationId', 'correlationKey']
    .every((key) => typeof envelope[key] === 'string' && envelope[key] !== '') &&
    Number.isSafeInteger(envelope.workflowVersion) && Number(envelope.workflowVersion) > 0 &&
    Number.isSafeInteger(envelope.attempt) && Number(envelope.attempt) > 0
}
