import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

async function loadProjectionModule() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-projection-test-'))
  const sourcePath = path.resolve('src/shared/session-projection.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
  }).outputText
  const modulePath = path.join(tempRoot, 'session-projection.mjs')
  fs.writeFileSync(modulePath, output)

  try {
    return await import(pathToFileURL(modulePath).href)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function baseSession(overrides = {}) {
  return {
    sessionId: 'session-1',
    status: 'running',
    messages: [],
    runtimeEvents: [],
    runtimeActivities: [],
    runtimeRequests: [],
    runtimeUserInputRequests: [],
    runtimePlans: [],
    ...overrides,
  }
}

test('projectSession keeps restored stale interactions closed when old open events are replayed', async () => {
  const { projectSession } = await loadProjectionModule()
  const sessionId = 'session-1'
  const ts = '2026-06-29T00:00:00.000Z'
  const projection = projectSession(
    baseSession({
      runtimeRequests: [
        {
          id: 'approval-1',
          sessionId,
          kind: 'approval',
          title: 'Run command',
          status: 'stale',
          createdAt: ts,
        },
      ],
      runtimeUserInputRequests: [
        {
          id: 'input-1',
          sessionId,
          prompt: 'Choose a branch',
          status: 'stale',
          createdAt: ts,
        },
      ],
      runtimeEvents: [
        {
          id: 'event-approval-open',
          ts: '2026-06-29T00:00:01.000Z',
          type: 'request.opened',
          sessionId,
          request: {
            id: 'approval-1',
            sessionId,
            kind: 'approval',
            title: 'Run command',
            status: 'open',
            createdAt: ts,
          },
        },
        {
          id: 'event-input-open',
          ts: '2026-06-29T00:00:02.000Z',
          type: 'user-input.requested',
          sessionId,
          request: {
            id: 'input-1',
            sessionId,
            prompt: 'Choose a branch',
            status: 'open',
            createdAt: ts,
          },
        },
      ],
    })
  )

  assert.equal(projection.openRequests.length, 0)
  assert.equal(projection.userInputRequests.length, 0)
  assert.equal(projection.staleRequests[0].id, 'approval-1')
  assert.equal(projection.staleUserInputRequests[0].id, 'input-1')
})

test('projectSession preserves persisted assistant turns and ignores late snapshots after text deltas', async () => {
  const { projectSession } = await loadProjectionModule()
  const sessionId = 'session-1'
  const projection = projectSession(
    baseSession({
      messages: [
        {
          id: 'user-1',
          sessionId,
          role: 'user',
          content: 'hello',
          ts: '2026-06-29T00:00:00.000Z',
          status: 'complete',
        },
        {
          id: 'assistant-old',
          sessionId,
          role: 'assistant',
          content: 'old streamed content',
          ts: '2026-06-29T00:00:01.000Z',
          runId: 'turn-a',
          status: 'complete',
        },
        {
          id: 'assistant-keep',
          sessionId,
          role: 'assistant',
          content: 'persisted second turn',
          ts: '2026-06-29T00:00:02.000Z',
          runId: 'turn-b',
          status: 'complete',
        },
      ],
      runtimeEvents: [
        {
          id: 'delta-1',
          ts: '2026-06-29T00:00:03.000Z',
          type: 'content.delta',
          sessionId,
          turnId: 'turn-a',
          streamKind: 'assistant_text',
          text: 'Hello ',
        },
        {
          id: 'delta-2',
          ts: '2026-06-29T00:00:04.000Z',
          type: 'content.delta',
          sessionId,
          turnId: 'turn-a',
          streamKind: 'assistant_text',
          text: 'world',
        },
        {
          id: 'late-snapshot',
          ts: '2026-06-29T00:00:05.000Z',
          type: 'content.delta',
          sessionId,
          turnId: 'turn-a',
          streamKind: 'assistant_text',
          text: 'Hello',
          isSnapshot: true,
        },
        {
          id: 'complete',
          ts: '2026-06-29T00:00:06.000Z',
          type: 'turn.completed',
          sessionId,
          turnId: 'turn-a',
        },
      ],
    })
  )

  const assistantMessages = projection.messages.filter(
    (message) => message.role === 'assistant'
  )

  assert.equal(assistantMessages.length, 2)
  assert.equal(
    assistantMessages.find((message) => message.runId === 'turn-a')?.content,
    'Hello world'
  )
  assert.equal(
    assistantMessages.find((message) => message.runId === 'turn-a')?.status,
    'complete'
  )
  assert.equal(
    assistantMessages.find((message) => message.runId === 'turn-a')?.ts,
    '2026-06-29T00:00:04.000Z'
  )
  assert.equal(
    assistantMessages.find((message) => message.runId === 'turn-b')?.content,
    'persisted second turn'
  )
})

test('projectSession projects plans turn diffs and work into a unified timeline', async () => {
  const { projectSession } = await loadProjectionModule()
  const sessionId = 'session-1'
  const turnId = 'turn-a'
  const projection = projectSession(
    baseSession({
      messages: [
        {
          id: 'user-1',
          sessionId,
          role: 'user',
          content: 'change a file',
          ts: '2026-06-29T00:00:00.000Z',
          status: 'complete',
          runId: turnId,
        },
      ],
      runtimeEvents: [
        {
          id: 'turn-start',
          ts: '2026-06-29T00:00:01.000Z',
          type: 'turn.started',
          sessionId,
          turnId,
        },
        {
          id: 'plan',
          ts: '2026-06-29T00:00:02.000Z',
          type: 'plan.updated',
          sessionId,
          plan: {
            id: 'plan-1',
            sessionId,
            turnId,
            title: 'Proposed plan',
            items: [{ id: 'plan-1:item-1', title: 'Edit file', status: 'pending' }],
            updatedAt: '2026-06-29T00:00:02.000Z',
          },
        },
        {
          id: 'activity',
          ts: '2026-06-29T00:00:03.000Z',
          type: 'item.completed',
          sessionId,
          item: {
            id: 'tool-1',
            sessionId,
            turnId,
            kind: 'command',
            title: 'git status',
            status: 'completed',
            startedAt: '2026-06-29T00:00:03.000Z',
            completedAt: '2026-06-29T00:00:03.500Z',
          },
        },
        {
          id: 'diff',
          ts: '2026-06-29T00:00:04.000Z',
          type: 'turn.diff.updated',
          sessionId,
          turnId,
          diff: {
            sessionId,
            turnId,
            cwd: '/tmp/project',
            repoRoot: '/tmp/project',
            generatedAt: '2026-06-29T00:00:04.000Z',
            range: {
              kind: 'checkpoint',
              fromCheckpointRef: 'refs/orrery/checkpoints/session-1/turns/0/turn-a-before',
              toCheckpointRef: 'refs/orrery/checkpoints/session-1/turns/1/turn-a-after',
              fromTurnCount: 0,
              toTurnCount: 1,
            },
            files: [
              {
                path: 'src/app.ts',
                changeType: 'change',
                additions: 2,
                deletions: 1,
              },
            ],
            totals: { files: 1, additions: 2, deletions: 1 },
          },
        },
        {
          id: 'turn-complete',
          ts: '2026-06-29T00:00:05.000Z',
          type: 'turn.completed',
          sessionId,
          turnId,
        },
      ],
    })
  )

  assert.equal(projection.activePlan?.id, 'plan-1')
  assert.equal(projection.turnDiffs.length, 1)
  assert.equal(projection.turnDiffs[0].totals.additions, 2)
  assert.deepEqual(
    projection.timeline.map((entry) => entry.kind),
    ['message', 'turn', 'plan', 'activity', 'turn-diff', 'turn']
  )
})
