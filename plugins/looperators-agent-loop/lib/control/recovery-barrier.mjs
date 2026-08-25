import { digestJson } from '../canonical-json.mjs';
import { SCHEMA_VERSION } from '../contracts.mjs';
import { recoveryIdFor, recoveryRequestDigest, terminalStateForRecovery } from '../recovery.mjs';
import { fail } from './errors.mjs';

export function assertPreparedRecoveryIdentity(runtime, state, receipt, context, input) {
  assertRecoveryReceiptInvariant(runtime, state, receipt);
  if (
    receipt.requestId !== input.requestId ||
    receipt.actorId !== context.rootSessionId ||
    receipt.fromRevision !== input.expectedRevision ||
    receipt.evidenceDigest !== input.expectedEvidenceDigest
  ) {
    fail('REQUEST_ID_CONFLICT', 'legacy recovery request does not match its immutable receipt');
  }
}

export function assertRecoveryReceiptInvariant(runtime, state, receipt) {
  if (
    receipt.recoveryId !== recoveryIdFor(receipt.runId, receipt.requestId) ||
    receipt.runId !== state.runId ||
    receipt.actorKind !== 'root' ||
    receipt.actorId !== state.rootSessionId ||
    receipt.requestDigest !==
      recoveryRequestDigest({
        runId: receipt.runId,
        requestId: receipt.requestId,
        actorId: receipt.actorId,
        expectedRevision: receipt.fromRevision,
        expectedEvidenceDigest: receipt.evidenceDigest,
      })
  ) {
    fail('HISTORY_CORRUPT', 'legacy recovery receipt identity is invalid');
  }
}

export function assertPreparedRecoveryBarrier(runtime, state, recoveryRead, options = {}) {
  if (recoveryRead.corrupt.length > 0) {
    fail('HISTORY_CORRUPT', 'legacy recovery receipt is corrupt');
  }
  if (recoveryRead.facts.length > 1) {
    fail('RECOVERY_REQUIRED', 'multiple legacy recovery receipts exist for one run');
  }
  const receipt = recoveryRead.facts[0];
  if (!receipt) {
    return;
  }
  assertRecoveryReceiptInvariant(runtime, state, receipt);
  if (state.latestRecoveryId === receipt.recoveryId && state.revision === receipt.toRevision) {
    if (digestJson(state) !== receipt.terminalStateDigest) {
      fail('HISTORY_CORRUPT', 'quarantined state does not match its recovery receipt');
    }
    return;
  }
  if (state.revision !== receipt.fromRevision || digestJson(state) !== receipt.priorStateDigest) {
    fail('LEGACY_RECOVERY_ORPHANED', 'prepared legacy recovery no longer matches durable state');
  }
  if (digestJson(terminalStateForRecovery(state, receipt)) !== receipt.terminalStateDigest) {
    fail('HISTORY_CORRUPT', 'prepared legacy recovery terminal state is invalid');
  }
  if ((options.normalPreparedCount ?? 0) > 0) {
    fail('RECOVERY_REQUIRED', 'legacy recovery competes with another prepared receipt');
  }
  fail('LEGACY_RECOVERY_PENDING', 'a legacy recovery receipt awaits explicit confirmation');
}

export function legacyRecoveryResult(runtime, state, receipt, duplicate, verification) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    status: state.status,
    revision: state.revision,
    recoveryId: receipt.recoveryId,
    duplicate,
    verification,
  };
}
