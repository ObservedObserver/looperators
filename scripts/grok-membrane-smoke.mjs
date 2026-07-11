#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { RuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForTerminal(runtime, sessionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = runtime.getState().sessions[sessionId]
    if (session?.status === 'idle') return session
    if (session?.status === 'failed' || session?.status === 'killed') {
      throw new Error(session.failure?.message ?? `Grok membrane smoke ${session.status}.`)
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for Grok membrane smoke.')
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-membrane-smoke-'))
const marker = `grok-membrane-${randomUUID().slice(0, 8)}`
const runtime = new RuntimeSessionManager({
  storageFile: path.join(tempRoot, 'runtime-state.json'),
})

try {
  const created = await runtime.createSession({
    agent: 'grok',
    cwd: tempRoot,
    runtimeSettings: { runtimeMode: 'full-access', reasoningEffort: 'low' },
    prompt: [
      'Use the report tool from the orrery_membrane MCP server exactly once.',
      `Submit type "info" with payload {"marker":"${marker}"}.`,
      'After the tool succeeds, reply exactly REPORTED.',
    ].join('\n'),
  })
  const session = await waitForTerminal(runtime, created.sessionId)
  const report = runtime
    .getState()
    .reports.find((entry) => entry.payload?.type === 'info' && entry.payload?.payload?.marker === marker)
  if (!report) throw new Error('Grok completed without submitting the membrane report.')
  const assistantText = session.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text ?? '')
    .join('\n')
  process.stdout.write(
    `${JSON.stringify({ ok: true, reportReceived: true, replied: assistantText.includes('REPORTED') })}\n`,
  )
} finally {
  runtime.killAll()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
