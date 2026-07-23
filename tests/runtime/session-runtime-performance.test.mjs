import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { KernelStore } from '../../dist-electron/electron/runtime/kernelStore.js'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = () => {
      const result = predicate()
      if (result) {
        resolve(result)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for performance fixture'))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

class RepeatingSessionAdapter {
  startTurn(input) {
    const run = new EventEmitter()
    let closed = false
    run.kill = () => {
      if (closed) return false
      closed = true
      queueMicrotask(() =>
        run.emit('close', { code: null, signal: 'SIGTERM', killed: true }),
      )
      return true
    }
    setImmediate(() => {
      if (closed) return
      const ts = new Date().toISOString()
      for (let index = 0; index < 100; index += 1) {
        run.emit('providerSession', {
          providerSessionId: 'upstream-session',
        })
      }
      for (let index = 0; index < 45; index += 1) {
        run.emit('native', {
          ts,
          providerKind: 'claude-code',
          turnId: input.turnId,
          raw: {
            source: 'claude.sdk',
            messageType: 'stream_event',
            payload: { index, text: 'x'.repeat(1024) },
          },
        })
      }
      run.emit('providerEvent', {
        id: 'tool-completed',
        ts,
        type: 'item.completed',
        sessionId: input.sessionId,
        turnId: input.turnId,
        item: {
          id: 'tool-1',
          kind: 'tool_call',
          title: 'Read',
          status: 'completed',
          output: 'done',
          raw: {
            source: 'claude.sdk',
            payload: { duplicated: 'y'.repeat(4096) },
          },
        },
        raw: {
          source: 'claude.sdk',
          payload: { duplicated: 'z'.repeat(4096) },
        },
      })
      run.emit('providerEvent', {
        id: 'assistant-delta',
        ts,
        type: 'content.delta',
        sessionId: input.sessionId,
        turnId: input.turnId,
        streamKind: 'assistant_text',
        text: 'done',
      })
      run.emit('result', {
        session_id: 'upstream-session',
        result: 'done',
      })
      closed = true
      run.emit('close', { code: 0, signal: null, killed: false })
    })
    return run
  }

  closeAll() {}
}

test('provider bursts dedupe session persistence and keep hot state compact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-runtime-perf-'))
  const storageFile = path.join(root, 'state.json')
  const emitted = []
  let snapshotWrites = 0
  const originalSaveSnapshot = KernelStore.prototype.saveSnapshot
  KernelStore.prototype.saveSnapshot = function countedSnapshot(state) {
    snapshotWrites += 1
    return originalSaveSnapshot.call(this, state)
  }
  const runtime = new RuntimeSessionManager({
    storageFile,
    providerAdapters: new Map([
      ['claude-code', new RepeatingSessionAdapter()],
    ]),
    broadcastRuntimeEvent: (event) => emitted.push(event),
  })

  try {
    const created = await runtime.createSession({
      prompt: 'performance fixture',
      cwd: process.cwd(),
    })
    await waitFor(
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle',
    )

    const session = runtime.getState().sessions[created.sessionId]
    assert.equal(session.providerSessionId, 'upstream-session')
    assert.equal(session.nativeEvents.length, 40)
    assert.equal(session.runtimeEvents.find((event) => event.id === 'tool-completed').raw, undefined)
    assert.equal(
      session.runtimeEvents.find((event) => event.id === 'tool-completed').item.raw,
      undefined,
    )
    assert.equal(session.runtimeActivities[0].raw, undefined)
    assert.ok(snapshotWrites <= 8, `${snapshotWrites} full snapshots for repeated provider session events`)

    const positionResult = await runtime.dispatchCommand({
      commandId: 'position-compact',
      kind: 'update_node_positions',
      actor: { kind: 'human' },
      input: {
        positions: [
          { nodeId: created.sessionId, position: { x: 320, y: 240 } },
        ],
      },
    })
    assert.equal(positionResult.ok, true)
    assert.deepEqual(positionResult.positions, [
      { nodeId: created.sessionId, position: { x: 320, y: 240 } },
    ])
    assert.equal(Number.isNaN(Date.parse(positionResult.updatedAt)), false)
    assert.equal(
      emitted.some((event) => event.type === 'node.positions.updated'),
      true,
    )

    const database = new DatabaseSync(storageFile.replace(/\.json$/, '.sqlite'))
    const positionRecord = database
      .prepare(
        `SELECT length(result) AS bytes
         FROM command_records
         WHERE command_id = 'position-compact'`,
      )
      .get()
    const completionRecord = database
      .prepare(
        `SELECT MAX(length(result)) AS bytes
         FROM command_records
         WHERE kind = 'provider_complete_run'`,
      )
      .get()
    database.close()
    assert.ok(positionRecord.bytes < 512)
    assert.ok(completionRecord.bytes < 512)
  } finally {
    runtime.killAll()
    KernelStore.prototype.saveSnapshot = originalSaveSnapshot
    fs.rmSync(root, { recursive: true, force: true })
  }
})
