import { compareCodePoints, digestJson } from '../canonical-json.mjs';
import { isNativeSpawnPreToolUse, SCHEMA_VERSION } from '../contracts.mjs';

export async function maybeRead(reader) {
  try {
    return await reader();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function stateSummary(state, definition, duplicate = false) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    status: state.status,
    revision: state.revision,
    currentLap: state.currentLap,
    lapCap: definition.lapCap,
    continuationLease: state.continuationLease,
    cancelRequested: state.cancelRequested,
    needsHuman: state.needsHuman ?? false,
    duplicate,
    ...(state.pendingTransitionId ? { pendingTransitionId: state.pendingTransitionId } : {}),
    ...(state.latestReportId ? { latestReportId: state.latestReportId } : {}),
    ...(state.latestGovernorDecisionId
      ? {
          latestGovernorDecisionId: state.latestGovernorDecisionId,
        }
      : {}),
    ...(state.latestRecoveryId ? { latestRecoveryId: state.latestRecoveryId } : {}),
  };
}

export function previewGraph() {
  return {
    nodes: [
      { id: 'root-master', role: 'root' },
      { id: 'role:implementer', role: 'implementer' },
      { id: 'role:reviewer', role: 'reviewer' },
    ],
    edges: [
      {
        from: 'role:implementer',
        to: 'role:reviewer',
        on: 'done',
      },
      {
        from: 'role:reviewer',
        to: 'role:implementer',
        on: 'issues',
      },
      {
        from: 'role:reviewer',
        to: 'root-master',
        on: 'clean',
      },
    ],
  };
}

export function withoutPending(state) {
  const { pendingTransitionId: _pending, ...rest } = state;
  return rest;
}

export function governedTransitionRole(transition) {
  if (transition.kind === 'activate-implementer') {
    return 'implementer';
  }
  if (transition.kind === 'activate-reviewer') {
    return 'reviewer';
  }
  return null;
}

export function workerObservationSnapshot(evidence, bindings, rootSessionId) {
  const spawnToolUseIds = [
    ...new Set(
      evidence
        .filter(
          (event) =>
            event.conflictEligible === true && event.sessionId === rootSessionId && isNativeSpawnPreToolUse(event) && typeof event.toolUseId === 'string',
        )
        .map((event) => event.toolUseId),
    ),
  ].sort(compareCodePoints);
  const starts = evidence
    .filter(
      (event) => event.event === 'SubagentStart' && event.conflictEligible === true && event.sessionId === rootSessionId && typeof event.agentId === 'string',
    )
    .sort((left, right) => {
      const observedOrder = compareCodePoints(left.observedAt, right.observedAt);
      return observedOrder !== 0 ? observedOrder : compareCodePoints(left.eventId, right.eventId);
    });
  const subagentStartEventIds = starts.map((event) => event.eventId).sort(compareCodePoints);
  const bindingIds = bindings.map((binding) => binding.bindingId).sort(compareCodePoints);
  const base = {
    spawnToolUseIds,
    subagentStartEventIds,
    bindingIds,
  };
  return {
    ...base,
    starts,
    observationDigest: digestJson(base),
  };
}

export function difference(values, baseline) {
  const prior = new Set(baseline);
  return values.filter((value) => !prior.has(value));
}
