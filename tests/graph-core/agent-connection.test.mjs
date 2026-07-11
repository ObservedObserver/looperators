import assert from 'node:assert/strict'
import test from 'node:test'

import { compileAgentConnection, validateAgentConnection } from '../../dist-electron/shared/agent-connection.js'

function input(overrides = {}) {
  return {
    sourceSessionId: 'coder',
    target: { kind: 'existing', sessionId: 'reviewer' },
    timing: 'current-result',
    behavior: 'one-review',
    instruction: 'Review the current diff.',
    ...overrides,
  }
}

test('current-result and next-completion compile to distinct immediate semantics', () => {
  assert.equal(compileAgentConnection(input()).immediate, true)
  assert.equal(compileAgentConnection(input({ timing: 'next-completion' })).immediate, false)
})

test('dynamic behavior maps one review, future review, and review loop relationships', () => {
  assert.deepEqual(compileAgentConnection(input()).relationships, [{ role: 'review-pass', oneShot: true, reportIssuesOnly: false }])
  assert.deepEqual(compileAgentConnection(input({ behavior: 'keep-reviewing' })).relationships, [
    { role: 'review-pass', oneShot: false, reportIssuesOnly: false },
  ])
  assert.deepEqual(compileAgentConnection(input({ behavior: 'review-loop', review: { blocking: { mode: 'p0-p1' }, maxLaps: 6 } })).relationships, [
    { role: 'review-pass', oneShot: false, reportIssuesOnly: false },
    { role: 'review-fix', oneShot: false, reportIssuesOnly: true },
  ])
})

test('dynamic connection validation localizes target and review errors', () => {
  const result = validateAgentConnection(
    input({
      target: {
        kind: 'new',
        label: '',
        instruction: '',
        providerKind: 'codex',
        providerInstanceId: 'missing',
        runtimeSettings: { runtimeMode: 'approval-required' },
      },
      behavior: 'review-loop',
      instruction: '',
      review: { blocking: { mode: 'custom', customCriteria: '' }, maxLaps: 0 },
    }),
    ['default-codex'],
  )
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.field === 'target.label'))
  assert.ok(result.issues.some((issue) => issue.field === 'target.providerInstanceId'))
  assert.ok(result.issues.some((issue) => issue.field === 'review.maxLaps'))
  assert.ok(result.issues.some((issue) => issue.field === 'review.blocking.customCriteria'))
})
