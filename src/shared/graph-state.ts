export const graphStateVersion = 2

export const sessionStatuses = [
  'pending',
  'running',
  'idle',
  'failed',
  'killed',
] as const

export const reportTypes = ['verdict', 'relationship', 'info'] as const

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
    clusters: 'Record<ClusterId, Cluster>',
    reports: 'Report[]',
    diagnostics: 'RuntimeStateDiagnostic[]?',
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
  ],
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

export type GraphNode = {
  nodeId: NodeId
  sessionId: SessionId
  label: string
  role: SessionRole
  agent: string
  clusterId?: ClusterId
  status: SessionStatus
  position: { x: number; y: number }
}

export type GraphEdgeKind = 'create-session' | 'resume-session' | 'report'

export type GraphEdge = {
  edgeId: EdgeId
  source: SessionId
  target: SessionId
  kind: GraphEdgeKind
  call?: SkillCallEnvelope
  label?: string
  ts: string
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
  frozen?: boolean
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
