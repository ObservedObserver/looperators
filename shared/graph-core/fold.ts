// State = fold(Log): everything "already happened" on the graph is a pure
// fold of the append-only event log (kernel doc §2.1). The fold must be
// deterministic — replaying the same log yields a byte-identical state,
// because nondeterministic inputs (LLM gate decisions) are themselves
// logged events.

import {
  createEmptyKernelState,
  pendingSlotKey,
  type GraphEvent,
  type KernelState,
  type KernelSession,
  type Subscription,
} from './types.js'

function ensureSession(state: KernelState, sessionId: string): KernelSession {
  const existing = state.sessions[sessionId]
  if (existing) {
    return existing
  }
  const created: KernelSession = {
    sessionId,
    status: 'pending',
    frozen: false,
    archived: false,
  }
  state.sessions[sessionId] = created
  return created
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Applies one event to the state, mutating in place. Exported for
// incremental folding; use fold() for whole-log replays.
export function applyEvent(state: KernelState, event: GraphEvent): KernelState {
  state.lastSeq = event.seq
  const payload = event.payload ?? {}

  switch (event.type) {
    case 'session.created': {
      const sessionId = asString(payload.sessionId)
      if (!sessionId) {
        break
      }
      const session = ensureSession(state, sessionId)
      // Creation immediately starts the first turn in the current runtime.
      session.status = 'running'
      session.createdBy = asString(payload.sourceSessionId)
      break
    }
    case 'session.resumed': {
      const sessionId = asString(payload.sessionId)
      if (!sessionId) {
        break
      }
      ensureSession(state, sessionId).status = 'running'
      break
    }
    case 'session.finished': {
      const sessionId = asString(payload.sessionId)
      if (!sessionId) {
        break
      }
      ensureSession(state, sessionId).status = 'idle'
      break
    }
    case 'session.failed': {
      const sessionId = asString(payload.sessionId)
      if (!sessionId) {
        break
      }
      ensureSession(state, sessionId).status = 'failed'
      break
    }
    case 'session.killed': {
      const sessionId = asString(payload.sessionId)
      if (!sessionId) {
        break
      }
      ensureSession(state, sessionId).status = 'killed'
      break
    }
    case 'session.archived': {
      const sessionId = asString(payload.sessionId)
      if (!sessionId) {
        break
      }
      ensureSession(state, sessionId).archived = payload.archived !== false
      break
    }
    case 'freeze.applied': {
      const targets = Array.isArray(payload.targetSessionIds)
        ? payload.targetSessionIds.filter((id) => typeof id === 'string')
        : []
      for (const sessionId of targets) {
        const session = ensureSession(state, sessionId)
        session.frozen = true
        session.freezeReason = event.reason
      }
      break
    }
    case 'freeze.lifted': {
      const targets = Array.isArray(payload.targetSessionIds)
        ? payload.targetSessionIds.filter((id) => typeof id === 'string')
        : []
      for (const sessionId of targets) {
        const session = ensureSession(state, sessionId)
        session.frozen = false
        session.freezeReason = undefined
      }
      break
    }
    case 'scope.upserted': {
      const scopeId = asString(payload.scopeId) ?? asString(payload.clusterId)
      if (!scopeId) {
        break
      }
      const rawMembers = Array.isArray(payload.members)
        ? payload.members.filter((id) => typeof id === 'string')
        : Array.isArray(payload.nodeIds)
          ? payload.nodeIds.filter((id) => typeof id === 'string')
          : []
      // A previously assigned master survives an upsert (role.assigned is
      // the only fact that changes it), and the master is never a member:
      // re-drawing a cluster box around the master node must not make
      // cluster-source subscriptions match the master's own events.
      const masterSessionId =
        state.scopes[scopeId]?.masterSessionId ?? asString(payload.masterSessionId)
      state.scopes[scopeId] = {
        scopeId,
        kind: payload.kind === 'graph' ? 'graph' : 'cluster',
        parentId: asString(payload.parentId),
        members: rawMembers.filter((id) => id !== masterSessionId),
        masterSessionId,
      }
      break
    }
    case 'role.assigned': {
      const scopeId = asString(payload.scopeId) ?? asString(payload.clusterId)
      const masterSessionId = asString(payload.masterSessionId)
      if (!scopeId || !masterSessionId) {
        break
      }
      const scope = state.scopes[scopeId]
      if (scope) {
        scope.masterSessionId = masterSessionId
        scope.members = scope.members.filter((id) => id !== masterSessionId)
      } else {
        state.scopes[scopeId] = {
          scopeId,
          kind: 'cluster',
          parentId: undefined,
          members: [],
          masterSessionId,
        }
      }
      break
    }
    case 'subscription.authored': {
      const subscription = payload.subscription as Subscription | undefined
      if (!subscription || typeof subscription.id !== 'string') {
        break
      }
      state.subscriptions[subscription.id] = {
        ...subscription,
        state: 'active',
        firings: Number(subscription.firings) || 0,
      }
      break
    }
    case 'subscription.stopped': {
      const subscriptionId = asString(payload.subscriptionId)
      const subscription = subscriptionId
        ? state.subscriptions[subscriptionId]
        : undefined
      if (subscription) {
        subscription.state = 'stopped'
      }
      break
    }
    case 'activation.pending': {
      const subscriptionId = asString(payload.subscriptionId)
      const target = asString(payload.target)
      if (!subscriptionId || !target) {
        break
      }
      const slotKey = pendingSlotKey(subscriptionId, target)
      state.pending[slotKey] = {
        slotKey,
        subscriptionId,
        target,
        triggerEventId: asString(payload.triggerEventId) ?? event.causeId ?? event.id,
        status: 'pending',
        createdAtSeq: event.seq,
      }
      break
    }
    case 'activation.approved': {
      const slotKey = slotKeyFromPayload(payload)
      const slot = slotKey ? state.pending[slotKey] : undefined
      if (slot) {
        slot.status = 'approved'
      }
      break
    }
    case 'activation.denied':
    case 'activation.superseded': {
      // Terminal for the slot: it frees up for the next matching event.
      const slotKey = slotKeyFromPayload(payload)
      if (slotKey) {
        delete state.pending[slotKey]
      }
      break
    }
    case 'activated': {
      const slotKey = slotKeyFromPayload(payload)
      if (slotKey) {
        delete state.pending[slotKey]
      }
      const subscriptionId = asString(payload.subscriptionId)
      const subscription = subscriptionId
        ? state.subscriptions[subscriptionId]
        : undefined
      if (subscription) {
        // Iteration counting is defined as firings of the designated
        // subscription (§6.2); a firing is an executed activation.
        subscription.firings += 1
      }
      break
    }
    case 'delivered': {
      // A delivery executed by a deliver-only subscription counts as one
      // firing of that subscription (data-plane edges fire too, §6.2).
      // deliver+activate subscriptions count on `activated` instead — the
      // combined action emits both events but must fire exactly once.
      const subscriptionId = asString(payload.subscriptionId)
      const subscription = subscriptionId
        ? state.subscriptions[subscriptionId]
        : undefined
      if (subscription && subscription.action.kind === 'deliver') {
        subscription.firings += 1
      }
      break
    }
    case 'edge.linked': {
      const edgeId = asString(payload.edgeId)
      const source = asString(payload.source)
      const target = asString(payload.target)
      if (!edgeId || !source || !target) {
        break
      }
      state.links[edgeId] = {
        edgeId,
        source,
        target,
        label: asString(payload.label),
      }
      break
    }
    case 'edge.removed': {
      const edgeId = asString(payload.edgeId)
      if (edgeId) {
        delete state.links[edgeId]
      }
      break
    }
    default:
      // Unknown/irrelevant event types fold to a no-op by design: the log
      // may carry facts (interaction.*, storage.*, loop.* pre-G3) that the
      // kernel state does not project.
      break
  }

  return state
}

function slotKeyFromPayload(payload: Record<string, any>): string | undefined {
  const explicit = asString(payload.slotKey)
  if (explicit) {
    return explicit
  }
  const subscriptionId = asString(payload.subscriptionId)
  const target = asString(payload.target)
  return subscriptionId && target ? pendingSlotKey(subscriptionId, target) : undefined
}

export function fold(events: GraphEvent[], base?: KernelState): KernelState {
  const state = base ?? createEmptyKernelState()
  for (const event of events) {
    applyEvent(state, event)
  }
  return state
}
