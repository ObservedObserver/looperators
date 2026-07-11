import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
const fakeGrokAgentPath = path.resolve('tests/runtime/fixtures/fake-grok-agent.mjs')

function fakeCodexAppServerSource(markerFile) {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({
      method: message.method,
      params: message.params
    }))
    send({ id: message.id, result: { thread: { id: 'fake-codex-thread' } } })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'fake-codex-turn' } } })
    send({ method: 'turn/started', params: { turn: { id: 'fake-codex-turn' } } })
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'assistant-message', delta: 'codex profile inferred' },
    })
    send({ method: 'turn/completed', params: { turnId: 'fake-codex-turn' } })
    setTimeout(() => process.exit(0), 25)
    return
  }
  send({ id: message.id, result: {} })
})
`
}

function fakeCodexFailedTurnSource() {
  return `#!/usr/bin/env node
const readline = require('node:readline')
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'failed-thread' } } })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'failed-turn' } } })
    send({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'failed-turn',
          status: 'failed',
          error: { message: 'selected model requires a newer Codex runtime' },
        },
      },
    })
  }
})
`
}

function fakeCodexKillErrorSource() {
  return `#!/usr/bin/env node
const readline = require('node:readline')
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
process.on('SIGTERM', () => {
  process.stdout.write('not-json-during-kill\\n')
  setTimeout(() => process.exit(0), 25)
})
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'kill-thread' } } })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'kill-turn' } } })
    send({ method: 'turn/started', params: { turn: { id: 'kill-turn' } } })
  }
})
setInterval(() => {}, 1000)
`
}

function fakeCodexPermissionRequestSource(markerFile) {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
let permissionRequested = false
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'fake-codex-thread' } } })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'fake-codex-turn' } } })
    send({ method: 'turn/started', params: { turn: { id: 'fake-codex-turn' } } })
    permissionRequested = true
    send({
      id: 'codex-permission-1',
      method: 'item/permissions/requestApproval',
      params: {
        turnId: 'fake-codex-turn',
        permissions: {
          network: null,
          fileSystem: { read: [process.cwd()], write: null },
        },
        scope: 'turn',
        description: 'Need test permission',
      },
    })
    return
  }
  if (permissionRequested && message.id === 'codex-permission-1' && message.result) {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(message.result))
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'assistant-message', delta: 'permission handled' },
    })
    send({ method: 'turn/completed', params: { turnId: 'fake-codex-turn' } })
    setTimeout(() => process.exit(0), 25)
    return
  }
  send({ id: message.id, result: {} })
})
`
}

function fakeCodexUserInputRequestSource(markerFile) {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
let inputRequested = false
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'fake-codex-thread' } } })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'fake-codex-turn' } } })
    send({ method: 'turn/started', params: { turn: { id: 'fake-codex-turn' } } })
    inputRequested = true
    send({
      id: 'codex-input-1',
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'branch',
            header: 'Branch',
            question: 'Which branch?',
            options: [
              { id: 'main', label: 'main' },
              { id: 'feature', label: 'feature' },
            ],
          },
          {
            id: 'checks',
            header: 'Checks',
            question: 'Which checks?',
            multiSelect: true,
            options: [
              { id: 'tests', label: 'tests' },
              { id: 'build', label: 'build' },
            ],
          },
        ],
      },
    })
    return
  }
  if (inputRequested && message.id === 'codex-input-1' && message.result) {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(message.result))
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'assistant-message', delta: 'input handled' },
    })
    send({ method: 'turn/completed', params: { turnId: 'fake-codex-turn' } })
    setTimeout(() => process.exit(0), 25)
    return
  }
  send({ id: message.id, result: {} })
})
`
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Orrery Test',
      GIT_AUTHOR_EMAIL: 'orrery-test@example.com',
      GIT_COMMITTER_NAME: 'Orrery Test',
      GIT_COMMITTER_EMAIL: 'orrery-test@example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitRefs(cwd, root) {
  const output = git(cwd, ['for-each-ref', '--format=%(refname)', root])
  return output
    .split('\n')
    .map((ref) => ref.trim())
    .filter(Boolean)
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

function persistedStateWithSession(sessionId, cwd) {
  const ts = '2026-06-30T00:00:00.000Z'
  return {
    version: 8,
    updatedAt: ts,
    providerInstances: [],
    nodes: [
      {
        nodeId: sessionId,
        sessionId,
        label: 'Terminal Session',
        role: 'worker',
        agent: 'codex',
        status: 'idle',
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    sessions: {
      [sessionId]: {
        sessionId,
        nodeId: sessionId,
        backend: 'codex-app-server',
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
        agent: 'codex',
        label: 'Terminal Session',
        prompt: 'terminal fixture',
        cwd,
        role: 'worker',
        status: 'idle',
        createdAt: ts,
        updatedAt: ts,
        chunks: [],
        messages: [],
        nativeEvents: [],
        runtimeEvents: [],
        runtimeActivities: [],
        runtimeRequests: [],
        runtimeUserInputRequests: [],
        runtimePlans: [],
      },
    },
    clusters: {},
    reports: [],
  }
}

test('compiled RuntimeSessionManager creates, resumes, persists, and validates reports', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ts-runtime-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const emittedEvents = []

  const manager = (input) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }

  try {
    const runtime = manager({
      storageFile,
      broadcastRuntimeEvent: (event) => {
        emittedEvents.push(event)
      },
    })
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

    const requiredCallbackEvents = await waitFor('runtime event callback events', () => {
      const types = new Set(emittedEvents.map((event) => event.type))
      return (
        types.has('session.created') &&
        types.has('session.resumed') &&
        (types.has('session.finished') || types.has('runtime.state'))
      )
    })
    assert.equal(requiredCallbackEvents, true)
    assert.ok(
      emittedEvents.some(
        (event) => event.type === 'session.created' && event.sessionId === sessionId
      )
    )
    assert.ok(
      emittedEvents.some(
        (event) => event.type === 'session.resumed' && event.sessionId === sessionId
      )
    )
    const providerEvents = emittedEvents.filter(
      (event) => event.type === 'provider.runtime'
    )
    assert.ok(providerEvents.length > 0)
    assert.equal(providerEvents.every((event) => !('state' in event)), true)

    const restored = manager({ storageFile })
    assert.equal(restored.getState().sessions[sessionId].sessionId, sessionId)
  } finally {
    for (const runtime of managers) {
      runtime.killAll()
    }
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager lists workspace files for a session', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-workspace-files-test-'))
  const projectRoot = path.join(tempRoot, 'project')
  const storageFile = path.join(tempRoot, 'runtime-state.json')

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Test project\n')
  fs.writeFileSync(path.join(projectRoot, 'src', 'app.ts'), 'export const ok = true\n')
  fs.writeFileSync(path.join(projectRoot, 'node_modules', 'pkg', 'ignored.js'), 'module.exports = true\n')

  const runtime = new RuntimeSessionManager({ storageFile })

  try {
    const created = await runtime.createSession({
      prompt: 'workspace file listing',
      label: 'Workspace Files',
      cwd: projectRoot,
    })
    await waitFor(
      'workspace file session idle',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const result = runtime.getWorkspaceFiles({
      sessionId: created.sessionId,
      maxDepth: 3,
      maxEntries: 20,
    })

    assert.equal(result.cwd, projectRoot)
    assert.equal(result.totalFiles, 2)
    assert.equal(result.truncated, false)
    assert.ok(result.ignoredDirectories.includes('node_modules'))
    assert.ok(result.entries.some((entry) => entry.path === 'README.md'))
    assert.ok(
      result.entries.some((entry) =>
        entry.children?.some((child) => child.path === 'src/app.ts')
      )
    )

    const content = runtime.getWorkspaceFileContent({
      sessionId: created.sessionId,
      path: 'src/app.ts',
    })
    assert.equal(content.path, 'src/app.ts')
    assert.equal(content.isBinary, false)
    assert.match(content.content, /export const ok = true/)

    assert.throws(
      () =>
        runtime.getWorkspaceFileContent({
          sessionId: created.sessionId,
          path: '../runtime-state.json',
        }),
      /must stay inside the project folder/
    )
  } finally {
    runtime.killAll()
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager opens an auxiliary terminal for a session', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-terminal-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const sessionId = 'sess-terminal'
  const emittedEvents = []

  fs.writeFileSync(
    storageFile,
    JSON.stringify(persistedStateWithSession(sessionId, tempRoot), null, 2)
  )

  const runtime = new RuntimeSessionManager({
    storageFile,
    broadcastRuntimeEvent: (event) => emittedEvents.push(event),
  })

  try {
    const created = runtime.createTerminal({ sessionId })
    assert.equal(created.ok, true)
    assert.equal(created.terminal.sessionId, sessionId)
    assert.equal(created.terminal.cwd, tempRoot)
    assert.equal(created.terminal.status, 'running')
    assert.match(created.terminal.prompt, / .+ [%>] $/)

    const command =
      process.platform === 'win32'
        ? 'cd && echo orrery-terminal-ok'
        : 'pwd && echo orrery-terminal-ok'
    const started = runtime.runTerminalCommand({
      terminalId: created.terminal.terminalId,
      command,
    })
    assert.equal(started.ok, true)
    assert.equal(started.terminal.currentCommand.command, command)

    const finished = await waitFor('terminal command finished', () =>
      emittedEvents.find(
        (event) =>
          event.type === 'terminal.command.finished' &&
          event.command.commandId === started.commandId
      )
    )
    assert.equal(finished.command.exitCode, 0)

    const output = finished.terminal.chunks
      .map((chunk) => chunk.text)
      .join('')
    assert.match(output, /orrery-terminal-ok/)
    assert.match(output, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(output, new RegExp(`${created.terminal.prompt}${command}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(output, /❯ /)
    assert.equal(
      finished.terminal.chunks.some((chunk) =>
        chunk.text.includes('__ORRERY_COMMAND_DONE_')
      ),
      false
    )

    const cleared = runtime.clearTerminal({
      terminalId: created.terminal.terminalId,
    })
    assert.equal(cleared.terminal.chunks.length, 0)

    const closed = runtime.closeTerminal({
      terminalId: created.terminal.terminalId,
    })
    assert.equal(closed.terminal.status, 'closed')
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager persists provider instance settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-settings-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const fakeCodex = path.join(tempRoot, 'codex')
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(fakeCodex, 0o755)

  const manager = new RuntimeSessionManager({ storageFile })

  try {
    const initialState = manager.getState()
    assert.equal(initialState.providerInstances.length, 3)
    assert.ok(
      initialState.providerInstances.some(
        (instance) => instance.providerInstanceId === 'default-codex'
      )
    )

    const result = manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Local',
      binaryPath: fakeCodex,
      homePath: path.join(tempRoot, 'codex-home'),
      shadowHomePath: path.join(tempRoot, 'codex-shadow-home'),
      launchArgs: ['app-server', '--experimental'],
      env: { CODEX_PROFILE: 'local' },
    })
    assert.equal(result.providerInstance.label, 'Codex Local')
    assert.equal(result.providerInstance.binaryPath, fakeCodex)

    const setup = await manager.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      cwd: tempRoot,
    })
    assert.equal(setup.providerInstanceId, 'default-codex')
    assert.equal(
      setup.checks.find((check) => check.id === 'binary')?.status,
      'ok'
    )
    assert.equal(
      setup.checks.find((check) => check.id === 'binary')?.detail,
      fakeCodex
    )

    const restored = new RuntimeSessionManager({ storageFile })
    const restoredCodex = restored
      .getState()
      .providerInstances.find(
        (instance) => instance.providerInstanceId === 'default-codex'
      )
    assert.equal(restoredCodex?.label, 'Codex Local')
    assert.deepEqual(restoredCodex?.launchArgs, ['app-server', '--experimental'])
    assert.deepEqual(restoredCodex?.env, { CODEX_PROFILE: 'local' })

    const cleared = restored.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Default',
    })
    assert.equal(cleared.providerInstance.binaryPath, undefined)
    assert.equal(cleared.providerInstance.homePath, undefined)
    assert.equal(cleared.providerInstance.shadowHomePath, undefined)
    assert.equal(cleared.providerInstance.launchArgs, undefined)
    await assert.rejects(
      () =>
        restored.getProviderSetupStatus({
          providerKind: 'codex',
          providerInstanceId: 'missing-codex',
          cwd: tempRoot,
        }),
      /Unknown provider instance/
    )
    await assert.rejects(
      () =>
        restored.getProviderSetupStatus({
          providerKind: 'codex',
          providerInstanceId: 'default-claude-sdk',
          cwd: tempRoot,
        }),
      /not codex/
    )
    await assert.rejects(
      () =>
        restored.getProviderSetupStatus({
          providerKind: 'unknown-provider',
          cwd: tempRoot,
        }),
      /Unsupported provider kind/
    )
    assert.throws(
      () =>
        restored.upsertProviderInstance({
          providerInstanceId: 'bad-kind',
          kind: 'not-a-provider',
          label: 'Bad',
        }),
      /Unsupported provider instance kind/
    )
    assert.throws(
      () =>
        restored.upsertProviderInstance({
          providerInstanceId: 'default-grok',
          kind: 'grok',
          label: 'Grok Secret',
          env: { XAI_API_KEY: 'MUST_NOT_PERSIST' },
        }),
      /XAI_API_KEY cannot be persisted/
    )
    assert.doesNotMatch(JSON.stringify(restored.getState()), /MUST_NOT_PERSIST/)
    assert.throws(
      () =>
        restored.upsertProviderInstance({
          providerInstanceId: 'default-grok',
          kind: 'grok',
          label: 'Grok Generic Secret',
          env: { ACCESS_TOKEN: 'MUST_NOT_RETURN' },
        }),
      /looks sensitive.*cannot be persisted/
    )
    assert.doesNotMatch(JSON.stringify(restored.getState()), /MUST_NOT_RETURN/)
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('old v8 state gains default-grok without rewriting existing sessions', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-v8-normalize-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const sessionId = 'existing-claude-session'
  const ts = '2026-07-01T00:00:00.000Z'
  fs.writeFileSync(
    storageFile,
    JSON.stringify({
      version: 8,
      updatedAt: ts,
      providerInstances: [
        {
          providerInstanceId: 'custom-claude',
          kind: 'claude-code',
          label: 'Existing Claude',
          binaryPath: '/tmp/existing-claude',
        },
      ],
      nodes: [
        {
          nodeId: sessionId,
          sessionId,
          label: 'Existing session',
          role: 'worker',
          agent: 'claude-code',
          status: 'idle',
          position: { x: 12, y: 34 },
        },
      ],
      edges: [],
      sessions: {
        [sessionId]: {
          sessionId,
          nodeId: sessionId,
          backend: 'claude-agent-sdk',
          providerKind: 'claude-code',
          providerInstanceId: 'custom-claude',
          providerSessionId: 'upstream-existing',
          agent: 'claude-code',
          label: 'Existing session',
          prompt: 'keep me',
          cwd: process.cwd(),
          role: 'worker',
          status: 'idle',
          createdAt: ts,
          updatedAt: ts,
        },
      },
      clusters: {},
      reports: [],
      subscriptions: {},
      pendingActivations: {},
    })
  )

  const manager = new RuntimeSessionManager({ storageFile })
  try {
    const state = manager.getState()
    assert.equal(state.version, 8)
    assert.deepEqual(
      state.providerInstances.find((instance) => instance.providerInstanceId === 'default-grok'),
      { providerInstanceId: 'default-grok', kind: 'grok', label: 'Grok Build' }
    )
    assert.deepEqual(
      {
        backend: state.sessions[sessionId].backend,
        providerKind: state.sessions[sessionId].providerKind,
        providerInstanceId: state.sessions[sessionId].providerInstanceId,
        providerSessionId: state.sessions[sessionId].providerSessionId,
        agent: state.sessions[sessionId].agent,
        label: state.sessions[sessionId].label,
        prompt: state.sessions[sessionId].prompt,
      },
      {
        backend: 'claude-agent-sdk',
        providerKind: 'claude-code',
        providerInstanceId: 'custom-claude',
        providerSessionId: 'upstream-existing',
        agent: 'claude-code',
        label: 'Existing session',
        prompt: 'keep me',
      }
    )
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok create requests preserve provider, instance, backend, and agent metadata', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-provider-contract-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const adapter = new DeterministicProviderAdapter({ kind: 'grok' })
  const manager = new BaseRuntimeSessionManager({
    storageFile,
    providerAdapters: new Map([['grok', adapter]]),
  })

  try {
    const created = await manager.createSession({
      prompt: 'Grok provider contract',
      cwd: tempRoot,
      providerKind: 'grok',
      providerInstanceId: 'default-grok',
      runtimeSettings: {
        runtimeMode: 'approval-required',
        reasoningEffort: 'high',
      },
    })
    await waitFor(
      'Grok contract session idle',
      () => manager.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const session = manager.getState().sessions[created.sessionId]
    assert.equal(session.providerKind, 'grok')
    assert.equal(session.providerInstanceId, 'default-grok')
    assert.equal(session.backend, 'grok-acp')
    assert.equal(session.agent, 'grok')
    assert.equal(adapter.startedTurns[0].providerKind, 'grok')
    assert.equal(adapter.startedTurns[0].providerInstanceId, 'default-grok')
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager runs and cold-loads Grok through the production adapter', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-production-adapter-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const manager = new BaseRuntimeSessionManager({ storageFile })

  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Fake Grok',
      binaryPath: fakeGrokAgentPath,
      env: { FAKE_GROK_SCENARIO: 'normal' },
    })
    const created = await manager.createSession({
      prompt: 'first Grok turn',
      cwd: tempRoot,
      providerKind: 'grok',
      providerInstanceId: 'default-grok',
    })
    await waitFor(
      'first Grok turn idle',
      () => manager.getState().sessions[created.sessionId]?.status === 'idle'
    )
    const first = manager.getState().sessions[created.sessionId]
    assert.equal(first.providerSessionId, 'fake-grok-session')
    assert.ok(first.messages.some((message) => message.content === 'FAKE_GROK_TEXT'))

    await manager.resumeSession({ sessionId: created.sessionId, message: 'second Grok turn' })
    await waitFor(
      'second Grok turn idle',
      () =>
        manager.getState().sessions[created.sessionId]?.status === 'idle' &&
        manager.getState().sessions[created.sessionId]?.messages.filter(
          (message) => message.role === 'assistant'
        ).length >= 2
    )
    const resumed = manager.getState().sessions[created.sessionId]
    assert.equal(resumed.providerSessionId, 'fake-grok-session')
    assert.equal(
      resumed.messages.some((message) => message.content.includes('REPLAY_MUST_NOT_PROJECT')),
      false
    )
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager answers Grok permissions and structured input end to end', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-interactions-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const logFile = path.join(tempRoot, 'grok-wire.jsonl')
  const manager = new BaseRuntimeSessionManager({ storageFile })

  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Fake Grok Interactions',
      binaryPath: fakeGrokAgentPath,
      env: {
        FAKE_GROK_SCENARIO: 'interaction-flow',
        FAKE_GROK_LOG: logFile,
      },
    })
    const created = await manager.createSession({
      prompt: 'request Grok interactions',
      cwd: tempRoot,
      providerKind: 'grok',
      providerInstanceId: 'default-grok',
    })
    await waitFor(
      'Grok permission request open',
      () =>
        manager.getState().sessions[created.sessionId]?.runtimeRequests?.[0]
          ?.status === 'open'
    )
    const permission = manager.getState().sessions[created.sessionId].runtimeRequests[0]
    assert.equal(
      manager.respondRuntimeRequest({
        sessionId: created.sessionId,
        requestId: permission.id,
        decision: 'acceptForSession',
      }).ok,
      true
    )

    await waitFor(
      'Grok structured input open',
      () =>
        manager.getState().sessions[created.sessionId]?.runtimeUserInputRequests?.[0]
          ?.status === 'open'
    )
    const question =
      manager.getState().sessions[created.sessionId].runtimeUserInputRequests[0]
    assert.deepEqual(question.questions.map((item) => item.id), ['choice', 'many'])
    assert.throws(
      () => manager.answerUserInput({
        sessionId: created.sessionId,
        requestId: question.id,
        answers: { choice: 'beta-id' },
      }),
      /Every user input question requires a non-empty answer/,
    )
    assert.equal(
      manager.getState().sessions[created.sessionId].runtimeUserInputRequests[0].status,
      'open',
    )
    assert.equal(
      fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('"id":911'),
      false,
    )
    assert.equal(
      manager.answerUserInput({
        sessionId: created.sessionId,
        requestId: question.id,
        answers: { choice: 'beta-id', many: ['tests-id', 'custom note'] },
      }).ok,
      true
    )
    await waitFor(
      'Grok interaction session idle',
      () => manager.getState().sessions[created.sessionId]?.status === 'idle'
    )
    const session = manager.getState().sessions[created.sessionId]
    assert.equal(session.runtimeRequests[0].status, 'approved_for_session')
    assert.equal(session.runtimeUserInputRequests[0].status, 'answered')
    assert.deepEqual(session.runtimeUserInputRequests[0].answers, {
      choice: 'beta-id',
      many: ['tests-id', 'custom note'],
    })
    const wire = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(wire.find((message) => message.id === 910)?.result, {
      outcome: { outcome: 'selected', optionId: 'allow-session' },
    })
    assert.deepEqual(wire.find((message) => message.id === 911)?.result, {
      outcome: 'accepted',
      answers: { 'Pick one': ['Beta'], 'Pick many': ['Tests', 'Other'] },
      annotations: { 'Pick many': { notes: 'custom note' } },
    })
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager records Grok wire cancellation instead of the unavailable requested direction', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-permission-fallback-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const logFile = path.join(tempRoot, 'grok-wire.jsonl')
  const manager = new BaseRuntimeSessionManager({ storageFile })

  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Fake Grok Missing Always',
      binaryPath: fakeGrokAgentPath,
      env: {
        FAKE_GROK_SCENARIO: 'permission-no-always',
        FAKE_GROK_LOG: logFile,
      },
    })
    const created = await manager.createSession({
      prompt: 'request unavailable permission direction',
      cwd: tempRoot,
      providerKind: 'grok',
    })
    await waitFor(
      'Grok permission without allow_always open',
      () =>
        manager.getState().sessions[created.sessionId]?.runtimeRequests?.[0]
          ?.status === 'open'
    )
    const request = manager.getState().sessions[created.sessionId].runtimeRequests[0]
    const response = manager.respondRuntimeRequest({
      sessionId: created.sessionId,
      requestId: request.id,
      decision: 'acceptForSession',
    })
    assert.equal(response.ok, true)
    assert.equal(
      response.state.sessions[created.sessionId].runtimeRequests[0].status,
      'canceled'
    )
    await waitFor(
      'Grok permission fallback session idle',
      () => manager.getState().sessions[created.sessionId]?.status === 'idle'
    )
    const wire = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(wire.find((message) => message.id === 910)?.result, {
      outcome: { outcome: 'cancelled' },
    })
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager rejects an all-empty Grok answer and keeps the request open', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-empty-answer-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const logFile = path.join(tempRoot, 'grok-wire.jsonl')
  const manager = new BaseRuntimeSessionManager({ storageFile })

  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Fake Grok Empty Answer',
      binaryPath: fakeGrokAgentPath,
      env: {
        FAKE_GROK_SCENARIO: 'interaction-flow',
        FAKE_GROK_LOG: logFile,
      },
    })
    const created = await manager.createSession({
      prompt: 'request empty Grok answer',
      cwd: tempRoot,
      providerKind: 'grok',
    })
    await waitFor(
      'Grok empty-answer permission open',
      () =>
        manager.getState().sessions[created.sessionId]?.runtimeRequests?.[0]
          ?.status === 'open'
    )
    manager.respondRuntimeRequest({
      sessionId: created.sessionId,
      requestId: '910',
      decision: 'accept',
    })
    await waitFor(
      'Grok empty-answer question open',
      () =>
        manager.getState().sessions[created.sessionId]?.runtimeUserInputRequests?.[0]
          ?.status === 'open'
    )
    assert.throws(
      () => manager.answerUserInput({
        sessionId: created.sessionId,
        requestId: '911',
        answers: { choice: '', many: [] },
      }),
      /Every user input question requires a non-empty answer/,
    )
    assert.equal(
      manager.getState().sessions[created.sessionId].runtimeUserInputRequests[0].status,
      'open',
    )
    assert.equal(fs.readFileSync(logFile, 'utf8').includes('"id":911'), false)
  } finally {
    manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager rejects pre-clean-break graph state', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-migration-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  fs.writeFileSync(
    storageFile,
    JSON.stringify(
      {
        version: 5,
        updatedAt: '2026-06-29T00:00:00.000Z',
        providerInstances: [],
        nodes: [],
        edges: [],
        sessions: {},
        clusters: {},
        reports: [],
      },
      null,
      2
    )
  )

  try {
    assert.throws(
      () => new RuntimeSessionManager({ storageFile }),
      /Unsupported Orrery graph state version: 5.*Expected 8/
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('restored SDK sessions without a provider id resume without a fabricated local id', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-resume-id-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const sessionId = 'restored-sdk-session'
  const adapter = new DeterministicProviderAdapter()
  fs.writeFileSync(
    storageFile,
    JSON.stringify({
      version: 8,
      updatedAt: '2026-07-11T00:00:00.000Z',
      providerInstances: [],
      nodes: [],
      edges: [],
      sessions: {
        [sessionId]: {
          sessionId,
          backend: 'claude-agent-sdk',
          providerKind: 'claude-code',
          providerInstanceId: 'default-claude-sdk',
          agent: 'claude-code',
          label: 'Restored SDK',
          prompt: 'restored',
          cwd: process.cwd(),
          status: 'idle',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        },
      },
      clusters: {},
      reports: [],
    })
  )
  const runtime = new BaseRuntimeSessionManager({
    storageFile,
    providerAdapters: new Map([['claude-code', adapter]]),
  })

  try {
    assert.equal(runtime.getState().sessions[sessionId].providerSessionId, undefined)
    assert.equal(runtime.getState().sessions[sessionId].backendSessionId, undefined)

    await runtime.resumeSession({ sessionId, message: 'resume without provider id' })
    await waitFor(
      'restored session idle',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )
    assert.equal(adapter.startedTurns[0].backendSessionId, undefined)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager infers provider kind from provider instance id', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-infer-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const markerFile = path.join(tempRoot, 'codex-thread.json')
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const project = path.join(tempRoot, 'project')
  const emittedEvents = []

  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(fakeCodex, fakeCodexAppServerSource(markerFile))
  fs.chmodSync(fakeCodex, 0o755)

  const runtime = new RuntimeSessionManager({
    storageFile,
    broadcastRuntimeEvent: (event) => emittedEvents.push(event),
  })

  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Infer',
      binaryPath: fakeCodex,
    })
    const created = await runtime.createSession({
      prompt: 'infer provider from instance',
      providerInstanceId: 'default-codex',
      runtimeSettings: {
        runtimeMode: 'full-access',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
      },
      cwd: project,
    })
    await waitFor(
      'provider instance inferred codex idle',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const session = runtime.getState().sessions[created.sessionId]
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.equal(session.providerKind, 'codex')
    assert.equal(session.providerInstanceId, 'default-codex')
    assert.equal(session.effectiveRuntimeConfig.providerKind, 'codex')
    assert.equal(session.effectiveRuntimeConfig.modeLabel, 'Full access')
    assert.equal(session.effectiveRuntimeConfig.model, 'gpt-5-codex')
    assert.equal(session.effectiveRuntimeConfig.reasoningEffort, 'high')
    assert.deepEqual(session.effectiveRuntimeConfig.native, {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    assert.equal(marker.params.cwd, project)
    assert.equal(marker.params.approvalPolicy, 'never')
    assert.equal(marker.params.sandbox, 'danger-full-access')
    assert.equal(marker.params.model, 'gpt-5-codex')
    const providerEvents = emittedEvents.filter(
      (event) => event.type === 'provider.runtime'
    )
    assert.ok(providerEvents.length > 0)
    assert.equal(providerEvents.every((event) => !('state' in event)), true)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager records one failure fact for a failed Codex turn', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-failed-turn-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const storageFile = path.join(tempRoot, 'runtime-state.sqlite')
  const project = path.join(tempRoot, 'project')

  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(fakeCodex, fakeCodexFailedTurnSource())
  fs.chmodSync(fakeCodex, 0o755)

  const runtime = new RuntimeSessionManager({ storageFile })
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'failed-codex',
      kind: 'codex',
      label: 'Failed Codex',
      binaryPath: fakeCodex,
    })
    const created = await runtime.createSession({
      prompt: 'fail once',
      providerKind: 'codex',
      providerInstanceId: 'failed-codex',
      runtimeSettings: { runtimeMode: 'full-access', model: 'future-model' },
      cwd: project,
    })
    await waitFor(
      'failed Codex session',
      () => runtime.getState().sessions[created.sessionId]?.status === 'failed'
    )
    await delay(100)

    const session = runtime.getState().sessions[created.sessionId]
    const failures = runtime
      .getKernelEvents({ type: 'session.failed' })
      .events.filter((event) => event.payload?.sessionId === created.sessionId)
    assert.equal(session.status, 'failed')
    assert.match(session.error, /requires a newer Codex runtime/)
    assert.equal(failures.length, 1)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager keeps user kill authoritative over teardown errors', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-kill-error-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const storageFile = path.join(tempRoot, 'runtime-state.sqlite')
  const project = path.join(tempRoot, 'project')

  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(fakeCodex, fakeCodexKillErrorSource())
  fs.chmodSync(fakeCodex, 0o755)

  const runtime = new RuntimeSessionManager({ storageFile })
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'kill-error-codex',
      kind: 'codex',
      label: 'Kill Error Codex',
      binaryPath: fakeCodex,
    })
    const created = await runtime.createSession({
      prompt: 'wait to be killed',
      providerKind: 'codex',
      providerInstanceId: 'kill-error-codex',
      runtimeSettings: { runtimeMode: 'full-access', model: 'gpt-5.5' },
      cwd: project,
    })
    await waitFor(
      'running Codex session',
      () => runtime.getState().sessions[created.sessionId]?.status === 'running'
    )
    assert.equal(runtime.killSession(created.sessionId).ok, true)
    await waitFor(
      'killed Codex session',
      () => runtime.getState().sessions[created.sessionId]?.status === 'killed'
    )
    await delay(150)

    const session = runtime.getState().sessions[created.sessionId]
    const killedFacts = runtime
      .getKernelEvents({ type: 'session.killed' })
      .events.filter((event) => event.payload?.sessionId === created.sessionId)
    const failedFacts = runtime
      .getKernelEvents({ type: 'session.failed' })
      .events.filter((event) => event.payload?.sessionId === created.sessionId)
    assert.equal(session.status, 'killed')
    assert.equal(killedFacts.length, 1)
    assert.equal(failedFacts.length, 0)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager records unsupported Codex permission cancel as denied', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-cancel-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const markerFile = path.join(tempRoot, 'permission-response.json')
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const project = path.join(tempRoot, 'project')

  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(fakeCodex, fakeCodexPermissionRequestSource(markerFile))
  fs.chmodSync(fakeCodex, 0o755)

  const runtime = new RuntimeSessionManager({ storageFile })

  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Permission',
      binaryPath: fakeCodex,
    })
    const created = await runtime.createSession({
      prompt: 'request codex permission',
      providerInstanceId: 'default-codex',
      cwd: project,
    })
    await waitFor(
      'codex permission request open',
      () =>
        runtime.getState().sessions[created.sessionId]?.runtimeRequests?.[0]
          ?.status === 'open'
    )

    const result = runtime.respondRuntimeRequest({
      sessionId: created.sessionId,
      requestId: 'codex-permission-1',
      decision: 'cancel',
    })
    assert.equal(result.ok, true)
    assert.equal(
      result.state.sessions[created.sessionId].runtimeRequests[0].status,
      'denied'
    )
    await waitFor(
      'codex permission cancel session idle',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.deepEqual(marker, {
      permissions: {},
      scope: 'turn',
      strictAutoReview: false,
    })
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager persists structured user input answers', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-input-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const markerFile = path.join(tempRoot, 'input-response.json')
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const project = path.join(tempRoot, 'project')

  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(fakeCodex, fakeCodexUserInputRequestSource(markerFile))
  fs.chmodSync(fakeCodex, 0o755)

  const runtime = new RuntimeSessionManager({ storageFile })

  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex User Input',
      binaryPath: fakeCodex,
    })
    const created = await runtime.createSession({
      prompt: 'request codex user input',
      providerInstanceId: 'default-codex',
      cwd: project,
    })
    await waitFor(
      'codex structured user input open',
      () =>
        runtime.getState().sessions[created.sessionId]?.runtimeUserInputRequests?.[0]
          ?.status === 'open'
    )

    const result = runtime.answerUserInput({
      sessionId: created.sessionId,
      requestId: 'codex-input-1',
      answers: {
        branch: 'feature',
        checks: ['tests', 'build'],
      },
    })
    assert.equal(result.ok, true)
    const request =
      result.state.sessions[created.sessionId].runtimeUserInputRequests[0]
    assert.equal(request.status, 'answered')
    assert.deepEqual(request.answers, {
      branch: 'feature',
      checks: ['tests', 'build'],
    })
    await waitFor(
      'codex structured user input session idle',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
    )

    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.deepEqual(marker, {
      answers: {
        branch: { answers: ['feature'] },
        checks: { answers: ['tests', 'build'] },
      },
    })
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager passes provider config into master sessions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-master-config-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const project = path.join(tempRoot, 'project')

  fs.mkdirSync(project, { recursive: true })

  const runtime = new RuntimeSessionManager({ storageFile })

  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'sdk-master',
      kind: 'claude-code',
      label: 'SDK Master',
      binaryPath: '/usr/bin/true',
    })
    const worker = await runtime.createSession({
      prompt: 'worker',
      providerKind: 'claude-code',
      providerInstanceId: 'sdk-master',
      cwd: project,
    })
    await waitFor(
      'master config worker idle',
      () => runtime.getState().sessions[worker.sessionId]?.status === 'idle'
    )

    const cluster = runtime.upsertCluster({
      label: 'Config cluster',
      nodeIds: [worker.sessionId],
    })
    const master = await runtime.createMasterForCluster({
      clusterId: cluster.clusterId,
      prompt: 'master',
      providerKind: 'claude-code',
      providerInstanceId: 'sdk-master',
      runtimeSettings: {
        runtimeMode: 'full-access',
        model: 'claude-master-model',
        reasoningEffort: 'high',
      },
      cwd: project,
    })
    await waitFor(
      'master config master idle',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )

    const masterSession = runtime.getState().sessions[master.sessionId]
    assert.equal(masterSession.providerInstanceId, 'sdk-master')
    assert.equal(masterSession.runtimeSettings.runtimeMode, 'full-access')
    assert.equal(masterSession.runtimeSettings.model, 'claude-master-model')
    assert.equal(masterSession.runtimeSettings.reasoningEffort, 'high')
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager infers provider kind from master provider instance id', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-master-provider-infer-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const markerFile = path.join(tempRoot, 'codex-thread.json')
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const project = path.join(tempRoot, 'project')

  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(fakeCodex, fakeCodexAppServerSource(markerFile))
  fs.chmodSync(fakeCodex, 0o755)

  const runtime = new RuntimeSessionManager({ storageFile })

  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Master Infer',
      binaryPath: fakeCodex,
    })
    const worker = await runtime.createSession({
      prompt: 'worker',
      providerInstanceId: 'default-codex',
      cwd: project,
    })
    await waitFor(
      'master provider infer worker idle',
      () => runtime.getState().sessions[worker.sessionId]?.status === 'idle'
    )

    const cluster = runtime.upsertCluster({
      label: 'Codex inferred master cluster',
      nodeIds: [worker.sessionId],
    })
    const master = await runtime.createMasterForCluster({
      clusterId: cluster.clusterId,
      prompt: 'master',
      providerInstanceId: 'default-codex',
      cwd: project,
    })
    await waitFor(
      'master provider inferred codex idle',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )

    const masterSession = runtime.getState().sessions[master.sessionId]
    assert.equal(masterSession.providerKind, 'codex')
    assert.equal(masterSession.providerInstanceId, 'default-codex')
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager captures per-turn checkpoint diffs', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-turn-diff-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const project = path.join(tempRoot, 'project')
  const managers = new Set()

  fs.mkdirSync(project, { recursive: true })
  git(project, ['init'])
  fs.writeFileSync(path.join(project, 'README.md'), '# Turn diff test\n')
  git(project, ['add', 'README.md'])
  git(project, ['commit', '-m', 'initial'])

  const manager = (input) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }

  try {
    const runtime = manager({ storageFile })
    const created = await runtime.createSession({
      prompt: 'edit a file',
      label: 'Turn Diff',
      cwd: project,
    })
    const sessionId = created.sessionId

    await waitFor(
      'turn diff session idle',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )

    const session = runtime.getState().sessions[sessionId]
    const diffEvent = session.runtimeEvents.find(
      (event) => event.type === 'turn.diff.updated'
    )
    assert.ok(diffEvent, 'expected a turn.diff.updated runtime event')
    assert.equal(diffEvent.diff.error, undefined)
    assert.equal(diffEvent.diff.totals.files, 1)
    assert.equal(diffEvent.diff.files[0].path, 'p1-turn-diff.txt')

    const turnDiff = runtime.getWorkingTreeDiff({
      sessionId,
      turnId: diffEvent.turnId,
    })
    assert.equal(turnDiff.range.kind, 'checkpoint')
    assert.equal(turnDiff.totals.files, 1)
    assert.match(turnDiff.patch, /changed by deterministic provider/)

    const checkpointRoot = `refs/orrery/checkpoints/${sessionId}`
    const orphanRef = `${checkpointRoot}/turns/999/orphan-before`
    git(project, ['update-ref', orphanRef, git(project, ['rev-parse', 'HEAD'])])
    assert.ok(gitRefs(project, checkpointRoot).includes(orphanRef))

    await runtime.resumeSession({
      sessionId,
      message: 'edit the file again',
    })
    await waitFor(
      'second turn diff session idle',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )

    const nextSession = runtime.getState().sessions[sessionId]
    const diffEvents = nextSession.runtimeEvents.filter(
      (event) => event.type === 'turn.diff.updated'
    )
    assert.equal(diffEvents.length, 2)

    const retainedRefs = new Set(
      diffEvents.flatMap((event) => [
        event.diff.range?.fromCheckpointRef,
        event.diff.range?.toCheckpointRef,
      ])
    )
    const currentRefs = gitRefs(project, checkpointRoot)
    assert.ok(!currentRefs.includes(orphanRef))
    for (const ref of retainedRefs) {
      assert.equal(currentRefs.includes(ref), true, `${ref} should be retained`)
    }

    runtime.killAll()
    managers.delete(runtime)

    // Post-G0 the runtime persists to SQLite; write the tampered state as a
    // legacy JSON file so it loads through the migration path.
    const persisted = runtime.getState()
    persisted.sessions[sessionId].runtimeEvents = Array.from({ length: 2000 }, (_, index) => ({
      id: `filler-${index}`,
      ts: new Date(index).toISOString(),
      type: 'content.delta',
      sessionId,
      turnId: `filler-turn-${Math.floor(index / 2)}`,
      streamKind: 'assistant_text',
      text: 'filler',
    }))
    const cappedStorageFile = path.join(tempRoot, 'capped-runtime-state.json')
    fs.writeFileSync(cappedStorageFile, JSON.stringify(persisted, null, 2))

    const cappedRuntime = manager({ storageFile: cappedStorageFile })
    await cappedRuntime.resumeSession({
      sessionId,
      message: 'edit after event cap',
    })
    await waitFor(
      'event capped turn diff session idle',
      () => cappedRuntime.getState().sessions[sessionId]?.status === 'idle'
    )

    const cappedSession = cappedRuntime.getState().sessions[sessionId]
    const cappedDiffEvent = [...cappedSession.runtimeEvents]
      .reverse()
      .find((event) => event.type === 'turn.diff.updated')
    assert.ok(cappedDiffEvent, 'expected a checkpoint diff after event cap')
    assert.equal(cappedDiffEvent.diff.error, undefined)
    const cappedTurnDiff = cappedRuntime.getWorkingTreeDiff({
      sessionId,
      turnId: cappedDiffEvent.turnId,
    })
    assert.equal(cappedTurnDiff.range.kind, 'checkpoint')
    assert.match(cappedTurnDiff.patch, /changed by deterministic provider/)
  } finally {
    for (const runtime of managers) {
      runtime.killAll()
    }
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager persists structured attachments without inlining image data into chat text', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-attachment-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()

  const manager = (input) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }

  try {
    const runtime = manager({ storageFile })
    const imageDataUrl = 'data:image/png;base64,aW1hZ2UtYnl0ZXM='
    const created = await runtime.createSession({
      prompt: 'review attachments',
      label: 'Attachment Runtime',
      cwd: process.cwd(),
      attachments: [
        {
          id: 'text-attachment',
          name: 'notes.md',
          mediaType: 'text/markdown',
          size: 12,
          kind: 'text',
          text: '# Notes',
        },
        {
          id: 'image-attachment',
          name: 'screenshot.png',
          mediaType: 'image/png',
          size: 17,
          kind: 'image',
          dataUrl: imageDataUrl,
        },
        {
          id: 'svg-attachment',
          name: 'diagram.svg',
          mediaType: 'image/svg+xml',
          size: 21,
          kind: 'image',
          dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
        },
      ],
    })
    const sessionId = created.sessionId

    await waitFor(
      'attachment session idle',
      () => runtime.getState().sessions[sessionId]?.status === 'idle'
    )

    const session = runtime.getState().sessions[sessionId]
    const userMessage = session.messages.find((message) => message.role === 'user')
    assert.equal(userMessage.content, 'review attachments')
    assert.equal(userMessage.attachments.length, 3)
    assert.equal(userMessage.attachments[0].kind, 'text')
    assert.equal(userMessage.attachments[1].kind, 'image')
    assert.equal(userMessage.attachments[2].kind, 'binary')
    assert.equal(userMessage.content.includes('data:image/png'), false)

    const restored = manager({ storageFile })
    assert.equal(
      restored.getState().sessions[sessionId].messages[0].attachments[1].name,
      'screenshot.png'
    )
  } finally {
    for (const runtime of managers) {
      runtime.killAll()
    }
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager reports provider setup diagnostics', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-provider-setup-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  process.env.ORRERY_CLAUDE_BIN = path.join(tempRoot, 'missing-claude')

  try {
    const runtime = new RuntimeSessionManager({ storageFile })
    const status = await runtime.getProviderSetupStatus({
      providerKind: 'claude-code',
      cwd: path.join(tempRoot, 'missing-project'),
    })
    const binary = status.checks.find((check) => check.id === 'binary')
    const cwd = status.checks.find((check) => check.id === 'cwd')
    const auth = status.checks.find((check) => check.id === 'auth')

    assert.equal(binary.status, 'error')
    assert.equal(cwd.status, 'error')
    assert.equal(auth.status, 'unknown')
  } finally {
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager lazily probes Grok ACP and exposes the dynamic model catalog', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-setup-status-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const logFile = path.join(tempRoot, 'grok-wire.jsonl')
  const runtime = new RuntimeSessionManager({ storageFile })
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Probe Grok',
      binaryPath: fakeGrokAgentPath,
      env: {
        FAKE_GROK_SCENARIO: 'probe-models',
        FAKE_GROK_LOG: logFile,
      },
    })
    assert.equal(fs.existsSync(logFile), false, 'saving/selecting a profile must not probe eagerly')
    const [left, right] = await Promise.all([
      runtime.getProviderSetupStatus({ providerKind: 'grok', cwd: tempRoot }),
      runtime.getProviderSetupStatus({ providerKind: 'grok', cwd: tempRoot }),
    ])
    assert.deepEqual(right.models, left.models)
    assert.equal(left.checks.find((check) => check.id === 'auth')?.status, 'ok')
    assert.equal(left.checks.find((check) => check.id === 'acp-session')?.status, 'ok')
    assert.equal(left.models.currentModelId, 'grok-default')
    assert.deepEqual(
      left.models.availableModels.map((model) => model.modelId),
      ['grok-default', 'grok-no-reasoning']
    )
    assert.equal(left.models.availableModels[1].supportsReasoningEffort, false)
    const wire = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(wire.filter((entry) => entry.startup).length, 1)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager does not launch a Grok ACP probe when the binary is missing', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-missing-setup-'))
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  })
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Missing Grok',
      binaryPath: path.join(tempRoot, 'missing-grok'),
    })
    const status = await runtime.getProviderSetupStatus({
      providerKind: 'grok',
      cwd: tempRoot,
    })
    assert.equal(status.checks.find((check) => check.id === 'binary')?.status, 'error')
    assert.equal(status.checks.find((check) => check.id === 'auth')?.status, 'unknown')
    assert.equal(status.models, undefined)
  } finally {
    runtime.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager repairs restored sessions with missing worktree cwd', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-cwd-repair-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const validProject = path.join(tempRoot, 'project-root')
  const missingWorktree = path.join(tempRoot, '.orrery-worktrees', 'project-root', 'deadbeef')
  const legacyMissingCodexWorktree = path.join(
    os.homedir(),
    '.codex',
    'worktrees',
    'deadbeef',
    path.basename(process.cwd())
  )
  const ts = new Date().toISOString()
  const projectSessionId = 'repair-project-session'
  const legacySessionId = 'repair-legacy-session'

  fs.mkdirSync(validProject, { recursive: true })
  fs.writeFileSync(
    storageFile,
    `${JSON.stringify(
      {
        version: 8,
        updatedAt: ts,
        nodes: [],
        edges: [],
        clusters: {},
        reports: [],
        diagnostics: [
          {
            id: 'old-invalid-diagnostic',
            type: 'storage.cwd_invalid',
            message: 'old invalid cwd',
            ts,
            details: { sessionId: projectSessionId, cwd: missingWorktree },
          },
        ],
        sessions: {
          [projectSessionId]: {
            sessionId: projectSessionId,
            label: 'Project Worktree Session',
            prompt: 'restore project cwd',
            cwd: missingWorktree,
            project: {
              name: 'project-root',
              cwd: validProject,
              repoRoot: validProject,
              workMode: 'worktree',
              branch: 'orrery/deadbeef',
              baseBranch: 'main',
            },
            status: 'idle',
            createdAt: ts,
            updatedAt: ts,
            messages: [],
          },
          [legacySessionId]: {
            sessionId: legacySessionId,
            label: 'Legacy Codex Worktree Session',
            prompt: 'restore legacy cwd',
            cwd: legacyMissingCodexWorktree,
            status: 'idle',
            createdAt: ts,
            updatedAt: ts,
            messages: [],
          },
        },
      },
      null,
      2
    )}\n`
  )

  try {
    const runtime = new RuntimeSessionManager({ storageFile })
    const state = runtime.getState()

    assert.equal(state.sessions[projectSessionId].cwd, validProject)
    assert.equal(state.sessions[projectSessionId].project.workMode, 'local')
    assert.equal(state.sessions[legacySessionId].cwd, process.cwd())
    assert.equal(
      state.diagnostics?.some(
        (item) =>
          item.type === 'storage.cwd_invalid' &&
          item.details?.sessionId === projectSessionId
      ),
      false
    )
    assert.equal(
      state.diagnostics?.filter((item) => item.type === 'storage.cwd_repaired')
        .length,
      2
    )
    runtime.killAll()
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('compiled RuntimeSessionManager marks open provider interactions stale after restart', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-stale-request-test-'))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const ts = new Date().toISOString()
  const sessionId = 'stale-runtime-session'
  const nullSettingsSessionId = 'null-runtime-settings-session'

  fs.writeFileSync(
    storageFile,
    `${JSON.stringify(
      {
        version: 8,
        updatedAt: ts,
        nodes: [],
        edges: [],
        clusters: {},
        reports: [],
        sessions: {
          [sessionId]: {
            sessionId,
            label: 'Stale request session',
            prompt: 'restore stale request',
            cwd: process.cwd(),
            status: 'running',
            createdAt: ts,
            updatedAt: ts,
            messages: [
              {
                id: 'user-message',
                sessionId,
                role: 'user',
                content: 'hello',
                ts,
                status: 'complete',
              },
            ],
            runtimeRequests: [
              {
                id: 'approval-1',
                sessionId,
                kind: 'approval',
                title: 'Run command',
                status: 'open',
                createdAt: ts,
              },
            ],
            runtimeUserInputRequests: [
              {
                id: 'input-1',
                sessionId,
                prompt: 'Choose a branch',
                status: 'open',
                createdAt: ts,
              },
            ],
            runtimeSettings: {
              runtimeMode: 'full-access',
              model: 'gpt-5-codex',
              reasoningEffort: 'high',
            },
          },
          [nullSettingsSessionId]: {
            sessionId: nullSettingsSessionId,
            label: 'Null runtime settings session',
            prompt: 'restore null runtime settings',
            cwd: process.cwd(),
            status: 'idle',
            createdAt: ts,
            updatedAt: ts,
            messages: [],
            runtimeSettings: null,
          },
        },
      },
      null,
      2
    )}\n`
  )

  try {
    const runtime = new RuntimeSessionManager({ storageFile })
    const session = runtime.getState().sessions[sessionId]

    assert.equal(session.status, 'failed')
    assert.equal(session.runtimeRequests[0].status, 'stale')
    assert.equal(session.runtimeUserInputRequests[0].status, 'stale')
    assert.equal(session.runtimeSettings.runtimeMode, 'full-access')
    assert.equal(session.runtimeSettings.model, 'gpt-5-codex')
    assert.equal(session.runtimeSettings.reasoningEffort, 'high')
    assert.equal(
      runtime.getState().sessions[nullSettingsSessionId].runtimeSettings.runtimeMode,
      'approval-required'
    )
    assert.equal(
      runtime
        .getState()
        .diagnostics.some((item) => item.type === 'runtime.request_stale'),
      true
    )
    assert.equal(
      runtime
        .getState()
        .diagnostics.some((item) => item.type === 'runtime.user_input_stale'),
      true
    )
    runtime.killAll()
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
