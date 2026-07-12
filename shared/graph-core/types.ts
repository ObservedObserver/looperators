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
  // L1 time-based trigger: matches `external.timer` ticks appended by the
  // runtime's timer source for exactly this subscription. Only valid with a
  // timer source (and vice versa); the runtime enforces the pairing and that
  // exactly one of the two forms is present: an interval (`everySeconds`) or
  // a wall-clock daily time (`dailyAt: 'HH:MM'`, runtime-host local time).
  | { on: 'schedule'; everySeconds?: number; dailyAt?: string }
  // L2 external trigger: matches `external.<topic>` facts appended by the
  // runtime's ingestion choke point on behalf of a registered source. Which
  // source the fact came from is identity (payload.sourceId), checked in
  // evaluate() against the subscription's external SourceRef — like timer
  // ticks. `topic` narrows by fact name, `match` by flat string-equality on
  // payload fields (same shape as report match, but source-declared keys).
  | { on: 'external'; topic?: string; match?: Record<string, string> }

import type { DynamicCreateAction } from '../dynamic-topology.js'

export type SubscriptionAction =
  | { kind: 'deliver'; topic?: string }
  | { kind: 'deliver+activate'; topic?: string; note?: string }
  | DynamicCreateAction

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
// The clock as a trigger origin (L1). A timer is an event source, not a
// session: it emits `external.timer` facts into the log (§2.4) and can never
// receive an edge, so schedule subscriptions cannot lie on a cycle.
export type TimerRef = { kind: 'timer' }
// A registered external event source as a trigger origin (L2). Like a
// timer, a source is not a session: it only ever appends `external.<topic>`
// facts through the runtime's ingestion choke point and can never receive
// an edge, so external subscriptions cannot lie on a cycle by themselves.
export type ExternalSourceRef = { kind: 'external'; sourceId: string }
export type SourceRef = NodeRef | ClusterRef | TimerRef | ExternalSourceRef

export type Subscription = {
  id: SubscriptionId
  source: SourceRef
  on: EventPattern
  target: NodeRef
  action: SubscriptionAction
  executionRef?: {
    workflowId: string
    workflowVersion: number
    runId: string
    phaseId: string
  }
  gate: SubscriptionGate
  concurrency: SubscriptionConcurrency
  stop?: SubscriptionStop
  onStop: SubscriptionOnStop
  state: 'active' | 'stopped'
  firings: number
  // Runtime-authored subscriptions carry this timestamp. Older folded
  // fixtures may omit it, so projections must treat it as optional.
  createdAt?: string
  // Timer subscriptions: ts of the last external.timer tick. Folded from the
  // event log (the log is the source of truth; any snapshot copy is a cache).
  lastTickAt?: string
}

// --- External event sources (L2, kernel doc §2.4) ---

export type ExternalSourceKind = 'script' | 'git' | 'webhook' | 'manual'

// A registered source entity, folded from `source.registered` /
// `source.removed` facts. Sources are explicit registrations — the vetoed
// route ("infer triggers from side effects") stays vetoed: a watcher only
// exists because a registration fact says so, and it only speaks by
// appending explicit `external.<topic>` facts.
export type ExternalSource = {
  id: string
  kind: ExternalSourceKind
  // Fact name this source emits under: events are `external.<topic>`.
  // Slug, validated at registration; 'timer' is reserved for L1.
  topic: string
  label?: string
  // Adapter configuration, opaque to the kernel (command/args for script,
  // repo path/refs for git). The runtime interprets it; fold just carries it.
  config: Record<string, any>
  // Source-side sampling (proposal L2 guardrail 1): the ingestion choke
  // point rejects emits arriving sooner than this after the last accepted
  // one. A source parameter, not a subscription operator.
  minIntervalSeconds?: number
  state: 'active' | 'removed'
  // Ingestion anchors, folded from the log like Subscription.lastTickAt
  // (any snapshot copy is a cache; replay recovers them).
  lastEventAt?: string
  lastDedupeKey?: string
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
  // Slot identity: one slot per (subscription, target) pair (§2.4), except
  // queue subscriptions, whose backlog entries carry an ordinal suffix
  // (`…#2`, `…#3`) so they coexist; createdAtSeq orders the backlog.
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
  // Registered external event sources (L2). Removed sources stay as
  // tombstones so stopped edges keep a renderable origin on the canvas.
  sources: Record<string, ExternalSource>
}

export function createEmptyKernelState(): KernelState {
  return {
    lastSeq: 0,
    sessions: {},
    subscriptions: {},
    scopes: {},
    pending: {},
    links: {},
    sources: {},
  }
}

export function pendingSlotKey(subscriptionId: SubscriptionId, target: SessionId) {
  return `${subscriptionId}→${target}`
}
