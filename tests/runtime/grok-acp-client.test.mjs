import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  GrokAcpClient,
  collectGrokStderrForTest,
  redactGrokDiagnosticForTest,
} from '../../dist-electron/electron/runtime/providers/grokAcpClient.js'

const fakeGrok = path.resolve('tests/runtime/fixtures/fake-grok-agent.mjs')

function clientFor(tempRoot, scenario, extraEnv = {}) {
  return new GrokAcpClient({
    cwd: tempRoot,
    providerInstance: {
      binaryPath: fakeGrok,
      env: { FAKE_GROK_SCENARIO: scenario, ...extraEnv },
    },
  })
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

test('Grok ACP client correlates requests and streams notifications', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-client-'))
  const client = clientFor(tempRoot, 'normal')
  const notifications = []
  client.on('notification', (message) => notifications.push(message))
  try {
    assert.deepEqual(await client.request('initialize', {}, { timeoutMs: 1000 }), {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
    })
    assert.deepEqual(
      await client.request(
        'session/prompt',
        { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] },
        { timeoutMs: 1000 }
      ),
      { stopReason: 'end_turn' }
    )
    assert.equal(notifications[0].params.update.content.text, 'FAKE_GROK_TEXT')
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok ACP client launches grok agent stdio with provider args and env', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-launch-'))
  const logFile = path.join(tempRoot, 'wire.jsonl')
  const client = new GrokAcpClient({
    cwd: tempRoot,
    providerInstance: {
      binaryPath: fakeGrok,
      launchArgs: ['--profile', 'test'],
      env: { FAKE_GROK_LOG: logFile, FAKE_GROK_CUSTOM: 'yes' },
    },
  })
  try {
    await client.request('initialize', {}, { timeoutMs: 1000 })
    const startup = JSON.parse(fs.readFileSync(logFile, 'utf8').split('\n')[0]).startup
    assert.deepEqual(startup.argv, ['agent', '--profile', 'test', 'stdio'])
    assert.equal(startup.custom, 'yes')
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok ACP client keeps malformed frames non-fatal', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-malformed-'))
  const client = clientFor(tempRoot, 'malformed')
  const protocolErrors = []
  client.on('protocolError', (error) => protocolErrors.push(error))
  try {
    const result = await client.request('initialize', {}, { timeoutMs: 1000 })
    assert.equal(result.protocolVersion, 1)
    assert.match(protocolErrors[0].message, /Invalid Grok ACP JSON line/)
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok ACP client reports RPC errors and timeouts with method context', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-errors-'))
  const rejected = clientFor(tempRoot, 'rpc-error')
  await assert.rejects(
    () => rejected.request('authenticate', {}, { timeoutMs: 1000 }),
    /authenticate failed \(-32001\): fake request rejected/
  )
  rejected.close()

  const timedOut = clientFor(tempRoot, 'timeout')
  await assert.rejects(
    () => timedOut.request('initialize', {}, { timeoutMs: 40 }),
    /timed out: initialize after 40ms/
  )
  timedOut.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('Grok ACP client redacts known secret values from JSON-RPC errors and native messages', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-rpc-redaction-'))
  const secret = 'fake request rejected'
  const client = new GrokAcpClient({
    cwd: tempRoot,
    providerInstance: {
      binaryPath: fakeGrok,
      env: { FAKE_GROK_SCENARIO: 'rpc-error', TEST_TOKEN: secret },
    },
  })
  const messages = []
  client.on('message', (message) => messages.push(message))
  try {
    await assert.rejects(
      client.request('initialize', {}, { timeoutMs: 500 }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret))
        assert.match(error.message, /\[REDACTED\]/)
        return true
      },
    )
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(secret))
    assert.match(JSON.stringify(messages), /\[REDACTED\]/)
  } finally {
    client.close({ graceMs: 50 })
    await client.waitForClose()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok ACP client rejects unknown server requests and surfaces orphan responses', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-unknown-'))
  const logFile = path.join(tempRoot, 'wire.jsonl')
  const unknown = clientFor(tempRoot, 'unknown-request', { FAKE_GROK_LOG: logFile })
  try {
    await unknown.request('initialize', {}, { timeoutMs: 1000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const messages = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(
      messages.some(
        (message) =>
          message.id === 900 &&
          message.error?.code === -32601 &&
          /unknown\/method/.test(message.error.message)
      )
    )
  } finally {
    unknown.close()
  }

  const orphan = clientFor(tempRoot, 'orphan-response')
  const orphanMessage = once(orphan, 'orphanResponse')
  await orphan.request('initialize', {}, { timeoutMs: 1000 })
  assert.equal((await orphanMessage).id, 999)
  orphan.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('Grok ACP client exposes server requests and writes explicit responses and notifications', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-server-request-'))
  const logFile = path.join(tempRoot, 'wire.jsonl')
  const client = clientFor(tempRoot, 'known-request', { FAKE_GROK_LOG: logFile })
  client.on('request', (message) => {
    void client.respond(message.id, { outcome: { outcome: 'cancelled' } })
  })
  try {
    await client.request('initialize', {}, { timeoutMs: 1000 })
    await client.notify('session/cancel', { sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const messages = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(
      messages.some(
        (message) =>
          message.id === 901 && message.result?.outcome?.outcome === 'cancelled'
      )
    )
    assert.ok(
      messages.some(
        (message) =>
          message.method === 'session/cancel' && message.params.sessionId === 'session-1'
      )
    )
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok ACP client includes bounded stderr on early exit and redacts credential values', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-exit-'))
  assert.equal(
    redactGrokDiagnosticForTest('failed with TOP_SECRET_VALUE', {
      XAI_API_KEY: 'TOP_SECRET_VALUE',
    }),
    'failed with [REDACTED]'
  )
  assert.deepEqual(
    collectGrokStderrForTest(['failed with TOP_', 'SECRET_VALUE\n'], {
      XAI_API_KEY: 'TOP_SECRET_VALUE',
    }).emitted,
    ['failed with [REDACTED]']
  )
  assert.deepEqual(
    collectGrokStderrForTest([`${'x'.repeat(20_000)}\n`], {}).emitted,
    ['[stderr line omitted: too long]']
  )
  const client = clientFor(tempRoot, 'stderr-exit')
  try {
    await assert.rejects(
      () => client.request('initialize', {}, { timeoutMs: 1000 }),
      (error) => {
        assert.match(error.message, /code=7/)
        assert.match(error.message, /diagnostic without credentials/)
        assert.doesNotMatch(error.message, /TOP_SECRET_VALUE/)
        return true
      }
    )
  } finally {
    assert.equal(client.close(), false)
  }

  const midRequestExit = clientFor(tempRoot, 'early-exit')
  await assert.rejects(
    () => midRequestExit.request('initialize', {}, { timeoutMs: 1000 }),
    /code=3/
  )
  assert.equal(midRequestExit.close(), false)
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('Grok ACP client keeps only a bounded stderr tail', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-stderr-tail-'))
  const client = clientFor(tempRoot, 'stderr-many')
  try {
    await assert.rejects(
      () => client.request('initialize', {}, { timeoutMs: 1000 }),
      (error) => {
        assert.doesNotMatch(error.message, /diagnostic-0(?:\D|$)/)
        assert.match(error.message, /diagnostic-24/)
        return true
      }
    )
    assert.equal(client.stderrTail.length, 20)
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok ACP client closes idempotently and escalates an ignored SIGTERM', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-close-'))
  const client = clientFor(tempRoot, 'ignore-term')
  await client.request('initialize', {}, { timeoutMs: 1000 })
  const closed = once(client, 'close')
  assert.equal(client.close({ graceMs: 40 }), true)
  assert.equal(client.close({ graceMs: 40 }), false)
  const result = await closed
  assert.equal(result.signal, 'SIGKILL')
  fs.rmSync(tempRoot, { recursive: true, force: true })
})
