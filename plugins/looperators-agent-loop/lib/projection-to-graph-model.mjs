const STATUSES = new Set([
  "draft",
  "running",
  "paused",
  "interrupted",
  "succeeded",
  "capped",
  "cancelled",
  "failed",
]);
const NODE_STATES = new Set([
  "active",
  "waiting",
  "bound",
  "unbound",
  "terminal",
]);
const TIMELINE_KINDS = new Set([
  "event",
  "report",
  "transition",
  "governor-decision",
  "recovery",
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const NODE_DEFINITIONS = [
  {
    id: "root",
    kind: "root",
    role: "root",
  },
  {
    id: "role:implementer",
    kind: "worker-role",
    role: "implementer",
  },
  {
    id: "role:reviewer",
    kind: "worker-role",
    role: "reviewer",
  },
];
const EDGE_DEFINITIONS = [
  {
    id: "root-governs-implementer",
    source: "root",
    target: "role:implementer",
    kind: "governs",
  },
  {
    id: "implementer-handoff-reviewer",
    source: "role:implementer",
    target: "role:reviewer",
    kind: "handoff",
  },
  {
    id: "reviewer-feedback-implementer",
    source: "role:reviewer",
    target: "role:implementer",
    kind: "feedback",
  },
  {
    id: "reviewer-verdict-root",
    source: "role:reviewer",
    target: "root",
    kind: "verdict",
  },
];

function projectionError(code, message) {
  return Object.assign(new TypeError(message), { code });
}

function invalid(message) {
  throw projectionError(
    "GRAPH_VIEW_PROJECTION_INVALID",
    message,
  );
}

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function boundedString(value, path, max = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max
  ) {
    invalid(`${path} must be a bounded string`);
  }
  return value;
}

function optionalString(value, path, max = 256) {
  return value === undefined
    ? undefined
    : boundedString(value, path, max);
}

function boundedInteger(
  value,
  path,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    invalid(`${path} must be a bounded integer`);
  }
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") {
    invalid(`${path} must be a boolean`);
  }
  return value;
}

function assertProjectionEnvelope(value, options) {
  if (!isRecord(value)) {
    invalid("projection must be an object");
  }
  if (
    value.schemaVersion !== 1 ||
    value.storeVersion !== 1 ||
    value.projectionVersion !== 3 ||
    value.recipe !== "review-until-clean"
  ) {
    invalid("projection version or recipe is unsupported");
  }
  const runId = boundedString(value.runId, "projection.runId", 128);
  const revision = boundedInteger(
    value.revision,
    "projection.revision",
  );
  if (
    !isRecord(value.integrity) ||
    value.integrity.status !== "verified" ||
    value.integrity.verifiedRevision !== revision
  ) {
    throw projectionError(
      "GRAPH_VIEW_PROJECTION_UNVERIFIED",
      "projection integrity is not verified",
    );
  }
  if (
    typeof value.projectionDigest !== "string" ||
    !DIGEST.test(value.projectionDigest)
  ) {
    invalid("projection.projectionDigest is invalid");
  }
  if (
    options.expectedProjectionDigest !== undefined &&
    value.projectionDigest !== options.expectedProjectionDigest
  ) {
    throw projectionError(
      "PROJECTION_DIGEST_MISMATCH",
      "projection digest does not match the expected snapshot",
    );
  }
  if (
    options.expectedRunId !== undefined &&
    runId !== options.expectedRunId
  ) {
    throw projectionError(
      "SNAPSHOT_IDENTITY_MISMATCH",
      "projection belongs to another run",
    );
  }
  return {
    runId,
    revision,
    projectionDigest: value.projectionDigest,
  };
}

function mapNodes(value) {
  if (!Array.isArray(value) || value.length !== NODE_DEFINITIONS.length) {
    invalid("projection.nodes must contain exactly three nodes");
  }
  const byId = new Map(value.map((node) => [node?.id, node]));
  return NODE_DEFINITIONS.map((definition) => {
    const node = byId.get(definition.id);
    if (
      !isRecord(node) ||
      node.kind !== definition.kind ||
      (definition.role !== "root" && node.role !== definition.role) ||
      !NODE_STATES.has(node.state)
    ) {
      invalid(`projection node ${definition.id} is invalid`);
    }
    const nativeAgentId = optionalString(
      node.nativeAgentId,
      `projection node ${definition.id}.nativeAgentId`,
      256,
    );
    const nativeAgentType = optionalString(
      node.nativeAgentType,
      `projection node ${definition.id}.nativeAgentType`,
      128,
    );
    return {
      id: definition.id,
      kind: definition.kind,
      role: definition.role,
      label: boundedString(
        node.label,
        `projection node ${definition.id}.label`,
        80,
      ),
      state: node.state,
      ...(nativeAgentId ? { nativeAgentId } : {}),
      ...(nativeAgentType ? { nativeAgentType } : {}),
    };
  });
}

function mapEdges(value) {
  if (!Array.isArray(value) || value.length !== EDGE_DEFINITIONS.length) {
    invalid("projection.edges must contain exactly four relationships");
  }
  const byId = new Map(value.map((edge) => [edge?.id, edge]));
  return EDGE_DEFINITIONS.map((definition) => {
    const edge = byId.get(definition.id);
    if (
      !isRecord(edge) ||
      edge.source !== definition.source ||
      edge.target !== definition.target ||
      edge.kind !== definition.kind
    ) {
      invalid(`projection edge ${definition.id} is invalid`);
    }
    return {
      ...definition,
      active: requireBoolean(
        edge.active,
        `projection edge ${definition.id}.active`,
      ),
      reportCount: boundedInteger(
        edge.reportCount,
        `projection edge ${definition.id}.reportCount`,
      ),
    };
  });
}

function mapPending(value, lapCap) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !["implementer", "reviewer"].includes(value.role) ||
    value.kind !== `activate-${value.role}`
  ) {
    invalid("projection.pending is invalid");
  }
  boundedString(
    value.transitionId,
    "projection.pending.transitionId",
    128,
  );
  return {
    role: value.role,
    kind: value.kind,
    lap: boundedInteger(value.lap, "projection.pending.lap", {
      max: lapCap,
    }),
  };
}

function mapLatestReport(value) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !["implementer", "reviewer"].includes(value.fromRole) ||
    !["info", "verdict"].includes(value.type)
  ) {
    invalid("projection.latestReport is invalid");
  }
  boundedString(
    value.reportId,
    "projection.latestReport.reportId",
    128,
  );
  if (
    value.verdict !== undefined &&
    !["issues", "clean"].includes(value.verdict)
  ) {
    invalid("projection.latestReport.verdict is invalid");
  }
  return {
    fromRole: value.fromRole,
    type: value.type,
    ...(value.verdict ? { verdict: value.verdict } : {}),
    issueCount: boundedInteger(
      value.issueCount,
      "projection.latestReport.issueCount",
    ),
  };
}

function mapTimeline(value) {
  if (!Array.isArray(value) || value.length > 32) {
    invalid("projection.timeline is invalid");
  }
  return value.map((item, index) => {
    if (!isRecord(item) || !TIMELINE_KINDS.has(item.kind)) {
      invalid(`projection.timeline[${index}] is invalid`);
    }
    const role = optionalString(
      item.role,
      `projection.timeline[${index}].role`,
      16,
    );
    if (
      role !== undefined &&
      !["implementer", "reviewer"].includes(role)
    ) {
      invalid(`projection.timeline[${index}].role is invalid`);
    }
    return {
      id: boundedString(
        item.id,
        `projection.timeline[${index}].id`,
        128,
      ),
      at: boundedString(
        item.at,
        `projection.timeline[${index}].at`,
        40,
      ),
      label: boundedString(
        item.label,
        `projection.timeline[${index}].label`,
        128,
      ),
      kind: item.kind,
      ...(role ? { role } : {}),
    };
  });
}

export function projectionToAgentGraphModel(
  value,
  options = {},
) {
  const identity = assertProjectionEnvelope(value, options);
  if (!STATUSES.has(value.status)) {
    invalid("projection.status is invalid");
  }
  const lapCap = boundedInteger(
    value.lapCap,
    "projection.lapCap",
    { min: 1, max: 6 },
  );
  const currentLap = boundedInteger(
    value.currentLap,
    "projection.currentLap",
    { max: lapCap },
  );
  if (!isRecord(value.continuationLease)) {
    invalid("projection.continuationLease must be an object");
  }
  const granted = boundedInteger(
    value.continuationLease.granted,
    "projection.continuationLease.granted",
    { max: 6 },
  );
  const consumed = boundedInteger(
    value.continuationLease.consumed,
    "projection.continuationLease.consumed",
    { max: granted },
  );
  const pending = mapPending(value.pending, lapCap);
  const latestReport = mapLatestReport(value.latestReport);
  let recovery;
  if (value.recovery !== undefined) {
    if (!isRecord(value.recovery)) {
      invalid("projection.recovery is invalid");
    }
    boundedString(
      value.recovery.recoveryId,
      "projection.recovery.recoveryId",
      128,
    );
    recovery = {
      reason: boundedString(
        value.recovery.reason,
        "projection.recovery.reason",
        80,
      ),
    };
  }
  return {
    identity: {
      ...identity,
      integrity: "verified",
    },
    status: value.status,
    currentLap,
    lapCap,
    lease: { granted, consumed },
    cancelRequested: requireBoolean(
      value.cancelRequested,
      "projection.cancelRequested",
    ),
    needsHuman: requireBoolean(
      value.needsHuman,
      "projection.needsHuman",
    ),
    nodes: mapNodes(value.nodes),
    edges: mapEdges(value.edges),
    ...(pending ? { pending } : {}),
    ...(latestReport ? { latestReport } : {}),
    ...(recovery ? { recovery } : {}),
    timeline: mapTimeline(value.timeline),
  };
}
