import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js'
import { DeterministicProviderAdapter, deterministicProviderAdapters } from './support/deterministic-provider.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(label, predicate, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function harness(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const adapter = new DeterministicProviderAdapter()
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(root, 'state.json'),
    providerAdapters: new Map([['claude-code', adapter]]),
  })
  return { root, adapter, runtime, cleanup: () => { runtime.killAll(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('consumption budgets are disabled by default while capacity governance remains active', async () => {
  const { runtime, cleanup } = harness('orrery-budget-default-off-')
  try {
    const created = await runtime.createSession({
      prompt: 'ORRERY_TOOL_ACTIVITY default-off turn',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'read-only' },
    })
    await waitFor('default-off turn complete', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')
    const policy = runtime.getState().resourcePolicies.global
    assert.equal(policy.consumptionEnforcement, 'off')
    assert.equal(policy.maxToolCallsPerTurn, undefined)
    assert.equal(policy.maxDurationPerTurnMs, undefined)
    assert.equal(policy.maxTokensPerTurn, undefined)
    assert.equal(policy.maxConcurrentSessions, 4)
    assert.equal(runtime.getKernelEvents({ type: 'resource.budget-exhausted' }).events.length, 0)
  } finally { cleanup() }
})

test('legacy policies without explicit enforcement migrate off regardless of who last edited capacity', () => {
  for (const [updatedBy, expectedEnforcement, expectedToolLimit] of [
    ['runtime', 'off', undefined],
    ['human', 'off', undefined],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `orrery-budget-migration-${updatedBy}-`))
    const storageFile = path.join(root, 'state.json')
    const state = createEmptyGraphState()
    state.resourcePolicies.global = {
      scopeId: 'global', maxConcurrentSessions: 4, maxConcurrentPerProvider: 4, maxQueuedRuns: 100,
      maxTurns: 100, maxTokens: 2_000_000, maxDurationMs: 14_400_000, maxToolCalls: 500,
      maxFanout: 8, maxTokensPerTurn: 200_000, maxDurationPerTurnMs: 900_000, maxToolCallsPerTurn: 10,
      updatedAt: state.updatedAt, updatedBy, budgetStartedAt: state.updatedAt,
    }
    fs.writeFileSync(storageFile, JSON.stringify(state))
    const runtime = new RuntimeSessionManager({ storageFile, providerAdapters: deterministicProviderAdapters() })
    try {
      const policy = runtime.getState().resourcePolicies.global
      assert.equal(policy.consumptionEnforcement, expectedEnforcement)
      assert.equal(policy.maxToolCallsPerTurn, expectedToolLimit)
    } finally {
      runtime.killAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('warning budgets report usage without freezing or terminating the turn', async () => {
  const { runtime, cleanup } = harness('orrery-budget-warning-')
  try {
    await runtime.dispatchCommand({
      commandId: 'warning-policy', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxTokensPerTurn: 10, consumptionEnforcement: 'warn' },
    })
    const created = await runtime.createSession({ prompt: 'warn but continue', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await waitFor('warned turn complete', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')
    assert.notEqual(runtime.getState().nodes.find((node) => node.sessionId === created.sessionId).frozen, true)
    assert.equal(runtime.getKernelEvents({ type: 'resource.budget-warning' }).events.length, 1)
    assert.equal(runtime.getKernelEvents({ type: 'resource.budget-exhausted' }).events.length, 0)
  } finally { cleanup() }
})

test('aggregate-only hard budgets derive conservative reservations before concurrent admission', async () => {
  const { runtime, cleanup } = harness('orrery-budget-aggregate-reservation-')
  try {
    await runtime.dispatchCommand({
      commandId: 'aggregate-only-policy', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxTokens: 20, consumptionEnforcement: 'hard' },
    })
    await runtime.createSession({ prompt: 'ORRERY_SLEEP reserve aggregate', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await assert.rejects(
      runtime.createSession({ prompt: 'must not oversubscribe aggregate', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } }),
      /Resource budget exhausted/,
    )
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 1)
  } finally { cleanup() }
})

test('aggregate-only hard budgets constrain the admitted turn itself', async () => {
  const { runtime, cleanup } = harness('orrery-budget-aggregate-turn-')
  try {
    await runtime.dispatchCommand({
      commandId: 'aggregate-turn-policy', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxTokens: 10, consumptionEnforcement: 'hard' },
    })
    const created = await runtime.createSession({ prompt: 'provider reports eighteen tokens', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await waitFor('aggregate-only violating turn fails', () => runtime.getState().sessions[created.sessionId]?.status === 'failed')
    assert.match(runtime.getState().sessions[created.sessionId].error, /tokens 18\/10/)
  } finally { cleanup() }
})

test('off to hard refreshes active reservations before admitting another turn', async () => {
  const { runtime, cleanup } = harness('orrery-budget-live-reservation-')
  try {
    await runtime.createSession({ prompt: 'ORRERY_SLEEP active before hard policy', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await runtime.dispatchCommand({
      commandId: 'live-aggregate-hard', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxTokens: 20, consumptionEnforcement: 'hard' },
    })
    await assert.rejects(
      runtime.createSession({ prompt: 'must wait behind refreshed reservation', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } }),
      /Resource budget exhausted/,
    )
    assert.equal(runtime.getState().workspaceLeases.find((lease) => lease.status === 'active')?.reservedTokens, 20)
  } finally { cleanup() }
})

test('duration enforcement is re-armed when a human changes policy during an active turn', async () => {
  const { runtime, cleanup } = harness('orrery-budget-live-duration-')
  try {
    await runtime.dispatchCommand({
      commandId: 'duration-hard', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxDurationPerTurnMs: 800, consumptionEnforcement: 'hard' },
    })
    const spared = await runtime.createSession({ prompt: 'ORRERY_SLEEP disable before deadline', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await runtime.dispatchCommand({
      commandId: 'duration-off', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', consumptionEnforcement: 'off' },
    })
    await waitFor('active turn survives hard to off', () => runtime.getState().sessions[spared.sessionId]?.status === 'idle')

    const stopped = await runtime.createSession({ prompt: 'ORRERY_SLEEP enable during turn', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await runtime.dispatchCommand({
      commandId: 'duration-hard-again', kind: 'set_resource_policy', actor: { kind: 'human' },
      input: { scopeId: 'global', maxDurationPerTurnMs: 80, consumptionEnforcement: 'hard' },
    })
    await waitFor('active turn stops after off to hard', () => runtime.getState().sessions[stopped.sessionId]?.status === 'failed')
    assert.match(runtime.getState().sessions[stopped.sessionId].error, /durationMs/)
  } finally { cleanup() }
})

test('same-workspace writers serialize while readers run concurrently and usage is durable', async () => {
  const { runtime, adapter, cleanup } = harness('orrery-resource-')
  try {
    const writer = (label) => runtime.createSession({
      label, prompt: `ORRERY_SLEEP ${label}`, cwd: process.cwd(),
      runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'workspace-write' },
    })
    const first = await writer('writer-a')
    const second = await writer('writer-b')
    const queued = runtime.getState()
    assert.equal(queued.runQueue.length, 1)
    assert.equal(queued.workspaceLeases.filter((lease) => lease.status === 'active' && lease.mode === 'writer').length, 1)
    assert.equal(adapter.startedTurns.length, 1)
    await waitFor('both writers complete', () => runtime.getState().sessions[first.sessionId]?.status === 'idle' && runtime.getState().sessions[second.sessionId]?.status === 'idle')
    const completed = runtime.getState()
    assert.equal(completed.runQueue.length, 0)
    assert.equal(completed.workspaceLeases.filter((lease) => lease.status === 'active').length, 0)
    assert.equal(completed.usageFacts.length, 2)
    assert.equal(completed.usageFacts.every((fact) => fact.totalTokens === 18 && fact.source === 'provider'), true)
    assert.equal(completed.usageFacts.some((fact) => 'cost' in fact), false)

    const reader = (label) => runtime.createSession({
      label, prompt: `ORRERY_DELAY ${label}`, cwd: process.cwd(),
      runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
    })
    const readA = await reader('reader-a')
    const readB = await reader('reader-b')
    const reading = runtime.getState()
    assert.equal(reading.runQueue.length, 0)
    assert.equal(reading.workspaceLeases.filter((lease) => lease.status === 'active' && lease.mode === 'reader').length, 2)
    await waitFor('both readers complete', () => runtime.getState().sessions[readA.sessionId]?.status === 'idle' && runtime.getState().sessions[readB.sessionId]?.status === 'idle')
  } finally { cleanup() }
})

test('resource policy makes autonomous ceilings explicit and supports human recovery', async () => {
  const { runtime, cleanup } = harness('orrery-budget-')
  try {
    await runtime.dispatchCommand({ commandId: 'budget-1', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxTurns: 1 } })
    const created = await runtime.createSession({ prompt: 'budgeted turn', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await waitFor('budgeted turn complete', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')
    const messageCount = runtime.getState().sessions[created.sessionId].messages.length
    await assert.rejects(runtime.resumeSession({ sessionId: created.sessionId, message: 'over budget' }), /Resource budget exhausted/)
    assert.equal(runtime.getState().sessions[created.sessionId].messages.length, messageCount, 'budget preflight leaves no ghost user turn')
    assert.equal(runtime.getState().nodes.find((node) => node.sessionId === created.sessionId).frozen, true)
    await runtime.dispatchCommand({ commandId: 'budget-2', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxTurns: 1, resetUsage: true } })
    await runtime.unfreeze({ target: created.sessionId })
    await runtime.resumeSession({ sessionId: created.sessionId, message: 'recovered' })
    await waitFor('recovered turn complete', () => runtime.getState().usageFacts.length === 2)
    assert.equal(runtime.getState().usage.nodes[created.sessionId].turns, 2)
  } finally { cleanup() }
})

test('global provider policy caps the same provider across independent Scopes', async () => {
  const { runtime, cleanup } = harness('orrery-global-provider-cap-')
  try {
    await runtime.dispatchCommand({ commandId: 'global-cap', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxConcurrentPerProvider: 1 } })
    await runtime.dispatchCommand({ commandId: 'scope-a-cap', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'scope-a', maxConcurrentPerProvider: 4 } })
    await runtime.dispatchCommand({ commandId: 'scope-b-cap', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'scope-b', maxConcurrentPerProvider: 4 } })
    await runtime.createSession({ cluster: 'scope-a', prompt: 'ORRERY_SLEEP scope a', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' } })
    const second = await runtime.createSession({ cluster: 'scope-b', prompt: 'scope b', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' } })
    assert.equal(runtime.getState().runQueue.find((item) => item.sessionId === second.sessionId)?.reason, 'provider-cap')
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 1)
  } finally { cleanup() }
})

test('per-turn token ceiling stops the violating run and remains recoverable', async () => {
  const { runtime, cleanup } = harness('orrery-per-turn-cap-')
  try {
    await runtime.dispatchCommand({ commandId: 'per-turn-low', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxTokensPerTurn: 10 } })
    const created = await runtime.createSession({ prompt: 'provider reports eighteen tokens', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only' } })
    await waitFor('token-capped run settles', () => !['pending', 'running'].includes(runtime.getState().sessions[created.sessionId]?.status) && runtime.getState().sessions[created.sessionId]?.status)
    assert.equal(runtime.getState().sessions[created.sessionId].status, 'failed')
    assert.equal(runtime.getState().nodes.find((node) => node.sessionId === created.sessionId).frozen, true)
    assert.equal(runtime.getState().usageFacts.find((fact) => fact.sessionId === created.sessionId)?.totalTokens, 18)
    await runtime.dispatchCommand({ commandId: 'per-turn-recover', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxTokensPerTurn: 20, resetUsage: true } })
    await runtime.unfreeze({ target: created.sessionId })
    await runtime.resumeSession({ sessionId: created.sessionId, message: 'recovered token budget' })
    await waitFor('token-capped run recovers', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')
  } finally { cleanup() }
})

test('provider caps backpressure readers; interrupt releases its lease and admits the next turn', async () => {
  const { runtime, adapter, cleanup } = harness('orrery-interrupt-')
  try {
    await runtime.dispatchCommand({ commandId: 'cap-provider', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxConcurrentPerProvider: 1 } })
    const start = (label) => runtime.createSession({
      label, prompt: `ORRERY_SLEEP ${label}`, cwd: process.cwd(),
      runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' },
    })
    const active = await start('active-reader')
    const queued = await start('queued-reader')
    assert.equal(runtime.getState().runQueue[0].reason, 'provider-cap')
    assert.equal(runtime.getState().workspaceLeases.some((lease) => lease.sessionId === queued.sessionId && lease.status === 'active'), false, 'queued/coalesced work never holds a lease')
    assert.equal(runtime.killSession(active.sessionId).ok, true)
    await waitFor('queued reader admitted', () => adapter.startedTurns.length === 2)
    await waitFor('queued reader complete', () => runtime.getState().sessions[queued.sessionId]?.status === 'idle')
    assert.equal(runtime.getState().workspaceLeases.filter((lease) => lease.status === 'active').length, 0)
  } finally { cleanup() }
})

test('killAll cancels a provider launch waiting for the membrane before the adapter can start', async () => {
  const { runtime, adapter, cleanup } = harness('orrery-shutdown-launch-race-')
  try {
    const creating = runtime.createSession({
      prompt: 'must never reach provider adapter',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'read-only' },
    })
    runtime.killAll()
    await assert.rejects(
      Promise.race([
        creating,
        delay(500).then(() => {
          throw new Error('provider launch did not settle after runtime shutdown')
        }),
      ]),
      /cancelled by runtime shutdown/,
    )
    assert.equal(adapter.startedTurns.length, 0)
    assert.equal(
      runtime.getState().workspaceLeases.some((lease) => lease.status === 'active'),
      false,
    )
    const createdEvent = runtime.getKernelEvents({ type: 'session.created' }).events[0]
    const failedEvent = runtime.getKernelEvents({ type: 'session.failed' }).events[0]
    assert.equal(failedEvent.causeId, createdEvent.id)
  } finally {
    cleanup()
  }
})

test('an authorized command revives a queued run on the same manager after killAll', async () => {
  const { runtime, adapter, cleanup } = harness('orrery-shutdown-queue-revive-')
  try {
    await runtime.dispatchCommand({
      commandId: 'shutdown-revive-cap',
      kind: 'set_resource_policy',
      actor: { kind: 'human' },
      input: { scopeId: 'global', maxConcurrentPerProvider: 1 },
    })
    await runtime.createSession({
      prompt: 'ORRERY_SLEEP active before shutdown',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' },
    })
    const queued = await runtime.createSession({
      prompt: 'queued across shutdown',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' },
    })
    assert.equal(runtime.getState().runQueue.length, 1)
    assert.equal(adapter.startedTurns.length, 1)

    runtime.killAll()
    await waitFor('shutdown releases the active lease', () =>
      runtime.getState().workspaceLeases.every((lease) => lease.status !== 'active'),
    )
    assert.equal(runtime.getState().runQueue.length, 1)

    await assert.rejects(
      runtime.dispatchCommand({
        commandId: 'invalid-revive-provider-run-queue',
        kind: 'not_a_kernel_command',
        actor: { kind: 'human' },
      }),
      /Unknown kernel command/,
    )
    await delay(100)
    assert.equal(adapter.startedTurns.length, 1)
    assert.equal(runtime.getState().runQueue.length, 1)

    await runtime.dispatchCommand({
      commandId: 'revive-provider-run-queue',
      kind: 'update_node_positions',
      actor: { kind: 'human' },
      input: { positions: [] },
    })
    await waitFor('revived queued run starts', () => adapter.startedTurns.length === 2)
    await waitFor(
      'revived queued run completes',
      () => runtime.getState().sessions[queued.sessionId]?.status === 'idle',
    )
    assert.equal(runtime.getState().runQueue.length, 0)
  } finally { cleanup() }
})

test('direct and dispatched provider APIs revive a reusable manager after killAll', async () => {
  const { runtime, adapter, cleanup } = harness('orrery-shutdown-direct-revive-')
  try {
    runtime.killAll()
    const created = await runtime.createSession({
      prompt: 'direct create after shutdown',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'read-only' },
    })
    await waitFor(
      'directly revived run completes',
      () => runtime.getState().sessions[created.sessionId]?.status === 'idle',
    )
    assert.equal(adapter.startedTurns.length, 1)

    runtime.killAll()
    const dispatched = await runtime.dispatchCommand({
      commandId: 'create-after-second-shutdown',
      kind: 'create_session',
      actor: { kind: 'human' },
      input: {
        prompt: 'dispatched create after shutdown',
        cwd: process.cwd(),
        runtimeSettings: { sandbox: 'read-only' },
      },
    })
    await waitFor(
      'dispatched revived run completes',
      () => runtime.getState().sessions[dispatched.sessionId]?.status === 'idle',
    )
    assert.equal(adapter.startedTurns.length, 2)
  } finally { cleanup() }
})

test('a command submitted before killAll cannot revive the queue across the shutdown epoch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-shutdown-stale-command-'))
  const adapter = new DeterministicProviderAdapter()
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(root, 'state.json'),
    providerAdapters: new Map([['claude-code', adapter]]),
    controlCommandCommitDelayMs: 200,
  })
  try {
    await runtime.createSession({
      prompt: 'ORRERY_SLEEP lease owner before shutdown',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'workspace-write' },
    })
    const queued = await runtime.createSession({
      prompt: 'queued behind stale command',
      cwd: process.cwd(),
      runtimeSettings: { sandbox: 'workspace-write' },
    })
    const staleCommand = runtime.dispatchCommand({
      commandId: 'submitted-before-shutdown',
      kind: 'update_node_positions',
      actor: { kind: 'human' },
      input: { positions: [] },
    })
    await delay(20)
    runtime.killAll()
    await staleCommand
    await delay(100)
    assert.equal(adapter.startedTurns.length, 1)
    assert.equal(runtime.getState().runQueue.length, 1)

    await runtime.dispatchCommand({
      commandId: 'submitted-after-shutdown',
      kind: 'update_node_positions',
      actor: { kind: 'human' },
      input: { positions: [] },
    })
    await waitFor('current-epoch command revives queue', () => adapter.startedTurns.length === 2)
    await waitFor(
      'current-epoch queued run completes',
      () => runtime.getState().sessions[queued.sessionId]?.status === 'idle',
    )
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('budget reservations prevent concurrent oversubscription and exhaustion commits through command path', async () => {
  const { runtime, root, cleanup } = harness('orrery-budget-command-')
  try {
    await runtime.dispatchCommand({ commandId: 'budget-command-policy', kind: 'set_resource_policy', actor: { kind: 'human' }, input: { scopeId: 'global', maxTurns: 1 } })
    await runtime.dispatchCommand({
      commandId: 'budget-command-first', kind: 'create_session', actor: { kind: 'human' },
      input: { label: 'reserved-first', prompt: 'ORRERY_SLEEP first', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' } },
    })
    await assert.rejects(runtime.dispatchCommand({
      commandId: 'budget-command-second', kind: 'create_session', actor: { kind: 'human' },
      input: { label: 'budget-blocked', prompt: 'must not launch', cwd: process.cwd(), runtimeSettings: { sandbox: 'read-only', interactionMode: 'plan' } },
    }), /Resource budget exhausted/)
    const blocked = Object.values(runtime.getState().sessions).find((session) => session.label === 'budget-blocked')
    assert.ok(blocked, 'typed budget rejection commits the inspectable Session state')
    assert.equal(runtime.getState().nodes.find((node) => node.sessionId === blocked.sessionId).frozen, true)
    assert.equal(runtime.getKernelEvents({ type: 'resource.budget-exhausted' }).events.length, 1)
    const adapterStarts = runtime.getState().workspaceLeases.filter((lease) => lease.sessionId === blocked.sessionId)
    assert.equal(adapterStarts.length, 0)
    assert.ok(fs.existsSync(root))
  } finally { cleanup() }
})

test('a Session cannot accumulate multiple generic admission queue entries', async () => {
  const { runtime, cleanup } = harness('orrery-session-reservation-')
  try {
    await runtime.createSession({ prompt: 'ORRERY_SLEEP lease owner', cwd: process.cwd(), runtimeSettings: { sandbox: 'workspace-write' } })
    const queued = await runtime.createSession({ prompt: 'queued writer', cwd: process.cwd(), runtimeSettings: { sandbox: 'workspace-write' } })
    assert.equal(runtime.getState().runQueue.filter((item) => item.sessionId === queued.sessionId).length, 1)
    await assert.rejects(runtime.resumeSession({ sessionId: queued.sessionId, message: 'duplicate queued turn' }), /queued provider turn|active or queued/)
    assert.equal(runtime.getState().runQueue.filter((item) => item.sessionId === queued.sessionId).length, 1)
    assert.equal(runtime.killSession(queued.sessionId).ok, true)
    assert.equal(runtime.getState().runQueue.filter((item) => item.sessionId === queued.sessionId).length, 0)
  } finally { cleanup() }
})

test('managed worktrees retain fork point and merge only a stable completed-turn changeset', async () => {
  const { runtime, root, cleanup } = harness('orrery-worktree-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Orrery Test')
  git('config', 'user.email', 'orrery@example.test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# Turn diff test\n')
  git('add', 'README.md')
  git('commit', '-m', 'baseline')
  const baseline = git('rev-parse', 'HEAD')
  try {
    const created = await runtime.createSession({
      label: 'worktree writer', prompt: 'change the fixture', cwd: repo, workMode: 'worktree',
      runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'workspace-write' },
    })
    await waitFor('worktree turn complete', () => runtime.getState().sessions[created.sessionId]?.status === 'idle')
    const session = runtime.getState().sessions[created.sessionId]
    assert.equal(session.project.forkPoint, baseline)
    assert.equal(fs.existsSync(path.join(repo, 'p1-turn-diff.txt')), false)
    const baseWriter = await runtime.createSession({
      label: 'base writer', prompt: 'ORRERY_SLEEP base writer', cwd: repo,
      runtimeSettings: { sandbox: 'workspace-write' },
    })
    const busyMerge = await runtime.mergeWorktreeChanges({ sessionId: created.sessionId })
    assert.equal(busyMerge.ok, false)
    assert.equal(busyMerge.conflict.code, 'workspace-busy')
    runtime.killSession(baseWriter.sessionId)
    await waitFor('base writer lease released', () => runtime.getState().workspaceLeases.every((lease) => lease.status !== 'active'))
    const merged = await runtime.mergeWorktreeChanges({ sessionId: created.sessionId })
    assert.equal(merged.ok, true, JSON.stringify(merged.conflict))
    assert.equal(merged.applied, true)
    assert.match(fs.readFileSync(path.join(repo, 'p1-turn-diff.txt'), 'utf8'), /deterministic provider/)
    const repeatedMerge = await runtime.mergeWorktreeChanges({ sessionId: created.sessionId })
    assert.equal(repeatedMerge.alreadyApplied, true)

    const conflictSession = await runtime.createSession({
      label: 'conflicting writer', prompt: 'change the fixture again', cwd: repo, workMode: 'worktree',
      runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'workspace-write' },
    })
    await waitFor('conflicting worktree turn complete', () => runtime.getState().sessions[conflictSession.sessionId]?.status === 'idle')
    fs.writeFileSync(path.join(repo, 'p1-turn-diff.txt'), 'target changed independently\n')
    const conflict = await runtime.mergeWorktreeChanges({ sessionId: conflictSession.sessionId })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.conflict.kind, 'workflow-conflict')
    assert.equal(conflict.conflict.code, 'changeset-conflict')
    assert.equal(fs.readFileSync(path.join(repo, 'p1-turn-diff.txt'), 'utf8'), 'target changed independently\n')
    const cleaned = await runtime.cleanupWorktree({ sessionId: created.sessionId })
    assert.equal(cleaned.ok, true)
    assert.equal(runtime.getState().sessions[created.sessionId].project.cleanupStatus, 'cleaned')
    assert.equal(fs.existsSync(session.cwd), false)
    assert.equal((await runtime.cleanupWorktree({ sessionId: created.sessionId })).alreadyCleaned, true)
  } finally { cleanup() }
})

test('durable queued run survives runtime restart without duplicate provider launch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-queue-restart-'))
  const storageFile = path.join(root, 'state.json')
  const firstAdapter = new DeterministicProviderAdapter()
  let runtime = new RuntimeSessionManager({ storageFile, providerAdapters: new Map([['claude-code', firstAdapter]]) })
  try {
    await runtime.createSession({ prompt: 'ORRERY_SLEEP owner', cwd: process.cwd(), runtimeSettings: { sandbox: 'workspace-write' } })
    const queued = await runtime.createSession({ prompt: 'queued after restart', cwd: process.cwd(), runtimeSettings: { sandbox: 'workspace-write' } })
    assert.equal(runtime.getState().runQueue.length, 1)
    runtime.killAll()
    await delay(50)
    const secondAdapter = new DeterministicProviderAdapter()
    runtime = new RuntimeSessionManager({ storageFile, providerAdapters: new Map([['claude-code', secondAdapter]]) })
    await waitFor('restored queue completes', () => runtime.getState().sessions[queued.sessionId]?.status === 'idle')
    assert.equal(secondAdapter.startedTurns.length, 1)
    assert.equal(runtime.getState().runQueue.length, 0)
    assert.equal(new Set(runtime.getState().usageFacts.map((fact) => fact.turnId)).size, runtime.getState().usageFacts.length)
    assert.equal(runtime.getState().usageFacts.some((fact) => fact.source === 'unavailable'), true, 'interrupted active turn is metered on recovery')
  } finally {
    runtime.killAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
