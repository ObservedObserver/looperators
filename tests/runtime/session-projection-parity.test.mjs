import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

import { projectSession as projectSessionElectron } from '../../dist-electron/shared/session-projection.js'
import { createRuntimeStateStore } from '../../dist-electron/shared/runtime-state-store.js'

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
        itemId: 'provider-message-1',
        text: 'streamed ',
      },
      {
        id: 'event-delta-snapshot',
        ts: '2026-07-01T00:00:04.500Z',
        type: 'content.delta',
        streamKind: 'assistant_text',
        turnId: 'turn-1',
        itemId: 'provider-message-1',
        text: 'snapshot must be skipped after deltas',
        isSnapshot: true,
      },
      {
        id: 'event-delta-2',
        ts: '2026-07-01T00:00:05.000Z',
        type: 'content.delta',
        streamKind: 'assistant_text',
        turnId: 'turn-1',
        itemId: 'provider-message-1',
        text: 'answer',
      },
      {
        id: 'event-message-completed',
        ts: '2026-07-01T00:00:05.100Z',
        type: 'message.completed',
        message: {
          id: 'message-provider-completed',
          sessionId: 'session-parity',
          role: 'assistant',
          content: 'completed answer',
          ts: '2026-07-01T00:00:05.100Z',
          runId: 'turn-1',
          providerItemId: 'provider-message-1',
          phase: 'final_answer',
          status: 'complete',
        },
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
      electronResult.messages.some((message) => message.content === 'completed answer' && message.phase === 'final_answer'),
      true,
      'fixture must exercise the completed assistant path'
    )
  } finally {
    renderer.cleanup()
  }
})

test('renderer projection reuses historical rows for append-only assistant deltas', async () => {
  const renderer = await loadRendererProjection()
  try {
    const previousSession = fixtureSession()
    const previousProjection = renderer.module.projectSession(previousSession)
    const deltaEvent = {
      id: 'event-next-turn-delta',
      ts: '2026-07-01T00:00:07.000Z',
      type: 'content.delta',
      sessionId: previousSession.sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-2',
      itemId: 'provider-message-2',
      text: 'live',
    }
    const streamingMessage = {
      id: `${previousSession.sessionId}:provider-message-2:assistant`,
      sessionId: previousSession.sessionId,
      role: 'assistant',
      content: 'live',
      ts: deltaEvent.ts,
      runId: 'turn-2',
      providerItemId: 'provider-message-2',
      status: 'streaming',
    }
    const nextSession = {
      ...previousSession,
      updatedAt: deltaEvent.ts,
      runtimeEvents: [...previousSession.runtimeEvents, deltaEvent],
      messages: [...previousSession.messages, streamingMessage],
    }

    const nextProjection = renderer.module.projectSessionIncrementally(
      nextSession,
      previousSession,
      previousProjection,
    )
    const previousHistoricalEntry = previousProjection.timeline.find((entry) => entry.kind === 'turn')
    const nextHistoricalEntry = nextProjection.timeline.find((entry) => entry.id === previousHistoricalEntry.id)

    assert.equal(nextProjection.activities, previousProjection.activities)
    assert.equal(nextHistoricalEntry, previousHistoricalEntry)
    assert.equal(nextProjection.messages.at(-1).content, 'live')
    assert.equal(nextProjection.timeline.at(-1).message, nextProjection.messages.at(-1))

    const chunkOnlySession = {
      ...nextSession,
      chunks: [{ id: 'chunk-1', sessionId: nextSession.sessionId, ts: deltaEvent.ts, stream: 'stdout', raw: 'live', text: 'live' }],
    }
    assert.equal(
      renderer.module.projectSessionIncrementally(chunkOnlySession, nextSession, nextProjection),
      nextProjection,
      'chunk-only updates must not rebuild a projection',
    )
  } finally {
    renderer.cleanup()
  }
})

test('1000-row Session replay keeps historical rows stable and avoids App root renders', async () => {
  const renderer = await loadRendererProjection()
  try {
    const ts = '2026-07-01T00:00:00.000Z'
    const session = {
      sessionId: 'session-long',
      nodeId: 'session-long',
      backend: 'local-cli',
      providerKind: 'claude-code',
      providerInstanceId: 'default',
      agent: 'claude-code',
      label: 'long session',
      prompt: 'test',
      cwd: process.cwd(),
      role: 'worker',
      status: 'running',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
      messages: Array.from({ length: 1000 }, (_, index) => ({
        id: `history-${index}`,
        sessionId: 'session-long',
        role: 'user',
        content: `history ${index}`,
        ts: new Date(Date.parse(ts) + index).toISOString(),
        status: 'complete',
      })),
      nativeEvents: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }
    const store = createRuntimeStateStore(
      {
        controlVersion: 0,
        updatedAt: ts,
        sessions: { [session.sessionId]: session },
        nodes: [],
      },
      { projectSession: renderer.module.projectSessionIncrementally },
    )
    let sessionNotifications = 0
    const unsubscribe = store.subscribeSession(session.sessionId, () => {
      sessionNotifications += 1
    })
    const initialView = store.getSessionView(session.sessionId)
    const historicalEntry = initialView.projection.timeline[0]
    let rootRenderRequests = 0

    for (let batch = 0; batch < 40; batch += 1) {
      const events = Array.from({ length: 5 }, (_, offset) => {
        const index = batch * 5 + offset
        return {
          type: 'provider.runtime',
          sessionId: session.sessionId,
          providerEvent: {
            id: `stream-${index}`,
            ts: new Date(Date.parse(ts) + 2000 + index).toISOString(),
            type: 'content.delta',
            sessionId: session.sessionId,
            streamKind: 'assistant_text',
            turnId: 'turn-stream',
            itemId: 'message-stream',
            text: 'x',
          },
        }
      })
      const result = store.applyStreamEvents(events)
      if (result.requiresRootRender) {
        rootRenderRequests += 1
      }
      store.getSessionView(session.sessionId)
    }

    const finalView = store.getSessionView(session.sessionId)
    assert.equal(rootRenderRequests, 0)
    assert.equal(sessionNotifications, 40)
    assert.equal(finalView.projection.timeline.length, 1001)
    assert.equal(finalView.projection.messages.at(-1).content.length, 200)
    assert.equal(finalView.projection.timeline[0], historicalEntry)
    unsubscribe()
  } finally {
    renderer.cleanup()
  }
})

test('capped runtime-event replay keeps the complete assistant message across full projections', async () => {
  const renderer = await loadRendererProjection()
  try {
    const ts = '2026-07-01T00:00:00.000Z'
    const session = {
      sessionId: 'session-capped',
      status: 'running',
      messages: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }
    const store = createRuntimeStateStore(
      {
        controlVersion: 0,
        updatedAt: ts,
        sessions: { [session.sessionId]: session },
        nodes: [],
      },
      { projectSession: renderer.module.projectSessionIncrementally },
    )

    for (let batch = 0; batch < 401; batch += 1) {
      const events = Array.from({ length: batch === 400 ? 1 : 5 }, (_, offset) => {
        const index = batch * 5 + offset
        return {
          type: 'provider.runtime',
          sessionId: session.sessionId,
          providerEvent: {
            id: `stream-${index}`,
            ts: new Date(Date.parse(ts) + index).toISOString(),
            type: 'content.delta',
            sessionId: session.sessionId,
            streamKind: 'assistant_text',
            turnId: 'turn-stream',
            itemId: 'message-stream',
            text: 'x',
          },
        }
      })
      store.applyStreamEvents(events)
      store.getSessionView(session.sessionId)
    }

    const beforeBoundary = store.getSessionView(session.sessionId)
    const canonicalBeforeBoundary = renderer.module.projectSession(store.getState().sessions[session.sessionId])
    assert.equal(beforeBoundary.projection.messages.at(-1).content.length, 2001)
    assert.deepEqual(beforeBoundary.projection, canonicalBeforeBoundary)

    store.applyStreamEvents([
      {
        type: 'provider.runtime',
        sessionId: session.sessionId,
        providerEvent: {
          id: 'activity-after-cap',
          ts: new Date(Date.parse(ts) + 2002).toISOString(),
          type: 'item.started',
          sessionId: session.sessionId,
          item: {
            id: 'activity-after-cap',
            sessionId: session.sessionId,
            turnId: 'turn-stream',
            kind: 'tool',
            status: 'running',
            startedAt: new Date(Date.parse(ts) + 2002).toISOString(),
          },
        },
      },
    ])
    const afterBoundary = store.getSessionView(session.sessionId)
    assert.equal(afterBoundary.projection.messages.at(-1).content.length, 2001)
    assert.deepEqual(
      afterBoundary.projection,
      renderer.module.projectSession(store.getState().sessions[session.sessionId]),
    )
  } finally {
    renderer.cleanup()
  }
})

test('capped replay keeps message.completed content authoritative over a backend streaming copy', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-capped-completion'
    const ts = '2026-07-01T00:00:00.000Z'
    const runtimeEvents = Array.from({ length: 1998 }, (_, index) => ({
      id: `filler-${index}`,
      ts: new Date(Date.parse(ts) + index).toISOString(),
      type: 'content.delta',
      sessionId,
      streamKind: 'reasoning_text',
      turnId: 'turn-stream',
      text: 'ignored',
    }))
    runtimeEvents.push(
      {
        id: 'partial-delta',
        ts: new Date(Date.parse(ts) + 1998).toISOString(),
        type: 'content.delta',
        sessionId,
        streamKind: 'assistant_text',
        turnId: 'turn-stream',
        itemId: 'provider-message',
        text: 'partial',
      },
      {
        id: 'authoritative-completion',
        ts: new Date(Date.parse(ts) + 1999).toISOString(),
        type: 'message.completed',
        sessionId,
        message: {
          id: 'provider-completed-message',
          sessionId,
          role: 'assistant',
          content: 'partial final',
          ts: new Date(Date.parse(ts) + 1999).toISOString(),
          runId: 'turn-stream',
          providerItemId: 'provider-message',
          phase: 'final_answer',
          status: 'complete',
        },
      },
    )
    const session = {
      sessionId,
      status: 'running',
      messages: [
        {
          id: 'random-backend-id',
          sessionId,
          role: 'assistant',
          content: 'partial',
          ts,
          runId: 'turn-stream',
          status: 'streaming',
        },
      ],
      runtimeEvents,
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }

    const projection = renderer.module.projectSession(session)
    const assistant = projection.messages.find((message) => message.role === 'assistant')
    assert.equal(assistant.content, 'partial final')
    assert.equal(assistant.providerItemId, 'provider-message')
    assert.equal(assistant.phase, 'final_answer')
    assert.equal(assistant.status, 'complete')
    assert.deepEqual(projectSessionElectron(session), projection)
  } finally {
    renderer.cleanup()
  }
})

test('cap rollover drops evicted lifecycle rows without losing streamed content', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-capped-turn'
    const ts = '2026-07-01T00:00:00.000Z'
    const initialState = {
      controlVersion: 0,
      updatedAt: ts,
      sessions: {
        [sessionId]: {
          sessionId,
          status: 'running',
          messages: [],
          runtimeEvents: [],
          runtimeActivities: [],
          runtimeRequests: [],
          runtimeUserInputRequests: [],
          runtimePlans: [],
        },
      },
      nodes: [],
    }
    const turnStarted = {
      type: 'provider.runtime',
      sessionId,
      providerEvent: {
        id: 'turn-started',
        ts,
        type: 'turn.started',
        sessionId,
        turnId: 'turn-stream',
      },
    }
    let state = createRuntimeStateStore(initialState)
    state.applyStreamEvents([turnStarted])
    for (let index = 0; index < 1999; index += 1) {
      state.applyStreamEvents([
        {
          type: 'provider.runtime',
          sessionId,
          providerEvent: {
            id: `stream-${index}`,
            ts: new Date(Date.parse(ts) + index + 1).toISOString(),
            type: 'content.delta',
            sessionId,
            streamKind: 'assistant_text',
            turnId: 'turn-stream',
            itemId: 'message-stream',
            text: 'x',
          },
        },
      ])
    }

    const previousSession = state.getState().sessions[sessionId]
    const previousProjection = renderer.module.projectSession(previousSession)
    assert.equal(previousProjection.timeline.filter((entry) => entry.kind === 'turn').length, 1)

    state.applyStreamEvents([
      {
        type: 'provider.runtime',
        sessionId,
        providerEvent: {
          id: 'stream-1999',
          ts: new Date(Date.parse(ts) + 2000).toISOString(),
          type: 'content.delta',
          sessionId,
          streamKind: 'assistant_text',
          turnId: 'turn-stream',
          itemId: 'message-stream',
          text: 'x',
        },
      },
    ])
    const nextSession = state.getState().sessions[sessionId]
    const incremental = renderer.module.projectSessionIncrementally(
      nextSession,
      previousSession,
      previousProjection,
    )
    const canonical = renderer.module.projectSession(nextSession)

    assert.deepEqual(incremental, canonical)
    assert.equal(incremental.timeline.filter((entry) => entry.kind === 'turn').length, 0)
    assert.equal(incremental.messages.at(-1).content.length, 2000)
  } finally {
    renderer.cleanup()
  }
})

test('capped same-run assistant items do not reappear during another item delta', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-capped-items'
    const ts = '2026-07-01T00:00:00.000Z'
    const fillerEvents = Array.from({ length: 1999 }, (_, index) => ({
      id: `reasoning-${index}`,
      ts: new Date(Date.parse(ts) + index).toISOString(),
      type: 'content.delta',
      sessionId,
      streamKind: 'reasoning_text',
      turnId: 'turn-stream',
      text: 'ignored',
    }))
    const previousSession = {
      sessionId,
      status: 'running',
      messages: [
        {
          id: 'persisted-a',
          sessionId,
          role: 'assistant',
          content: 'A',
          ts,
          runId: 'turn-stream',
          providerItemId: 'item-a',
          status: 'streaming',
        },
        {
          id: 'persisted-b',
          sessionId,
          role: 'assistant',
          content: 'B',
          ts: new Date(Date.parse(ts) + 1999).toISOString(),
          runId: 'turn-stream',
          providerItemId: 'item-b',
          status: 'streaming',
        },
      ],
      runtimeEvents: [
        ...fillerEvents,
        {
          id: 'item-b-delta-1',
          ts: new Date(Date.parse(ts) + 1999).toISOString(),
          type: 'content.delta',
          sessionId,
          streamKind: 'assistant_text',
          turnId: 'turn-stream',
          itemId: 'item-b',
          text: 'B',
        },
      ],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }
    const previousProjection = renderer.module.projectSession(previousSession)
    assert.deepEqual(
      previousProjection.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
      ['B'],
    )

    const nextEvent = {
      id: 'item-b-delta-2',
      ts: new Date(Date.parse(ts) + 2000).toISOString(),
      type: 'content.delta',
      sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-stream',
      itemId: 'item-b',
      text: '2',
    }
    const nextSession = {
      ...previousSession,
      runtimeEvents: [...previousSession.runtimeEvents.slice(1), nextEvent],
      messages: [
        previousSession.messages[0],
        {
          ...previousSession.messages[1],
          content: 'B2',
          ts: nextEvent.ts,
        },
      ],
    }
    const incremental = renderer.module.projectSessionIncrementally(
      nextSession,
      previousSession,
      previousProjection,
    )
    const canonical = renderer.module.projectSession(nextSession)

    assert.deepEqual(incremental, canonical)
    assert.deepEqual(
      incremental.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
      ['B2'],
    )
  } finally {
    renderer.cleanup()
  }
})

test('a new provider item in the same run appends instead of replacing its sibling', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-same-run-items'
    const ts = '2026-07-01T00:00:00.000Z'
    const itemAEvent = {
      id: 'item-a-delta',
      ts,
      type: 'content.delta',
      sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-stream',
      itemId: 'item-a',
      text: 'A',
    }
    const itemAMessage = {
      id: `${sessionId}:item-a:assistant`,
      sessionId,
      role: 'assistant',
      content: 'A',
      ts,
      runId: 'turn-stream',
      providerItemId: 'item-a',
      status: 'streaming',
    }
    const previousSession = {
      sessionId,
      status: 'running',
      messages: [itemAMessage],
      runtimeEvents: [itemAEvent],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }
    const previousProjection = renderer.module.projectSession(previousSession)
    const itemBEvent = {
      id: 'item-b-delta',
      ts: new Date(Date.parse(ts) + 1).toISOString(),
      type: 'content.delta',
      sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-stream',
      itemId: 'item-b',
      text: 'B',
    }
    const nextSession = {
      ...previousSession,
      messages: [
        itemAMessage,
        {
          id: `${sessionId}:item-b:assistant`,
          sessionId,
          role: 'assistant',
          content: 'B',
          ts: itemBEvent.ts,
          runId: 'turn-stream',
          providerItemId: 'item-b',
          status: 'streaming',
        },
      ],
      runtimeEvents: [...previousSession.runtimeEvents, itemBEvent],
    }
    const incremental = renderer.module.projectSessionIncrementally(
      nextSession,
      previousSession,
      previousProjection,
    )
    const canonical = renderer.module.projectSession(nextSession)

    assert.deepEqual(incremental, canonical)
    assert.deepEqual(
      incremental.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
      ['A', 'B'],
    )
  } finally {
    renderer.cleanup()
  }
})

test('incremental projection stays canonical through mixed multi-item event-cap rollover', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-cap-replay'
    const ts = '2026-07-01T00:00:00.000Z'
    const store = createRuntimeStateStore(
      {
        controlVersion: 0,
        updatedAt: ts,
        sessions: {
          [sessionId]: {
            sessionId,
            status: 'running',
            messages: [],
            runtimeEvents: [],
            runtimeActivities: [],
            runtimeRequests: [],
            runtimeUserInputRequests: [],
            runtimePlans: [],
          },
        },
        nodes: [],
      },
      { projectSession: renderer.module.projectSessionIncrementally },
    )
    store.getSessionView(sessionId)

    const providerEvents = []
    let sequence = 0
    const pushEvent = (event) => {
      providerEvents.push({
        id: `mixed-${sequence}`,
        ts: new Date(Date.parse(ts) + sequence).toISOString(),
        sessionId,
        ...event,
      })
      sequence += 1
    }

    for (let turn = 0; turn < 7; turn += 1) {
      const turnId = `turn-${turn}`
      pushEvent({ type: 'turn.started', turnId })
      for (let item = 0; item < 3; item += 1) {
        const itemId = `${turnId}-item-${item}`
        pushEvent({
          type: 'item.started',
          item: {
            id: itemId,
            sessionId,
            turnId,
            kind: 'tool',
            title: itemId,
            status: 'running',
            startedAt: new Date(Date.parse(ts) + sequence).toISOString(),
          },
        })
        for (let delta = 0; delta < 105; delta += 1) {
          const isReasoning = delta % 11 === 0
          const isSnapshot = !isReasoning && delta % 37 === 0
          pushEvent({
            type: 'content.delta',
            streamKind: isReasoning ? 'reasoning_text' : 'assistant_text',
            turnId,
            itemId,
            text: isSnapshot ? String(item).repeat(delta + 1) : `${item}`,
            ...(isSnapshot ? { isSnapshot: true } : {}),
          })
        }
        pushEvent({
          type: 'message.completed',
          message: {
            id: `${sessionId}:${itemId}:assistant`,
            sessionId,
            role: 'assistant',
            content: String(item).repeat(95),
            ts: new Date(Date.parse(ts) + sequence).toISOString(),
            runId: turnId,
            providerItemId: itemId,
            phase: item === 2 ? 'final_answer' : 'commentary',
            status: 'complete',
          },
        })
        pushEvent({
          type: 'item.completed',
          item: {
            id: itemId,
            sessionId,
            turnId,
            kind: 'tool',
            title: itemId,
            status: 'completed',
            startedAt: new Date(Date.parse(ts) + sequence - 107).toISOString(),
            completedAt: new Date(Date.parse(ts) + sequence).toISOString(),
          },
        })
      }
      pushEvent({ type: 'turn.completed', turnId })
    }

    for (let batchStart = 0; batchStart < providerEvents.length; batchStart += 5) {
      const batch = providerEvents.slice(batchStart, batchStart + 5).map((providerEvent) => ({
        type: 'provider.runtime',
        sessionId,
        providerEvent,
      }))
      store.applyStreamEvents(batch)
      const incremental = store.getSessionView(sessionId).projection
      const canonical = renderer.module.projectSession(store.getState().sessions[sessionId])
      assert.deepEqual(incremental, canonical, `projection diverged after event ${batchStart + batch.length}`)
    }
  } finally {
    renderer.cleanup()
  }
})

test('snapshot cap rollover uses the retained event window for live and canonical content', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-snapshot-rollover'
    const ts = '2026-07-01T00:00:00.000Z'
    const itemId = 'message-stream'
    const firstDelta = {
      id: 'first-delta',
      ts,
      type: 'content.delta',
      sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-stream',
      itemId,
      text: 'abc',
    }
    const runtimeEvents = [
      firstDelta,
      ...Array.from({ length: 1999 }, (_, index) => ({
        id: `reasoning-${index}`,
        ts: new Date(Date.parse(ts) + index + 1).toISOString(),
        type: 'content.delta',
        sessionId,
        streamKind: 'reasoning_text',
        turnId: 'turn-stream',
        text: 'ignored',
      })),
    ]
    const store = createRuntimeStateStore(
      {
        controlVersion: 0,
        updatedAt: ts,
        sessions: {
          [sessionId]: {
            sessionId,
            status: 'running',
            messages: [
              {
                id: `${sessionId}:${itemId}:assistant`,
                sessionId,
                role: 'assistant',
                content: 'abc',
                ts,
                runId: 'turn-stream',
                providerItemId: itemId,
                status: 'streaming',
              },
            ],
            runtimeEvents,
            runtimeActivities: [],
            runtimeRequests: [],
            runtimeUserInputRequests: [],
            runtimePlans: [],
          },
        },
        nodes: [],
      },
      { projectSession: renderer.module.projectSessionIncrementally },
    )
    store.getSessionView(sessionId)
    const snapshotTs = new Date(Date.parse(ts) + 2000).toISOString()
    store.applyStreamEvents([
      {
        type: 'provider.runtime',
        sessionId,
        providerEvent: {
          id: 'replacement-snapshot',
          ts: snapshotTs,
          type: 'content.delta',
          sessionId,
          streamKind: 'assistant_text',
          turnId: 'turn-stream',
          itemId,
          text: 'abc',
          isSnapshot: true,
        },
      },
    ])

    const session = store.getState().sessions[sessionId]
    const incremental = store.getSessionView(sessionId).projection
    const canonical = renderer.module.projectSession(session)
    assert.deepEqual(incremental, canonical)
    assert.equal(session.messages.at(-1).ts, snapshotTs)
    assert.equal(incremental.messages.at(-1).ts, snapshotTs)
  } finally {
    renderer.cleanup()
  }
})

test('post-snapshot deltas extend the projected content after an older authoritative raw snapshot', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-authoritative-snapshot'
    const ts = '2026-07-01T00:00:00.000Z'
    const itemId = 'message-stream'
    const snapshotTs = new Date(Date.parse(ts) + 1999).toISOString()
    const runtimeEvents = [
      ...Array.from({ length: 1999 }, (_, index) => ({
        id: `reasoning-${index}`,
        ts: new Date(Date.parse(ts) + index).toISOString(),
        type: 'content.delta',
        sessionId,
        streamKind: 'reasoning_text',
        turnId: 'turn-stream',
        text: 'ignored',
      })),
      {
        id: 'retained-snapshot',
        ts: snapshotTs,
        type: 'content.delta',
        sessionId,
        streamKind: 'assistant_text',
        turnId: 'turn-stream',
        itemId,
        text: 'replacement',
        isSnapshot: true,
      },
    ]
    const store = createRuntimeStateStore(
      {
        controlVersion: 0,
        updatedAt: snapshotTs,
        sessions: {
          [sessionId]: {
            sessionId,
            status: 'running',
            messages: [
              {
                id: `${sessionId}:${itemId}:assistant`,
                sessionId,
                role: 'assistant',
                content: 'old',
                ts,
                runId: 'turn-stream',
                providerItemId: itemId,
                status: 'streaming',
              },
            ],
            runtimeEvents,
            runtimeActivities: [],
            runtimeRequests: [],
            runtimeUserInputRequests: [],
            runtimePlans: [],
          },
        },
        nodes: [],
      },
      { projectSession: renderer.module.projectSessionIncrementally },
    )
    const previous = store.getSessionView(sessionId).projection
    assert.equal(previous.messages.at(-1).content, 'replacement')

    const deltaTs = new Date(Date.parse(ts) + 2000).toISOString()
    store.applyStreamEvents([
      {
        type: 'provider.runtime',
        sessionId,
        providerEvent: {
          id: 'post-snapshot-delta',
          ts: deltaTs,
          type: 'content.delta',
          sessionId,
          streamKind: 'assistant_text',
          turnId: 'turn-stream',
          itemId,
          text: '!',
        },
      },
    ])

    const session = store.getState().sessions[sessionId]
    assert.equal(session.messages.at(-1).content, 'old!')
    const incremental = store.getSessionView(sessionId).projection
    const canonical = renderer.module.projectSession(session)
    assert.deepEqual(incremental, canonical)
    assert.equal(incremental.messages.at(-1).content, 'replacement!')
  } finally {
    renderer.cleanup()
  }
})

test('a late delta preserves canonical status when the turn completion remains retained', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-late-delta'
    const ts = '2026-07-01T00:00:00.000Z'
    const itemId = 'message-stream'
    const previousSession = {
      sessionId,
      status: 'running',
      messages: [
        {
          id: `${sessionId}:${itemId}:assistant`,
          sessionId,
          role: 'assistant',
          content: 'answer',
          ts,
          runId: 'turn-stream',
          providerItemId: itemId,
          status: 'streaming',
        },
      ],
      runtimeEvents: [
        {
          id: 'answer-delta',
          ts,
          type: 'content.delta',
          sessionId,
          streamKind: 'assistant_text',
          turnId: 'turn-stream',
          itemId,
          text: 'answer',
        },
        {
          id: 'turn-completed',
          ts: new Date(Date.parse(ts) + 1).toISOString(),
          type: 'turn.completed',
          sessionId,
          turnId: 'turn-stream',
        },
      ],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }
    const previousProjection = renderer.module.projectSession(previousSession)
    assert.equal(previousProjection.messages.at(-1).status, 'complete')
    const lateDelta = {
      id: 'late-delta',
      ts: new Date(Date.parse(ts) + 2).toISOString(),
      type: 'content.delta',
      sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-stream',
      itemId,
      text: '!',
    }
    const nextSession = {
      ...previousSession,
      messages: [
        {
          ...previousSession.messages[0],
          content: 'answer!',
          ts: lateDelta.ts,
          status: 'streaming',
        },
      ],
      runtimeEvents: [...previousSession.runtimeEvents, lateDelta],
    }
    const incremental = renderer.module.projectSessionIncrementally(
      nextSession,
      previousSession,
      previousProjection,
    )
    const canonical = renderer.module.projectSession(nextSession)
    assert.deepEqual(incremental, canonical)
    assert.equal(incremental.messages.at(-1).status, 'complete')
  } finally {
    renderer.cleanup()
  }
})

test('a persisted-only assistant item restarts from its new retained delta', async () => {
  const renderer = await loadRendererProjection()
  try {
    const sessionId = 'session-persisted-only'
    const ts = '2026-07-01T00:00:00.000Z'
    const itemId = 'message-stream'
    const persistedMessage = {
      id: 'persisted-message',
      sessionId,
      role: 'assistant',
      content: 'old',
      ts,
      runId: 'turn-stream',
      providerItemId: itemId,
      phase: 'commentary',
      status: 'streaming',
    }
    const previousSession = {
      sessionId,
      status: 'running',
      messages: [persistedMessage],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
    }
    const previousProjection = renderer.module.projectSession(previousSession)
    assert.equal(previousProjection.messages.at(-1).content, 'old')
    const delta = {
      id: 'new-retained-delta',
      ts: new Date(Date.parse(ts) + 1).toISOString(),
      type: 'content.delta',
      sessionId,
      streamKind: 'assistant_text',
      turnId: 'turn-stream',
      itemId,
      text: '!',
    }
    const nextSession = {
      ...previousSession,
      messages: [
        {
          ...persistedMessage,
          content: 'old!',
          ts: delta.ts,
        },
      ],
      runtimeEvents: [delta],
    }
    const incremental = renderer.module.projectSessionIncrementally(
      nextSession,
      previousSession,
      previousProjection,
    )
    const canonical = renderer.module.projectSession(nextSession)

    assert.deepEqual(incremental, canonical)
    assert.equal(incremental.messages.at(-1).content, '!')
    assert.equal(incremental.messages.at(-1).phase, undefined)
  } finally {
    renderer.cleanup()
  }
})
