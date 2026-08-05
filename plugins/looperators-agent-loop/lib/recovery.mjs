import {
  canonicalJson,
  compareCodePoints,
  digestJson,
  sha256,
} from "./canonical-json.mjs";
import {
  LEGACY_EVIDENCE_VERSION,
  LEGACY_RECOVERY_VERSION,
  MAX_LEGACY_NATIVE_TARGET_FACTS,
  SCHEMA_VERSION,
  assertContract,
  validateLegacyNativeTargetEvidence,
  validateLegacyQuarantineReceipt,
} from "./contracts.mjs";

export const LEGACY_RECOVERY_REASON =
  "unsupported-native-target-history";
export const PROJECTION_RECOVERY_REASON =
  "legacy-history-quarantined";

function derivedId(prefix, value) {
  return `${prefix}_${sha256(canonicalJson(value))}`;
}

export function recoveryIdFor(runId, requestId) {
  return derivedId("recovery", {
    runId,
    requestId,
    reason: LEGACY_RECOVERY_REASON,
  });
}

export function recoveryRequestDigest(input) {
  return digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: "legacy-quarantine",
    runId: input.runId,
    requestId: input.requestId,
    actorKind: "root",
    actorId: input.actorId,
    expectedRevision: input.expectedRevision,
    expectedEvidenceDigest: input.expectedEvidenceDigest,
  });
}

export function legacyEntryKey(entry) {
  return `${entry.factKind}:${entry.factId}:${entry.field}`;
}

function transitionRole(transition) {
  if (transition?.kind === "activate-implementer") {
    return "implementer";
  }
  if (transition?.kind === "activate-reviewer") {
    return "reviewer";
  }
  return null;
}

function sortedFacts(values, idField) {
  return [...values]
    .map((value) => ({
      id: value[idField],
      digest: digestJson(value),
    }))
    .sort((left, right) =>
      compareCodePoints(left.id, right.id),
    );
}

function activeBindingByRole(state, bindings) {
  const byRole = new Map();
  for (const binding of bindings) {
    if (
      binding.rootSessionId !== state.rootSessionId ||
      binding.method !== "capability-token-v1" ||
      binding.revokedAt !== undefined ||
      !["implementer", "reviewer"].includes(binding.role) ||
      binding.agentId === `role:${binding.role}`
    ) {
      continue;
    }
    if (byRole.has(binding.role)) {
      const error = new TypeError(
        "legacy evidence requires one authoritative binding per role",
      );
      error.code = "RECOVERY_REQUIRED";
      throw error;
    }
    byRole.set(binding.role, binding);
  }
  return byRole;
}

export function collectLegacyNativeTargetEntries(input) {
  const {
    state,
    operations,
    transitions,
    reports,
    bindings,
  } = input;
  const byRole = activeBindingByRole(state, bindings);
  const transitionById = new Map(
    transitions.map((value) => [
      value.transitionId,
      value,
    ]),
  );
  const reportById = new Map(
    reports.map((value) => [value.reportId, value]),
  );
  const entries = [];
  for (const operation of operations) {
    if (operation.toRevision > state.revision) {
      continue;
    }
    const transition = transitionById.get(
      operation.transitionId,
    );
    const role = transitionRole(transition);
    const binding = role ? byRole.get(role) : null;
    if (!transition || !role || !binding) {
      continue;
    }
    if (transition.toNode === binding.agentId) {
      entries.push({
        factKind: "transition",
        factId: transition.transitionId,
        factDigest: digestJson(transition),
        field: "toNode",
        role,
        bindingId: binding.bindingId,
        bindingDigest: digestJson(binding),
      });
    }
    const report = operation.reportId
      ? reportById.get(operation.reportId)
      : null;
    if (report?.routedToNode === binding.agentId) {
      entries.push({
        factKind: "report",
        factId: report.reportId,
        factDigest: digestJson(report),
        field: "routedToNode",
        role,
        bindingId: binding.bindingId,
        bindingDigest: digestJson(binding),
      });
    }
  }
  entries.sort((left, right) =>
    compareCodePoints(
      legacyEntryKey(left),
      legacyEntryKey(right),
    ),
  );
  if (entries.length > MAX_LEGACY_NATIVE_TARGET_FACTS) {
    const error = new TypeError(
      "legacy native-target evidence exceeds its compatibility bound",
    );
    error.code = "LEGACY_RECOVERY_LIMIT";
    throw error;
  }
  return entries;
}

export function buildLegacyNativeTargetEvidence(input) {
  const entries =
    input.entries ??
    collectLegacyNativeTargetEntries(input);
  if (entries.length === 0) {
    return null;
  }
  const base = {
    schemaVersion: SCHEMA_VERSION,
    evidenceVersion: LEGACY_EVIDENCE_VERSION,
    runId: input.state.runId,
    stateRevision: input.state.revision,
    historyDigest: digestJson({
      runId: input.state.runId,
      stateDigest: digestJson(input.state),
      definition: {
        id: input.definition.definitionId,
        digest: digestJson(input.definition),
      },
      operations: sortedFacts(
        input.operations,
        "operationId",
      ),
      governorDecisions: sortedFacts(
        input.governorDecisions,
        "decisionId",
      ),
      transitions: sortedFacts(
        input.transitions,
        "transitionId",
      ),
      reports: sortedFacts(input.reports, "reportId"),
      bindings: sortedFacts(input.bindings, "bindingId"),
    }),
    entries,
  };
  return assertContract(
    "legacy native target evidence",
    {
      ...base,
      evidenceDigest: digestJson(base),
    },
    validateLegacyNativeTargetEvidence,
  );
}

export function legacyCompatibilityKeys(evidence) {
  return new Set(
    (evidence?.entries ?? []).map(legacyEntryKey),
  );
}

export function terminalStateForRecovery(state, receipt) {
  const {
    pendingTransitionId: _pendingTransitionId,
    ...withoutPending
  } = state;
  return {
    ...withoutPending,
    status: "failed",
    needsHuman: true,
    latestRecoveryId: receipt.recoveryId,
    revision: receipt.toRevision,
    updatedAt: receipt.createdAt,
  };
}

export function createLegacyQuarantineReceipt(input) {
  const recoveryId = recoveryIdFor(
    input.state.runId,
    input.requestId,
  );
  const common = {
    schemaVersion: SCHEMA_VERSION,
    recoveryVersion: LEGACY_RECOVERY_VERSION,
    recoveryId,
    runId: input.state.runId,
    requestId: input.requestId,
    requestDigest: recoveryRequestDigest({
      runId: input.state.runId,
      requestId: input.requestId,
      actorId: input.actorId,
      expectedRevision: input.state.revision,
      expectedEvidenceDigest:
        input.evidence.evidenceDigest,
    }),
    actorKind: "root",
    actorId: input.actorId,
    reason: LEGACY_RECOVERY_REASON,
    evidenceDigest: input.evidence.evidenceDigest,
    legacyFactCount: input.evidence.entries.length,
    priorStateDigest: digestJson(input.state),
    fromRevision: input.state.revision,
    toRevision: input.state.revision + 1,
    createdAt: input.createdAt,
  };
  const terminal = terminalStateForRecovery(input.state, {
    ...common,
    terminalStateDigest: "0".repeat(64),
  });
  return assertContract(
    "legacy quarantine receipt",
    {
      ...common,
      terminalStateDigest: digestJson(terminal),
    },
    validateLegacyQuarantineReceipt,
  );
}
