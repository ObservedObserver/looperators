import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

// L6 runtime tests: applyTemplate expands into the ordinary verbs
// (author_subscription / create_session / the goal-loop preset), so these
// tests assert what actually lands in state — the compiled truth — with no
// real agent involved. The pure compile shapes live in
// tests/graph-core/templates.test.mjs; the real-agent lap lives in
// tests/acceptance/review-until-clean-template.scenario.mjs.

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const prompt = readArg('-p') ?? ''
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
if (prompt.includes('ORRERY_DELAY')) {
  setInterval(() => {}, 1000)
} else {
  emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
}
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

async function createIdleSession(runtime, label, extra = {}) {
  const created = await runtime.createSession({
    prompt: `bootstrap ${label}`,
    label,
    cwd: process.cwd(),
    ...extra,
  })
  await waitFor(
    `${label} idle`,
    () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
  )
  return created.sessionId
}

test('the built-ins are listed as data and handoff is an IMMEDIATE one-shot — idle source, instant activation', async () => {
  const { manager, cleanup } = harness('orrery-l6-handoff-')
  try {
    const runtime = manager()

    const { templates } = runtime.listTemplates()
    assert.deepEqual(
      templates.map((template) => template.id),
      [
        'handoff',
        'watch-and-summarize',
        'review-until-clean',
        'goal-loop',
        'scheduled-routine',
        'reactive-fixer',
      ]
    )
    assert.ok(templates.every((template) => template.builtin))

    // Both sessions are IDLE: the kernel §8.1 handoff must fire right now,
    // not on the source's next finished turn.
    const builder = await createIdleSession(runtime, 'builder')
    const deployer = await createIdleSession(runtime, 'deployer')
    const subscriptionsBefore = Object.keys(runtime.getState().subscriptions ?? {}).length
    const messagesBefore = runtime.getState().sessions[deployer].messages.length

    const applied = await runtime.applyTemplate({
      templateId: 'handoff',
      params: { source: builder, target: deployer },
    })
    assert.equal(applied.templateId, 'handoff')
    assert.deepEqual(applied.createdSessionIds, [])
    assert.deepEqual(applied.subscriptionIds, [], 'a handoff is a command — nothing standing remains')
    assert.deepEqual(applied.deliveredTo, [deployer])

    // The target was activated immediately (a real turn ran on it) and the
    // delivery rode the ordinary channel with the handoff topic.
    await waitFor(
      'deployer ran its handoff turn',
      () =>
        runtime.getState().sessions[deployer].status === 'idle' &&
        runtime.getState().sessions[deployer].messages.length > messagesBefore
    )
    assert.equal(
      Object.keys(runtime.getState().subscriptions ?? {}).length,
      subscriptionsBefore,
      'no subscription was created'
    )
    const { events } = runtime.getKernelEvents({ limit: 500 })
    const delivered = events.find(
      (event) => event.type === 'delivered' && event.payload?.topic === 'handoff'
    )
    assert.ok(delivered, 'the handoff delivery is a kernel fact with topic handoff')
    const activated = events.find(
      (event) => event.type === 'activated' && event.payload?.sessionId === deployer
    )
    assert.ok(activated, 'the activation is a kernel fact on the target')
  } finally {
    cleanup()
  }
})

test('handoff preflights busy and frozen targets without leaving a partial delivery', async () => {
  const { manager, cleanup } = harness('orrery-l6-handoff-atomic-')
  try {
    const runtime = manager()
    const source = await createIdleSession(runtime, 'source')
    const frozenTarget = await createIdleSession(runtime, 'frozen target')
    const busyTarget = await createIdleSession(runtime, 'busy target')
    runtime.freeze({ target: frozenTarget, reason: 'hold' })
    await runtime.resumeSession({ sessionId: busyTarget, message: 'ORRERY_DELAY' })
    await waitFor(
      'busy handoff target running',
      () => runtime.getState().sessions[busyTarget]?.status === 'running'
    )

    for (const [target, error] of [
      [frozenTarget, /Frozen session cannot be resumed/],
      [busyTarget, /Session is already running/],
    ]) {
      const before = runtime.getKernelEvents({ limit: 500 }).events
      const deliveredBefore = before.filter(
        (event) =>
          event.type === 'delivered' &&
          event.payload?.target === target &&
          event.payload?.topic === 'handoff'
      ).length
      const activatedBefore = before.filter(
        (event) => event.type === 'activated' && event.payload?.sessionId === target
      ).length

      await assert.rejects(
        runtime.applyTemplate({
          templateId: 'handoff',
          params: { source, target },
        }),
        error
      )

      const after = runtime.getKernelEvents({ limit: 500 }).events
      assert.equal(
        after.filter(
          (event) =>
            event.type === 'delivered' &&
            event.payload?.target === target &&
            event.payload?.topic === 'handoff'
        ).length,
        deliveredBefore,
        'failed handoff leaves no unread channel delivery'
      )
      assert.equal(
        after.filter(
          (event) => event.type === 'activated' && event.payload?.sessionId === target
        ).length,
        activatedBefore,
        'failed handoff never activates the target'
      )
    }
  } finally {
    cleanup()
  }
})

test('watch-and-summarize lands a deliver-only edge that never activates the watcher', async () => {
  const { manager, cleanup } = harness('orrery-l6-watch-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'worker')
    const watcher = await createIdleSession(runtime, 'watcher')

    const applied = await runtime.applyTemplate({
      templateId: 'watch-and-summarize',
      params: { source: worker, watcher },
    })
    const subscription = runtime.getState().subscriptions[applied.subscriptionIds[0]]
    assert.equal(subscription.action.kind, 'deliver')
    assert.equal(subscription.action.topic, 'progress')
    assert.equal(subscription.stop, undefined)

    // A finished turn from the worker delivers but must not wake the watcher.
    await runtime.resumeSession({ sessionId: worker, message: 'do one turn' })
    await waitFor(
      'watch edge fired',
      () => runtime.getState().subscriptions[subscription.id]?.firings === 1
    )
    await delay(200)
    assert.equal(runtime.getState().sessions[watcher].status, 'idle')
  } finally {
    cleanup()
  }
})

test('review-until-clean pairs two edges under one suffix with the shared clean stop', async () => {
  const { manager, cleanup } = harness('orrery-l6-review-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'coder')
    const reviewer = await createIdleSession(runtime, 'reviewer')

    const applied = await runtime.applyTemplate({
      templateId: 'review-until-clean',
      params: { coder, reviewer, maxLaps: 3 },
    })
    assert.deepEqual(applied.createdSessionIds, [])
    assert.equal(applied.subscriptionIds.length, 2)

    const state = runtime.getState()
    const pass = state.subscriptions[applied.subscriptionIds[0]]
    const fix = state.subscriptions[applied.subscriptionIds[1]]
    const suffix = pass.id.replace('review-pass-', '')
    assert.equal(fix.id, `review-fix-${suffix}`, 'the pair shares one suffix')

    assert.deepEqual(pass.source, { kind: 'session', sessionId: coder })
    assert.deepEqual(pass.target, { kind: 'session', sessionId: reviewer })
    assert.deepEqual(fix.on, { on: 'report', match: { type: 'verdict', verdict: 'issues' } })
    for (const subscription of [pass, fix]) {
      assert.deepEqual(subscription.stop, { whenReport: { verdict: 'clean' }, maxFirings: 3 })
      assert.equal(subscription.preset, 'template:review-until-clean')
      assert.equal(subscription.state, 'active')
      // The maxFirings guardrail keeps the cycle auto-gated (no master needed).
      assert.equal(subscription.gate, 'auto')
    }
  } finally {
    cleanup()
  }
})

test('an empty reviewer slot creates the reviewer next to the coder (provider, cwd, trust inherited)', async () => {
  const { manager, cleanup } = harness('orrery-l6-review-create-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'coder', {
      runtimeSettings: { runtimeMode: 'auto-accept-edits', model: 'cheap-model-x' },
    })

    const applied = await runtime.applyTemplate({
      templateId: 'review-until-clean',
      params: { coder },
    })
    assert.equal(applied.createdSessionIds.length, 1)
    const reviewerId = applied.createdSessionIds[0]
    const state = runtime.getState()
    const reviewer = state.sessions[reviewerId]
    const coderSession = state.sessions[coder]
    assert.equal(reviewer.label, 'Reviewer')
    assert.equal(reviewer.cwd, coderSession.cwd)
    assert.equal(reviewer.providerKind, coderSession.providerKind)
    assert.equal(reviewer.runtimeSettings?.runtimeMode, 'auto-accept-edits')
    assert.equal(reviewer.runtimeSettings?.model, 'cheap-model-x')

    const pass = state.subscriptions[applied.subscriptionIds[0]]
    const fix = state.subscriptions[applied.subscriptionIds[1]]
    assert.deepEqual(pass.target, { kind: 'session', sessionId: reviewerId })
    assert.deepEqual(fix.source, { kind: 'session', sessionId: reviewerId })
  } finally {
    cleanup()
  }
})

test('the goal-loop template delegates to the L3 preset, duplicate guard included', async () => {
  const { manager, cleanup } = harness('orrery-l6-goal-')
  try {
    const runtime = manager()
    const worker = await createIdleSession(runtime, 'worker')

    const applied = await runtime.applyTemplate({
      templateId: 'goal-loop',
      params: { worker, goal: 'npm test exits 0', maxLaps: 4 },
    })
    assert.ok(applied.judgeSessionId)
    assert.deepEqual(applied.createdSessionIds, [applied.judgeSessionId])
    const [checkId, retryId] = applied.subscriptionIds
    assert.match(checkId, /^goal-check-/)
    assert.match(retryId, /^goal-retry-/)
    const check = runtime.getState().subscriptions[checkId]
    assert.deepEqual(check.stop, { whenReport: { verdict: 'done' }, maxFirings: 4 })
    // Even the delegated preset keeps the template provenance tag.
    assert.equal(check.preset, 'template:goal-loop')

    await assert.rejects(
      runtime.applyTemplate({
        templateId: 'goal-loop',
        params: { worker, goal: 'another goal' },
      }),
      /active goal loop/
    )
  } finally {
    cleanup()
  }
})

test('scheduled-routine and reactive-fixer land timer and external edges with their guardrails', async () => {
  const { manager, cleanup } = harness('orrery-l6-timer-external-')
  try {
    const runtime = manager()
    const target = await createIdleSession(runtime, 'target')

    const routine = await runtime.applyTemplate({
      templateId: 'scheduled-routine',
      params: {
        target,
        schedule: { everySeconds: 900 },
        instruction: 'Summarize new issues since the last run.',
      },
    })
    const routineSub = runtime.getState().subscriptions[routine.subscriptionIds[0]]
    assert.deepEqual(routineSub.source, { kind: 'timer' })
    assert.deepEqual(routineSub.on, { on: 'schedule', everySeconds: 900 })
    assert.equal(routineSub.action.note, 'Summarize new issues since the last run.')

    runtime.registerExternalSource({ id: 'src-ci', kind: 'manual', topic: 'ci' })
    const fixer = await runtime.applyTemplate({
      templateId: 'reactive-fixer',
      params: { source: 'src-ci', target, instruction: 'Fix the failure.' },
    })
    const fixerSub = runtime.getState().subscriptions[fixer.subscriptionIds[0]]
    assert.deepEqual(fixerSub.source, { kind: 'external', sourceId: 'src-ci' })
    assert.deepEqual(fixerSub.stop, { maxFirings: 3 })

    // A removed source cannot anchor a fixer.
    runtime.registerExternalSource({ id: 'src-gone', kind: 'manual', topic: 'gone' })
    runtime.removeExternalSource({ sourceId: 'src-gone' })
    await assert.rejects(
      runtime.applyTemplate({
        templateId: 'reactive-fixer',
        params: { source: 'src-gone', target, instruction: 'x' },
      }),
      /active external source/
    )
  } finally {
    cleanup()
  }
})

test('slot validation fails BEFORE anything is created — no orphan sessions, no half rings', async () => {
  const { manager, cleanup } = harness('orrery-l6-atomic-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'coder')
    const before = runtime.getState()
    const sessionCount = Object.keys(before.sessions).length
    const subscriptionCount = Object.keys(before.subscriptions ?? {}).length

    await assert.rejects(
      runtime.applyTemplate({
        templateId: 'review-until-clean',
        params: { coder: 'no-such-session' },
      }),
      /existing session/
    )
    await assert.rejects(
      runtime.applyTemplate({
        templateId: 'handoff',
        params: { source: coder, target: coder, bogus: 'x' },
      }),
      /no slot "bogus"/
    )
    await assert.rejects(
      runtime.applyTemplate({ templateId: 'no-such-template', params: {} }),
      /Unknown template/
    )
    await assert.rejects(
      runtime.applyTemplate({
        templateId: 'scheduled-routine',
        params: { target: coder, schedule: { everySeconds: 900, dailyAt: '07:00' }, instruction: 'x' },
      }),
      /exactly one of everySeconds or dailyAt/
    )

    const after = runtime.getState()
    assert.equal(Object.keys(after.sessions).length, sessionCount, 'no orphan sessions')
    assert.equal(
      Object.keys(after.subscriptions ?? {}).length,
      subscriptionCount,
      'no half-authored subscriptions'
    )
  } finally {
    cleanup()
  }
})

test('the review pair lives and dies together: stopping one edge stops both (any stop path)', async () => {
  const { manager, cleanup } = harness('orrery-l6-review-pair-stop-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'coder')
    const reviewer = await createIdleSession(runtime, 'reviewer')
    const applied = await runtime.applyTemplate({
      templateId: 'review-until-clean',
      params: { coder, reviewer, maxLaps: 2 },
    })
    const [passId, fixId] = applied.subscriptionIds

    // Stopping the REVERSE edge must take the forward edge with it — the
    // failed-run artifact showed a cap-stopped review-pass leaving
    // review-fix lingering active while the loop badge already said
    // stopped. All stop paths (cap, whenReport, manual, kill sweep) funnel
    // through the same verb, so a manual stop pins the pairing.
    runtime.stopSubscription({ subscriptionId: fixId, reason: 'testing the pair' })

    const state = runtime.getState()
    assert.equal(state.subscriptions[fixId].state, 'stopped')
    assert.equal(state.subscriptions[passId].state, 'stopped', 'the paired edge stopped too')
    const { events } = runtime.getKernelEvents({ limit: 500 })
    const pairedStop = events.find(
      (event) =>
        event.type === 'subscription.stopped' &&
        event.payload?.subscriptionId === passId
    )
    assert.match(pairedStop.reason ?? '', /Review loop ended/)

    // And the ring projection agrees: no half-stopped zombie.
    const ring = (state.loops ?? []).find((loop) => loop.memberSessionIds.includes(coder))
    if (ring) {
      assert.equal(ring.status, 'stopped')
    }
  } finally {
    cleanup()
  }
})

test('a coder killed during template apply never ends up with a ring or an orphan reviewer', async () => {
  const { manager, cleanup } = harness('orrery-l6-kill-race-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Doomed Coder')
    // A kill needs a live run; keep the coder busy while the apply races.
    await runtime.resumeSession({ sessionId: coder, message: 'stay busy' })

    // The kill lands as a microtask while reviewer creation is still
    // awaiting real async work — inside the gap between applyTemplate's
    // pre-validation and its author steps.
    const apply = runtime.applyTemplate({
      templateId: 'review-until-clean',
      params: { coder },
    })
    const kill = Promise.resolve().then(() => runtime.killSession(coder))
    await assert.rejects(
      () => apply,
      /killed while the template was being applied/,
      'the per-author liveness recheck rejects the apply'
    )
    await kill

    const state = runtime.getState()
    const activeReviewEdges = Object.values(state.subscriptions ?? {}).filter(
      (subscription) =>
        subscription.id.startsWith('review-') && subscription.state === 'active'
    )
    assert.deepEqual(activeReviewEdges, [], 'no active review edges on the killed coder')
    const reviewer = Object.values(state.sessions).find(
      (session) => session.label === 'Reviewer'
    )
    assert.ok(reviewer, 'the reviewer was created inside the race window')
    assert.equal(reviewer.status, 'killed', 'the orphan reviewer was cleaned up')
  } finally {
    cleanup()
  }
})

test('save → list → apply: a canvas ring becomes a template and rebinds to new sessions', async () => {
  const { manager, cleanup } = harness('orrery-l6-save-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder A')
    const reviewer = await createIdleSession(runtime, 'Reviewer A')
    const ring = await runtime.applyTemplate({
      templateId: 'review-until-clean',
      params: { coder, reviewer, maxLaps: 2 },
    })

    const saved = runtime.saveTemplate({
      name: 'our review flow',
      tagline: 'the team ring',
      subscriptionIds: ring.subscriptionIds,
    })
    assert.match(saved.template.id, /^tpl-[0-9a-f]{8}$/)
    assert.deepEqual(
      saved.template.slots.map((slot) => [slot.key, slot.label, slot.kind]),
      [
        ['session-1', 'Coder A', 'session'],
        ['session-2', 'Reviewer A', 'session'],
      ]
    )

    const { templates } = runtime.listTemplates()
    const descriptor = templates.find((template) => template.id === saved.template.id)
    assert.ok(descriptor, 'the saved template is listed')
    assert.equal(descriptor.builtin, false)
    assert.equal(descriptor.tagline, 'the team ring')

    const newCoder = await createIdleSession(runtime, 'Coder B')
    const newReviewer = await createIdleSession(runtime, 'Reviewer B')
    const applied = await runtime.applyTemplate({
      templateId: saved.template.id,
      params: { 'session-1': newCoder, 'session-2': newReviewer },
    })
    assert.equal(applied.subscriptionIds.length, 2)
    const state = runtime.getState()
    const pass = state.subscriptions[applied.subscriptionIds[0]]
    const fix = state.subscriptions[applied.subscriptionIds[1]]
    // The reapplied ring pairs up like the original: semantic prefixes
    // under one fresh shared suffix, not anonymous sub-* edges.
    const newSuffix = pass.id.replace('review-pass-', '')
    assert.match(pass.id, /^review-pass-[0-9a-f]{8}$/)
    assert.equal(fix.id, `review-fix-${newSuffix}`)
    assert.deepEqual(pass.source, { kind: 'session', sessionId: newCoder })
    assert.deepEqual(pass.target, { kind: 'session', sessionId: newReviewer })
    assert.deepEqual(fix.target, { kind: 'session', sessionId: newCoder })
    assert.deepEqual(pass.stop, { whenReport: { verdict: 'clean' }, maxFirings: 2 })
    assert.equal(pass.preset, `template:${saved.template.id}`)

    // A missing rebinding is caught by slot validation, not authored halfway.
    await assert.rejects(
      runtime.applyTemplate({
        templateId: saved.template.id,
        params: { 'session-1': newCoder },
      }),
      /missing required slot/
    )

    // Two same-prefix edges in one saved template must not overwrite each
    // other on apply: the second falls back to a runtime-generated id.
    const w1 = await runtime.applyTemplate({
      templateId: 'watch-and-summarize',
      params: { source: coder, watcher: reviewer },
    })
    const w2 = await runtime.applyTemplate({
      templateId: 'watch-and-summarize',
      params: { source: coder, watcher: newReviewer },
    })
    const doubled = runtime.saveTemplate({
      name: 'double watch',
      subscriptionIds: [...w1.subscriptionIds, ...w2.subscriptionIds],
    })
    const reapplied = await runtime.applyTemplate({
      templateId: doubled.template.id,
      params: {
        'session-1': newCoder,
        'session-2': coder,
        'session-3': reviewer,
      },
    })
    assert.equal(reapplied.subscriptionIds.length, 2)
    assert.notEqual(reapplied.subscriptionIds[0], reapplied.subscriptionIds[1])
    const reappliedState = runtime.getState()
    for (const id of reapplied.subscriptionIds) {
      assert.equal(reappliedState.subscriptions[id].state, 'active')
    }
  } finally {
    cleanup()
  }
})

test('saved templates survive a restart and removeTemplate really removes', async () => {
  const { manager, cleanup } = harness('orrery-l6-persist-')
  try {
    const runtime = manager()
    const a = await createIdleSession(runtime, 'a')
    const b = await createIdleSession(runtime, 'b')
    const ring = await runtime.applyTemplate({
      templateId: 'watch-and-summarize',
      params: { source: a, watcher: b },
    })
    // The plan's kernel-purity invariant, pinned: saving and removing
    // templates appends NOTHING to the kernel log — templates are
    // runtime-plane config, and only the snapshot carries them.
    const seqBeforeSave = runtime.getKernelEvents({ limit: 1 }).latestSeq
    const saved = runtime.saveTemplate({
      name: 'my watch',
      subscriptionIds: ring.subscriptionIds,
    })
    assert.equal(
      runtime.getKernelEvents({ limit: 1 }).latestSeq,
      seqBeforeSave,
      'saveTemplate appends no kernel facts'
    )
    const allTypes = runtime
      .getKernelEvents({ limit: 5000 })
      .events.map((event) => event.type)
    assert.equal(
      allTypes.some((type) => /template/i.test(type)),
      false,
      'no template-shaped event type ever enters the log'
    )
    runtime.killAll()

    const reloaded = manager()
    const listed = reloaded
      .listTemplates()
      .templates.find((template) => template.id === saved.template.id)
    assert.ok(listed, 'the template rode the snapshot across the restart')
    assert.ok(
      reloaded.getState().templates?.[saved.template.id],
      'getState carries saved templates (they are config, not secrets)'
    )

    const seqBeforeRemove = reloaded.getKernelEvents({ limit: 1 }).latestSeq
    reloaded.removeTemplate({ templateId: saved.template.id })
    assert.equal(
      reloaded.getKernelEvents({ limit: 1 }).latestSeq,
      seqBeforeRemove,
      'removeTemplate appends no kernel facts'
    )
    assert.equal(reloaded.getState().templates?.[saved.template.id], undefined)
    assert.equal(
      reloaded.listTemplates().templates.some((template) => template.id === saved.template.id),
      false
    )
    assert.throws(
      () => reloaded.removeTemplate({ templateId: saved.template.id }),
      /Unknown template/
    )
    assert.throws(
      () => reloaded.saveTemplate({ name: 'empty', subscriptionIds: [] }),
      /at least one subscription/
    )
  } finally {
    cleanup()
  }
})
