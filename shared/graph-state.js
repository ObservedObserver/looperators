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
      },
      output:
        'WorkingTreeDiffResult; current cwd working tree now, checkpoint-compatible range metadata',
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
    updateNodePositions: {
      input: {
        positions: '{ nodeId: NodeId, position: { x: number, y: number } }[]',
      },
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
      archived: 'boolean?',
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
