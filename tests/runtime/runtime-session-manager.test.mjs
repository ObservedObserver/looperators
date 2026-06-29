import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

function fakeClaudeSource() {
  return `#!/usr/bin/env node
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

test('compiled RuntimeSessionManager creates, resumes, persists, and validates reports', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ts-runtime-test-'))
  const fakeClaude = path.join(tempRoot, 'claude')
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const previousClaudeBin = process.env.ORRERY_CLAUDE_BIN
  const managers = new Set()
  const emittedEvents = []

  fs.writeFileSync(fakeClaude, fakeClaudeSource())
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude

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

    const restored = manager({ storageFile })
    assert.equal(restored.getState().sessions[sessionId].sessionId, sessionId)
  } finally {
    for (const runtime of managers) {
      runtime.killAll()
    }
    if (previousClaudeBin === undefined) {
      delete process.env.ORRERY_CLAUDE_BIN
    } else {
      process.env.ORRERY_CLAUDE_BIN = previousClaudeBin
    }
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
        version: 5,
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
        version: 5,
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
