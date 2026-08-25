import { canonicalJson } from '../canonical-json.mjs';
import { collectLegacyNativeTargetEntries } from '../recovery.mjs';
import { fail } from './errors.mjs';
import { definitionIdFor, definitionRequestDigest, operationIdFor, reportIdFor, transitionIdFor } from './identifiers.mjs';
import { assertIdentityBindingTopology } from './invariants.mjs';
import { governedTransitionRole, stateSummary } from './state.mjs';

export async function readAndValidateDefinition(runtime, state) {
  let definition;
  try {
    definition = await runtime.store.readDefinition(state.runId);
  } catch (error) {
    fail('RECOVERY_REQUIRED', 'run definition is missing or unreadable', { code: error?.code ?? 'READ_ERROR' });
  }
  const expectedDigest = definitionRequestDigest({
    rootSessionId: state.rootSessionId,
    requestId: definition.requestId,
    goal: definition.goal,
    implementerInstructions: definition.implementerInstructions,
    reviewerInstructions: definition.reviewerInstructions,
    lapCap: definition.lapCap,
  });
  if (
    definition.runId !== state.runId ||
    definition.definitionId !== definitionIdFor(state.runId) ||
    definition.requestDigest !== expectedDigest ||
    definition.recipe !== state.recipe ||
    definition.createdAt !== state.createdAt ||
    state.masterNode !== state.rootSessionId ||
    definition.lapCap !== state.continuationLease.granted
  ) {
    fail('RECOVERY_REQUIRED', 'run definition conflicts with durable loop state');
  }
  return definition;
}

export async function readAndValidateOperation(runtime, operation, state) {
  let durable;
  try {
    durable = await runtime.store.readOperation(operation.runId, operation.operationId);
  } catch (error) {
    fail('RECOVERY_REQUIRED', 'operation receipt is missing or unreadable', { code: error?.code ?? 'READ_ERROR' });
  }
  const expectsReport = operation.kind === 'report';
  if (
    canonicalJson(durable) !== canonicalJson(operation) ||
    operation.runId !== state.runId ||
    operation.operationId !== operationIdFor(operation.runId, operation.requestId) ||
    operation.transitionId !== transitionIdFor(operation.runId, operation.requestId) ||
    (expectsReport && operation.reportId !== reportIdFor(operation.runId, operation.requestId)) ||
    (!expectsReport && operation.reportId !== undefined) ||
    (expectsReport && (operation.actorKind !== 'worker' || operation.actorId === state.rootSessionId)) ||
    (!expectsReport && (operation.actorKind !== 'root' || operation.actorId !== state.rootSessionId))
  ) {
    fail('RECOVERY_REQUIRED', 'operation receipt identity or actor is invalid');
  }
  return readOperationFacts(runtime, operation);
}

export async function readGovernorDecisionReferences(runtime, state, decision, appliedOperations) {
  let event;
  let transition;
  try {
    [event, transition] = await Promise.all([
      runtime.store.readEvent(decision.runId, decision.originEventId),
      runtime.store.readTransition(decision.runId, decision.pendingTransitionId),
    ]);
  } catch (error) {
    fail('RECOVERY_REQUIRED', 'governor receipt references missing or unreadable facts', { code: error?.code ?? 'READ_ERROR' });
  }
  const role = governedTransitionRole(transition);
  const eventTurnId = event.turnId;
  const decisionTurnId = decision.turnId;
  const anchor = appliedOperations.find((operation) => operation.transitionId === transition.transitionId && operation.toRevision <= decision.fromRevision);
  if (
    decision.runId !== state.runId ||
    decision.rootSessionId !== state.rootSessionId ||
    decision.obligationId !== decision.pendingTransitionId ||
    event.eventId !== decision.originEventId ||
    event.conflictEligible !== true ||
    event.event !== decision.hookEvent ||
    event.sessionId !== decision.rootSessionId ||
    eventTurnId !== decisionTurnId ||
    transition.runId !== state.runId ||
    transition.transitionId !== decision.pendingTransitionId ||
    transition.toRevision === undefined ||
    transition.toRevision > decision.fromRevision ||
    role === null ||
    !anchor
  ) {
    fail('RECOVERY_REQUIRED', 'governor receipt conflicts with its durable event or obligation');
  }
  if (decision.hookEvent === 'SessionStart' && event.payloadSummary?.source !== 'resume') {
    fail('RECOVERY_REQUIRED', 'resume interruption receipt lacks a durable resume event');
  }
  if (decision.hookEvent === 'SubagentStop') {
    const bindingRead = await runtime.store.listIdentityBindings(state.runId);
    if (bindingRead.corrupt.length > 0) {
      fail('RECOVERY_REQUIRED', 'worker identity bindings are corrupt');
    }
    const matches = bindingRead.facts.filter(
      (binding) =>
        binding.agentId === decision.agentId &&
        event.agentId === decision.agentId &&
        binding.role === role &&
        binding.rootSessionId === state.rootSessionId &&
        binding.method === 'capability-token-v1' &&
        binding.revokedAt === undefined,
    );
    if (matches.length !== 1) {
      fail('RECOVERY_REQUIRED', 'SubagentStop receipt lacks one authoritative worker binding');
    }
  } else if (event.agentId !== undefined || decision.agentId !== undefined) {
    fail('RECOVERY_REQUIRED', 'root governor receipt contains worker identity');
  }
  return { event, transition, role };
}

export async function readValidatedBindings(runtime, state) {
  const bindingRead = await runtime.store.listIdentityBindings(state.runId);
  if (bindingRead.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'worker identity bindings are corrupt');
  }
  assertIdentityBindingTopology(runtime, bindingRead, state.rootSessionId);
  return bindingRead;
}

export function roleTargetMatches(runtime, role, nodeId, compatibilityKey, compatibilityKeys) {
  return nodeId === `role:${role}` || compatibilityKeys?.has(compatibilityKey) === true;
}

export function detectUnsupportedNativeTargets(runtime, state, bindingRead, operationRead, reportRead, transitionRead) {
  const entries = collectLegacyNativeTargetEntries({
    state,
    operations: operationRead.facts,
    reports: reportRead.facts,
    transitions: transitionRead.facts,
    bindings: bindingRead.facts,
  });
  if (entries.length > 0) {
    fail('UNSUPPORTED_NATIVE_TARGET_HISTORY', 'loop history uses an unsupported native worker target shape');
  }
}

export function bindingForAgent(runtime, bindingRead, state, targetAgentId) {
  const matches = bindingRead.facts.filter(
    (binding) =>
      binding.agentId === targetAgentId &&
      binding.rootSessionId === state.rootSessionId &&
      binding.method === 'capability-token-v1' &&
      binding.revokedAt === undefined,
  );
  if (matches.length !== 1) {
    fail('RECOVERY_REQUIRED', 'operation actor lacks one authoritative worker binding');
  }
  return matches[0];
}

export async function readOperationFacts(runtime, operation) {
  let transition;
  let report = null;
  try {
    transition = await runtime.store.readTransition(operation.runId, operation.transitionId);
    if (operation.reportId) {
      report = await runtime.store.readReport(operation.runId, operation.reportId);
    }
  } catch (error) {
    fail('RECOVERY_REQUIRED', 'operation receipt references missing or unreadable facts', { code: error?.code ?? 'READ_ERROR' });
  }
  const expectsReport = operation.kind === 'report';
  if (
    Boolean(operation.reportId) !== expectsReport ||
    Boolean(report) !== expectsReport ||
    transition.transitionId !== operation.transitionId ||
    transition.runId !== operation.runId ||
    transition.requestId !== operation.requestId ||
    transition.requestDigest !== operation.requestDigest ||
    transition.fromRevision !== operation.fromRevision ||
    transition.toRevision !== operation.toRevision ||
    transition.createdAt !== operation.createdAt ||
    (expectsReport &&
      (report.reportId !== operation.reportId ||
        report.runId !== operation.runId ||
        report.requestId !== operation.requestId ||
        report.requestDigest !== operation.requestDigest ||
        report.fromRevision !== operation.fromRevision ||
        report.toRevision !== operation.toRevision ||
        report.createdAt !== operation.createdAt ||
        transition.originReportId !== operation.reportId)) ||
    (!expectsReport && transition.originReportId !== undefined)
  ) {
    fail('RECOVERY_REQUIRED', 'operation receipt references missing or conflicting facts');
  }
  return { transition, report };
}

export async function mutationResult(runtime, state, definition, operation, duplicate) {
  const { transition, report } = await readOperationFacts(runtime, operation);
  return {
    ...stateSummary(state, definition, duplicate),
    operationId: operation.operationId,
    transition,
    ...(report ? { report } : {}),
  };
}
