import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from '../tests/runtime/support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-runtime-recovery-'))
const storageFile = path.join(tempRoot, 'orrery-runtime-state.json')
const activeStorageFile = path.join(tempRoot, 'orrery-active-runtime-state.json')
const managers = new Set()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function assertIdentity(state) {
  for (const node of state.nodes) {
    assert.equal(node.nodeId, node.sessionId, 'nodeId must equal sessionId')
    assert.ok(state.sessions[node.sessionId], 'every node must have a session')
  }
  for (const session of Object.values(state.sessions)) {
    assert.equal(session.nodeId, session.sessionId, 'session nodeId must equal sessionId')
  }
}

function diagnosticsOf(state) {
  return Array.isArray(state.diagnostics) ? state.diagnostics.map((item) => item.type) : []
}

function manager(input) {
  const runtime = new RuntimeSessionManager(input)
  managers.add(runtime)
  return runtime
}

try {

  const runtime = manager({ storageFile })
  const created = await runtime.createSession({
    prompt: 'normal restore',
    label: 'Persistence smoke',
    cwd: process.cwd(),
  })
  const sessionId = created.sessionId

  await waitFor(
    'initial session to finish',
    () => runtime.getState().sessions[sessionId]?.status === 'idle'
  )

  const restored = manager({ storageFile })
  const restoredState = restored.getState()
  assertIdentity(restoredState)
  assert.equal(restoredState.sessions[sessionId].backendSessionId, sessionId)
  assert.equal(restoredState.sessions[sessionId].messages[0].sessionId, sessionId)
  assert.ok(restoredState.sessions[sessionId].messages.length >= 2)

  await restored.resumeSession({
    sessionId,
    message: 'resume after restart',
  })
  await waitFor(
    'resumed session to finish',
    () => restored.getState().sessions[sessionId]?.status === 'idle'
  )
  const resumedState = restored.getState()
  assert.equal(resumedState.sessions[sessionId].backendSessionId, sessionId)
  assert.ok(resumedState.sessions[sessionId].messages.length >= 4)
  assertIdentity(resumedState)

  const cwdStorageFile = path.join(tempRoot, 'orrery-cwd-propagation-state.json')
  const selectedProjectCwd = path.join(tempRoot, 'selected-project')
  fs.mkdirSync(selectedProjectCwd)
  const cwdRuntime = manager({ storageFile: cwdStorageFile })
  const cwdWorker = await cwdRuntime.createSession({
    prompt: 'cwd propagation worker',
    label: 'Cwd Worker',
    cwd: selectedProjectCwd,
  })
  await waitFor(
    'cwd worker to finish',
    () => cwdRuntime.getState().sessions[cwdWorker.sessionId]?.status === 'idle'
  )
  const policy = {
    until: { whenReport: { verdict: 'clean' } },
    onStop: 'freeze',
    maxIterations: 2,
  }
  const cwdCluster = cwdRuntime.upsertCluster({
    label: 'Cwd Cluster',
    nodeIds: [cwdWorker.sessionId],
    loopPolicy: policy,
  })
  const cwdMaster = await cwdRuntime.createMasterForCluster({
    clusterId: cwdCluster.clusterId,
    prompt: 'cwd propagation master',
    label: 'Cwd Master',
    cwd: selectedProjectCwd,
    loopPolicy: policy,
  })
  await waitFor(
    'cwd master to finish',
    () => cwdRuntime.getState().sessions[cwdMaster.sessionId]?.status === 'idle'
  )
  assert.equal(
    cwdRuntime.getState().sessions[cwdMaster.sessionId].cwd,
    selectedProjectCwd,
    'master sessions should use the selected project cwd'
  )
  const cwdChild = await cwdRuntime.handleMembraneRequest({
    tool: 'create_session',
    source: cwdWorker.sessionId,
    input: {
      prompt: 'cwd propagation child',
      label: 'Cwd Child',
    },
  })
  await waitFor(
    'cwd child to finish',
    () => cwdRuntime.getState().sessions[cwdChild.sessionId]?.status === 'idle'
  )
  assert.equal(
    cwdRuntime.getState().sessions[cwdChild.sessionId].cwd,
    selectedProjectCwd,
    'membrane-created sessions should inherit source project cwd'
  )

  const staleCwdStorageFile = path.join(tempRoot, 'orrery-stale-cwd-state.json')
  const staleProjectCwd = path.join(tempRoot, 'stale-project')
  fs.mkdirSync(staleProjectCwd)
  const staleCwdRuntime = manager({ storageFile: staleCwdStorageFile })
  const staleCwdSession = await staleCwdRuntime.createSession({
    prompt: 'stale cwd diagnostic',
    label: 'Stale Cwd',
    cwd: staleProjectCwd,
  })
  await waitFor(
    'stale cwd session to finish',
    () => staleCwdRuntime.getState().sessions[staleCwdSession.sessionId]?.status === 'idle'
  )
  fs.rmSync(staleProjectCwd, { recursive: true, force: true })
  const invalidCwdRuntime = manager({ storageFile: staleCwdStorageFile })
  assert.ok(
    diagnosticsOf(invalidCwdRuntime.getState()).includes('storage.cwd_invalid'),
    'missing restored project cwd should create a diagnostic'
  )
  fs.mkdirSync(staleProjectCwd)
  const repairedCwdRuntime = manager({ storageFile: staleCwdStorageFile })
  assert.ok(
    !diagnosticsOf(repairedCwdRuntime.getState()).includes('storage.cwd_invalid'),
    'restored project cwd should clear stale cwd diagnostics'
  )

  // --- Kernel store (SQLite) persistence semantics ---

  const kernelDbFile = `${storageFile.replace(/\.json$/, '')}.sqlite`
  assert.ok(fs.existsSync(kernelDbFile), 'kernel store should live next to the storage file')

  const kernelLog = restored.getKernelEvents({ limit: 2000 })
  assert.ok(
    kernelLog.events.some(
      (event) =>
        event.type === 'session.created' &&
        event.payload.sessionId === sessionId &&
        event.actor.kind === 'human'
    ),
    'session.created must be logged with a human actor'
  )
  const createdEvent = kernelLog.events.find(
    (event) => event.type === 'session.created' && event.payload.sessionId === sessionId
  )
  assert.ok(
    kernelLog.events.some(
      (event) =>
        event.type === 'session.finished' &&
        event.payload.sessionId === sessionId &&
        event.actor.kind === 'provider' &&
        event.causeId === createdEvent.id
    ),
    'session.finished must chain to session.created via causeId'
  )
  assert.ok(
    kernelLog.events.some(
      (event) => event.type === 'activated' && event.payload.sessionId === sessionId
    ),
    'activated must be logged after restart'
  )
  const seqs = kernelLog.events.map((event) => event.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'kernel seq must be monotonic')

  // Corrupt kernel DB: preserved aside, runtime starts fresh with a diagnostic.
  const corruptStorageFile = path.join(tempRoot, 'orrery-corrupt-kernel-state.json')
  const corruptDbFile = `${corruptStorageFile.replace(/\.json$/, '')}.sqlite`
  const seeded = manager({ storageFile: corruptStorageFile })
  const seededSession = await seeded.createSession({
    prompt: 'corrupt kernel seed',
    label: 'Corrupt Seed',
    cwd: process.cwd(),
  })
  await waitFor(
    'corrupt seed session to finish',
    () => seeded.getState().sessions[seededSession.sessionId]?.status === 'idle'
  )
  seeded.killAll()
  fs.writeFileSync(corruptDbFile, 'this is not a sqlite database')
  fs.rmSync(`${corruptDbFile}-wal`, { force: true })
  fs.rmSync(`${corruptDbFile}-shm`, { force: true })
  const corruptRecovered = manager({ storageFile: corruptStorageFile }).getState()
  assert.equal(
    Object.keys(corruptRecovered.sessions).length,
    0,
    'corrupt kernel store should start with an empty state'
  )
  assert.ok(
    diagnosticsOf(corruptRecovered).includes('kernel-store.corrupt_database_preserved'),
    'corrupt kernel store should surface a diagnostic'
  )
  assert.ok(
    fs.readdirSync(tempRoot).some((name) => name.startsWith(path.basename(corruptDbFile)) && name.includes('.corrupt.')),
    'corrupt kernel store should be preserved for inspection'
  )

  // Legacy JSON migration: a pre-G0 JSON snapshot imports into SQLite once.
  const legacyStorageFile = path.join(tempRoot, 'orrery-legacy-state.json')
  fs.writeFileSync(legacyStorageFile, JSON.stringify(restored.getState(), null, 2))
  const migrated = manager({ storageFile: legacyStorageFile })
  const migratedState = migrated.getState()
  assert.ok(
    migratedState.sessions[sessionId],
    'legacy JSON snapshot should be imported on first run'
  )
  assertIdentity(migratedState)
  const migratedLog = migrated.getKernelEvents({ limit: 2000 })
  assert.ok(
    migratedLog.events.some((event) => event.type === 'storage.migrated'),
    'legacy import must be recorded as a storage.migrated kernel event'
  )
  assert.ok(
    fs.existsSync(`${legacyStorageFile.replace(/\.json$/, '')}.sqlite`),
    'migration should create the kernel store next to the legacy file'
  )

  // Corrupt kernel store next to a JSON fossil: restore the fossil, but as a
  // loud rollback (storage.restored-from-fossil), never as a fresh migration.
  const legacyDbFile = `${legacyStorageFile.replace(/\.json$/, '')}.sqlite`
  const archivedAfterMigration = await migrated.createSession({
    prompt: 'post-migration state that will roll back',
    label: 'Post Migration',
    cwd: process.cwd(),
  })
  await waitFor(
    'post-migration session to finish',
    () =>
      migrated.getState().sessions[archivedAfterMigration.sessionId]?.status ===
      'idle'
  )
  migrated.killAll()
  fs.writeFileSync(legacyDbFile, 'this is not a sqlite database')
  fs.rmSync(`${legacyDbFile}-wal`, { force: true })
  fs.rmSync(`${legacyDbFile}-shm`, { force: true })
  const rolledBack = manager({ storageFile: legacyStorageFile })
  const rolledBackState = rolledBack.getState()
  assert.ok(
    rolledBackState.sessions[sessionId],
    'fossil rollback should restore the pre-corruption snapshot'
  )
  assert.equal(
    rolledBackState.sessions[archivedAfterMigration.sessionId],
    undefined,
    'post-migration work is expected to be lost in a fossil rollback'
  )
  assert.ok(
    diagnosticsOf(rolledBackState).includes('storage.state_rolled_back'),
    'fossil rollback must surface a rollback diagnostic'
  )
  const rolledBackLog = rolledBack.getKernelEvents({ limit: 2000 })
  assert.ok(
    rolledBackLog.events.some(
      (event) => event.type === 'storage.restored-from-fossil'
    ),
    'fossil rollback must be recorded as storage.restored-from-fossil'
  )
  assert.ok(
    !rolledBackLog.events.some((event) => event.type === 'storage.migrated'),
    'fossil rollback must not masquerade as a fresh migration'
  )

  // A corrupt legacy JSON with no backup must not fake a migration event.
  const bogusStorageFile = path.join(tempRoot, 'orrery-bogus-legacy.json')
  fs.writeFileSync(bogusStorageFile, '{"version":2,"nodes":[')
  const bogusRecovered = manager({ storageFile: bogusStorageFile })
  assert.ok(
    diagnosticsOf(bogusRecovered.getState()).includes('storage.primary_parse_failed'),
    'corrupt legacy JSON should surface a parse diagnostic'
  )
  assert.ok(
    !bogusRecovered
      .getKernelEvents({ limit: 2000 })
      .events.some((event) => event.type === 'storage.migrated'),
    'a failed legacy import must not log storage.migrated'
  )

  const activeManager = manager({ storageFile: activeStorageFile })
  const active = await activeManager.createSession({
    prompt: 'ORRERY_DELAY simulate active run at app crash',
    label: 'Active recovery smoke',
    cwd: process.cwd(),
  })
  const activeSessionId = active.sessionId
  await waitFor(
    'active session to start',
    () => activeManager.getState().sessions[activeSessionId]?.status === 'running'
  )
  await waitFor(
    'active session to capture backend handle',
    () =>
      activeManager.getState().sessions[activeSessionId]?.providerSessionId ===
      activeSessionId,
  )

  const activeRecovered = manager({
    storageFile: activeStorageFile,
  })
  const activeRecoveredState = activeRecovered.getState()
  assertIdentity(activeRecoveredState)
  assert.equal(activeRecoveredState.sessions[activeSessionId].status, 'failed')
  assert.equal(activeRecoveredState.nodes[0].status, 'failed')
  assert.equal(activeRecoveredState.sessions[activeSessionId].backendSessionId, activeSessionId)
  assert.ok(
    diagnosticsOf(activeRecoveredState).includes('runtime.active_session_recovered'),
    'active run recovery should include a diagnostic'
  )
  assert.ok(
    activeRecovered
      .getKernelEvents({ limit: 2000 })
      .events.some(
        (event) =>
          event.type === 'session.failed' &&
          event.payload.sessionId === activeSessionId &&
          event.payload.interruptedByRestart === true &&
          event.actor.kind === 'runtime'
      ),
    'restart-interrupted sessions must get a terminal kernel event'
  )

  activeManager.killAll()
  await waitFor(
    'original active child to stop',
    () => activeManager.getState().sessions[activeSessionId]?.status === 'killed'
  )

  await activeRecovered.resumeSession({
    sessionId: activeSessionId,
    message: 'resume recovered active session',
  })
  await waitFor(
    'recovered active session to resume and finish',
    () => activeRecovered.getState().sessions[activeSessionId]?.status === 'idle'
  )
  assertIdentity(activeRecovered.getState())

  console.log(
    '[runtime:persistence] restore, corrupt recovery, active recovery, cwd propagation, stale cwd diagnostics, and resume passed'
  )
} finally {
  for (const runtime of managers) {
    try {
      runtime.killAll()
    } catch {
      // Best effort cleanup only.
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
