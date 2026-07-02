import assert from 'node:assert/strict'

export const name = 'link-edge-declaration'
export const description =
  'Declare and remove a link edge between two real sessions, observing the edge.created broadcast.'

export async function run({ orrery, provider, workDir, log }) {
  const coder = await orrery.createSession({
    ...provider,
    label: 'Coder',
    cwd: workDir,
    prompt: 'Reply with exactly: ready.',
  })
  const reviewer = await orrery.createSession({
    ...provider,
    label: 'Reviewer',
    cwd: workDir,
    prompt: 'Reply with exactly: ready.',
  })
  await orrery.waitForIdle(coder.sessionId)
  await orrery.waitForIdle(reviewer.sessionId)
  log('both sessions idle')

  let linked
  const edgeEvent = await orrery.waitForEvent(
    (event) => event.type === 'edge.created',
    {
      label: 'edge.created broadcast',
      trigger: async () => {
        linked = await orrery.linkSessions(reviewer.sessionId, coder.sessionId, {
          label: 'reviews',
          reason: 'Reviewer session watches the coder session.',
        })
      },
    }
  )
  assert.equal(edgeEvent.edgeId, linked.edge.edgeId)
  log(`link edge ${linked.edge.edgeId}`)

  const graph = await orrery.graph()
  const edge = graph.edges.find((candidate) => candidate.kind === 'link')
  assert.equal(edge.source, reviewer.sessionId)
  assert.equal(edge.target, coder.sessionId)
  assert.equal(edge.label, 'reviews')

  await orrery.removeEdge(linked.edge.edgeId)
  const graphAfterRemove = await orrery.graph()
  assert.equal(
    graphAfterRemove.edges.some((candidate) => candidate.kind === 'link'),
    false,
    'removed link edge must disappear from the topology'
  )
}
