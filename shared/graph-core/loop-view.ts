// Loop view projection (proposal L4): give a ring a face.
//
// Pure rendering-side derivation, no new storage objects. A "loop" is a
// cyclic strongly connected component of the intent graph (activating
// subscriptions only, cluster sources expanded per member — the same edge
// enumeration the static safety check uses, §6.4). The projection includes
// stopped subscriptions on purpose: a guardrail-stopped ring ("6/6 ·
// stopped") is exactly the state the badge exists to explain, so stopping
// must not dissolve the ring's shape.
//
// Lap counting: laps = firings of the ring's designated subscription (the
// one with the most firings; ties break to the smallest id). Every ring
// activation is a "hop"; consecutive designated-subscription activations
// delimit one lap window, so the timeline's lap count always matches the
// badge.

import type {
  GraphEvent,
  KernelActor,
  KernelState,
  Subscription,
  SubscriptionId,
} from './types.js'
import {
  intentEdges,
  nodeKeyOfSession,
  stronglyConnectedComponents,
  subgraphHasCycle,
  type IntentEdge,
} from './static-check.js'

export type LoopViewStatus = 'spinning' | 'waiting-gate' | 'frozen' | 'stopped' | 'idle'

export type LoopView = {
  // Stable identity: sorted member session ids joined with '+'. Membership
  // change means a different ring, so identity following membership is the
  // honest choice.
  loopId: string
  memberSessionIds: string[]
  subscriptionIds: SubscriptionId[]
  // The subscription whose firings count laps (max firings, ties → smallest
  // id) — also the timeline's lap delimiter.
  designatedSubscriptionId: SubscriptionId
  lapCount: number
  // min(stop.maxFirings) across ring subscriptions that define one; on-cycle
  // subscriptions always carry the default guardrail, so this is normally set.
  lapCap?: number
  status: LoopViewStatus
  statusDetail?: string
  stopSummary?: string
}

function ringStopSummary(subscriptions: Subscription[], lapCap?: number) {
  const verdicts = [
    ...new Set(
      subscriptions
        .map((subscription) => subscription.stop?.whenReport?.verdict)
        .filter((verdict): verdict is string => Boolean(verdict))
    ),
  ]
  const deadlines = subscriptions
    .map((subscription) => subscription.stop?.deadline)
    .filter((deadline): deadline is string => Boolean(deadline))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
  const parts = [
    ...verdicts.map((verdict) => `until ${verdict}`),
    lapCap !== undefined ? `max ${lapCap}` : undefined,
    deadlines.length > 0 ? `until ${deadlines[0]}` : undefined,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function ringStatus(
  state: KernelState,
  memberSessionIds: string[],
  subscriptions: Subscription[],
  edges: IntentEdge[]
): { status: LoopViewStatus; statusDetail?: string } {
  const activeEdges = edges.filter((edge) => edge.subscription.state === 'active')
  const memberSet = new Set(memberSessionIds.map(nodeKeyOfSession))
  // The ring is stopped when its active edges alone can no longer complete a
  // cycle — one stopped edge on a simple ring is enough to end the loop even
  // though other edges stay active as plain listeners.
  if (!subgraphHasCycle(memberSet, activeEdges)) {
    return { status: 'stopped' }
  }
  const frozenMember = memberSessionIds.find(
    (sessionId) => state.sessions[sessionId]?.frozen
  )
  if (frozenMember) {
    const reason = state.sessions[frozenMember]?.freezeReason
    return { status: 'frozen', statusDetail: reason }
  }
  const subscriptionIds = new Set(subscriptions.map((subscription) => subscription.id))
  const slots = Object.values(state.pending).filter((slot) =>
    subscriptionIds.has(slot.subscriptionId)
  )
  const memberRunning = memberSessionIds.some((sessionId) => {
    const status = state.sessions[sessionId]?.status
    return status === 'running' || status === 'pending'
  })
  if (memberRunning || slots.some((slot) => slot.status === 'approved')) {
    return { status: 'spinning' }
  }
  const waiting = slots.find((slot) => slot.status === 'pending')
  if (waiting) {
    const gate = state.subscriptions[waiting.subscriptionId]?.gate
    return {
      status: 'waiting-gate',
      statusDetail: gate ? `gate ${gate}` : undefined,
    }
  }
  return { status: 'idle' }
}

// Enumerates the cyclic SCCs of the intent graph (stopped edges included)
// as loop views, sorted by loopId for stable rendering.
export function loopsOf(state: KernelState): LoopView[] {
  const edges = intentEdges(state, { includeStopped: true })
  const nodes = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    nodes.add(edge.from)
    nodes.add(edge.to)
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, [])
    }
    adjacency.get(edge.from)!.push(edge.to)
  }
  const componentOf = stronglyConnectedComponents(nodes, adjacency)
  const componentSizes = new Map<number, number>()
  for (const component of componentOf.values()) {
    componentSizes.set(component, (componentSizes.get(component) ?? 0) + 1)
  }

  const edgesByComponent = new Map<number, IntentEdge[]>()
  for (const edge of edges) {
    const from = componentOf.get(edge.from)
    const to = componentOf.get(edge.to)
    if (from === undefined || from !== to) {
      continue
    }
    if ((componentSizes.get(from) ?? 0) <= 1 && edge.from !== edge.to) {
      continue
    }
    if (!edgesByComponent.has(from)) {
      edgesByComponent.set(from, [])
    }
    edgesByComponent.get(from)!.push(edge)
  }

  const loops: LoopView[] = []
  for (const componentEdges of edgesByComponent.values()) {
    const memberSessionIds = [
      ...new Set(
        componentEdges.flatMap((edge) => [edge.from, edge.to])
      ),
    ]
      .map((key) => key.replace(/^session:/, ''))
      .sort()
    const subscriptions = [
      ...new Map(
        componentEdges.map((edge) => [edge.subscription.id, edge.subscription])
      ).values(),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const designated = subscriptions.reduce((best, candidate) =>
      candidate.firings > best.firings ? candidate : best
    )
    const caps = subscriptions
      .map((subscription) => subscription.stop?.maxFirings)
      .filter((cap): cap is number => cap !== undefined)
    const lapCap = caps.length > 0 ? Math.min(...caps) : undefined
    const { status, statusDetail } = ringStatus(
      state,
      memberSessionIds,
      subscriptions,
      componentEdges
    )
    loops.push({
      loopId: memberSessionIds.join('+'),
      memberSessionIds,
      subscriptionIds: subscriptions.map((subscription) => subscription.id),
      designatedSubscriptionId: designated.id,
      lapCount: designated.firings,
      lapCap,
      status,
      statusDetail,
      stopSummary: ringStopSummary(subscriptions, lapCap),
    })
  }
  return loops.sort((left, right) => left.loopId.localeCompare(right.loopId))
}

// --- Per-lap timeline (proposal L4: "one line per lap: who triggered it,
// who let it through the gate, why, and what report came out") ---

export type LoopHop = {
  activatedEventId: string
  ts: string
  subscriptionId: SubscriptionId
  target: string
  // The fact that matched the subscription (external.timer, report.received,
  // session.finished, ...). May be absent if the log tail was truncated.
  trigger?: {
    eventId: string
    type?: string
    ts?: string
    reason?: string
    sourceSessionId?: string
  }
  // The gate decision that let this hop through (auto gates record the rule
  // actor; master/human gates record who approved and their note).
  gate?: { actor: KernelActor; reason?: string; ts: string }
  outcome?: { type: 'finished' | 'failed'; ts: string }
  reports: Array<{
    reportId?: string
    from?: string
    verdict?: string
    summary?: string
    ts: string
  }>
}

export type LoopLap = {
  index: number
  startTs: string
  hops: LoopHop[]
}

export type LoopTimeline = {
  loopId: string
  laps: LoopLap[]
  // Firing attempts the ring refused: denied at a gate, dropped, superseded.
  refusals: Array<{
    type: 'denied' | 'dropped' | 'superseded'
    subscriptionId: SubscriptionId
    ts: string
    reason?: string
    actor: KernelActor
  }>
  // Why edges stopped (guardrail, whenReport, deadline, manual stop).
  stops: Array<{
    type: string
    subscriptionId: SubscriptionId
    ts: string
    reason?: string
  }>
}

function payloadString(event: GraphEvent, key: string): string | undefined {
  const value = (event.payload ?? {})[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function loopTimelineOf(
  state: KernelState,
  events: GraphEvent[],
  loop: Pick<
    LoopView,
    'loopId' | 'memberSessionIds' | 'subscriptionIds' | 'designatedSubscriptionId'
  >
): LoopTimeline {
  const subscriptionIds = new Set(loop.subscriptionIds)
  const members = new Set(loop.memberSessionIds)
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const byId = new Map(ordered.map((event) => [event.id, event]))

  const hops: Array<LoopHop & { seq: number }> = []
  const hopByActivatedId = new Map<string, LoopHop>()
  const refusals: LoopTimeline['refusals'] = []
  const stops: LoopTimeline['stops'] = []
  // Latest approval per slot as the scan advances. Slot keys repeat per lap
  // (coalesce holds one slot per edge), so at the moment an `activated` fact
  // is scanned, the map holds exactly the approval that released it.
  const lastApprovedBySlot = new Map<string, GraphEvent>()

  for (const event of ordered) {
    const subscriptionId = payloadString(event, 'subscriptionId')

    if (event.type === 'activation.approved') {
      const slotKey = payloadString(event, 'slotKey')
      if (slotKey) {
        lastApprovedBySlot.set(slotKey, event)
      }
      continue
    }

    if (event.type === 'activated' && subscriptionId && subscriptionIds.has(subscriptionId)) {
      const trigger = event.causeId ? byId.get(event.causeId) : undefined
      const slotKey = payloadString(event, 'slotKey')
      const approval = slotKey ? lastApprovedBySlot.get(slotKey) : undefined
      const gate: LoopHop['gate'] = approval
        ? { actor: approval.actor, reason: approval.reason, ts: approval.ts }
        : undefined
      hops.push({
        seq: event.seq,
        activatedEventId: event.id,
        ts: event.ts,
        subscriptionId,
        target: payloadString(event, 'target') ?? payloadString(event, 'sessionId') ?? '',
        trigger: event.causeId
          ? {
              eventId: event.causeId,
              type: trigger?.type,
              ts: trigger?.ts,
              reason: trigger?.reason,
              sourceSessionId: trigger
                ? payloadString(trigger, 'from') ?? payloadString(trigger, 'sessionId')
                : undefined,
            }
          : undefined,
        gate,
        outcome: undefined,
        reports: [],
      })
      hopByActivatedId.set(event.id, hops[hops.length - 1])
      continue
    }

    const currentHop = hops.length > 0 ? hops[hops.length - 1] : undefined

    if (event.type === 'session.finished' || event.type === 'session.failed') {
      // Prefer the causal chain (provider facts carry causeId of the
      // activation). Without one, close the latest still-open hop of the
      // same target — not just the newest hop overall, so an interleaved
      // hop on another target never orphans the terminal fact.
      let resolved = event.causeId ? hopByActivatedId.get(event.causeId) : undefined
      if (!resolved) {
        const sessionId = payloadString(event, 'sessionId')
        if (sessionId) {
          for (let index = hops.length - 1; index >= 0; index -= 1) {
            if (hops[index].target === sessionId && !hops[index].outcome) {
              resolved = hops[index]
              break
            }
          }
        }
      }
      if (resolved && !resolved.outcome) {
        resolved.outcome = {
          type: event.type === 'session.finished' ? 'finished' : 'failed',
          ts: event.ts,
        }
      }
      continue
    }

    if (event.type === 'report.received') {
      const from = payloadString(event, 'from')
      if (from && members.has(from) && currentHop) {
        currentHop.reports.push({
          reportId: payloadString(event, 'reportId'),
          from,
          verdict: payloadString(event, 'verdict'),
          summary: payloadString(event, 'summary'),
          ts: event.ts,
        })
      }
      continue
    }

    if (
      (event.type === 'activation.denied' ||
        event.type === 'activation.dropped' ||
        event.type === 'activation.superseded') &&
      subscriptionId &&
      subscriptionIds.has(subscriptionId)
    ) {
      refusals.push({
        type: event.type.replace('activation.', '') as 'denied' | 'dropped' | 'superseded',
        subscriptionId,
        ts: event.ts,
        reason: event.reason,
        actor: event.actor,
      })
      continue
    }

    if (
      (event.type === 'subscription.stopped' || event.type === 'subscription.guarded') &&
      subscriptionId &&
      subscriptionIds.has(subscriptionId)
    ) {
      stops.push({
        type: event.type,
        subscriptionId,
        ts: event.ts,
        reason: event.reason,
      })
    }
  }

  // Lap windows: split hops at the designated subscription's activations.
  // Hops before the first designated anchor belong to lap 1 (the warm-up
  // half of the first revolution).
  const laps: LoopLap[] = []
  for (const hop of hops) {
    const { seq: _seq, ...visible } = hop
    const startsLap = hop.subscriptionId === loop.designatedSubscriptionId
    if (laps.length === 0 || (startsLap && laps[laps.length - 1].hops.some((existing) => existing.subscriptionId === loop.designatedSubscriptionId))) {
      laps.push({ index: laps.length + 1, startTs: hop.ts, hops: [visible] })
    } else {
      laps[laps.length - 1].hops.push(visible)
    }
  }

  return { loopId: loop.loopId, laps, refusals, stops }
}
