import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from '../tests/runtime/support/deterministic-provider.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-canvas-smoke-'))
const storageFile = path.join(tempRoot, 'orrery-runtime-state.json')
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

function manager(input) {
  const runtime = new RuntimeSessionManager(input)
  managers.add(runtime)
  return runtime
}

function clusterMasterNodes(state, clusterId) {
  return state.nodes.filter(
    (node) => node.clusterId === clusterId && node.role === 'master'
  )
}

try {

  const runtime = manager({ storageFile })
  const worker = await runtime.createSession({
    prompt: 'worker session for canvas orchestration smoke',
    label: 'Coder',
    cwd: process.cwd(),
  })
  await waitFor(
    'worker to finish',
    () => runtime.getState().sessions[worker.sessionId]?.status === 'idle'
  )

  const policy = {
    until: { whenReport: { verdict: 'clean' } },
    onStop: 'freeze',
    maxIterations: 6,
  }
  const cluster = runtime.upsertCluster({
    label: 'Review loop',
    nodeIds: [worker.sessionId],
    loopPolicy: policy,
  })

  const master = await runtime.createMasterForCluster({
    clusterId: cluster.clusterId,
    label: 'Review loop Master',
    prompt: 'master session for canvas orchestration smoke',
    providerKind: 'claude-code',
    loopPolicy: policy,
  })
  await waitFor(
    'master to finish',
    () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
  )
  assert.equal(
    runtime.getState().sessions[master.sessionId].providerKind,
    'claude-code',
    'workflow-created master should use the normal Claude SDK provider'
  )

  const repeatedMaster = await runtime.createMasterForCluster({
    clusterId: cluster.clusterId,
    label: 'Duplicate Review loop Master',
    prompt: 'second master start should reuse the existing master',
    loopPolicy: policy,
  })
  assert.equal(
    repeatedMaster.sessionId,
    master.sessionId,
    'repeated Start Master should reuse the existing cluster master'
  )

  const replacement = await runtime.createSession({
    prompt: 'replacement master session for canvas orchestration smoke',
    label: 'Replacement Master',
    cwd: process.cwd(),
  })
  await waitFor(
    'replacement master candidate to finish',
    () => runtime.getState().sessions[replacement.sessionId]?.status === 'idle'
  )

  runtime.assignMasterToCluster({
    clusterId: cluster.clusterId,
    sessionId: replacement.sessionId,
  })

  runtime.setClusterLoopPolicy({
    clusterId: cluster.clusterId,
    loopPolicy: policy,
  })

  const state = runtime.getState()
  assert.equal(state.clusters[cluster.clusterId].nodeIds.length, 1)
  assert.equal(state.clusters[cluster.clusterId].nodeIds[0], worker.sessionId)
  assert.equal(
    state.clusters[cluster.clusterId].masterSessionId,
    replacement.sessionId
  )
  assert.equal(state.clusters[cluster.clusterId].loopPolicy.until.whenReport.verdict, 'clean')
  assert.equal(state.clusters[cluster.clusterId].loopPolicy.onStop, 'freeze')
  assert.equal(state.clusters[cluster.clusterId].loopPolicy.maxIterations, 6)
  assert.equal(state.sessions[master.sessionId].role, 'worker')
  assert.equal(state.sessions[replacement.sessionId].role, 'master')
  assert.equal(
    state.nodes.find((node) => node.sessionId === replacement.sessionId)?.role,
    'master'
  )
  assert.equal(
    state.nodes.find((node) => node.sessionId === master.sessionId)?.role,
    'worker',
    'replaced master node should be demoted'
  )
  assert.equal(
    state.clusters[cluster.clusterId].nodeIds.includes(replacement.sessionId),
    false,
    'master should not be counted as a managed worker node'
  )
  assert.equal(
    clusterMasterNodes(state, cluster.clusterId).length,
    1,
    'cluster should expose exactly one master node'
  )

  const freezeReason = 'Freeze managed scope for canvas orchestration smoke'
  runtime.freeze({
    target: cluster.clusterId,
    reason: freezeReason,
    source: replacement.sessionId,
    masterReason: freezeReason,
  })
  assert.ok(
    runtime
      .getState()
      .edges.some(
        (edge) =>
          edge.kind === 'freeze' &&
          edge.source === replacement.sessionId &&
          edge.target === worker.sessionId &&
          edge.masterReason === freezeReason
      ),
    'master-attributed cluster freeze should create a visible freeze edge'
  )
  await assert.rejects(
    () =>
      runtime.resumeSession({
        sessionId: worker.sessionId,
        message: 'worker should remain frozen with the cluster',
      }),
    /Frozen session cannot be resumed/
  )
  await runtime.resumeSession({
    sessionId: replacement.sessionId,
    message: 'master should remain a normal chat after cluster freeze',
  })
  await waitFor(
    'master to resume after cluster freeze',
    () => runtime.getState().sessions[replacement.sessionId]?.status === 'idle'
  )
  assert.equal(
    runtime.getState().nodes.find((node) => node.sessionId === replacement.sessionId)
      ?.frozen,
    undefined,
    'cluster freeze should not mark the master node frozen'
  )

  const restored = manager({ storageFile })
  const restoredState = restored.getState()
  assert.equal(
    restoredState.clusters[cluster.clusterId].masterSessionId,
    replacement.sessionId
  )
  assert.equal(restoredState.sessions[replacement.sessionId].role, 'master')
  assert.equal(restoredState.sessions[master.sessionId].role, 'worker')
  assert.equal(restoredState.clusters[cluster.clusterId].loopPolicy.maxIterations, 6)
  assert.equal(clusterMasterNodes(restoredState, cluster.clusterId).length, 1)
  assert.ok(
    restoredState.sessions[replacement.sessionId].messages.length >= 2,
    'restored master chat session should be openable in the left chat view'
  )

  console.log(
    '[canvas:orchestration] worker -> cluster -> master reuse/replace -> LoopPolicy -> restore passed'
  )
} finally {
  for (const runtime of managers) {
    try {
      runtime.killAll()
    } catch {
      // Best-effort cleanup only.
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
