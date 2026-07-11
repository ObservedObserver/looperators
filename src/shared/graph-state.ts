import type {
  ChatAttachment,
  NativeProviderEvent,
  ProviderInstance,
  ProviderEffectiveRuntimeConfig,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderRuntimeSettings,
  RuntimeRequestDecision,
  RuntimeActivity,
  RuntimePlan,
  RuntimeRequest,
  UserInputRequest,
  UserInputAnswerMap,
} from './provider-runtime';
import type { ReviewWorkflowStartInput } from '@shared/review-workflow';
import type { DraftGraph, DraftInstantiationMap } from '@shared/draft-graph';
import type { ConnectAgentsInput } from '@shared/agent-connection';
import type { GoalWorkflowStartInput, HandoffWorkflowStartInput } from '@shared/classic-workflow';

export const graphStateVersion = 7;

// Intent-layer enums (kernel doc §7.3), mirrored from shared/graph-state.ts.
export const subscriptionGates = ['auto', 'master', 'human'] as const;
export const subscriptionConcurrencies = ['coalesce', 'queue', 'drop', 'interrupt'] as const;
export const subscriptionOnStops = ['freeze-edge', 'freeze-target', 'freeze-cluster'] as const;
export const subscriptionStates = ['active', 'stopped'] as const;
export const subscriptionPatterns = ['finished', 'failed', 'report', 'delivered', 'schedule', 'external'] as const;

export const sessionStatuses = ['pending', 'running', 'idle', 'failed', 'killed'] as const;

export const reportTypes = ['verdict', 'relationship', 'info'] as const;

export const graphEdgeKinds = ['create-session', 'resume-session', 'report', 'freeze', 'link'] as const;

export const openWorkspaceTargetIds = ['vscode', 'cursor', 'windsurf', 'antigravity', 'finder', 'terminal', 'ghostty', 'xcode'] as const;

export const runtimeTerminalStatuses = ['running', 'exited', 'closed'] as const;

export const runtimeTerminalStreams = ['stdin', 'stdout', 'stderr', 'system'] as const;

export const defaultGraphProviderInstances: ProviderInstance[] = [
  {
    providerInstanceId: 'default-claude-sdk',
    kind: 'claude-code',
    label: 'Claude SDK',
  },
  {
    providerInstanceId: 'default-codex',
    kind: 'codex',
    label: 'Codex',
  },
  {
    providerInstanceId: 'legacy-claude-cli',
    kind: 'legacy-claude-cli',
    label: 'Claude CLI',
  },
];

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
    providerInstances: 'ProviderInstance[]; local provider runtime profiles',
    clusters: 'Record<ClusterId, Cluster>; Cluster.nodeIds are the managed scope nodes',
    reports: 'Report[]',
    subscriptions: 'Record<SubscriptionId, Subscription>; intent-layer edges (v7, kernel doc §7.3)',
    pendingActivations: 'Record<slotKey, PendingActivation>; one live slot per (subscription, target) (v7)',
    loops: 'LoopView[]?; derived on read, never stored — exact compiled Review/Goal instances plus generic cyclic SCCs',
    sources: 'Record<sourceId, ExternalSource>?; L2 registered external event sources (removed ones stay as tombstones)',
    templates: 'Record<templateId, SavedTemplate>?; L6 user-saved relation templates — runtime-plane config, snapshot-persisted, never kernel facts',
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
      input: 'verdict | relationship | info payload; runtime adds envelope and routes upward',
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
  },
  publicRuntimeApi: {
    linkSessions: {
      input: {
        source: 'SessionId',
        target: 'SessionId',
        label: 'string?; defaults to "link"',
        reason: 'string?; shown as edge detail',
      },
      output: '{ edge: GraphEdge }; idempotent for same source/target/label, a new reason refreshes the stored summary',
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
        workMode: '"local" | "worktree"?; UI intent, runtime resolves to final cwd',
        branch: 'string?; existing branch to use locally or as the base for a managed worktree',
        sourceSessionId: 'SessionId?; UI/runtime-only linked chat source, not accepted by membrane create_session',
        linkLabel: 'string?; UI/runtime-only create-session edge label, not accepted by membrane create_session',
        attachments: 'ChatAttachment[]?; structured provider-native attachments for the first turn',
        providerInstanceId: 'string?; selected provider runtime profile for this session',
        runtimeSettings: 'ProviderRuntimeSettings?; runtime mode, model, reasoning effort, sandbox/approval policy hints',
        effectiveRuntimeConfig: 'ProviderEffectiveRuntimeConfig?; provider-native runtime config actually applied by the adapter',
      },
    },
    getProjectContext: {
      input: {
        cwd: 'string?; project cwd selected by the UI',
      },
      output: 'ProjectContext; project name, git repo root, current branch, and local branch list',
    },
    chooseProjectFolder: {
      input: {},
      output: '{ canceled: boolean, cwd?: string }; opens a native folder picker for Project selection',
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
    getWorkingTreeDiff: {
      input: {
        sessionId: 'SessionId; resolves the selected chat node to its project cwd',
        ignoreWhitespace: 'boolean?',
        turnId: 'string?; when present returns the checkpoint diff for that provider turn',
      },
      output: 'WorkingTreeDiffResult; current cwd working tree now, checkpoint-compatible range metadata',
    },
    getWorkspaceFiles: {
      input: {
        sessionId: 'SessionId; resolves the selected chat node to its project cwd',
        maxDepth: 'number?; preview tree depth, clamped by runtime',
        maxEntries: 'number?; preview entry cap, clamped by runtime',
      },
      output: 'WorkspaceFilesResult; recursive file count plus a bounded file tree preview',
    },
    getWorkspaceFileContent: {
      input: {
        sessionId: 'SessionId; resolves the selected chat node to its project cwd',
        path: 'string; workspace-relative file path',
        maxBytes: 'number?; content byte cap, clamped by runtime',
      },
      output: 'WorkspaceFileContentResult; bounded UTF-8 file preview',
    },
    openWorkspace: {
      input: {
        cwd: 'string; project folder to open',
        target: '"vscode" | "cursor" | "windsurf" | "antigravity" | "finder" | "terminal" | "ghostty" | "xcode"',
      },
      output: '{ ok: boolean, cwd: string, target: OpenWorkspaceTarget }',
    },
    createTerminal: {
      input: {
        sessionId: 'SessionId; selected chat this auxiliary terminal is attached to',
        cwd: 'string?; defaults to the selected session cwd',
      },
      output: 'RuntimeTerminal; in-process terminal surface, not a graph session',
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
      output: '{ ok: boolean, terminal: RuntimeTerminal, commandId: string }',
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
        providerInstanceId: 'string?; provider instance selected in provider settings',
        cwd: 'string?; optional project cwd to validate against provider access',
      },
      output: 'ProviderSetupStatus; binary/cwd/auth/account/MCP setup diagnostics for the selected provider',
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
        agent: '"claude-code" | "codex"?',
        providerKind: 'ProviderKind?',
        providerInstanceId: 'string?',
        runtimeSettings: 'ProviderRuntimeSettings?',
        label: 'string?',
        loopPolicy: 'LoopPolicy?',
      },
    },
  },
  runtimeEvents: [
    'runtime.state',
    'provider.instances.updated',
    'session.created',
    'session.resumed',
    'session.stream',
    'session.finished',
    'session.failed',
    'session.killed',
    'report.received',
    'freeze.applied',
    'edge.created',
    'edge.removed',
    'loop.started',
    'loop.stopped',
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
} as const;

export type SessionId = string;
export type NodeId = SessionId;
export type ClusterId = string;
export type EdgeId = string;
export type CallId = string;

export type SessionStatus = (typeof sessionStatuses)[number];

export type AgentBackend = 'claude-cli' | 'claude-agent-sdk' | 'codex-app-server';
export type SessionRole = 'worker' | 'master';
export type WorkMode = 'local' | 'worktree';

export type SessionProject = {
  name: string;
  cwd: string;
  repoRoot?: string;
  workMode: WorkMode;
  baseBranch?: string;
  branch?: string;
};

export type SkillCallEnvelope = {
  callId: CallId;
  source: SessionId;
  ts: string;
};

export type Issue = {
  message: string;
  file?: string;
  line?: number;
  severity?: 'info' | 'warn' | 'error';
};

export type ReportPayload =
  | { type: 'verdict'; verdict: string; issues?: Issue[]; summary?: string }
  | {
      type: 'relationship';
      target: string;
      nature?: string;
      sessionRef?: SessionId;
    }
  | { type: 'info'; payload: unknown };

export type Report = {
  id: string;
  from: SessionId;
  envelope: SkillCallEnvelope;
  payload: ReportPayload;
};

export type FreezeState = {
  frozen?: boolean;
  freezeReason?: string;
  masterReason?: string;
};

export type LoopPolicy = {
  until?: { whenReport: { verdict: string } };
  onStop: 'freeze';
  maxIterations?: number;
};

export type LoopStatus = 'running' | 'stopped';

export type LoopEvent = {
  type: string;
  ts: string;
  sessionId?: SessionId;
  from?: SessionId;
  reportId?: string;
  targetId?: string;
  error?: string;
};

export type LoopState = {
  status: LoopStatus;
  iterations: number;
  coderSessionId?: SessionId;
  reviewerSessionId?: SessionId;
  lastEvent?: LoopEvent;
  lastProcessedEventKey?: string;
  reason?: string;
  startedAt?: string;
  stoppedAt?: string;
};

export type GraphNode = FreezeState & {
  nodeId: NodeId;
  sessionId: SessionId;
  label: string;
  role: SessionRole;
  agent: string;
  clusterId?: ClusterId;
  status: SessionStatus;
  position: { x: number; y: number };
};

export type GraphEdgeKind = (typeof graphEdgeKinds)[number];
export type OpenWorkspaceTarget = (typeof openWorkspaceTargetIds)[number];
export type RuntimeTerminalStatus = (typeof runtimeTerminalStatuses)[number];
export type RuntimeTerminalStream = (typeof runtimeTerminalStreams)[number];

export type GraphEdge = FreezeState & {
  edgeId: EdgeId;
  source: SessionId;
  target: SessionId;
  kind: GraphEdgeKind;
  call?: SkillCallEnvelope;
  label?: string;
  ts: string;
  reportId?: string;
  verdict?: string;
  issueCount?: number;
  summary?: string;
};

export type AgentStreamChunk = {
  id: string;
  sessionId: SessionId;
  ts: string;
  stream: 'stdout' | 'stderr';
  raw: string;
  eventType?: string;
  text?: string;
};

export type AgentMessageRole = 'user' | 'assistant' | 'system';

export type AgentMessage = {
  id: string;
  sessionId: SessionId;
  role: AgentMessageRole;
  content: string;
  attachments?: ChatAttachment[];
  ts: string;
  runId?: string;
  providerItemId?: string;
  phase?: string;
  status?: 'streaming' | 'complete' | 'failed';
};

export type AgentSession = {
  sessionId: SessionId;
  nodeId: NodeId;
  backend: AgentBackend;
  backendSessionId?: string;
  providerKind: ProviderKind;
  providerInstanceId: string;
  providerSessionId?: string;
  providerResumeCursor?: string;
  agent: string;
  label: string;
  prompt: string;
  cwd: string;
  project?: SessionProject;
  role: SessionRole;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  result?: string;
  chunks: AgentStreamChunk[];
  messages: AgentMessage[];
  nativeEvents: NativeProviderEvent[];
  runtimeEvents: ProviderRuntimeEvent[];
  runtimeActivities: RuntimeActivity[];
  runtimeRequests: RuntimeRequest[];
  runtimeUserInputRequests: UserInputRequest[];
  runtimePlans: RuntimePlan[];
  runtimeSettings?: ProviderRuntimeSettings;
  effectiveRuntimeConfig?: ProviderEffectiveRuntimeConfig;
  archived?: boolean;
  // Runtime-created workflow participants can exist without a provider turn
  // until their first relationship activation. The UI renders these as
  // waiting Agents; ordinary createSession never exposes this transient.
  prepared?: boolean;
};

export type RuntimeTerminalChunk = {
  id: string;
  terminalId: string;
  sessionId: SessionId;
  ts: string;
  stream: RuntimeTerminalStream;
  text: string;
};

export type RuntimeTerminalCommand = {
  commandId: string;
  command: string;
  status: 'running' | 'finished';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
};

export type RuntimeTerminal = {
  terminalId: string;
  sessionId: SessionId;
  cwd: string;
  shell: string;
  prompt: string;
  status: RuntimeTerminalStatus;
  createdAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  chunks: RuntimeTerminalChunk[];
  currentCommand?: RuntimeTerminalCommand;
  lastCommand?: RuntimeTerminalCommand;
};

export type Cluster = {
  clusterId: ClusterId;
  label: string;
  nodeIds: NodeId[];
  masterSessionId?: SessionId;
  loopPolicy?: LoopPolicy;
  loopState?: LoopState;
  frozen?: boolean;
  freezeReason?: string;
};

export type RuntimeStateDiagnostic = {
  id: string;
  type: string;
  message: string;
  ts: string;
  details?: Record<string, unknown>;
};

// Intent-layer edge (kernel doc §7.3): the stored rule "when source emits
// this event, target should be delivered to / activated", with its guards.
export type SubscriptionGate = (typeof subscriptionGates)[number];
export type SubscriptionConcurrency = (typeof subscriptionConcurrencies)[number];
export type SubscriptionOnStop = (typeof subscriptionOnStops)[number];

export type SubscriptionSourceRef =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'cluster'; clusterId: ClusterId }
  // L1: the clock as a trigger origin; paired exclusively with `schedule`.
  | { kind: 'timer' }
  // L2: a registered external source; paired exclusively with `external`.
  | { kind: 'external'; sourceId: string };

export type SubscriptionPattern =
  | { on: 'finished' }
  | { on: 'failed' }
  | { on: 'report'; match?: { type?: string; verdict?: string } }
  | { on: 'delivered'; topic?: string }
  // Exactly one schedule form: an interval, or a wall-clock daily time
  // ('HH:MM', runtime-host local) — the cron-shaped case.
  | { on: 'schedule'; everySeconds?: number; dailyAt?: string }
  // L2: `external.<topic>` facts from the edge's source; match is strict
  // string equality on payload fields.
  | { on: 'external'; topic?: string; match?: Record<string, string> };

// L2 registered external event source (facts are `external.<topic>`).
// Removed sources stay as tombstones so stopped edges keep their origin.
export type ExternalSourceKind = 'script' | 'git' | 'webhook' | 'manual';

export type ExternalSource = {
  id: string;
  kind: ExternalSourceKind;
  topic: string;
  label?: string;
  config: Record<string, any>;
  minIntervalSeconds?: number;
  state: 'active' | 'removed';
  createdAt: string;
  lastEventAt?: string;
  lastDedupeKey?: string;
  // Adapter-side operational error (runtime-plane; cleared on the next
  // accepted emit).
  lastError?: string;
};

export type RegisterExternalSourceInput = {
  id?: string;
  kind: ExternalSourceKind;
  topic?: string;
  label?: string;
  config?: Record<string, any>;
  minIntervalSeconds?: number;
  token?: string;
};

export type RegisterExternalSourceResult = {
  source: ExternalSource;
  token?: string;
};

export type EmitExternalEventInput = {
  sourceId: string;
  topic?: string;
  payload?: Record<string, any>;
  dedupeKey?: string;
};

export type EmitExternalEventResult = { ok: true; eventId?: string; type: string } | { ok: false; dropped: true; reason: string };

// L6 relation template library. Built-in templates and user-saved ones are
// served as data (descriptors with slot definitions) so the renderer stays
// compile-free: it renders slot forms and calls applyTemplate; the runtime
// owns the single compile face (shared/templates.ts).
export type TemplateSlotKind = 'session' | 'text' | 'longtext' | 'number' | 'schedule' | 'external-source';

export type TemplateSlot = {
  key: string;
  label: string;
  kind: TemplateSlotKind;
  required: boolean;
  placeholder?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  help?: string;
};

export type TemplateDescriptor = {
  id: string;
  name: string;
  tagline: string;
  handsOff: string;
  builtin: boolean;
  slots: TemplateSlot[];
  savedFields?: SavedWorkflowFields;
  workflowSpec?: SavedWorkflowSpec;
};

export type SavedWorkflowFields = {
  kind: 'review' | 'goal' | 'relationship';
  relationshipCount: number;
  maxLaps?: number;
  instructions: string[];
};

export type SavedWorkflowSpec =
  | { version: 1; kind: 'handoff'; input: HandoffWorkflowStartInput }
  | { version: 1; kind: 'goal-loop'; input: GoalWorkflowStartInput }
  | { version: 1; kind: 'review-until-clean'; input: ReviewWorkflowStartInput };

// A user-saved template: parameterized subscriptions (session endpoints
// became session slots, external sources became source slots). Runtime-plane
// config — snapshot-persisted, never a kernel fact.
export type SavedTemplate = {
  id: string;
  name: string;
  tagline?: string;
  createdAt: string;
  slots: TemplateSlot[];
  subscriptions: Array<Record<string, any>>;
  savedFields?: SavedWorkflowFields;
  workflowSpec?: SavedWorkflowSpec;
};

export type ListTemplatesResult = { templates: TemplateDescriptor[] };

export type ApplyTemplateInput = {
  templateId: string;
  // Slot values: session ids, external source ids, text, numbers, or
  // { everySeconds | dailyAt } for schedule slots.
  params?: Record<string, any>;
};

export type ApplyTemplateResult = {
  templateId: string;
  createdSessionIds: SessionId[];
  subscriptionIds: string[];
  // Sessions that received a one-shot handoff (delivery + activation);
  // handoffs are commands, not subscriptions, so nothing standing remains.
  deliveredTo?: SessionId[];
  judgeSessionId?: SessionId;
  state: GraphState;
};

export type StartReviewWorkflowInput = ReviewWorkflowStartInput;

export type StartReviewWorkflowResult = {
  coderSessionId: SessionId;
  reviewerSessionId: SessionId;
  createdSessionIds: SessionId[];
  subscriptionIds: string[];
  loop?: LoopView;
  state: GraphState;
};

export type StartDraftWorkflowInput = {
  graph: DraftGraph;
};

export type StartDraftWorkflowResult = {
  mapping: DraftInstantiationMap;
  createdSessionIds: SessionId[];
  subscriptionIds: string[];
  state: GraphState;
};

export type { ConnectAgentsInput };

export type ConnectAgentsResult = {
  targetSessionId: SessionId;
  createdSessionIds: SessionId[];
  subscriptionIds: string[];
  state: GraphState;
};

export type SaveTemplateInput = {
  name: string;
  tagline?: string;
  subscriptionIds?: string[];
  workflowSpec?: SavedWorkflowSpec;
};

export type SaveTemplateResult = {
  template: SavedTemplate;
  state: GraphState;
};

export type Subscription = {
  id: string;
  source: SubscriptionSourceRef;
  on: SubscriptionPattern;
  target: { kind: 'session'; sessionId: SessionId };
  action: { kind: 'deliver' | 'deliver+activate'; topic?: string; note?: string };
  gate: SubscriptionGate;
  concurrency: SubscriptionConcurrency;
  stop?: { whenReport?: { verdict: string }; maxFirings?: number; deadline?: string };
  onStop: SubscriptionOnStop;
  state: 'active' | 'stopped';
  firings: number;
  label?: string;
  createdAt: string;
  // Timer subscriptions: when the last tick fired (drives the next-tick anchor).
  lastTickAt?: string;
};

export type PendingActivation = {
  slotKey: string;
  subscriptionId: string;
  target: SessionId;
  triggerEventId: string;
  gate: SubscriptionGate;
  masterSessionId?: SessionId;
  status: 'pending' | 'approved';
  createdAt: string;
};

// --- L4 loop view: the ring as a readable whole (thin projection; the
// runtime derives these from subscriptions on every read, nothing stored) ---

export type LoopViewStatus = 'spinning' | 'waiting-gate' | 'frozen' | 'stopped' | 'idle';
export type LoopViewKind = 'review' | 'goal' | 'generic';

export type LoopView = {
  // Compiled workflows use their forward relationship id; generic rings use
  // sorted member ids.
  loopId: string;
  kind: LoopViewKind;
  memberSessionIds: SessionId[];
  // Ring edges, stopped ones included (a guardrail-stopped ring keeps its face).
  subscriptionIds: string[];
  // The subscription whose firings count laps.
  designatedSubscriptionId: string;
  lapCount: number;
  lapCap?: number;
  status: LoopViewStatus;
  statusDetail?: string;
  stopSummary?: string;
  createdAt?: string;
  terminal?: { type: string; ts: string; reason?: string };
};

export type LoopHop = {
  activatedEventId: string;
  activatedSeq: number;
  causeId?: string;
  slotKey?: string;
  ts: string;
  subscriptionId: string;
  target: SessionId;
  trigger?: { eventId: string; type?: string; ts?: string; reason?: string; sourceSessionId?: SessionId };
  gate?: { actor: KernelEvent['actor']; reason?: string; ts: string };
  outcome?: { type: 'finished' | 'failed'; ts: string };
  reports: Array<{ reportId?: string; from?: SessionId; verdict?: string; summary?: string; ts: string }>;
};

export type LoopLap = {
  index: number;
  startTs: string;
  hops: LoopHop[];
};

export type LoopTimeline = {
  loopId: string;
  laps: LoopLap[];
  refusals: Array<{ type: 'denied' | 'dropped' | 'superseded'; subscriptionId: string; ts: string; reason?: string; actor: KernelEvent['actor'] }>;
  stops: Array<{ type: string; subscriptionId: string; ts: string; reason?: string }>;
};

export type LoopTimelineResult = {
  loop: LoopView;
  timeline: LoopTimeline;
};

// L3 goal loop preset: one natural-language goal compiles into a judge
// session plus two subscriptions; stopping stays deterministic
// (whenReport done + maxFirings). No new kernel verbs are involved.
export type CreateGoalLoopInput = {
  workerSessionId: SessionId;
  goal: string;
  maxLaps?: number;
  gate?: SubscriptionGate;
  onStop?: SubscriptionOnStop;
  judgeProviderInstanceId?: string;
  judgeModel?: string;
};

export type CreateGoalLoopResult = {
  judgeSessionId: SessionId;
  checkSubscription: Subscription;
  retrySubscription: Subscription;
  state: GraphState;
};

export type StartHandoffWorkflowInput = HandoffWorkflowStartInput;
export type StartHandoffWorkflowResult = {
  sourceSessionId: SessionId;
  targetSessionId: SessionId;
  createdSessionIds: SessionId[];
  subscriptionIds: string[];
  deliveredTo: SessionId[];
  state: GraphState;
};

export type StartGoalWorkflowInput = GoalWorkflowStartInput;
export type StartGoalWorkflowResult = {
  workerSessionId: SessionId;
  judgeSessionId: SessionId;
  createdSessionIds: SessionId[];
  subscriptionIds: string[];
  loop?: LoopView;
  state: GraphState;
};

export type GraphState = {
  version: number;
  updatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sessions: Record<SessionId, AgentSession>;
  providerInstances: ProviderInstance[];
  clusters: Record<ClusterId, Cluster>;
  reports: Report[];
  subscriptions?: Record<string, Subscription>;
  pendingActivations?: Record<string, PendingActivation>;
  loops?: LoopView[];
  sources?: Record<string, ExternalSource>;
  templates?: Record<string, SavedTemplate>;
  diagnostics?: RuntimeStateDiagnostic[];
};

export type CreateRuntimeSessionInput = {
  prompt: string;
  cwd?: string;
  workMode?: WorkMode;
  branch?: string;
  agent?: 'claude-code' | 'codex';
  providerKind?: ProviderKind;
  providerInstanceId?: string;
  runtimeSettings?: ProviderRuntimeSettings;
  label?: string;
  context?: string;
  attachments?: ChatAttachment[];
  sourceSessionId?: SessionId;
  linkLabel?: string;
  cluster?: ClusterId;
  role?: SessionRole;
};

export type CreateRuntimeSessionResult = {
  sessionId: SessionId;
  state: GraphState;
};

export type ProjectContextInput = {
  cwd?: string;
};

export type ProjectContext = {
  cwd: string;
  projectName: string;
  isGitRepo: boolean;
  repoRoot?: string;
  currentBranch?: string;
  branches: string[];
  error?: string;
};

export type ProviderSetupCheckStatus = 'ok' | 'warning' | 'error' | 'unknown';

export type ProviderSetupCheck = {
  id: string;
  label: string;
  status: ProviderSetupCheckStatus;
  message: string;
  detail?: string;
};

export type ProviderSetupStatusInput = {
  providerKind: ProviderKind;
  providerInstanceId?: string;
  cwd?: string;
};

export type ProviderSetupStatus = {
  providerKind: ProviderKind;
  providerInstanceId?: string;
  generatedAt: string;
  checks: ProviderSetupCheck[];
};

export type UpsertProviderInstanceInput = ProviderInstance;

export type ResumeRuntimeSessionInput = {
  sessionId: SessionId;
  message: string;
  context?: string;
  attachments?: ChatAttachment[];
};

export type RespondRuntimeRequestInput = {
  sessionId: SessionId;
  requestId: string;
  decision: RuntimeRequestDecision;
};

export type AnswerUserInputInput = {
  sessionId: SessionId;
  requestId: string;
  answer?: string;
  answers?: UserInputAnswerMap;
};

export type ArchiveRuntimeSessionInput = {
  sessionId: SessionId;
  archived?: boolean;
};

export type UpsertClusterInput = {
  clusterId?: ClusterId;
  label?: string;
  nodeIds: NodeId[];
  loopPolicy?: LoopPolicy;
};

export type CreateMasterForClusterInput = {
  clusterId: ClusterId;
  prompt?: string;
  cwd?: string;
  agent?: 'claude-code' | 'codex';
  providerKind?: ProviderKind;
  providerInstanceId?: string;
  runtimeSettings?: ProviderRuntimeSettings;
  label?: string;
  loopPolicy?: LoopPolicy;
};

export type AssignMasterToClusterInput = {
  clusterId: ClusterId;
  sessionId: SessionId;
};

export type SetClusterLoopPolicyInput = {
  clusterId: ClusterId;
  loopPolicy: LoopPolicy;
};

export type UpdateNodePositionsInput = {
  positions: {
    nodeId: NodeId;
    position: { x: number; y: number };
  }[];
};

export type StartMasterLoopInput = {
  clusterId: ClusterId;
  reason?: string;
};

export type StopMasterLoopInput = {
  clusterId: ClusterId;
  reason?: string;
  killRunning?: boolean;
};

export type StopLoopInput = {
  loopId: string;
  reason?: string;
  killRunning?: boolean;
};

export type FreezeInput = {
  target: SessionId | ClusterId;
  reason?: string;
  source?: SessionId;
  masterReason?: string;
};

export type DiffRange =
  | {
      kind: 'working-tree';
      base: 'HEAD';
      target: 'workspace';
    }
  | {
      kind: 'checkpoint';
      fromCheckpointRef: string;
      toCheckpointRef: string;
      fromTurnCount?: number;
      toTurnCount?: number;
    };

export type WorkingTreeDiffFile = {
  path: string;
  previousPath?: string;
  changeType: string;
  additions: number;
  deletions: number;
};

export type WorkingTreeDiffResult = {
  sessionId: SessionId;
  cwd: string;
  repoRoot: string;
  generatedAt: string;
  range: DiffRange;
  files: WorkingTreeDiffFile[];
  totals: {
    files: number;
    additions: number;
    deletions: number;
  };
  statusEntries: string[];
  patch: string;
  truncated: boolean;
};

export type WorkingTreeDiffInput = {
  sessionId: SessionId;
  ignoreWhitespace?: boolean;
  turnId?: string;
};

export type WorkspaceFileKind = 'file' | 'directory' | 'symlink' | 'other';

export type WorkspaceFileEntry = {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  size?: number;
  children?: WorkspaceFileEntry[];
};

export type WorkspaceFilesInput = {
  sessionId: SessionId;
  maxDepth?: number;
  maxEntries?: number;
};

export type WorkspaceFilesResult = {
  sessionId: SessionId;
  cwd: string;
  generatedAt: string;
  totalFiles: number;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  ignoredDirectories: string[];
};

export type WorkspaceFileContentInput = {
  sessionId: SessionId;
  path: string;
  maxBytes?: number;
};

export type WorkspaceFileContentResult = {
  sessionId: SessionId;
  cwd: string;
  path: string;
  generatedAt: string;
  size: number;
  content: string;
  truncated: boolean;
  isBinary: boolean;
};

export type OpenWorkspaceInput = {
  cwd: string;
  target: OpenWorkspaceTarget;
};

export type OpenWorkspaceResult = {
  ok: boolean;
  cwd: string;
  target: OpenWorkspaceTarget;
  platform: string;
};

export type CreateTerminalInput = {
  sessionId: SessionId;
  cwd?: string;
};

export type GetTerminalInput = {
  terminalId: string;
};

export type RunTerminalCommandInput = {
  terminalId: string;
  command: string;
};

export type WriteTerminalInput = {
  terminalId: string;
  input: string;
};

export type ClearTerminalInput = {
  terminalId: string;
};

export type CloseTerminalInput = {
  terminalId: string;
};

export type RuntimeTerminalResult = {
  ok: boolean;
  terminal: RuntimeTerminal;
};

export type RunTerminalCommandResult = RuntimeTerminalResult & {
  commandId: string;
};

// One row of the kernel event log (SQLite `events` table, kernel doc §7.1):
// the append-only record of graph-level facts with actor + causal chain.
export type KernelEvent = {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor: {
    kind: 'human' | 'master' | 'agent' | 'rule' | 'provider' | 'runtime';
    ref?: string;
  };
  causeId?: string;
  reason?: string;
  payload: Record<string, unknown>;
};

export type RuntimeEvent =
  | { type: 'runtime.state'; state: GraphState }
  | { type: 'provider.instances.updated'; state: GraphState }
  | { type: 'session.created'; sessionId: SessionId; state: GraphState }
  | { type: 'session.resumed'; sessionId: SessionId; state: GraphState }
  | {
      type: 'session.stream';
      sessionId: SessionId;
      chunk: AgentStreamChunk;
      providerEvents?: ProviderRuntimeEvent[];
    }
  | {
      type: 'provider.runtime';
      sessionId: SessionId;
      providerEvent: ProviderRuntimeEvent;
    }
  | { type: 'session.finished'; sessionId: SessionId; state: GraphState }
  | {
      type: 'session.failed';
      sessionId: SessionId;
      error: string;
      state: GraphState;
    }
  | { type: 'session.killed'; sessionId: SessionId; state: GraphState }
  | { type: 'report.received'; from: SessionId; report: Report; state: GraphState }
  | { type: 'freeze.applied'; targetId: string; reason?: string; state: GraphState }
  | { type: 'edge.created'; edgeId: string; state: GraphState }
  | { type: 'edge.removed'; edgeId: string; state: GraphState }
  | { type: 'loop.started'; clusterId: ClusterId; state: GraphState }
  | {
      type: 'loop.stopped';
      clusterId: ClusterId;
      reason?: string;
      state: GraphState;
    }
  | { type: 'kernel.event'; event: KernelEvent }
  | { type: 'terminal.created'; terminal: RuntimeTerminal }
  | {
      type: 'terminal.output';
      terminalId: string;
      sessionId: SessionId;
      chunk: RuntimeTerminalChunk;
      terminal: RuntimeTerminal;
    }
  | {
      type: 'terminal.command.finished';
      terminalId: string;
      sessionId: SessionId;
      command: RuntimeTerminalCommand;
      terminal: RuntimeTerminal;
    }
  | {
      type: 'terminal.exited';
      terminalId: string;
      sessionId: SessionId;
      terminal: RuntimeTerminal;
    }
  | {
      type: 'terminal.closed';
      terminalId: string;
      sessionId: SessionId;
      terminal: RuntimeTerminal;
    }
  | {
      type: 'terminal.cleared';
      terminalId: string;
      sessionId: SessionId;
      terminal: RuntimeTerminal;
    };

export function createEmptyGraphState(): GraphState {
  return {
    version: graphStateVersion,
    updatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    sessions: {},
    providerInstances: defaultGraphProviderInstances.map((instance) => ({
      ...instance,
    })),
    clusters: {},
    reports: [],
    subscriptions: {},
    pendingActivations: {},
  };
}
