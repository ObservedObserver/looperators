import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearGrokProbeCacheForTest,
  probeGrokProvider,
} from '../../dist-electron/electron/runtime/providers/grokAcpProbeService.js'

const fakeGrok = path.resolve('tests/runtime/fixtures/fake-grok-agent.mjs')

function provider(scenario, logFile) {
  return {
    providerInstanceId: `probe-${scenario}`,
    binaryPath: fakeGrok,
    env: {
      FAKE_GROK_SCENARIO: scenario,
      FAKE_GROK_LOG: logFile,
    },
  }
}

function wire(logFile) {
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
}

test('Grok readiness probe merges concurrent calls, caches success, and preserves model metadata', async () => {
  clearGrokProbeCacheForTest()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-probe-cache-'))
  const logFile = path.join(tempRoot, 'wire.jsonl')
  const input = {
    providerInstance: provider('probe-models', logFile),
    cwd: tempRoot,
    totalTimeoutMs: 1000,
  }
  try {
    const [left, right] = await Promise.all([
      probeGrokProvider(input),
      probeGrokProvider(input),
    ])
    assert.equal(left.status, 'ready')
    assert.deepEqual(right, left)
    assert.equal(left.catalog.currentModelId, 'grok-default')
    assert.deepEqual(left.catalog.availableModels[0].reasoningEfforts, ['low', 'high'])
    assert.equal(
      left.catalog.availableModels[0].metadata.unknownCapability,
      'preserved',
    )
    assert.equal(left.catalog.availableModels[1].supportsReasoningEffort, false)
    assert.equal(wire(logFile).filter((entry) => entry.startup).length, 1)

    await probeGrokProvider(input)
    assert.equal(wire(logFile).filter((entry) => entry.startup).length, 1)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok readiness probe distinguishes auth failure and total setup timeout', async () => {
  clearGrokProbeCacheForTest()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-probe-failure-'))
  try {
    fs.mkdirSync(path.join(tempRoot, 'auth-cwd'))
    fs.mkdirSync(path.join(tempRoot, 'timeout-cwd'))
    const authProvider = provider('auth-fail', path.join(tempRoot, 'auth.jsonl'))
    authProvider.env.TEST_TOKEN = 'fake auth failed'
    const auth = await probeGrokProvider({
      providerInstance: authProvider,
      cwd: path.join(tempRoot, 'auth-cwd'),
      totalTimeoutMs: 1000,
    })
    assert.equal(auth.status, 'auth-error')
    assert.match(auth.message, /grok login|XAI_API_KEY/)
    assert.doesNotMatch(auth.detail, /fake auth failed/)
    assert.match(auth.detail, /\[REDACTED\]/)

    const setup = await probeGrokProvider({
      providerInstance: provider('session-new-fail', path.join(tempRoot, 'setup.jsonl')),
      cwd: path.join(tempRoot, 'auth-cwd'),
      totalTimeoutMs: 1000,
    })
    assert.equal(setup.status, 'setup-error')
    assert.match(setup.message, /session\/new.*failed/i)

    const startedAt = Date.now()
    const timeout = await probeGrokProvider({
      providerInstance: provider('slow-setup-budget', path.join(tempRoot, 'timeout.jsonl')),
      cwd: path.join(tempRoot, 'timeout-cwd'),
      totalTimeoutMs: 350,
    })
    assert.equal(timeout.status, 'timeout')
    assert.ok(Date.now() - startedAt < 700)
    assert.match(timeout.message, /session\/new.*timed out|timed out/i)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
