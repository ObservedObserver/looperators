import type {
  AgentGraphEdge,
  AgentGraphModel,
  AgentGraphNode,
  AgentGraphNodeState,
  AgentGraphReport,
  AgentGraphStatus,
} from './graph-model';

type RawProjection = Record<string, unknown>;

export type AgentGraphScenario = {
  name: string;
  projection: RawProjection;
  expectedModel: AgentGraphModel;
};

const edgeDefinitions = [
  {
    id: 'root-governs-implementer',
    source: 'root',
    target: 'role:implementer',
    kind: 'governs',
  },
  {
    id: 'implementer-handoff-reviewer',
    source: 'role:implementer',
    target: 'role:reviewer',
    kind: 'handoff',
  },
  {
    id: 'reviewer-feedback-implementer',
    source: 'role:reviewer',
    target: 'role:implementer',
    kind: 'feedback',
  },
  {
    id: 'reviewer-verdict-root',
    source: 'role:reviewer',
    target: 'root',
    kind: 'verdict',
  },
] as const;

function makeNodes(
  states: [AgentGraphNodeState, AgentGraphNodeState, AgentGraphNodeState],
  bound = true,
): AgentGraphNode[] {
  return [
    {
      id: 'root',
      kind: 'root',
      role: 'root',
      label: 'Governor',
      state: states[0],
    },
    {
      id: 'role:implementer',
      kind: 'worker-role',
      role: 'implementer',
      label: 'Implementer',
      state: states[1],
      ...(bound
        ? {
            nativeAgentId: 'native-implementer-fixture',
            nativeAgentType: 'worker',
          }
        : {}),
    },
    {
      id: 'role:reviewer',
      kind: 'worker-role',
      role: 'reviewer',
      label: 'Reviewer',
      state: states[2],
      ...(bound
        ? {
            nativeAgentId: 'native-reviewer-fixture',
            nativeAgentType: 'worker',
          }
        : {}),
    },
  ];
}

function makeEdges(
  activeKind?: AgentGraphEdge['kind'],
  reports: Partial<Record<AgentGraphEdge['kind'], number>> = {},
): AgentGraphEdge[] {
  return edgeDefinitions.map((edge) => ({
    ...edge,
    active: edge.kind === activeKind,
    reportCount: reports[edge.kind] ?? 0,
  }));
}

function rawNodes(nodes: AgentGraphNode[]) {
  return nodes.map(({ role, ...node }) =>
    node.kind === 'root' ? node : { ...node, role },
  );
}

function scenario(options: {
  name: string;
  digestCharacter: string;
  status: AgentGraphStatus;
  revision: number;
  currentLap: number;
  lapCap?: number;
  lease?: { granted: number; consumed: number };
  states: [AgentGraphNodeState, AgentGraphNodeState, AgentGraphNodeState];
  bound?: boolean;
  activeKind?: AgentGraphEdge['kind'];
  reports?: Partial<Record<AgentGraphEdge['kind'], number>>;
  latestReport?: AgentGraphReport;
  pendingRole?: 'implementer' | 'reviewer';
  needsHuman?: boolean;
  cancelRequested?: boolean;
  recovery?: { reason: string };
}): AgentGraphScenario {
  const nodes = makeNodes(options.states, options.bound);
  const edges = makeEdges(options.activeKind, options.reports);
  const digest = options.digestCharacter.repeat(64);
  const timeline =
    options.revision === 0
      ? []
      : [
          {
            id: `transition-${options.name}`,
            at: '2026-07-28T18:00:00.000Z',
            label: options.activeKind
              ? `activate-${options.pendingRole ?? options.activeKind}`
              : options.status,
            kind: 'transition' as const,
            ...(options.pendingRole ? { role: options.pendingRole } : {}),
          },
          ...(options.latestReport
            ? [
                {
                  id: `report-${options.name}`,
                  at: '2026-07-28T18:00:01.000Z',
                  label:
                    options.latestReport.verdict === 'issues'
                      ? 'reviewer verdict: issues'
                      : options.latestReport.verdict === 'clean'
                        ? 'reviewer verdict: clean'
                        : 'implementer info: done',
                  kind: 'report' as const,
                  role: options.latestReport.fromRole,
                },
              ]
            : []),
        ];
  const model: AgentGraphModel = {
    identity: {
      runId: `run-${options.name}`,
      revision: options.revision,
      projectionDigest: digest,
      integrity: 'verified',
    },
    status: options.status,
    currentLap: options.currentLap,
    lapCap: options.lapCap ?? 3,
    lease: options.lease ?? { granted: 3, consumed: 0 },
    cancelRequested: options.cancelRequested ?? false,
    needsHuman: options.needsHuman ?? false,
    nodes,
    edges,
    ...(options.pendingRole
      ? {
          pending: {
            role: options.pendingRole,
            kind:
              options.pendingRole === 'implementer'
                ? ('activate-implementer' as const)
                : ('activate-reviewer' as const),
            lap: options.currentLap,
          },
        }
      : {}),
    ...(options.latestReport ? { latestReport: options.latestReport } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    timeline,
  };
  return {
    name: options.name,
    expectedModel: model,
    projection: {
      schemaVersion: 1,
      storeVersion: 1,
      projectionVersion: 3,
      runId: model.identity.runId,
      revision: model.identity.revision,
      status: model.status,
      recipe: 'review-until-clean',
      currentLap: model.currentLap,
      lapCap: model.lapCap,
      continuationLease: model.lease,
      cancelRequested: model.cancelRequested,
      needsHuman: model.needsHuman,
      integrity: {
        status: 'verified',
        verifiedRevision: model.identity.revision,
      },
      eventWatermark: {
        eventCount: 0,
      },
      nodes: rawNodes(nodes),
      edges,
      ...(model.pending
        ? {
            pending: {
              transitionId: `transition-${options.name}`,
              ...model.pending,
            },
          }
        : {}),
      ...(model.latestReport
        ? {
            latestReport: {
              reportId: `report-${options.name}`,
              ...model.latestReport,
            },
          }
        : {}),
      ...(model.recovery
        ? {
            recovery: {
              recoveryId: `recovery_${'d'.repeat(64)}`,
              ...model.recovery,
            },
          }
        : {}),
      counts: {
        events: 0,
        reports: model.latestReport ? 1 : 0,
        transitions: model.identity.revision > 0 ? 1 : 0,
        operations: model.identity.revision,
        governorDecisions: 0,
        recoveries: model.recovery ? 1 : 0,
        diagnostics: 0,
        conflicts: 0,
        corrupt: 0,
      },
      timeline,
      projectionDigest: digest,
    },
  };
}

export const agentGraphScenarios: AgentGraphScenario[] = [
  scenario({
    name: 'draft',
    digestCharacter: 'a',
    status: 'draft',
    revision: 0,
    currentLap: 0,
    states: ['active', 'unbound', 'unbound'],
    bound: false,
  }),
  scenario({
    name: 'implementer-active',
    digestCharacter: 'b',
    status: 'running',
    revision: 1,
    currentLap: 0,
    states: ['waiting', 'active', 'unbound'],
    activeKind: 'governs',
    pendingRole: 'implementer',
  }),
  scenario({
    name: 'reviewer-issues',
    digestCharacter: 'c',
    status: 'running',
    revision: 4,
    currentLap: 1,
    lease: { granted: 3, consumed: 1 },
    states: ['waiting', 'waiting', 'active'],
    activeKind: 'feedback',
    reports: { handoff: 1, feedback: 1 },
    pendingRole: 'implementer',
    latestReport: {
      fromRole: 'reviewer',
      type: 'verdict',
      verdict: 'issues',
      issueCount: 2,
    },
  }),
  scenario({
    name: 'paused-needs-human',
    digestCharacter: 'd',
    status: 'paused',
    revision: 5,
    currentLap: 1,
    lease: { granted: 3, consumed: 2 },
    states: ['active', 'bound', 'bound'],
    reports: { handoff: 1, feedback: 1 },
    needsHuman: true,
  }),
  scenario({
    name: 'succeeded-clean',
    digestCharacter: 'e',
    status: 'succeeded',
    revision: 7,
    currentLap: 2,
    lease: { granted: 3, consumed: 2 },
    states: ['terminal', 'terminal', 'terminal'],
    activeKind: 'verdict',
    reports: { handoff: 2, feedback: 1, verdict: 1 },
    latestReport: {
      fromRole: 'reviewer',
      type: 'verdict',
      verdict: 'clean',
      issueCount: 0,
    },
  }),
  scenario({
    name: 'capped',
    digestCharacter: 'f',
    status: 'capped',
    revision: 6,
    currentLap: 3,
    lease: { granted: 3, consumed: 3 },
    states: ['terminal', 'terminal', 'terminal'],
    reports: { handoff: 2, feedback: 2 },
    needsHuman: true,
  }),
  scenario({
    name: 'cancelled',
    digestCharacter: '1',
    status: 'cancelled',
    revision: 2,
    currentLap: 0,
    lease: { granted: 3, consumed: 0 },
    states: ['terminal', 'terminal', 'terminal'],
    cancelRequested: true,
  }),
];

const reviewerIssuesScenario = agentGraphScenarios.find(
  (candidate) => candidate.name === 'reviewer-issues',
);

if (!reviewerIssuesScenario) {
  throw new Error('reviewer-issues fixture is unavailable');
}

/**
 * A UI-only acceptance model derived from the paired projection fixture.
 *
 * Keep this outside `agentGraphScenarios`: those fixtures prove the Plugin
 * projection adapter is lossless, while this model exercises the richer
 * Desktop-derived interaction surface before the Plugin imports it.
 */
export const desktopParityModel: AgentGraphModel = {
  ...reviewerIssuesScenario.expectedModel,
  responsibleRole: 'implementer',
  nodes: reviewerIssuesScenario.expectedModel.nodes.map((node) => ({
    ...node,
    runtimeLabel: node.role === 'root' ? 'Codex task' : 'Native subagent',
    model: node.role === 'root' ? 'Governor' : 'worker',
    description:
      node.role === 'root'
        ? 'Owns the bounded review policy and approves every transition.'
        : node.role === 'implementer'
          ? 'Addresses the latest blocking findings and reports completion.'
          : 'Reviews the implementation and returns a typed verdict.',
    activityCount: node.role === 'root' ? 4 : node.role === 'implementer' ? 7 : 5,
    lastActivityAt: '2026-08-02T18:00:04.000Z',
  })),
  edges: reviewerIssuesScenario.expectedModel.edges.map((edge) => ({
    ...edge,
    label:
      edge.kind === 'governs'
        ? 'Governed activation'
        : edge.kind === 'handoff'
          ? 'Implementation ready'
          : edge.kind === 'feedback'
            ? 'Blocking feedback'
            : 'Clean verdict',
    summary:
      edge.kind === 'feedback'
        ? 'Reviewer found blocking issues, so the Governor grants one bounded implementer continuation.'
        : `Typed ${edge.kind} report advances the run only after Governor validation.`,
    recent: edge.kind === 'handoff',
    pending: edge.kind === 'feedback',
    gate: 'Governor validates typed report and lease',
    firings: edge.reportCount,
    maxFirings: edge.kind === 'governs' ? 1 : 3,
    stopWhen: edge.kind === 'feedback' ? 'clean verdict, cancellation, or lap cap' : 'terminal run state',
  })),
  latestReport: {
    ...reviewerIssuesScenario.expectedModel.latestReport!,
    summary: 'Two blocking findings remain before the run can finish cleanly.',
    issues: [
      {
        severity: 'error',
        message: 'Cancel must revoke every unconsumed continuation capability.',
        file: 'plugins/looperators-agent-loop/mcp/governor.mjs',
        line: 214,
      },
      {
        severity: 'warn',
        message: 'Recovery must reject actions issued before the current process epoch.',
        file: 'plugins/looperators-agent-loop/mcp/store.mjs',
        line: 91,
      },
    ],
  },
  laps: [
    {
      index: 0,
      status: 'issues',
      at: '2026-08-02T18:00:02.000Z',
      implementerSummary: 'Added bounded continuation and typed reviewer reports.',
      reviewerSummary: 'Found cancellation and restart recovery gaps.',
      verdict: 'issues',
      issues: [
        {
          severity: 'error',
          message: 'Cancel did not revoke a previously issued continuation.',
        },
      ],
    },
    {
      index: 1,
      status: 'running',
      at: '2026-08-02T18:00:04.000Z',
      implementerSummary: 'Applying the two remaining fixes.',
      reviewerSummary: 'Waiting for a new typed implementation report.',
      issues: [],
    },
  ],
};
