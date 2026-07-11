import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import {
  DeterministicProviderAdapter,
  deterministicRuntimeSessionManager,
} from './support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

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
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  })

  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'custom-claude-sdk',
      kind: 'claude-code',
      label: 'Custom Claude SDK',
    })
    const creator = await runtime.createSession({
      prompt: 'cheap-preset creator session',
      label: 'Creator',
      cwd: process.cwd(),
      providerInstanceId: 'custom-claude-sdk',
      runtimeSettings: { model: 'inherited-cheap-model', reasoningEffort: 'low' },
    })
    await waitForIdle(runtime, creator.sessionId)

    const child = await runtime.handleMembraneRequest({
      tool: 'create_session',
      source: creator.sessionId,
      input: { agent: 'claude-code', prompt: 'membrane child session' },
    })

    const childSession = runtime.getState().sessions[child.sessionId]
    assert.equal(childSession.providerKind, 'claude-code')
    assert.equal(childSession.backend, 'claude-agent-sdk')
    assert.equal(childSession.providerInstanceId, 'custom-claude-sdk')
    assert.equal(
      childSession.runtimeSettings.model,
      'inherited-cheap-model',
      'membrane-created children must inherit the creator model (cost guard)'
    )
    assert.equal(childSession.runtimeSettings.reasoningEffort, 'low')
    assert.equal(childSession.cwd, runtime.getState().sessions[creator.sessionId].cwd)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('membrane create_session from Codex uses the default Claude SDK profile', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-membrane-cross-provider-'))
  const runtime = new BaseRuntimeSessionManager({
    storageFile: path.join(tempRoot, 'runtime-state.json'),
    providerAdapters: new Map([
      ['claude-code', new DeterministicProviderAdapter()],
      ['codex', new DeterministicProviderAdapter({ kind: 'codex' })],
    ]),
  })

  try {
    const creator = await runtime.createSession({
      prompt: 'codex creator session',
      label: 'Codex Creator',
      cwd: process.cwd(),
      agent: 'codex',
      runtimeSettings: { model: 'codex-only-model', reasoningEffort: 'high' },
    })
    await waitForIdle(runtime, creator.sessionId)

    const child = await runtime.handleMembraneRequest({
      tool: 'create_session',
      source: creator.sessionId,
      input: { agent: 'claude-code', prompt: 'cross-provider child session' },
    })

    const childSession = runtime.getState().sessions[child.sessionId]
    assert.equal(childSession.providerKind, 'claude-code')
    assert.equal(childSession.backend, 'claude-agent-sdk')
    assert.equal(childSession.providerInstanceId, 'default-claude-sdk')
    assert.equal(childSession.runtimeSettings.model, undefined)
    assert.equal(childSession.runtimeSettings.runtimeMode, 'approval-required')
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
