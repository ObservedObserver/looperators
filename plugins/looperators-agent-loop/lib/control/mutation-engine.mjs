import { canonicalJson } from '../canonical-json.mjs';
import { ACTIVE_RUN_STATUSES, assertContract, SCHEMA_VERSION, validateLoopOperation, validateLoopTransition } from '../contracts.mjs';
import { fail } from './errors.mjs';
import { applyOperation, rollForwardPrepared } from './history-apply.mjs';
import { mutationResult, readAndValidateDefinition } from './history-facts.mjs';
import { factLimitRequestId, mutationRequestDigest, operationIdFor, reportIdFor, transitionIdFor } from './identifiers.mjs';
import { assertIdentityBindingTopology, assertRequestNamespace } from './invariants.mjs';
import { maybeRead } from './state.mjs';

export function buildTransition(runtime, input) {
  return assertContract(
    'loop transition',
    {
      schemaVersion: SCHEMA_VERSION,
      transitionId: input.transitionId,
      runId: input.runId,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
      kind: input.kind,
      ...(input.fromNode ? { fromNode: input.fromNode } : {}),
      ...(input.toNode ? { toNode: input.toNode } : {}),
      ...(input.originReportId ? { originReportId: input.originReportId } : {}),
      lap: input.lap,
      fromRevision: input.fromRevision,
      toRevision: input.toRevision,
      createdAt: input.createdAt,
    },
    validateLoopTransition,
  );
}

export async function mutate(runtime, spec) {
  return runtime.store.withControlLock(spec.runId, async () => {
    let state = await runtime.store.readState(spec.runId);
    await spec.authorize(state);
    state = await rollForwardPrepared(runtime, state);
    await spec.authorize(state);
    const targetOperationId = operationIdFor(spec.runId, spec.requestId);
    const [definition, operationRead, observationRead, bindingRead, recoveryRead] = await Promise.all([
      runtime.store.readDefinition(spec.runId),
      runtime.store.listOperations(spec.runId),
      runtime.store.listWorkerObservations(spec.runId),
      runtime.store.listIdentityBindings(spec.runId),
      runtime.store.listRecoveries(spec.runId),
    ]);
    if (operationRead.corrupt.length > 0 || observationRead.corrupt.length > 0 || bindingRead.corrupt.length > 0 || recoveryRead.corrupt.length > 0) {
      fail('RECOVERY_REQUIRED', 'request namespace receipts are corrupt');
    }
    assertIdentityBindingTopology(runtime, bindingRead, state.rootSessionId);
    assertRequestNamespace(runtime, spec.requestId, 'operations', {
      definition,
      operations: operationRead.facts,
      observations: observationRead.facts,
      bindings: bindingRead.facts,
      recoveries: recoveryRead.facts,
    });
    const existingOperation = operationRead.facts.find((operation) => operation.operationId === targetOperationId);
    if (existingOperation) {
      if (existingOperation.requestDigest !== spec.requestDigest || existingOperation.kind !== spec.kind) {
        fail('REQUEST_ID_CONFLICT', 'request id already has different content');
      }
      state = await applyOperation(runtime, state, existingOperation);
      return mutationResult(runtime, state, definition, existingOperation, true);
    }

    const ids = {
      runId: spec.runId,
      requestId: spec.requestId,
      requestDigest: spec.requestDigest,
      transitionId: transitionIdFor(spec.runId, spec.requestId),
      ...(spec.kind === 'report'
        ? {
            reportId: reportIdFor(spec.runId, spec.requestId),
          }
        : {}),
      fromRevision: state.revision,
      toRevision: state.revision + 1,
    };
    const existingTransition = await maybeRead(() => runtime.store.readTransition(spec.runId, ids.transitionId));
    const existingReport = ids.reportId ? await maybeRead(() => runtime.store.readReport(spec.runId, ids.reportId)) : null;
    for (const orphan of [existingTransition, existingReport].filter(Boolean)) {
      if (orphan.requestDigest !== spec.requestDigest || orphan.requestId !== spec.requestId) {
        fail('REQUEST_ID_CONFLICT', 'request id already has different facts');
      }
      if (orphan.fromRevision !== undefined && orphan.fromRevision !== state.revision) {
        fail('STALE_UNCOMMITTED_REQUEST', 'uncommitted request belongs to an older revision');
      }
    }
    const createdAt = existingTransition?.createdAt ?? existingReport?.createdAt ?? runtime.now();
    if (existingTransition && existingReport && existingTransition.createdAt !== existingReport.createdAt) {
      fail('RECOVERY_REQUIRED', 'uncommitted request facts disagree');
    }
    const built = await spec.build(state, definition, createdAt, ids);
    const transitionResult = await runtime.store.putTransition(spec.runId, built.transition);
    await requireFactPublication(runtime, 'transitions', transitionResult, spec.runId, 'transition fact conflicts with this request');
    await runtime.fault('afterTransitionFact', {
      runId: spec.runId,
      requestId: spec.requestId,
    });
    if (built.report) {
      const reportResult = await runtime.store.putReport(spec.runId, built.report);
      await requireFactPublication(runtime, 'reports', reportResult, spec.runId, 'report fact conflicts with this request');
      await runtime.fault('afterReportFact', {
        runId: spec.runId,
        requestId: spec.requestId,
      });
    }
    await runtime.fault('afterFacts', {
      runId: spec.runId,
      requestId: spec.requestId,
    });
    const operation = assertContract(
      'loop operation',
      {
        schemaVersion: SCHEMA_VERSION,
        operationId: targetOperationId,
        runId: spec.runId,
        requestId: spec.requestId,
        requestDigest: spec.requestDigest,
        kind: spec.kind,
        actorKind: spec.actor.kind,
        actorId: spec.actor.id,
        fromRevision: state.revision,
        toRevision: state.revision + 1,
        ...(built.report ? { reportId: built.report.reportId } : {}),
        transitionId: built.transition.transitionId,
        createdAt,
      },
      validateLoopOperation,
    );
    const operationResult = await runtime.store.putOperation(spec.runId, operation);
    await requireFactPublication(runtime, 'operations', operationResult, spec.runId, 'operation receipt conflicts with this request');
    await runtime.fault('afterReceipt', {
      runId: spec.runId,
      requestId: spec.requestId,
    });
    state = await applyOperation(runtime, state, operation);
    await runtime.fault('afterCas', {
      runId: spec.runId,
      requestId: spec.requestId,
    });
    return mutationResult(runtime, state, definition, operation, false);
  });
}

export async function requireFactPublication(runtime, factKind, result, targetRunId, conflictMessage) {
  if (['created', 'duplicate'].includes(result?.status)) {
    return;
  }
  if (result?.status === 'conflict') {
    fail('REQUEST_ID_CONFLICT', conflictMessage);
  }
  if (result?.status === 'limit') {
    let durableState = await maybeRead(() => runtime.store.readState(targetRunId));
    if (durableState && ACTIVE_RUN_STATUSES.has(durableState.status) && !(durableState.status === 'interrupted' && durableState.needsHuman === true)) {
      durableState = await interruptForFactLimit(runtime, durableState, {
        factKind,
        limit: result.limit,
      });
    }
    fail('FACT_LIMIT_REACHED', `${factKind} capacity was reached; the run requires human recovery`, {
      factKind,
      limit: result.limit,
      status: durableState?.status ?? 'unknown',
      needsHuman: durableState?.needsHuman === true,
    });
  }
  fail('RECOVERY_REQUIRED', `${factKind} publication returned an unsupported result`);
}

export async function interruptForFactLimit(runtime, initialState, details = {}) {
  let state = await runtime.store.readState(initialState.runId);
  if (
    canonicalJson({
      runId: state.runId,
      rootSessionId: state.rootSessionId,
    }) !==
    canonicalJson({
      runId: initialState.runId,
      rootSessionId: initialState.rootSessionId,
    })
  ) {
    fail('RECOVERY_REQUIRED', 'fact-limit interruption targets a different run identity');
  }
  state = await rollForwardPrepared(runtime, state);
  if (!ACTIVE_RUN_STATUSES.has(state.status) || (state.status === 'interrupted' && state.needsHuman === true)) {
    return state;
  }
  await readAndValidateDefinition(runtime, state);
  const internalRequestId = factLimitRequestId(state.revision);
  const requestDigest = mutationRequestDigest({
    kind: 'interrupt',
    runId: state.runId,
    requestId: internalRequestId,
    actorKind: 'root',
    actorId: state.rootSessionId,
  });
  const ids = {
    runId: state.runId,
    requestId: internalRequestId,
    requestDigest,
    transitionId: transitionIdFor(state.runId, internalRequestId),
    fromRevision: state.revision,
    toRevision: state.revision + 1,
  };
  const existingTransition = await maybeRead(() => runtime.store.readTransition(state.runId, ids.transitionId));
  const existingOperation = await maybeRead(() => runtime.store.readOperation(state.runId, operationIdFor(state.runId, internalRequestId)));
  const createdAt = existingTransition?.createdAt ?? existingOperation?.createdAt ?? runtime.now();
  if (existingTransition && existingOperation && existingTransition.createdAt !== existingOperation.createdAt) {
    fail('RECOVERY_REQUIRED', 'fact-limit interruption facts disagree');
  }
  const transition = buildTransition(runtime, {
    ...ids,
    kind: 'interrupt',
    fromNode: state.masterNode,
    toNode: state.masterNode,
    lap: state.currentLap,
    createdAt,
  });
  const transitionResult = await runtime.store.putTransition(state.runId, transition, { allowSafetyReserve: true });
  if (!['created', 'duplicate'].includes(transitionResult?.status)) {
    fail('RECOVERY_REQUIRED', 'fact-limit interruption transition could not be published', {
      factKind: details.factKind ?? 'unknown',
      limit: details.limit ?? null,
      status: transitionResult?.status ?? 'unknown',
    });
  }
  await runtime.fault('afterSafetyTransition', {
    runId: state.runId,
    requestId: internalRequestId,
  });
  const operation = assertContract(
    'loop operation',
    {
      schemaVersion: SCHEMA_VERSION,
      operationId: operationIdFor(state.runId, internalRequestId),
      runId: state.runId,
      requestId: internalRequestId,
      requestDigest,
      kind: 'interrupt',
      actorKind: 'root',
      actorId: state.rootSessionId,
      fromRevision: state.revision,
      toRevision: state.revision + 1,
      transitionId: transition.transitionId,
      createdAt,
    },
    validateLoopOperation,
  );
  const operationResult = await runtime.store.putOperation(state.runId, operation, { allowSafetyReserve: true });
  if (!['created', 'duplicate'].includes(operationResult?.status)) {
    fail('RECOVERY_REQUIRED', 'fact-limit interruption receipt could not be published', {
      factKind: details.factKind ?? 'unknown',
      limit: details.limit ?? null,
      status: operationResult?.status ?? 'unknown',
    });
  }
  await runtime.fault('afterSafetyReceipt', {
    runId: state.runId,
    requestId: internalRequestId,
  });
  state = await applyOperation(runtime, state, operation);
  await runtime.fault('afterSafetyCas', {
    runId: state.runId,
    requestId: internalRequestId,
  });
  return state;
}
