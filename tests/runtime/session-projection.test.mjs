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
