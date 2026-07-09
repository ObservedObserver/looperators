import assert from 'node:assert/strict'

export const name = 'timer-beats'
export const description =
  'L1 acceptance (proposal §L1 验收): a real agent on an every-15s schedule is woken repeatedly — three external.timer facts land with complete causal chains into real activations; freezing the target keeps the beats flowing into the log while the activation is parked as a dirty slot (unfreeze-side verification awaits an unfreeze verb).'
export const timeoutMs = 480_000

export async function run({ orrery, provider, workDir, log }) {
  const target = await orrery.createSession({
    ...provider,
    label: 'Scheduled Summarizer',
    cwd: workDir,
    prompt: 'Reply with exactly: summarizer ready.',
  })
  await orrery.waitForIdle(target.sessionId)

  const authored = await orrery.authorSubscription({
    label: 'beat',
    source: { kind: 'timer' },
    on: { on: 'schedule', everySeconds: 15 },
    targetSessionId: target.sessionId,
    action: {
      kind: 'deliver+activate',
      note: 'Scheduled beat: reply with exactly: beat received. Then stop.',
    },
    gate: 'auto',
  })
  const sub = authored.subscription
  log(`schedule subscription ${sub.id} (every 15s)`)

  // Three real beats, at least two of which drive full turns (a beat that
  // lands mid-turn coalesces — that is the designed §6.1 behavior, and the
  // tick fact still reaches the log).
  const ticksOf = (events) =>
    events.filter(
      (event) =>
        event.type === 'external.timer' &&
        event.payload.subscriptionId === sub.id
    )
  await orrery.waitFor(
    'three beats and two completed activations',
    async () => {
      const { events } = await orrery.kernelEvents({ limit: 5000 })
      const ticks = ticksOf(events)
      const activated = events.filter(
        (event) =>
          event.type === 'activated' && event.payload.subscriptionId === sub.id
      )
      return ticks.length >= 3 && activated.length >= 2
        ? { done: true, value: { ticks, activated } }
        : { detail: `ticks=${ticks.length} activated=${activated.length}` }
    },
    { timeoutMs: 240_000 }
  )
  await orrery.waitForIdle(target.sessionId)

  // Causal chains: every pending activation of this edge chains to a tick
  // fact, and the ticks are runtime-actor facts (the clock is a source, not
  // a session).
  const { events } = await orrery.kernelEvents({ limit: 5000 })
  const ticks = ticksOf(events)
  const tickIds = new Set(ticks.map((event) => event.id))
  assert.ok(
    ticks.every((event) => event.actor.kind === 'runtime'),
    'ticks are appended by the runtime timer source'
  )
  const pendings = events.filter(
    (event) =>
      event.type === 'activation.pending' &&
      event.payload.subscriptionId === sub.id
  )
  assert.ok(pendings.length >= 2, 'beats produced pending activations')
  for (const pending of pendings) {
    assert.ok(
      tickIds.has(pending.causeId),
      `pending ${pending.id} must chain to a tick fact, got causeId=${pending.causeId}`
    )
  }

  // The real agent actually answered the beats.
  const transcript = await orrery.transcript(target.sessionId)
  const beatReplies = transcript.messages.filter(
    (message) => message.role === 'assistant' && /beat received/i.test(message.content ?? '')
  )
  assert.ok(
    beatReplies.length >= 2,
    `the summarizer must answer the beats, got ${beatReplies.length} beat replies`
  )

  // Freeze the target mid-schedule: beats keep landing in the log, but no
  // new activation executes — the approved slot parks as the dirty flag.
  const { latestSeq: freezeSeq } = await orrery.kernelEvents({ limit: 1 })
  await orrery.freeze({ target: target.sessionId, reason: 'Acceptance freeze mid-schedule' })
  log('target frozen; waiting for a beat to land while frozen')
  await orrery.waitFor(
    'a tick fact while frozen',
    async () => {
      const { events: after } = await orrery.kernelEvents({ since: freezeSeq, limit: 2000 })
      const tick = after.find(
        (event) =>
          event.type === 'external.timer' &&
          event.payload.subscriptionId === sub.id
      )
      return tick ? { done: true, value: tick } : { detail: 'no tick yet' }
    },
    { timeoutMs: 60_000 }
  )
  // Give the scheduler a beat's worth of chances to (incorrectly) run it.
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const { events: frozenWindow } = await orrery.kernelEvents({ since: freezeSeq, limit: 2000 })
  assert.equal(
    frozenWindow.filter(
      (event) => event.type === 'activated' && event.payload.subscriptionId === sub.id
    ).length,
    0,
    'no activation may execute while the target is frozen'
  )
  const parked = Object.values((await orrery.state()).pendingActivations ?? {}).find(
    (slot) => slot.subscriptionId === sub.id
  )
  assert.ok(parked, 'the frozen beat parks as a dirty slot (fires on a later drain)')
  log(`beat parked as dirty slot ${parked.slotKey} while frozen`)

  await orrery.stopSubscription(sub.id, { reason: 'scenario cleanup' })
  const state = await orrery.state()
  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log('timer beats verified: 3 ticks, causal chains, real replies, freeze parks the beat')
}
