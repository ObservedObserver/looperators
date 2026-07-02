import assert from 'node:assert/strict'

export const name = 'freeze-cascade'
export const description =
  'Freeze a cluster and verify the worker refuses resume, the freeze edge appears, and the master stays usable.'

export async function run({ orrery, provider, workDir, log }) {
  const worker = await orrery.createSession({
    ...provider,
    label: 'Worker',
    cwd: workDir,
    prompt: 'Reply with exactly: worker ready.',
  })
  const controller = await orrery.createSession({
    ...provider,
    label: 'Controller',
    cwd: workDir,
    prompt: 'Reply with exactly: controller ready.',
  })
  await orrery.waitForIdle(worker.sessionId)
  await orrery.waitForIdle(controller.sessionId)
  log('worker and controller idle')

  const cluster = await orrery.upsertCluster({
    label: 'Freeze Cascade',
    nodeIds: [worker.sessionId],
  })

  await orrery.freeze({
    target: cluster.clusterId,
    reason: 'Acceptance freeze cascade',
    source: controller.sessionId,
    masterReason: 'Acceptance freeze cascade',
  })
  log('cluster frozen')

  const graph = await orrery.graph()
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.kind === 'freeze' &&
        edge.source === controller.sessionId &&
        edge.target === worker.sessionId
    ),
    true,
    'attributed cluster freeze must create a visible freeze edge'
  )
  const workerNode = graph.nodes.find((node) => node.sessionId === worker.sessionId)
  assert.equal(workerNode.frozen, true, 'worker node must be frozen')

  await assert.rejects(
    () =>
      orrery.resumeSession(worker.sessionId, {
        message: 'frozen worker must reject resume',
      }),
    /Frozen session cannot be resumed/
  )

  await orrery.resumeSession(controller.sessionId, {
    message: 'Reply with exactly: still here.',
  })
  const controllerSummary = await orrery.waitForIdle(controller.sessionId)
  assert.equal(controllerSummary.status, 'idle', 'controller must stay usable')
}
