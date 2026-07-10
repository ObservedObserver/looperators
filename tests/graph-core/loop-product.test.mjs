import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveLoopProductView } from '../../dist-electron/shared/loop-product.js'

function session(sessionId, label, status = 'idle', overrides = {}) {
  return { sessionId, label, status, ...overrides }
}

function subscriptions(overrides = {}) {
  return {
    'review-pass-x': {
      id: 'review-pass-x',
      label: 'review pass',
      source: { kind: 'session', sessionId: 'coder' },
      on: { on: 'finished' },
      target: { sessionId: 'reviewer' },
      action: { kind: 'deliver+activate' },
      state: 'active',
      firings: 0,
      ...overrides.pass,
    },
    'review-fix-x': {
      id: 'review-fix-x',
      label: 'blocking issues',
      source: { kind: 'session', sessionId: 'reviewer' },
      on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
      target: { sessionId: 'coder' },
      action: { kind: 'deliver+activate' },
      state: 'active',
      firings: 0,
      ...overrides.fix,
    },
  }
}

function verdict(verdictValue, overrides = {}) {
  return {
    id: `report-${verdictValue}`,
    from: 'reviewer',
    envelope: { ts: overrides.ts ?? '2026-07-10T12:00:00.000Z' },
    payload: {
      type: 'verdict',
      verdict: verdictValue,
      ...(overrides.summary ? { summary: overrides.summary } : {}),
      ...(overrides.issues ? { issues: overrides.issues } : {}),
    },
  }
}

function fixture(overrides = {}) {
  return {
    loop: {
      loopId: 'coder+reviewer',
      kind: 'review',
      memberSessionIds: ['coder', 'reviewer'],
      subscriptionIds: ['review-pass-x', 'review-fix-x'],
      designatedSubscriptionId: 'review-pass-x',
      lapCount: 1,
      lapCap: 6,
      status: 'idle',
      createdAt: '2026-07-10T12:00:00.000Z',
      ...overrides.loop,
    },
    sessions: {
      coder: session('coder', 'Coder', 'idle', overrides.coder),
      reviewer: session('reviewer', 'Reviewer', 'idle', overrides.reviewer),
    },
    subscriptions: subscriptions(overrides.subscriptions),
    reports: overrides.reports ?? [],
    timeline: overrides.timeline,
  }
}

test('product status: initial Coder working', () => {
  const view = deriveLoopProductView(fixture({ coder: { status: 'running' }, loop: { status: 'spinning', lapCount: 0 } }))
  assert.equal(view.phase, 'coder-working')
  assert.equal(view.responsibleSessionId, 'coder')
  assert.equal(view.canStop, true)
})

test('product status: waiting for review', () => {
  const view = deriveLoopProductView(fixture({ loop: { lapCount: 0 } }))
  assert.equal(view.phase, 'waiting-review')
  assert.equal(view.responsibleSessionId, 'reviewer')
})

test('product status: Reviewer working', () => {
  const view = deriveLoopProductView(fixture({ reviewer: { status: 'running' }, loop: { status: 'spinning' } }))
  assert.equal(view.phase, 'reviewer-working')
  assert.match(view.detail, /typed verdict/i)
})

test('product status: an open permission request is visible as waiting, not working', () => {
  const view = deriveLoopProductView(
    fixture({
      coder: {
        status: 'running',
        runtimeRequests: [{ status: 'open', kind: 'permission', title: 'Allow Bash npm test' }],
      },
      loop: { status: 'spinning' },
    }),
  )
  assert.equal(view.phase, 'waiting-blocked')
  assert.match(view.headline, /needs your response/i)
  assert.match(view.detail, /npm test/i)
  assert.equal(view.responsibleSessionId, 'coder')
})

test('product status: Coder fixing blocking issues with issue details', () => {
  const issues = [{ severity: 'P1', message: 'Lowercase behavior is missing.', file: 'src/name.js', line: 4 }]
  const view = deriveLoopProductView(
    fixture({ coder: { status: 'running' }, loop: { status: 'spinning' }, reports: [verdict('issues', { issues })] }),
  )
  assert.equal(view.phase, 'fixing-blocking-issues')
  assert.deepEqual(view.blockingIssues, issues)
  assert.equal(view.responsibleSessionId, 'coder')
})

test('product status: frozen and gate waiting are actionable, not generic idle', () => {
  const frozen = deriveLoopProductView(
    fixture({ loop: { status: 'frozen', statusDetail: 'Overnight hold.' }, reviewer: { frozen: true } }),
  )
  assert.equal(frozen.phase, 'waiting-blocked')
  assert.equal(frozen.failureKind, 'frozen')
  assert.match(frozen.detail, /Overnight hold/)

  const gated = deriveLoopProductView(fixture({ loop: { status: 'waiting-gate', statusDetail: 'gate master' } }))
  assert.equal(gated.phase, 'waiting-blocked')
  assert.match(gated.headline, /approval/i)
})

test('product status: failed participant keeps provider/model/auth/workspace reasons actionable', () => {
  const cases = [
    ['Please login to provider', 'auth'],
    ['The selected model requires a newer version of Codex', 'model'],
    ['Workspace cwd is not a Git repository', 'workspace'],
    ['Provider app-server closed', 'provider'],
    ['spawn codex ENOENT', 'provider'],
  ]
  for (const [error, expected] of cases) {
    const view = deriveLoopProductView(fixture({ reviewer: { status: 'failed', error } }))
    assert.equal(view.phase, 'failed')
    assert.equal(view.failureKind, expected)
    assert.equal(view.recovery?.kind, expected === 'auth' || expected === 'provider' ? 'open-provider-settings' : 'open-agent')
    assert.equal(view.canRetry, false)
  }
})

test('goal completion has a Goal product state, never a Review verdict', () => {
  const view = deriveLoopProductView({
    loop: {
      loopId: 'goal-check-x',
      kind: 'goal',
      memberSessionIds: ['worker', 'judge'],
      subscriptionIds: ['goal-check-x', 'goal-retry-x'],
      designatedSubscriptionId: 'goal-check-x',
      lapCount: 2,
      lapCap: 6,
      status: 'stopped',
      terminal: { type: 'subscription.stopped', ts: '2026-07-10T12:01:00.000Z', reason: 'Goal loop ended: whenReport(done) matched.' },
    },
    sessions: {
      worker: session('worker', 'Worker'),
      judge: session('judge', 'Judge'),
    },
  })
  assert.equal(view.phase, 'stopped-goal')
  assert.equal(view.headline, 'Goal reached')
  assert.doesNotMatch(view.headline, /review/i)
})

test('Goal and generic Loops keep permission, frozen, and gate states actionable', () => {
  const baseLoop = {
    loopId: 'goal-check-x',
    kind: 'goal',
    memberSessionIds: ['worker', 'judge'],
    subscriptionIds: ['goal-check-x', 'goal-retry-x'],
    designatedSubscriptionId: 'goal-check-x',
    lapCount: 1,
    lapCap: 6,
    status: 'idle',
  };
  const sessions = {
    worker: session('worker', 'Worker'),
    judge: session('judge', 'Judge'),
  };
  const permission = deriveLoopProductView({
    loop: { ...baseLoop, status: 'spinning' },
    sessions: {
      ...sessions,
      worker: session('worker', 'Worker', 'running', {
        runtimeRequests: [{ status: 'open', kind: 'permission', title: 'Allow npm test' }],
      }),
    },
  });
  assert.equal(permission.phase, 'waiting-blocked');
  assert.equal(permission.responsibleSessionId, 'worker');
  assert.match(permission.detail, /npm test/);

  const frozen = deriveLoopProductView({
    loop: { ...baseLoop, status: 'frozen', statusDetail: 'Budget hold.' },
    sessions: { ...sessions, judge: session('judge', 'Judge', 'idle', { frozen: true }) },
  });
  assert.equal(frozen.phase, 'waiting-blocked');
  assert.equal(frozen.failureKind, 'frozen');
  assert.equal(frozen.recovery?.sessionId, 'judge');

  const gated = deriveLoopProductView({
    loop: { ...baseLoop, loopId: 'a+b', kind: 'generic', status: 'waiting-gate', statusDetail: 'gate human' },
    sessions,
  });
  assert.equal(gated.phase, 'waiting-blocked');
  assert.match(gated.headline, /approval/i);
  assert.equal(gated.recovery?.kind, 'open-agent');
})

test('a previous clean report cannot relabel a newer manually stopped workflow', () => {
  const view = deriveLoopProductView(
    fixture({
      loop: {
        status: 'stopped',
        createdAt: '2026-07-10T12:10:00.000Z',
        terminal: { type: 'subscription.stopped', ts: '2026-07-10T12:11:00.000Z', reason: 'Stopped by user from Loop panel.' },
      },
      reports: [verdict('clean', { ts: '2026-07-10T12:00:00.000Z', summary: 'Old generation.' })],
    }),
  )
  assert.equal(view.phase, 'stopped-manual')
  assert.equal(view.lastVerdict, undefined)
})

test('authoritative terminal fact survives without renderer event-tail input', () => {
  const view = deriveLoopProductView(
    fixture({
      loop: {
        status: 'stopped',
        terminal: { type: 'subscription.guarded', ts: '2026-07-10T12:11:00.000Z', reason: 'Safety policy stopped this workflow.' },
      },
      timeline: undefined,
    }),
  )
  assert.equal(view.phase, 'stopped-guarded')
  assert.match(view.stopReason, /Safety policy/)
})

test('product status: Reviewer finishing without a typed report is a distinct blocked state', () => {
  const view = deriveLoopProductView(
    fixture({
      timeline: {
        laps: [{ index: 1, hops: [{ target: 'reviewer', outcome: { type: 'finished', ts: 'now' }, reports: [] }] }],
        stops: [],
        refusals: [],
      },
    }),
  )
  assert.equal(view.phase, 'waiting-blocked')
  assert.equal(view.failureKind, 'missing-report')
  assert.match(view.headline, /did not report/i)
  assert.equal(view.canRetry, false, 'the UI must not repeat review work automatically')
  assert.equal(view.recovery?.kind, 'resume-manually')

  const badgeViewWithoutTimeline = deriveLoopProductView(
    fixture({
      reviewer: { messages: [{ role: 'assistant', status: 'complete', ts: '2026-07-10T12:00:01.000Z' }] },
      subscriptions: { pass: { firings: 1 } },
    }),
  )
  assert.equal(badgeViewWithoutTimeline.phase, 'waiting-blocked')
  assert.equal(badgeViewWithoutTimeline.failureKind, 'missing-report')
})

test('product terminal status: clean', () => {
  const view = deriveLoopProductView(
    fixture({
      loop: { status: 'stopped', lapCount: 2 },
      subscriptions: { pass: { state: 'stopped', firings: 2 }, fix: { state: 'stopped', firings: 1 } },
      reports: [verdict('issues', { ts: '2026-07-10T12:00:00.000Z' }), verdict('clean', { ts: '2026-07-10T12:01:00.000Z', summary: 'All checks pass.' })],
    }),
  )
  assert.equal(view.phase, 'stopped-clean')
  assert.equal(view.lastVerdict, 'clean')
  assert.equal(view.canStop, false)
})

test('product terminal status: cap', () => {
  const view = deriveLoopProductView(
    fixture({
      loop: { status: 'stopped', lapCount: 6, lapCap: 6 },
      reports: [verdict('issues', { issues: [{ severity: 'P1', message: 'Still failing.' }] })],
      timeline: {
        laps: [],
        refusals: [],
        stops: [{ type: 'subscription.guarded', subscriptionId: 'review-pass-x', ts: 'now', reason: 'maxFirings 6 reached' }],
      },
    }),
  )
  assert.equal(view.phase, 'stopped-cap')
  assert.match(view.detail, /6\/6/)
  assert.equal(view.recovery?.sessionId, 'coder')
})

test('product terminal status: manual stop remains distinct from cap and clean', () => {
  const view = deriveLoopProductView(
    fixture({
      loop: { status: 'stopped', lapCount: 1 },
      timeline: {
        laps: [],
        refusals: [],
        stops: [{ type: 'subscription.stopped', subscriptionId: 'review-pass-x', ts: 'now', reason: 'Stopped by user from Loop panel.' }],
      },
    }),
  )
  assert.equal(view.phase, 'stopped-manual')
  assert.match(view.stopReason, /user/i)
  assert.equal(view.canStop, false)

  const manualAtNumericCap = deriveLoopProductView(
    fixture({
      loop: { status: 'stopped', lapCount: 6, lapCap: 6 },
      timeline: {
        laps: [],
        refusals: [],
        stops: [{ type: 'subscription.stopped', subscriptionId: 'review-pass-x', ts: 'now', reason: 'Stopped by user from Loop panel.' }],
      },
    }),
  )
  assert.equal(manualAtNumericCap.phase, 'stopped-manual', 'an explicit user stop wins over the numeric cap heuristic')
})
