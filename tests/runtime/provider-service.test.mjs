import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ProviderService } from '../../dist-electron/electron/runtime/providerService.js'

test('ProviderService manages provider instances, bindings, active turns, and logs', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-service-'))
  const run = new EventEmitter()
  run.kill = () => {
    run.emit('close', { code: 0, signal: 'SIGTERM', killed: true })
    return true
  }
  const adapterCalls = []
  const service = new ProviderService({
    logRoot: tempRoot,
    adapters: new Map([
      [
        'codex',
        {
          startTurn(input) {
            adapterCalls.push(input)
            return run
          },
          closeAll() {},
        },
      ],
    ]),
    providerInstances: [
      {
        providerInstanceId: 'codex-test',
        kind: 'codex',
        label: 'Codex Test',
      },
    ],
  })

  try {
    assert.deepEqual(service.listProviderInstances(), [
      {
        providerInstanceId: 'codex-test',
        kind: 'codex',
        label: 'Codex Test',
      },
    ])

    service.startTurn({
      providerKind: 'codex',
      providerInstanceId: 'codex-test',
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: process.cwd(),
      prompt: 'hello',
    })
    assert.equal(adapterCalls[0].providerInstanceId, 'codex-test')
    assert.equal(service.getBinding('session-1').providerInstanceId, 'codex-test')

    run.emit('providerSession', {
      providerSessionId: 'thread-1',
      resumeCursor: 'cursor-1',
    })
    assert.equal(service.getBinding('session-1').providerSessionId, 'thread-1')
    assert.equal(service.getBinding('session-1').resumeCursor, 'cursor-1')

    service.recordNativeEvent({
      id: 'native-1',
      sessionId: 'session-1',
      providerKind: 'codex',
      raw: { source: 'codex.app-server.notification', payload: { ok: true } },
    })
    service.recordRuntimeEvent('session-1', {
      id: 'runtime-1',
      sessionId: 'session-1',
      type: 'turn.started',
      turnId: 'turn-1',
    })
    await service.flushLogs()

    const nativeLog = fs.readFileSync(
      path.join(tempRoot, 'session-1', 'native.ndjson'),
      'utf8'
    )
    const canonicalLog = fs.readFileSync(
      path.join(tempRoot, 'session-1', 'canonical.ndjson'),
      'utf8'
    )
    assert.match(nativeLog, /native-1/)
    assert.match(canonicalLog, /runtime-1/)
  } finally {
    await service.closeAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('ProviderService registers the default Grok profile', async () => {
  const service = new ProviderService()
  try {
    assert.equal(
      service.listProviderInstances().some(
        (instance) =>
          instance.providerInstanceId === 'default-grok' &&
          instance.kind === 'grok' &&
          instance.label === 'Grok Build'
      ),
      true
    )
  } finally {
    await service.closeAll()
  }
})

test('ProviderService waits for a closing run before its final log flush', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-close-'))
  const run = new EventEmitter()
  let killed = false
  run.kill = () => {
    if (killed) return false
    killed = true
    setImmediate(() => {
      run.emit('native', {
        id: 'native-during-close',
        providerKind: 'codex',
      })
      run.emit('close', { code: 0, signal: 'SIGTERM', killed: true })
    })
    return true
  }
  const service = new ProviderService({
    logRoot: tempRoot,
    adapters: new Map([
      [
        'codex',
        {
          startTurn() {
            return run
          },
          closeAll() {},
        },
      ],
    ]),
    providerInstances: [
      {
        providerInstanceId: 'codex-test',
        kind: 'codex',
        label: 'Codex Test',
      },
    ],
  })
  service.on('provider.native', ({ sessionId, event }) => {
    service.recordNativeEvent({ ...event, sessionId })
  })

  try {
    service.startTurn({
      providerKind: 'codex',
      providerInstanceId: 'codex-test',
      sessionId: 'session-close',
      turnId: 'turn-close',
      cwd: process.cwd(),
      prompt: 'hello',
    })
    await service.closeAll()

    const nativeLog = fs.readFileSync(
      path.join(tempRoot, 'session-close', 'native.ndjson'),
      'utf8',
    )
    assert.match(nativeLog, /native-during-close/)
  } finally {
    await service.closeAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
