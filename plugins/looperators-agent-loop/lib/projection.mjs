import {
  canonicalJson,
  compareCodePoints,
  digestJson,
} from "./canonical-json.mjs";
import {
  PROJECTION_VERSION,
  SCHEMA_VERSION,
  STORE_VERSION,
  assertContract,
  validateGraphProjection,
} from "./contracts.mjs";

export const MAX_PROJECTION_BYTES = 512 * 1024;
export const MAX_PROJECTION_TIMELINE = 32;

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "capped",
  "cancelled",
  "failed",
]);

function projectionError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function roleForTransition(transition) {
  if (transition.kind === "activate-implementer") {
    return "implementer";
  }
  if (transition.kind === "activate-reviewer") {
    return "reviewer";
  }
  return undefined;
}

function factOrder(left, right) {
  const timeOrder = compareCodePoints(left.at, right.at);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  const kindOrder = compareCodePoints(left.kind, right.kind);
  return kindOrder !== 0
    ? kindOrder
    : compareCodePoints(left.id, right.id);
}

function canonicalizeEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.conflictEligible
      ? event.semanticKey
      : `${event.semanticKey}:${event.eventId}`;
    const values = groups.get(key) ?? [];
    values.push(event);
    groups.set(key, values);
  }
  const canonical = [];
  let conflicts = 0;
  for (const values of groups.values()) {
    const sorted = [...values].sort((left, right) =>
      compareCodePoints(left.eventId, right.eventId),
    );
    canonical.push(sorted[0]);
    if (
      sorted[0].conflictEligible &&
      new Set(sorted.map((event) => event.payloadDigest)).size > 1
    ) {
      conflicts += 1;
    }
  }
  canonical.sort((left, right) =>
    compareCodePoints(left.eventId, right.eventId),
  );
  return { canonical, conflicts };
}

function activeBindings(bindings, rootSessionId) {
  const byRole = new Map();
  const byAgentId = new Map();
  for (const binding of bindings) {
    if (
      binding.method !== "capability-token-v1" ||
      binding.rootSessionId !== rootSessionId ||
      binding.revokedAt !== undefined ||
      !["implementer", "reviewer"].includes(binding.role)
    ) {
      continue;
    }
    if (byRole.has(binding.role) || byAgentId.has(binding.agentId)) {
      throw projectionError(
        "HISTORY_CORRUPT",
        "verified projection requires unique active worker bindings",
      );
    }
    byRole.set(binding.role, binding);
    byAgentId.set(binding.agentId, binding);
  }
  return { byRole, byAgentId };
}

function workerTypes(events) {
  const byAgentId = new Map();
  const starts = events
    .filter(
      (event) =>
        event.event === "SubagentStart" &&
        typeof event.agentId === "string",
    )
    .sort((left, right) => {
      const timeOrder = compareCodePoints(
        left.observedAt,
        right.observedAt,
      );
      return timeOrder !== 0
        ? timeOrder
        : compareCodePoints(left.eventId, right.eventId);
    });
  for (const event of starts) {
    if (event.agentType) {
      byAgentId.set(event.agentId, event.agentType);
    }
  }
  return byAgentId;
}

function nodeState(status, pendingRole, role, bound) {
  if (TERMINAL_STATUSES.has(status)) {
    return "terminal";
  }
  if (status === "running" && pendingRole === role) {
    return "active";
  }
  return bound ? "bound" : "unbound";
}

function timelineEvent(event, roleByAgentId) {
  return {
    kind: "event",
    id: event.eventId,
    at: event.observedAt,
    label: event.event,
    ...(event.agentId && roleByAgentId.has(event.agentId)
      ? { role: roleByAgentId.get(event.agentId).role }
      : {}),
  };
}

function timelineReport(report, role) {
  const suffix =
    report.type === "verdict"
      ? `: ${report.verdict}`
      : report.status
        ? `: ${report.status}`
        : "";
  return {
    kind: "report",
    id: report.reportId,
    at: report.createdAt,
    label: `${role} ${report.type}${suffix}`,
    role,
  };
}

function timelineTransition(transition) {
  const role = roleForTransition(transition);
  return {
    kind: "transition",
    id: transition.transitionId,
    at: transition.createdAt,
    label: transition.kind,
    ...(role ? { role } : {}),
  };
}

function timelineDecision(decision) {
  return {
    kind: "governor-decision",
    id: decision.decisionId,
    at: decision.createdAt,
    label: `${decision.action}: ${decision.reasonCode}`,
  };
}

function timelineRecovery(recovery) {
  return {
    kind: "recovery",
    id: recovery.recoveryId,
    at: recovery.createdAt,
    label: "legacy history quarantined",
  };
}

function checkedRole(bindingByAgentId, agentId, factKind) {
  const binding = bindingByAgentId.get(agentId);
  if (!binding) {
    throw projectionError(
      "HISTORY_CORRUPT",
      `verified ${factKind} lacks an active worker role binding`,
    );
  }
  return binding.role;
}

export function assertGraphProjectionIntegrity(value) {
  assertContract(
    "graph projection",
    value,
    validateGraphProjection,
  );
  const { projectionDigest, ...base } = value;
  if (projectionDigest !== digestJson(base)) {
    throw projectionError(
      "PROJECTION_DIGEST_MISMATCH",
      "graph projection digest is invalid",
    );
  }
  const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (bytes > MAX_PROJECTION_BYTES) {
    throw projectionError(
      "PROJECTION_TOO_LARGE",
      "graph projection exceeds its canonical payload bound",
    );
  }
  return value;
}

export function canonicalProjectionBytes(value) {
  return canonicalJson(assertGraphProjectionIntegrity(value));
}

export function snapshotIdentity(value) {
  const projection = assertGraphProjectionIntegrity(value);
  return {
    runId: projection.runId,
    revision: projection.revision,
    eventWatermark: projection.eventWatermark,
  };
}

export function buildAgentLoopProjection(input) {
  const {
    state,
    definition,
    bindings = [],
    events = [],
    reports = [],
    transitions = [],
    operations = [],
    governorDecisions = [],
    recoveries = [],
    diagnostics = [],
    timelineLimit = MAX_PROJECTION_TIMELINE,
  } = input;
  if (
    !Number.isInteger(timelineLimit) ||
    timelineLimit < 0 ||
    timelineLimit > MAX_PROJECTION_TIMELINE
  ) {
    throw projectionError(
      "INVALID_PROJECTION_LIMIT",
      "projection timeline limit is invalid",
    );
  }

  const { canonical: canonicalEvents, conflicts } =
    canonicalizeEvents(events);
  const appliedOperations = operations
    .filter((operation) => operation.toRevision <= state.revision)
    .sort(
      (left, right) =>
        left.toRevision - right.toRevision ||
        compareCodePoints(left.operationId, right.operationId),
    );
  const appliedDecisions = governorDecisions
    .filter((decision) => decision.toRevision <= state.revision)
    .sort(
      (left, right) =>
        left.toRevision - right.toRevision ||
        compareCodePoints(left.decisionId, right.decisionId),
    );
  const appliedRecoveries = recoveries
    .filter(
      (recovery) =>
        recovery.toRevision <= state.revision,
    )
    .sort(
      (left, right) =>
        left.toRevision - right.toRevision ||
        compareCodePoints(
          left.recoveryId,
          right.recoveryId,
        ),
    );
  if (
    appliedRecoveries.length > 1 ||
    state.latestRecoveryId !==
      appliedRecoveries.at(-1)?.recoveryId
  ) {
    throw projectionError(
      "HISTORY_CORRUPT",
      "verified projection has an invalid recovery receipt set",
    );
  }
  const appliedReportIds = new Set(
    appliedOperations.map((operation) => operation.reportId).filter(Boolean),
  );
  const appliedTransitionIds = new Set(
    appliedOperations.map((operation) => operation.transitionId),
  );
  const appliedReports = reports
    .filter((report) => appliedReportIds.has(report.reportId))
    .sort((left, right) =>
      compareCodePoints(left.reportId, right.reportId),
    );
  const appliedTransitions = transitions
    .filter((transition) =>
      appliedTransitionIds.has(transition.transitionId),
    )
    .sort((left, right) =>
      compareCodePoints(left.transitionId, right.transitionId),
    );

  if (
    appliedReportIds.size !== appliedReports.length ||
    appliedTransitionIds.size !== appliedTransitions.length
  ) {
    throw projectionError(
      "HISTORY_CORRUPT",
      "verified receipt history references missing graph facts",
    );
  }

  const bindingIndex = activeBindings(
    bindings,
    state.rootSessionId,
  );
  const roleByAgentId = bindingIndex.byAgentId;
  const pendingTransition = state.pendingTransitionId
    ? appliedTransitions.find(
        (transition) =>
          transition.transitionId === state.pendingTransitionId,
      )
    : undefined;
  const pendingRole = pendingTransition
    ? roleForTransition(pendingTransition)
    : undefined;
  if (state.pendingTransitionId && !pendingRole) {
    throw projectionError(
      "HISTORY_CORRUPT",
      "verified pending transition is not a worker obligation",
    );
  }

  const nativeTypes = workerTypes(canonicalEvents);
  const nodes = [
    {
      id: "root",
      kind: "root",
      label: "Governor",
      state: TERMINAL_STATUSES.has(state.status)
        ? "terminal"
        : ["paused", "interrupted"].includes(state.status)
          ? "waiting"
          : "active",
    },
    ...["implementer", "reviewer"].map((role) => {
      const binding = bindingIndex.byRole.get(role);
      const nativeBinding =
        binding && !binding.agentId.startsWith("role:")
          ? binding
          : undefined;
      return {
        id: `role:${role}`,
        kind: "worker-role",
        role,
        label: role === "implementer" ? "Implementer" : "Reviewer",
        state: nodeState(
          state.status,
          pendingRole,
          role,
          Boolean(binding),
        ),
        ...(nativeBinding
          ? {
              nativeAgentId: nativeBinding.agentId,
              ...(nativeTypes.has(nativeBinding.agentId)
                ? {
                    nativeAgentType:
                      nativeTypes.get(nativeBinding.agentId),
                  }
                : {}),
            }
          : {}),
      };
    }),
  ];

  const reportRoles = new Map(
    appliedReports.map((report) => [
      report.reportId,
      checkedRole(
        roleByAgentId,
        report.fromNode,
        "report",
      ),
    ]),
  );
  const implementerReports = appliedReports.filter(
    (report) => reportRoles.get(report.reportId) === "implementer",
  );
  const reviewerIssueReports = appliedReports.filter(
    (report) =>
      reportRoles.get(report.reportId) === "reviewer" &&
      report.verdict === "issues",
  );
  const reviewerCleanReports = appliedReports.filter(
    (report) =>
      reportRoles.get(report.reportId) === "reviewer" &&
      report.verdict === "clean",
  );
  const edges = [
    {
      id: "root-governs-implementer",
      source: "root",
      target: "role:implementer",
      kind: "governs",
      active: state.status === "running" && pendingRole === "implementer",
      reportCount: 0,
    },
    {
      id: "implementer-handoff-reviewer",
      source: "role:implementer",
      target: "role:reviewer",
      kind: "handoff",
      active: state.status === "running" && pendingRole === "reviewer",
      reportCount: implementerReports.length,
    },
    {
      id: "reviewer-feedback-implementer",
      source: "role:reviewer",
      target: "role:implementer",
      kind: "feedback",
      active:
        state.status === "running" &&
        pendingRole === "implementer" &&
        reviewerIssueReports.length > 0,
      reportCount: reviewerIssueReports.length,
    },
    {
      id: "reviewer-verdict-root",
      source: "role:reviewer",
      target: "root",
      kind: "verdict",
      active:
        state.status === "succeeded" &&
        reviewerCleanReports.length > 0,
      reportCount: reviewerCleanReports.length,
    },
  ];

  const latestReport = state.latestReportId
    ? appliedReports.find(
        (report) => report.reportId === state.latestReportId,
      )
    : undefined;
  if (state.latestReportId && !latestReport) {
    throw projectionError(
      "HISTORY_CORRUPT",
      "verified latest report is missing from applied receipts",
    );
  }

  const timeline = [
    ...canonicalEvents.map((event) =>
      timelineEvent(event, roleByAgentId),
    ),
    ...appliedReports.map((report) =>
      timelineReport(
        report,
        reportRoles.get(report.reportId),
      ),
    ),
    ...appliedTransitions.map(timelineTransition),
    ...appliedDecisions.map(timelineDecision),
    ...appliedRecoveries.map(timelineRecovery),
  ]
    .sort(factOrder)
    .slice(-timelineLimit);
  const sortedEventIds = [
    ...new Set(events.map((event) => event.eventId)),
  ].sort(compareCodePoints);
  const eventWatermark = {
    eventCount: sortedEventIds.length,
    ...(sortedEventIds.length > 0
      ? { lastEventId: sortedEventIds.at(-1) }
      : {}),
  };
  const base = {
    schemaVersion: SCHEMA_VERSION,
    storeVersion: STORE_VERSION,
    projectionVersion: PROJECTION_VERSION,
    runId: state.runId,
    revision: state.revision,
    status: state.status,
    recipe: state.recipe,
    currentLap: state.currentLap,
    lapCap: definition.lapCap,
    continuationLease: state.continuationLease,
    cancelRequested: state.cancelRequested,
    needsHuman: state.needsHuman ?? false,
    integrity: {
      status: "verified",
      verifiedRevision: state.revision,
    },
    eventWatermark,
    nodes,
    edges,
    ...(pendingTransition
      ? {
          pending: {
            transitionId: pendingTransition.transitionId,
            kind: pendingTransition.kind,
            role: pendingRole,
            lap: pendingTransition.lap,
          },
        }
      : {}),
    ...(latestReport
      ? {
          latestReport: {
            reportId: latestReport.reportId,
            fromRole: reportRoles.get(latestReport.reportId),
            type: latestReport.type,
            ...(latestReport.verdict
              ? { verdict: latestReport.verdict }
              : {}),
            issueCount: latestReport.issues?.length ?? 0,
          },
        }
      : {}),
    ...(appliedRecoveries.length === 1
      ? {
          recovery: {
            recoveryId:
              appliedRecoveries[0].recoveryId,
            reason: "legacy-history-quarantined",
          },
        }
      : {}),
    counts: {
      events: canonicalEvents.length,
      reports: appliedReports.length,
      transitions: appliedTransitions.length,
      operations: appliedOperations.length,
      governorDecisions: appliedDecisions.length,
      recoveries: appliedRecoveries.length,
      diagnostics: diagnostics.length,
      conflicts,
      corrupt: 0,
    },
    timeline,
  };
  return assertGraphProjectionIntegrity({
    ...base,
    projectionDigest: digestJson(base),
  });
}
