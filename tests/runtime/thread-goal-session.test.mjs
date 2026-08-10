import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { SessionCommandRuntime } from '../../dist-electron/electron/runtime/sessions/sessionCommandRuntime.js'

async function waitFor(label, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function writeGoalProvider(dir) {
  const requestLog = path.join(dir, 'requests.jsonl')
  const binaryPath = path.join(dir, 'codex')
  fs.writeFileSync(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const requestLog = ${JSON.stringify(requestLog)}
const active = { threadId: 'provider-goal-thread', objective: 'write marker', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 100 }
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  fs.appendFileSync(requestLog, JSON.stringify(message) + '\\n')
  if (message.method === 'initialize') return send({ id: message.id, result: {} })
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'provider-goal-thread' } } })
  if (message.method === 'thread/goal/set') {
    send({ id: message.id, result: { goal: active } })
    send({ method: 'thread/goal/updated', params: { threadId: active.threadId, goal: active } })
    setTimeout(() => {
      send({ method: 'item/completed', params: { item: { id: 'goal-message', type: 'agentMessage', text: 'goal complete', status: 'completed' } } })
      send({ method: 'turn/completed', params: { turn: { id: 'automatic-turn', status: 'completed' } } })
      send({ method: 'thread/goal/updated', params: { threadId: active.threadId, goal: { ...active, status: 'complete', tokensUsed: 18, timeUsedSeconds: 1, updatedAt: 101 } } })
    }, 30)
    return
  }
  if (message.method === 'thread/goal/get') return send({ id: message.id, result: { goal: active } })
  if (message.method === 'thread/goal/clear') return send({ id: message.id, result: { cleared: true } })
  send({ id: message.id, result: {} })
})
`)
  fs.chmodSync(binaryPath, 0o755)
  return { binaryPath, requestLog }
}

function writePausableGoalProvider(dir, settleStatus) {
  const binaryPath = path.join(dir, 'codex-pausable')
  fs.writeFileSync(binaryPath, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
let goal = { threadId: 'provider-paused-thread', objective: 'wait', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 100 }
let itemStarted = false
const settleStatus = ${JSON.stringify(settleStatus)}
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') return send({ id: message.id, result: {} })
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: goal.threadId } } })
  if (message.method === 'thread/goal/get') return send({ id: message.id, result: { goal } })
  if (message.method === 'thread/goal/set') {
    if (message.params.status === 'paused' && settleStatus === '__ignore_pause__') return
    goal = { ...goal, ...(message.params.objective ? { objective: message.params.objective } : {}), ...(message.params.status ? { status: message.params.status } : {}), updatedAt: goal.updatedAt + 1 }
    send({ id: message.id, result: { goal } })
    send({ method: 'thread/goal/updated', params: { threadId: goal.threadId, goal } })
    if (goal.status === 'active' && !itemStarted) {
      itemStarted = true
      send({ method: 'item/started', params: { threadId: goal.threadId, turnId: 'auto-turn', item: { id: 'waiting-command', type: 'commandExecution', command: '/bin/sh -c wait', status: 'inProgress' } } })
      if (settleStatus === '__exit__') {
        setTimeout(() => process.exit(1), 20)
      } else if (settleStatus && settleStatus !== '__ignore_pause__') {
        setTimeout(() => {
          goal = { ...goal, status: settleStatus, updatedAt: goal.updatedAt + 1 }
          send({ method: 'thread/goal/updated', params: { threadId: goal.threadId, goal } })
        }, 20)
      }
    }
    return
  }
  send({ id: message.id, result: {} })
})
`)
  fs.chmodSync(binaryPath, 0o755)
  return binaryPath
}

test('new Codex goal materializes a thread without dispatching a regular turn', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-session-'))
  const manager = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') })
  const { binaryPath, requestLog } = writeGoalProvider(tempRoot)
  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Goal provider',
      binaryPath,
    })
    const result = await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: {
        objective: 'write marker',
        status: 'active',
        cwd: tempRoot,
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
      },
    })
    const session = await waitFor('completed thread goal', () => {
      const current = manager.getState().sessions[result.sessionId]
      return current?.threadGoal?.status === 'complete' && current.status === 'idle'
        ? current
        : undefined
    })
    assert.equal(session.providerSessionId, 'provider-goal-thread')
    assert.equal(session.messages[0].content, '/goal write marker')
    assert.ok(session.messages.some((message) => message.content === 'goal complete'))
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(requests.some((message) => message.method === 'turn/start'), false)
    assert.ok(requests.some((message) => message.method === 'thread/goal/set'))
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('unsupported provider rejects a goal before creating a session', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-unsupported-'))
  const manager = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') })
  try {
    await assert.rejects(
      manager.dispatchCommand({
        kind: 'set_thread_goal',
        actor: { kind: 'human' },
        input: {
          objective: 'must not start',
          cwd: tempRoot,
          providerKind: 'claude-code',
          providerInstanceId: 'default-claude-sdk',
        },
      }),
      /supported by Codex chats only/,
    )
    assert.equal(Object.keys(manager.getState().sessions).length, 0)
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('pausing a goal finalizes provider activities left open by the interrupted turn', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-pause-'))
  const runtimeEvents = []
  const manager = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'state.json'),
    broadcastRuntimeEvent: (event) => runtimeEvents.push(event),
  })
  const binaryPath = writePausableGoalProvider(tempRoot)
  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Pausable goal provider',
      binaryPath,
    })
    const created = await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: {
        objective: 'wait',
        status: 'active',
        cwd: tempRoot,
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
      },
    })
    await waitFor('running provider activity', () => {
      const session = manager.getState().sessions[created.sessionId]
      return session?.threadGoal?.status === 'active' &&
        session.runtimeActivities.some((activity) => activity.status === 'running')
    })
    await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: { sessionId: created.sessionId, status: 'paused' },
    })
    const paused = await waitFor('paused idle session', () => {
      const session = manager.getState().sessions[created.sessionId]
      return session?.threadGoal?.status === 'paused' && session.status === 'idle'
        ? session
        : undefined
    })
    assert.equal(paused.runtimeActivities[0].status, 'failed')
    assert.match(paused.runtimeActivities[0].error, /Goal paused/)
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.type === 'provider.runtime' &&
          event.providerEvent?.type === 'item.completed' &&
          event.providerEvent.item?.status === 'failed',
      ),
      true,
      'the renderer receives the synthetic terminal activity update',
    )
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a usage-limited goal finalizes provider activities left open by the terminal turn', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-limited-'))
  const runtimeEvents = []
  const manager = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'state.json'),
    broadcastRuntimeEvent: (event) => runtimeEvents.push(event),
  })
  const binaryPath = writePausableGoalProvider(tempRoot, 'usageLimited')
  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Limited goal provider',
      binaryPath,
    })
    const created = await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: {
        objective: 'wait',
        status: 'active',
        cwd: tempRoot,
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
      },
    })
    const limited = await waitFor('usage-limited idle session', () => {
      const session = manager.getState().sessions[created.sessionId]
      return session?.threadGoal?.status === 'usageLimited' && session.status === 'idle'
        ? session
        : undefined
    })
    assert.equal(limited.runtimeActivities[0].status, 'failed')
    assert.match(limited.runtimeActivities[0].error, /usage limit/)
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.type === 'provider.runtime' &&
          event.providerEvent?.type === 'item.completed' &&
          event.providerEvent.item?.status === 'failed',
      ),
      true,
    )
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a completed goal closes a trailing provider activity as successful', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-complete-'))
  const runtimeEvents = []
  const manager = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'state.json'),
    broadcastRuntimeEvent: (event) => runtimeEvents.push(event),
  })
  const binaryPath = writePausableGoalProvider(tempRoot, 'complete')
  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Completing goal provider',
      binaryPath,
    })
    const created = await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: {
        objective: 'wait',
        status: 'active',
        cwd: tempRoot,
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
      },
    })
    const completed = await waitFor('completed goal session', () => {
      const session = manager.getState().sessions[created.sessionId]
      return session?.threadGoal?.status === 'complete' && session.status === 'idle'
        ? session
        : undefined
    })
    assert.equal(completed.runtimeActivities[0].status, 'completed')
    assert.equal(completed.runtimeActivities[0].error, undefined)
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.type === 'provider.runtime' &&
          event.providerEvent?.type === 'item.completed' &&
          event.providerEvent.item?.status === 'completed',
      ),
      true,
    )
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a failed goal run finalizes provider activities before discarding run context', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-failure-'))
  const runtimeEvents = []
  const manager = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'state.json'),
    broadcastRuntimeEvent: (event) => runtimeEvents.push(event),
  })
  const binaryPath = writePausableGoalProvider(tempRoot, '__exit__')
  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Failing goal provider',
      binaryPath,
    })
    const created = await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: {
        objective: 'wait',
        status: 'active',
        cwd: tempRoot,
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
      },
    })
    const failed = await waitFor('failed goal session', () => {
      const session = manager.getState().sessions[created.sessionId]
      return session?.status === 'failed' ? session : undefined
    })
    assert.equal(failed.runtimeActivities[0].status, 'failed')
    assert.match(failed.runtimeActivities[0].error, /Goal run failed/)
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.type === 'provider.runtime' &&
          event.providerEvent?.type === 'item.completed' &&
          event.providerEvent.item?.status === 'failed',
      ),
      true,
    )
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('an unconfirmed kill pause keeps the active cache and records a recovery diagnostic', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-thread-goal-kill-recovery-'))
  const manager = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') })
  const binaryPath = writePausableGoalProvider(tempRoot, '__ignore_pause__')
  try {
    manager.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Unresponsive goal provider',
      binaryPath,
    })
    const created = await manager.dispatchCommand({
      kind: 'set_thread_goal',
      actor: { kind: 'human' },
      input: {
        objective: 'wait',
        status: 'active',
        cwd: tempRoot,
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
      },
    })
    await waitFor('active goal before kill', () =>
      manager.getState().sessions[created.sessionId]?.threadGoal?.status === 'active',
    )
    manager.killSession(created.sessionId)
    const recovered = await waitFor('goal pause recovery diagnostic', () => {
      const state = manager.getState()
      return state.diagnostics?.some(
        (item) =>
          item.type === 'runtime.thread_goal_pause_unconfirmed' &&
          item.details?.sessionId === created.sessionId,
      )
        ? state.sessions[created.sessionId]
        : undefined
    }, 5000)
    assert.equal(recovered.threadGoal.status, 'active')
    assert.equal(recovered.status, 'killed')
    assert.equal(recovered.runtimeActivities[0].status, 'failed')
    assert.match(recovered.runtimeActivities[0].error, /Goal run was killed/)
  } finally {
    await manager.killAll()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('regular messages cannot resume a cached active Codex goal', async () => {
  const session = {
    sessionId: 'session-1',
    providerKind: 'codex',
    status: 'idle',
    cwd: process.cwd(),
    threadGoal: {
      threadId: 'thread-1',
      objective: 'keep going',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 100,
      updatedAt: 100,
    },
  }
  const commands = new SessionCommandRuntime({
    state: () => ({ sessions: { 'session-1': session }, runQueue: [] }),
    runs: () => new Map(),
    isSessionFrozen: () => false,
    assertBudgetAvailable: () => undefined,
  })
  await assert.rejects(
    commands.cmdResumeSession(
      { sessionId: 'session-1', message: 'ordinary message' },
      { actor: { kind: 'human' } },
    ),
    /active goal.*Pause or clear/i,
  )
})
