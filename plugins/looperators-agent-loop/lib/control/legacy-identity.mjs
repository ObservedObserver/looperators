import { canonicalJson, digestJson } from '../canonical-json.mjs';
import { assertContract, SCHEMA_VERSION, validateWorkerObservation, WORKER_ROLES } from '../contracts.mjs';
import { issueRunCapability } from '../identity.mjs';
import { fail } from './errors.mjs';
import { rollForwardPrepared } from './history-apply.mjs';
import { bindingRequestDigest, observationIdFor, observationRequestDigest } from './identifiers.mjs';
import { readIdentityPlane } from './identity-plane.mjs';
import { agentId, assertRootContext, requestId, runId } from './input.mjs';
import { assertRequestNamespace, assertRoot } from './invariants.mjs';
import { difference } from './state.mjs';

export async function prepareWorkerSpawn(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  const prepareRequestId = requestId(input?.requestId);
  const role = input?.role;
  if (!WORKER_ROLES.has(role)) {
    fail('INVALID_TOOL_INPUT', 'role is invalid');
  }
  const desiredObservationId = observationIdFor(targetRunId, prepareRequestId);
  const requestDigest = observationRequestDigest({
    runId: targetRunId,
    requestId: prepareRequestId,
    rootSessionId: context.rootSessionId,
    role,
  });
  return runtime.store.withControlLock(targetRunId, () =>
    runtime.store.withWorkerObservationSnapshotLock(targetRunId, async () => {
      let state = await runtime.store.readState(targetRunId);
      assertRoot(runtime, state, context);
      state = await rollForwardPrepared(runtime, state);
      assertRoot(runtime, state, context);
      if (state.status !== 'running') {
        fail('INVALID_STATE_TRANSITION', 'worker spawn can only prepare on a running loop');
      }
      const [plane, observations, operations, recoveries, definition] = await Promise.all([
        readIdentityPlane(runtime, targetRunId, context.rootSessionId, { reconcile: true }),
        runtime.store.listWorkerObservations(targetRunId),
        runtime.store.listOperations(targetRunId),
        runtime.store.listRecoveries(targetRunId),
        runtime.store.readDefinition(targetRunId),
      ]);
      if (observations.corrupt.length > 0 || operations.corrupt.length > 0 || recoveries.corrupt.length > 0) {
        fail('RECOVERY_REQUIRED', 'prepare receipts are corrupt');
      }
      assertRequestNamespace(runtime, prepareRequestId, 'observations', {
        definition,
        operations: operations.facts,
        observations: observations.facts,
        bindings: plane.bindingRead.facts,
        recoveries: recoveries.facts,
      });
      const sameRequest = observations.facts.filter((item) => item.requestId === prepareRequestId);
      if (sameRequest.length > 1) {
        fail('RECOVERY_REQUIRED', 'multiple prepare receipts reuse one request id');
      }
      if (sameRequest.length === 1) {
        const existing = sameRequest[0];
        if (existing.observationId === desiredObservationId && existing.requestDigest === requestDigest && existing.role === role) {
          return {
            schemaVersion: SCHEMA_VERSION,
            runId: targetRunId,
            observationId: existing.observationId,
            role,
            observationDigest: existing.observationDigest,
            duplicate: true,
            consumed: plane.bindingRead.facts.some((binding) => binding.observationId === existing.observationId),
          };
        }
        fail('REQUEST_ID_CONFLICT', 'prepare request id already has different content');
      }
      if (
        definition.requestId === prepareRequestId ||
        operations.facts.some((operation) => operation.requestId === prepareRequestId) ||
        plane.bindingRead.facts.some((binding) => binding.requestId === prepareRequestId)
      ) {
        fail('REQUEST_ID_CONFLICT', 'request id already belongs to another mutation');
      }
      const consumed = new Set(plane.bindingRead.facts.map((binding) => binding.observationId).filter(Boolean));
      if (observations.facts.some((item) => !consumed.has(item.observationId))) {
        fail('SPAWN_ALREADY_PREPARED', 'another worker spawn baseline is still unconsumed');
      }
      const roleBindings = new Map(plane.bindingRead.facts.filter((binding) => binding.role).map((binding) => [binding.role, binding]));
      if (roleBindings.has(role)) {
        fail('ROLE_ALREADY_BOUND', 'worker role is already bound');
      }
      if ((role === 'implementer' && roleBindings.size !== 0) || (role === 'reviewer' && (!roleBindings.has('implementer') || roleBindings.size !== 1))) {
        fail('WORKER_ROLE_ORDER', 'workers must prepare implementer then reviewer');
      }
      if (plane.snapshot.spawnToolUseIds.length !== plane.snapshot.subagentStartEventIds.length) {
        fail('OBSERVATION_UNBALANCED', 'native spawn and worker-start observations are not balanced');
      }
      const boundAgentIds = new Set(plane.bindingRead.facts.map((binding) => binding.agentId));
      if (plane.snapshot.starts.some((event) => !boundAgentIds.has(event.agentId))) {
        fail('UNEXPLAINED_WORKER', 'an observed worker is not bound to this loop');
      }
      const observation = assertContract(
        'worker observation',
        {
          schemaVersion: SCHEMA_VERSION,
          observationId: desiredObservationId,
          runId: targetRunId,
          requestId: prepareRequestId,
          requestDigest,
          rootSessionId: context.rootSessionId,
          role,
          spawnToolUseIds: plane.snapshot.spawnToolUseIds,
          subagentStartEventIds: plane.snapshot.subagentStartEventIds,
          bindingIds: plane.snapshot.bindingIds,
          observationDigest: plane.snapshot.observationDigest,
          createdAt: runtime.now(),
        },
        validateWorkerObservation,
      );
      const published = await runtime.store.putWorkerObservation(targetRunId, observation);
      if (!['created', 'duplicate'].includes(published.status)) {
        fail(published.status === 'limit' ? 'FACT_LIMIT_REACHED' : 'REQUEST_ID_CONFLICT', 'worker spawn baseline could not be published');
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        runId: targetRunId,
        observationId: observation.observationId,
        role,
        observationDigest: observation.observationDigest,
        duplicate: published.status === 'duplicate',
        consumed: false,
      };
    }),
  );
}

export async function bindWorker(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const targetRunId = runId(input?.runId);
  const bindRequestId = requestId(input?.requestId);
  const targetAgentId = agentId(input?.agentId);
  const targetObservationId = runId(input?.observationId);
  const targetOriginEventId = runId(input?.originEventId);
  const role = input?.role;
  if (!WORKER_ROLES.has(role)) {
    fail('INVALID_TOOL_INPUT', 'role is invalid');
  }
  const digest = bindingRequestDigest({
    runId: targetRunId,
    requestId: bindRequestId,
    agentId: targetAgentId,
    role,
    observationId: targetObservationId,
    originEventId: targetOriginEventId,
  });
  return runtime.store.withControlLock(targetRunId, () =>
    runtime.store.withWorkerObservationSnapshotLock(targetRunId, async () => {
      let state = await runtime.store.readState(targetRunId);
      assertRoot(runtime, state, context);
      state = await rollForwardPrepared(runtime, state);
      assertRoot(runtime, state, context);
      if (state.status !== 'running') {
        fail('INVALID_STATE_TRANSITION', 'workers can only bind to a running loop');
      }
      const [plane, observations, operations, recoveries, definition] = await Promise.all([
        readIdentityPlane(runtime, targetRunId, context.rootSessionId, { reconcile: true }),
        runtime.store.listWorkerObservations(targetRunId),
        runtime.store.listOperations(targetRunId),
        runtime.store.listRecoveries(targetRunId),
        runtime.store.readDefinition(targetRunId),
      ]);
      const bindings = plane.bindingRead;
      if (observations.corrupt.length > 0 || operations.corrupt.length > 0 || recoveries.corrupt.length > 0) {
        fail('RECOVERY_REQUIRED', 'worker bind receipts are corrupt');
      }
      if (bindings.corrupt.length > 0) {
        fail('RECOVERY_REQUIRED', 'identity bindings are corrupt');
      }
      assertRequestNamespace(runtime, bindRequestId, 'identity', {
        definition,
        operations: operations.facts,
        observations: observations.facts,
        bindings: bindings.facts,
        recoveries: recoveries.facts,
      });
      const sameRequests = bindings.facts.filter((binding) => binding.requestId === bindRequestId);
      if (sameRequests.length > 1) {
        fail('RECOVERY_REQUIRED', 'multiple worker bindings reuse one request id');
      }
      if (sameRequests.length === 1) {
        const existing = sameRequests[0];
        if (
          existing.agentId === targetAgentId &&
          existing.role === role &&
          existing.requestDigest === digest &&
          existing.observationId === targetObservationId &&
          existing.originEventId === targetOriginEventId
        ) {
          return {
            schemaVersion: SCHEMA_VERSION,
            runId: targetRunId,
            agentId: targetAgentId,
            role,
            issued: false,
            duplicate: true,
            capabilityReissueRequired: true,
          };
        }
        fail('REQUEST_ID_CONFLICT', 'bind request id already has different content');
      }
      if (
        definition.requestId === bindRequestId ||
        operations.facts.some((operation) => operation.requestId === bindRequestId) ||
        observations.facts.some((observation) => observation.requestId === bindRequestId)
      ) {
        fail('REQUEST_ID_CONFLICT', 'request id already belongs to another mutation');
      }
      let baseline;
      try {
        baseline = await runtime.store.readWorkerObservation(targetRunId, targetObservationId);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          fail('OBSERVATION_BASELINE_MISSING', 'worker spawn baseline does not exist');
        }
        throw error;
      }
      if (baseline.rootSessionId !== context.rootSessionId || baseline.role !== role) {
        fail('OBSERVATION_BASELINE_MISMATCH', 'worker spawn baseline belongs to another root or role');
      }
      if (bindings.facts.some((binding) => binding.observationId === targetObservationId)) {
        fail('OBSERVATION_BASELINE_CONSUMED', 'worker spawn baseline is already consumed');
      }
      const consumed = new Set(bindings.facts.map((binding) => binding.observationId).filter(Boolean));
      const unconsumed = observations.facts.filter((observation) => !consumed.has(observation.observationId));
      if (unconsumed.length !== 1 || unconsumed[0].observationId !== targetObservationId) {
        fail('OBSERVATION_BASELINE_SUPERSEDED', 'worker spawn baseline is not the current permit');
      }
      const sameAgent = bindings.facts.find((binding) => binding.agentId === targetAgentId);
      if (sameAgent) {
        fail('AGENT_ALREADY_BOUND', 'agent is already bound with different intent');
      }
      if (bindings.facts.some((binding) => binding.role === role)) {
        fail('ROLE_ALREADY_BOUND', 'worker role is already bound');
      }
      if ((bindings.facts.length === 0 && role !== 'implementer') || (bindings.facts.length === 1 && role !== 'reviewer')) {
        fail('WORKER_ROLE_ORDER', 'workers must bind implementer then reviewer');
      }
      const baselineBase = {
        spawnToolUseIds: baseline.spawnToolUseIds,
        subagentStartEventIds: baseline.subagentStartEventIds,
        bindingIds: baseline.bindingIds,
      };
      if (digestJson(baselineBase) !== baseline.observationDigest) {
        fail('RECOVERY_REQUIRED', 'worker spawn baseline digest is invalid');
      }
      for (const [current, prior] of [
        [plane.snapshot.spawnToolUseIds, baseline.spawnToolUseIds],
        [plane.snapshot.subagentStartEventIds, baseline.subagentStartEventIds],
        [plane.snapshot.bindingIds, baseline.bindingIds],
      ]) {
        if (prior.some((id) => !current.includes(id))) {
          fail('RECOVERY_REQUIRED', 'worker observation moved behind its baseline');
        }
      }
      if (canonicalJson(plane.snapshot.bindingIds) !== canonicalJson(baseline.bindingIds)) {
        fail('OBSERVATION_AMBIGUOUS', 'identity bindings changed after worker prepare');
      }
      const newSpawnToolUseIds = difference(plane.snapshot.spawnToolUseIds, baseline.spawnToolUseIds);
      const newStartEventIds = difference(plane.snapshot.subagentStartEventIds, baseline.subagentStartEventIds);
      if (newSpawnToolUseIds.length !== 1 || newStartEventIds.length !== 1) {
        fail('OBSERVATION_AMBIGUOUS', 'worker bind requires exactly one spawn and one worker-start delta', {
          spawnDelta: newSpawnToolUseIds.length,
          workerStartDelta: newStartEventIds.length,
        });
      }
      if (newStartEventIds[0] !== targetOriginEventId) {
        fail('OBSERVATION_CANDIDATE_CHANGED', 'selected worker event is no longer the unique delta');
      }
      const originEvent = plane.snapshot.starts.find((event) => event.eventId === targetOriginEventId);
      if (!originEvent || originEvent.agentId !== targetAgentId) {
        fail('OBSERVATION_CANDIDATE_MISMATCH', 'selected worker does not match the observed event');
      }
      const boundAgentIds = new Set(bindings.facts.map((binding) => binding.agentId));
      const unboundStarts = plane.snapshot.starts.filter((event) => !boundAgentIds.has(event.agentId));
      if (unboundStarts.length !== 1 || unboundStarts[0].eventId !== targetOriginEventId) {
        fail('OBSERVATION_AMBIGUOUS', 'worker observation contains unexplained unbound workers');
      }
      const issued = await issueRunCapability(runtime.store, {
        runId: targetRunId,
        rootSessionId: context.rootSessionId,
        agentId: targetAgentId,
        role,
        requestId: bindRequestId,
        requestDigest: digest,
        observationId: targetObservationId,
        originEventId: targetOriginEventId,
        createdAt: runtime.now(),
      });
      return {
        schemaVersion: SCHEMA_VERSION,
        runId: targetRunId,
        agentId: targetAgentId,
        role,
        issued: true,
        duplicate: false,
        capabilityToken: issued.token,
      };
    }),
  );
}
