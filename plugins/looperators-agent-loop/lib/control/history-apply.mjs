import { canonicalJson, compareCodePoints } from '../canonical-json.mjs';
import { assertContract, validateGovernorDecision } from '../contracts.mjs';
import { fail } from './errors.mjs';
import { readAndValidateDefinition, readAndValidateOperation, readGovernorDecisionReferences, readValidatedBindings } from './history-facts.mjs';
import { validateDurableControlHistory } from './history-validator.mjs';
import { nextStateForGovernorDecision, nextStateForOperation } from './state-reducer.mjs';

export async function rollForwardPrepared(runtime, initialState) {
  let state = initialState;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const [operationRead, governorDecisionRead, recoveryRead, reportRead, transitionRead] = await Promise.all([
      runtime.store.listOperations(state.runId),
      runtime.store.listGovernorDecisions(state.runId),
      runtime.store.listRecoveries(state.runId),
      runtime.store.listReports(state.runId),
      runtime.store.listTransitions(state.runId),
    ]);
    if (operationRead.corrupt.length > 0 || governorDecisionRead.corrupt.length > 0 || reportRead.corrupt.length > 0 || transitionRead.corrupt.length > 0) {
      fail('RECOVERY_REQUIRED', 'prepared receipts are corrupt');
    }
    if (recoveryRead.corrupt.length > 0) {
      fail('HISTORY_CORRUPT', 'legacy recovery receipt is corrupt');
    }
    await validateDurableControlHistory(runtime, state, operationRead, governorDecisionRead, recoveryRead, { reportRead, transitionRead });
    const prepared = [
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
    ]
      .filter(({ receipt }) => receipt.fromRevision === state.revision)
      .sort((left, right) => compareCodePoints(left.id, right.id));
    if (prepared.length === 0) {
      return state;
    }
    if (prepared.length > 1) {
      fail('RECOVERY_REQUIRED', 'multiple prepared receipts target the same revision');
    }
    const [next] = prepared;
    state = next.kind === 'operation' ? await applyOperation(runtime, state, next.receipt) : await applyGovernorDecision(runtime, state, next.receipt);
  }
  fail('RECOVERY_REQUIRED', 'prepared receipt chain exceeds the recovery bound');
}

export async function applyOperation(runtime, state, operation) {
  if (state.runId !== operation.runId) {
    fail('RECOVERY_REQUIRED', 'operation receipt belongs to a different run');
  }
  const facts = await readAndValidateOperation(runtime, operation, state);
  if (state.revision >= operation.toRevision) {
    return state;
  }
  const [definition, bindingRead] = await Promise.all([readAndValidateDefinition(runtime, state), readValidatedBindings(runtime, state)]);
  const next = await nextStateForOperation(runtime, state, operation, facts, definition, bindingRead);
  return runtime.store.compareAndSwapState(state.runId, state.revision, next);
}

export async function applyGovernorDecision(runtime, state, decisionValue) {
  const decision = assertContract('governor decision', decisionValue, validateGovernorDecision);
  let durable;
  try {
    durable = await runtime.store.readGovernorDecision(decision.runId, decision.decisionId);
  } catch (error) {
    fail('RECOVERY_REQUIRED', 'governor receipt is missing or unreadable', { code: error?.code ?? 'READ_ERROR' });
  }
  if (canonicalJson(durable) !== canonicalJson(decision)) {
    fail('RECOVERY_REQUIRED', 'governor receipt conflicts with the prepared decision');
  }
  await readAndValidateDefinition(runtime, state);
  const operationRead = await runtime.store.listOperations(state.runId);
  if (operationRead.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'operation receipts are corrupt');
  }
  await readGovernorDecisionReferences(
    runtime,
    state,
    decision,
    operationRead.facts.filter((operation) => operation.toRevision <= state.revision),
  );
  if (state.runId !== decision.runId || state.rootSessionId !== decision.rootSessionId || decision.obligationId !== decision.pendingTransitionId) {
    fail('RECOVERY_REQUIRED', 'governor receipt belongs to a different run or root');
  }
  if (state.revision >= decision.toRevision) {
    return state;
  }
  if (state.revision !== decision.fromRevision || state.pendingTransitionId !== decision.pendingTransitionId) {
    fail('RECOVERY_REQUIRED', 'governor receipt does not match durable state');
  }
  const next = nextStateForGovernorDecision(runtime, state, decision);
  return runtime.store.compareAndSwapState(state.runId, state.revision, next);
}
