export type CanvasRoutingNode = {
  id: string
  type?: string
  position: { x: number; y: number }
}

export type CanvasRoutingEdge = {
  id: string
  type?: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

type HorizontalSide = 'left' | 'right'

function compareNodePositions(left: CanvasRoutingNode, right: CanvasRoutingNode) {
  return left.position.x - right.position.x || left.position.y - right.position.y || left.id.localeCompare(right.id)
}

function oppositeSide(side: HorizontalSide): HorizontalSide {
  return side === 'left' ? 'right' : 'left'
}

function agentSideToward(source: CanvasRoutingNode, target: CanvasRoutingNode): HorizontalSide {
  return compareNodePositions(source, target) < 0 ? 'right' : 'left'
}

function unorderedPairKey(source: string, target: string) {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`
}

/**
 * Assigns stable left/right ports to runtime Agent edges without changing
 * graph semantics or node positions.
 *
 * A one-way relationship uses facing ports. Reciprocal relationships use two
 * separate same-side channels: the edge from the earlier-positioned Agent
 * uses the right side, and its reverse uses the left side. Keeping the target
 * on the same side as the source is what prevents the two Bezier paths from
 * crossing through each other.
 *
 * Non-Agent endpoints keep their existing handles. This matters for clock,
 * external-source, cluster, and other synthetic nodes that do not expose the
 * Agent node's four named ports.
 */
export function routeRuntimeAgentEdges<TEdge extends CanvasRoutingEdge>(
  edges: readonly TEdge[],
  nodes: readonly CanvasRoutingNode[],
): TEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const directionsByPair = new Map<string, Set<string>>()

  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.source)
    const targetNode = nodeById.get(edge.target)
    if (
      edge.type !== 'readability' ||
      edge.source === edge.target ||
      sourceNode?.type !== 'agent' ||
      targetNode?.type !== 'agent'
    ) {
      continue
    }

    const pairKey = unorderedPairKey(edge.source, edge.target)
    const directions = directionsByPair.get(pairKey) ?? new Set<string>()
    directions.add(`${edge.source}\u0000${edge.target}`)
    directionsByPair.set(pairKey, directions)
  }

  return edges.map((edge) => {
    if (edge.type !== 'readability') {
      return edge
    }

    const sourceNode = nodeById.get(edge.source)
    const targetNode = nodeById.get(edge.target)
    if (!sourceNode || !targetNode) {
      return edge
    }

    const sourceIsAgent = sourceNode.type === 'agent'
    const targetIsAgent = targetNode.type === 'agent'
    if (!sourceIsAgent && !targetIsAgent) {
      return edge
    }

    if (edge.source === edge.target) {
      return sourceIsAgent
        ? { ...edge, sourceHandle: 'source-right', targetHandle: 'target-right' }
        : edge
    }

    const sourceSide = agentSideToward(sourceNode, targetNode)
    const isReciprocalAgentPair =
      sourceIsAgent &&
      targetIsAgent &&
      (directionsByPair.get(unorderedPairKey(edge.source, edge.target))?.size ?? 0) > 1
    const targetSide = isReciprocalAgentPair ? sourceSide : oppositeSide(sourceSide)

    return {
      ...edge,
      ...(sourceIsAgent ? { sourceHandle: `source-${sourceSide}` } : {}),
      ...(targetIsAgent ? { targetHandle: `target-${targetSide}` } : {}),
    }
  })
}
