import { useEffect, useMemo, useState } from 'react';

import type {
  AnswerUserInputInput,
  ArchiveRuntimeSessionInput,
  AssignMasterToClusterInput,
  ClearTerminalInput,
  CloseTerminalInput,
  CreateTerminalInput,
  CreateMasterForClusterInput,
  CreateRuntimeSessionInput,
  CreateRuntimeSessionResult,
  FreezeInput,
  UnfreezeInput,
  GetTerminalInput,
  CreateGoalLoopInput,
  CreateGoalLoopResult,
  EmitExternalEventInput,
  EmitExternalEventResult,
  GraphState,
  KernelEvent,
  LoopTimelineResult,
  OpenWorkspaceInput,
  OpenWorkspaceResult,
  ProviderSetupStatus,
  ProviderSetupStatusInput,
  ProjectContext,
  ProjectContextInput,
  ApplyTemplateInput,
  ApplyTemplateResult,
  ListTemplatesResult,
  RegisterExternalSourceInput,
  RegisterExternalSourceResult,
  SaveTemplateInput,
  SaveTemplateResult,
  RespondRuntimeRequestInput,
  ResumeRuntimeSessionInput,
  RuntimeEvent,
  RuntimeTerminalResult,
  RunTerminalCommandInput,
  RunTerminalCommandResult,
  SessionId,
  SetClusterLoopPolicyInput,
  StartMasterLoopInput,
  StartReviewWorkflowInput,
  StartReviewWorkflowResult,
  StartPlanCouncilInput,
  StartPlanCouncilResult,
  StartDraftWorkflowInput,
  StartDraftWorkflowResult,
  StartHandoffWorkflowInput,
  StartHandoffWorkflowResult,
  StartGoalWorkflowInput,
  StartGoalWorkflowResult,
  ConnectAgentsInput,
  ConnectAgentsResult,
  StopMasterLoopInput,
  StopLoopInput,
  UpdateNodePositionsInput,
  UpsertProviderInstanceInput,
  UpsertClusterInput,
  WorkspaceFileContentInput,
  WorkspaceFileContentResult,
  WorkspaceFilesInput,
  WorkspaceFilesResult,
  WriteTerminalInput,
  WorkingTreeDiffInput,
  WorkingTreeDiffResult,
} from '@/shared/graph-state';
import type { PlanCouncil } from '@shared/plan-council';
import type { ProviderInstance } from '@/shared/provider-runtime';

const defaultRuntimeUrl = 'http://127.0.0.1:48274';

export type RuntimeWorkspaceMetadata = {
  defaultCwd?: string;
};

export type RuntimeConfig = {
  platform?: string;
  workspace?: RuntimeWorkspaceMetadata;
};

export type KernelEventsInput = { since?: number; limit?: number; tail?: boolean };
export type KernelEventsResult = { events: KernelEvent[]; latestSeq: number };

export type RuntimeApi = {
  getState: () => Promise<GraphState>;
  getKernelEvents: (input?: KernelEventsInput) => Promise<KernelEventsResult>;
  dispatchCommand: (input: { commandId?: string; idempotencyKey?: string; expectedVersion?: number; kind: string; reason?: string; input?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  getLoopTimeline: (input: { loopId: string }) => Promise<LoopTimelineResult>;
  createGoalLoop: (input: CreateGoalLoopInput) => Promise<CreateGoalLoopResult>;
  startReviewWorkflow: (input: StartReviewWorkflowInput) => Promise<StartReviewWorkflowResult>;
  startPlanCouncil: (input: StartPlanCouncilInput) => Promise<StartPlanCouncilResult>;
  getPlanCouncil: (input: { workflowId: string }) => Promise<{ council: PlanCouncil }>;
  getPlanCouncilArtifact: (input: { workflowId: string; artifactId: string }) => Promise<{ artifact: PlanCouncil['artifacts'][number]; content: string }>;
  startPlanCouncilCrossReview: (input: { workflowId: string }) => Promise<{ council: PlanCouncil; state: GraphState }>;
  startPlanCouncilSynthesis: (input: { workflowId: string }) => Promise<{ council: PlanCouncil; state: GraphState }>;
  stopPlanCouncil: (input: { workflowId: string; reason?: string }) => Promise<{ council: PlanCouncil; state: GraphState }>;
  startDraftWorkflow: (input: StartDraftWorkflowInput) => Promise<StartDraftWorkflowResult>;
  startHandoffWorkflow: (input: StartHandoffWorkflowInput) => Promise<StartHandoffWorkflowResult>;
  startGoalWorkflow: (input: StartGoalWorkflowInput) => Promise<StartGoalWorkflowResult>;
  connectAgents: (input: ConnectAgentsInput) => Promise<ConnectAgentsResult>;
  registerExternalSource: (input: RegisterExternalSourceInput) => Promise<RegisterExternalSourceResult>;
  removeExternalSource: (input: { sourceId: string; reason?: string }) => Promise<{ ok: boolean }>;
  emitExternalEvent: (input: EmitExternalEventInput) => Promise<EmitExternalEventResult>;
  listTemplates: () => Promise<ListTemplatesResult>;
  applyTemplate: (input: ApplyTemplateInput) => Promise<ApplyTemplateResult>;
  saveTemplate: (input: SaveTemplateInput) => Promise<SaveTemplateResult>;
  removeTemplate: (input: { templateId: string }) => Promise<{ ok: boolean; state: GraphState }>;
  getProjectContext: (input: ProjectContextInput) => Promise<ProjectContext>;
  getProviderSetupStatus: (input: ProviderSetupStatusInput) => Promise<ProviderSetupStatus>;
  upsertProviderInstance: (input: UpsertProviderInstanceInput) => Promise<{ providerInstance: ProviderInstance; state: GraphState }>;
  chooseProjectFolder: () => Promise<{ canceled: boolean; cwd?: string }>;
  createSession: (input: CreateRuntimeSessionInput) => Promise<CreateRuntimeSessionResult>;
  resumeSession: (input: ResumeRuntimeSessionInput) => Promise<{ ok: boolean; state: GraphState }>;
  archiveSession: (input: ArchiveRuntimeSessionInput) => Promise<{ ok: boolean; state: GraphState }>;
  killSession: (sessionId: SessionId) => Promise<{ ok: boolean; state: GraphState }>;
  respondRuntimeRequest: (input: RespondRuntimeRequestInput) => Promise<{ ok: boolean; state: GraphState }>;
  answerUserInput: (input: AnswerUserInputInput) => Promise<{ ok: boolean; state: GraphState }>;
  upsertCluster: (input: UpsertClusterInput) => Promise<{ clusterId: string; state: GraphState }>;
  createMasterForCluster: (input: CreateMasterForClusterInput) => Promise<{ sessionId: SessionId; state: GraphState }>;
  assignMasterToCluster: (input: AssignMasterToClusterInput) => Promise<{ state: GraphState }>;
  setClusterLoopPolicy: (input: SetClusterLoopPolicyInput) => Promise<{ state: GraphState }>;
  updateNodePositions: (input: UpdateNodePositionsInput) => Promise<{ state: GraphState }>;
  startMasterLoop: (input: StartMasterLoopInput) => Promise<{ state: GraphState }>;
  stopMasterLoop: (input: StopMasterLoopInput) => Promise<{ state: GraphState }>;
  stopLoop: (input: StopLoopInput) => Promise<{ state: GraphState }>;
  stopSubscription: (input: { subscriptionId: string; reason?: string }) => Promise<{ ok: boolean; state: GraphState }>;
  freeze: (input: FreezeInput) => Promise<{ ok: boolean; state: GraphState }>;
  unfreeze: (input: UnfreezeInput) => Promise<{ ok: boolean; state: GraphState }>;
  cleanupChannels: (input: { sessionId?: string; maxReadAgeDays?: number; maxReadEntries?: number; keepLatestReadPerTopic?: boolean; reason?: string }) => Promise<{ ok: boolean; removedDeliveries: number; removedBytes: number; state: GraphState }>;
  getWorkingTreeDiff: (input: WorkingTreeDiffInput) => Promise<WorkingTreeDiffResult>;
  getWorkspaceFiles: (input: WorkspaceFilesInput) => Promise<WorkspaceFilesResult>;
  getWorkspaceFileContent: (input: WorkspaceFileContentInput) => Promise<WorkspaceFileContentResult>;
  openWorkspace: (input: OpenWorkspaceInput) => Promise<OpenWorkspaceResult>;
  createTerminal: (input: CreateTerminalInput) => Promise<RuntimeTerminalResult>;
  getTerminal: (input: GetTerminalInput) => Promise<RuntimeTerminalResult>;
  runTerminalCommand: (input: RunTerminalCommandInput) => Promise<RunTerminalCommandResult>;
  writeTerminalInput: (input: WriteTerminalInput) => Promise<RuntimeTerminalResult>;
  clearTerminal: (input: ClearTerminalInput) => Promise<RuntimeTerminalResult>;
  closeTerminal: (input: CloseTerminalInput) => Promise<RuntimeTerminalResult>;
  onEvent: (listener: (event: RuntimeEvent) => void) => () => void;
};

export type ElectronOrreryApi = {
  platform: string;
  workspace?: RuntimeWorkspaceMetadata;
  runtime: RuntimeApi;
};

type ElectronRuntimeClient = {
  kind: 'electron';
  isAvailable: true;
  platform: string;
  workspace: RuntimeWorkspaceMetadata;
  runtime: RuntimeApi;
};

type HttpRuntimeClient = {
  kind: 'http';
  isAvailable: true;
  platform: string;
  runtimeUrl: string;
  workspace: RuntimeWorkspaceMetadata;
  runtime: RuntimeApi;
  getConfig: () => Promise<RuntimeConfig>;
};

type ConnectingRuntimeClient = {
  kind: 'connecting';
  isAvailable: false;
  runtimeUrl: string;
  workspace: RuntimeWorkspaceMetadata;
  runtime?: undefined;
  platform?: undefined;
  error?: undefined;
};

type UnavailableRuntimeClient = {
  kind: 'unavailable';
  isAvailable: false;
  workspace: RuntimeWorkspaceMetadata;
  runtime?: undefined;
  platform?: undefined;
  runtimeUrl?: string;
  error?: string;
};

export type RuntimeClient = ElectronRuntimeClient | HttpRuntimeClient | ConnectingRuntimeClient | UnavailableRuntimeClient;

const unavailableRuntimeClient: RuntimeClient = {
  kind: 'unavailable',
  isAvailable: false,
  workspace: {},
};

type JsonRecord = Record<string, unknown>;

let cachedHttpRuntimeClient: HttpRuntimeClient | undefined;

const runtimeEventTypes: RuntimeEvent['type'][] = [
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
  'plan-council.updated',
  'workflow.proposal.updated',
  'workflow.wakeup.updated',
  'kernel.event',
  'terminal.created',
  'terminal.output',
  'terminal.command.finished',
  'terminal.exited',
  'terminal.closed',
  'terminal.cleared',
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRuntimeUrl() {
  const configured = import.meta.env.VITE_ORRERY_RUNTIME_URL?.trim() || import.meta.env.VITE_ORRERY_RUNTIME_HTTP_URL?.trim();
  const rawUrl = configured && configured.length > 0 ? configured : defaultRuntimeUrl;
  const base = typeof window !== 'undefined' ? window.location.href : defaultRuntimeUrl;

  return new URL(rawUrl, base).toString().replace(/\/+$/, '');
}

function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  if (!isRecord(value)) {
    return {};
  }

  const workspace = isRecord(value.workspace)
    ? {
        defaultCwd: typeof value.workspace.defaultCwd === 'string' ? value.workspace.defaultCwd : undefined,
      }
    : {
        defaultCwd: typeof value.defaultCwd === 'string' ? value.defaultCwd : undefined,
      };

  return {
    platform: typeof value.platform === 'string' ? value.platform : undefined,
    workspace,
  };
}

function normalizeGraphState(value: unknown): GraphState {
  if (isRecord(value) && isRecord(value.state)) {
    return value.state as GraphState;
  }

  return value as GraphState;
}

function responseErrorMessage(method: string, path: string, status: number, body: unknown) {
  const prefix = `looperators runtime ${method} ${path} failed (${status})`;
  if (isRecord(body)) {
    const detail = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : undefined;
    return detail ? `${prefix}: ${detail}` : prefix;
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return `${prefix}: ${body.trim()}`;
  }

  return prefix;
}

function parseSseRuntimeEvent(event: MessageEvent<string>): RuntimeEvent | undefined {
  if (!event.data || event.data.trim().length === 0) {
    return undefined;
  }

  const value = JSON.parse(event.data) as unknown;
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.type === 'string') {
    return value as RuntimeEvent;
  }

  if (runtimeEventTypes.includes(event.type as RuntimeEvent['type'])) {
    return { ...value, type: event.type } as RuntimeEvent;
  }

  return undefined;
}

class HttpRuntimeApi implements RuntimeApi {
  readonly #baseUrl: string;
  #configPromise: Promise<RuntimeConfig> | undefined;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  getConfig() {
    this.#configPromise ??= this.#get('config')
      .then(normalizeRuntimeConfig)
      .catch((error) => {
        this.#configPromise = undefined;
        throw error;
      });
    return this.#configPromise;
  }

  async getState() {
    return normalizeGraphState(await this.#get('state'));
  }

  getProjectContext(input: ProjectContextInput) {
    return this.#post<ProjectContext>('project-context', input);
  }

  getProviderSetupStatus(input: ProviderSetupStatusInput) {
    return this.#post<ProviderSetupStatus>('provider-setup-status', input);
  }

  upsertProviderInstance(input: UpsertProviderInstanceInput) {
    return this.#post<{ providerInstance: ProviderInstance; state: GraphState }>('provider-instances', input);
  }

  async chooseProjectFolder() {
    return { canceled: true };
  }

  createSession(input: CreateRuntimeSessionInput) {
    return this.#post<CreateRuntimeSessionResult>('sessions', input);
  }

  resumeSession(input: ResumeRuntimeSessionInput) {
    return this.#post<{ ok: boolean; state: GraphState }>(`sessions/${encodeURIComponent(input.sessionId)}/resume`, input);
  }

  archiveSession(input: ArchiveRuntimeSessionInput) {
    return this.#post<{ ok: boolean; state: GraphState }>(`sessions/${encodeURIComponent(input.sessionId)}/archive`, input);
  }

  killSession(sessionId: SessionId) {
    return this.#post<{ ok: boolean; state: GraphState }>(`sessions/${encodeURIComponent(sessionId)}/kill`);
  }

  respondRuntimeRequest(input: RespondRuntimeRequestInput) {
    return this.#post<{ ok: boolean; state: GraphState }>(`requests/${encodeURIComponent(input.requestId)}/respond`, input);
  }

  answerUserInput(input: AnswerUserInputInput) {
    return this.#post<{ ok: boolean; state: GraphState }>(`user-input/${encodeURIComponent(input.requestId)}/answer`, input);
  }

  upsertCluster(input: UpsertClusterInput) {
    return this.#post<{ clusterId: string; state: GraphState }>('clusters', input);
  }

  createMasterForCluster(input: CreateMasterForClusterInput) {
    return this.#post<{ sessionId: SessionId; state: GraphState }>(`clusters/${encodeURIComponent(input.clusterId)}/master`, input);
  }

  assignMasterToCluster(input: AssignMasterToClusterInput) {
    return this.#post<{ state: GraphState }>(`clusters/${encodeURIComponent(input.clusterId)}/assign-master`, input);
  }

  setClusterLoopPolicy(input: SetClusterLoopPolicyInput) {
    return this.#post<{ state: GraphState }>(`clusters/${encodeURIComponent(input.clusterId)}/loop-policy`, input);
  }

  updateNodePositions(input: UpdateNodePositionsInput) {
    return this.#post<{ state: GraphState }>('node-positions', input);
  }

  startMasterLoop(input: StartMasterLoopInput) {
    return this.#post<{ state: GraphState }>(`clusters/${encodeURIComponent(input.clusterId)}/start-loop`, input);
  }

  stopMasterLoop(input: StopMasterLoopInput) {
    return this.#post<{ state: GraphState }>(`clusters/${encodeURIComponent(input.clusterId)}/stop-loop`, input);
  }

  stopLoop(input: StopLoopInput) {
    return this.#post<{ state: GraphState }>(`loops/${encodeURIComponent(input.loopId)}/stop`, input);
  }

  freeze(input: FreezeInput) {
    return this.#post<{ ok: boolean; state: GraphState }>('freeze', input);
  }

  unfreeze(input: UnfreezeInput) {
    return this.#post<{ ok: boolean; state: GraphState }>('unfreeze', input);
  }

  cleanupChannels(input: { sessionId?: string; maxReadAgeDays?: number; maxReadEntries?: number; keepLatestReadPerTopic?: boolean; reason?: string }) {
    return this.#post<{ ok: boolean; removedDeliveries: number; removedBytes: number; state: GraphState }>('channels/cleanup', input);
  }

  getWorkingTreeDiff(input: WorkingTreeDiffInput) {
    return this.#post<WorkingTreeDiffResult>('working-tree-diff', input);
  }

  getWorkspaceFiles(input: WorkspaceFilesInput) {
    return this.#post<WorkspaceFilesResult>('workspace-files', input);
  }

  getWorkspaceFileContent(input: WorkspaceFileContentInput) {
    return this.#post<WorkspaceFileContentResult>('workspace-file-content', input);
  }

  openWorkspace(input: OpenWorkspaceInput) {
    return this.#post<OpenWorkspaceResult>('open-workspace', input);
  }

  createTerminal(input: CreateTerminalInput) {
    return this.#post<RuntimeTerminalResult>('terminals', input);
  }

  getTerminal(input: GetTerminalInput) {
    return this.#get<RuntimeTerminalResult>(`terminals/${encodeURIComponent(input.terminalId)}`);
  }

  getKernelEvents(input?: KernelEventsInput) {
    const params = new URLSearchParams();
    if (input?.since !== undefined) {
      params.set('since', String(input.since));
    }
    if (input?.limit !== undefined) {
      params.set('limit', String(input.limit));
    }
    if (input?.tail) {
      params.set('tail', 'true');
    }
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.#get<KernelEventsResult>(`kernel-events${query}`);
  }

  dispatchCommand(input: { commandId?: string; idempotencyKey?: string; expectedVersion?: number; kind: string; reason?: string; input?: Record<string, unknown> }) {
    return this.#post<Record<string, unknown>>('commands', input);
  }

  getLoopTimeline(input: { loopId: string }) {
    return this.#get<LoopTimelineResult>(`loops/${encodeURIComponent(input.loopId)}/timeline`);
  }

  createGoalLoop(input: CreateGoalLoopInput) {
    return this.#post<CreateGoalLoopResult>('goal-loops', input);
  }

  startReviewWorkflow(input: StartReviewWorkflowInput) {
    return this.#post<StartReviewWorkflowResult>('review-workflows', input);
  }

  startPlanCouncil(input: StartPlanCouncilInput) {
    return this.#post<StartPlanCouncilResult>('plan-councils', input);
  }

  getPlanCouncil(input: { workflowId: string }) {
    return this.#get<{ council: PlanCouncil }>(`plan-councils/${encodeURIComponent(input.workflowId)}`);
  }

  getPlanCouncilArtifact(input: { workflowId: string; artifactId: string }) {
    return this.#get<{ artifact: PlanCouncil['artifacts'][number]; content: string }>(
      `plan-councils/${encodeURIComponent(input.workflowId)}/artifacts/${encodeURIComponent(input.artifactId)}`,
    );
  }

  startPlanCouncilCrossReview(input: { workflowId: string }) {
    return this.#post<{ council: PlanCouncil; state: GraphState }>(
      `plan-councils/${encodeURIComponent(input.workflowId)}/cross-review`,
      {},
    );
  }

  startPlanCouncilSynthesis(input: { workflowId: string }) {
    return this.#post<{ council: PlanCouncil; state: GraphState }>(
      `plan-councils/${encodeURIComponent(input.workflowId)}/synthesis`,
      {},
    );
  }

  stopPlanCouncil(input: { workflowId: string; reason?: string }) {
    return this.#post<{ council: PlanCouncil; state: GraphState }>(
      `plan-councils/${encodeURIComponent(input.workflowId)}/stop`,
      { reason: input.reason },
    );
  }

  startDraftWorkflow(input: StartDraftWorkflowInput) {
    return this.#post<StartDraftWorkflowResult>('draft-workflows', input);
  }

  startHandoffWorkflow(input: StartHandoffWorkflowInput) {
    return this.#post<StartHandoffWorkflowResult>('handoff-workflows', input);
  }

  startGoalWorkflow(input: StartGoalWorkflowInput) {
    return this.#post<StartGoalWorkflowResult>('goal-workflows/start', input);
  }

  connectAgents(input: ConnectAgentsInput) {
    return this.#post<ConnectAgentsResult>('agent-connections', input);
  }

  stopSubscription(input: { subscriptionId: string; reason?: string }) {
    return this.#post<{ ok: boolean; state: GraphState }>(`subscriptions/${encodeURIComponent(input.subscriptionId)}/stop`, input);
  }

  registerExternalSource(input: RegisterExternalSourceInput) {
    return this.#post<RegisterExternalSourceResult>('sources', input);
  }

  removeExternalSource(input: { sourceId: string; reason?: string }) {
    return this.#post<{ ok: boolean }>(`sources/${encodeURIComponent(input.sourceId)}/remove`, input);
  }

  emitExternalEvent(input: EmitExternalEventInput) {
    return this.#post<EmitExternalEventResult>('external-events', input);
  }

  listTemplates() {
    return this.#get<ListTemplatesResult>('templates');
  }

  applyTemplate(input: ApplyTemplateInput) {
    return this.#post<ApplyTemplateResult>('templates/apply', input);
  }

  saveTemplate(input: SaveTemplateInput) {
    return this.#post<SaveTemplateResult>('templates/save', input);
  }

  removeTemplate(input: { templateId: string }) {
    return this.#post<{ ok: boolean; state: GraphState }>(`templates/${encodeURIComponent(input.templateId)}/remove`, input);
  }

  runTerminalCommand(input: RunTerminalCommandInput) {
    return this.#post<RunTerminalCommandResult>(`terminals/${encodeURIComponent(input.terminalId)}/command`, input);
  }

  writeTerminalInput(input: WriteTerminalInput) {
    return this.#post<RuntimeTerminalResult>(`terminals/${encodeURIComponent(input.terminalId)}/stdin`, input);
  }

  clearTerminal(input: ClearTerminalInput) {
    return this.#post<RuntimeTerminalResult>(`terminals/${encodeURIComponent(input.terminalId)}/clear`, input);
  }

  closeTerminal(input: CloseTerminalInput) {
    return this.#post<RuntimeTerminalResult>(`terminals/${encodeURIComponent(input.terminalId)}/close`, input);
  }

  onEvent(listener: (event: RuntimeEvent) => void) {
    const source = new EventSource(this.#url('events'));
    const handleEvent = (event: MessageEvent<string>) => {
      try {
        const runtimeEvent = parseSseRuntimeEvent(event);
        if (runtimeEvent) {
          listener(runtimeEvent);
        }
      } catch (error) {
        console.error('Failed to parse looperators runtime event.', error);
      }
    };

    source.onmessage = handleEvent;
    source.addEventListener('runtime', handleEvent);
    source.addEventListener('runtime-event', handleEvent);
    for (const type of runtimeEventTypes) {
      source.addEventListener(type, handleEvent);
    }

    return () => {
      source.close();
    };
  }

  #get<T = unknown>(path: string) {
    return this.#request<T>('GET', path);
  }

  #post<T>(path: string, input?: unknown) {
    return this.#request<T>('POST', path, input);
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const headers = new Headers({ Accept: 'application/json' });
    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(this.#url(path), init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach looperators runtime at ${this.#baseUrl}: ${reason}`);
    }

    const parsedBody = await this.#parseBody(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(method, `/api/runtime/${path}`, response.status, parsedBody));
    }

    return parsedBody as T;
  }

  async #parseBody(response: Response) {
    if (response.status === 204) {
      return undefined;
    }

    const text = await response.text();
    if (text.trim().length === 0) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return JSON.parse(text) as unknown;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  #url(path: string) {
    return `${this.#baseUrl}/api/runtime/${path.replace(/^\/+/, '')}`;
  }
}

function createHttpRuntimeClient(runtimeUrl: string, config?: RuntimeConfig): HttpRuntimeClient {
  if (cachedHttpRuntimeClient?.runtimeUrl === runtimeUrl) {
    return cachedHttpRuntimeClient;
  }

  const runtime = new HttpRuntimeApi(runtimeUrl);
  const workspace: RuntimeWorkspaceMetadata = { ...(config?.workspace ?? {}) };

  cachedHttpRuntimeClient = {
    kind: 'http',
    isAvailable: true,
    platform: config?.platform ?? 'web',
    runtimeUrl,
    workspace,
    runtime,
    getConfig: () => runtime.getConfig(),
  };

  return cachedHttpRuntimeClient;
}

export function getConfiguredRuntimeUrl() {
  return normalizeRuntimeUrl();
}

export function createRuntimeProbeClient(runtimeUrl = getConfiguredRuntimeUrl()) {
  return new HttpRuntimeApi(runtimeUrl);
}

export function getActiveRuntimeClient(config?: RuntimeConfig): RuntimeClient {
  if (typeof window === 'undefined') {
    return unavailableRuntimeClient;
  }

  const electronApi = window.orrery;
  if (electronApi?.runtime) {
    return {
      kind: 'electron',
      isAvailable: true,
      platform: electronApi.platform,
      workspace: electronApi.workspace ?? {},
      runtime: electronApi.runtime,
    };
  }

  if (config) {
    return createHttpRuntimeClient(getConfiguredRuntimeUrl(), config);
  }

  return {
    kind: 'connecting',
    isAvailable: false,
    runtimeUrl: getConfiguredRuntimeUrl(),
    workspace: {},
  };
}

export function hasRuntimeClient() {
  return getActiveRuntimeClient().isAvailable;
}

export function useRuntimeClient(options: { disabled?: boolean } = {}) {
  const disabled = options.disabled === true;
  const electronClient = useMemo(() => (disabled ? unavailableRuntimeClient : getActiveRuntimeClient()), [disabled]);
  const runtimeUrl = useMemo(() => getConfiguredRuntimeUrl(), []);
  const [httpState, setHttpState] = useState<RuntimeClient>(() =>
    disabled || electronClient.kind !== 'connecting'
      ? electronClient
      : {
          kind: 'connecting',
          isAvailable: false,
          runtimeUrl,
          workspace: {},
        },
  );

  useEffect(() => {
    if (disabled || electronClient.kind !== 'connecting') {
      setHttpState(electronClient);
      return;
    }

    let isMounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setHttpState({
      kind: 'connecting',
      isAvailable: false,
      runtimeUrl,
      workspace: {},
    });

    const probeRuntime = () => {
      const probe = createRuntimeProbeClient(runtimeUrl);
      probe
        .getConfig()
        .then((config) => {
          if (isMounted) {
            setHttpState(createHttpRuntimeClient(runtimeUrl, config));
          }
        })
        .catch((error: unknown) => {
          if (!isMounted) {
            return;
          }

          setHttpState({
            kind: 'unavailable',
            isAvailable: false,
            runtimeUrl,
            workspace: {},
            error: error instanceof Error ? error.message : String(error),
          });
          retryTimer = setTimeout(probeRuntime, 2000);
        });
    };

    probeRuntime();

    return () => {
      isMounted = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [disabled, electronClient, runtimeUrl]);

  return electronClient.kind === 'connecting' ? httpState : electronClient;
}
