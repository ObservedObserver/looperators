import { defaultProviderInstances } from './provider-metadata.js'

export const graphStateVersion = 8

// Intent-layer enums (kernel doc §7.3). Kept as value arrays so the electron
// build and the renderer share one vocabulary.
export const subscriptionGates = ['auto', 'master', 'human']
export const subscriptionConcurrencies = ['coalesce', 'queue', 'drop', 'interrupt']
export const subscriptionOnStops = ['freeze-edge', 'freeze-target', 'freeze-cluster']
export const subscriptionStates = ['active', 'stopped']
export const subscriptionPatterns = ['finished', 'failed', 'report', 'delivered', 'schedule', 'external']

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
  'link',
]

export const openWorkspaceTargetIds = [
  'vscode',
  'cursor',
  'windsurf',
  'antigravity',
  'finder',
  'terminal',
  'ghostty',
  'xcode',
]

export const runtimeTerminalStatuses = [
  'running',
  'exited',
  'closed',
]

export const runtimeTerminalStreams = [
  'stdin',
  'stdout',
  'stderr',
  'system',
]

export const defaultGraphProviderInstances = defaultProviderInstances

export const graphStateSchema = {
  version: graphStateVersion,
  invariants: ['nodeId === sessionId'],
  envelope: {
    callId: 'string',
    source: 'SessionId',
    ts: 'ISO-8601 string',
  },
  graphState: {
    controlVersion:
      'number; optimistic version of transactionally committed control commands',
    nodes: 'GraphNode[]',
    edges: 'GraphEdge[]',
    sessions: 'Record<SessionId, AgentSession>',
    providerInstances: 'ProviderInstance[]; local provider runtime profiles',
    clusters:
      'Record<ClusterId, Cluster>; Cluster.nodeIds are the managed scope nodes',
    reports: 'Report[]',
    subscriptions:
      'Record<SubscriptionId, Subscription>; intent-layer edges (v7, kernel doc §7.3)',
    pendingActivations:
      'Record<slotKey, PendingActivation>; one live slot per (subscription, target) (v7)',
    planCouncils:
      'Record<workflowId, PlanCouncil>; durable product projection for manual-gated multi-agent planning runs',
    workflowPlans:
      'Record<workflowId, Record<version, WorkflowPlan>>; authoring-plane versions, never read by the scheduler',
    workflowProposals:
      'Record<proposalId, WorkflowProposal>; review/approval/commit state for Master and standalone authoring',
    workflowCapabilities:
      'Record<scopeId, ScopeWorkflowCapability>; scope-owned authorization, never inferred from prompts',
    workflowWakeups:
      'Record<wakeupId, WorkflowMasterWakeup>; durable coalesced Governor judgment requests',
    barriers:
      'Record<barrierId, WorkflowBarrier>; durable correlation-scoped all/any/quorum joins',
    dynamicSpawnGroups:
      'Record<groupId, DynamicSpawnGroup>; durable bounded dynamic-topology deployments',
    workspaceLeases:
      'WorkspaceLease[]; durable reader/writer ownership facts for provider turns',
    runQueue:
      'QueuedProviderRun[]; durable fair-admission queue (queued work never owns a lease)',
    usageFacts:
      'RuntimeUsageFact[]; immutable provider usage facts, independent from pricing',
    resourcePolicies:
      'Record<scopeId, RuntimeResourcePolicy>; global workspace serialization switch, always-on capacity controls, and optional off/warn/hard consumption budgets',
    schedulerMetrics:
      'SchedulerBackpressureMetrics; runtime admission/backpressure projection',
    loops:
      'LoopView[]?; derived on read, never stored — exact compiled Review/Goal instances plus generic cyclic SCCs',
    sources:
      'Record<sourceId, ExternalSource>; L2 registered external event sources (removed ones stay as tombstones)',
    templates:
      'Record<templateId, SavedTemplate>?; L6 user-saved relation templates — runtime-plane config (the scheduler never reads them), persisted via snapshot, never kernel facts',
    diagnostics: 'RuntimeStateDiagnostic[]?',
  },
  externalSource: {
    id: 'string',
    kind: '"script" | "git" | "webhook" | "manual"',
    topic: 'string; facts are `external.<topic>`; "timer" reserved',
    label: 'string?',
    config: 'Record<string, any>; adapter config, opaque to the kernel',
    minIntervalSeconds:
      'number?; source-side sampling — too-soon emits are dropped, not delayed (defaults per kind)',
    state: '"active" | "removed"',
    createdAt: 'ISO-8601 string',
    lastEventAt: 'ISO-8601 string?; last accepted emit (folded from the log)',
    lastDedupeKey: 'string?; consecutive-duplicate suppression anchor',
    lastError:
      'string?; adapter-side operational error (runtime-plane cache, cleared on the next accepted emit; never a kernel fact)',
  },
  subscription: {
    id: 'SubscriptionId',
    source: '{kind:"session",sessionId} | {kind:"cluster",clusterId} | {kind:"timer"} | {kind:"external",sourceId}',
    on: '{on:"finished"|"failed"} | {on:"report",match?:{type?,verdict?}} | {on:"delivered",topic?} | {on:"schedule",everySeconds?|dailyAt?} (timer source only; exactly one form, dailyAt="HH:MM" host-local) | {on:"external",topic?,match?:Record<string,string>} (external source only; match is strict string equality on payload fields)',
    target: '{kind:"session",sessionId}',
    action: '{kind:"deliver"|"deliver+activate", topic?, note?} | validated bounded DynamicCreateAction',
    executionRef: '{workflowId,workflowVersion,runId,phaseId}?; governing seed for events whose source turn has no envelope',
    gate: subscriptionGates,
    concurrency: subscriptionConcurrencies,
    stop: '{whenReport?:{verdict}, maxFirings?, deadline?}?',
    onStop: subscriptionOnStops,
    state: subscriptionStates,
    firings: 'number',
    label: 'string?',
    createdAt: 'ISO-8601 string',
    lastTickAt: 'ISO-8601 string?; timer subscriptions: when the last tick fired',
  },
  pendingActivation: {
    slotKey: 'string; `${subscriptionId}→${target}`',
    subscriptionId: 'SubscriptionId',
    target: 'SessionId',
    triggerEventId: 'kernel EventId',
    gate: subscriptionGates,
    masterSessionId: 'SessionId?; governor per LCA rule R1 when gate=master',
    status: '"pending" | "approved"',
    createdAt: 'ISO-8601 string',
  },
  loopView: {
    loopId: 'string; sorted member sessionIds joined with "+"',
    memberSessionIds: 'SessionId[]',
    subscriptionIds: 'SubscriptionId[]; ring edges, stopped ones included',
    designatedSubscriptionId: 'SubscriptionId; its firings count the laps',
    lapCount: 'number',
    lapCap: 'number?; min stop.maxFirings across ring edges',
    status: '"spinning" | "waiting-gate" | "frozen" | "stopped" | "idle"',
    statusDetail: 'string?',
    stopSummary: 'string?',
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
    link_sessions: {
      input: {
        sessionId: 'SessionId; link target, source is the calling session',
        label: 'string?',
        reason: 'string?',
      },
      output: { ok: 'boolean', edgeId: 'string' },
    },
    inspect_scope: {
      input: '{ cursor?, pageSize? }; Master-only, read-only',
      output: '{ scope, capability, summary, sessionRefs, providerRefs, workflowRefs, nextCursor? }',
    },
    inspect_workflow_wakeups: {
      input: '{ statuses? }; Master-only, read-only',
      output: '{ wakeups: WorkflowMasterWakeup[] }',
    },
    acknowledge_workflow_wakeup: {
      input: '{ wakeupId, reason }; governing Master only',
      output: '{ wakeup: WorkflowMasterWakeup }',
    },
    advance_plan_council: {
      input: '{ workflowId, wakeupId?, reason, idempotencyKey? }; governing Master only; Council gate must be master',
      output: '{ council: PlanCouncil, wakeup? }',
    },
    propose_workflow: {
      input: '{ recipe, objective, input, reason, idempotencyKey }; Master-only',
      output: 'compact WorkflowProposal summary; no execution mutation and no GraphState payload',
    },
    propose_workflow_patch: {
      input: '{ workflowId, baseVersion, wakeupIds?, reason, operations, idempotencyKey }; Master-only; operations include bounded add-dynamic-triage',
      output: 'compact versioned patch Proposal with impact and rollback; no execution mutation',
    },
    revise_workflow: {
      input: '{ proposalId, recipe?, objective?, input?, reason }; human locks are immutable to Master',
      output: 'compact revised WorkflowProposal summary',
    },
    explain_workflow: {
      input: '{ proposalId }; Master-only, read-only',
      output: 'compact participants, relationships, Graph Diff, policy, validation',
    },
    commit_workflow: {
      input: '{ proposalId, expectedBaseVersion, idempotencyKey, reason? }; approved proposals only',
      output: 'compact committed proposal with stable execution mapping',
    },
    abort_workflow: {
      input: '{ proposalId, reason }; uncommitted proposals only',
      output: 'compact aborted proposal summary',
    },
  },
  publicRuntimeApi: {
    linkSessions: {
      input: {
        source: 'SessionId',
        target: 'SessionId',
        label: 'string?; defaults to "link"',
        reason: 'string?; shown as edge detail',
      },
      output:
        '{ edge: GraphEdge }; idempotent for same source/target/label, a new reason refreshes the stored summary',
    },
    removeEdge: {
      input: {
        edgeId: 'string; only kind "link" edges are removable',
      },
      output: '{ ok: boolean }',
    },
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
        providerInstanceId:
          'string?; selected provider runtime profile for this session',
        runtimeSettings:
          'ProviderRuntimeSettings?; runtime mode, model, reasoning effort, sandbox/approval policy hints',
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
    createGoalLoop: {
      input: {
        workerSessionId: 'SessionId',
        goal: "string; the natural-language done condition — goes only into the judge's prompts, never parsed",
        maxLaps: 'number?; default 6 (defaultCycleMaxFirings), guardrail via stop.maxFirings',
        gate: 'auto|master|human?; default auto — deterministic judging needs no master',
        onStop: 'freeze-edge|freeze-target|freeze-cluster?; default freeze-edge',
        judgeProviderInstanceId: "string?; default: the worker's provider (cheap-judge override point)",
        judgeModel: "string?; compatible model for an overridden Judge provider",
      },
      output:
        '{ judgeSessionId, checkSubscription, retrySubscription, state }; L3 preset — compiles into create_session + author_subscription ×2 (worker on finished → judge; judge on report(fail) → worker; both stop at whenReport done + maxFirings), no new kernel verb',
    },
    startHandoffWorkflow: {
      input:
        '{ source: new|existing Agent endpoint, target: new|existing Agent endpoint, note }; atomic product workflow',
      output:
        '{ sourceSessionId, targetSessionId, createdSessionIds, subscriptionIds, deliveredTo, state }; one-shot, with no standing relationship after delivery',
    },
    startGoalWorkflow: {
      input:
        '{ worker: new|existing Agent endpoint, goal, maxLaps, judgeProviderInstanceId?, judgeModel? }; atomic product workflow',
      output:
        '{ workerSessionId, judgeSessionId, createdSessionIds, subscriptionIds, loop, state }; installs the Goal ring before starting Worker',
    },
    startReviewWorkflow: {
      input:
        '{ coder: new|existing endpoint + work prompt, reviewer: new|existing endpoint + independent provider config + review instruction, blocking: any-issue|p0-p1|custom, maxLaps }; one product-level transaction',
      output:
        '{ coderSessionId, reviewerSessionId, createdSessionIds, subscriptionIds, loop, state }; creates/binds both endpoints, authors the paired review ring, then starts the Coder. A new Reviewer stays provider-cold until the first delivered diff (no ready turn)',
    },
    stopLoop: {
      input:
        '{ loopId, reason?, killRunning? }; stops every active relationship in the derived ring. By default an Agent turn already running is allowed to finish; killRunning is an explicit opt-in',
      output: '{ state }; no stored Loop object is created',
    },
    registerExternalSource: {
      input: {
        kind: '"script" | "git" | "webhook" | "manual"',
        topic: 'string?; default = kind; facts are `external.<topic>`',
        label: 'string?',
        config: 'Record<string, any>?; adapter config (script: command; git: repoPath)',
        minIntervalSeconds: 'number?; source-side sampling, defaults per kind',
        token: 'string?; transport auth for HTTP emits (webhook kind gets one by default)',
      },
      output:
        '{ source, token? }; L2 — registers an explicit event source; the token is runtime-plane and never enters the kernel log',
    },
    removeExternalSource: {
      input: { sourceId: 'string', reason: 'string?' },
      output:
        '{ ok, source }; tombstones the source and stops its subscriptions (participant parity)',
    },
    emitExternalEvent: {
      input: {
        sourceId: 'string',
        topic: 'string?; must equal the source topic when present',
        payload:
          'Record<string, any>?; flat JSON, <=16KB, reserved keys sourceId/dedupeKey/subscriptionId/sessionId rejected',
        dedupeKey: 'string?; consecutive duplicates are dropped',
      },
      output:
        '{ ok: true, eventId, type } | { ok: false, dropped: true, reason }; the L2 ingestion choke point — accepted emits append one `external.<topic>` fact and ride the ordinary scheduler',
    },
    listTemplates: {
      input: {},
      output:
        '{ templates: TemplateDescriptor[] }; L6 — built-in relation templates plus user-saved ones, as data (name, tagline, slots) so the UI stays compile-free',
    },
    applyTemplate: {
      input: {
        templateId: 'string; a built-in template id or a saved tpl-* id',
        params:
          'Record<slotKey, any>?; slot values — session ids, external source ids, text, numbers, { everySeconds | dailyAt } for schedule slots',
      },
      output:
        '{ templateId, createdSessionIds, subscriptionIds, deliveredTo?, judgeSessionId?, state }; expands into ordinary commands (author_subscription / create_session / deliver+activate / the goal-loop preset) — no new kernel verbs. Handoff is a one-shot command (kernel doc §8.1): an immediate delivery + activation, no subscription remains',
    },
    saveTemplate: {
      input: {
        name: 'string',
        tagline: 'string?',
        subscriptionIds:
          'string[]; existing subscriptions to parameterize — distinct session endpoints become session slots, external sources become source slots',
      },
      output:
        '{ template: SavedTemplate, state }; runtime-plane config (snapshot-persisted, never a kernel fact)',
    },
    removeTemplate: {
      input: { templateId: 'string; a saved tpl-* id' },
      output: '{ ok, state }; no tombstone — nothing references a template after it compiled',
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
    getWorkspaceFiles: {
      input: {
        sessionId:
          'SessionId; resolves the selected chat node to its project cwd',
        maxDepth: 'number?; preview tree depth, clamped by runtime',
        maxEntries: 'number?; preview entry cap, clamped by runtime',
      },
      output:
        'WorkspaceFilesResult; recursive file count plus a bounded file tree preview',
    },
    getWorkspaceFileContent: {
      input: {
        sessionId:
          'SessionId; resolves the selected chat node to its project cwd',
        path: 'string; workspace-relative file path',
        maxBytes: 'number?; content byte cap, clamped by runtime',
      },
      output: 'WorkspaceFileContentResult; bounded UTF-8 file preview',
    },
    openWorkspace: {
      input: {
        cwd: 'string; project folder to open',
        target:
          '"vscode" | "cursor" | "windsurf" | "antigravity" | "finder" | "terminal" | "ghostty" | "xcode"',
      },
      output: '{ ok: boolean, cwd: string, target: OpenWorkspaceTarget }',
    },
    createTerminal: {
      input: {
        sessionId:
          'SessionId; selected chat this auxiliary terminal is attached to',
        cwd: 'string?; defaults to the selected session cwd',
      },
      output:
        'RuntimeTerminal; in-process terminal surface, not a graph session',
    },
    getTerminal: {
      input: { terminalId: 'string' },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    runTerminalCommand: {
      input: {
        terminalId: 'string',
        command: 'string; shell command line to send to the terminal',
      },
      output:
        '{ ok: boolean, terminal: RuntimeTerminal, commandId: string }',
    },
    writeTerminalInput: {
      input: {
        terminalId: 'string',
        input: 'string; raw stdin for the running shell',
      },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    clearTerminal: {
      input: { terminalId: 'string' },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    closeTerminal: {
      input: { terminalId: 'string' },
      output: '{ ok: boolean, terminal: RuntimeTerminal }',
    },
    getProviderSetupStatus: {
      input: {
        providerKind: 'ProviderKind; provider selected in the chat setup UI',
        providerInstanceId:
          'string?; provider instance selected in provider settings',
        cwd: 'string?; optional project cwd to validate against provider access',
      },
      output:
        'ProviderSetupStatus; binary/cwd/auth/account/MCP setup diagnostics for the selected provider',
    },
    upsertProviderInstance: {
      input: {
        providerInstanceId: 'string; stable provider instance id',
        kind: 'ProviderKind',
        label: 'string',
        binaryPath: 'string?',
        homePath: 'string?',
        shadowHomePath: 'string?',
        launchArgs: 'string[]?',
      },
      output: '{ providerInstance: ProviderInstance; state: GraphState }',
    },
    createMasterForCluster: {
      input: {
        clusterId: 'ClusterId',
        prompt: 'string?',
        cwd: 'string?; project cwd selected by the UI for the master session',
        agent: '"claude-code" | "codex" | "grok"?',
        providerKind: 'ProviderKind?',
        providerInstanceId: 'string?',
        runtimeSettings: 'ProviderRuntimeSettings?',
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
    'provider.instances.updated',
    'session.created',
    'session.resumed',
    'session.stream',
    'provider.runtime',
    'session.finished',
    'session.failed',
    'session.killed',
    'report.received',
    'freeze.applied',
    'edge.created',
    'edge.removed',
    'loop.started',
    'loop.stopped',
    'workflow.proposal.updated',
    'workflow.wakeup.updated',
    // Kernel event-log fact (G0): { type: 'kernel.event', event: KernelEvent }.
    // Deliberately carries no state payload; it mirrors the SQLite events row
    // { seq, id, ts, type, actor{kind,ref}, causeId?, reason?, payload }.
    'kernel.event',
    'terminal.created',
    'terminal.output',
    'terminal.command.finished',
    'terminal.exited',
    'terminal.closed',
    'terminal.cleared',
  ],
  readabilityFields: {
    GraphNode: {
      frozen: 'boolean?',
      freezeReason: 'string?',
      masterReason: 'string?',
    },
    AgentSession: {
      backend: '"claude-agent-sdk" | "codex-app-server" | "grok-acp"',
      providerKind: '"claude-code" | "codex" | "grok"',
      providerInstanceId: 'string',
      providerSessionId: 'string?',
      runtimeSettings: 'ProviderRuntimeSettings?',
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
    controlVersion: 0,
    updatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    sessions: {},
    providerInstances: defaultGraphProviderInstances.map((instance) => ({
      ...instance,
    })),
    providerModelCatalogs: {},
    clusters: {},
    reports: [],
    subscriptions: {},
    pendingActivations: {},
    planCouncils: {},
    workflowPlans: {},
    workflowProposals: {},
    workflowCapabilities: {},
    workflowWakeups: {},
    barriers: {},
    dynamicSpawnGroups: {},
    workspaceLeases: [],
    runQueue: [],
    usageFacts: [],
    resourcePolicies: {},
    schedulerMetrics: {
      queuedTotal: 0,
      admittedTotal: 0,
      rejectedTotal: 0,
      maxQueueDepth: 0,
      byReason: {},
    },
    sources: {},
    // L6 saved relation templates — runtime-plane config, snapshot-persisted.
    templates: {},
    // Transport secrets for the HTTP ingestion path — runtime-plane only,
    // never appended to the kernel log.
    sourceTokens: {},
  }
}
