import type { JsonRecord } from '../runtimeCommon.js'

export type KernelCommandHandler = (
  input: JsonRecord,
  context: JsonRecord,
) => unknown | Promise<unknown>

export type KernelCommandPolicy = Readonly<{
  automaticallyJournaledWorkflow?: boolean
  affectsControlVersion?: boolean
  drainApprovedSlotsAfterCommit?: boolean
}>

function defineKernelCommandPolicies<
  const Policies extends Record<string, KernelCommandPolicy>,
>(policies: Policies): Readonly<{
  [Kind in keyof Policies]: Readonly<Policies[Kind]>
}> {
  for (const policy of Object.values(policies)) Object.freeze(policy)
  return Object.freeze(policies)
}

// This object is the canonical command catalog. Command kind, transaction
// policy, and post-commit policy must be declared together so adding a command
// cannot silently skip workflow journaling or version semantics.
export const kernelCommandPolicies = defineKernelCommandPolicies({
  create_session: { automaticallyJournaledWorkflow: true },
  resume_session: { automaticallyJournaledWorkflow: true },
  deliver: {},
  activate: { automaticallyJournaledWorkflow: true },
  archive_session: {},
  kill_session: {},
  respond_runtime_request: {},
  answer_user_input: {},
  upsert_scope: {},
  create_master: {},
  assign_master: {},
  set_loop_policy: {},
  update_node_positions: { affectsControlVersion: false },
  start_loop: {},
  stop_loop: {},
  freeze: {},
  unfreeze: { drainApprovedSlotsAfterCommit: true },
  link_sessions: {},
  remove_edge: {},
  report: {},
  upsert_provider_instance: {},
  author_subscription: {},
  stop_subscription: {},
  approve_activation: { drainApprovedSlotsAfterCommit: true },
  deny_activation: {},
  cleanup_channels: {},
  propose_workflow: {},
  propose_workflow_patch: {},
  revise_workflow: {},
  approve_workflow_proposal: {},
  reject_workflow_proposal: {},
  expire_workflow_proposal: {},
  commit_workflow: { automaticallyJournaledWorkflow: true },
  abort_workflow_proposal: {},
  lock_workflow_item: {},
  record_workflow_wakeup: {},
  notify_workflow_wakeup: {},
  acknowledge_workflow_wakeup: {},
  create_barrier: {},
  arrive_barrier: {},
  cancel_barrier: {},
  expire_barrier: {},
  provider_complete_run: { affectsControlVersion: false },
  set_resource_policy: {},
  merge_worktree_changes: {},
  cleanup_worktree: {},
  create_goal_loop: {},
  start_review_workflow: {},
  start_plan_council: {},
  start_plan_council_cross_review: {
    automaticallyJournaledWorkflow: true,
  },
  start_plan_council_synthesis: { automaticallyJournaledWorkflow: true },
  retry_plan_council_participant: {
    automaticallyJournaledWorkflow: true,
  },
  stop_plan_council: {},
  start_draft_workflow: { automaticallyJournaledWorkflow: true },
  start_handoff_workflow: { automaticallyJournaledWorkflow: true },
  start_goal_workflow: { automaticallyJournaledWorkflow: true },
  connect_agents: {
    automaticallyJournaledWorkflow: true,
    drainApprovedSlotsAfterCommit: true,
  },
  apply_template: {},
  save_template: {},
  remove_template: {},
  register_external_source: {},
  remove_external_source: {},
  rule_stop_for_event: {},
  rule_deliver_for_event: {},
  rule_pend_activation: {},
  rule_execute_activation: { automaticallyJournaledWorkflow: true },
  rule_drop_activation: {},
  rule_stop_killed_subscriptions: {},
} satisfies Record<string, KernelCommandPolicy>)

export type KernelCommandKind = keyof typeof kernelCommandPolicies

export type KernelCommandHandlers = Readonly<{
  [Kind in KernelCommandKind]: KernelCommandHandler
}>

export type KernelCommandRegistry = Readonly<
  Record<
    KernelCommandKind,
    Readonly<KernelCommandPolicy & { handler: KernelCommandHandler }>
  >
>

export const kernelCommandKinds = Object.freeze(
  Object.keys(kernelCommandPolicies) as KernelCommandKind[],
)

export function createKernelCommandRegistry(
  handlers: KernelCommandHandlers,
): KernelCommandRegistry {
  // Keep runtime checks for JavaScript and dynamically assembled callers;
  // the typed manager call site also gets compile-time exhaustiveness.
  for (const kind of kernelCommandKinds) {
    if (typeof handlers[kind] !== 'function') {
      throw new Error(`Kernel command ${kind} is missing its handler.`)
    }
  }
  for (const kind of Object.keys(handlers)) {
    if (!Object.hasOwn(kernelCommandPolicies, kind)) {
      throw new Error(`Kernel command handler ${kind} has no policy.`)
    }
  }

  return Object.freeze(
    Object.fromEntries(
      kernelCommandKinds.map((kind) => [
        kind,
        Object.freeze({
          ...kernelCommandPolicies[kind],
          handler: handlers[kind],
        }),
      ]),
    ),
  ) as KernelCommandRegistry
}

export function commandRegistryEntry(
  registry: KernelCommandRegistry,
  kind: string | undefined,
) {
  return kind && Object.hasOwn(registry, kind)
    ? registry[kind as KernelCommandKind]
    : undefined
}
