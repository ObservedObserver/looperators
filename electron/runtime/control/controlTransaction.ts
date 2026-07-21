import type { KernelActor } from '../../../shared/graph-core/index.js'
import type { ChannelDeliveryEntry } from '../contextChannel.js'
import type { KernelEventInput } from '../kernelStore.js'
import type { JsonRecord } from '../runtimeCommon.js'

export type PostCommitEffect = {
  label: string
  run: () => void
}

// The in-memory unit of work surrounding one durable KernelStore commit.
// Domain handlers may append facts, broadcasts, durable outbox effects, and
// process-local post-commit effects, but only CommandExecutor closes the unit.
export type ControlTransaction = {
  commandId: string
  idempotencyKey?: string
  kind: string
  actor: KernelActor
  causeId?: string
  expectedVersion?: number
  events: KernelEventInput[]
  broadcasts: JsonRecord[]
  channelCheckpoints: Map<string, ChannelDeliveryEntry[]>
  runSessionIdsBefore: Set<string>
  deploymentFinalizations: Array<{
    deploymentId: string
    stage: string
    status: string
    journal?: JsonRecord
  }>
  outboxEffects: Array<{
    effectId: string
    kind: string
    payload?: JsonRecord
  }>
  postCommitEffects: PostCommitEffect[]
  workflowDeploymentIds: Set<string>
  automaticDeploymentId?: string
  baseEventSeq: number
  closed: boolean
}
