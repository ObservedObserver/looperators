import { digestJson } from '../canonical-json.mjs';
import { ACTIVE_RUN_STATUSES } from '../contracts.mjs';
import { buildLegacyNativeTargetEvidence, recoveryIdFor, recoveryRequestDigest, terminalStateForRecovery } from '../recovery.mjs';
import { ROOT_CONTROL_STATUSES } from './constants.mjs';
import { fail } from './errors.mjs';
import { bindingForAgent, roleTargetMatches } from './history-facts.mjs';
import { factLimitRequestId, mutationRequestDigest, reportPayload } from './identifiers.mjs';
import { governedTransitionRole, withoutPending } from './state.mjs';

export function initialReplayState(runtime, state, definition) {
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    rootSessionId: state.rootSessionId,
    originatingTurnId: state.originatingTurnId,
    scope: state.scope,
    masterNode: state.masterNode,
    recipe: state.recipe,
    status: 'draft',
    currentLap: 0,
    continuationLease: {
      granted: definition.lapCap,
      consumed: 0,
    },
    cancelRequested: false,
    revision: 0,
    createdAt: definition.createdAt,
    updatedAt: definition.createdAt,
  };
}

export async function nextStateForOperation(runtime, state, operation, facts, definition, bindingRead, options = {}) {
  const { transition, report } = facts;
  if (state.runId !== operation.runId || state.revision !== operation.fromRevision || operation.toRevision !== state.revision + 1) {
    fail('RECOVERY_REQUIRED', 'operation revision does not match replay state');
  }
  const expectedDigest = mutationRequestDigest({
    kind: operation.kind,
    runId: operation.runId,
    requestId: operation.requestId,
    actorKind: operation.actorKind,
    actorId: operation.actorId,
    payload: report ? reportPayload(report) : {},
  });
  if (operation.requestDigest !== expectedDigest) {
    fail('RECOVERY_REQUIRED', 'operation request digest is not reproducible');
  }
  const transitionMatches = (expected) =>
    transition.kind === expected.kind &&
    transition.fromNode === expected.fromNode &&
    transition.lap === expected.lap &&
    (expected.toRole
      ? roleTargetMatches(runtime, expected.toRole, transition.toNode, `transition:${transition.transitionId}:toNode`, options.compatibilityKeys)
      : transition.toNode === expected.toNode);
  const reportRouteMatches = (expectedRole = null) =>
    report?.fromNode === operation.actorId &&
    report?.receiver === 'root-master' &&
    (expectedRole
      ? report.routedToNode === transition.toNode &&
        roleTargetMatches(runtime, expectedRole, report.routedToNode, `report:${report.reportId}:routedToNode`, options.compatibilityKeys)
      : report?.routedToNode === undefined);
  let next = {
    ...state,
    revision: operation.toRevision,
    updatedAt: operation.createdAt,
    latestOperationId: operation.operationId,
  };

  if (operation.kind === 'start') {
    if (
      state.status !== 'draft' ||
      state.currentLap !== 0 ||
      report !== null ||
      !transitionMatches({
        kind: 'activate-implementer',
        fromNode: state.masterNode,
        toRole: 'implementer',
        lap: 0,
      })
    ) {
      fail('RECOVERY_REQUIRED', 'start receipt has invalid transition semantics');
    }
    return {
      ...next,
      status: 'running',
      pendingTransitionId: transition.transitionId,
    };
  }

  if (operation.kind === 'report') {
    if (state.status !== 'running' || !state.pendingTransitionId || report === null) {
      fail('RECOVERY_REQUIRED', 'report receipt does not match an active obligation');
    }
    let pending;
    try {
      pending = await runtime.store.readTransition(state.runId, state.pendingTransitionId);
    } catch (error) {
      fail('RECOVERY_REQUIRED', 'report receipt references an unreadable prior obligation', { code: error?.code ?? 'READ_ERROR' });
    }
    const binding = bindingForAgent(runtime, bindingRead, state, operation.actorId);
    const pendingRole = governedTransitionRole(pending);
    if (pendingRole === null || binding.role !== pendingRole) {
      fail('RECOVERY_REQUIRED', 'report actor does not own the replayed obligation');
    }
    if (binding.role === 'implementer') {
      if (
        report.type !== 'info' ||
        report.status !== 'done' ||
        report.verdict !== undefined ||
        report.issues !== undefined ||
        !transitionMatches({
          kind: 'activate-reviewer',
          fromNode: operation.actorId,
          toRole: 'reviewer',
          lap: state.currentLap,
        }) ||
        !reportRouteMatches('reviewer')
      ) {
        fail('RECOVERY_REQUIRED', 'implementer report has invalid transition semantics');
      }
      return {
        ...next,
        currentLap: transition.lap,
        pendingTransitionId: transition.transitionId,
        latestReportId: report.reportId,
      };
    }

    if (report.type !== 'verdict' || !['clean', 'issues'].includes(report.verdict) || report.status !== undefined) {
      fail('RECOVERY_REQUIRED', 'reviewer report has invalid typed semantics');
    }
    if (report.verdict === 'clean') {
      if (
        !transitionMatches({
          kind: 'succeed',
          fromNode: operation.actorId,
          toNode: state.masterNode,
          lap: state.currentLap,
        }) ||
        !reportRouteMatches()
      ) {
        fail('RECOVERY_REQUIRED', 'clean verdict has invalid transition semantics');
      }
      return {
        ...withoutPending(next),
        status: 'succeeded',
        latestReportId: report.reportId,
      };
    }
    if (!Array.isArray(report.issues) || report.issues.length === 0) {
      fail('RECOVERY_REQUIRED', 'issues verdict lacks typed issues');
    }
    if (state.currentLap + 1 > definition.lapCap) {
      if (
        !transitionMatches({
          kind: 'cap',
          fromNode: operation.actorId,
          toNode: state.masterNode,
          lap: state.currentLap,
        }) ||
        !reportRouteMatches()
      ) {
        fail('RECOVERY_REQUIRED', 'lap-cap verdict has invalid transition semantics');
      }
      return {
        ...withoutPending(next),
        status: 'capped',
        latestReportId: report.reportId,
      };
    }
    if (
      !transitionMatches({
        kind: 'activate-implementer',
        fromNode: operation.actorId,
        toRole: 'implementer',
        lap: state.currentLap + 1,
      }) ||
      !reportRouteMatches('implementer')
    ) {
      fail('RECOVERY_REQUIRED', 'issues verdict has invalid transition semantics');
    }
    return {
      ...next,
      currentLap: transition.lap,
      pendingTransitionId: transition.transitionId,
      latestReportId: report.reportId,
    };
  }

  if (report !== null) {
    fail('RECOVERY_REQUIRED', 'non-report operation unexpectedly references a report');
  }
  const rootTransitionMatches = (kind) =>
    transitionMatches({
      kind,
      fromNode: state.masterNode,
      toNode: state.masterNode,
      lap: state.currentLap,
    });
  switch (operation.kind) {
    case 'pause':
      if (!['running', 'interrupted'].includes(state.status) || !rootTransitionMatches('pause')) {
        fail('RECOVERY_REQUIRED', 'pause receipt has invalid transition semantics');
      }
      return { ...next, status: 'paused' };
    case 'resume':
      if (!['paused', 'interrupted'].includes(state.status) || !rootTransitionMatches('resume')) {
        fail('RECOVERY_REQUIRED', 'resume receipt has invalid transition semantics');
      }
      return {
        ...next,
        status: 'running',
        needsHuman: false,
      };
    case 'cancel':
      if (!ROOT_CONTROL_STATUSES.has(state.status) || !rootTransitionMatches('cancel')) {
        fail('RECOVERY_REQUIRED', 'cancel receipt has invalid transition semantics');
      }
      return {
        ...withoutPending(next),
        status: 'cancelled',
        cancelRequested: true,
      };
    case 'interrupt':
      if (
        operation.requestId !== factLimitRequestId(operation.fromRevision) ||
        !ACTIVE_RUN_STATUSES.has(state.status) ||
        (state.status === 'interrupted' && state.needsHuman === true) ||
        !rootTransitionMatches('interrupt')
      ) {
        fail('RECOVERY_REQUIRED', 'fact-limit interruption receipt has invalid semantics');
      }
      return {
        ...next,
        status: 'interrupted',
        needsHuman: true,
      };
    default:
      fail('RECOVERY_REQUIRED', 'operation kind is unsupported during replay');
  }
}

export function nextStateForGovernorDecision(runtime, state, decision) {
  if (
    state.runId !== decision.runId ||
    state.rootSessionId !== decision.rootSessionId ||
    state.revision !== decision.fromRevision ||
    decision.toRevision !== state.revision + 1 ||
    state.pendingTransitionId !== decision.pendingTransitionId ||
    decision.obligationId !== decision.pendingTransitionId
  ) {
    fail('RECOVERY_REQUIRED', 'governor receipt does not match replay state');
  }
  let next = {
    ...state,
    revision: decision.toRevision,
    updatedAt: decision.createdAt,
    latestGovernorDecisionId: decision.decisionId,
  };
  switch (decision.action) {
    case 'block':
      if (state.status !== 'running' || decision.leaseEpoch !== state.continuationLease.consumed + 1 || decision.leaseEpoch > state.continuationLease.granted) {
        fail('RECOVERY_REQUIRED', 'continuation receipt has an invalid lease epoch');
      }
      return {
        ...next,
        continuationLease: {
          ...state.continuationLease,
          consumed: decision.leaseEpoch,
        },
      };
    case 'cap':
      if (state.status !== 'running' || state.continuationLease.consumed < state.continuationLease.granted) {
        fail('RECOVERY_REQUIRED', 'cap receipt does not match an exhausted lease');
      }
      return {
        ...withoutPending(next),
        status: 'capped',
        needsHuman: true,
      };
    case 'interrupt':
      if (state.status !== 'running') {
        fail('RECOVERY_REQUIRED', 'interrupt receipt does not match a running state');
      }
      return {
        ...next,
        status: 'interrupted',
        needsHuman: true,
      };
    default:
      fail('RECOVERY_REQUIRED', 'governor receipt action is unsupported');
  }
}

export function nextStateForRecovery(runtime, state, receipt, context) {
  if (
    state.runId !== receipt.runId ||
    state.rootSessionId !== receipt.actorId ||
    state.revision !== receipt.fromRevision ||
    receipt.toRevision !== state.revision + 1 ||
    receipt.recoveryId !== recoveryIdFor(receipt.runId, receipt.requestId) ||
    receipt.requestDigest !==
      recoveryRequestDigest({
        runId: receipt.runId,
        requestId: receipt.requestId,
        actorId: receipt.actorId,
        expectedRevision: receipt.fromRevision,
        expectedEvidenceDigest: receipt.evidenceDigest,
      }) ||
    !ROOT_CONTROL_STATUSES.has(state.status) ||
    digestJson(state) !== receipt.priorStateDigest
  ) {
    fail('HISTORY_CORRUPT', 'legacy recovery receipt does not match its prior state');
  }
  const evidence = buildLegacyNativeTargetEvidence({
    state,
    definition: context.definition,
    operations: context.operations,
    governorDecisions: context.governorDecisions,
    transitions: context.transitions,
    reports: context.reports,
    bindings: context.bindings,
    entries: context.entries,
  });
  if (!evidence || evidence.evidenceDigest !== receipt.evidenceDigest || evidence.entries.length !== receipt.legacyFactCount) {
    fail('HISTORY_CORRUPT', 'legacy recovery evidence no longer matches its immutable receipt');
  }
  const next = terminalStateForRecovery(state, receipt);
  if (digestJson(next) !== receipt.terminalStateDigest) {
    fail('HISTORY_CORRUPT', 'legacy recovery terminal state digest is invalid');
  }
  return next;
}
