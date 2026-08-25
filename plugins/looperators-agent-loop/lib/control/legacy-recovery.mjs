import { digestJson } from '../canonical-json.mjs';
import { SCHEMA_VERSION } from '../contracts.mjs';
import { createLegacyQuarantineReceipt, terminalStateForRecovery } from '../recovery.mjs';
import { ROOT_CONTROL_STATUSES } from './constants.mjs';
import { fail } from './errors.mjs';
import { validateDurableControlHistory } from './history-validator.mjs';
import { assertRootContext, requestId, runId } from './input.mjs';
import { assertRequestNamespace, assertRoot, readRequestNamespacePlane } from './invariants.mjs';
import { assertPreparedRecoveryIdentity, assertRecoveryReceiptInvariant, legacyRecoveryResult } from './recovery-barrier.mjs';
import { appliedRecoveryVerification, legacyEvidenceFromPlane, readLegacyRecoveryPlane, verifyLegacyEvidence } from './recovery-plane.mjs';

export async function previewLegacyRecovery(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  return runtime.store.withControlLock(targetRunId, async () => {
    const state = await runtime.store.readState(targetRunId);
    assertRoot(runtime, state, context);
    const plane = await readLegacyRecoveryPlane(runtime, targetRunId);
    if (plane.recoveryRead.facts.length > 1) {
      fail('RECOVERY_REQUIRED', 'multiple legacy recovery receipts exist for one run');
    }
    const receipt = plane.recoveryRead.facts[0];
    if (receipt) {
      assertRecoveryReceiptInvariant(runtime, state, receipt);
      if (state.latestRecoveryId === receipt.recoveryId && state.revision === receipt.toRevision && digestJson(state) === receipt.terminalStateDigest) {
        await validateDurableControlHistory(runtime, state, plane.operationRead, plane.governorDecisionRead, plane.recoveryRead, {
          reportRead: plane.reportRead,
          transitionRead: plane.transitionRead,
        });
        return {
          schemaVersion: SCHEMA_VERSION,
          runId: targetRunId,
          eligible: false,
          quarantined: true,
          pendingRecovery: false,
          revision: state.revision,
          legacyFactCount: receipt.legacyFactCount,
          evidenceDigest: receipt.evidenceDigest,
          terminalStatus: 'failed',
          warningCode: 'LEGACY_HISTORY_ALREADY_QUARANTINED',
        };
      }
      if (state.revision !== receipt.fromRevision || digestJson(state) !== receipt.priorStateDigest) {
        fail('LEGACY_RECOVERY_ORPHANED', 'prepared legacy recovery no longer matches durable state');
      }
      if (digestJson(terminalStateForRecovery(state, receipt)) !== receipt.terminalStateDigest) {
        fail('HISTORY_CORRUPT', 'prepared legacy recovery terminal state is invalid');
      }
      let evidenceMatches = false;
      try {
        const current = legacyEvidenceFromPlane(runtime, state, plane);
        evidenceMatches = current?.evidenceDigest === receipt.evidenceDigest && current.entries.length === receipt.legacyFactCount;
      } catch {
        evidenceMatches = false;
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        runId: targetRunId,
        eligible: true,
        quarantined: false,
        pendingRecovery: true,
        revision: state.revision,
        legacyFactCount: receipt.legacyFactCount,
        evidenceDigest: receipt.evidenceDigest,
        evidenceMatches,
        terminalStatus: 'failed',
        warningCode: 'LEGACY_RECOVERY_CONFIRM_REQUIRED',
      };
    }
    if (!ROOT_CONTROL_STATUSES.has(state.status)) {
      fail('INVALID_STATE_TRANSITION', 'only a non-terminal run can enter legacy quarantine');
    }
    const evidence = await verifyLegacyEvidence(runtime, state, plane);
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: targetRunId,
      eligible: Boolean(evidence),
      quarantined: false,
      pendingRecovery: false,
      revision: state.revision,
      legacyFactCount: evidence?.entries.length ?? 0,
      ...(evidence ? { evidenceDigest: evidence.evidenceDigest } : {}),
      terminalStatus: 'failed',
      warningCode: evidence ? 'LEGACY_HISTORY_QUARANTINE_AVAILABLE' : 'NO_LEGACY_NATIVE_TARGET_HISTORY',
    };
  });
}

export async function quarantineLegacy(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  const targetRequestId = requestId(input?.requestId);
  const expectedRevision = input?.expectedRevision;
  const expectedEvidenceDigest = input?.expectedEvidenceDigest;
  if (
    input?.confirm !== true ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0 ||
    typeof expectedEvidenceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedEvidenceDigest)
  ) {
    fail('INVALID_TOOL_INPUT', 'legacy quarantine confirmation is invalid');
  }
  return runtime.store.withControlLock(targetRunId, async () => {
    let state = await runtime.store.readState(targetRunId);
    assertRoot(runtime, state, context);
    const namespacePlane = await readRequestNamespacePlane(runtime, targetRunId);
    const { recoveryRead } = namespacePlane;
    if (recoveryRead.facts.length > 1) {
      fail('RECOVERY_REQUIRED', 'multiple legacy recovery receipts exist for one run');
    }
    const existing = recoveryRead.facts[0];
    if (existing) {
      assertPreparedRecoveryIdentity(runtime, state, existing, context, {
        requestId: targetRequestId,
        expectedRevision,
        expectedEvidenceDigest,
      });
      if (state.latestRecoveryId === existing.recoveryId && state.revision === existing.toRevision) {
        if (digestJson(state) !== existing.terminalStateDigest) {
          fail('HISTORY_CORRUPT', 'quarantined state does not match its recovery receipt');
        }
        return legacyRecoveryResult(runtime, state, existing, true, await appliedRecoveryVerification(runtime, state, existing));
      }
      if (state.revision !== existing.fromRevision || digestJson(state) !== existing.priorStateDigest) {
        fail('LEGACY_RECOVERY_ORPHANED', 'prepared legacy recovery no longer matches durable state');
      }
      let verified = false;
      try {
        const plane = await readLegacyRecoveryPlane(runtime, targetRunId);
        const evidence = legacyEvidenceFromPlane(runtime, state, plane);
        verified = evidence?.evidenceDigest === existing.evidenceDigest && evidence.entries.length === existing.legacyFactCount;
      } catch {
        verified = false;
      }
      const next = terminalStateForRecovery(state, existing);
      if (digestJson(next) !== existing.terminalStateDigest) {
        fail('HISTORY_CORRUPT', 'prepared recovery terminal state is invalid');
      }
      state = await runtime.store.compareAndSwapState(targetRunId, state.revision, next);
      await runtime.fault('afterRecoveryCas', {
        runId: targetRunId,
        requestId: targetRequestId,
      });
      return legacyRecoveryResult(runtime, state, existing, false, verified ? 'verified' : 'quarantined-unverified');
    }

    if (state.revision !== expectedRevision || !ROOT_CONTROL_STATUSES.has(state.status)) {
      fail('STALE_RECOVERY_PREVIEW', 'legacy recovery preview no longer matches durable state');
    }
    const plane = await readLegacyRecoveryPlane(runtime, targetRunId);
    assertRequestNamespace(runtime, targetRequestId, 'recoveries', {
      definition: plane.definition,
      operations: plane.operationRead.facts,
      observations: plane.observationRead.facts,
      bindings: plane.bindingRead.facts,
      recoveries: plane.recoveryRead.facts,
    });
    const normalPrepared = [...plane.operationRead.facts, ...plane.governorDecisionRead.facts].filter((receipt) => receipt.fromRevision === state.revision);
    if (normalPrepared.length > 0) {
      fail('RECOVERY_REQUIRED', 'legacy recovery competes with a prepared control receipt');
    }
    const evidence = await verifyLegacyEvidence(runtime, state, plane);
    if (!evidence) {
      fail('NO_LEGACY_NATIVE_TARGET_HISTORY', 'run has no eligible legacy native-target history');
    }
    if (evidence.evidenceDigest !== expectedEvidenceDigest) {
      fail('STALE_RECOVERY_PREVIEW', 'legacy recovery evidence changed after preview');
    }
    const receipt = createLegacyQuarantineReceipt({
      state,
      requestId: targetRequestId,
      actorId: context.rootSessionId,
      evidence,
      createdAt: runtime.now(),
    });
    const published = await runtime.store.putRecovery(targetRunId, receipt);
    if (published.status === 'conflict') {
      fail('REQUEST_ID_CONFLICT', 'legacy recovery receipt conflicts with this request');
    }
    if (published.status === 'limit') {
      fail('FACT_LIMIT_REACHED', 'legacy recovery receipt capacity was reached before publication');
    }
    if (!['created', 'duplicate'].includes(published.status)) {
      fail('RECOVERY_REQUIRED', 'legacy recovery receipt could not be published');
    }
    await runtime.fault('afterRecoveryReceipt', {
      runId: targetRunId,
      requestId: targetRequestId,
    });
    const next = terminalStateForRecovery(state, receipt);
    state = await runtime.store.compareAndSwapState(targetRunId, state.revision, next);
    await runtime.fault('afterRecoveryCas', {
      runId: targetRunId,
      requestId: targetRequestId,
    });
    return legacyRecoveryResult(runtime, state, receipt, false, 'verified');
  });
}
