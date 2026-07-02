// graph-core: pure, IO-free types for the session graph kernel.
// Baseline: design-docs/session-graph-kernel.md §7 (schema drafts).
// This package is the single source of truth for kernel-level shapes;
// the runtime (kernelStore, sessionManager) imports from here.

export type SessionId = string
export type ClusterId = string
export type ScopeId = string
export type SubscriptionId = string
export type EventId = string

export type KernelActorKind =
  | 'human'
  | 'master'
  | 'agent'
  | 'rule'
  | 'provider'
  | 'runtime'

export type KernelActor = {
  kind: KernelActorKind
  // sessionId for master/agent, rule identity (subscriptionId or
  // "loop:<clusterId>" before G3) for rule.
  ref?: string
}

export const kernelActorKinds = new Set<KernelActorKind>([
  'human',
  'master',
  'agent',
  'rule',
  'provider',
  'runtime',
])

// One appended fact. Matches the SQLite `events` row shape from G0.
export type GraphEvent = {
  seq: number
  id: EventId
  ts: string
  type: string
  actor: KernelActor
  causeId?: EventId
  reason?: string
  payload: Record<string, any>
}

// --- Intent layer: subscriptions (kernel doc §7.3) ---

export type EventPattern =
  | { on: 'finished' }
  | { on: 'failed' }
  | { on: 'report'; match?: { type?: string; verdict?: string } }
  // Reserved for G2+: mediated delivery events as trigger sources.
  | { on: 'delivered'; topic?: string }

export type SubscriptionAction =
  | { kind: 'deliver'; topic?: string }
  | { kind: 'deliver+activate'; topic?: string; note?: string }
  // Reserved for a later version; v1 create runs as a one-shot command.
  | { kind: 'create'; agent: string; promptTemplate: string }

export type SubscriptionGate = 'auto' | 'master' | 'human'
export type SubscriptionConcurrency = 'coalesce' | 'queue' | 'drop' | 'interrupt'
export type SubscriptionOnStop = 'freeze-edge' | 'freeze-target' | 'freeze-cluster'

export type SubscriptionStop = {
  // Observed on reports from the edge's participants (source or target).
  whenReport?: { verdict: string }
  // Checked at fire attempts; reaching the cap stops instead of firing.
  maxFirings?: number
  // Any parseable date-time; compared as an instant (Date.parse), so
  // offset-bearing strings are safe. Canonical form is toISOString() UTC.
  deadline?: string
}

export type NodeRef = { kind: 'session'; sessionId: SessionId }
export type ClusterRef = { kind: 'cluster'; clusterId: ClusterId }
export type SourceRef = NodeRef | ClusterRef

export type Subscription = {
  id: SubscriptionId
  source: SourceRef
  on: EventPattern
  target: NodeRef
  action: SubscriptionAction
  gate: SubscriptionGate
  concurrency: SubscriptionConcurrency
  stop?: SubscriptionStop
  onStop: SubscriptionOnStop
  state: 'active' | 'stopped'
  firings: number
}

// --- Governance layer: scope forest (kernel doc §7.4) ---

export type Scope = {
  scopeId: ScopeId
  kind: 'cluster' | 'graph'
  parentId?: ScopeId
  members: SessionId[]
  masterSessionId?: SessionId
}

// --- Folded state (State = fold(Log), kernel doc §2.1) ---

// Kernel-level session status (§5). The provider-plane has finer states;
// the kernel only needs what scheduling decisions depend on.
export type KernelSessionStatus =
  | 'pending'
  | 'running'
  | 'awaiting-input'
  | 'idle'
  | 'failed'
  | 'killed'

export type KernelSession = {
  sessionId: SessionId
  status: KernelSessionStatus
  // Orthogonal flag, not a status (§5): freeze gates inbound activation.
  frozen: boolean
  freezeReason?: string
  archived: boolean
  // Lineage: the session that created this one (spawned-by forest, §3).
  createdBy?: SessionId
}

export type PendingActivation = {
  // Slot identity: one slot per (subscription, target) pair (§2.4).
  slotKey: string
  subscriptionId: SubscriptionId
  target: SessionId
  // The event that matched and produced this pending activation.
  triggerEventId: EventId
  status: 'pending' | 'approved' | 'denied' | 'superseded' | 'activated'
  createdAtSeq: number
}

export type DeclaredLink = {
  edgeId: string
  source: SessionId
  target: SessionId
  label?: string
}

export type KernelState = {
  lastSeq: number
  sessions: Record<SessionId, KernelSession>
  subscriptions: Record<SubscriptionId, Subscription>
  scopes: Record<ScopeId, Scope>
  // Live pending-activation slots keyed by slotKey (only non-terminal ones).
  pending: Record<string, PendingActivation>
  links: Record<string, DeclaredLink>
}

export function createEmptyKernelState(): KernelState {
  return {
    lastSeq: 0,
    sessions: {},
    subscriptions: {},
    scopes: {},
    pending: {},
    links: {},
  }
}

export function pendingSlotKey(subscriptionId: SubscriptionId, target: SessionId) {
  return `${subscriptionId}→${target}`
}
