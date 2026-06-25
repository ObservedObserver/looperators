import {
  graphStateVersion,
  type AgentStreamChunk,
  type GraphState,
} from './graph-state'

/**
 * Demo runtime state for design / web preview only.
 * Activated via `?demo=1` when NOT running inside Electron (no window.orrery).
 * Never used by the real Electron runtime.
 *
 * The `chunks` below are real Claude CLI `stream-json` lines (tool_use /
 * tool_result / result) so the ToolRunFeed renders end-to-end in the browser.
 */

type ToolInput = Record<string, unknown>

function toolUseChunk(
  sessionId: string,
  backendId: string,
  ts: string,
  toolId: string,
  name: string,
  input: ToolInput
): AgentStreamChunk {
  return {
    id: `${toolId}-use`,
    sessionId,
    ts,
    stream: 'stdout',
    eventType: 'assistant',
    raw: JSON.stringify({
      type: 'assistant',
      message: {
        id: `msg-${toolId}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name, input }],
      },
      session_id: backendId,
    }),
  }
}

function toolResultChunk(
  sessionId: string,
  backendId: string,
  ts: string,
  toolId: string,
  content: string,
  isError = false
): AgentStreamChunk {
  return {
    id: `${toolId}-res`,
    sessionId,
    ts,
    stream: 'stdout',
    eventType: 'user',
    raw: JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolId, content, is_error: isError },
        ],
      },
      session_id: backendId,
    }),
  }
}

function resultChunk(
  sessionId: string,
  backendId: string,
  ts: string,
  durationMs: number,
  numTurns: number,
  result: string
): AgentStreamChunk {
  return {
    id: `result-${ts}`,
    sessionId,
    ts,
    stream: 'stdout',
    eventType: 'result',
    text: result,
    raw: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: durationMs,
      num_turns: numTurns,
      result,
      session_id: backendId,
    }),
  }
}

// P1 acceptance run — read → grep → patch → verify → test(fail) → patch → test(ok).
function p1AcceptanceChunks(): AgentStreamChunk[] {
  const sid = 'sess-p1-accept'
  const bid = '3cce7740-d183-4170-9ee4-0d45e5078234'
  const T = '2026-06-24T12:56:'
  return [
    toolUseChunk(sid, bid, `${T}03.000Z`, 'toolu_01', 'Read', {
      file_path: 'src/runtime/orchestrator.ts',
    }),
    toolResultChunk(sid, bid, `${T}03.040Z`, 'toolu_01', ''),
    toolUseChunk(sid, bid, `${T}03.100Z`, 'toolu_02', 'Grep', {
      pattern: 'sessionId === nodeId',
      output_mode: 'content',
    }),
    toolResultChunk(sid, bid, `${T}03.122Z`, 'toolu_02', '3 matches'),
    toolUseChunk(sid, bid, `${T}03.200Z`, 'toolu_03', 'Edit', {
      file_path: 'src/runtime/orchestrator.ts',
      old_string: 'x',
      new_string: 'y',
    }),
    toolResultChunk(sid, bid, `${T}03.260Z`, 'toolu_03', ''),
    toolUseChunk(sid, bid, `${T}03.300Z`, 'toolu_04', 'Bash', {
      command: 'npm run verify',
    }),
    toolResultChunk(
      sid,
      bid,
      `${T}04.500Z`,
      'toolu_04',
      'typecheck clean\nlint 0 warnings\nbuild 4 routes'
    ),
    toolUseChunk(sid, bid, `${T}04.600Z`, 'toolu_05', 'Bash', {
      command: 'npm test',
    }),
    toolResultChunk(
      sid,
      bid,
      `${T}05.200Z`,
      'toolu_05',
      'FAIL src/orchestrator.test.ts — 2 failing',
      true
    ),
    toolUseChunk(sid, bid, `${T}05.300Z`, 'toolu_06', 'Edit', {
      file_path: 'src/runtime/orchestrator.ts',
      old_string: 'a',
      new_string: 'b',
    }),
    toolResultChunk(sid, bid, `${T}05.350Z`, 'toolu_06', ''),
    toolUseChunk(sid, bid, `${T}05.400Z`, 'toolu_07', 'Bash', {
      command: 'npm test',
    }),
    toolResultChunk(sid, bid, `${T}06.300Z`, 'toolu_07', '48 passed'),
    resultChunk(
      sid,
      bid,
      `${T}06.420Z`,
      3420,
      4,
      'Checkpointed p1-acceptance@4f2a · 48 green.'
    ),
  ]
}

// P2 research run — still streaming: one fetch done, one in flight.
function p2ResearchChunks(): AgentStreamChunk[] {
  const sid = 'sess-p2-research'
  const bid = 'a91f2c08-77bd-4e10-9a2c-1de5079b21aa'
  const T = '2026-06-24T12:56:'
  return [
    toolUseChunk(sid, bid, `${T}28.000Z`, 'toolu_r1', 'WebFetch', {
      url: 'https://orrery.dev/changelog',
      prompt: 'list regressions',
    }),
    toolResultChunk(sid, bid, `${T}29.500Z`, 'toolu_r1', 'fetched 24kb · 18 entries'),
    toolUseChunk(sid, bid, `${T}30.000Z`, 'toolu_r2', 'WebFetch', {
      url: 'https://orrery.dev/releases',
      prompt: 'cluster by component',
    }),
  ]
}

export function createDemoGraphState(): GraphState {
  const base = '2026-06-24T12:5'
  return {
    version: graphStateVersion,
    updatedAt: `${base}5:36.000Z`,
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
        backend: 'claude-cli',
        backendSessionId: '3cce7740-d183-4170-9ee4-0d45e5078234',
        agent: 'claude-code',
        label: 'P1 Acceptance',
        prompt: 'Run the P1 acceptance loop and checkpoint when green.',
        cwd: '~/Documents/GitHub/orrery',
        role: 'worker',
        status: 'idle',
        createdAt: `${base}0:00.000Z`,
        updatedAt: `${base}6:12.000Z`,
        chunks: p1AcceptanceChunks(),
        messages: [
          {
            id: 'm1',
            sessionId: 'sess-p1-accept',
            role: 'user',
            content:
              'Remember marker P1_ACCEPT_1782305678623_5453fb. Reply exactly done.',
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
            content:
              'Read orchestrator.ts and patched the nodeId guard (-4 +11). Ran npm run verify (typecheck clean, lint 0 warnings, build 4 routes). First npm test had 2 failing, applied a fix (-1 +2), re-ran: 48 passed. Checkpointed p1-acceptance@4f2a.',
            ts: `${base}6:11.000Z`,
            status: 'complete',
          },
        ],
      },
      'sess-p2-research': {
        sessionId: 'sess-p2-research',
        nodeId: 'sess-p2-research',
        backend: 'claude-cli',
        backendSessionId: 'a91f2c08-77bd-4e10-9a2c-1de5079b21aa',
        agent: 'claude-code',
        label: 'P2 Research loop',
        prompt: 'Crawl the changelog and summarize regressions.',
        cwd: '~/Documents/GitHub/orrery',
        role: 'worker',
        status: 'running',
        createdAt: `${base}3:10.000Z`,
        updatedAt: `${base}6:30.000Z`,
        chunks: p2ResearchChunks(),
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
            status: 'streaming',
          },
        ],
      },
      'sess-p0-bootstrap': {
        sessionId: 'sess-p0-bootstrap',
        nodeId: 'sess-p0-bootstrap',
        backend: 'claude-cli',
        backendSessionId: '77bce4d1-02a9-4c33-8f10-9b0042aa0042',
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
  }
}
