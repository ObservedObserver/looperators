import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
process.on('SIGTERM', () => process.exit(143))
emit({
  type: 'assistant',
  session_id: backendSessionId,
  message: { content: [{ type: 'text', text: 'fake response for ' + backendSessionId }] },
})
emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
`

function installFakeClaude(tempRoot) {
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate()
    if (value) {
      return value
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function harness(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  installFakeClaude(tempRoot)
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input = { storageFile }) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }
  const cleanup = () => {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, storageFile, manager, cleanup }
}

async function createIdleSession(runtime, label) {
  const created = await runtime.createSession({
    prompt: `bootstrap ${label}`,
    label,
    cwd: process.cwd(),
  })
  await waitFor(
    `${label} idle`,
    () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
  )
  return created.sessionId
}

function kernelEvents(runtime) {
  return runtime.getKernelEvents({ limit: 5000 }).events
}

function activationsOf(runtime, subscriptionId) {
  return kernelEvents(runtime).filter(
    (event) =>
      event.type === 'activated' && event.payload.subscriptionId === subscriptionId
  )
}

function judgeReport(runtime, judgeSessionId, verdict, extras = {}) {
  return runtime.handleMembraneRequest({
    tool: 'report',
    source: judgeSessionId,
    input: { type: 'verdict', verdict, ...extras },
  })
}

test('a goal sentence compiles into a judge ring that stops itself at done', async () => {
  const { manager, cleanup } = harness('orrery-goal-done-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'Worker')

    const goal = 'until the fake suite is green'
    const created = await runtime.createGoalLoop({
      workerSessionId: worker,
      goal,
      maxLaps: 3,
    })
    const judge = created.judgeSessionId

    // The preset expanded into ordinary facts: a judge session and two
    // typed edges; the goal sentence lives only in prompts and labels.
    const state = runtime.getState()
    assert.equal(state.sessions[judge].label, 'Worker · judge')
    assert.equal(state.sessions[judge].cwd, state.sessions[worker].cwd)
    const check = created.checkSubscription
    const retry = created.retrySubscription
    assert.match(check.id, /^goal-check-/)
    assert.match(retry.id, /^goal-retry-/)
    assert.deepEqual(check.stop, { whenReport: { verdict: 'done' }, maxFirings: 3 })
    assert.deepEqual(retry.stop, { whenReport: { verdict: 'done' }, maxFirings: 3 })
    assert.equal(check.gate, 'auto')
    assert.deepEqual(retry.on, {
      on: 'report',
      match: { type: 'verdict', verdict: 'fail' },
    })
    // Constraint 1: the goal sentence exists ONLY in judge prompts — the
    // check note (the judge's activation prompt) carries it, while the
    // worker retry note and the persisted labels stay goal-free.
    assert.match(check.action.note, new RegExp(goal))
    assert.match(check.action.note, /deterministic, executable checks/)
    assert.doesNotMatch(retry.action.note, new RegExp(goal))
    assert.match(retry.action.note, /verdict and issues/)
    assert.equal(check.label, 'goal check')
    assert.equal(retry.label, 'goal retry')

    // The ring projects immediately with the lap cap on the badge.
    const loop = state.loops.find((candidate) =>
      candidate.subscriptionIds.includes(check.id)
    )
    assert.ok(loop, 'the goal ring projects as a loop view')
    assert.deepEqual(loop.memberSessionIds, [worker, judge].sort())
    assert.equal(loop.lapCap, 3)

    await waitFor('judge idle after bootstrap', () => runtime.getState().sessions[judge]?.status === 'idle')

    // Lap 1: the worker finishes → the judge is activated with the goal note.
    await runtime.resumeSession({ sessionId: worker, message: 'attempt one' })
    await waitFor('judge activated by the check edge', () => activationsOf(runtime, check.id).length >= 1, 15000)
    await waitFor('judge idle after check', () => runtime.getState().sessions[judge]?.status === 'idle')

    // The judge rules fail → the worker is re-activated with the issues.
    await judgeReport(runtime, judge, 'fail', {
      summary: 'suite still red',
      issues: [{ message: 'test A fails' }],
    })
    await waitFor('worker re-activated by the retry edge', () => activationsOf(runtime, retry.id).length >= 1, 15000)
    await waitFor('lap 2 judge activation', () => activationsOf(runtime, check.id).length >= 2, 15000)
    await waitFor('judge idle after lap 2', () => runtime.getState().sessions[judge]?.status === 'idle')

    // The judge rules done → both edges stop deterministically (whenReport
    // observes the edge participants; the judge is on both edges).
    await judgeReport(runtime, judge, 'done', { summary: 'npm test: green' })
    await waitFor(
      'both goal edges stopped at done',
      () =>
        runtime.getState().subscriptions[check.id]?.state === 'stopped' &&
        runtime.getState().subscriptions[retry.id]?.state === 'stopped'
    )

    const stops = kernelEvents(runtime).filter(
      (event) =>
        event.type === 'subscription.stopped' &&
        [check.id, retry.id].includes(event.payload.subscriptionId)
    )
    assert.equal(stops.length, 2)
    for (const stop of stops) {
      assert.match(stop.reason ?? '', /done/, 'the stop explains itself with the verdict')
    }

    // The badge reads the ending; the timeline can replay the laps.
    const stopped = runtime.getState()
    const endedLoop = stopped.loops.find((candidate) => candidate.subscriptionIds.includes(check.id))
    assert.equal(endedLoop.status, 'stopped')
    const { timeline } = runtime.getLoopTimeline({ loopId: endedLoop.loopId })
    assert.ok(timeline.laps.length >= 1, 'the goal ring has readable laps')
    const reports = timeline.laps.flatMap((lap) => lap.hops).flatMap((hop) => hop.reports)
    assert.ok(
      reports.some((report) => report.verdict === 'fail'),
      'the failed lap is readable from the timeline'
    )
  } finally {
    cleanup()
  }
})

test('the lap cap ends a goal loop whose judge never says done', async () => {
  const { manager, cleanup } = harness('orrery-goal-cap-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'Capped Worker')
    const created = await runtime.createGoalLoop({
      workerSessionId: worker,
      goal: 'until an impossible bar is cleared',
      maxLaps: 1,
    })
    const judge = created.judgeSessionId
    const check = created.checkSubscription
    await waitFor('judge idle after bootstrap', () => runtime.getState().sessions[judge]?.status === 'idle')

    await runtime.resumeSession({ sessionId: worker, message: 'attempt' })
    await waitFor('lap 1 judge activation', () => activationsOf(runtime, check.id).length >= 1, 15000)
    await waitFor('judge idle', () => runtime.getState().sessions[judge]?.status === 'idle')

    await judgeReport(runtime, judge, 'fail', { summary: 'still impossible' })
    // The retry edge fires (its own firing 1); the worker finishes; the
    // check edge is now at its cap, so the attempt stops it instead.
    await waitFor(
      'check edge guardrail stop',
      () => runtime.getState().subscriptions[check.id]?.state === 'stopped',
      20000
    )
    const stop = kernelEvents(runtime).find(
      (event) =>
        event.type === 'subscription.stopped' &&
        event.payload.subscriptionId === check.id
    )
    assert.match(stop.reason ?? '', /maxFirings/, 'the guardrail names itself')
    assert.equal(
      activationsOf(runtime, check.id).length,
      1,
      'the judge never runs past the cap'
    )

    // The paired retry edge dies with it: a later fail report must not be
    // able to wake the worker through a ring that can no longer lap.
    await waitFor(
      'paired retry edge stopped with the guardrail',
      () => runtime.getState().subscriptions[created.retrySubscription.id]?.state === 'stopped'
    )
    const pairedStop = kernelEvents(runtime).find(
      (event) =>
        event.type === 'subscription.stopped' &&
        event.payload.subscriptionId === created.retrySubscription.id
    )
    assert.match(pairedStop.reason ?? '', /Goal loop ended/)
    const retryFiringsAtStop = activationsOf(runtime, created.retrySubscription.id).length
    await judgeReport(runtime, judge, 'fail', { summary: 'shouting into the void' })
    await delay(600)
    assert.equal(
      activationsOf(runtime, created.retrySubscription.id).length,
      retryFiringsAtStop,
      'a fail report after the guardrail wakes nobody'
    )
  } finally {
    cleanup()
  }
})

test('manually stopping either goal edge stops its pair too', async () => {
  const { manager, cleanup } = harness('orrery-goal-manual-stop-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'Manually Stopped')
    const created = await runtime.createGoalLoop({
      workerSessionId: worker,
      goal: 'until someone changes their mind',
    })
    const judge = created.judgeSessionId
    await waitFor('judge idle after bootstrap', () => runtime.getState().sessions[judge]?.status === 'idle')

    // A human stops just the check edge from the UI/API path — the retry
    // edge must die with it, or a later fail report would wake the worker
    // through a ring that can no longer lap.
    runtime.stopSubscription({
      subscriptionId: created.checkSubscription.id,
      reason: 'Changed my mind.',
    })
    const subscriptions = runtime.getState().subscriptions
    assert.equal(subscriptions[created.checkSubscription.id].state, 'stopped')
    assert.equal(subscriptions[created.retrySubscription.id].state, 'stopped')

    const pairedStop = kernelEvents(runtime).find(
      (event) =>
        event.type === 'subscription.stopped' &&
        event.payload.subscriptionId === created.retrySubscription.id
    )
    assert.match(pairedStop.reason ?? '', /Goal loop ended/)

    const retryActivations = activationsOf(runtime, created.retrySubscription.id).length
    await judgeReport(runtime, judge, 'fail', { summary: 'too late' })
    await delay(600)
    assert.equal(
      activationsOf(runtime, created.retrySubscription.id).length,
      retryActivations,
      'a fail report after the manual stop wakes nobody'
    )
  } finally {
    cleanup()
  }
})

test('pair coupling requires the compiled shape, not just the id prefix', async () => {
  const { manager, cleanup } = harness('orrery-goal-imposter-')
  try {
    const runtime = manager()
    const a = await createIdleSession(runtime, 'A')
    const b = await createIdleSession(runtime, 'B')
    const c = await createIdleSession(runtime, 'C')

    // User-authored subscriptions squatting on the goal id prefixes, but
    // NOT structurally reciprocal (goal-retry-zz does not point back at A).
    runtime.authorSubscription({
      id: 'goal-check-zz',
      sourceSessionId: a,
      on: { on: 'finished' },
      targetSessionId: b,
      action: { kind: 'deliver' },
      gate: 'auto',
    })
    runtime.authorSubscription({
      id: 'goal-retry-zz',
      sourceSessionId: b,
      on: { on: 'finished' },
      targetSessionId: c,
      action: { kind: 'deliver' },
      gate: 'auto',
    })

    // The squatter must not masquerade as an existing goal loop either:
    // the duplicate guard demands the same reciprocal shape.
    const compiled = await runtime.createGoalLoop({
      workerSessionId: a,
      goal: 'a real ring despite the squatters',
    })
    assert.match(compiled.checkSubscription.id, /^goal-check-/)

    runtime.stopSubscription({ subscriptionId: 'goal-check-zz', reason: 'Just this one.' })
    const subscriptions = runtime.getState().subscriptions
    assert.equal(subscriptions['goal-check-zz'].state, 'stopped')
    assert.equal(
      subscriptions['goal-retry-zz'].state,
      'active',
      'an id-prefix imposter without the reciprocal shape is left alone'
    )
    assert.equal(
      subscriptions[compiled.checkSubscription.id].state,
      'active',
      'the real ring is untouched by the imposter stop'
    )
  } finally {
    cleanup()
  }
})

test('a worker killed during goal loop creation never ends up with an active ring', async () => {
  const { manager, cleanup } = harness('orrery-goal-kill-race-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'Doomed Worker')
    // A kill needs a live run; keep the worker busy while the compile races.
    await runtime.resumeSession({ sessionId: worker, message: 'stay busy' })

    // The kill lands as a microtask while judge creation is still awaiting
    // real async work, i.e. inside the validation gap the recheck guards.
    const compile = runtime.createGoalLoop({
      workerSessionId: worker,
      goal: 'race the reaper',
    })
    const kill = Promise.resolve().then(() => runtime.killSession(worker))
    await assert.rejects(
      () => compile,
      /killed while the goal loop was being created/,
      'the post-creation recheck rejects the compile'
    )
    await kill

    assert.deepEqual(
      Object.keys(runtime.getState().subscriptions ?? {}).filter((id) => id.startsWith('goal-')),
      [],
      'no goal edges exist on the killed worker'
    )
  } finally {
    cleanup()
  }
})

test('goal loop validation rejects bad input before anything is created', async () => {
  const { manager, cleanup } = harness('orrery-goal-validate-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'Validated')

    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: 'nope', goal: 'x' }),
      /Unknown goal loop worker/
    )
    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: worker, goal: '   ' }),
      /non-empty goal/
    )
    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: worker, goal: 'x', maxLaps: 0 }),
      /between 1 and 99/
    )
    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: worker, goal: 'x', maxLaps: 100 }),
      /between 1 and 99/
    )
    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: worker, goal: 'x', gate: 'sometimes' }),
      /gate must be/
    )
    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: worker, goal: 'x', onStop: 'explode' }),
      /onStop must be/,
      'onStop is validated before the judge session exists'
    )

    const sessionsBefore = Object.keys(runtime.getState().sessions).length
    assert.equal(sessionsBefore, 1, 'failed validations created nothing')

    // One active goal loop per worker — including two calls racing through
    // the awaited judge creation (TOCTOU): exactly one compilation wins.
    const race = await Promise.allSettled([
      runtime.createGoalLoop({ workerSessionId: worker, goal: 'first goal' }),
      runtime.createGoalLoop({ workerSessionId: worker, goal: 'racing goal' }),
    ])
    assert.deepEqual(
      race.map((outcome) => outcome.status).sort(),
      ['fulfilled', 'rejected'],
      'concurrent compilations resolve to exactly one ring'
    )
    await assert.rejects(
      () => runtime.createGoalLoop({ workerSessionId: worker, goal: 'second goal' }),
      /already has an active goal loop/
    )
    assert.equal(
      Object.keys(runtime.getState().sessions).length,
      2,
      'the refused duplicates created no second judge'
    )
    assert.equal(
      Object.values(runtime.getState().subscriptions ?? {}).filter((subscription) =>
        subscription.id.startsWith('goal-check-')
      ).length,
      1,
      'exactly one check edge exists after the race'
    )
  } finally {
    cleanup()
  }
})
