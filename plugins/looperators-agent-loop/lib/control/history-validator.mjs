import { canonicalJson, compareCodePoints } from '../canonical-json.mjs';
import { collectLegacyNativeTargetEntries, legacyEntryKey } from '../recovery.mjs';
import { fail } from './errors.mjs';
import { readAndValidateDefinition, readAndValidateOperation, readGovernorDecisionReferences, readValidatedBindings } from './history-facts.mjs';
import { assertDurableRequestNamespaces } from './invariants.mjs';
import { assertPreparedRecoveryBarrier } from './recovery-barrier.mjs';
import { initialReplayState, nextStateForGovernorDecision, nextStateForOperation, nextStateForRecovery } from './state-reducer.mjs';
import { governedTransitionRole } from './state.mjs';

export async function validateDurableControlHistory(
  runtime,
  state,
  operationRead,
  governorDecisionRead,
  recoveryRead = { facts: [], corrupt: [] },
  options = {},
) {
  const definition = await readAndValidateDefinition(runtime, state);
  const bindingRead = await readValidatedBindings(runtime, state);
  const observationRead = options.observationRead ?? (await runtime.store.listWorkerObservations(state.runId));
  if (observationRead.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'worker observation receipts are corrupt');
  }
  if (recoveryRead.corrupt.length > 0) {
    fail('HISTORY_CORRUPT', 'legacy recovery receipts are corrupt');
  }
  if (recoveryRead.facts.length > 1) {
    fail('RECOVERY_REQUIRED', 'multiple legacy recovery receipts exist for one run');
  }
  assertDurableRequestNamespaces(runtime, {
    definition,
    operations: operationRead.facts,
    observations: observationRead.facts,
    bindings: bindingRead.facts,
    recoveries: recoveryRead.facts,
  });
  assertPreparedRecoveryBarrier(runtime, state, recoveryRead, {
    normalPreparedCount: [...operationRead.facts, ...governorDecisionRead.facts].filter((receipt) => receipt.fromRevision === state.revision).length,
  });
  for (const receipt of recoveryRead.facts) {
    let durable;
    try {
      durable = await runtime.store.readRecovery(state.runId, receipt.recoveryId);
    } catch (error) {
      fail('HISTORY_CORRUPT', 'legacy recovery receipt is missing or unreadable', { code: error?.code ?? 'READ_ERROR' });
    }
    if (
      canonicalJson(durable) !== canonicalJson(receipt) ||
      receipt.runId !== state.runId ||
      receipt.actorKind !== 'root' ||
      receipt.fromRevision > state.revision
    ) {
      fail('HISTORY_CORRUPT', 'legacy recovery receipt identity is unstable');
    }
  }
  const operationFacts = new Map();
  for (const operation of operationRead.facts) {
    if (operation.fromRevision > state.revision) {
      fail('RECOVERY_REQUIRED', 'operation receipt is ahead of durable state');
    }
    operationFacts.set(operation.operationId, await readAndValidateOperation(runtime, operation, state));
  }
  const appliedOperationReceipts = operationRead.facts.filter((operation) => operation.toRevision <= state.revision);
  for (const decision of governorDecisionRead.facts) {
    if (decision.fromRevision > state.revision) {
      fail('RECOVERY_REQUIRED', 'governor receipt is ahead of durable state');
    }
    let durable;
    try {
      durable = await runtime.store.readGovernorDecision(state.runId, decision.decisionId);
    } catch (error) {
      fail('RECOVERY_REQUIRED', 'governor receipt is missing or unreadable', { code: error?.code ?? 'READ_ERROR' });
    }
    if (canonicalJson(durable) !== canonicalJson(decision)) {
      fail('RECOVERY_REQUIRED', 'governor receipt identity is unstable');
    }
    await readGovernorDecisionReferences(runtime, state, decision, appliedOperationReceipts);
  }

  const receipts = [
    ...operationRead.facts.map((receipt) => ({
      kind: 'operation',
      id: receipt.operationId,
      receipt,
    })),
    ...governorDecisionRead.facts.map((receipt) => ({
      kind: 'governor-decision',
      id: receipt.decisionId,
      receipt,
    })),
    ...recoveryRead.facts.map((receipt) => ({
      kind: 'recovery',
      id: receipt.recoveryId,
      receipt,
    })),
  ];
  const applied = receipts.filter(({ receipt }) => receipt.toRevision <= state.revision);
  const appliedByRevision = new Map();
  for (const item of applied) {
    const revision = item.receipt.fromRevision;
    const values = appliedByRevision.get(revision) ?? [];
    values.push(item);
    appliedByRevision.set(revision, values);
  }
  for (let revision = 0; revision < state.revision; revision += 1) {
    const matches = (appliedByRevision.get(revision) ?? []).filter(({ receipt }) => receipt.toRevision === revision + 1);
    if (matches.length !== 1) {
      fail('RECOVERY_REQUIRED', 'durable control receipt history has a gap or collision', { revision, receipts: matches.length });
    }
  }

  let replay = initialReplayState(runtime, state, definition);
  const transitionFacts = options.transitionRead?.facts ?? [...operationFacts.values()].map(({ transition }) => transition);
  const reportFacts = options.reportRead?.facts ?? [...operationFacts.values()].map(({ report }) => report).filter(Boolean);
  const appliedRecovery = recoveryRead.facts.find((receipt) => receipt.toRevision <= state.revision);
  const compatibilityEntries =
    options.legacyEvidence?.entries ??
    (appliedRecovery
      ? collectLegacyNativeTargetEntries({
          state,
          operations: operationRead.facts,
          transitions: transitionFacts,
          reports: reportFacts,
          bindings: bindingRead.facts,
        })
      : []);
  const compatibilityKeys = options.legacyEvidence || appliedRecovery ? new Set(compatibilityEntries.map(legacyEntryKey)) : undefined;
  for (let revision = 0; revision < state.revision; revision += 1) {
    const [item] = (appliedByRevision.get(revision) ?? []).filter(({ receipt }) => receipt.toRevision === revision + 1);
    if (item.kind === 'operation') {
      replay = await nextStateForOperation(runtime, replay, item.receipt, operationFacts.get(item.receipt.operationId), definition, bindingRead, {
        compatibilityKeys,
      });
    } else if (item.kind === 'governor-decision') {
      replay = nextStateForGovernorDecision(runtime, replay, item.receipt);
    } else {
      replay = nextStateForRecovery(runtime, replay, item.receipt, {
        definition,
        operations: operationRead.facts,
        governorDecisions: governorDecisionRead.facts,
        transitions: transitionFacts,
        reports: reportFacts,
        bindings: bindingRead.facts,
        entries: compatibilityEntries,
      });
    }
  }
  if (canonicalJson(replay) !== canonicalJson(state)) {
    fail('RECOVERY_REQUIRED', 'durable state does not equal deterministic receipt replay');
  }
  const prepared = receipts.filter(({ receipt }) => receipt.fromRevision === state.revision);
  if (prepared.length > 1) {
    fail('RECOVERY_REQUIRED', 'durable control history has competing prepared receipts');
  }
  for (const item of prepared) {
    if (item.receipt.toRevision !== state.revision + 1) {
      fail('RECOVERY_REQUIRED', 'prepared receipt has an invalid target revision');
    }
    if (item.kind === 'operation') {
      await nextStateForOperation(runtime, replay, item.receipt, operationFacts.get(item.receipt.operationId), definition, bindingRead, { compatibilityKeys });
    } else if (item.kind === 'governor-decision') {
      nextStateForGovernorDecision(runtime, replay, item.receipt);
    } else {
      fail('LEGACY_RECOVERY_PENDING', 'a legacy recovery receipt awaits explicit confirmation');
    }
  }

  const appliedOperations = appliedOperationReceipts.sort(
    (left, right) => left.toRevision - right.toRevision || compareCodePoints(left.operationId, right.operationId),
  );
  const appliedDecisions = governorDecisionRead.facts
    .filter((decision) => decision.toRevision <= state.revision)
    .sort((left, right) => left.toRevision - right.toRevision || compareCodePoints(left.decisionId, right.decisionId));
  const expectedOperationId = appliedOperations.at(-1)?.operationId;
  const expectedDecisionId = appliedDecisions.at(-1)?.decisionId;
  const appliedRecoveries = recoveryRead.facts
    .filter((receipt) => receipt.toRevision <= state.revision)
    .sort((left, right) => left.toRevision - right.toRevision || compareCodePoints(left.recoveryId, right.recoveryId));
  const expectedRecoveryId = appliedRecoveries.at(-1)?.recoveryId;
  if (
    state.latestOperationId !== expectedOperationId ||
    state.latestGovernorDecisionId !== expectedDecisionId ||
    state.latestRecoveryId !== expectedRecoveryId
  ) {
    fail('RECOVERY_REQUIRED', 'durable state points to missing or stale control receipts');
  }
  const expectedReportId = [...appliedOperations].reverse().find((operation) => operation.reportId)?.reportId;
  if (state.latestReportId !== expectedReportId) {
    fail('RECOVERY_REQUIRED', 'durable state points to a missing or stale report');
  }

  const blocks = appliedDecisions
    .filter((decision) => decision.action === 'block')
    .sort((left, right) => left.leaseEpoch - right.leaseEpoch || compareCodePoints(left.decisionId, right.decisionId));
  if (blocks.length !== state.continuationLease.consumed || blocks.some((decision, index) => decision.leaseEpoch !== index + 1)) {
    fail('RECOVERY_REQUIRED', 'continuation lease does not match applied decision receipts');
  }

  if (state.pendingTransitionId) {
    const anchors = appliedOperations.filter((operation) => operation.transitionId === state.pendingTransitionId);
    const transition = anchors.length === 1 ? operationFacts.get(anchors[0].operationId)?.transition : null;
    if (!transition || governedTransitionRole(transition) === null || transition.lap !== state.currentLap) {
      fail('RECOVERY_REQUIRED', 'pending transition is not anchored in applied operation history');
    }
  }
  return {
    definition,
    bindingRead,
    operationFacts,
    appliedOperations,
    appliedDecisions,
    appliedRecoveries,
  };
}
