export const graphStateVersion = 5

export const sessionStatuses = [
  'pending',
  'running',
  'idle',
  'failed',
  'killed',
]

export const reportTypes = ['verdict', 'relationship', 'info']

export const graphEdgeKinds = [
  'create-session',
  'resume-session',
  'report',
  'freeze',
]

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
    'provider.runtime',
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
      backend: '"claude-cli" | "claude-agent-sdk" | "codex-app-server"',
      providerKind: '"legacy-claude-cli" | "claude-code" | "codex"',
      providerInstanceId: 'string',
      providerSessionId: 'string?',
      runtimeEvents: 'ProviderRuntimeEvent[]',
      runtimeActivities: 'RuntimeActivity[]',
      nativeEvents: 'NativeProviderEvent[]',
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
}

export function createEmptyGraphState() {
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
