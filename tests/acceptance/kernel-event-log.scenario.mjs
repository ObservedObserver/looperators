import assert from 'node:assert/strict'

export const name = 'kernel-event-log'
export const description =
  'G0/G2 acceptance: real session lifecycle lands in the SQLite kernel event log with actors and causal chains (session.created -> session.finished -> activated).'

export async function run({ orrery, provider, workDir, log }) {
  const before = await orrery.kernelEvents()
  const baselineSeq = before.latestSeq
  log(`kernel log baseline seq ${baselineSeq}`)

  const created = await orrery.createSession({
    ...provider,
    label: 'Kernel Log Probe',
    cwd: workDir,
    prompt: 'Reply with exactly: ready. Then stop.',
  })
  log(`probe session ${created.sessionId}`)
  await orrery.waitForIdle(created.sessionId)

  await orrery.resumeSession(created.sessionId, {
    message: 'Reply with exactly: done. Then stop.',
  })
  await orrery.waitForIdle(created.sessionId)

  const { events, latestSeq } = await orrery.kernelEvents({ since: baselineSeq, limit: 2000 })
  assert.ok(latestSeq > baselineSeq, 'real runs must append kernel events')

  const createdEvent = events.find(
    (event) =>
      event.type === 'session.created' &&
      event.payload.sessionId === created.sessionId
  )
  assert.ok(createdEvent, 'session.created must be in the kernel log')
  assert.equal(createdEvent.actor.kind, 'human', 'API-created sessions act as human')

  const finishedEvents = events.filter(
    (event) =>
      event.type === 'session.finished' &&
      event.payload.sessionId === created.sessionId
  )
  assert.ok(finishedEvents.length >= 2, 'both turns must log session.finished')
  assert.equal(finishedEvents[0].actor.kind, 'provider')
  assert.equal(
    finishedEvents[0].causeId,
    createdEvent.id,
    'the first finish must chain to session.created via causeId'
  )

  const resumedEvent = events.find(
    (event) =>
      event.type === 'activated' &&
      event.payload.sessionId === created.sessionId
  )
  assert.ok(resumedEvent, 'activated must be in the kernel log')
  assert.equal(
    finishedEvents[1].causeId,
    resumedEvent.id,
    'the second finish must chain to the activation via causeId'
  )

  const seqs = events.map((event) => event.seq)
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    'kernel seq must be monotonic'
  )
  log(`kernel log verified: ${events.length} events, causal chain intact`)
}
