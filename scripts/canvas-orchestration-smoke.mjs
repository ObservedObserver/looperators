import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager } from '../electron/runtime/sessionManager.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-canvas-smoke-'))
const fakeClaude = path.join(tempRoot, 'claude')
const storageFile = path.join(tempRoot, 'orrery-runtime-state.json')
const managers = new Set()

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

function installFakeClaude() {
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
}

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

function manager(input) {
  const runtime = new RuntimeSessionManager(input)
  managers.add(runtime)
  return runtime
}

try {
  installFakeClaude()

  const runtime = manager({ storageFile })
  const worker = await runtime.createSession({
    prompt: 'worker session for canvas orchestration smoke',
    label: 'Coder',
    cwd: process.cwd(),
  })
  await waitFor(
    'worker to finish',
    () => runtime.getState().sessions[worker.sessionId]?.status === 'idle'
  )

  const policy = {
    until: { whenReport: { verdict: 'clean' } },
    onStop: 'freeze',
    maxIterations: 6,
  }
  const cluster = runtime.upsertCluster({
    label: 'Review loop',
    nodeIds: [worker.sessionId],
    loopPolicy: policy,
  })

  const master = await runtime.createMasterForCluster({
    clusterId: cluster.clusterId,
    label: 'Review loop Master',
    prompt: 'master session for canvas orchestration smoke',
    loopPolicy: policy,
  })
  await waitFor(
    'master to finish',
    () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
  )

  runtime.setClusterLoopPolicy({
    clusterId: cluster.clusterId,
    loopPolicy: policy,
  })

  const state = runtime.getState()
  assert.equal(state.clusters[cluster.clusterId].nodeIds.length, 1)
  assert.equal(state.clusters[cluster.clusterId].nodeIds[0], worker.sessionId)
  assert.equal(state.clusters[cluster.clusterId].masterSessionId, master.sessionId)
  assert.equal(state.clusters[cluster.clusterId].loopPolicy.until.whenReport.verdict, 'clean')
  assert.equal(state.clusters[cluster.clusterId].loopPolicy.onStop, 'freeze')
  assert.equal(state.clusters[cluster.clusterId].loopPolicy.maxIterations, 6)
  assert.equal(state.sessions[master.sessionId].role, 'master')
  assert.equal(
    state.nodes.find((node) => node.sessionId === master.sessionId)?.role,
    'master'
  )
  assert.equal(
    state.clusters[cluster.clusterId].nodeIds.includes(master.sessionId),
    false,
    'master should not be counted as a managed worker node'
  )

  const restored = manager({ storageFile })
  const restoredState = restored.getState()
  assert.equal(restoredState.clusters[cluster.clusterId].masterSessionId, master.sessionId)
  assert.equal(restoredState.sessions[master.sessionId].role, 'master')
  assert.equal(restoredState.clusters[cluster.clusterId].loopPolicy.maxIterations, 6)
  assert.ok(
    restoredState.sessions[master.sessionId].messages.length >= 2,
    'restored master chat session should be openable in the left chat view'
  )

  console.log(
    '[canvas:orchestration] worker -> cluster -> real master session -> LoopPolicy -> restore passed'
  )
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
