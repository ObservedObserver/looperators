import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'master-review-loop'
export const description =
  'Cluster a worker, create a review master, run the master loop until a clean verdict report stops it and freezes the managed scope.'
export const timeoutMs = 480_000

function git(cwd, ...args) {
  execFileSync(
    'git',
    ['-c', 'user.name=orrery-acceptance', '-c', 'user.email=acceptance@orrery.local', ...args],
    { cwd, stdio: 'ignore' }
  )
}

export async function run({ orrery, provider, modelPreset, workDir, log }) {
  // The loop reviewer reviews the coder cwd's working-tree diff. Seed a real
  // repo with an unambiguously harmless pending change (a typo fix), so
  // "clean" is the semantically correct verdict rather than a coin flip over
  // an unreadable diff.
  git(workDir, 'init')
  const notesFile = path.join(workDir, 'notes.txt')
  fs.writeFileSync(notesFile, 'teh quick brown fox jumps over the lazy dog\n')
  git(workDir, 'add', '.')
  git(workDir, 'commit', '-m', 'baseline notes')
  fs.writeFileSync(notesFile, 'the quick brown fox jumps over the lazy dog\n')

  const worker = await orrery.createSession({
    ...provider,
    label: 'Loop Worker',
    cwd: workDir,
    prompt: 'Reply with exactly: worker ready.',
  })
  await orrery.waitForIdle(worker.sessionId)
  log('worker idle')

  const policy = {
    until: { whenReport: { verdict: 'clean' } },
    onStop: 'freeze',
    maxIterations: 3,
  }
  const cluster = await orrery.upsertCluster({
    label: 'Acceptance Review Loop',
    nodeIds: [worker.sessionId],
    loopPolicy: policy,
  })

  // The loop machinery creates and instructs its own reviewer session; the
  // master only anchors the cluster, so its prompt stays neutral.
  const master = await orrery.createMasterForCluster(cluster.clusterId, {
    prompt:
      'You are the review master for a managed cluster. Reply with exactly: standing by.',
    providerKind: provider.providerKind,
    label: 'Acceptance Review Master',
    cwd: workDir,
    loopPolicy: policy,
  })
  log(`master ${master.sessionId}`)
  await orrery.waitForIdle(master.sessionId)

  await orrery.startMasterLoop(cluster.clusterId, {
    reason: 'Acceptance master loop run',
  })
  log('loop started')

  const report = await orrery.waitForReport(
    { verdict: 'clean' },
    { timeoutMs: 420_000 }
  )
  log(`clean verdict report from ${report.from}`)

  const loopState = await orrery.waitFor('loop to stop', async () => {
    const state = await orrery.state()
    const current = state.clusters[cluster.clusterId]?.loopState
    return current?.status === 'stopped'
      ? { done: true, value: current }
      : { detail: current?.reason ?? 'no loop state' }
  })
  log(`loop stopped: ${loopState.reason}`)

  // The loop stops on the report while the reviewer's turn is still
  // streaming; settle every session before asserting, so the pass reflects a
  // final state and harness teardown never kills an active provider run.
  await orrery.waitForIdle(report.from)
  for (const session of Object.values((await orrery.state()).sessions)) {
    if (session.status === 'running' || session.status === 'pending') {
      await orrery.waitForIdle(session.sessionId)
    }
  }

  const state = await orrery.state()
  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  assert.equal(
    state.clusters[cluster.clusterId].loopState.reviewerSessionId,
    report.from,
    'the clean verdict must come from the loop reviewer session'
  )
  const workerNode = state.nodes.find((node) => node.sessionId === worker.sessionId)
  assert.equal(
    workerNode.frozen,
    true,
    'loop policy onStop: freeze must freeze the managed worker'
  )
  assert.equal(
    state.clusters[cluster.clusterId].frozen,
    true,
    'loop policy onStop: freeze must freeze the cluster'
  )

  // Cost guard: the whole loop — master and the reviewer it spawned — must
  // ride the cheap preset, never silently fall back to default models.
  const presetModel = modelPreset?.[provider.providerKind]?.model
  if (presetModel) {
    for (const sessionId of [master.sessionId, report.from]) {
      const session = state.sessions[sessionId]
      assert.equal(
        session.runtimeSettings?.model,
        presetModel,
        `${session.label} must run on the preset model, got ${session.runtimeSettings?.model}`
      )
    }
  }
}
