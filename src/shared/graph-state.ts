import type {
  ChatAttachment,
  NativeProviderEvent,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderRuntimeSettings,
  RuntimeActivity,
  RuntimePlan,
  RuntimeRequest,
  UserInputRequest,
} from './provider-runtime'

export const graphStateVersion = 5

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
  publicRuntimeApi: {
    createSession: {
      input: {
        base: 'CreateRuntimeSessionInput',
        workMode:
          '"local" | "worktree"?; UI intent, runtime resolves to final cwd',
        branch:
          'string?; existing branch to use locally or as the base for a managed worktree',
        sourceSessionId:
          'SessionId?; UI/runtime-only linked chat source, not accepted by membrane create_session',
        linkLabel:
          'string?; UI/runtime-only create-session edge label, not accepted by membrane create_session',
        attachments:
          'ChatAttachment[]?; structured provider-native attachments for the first turn',
      },
    },
    getProjectContext: {
      input: {
        cwd: 'string?; project cwd selected by the UI',
      },
      output:
        'ProjectContext; project name, git repo root, current branch, and local branch list',
    },
    chooseProjectFolder: {
      input: {},
      output:
        '{ canceled: boolean, cwd?: string }; opens a native folder picker for Project selection',
    },
    archiveSession: {
      input: {
        sessionId: 'SessionId',
        archived: 'boolean?; true hides from default history, false restores',
      },
    },
    freeze: {
      input: {
        target: 'SessionId | ClusterId',
        reason: 'string?',
        source: 'SessionId?; optional master/control session for visible freeze edge',
        masterReason: 'string?; explanation shown on freeze edges',
      },
    },
    getWorkingTreeDiff: {
      input: {
        sessionId:
          'SessionId; resolves the selected chat node to its project cwd',
        ignoreWhitespace: 'boolean?',
        turnId:
          'string?; when present returns the checkpoint diff for that provider turn',
      },
      output:
        'WorkingTreeDiffResult; current cwd working tree now, checkpoint-compatible range metadata',
    },
    getProviderSetupStatus: {
      input: {
        providerKind: 'ProviderKind; provider selected in the chat setup UI',
        cwd: 'string?; optional project cwd to validate against provider access',
      },
      output:
        'ProviderSetupStatus; binary/cwd/auth/account/MCP setup diagnostics for the selected provider',
    },
    createMasterForCluster: {
      input: {
        clusterId: 'ClusterId',
        prompt: 'string?',
        cwd: 'string?; project cwd selected by the UI for the master session',
        agent: '"claude-code" | "codex"?',
        providerKind: 'ProviderKind?',
        label: 'string?',
        loopPolicy: 'LoopPolicy?',
      },
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
    AgentSession: {
      archived: 'boolean?',
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

export type AgentBackend =
  | 'claude-cli'
  | 'claude-agent-sdk'
  | 'codex-app-server'
export type SessionRole = 'worker' | 'master'
export type WorkMode = 'local' | 'worktree'

export type SessionProject = {
  name: string
  cwd: string
  repoRoot?: string
  workMode: WorkMode
  baseBranch?: string
  branch?: string
}

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
  attachments?: ChatAttachment[]
  ts: string
  runId?: string
  status?: 'streaming' | 'complete' | 'failed'
}

export type AgentSession = {
  sessionId: SessionId
  nodeId: NodeId
  backend: AgentBackend
  backendSessionId?: string
  providerKind: ProviderKind
  providerInstanceId: string
  providerSessionId?: string
  providerResumeCursor?: string
  agent: string
  label: string
  prompt: string
  cwd: string
  project?: SessionProject
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
  nativeEvents: NativeProviderEvent[]
  runtimeEvents: ProviderRuntimeEvent[]
  runtimeActivities: RuntimeActivity[]
  runtimeRequests: RuntimeRequest[]
  runtimeUserInputRequests: UserInputRequest[]
  runtimePlans: RuntimePlan[]
  runtimeSettings?: ProviderRuntimeSettings
  archived?: boolean
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
  workMode?: WorkMode
  branch?: string
  agent?: 'claude-code' | 'codex'
  providerKind?: ProviderKind
  runtimeSettings?: ProviderRuntimeSettings
  label?: string
  context?: string
  attachments?: ChatAttachment[]
  sourceSessionId?: SessionId
  linkLabel?: string
  cluster?: ClusterId
  role?: SessionRole
}

export type CreateRuntimeSessionResult = {
  sessionId: SessionId
  state: GraphState
}

export type ProjectContextInput = {
  cwd?: string
}

export type ProjectContext = {
  cwd: string
  projectName: string
  isGitRepo: boolean
  repoRoot?: string
  currentBranch?: string
  branches: string[]
  error?: string
}

export type ProviderSetupCheckStatus = 'ok' | 'warning' | 'error' | 'unknown'

export type ProviderSetupCheck = {
  id: string
  label: string
  status: ProviderSetupCheckStatus
  message: string
  detail?: string
}

export type ProviderSetupStatusInput = {
  providerKind: ProviderKind
  cwd?: string
}

export type ProviderSetupStatus = {
  providerKind: ProviderKind
  generatedAt: string
  checks: ProviderSetupCheck[]
}

export type ResumeRuntimeSessionInput = {
  sessionId: SessionId
  message: string
  context?: string
  attachments?: ChatAttachment[]
}

export type RespondRuntimeRequestInput = {
  sessionId: SessionId
  requestId: string
  decision: 'approved' | 'denied'
}

export type AnswerUserInputInput = {
  sessionId: SessionId
  requestId: string
  answer: string
}

export type ArchiveRuntimeSessionInput = {
  sessionId: SessionId
  archived?: boolean
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
  cwd?: string
  agent?: 'claude-code' | 'codex'
  providerKind?: ProviderKind
  runtimeSettings?: ProviderRuntimeSettings
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

export type UpdateNodePositionsInput = {
  positions: {
    nodeId: NodeId
    position: { x: number; y: number }
  }[]
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
  source?: SessionId
  masterReason?: string
}

export type DiffRange =
  | {
      kind: 'working-tree'
      base: 'HEAD'
      target: 'workspace'
    }
  | {
      kind: 'checkpoint'
      fromCheckpointRef: string
      toCheckpointRef: string
      fromTurnCount?: number
      toTurnCount?: number
    }

export type WorkingTreeDiffFile = {
  path: string
  previousPath?: string
  changeType: string
  additions: number
  deletions: number
}

export type WorkingTreeDiffResult = {
  sessionId: SessionId
  cwd: string
  repoRoot: string
  generatedAt: string
  range: DiffRange
  files: WorkingTreeDiffFile[]
  totals: {
    files: number
    additions: number
    deletions: number
  }
  statusEntries: string[]
  patch: string
  truncated: boolean
}

export type WorkingTreeDiffInput = {
  sessionId: SessionId
  ignoreWhitespace?: boolean
  turnId?: string
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
  | {
      type: 'provider.runtime'
      sessionId: SessionId
      providerEvent: ProviderRuntimeEvent
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
