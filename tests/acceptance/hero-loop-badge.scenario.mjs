import assert from 'node:assert/strict'

export const name = 'hero-loop-badge'
export const description =
  'L4 acceptance (proposal §L4 验收): a real two-agent ring spins to its lap cap while the loop badge (state.loops) tracks lap count and status; afterwards the per-lap timeline alone — no session opened — retells every lap: who triggered it, who let it through the gate, and how it ended.'
export const timeoutMs = 480_000

export async function run({ orrery, provider, workDir, log }) {
  const ping = await orrery.createSession({
    ...provider,
    label: 'Ping',
    cwd: workDir,
    prompt: 'Reply with exactly: ping ready.',
  })
  await orrery.waitForIdle(ping.sessionId)
  const pong = await orrery.createSession({
    ...provider,
    label: 'Pong',
    cwd: workDir,
    prompt: 'Reply with exactly: pong ready.',
  })
  await orrery.waitForIdle(pong.sessionId)

  // A deliberately tiny ring: each activation is one short real turn. Both
  // edges carry maxFirings 2, so the ring must stop itself at lap 2.
  const edgeOut = (
    await orrery.authorSubscription({
      label: 'ping→pong',
      sourceSessionId: ping.sessionId,
      on: { on: 'finished' },
      targetSessionId: pong.sessionId,
      action: { kind: 'deliver+activate', note: 'Reply with exactly: pong. Then stop.' },
      gate: 'auto',
      stop: { maxFirings: 2 },
    })
  ).subscription
  const edgeBack = (
    await orrery.authorSubscription({
      label: 'pong→ping',
      sourceSessionId: pong.sessionId,
      on: { on: 'finished' },
      targetSessionId: ping.sessionId,
      action: { kind: 'deliver+activate', note: 'Reply with exactly: ping. Then stop.' },
      gate: 'auto',
      stop: { maxFirings: 2 },
    })
  ).subscription
  log(`ring authored: ${edgeOut.id} ⇄ ${edgeBack.id}`)

  // The projection must see the ring before it ever fires.
  const idle = (await orrery.state()).loops ?? []
  assert.equal(idle.length, 1, 'the ring projects exactly one loop')
  assert.equal(idle[0].status, 'idle')
  assert.equal(idle[0].lapCap, 2, 'lapCap = min stop.maxFirings across ring edges')
  const loopId = idle[0].loopId

  // Kick the ring with one real turn and read the badge while it spins.
  await orrery.resumeSession(ping.sessionId, {
    message: 'Reply with exactly: starting the ring. Then stop.',
  })
  let sawLiveBadge = false
  const stopped = await orrery.waitFor(
    'ring spins to its cap and stops',
    async () => {
      const loops = (await orrery.state()).loops ?? []
      const loop = loops.find((candidate) => candidate.loopId === loopId)
      if (!loop) {
        return { detail: 'loop projection missing' }
      }
      if (loop.status === 'spinning' || loop.status === 'waiting-gate') {
        sawLiveBadge = true
      }
      return loop.status === 'stopped'
        ? { done: true, value: loop }
        : { detail: `status=${loop.status} laps=${loop.lapCount}` }
    },
    { timeoutMs: 300_000 }
  )
  assert.ok(sawLiveBadge, 'the badge must be readable as live while the ring turns')
  assert.equal(stopped.lapCount, 2, 'the badge counts exactly the capped laps')
  // The badge speaks the projection's compact vocabulary ("max 2"), the
  // kernel log keeps the raw reason ("maxFirings=2 reached.").
  assert.match(
    stopped.stopSummary ?? '',
    /max 2/,
    'the badge names the guardrail that stopped the ring'
  )

  // Settle both agents before reading the timeline.
  await orrery.waitForIdle(ping.sessionId)
  await orrery.waitForIdle(pong.sessionId)

  // The 一分钟读懂 claim: the loop timeline ALONE retells the run.
  const { timeline } = await orrery.getLoopTimeline(loopId)
  assert.equal(timeline.laps.length, 2, 'one timeline lap per counted lap')
  for (const lap of timeline.laps) {
    assert.ok(lap.hops.length >= 1, `lap ${lap.index} has hops`)
    for (const hop of lap.hops) {
      assert.ok(hop.trigger?.type, `lap ${lap.index}: every hop names its trigger`)
      assert.equal(
        hop.gate?.actor?.kind,
        'rule',
        `lap ${lap.index}: the auto gate decision is attributed to a rule actor`
      )
      assert.equal(
        hop.outcome?.type,
        'finished',
        `lap ${lap.index}: every hop records how the turn ended`
      )
    }
  }
  assert.ok(
    timeline.stops.some((stop) => /maxFirings/.test(stop.reason ?? '')),
    'the timeline records why the ring stopped'
  )

  const state = await orrery.state()
  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log(
    `hero loop badge verified: live badge, ${stopped.lapCount}/${stopped.lapCap} laps, timeline retells ${timeline.laps.length} laps + stop reason`
  )
}
