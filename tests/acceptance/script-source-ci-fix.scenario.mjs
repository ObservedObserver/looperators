import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'script-source-ci-fix'
export const description =
  'L2 acceptance, half 2 (proposal §L2 验收): a user-authored polling script is registered as a source; its "CI failed" line activates a real fixer whose fix flips the next poll to green — the log reads the whole ride: failed → trigger → fix → green, and the edge goes quiet.'
export const timeoutMs = 480_000

export async function run({ orrery, provider, workDir, log }) {
  // The watched world: a status file the "CI" script polls and the fixer
  // repairs. The script is exactly what a user would write — a loop that
  // checks something and prints one JSON line per check.
  // The world starts GREEN and breaks only after the edge is listening:
  // the failed beat then always carries a fresh dedupeKey (green → failed),
  // so no pre-subscription beat can dedupe the trigger away.
  const statusFile = path.join(workDir, 'service-status.txt')
  fs.writeFileSync(statusFile, 'OK\n')
  const checkScript = path.join(workDir, 'ci-poll.mjs')
  fs.writeFileSync(
    checkScript,
    [
      `import fs from 'node:fs'`,
      `const file = ${JSON.stringify(statusFile)}`,
      `const beat = () => {`,
      `  const raw = fs.readFileSync(file, 'utf8').trim()`,
      `  const status = raw.startsWith('OK') ? 'green' : 'failed'`,
      `  console.log(JSON.stringify({ status, detail: raw, dedupeKey: 'status-' + status }))`,
      `}`,
      `beat()`,
      `setInterval(beat, 3000)`,
      '',
    ].join('\n')
  )

  const fixer = await orrery.createSession({
    ...provider,
    label: 'CI Fixer',
    cwd: workDir,
    // The fix writes a workspace file; the autonomous-repair story needs
    // the auto-edits mode, not a human rubber-stamping each write.
    runtimeSettings: { runtimeMode: 'auto-accept-edits' },
    prompt: 'Reply with exactly: fixer ready.',
  })
  await orrery.waitForIdle(fixer.sessionId)

  const { source } = await orrery.registerExternalSource({
    id: 'src-ci-poll',
    kind: 'script',
    topic: 'ci',
    label: 'CI poll script',
    minIntervalSeconds: 0,
    config: { command: process.execPath, args: [checkScript] },
  })
  const sub = (
    await orrery.authorSubscription({
      label: 'ci-autofix',
      source: { kind: 'external', sourceId: source.id },
      on: { on: 'external', topic: 'ci', match: { status: 'failed' } },
      targetSessionId: fixer.sessionId,
      action: {
        kind: 'deliver+activate',
        note:
          'A CI status event was delivered to your context channel as external-event.md; its detail field describes the breakage. ' +
          'Fix it by overwriting the file service-status.txt in your workspace so its entire content is exactly: OK. ' +
          'Then reply with exactly: fixed. Then stop.',
      },
      gate: 'auto',
      stop: { maxFirings: 2 },
    })
  ).subscription
  log(`autofix edge ${sub.id} listening on external.ci(status=failed)`)

  // The watcher is alive (green fact logged, wakes nobody); NOW break the
  // world the edge is guarding.
  await orrery.waitFor('baseline green beat', async () => {
    const { events } = await orrery.kernelEvents({ type: 'external.ci', limit: 50 })
    const green = events.find((event) => event.payload.status === 'green')
    return green ? { done: true } : { detail: 'no beat yet' }
  }, { timeoutMs: 60_000 })
  fs.writeFileSync(statusFile, 'BROKEN: greeting endpoint returns 500\n')
  log('service broken; waiting for the autofix ride')

  // failed → trigger → fix: the real agent repairs the watched file.
  await orrery.waitFor('fixer activated and done', async () => {
    const state = await orrery.state()
    const current = state.subscriptions?.[sub.id]
    const busy = Object.values(state.sessions).some(
      (session) => session.status === 'running' || session.status === 'pending'
    )
    return current?.firings >= 1 && !busy
      ? { done: true }
      : { detail: `firings=${current?.firings ?? 0}` }
  }, { timeoutMs: 240_000 })
  assert.equal(
    fs.readFileSync(statusFile, 'utf8').trim(),
    'OK',
    'the fixer actually repaired the watched file'
  )
  log('fixer repaired the status file')

  // The failed beat is on the blackboard...
  const { events: rideEvents } = await orrery.kernelEvents({ type: 'external.ci', limit: 200 })
  const failedFact = rideEvents.find((event) => event.payload.status === 'failed')
  assert.ok(failedFact, 'the failed beat is a kernel fact')
  assert.match(failedFact.payload.detail, /BROKEN/)

  // ...and → green: the script itself must observe the fix on its next
  // beat, AFTER the failure, without waking anyone.
  const greenFact = await orrery.waitFor('post-fix green beat', async () => {
    const { events } = await orrery.kernelEvents({ type: 'external.ci', limit: 200 })
    const green = events.find(
      (event) => event.payload.status === 'green' && event.seq > failedFact.seq
    )
    return green ? { done: true, value: green } : { detail: 'still red' }
  }, { timeoutMs: 60_000 })

  const { events } = await orrery.kernelEvents({ limit: 5000 })
  const pending = events.find(
    (event) =>
      event.type === 'activation.pending' &&
      event.payload.subscriptionId === sub.id &&
      event.causeId === failedFact.id
  )
  assert.ok(pending, 'the fix activation chains to the failed fact')
  assert.ok(failedFact.seq < greenFact.seq, 'green follows failed in the log')
  const firingsAfterGreen = events.filter(
    (event) =>
      event.type === 'activated' &&
      event.payload.subscriptionId === sub.id &&
      event.seq > greenFact.seq
  )
  assert.equal(firingsAfterGreen.length, 0, 'a green beat wakes nobody')
  assert.equal(
    (await orrery.state()).subscriptions[sub.id].firings,
    1,
    'exactly one firing for the whole ride'
  )

  // 停: cleanup leaves the graph quiet and the watcher process gone.
  await orrery.stopSubscription(sub.id, { reason: 'scenario cleanup' })
  await orrery.removeExternalSource(source.id, { reason: 'scenario cleanup' })
  const state = await orrery.state()
  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log('script-source CI fix verified: failed → trigger → fix → green → quiet')
}
