import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'review-until-clean-template'
export const description =
  'L6 acceptance (proposal §L6 验收): a Review-until-clean ring is built ENTIRELY through the template library — applyTemplate fills two slots (coder; reviewer left empty so the runtime creates one) and ready-made subscriptions land with the clean stop and lap cap. Then the ring truly turns on real agents: the coder ships step 1 of a two-step change, the reviewer reads the work against SPEC.md and reports issues through the membrane (earned, not scripted), the retry edge wakes the coder with exactly those issues, the fix lap ends with verdict clean and the ring stops itself. The reviewer reports via the membrane, so run with a provider that mounts it (claude providers today; codex once its membrane wiring lands).'
export const timeoutMs = 900_000

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=orrery-acceptance', '-c', 'user.email=acceptance@orrery.local', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

export async function run({ orrery, provider, workDir, log }) {
  // A real, dependency-free workspace: a one-function module and the spec
  // it currently violates in three concrete ways (prefix, upper case, the
  // trailing exclamation mark).
  fs.writeFileSync(
    path.join(workDir, 'SPEC.md'),
    [
      '# greet.js spec',
      '',
      "greet(name) must return exactly: `Hello, <NAME>!`",
      '- The prefix is "Hello, " — the word Hello, a comma, one space.',
      '- `<NAME>` is the name argument converted to UPPER CASE.',
      '- The string ends with exactly one exclamation mark.',
      '',
      "Example: greet('Ada') === 'Hello, ADA!'",
      '',
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(workDir, 'greet.js'),
    "export function greet(name) {\n  return 'Hi ' + name;\n}\n"
  )
  // A real git baseline: the review-pass delivery bundles the workspace
  // diff, and outside a work tree that bundle is only a git error — the
  // reviewer would (rightly) refuse to certify work it cannot see.
  git(workDir, 'init', '-b', 'main')
  git(workDir, 'add', '.')
  git(workDir, 'commit', '-m', 'baseline: greet.js violates SPEC.md')

  const coder = await orrery.createSession({
    ...provider,
    label: 'Template Coder',
    cwd: workDir,
    // The coder edits greet.js and the reviewer reads it; the reviewer is
    // created BY the template and inherits these settings (trust level,
    // model, workspace) — full autonomy in an ISOLATED temp workspace.
    runtimeSettings: { runtimeMode: 'full-access' },
    prompt: 'Reply with exactly: coder ready.',
  })
  await orrery.waitForIdle(coder.sessionId)

  // The whole L6 promise in two calls: the catalog is data, and one apply
  // with two filled slots lands the ready-made ring.
  const { templates } = await orrery.listTemplates()
  const descriptor = templates.find((template) => template.id === 'review-until-clean')
  assert.ok(descriptor?.builtin, 'the review template is in the built-in catalog')
  assert.ok(
    descriptor.slots.some((slot) => slot.key === 'reviewer' && slot.required === false),
    'the reviewer slot is optional — leaving it empty is the ten-second path'
  )

  const applied = await orrery.applyTemplate({
    templateId: 'review-until-clean',
    params: { coder: coder.sessionId, maxLaps: 4 },
  })
  assert.equal(applied.createdSessionIds.length, 1, 'the template created the reviewer')
  const reviewerId = applied.createdSessionIds[0]
  assert.equal(applied.subscriptionIds.length, 2)
  const [passId, fixId] = applied.subscriptionIds
  const suffix = passId.replace('review-pass-', '')
  assert.equal(fixId, `review-fix-${suffix}`, 'the pair shares one suffix')
  log(`template applied: reviewer ${reviewerId}, edges ${passId} / ${fixId}`)

  const state0 = await orrery.state()
  const pass = state0.subscriptions[passId]
  const fix = state0.subscriptions[fixId]
  assert.deepEqual(pass.stop, { whenReport: { verdict: 'clean' }, maxFirings: 4 })
  assert.deepEqual(fix.stop, { whenReport: { verdict: 'clean' }, maxFirings: 4 })
  assert.deepEqual(fix.on, { on: 'report', match: { type: 'verdict', verdict: 'issues' } })
  assert.equal(state0.sessions[reviewerId].cwd, workDir, 'the reviewer works in the coder workspace')

  // The compiled pair projects as a ring with the lap cap on its badge.
  const ring = (state0.loops ?? []).find((loop) => loop.memberSessionIds.includes(coder.sessionId))
  assert.ok(ring, 'the template ring projects as a loop')
  assert.equal(ring.lapCap, 4)
  assert.ok(ring.memberSessionIds.includes(reviewerId))
  await orrery.waitForIdle(reviewerId)

  // Lap 1 with honestly incomplete work: the coder ships step 1 of a
  // two-step change, so the diff the reviewer reads truly violates the
  // spec — the issues verdict is EARNED by reading real files, not staged.
  await orrery.resumeSession(coder.sessionId, {
    message: [
      'Step 1 of a two-step refactor: in greet.js, change the greeting word from Hi to Hello.',
      'Make ONLY this change in this turn — the remaining spec work in SPEC.md is scheduled separately. Do not touch anything else.',
      'Then reply with one line: step 1 done, SPEC.md defines the remaining requirements. And stop.',
    ].join('\n'),
  })

  const issuesReport = await orrery.waitForReport(
    { verdict: 'issues' },
    { timeoutMs: 420_000 }
  )
  assert.equal(
    issuesReport.from,
    reviewerId,
    'lap 1: the issues verdict comes from the template-created reviewer'
  )
  log('lap 1: reviewer reported issues (spec violations caught in the real diff)')

  // The retry edge wakes the coder with exactly those issues; the fix lap
  // ends with the reviewer reporting clean and the ring stopping itself.
  // Fail FAST if the ring caps out instead: once both edges are stopped
  // without a clean verdict, no future lap can produce one — waiting the
  // full timeout would only mask the failure mode.
  const cleanReport = await orrery.waitFor(
    'clean verdict before the ring caps out',
    async () => {
      const state = await orrery.state()
      const clean = (state.reports ?? []).find(
        (report) => report.payload?.verdict === 'clean' && report.from === reviewerId
      )
      if (clean) {
        return { done: true, value: clean }
      }
      const passState = state.subscriptions[passId]?.state
      const fixState = state.subscriptions[fixId]?.state
      if (passState === 'stopped' && fixState === 'stopped') {
        throw new Error(
          'the ring stopped (lap cap reached) without ever reporting clean'
        )
      }
      return {
        detail: `pass=${passState} fix=${fixState}, ${(state.reports ?? []).length} reports`,
      }
    },
    { timeoutMs: 600_000 }
  )
  assert.equal(cleanReport.from, reviewerId, 'the clean verdict comes from the reviewer')
  log('reviewer reported clean')

  await orrery.waitFor('review edges stop together', async () => {
    const state = await orrery.state()
    const passState = state.subscriptions[passId]?.state
    const fixState = state.subscriptions[fixId]?.state
    return passState === 'stopped' && fixState === 'stopped'
      ? { done: true }
      : { detail: `pass=${passState} fix=${fixState}` }
  })

  // Settle every session before the deterministic re-check.
  for (const session of Object.values((await orrery.state()).sessions)) {
    if (session.status === 'running' || session.status === 'pending') {
      await orrery.waitForIdle(session.sessionId)
    }
  }

  // Events are truth, but the spec is the spec: a deterministic check
  // (written only now, so no agent could lean on it during the laps)
  // proves the workspace really converged.
  fs.writeFileSync(
    path.join(workDir, 'check.mjs'),
    [
      "import assert from 'node:assert/strict'",
      "import { greet } from './greet.js'",
      "assert.equal(greet('Ada'), 'Hello, ADA!')",
      "console.log('spec check passed')",
      '',
    ].join('\n')
  )
  execFileSync('node', ['check.mjs'], { cwd: workDir, stdio: 'pipe' })
  log('deterministic spec check passed — greet() really matches SPEC.md')

  const state = await orrery.state()
  const ringAfter = (state.loops ?? []).find((loop) =>
    loop.memberSessionIds.includes(coder.sessionId)
  )
  assert.equal(ringAfter?.status, 'stopped', 'the ring reads as stopped on the canvas')
  assert.ok(
    ringAfter.lapCount <= 4,
    `the loop stayed within its lap cap, took ${ringAfter.lapCount}`
  )

  // The per-lap timeline retells the ride: an issues lap, then the clean lap.
  const { timeline } = await orrery.getLoopTimeline(ringAfter.loopId)
  const verdicts = timeline.laps.flatMap((lap) =>
    lap.hops.flatMap((hop) => hop.reports.map((report) => report.verdict))
  )
  assert.ok(verdicts.includes('issues'), 'the timeline shows the earned issues lap')
  assert.ok(verdicts.includes('clean'), 'the timeline shows the clean lap')

  // Kernel-log evidence: the stop chains to the clean verdict.
  const { events } = await orrery.kernelEvents({ limit: 5000 })
  const cleanEvent = events
    .filter((event) => event.type === 'report.received' && event.payload.verdict === 'clean')
    .at(-1)
  const passStopped = events.find(
    (event) =>
      event.type === 'subscription.stopped' && event.payload.subscriptionId === passId
  )
  assert.equal(
    passStopped.causeId,
    cleanEvent.id,
    'the review-pass stop chains to the clean verdict'
  )

  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log(
    `template ring verified: template → issues → fix → clean in ${ringAfter.lapCount} lap(s), spec deterministically met`
  )
}
