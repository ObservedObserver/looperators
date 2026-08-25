import { assertContract, SCHEMA_VERSION, validateLoopReport, WORKER_ROLES } from '../contracts.mjs';
import { assertConsumedRoleCapability, assertRoleCapability } from './capabilities.mjs';
import { fail } from './errors.mjs';
import { mutationResult } from './history-facts.mjs';
import { mutationRequestDigest, operationIdFor, roleAgentId } from './identifiers.mjs';
import { boundedString, requestId, runId } from './input.mjs';
import { buildTransition, mutate } from './mutation-engine.mjs';

export async function report(runtime, input) {
  const targetRunId = runId(input?.runId);
  const mutationRequestId = requestId(input?.requestId);
  const role = input?.role;
  if (!WORKER_ROLES.has(role)) {
    fail('INVALID_TOOL_INPUT', 'role is invalid');
  }
  const targetAgentId = roleAgentId(role);
  const token = boundedString(input?.capabilityToken, 'capabilityToken', 2048);
  if (!['info', 'verdict'].includes(input?.type)) {
    fail('INVALID_REPORT', 'report type is invalid');
  }
  const payload = {
    type: input?.type,
    ...(input?.status ? { status: input.status } : {}),
    ...(input?.verdict ? { verdict: input.verdict } : {}),
    ...(input?.issues ? { issues: input.issues } : {}),
    ...(input?.summary ? { summary: input.summary } : {}),
  };
  const digest = mutationRequestDigest({
    kind: 'report',
    runId: targetRunId,
    requestId: mutationRequestId,
    actorKind: 'worker',
    actorId: targetAgentId,
    payload,
  });
  const [stateBefore, operationRead] = await Promise.all([runtime.store.readState(targetRunId), runtime.store.listOperations(targetRunId)]);
  if (operationRead.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'report operation history is corrupt');
  }
  const existingOperation = operationRead.facts.find((operation) => operation.operationId === operationIdFor(targetRunId, mutationRequestId));
  if (existingOperation && stateBefore.revision >= existingOperation.toRevision) {
    if (existingOperation.kind !== 'report' || existingOperation.actorId !== targetAgentId || existingOperation.requestDigest !== digest) {
      fail('REQUEST_ID_CONFLICT', 'report request id already has different content');
    }
    await assertConsumedRoleCapability(runtime, existingOperation, role, token, operationRead.facts);
    return mutationResult(runtime, stateBefore, await runtime.store.readDefinition(targetRunId), existingOperation, true);
  }
  await assertRoleCapability(runtime, stateBefore, role, token);
  return mutate(runtime, {
    runId: targetRunId,
    requestId: mutationRequestId,
    requestDigest: digest,
    kind: 'report',
    actor: { kind: 'worker', id: targetAgentId },
    authorize: (state) => assertRoleCapability(runtime, state, role, token),
    reportPayload: payload,
    build: (state, definition, createdAt, ids) => buildReportMutation(runtime, state, definition, createdAt, ids, targetAgentId, payload),
  });
}

export async function buildReportMutation(runtime, state, definition, createdAt, ids, targetAgentId, payload) {
  if (state.status !== 'running') {
    fail('REPORT_NOT_ACCEPTED', 'run is not accepting worker reports');
  }
  const bindings = await runtime.store.listIdentityBindings(state.runId);
  if (bindings.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'identity bindings are corrupt');
  }
  const binding = bindings.facts.find((candidate) => candidate.agentId === targetAgentId);
  if (!binding?.role) {
    fail('AGENT_NOT_BOUND', 'worker has no governed role binding');
  }
  if (!state.pendingTransitionId) {
    fail('REPORT_OUT_OF_TURN', 'run has no pending worker action');
  }
  const pending = await runtime.store.readTransition(state.runId, state.pendingTransitionId);
  const expectedRole = pending.kind === 'activate-implementer' ? 'implementer' : pending.kind === 'activate-reviewer' ? 'reviewer' : null;
  if (binding.role !== expectedRole) {
    fail('REPORT_OUT_OF_TURN', 'worker role does not match the pending action');
  }

  let transitionKind;
  let transitionTarget;
  let transitionLap = state.currentLap;
  if (binding.role === 'implementer') {
    if (payload.type !== 'info' || payload.status !== 'done' || payload.verdict !== undefined || payload.issues !== undefined) {
      fail('INVALID_REPORT', 'implementer must submit only info/status=done');
    }
    transitionKind = 'activate-reviewer';
    transitionTarget = await roleNode(runtime, state.runId, 'reviewer');
  } else {
    if (payload.type !== 'verdict' || !['issues', 'clean'].includes(payload.verdict) || payload.status !== undefined) {
      fail('INVALID_REPORT', 'reviewer must submit a typed clean/issues verdict');
    }
    if (payload.verdict === 'issues' && (!Array.isArray(payload.issues) || payload.issues.length === 0)) {
      fail('INVALID_REPORT', 'issues verdict requires at least one issue');
    }
    if (payload.verdict === 'clean' && Array.isArray(payload.issues) && payload.issues.length > 0) {
      fail('INVALID_REPORT', 'clean verdict cannot contain issues');
    }
    if (payload.verdict === 'clean') {
      transitionKind = 'succeed';
      transitionTarget = state.masterNode;
    } else if (state.currentLap + 1 > definition.lapCap) {
      transitionKind = 'cap';
      transitionTarget = state.masterNode;
    } else {
      transitionKind = 'activate-implementer';
      transitionTarget = await roleNode(runtime, state.runId, 'implementer');
      transitionLap = state.currentLap + 1;
    }
  }

  const report = assertContract(
    'loop report',
    {
      schemaVersion: SCHEMA_VERSION,
      reportId: ids.reportId,
      runId: state.runId,
      requestId: ids.requestId,
      requestDigest: ids.requestDigest,
      fromRevision: ids.fromRevision,
      toRevision: ids.toRevision,
      fromNode: targetAgentId,
      receiver: 'root-master',
      ...(transitionKind.startsWith('activate-') ? { routedToNode: transitionTarget } : {}),
      type: payload.type,
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.verdict ? { verdict: payload.verdict } : {}),
      ...(payload.issues ? { issues: payload.issues } : {}),
      ...(payload.summary ? { summary: payload.summary } : {}),
      createdAt,
    },
    validateLoopReport,
  );
  const transition = buildTransition(runtime, {
    ...ids,
    kind: transitionKind,
    fromNode: targetAgentId,
    toNode: transitionTarget,
    originReportId: report.reportId,
    lap: transitionLap,
    createdAt,
  });
  return { report, transition };
}

export async function roleNode(runtime, targetRunId, role) {
  const bindings = await runtime.store.listIdentityBindings(targetRunId);
  if (bindings.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'identity bindings are corrupt');
  }
  const matches = bindings.facts.filter((binding) => binding.role === role);
  if (matches.length > 1) {
    fail('IDENTITY_BINDING_CONFLICT', 'multiple workers are bound to one role');
  }
  return `role:${role}`;
}
