import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-master-loop-'))
const fakeClaude = path.join(tempRoot, 'claude')
const storageFile = path.join(tempRoot, 'orrery-runtime-state.json')
const managers = new Set()

const fakeClaudeSource = `#!/usr/bin/env node
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
if ((readArg('-p') ?? '').trimStart().startsWith('ORRERY_DELAY')) {
  setInterval(() => {}, 1000)
} else {
  emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
}
`

function installFakeClaude() {
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
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

function manager(input) {
  const runtime = new RuntimeSessionManager(input)
  managers.add(runtime)
  return runtime
}

async function waitIdle(runtime, sessionId, label = sessionId) {
  await waitFor(`${label} idle`, () =>
    runtime.getState().sessions[sessionId]?.status === 'idle'
  )
}

async function waitStatus(runtime, sessionId, status, label = sessionId) {
  await waitFor(`${label} ${status}`, () =>
    runtime.getState().sessions[sessionId]?.status === status
  )
}

function edges(state, kind, source, target) {
  return state.edges.filter(
    (edge) =>
      edge.kind === kind &&
      (source ? edge.source === source : true) &&
      (target ? edge.target === target : true)
  )
}

async function createCluster(runtime, label, maxIterations = 3) {
  const worker = await runtime.createSession({
    prompt: `${label} coder`,
    label: `${label} Coder`,
    cwd: process.cwd(),
  })
  await waitIdle(runtime, worker.sessionId, `${label} coder`)

  const policy = {
    until: { whenReport: { verdict: 'clean' } },
    onStop: 'freeze',
    maxIterations,
  }
  const cluster = runtime.upsertCluster({
    label,
    nodeIds: [worker.sessionId],
    loopPolicy: policy,
  })

  const master = await runtime.createMasterForCluster({
    clusterId: cluster.clusterId,
    label: `${label} Master`,
    prompt: `${label} master`,
    loopPolicy: policy,
  })
  await waitIdle(runtime, master.sessionId, `${label} master`)

  return {
    clusterId: cluster.clusterId,
    coderId: worker.sessionId,
    masterId: master.sessionId,
  }
}

async function reportIssues(runtime, reviewerId, summary = 'needs fixes') {
  await runtime.handleMembraneRequest({
    tool: 'report',
    source: reviewerId,
    input: {
      type: 'verdict',
      verdict: 'issues',
      summary,
      issues: [
        {
          message: 'fix null check',
          file: 'foo.ts',
          line: 42,
          severity: 'error',
        },
      ],
    },
  })
}

async function reportClean(runtime, reviewerId) {
  await runtime.handleMembraneRequest({
    tool: 'report',
    source: reviewerId,
    input: {
      type: 'verdict',
      verdict: 'clean',
      summary: 'review clean',
    },
  })
}

async function waitForReviewer(runtime, masterId, label) {
  const createEdge = await waitFor(`${label} reviewer create edge`, () =>
    runtime
      .getState()
      .edges.find(
        (edge) =>
          edge.kind === 'create-session' &&
          edge.source === masterId &&
          edge.masterReason?.includes('create reviewer')
      )
  )
  await waitIdle(runtime, createEdge.target, `${label} reviewer`)
  return createEdge.target
}

try {
  installFakeClaude()
  const runtime = manager({ storageFile })

  const clean = await createCluster(runtime, 'Clean loop', 3)
  runtime.startMasterLoop({
    clusterId: clean.clusterId,
    reason: 'smoke clean loop start',
  })
  const cleanReviewerId = await waitForReviewer(
    runtime,
    clean.masterId,
    'clean loop'
  )

  await reportIssues(runtime, cleanReviewerId)
  await waitFor('clean loop coder resume edge', () =>
    edges(runtime.getState(), 'resume-session', clean.masterId, clean.coderId)
      .find((edge) => edge.masterReason?.includes('iteration 1'))
  )
  await waitIdle(runtime, clean.coderId, 'clean loop coder resumed')

  await waitFor('clean loop reviewer resume edge', () =>
    edges(runtime.getState(), 'resume-session', clean.masterId, cleanReviewerId)
      .find((edge) => edge.masterReason?.includes('resume reviewer'))
  )
  await reportClean(runtime, cleanReviewerId)

  await waitFor('clean loop frozen state', () => {
    const state = runtime.getState()
    const cluster = state.clusters[clean.clusterId]
    const coderNode = state.nodes.find((node) => node.sessionId === clean.coderId)
    const reviewerNode = state.nodes.find(
      (node) => node.sessionId === cleanReviewerId
    )
    return (
      cluster?.loopState?.status === 'stopped' &&
      cluster.frozen === true &&
      coderNode?.frozen === true &&
      reviewerNode?.frozen === true &&
      edges(state, 'freeze', clean.masterId, clean.coderId).length > 0 &&
      edges(state, 'freeze', clean.masterId, cleanReviewerId).length > 0
    )
  })

  const restored = manager({ storageFile })
  const restoredClean = restored.getState().clusters[clean.clusterId]
  assert.equal(restoredClean.loopState.status, 'stopped')
  assert.equal(restoredClean.loopState.iterations, 1)
  assert.equal(restoredClean.loopState.reviewerSessionId, cleanReviewerId)
  assert.equal(restoredClean.frozen, true)

  // --- G0 kernel log: loop actions must be attributed to the rule actor and
  // causally chained to the events that triggered them. ---
  const kernelLog = runtime.getKernelEvents({ limit: 2000 }).events
  const kernelById = new Map(kernelLog.map((event) => [event.id, event]))

  const loopStarted = kernelLog.find(
    (event) =>
      event.type === 'loop.started' && event.payload.clusterId === clean.clusterId
  )
  assert.ok(loopStarted, 'loop.started must be logged')
  assert.equal(loopStarted.actor.kind, 'human')

  const reviewerCreated = kernelLog.find(
    (event) =>
      event.type === 'session.created' &&
      event.payload.sessionId === cleanReviewerId
  )
  assert.ok(reviewerCreated, 'reviewer creation must be logged')
  assert.equal(reviewerCreated.actor.kind, 'rule')
  assert.equal(reviewerCreated.actor.ref, `loop:${clean.clusterId}`)
  const reviewerCause = kernelById.get(reviewerCreated.causeId)
  assert.ok(
    reviewerCause &&
      ['loop.started', 'session.finished'].includes(reviewerCause.type),
    'reviewer creation must chain to the wakeup event'
  )

  const issuesReport = kernelLog.find(
    (event) =>
      event.type === 'report.received' &&
      event.payload.from === cleanReviewerId &&
      event.payload.verdict === 'issues'
  )
  assert.ok(issuesReport, 'issues verdict must be logged')
  assert.equal(issuesReport.actor.kind, 'agent')

  const coderResumed = kernelLog.find(
    (event) =>
      event.type === 'session.resumed' &&
      event.payload.sessionId === clean.coderId &&
      event.actor.kind === 'rule'
  )
  assert.ok(coderResumed, 'loop-driven coder resume must be logged as a rule action')
  assert.equal(
    coderResumed.causeId,
    issuesReport.id,
    'coder resume must chain to the issues report'
  )

  const cleanReport = kernelLog.find(
    (event) =>
      event.type === 'report.received' &&
      event.payload.from === cleanReviewerId &&
      event.payload.verdict === 'clean'
  )
  assert.ok(cleanReport, 'clean verdict must be logged')

  const loopStopped = kernelLog.find(
    (event) =>
      event.type === 'loop.stopped' && event.payload.clusterId === clean.clusterId
  )
  assert.ok(loopStopped, 'loop.stopped must be logged')
  assert.equal(loopStopped.actor.kind, 'rule')
  assert.equal(
    loopStopped.causeId,
    cleanReport.id,
    'loop stop must chain to the clean verdict report'
  )

  const freezeApplied = kernelLog.find(
    (event) =>
      event.type === 'freeze.applied' &&
      event.payload.targetId === clean.clusterId
  )
  assert.ok(freezeApplied, 'loop stop must log freeze.applied')
  assert.equal(freezeApplied.actor.kind, 'rule')
  assert.equal(
    freezeApplied.causeId,
    cleanReport.id,
    'freeze must chain to the clean verdict report'
  )

  const max = await createCluster(runtime, 'Max guard loop', 1)
  runtime.startMasterLoop({
    clusterId: max.clusterId,
    reason: 'smoke max guard start',
  })
  const maxReviewerId = await waitForReviewer(runtime, max.masterId, 'max loop')
  await reportIssues(runtime, maxReviewerId, 'first issue pass')
  await waitFor('max loop first coder resume', () =>
    edges(runtime.getState(), 'resume-session', max.masterId, max.coderId).length === 1
  )
  await waitIdle(runtime, max.coderId, 'max loop coder resumed')
  await waitFor('max loop reviewer resume edge', () =>
    edges(runtime.getState(), 'resume-session', max.masterId, maxReviewerId).length === 1
  )
  await reportIssues(runtime, maxReviewerId, 'second issue pass')
  await waitFor('max loop stopped by guard', () => {
    const state = runtime.getState()
    const cluster = state.clusters[max.clusterId]
    return (
      cluster?.loopState?.status === 'stopped' &&
      cluster.loopState.reason?.includes('maxIterations=1') &&
      cluster.frozen === true &&
      edges(state, 'resume-session', max.masterId, max.coderId).length === 1
    )
  })

  const stopped = await createCluster(runtime, 'Stop guard loop', 3)
  runtime.startMasterLoop({
    clusterId: stopped.clusterId,
    reason: 'smoke stop guard start',
  })
  const stoppedReviewerId = await waitForReviewer(
    runtime,
    stopped.masterId,
    'stop loop'
  )
  runtime.stopMasterLoop({
    clusterId: stopped.clusterId,
    reason: 'smoke user stop',
  })
  await reportIssues(runtime, stoppedReviewerId, 'ignored after stop')
  await delay(250)
  const stoppedState = runtime.getState()
  assert.equal(
    stoppedState.clusters[stopped.clusterId].loopState.status,
    'stopped'
  )
  assert.equal(
    edges(stoppedState, 'resume-session', stopped.masterId, stopped.coderId).length,
    0,
    'stopped loop must not resume coder after later reports'
  )

  const killedCoder = await runtime.createSession({
    prompt: 'ORRERY_DELAY running coder killed while loop waits',
    label: 'Killed Coder',
    cwd: process.cwd(),
  })
  await waitStatus(runtime, killedCoder.sessionId, 'running', 'killed coder')
  const killPolicy = {
    until: { whenReport: { verdict: 'clean' } },
    onStop: 'freeze',
    maxIterations: 3,
  }
  const killCluster = runtime.upsertCluster({
    label: 'Kill guard loop',
    nodeIds: [killedCoder.sessionId],
    loopPolicy: killPolicy,
  })
  const killMaster = await runtime.createMasterForCluster({
    clusterId: killCluster.clusterId,
    label: 'Kill guard Master',
    prompt: 'kill guard master',
    loopPolicy: killPolicy,
  })
  await waitIdle(runtime, killMaster.sessionId, 'kill guard master')
  runtime.startMasterLoop({
    clusterId: killCluster.clusterId,
    reason: 'smoke kill guard start',
  })
  await waitFor('kill guard loop waiting for coder', () => {
    const cluster = runtime.getState().clusters[killCluster.clusterId]
    return (
      cluster?.loopState?.status === 'running' &&
      cluster.loopState.reason === 'Waiting for coder to finish.'
    )
  })
  runtime.killSession(killedCoder.sessionId)
  await waitFor('kill guard loop stopped after coder kill', () => {
    const state = runtime.getState()
    const cluster = state.clusters[killCluster.clusterId]
    return (
      state.sessions[killedCoder.sessionId]?.status === 'killed' &&
      cluster?.loopState?.status === 'stopped' &&
      cluster.loopState.reason?.includes('killed') &&
      edges(state, 'create-session', killMaster.sessionId).length === 0 &&
      edges(state, 'resume-session', killMaster.sessionId).length === 0
    )
  })

  const stoppedRunningCoder = await runtime.createSession({
    prompt: 'ORRERY_DELAY running coder killed by stopMasterLoop',
    label: 'Stop Kill Coder',
    cwd: process.cwd(),
  })
  await waitStatus(
    runtime,
    stoppedRunningCoder.sessionId,
    'running',
    'stop kill coder'
  )
  const stopKillCluster = runtime.upsertCluster({
    label: 'Stop kill loop',
    nodeIds: [stoppedRunningCoder.sessionId],
    loopPolicy: killPolicy,
  })
  const stopKillMaster = await runtime.createMasterForCluster({
    clusterId: stopKillCluster.clusterId,
    label: 'Stop kill Master',
    prompt: 'stop kill master',
    loopPolicy: killPolicy,
  })
  await waitIdle(runtime, stopKillMaster.sessionId, 'stop kill master')
  runtime.startMasterLoop({
    clusterId: stopKillCluster.clusterId,
    reason: 'smoke stop kill start',
  })
  await waitFor('stop kill loop running', () =>
    runtime.getState().clusters[stopKillCluster.clusterId]?.loopState?.status ===
    'running'
  )
  runtime.stopMasterLoop({
    clusterId: stopKillCluster.clusterId,
    reason: 'smoke stop kill',
    killRunning: true,
  })
  await waitFor('stop kill loop killed running coder', () => {
    const state = runtime.getState()
    const cluster = state.clusters[stopKillCluster.clusterId]
    return (
      cluster?.loopState?.status === 'stopped' &&
      state.sessions[stoppedRunningCoder.sessionId]?.status === 'killed'
    )
  })

  const finalState = runtime.getState()
  console.log(
    `[master-loop] ok nodes=${finalState.nodes.length} edges=${finalState.edges.length} reports=${finalState.reports.length}`
  )
} finally {
  for (const runtime of managers) {
    try {
      runtime.killAll()
    } catch {
      // Best-effort cleanup only.
    }
  }
  delete process.env.ORRERY_CLAUDE_BIN
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
