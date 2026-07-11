#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { GrokAcpAdapter } from '../dist-electron/electron/runtime/providers/grokAcpAdapter.js'

function runTurn({ adapter, binaryPath, cwd, prompt, backendSessionId, turnId }) {
  const run = adapter.startTurn({
    sessionId: 'grok-real-smoke',
    turnId,
    prompt,
    cwd,
    backendSessionId,
    attachments: [],
    runtimeSettings: { runtimeMode: 'approval-required', reasoningEffort: 'low' },
    providerInstance: {
      providerInstanceId: 'real-grok',
      kind: 'grok',
      label: 'Real Grok',
      binaryPath,
    },
  })
  return new Promise((resolve, reject) => {
    let providerSessionId = backendSessionId
    let text = ''
    let failure
    run.on('providerSession', (event) => {
      providerSessionId = event.providerSessionId
    })
    run.on('providerEvent', (event) => {
      if (event.type === 'content.delta' && event.streamKind === 'assistant_text') {
        text += event.text
      }
    })
    run.on('error', (error) => {
      failure = error
    })
    run.once('close', (close) => {
      if (failure || close.code !== 0) {
        reject(failure ?? new Error(`Grok smoke closed with code ${close.code}`))
        return
      }
      resolve({ providerSessionId, text, close })
    })
  })
}

const binaryPath = process.env.ORRERY_GROK_BIN ?? 'grok'
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-real-smoke-'))
const nonce = `ORRERY-P3-${randomUUID().slice(0, 8).toUpperCase()}`
const adapter = new GrokAcpAdapter()

try {
  const first = await runTurn({
    adapter,
    binaryPath,
    cwd,
    turnId: 'turn-1',
    prompt: `Remember this nonce for the next turn: ${nonce}. Reply exactly STORED.`,
  })
  const second = await runTurn({
    adapter,
    binaryPath,
    cwd,
    backendSessionId: first.providerSessionId,
    turnId: 'turn-2',
    prompt: 'Without reading files, reply with the nonce I asked you to remember in the previous turn.',
  })
  if (!second.text.includes(nonce)) {
    throw new Error('Cold recovery lost the expected nonce')
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        recoveredNonce: true,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  fs.rmSync(cwd, { recursive: true, force: true })
}
