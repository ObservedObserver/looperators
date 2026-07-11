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
  } finally {
    await runtimeServer.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
