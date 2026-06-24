export const graphStateVersion = 4

export const sessionStatuses = [
  'pending',
  'running',
  'idle',
  'failed',
  'killed',
] as const

export const reportTypes = ['verdict', 'relationship', 'info'] as const

export const graphEdgeKinds = [
  'create-session',
  'resume-session',
  'report',
  'freeze',
] as const

export const graphStateSchema = {
  version: graphStateVersion,
  invariants: ['nodeId === sessionId'],
  envelope: {
    callId: 'string',
    source: 'SessionId',
    ts: 'ISO-8601 string',
  },
  graphState: {
    nodes: 'GraphNode[]',
    edges: 'GraphEdge[]',
    sessions: 'Record<SessionId, AgentSession>',
    clusters:
      'Record<ClusterId, Cluster>; Cluster.nodeIds are the managed scope nodes',
    reports: 'Report[]',
    diagnostics: 'RuntimeStateDiagnostic[]?',
  },
  loopPolicy: {
    until: { whenReport: { verdict: 'string' } },
    onStop: 'freeze',
    maxIterations: 'number?',
  },
  loopState: {
    status: '"running" | "stopped"',
    iterations: 'number',
    coderSessionId: 'SessionId?',
    reviewerSessionId: 'SessionId?',
    lastEvent: 'LoopEvent?',
    lastProcessedEventKey: 'string?',
    reason: 'string?',
    startedAt: 'ISO-8601 string?',
    stoppedAt: 'ISO-8601 string?',
  },
  membraneSkills: {
    create_session: {
      input: {
        agent: 'string',
        prompt: 'string',
        context: 'string?',
        cluster: 'ClusterId?',
        label: 'string?',
      },
      output: { sessionId: 'SessionId' },
    },
    resume_session: {
      input: {
        sessionId: 'SessionId',
        message: 'string',
        context: 'string?',
      },
      output: { ok: 'boolean' },
    },
    report: {
      input:
        'verdict | relationship | info payload; runtime adds envelope and routes upward',
      output: { ok: 'boolean' },
    },
  },
  runtimeEvents: [
    'runtime.state',
    'session.created',
    'session.resumed',
    'session.stream',
    'session.finished',
    'session.failed',
    'session.killed',
    'report.received',
    'freeze.applied',
    'loop.started',
    'loop.stopped',
  ],
  readabilityFields: {
    GraphNode: {
      frozen: 'boolean?',
      freezeReason: 'string?',
      masterReason: 'string?',
    },
    GraphEdge: {
      kind: graphEdgeKinds,
      reportId: 'string?',
      verdict: 'string?',
      issueCount: 'number?',
      summary: 'string?',
      masterReason: 'string?',
      frozen: 'boolean?',
      freezeReason: 'string?',
    },
    Cluster: {
      frozen: 'boolean?',
      freezeReason: 'string?',
      loopState: 'LoopState?',
    },
  },
} as const

export type SessionId = string
export type NodeId = SessionId
export type ClusterId = string
export type EdgeId = string
export type CallId = string

export type SessionStatus = (typeof sessionStatuses)[number]

export type AgentBackend = 'claude-cli'
export type SessionRole = 'worker' | 'master'

export type SkillCallEnvelope = {
  callId: CallId
  source: SessionId
  ts: string
}

export type Issue = {
  message: string
  file?: string
  line?: number
  severity?: 'info' | 'warn' | 'error'
}

export type ReportPayload =
  | { type: 'verdict'; verdict: string; issues?: Issue[]; summary?: string }
  | {
      type: 'relationship'
      target: string
      nature?: string
      sessionRef?: SessionId
    }
  | { type: 'info'; payload: unknown }

export type Report = {
  id: string
  from: SessionId
  envelope: SkillCallEnvelope
  payload: ReportPayload
}

export type FreezeState = {
  frozen?: boolean
  freezeReason?: string
  masterReason?: string
}

export type LoopPolicy = {
  until?: { whenReport: { verdict: string } }
  onStop: 'freeze'
  maxIterations?: number
}

export type LoopStatus = 'running' | 'stopped'

export type LoopEvent = {
  type: string
  ts: string
  sessionId?: SessionId
  from?: SessionId
  reportId?: string
  targetId?: string
  error?: string
}

export type LoopState = {
  status: LoopStatus
  iterations: number
  coderSessionId?: SessionId
  reviewerSessionId?: SessionId
  lastEvent?: LoopEvent
  lastProcessedEventKey?: string
  reason?: string
  startedAt?: string
  stoppedAt?: string
}

export type GraphNode = FreezeState & {
  nodeId: NodeId
  sessionId: SessionId
  label: string
  role: SessionRole
  agent: string
  clusterId?: ClusterId
  status: SessionStatus
  position: { x: number; y: number }
}

export type GraphEdgeKind = (typeof graphEdgeKinds)[number]

export type GraphEdge = FreezeState & {
  edgeId: EdgeId
  source: SessionId
  target: SessionId
  kind: GraphEdgeKind
  call?: SkillCallEnvelope
  label?: string
  ts: string
  reportId?: string
  verdict?: string
  issueCount?: number
  summary?: string
}

export type AgentStreamChunk = {
  id: string
  sessionId: SessionId
  ts: string
  stream: 'stdout' | 'stderr'
  raw: string
  eventType?: string
  text?: string
}

export type AgentMessageRole = 'user' | 'assistant' | 'system'

export type AgentMessage = {
  id: string
  sessionId: SessionId
  role: AgentMessageRole
  content: string
  ts: string
  runId?: string
  status?: 'streaming' | 'complete' | 'failed'
}

export type AgentSession = {
  sessionId: SessionId
  nodeId: NodeId
  backend: AgentBackend
  backendSessionId?: string
  agent: string
  label: string
  prompt: string
  cwd: string
  role: SessionRole
  status: SessionStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number | null
  signal?: string | null
  error?: string
  result?: string
  chunks: AgentStreamChunk[]
  messages: AgentMessage[]
}

export type Cluster = {
  clusterId: ClusterId
  label: string
  nodeIds: NodeId[]
  masterSessionId?: SessionId
  loopPolicy?: LoopPolicy
  loopState?: LoopState
  frozen?: boolean
  freezeReason?: string
}

export type RuntimeStateDiagnostic = {
  id: string
  type: string
  message: string
  ts: string
  details?: Record<string, unknown>
}

export type GraphState = {
  version: number
  updatedAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  sessions: Record<SessionId, AgentSession>
  clusters: Record<ClusterId, Cluster>
  reports: Report[]
  diagnostics?: RuntimeStateDiagnostic[]
}

export type CreateRuntimeSessionInput = {
  prompt: string
  cwd?: string
  agent?: 'claude-code'
  label?: string
  cluster?: ClusterId
  role?: SessionRole
}

export type CreateRuntimeSessionResult = {
  sessionId: SessionId
  state: GraphState
}

export type ResumeRuntimeSessionInput = {
  sessionId: SessionId
  message: string
  context?: string
}

export type UpsertClusterInput = {
  clusterId?: ClusterId
  label?: string
  nodeIds: NodeId[]
  loopPolicy?: LoopPolicy
}

export type CreateMasterForClusterInput = {
  clusterId: ClusterId
  prompt?: string
  label?: string
  loopPolicy?: LoopPolicy
}

export type AssignMasterToClusterInput = {
  clusterId: ClusterId
  sessionId: SessionId
}

export type SetClusterLoopPolicyInput = {
  clusterId: ClusterId
  loopPolicy: LoopPolicy
}

export type StartMasterLoopInput = {
  clusterId: ClusterId
  reason?: string
}

export type StopMasterLoopInput = {
  clusterId: ClusterId
  reason?: string
  killRunning?: boolean
}

export type FreezeInput = {
  target: SessionId | ClusterId
  reason?: string
}

export type RuntimeEvent =
  | { type: 'runtime.state'; state: GraphState }
  | { type: 'session.created'; sessionId: SessionId; state: GraphState }
  | { type: 'session.resumed'; sessionId: SessionId; state: GraphState }
  | {
      type: 'session.stream'
      sessionId: SessionId
      chunk: AgentStreamChunk
      state: GraphState
    }
  | { type: 'session.finished'; sessionId: SessionId; state: GraphState }
  | {
      type: 'session.failed'
      sessionId: SessionId
      error: string
      state: GraphState
    }
  | { type: 'session.killed'; sessionId: SessionId; state: GraphState }
  | { type: 'report.received'; from: SessionId; report: Report; state: GraphState }
  | { type: 'freeze.applied'; targetId: string; reason?: string; state: GraphState }
  | { type: 'loop.started'; clusterId: ClusterId; state: GraphState }
  | {
      type: 'loop.stopped'
      clusterId: ClusterId
      reason?: string
      state: GraphState
    }

export function createEmptyGraphState(): GraphState {
  return {
    version: graphStateVersion,
    updatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    sessions: {},
    clusters: {},
    reports: [],
  }
}
