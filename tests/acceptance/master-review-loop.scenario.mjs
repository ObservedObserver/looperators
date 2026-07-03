import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'master-review-loop'
export const description =
  'G3 hero loop: the LoopPolicy preset compiles into S1/S2 subscriptions; a real master approves the pending activation via membrane, the reviewer reads the diff from its channel and reports clean, and the stop condition freezes the scope (§12.5 alignment).'
export const timeoutMs = 480_000

function git(cwd, ...args) {
  execFileSync(
    'git',
    ['-c', 'user.name=orrery-acceptance', '-c', 'user.email=acceptance@orrery.local', ...args],
    { cwd, stdio: 'ignore' }
  )
}

export async function run({ orrery, provider, modelPreset, workDir, log }) {
  // Seed a real repo with an unambiguously harmless pending change (a typo
  // fix), so "clean" is the semantically correct verdict rather than a coin
  // flip over an unreadable diff.
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

  // The master is a real agent whose only judgement duty is the gate: it
  // must approve each pending activation it is asked about (§8.2 division —
  // the runtime does the clerical work).
  const master = await orrery.createMasterForCluster(cluster.clusterId, {
    // Instruction-style and precedence-explicit: cheap models otherwise let
    // the bootstrap "reply with exactly ..." win over later requests.
    prompt:
      'You are the review master for a managed cluster. Follow this rule on every message, it overrides everything else: ' +
      'IF the message contains a slotKey, call mcp__orrery_membrane__approve_activation exactly once with that exact slotKey value, then stop. ' +
      'Do not call any other membrane tools. ' +
      'ONLY IF the message contains no slotKey (like this first one), reply with exactly: standing by.',
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

  // The preset compiled into the two §8.2 subscriptions.
  const stateAfterStart = await orrery.state()
  const subs = Object.values(stateAfterStart.subscriptions ?? {})
  const s1 = subs.find((sub) => sub.label === 'S1')
  const s2 = subs.find((sub) => sub.label === 'S2')
  assert.ok(s1 && s2, 'startMasterLoop must author the S1/S2 subscriptions')
  assert.equal(s2.stop.whenReport.verdict, 'clean')
  assert.equal(s2.stop.maxFirings, 3)
  const reviewerSessionId = s1.target.sessionId
  log(`loop reviewer ${reviewerSessionId}`)

  // Real-LLM §12.5 walk: kick pends S1 → the real master approves via
  // membrane → the reviewer reads the diff from its channel → clean verdict
  // → S2 stops → freeze-cluster.
  const report = await orrery.waitForReport(
    { verdict: 'clean' },
    { timeoutMs: 420_000 }
  )
  log(`clean verdict report from ${report.from}`)

  await orrery.waitFor('loop to stop', async () => {
    const state = await orrery.state()
    const current = state.clusters[cluster.clusterId]?.loopState
    return current?.status === 'stopped'
      ? { done: true, value: current }
      : { detail: current?.reason ?? 'no loop state' }
  })

  // Settle every session before asserting on final state.
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
    report.from,
    reviewerSessionId,
    'the clean verdict must come from the S1 target (the loop reviewer)'
  )
  assert.equal(state.subscriptions[s1.id].state, 'stopped')
  assert.equal(state.subscriptions[s2.id].state, 'stopped')
  assert.equal(
    state.subscriptions[s2.id].firings,
    state.clusters[cluster.clusterId].loopState.iterations,
    'iteration count = S2 firings (§6.2)'
  )
  const workerNode = state.nodes.find((node) => node.sessionId === worker.sessionId)
  assert.equal(workerNode.frozen, true, 'onStop freeze must freeze the managed worker')
  assert.equal(state.clusters[cluster.clusterId].frozen, true)

  // Kernel-log evidence: the REAL master's approval is on the blackboard,
  // and the stop chains to the clean verdict.
  const { events } = await orrery.kernelEvents({ limit: 2000 })
  const approval = events.find(
    (event) =>
      event.type === 'activation.approved' &&
      event.actor.kind === 'master' &&
      event.actor.ref === master.sessionId
  )
  assert.ok(approval, 'the real master approved the pending activation via membrane')
  const cleanReportEvent = events
    .filter(
      (event) => event.type === 'report.received' && event.payload.verdict === 'clean'
    )
    .at(-1)
  const s2Stopped = events.find(
    (event) =>
      event.type === 'subscription.stopped' &&
      event.payload.subscriptionId === s2.id
  )
  assert.equal(
    s2Stopped.causeId,
    cleanReportEvent.id,
    'the stop chains to the clean verdict in the kernel log'
  )
  const diffDelivered = events.find(
    (event) =>
      event.type === 'delivered' &&
      event.payload.subscriptionId === s1.id &&
      event.payload.topic === 'diff'
  )
  assert.ok(diffDelivered, 'the S1 firing delivered the diff through the channel')

  // Cost guard: master and reviewer must ride the cheap preset.
  const presetModel = modelPreset?.[provider.providerKind]?.model
  if (presetModel) {
    for (const sessionId of [master.sessionId, reviewerSessionId]) {
      const session = state.sessions[sessionId]
      assert.equal(
        session.runtimeSettings?.model,
        presetModel,
        `${session.label} must run on the preset model, got ${session.runtimeSettings?.model}`
      )
    }
  }
}
