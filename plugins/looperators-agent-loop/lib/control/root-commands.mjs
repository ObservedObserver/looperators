import { withCurrentRoleCapability } from './capabilities.mjs';
import { ROOT_CONTROL_STATUSES } from './constants.mjs';
import { fail } from './errors.mjs';
import { mutationRequestDigest } from './identifiers.mjs';
import { ensureCooperativeRoleBindings } from './identity-plane.mjs';
import { assertRootContext, requestId, runId } from './input.mjs';
import { assertRoot } from './invariants.mjs';
import { buildTransition, mutate } from './mutation-engine.mjs';
import { roleNode } from './report-command.mjs';

export async function start(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  const before = await runtime.store.readState(targetRunId);
  assertRoot(runtime, before, context);
  await ensureCooperativeRoleBindings(runtime, before);
  const result = await rootMutation(runtime, context, input, 'start', async (state, definition, createdAt, ids) => {
    if (state.status !== 'draft') {
      fail('INVALID_STATE_TRANSITION', 'only a draft run can start');
    }
    return {
      transition: buildTransition(runtime, {
        ...ids,
        kind: 'activate-implementer',
        fromNode: state.masterNode,
        toNode: await roleNode(runtime, state.runId, 'implementer'),
        lap: 0,
        createdAt,
      }),
    };
  });
  return withCurrentRoleCapability(runtime, result);
}

export async function pause(runtime, contextValue, input) {
  return rootMutation(runtime, contextValue, input, 'pause', async (state, _definition, createdAt, ids) => {
    if (!['running', 'interrupted'].includes(state.status)) {
      fail('INVALID_STATE_TRANSITION', 'only a running or interrupted run can pause');
    }
    return {
      transition: buildTransition(runtime, {
        ...ids,
        kind: 'pause',
        fromNode: state.masterNode,
        toNode: state.masterNode,
        lap: state.currentLap,
        createdAt,
      }),
    };
  });
}

export async function resume(runtime, contextValue, input) {
  return rootMutation(runtime, contextValue, input, 'resume', async (state, _definition, createdAt, ids) => {
    if (!['paused', 'interrupted'].includes(state.status)) {
      fail('INVALID_STATE_TRANSITION', 'only a paused or interrupted run can resume');
    }
    return {
      transition: buildTransition(runtime, {
        ...ids,
        kind: 'resume',
        fromNode: state.masterNode,
        toNode: state.masterNode,
        lap: state.currentLap,
        createdAt,
      }),
    };
  });
}

export async function cancel(runtime, contextValue, input) {
  return rootMutation(runtime, contextValue, input, 'cancel', async (state, _definition, createdAt, ids) => {
    if (!ROOT_CONTROL_STATUSES.has(state.status)) {
      fail('INVALID_STATE_TRANSITION', 'terminal runs cannot be cancelled again');
    }
    return {
      transition: buildTransition(runtime, {
        ...ids,
        kind: 'cancel',
        fromNode: state.masterNode,
        toNode: state.masterNode,
        lap: state.currentLap,
        createdAt,
      }),
    };
  });
}

export async function rootMutation(runtime, contextValue, input, kind, build) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  const mutationRequestId = requestId(input?.requestId);
  const actor = {
    kind: 'root',
    id: context.rootSessionId,
  };
  const digest = mutationRequestDigest({
    kind,
    runId: targetRunId,
    requestId: mutationRequestId,
    actorKind: actor.kind,
    actorId: actor.id,
  });
  return mutate(runtime, {
    runId: targetRunId,
    requestId: mutationRequestId,
    requestDigest: digest,
    kind,
    actor,
    authorize: (state) => assertRoot(runtime, state, context),
    build,
  });
}
