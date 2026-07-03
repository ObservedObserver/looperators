import assert from 'node:assert/strict'

export const name = 'channel-handoff'
export const description =
  'G2 acceptance: a channel-mediated handoff between two real sessions follows the §8.1 sequence — create B, deliver the upstream artifact bundle (topic handoff), activate B with a short note; B reads the delivered file and acts on it.'

export async function run({ orrery, provider, workDir, log }) {
  // Upstream session A produces a memorable turn (its summary becomes the
  // artifact bundle payload).
  const upstream = await orrery.createSession({
    ...provider,
    label: 'Handoff Upstream',
    cwd: workDir,
    prompt:
      'Reply with exactly this sentence and nothing else: The agreed codeword is NECTAR-77.',
  })
  log(`upstream session ${upstream.sessionId}`)
  await orrery.waitForIdle(upstream.sessionId)

  // §8.1 step 1: create B (a plain, context-free bootstrap).
  const downstream = await orrery.createSession({
    ...provider,
    label: 'Handoff Downstream',
    cwd: workDir,
    prompt: 'Reply with exactly: ready. Then stop and wait for instructions.',
  })
  log(`downstream session ${downstream.sessionId}`)
  await orrery.waitForIdle(downstream.sessionId)

  const baseline = await orrery.kernelEvents()

  // §8.1 step 2: deliver A's artifact bundle into B's channel (data plane,
  // no activation — B must stay idle).
  const delivered = await orrery.deliverToSession(downstream.sessionId, {
    topic: 'handoff',
    source: upstream.sessionId,
  })
  assert.ok(delivered.delivery.files.length >= 1, 'the bundle has files')
  const afterDeliver = await orrery.session(downstream.sessionId)
  assert.equal(
    afterDeliver.session.status,
    'idle',
    'a pure delivery must not activate the target'
  )

  // §8.1 step 3: activate B with a short note; the runtime assembles the
  // delivery listing deterministically.
  await orrery.activateSession(downstream.sessionId, {
    note:
      'You received an upstream handoff. Read the delivered files listed below, ' +
      'find the agreed codeword in them, then reply with only that codeword and nothing else.',
  })
  await orrery.waitForIdle(downstream.sessionId)

  const transcript = await orrery.transcript(downstream.sessionId)
  const reply = transcript.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')
  assert.match(
    reply,
    /NECTAR-77/,
    `downstream must surface the codeword from the delivered file, got: ${reply}`
  )

  // The kernel log reads deliver → activate → finish with intact causality.
  const { events } = await orrery.kernelEvents({ since: baseline.latestSeq, limit: 2000 })
  const deliveredEvent = events.find(
    (event) =>
      event.type === 'delivered' &&
      event.payload.target === downstream.sessionId &&
      event.payload.topic === 'handoff'
  )
  assert.ok(deliveredEvent, 'delivered must be in the kernel log')
  assert.equal(deliveredEvent.payload.source, upstream.sessionId)

  const activatedEvent = events.find(
    (event) =>
      event.type === 'activated' &&
      event.payload.sessionId === downstream.sessionId
  )
  assert.ok(activatedEvent, 'activated must be in the kernel log')
  assert.ok(
    (activatedEvent.payload.deliveries ?? []).includes(
      deliveredEvent.payload.channelSeq
    ),
    'the activation consumed the handoff delivery'
  )
  assert.ok(activatedEvent.seq > deliveredEvent.seq, 'deliver precedes activate')

  const finishedEvent = events.find(
    (event) =>
      event.type === 'session.finished' &&
      event.payload.sessionId === downstream.sessionId &&
      event.causeId === activatedEvent.id
  )
  assert.ok(finishedEvent, 'the finish chains to the activation')

  // Clean chat history (§8.1): the bootstrap is short, the handoff payload
  // itself lives in the channel file rather than the transcript.
  const userMessages = transcript.messages.filter(
    (message) => message.role === 'user'
  )
  assert.ok(
    userMessages.every(
      (message) => !message.content.includes('The agreed codeword is')
    ),
    'the handoff payload must not be inlined into the chat history'
  )
  log('channel handoff verified: deliver → activate → finish, payload off-transcript')
}
