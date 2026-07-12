import assert from 'node:assert/strict'
import test from 'node:test'

import { validateDynamicCreateAction } from '../../dist-electron/shared/dynamic-topology.js'

function action(overrides = {}) {
  return {
    kind: 'create',
    forEach: { kind: 'report-issues' },
    template: {
      templateId: 'triage-v1',
      labelPrefix: 'Triage',
      role: 'triage',
      prompt: 'Investigate the assigned issue and report a concise diagnosis.',
      providerKind: 'claude-code',
      providerInstanceId: 'default-claude-sdk',
      workspace: { access: 'read-only', workMode: 'local' },
      retention: 'archive-on-stop',
    },
    limits: { maxGenerationDepth: 2, maxSessions: 8, maxFanOut: 3, maxPlanVersions: 10 },
    ...overrides,
  }
}

test('dynamic create accepts only bounded fixed participant templates', () => {
  assert.equal(validateDynamicCreateAction(action(), {
    providerInstanceIds: ['default-claude-sdk'],
  }).ok, true)
  assert.equal(validateDynamicCreateAction(action({
    template: { ...action().template, prompt: 'Investigate {{issue}}' },
  })).ok, false)
  assert.equal(validateDynamicCreateAction(action({
    limits: { ...action().limits, maxFanOut: 9 },
  })).ok, false)
  assert.equal(validateDynamicCreateAction({ ...action(), promptTemplate: '{{anything}}' }).ok, false)
  assert.equal(validateDynamicCreateAction({
    kind: 'create', agent: 'claude-code', promptTemplate: '{{anything}}',
  }).ok, false)
})
