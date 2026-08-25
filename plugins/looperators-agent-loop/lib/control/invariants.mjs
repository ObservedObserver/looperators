import { compareCodePoints, sha256 } from '../canonical-json.mjs';
import { WORKER_ROLES } from '../contracts.mjs';
import { fail } from './errors.mjs';
import { assertRootContext } from './input.mjs';

export function assertRoot(runtime, state, context) {
  assertRootContext(context);
  if (state.rootSessionId !== context.rootSessionId) {
    fail('ROOT_IDENTITY_MISMATCH', 'root task does not own this loop run');
  }
}

export function assertIdentityBindingTopology(runtime, bindingRead, rootSessionId) {
  const bindings = bindingRead.facts;
  if (bindings.some((binding) => binding.rootSessionId !== rootSessionId || !WORKER_ROLES.has(binding.role)) || bindings.length > 2) {
    fail('RECOVERY_REQUIRED', 'worker identity bindings do not match the authoritative root and role topology');
  }
  const roleCounts = new Map();
  for (const binding of bindings) {
    roleCounts.set(binding.role, (roleCounts.get(binding.role) ?? 0) + 1);
  }
  const topologyIsValid =
    bindings.length === 0 ||
    (bindings.length === 1 && roleCounts.get('implementer') === 1) ||
    (bindings.length === 2 && roleCounts.get('implementer') === 1 && roleCounts.get('reviewer') === 1);
  if (!topologyIsValid) {
    fail('RECOVERY_REQUIRED', 'worker identity bindings violate implementer-first topology');
  }
}

export function assertRequestNamespace(runtime, targetRequestId, expectedNamespace, values) {
  const claims = [
    ...(values.definition.requestId === targetRequestId ? ['definition'] : []),
    ...values.operations.filter((operation) => operation.requestId === targetRequestId).map(() => 'operations'),
    ...values.observations.filter((observation) => observation.requestId === targetRequestId).map(() => 'observations'),
    ...values.bindings.filter((binding) => binding.requestId === targetRequestId).map(() => 'identity'),
    ...(values.recoveries ?? []).filter((recovery) => recovery.requestId === targetRequestId).map(() => 'recoveries'),
  ];
  if (claims.some((namespace) => namespace !== expectedNamespace)) {
    fail('REQUEST_ID_CONFLICT', 'request id already belongs to another mutation namespace');
  }
}

export function assertDurableRequestNamespaces(runtime, values) {
  const claims = new Map();
  const claim = (request, namespace) => {
    if (typeof request !== 'string') {
      return;
    }
    const namespaces = claims.get(request) ?? new Set();
    namespaces.add(namespace);
    claims.set(request, namespaces);
  };
  claim(values.definition.requestId, 'definition');
  for (const operation of values.operations) {
    claim(operation.requestId, 'operations');
  }
  for (const observation of values.observations) {
    claim(observation.requestId, 'observations');
  }
  for (const binding of values.bindings) {
    claim(binding.requestId, 'identity');
  }
  for (const recovery of values.recoveries) {
    claim(recovery.requestId, 'recoveries');
  }
  const collisions = [...claims.entries()]
    .filter(([, namespaces]) => namespaces.size > 1)
    .map(([request, namespaces]) => ({
      requestIdDigest: sha256(request),
      namespaces: [...namespaces].sort(compareCodePoints),
    }))
    .sort((left, right) => compareCodePoints(left.requestIdDigest, right.requestIdDigest));
  if (collisions.length > 0) {
    fail('HISTORY_CORRUPT', 'durable request ids cross mutation namespaces', { collisions });
  }
}

export async function readRequestNamespacePlane(runtime, targetRunId) {
  const [definition, operationRead, observationRead, bindingRead, recoveryRead] = await Promise.all([
    runtime.store.readDefinition(targetRunId),
    runtime.store.listOperations(targetRunId),
    runtime.store.listWorkerObservations(targetRunId),
    runtime.store.listIdentityBindings(targetRunId),
    runtime.store.listRecoveries(targetRunId),
  ]);
  if ([operationRead, observationRead, bindingRead, recoveryRead].some((read) => read.corrupt.length > 0)) {
    fail('HISTORY_CORRUPT', 'request namespace history could not be verified');
  }
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
    observationRead,
    bindingRead,
    recoveryRead,
  };
}
