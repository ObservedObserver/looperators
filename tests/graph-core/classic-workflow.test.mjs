import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classicWorkflowPreflightKey,
  resolveGoalJudgeRuntime,
  validateGoalWorkflowStart,
  validateHandoffWorkflowStart,
} from '../../dist-electron/shared/classic-workflow.js'

const fresh = (label, prompt = 'Do the work.') => ({
  kind: 'new',
  label,
  prompt,
  cwd: '/repo',
  workMode: 'local',
  providerKind: 'claude-code',
  providerInstanceId: 'claude-code:default',
  runtimeSettings: { runtimeMode: 'auto-accept-edits', reasoningEffort: 'medium' },
})

const context = { providerInstanceIds: ['claude-code:default', 'codex:default'], sessions: {} }

test('Handoff and Goal share the same new/existing Agent endpoint contract', () => {
  assert.equal(validateHandoffWorkflowStart({ source: fresh('Source'), target: fresh('Receiver'), note: 'Continue once.' }, context).ok, true)
  assert.equal(validateGoalWorkflowStart({ worker: fresh('Worker'), goal: 'Tests pass.', maxLaps: 4 }, context).ok, true)
  assert.match(
    validateHandoffWorkflowStart({ source: fresh('Source', ''), target: fresh('Receiver'), note: '' }, context).issues.map((issue) => issue.field).join(','),
    /source\.prompt.*note/,
  )
})

test('Goal exposes the judge override and keeps the shared 1-99 stop bound', () => {
  assert.equal(
    validateGoalWorkflowStart({ worker: fresh('Worker'), goal: 'Done.', maxLaps: 99, judgeProviderInstanceId: 'codex:default' }, context).ok,
    true,
  )
  assert.deepEqual(
    validateGoalWorkflowStart({ worker: fresh('Worker'), goal: 'Done.', maxLaps: 100, judgeProviderInstanceId: 'missing' }, context).issues.map(
      (issue) => issue.field,
    ),
    ['maxLaps', 'judgeProviderInstanceId'],
  )
})

test('cross-provider Goal Judge derives its kind and drops an incompatible Worker model', () => {
  const worker = {
    providerKind: 'claude-code',
    providerInstanceId: 'claude-code:default',
    runtimeSettings: { runtimeMode: 'auto-accept-edits', reasoningEffort: 'high', model: 'claude-sonnet-4-6' },
  }
  assert.deepEqual(
    resolveGoalJudgeRuntime(
      worker,
      [
        { providerInstanceId: 'claude-code:default', kind: 'claude-code' },
        { providerInstanceId: 'codex:default', kind: 'codex' },
      ],
      'codex:default',
      'gpt-5.5',
    ),
    {
      providerKind: 'codex',
      providerInstanceId: 'codex:default',
      runtimeSettings: { runtimeMode: 'auto-accept-edits', reasoningEffort: 'high', model: 'gpt-5.5' },
    },
  )
  assert.equal(worker.runtimeSettings.model, 'claude-sonnet-4-6')
})

test('classic workflow preflight key ignores unrelated runtime snapshot identity', () => {
  const selected = [{
    role: 'Worker', cwd: '/repo', workMode: 'local', checkProject: true,
    providerKind: 'claude-code', providerInstanceId: 'claude-code:default',
    providerProfileFingerprint: '["claude-code:default","claude-code","/bin/claude"]',
  }]
  const before = classicWorkflowPreflightKey(selected)
  const afterUnrelatedStreamUpdate = classicWorkflowPreflightKey(structuredClone(selected))
  const afterSelectedWorkspaceChange = classicWorkflowPreflightKey([{ ...selected[0], cwd: '/other-repo' }])
  const afterSelectedProfileRepair = classicWorkflowPreflightKey([{
    ...selected[0],
    providerProfileFingerprint: '["claude-code:default","claude-code","/fixed/claude"]',
  }])
  assert.equal(afterUnrelatedStreamUpdate, before)
  assert.notEqual(afterSelectedWorkspaceChange, before)
  assert.notEqual(afterSelectedProfileRepair, before)
})
