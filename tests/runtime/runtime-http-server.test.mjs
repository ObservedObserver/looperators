import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startRuntimeHttpServer } from '../../dist-electron/electron/runtimeHttpServer.js'

test('compiled runtime HTTP server exposes state, config, CORS, and SSE', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-http-test-'))
  const runtimeServer = await startRuntimeHttpServer({
    port: 0,
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  })

  try {
    const base = `http://${runtimeServer.host}:${runtimeServer.port}`
    const configResponse = await fetch(`${base}/api/runtime/config`)
    assert.equal(configResponse.status, 200)
    const config = await configResponse.json()
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, runtimeServer.port)
    assert.equal(config.baseUrl, base)
    assert.equal(config.eventsUrl, `${base}/api/runtime/events`)

    const stateResponse = await fetch(`${base}/api/runtime/state`)
    assert.equal(stateResponse.status, 200)
    const state = await stateResponse.json()
    assert.equal(state.version, 5)
    assert.deepEqual(state.nodes, [])

    const contextResponse = await fetch(`${base}/api/runtime/project-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify({ cwd: process.cwd() }),
    })
    assert.equal(contextResponse.status, 200)
    assert.equal(
      contextResponse.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:5173'
    )
    const context = await contextResponse.json()
    assert.equal(context.cwd, process.cwd())

    const blockedResponse = await fetch(`${base}/api/runtime/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'https://example.invalid',
      },
      body: JSON.stringify({ prompt: 'must not start' }),
    })
    assert.equal(blockedResponse.status, 403)
    assert.equal(runtimeServer.runtime.getState().nodes.length, 0)

    const wrongTypeResponse = await fetch(`${base}/api/runtime/project-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify({ cwd: process.cwd() }),
    })
    assert.equal(wrongTypeResponse.status, 415)

    const optionsResponse = await fetch(`${base}/api/runtime/state`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5173' },
    })
    assert.equal(optionsResponse.status, 204)
    assert.equal(
      optionsResponse.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:5173'
    )

    const controller = new AbortController()
    const eventsResponse = await fetch(`${base}/api/runtime/events`, {
      signal: controller.signal,
    })
    assert.equal(eventsResponse.status, 200)
    assert.equal(
      eventsResponse.headers.get('content-type')?.startsWith('text/event-stream'),
      true
    )
    const reader = eventsResponse.body.getReader()
    const firstChunk = await reader.read()
    controller.abort()
    const text = Buffer.from(firstChunk.value ?? []).toString('utf8')
    assert.match(text, /: connected/)
  } finally {
    await runtimeServer.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
