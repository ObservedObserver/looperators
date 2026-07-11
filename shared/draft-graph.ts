import type { ReviewBlockingMode, ReviewRuntimeSettings, ReviewWorkflowStartInput, ReviewWorkflowValidationContext } from './review-workflow.js'
import { validateReviewWorkflowStart } from './review-workflow.js'

export type DraftPoint = { x: number; y: number }

export type DraftAgentEndpoint =
  | {
      kind: 'new'
      label: string
      prompt: string
      cwd: string
      workMode: 'local' | 'worktree'
      branch?: string
      providerKind: 'claude-code' | 'codex' | 'grok'
      providerInstanceId: string
      runtimeSettings: ReviewRuntimeSettings
    }
  | {
      kind: 'existing'
      sessionId: string
      prompt: string
    }

export type DraftAgentNode = {
  id: string
  position: DraftPoint
  endpoint: DraftAgentEndpoint
}

export type DraftRelationKind = 'handoff-once' | 'trigger-on-completion' | 'review-loop'

export type DraftRelation = {
  id: string
  kind: DraftRelationKind
  sourceNodeId: string
  targetNodeId: string
  instruction: string
  review?: {
    blocking: {
      mode: ReviewBlockingMode
      customCriteria?: string
    }
    maxLaps: number
  }
}

export type DraftSelection = { kind: 'node'; id: string } | { kind: 'relation'; id: string }

export type DraftGraph = {
  nodes: Record<string, DraftAgentNode>
  nodeOrder: string[]
  relations: Record<string, DraftRelation>
  relationOrder: string[]
  selection?: DraftSelection
  nextNodeNumber: number
  nextRelationNumber: number
}

export type DraftGraphAction =
  | { type: 'add-node'; node: Omit<DraftAgentNode, 'id'>; id?: string }
  | { type: 'update-node'; id: string; patch: Partial<Omit<DraftAgentNode, 'id'>> }
  | { type: 'remove-node'; id: string }
  | { type: 'add-relation'; relation: Omit<DraftRelation, 'id'>; id?: string }
  | { type: 'update-relation'; id: string; patch: Partial<Omit<DraftRelation, 'id'>> }
  | { type: 'remove-relation'; id: string }
  | { type: 'select'; selection?: DraftSelection }
  | { type: 'clear' }

export type DraftValidationIssue = {
  target: 'graph' | 'node' | 'relation'
  id?: string
  field: string
  message: string
}

export type DraftInstantiationMap = {
  nodeSessionIds: Record<string, string>
  relationSubscriptionIds: Record<string, string[]>
}

export type DraftCompiledRelation =
  | {
      kind: 'subscription'
      relationId: string
      sourceNodeId: string
      targetNodeId: string
      label: string
      on: { on: 'finished' }
      action: { kind: 'deliver+activate'; topic: string; note: string }
      stop?: { maxFirings: number }
    }
  | {
      kind: 'review-workflow'
      relationId: string
      input: ReviewWorkflowStartInput
    }

export function emptyDraftGraph(): DraftGraph {
  return {
    nodes: {},
    nodeOrder: [],
    relations: {},
    relationOrder: [],
    nextNodeNumber: 1,
    nextRelationNumber: 1,
  }
}

function nextAvailableId(prefix: string, start: number, values: Record<string, unknown>) {
  let number = start
  while (values[`${prefix}-${number}`]) number += 1
  return { id: `${prefix}-${number}`, next: number + 1 }
}

function assertPoint(value: DraftPoint) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) {
    throw new Error('Draft node position must use finite x/y coordinates.')
  }
}

export function reduceDraftGraph(graph: DraftGraph, action: DraftGraphAction): DraftGraph {
  switch (action.type) {
    case 'add-node': {
      assertPoint(action.node.position)
      const generated = nextAvailableId('draft-agent', graph.nextNodeNumber, graph.nodes)
      const id = action.id?.trim() || generated.id
      if (graph.nodes[id]) throw new Error(`Draft node already exists: ${id}`)
      return {
        ...graph,
        nodes: { ...graph.nodes, [id]: { ...action.node, id } },
        nodeOrder: [...graph.nodeOrder, id],
        selection: { kind: 'node', id },
        nextNodeNumber: action.id ? graph.nextNodeNumber : generated.next,
      }
    }
    case 'update-node': {
      const current = graph.nodes[action.id]
      if (!current) throw new Error(`Unknown draft node: ${action.id}`)
      if (action.patch.position) assertPoint(action.patch.position)
      return {
        ...graph,
        nodes: { ...graph.nodes, [action.id]: { ...current, ...action.patch, id: action.id } },
      }
    }
    case 'remove-node': {
      if (!graph.nodes[action.id]) return graph
      const nodes = { ...graph.nodes }
      delete nodes[action.id]
      const removedRelationIds = graph.relationOrder.filter((id) => {
        const relation = graph.relations[id]
        return relation.sourceNodeId === action.id || relation.targetNodeId === action.id
      })
      const relations = { ...graph.relations }
      for (const id of removedRelationIds) delete relations[id]
      const selection =
        graph.selection?.id === action.id || (graph.selection?.kind === 'relation' && removedRelationIds.includes(graph.selection.id))
          ? undefined
          : graph.selection
      return {
        ...graph,
        nodes,
        nodeOrder: graph.nodeOrder.filter((id) => id !== action.id),
        relations,
        relationOrder: graph.relationOrder.filter((id) => !removedRelationIds.includes(id)),
        selection,
      }
    }
    case 'add-relation': {
      const generated = nextAvailableId('draft-relation', graph.nextRelationNumber, graph.relations)
      const id = action.id?.trim() || generated.id
      if (graph.relations[id]) throw new Error(`Draft relation already exists: ${id}`)
      if (!graph.nodes[action.relation.sourceNodeId]) throw new Error(`Unknown draft source node: ${action.relation.sourceNodeId}`)
      if (!graph.nodes[action.relation.targetNodeId]) throw new Error(`Unknown draft target node: ${action.relation.targetNodeId}`)
      return {
        ...graph,
        relations: { ...graph.relations, [id]: { ...action.relation, id } },
        relationOrder: [...graph.relationOrder, id],
        selection: { kind: 'relation', id },
        nextRelationNumber: action.id ? graph.nextRelationNumber : generated.next,
      }
    }
    case 'update-relation': {
      const current = graph.relations[action.id]
      if (!current) throw new Error(`Unknown draft relation: ${action.id}`)
      return {
        ...graph,
        relations: { ...graph.relations, [action.id]: { ...current, ...action.patch, id: action.id } },
      }
    }
    case 'remove-relation': {
      if (!graph.relations[action.id]) return graph
      const relations = { ...graph.relations }
      delete relations[action.id]
      return {
        ...graph,
        relations,
        relationOrder: graph.relationOrder.filter((id) => id !== action.id),
        selection: graph.selection?.kind === 'relation' && graph.selection.id === action.id ? undefined : graph.selection,
      }
    }
    case 'select':
      return { ...graph, selection: action.selection }
    case 'clear':
      return emptyDraftGraph()
  }
}

function trimmed(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function joinedInstructions(...values: unknown[]) {
  return values.map(trimmed).filter(Boolean).join('\n\n')
}

function reviewInputForRelation(graph: DraftGraph, relation: DraftRelation): ReviewWorkflowStartInput | undefined {
  const source = graph.nodes[relation.sourceNodeId]
  const target = graph.nodes[relation.targetNodeId]
  if (!source || !target || relation.kind !== 'review-loop') return undefined
  const review = relation.review ?? { blocking: { mode: 'p0-p1' as const }, maxLaps: 6 }
  const coder = source.endpoint
  const reviewer = target.endpoint
  return {
    coder: coder.kind === 'new' ? { ...coder } : { kind: 'existing', sessionId: coder.sessionId, prompt: coder.prompt },
    reviewer:
      reviewer.kind === 'new'
        ? {
            kind: 'new',
            label: reviewer.label,
            instruction: joinedInstructions(reviewer.prompt, relation.instruction),
            providerKind: reviewer.providerKind,
            providerInstanceId: reviewer.providerInstanceId,
            runtimeSettings: reviewer.runtimeSettings,
          }
        : {
            kind: 'existing',
            sessionId: reviewer.sessionId,
            instruction: joinedInstructions(reviewer.prompt, relation.instruction),
          },
    blocking: review.blocking,
    maxLaps: review.maxLaps,
  }
}

export function validateDraftGraph(graph: DraftGraph, context: ReviewWorkflowValidationContext = {}) {
  const issues: DraftValidationIssue[] = []
  const providerIds = new Set(context.providerInstanceIds ?? [])
  if (graph.nodeOrder.length === 0) {
    issues.push({ target: 'graph', field: 'nodes', message: 'Add at least one Agent.' })
  }
  if (graph.nodeOrder.length > 1 && graph.relationOrder.length === 0) {
    issues.push({ target: 'graph', field: 'relations', message: 'Connect the Agents with a Relationship.' })
  }

  for (const id of graph.nodeOrder) {
    const node = graph.nodes[id]
    if (!node) {
      issues.push({ target: 'graph', field: 'nodeOrder', message: `Draft node ${id} is missing.` })
      continue
    }
    assertPoint(node.position)
    if (!trimmed(node.endpoint.prompt)) {
      issues.push({ target: 'node', id, field: 'prompt', message: "Add this Agent's Prompt." })
    }
    if (node.endpoint.kind === 'new') {
      if (!trimmed(node.endpoint.label)) issues.push({ target: 'node', id, field: 'label', message: 'Name this Agent.' })
      if (!trimmed(node.endpoint.cwd)) issues.push({ target: 'node', id, field: 'cwd', message: "Choose this Agent's workspace." })
      if (!trimmed(node.endpoint.providerInstanceId)) {
        issues.push({ target: 'node', id, field: 'providerInstanceId', message: "Choose this Agent's provider." })
      } else if (providerIds.size > 0 && !providerIds.has(node.endpoint.providerInstanceId)) {
        issues.push({ target: 'node', id, field: 'providerInstanceId', message: 'The selected provider is unavailable.' })
      }
    } else if (!trimmed(node.endpoint.sessionId)) {
      issues.push({ target: 'node', id, field: 'sessionId', message: 'Choose an existing Agent.' })
    } else {
      issues.push({
        target: 'node',
        id,
        field: 'sessionId',
        message: 'Existing Agents connect dynamically. Static Draft creates new Agents only.',
      })
    }
    if (node.endpoint.kind === 'existing' && trimmed(node.endpoint.sessionId) && context.sessions) {
      const session = context.sessions[node.endpoint.sessionId]
      if (!session) {
        issues.push({ target: 'node', id, field: 'sessionId', message: 'The selected Agent no longer exists.' })
      } else {
        if (!['idle', 'failed'].includes(session.status)) {
          issues.push({ target: 'node', id, field: 'sessionId', message: `The selected Agent is ${session.status}; wait until it is idle.` })
        }
        if (session.frozen) {
          issues.push({ target: 'node', id, field: 'sessionId', message: 'The selected Agent is frozen.' })
        }
      }
    }
    if (
      graph.nodeOrder.length > 1 &&
      !graph.relationOrder.some((relationId) => {
        const relation = graph.relations[relationId]
        return relation?.sourceNodeId === id || relation?.targetNodeId === id
      })
    ) {
      issues.push({ target: 'node', id, field: 'relationship', message: 'Connect this Agent to the workflow.' })
    }
  }

  const signatures = new Set<string>()
  for (const id of graph.relationOrder) {
    const relation = graph.relations[id]
    if (!relation) {
      issues.push({ target: 'graph', field: 'relationOrder', message: `Draft relation ${id} is missing.` })
      continue
    }
    if (!graph.nodes[relation.sourceNodeId]) {
      issues.push({ target: 'relation', id, field: 'sourceNodeId', message: 'Relationship source no longer exists.' })
    }
    if (!graph.nodes[relation.targetNodeId]) {
      issues.push({ target: 'relation', id, field: 'targetNodeId', message: 'Relationship target no longer exists.' })
    }
    if (relation.sourceNodeId === relation.targetNodeId) {
      issues.push({ target: 'relation', id, field: 'targetNodeId', message: 'Connect two different Agents.' })
    }
    const signature = `${relation.kind}:${relation.sourceNodeId}:${relation.targetNodeId}`
    if (signatures.has(signature)) {
      issues.push({ target: 'relation', id, field: 'kind', message: 'This Relationship already exists.' })
    }
    signatures.add(signature)
    if (relation.kind === 'review-loop') {
      const input = reviewInputForRelation(graph, relation)
      if (input) {
        for (const issue of validateReviewWorkflowStart(input, context).issues) {
          const targetId = issue.field.startsWith('reviewer') ? relation.targetNodeId : issue.field.startsWith('coder') ? relation.sourceNodeId : id
          issues.push({
            target: targetId === id ? 'relation' : 'node',
            id: targetId,
            field: issue.field,
            message: issue.message,
          })
        }
      }
    }
  }
  if (graph.relationOrder.length > 0) {
    const incoming = new Map(graph.nodeOrder.map((id) => [id, 0]))
    const outgoing = new Map(graph.nodeOrder.map((id) => [id, [] as string[]]))
    for (const relationId of graph.relationOrder) {
      const relation = graph.relations[relationId]
      if (!relation || !incoming.has(relation.sourceNodeId) || !incoming.has(relation.targetNodeId)) continue
      incoming.set(relation.targetNodeId, (incoming.get(relation.targetNodeId) ?? 0) + 1)
      outgoing.get(relation.sourceNodeId)?.push(relation.targetNodeId)
    }
    const queue = graph.nodeOrder.filter((id) => incoming.get(id) === 0)
    let visited = 0
    while (queue.length > 0) {
      const id = queue.shift() as string
      visited += 1
      for (const target of outgoing.get(id) ?? []) {
        const next = (incoming.get(target) ?? 0) - 1
        incoming.set(target, next)
        if (next === 0) queue.push(target)
      }
    }
    if (visited < graph.nodeOrder.length) {
      issues.push({
        target: 'graph',
        field: 'cycle',
        message: 'Only Review loop creates a return path. Remove the manually reversed Relationship.',
      })
    }
  }
  return { ok: issues.length === 0, issues }
}

export function compileDraftRelation(graph: DraftGraph, relationId: string): DraftCompiledRelation {
  const relation = graph.relations[relationId]
  if (!relation) throw new Error(`Unknown draft relation: ${relationId}`)
  if (relation.kind === 'review-loop') {
    const input = reviewInputForRelation(graph, relation)
    if (!input) throw new Error(`Review Relationship ${relationId} is incomplete.`)
    return { kind: 'review-workflow', relationId, input }
  }
  const handoff = relation.kind === 'handoff-once'
  return {
    kind: 'subscription',
    relationId,
    sourceNodeId: relation.sourceNodeId,
    targetNodeId: relation.targetNodeId,
    label: handoff ? 'handoff once' : 'trigger on completion',
    on: { on: 'finished' },
    action: {
      kind: 'deliver+activate',
      topic: handoff ? 'handoff' : 'completion',
      note:
        trimmed(relation.instruction) ||
        (handoff
          ? 'Handoff: read the delivered result and continue the work once.'
          : 'The source Agent completed another turn. Read the delivered result and act on it.'),
    },
    ...(handoff ? { stop: { maxFirings: 1 } } : {}),
  }
}

export function draftNodePositionUpdates(graph: DraftGraph, mapping: DraftInstantiationMap) {
  return graph.nodeOrder.flatMap((id) => {
    const sessionId = mapping.nodeSessionIds[id]
    const node = graph.nodes[id]
    return sessionId && node ? [{ nodeId: sessionId, position: { ...node.position } }] : []
  })
}
