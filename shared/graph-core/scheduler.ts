// Pure scheduling decisions (kernel doc §2.2, §2.4, §6).
//
// The scheduler is a function of (state, event) → decisions. It performs no
// IO: decisions are data describing what the runtime's command executor
// should do (author activation.pending events, stop subscriptions, ...).
// Stop conditions are evaluated BEFORE pending firings execute (§2.2), so a
// stop and a firing triggered by the same event can never race.

import { governingMaster } from './scope.js'
import {
  pendingSlotKey,
  type EventPattern,
  type GraphEvent,
  type KernelState,
  type SessionId,
  type Subscription,
} from './types.js'

export type SchedulerDecision =
  | {
      kind: 'stop-subscription'
      subscriptionId: string
      onStop: Subscription['onStop']
      reason: string
      triggerEventId: string
    }
  | {
      // Data-plane only (§2.5): deliver-only subscriptions write to the
      // target's channel without activation — no gate, no pending slot, no
      // busy check, and freeze does not block them (§5). Coalescing of
      // deliveries happens in the channel via topic supersession (§4.2).
      kind: 'deliver'
      subscriptionId: string
      target: SessionId
      topic?: string
      triggerEventId: string
    }
  | {
      kind: 'pend-activation'
      subscriptionId: string
      target: SessionId
      action: Subscription['action']
      gate: 'auto' | 'master' | 'human'
      // Set when gate === 'master': the governing master per LCA rule R1.
      // undefined with gate 'master' means governance falls to the human/UI.
      masterSessionId?: SessionId
      triggerEventId: string
      // True when this pend replaces an earlier slot (coalesce supersession).
      supersedes?: string
    }
  | {
      kind: 'drop-firing'
      subscriptionId: string
      reason: string
      triggerEventId: string
    }
  | {
      kind: 'interrupt-target'
      subscriptionId: string
      target: SessionId
      triggerEventId: string
    }

// Which session did this event originate from, for source matching?
export function eventSourceSession(event: GraphEvent): SessionId | undefined {
  const payload = event.payload ?? {}
  if (event.type === 'report.received') {
    return typeof payload.from === 'string' ? payload.from : undefined
  }
  if (event.type === 'delivered') {
    return typeof payload.source === 'string' ? payload.source : undefined
  }
  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined
}

export function matchesPattern(pattern: EventPattern, event: GraphEvent): boolean {
  const payload = event.payload ?? {}
  switch (pattern.on) {
    case 'finished':
      return event.type === 'session.finished'
    case 'failed':
      return event.type === 'session.failed'
    case 'report': {
      if (event.type !== 'report.received') {
        return false
      }
      const match = pattern.match
      if (!match) {
        return true
      }
      if (match.type && payload.reportType !== match.type) {
        return false
      }
      if (match.verdict && payload.verdict !== match.verdict) {
        return false
      }
      return true
    }
    case 'delivered': {
      if (event.type !== 'delivered') {
        return false
      }
      return pattern.topic === undefined || payload.topic === pattern.topic
    }
    case 'schedule':
      // Tick identity (which subscription this tick belongs to) is checked
      // in evaluate(), where the subscription is in scope.
      return event.type === 'external.timer'
    case 'external': {
      // Source identity (which registered source emitted this fact) is
      // checked in evaluate(), like tick identity. Here: fact name and
      // payload-field equality only. Strict string equality on match values
      // by design — sources declare flat string fields for routing.
      if (!event.type.startsWith('external.') || event.type === 'external.timer') {
        return false
      }
      if (pattern.topic !== undefined && event.type !== `external.${pattern.topic}`) {
        return false
      }
      const match = pattern.match
      if (!match) {
        return true
      }
      for (const [key, value] of Object.entries(match)) {
        if (payload[key] !== value) {
          return false
        }
      }
      return true
    }
  }
  return false
}

function sourceMatches(
  state: KernelState,
  subscription: Subscription,
  sourceSession: SessionId | undefined
): boolean {
  if (subscription.source.kind === 'timer' || subscription.source.kind === 'external') {
    // Timer/external relevance is by emit identity, decided in evaluate().
    return false
  }
  if (!sourceSession) {
    return false
  }
  if (subscription.source.kind === 'session') {
    return subscription.source.sessionId === sourceSession
  }
  const scope = state.scopes[subscription.source.clusterId]
  return Boolean(scope?.members.includes(sourceSession))
}

function sourceSessions(state: KernelState, subscription: Subscription): SessionId[] {
  if (subscription.source.kind === 'session') {
    return [subscription.source.sessionId]
  }
  if (subscription.source.kind === 'timer' || subscription.source.kind === 'external') {
    // A clock or an external source is not a session; the edge's only
    // participant is its target (whenReport observation narrows to the
    // target's own verdicts).
    return []
  }
  const scope = state.scopes[subscription.source.clusterId]
  return scope ? scope.members : []
}

// Structured stop predicates the runtime can decide deterministically
// (§6.2: whenReport / maxFirings / deadline). Judgement-type stopping is
// not a predicate — its correct form is gate=master.
//
// Observation scopes differ per condition class:
// - whenReport observes reports from the edge's PARTICIPANTS (source or
//   target) — an unrelated session's "clean" verdict must never stop this
//   edge, but a verdict from either end of the relationship does.
// - deadline observes the passage of time: any event whose ts is past the
//   deadline stops the subscription, regardless of where it came from.
// - maxFirings prevents a firing attempt once persisted/replayed state is
//   already at its cap. The runtime also stops immediately after the action
//   that reaches the cap, so no N+1 event is required for lifecycle cleanup.
function stopReason(
  state: KernelState,
  subscription: Subscription,
  event: GraphEvent,
  matched: boolean
): string | undefined {
  const stop = subscription.stop
  if (!stop) {
    return undefined
  }

  if (stop.deadline && deadlinePassed(stop.deadline, event.ts)) {
    return `Deadline ${stop.deadline} passed.`
  }

  if (
    stop.whenReport &&
    event.type === 'report.received' &&
    (event.payload ?? {}).verdict === stop.whenReport.verdict
  ) {
    const from = eventSourceSession(event)
    const participants = new Set([
      ...sourceSessions(state, subscription),
      subscription.target.sessionId,
    ])
    if (from && participants.has(from)) {
      return `Report verdict ${stop.whenReport.verdict} satisfied the stop condition.`
    }
  }

  if (
    matched &&
    stop.maxFirings !== undefined &&
    subscription.firings >= stop.maxFirings
  ) {
    return `maxFirings=${stop.maxFirings} reached.`
  }

  return undefined
}

// Timestamps in the log are canonical toISOString() UTC; deadlines authored
// elsewhere may carry offsets, so compare as instants, not strings.
function deadlinePassed(deadline: string, eventTs: string): boolean {
  const deadlineMs = Date.parse(deadline)
  const eventMs = Date.parse(eventTs)
  if (Number.isNaN(deadlineMs) || Number.isNaN(eventMs)) {
    return false
  }
  return eventMs >= deadlineMs
}

function targetBusy(state: KernelState, target: SessionId): boolean {
  const status = state.sessions[target]?.status
  return status === 'running' || status === 'pending' || status === 'awaiting-input'
}

// Evaluate one event against all active subscriptions. Decision order per
// subscription: stop first (a stopping subscription never fires on the
// same event), then concurrency policy, then gate routing.
//
// Contract (§2.4 scheduling loop `Log → fold → State → match`): `state` is
// the fold INCLUDING the trigger event — append, fold, then evaluate.
export function evaluate(state: KernelState, event: GraphEvent): SchedulerDecision[] {
  const decisions: SchedulerDecision[] = []

  for (const subscription of Object.values(state.subscriptions)) {
    if (subscription.state !== 'active') {
      continue
    }

    const sourceSession = eventSourceSession(event)
    // Timer edges have no source session; a tick is relevant to exactly the
    // subscription it was appended for (payload.subscriptionId). External
    // edges are relevant to exactly the source that emitted the fact
    // (payload.sourceId) — many subscriptions may listen to one source.
    const relevant =
      subscription.source.kind === 'timer'
        ? (event.payload ?? {}).subscriptionId === subscription.id
        : subscription.source.kind === 'external'
          ? (event.payload ?? {}).sourceId === subscription.source.sourceId
          : sourceMatches(state, subscription, sourceSession)
    const matched = relevant && matchesPattern(subscription.on, event)

    // Stop conditions observe beyond the source (deadline: any event;
    // whenReport: reports from either edge participant), so they are
    // evaluated before — and independently of — source relevance.
    const stop = stopReason(state, subscription, event, matched)
    if (stop) {
      decisions.push({
        kind: 'stop-subscription',
        subscriptionId: subscription.id,
        onStop: subscription.onStop,
        reason: stop,
        triggerEventId: event.id,
      })
      continue
    }

    if (!matched) {
      continue
    }

    const target = subscription.target.sessionId

    if (subscription.action.kind === 'deliver') {
      decisions.push({
        kind: 'deliver',
        subscriptionId: subscription.id,
        target,
        topic: subscription.action.topic,
        triggerEventId: event.id,
      })
      continue
    }

    const slotKey = pendingSlotKey(subscription.id, target)
    const existingSlot = state.pending[slotKey]
    const busy = targetBusy(state, target)

    if (subscription.concurrency === 'drop' && (busy || existingSlot)) {
      decisions.push({
        kind: 'drop-firing',
        subscriptionId: subscription.id,
        reason: busy ? 'Target is busy.' : 'A pending activation already exists.',
        triggerEventId: event.id,
      })
      continue
    }

    if (subscription.concurrency === 'interrupt' && busy) {
      decisions.push({
        kind: 'interrupt-target',
        subscriptionId: subscription.id,
        target,
        triggerEventId: event.id,
      })
    }

    const gate = subscription.gate
    decisions.push({
      kind: 'pend-activation',
      subscriptionId: subscription.id,
      target,
      action: subscription.action,
      gate,
      masterSessionId:
        gate === 'master' ? governingMaster(state, subscription) : undefined,
      triggerEventId: event.id,
      // Coalesce keeps only the latest pending context (§6.1), and
      // interrupt is latest-wins by definition — both supersede an
      // existing slot so the old pending gets a terminal fact instead of
      // being silently overwritten. Queue keeps both; the runtime
      // maintains the ordered backlog for queue subscriptions.
      supersedes:
        subscription.concurrency !== 'queue' && existingSlot
          ? existingSlot.slotKey
          : undefined,
    })
  }

  return decisions
}
