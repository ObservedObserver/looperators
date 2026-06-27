import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

function fakeClaudeSource() {
  return `#!/usr/bin/env node
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
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = predicate()
    if (result) {
      return result
    }
    await delay(25)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

test('compiled RuntimeSessionManager creates, resumes, persists, and validates reports', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ts-runtime-test-'))
  const fakeClaude = path.join(tempRoot, 'claude')
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const previousClaudeBin = process.env.ORRERY_CLAUDE_BIN
  const managers = new Set()

  fs.writeFileSync(fakeClaude, fakeClaudeSource())
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude

  const manager = (input) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }

  try {
    const runtime = manager({ storageFile })
    const created = await runtime.createSession({
      prompt: 'compiled runtime create',
      label: 'Compiled Runtime',
      cwd: process.cwd(),
    })
    const sessionId = created.sessionId

    await waitFor(
      'created session idle',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )

    await runtime.resumeSession({
      sessionId,
      message: 'compiled runtime resume',
    })
    await waitFor(
      'resumed session idle',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )

    const resumedState = runtime.getState()
    assert.equal(resumedState.nodes[0].nodeId, sessionId)
    assert.equal(resumedState.nodes[0].sessionId, sessionId)
    assert.ok(resumedState.sessions[sessionId].messages.length >= 4)

    await assert.rejects(
      runtime.handleMembraneRequest({
        tool: 'report',
        source: sessionId,
        input: {
          type: 'verdict',
          verdict: 'issues',
          issues: [{ file: 'missing-message.ts' }],
        },
      }),
      /verdict issue 0 message is required/
    )
    assert.equal(runtime.getState().reports.length, 0)

    const reportResult = await runtime.handleMembraneRequest({
      tool: 'report',
      source: sessionId,
      input: {
        type: 'verdict',
        verdict: 'clean',
        summary: 'compiled runtime report accepted',
      },
    })
    assert.deepEqual(reportResult, { ok: true })
    assert.equal(runtime.getState().reports[0].payload.verdict, 'clean')

    const restored = manager({ storageFile })
    assert.equal(restored.getState().sessions[sessionId].sessionId, sessionId)
  } finally {
    for (const runtime of managers) {
      runtime.killAll()
    }
    if (previousClaudeBin === undefined) {
      delete process.env.ORRERY_CLAUDE_BIN
    } else {
      process.env.ORRERY_CLAUDE_BIN = previousClaudeBin
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
