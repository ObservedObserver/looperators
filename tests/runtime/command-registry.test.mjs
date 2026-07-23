import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createKernelCommandRegistry,
  kernelCommandKinds,
  kernelCommandPolicies,
} from '../../dist-electron/electron/runtime/control/commandRegistry.js'

function completeHandlers() {
  return Object.fromEntries(
    kernelCommandKinds.map((kind) => [kind, () => ({ kind })]),
  )
}

test('command registry is exhaustive and joins handlers to transaction policy', async () => {
  const registry = createKernelCommandRegistry(completeHandlers())

  assert.equal(kernelCommandKinds.length, 68)
  assert.deepEqual(Object.keys(registry), kernelCommandKinds)
  assert.deepEqual(Object.keys(kernelCommandPolicies), kernelCommandKinds)
  assert.equal(Object.isFrozen(registry), true)
  for (const kind of kernelCommandKinds) {
    assert.equal(Object.isFrozen(kernelCommandPolicies[kind]), true)
    assert.equal(typeof registry[kind].handler, 'function')
    assert.equal(Object.isFrozen(registry[kind]), true)
    assert.deepEqual(await registry[kind].handler(), { kind })
  }
})

test('command registry keeps journal, version, and post-commit policy canonical', () => {
  const automaticallyJournaled = kernelCommandKinds.filter(
    (kind) => kernelCommandPolicies[kind].automaticallyJournaledWorkflow,
  )
  assert.deepEqual(automaticallyJournaled, [
    'create_session',
    'resume_session',
    'activate',
    'commit_workflow',
    'start_plan_council_cross_review',
    'start_plan_council_synthesis',
    'retry_plan_council_participant',
    'start_draft_workflow',
    'start_handoff_workflow',
    'start_goal_workflow',
    'connect_agents',
    'rule_execute_activation',
  ])
  assert.deepEqual(
    kernelCommandKinds.filter(
      (kind) => kernelCommandPolicies[kind].affectsControlVersion === false,
    ),
    ['update_node_positions', 'provider_complete_run'],
  )
  assert.deepEqual(
    kernelCommandKinds.filter(
      (kind) => kernelCommandPolicies[kind].drainApprovedSlotsAfterCommit,
    ),
    ['unfreeze', 'approve_activation', 'connect_agents'],
  )
})

test('command registry rejects missing handlers and undeclared command kinds', () => {
  const handlers = completeHandlers()
  delete handlers.freeze
  assert.throws(
    () => createKernelCommandRegistry(handlers),
    /freeze is missing its handler/,
  )

  assert.throws(
    () =>
      createKernelCommandRegistry({
        ...completeHandlers(),
        undeclared_command: () => undefined,
      }),
    /undeclared_command has no policy/,
  )
})
