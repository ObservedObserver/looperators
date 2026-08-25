import { canonicalJson, sha256 } from '../canonical-json.mjs';
import { SCHEMA_VERSION, WORKER_ROLES } from '../contracts.mjs';
import { fail } from './errors.mjs';
import { digestsEqual } from './identifiers.mjs';
import { governedTransitionRole, maybeRead } from './state.mjs';
import { randomBytes } from 'node:crypto';

export async function currentRoleCapability(runtime, state) {
  if (!['running', 'paused', 'interrupted'].includes(state.status) || !state.pendingTransitionId) {
    return null;
  }
  return runtime.store.withControlLock(state.runId, async () => {
    const current = await runtime.store.readState(state.runId);
    if (!['running', 'paused', 'interrupted'].includes(current.status) || !current.pendingTransitionId) {
      return null;
    }
    const transition = await runtime.store.readTransition(current.runId, current.pendingTransitionId);
    const role = governedTransitionRole(transition);
    if (!role) {
      fail('RECOVERY_REQUIRED', 'pending transition has no cooperative role');
    }
    const key = canonicalJson({
      runId: current.runId,
      role,
      pendingTransitionId: transition.transitionId,
      actionRevision: transition.toRevision,
    });
    const cachedToken = runtime.actionTokens.get(key);
    const existing = await maybeRead(() => runtime.store.readActionCapability(current.runId, transition.transitionId));
    if (
      cachedToken &&
      validActionCapabilityRecord(runtime, existing, current.runId, role, transition) &&
      digestsEqual(existing.tokenDigest, sha256(cachedToken))
    ) {
      return {
        role,
        pendingTransitionId: transition.transitionId,
        actionRevision: transition.toRevision,
        capabilityToken: cachedToken,
      };
    }
    const capabilityToken = randomBytes(48).toString('base64url');
    await runtime.store.replaceActionCapability(current.runId, transition.transitionId, {
      schemaVersion: SCHEMA_VERSION,
      runId: current.runId,
      role,
      pendingTransitionId: transition.transitionId,
      actionRevision: transition.toRevision,
      tokenDigest: sha256(capabilityToken),
      issuedAt: runtime.now(),
    });
    runtime.actionTokens.set(key, capabilityToken);
    return {
      role,
      pendingTransitionId: transition.transitionId,
      actionRevision: transition.toRevision,
      capabilityToken,
    };
  });
}

export async function withCurrentRoleCapability(runtime, result) {
  const state = await runtime.store.readState(result.runId);
  const roleCapability = await currentRoleCapability(runtime, state);
  return roleCapability ? { ...result, roleCapability } : result;
}

export function validActionCapabilityRecord(runtime, record, runIdValue, role, transition) {
  return (
    record?.schemaVersion === SCHEMA_VERSION &&
    record.runId === runIdValue &&
    record.role === role &&
    record.pendingTransitionId === transition.transitionId &&
    record.actionRevision === transition.toRevision &&
    typeof record.tokenDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(record.tokenDigest) &&
    typeof record.issuedAt === 'string'
  );
}

export function assertCapabilityTokenShape(runtime, role, token) {
  if (!WORKER_ROLES.has(role) || typeof token !== 'string' || token.length < 64 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    fail('CAPABILITY_REJECTED', 'role capability is missing, stale, or invalid');
  }
}

export async function assertRoleCapability(runtime, state, role, token) {
  assertCapabilityTokenShape(runtime, role, token);
  if (state.status !== 'running' || !state.pendingTransitionId) {
    fail('CAPABILITY_REJECTED', 'role capability is missing, stale, or invalid');
  }
  const transition = await runtime.store.readTransition(state.runId, state.pendingTransitionId);
  const record = await maybeRead(() => runtime.store.readActionCapability(state.runId, state.pendingTransitionId));
  if (
    governedTransitionRole(transition) !== role ||
    !validActionCapabilityRecord(runtime, record, state.runId, role, transition) ||
    !digestsEqual(record.tokenDigest, sha256(token))
  ) {
    fail('CAPABILITY_REJECTED', 'role capability is missing, stale, or invalid');
  }
}

export async function assertConsumedRoleCapability(runtime, operation, role, token, operations) {
  assertCapabilityTokenShape(runtime, role, token);
  const anchor = operations.find((candidate) => candidate.toRevision === operation.fromRevision);
  if (!anchor) {
    fail('CAPABILITY_REJECTED', 'role capability is missing, stale, or invalid');
  }
  const transition = await runtime.store.readTransition(operation.runId, anchor.transitionId);
  const record = await maybeRead(() => runtime.store.readActionCapability(operation.runId, transition.transitionId));
  if (
    governedTransitionRole(transition) !== role ||
    !validActionCapabilityRecord(runtime, record, operation.runId, role, transition) ||
    !digestsEqual(record.tokenDigest, sha256(token))
  ) {
    fail('CAPABILITY_REJECTED', 'role capability is missing, stale, or invalid');
  }
}
