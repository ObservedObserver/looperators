import assert from 'node:assert/strict'

export const name = 'watcher-auto-gate'
export const description =
  'G3 acceptance watcher (§8.3): a gate=auto subscription fires without any master — the runtime delivers the artifact bundle and activates the acceptor, which reads the delivered file. Closing the cycle without guards is rejected into safe defaults by the static check.'

export async function run({ orrery, provider, workDir, log }) {
  const coder = await orrery.createSession({
    ...provider,
    label: 'Watched Coder',
    cwd: workDir,
    prompt: 'Reply with exactly: ready.',
  })
  await orrery.waitForIdle(coder.sessionId)
  const acceptor = await orrery.createSession({
    ...provider,
    label: 'Acceptor',
    cwd: workDir,
    prompt: 'Reply with exactly: acceptor ready. Then wait for activations.',
  })
  await orrery.waitForIdle(acceptor.sessionId)

  // S3 (§8.3): permanent listener, no stop, no master involved.
  const authored = await orrery.authorSubscription({
    label: 'S3',
    sourceSessionId: coder.sessionId,
    on: { on: 'finished' },
    targetSessionId: acceptor.sessionId,
    action: {
      kind: 'deliver+activate',
      topic: 'changeset',
      note:
        'A changeset was delivered to your context channel (files listed below). ' +
        'Read the delivered turn summary, find the marker code of the form MARKER-<number> in it, ' +
        'and reply with only that marker code. Then stop.',
    },
    gate: 'auto',
  })
  const s3 = authored.subscription
  assert.equal(s3.gate, 'auto')
  assert.equal(s3.stop, undefined, 'a permanent acyclic listener carries no forced stop')
  log(`watcher subscription ${s3.id}`)

  // The coder finishes a turn whose summary carries a deterministic marker.
  await orrery.resumeSession(coder.sessionId, {
    message: 'Reply with exactly: work finished, marker MARKER-77. Then stop.',
  })
  await orrery.waitForIdle(coder.sessionId)

  // No human, no master: the runtime fires the watcher on its own.
  await orrery.waitFor('watcher firing', async () => {
    const state = await orrery.state()
    const sub = state.subscriptions?.[s3.id]
    const busy = Object.values(state.sessions).some(
      (session) => session.status === 'running' || session.status === 'pending'
    )
    return sub?.firings >= 1 && !busy
      ? { done: true, value: sub }
      : { detail: `firings=${sub?.firings ?? 0}` }
  })

  const transcript = await orrery.transcript(acceptor.sessionId)
  const reply = transcript.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')
  assert.match(
    reply,
    /MARKER-77/,
    `the acceptor must read the delivered summary and surface the marker, got: ${reply}`
  )

  // Kernel-log evidence: rule-approved (auto) activation chain.
  const { events } = await orrery.kernelEvents({ limit: 2000 })
  const approved = events.find(
    (event) =>
      event.type === 'activation.approved' &&
      event.payload.subscriptionId === s3.id
  )
  assert.ok(approved, 'the auto gate approved the firing')
  assert.equal(approved.actor.kind, 'rule', 'auto approvals are rule actors')
  const activated = events.find(
    (event) =>
      event.type === 'activated' && event.payload.subscriptionId === s3.id
  )
  assert.ok(activated, 'the firing activated the acceptor')

  // Static check: closing the loop back to the coder without guards must be
  // forced into safe defaults (§6.4) — gate=master and default maxFirings.
  const back = await orrery.authorSubscription({
    label: 'S4',
    sourceSessionId: acceptor.sessionId,
    on: { on: 'finished' },
    targetSessionId: coder.sessionId,
    action: { kind: 'deliver+activate' },
  })
  assert.equal(back.subscription.gate, 'master', 'cycle default gate is master')
  assert.equal(back.subscription.stop.maxFirings, 6, 'cycle edges get default maxFirings')
  assert.ok(
    back.staticCheck.guardedSubscriptionIds.length >= 1,
    'the static check reported the forced guardrails'
  )
  // Stop both to leave the graph quiet before teardown.
  await orrery.stopSubscription(back.subscription.id, { reason: 'scenario cleanup' })
  await orrery.stopSubscription(s3.id, { reason: 'scenario cleanup' })

  const state = await orrery.state()
  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log('watcher auto-gate verified: rule-approved firing + static check defaults')
}
