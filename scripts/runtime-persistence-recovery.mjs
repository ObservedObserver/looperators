import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager } from '../electron/runtime/sessionManager.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-runtime-recovery-'))
const fakeClaude = path.join(tempRoot, 'claude')
const storageFile = path.join(tempRoot, 'orrery-runtime-state.json')
const activeStorageFile = path.join(tempRoot, 'orrery-active-runtime-state.json')
const managers = new Set()

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const prompt = readArg('-p') ?? ''
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
process.on('SIGTERM', () => process.exit(143))
emit({
  type: 'assistant',
  session_id: backendSessionId,
  message: { content: [{ type: 'text', text: 'fake response for ' + backendSessionId }] },
})
if (prompt.includes('ORRERY_DELAY')) {
  setInterval(() => {}, 1000)
} else {
  emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
}
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

function assertIdentity(state) {
  for (const node of state.nodes) {
    assert.equal(node.nodeId, node.sessionId, 'nodeId must equal sessionId')
    assert.ok(state.sessions[node.sessionId], 'every node must have a session')
  }
  for (const session of Object.values(state.sessions)) {
    assert.equal(session.nodeId, session.sessionId, 'session nodeId must equal sessionId')
  }
}

function diagnosticsOf(state) {
  return Array.isArray(state.diagnostics) ? state.diagnostics.map((item) => item.type) : []
}

function manager(input) {
  const runtime = new RuntimeSessionManager(input)
  managers.add(runtime)
  return runtime
}

try {
  installFakeClaude()

  const runtime = manager({ storageFile })
  const created = await runtime.createSession({
    prompt: 'normal restore',
    label: 'Persistence smoke',
    cwd: process.cwd(),
  })
  const sessionId = created.sessionId

  await waitFor(
    'initial session to finish',
    () => runtime.getState().sessions[sessionId]?.status === 'idle'
  )

  const restored = manager({ storageFile })
  const restoredState = restored.getState()
  assertIdentity(restoredState)
  assert.equal(restoredState.sessions[sessionId].backendSessionId, sessionId)
  assert.equal(restoredState.sessions[sessionId].messages[0].sessionId, sessionId)
  assert.ok(restoredState.sessions[sessionId].messages.length >= 2)

  await restored.resumeSession({
    sessionId,
    message: 'resume after restart',
  })
  await waitFor(
    'resumed session to finish',
    () => restored.getState().sessions[sessionId]?.status === 'idle'
  )
  const resumedState = restored.getState()
  assert.equal(resumedState.sessions[sessionId].backendSessionId, sessionId)
  assert.ok(resumedState.sessions[sessionId].messages.length >= 4)
  assertIdentity(resumedState)

  assert.ok(fs.existsSync(`${storageFile}.bak`), 'atomic writer should keep a backup')
  fs.writeFileSync(storageFile, '{"version":2,"nodes":[')
  const corruptRecovered = manager({ storageFile }).getState()
  assert.ok(corruptRecovered.sessions[sessionId], 'corrupt primary should recover from backup')
  assertIdentity(corruptRecovered)
  assert.ok(
    diagnosticsOf(corruptRecovered).includes('storage.primary_parse_failed'),
    'corrupt recovery should include primary parse diagnostic'
  )
  assert.ok(
    diagnosticsOf(corruptRecovered).includes('storage.recovered_from_backup'),
    'corrupt recovery should include backup recovery diagnostic'
  )

  const activeManager = manager({ storageFile: activeStorageFile })
  const active = await activeManager.createSession({
    prompt: 'ORRERY_DELAY simulate active run at app crash',
    label: 'Active recovery smoke',
    cwd: process.cwd(),
  })
  const activeSessionId = active.sessionId
  await waitFor(
    'active session to start',
    () => activeManager.getState().sessions[activeSessionId]?.status === 'running'
  )
  await waitFor(
    'active session to capture backend handle',
    () => activeManager.getState().sessions[activeSessionId]?.chunks.length > 0
  )

  const activeRecovered = manager({
    storageFile: activeStorageFile,
  })
  const activeRecoveredState = activeRecovered.getState()
  assertIdentity(activeRecoveredState)
  assert.equal(activeRecoveredState.sessions[activeSessionId].status, 'failed')
  assert.equal(activeRecoveredState.nodes[0].status, 'failed')
  assert.equal(activeRecoveredState.sessions[activeSessionId].backendSessionId, activeSessionId)
  assert.ok(
    diagnosticsOf(activeRecoveredState).includes('runtime.active_session_recovered'),
    'active run recovery should include a diagnostic'
  )

  activeManager.killAll()
  await waitFor(
    'original active child to stop',
    () => activeManager.getState().sessions[activeSessionId]?.status === 'killed'
  )

  await activeRecovered.resumeSession({
    sessionId: activeSessionId,
    message: 'resume recovered active session',
  })
  await waitFor(
    'recovered active session to resume and finish',
    () => activeRecovered.getState().sessions[activeSessionId]?.status === 'idle'
  )
  assertIdentity(activeRecovered.getState())

  console.log('[runtime:persistence] restore, corrupt recovery, active recovery, and resume passed')
} finally {
  for (const runtime of managers) {
    try {
      runtime.killAll()
    } catch {
      // Best effort cleanup only.
    }
  }
  delete process.env.ORRERY_CLAUDE_BIN
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
