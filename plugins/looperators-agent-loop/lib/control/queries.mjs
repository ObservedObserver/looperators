import { canonicalJson, compareCodePoints } from '../canonical-json.mjs';
import { buildAgentLoopProjection } from '../projection.mjs';
import { currentRoleCapability } from './capabilities.mjs';
import { fail } from './errors.mjs';
import { detectUnsupportedNativeTargets } from './history-facts.mjs';
import { validateDurableControlHistory } from './history-validator.mjs';
import { readIdentityPlane } from './identity-plane.mjs';
import { assertRootContext, runId } from './input.mjs';
import { assertDurableRequestNamespaces, assertRoot } from './invariants.mjs';
import { assertPreparedRecoveryBarrier } from './recovery-barrier.mjs';
import { maybeRead, stateSummary } from './state.mjs';

export async function getLoop(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await snapshotForRun(runtime, targetRunId, {
      rootContext: context,
    });
    const state = await runtime.store.readState(targetRunId);
    assertRoot(runtime, state, context);
    const definition = await runtime.store.readDefinition(targetRunId);
    const roleCapability = await currentRoleCapability(runtime, state);
    const identityPlane = await runtime.store.withWorkerObservationSnapshotLock(targetRunId, () =>
      readIdentityPlane(runtime, targetRunId, context.rootSessionId),
    );
    const { bindingRead, observedRead, snapshot } = identityPlane;
    const roleByAgentId = new Map(bindingRead.facts.map((binding) => [binding.agentId, binding.role]));
    const pendingTransition = state.pendingTransitionId ? await maybeRead(() => runtime.store.readTransition(targetRunId, state.pendingTransitionId)) : null;
    const latestReport = state.latestReportId ? await maybeRead(() => runtime.store.readReport(targetRunId, state.latestReportId)) : null;
    const after = await snapshotForRun(runtime, targetRunId, {
      rootContext: context,
    });
    const coherentState =
      canonicalJson({
        runId: state.runId,
        revision: state.revision,
        status: state.status,
        currentLap: state.currentLap,
        lapCap: definition.lapCap,
        continuationLease: state.continuationLease,
        cancelRequested: state.cancelRequested,
        needsHuman: state.needsHuman ?? false,
        pendingTransitionId: state.pendingTransitionId ?? null,
        latestReportId: state.latestReportId ?? null,
        latestRecoveryId: state.latestRecoveryId ?? null,
      }) ===
      canonicalJson({
        runId: after.runId,
        revision: after.revision,
        status: after.status,
        currentLap: after.currentLap,
        lapCap: after.lapCap,
        continuationLease: after.continuationLease,
        cancelRequested: after.cancelRequested,
        needsHuman: after.needsHuman,
        pendingTransitionId: after.pending?.transitionId ?? null,
        latestReportId: after.latestReport?.reportId ?? null,
        latestRecoveryId: after.recovery?.recoveryId ?? null,
      });
    if (before.projectionDigest !== after.projectionDigest || !coherentState) {
      continue;
    }
    return {
      ...stateSummary(state, definition),
      definition,
      bindings: bindingRead.facts
        .map((binding) => ({
          agentId: binding.agentId,
          role: binding.role,
          method: binding.method,
          createdAt: binding.createdAt,
        }))
        .sort((left, right) => compareCodePoints(`${left.role}:${left.agentId}`, `${right.role}:${right.agentId}`)),
      observedWorkers: observedRead.facts.map((event) => ({
        agentId: event.agentId,
        agentType: event.agentType ?? 'unknown',
        eventId: event.eventId,
        observedAt: event.observedAt,
        ...(roleByAgentId.has(event.agentId)
          ? {
              boundRole: roleByAgentId.get(event.agentId),
            }
          : {}),
      })),
      workerObservation: {
        observationDigest: snapshot.observationDigest,
        spawnCount: snapshot.spawnToolUseIds.length,
        workerStartCount: snapshot.subagentStartEventIds.length,
        pendingCount: identityPlane.pendingCount,
        balanced: snapshot.spawnToolUseIds.length === snapshot.subagentStartEventIds.length,
      },
      ...(roleCapability ? { roleCapability } : {}),
      ...(pendingTransition ? { pendingTransition } : {}),
      ...(latestReport ? { latestReport } : {}),
      projectionDigest: after.projectionDigest,
      eventWatermark: after.eventWatermark,
    };
  }
  fail('SNAPSHOT_BUSY', 'authoritative loop changed while it was being read');
}

export async function getSnapshot(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  return snapshotForRun(runtime, runId(input?.runId), {
    rootContext: context,
  });
}

export async function snapshotForRun(runtime, targetRunIdValue, options = {}) {
  const targetRunId = runId(targetRunIdValue);
  const lockTimeoutMs = options.lockTimeoutMs ?? 250;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 5_000) {
    fail('INVALID_SNAPSHOT_OPTIONS', 'snapshot lock timeout is invalid');
  }
  try {
    return await runtime.store.withControlLock(
      targetRunId,
      async () => {
        const state = await runtime.store.readState(targetRunId);
        if (options.rootContext) {
          assertRoot(runtime, state, options.rootContext);
        }
        const [operationRead, governorDecisionRead, eventRead, reportRead, transitionRead, bindingRead, observationRead, diagnosticRead, recoveryRead] =
          await Promise.all([
            runtime.store.listOperations(targetRunId),
            runtime.store.listGovernorDecisions(targetRunId),
            runtime.store.listEvents(targetRunId),
            runtime.store.listReports(targetRunId),
            runtime.store.listTransitions(targetRunId),
            runtime.store.listIdentityBindings(targetRunId),
            runtime.store.listWorkerObservations(targetRunId),
            runtime.store.listDiagnostics(targetRunId),
            runtime.store.listRecoveries(targetRunId),
          ]);
        const reads = [operationRead, governorDecisionRead, eventRead, reportRead, transitionRead, bindingRead, observationRead, diagnosticRead, recoveryRead];
        if (reads.some((read) => read.corrupt.length > 0)) {
          fail('HISTORY_CORRUPT', 'authoritative loop history could not be verified');
        }
        const definition = await runtime.store.readDefinition(targetRunId);
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
        if (!state.latestRecoveryId) {
          detectUnsupportedNativeTargets(runtime, state, bindingRead, operationRead, reportRead, transitionRead);
        }
        const verified = await validateDurableControlHistory(runtime, state, operationRead, governorDecisionRead, recoveryRead, { reportRead, transitionRead });
        return buildAgentLoopProjection({
          state,
          definition: verified.definition,
          bindings: verified.bindingRead.facts,
          events: eventRead.facts,
          reports: reportRead.facts,
          transitions: transitionRead.facts,
          operations: operationRead.facts,
          governorDecisions: governorDecisionRead.facts,
          recoveries: verified.appliedRecoveries,
          diagnostics: diagnosticRead.facts,
        });
      },
      { timeoutMs: lockTimeoutMs },
    );
  } catch (error) {
    if (error?.code === 'STORE_LOCK_TIMEOUT') {
      fail('SNAPSHOT_BUSY', 'authoritative snapshot is temporarily busy');
    }
    if (
      [
        'ROOT_ONLY_TOOL',
        'ROOT_IDENTITY_MISMATCH',
        'UNSUPPORTED_NATIVE_TARGET_HISTORY',
        'LEGACY_RECOVERY_PENDING',
        'LEGACY_RECOVERY_LIMIT',
        'HISTORY_CORRUPT',
        'PROJECTION_TOO_LARGE',
        'INVALID_SNAPSHOT_OPTIONS',
      ].includes(error?.code)
    ) {
      throw error;
    }
    fail('HISTORY_CORRUPT', 'authoritative loop history could not be verified');
  }
}
