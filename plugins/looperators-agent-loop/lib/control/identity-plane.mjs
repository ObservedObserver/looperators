import { canonicalJson, compareCodePoints, sha256 } from '../canonical-json.mjs';
import { assertContract, SCHEMA_VERSION, validateIdentityBinding } from '../contracts.mjs';
import { fail } from './errors.mjs';
import { roleAgentId } from './identifiers.mjs';
import { assertIdentityBindingTopology } from './invariants.mjs';
import { workerObservationSnapshot } from './state.mjs';

export async function readIdentityPlane(runtime, targetRunId, rootSessionId, options = {}) {
  if (options.reconcile === true) {
    const reconciled = await runtime.store.reconcilePendingWorkerObservations(targetRunId);
    if (reconciled.corrupt.length > 0 || reconciled.unresolved.length > 0) {
      fail('OBSERVATION_INCOMPLETE', 'pending worker observations require recovery');
    }
  }
  const [bindingRead, evidenceRead] = await Promise.all([
    runtime.store.listIdentityBindings(targetRunId),
    runtime.store.readWorkerObservationEvidence(targetRunId),
  ]);
  if (bindingRead.corrupt.length > 0 || evidenceRead.corrupt.length > 0 || evidenceRead.conflicts.length > 0) {
    fail('RECOVERY_REQUIRED', 'worker identity evidence is corrupt');
  }
  assertIdentityBindingTopology(runtime, bindingRead, rootSessionId);
  const observedRead = {
    facts: evidenceRead.facts
      .filter(
        (event) => event.event === 'SubagentStart' && event.conflictEligible === true && event.sessionId === rootSessionId && typeof event.agentId === 'string',
      )
      .sort((left, right) => {
        const timeOrder = compareCodePoints(left.observedAt, right.observedAt);
        return timeOrder !== 0 ? timeOrder : compareCodePoints(left.eventId, right.eventId);
      }),
    corrupt: evidenceRead.corrupt,
  };
  const snapshot = workerObservationSnapshot(evidenceRead.facts, bindingRead.facts, rootSessionId);
  if (observedRead.facts.length > 64 || snapshot.spawnToolUseIds.length > 64 || bindingRead.facts.length > 64) {
    fail('RECOVERY_REQUIRED', 'worker observation exceeds the bounded identity view');
  }
  return {
    bindingRead,
    observedRead,
    evidenceRead,
    snapshot,
    pendingCount: evidenceRead.pendingCount,
  };
}

export async function ensureCooperativeRoleBindings(runtime, state) {
  const current = await runtime.store.listIdentityBindings(state.runId);
  if (current.corrupt.length > 0) {
    fail('RECOVERY_REQUIRED', 'cooperative role bindings are corrupt');
  }
  for (const role of ['implementer', 'reviewer']) {
    const targetAgentId = roleAgentId(role);
    const existing = current.facts.find((binding) => binding.role === role);
    if (existing) {
      if (
        existing.agentId !== targetAgentId ||
        existing.rootSessionId !== state.rootSessionId ||
        existing.method !== 'capability-token-v1' ||
        existing.revokedAt !== undefined
      ) {
        fail('RECOVERY_REQUIRED', 'cooperative role binding conflicts with the fixed topology');
      }
      continue;
    }
    const binding = assertContract(
      'identity binding',
      {
        schemaVersion: SCHEMA_VERSION,
        bindingId: `binding_${sha256(
          canonicalJson({
            runId: state.runId,
            agentId: targetAgentId,
          }),
        )}`,
        runId: state.runId,
        agentId: targetAgentId,
        rootSessionId: state.rootSessionId,
        method: 'capability-token-v1',
        tokenDigest: sha256(
          canonicalJson({
            kind: 'cooperative-role-binding',
            runId: state.runId,
            role,
          }),
        ),
        role,
        createdAt: state.createdAt,
      },
      validateIdentityBinding,
    );
    const published = await runtime.store.putIdentityBinding(state.runId, binding);
    if (!['created', 'duplicate'].includes(published.status)) {
      fail('RECOVERY_REQUIRED', 'cooperative role binding could not be published');
    }
    current.facts.push(binding);
  }
}
