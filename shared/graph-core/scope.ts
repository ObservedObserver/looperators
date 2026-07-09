// Governance routing over the scope forest (kernel doc §2.3).
//
// R1: a subscription's governing master = the master of the lowest common
//     scope (LCA) of source and target; if that scope has no master, walk
//     up; if nothing has one, governance falls to the human/UI.
// R2: a report routes to the reporter's nearest ancestor scope that has a
//     master; otherwise to the human/UI.
//
// By construction, an intra-cluster subscription can never route to the
// global master — "global master only coordinates at cluster boundaries"
// becomes a theorem instead of a guideline.

import type {
  KernelState,
  Scope,
  ScopeId,
  SessionId,
  SourceRef,
  Subscription,
} from './types.js'

// The implicit whole-graph scope: parent of every root scope.
export const graphScopeId = 'scope:graph'

function scopesOf(state: KernelState): Scope[] {
  return Object.values(state.scopes)
}

// A session's scope chain from innermost to the implicit graph root.
export function scopeChain(state: KernelState, sessionId: SessionId): ScopeId[] {
  const direct = scopesOf(state).find(
    (scope) =>
      scope.members.includes(sessionId) || scope.masterSessionId === sessionId
  )
  const chain: ScopeId[] = []
  let current: Scope | undefined = direct
  const seen = new Set<ScopeId>()
  while (current && !seen.has(current.scopeId)) {
    seen.add(current.scopeId)
    chain.push(current.scopeId)
    current = current.parentId ? state.scopes[current.parentId] : undefined
  }
  chain.push(graphScopeId)
  return chain
}

export function lowestCommonScope(
  state: KernelState,
  left: SessionId,
  right: SessionId
): ScopeId {
  const leftChain = scopeChain(state, left)
  const rightChain = new Set(scopeChain(state, right))
  for (const scopeId of leftChain) {
    if (rightChain.has(scopeId)) {
      return scopeId
    }
  }
  return graphScopeId
}

function masterOfScopeOrAncestors(
  state: KernelState,
  scopeId: ScopeId
): SessionId | undefined {
  let current: Scope | undefined =
    scopeId === graphScopeId ? undefined : state.scopes[scopeId]
  const seen = new Set<ScopeId>()
  while (current && !seen.has(current.scopeId)) {
    seen.add(current.scopeId)
    if (current.masterSessionId) {
      return current.masterSessionId
    }
    current = current.parentId ? state.scopes[current.parentId] : undefined
  }
  // The implicit graph scope has no stored record; a graph-level master
  // would live in a scope with kind 'graph'.
  const graphScope = scopesOf(state).find((scope) => scope.kind === 'graph')
  return graphScope?.masterSessionId
}

function sourceSessionsOf(state: KernelState, source: SourceRef): SessionId[] {
  if (source.kind === 'session') {
    return [source.sessionId]
  }
  if (source.kind === 'timer' || source.kind === 'external') {
    return []
  }
  const scope = state.scopes[source.clusterId]
  return scope ? [...scope.members] : []
}

// R1. Returns the master session that governs this subscription's firings,
// or undefined when governance falls to the human/UI.
export function governingMaster(
  state: KernelState,
  subscription: Subscription
): SessionId | undefined {
  const sources = sourceSessionsOf(state, subscription.source)
  const target = subscription.target.sessionId
  // R1 degenerates for timer and external sources: neither lives in any
  // scope, so the LCA collapses to the target's own chain — its nearest
  // ancestor master.
  if (subscription.source.kind === 'timer' || subscription.source.kind === 'external') {
    return masterOfScopeOrAncestors(state, scopeChain(state, target)[0])
  }
  // For cluster sources, the LCA of the cluster and the target is the same
  // for every member; use the first member (or the cluster scope directly).
  if (subscription.source.kind === 'cluster') {
    const scope = state.scopes[subscription.source.clusterId]
    if (scope) {
      const targetChain = new Set(scopeChain(state, target))
      let current: Scope | undefined = scope
      const seen = new Set<ScopeId>()
      while (current && !seen.has(current.scopeId)) {
        seen.add(current.scopeId)
        if (targetChain.has(current.scopeId)) {
          return masterOfScopeOrAncestors(state, current.scopeId)
        }
        current = current.parentId ? state.scopes[current.parentId] : undefined
      }
      return masterOfScopeOrAncestors(state, graphScopeId)
    }
  }
  const source = sources[0]
  if (!source) {
    return masterOfScopeOrAncestors(state, graphScopeId)
  }
  const lca = lowestCommonScope(state, source, target)
  return masterOfScopeOrAncestors(state, lca)
}

// R2. Where does a report from this session route? The nearest ancestor
// scope with a master; undefined = human/UI. A master's own reports never
// route to itself.
export function reportRoute(
  state: KernelState,
  reporter: SessionId
): SessionId | undefined {
  for (const scopeId of scopeChain(state, reporter)) {
    const master = scopeId === graphScopeId ? undefined : state.scopes[scopeId]?.masterSessionId
    if (master && master !== reporter) {
      return master
    }
  }
  const graphScope = scopesOf(state).find((scope) => scope.kind === 'graph')
  const master = graphScope?.masterSessionId
  return master && master !== reporter ? master : undefined
}
