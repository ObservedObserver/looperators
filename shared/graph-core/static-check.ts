// Static safety check over the active intent graph (kernel doc §6.4).
//
// Rule: on the graph whose edges are active subscriptions with an
// activating action (deliver-only edges do not participate — they never
// activate anyone), every directed cycle must contain at least one edge
// with stop ≠ ∅ or gate ≠ auto. Additionally, every subscription that
// lies on any cycle gets a default maxFirings guardrail regardless of
// gate. Permanent listeners (acyclic, no until) are legal; unguarded
// loops are not.

import type { KernelState, Subscription } from './types.js'

export const defaultCycleMaxFirings = 6

export type IntentEdge = {
  subscription: Subscription
  from: string
  to: string
}

export function nodeKeyOfSession(sessionId: string) {
  return `session:${sessionId}`
}

function hasStopCondition(subscription: Subscription): boolean {
  const stop = subscription.stop
  if (!stop) {
    return false
  }
  return (
    stop.whenReport !== undefined ||
    stop.maxFirings !== undefined ||
    stop.deadline !== undefined
  )
}

function isGuarded(subscription: Subscription): boolean {
  return hasStopCondition(subscription) || subscription.gate !== 'auto'
}

// Expands cluster sources into per-member session edges so that a cycle
// running through a cluster member is not hidden by the ref indirection.
// `includeStopped` is the loop-view variant (L4): a guardrail-stopped ring
// must keep its shape on the canvas, so the projection enumerates over
// stopped edges too, while the safety check only ever sees active ones.
export function intentEdges(
  state: KernelState,
  options?: { includeStopped?: boolean }
): IntentEdge[] {
  const edges: IntentEdge[] = []
  for (const subscription of Object.values(state.subscriptions)) {
    if (subscription.state !== 'active' && !options?.includeStopped) {
      continue
    }
    if (subscription.action.kind === 'deliver') {
      continue
    }
    if (subscription.source.kind === 'timer' || subscription.source.kind === 'external') {
      // Timers and external sources are pure entry points: nothing in the
      // graph can activate a clock or a watcher, so their edges can never
      // lie on a directed cycle. Frequency runaway is bounded at the source
      // (runtime minimum interval for timers, source-side sampling for
      // external emits), and an unbounded listener is legal (§6.4). Cycles
      // among the downstream session edges still hit the checks below.
      continue
    }
    const to = nodeKeyOfSession(subscription.target.sessionId)
    if (subscription.source.kind === 'session') {
      edges.push({
        subscription,
        from: nodeKeyOfSession(subscription.source.sessionId),
        to,
      })
      continue
    }
    const scope = state.scopes[subscription.source.clusterId]
    for (const member of scope?.members ?? []) {
      edges.push({ subscription, from: nodeKeyOfSession(member), to })
    }
  }
  return edges
}

// Tarjan strongly connected components, iterative.
export function stronglyConnectedComponents(
  nodes: Set<string>,
  adjacency: Map<string, string[]>
): Map<string, number> {
  const componentOf = new Map<string, number>()
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let nextIndex = 0
  let nextComponent = 0

  for (const start of nodes) {
    if (index.has(start)) {
      continue
    }
    const work: Array<{ node: string; neighborIndex: number }> = [
      { node: start, neighborIndex: 0 },
    ]
    index.set(start, nextIndex)
    lowLink.set(start, nextIndex)
    nextIndex += 1
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const neighbors = adjacency.get(frame.node) ?? []
      if (frame.neighborIndex < neighbors.length) {
        const neighbor = neighbors[frame.neighborIndex]
        frame.neighborIndex += 1
        if (!index.has(neighbor)) {
          index.set(neighbor, nextIndex)
          lowLink.set(neighbor, nextIndex)
          nextIndex += 1
          stack.push(neighbor)
          onStack.add(neighbor)
          work.push({ node: neighbor, neighborIndex: 0 })
        } else if (onStack.has(neighbor)) {
          lowLink.set(
            frame.node,
            Math.min(lowLink.get(frame.node)!, index.get(neighbor)!)
          )
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        lowLink.set(
          parent.node,
          Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!)
        )
      }
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        while (true) {
          const popped = stack.pop()!
          onStack.delete(popped)
          componentOf.set(popped, nextComponent)
          if (popped === frame.node) {
            break
          }
        }
        nextComponent += 1
      }
    }
  }

  return componentOf
}

export function subgraphHasCycle(nodes: Set<string>, edges: IntentEdge[]): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, [])
    }
    adjacency.get(edge.from)!.push(edge.to)
    // A self-loop is trivially a cycle.
    if (edge.from === edge.to) {
      return true
    }
  }

  const color = new Map<string, 'gray' | 'black'>()
  for (const start of nodes) {
    if (color.has(start)) {
      continue
    }
    const work: Array<{ node: string; neighborIndex: number }> = [
      { node: start, neighborIndex: 0 },
    ]
    color.set(start, 'gray')
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const neighbors = adjacency.get(frame.node) ?? []
      if (frame.neighborIndex < neighbors.length) {
        const neighbor = neighbors[frame.neighborIndex]
        frame.neighborIndex += 1
        const seen = color.get(neighbor)
        if (seen === 'gray') {
          return true
        }
        if (!seen && nodes.has(neighbor)) {
          color.set(neighbor, 'gray')
          work.push({ node: neighbor, neighborIndex: 0 })
        }
        continue
      }
      color.set(frame.node, 'black')
      work.pop()
    }
  }
  return false
}

export type StaticCheckViolation = {
  // Session node keys of the offending strongly connected component.
  nodes: string[]
  // Exactly the unguarded subscriptions lying on some all-unguarded cycle
  // (suitable for precise canvas highlighting).
  subscriptionIds: string[]
}

export type StaticCheckResult = {
  ok: boolean
  violations: StaticCheckViolation[]
  // Every subscription lying on any cycle — these must carry the default
  // maxFirings guardrail regardless of gate.
  cyclicSubscriptionIds: string[]
  // The cyclic subscriptions currently missing maxFirings; callers apply
  // defaultCycleMaxFirings to them (or warn on the canvas).
  needsDefaultMaxFirings: string[]
}

export function staticCheck(state: KernelState): StaticCheckResult {
  const edges = intentEdges(state)
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

  // An edge lies on a cycle iff both endpoints share an SCC and that SCC is
  // cyclic (has more than one node, or a self-loop).
  const componentSizes = new Map<number, number>()
  for (const component of componentOf.values()) {
    componentSizes.set(component, (componentSizes.get(component) ?? 0) + 1)
  }
  const cyclicEdges = edges.filter((edge) => {
    const from = componentOf.get(edge.from)
    const to = componentOf.get(edge.to)
    if (from === undefined || from !== to) {
      return false
    }
    return (componentSizes.get(from) ?? 0) > 1 || edge.from === edge.to
  })

  const cyclicSubscriptionIds = [
    ...new Set(cyclicEdges.map((edge) => edge.subscription.id)),
  ]

  // Violation check per cyclic SCC: if the unguarded edges alone still form
  // a cycle, there exists a directed cycle with no stop and no gate — the
  // exact condition §6.4 forbids. Attribution is precise: only the edges
  // that actually lie on some all-unguarded cycle are reported (an SCC of
  // the unguarded subgraph), not every unguarded edge in the component.
  const violations: StaticCheckViolation[] = []
  const componentsChecked = new Set<number>()
  for (const edge of cyclicEdges) {
    const component = componentOf.get(edge.from)!
    if (componentsChecked.has(component)) {
      continue
    }
    componentsChecked.add(component)
    const componentNodes = new Set(
      [...nodes].filter((node) => componentOf.get(node) === component)
    )
    const unguarded = cyclicEdges.filter(
      (candidate) =>
        componentOf.get(candidate.from) === component &&
        !isGuarded(candidate.subscription)
    )
    if (subgraphHasCycle(componentNodes, unguarded)) {
      const unguardedAdjacency = new Map<string, string[]>()
      for (const candidate of unguarded) {
        if (!unguardedAdjacency.has(candidate.from)) {
          unguardedAdjacency.set(candidate.from, [])
        }
        unguardedAdjacency.get(candidate.from)!.push(candidate.to)
      }
      const subComponentOf = stronglyConnectedComponents(
        componentNodes,
        unguardedAdjacency
      )
      const subComponentSizes = new Map<number, number>()
      for (const subComponent of subComponentOf.values()) {
        subComponentSizes.set(
          subComponent,
          (subComponentSizes.get(subComponent) ?? 0) + 1
        )
      }
      const offending = unguarded.filter((candidate) => {
        const from = subComponentOf.get(candidate.from)
        const to = subComponentOf.get(candidate.to)
        if (from === undefined || from !== to) {
          return false
        }
        return (
          (subComponentSizes.get(from) ?? 0) > 1 || candidate.from === candidate.to
        )
      })
      violations.push({
        nodes: [...componentNodes].sort(),
        subscriptionIds: [
          ...new Set(offending.map((candidate) => candidate.subscription.id)),
        ],
      })
    }
  }

  const needsDefaultMaxFirings = cyclicSubscriptionIds.filter((id) => {
    const subscription = state.subscriptions[id]
    return subscription?.stop?.maxFirings === undefined
  })

  return {
    ok: violations.length === 0,
    violations,
    cyclicSubscriptionIds,
    needsDefaultMaxFirings,
  }
}
