import { defaultGraphProviderInstances, graphStateVersion, type GraphState } from './graph-state';
import type { RuntimeActivity } from './provider-runtime';

/**
 * Demo runtime state for design / web preview only.
 * Activated via `?demo=1` when NOT running inside Electron (no window.orrery).
 * Never used by the real Electron runtime.
 */

type DemoActivityInput = {
  id: string;
  sessionId: string;
  turnId: string;
  providerName: string;
  command: string;
  args?: string;
  status: RuntimeActivity['status'];
  startedAt: string;
  durationMs?: number;
  sublines?: RuntimeActivity['sublines'];
  error?: string;
};

function demoActivity(input: DemoActivityInput): RuntimeActivity {
  const completedAt =
    input.status === 'running' || input.durationMs === undefined ? undefined : new Date(Date.parse(input.startedAt) + input.durationMs).toISOString();

  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: 'tool_call',
    providerName: input.providerName,
    command: input.command,
    args: input.args,
    title: input.command,
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: completedAt ?? input.startedAt,
    completedAt,
    durationMs: input.durationMs,
    sublines: input.sublines ?? [],
    error: input.error,
  };
}

function p1AcceptanceActivities(): RuntimeActivity[] {
  const sessionId = 'sess-p1-accept';
  const turnId = 'turn-p1-acceptance';
  const T = '2026-06-24T12:56:';

  return [
    demoActivity({
      id: 'toolu_01',
      sessionId,
      turnId,
      providerName: 'Read',
      command: 'read_file',
      args: 'orchestrator.ts',
      status: 'completed',
      startedAt: `${T}03.000Z`,
      durationMs: 40,
    }),
    demoActivity({
      id: 'toolu_02',
      sessionId,
      turnId,
      providerName: 'Grep',
      command: 'grep',
      args: '"sessionId === nodeId"',
      status: 'completed',
      startedAt: `${T}03.100Z`,
      durationMs: 22,
      sublines: [{ value: '3 matches' }],
    }),
    demoActivity({
      id: 'toolu_03',
      sessionId,
      turnId,
      providerName: 'Edit',
      command: 'apply_patch',
      args: 'orchestrator.ts',
      status: 'completed',
      startedAt: `${T}03.200Z`,
      durationMs: 60,
    }),
    demoActivity({
      id: 'toolu_04',
      sessionId,
      turnId,
      providerName: 'Bash',
      command: 'bash',
      args: 'npm run verify',
      status: 'completed',
      startedAt: `${T}03.300Z`,
      durationMs: 1200,
      sublines: [{ value: 'typecheck clean' }, { value: 'lint 0 warnings' }, { value: 'build 4 routes' }],
    }),
    demoActivity({
      id: 'toolu_05',
      sessionId,
      turnId,
      providerName: 'Bash',
      command: 'bash',
      args: 'npm test',
      status: 'failed',
      startedAt: `${T}04.600Z`,
      durationMs: 600,
      sublines: [{ value: 'FAIL src/orchestrator.test.ts - 2 failing' }],
      error: 'FAIL src/orchestrator.test.ts - 2 failing',
    }),
    demoActivity({
      id: 'toolu_06',
      sessionId,
      turnId,
      providerName: 'Edit',
      command: 'apply_patch',
      args: 'orchestrator.ts',
      status: 'completed',
      startedAt: `${T}05.300Z`,
      durationMs: 50,
    }),
    demoActivity({
      id: 'toolu_07',
      sessionId,
      turnId,
      providerName: 'Bash',
      command: 'bash',
      args: 'npm test',
      status: 'completed',
      startedAt: `${T}05.400Z`,
      durationMs: 900,
      sublines: [{ value: '48 passed' }],
    }),
  ];
}

function p2ResearchActivities(): RuntimeActivity[] {
  const sessionId = 'sess-p2-research';
  const turnId = 'turn-p2-research';
  const T = '2026-06-24T12:56:';

  return [
    demoActivity({
      id: 'toolu_r1',
      sessionId,
      turnId,
      providerName: 'WebFetch',
      command: 'web.fetch',
      args: 'orrery.dev',
      status: 'completed',
      startedAt: `${T}28.000Z`,
      durationMs: 1500,
      sublines: [{ value: 'fetched 24kb - 18 entries' }],
    }),
    demoActivity({
      id: 'toolu_r2',
      sessionId,
      turnId,
      providerName: 'WebFetch',
      command: 'web.fetch',
      args: 'orrery.dev',
      status: 'running',
      startedAt: `${T}30.000Z`,
    }),
  ];
}

export function createDemoGraphState(): GraphState {
  const base = '2026-06-24T12:5';
  return {
    version: graphStateVersion,
    updatedAt: `${base}5:36.000Z`,
    providerInstances: defaultGraphProviderInstances.map((instance) => ({
      ...instance,
    })),
    nodes: [
      {
        nodeId: 'sess-p1-accept',
        sessionId: 'sess-p1-accept',
        label: 'P1 Acceptance',
        role: 'worker',
        agent: 'claude-code',
        status: 'idle',
        position: { x: 0, y: 0 },
      },
      {
        nodeId: 'sess-p2-research',
        sessionId: 'sess-p2-research',
        label: 'P2 Research loop',
        role: 'worker',
        agent: 'claude-code',
        status: 'running',
        position: { x: 360, y: -48 },
      },
      {
        nodeId: 'sess-p0-bootstrap',
        sessionId: 'sess-p0-bootstrap',
        label: 'P0 Bootstrap',
        role: 'master',
        agent: 'claude-code',
        status: 'idle',
        position: { x: -340, y: 150 },
      },
    ],
    edges: [
      {
        edgeId: 'edge-1',
        source: 'sess-p0-bootstrap',
        target: 'sess-p1-accept',
        kind: 'create-session',
        ts: `${base}0:02.000Z`,
        label: 'spawn p1',
      },
      {
        edgeId: 'edge-2',
        source: 'sess-p1-accept',
        target: 'sess-p0-bootstrap',
        kind: 'report',
        ts: `${base}6:10.000Z`,
        verdict: 'clean',
        issueCount: 0,
        summary: 'P1 acceptance green — 48 tests pass.',
      },
    ],
    sessions: {
      'sess-p1-accept': {
        sessionId: 'sess-p1-accept',
        nodeId: 'sess-p1-accept',
        backend: 'claude-agent-sdk',
        backendSessionId: '3cce7740-d183-4170-9ee4-0d45e5078234',
        providerKind: 'claude-code',
        providerInstanceId: 'default-claude-sdk',
        providerSessionId: '3cce7740-d183-4170-9ee4-0d45e5078234',
        agent: 'claude-code',
        label: 'P1 Acceptance',
        prompt: 'Run the P1 acceptance loop and checkpoint when green.',
        cwd: '~/Documents/GitHub/orrery',
        role: 'worker',
        status: 'idle',
        createdAt: `${base}0:00.000Z`,
        updatedAt: `${base}6:12.000Z`,
        chunks: [],
        nativeEvents: [],
        runtimeEvents: [],
        runtimeActivities: p1AcceptanceActivities(),
        runtimeRequests: [],
        runtimeUserInputRequests: [],
        runtimePlans: [],
        messages: [
          {
            id: 'm1',
            sessionId: 'sess-p1-accept',
            role: 'user',
            content: 'Remember marker P1_ACCEPT_1782305678623_5453fb. Reply exactly done.',
            ts: `${base}5:30.000Z`,
            status: 'complete',
          },
          {
            id: 'm2',
            sessionId: 'sess-p1-accept',
            role: 'assistant',
            content: 'done',
            ts: `${base}5:31.000Z`,
            status: 'complete',
          },
          {
            id: 'm3',
            sessionId: 'sess-p1-accept',
            role: 'user',
            content: 'What marker did I ask you to remember? Reply only the marker.',
            ts: `${base}5:48.000Z`,
            status: 'complete',
          },
          {
            id: 'm4',
            sessionId: 'sess-p1-accept',
            role: 'assistant',
            content: 'P1_ACCEPT_1782305678623_5453fb',
            ts: `${base}5:49.000Z`,
            status: 'complete',
          },
          {
            id: 'm5',
            sessionId: 'sess-p1-accept',
            role: 'user',
            content: 'Run the P1 acceptance loop and checkpoint when green.',
            ts: `${base}6:02.000Z`,
            status: 'complete',
          },
          {
            id: 'm6',
            sessionId: 'sess-p1-accept',
            role: 'assistant',
            content: [
              '## Acceptance summary',
              '',
              '- Patched `src/runtime/orchestrator.ts` so node/session identity stays stable.',
              '- Ran `npm run verify`; typecheck, lint, and build were clean.',
              '- Re-ran `npm test` after the fix: **48 passed**.',
              '',
              '```ts',
              'if (node.sessionId !== node.nodeId) {',
              "  throw new Error('nodeId must match sessionId')",
              '}',
              '```',
              '',
              '```markdown',
              '| Check | Result |',
              '| --- | --- |',
              '| typecheck | clean |',
              '| tests | 48 passed |',
              '```',
              '',
              'Checkpointed `p1-acceptance@4f2a`.',
            ].join('\n'),
            ts: `${base}6:11.000Z`,
            runId: 'turn-p1-acceptance',
            status: 'complete',
          },
        ],
      },
      'sess-p2-research': {
        sessionId: 'sess-p2-research',
        nodeId: 'sess-p2-research',
        backend: 'claude-agent-sdk',
        backendSessionId: 'a91f2c08-77bd-4e10-9a2c-1de5079b21aa',
        providerKind: 'claude-code',
        providerInstanceId: 'default-claude-sdk',
        providerSessionId: 'a91f2c08-77bd-4e10-9a2c-1de5079b21aa',
        agent: 'claude-code',
        label: 'P2 Research loop',
        prompt: 'Crawl the changelog and summarize regressions.',
        cwd: '~/Documents/GitHub/orrery',
        role: 'worker',
        status: 'running',
        createdAt: `${base}3:10.000Z`,
        updatedAt: `${base}6:30.000Z`,
        chunks: [],
        nativeEvents: [],
        runtimeEvents: [],
        runtimeActivities: p2ResearchActivities(),
        runtimeRequests: [],
        runtimeUserInputRequests: [],
        runtimePlans: [],
        messages: [
          {
            id: 'r1',
            sessionId: 'sess-p2-research',
            role: 'user',
            content: 'Crawl the changelog and summarize regressions.',
            ts: `${base}3:10.000Z`,
            status: 'complete',
          },
          {
            id: 'r2',
            sessionId: 'sess-p2-research',
            role: 'assistant',
            content: 'Fetching changelog pages and clustering by component…',
            ts: `${base}6:30.000Z`,
            runId: 'turn-p2-research',
            status: 'streaming',
          },
        ],
      },
      'sess-p0-bootstrap': {
        sessionId: 'sess-p0-bootstrap',
        nodeId: 'sess-p0-bootstrap',
        backend: 'claude-agent-sdk',
        backendSessionId: '77bce4d1-02a9-4c33-8f10-9b0042aa0042',
        providerKind: 'claude-code',
        providerInstanceId: 'default-claude-sdk',
        providerSessionId: '77bce4d1-02a9-4c33-8f10-9b0042aa0042',
        agent: 'claude-code',
        label: 'P0 Bootstrap',
        prompt: 'Bootstrap the master loop and spawn acceptance workers.',
        cwd: '~/Documents/GitHub/orrery',
        role: 'master',
        status: 'idle',
        createdAt: `${base}0:00.000Z`,
        updatedAt: `${base}6:10.000Z`,
        exitCode: 0,
        chunks: [],
        nativeEvents: [],
        runtimeEvents: [],
        runtimeActivities: [],
        runtimeRequests: [],
        runtimeUserInputRequests: [],
        runtimePlans: [],
        messages: [
          {
            id: 'b1',
            sessionId: 'sess-p0-bootstrap',
            role: 'user',
            content: 'Bootstrap the master loop and spawn acceptance workers.',
            ts: `${base}0:00.000Z`,
            status: 'complete',
          },
          {
            id: 'b2',
            sessionId: 'sess-p0-bootstrap',
            role: 'assistant',
            content: 'Bootstrap complete. Spawned p1-acceptance. Exit 0.',
            ts: `${base}0:05.000Z`,
            status: 'complete',
          },
        ],
      },
    },
    clusters: {},
    reports: [
      {
        id: 'rep-1',
        from: 'sess-p1-accept',
        envelope: {
          callId: 'call-1',
          source: 'sess-p1-accept',
          ts: `${base}6:10.000Z`,
        },
        payload: {
          type: 'verdict',
          verdict: 'clean',
          issues: [],
          summary: 'P1 acceptance green — 48 tests pass, checkpoint p1-acceptance@4f2a.',
        },
      },
    ],
  };
}
