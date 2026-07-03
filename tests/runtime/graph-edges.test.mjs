import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { startRuntimeHttpServer } from '../../dist-electron/electron/runtimeHttpServer.js'

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
emit({
  type: 'assistant',
  session_id: backendSessionId,
  message: { content: [{ type: 'text', text: 'fake response for ' + backendSessionId }] },
})
emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
`

function installFakeClaude(tempRoot) {
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForIdle(runtime, sessionId, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (runtime.getState().sessions[sessionId]?.status === 'idle') {
      return
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${sessionId} to go idle`)
}

test('link edges: HTTP endpoints, membrane skill, and removal rules', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-edges-test-'))
  installFakeClaude(tempRoot)
  const runtimeServer = await startRuntimeHttpServer({
    port: 0,
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  })
  const base = `http://${runtimeServer.host}:${runtimeServer.port}`
  const runtime = runtimeServer.runtime
  const postJson = async (requestPath, body) => {
    const response = await fetch(`${base}${requestPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, body: await response.json() }
  }

  try {
    const coder = await runtime.createSession({
      prompt: 'coder session',
      label: 'Coder',
      cwd: process.cwd(),
    })
    const reviewer = await runtime.createSession({
      prompt: 'reviewer session',
      label: 'Reviewer',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, coder.sessionId)
    await waitForIdle(runtime, reviewer.sessionId)

    const created = await postJson('/api/runtime/edges', {
      source: reviewer.sessionId,
      target: coder.sessionId,
      label: 'reviews',
      reason: 'Reviewer watches the coder session',
    })
    assert.equal(created.status, 200)
    const edge = created.body.edge
    assert.equal(edge.kind, 'link')
    assert.equal(edge.label, 'reviews')
    assert.equal(edge.summary, 'Reviewer watches the coder session')
    assert.equal(edge.source, reviewer.sessionId)
    assert.equal(edge.target, coder.sessionId)
    assert.equal(edge.edgeId.startsWith('link:'), true)
    assert.equal(edge.call.source, reviewer.sessionId)

    const stateAfterLink = runtime.getState()
    assert.equal(stateAfterLink.version, 7)

    const duplicate = await postJson('/api/runtime/edges', {
      source: reviewer.sessionId,
      target: coder.sessionId,
      label: 'reviews',
    })
    assert.equal(duplicate.status, 200)
    assert.equal(
      duplicate.body.edge.edgeId,
      edge.edgeId,
      'same source/target/label must be idempotent'
    )

    const refreshed = await postJson('/api/runtime/edges', {
      source: reviewer.sessionId,
      target: coder.sessionId,
      label: 'reviews',
      reason: 'Updated rationale for the same link',
    })
    assert.equal(refreshed.body.edge.edgeId, edge.edgeId)
    assert.equal(
      refreshed.body.edge.summary,
      'Updated rationale for the same link',
      'a fresh reason must replace the stored summary on a dedupe hit'
    )
    assert.equal(
      runtime.getState().edges.filter((candidate) => candidate.kind === 'link').length,
      1
    )

    const differentLabel = await postJson('/api/runtime/edges', {
      source: reviewer.sessionId,
      target: coder.sessionId,
      label: 'depends-on',
    })
    assert.notEqual(differentLabel.body.edge.edgeId, edge.edgeId)

    const selfLink = await postJson('/api/runtime/edges', {
      source: coder.sessionId,
      target: coder.sessionId,
    })
    assert.equal(selfLink.status, 500)
    assert.match(selfLink.body.error, /Cannot link a session to itself/)

    const unknownTarget = await postJson('/api/runtime/edges', {
      source: coder.sessionId,
      target: 'no-such-session',
    })
    assert.equal(unknownTarget.status, 500)
    assert.match(unknownTarget.body.error, /Unknown session/)

    const membraneResult = await runtime.handleMembraneRequest({
      tool: 'link_sessions',
      source: coder.sessionId,
      input: { sessionId: reviewer.sessionId, label: 'asks', reason: 'coder asks reviewer' },
    })
    assert.equal(membraneResult.ok, true)
    const membraneEdge = runtime
      .getState()
      .edges.find((candidate) => candidate.edgeId === membraneResult.edgeId)
    assert.equal(membraneEdge.kind, 'link')
    assert.equal(membraneEdge.source, coder.sessionId)
    assert.equal(membraneEdge.call.source, coder.sessionId)

    const missingTarget = await assert.rejects(
      () =>
        runtime.handleMembraneRequest({
          tool: 'link_sessions',
          source: coder.sessionId,
          input: {},
        }),
      /link_sessions sessionId is required/
    )
    assert.equal(missingTarget, undefined)

    const removal = await postJson(
      `/api/runtime/edges/${encodeURIComponent(edge.edgeId)}/remove`
    )
    assert.equal(removal.status, 200)
    assert.equal(removal.body.ok, true)
    assert.equal(
      runtime.getState().edges.some((candidate) => candidate.edgeId === edge.edgeId),
      false
    )

    const createSessionEdge = runtime
      .getState()
      .edges.find((candidate) => candidate.kind !== 'link')
    if (createSessionEdge) {
      const blockedRemoval = await postJson(
        `/api/runtime/edges/${encodeURIComponent(createSessionEdge.edgeId)}/remove`
      )
      assert.equal(blockedRemoval.status, 500)
      assert.match(blockedRemoval.body.error, /Only link edges can be removed/)
    }

    const unknownRemoval = await postJson('/api/runtime/edges/no-such-edge/remove')
    assert.equal(unknownRemoval.status, 500)
    assert.match(unknownRemoval.body.error, /Unknown edge/)

    // Malformed percent-encoding must be a 400, not an unhandled rejection
    // that kills the runtime server process.
    const malformed = await postJson('/api/runtime/edges/%zz/remove')
    assert.equal(malformed.status, 400)
    assert.match(malformed.body.error, /Malformed URL encoding/)
    const stillAlive = await fetch(`${base}/api/runtime/config`)
    assert.equal(stillAlive.status, 200, 'server must survive malformed URLs')
  } finally {
    await runtimeServer.close()
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('link edges survive restart and v5 storage files migrate to v6', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-edges-migrate-'))
  installFakeClaude(tempRoot)
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }

  try {
    const runtime = manager({ storageFile })
    const first = await runtime.createSession({
      prompt: 'first session',
      label: 'First',
      cwd: process.cwd(),
    })
    const second = await runtime.createSession({
      prompt: 'second session',
      label: 'Second',
      cwd: process.cwd(),
    })
    await waitForIdle(runtime, first.sessionId)
    await waitForIdle(runtime, second.sessionId)
    const { edge } = runtime.linkSessions({
      source: first.sessionId,
      target: second.sessionId,
      label: 'reviews',
    })
    runtime.killAll()

    // Simulate a pre-link (v5) legacy JSON storage file: the version field
    // must not gate normalization, and persisted link edges must keep their
    // kind. Post-G0 the runtime persists to SQLite, so a bare JSON file also
    // exercises the legacy-import path.
    const persisted = runtime.getState()
    assert.equal(persisted.version, 7)
    persisted.version = 5
    const legacyStorageFile = path.join(tempRoot, 'legacy-runtime-state.json')
    fs.writeFileSync(legacyStorageFile, JSON.stringify(persisted))

    const restored = manager({ storageFile: legacyStorageFile })
    const state = restored.getState()
    assert.equal(state.version, 7, 'older storage versions must migrate forward on load')
    assert.equal(Object.keys(state.sessions).length, 2, 'sessions must survive')
    const restoredEdge = state.edges.find(
      (candidate) => candidate.edgeId === edge.edgeId
    )
    assert.equal(
      restoredEdge?.kind,
      'link',
      'persisted link edges must not degrade to another kind on reload'
    )
    assert.equal(restoredEdge?.label, 'reviews')

    // Same-store restart (SQLite snapshot) must also keep the link edge.
    const sqliteRestored = manager({ storageFile })
    const sqliteEdge = sqliteRestored
      .getState()
      .edges.find((candidate) => candidate.edgeId === edge.edgeId)
    assert.equal(sqliteEdge?.kind, 'link', 'link edge must survive a SQLite restart')
  } finally {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
