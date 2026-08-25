import { buildLegacyNativeTargetEvidence } from '../recovery.mjs';
import { fail } from './errors.mjs';
import { validateDurableControlHistory } from './history-validator.mjs';
import { assertDurableRequestNamespaces, assertIdentityBindingTopology } from './invariants.mjs';

export async function readLegacyRecoveryPlane(runtime, targetRunId) {
  const [state, definition, operationRead, governorDecisionRead, recoveryRead, reportRead, transitionRead, bindingRead, observationRead] = await Promise.all([
    runtime.store.readState(targetRunId),
    runtime.store.readDefinition(targetRunId),
    runtime.store.listOperations(targetRunId),
    runtime.store.listGovernorDecisions(targetRunId),
    runtime.store.listRecoveries(targetRunId),
    runtime.store.listReports(targetRunId),
    runtime.store.listTransitions(targetRunId),
    runtime.store.listIdentityBindings(targetRunId),
    runtime.store.listWorkerObservations(targetRunId),
  ]);
  const reads = [operationRead, governorDecisionRead, recoveryRead, reportRead, transitionRead, bindingRead, observationRead];
  if (reads.some((read) => read.corrupt.length > 0)) {
    fail('HISTORY_CORRUPT', 'legacy recovery history could not be verified');
  }
  assertIdentityBindingTopology(runtime, bindingRead, state.rootSessionId);
  assertDurableRequestNamespaces(runtime, {
    definition,
    operations: operationRead.facts,
    observations: observationRead.facts,
    bindings: bindingRead.facts,
    recoveries: recoveryRead.facts,
  });
  return {
    definition,
    operationRead,
    governorDecisionRead,
    recoveryRead,
    reportRead,
    transitionRead,
    bindingRead,
    observationRead,
  };
}

export function legacyEvidenceFromPlane(runtime, state, plane) {
  return buildLegacyNativeTargetEvidence({
    state,
    definition: plane.definition,
    operations: plane.operationRead.facts,
    governorDecisions: plane.governorDecisionRead.facts,
    transitions: plane.transitionRead.facts,
    reports: plane.reportRead.facts,
    bindings: plane.bindingRead.facts,
  });
}

export async function verifyLegacyEvidence(runtime, state, plane) {
  const evidence = legacyEvidenceFromPlane(runtime, state, plane);
  await validateDurableControlHistory(
    runtime,
    state,
    plane.operationRead,
    plane.governorDecisionRead,
    { facts: [], corrupt: [] },
    {
      reportRead: plane.reportRead,
      transitionRead: plane.transitionRead,
      ...(evidence ? { legacyEvidence: evidence } : {}),
    },
  );
  return evidence;
}

export async function appliedRecoveryVerification(runtime, state, receipt) {
  try {
    const plane = await readLegacyRecoveryPlane(runtime, state.runId);
    await validateDurableControlHistory(runtime, state, plane.operationRead, plane.governorDecisionRead, plane.recoveryRead, {
      reportRead: plane.reportRead,
      transitionRead: plane.transitionRead,
    });
    return state.latestRecoveryId === receipt.recoveryId ? 'verified' : 'quarantined-unverified';
  } catch {
    return 'quarantined-unverified';
  }
}
