import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeThreadGoal,
  parseGoalComposerCommand,
  shouldApplyThreadGoalEvent,
} from '../../dist-electron/shared/thread-goal.js'
import { normalizeSession } from '../../dist-electron/electron/runtime/persistence/runtimeStateRecovery.js'

test('goal composer parser distinguishes view, lifecycle controls, and escaped objectives', () => {
  assert.deepEqual(parseGoalComposerCommand('/goal'), { kind: 'view' })
  assert.deepEqual(parseGoalComposerCommand('  /GOAL   pause  '), { kind: 'pause' })
  assert.deepEqual(parseGoalComposerCommand('/goal resume'), { kind: 'resume' })
  assert.deepEqual(parseGoalComposerCommand('/goal clear'), { kind: 'clear' })
  assert.deepEqual(parseGoalComposerCommand('/goal set pause'), {
    kind: 'set',
    objective: 'pause',
  })
  assert.deepEqual(parseGoalComposerCommand('/goal ship the feature'), {
    kind: 'set',
    objective: 'ship the feature',
  })
  assert.equal(parseGoalComposerCommand('/go ship'), undefined)
  assert.equal(parseGoalComposerCommand('message /goal ship'), undefined)
  assert.equal(parseGoalComposerCommand(`/goal ${'x'.repeat(4001)}`).kind, 'invalid')
})

test('goal payload normalizer rejects malformed provider state', () => {
  const goal = normalizeThreadGoal({
    threadId: 'thread-1',
    objective: 'Finish safely',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 12,
    timeUsedSeconds: 3,
    createdAt: 100,
    updatedAt: 101,
  })
  assert.equal(goal.objective, 'Finish safely')
  assert.equal(goal.tokenBudget, null)
  assert.equal(normalizeThreadGoal({ ...goal, status: 'unknown' }), undefined)
  assert.equal(normalizeThreadGoal({ ...goal, tokensUsed: -1 }), undefined)
})

test('goal event ordering accepts same-second progress and rejects invalid timestamps', () => {
  assert.equal(shouldApplyThreadGoalEvent({ lastAppliedAt: 100, eventAt: 100 }), true)
  assert.equal(shouldApplyThreadGoalEvent({ lastAppliedAt: 101, eventAt: 100 }), false)
  assert.equal(shouldApplyThreadGoalEvent({ lastAppliedAt: undefined, eventAt: Number.NaN }), false)
  assert.equal(
    shouldApplyThreadGoalEvent({ authoritative: true, lastAppliedAt: 101, eventAt: 100 }),
    true,
  )
})

test('session recovery removes malformed persisted thread goals', () => {
  const diagnostics = []
  const session = normalizeSession(
    'session-1',
    {
      sessionId: 'session-1',
      nodeId: 'session-1',
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      agent: 'codex',
      cwd: process.cwd(),
      status: 'idle',
      threadGoal: { threadId: 'thread-1', objective: 'broken', status: 'active' },
    },
    diagnostics,
    [{ providerInstanceId: 'default-codex', kind: 'codex', label: 'Codex' }],
  )
  assert.equal(Object.hasOwn(session, 'threadGoal'), false)
  assert.equal(
    diagnostics.some((item) => item.type === 'storage.thread_goal_skipped'),
    true,
  )
})

test('session recovery repairs an invalid persisted goal event watermark', () => {
  const diagnostics = []
  const session = normalizeSession(
    'session-1',
    {
      sessionId: 'session-1',
      nodeId: 'session-1',
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      agent: 'codex',
      cwd: process.cwd(),
      status: 'idle',
      threadGoal: {
        threadId: 'thread-1',
        objective: 'recover safely',
        status: 'paused',
        tokensUsed: 1,
        timeUsedSeconds: 1,
        createdAt: 100,
        updatedAt: 101,
      },
      threadGoalLastAppliedAt: -1,
    },
    diagnostics,
    [{ providerInstanceId: 'default-codex', kind: 'codex', label: 'Codex' }],
  )
  assert.equal(session.threadGoalLastAppliedAt, 101)
  assert.equal(
    diagnostics.some((item) => item.type === 'storage.thread_goal_watermark_repaired'),
    true,
  )
})
