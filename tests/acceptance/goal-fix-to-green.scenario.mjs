import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'goal-fix-to-green'
export const description =
  'L3 acceptance (proposal §L3 验收): on a real repo, a "fix until npm test is green, at most 4 laps" goal loop — lap 1 the judge runs the suite and reports fail with the failing cases, the retry edge wakes the coder with the issues, lap 2 the judge reports done and the ring stops itself; the scenario then runs npm test deterministically to confirm green. The judge reports through the membrane, which is mounted for the Claude Agent SDK (MCP handoff) and Codex (per-thread config.mcp_servers) alike — runs under either --provider.'
export const timeoutMs = 900_000

export async function run({ orrery, provider, workDir, log }) {
  const providerInstanceId =
    provider.providerKind === 'codex' ? 'default-codex' : provider.providerKind === 'claude-code' ? 'default-claude-sdk' : 'claude-code'
  // A real, dependency-free repo whose suite fails for one honest reason.
  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify(
      { name: 'acceptance-goal-repo', private: true, scripts: { test: 'node --test' } },
      null,
      2
    )
  )
  fs.writeFileSync(
    path.join(workDir, 'math.js'),
    'export function add(left, right) {\n  return left - right;\n}\n'
  )
  fs.writeFileSync(
    path.join(workDir, 'math.test.js'),
    [
      "import assert from 'node:assert/strict'",
      "import test from 'node:test'",
      "import { add } from './math.js'",
      '',
      "test('add sums its operands', () => {",
      '  assert.equal(add(2, 3), 5)',
      '})',
      '',
    ].join('\n')
  )

  // P4 cold start: one product command creates Worker + Judge, installs both
  // relationships, and only then starts the Worker.
  const compiled = await orrery.startGoalWorkflow({
    worker: {
      kind: 'new',
      ...provider,
      providerInstanceId,
      label: 'Goal Coder',
      prompt: 'Reply with exactly: starting work now. Do not change any files yet. Then stop.',
      cwd: workDir,
      workMode: 'local',
      runtimeSettings: { runtimeMode: 'full-access' },
    },
    goal: 'Running `npm test` in this repository exits with code 0 (the whole test suite passes).',
    maxLaps: 4,
  })
  const worker = { sessionId: compiled.workerSessionId }
  const compiledState = await orrery.state()
  const [checkId, retryId] = compiled.subscriptionIds
  const check = compiledState.subscriptions[checkId]
  const retry = compiledState.subscriptions[retryId]
  assert.equal(check.stop.whenReport.verdict, 'done')
  assert.equal(check.stop.maxFirings, 4)
  log(`goal loop compiled: judge ${compiled.judgeSessionId}, edges ${check.id} / ${retry.id}`)

  // The compiled pair projects as a ring with the lap cap on its badge.
  const loops = (await orrery.state()).loops ?? []
  const goalLoop = loops.find((loop) =>
    loop.memberSessionIds.includes(worker.sessionId)
  )
  assert.ok(goalLoop, 'the goal pair projects as a loop')
  assert.equal(goalLoop.lapCap, 4)

  const failReport = await orrery.waitForReport(
    { verdict: 'fail' },
    { timeoutMs: 420_000 }
  )
  assert.equal(
    failReport.from,
    compiled.judgeSessionId,
    'lap 1: the fail verdict comes from the judge'
  )
  log('lap 1: judge reported fail (red suite caught)')

  // The retry edge wakes the coder with the issues; the coder fixes; the
  // judge re-checks and reports done; the ring stops itself.
  const doneReport = await orrery.waitForReport(
    { verdict: 'done' },
    { timeoutMs: 600_000 }
  )
  assert.equal(
    doneReport.from,
    compiled.judgeSessionId,
    'the done verdict comes from the judge'
  )
  log('judge reported done')

  await orrery.waitFor('goal edges stop together', async () => {
    const state = await orrery.state()
    const checkState = state.subscriptions?.[check.id]?.state
    const retryState = state.subscriptions?.[retry.id]?.state
    return checkState === 'stopped' && retryState === 'stopped'
      ? { done: true }
      : { detail: `check=${checkState} retry=${retryState}` }
  })

  // Settle every session before the deterministic re-check.
  for (const session of Object.values((await orrery.state()).sessions)) {
    if (session.status === 'running' || session.status === 'pending') {
      await orrery.waitForIdle(session.sessionId)
    }
  }

  // Events are truth, but green is greener: the scenario runs the suite
  // itself — the goal was met in the actual repository.
  execFileSync('npm', ['test'], { cwd: workDir, stdio: 'pipe' })
  log('npm test exits 0 — the repo is actually green')

  const state = await orrery.state()
  const ringAfter = (state.loops ?? []).find((loop) =>
    loop.memberSessionIds.includes(worker.sessionId)
  )
  assert.equal(ringAfter?.status, 'stopped', 'the goal ring reads as stopped on the canvas')
  assert.ok(
    ringAfter.lapCount <= 4,
    `the loop stayed within its lap cap, took ${ringAfter.lapCount}`
  )

  // The per-lap timeline retells the ride: a fail lap, then the done lap.
  const { timeline } = await orrery.getLoopTimeline(ringAfter.loopId)
  const verdicts = timeline.laps.flatMap((lap) =>
    lap.hops.flatMap((hop) => hop.reports.map((report) => report.verdict))
  )
  assert.ok(verdicts.includes('fail'), 'the timeline shows the earned fail lap')
  assert.ok(verdicts.includes('done'), 'the timeline shows the done lap')

  // Kernel-log evidence: the stop chains to the done verdict.
  const { events } = await orrery.kernelEvents({ limit: 5000 })
  const doneEvent = events
    .filter((event) => event.type === 'report.received' && event.payload.verdict === 'done')
    .at(-1)
  const checkStopped = events.find(
    (event) =>
      event.type === 'subscription.stopped' &&
      event.payload.subscriptionId === check.id
  )
  assert.equal(
    checkStopped.causeId,
    doneEvent.id,
    'the check edge stop chains to the done verdict'
  )

  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log(
    `goal loop verified: fail → fix → done in ${ringAfter.lapCount} lap(s), suite deterministically green`
  )
}
