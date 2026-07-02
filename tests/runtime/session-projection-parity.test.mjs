import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

import { projectSession as projectSessionElectron } from '../../dist-electron/shared/session-projection.js'

async function loadRendererProjection() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-projection-parity-'))
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
  const module = await import(pathToFileURL(modulePath).href)
  return { module, cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }) }
}

function fixtureSession() {
  return {
    sessionId: 'session-parity',
    status: 'running',
    runtimeSettings: { runtimeMode: 'approval-required', model: 'parity-model' },
    effectiveRuntimeConfig: { providerKind: 'claude-code' },
    messages: [
      {
        id: 'message-user',
        sessionId: 'session-parity',
        role: 'user',
        content: 'parity fixture prompt',
        ts: '2026-07-01T00:00:00.000Z',
        status: 'complete',
      },
      {
        id: 'message-assistant-persisted',
        sessionId: 'session-parity',
        role: 'assistant',
        content: 'persisted assistant answer',
        ts: '2026-07-01T00:00:01.000Z',
        runId: 'turn-0',
        status: 'complete',
      },
    ],
    runtimeActivities: [
      {
        id: 'activity-fallback',
        sessionId: 'session-parity',
        createdAt: '2026-07-01T00:00:02.000Z',
        turnId: 'turn-1',
        kind: 'command',
      },
    ],
    runtimeRequests: [],
    runtimeUserInputRequests: [],
    runtimePlans: [],
    runtimeEvents: [
      {
        id: 'event-turn-started',
        ts: '2026-07-01T00:00:03.000Z',
        type: 'turn.started',
        turnId: 'turn-1',
      },
      {
        id: 'event-delta-1',
        ts: '2026-07-01T00:00:04.000Z',
        type: 'content.delta',
        streamKind: 'assistant_text',
        turnId: 'turn-1',
        text: 'streamed ',
      },
      {
        id: 'event-delta-snapshot',
        ts: '2026-07-01T00:00:04.500Z',
        type: 'content.delta',
        streamKind: 'assistant_text',
        turnId: 'turn-1',
        text: 'snapshot must be skipped after deltas',
        isSnapshot: true,
      },
      {
        id: 'event-delta-2',
        ts: '2026-07-01T00:00:05.000Z',
        type: 'content.delta',
        streamKind: 'assistant_text',
        turnId: 'turn-1',
        text: 'answer',
      },
      {
        id: 'event-item-started',
        ts: '2026-07-01T00:00:05.200Z',
        type: 'item.started',
        item: {
          id: 'activity-live',
          createdAt: '2026-07-01T00:00:05.200Z',
          turnId: 'turn-1',
          kind: 'tool',
          status: 'running',
        },
      },
      {
        id: 'event-item-completed',
        ts: '2026-07-01T00:00:05.400Z',
        type: 'item.completed',
        item: {
          id: 'activity-live',
          createdAt: '2026-07-01T00:00:05.200Z',
          turnId: 'turn-1',
          kind: 'tool',
          status: 'completed',
        },
      },
      {
        id: 'event-request-opened',
        ts: '2026-07-01T00:00:05.500Z',
        type: 'request.opened',
        request: {
          id: 'request-1',
          createdAt: '2026-07-01T00:00:05.500Z',
          turnId: 'turn-1',
          command: 'rm -rf ./scratch',
        },
      },
      {
        id: 'event-request-resolved',
        ts: '2026-07-01T00:00:05.600Z',
        type: 'request.resolved',
        requestId: 'request-1',
        status: 'approved',
      },
      {
        id: 'event-user-input-requested',
        ts: '2026-07-01T00:00:05.700Z',
        type: 'user-input.requested',
        request: {
          id: 'user-input-1',
          createdAt: '2026-07-01T00:00:05.700Z',
          turnId: 'turn-1',
          question: 'continue?',
        },
      },
      {
        id: 'event-user-input-answered',
        ts: '2026-07-01T00:00:05.800Z',
        type: 'user-input.answered',
        requestId: 'user-input-1',
        answer: 'yes',
      },
      {
        id: 'event-plan-updated',
        ts: '2026-07-01T00:00:05.900Z',
        type: 'plan.updated',
        plan: {
          id: 'plan-1',
          updatedAt: '2026-07-01T00:00:05.900Z',
          turnId: 'turn-1',
          steps: ['step one'],
        },
      },
      {
        id: 'event-turn-diff',
        ts: '2026-07-01T00:00:06.000Z',
        type: 'turn.diff.updated',
        turnId: 'turn-1',
        diff: {
          turnId: 'turn-1',
          generatedAt: '2026-07-01T00:00:06.000Z',
          files: [{ name: 'a.txt' }],
        },
      },
      {
        id: 'event-turn-completed',
        ts: '2026-07-01T00:00:06.100Z',
        type: 'turn.completed',
        turnId: 'turn-1',
      },
      {
        id: 'event-session-state',
        ts: '2026-07-01T00:00:06.200Z',
        type: 'session.state',
        sessionId: 'session-parity',
        status: 'idle',
      },
    ],
  }
}

test('electron session-projection mirror matches the renderer implementation', async () => {
  const renderer = await loadRendererProjection()
  try {
    const rendererResult = renderer.module.projectSession(fixtureSession())
    const electronResult = projectSessionElectron(fixtureSession())
    assert.deepEqual(electronResult, rendererResult)
    assert.equal(electronResult.status, 'idle')
    assert.equal(
      electronResult.messages.some((message) => message.content === 'streamed answer'),
      true,
      'fixture must exercise the streamed-assistant path'
    )
  } finally {
    renderer.cleanup()
  }
})
