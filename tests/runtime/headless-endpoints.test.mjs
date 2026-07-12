import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startRuntimeHttpServer } from '../../dist-electron/electron/runtimeHttpServer.js'
import { deterministicProviderAdapters } from './support/deterministic-provider.mjs'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('headless read endpoints expose sessions, graph, and event cursors', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-headless-endpoints-'))
  const runtimeServer = await startRuntimeHttpServer({
    port: 0,
    storageFile: path.join(tempRoot, 'runtime-state.json'),
    providerAdapters: deterministicProviderAdapters(),
  })

  try {
    const base = `http://${runtimeServer.host}:${runtimeServer.port}`
    const runtime = runtimeServer.runtime

    const created = await runtime.createSession({
      prompt: 'headless endpoint smoke session',
      label: 'Endpoint Smoke',
      cwd: process.cwd(),
      runtimeSettings: { model: 'preset-model-under-test' },
    })
    await waitFor(
      'session to finish',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const listResponse = await fetch(`${base}/api/runtime/sessions`)
    assert.equal(listResponse.status, 200)
    const list = await listResponse.json()
    assert.equal(list.sessions.length, 1)
    const summary = list.sessions[0]
    assert.equal(summary.sessionId, created.sessionId)
    assert.equal(summary.label, 'Endpoint Smoke')
    assert.equal(summary.status, 'idle')
    assert.equal(summary.messageCount >= 1, true)
    assert.equal(summary.runtimeSettings.model, 'preset-model-under-test')
    assert.equal(summary.runtimeEvents, undefined, 'summary must stay lightweight')

    const summaryView = await (
      await fetch(`${base}/api/runtime/sessions/${created.sessionId}`)
    ).json()
    assert.equal(summaryView.view, 'summary')
    assert.equal(summaryView.session.sessionId, created.sessionId)

    const rawView = await (
      await fetch(`${base}/api/runtime/sessions/${created.sessionId}?view=raw`)
    ).json()
    assert.equal(rawView.view, 'raw')
    assert.equal(Array.isArray(rawView.session.runtimeEvents), true)

    const transcriptView = await (
      await fetch(`${base}/api/runtime/sessions/${created.sessionId}?view=transcript`)
    ).json()
    assert.equal(transcriptView.view, 'transcript')
    assert.equal(transcriptView.projection.sessionId, created.sessionId)
    assert.equal(
      transcriptView.projection.messages.some((message) => message.role === 'user'),
      true
    )
    assert.equal(Array.isArray(transcriptView.projection.timeline), true)

    const unknownView = await fetch(
      `${base}/api/runtime/sessions/${created.sessionId}?view=bogus`
    )
    assert.equal(unknownView.status, 500)
    assert.match((await unknownView.json()).error, /Unknown session view/)

    const missingResponse = await fetch(`${base}/api/runtime/sessions/no-such-session`)
    assert.equal(missingResponse.status, 404)
    assert.match((await missingResponse.json()).error, /Unknown session/)

    const graphResponse = await fetch(`${base}/api/runtime/graph`)
    assert.equal(graphResponse.status, 200)
    const graph = await graphResponse.json()
    assert.equal(graph.nodes.length, 1)
    assert.equal(Array.isArray(graph.edges), true)
    assert.equal(typeof graph.clusters, 'object')
    assert.equal(graph.sessions, undefined, 'topology must not embed session payloads')

    const eventsResponse = await fetch(
      `${base}/api/runtime/sessions/${created.sessionId}/events`
    )
    assert.equal(eventsResponse.status, 200)
    const events = await eventsResponse.json()
    assert.equal(events.sessionId, created.sessionId)
    assert.equal(events.events.length > 0, true)
    assert.equal(events.reset, false)
    assert.equal(events.cursor, events.events.at(-1).id)

    const incremental = await (
      await fetch(
        `${base}/api/runtime/sessions/${created.sessionId}/events?since=${events.cursor}`
      )
    ).json()
    assert.equal(incremental.events.length, 0)
    assert.equal(incremental.reset, false)
    assert.equal(incremental.cursor, events.cursor)

    const resetFetch = await (
      await fetch(
        `${base}/api/runtime/sessions/${created.sessionId}/events?since=evicted-cursor`
      )
    ).json()
    assert.equal(resetFetch.reset, true)
    assert.equal(resetFetch.events.length, events.events.length)

    const commandEnvelope = {
      commandId: 'http-freeze-command',
      idempotencyKey: 'http-freeze-once',
      expectedVersion: 0,
      kind: 'freeze',
      input: { target: created.sessionId, reason: 'HTTP command envelope test' },
    }
    const commandResponse = await fetch(`${base}/api/runtime/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commandEnvelope),
    })
    assert.equal(commandResponse.status, 200)
    assert.equal(runtime.getState().controlVersion, 1)
    const repeatedCommand = await fetch(`${base}/api/runtime/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...commandEnvelope, commandId: 'http-freeze-retry' }),
    })
    assert.equal(repeatedCommand.status, 200)
    assert.equal(runtime.getState().controlVersion, 1)
    assert.equal(
      runtime.getKernelEvents({ type: 'freeze.applied' }).events.filter(
        (event) => event.payload.targetId === created.sessionId,
      ).length,
      1,
    )
    const unfreezeResponse = await fetch(`${base}/api/runtime/unfreeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: created.sessionId,
        commandId: 'http-unfreeze-command',
        idempotencyKey: 'http-unfreeze-once',
        expectedVersion: 1,
      }),
    })
    assert.equal(unfreezeResponse.status, 200)
    assert.equal(runtime.getState().controlVersion, 2)

    const councilAgent = (key) => ({
      key,
      label: key,
      providerKind: 'claude-code',
      providerInstanceId: 'default-claude-sdk',
      runtimeSettings: {
        runtimeMode: 'approval-required',
        sandbox: 'read-only',
        model: `${key}-model`,
      },
    })
    const councilResponse = await fetch(`${base}/api/runtime/plan-councils`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Compare two deterministic plans.',
        cwd: process.cwd(),
        planners: [councilAgent('planner-a'), councilAgent('planner-b')],
        synthesizer: councilAgent('synthesizer'),
      }),
    })
    assert.equal(councilResponse.status, 200)
    const councilStarted = await councilResponse.json()
    await waitFor(
      'HTTP Council proposals',
      () => runtime.getState().planCouncils[councilStarted.workflowId]?.phase === 'ready-for-cross-review',
    )
    const councilView = await (
      await fetch(`${base}/api/runtime/plan-councils/${councilStarted.workflowId}`)
    ).json()
    assert.equal(councilView.council.artifacts.length, 2)
    const firstArtifact = councilView.council.artifacts[0]
    const artifactView = await (
      await fetch(
        `${base}/api/runtime/plan-councils/${councilStarted.workflowId}/artifacts/${firstArtifact.artifactId}`,
      )
    ).json()
    assert.match(artifactView.content, /independent Planner/i)
    const crossReviewResponse = await fetch(
      `${base}/api/runtime/plan-councils/${councilStarted.workflowId}/cross-review`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
    assert.equal(crossReviewResponse.status, 200)
    await waitFor(
      'HTTP Council reviews',
      () => runtime.getState().planCouncils[councilStarted.workflowId]?.phase === 'ready-for-synthesis',
    )
    const synthesisResponse = await fetch(
      `${base}/api/runtime/plan-councils/${councilStarted.workflowId}/synthesis`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
    assert.equal(synthesisResponse.status, 200)
    await waitFor(
      'HTTP Council synthesis',
      () => runtime.getState().planCouncils[councilStarted.workflowId]?.phase === 'completed',
    )
  } finally {
    await runtimeServer.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
