import assert from 'node:assert/strict'
import test from 'node:test'

import {
  builtinTemplates,
  builtinTemplateById,
  compileBuiltinTemplate,
  compileSavedTemplate,
  defaultReactiveFixerMaxFirings,
  defaultReviewMaxLaps,
  parameterizeSubscriptions,
  templateDescriptors,
  validateSlotParams,
} from '../../dist-electron/shared/templates.js'

// ---- registry shape ----

test('the six proposal templates are registered, in the proposal order', () => {
  assert.deepEqual(
    builtinTemplates.map((template) => template.id),
    [
      'handoff',
      'watch-and-summarize',
      'review-until-clean',
      'goal-loop',
      'scheduled-routine',
      'reactive-fixer',
    ]
  )
  for (const template of builtinTemplates) {
    assert.equal(template.builtin, true)
    assert.ok(template.name.length > 0)
    assert.ok(template.tagline.length > 0)
    assert.ok(template.handsOff.length > 0)
    assert.ok(template.slots.length > 0, `${template.id} declares slots`)
  }
})

// ---- handoff ----

test('handoff compiles to a one-shot command step — no subscription, kernel doc §8.1', () => {
  const plan = compileBuiltinTemplate('handoff', { source: 's-a', target: 's-b' })
  assert.equal(plan.steps.length, 1)
  const step = plan.steps[0]
  assert.equal(step.kind, 'handoff', 'a handoff is a command, not a standing relation')
  assert.deepEqual(step.source, { session: 's-a' })
  assert.deepEqual(step.target, { session: 's-b' })
  assert.equal(step.topic, 'handoff')
  assert.match(step.note, /Handoff/)
})

test('handoff prefers the caller note over the default', () => {
  const plan = compileBuiltinTemplate('handoff', {
    source: 's-a',
    target: 's-b',
    note: 'Deploy what the builder produced.',
  })
  assert.equal(plan.steps[0].note, 'Deploy what the builder produced.')
})

// ---- watch & summarize ----

test('watch-and-summarize compiles to a deliver-only edge (no stop, no activation)', () => {
  const plan = compileBuiltinTemplate('watch-and-summarize', {
    source: 's-a',
    watcher: 's-w',
  })
  const step = plan.steps[0]
  assert.equal(step.input.action.kind, 'deliver')
  assert.equal(step.input.action.topic, 'progress')
  assert.equal(step.input.stop, undefined)
  assert.deepEqual(step.input.target, { session: 's-w' })
})

// ---- review until clean ----

test('review-until-clean with a reviewer compiles to a paired ring, both edges sharing the clean stop', () => {
  const plan = compileBuiltinTemplate('review-until-clean', {
    coder: 's-coder',
    reviewer: 's-reviewer',
  })
  assert.equal(plan.steps.length, 2)
  const [pass, fix] = plan.steps
  assert.equal(pass.input.idPrefix, 'review-pass')
  assert.deepEqual(pass.input.source, { session: 's-coder' })
  assert.deepEqual(pass.input.target, { session: 's-reviewer' })
  assert.deepEqual(pass.input.on, { on: 'finished' })
  assert.match(pass.input.action.note, /verdict/)

  assert.equal(fix.input.idPrefix, 'review-fix')
  assert.deepEqual(fix.input.on, {
    on: 'report',
    match: { type: 'verdict', verdict: 'issues' },
  })
  assert.deepEqual(fix.input.target, { session: 's-coder' })

  const expectedStop = {
    whenReport: { verdict: 'clean' },
    maxFirings: defaultReviewMaxLaps,
  }
  assert.deepEqual(pass.input.stop, expectedStop)
  assert.deepEqual(fix.input.stop, expectedStop)
})

test('review-until-clean with an empty reviewer slot plans a created reviewer bound by ref', () => {
  const plan = compileBuiltinTemplate('review-until-clean', {
    coder: 's-coder',
    maxLaps: '3',
  })
  assert.equal(plan.steps.length, 3)
  const [create, pass, fix] = plan.steps
  assert.equal(create.kind, 'create-session')
  assert.equal(create.ref, 'reviewer')
  assert.equal(create.inheritFromSessionId, 's-coder')
  assert.match(create.prompt, /mcp__orrery_membrane__report/)
  assert.deepEqual(pass.input.target, { ref: 'reviewer' })
  assert.deepEqual(fix.input.source, { ref: 'reviewer' })
  assert.equal(pass.input.stop.maxFirings, 3)
  assert.equal(fix.input.stop.maxFirings, 3)
})

// ---- goal loop ----

test('goal-loop compiles to a delegation step (the L3 preset owns the ring)', () => {
  const plan = compileBuiltinTemplate('goal-loop', {
    worker: 's-w',
    goal: 'npm test exits 0',
    maxLaps: 4,
  })
  assert.deepEqual(plan.steps, [
    {
      kind: 'goal-loop',
      input: { workerSessionId: 's-w', goal: 'npm test exits 0', maxLaps: 4 },
    },
  ])
})

test('goal-loop requires the goal sentence', () => {
  assert.throws(
    () => compileBuiltinTemplate('goal-loop', { worker: 's-w' }),
    /missing required slot/
  )
})

// ---- scheduled routine ----

test('scheduled-routine compiles an interval timer edge with the instruction as note', () => {
  const plan = compileBuiltinTemplate('scheduled-routine', {
    target: 's-t',
    schedule: { everySeconds: 900 },
    instruction: 'Summarize new issues.',
  })
  const step = plan.steps[0]
  assert.deepEqual(step.input.source, { timer: true })
  assert.deepEqual(step.input.on, { on: 'schedule', everySeconds: 900 })
  assert.equal(step.input.action.kind, 'deliver+activate')
  assert.equal(step.input.action.note, 'Summarize new issues.')
})

test('scheduled-routine accepts dailyAt and rejects ambiguous schedules', () => {
  const plan = compileBuiltinTemplate('scheduled-routine', {
    target: 's-t',
    schedule: { dailyAt: '07:30' },
    instruction: 'Morning report.',
  })
  assert.deepEqual(plan.steps[0].input.on, { on: 'schedule', dailyAt: '07:30' })

  assert.throws(
    () =>
      compileBuiltinTemplate('scheduled-routine', {
        target: 's-t',
        schedule: { everySeconds: 900, dailyAt: '07:30' },
        instruction: 'x',
      }),
    /exactly one of everySeconds or dailyAt/
  )
  assert.throws(
    () =>
      compileBuiltinTemplate('scheduled-routine', {
        target: 's-t',
        schedule: {},
        instruction: 'x',
      }),
    /exactly one of everySeconds or dailyAt/
  )
})

test('scheduled-routine rejects malformed schedule values at compile time and normalizes dailyAt', () => {
  const compile = (schedule) =>
    compileBuiltinTemplate('scheduled-routine', { target: 's-t', schedule, instruction: 'x' })
  assert.throws(() => compile({ dailyAt: '25:99' }), /dailyAt must be HH:MM/)
  assert.throws(() => compile({ dailyAt: 'seven-ish' }), /dailyAt must be HH:MM/)
  assert.throws(() => compile({ everySeconds: 0 }), /positive integer/)
  assert.throws(() => compile({ everySeconds: 2.5 }), /positive integer/)
  assert.throws(() => compile({ everySeconds: 'often' }), /positive integer/)
  // Single-digit hours normalize to the kernel's canonical HH:MM.
  const plan = compile({ dailyAt: '7:30' })
  assert.deepEqual(plan.steps[0].input.on, { on: 'schedule', dailyAt: '07:30' })
})

// ---- reactive fixer ----

test('reactive-fixer compiles an external edge with the firing guardrail', () => {
  const plan = compileBuiltinTemplate('reactive-fixer', {
    source: 'src-ci',
    target: 's-fixer',
    instruction: 'Fix the failing build.',
  })
  const step = plan.steps[0]
  assert.deepEqual(step.input.source, { external: 'src-ci' })
  assert.deepEqual(step.input.on, { on: 'external' })
  assert.deepEqual(step.input.stop, { maxFirings: defaultReactiveFixerMaxFirings })
})

test('reactive-fixer honors an explicit max firings', () => {
  const plan = compileBuiltinTemplate('reactive-fixer', {
    source: 'src-ci',
    target: 's-fixer',
    instruction: 'x',
    maxFirings: 1,
  })
  assert.deepEqual(plan.steps[0].input.stop, { maxFirings: 1 })
})

// ---- slot validation ----

test('unknown template and unknown slot keys are named in the error', () => {
  assert.throws(() => compileBuiltinTemplate('no-such-template', {}), /Unknown template/)
  assert.throws(
    () => compileBuiltinTemplate('handoff', { source: 'a', target: 'b', bogus: 'x' }),
    /no slot "bogus"/
  )
})

test('number slots coerce strings and reject non-positive or fractional values', () => {
  const slots = builtinTemplateById.get('review-until-clean').slots
  const filled = validateSlotParams('Review until clean', slots, {
    coder: 's-c',
    maxLaps: '5',
  })
  assert.equal(filled.maxLaps, 5)
  assert.throws(
    () => validateSlotParams('Review until clean', slots, { coder: 's-c', maxLaps: 2.5 }),
    /positive integer/
  )
  assert.throws(
    () => validateSlotParams('Review until clean', slots, { coder: 's-c', maxLaps: 0 }),
    /positive integer/
  )
  // Number.isInteger(1e100) is true — a cap that large is no guardrail;
  // number slots demand safe integers under the product ceiling.
  assert.throws(
    () => validateSlotParams('Review until clean', slots, { coder: 's-c', maxLaps: 1e100 }),
    /positive integer \(1-999\)/
  )
  assert.throws(
    () => validateSlotParams('Review until clean', slots, { coder: 's-c', maxLaps: 1000 }),
    /positive integer \(1-999\)/
  )
})

test('blank strings do not satisfy required slots', () => {
  assert.throws(
    () => compileBuiltinTemplate('handoff', { source: '   ', target: 's-b' }),
    /missing required slot/
  )
})

// ---- custom templates: parameterize → compile roundtrip ----

const liveReviewRing = [
  {
    id: 'review-pass-1a2b3c4d',
    label: 'review pass',
    source: { kind: 'session', sessionId: 's-coder' },
    on: { on: 'finished' },
    target: { kind: 'session', sessionId: 's-reviewer' },
    action: { kind: 'deliver+activate', topic: 'diff', note: 'review it' },
    concurrency: 'coalesce',
    stop: { whenReport: { verdict: 'clean' }, maxFirings: 6 },
    onStop: 'freeze-edge',
    state: 'active',
    firings: 2,
  },
  {
    id: 'review-fix-1a2b3c4d',
    label: 'review fix',
    source: { kind: 'session', sessionId: 's-reviewer' },
    on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
    target: { kind: 'session', sessionId: 's-coder' },
    action: { kind: 'deliver+activate', topic: 'review', note: 'fix it' },
    concurrency: 'coalesce',
    stop: { whenReport: { verdict: 'clean' }, maxFirings: 6 },
    onStop: 'freeze-edge',
    state: 'active',
    firings: 2,
  },
]

test('parameterize turns distinct session endpoints into labeled slots and drops runtime state', () => {
  const body = parameterizeSubscriptions(liveReviewRing, {
    session: (id) => ({ 's-coder': 'Coder', 's-reviewer': 'Reviewer' })[id],
    source: () => undefined,
  })
  assert.deepEqual(
    body.slots.map((slot) => [slot.key, slot.label, slot.kind]),
    [
      ['session-1', 'Coder', 'session'],
      ['session-2', 'Reviewer', 'session'],
    ]
  )
  assert.equal(body.subscriptions.length, 2)
  assert.deepEqual(body.subscriptions[0].source, { session: '$session-1' })
  assert.deepEqual(body.subscriptions[0].target, { session: '$session-2' })
  assert.deepEqual(body.subscriptions[1].source, { session: '$session-2' })
  // History and identity stay out of the template — but the SEMANTIC id
  // prefix survives, so a reapplied ring pairs up under one fresh suffix.
  for (const subscription of body.subscriptions) {
    assert.equal('id' in subscription, false)
    assert.equal('firings' in subscription, false)
    assert.equal('state' in subscription, false)
  }
  assert.equal(body.subscriptions[0].idPrefix, 'review-pass')
  assert.equal(body.subscriptions[1].idPrefix, 'review-fix')
  // The relation itself survives verbatim.
  assert.deepEqual(body.subscriptions[1].on, {
    on: 'report',
    match: { type: 'verdict', verdict: 'issues' },
  })
  assert.deepEqual(body.subscriptions[0].stop, {
    whenReport: { verdict: 'clean' },
    maxFirings: 6,
  })
})

test('a saved template rebinds to new sessions on compile', () => {
  const body = parameterizeSubscriptions(liveReviewRing, {
    session: () => undefined,
    source: () => undefined,
  })
  const plan = compileSavedTemplate(
    { name: 'our review', slots: body.slots, subscriptions: body.subscriptions },
    { 'session-1': 's-new-coder', 'session-2': 's-new-reviewer' }
  )
  assert.equal(plan.steps.length, 2)
  assert.deepEqual(plan.steps[0].input.source, { session: 's-new-coder' })
  assert.deepEqual(plan.steps[0].input.target, { session: 's-new-reviewer' })
  assert.deepEqual(plan.steps[1].input.source, { session: 's-new-reviewer' })
  assert.deepEqual(plan.steps[1].input.target, { session: 's-new-coder' })
})

test('timer and external endpoints survive parameterization; external rebinds via slot', () => {
  const body = parameterizeSubscriptions(
    [
      {
        id: 'routine-1',
        source: { kind: 'timer' },
        on: { on: 'schedule', everySeconds: 900 },
        target: { kind: 'session', sessionId: 's-t' },
        action: { kind: 'deliver+activate', note: 'wake' },
      },
      {
        id: 'fixer-1',
        source: { kind: 'external', sourceId: 'src-ci' },
        on: { on: 'external' },
        target: { kind: 'session', sessionId: 's-t' },
        action: { kind: 'deliver+activate', note: 'fix' },
        stop: { maxFirings: 3 },
      },
    ],
    { session: () => 'Target', source: () => 'CI watcher' }
  )
  assert.deepEqual(
    body.slots.map((slot) => [slot.key, slot.kind]),
    [
      ['session-1', 'session'],
      ['source-1', 'external-source'],
    ]
  )
  assert.deepEqual(body.subscriptions[0].source, { timer: true })
  assert.deepEqual(body.subscriptions[1].source, { external: '$source-1' })

  const plan = compileSavedTemplate(
    { name: 'ops', slots: body.slots, subscriptions: body.subscriptions },
    { 'session-1': 's-ops', 'source-1': 'src-new-ci' }
  )
  assert.deepEqual(plan.steps[0].input.source, { timer: true })
  assert.deepEqual(plan.steps[0].input.target, { session: 's-ops' })
  assert.deepEqual(plan.steps[1].input.source, { external: 'src-new-ci' })
})

test('cluster endpoints and empty selections cannot be templated', () => {
  assert.throws(
    () =>
      parameterizeSubscriptions(
        [
          {
            id: 'x',
            source: { kind: 'cluster', clusterId: 'c-1' },
            on: { on: 'finished' },
            target: { kind: 'session', sessionId: 's-t' },
            action: { kind: 'deliver+activate' },
          },
        ],
        { session: () => undefined, source: () => undefined }
      ),
    /cluster endpoint/
  )
  assert.throws(
    () => parameterizeSubscriptions([], { session: () => undefined, source: () => undefined }),
    /at least one subscription/
  )
})

// ---- descriptor list for the UI ----

test('templateDescriptors merges built-ins with saved templates in save order', () => {
  const saved = {
    'tpl-bbbbbbbb': {
      id: 'tpl-bbbbbbbb',
      name: 'later',
      createdAt: '2026-07-09T10:00:00.000Z',
      slots: [],
      subscriptions: [{ source: { timer: true }, on: { on: 'schedule', everySeconds: 900 }, target: { session: '$session-1' }, action: { kind: 'deliver+activate' } }],
    },
    'tpl-aaaaaaaa': {
      id: 'tpl-aaaaaaaa',
      name: 'earlier',
      tagline: 'my pipeline',
      createdAt: '2026-07-09T09:00:00.000Z',
      slots: [],
      subscriptions: [],
    },
  }
  const list = templateDescriptors(saved)
  assert.equal(list.length, builtinTemplates.length + 2)
  const custom = list.slice(builtinTemplates.length)
  assert.deepEqual(
    custom.map((template) => [template.id, template.builtin, template.tagline]),
    [
      ['tpl-aaaaaaaa', false, 'my pipeline'],
      ['tpl-bbbbbbbb', false, 'Saved from the canvas'],
    ]
  )
  assert.equal(templateDescriptors(undefined).length, builtinTemplates.length)
})
