import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

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

test('membrane create_session inherits the creator runtime settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-membrane-inherit-'))
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  })

  try {
    const creator = await runtime.createSession({
      prompt: 'cheap-preset creator session',
      label: 'Creator',
      cwd: process.cwd(),
      runtimeSettings: { model: 'inherited-cheap-model', reasoningEffort: 'low' },
    })
    await waitForIdle(runtime, creator.sessionId)

    const child = await runtime.handleMembraneRequest({
      tool: 'create_session',
      source: creator.sessionId,
      input: { agent: 'claude-code', prompt: 'membrane child session' },
    })

    const childSession = runtime.getState().sessions[child.sessionId]
    assert.equal(
      childSession.runtimeSettings.model,
      'inherited-cheap-model',
      'membrane-created children must inherit the creator model (cost guard)'
    )
    assert.equal(childSession.runtimeSettings.reasoningEffort, 'low')
    assert.equal(childSession.cwd, runtime.getState().sessions[creator.sessionId].cwd)
  } finally {
    runtime.killAll()
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
