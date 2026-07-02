import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  OrreryClient,
  OrreryHarness,
  resolveRequestedProviderKind,
} from '../../scripts/lib/orrery-client.mjs'

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

test('headless harness drives an isolated runtime end to end', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-client-test-'))
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)

  const harness = await OrreryHarness.start({
    env: { ORRERY_CLAUDE_BIN: fakeClaude },
    modelPreset: {
      'legacy-claude-cli': { model: 'cheap-model-for-tests' },
    },
  })

  try {
    const config = await harness.config()
    assert.equal(config.storageFile, harness.storageFile)

    let created
    const sessionCreatedEvent = await harness.waitForEvent(
      (event) => event.type === 'session.created',
      {
        timeoutMs: 10_000,
        label: 'session.created event',
        trigger: async () => {
          created = await harness.createSession({
            prompt: 'first headless client session',
            label: 'Client A',
            cwd: process.cwd(),
          })
        },
      }
    )
    assert.equal(sessionCreatedEvent.sessionId, created.sessionId)

    const idle = await harness.waitForIdle(created.sessionId, { timeoutMs: 10_000 })
    assert.equal(idle.status, 'idle')
    assert.equal(
      idle.runtimeSettings.model,
      'cheap-model-for-tests',
      'model preset must ride per-session runtime settings'
    )

    const explicit = await harness.createSession({
      prompt: 'second headless client session',
      label: 'Client B',
      cwd: process.cwd(),
      runtimeSettings: { model: 'scenario-override-model' },
    })
    const explicitIdle = await harness.waitForIdle(explicit.sessionId, {
      timeoutMs: 10_000,
    })
    assert.equal(
      explicitIdle.runtimeSettings.model,
      'scenario-override-model',
      'explicit runtime settings must beat the preset'
    )

    const sessions = await harness.sessions()
    assert.equal(sessions.length, 2)

    const transcript = await harness.transcript(created.sessionId)
    assert.equal(
      transcript.messages.some((message) =>
        String(message.content).includes('first headless client session')
      ),
      true
    )

    const graph = await harness.graph()
    assert.equal(graph.nodes.length, 2)

    const events = await harness.events(created.sessionId)
    assert.equal(events.events.length > 0, true)
    const incremental = await harness.events(created.sessionId, events.cursor)
    assert.equal(incremental.events.length, 0)

    await assert.rejects(
      () => harness.waitForIdle('missing-session', { timeoutMs: 1_000 }),
      /Unknown session/
    )
  } finally {
    const storageFile = harness.storageFile
    await harness.close()
    assert.equal(
      fs.existsSync(storageFile),
      false,
      'isolated harness must clean up its storage'
    )
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('attach mode targets an explicit base url', () => {
  const client = OrreryClient.attach('http://127.0.0.1:48274/')
  assert.equal(client.baseUrl, 'http://127.0.0.1:48274')
})

test('preset kind resolution mirrors the server providerConfig exactly', () => {
  const instances = [
    { providerInstanceId: 'isolated-codex', kind: 'codex' },
    { providerInstanceId: 'default-claude-sdk', kind: 'claude-code' },
  ]
  assert.equal(resolveRequestedProviderKind({}, instances), 'legacy-claude-cli')
  assert.equal(
    resolveRequestedProviderKind({ providerKind: 'claude-code' }, instances),
    'claude-code'
  )
  assert.equal(
    resolveRequestedProviderKind({ agent: 'codex' }, instances),
    'codex'
  )
  assert.equal(
    resolveRequestedProviderKind({ providerInstanceId: 'isolated-codex' }, instances),
    'codex',
    'instance-only input must resolve the instance kind like the server does'
  )
  assert.equal(
    resolveRequestedProviderKind({ providerKind: 'claude-code ' }, instances),
    'legacy-claude-cli',
    'untrimmed kinds must fall back exactly like the server (no client-side trim)'
  )
  assert.equal(
    resolveRequestedProviderKind(
      { providerKind: 'codex', providerInstanceId: 'default-claude-sdk' },
      instances
    ),
    'codex',
    'explicit providerKind wins over the instance kind'
  )
})
