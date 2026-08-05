import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  compareCodePoints,
  digestJson,
  sha256,
} from "./canonical-json.mjs";

export const SCHEMA_VERSION = 1;
export const SEMANTIC_KEY_VERSION = 1;
export const STORE_VERSION = 1;
export const PROJECTION_VERSION = 3;
export const LEGACY_RECOVERY_VERSION = 1;
export const LEGACY_EVIDENCE_VERSION = 1;
export const HOOK_COLLECTOR_PROTOCOL =
  "looperators-hook-collector-v2";
export const MAX_LEGACY_NATIVE_TARGET_FACTS = 16;

export const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
]);

export const RUN_STATUSES = new Set([
  "draft",
  "running",
  "paused",
  "succeeded",
  "capped",
  "cancelled",
  "failed",
  "interrupted",
]);

export const ACTIVE_RUN_STATUSES = new Set([
  "draft",
  "running",
  "paused",
  "interrupted",
]);

const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const WORKER_ROLES = new Set(["implementer", "reviewer"]);
export const GOVERNOR_ACTIONS = new Set([
  "block",
  "cap",
  "interrupt",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function stringField(errors, value, name, options = {}) {
  const { optional = false, max = 256, pattern = null } = options;
  if (value === undefined && optional) {
    return;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    (pattern && !pattern.test(value))
  ) {
    errors.push(`${name} must be a non-empty string up to ${max} characters`);
  }
}

function integerField(errors, value, name, options = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}`);
  }
}

function rejectUnknown(errors, value, allowed, name) {
  if (!isPlainObject(value)) {
    errors.push(`${name} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${name}.${key} is not allowed`);
    }
  }
}

function utf8StringField(errors, value, name, maxBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    errors.push(
      `${name} must be a non-empty UTF-8 string up to ${maxBytes} bytes`,
    );
  }
}

export function validateNormalizedHookEvent(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "semanticKeyVersion",
    "eventId",
    "semanticKey",
    "sessionId",
    "turnId",
    "event",
    "agentId",
    "agentType",
    "toolUseId",
    "stopHookActive",
    "observedAt",
    "payloadDigest",
    "payloadSummary",
    "causeRef",
    "conflictEligible",
  ]);
  rejectUnknown(errors, value, allowed, "event");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("event.schemaVersion must be 1");
  }
  if (value.semanticKeyVersion !== SEMANTIC_KEY_VERSION) {
    errors.push("event.semanticKeyVersion must be 1");
  }
  stringField(errors, value.eventId, "event.eventId", {
    max: 68,
    pattern: /^evt_[a-f0-9]{64}$/,
  });
  stringField(errors, value.semanticKey, "event.semanticKey", {
    max: 71,
    pattern: /^sem-v1:[a-f0-9]{64}$/,
  });
  stringField(errors, value.sessionId, "event.sessionId");
  stringField(errors, value.turnId, "event.turnId", { optional: true });
  stringField(errors, value.event, "event.event", { max: 64 });
  stringField(errors, value.agentId, "event.agentId", { optional: true });
  stringField(errors, value.agentType, "event.agentType", {
    optional: true,
    max: 128,
  });
  stringField(errors, value.toolUseId, "event.toolUseId", { optional: true });
  if (
    value.stopHookActive !== undefined &&
    typeof value.stopHookActive !== "boolean"
  ) {
    errors.push("event.stopHookActive must be a boolean");
  }
  if (!isTimestamp(value.observedAt)) {
    errors.push("event.observedAt must be an ISO date-time");
  }
  stringField(errors, value.payloadDigest, "event.payloadDigest", {
    max: 64,
    pattern: SHA256,
  });
  if (value.payloadSummary !== undefined && !isPlainObject(value.payloadSummary)) {
    errors.push("event.payloadSummary must be an object");
  }
  stringField(errors, value.causeRef, "event.causeRef", { optional: true });
  if (typeof value.conflictEligible !== "boolean") {
    errors.push("event.conflictEligible must be a boolean");
  }
  return errors;
}

export function validateLoopDefinition(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "definitionId",
    "runId",
    "requestId",
    "requestDigest",
    "recipe",
    "goal",
    "implementerInstructions",
    "reviewerInstructions",
    "lapCap",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "definition");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("definition.schemaVersion must be 1");
  }
  stringField(errors, value.definitionId, "definition.definitionId", {
    max: 75,
    pattern: /^definition_[a-f0-9]{64}$/,
  });
  stringField(errors, value.runId, "definition.runId", {
    max: 68,
    pattern: /^run_[a-f0-9]{64}$/,
  });
  stringField(errors, value.requestId, "definition.requestId", {
    max: 128,
    pattern: SAFE_FILE_ID,
  });
  stringField(errors, value.requestDigest, "definition.requestDigest", {
    max: 64,
    pattern: SHA256,
  });
  if (value.recipe !== "review-until-clean") {
    errors.push("definition.recipe must be review-until-clean");
  }
  utf8StringField(errors, value.goal, "definition.goal", 8 * 1024);
  utf8StringField(
    errors,
    value.implementerInstructions,
    "definition.implementerInstructions",
    16 * 1024,
  );
  utf8StringField(
    errors,
    value.reviewerInstructions,
    "definition.reviewerInstructions",
    16 * 1024,
  );
  integerField(errors, value.lapCap, "definition.lapCap", {
    min: 1,
    max: 6,
  });
  if (!isTimestamp(value.createdAt)) {
    errors.push("definition.createdAt must be an ISO date-time");
  }
  return errors;
}

export function validateWorkerObservation(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "observationId",
    "runId",
    "requestId",
    "requestDigest",
    "rootSessionId",
    "role",
    "spawnToolUseIds",
    "subagentStartEventIds",
    "bindingIds",
    "observationDigest",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "observation");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("observation.schemaVersion must be 1");
  }
  stringField(errors, value.observationId, "observation.observationId", {
    max: 128,
    pattern: /^observation_[a-f0-9]{64}$/,
  });
  stringField(errors, value.runId, "observation.runId", {
    max: 128,
  });
  stringField(errors, value.requestId, "observation.requestId", {
    max: 128,
    pattern: SAFE_FILE_ID,
  });
  stringField(
    errors,
    value.requestDigest,
    "observation.requestDigest",
    {
      max: 64,
      pattern: SHA256,
    },
  );
  stringField(
    errors,
    value.rootSessionId,
    "observation.rootSessionId",
  );
  if (!WORKER_ROLES.has(value.role)) {
    errors.push("observation.role is invalid");
  }
  for (const [field, pattern] of [
    ["spawnToolUseIds", null],
    ["subagentStartEventIds", /^evt_[a-f0-9]{64}$/],
    ["bindingIds", /^binding_[a-f0-9]{64}$/],
  ]) {
    const items = value[field];
    if (
      !Array.isArray(items) ||
      items.length > 64 ||
      new Set(items).size !== items.length
    ) {
      errors.push(
        `observation.${field} must contain at most 64 unique strings`,
      );
      continue;
    }
    for (const item of items) {
      if (
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 256 ||
        (pattern && !pattern.test(item))
      ) {
        errors.push(`observation.${field} contains an invalid id`);
      }
    }
    const sorted = [...items].sort(compareCodePoints);
    if (canonicalJson(sorted) !== canonicalJson(items)) {
      errors.push(`observation.${field} must be code-point sorted`);
    }
  }
  stringField(
    errors,
    value.observationDigest,
    "observation.observationDigest",
    {
      max: 64,
      pattern: SHA256,
    },
  );
  if (!isTimestamp(value.createdAt)) {
    errors.push("observation.createdAt must be an ISO date-time");
  }
  return errors;
}

export function validateLoopOperation(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "operationId",
    "runId",
    "requestId",
    "requestDigest",
    "kind",
    "actorKind",
    "actorId",
    "fromRevision",
    "toRevision",
    "reportId",
    "transitionId",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "operation");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("operation.schemaVersion must be 1");
  }
  stringField(errors, value.operationId, "operation.operationId", {
    max: 67,
    pattern: /^op_[a-f0-9]{64}$/,
  });
  stringField(errors, value.runId, "operation.runId", { max: 128 });
  stringField(errors, value.requestId, "operation.requestId", {
    max: 128,
    pattern: SAFE_FILE_ID,
  });
  stringField(errors, value.requestDigest, "operation.requestDigest", {
    max: 64,
    pattern: SHA256,
  });
  if (
    ![
      "start",
      "report",
      "pause",
      "resume",
      "cancel",
      "interrupt",
    ].includes(
      value.kind,
    )
  ) {
    errors.push("operation.kind is invalid");
  }
  if (!["root", "worker"].includes(value.actorKind)) {
    errors.push("operation.actorKind is invalid");
  }
  stringField(errors, value.actorId, "operation.actorId");
  integerField(errors, value.fromRevision, "operation.fromRevision");
  integerField(errors, value.toRevision, "operation.toRevision");
  if (
    Number.isInteger(value.fromRevision) &&
    Number.isInteger(value.toRevision) &&
    value.toRevision !== value.fromRevision + 1
  ) {
    errors.push("operation.toRevision must equal fromRevision + 1");
  }
  stringField(errors, value.reportId, "operation.reportId", {
    optional: value.kind !== "report",
    max: 128,
  });
  stringField(errors, value.transitionId, "operation.transitionId", {
    max: 128,
  });
  if (!isTimestamp(value.createdAt)) {
    errors.push("operation.createdAt must be an ISO date-time");
  }
  return errors;
}

export function validateLoopReport(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "reportId",
    "runId",
    "requestId",
    "requestDigest",
    "fromRevision",
    "toRevision",
    "fromNode",
    "receiver",
    "routedToNode",
    "type",
    "status",
    "verdict",
    "issues",
    "summary",
    "originEventId",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "report");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("report.schemaVersion must be 1");
  }
  stringField(errors, value.reportId, "report.reportId", { max: 128 });
  stringField(errors, value.runId, "report.runId", { max: 128 });
  stringField(errors, value.requestId, "report.requestId", {
    optional: value.requestDigest === undefined,
    max: 128,
    pattern: SAFE_FILE_ID,
  });
  stringField(errors, value.requestDigest, "report.requestDigest", {
    optional: value.requestId === undefined,
    max: 64,
    pattern: SHA256,
  });
  if (
    value.requestId !== undefined ||
    value.requestDigest !== undefined ||
    value.fromRevision !== undefined ||
    value.toRevision !== undefined
  ) {
    integerField(errors, value.fromRevision, "report.fromRevision");
    integerField(errors, value.toRevision, "report.toRevision", {
      min: 1,
    });
    if (
      Number.isInteger(value.fromRevision) &&
      Number.isInteger(value.toRevision) &&
      value.toRevision !== value.fromRevision + 1
    ) {
      errors.push("report.toRevision must equal fromRevision + 1");
    }
    if (
      value.requestId === undefined ||
      value.requestDigest === undefined
    ) {
      errors.push(
        "revision-bearing reports require requestId and requestDigest",
      );
    }
  }
  stringField(errors, value.fromNode, "report.fromNode");
  if (!["root-master", "human"].includes(value.receiver)) {
    errors.push("report.receiver is invalid");
  }
  stringField(errors, value.routedToNode, "report.routedToNode", {
    optional: true,
  });
  if (!["verdict", "info", "relationship"].includes(value.type)) {
    errors.push("report.type is invalid");
  }
  if (value.status !== undefined && value.status !== "done") {
    errors.push("report.status is invalid");
  }
  if (value.type === "info" && value.status !== undefined && value.status !== "done") {
    errors.push("info report status must be done");
  }
  if (value.verdict !== undefined && !["clean", "issues"].includes(value.verdict)) {
    errors.push("report.verdict is invalid");
  }
  if (value.type === "verdict" && value.verdict === undefined) {
    errors.push("verdict reports require report.verdict");
  }
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues) || value.issues.length > 200) {
      errors.push("report.issues must be an array with at most 200 items");
    } else {
      value.issues.forEach((issue, index) => {
        if (!isPlainObject(issue)) {
          errors.push(`report.issues[${index}] must be an object`);
          return;
        }
        rejectUnknown(
          errors,
          issue,
          new Set(["message", "file", "line", "severity"]),
          `report.issues[${index}]`,
        );
        stringField(errors, issue.message, `report.issues[${index}].message`, {
          max: 4000,
        });
        stringField(errors, issue.file, `report.issues[${index}].file`, {
          optional: true,
          max: 2000,
        });
        if (issue.line !== undefined) {
          integerField(errors, issue.line, `report.issues[${index}].line`, {
            min: 1,
          });
        }
        if (
          issue.severity !== undefined &&
          !["info", "warn", "error"].includes(issue.severity)
        ) {
          errors.push(`report.issues[${index}].severity is invalid`);
        }
      });
    }
  }
  if (
    value.type === "verdict" &&
    value.verdict === "issues" &&
    (!Array.isArray(value.issues) || value.issues.length === 0)
  ) {
    errors.push("issues verdict requires at least one issue");
  }
  if (
    value.type === "verdict" &&
    value.verdict === "clean" &&
    Array.isArray(value.issues) &&
    value.issues.length > 0
  ) {
    errors.push("clean verdict cannot contain issues");
  }
  stringField(errors, value.summary, "report.summary", {
    optional: true,
    max: 8000,
  });
  stringField(errors, value.originEventId, "report.originEventId", {
    optional: true,
    max: 128,
  });
  if (!isTimestamp(value.createdAt)) {
    errors.push("report.createdAt must be an ISO date-time");
  }
  return errors;
}

export function validateLoopTransition(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "transitionId",
    "runId",
    "requestId",
    "requestDigest",
    "kind",
    "fromNode",
    "toNode",
    "originReportId",
    "originEventId",
    "lap",
    "leaseEpoch",
    "fromRevision",
    "toRevision",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "transition");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("transition.schemaVersion must be 1");
  }
  stringField(errors, value.transitionId, "transition.transitionId", {
    max: 128,
  });
  stringField(errors, value.runId, "transition.runId", { max: 128 });
  stringField(errors, value.requestId, "transition.requestId", {
    optional: true,
    max: 128,
  });
  stringField(errors, value.requestDigest, "transition.requestDigest", {
    optional: value.requestId === undefined,
    max: 64,
    pattern: SHA256,
  });
  if (
    ![
      "activate-reviewer",
      "activate-implementer",
      "succeed",
      "pause",
      "resume",
      "cancel",
      "interrupt",
      "cap",
    ].includes(value.kind)
  ) {
    errors.push("transition.kind is invalid");
  }
  for (const field of [
    "fromNode",
    "toNode",
    "originReportId",
    "originEventId",
  ]) {
    stringField(errors, value[field], `transition.${field}`, {
      optional: true,
    });
  }
  integerField(errors, value.lap, "transition.lap");
  if (value.leaseEpoch !== undefined) {
    integerField(errors, value.leaseEpoch, "transition.leaseEpoch");
  }
  if (
    value.fromRevision !== undefined ||
    value.toRevision !== undefined
  ) {
    integerField(
      errors,
      value.fromRevision,
      "transition.fromRevision",
    );
    integerField(errors, value.toRevision, "transition.toRevision");
    if (
      Number.isInteger(value.fromRevision) &&
      Number.isInteger(value.toRevision) &&
      value.toRevision !== value.fromRevision + 1
    ) {
      errors.push(
        "transition.toRevision must equal fromRevision + 1",
      );
    }
  }
  if (!isTimestamp(value.createdAt)) {
    errors.push("transition.createdAt must be an ISO date-time");
  }
  return errors;
}

export function validateGovernorDecision(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "decisionId",
    "runId",
    "obligationId",
    "originEventId",
    "hookEvent",
    "rootSessionId",
    "turnId",
    "agentId",
    "action",
    "reasonCode",
    "pendingTransitionId",
    "fromRevision",
    "toRevision",
    "leaseEpoch",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "governorDecision");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("governorDecision.schemaVersion must be 1");
  }
  stringField(errors, value.decisionId, "governorDecision.decisionId", {
    max: 73,
    pattern: /^decision_[a-f0-9]{64}$/,
  });
  stringField(errors, value.runId, "governorDecision.runId", {
    max: 128,
  });
  stringField(
    errors,
    value.obligationId,
    "governorDecision.obligationId",
    { max: 128 },
  );
  stringField(
    errors,
    value.originEventId,
    "governorDecision.originEventId",
    {
      max: 68,
      pattern: /^evt_[a-f0-9]{64}$/,
    },
  );
  if (!["Stop", "SubagentStop", "SessionStart"].includes(value.hookEvent)) {
    errors.push("governorDecision.hookEvent is invalid");
  }
  stringField(
    errors,
    value.rootSessionId,
    "governorDecision.rootSessionId",
  );
  stringField(errors, value.turnId, "governorDecision.turnId", {
    optional: value.hookEvent === "SessionStart",
  });
  stringField(errors, value.agentId, "governorDecision.agentId", {
    optional: true,
  });
  if (!GOVERNOR_ACTIONS.has(value.action)) {
    errors.push("governorDecision.action is invalid");
  }
  if (
    ![
      "pending-root-transition",
      "pending-worker-report",
      "lease-exhausted",
      "resume-in-flight",
    ].includes(value.reasonCode)
  ) {
    errors.push("governorDecision.reasonCode is invalid");
  }
  stringField(
    errors,
    value.pendingTransitionId,
    "governorDecision.pendingTransitionId",
    { max: 128 },
  );
  integerField(
    errors,
    value.fromRevision,
    "governorDecision.fromRevision",
  );
  integerField(
    errors,
    value.toRevision,
    "governorDecision.toRevision",
    { min: 1 },
  );
  if (
    Number.isInteger(value.fromRevision) &&
    Number.isInteger(value.toRevision) &&
    value.toRevision !== value.fromRevision + 1
  ) {
    errors.push(
      "governorDecision.toRevision must equal fromRevision + 1",
    );
  }
  if (value.leaseEpoch !== undefined) {
    integerField(
      errors,
      value.leaseEpoch,
      "governorDecision.leaseEpoch",
      { min: 1, max: 6 },
    );
  }
  if (!isTimestamp(value.createdAt)) {
    errors.push("governorDecision.createdAt must be an ISO date-time");
  }

  if (value.action === "block") {
    if (!["Stop", "SubagentStop"].includes(value.hookEvent)) {
      errors.push("block governorDecision requires a stop hook event");
    }
    if (value.leaseEpoch === undefined) {
      errors.push("block governorDecision requires leaseEpoch");
    }
    const expectedReason =
      value.hookEvent === "SubagentStop"
        ? "pending-worker-report"
        : "pending-root-transition";
    if (value.reasonCode !== expectedReason) {
      errors.push("block governorDecision reasonCode is invalid");
    }
  } else if (value.leaseEpoch !== undefined) {
    errors.push(
      "non-block governorDecision cannot include leaseEpoch",
    );
  }
  if (
    value.action === "cap" &&
    (value.reasonCode !== "lease-exhausted" ||
      !["Stop", "SubagentStop"].includes(value.hookEvent))
  ) {
    errors.push("cap governorDecision fields are invalid");
  }
  if (
    value.action === "interrupt" &&
    (value.reasonCode !== "resume-in-flight" ||
      value.hookEvent !== "SessionStart")
  ) {
    errors.push("interrupt governorDecision fields are invalid");
  }
  if (
    value.hookEvent === "SubagentStop" &&
    value.agentId === undefined
  ) {
    errors.push("SubagentStop governorDecision requires agentId");
  }
  if (
    value.hookEvent !== "SubagentStop" &&
    value.agentId !== undefined
  ) {
    errors.push(
      "non-SubagentStop governorDecision cannot include agentId",
    );
  }
  return errors;
}

export function validateLoopRun(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "runId",
    "rootSessionId",
    "originatingTurnId",
    "scope",
    "masterNode",
    "recipe",
    "status",
    "currentLap",
    "continuationLease",
    "pendingTransitionId",
    "cancelRequested",
    "latestReportId",
    "latestOperationId",
    "latestGovernorDecisionId",
    "latestRecoveryId",
    "needsHuman",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  rejectUnknown(errors, value, allowed, "run");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("run.schemaVersion must be 1");
  }
  stringField(errors, value.runId, "run.runId", { max: 128 });
  stringField(errors, value.rootSessionId, "run.rootSessionId");
  stringField(errors, value.originatingTurnId, "run.originatingTurnId");
  if (!isPlainObject(value.scope) || value.scope.kind !== "task") {
    errors.push("run.scope must equal { kind: \"task\" }");
  } else {
    rejectUnknown(errors, value.scope, new Set(["kind"]), "run.scope");
  }
  stringField(errors, value.masterNode, "run.masterNode");
  if (value.recipe !== "review-until-clean") {
    errors.push("run.recipe must be review-until-clean");
  }
  if (!RUN_STATUSES.has(value.status)) {
    errors.push("run.status is invalid");
  }
  integerField(errors, value.currentLap, "run.currentLap");
  if (!isPlainObject(value.continuationLease)) {
    errors.push("run.continuationLease must be an object");
  } else {
    rejectUnknown(
      errors,
      value.continuationLease,
      new Set(["granted", "consumed"]),
      "run.continuationLease",
    );
    integerField(
      errors,
      value.continuationLease.granted,
      "run.continuationLease.granted",
      { max: 6 },
    );
    integerField(
      errors,
      value.continuationLease.consumed,
      "run.continuationLease.consumed",
    );
    if (
      Number.isInteger(value.continuationLease.granted) &&
      Number.isInteger(value.continuationLease.consumed) &&
      value.continuationLease.consumed > value.continuationLease.granted
    ) {
      errors.push("run.continuationLease.consumed cannot exceed granted");
    }
  }
  stringField(errors, value.pendingTransitionId, "run.pendingTransitionId", {
    optional: true,
    max: 128,
  });
  if (typeof value.cancelRequested !== "boolean") {
    errors.push("run.cancelRequested must be a boolean");
  }
  stringField(errors, value.latestReportId, "run.latestReportId", {
    optional: true,
    max: 128,
  });
  stringField(
    errors,
    value.latestOperationId,
    "run.latestOperationId",
    {
      optional: true,
      max: 128,
    },
  );
  stringField(
    errors,
    value.latestGovernorDecisionId,
    "run.latestGovernorDecisionId",
    {
      optional: true,
      max: 73,
    },
  );
  stringField(
    errors,
    value.latestRecoveryId,
    "run.latestRecoveryId",
    {
      optional: true,
      max: 73,
      pattern: /^recovery_[a-f0-9]{64}$/,
    },
  );
  if (value.needsHuman !== undefined && typeof value.needsHuman !== "boolean") {
    errors.push("run.needsHuman must be a boolean");
  }
  integerField(errors, value.revision, "run.revision");
  if (!isTimestamp(value.createdAt)) {
    errors.push("run.createdAt must be an ISO date-time");
  }
  if (!isTimestamp(value.updatedAt)) {
    errors.push("run.updatedAt must be an ISO date-time");
  }
  return errors;
}

export function validateGraphProjection(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "storeVersion",
    "projectionVersion",
    "runId",
    "revision",
    "status",
    "recipe",
    "currentLap",
    "lapCap",
    "continuationLease",
    "cancelRequested",
    "needsHuman",
    "integrity",
    "eventWatermark",
    "nodes",
    "edges",
    "pending",
    "latestReport",
    "recovery",
    "counts",
    "timeline",
    "projectionDigest",
  ]);
  rejectUnknown(errors, value, allowed, "projection");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("projection.schemaVersion must be 1");
  }
  if (value.storeVersion !== STORE_VERSION) {
    errors.push("projection.storeVersion must be 1");
  }
  if (value.projectionVersion !== PROJECTION_VERSION) {
    errors.push("projection.projectionVersion must be 3");
  }
  stringField(errors, value.runId, "projection.runId", { max: 128 });
  integerField(errors, value.revision, "projection.revision");
  if (!RUN_STATUSES.has(value.status)) {
    errors.push("projection.status is invalid");
  }
  if (value.recipe !== "review-until-clean") {
    errors.push("projection.recipe must be review-until-clean");
  }
  integerField(errors, value.currentLap, "projection.currentLap");
  integerField(errors, value.lapCap, "projection.lapCap", {
    min: 1,
    max: 6,
  });
  if (!isPlainObject(value.continuationLease)) {
    errors.push("projection.continuationLease must be an object");
  } else {
    rejectUnknown(
      errors,
      value.continuationLease,
      new Set(["granted", "consumed"]),
      "projection.continuationLease",
    );
    integerField(
      errors,
      value.continuationLease.granted,
      "projection.continuationLease.granted",
      { max: 6 },
    );
    integerField(
      errors,
      value.continuationLease.consumed,
      "projection.continuationLease.consumed",
      { max: 6 },
    );
    if (
      Number.isInteger(value.continuationLease.granted) &&
      Number.isInteger(value.continuationLease.consumed) &&
      value.continuationLease.consumed >
        value.continuationLease.granted
    ) {
      errors.push(
        "projection.continuationLease.consumed cannot exceed granted",
      );
    }
  }
  if (
    Number.isInteger(value.currentLap) &&
    Number.isInteger(value.lapCap) &&
    value.currentLap > value.lapCap
  ) {
    errors.push("projection.currentLap cannot exceed lapCap");
  }
  if (typeof value.cancelRequested !== "boolean") {
    errors.push("projection.cancelRequested must be a boolean");
  }
  if (typeof value.needsHuman !== "boolean") {
    errors.push("projection.needsHuman must be a boolean");
  }
  if (!isPlainObject(value.integrity)) {
    errors.push("projection.integrity must be an object");
  } else {
    rejectUnknown(
      errors,
      value.integrity,
      new Set(["status", "verifiedRevision"]),
      "projection.integrity",
    );
    if (value.integrity.status !== "verified") {
      errors.push("projection.integrity.status must be verified");
    }
    integerField(
      errors,
      value.integrity.verifiedRevision,
      "projection.integrity.verifiedRevision",
    );
    if (
      Number.isInteger(value.revision) &&
      value.integrity.verifiedRevision !== value.revision
    ) {
      errors.push(
        "projection.integrity.verifiedRevision must equal revision",
      );
    }
  }
  if (!isPlainObject(value.eventWatermark)) {
    errors.push("projection.eventWatermark must be an object");
  } else {
    rejectUnknown(
      errors,
      value.eventWatermark,
      new Set(["eventCount", "lastEventId"]),
      "projection.eventWatermark",
    );
    integerField(
      errors,
      value.eventWatermark.eventCount,
      "projection.eventWatermark.eventCount",
    );
    stringField(
      errors,
      value.eventWatermark.lastEventId,
      "projection.eventWatermark.lastEventId",
      {
        optional: value.eventWatermark.eventCount === 0,
        max: 68,
        pattern: /^evt_[a-f0-9]{64}$/,
      },
    );
    if (
      value.eventWatermark.eventCount === 0 &&
      value.eventWatermark.lastEventId !== undefined
    ) {
      errors.push(
        "projection.eventWatermark.lastEventId requires at least one event",
      );
    }
  }

  if (!Array.isArray(value.nodes) || value.nodes.length !== 3) {
    errors.push("projection.nodes must contain exactly three nodes");
  } else {
    const nodeIds = new Set();
    for (const [index, node] of value.nodes.entries()) {
      const name = `projection.nodes[${index}]`;
      rejectUnknown(
        errors,
        node,
        new Set([
          "id",
          "kind",
          "role",
          "label",
          "state",
          "nativeAgentId",
          "nativeAgentType",
        ]),
        name,
      );
      if (!isPlainObject(node)) {
        continue;
      }
      if (!["root", "role:implementer", "role:reviewer"].includes(node.id)) {
        errors.push(`${name}.id is invalid`);
      }
      if (nodeIds.has(node.id)) {
        errors.push(`${name}.id is duplicated`);
      }
      nodeIds.add(node.id);
      if (!["root", "worker-role"].includes(node.kind)) {
        errors.push(`${name}.kind is invalid`);
      }
      if (
        node.role !== undefined &&
        !WORKER_ROLES.has(node.role)
      ) {
        errors.push(`${name}.role is invalid`);
      }
      stringField(errors, node.label, `${name}.label`, { max: 64 });
      if (
        !["active", "waiting", "bound", "unbound", "terminal"].includes(
          node.state,
        )
      ) {
        errors.push(`${name}.state is invalid`);
      }
      stringField(errors, node.nativeAgentId, `${name}.nativeAgentId`, {
        optional: true,
      });
      stringField(errors, node.nativeAgentType, `${name}.nativeAgentType`, {
        optional: true,
        max: 128,
      });
      if (
        (node.id === "root" &&
          (node.kind !== "root" ||
            node.role !== undefined ||
            node.nativeAgentId !== undefined ||
            node.nativeAgentType !== undefined)) ||
        (node.id !== "root" &&
          (node.kind !== "worker-role" ||
            node.role !== node.id.slice("role:".length)))
      ) {
        errors.push(`${name} has inconsistent root/role fields`);
      }
      if (
        node.nativeAgentType !== undefined &&
        node.nativeAgentId === undefined
      ) {
        errors.push(
          `${name}.nativeAgentType requires nativeAgentId`,
        );
      }
    }
    for (const id of ["root", "role:implementer", "role:reviewer"]) {
      if (!nodeIds.has(id)) {
        errors.push(`projection.nodes is missing ${id}`);
      }
    }
  }

  if (!Array.isArray(value.edges) || value.edges.length !== 4) {
    errors.push("projection.edges must contain exactly four edges");
  } else {
    const edgeIds = new Set();
    for (const [index, edge] of value.edges.entries()) {
      const name = `projection.edges[${index}]`;
      rejectUnknown(
        errors,
        edge,
        new Set([
          "id",
          "source",
          "target",
          "kind",
          "active",
          "reportCount",
        ]),
        name,
      );
      if (!isPlainObject(edge)) {
        continue;
      }
      stringField(errors, edge.id, `${name}.id`, { max: 64 });
      if (edgeIds.has(edge.id)) {
        errors.push(`${name}.id is duplicated`);
      }
      edgeIds.add(edge.id);
      if (
        !["root", "role:implementer", "role:reviewer"].includes(
          edge.source,
        ) ||
        !["root", "role:implementer", "role:reviewer"].includes(
          edge.target,
        )
      ) {
        errors.push(`${name} has an invalid endpoint`);
      }
      if (!["governs", "handoff", "feedback", "verdict"].includes(edge.kind)) {
        errors.push(`${name}.kind is invalid`);
      }
      if (typeof edge.active !== "boolean") {
        errors.push(`${name}.active must be a boolean`);
      }
      integerField(errors, edge.reportCount, `${name}.reportCount`);
    }
    const expectedEdges = new Map([
      [
        "root-governs-implementer",
        ["root", "role:implementer", "governs"],
      ],
      [
        "implementer-handoff-reviewer",
        [
          "role:implementer",
          "role:reviewer",
          "handoff",
        ],
      ],
      [
        "reviewer-feedback-implementer",
        [
          "role:reviewer",
          "role:implementer",
          "feedback",
        ],
      ],
      [
        "reviewer-verdict-root",
        ["role:reviewer", "root", "verdict"],
      ],
    ]);
    for (const edge of value.edges) {
      const expected = expectedEdges.get(edge.id);
      if (
        !expected ||
        edge.source !== expected[0] ||
        edge.target !== expected[1] ||
        edge.kind !== expected[2]
      ) {
        errors.push(
          `projection edge ${edge.id ?? "unknown"} does not match the recipe`,
        );
      }
    }
  }

  if (value.pending !== undefined) {
    const pending = value.pending;
    rejectUnknown(
      errors,
      pending,
      new Set(["transitionId", "kind", "role", "lap"]),
      "projection.pending",
    );
    if (isPlainObject(pending)) {
      stringField(
        errors,
        pending.transitionId,
        "projection.pending.transitionId",
        { max: 128 },
      );
      if (
        !["activate-implementer", "activate-reviewer"].includes(
          pending.kind,
        )
      ) {
        errors.push("projection.pending.kind is invalid");
      }
      if (!WORKER_ROLES.has(pending.role)) {
        errors.push("projection.pending.role is invalid");
      }
      if (
        pending.kind === "activate-implementer" &&
        pending.role !== "implementer"
      ) {
        errors.push("projection.pending role does not match kind");
      }
      if (
        pending.kind === "activate-reviewer" &&
        pending.role !== "reviewer"
      ) {
        errors.push("projection.pending role does not match kind");
      }
      integerField(errors, pending.lap, "projection.pending.lap");
    }
  }

  if (value.latestReport !== undefined) {
    const report = value.latestReport;
    rejectUnknown(
      errors,
      report,
      new Set([
        "reportId",
        "fromRole",
        "type",
        "verdict",
        "issueCount",
      ]),
      "projection.latestReport",
    );
    if (isPlainObject(report)) {
      stringField(
        errors,
        report.reportId,
        "projection.latestReport.reportId",
        { max: 128 },
      );
      if (!WORKER_ROLES.has(report.fromRole)) {
        errors.push("projection.latestReport.fromRole is invalid");
      }
      if (!["info", "verdict"].includes(report.type)) {
        errors.push("projection.latestReport.type is invalid");
      }
      if (
        report.verdict !== undefined &&
        !["issues", "clean"].includes(report.verdict)
      ) {
        errors.push("projection.latestReport.verdict is invalid");
      }
      integerField(
        errors,
        report.issueCount,
        "projection.latestReport.issueCount",
        { max: 200 },
      );
      if (
        (report.type === "verdict" &&
          report.verdict === undefined) ||
        (report.type === "info" &&
          report.verdict !== undefined) ||
        (report.verdict === "clean" &&
          report.issueCount !== 0) ||
        (report.verdict === "issues" &&
          report.issueCount === 0)
      ) {
        errors.push(
          "projection.latestReport type, verdict, and issueCount are inconsistent",
        );
      }
    }
  }

  const countNames = [
    "events",
    "reports",
    "transitions",
    "operations",
    "governorDecisions",
    "recoveries",
    "diagnostics",
    "conflicts",
    "corrupt",
  ];
  if (!isPlainObject(value.counts)) {
    errors.push("projection.counts must be an object");
  } else {
    rejectUnknown(
      errors,
      value.counts,
      new Set(countNames),
      "projection.counts",
    );
    for (const name of countNames) {
      integerField(
        errors,
        value.counts[name],
        `projection.counts.${name}`,
      );
    }
    if (value.counts.corrupt !== 0) {
      errors.push("projection.counts.corrupt must be 0");
    }
    if (
      Number.isInteger(value.revision) &&
      Number.isInteger(value.counts.operations) &&
      Number.isInteger(value.counts.governorDecisions) &&
      value.counts.operations +
        value.counts.governorDecisions +
        value.counts.recoveries !==
        value.revision
    ) {
      errors.push(
        "projection applied control receipt counts must equal revision",
      );
    }
    if (
      Number.isInteger(value.counts.operations) &&
      Number.isInteger(value.counts.transitions) &&
      value.counts.operations !== value.counts.transitions
    ) {
      errors.push(
        "projection transition count must equal operation count",
      );
    }
  }

  if (value.recovery !== undefined) {
    rejectUnknown(
      errors,
      value.recovery,
      new Set(["recoveryId", "reason"]),
      "projection.recovery",
    );
    if (isPlainObject(value.recovery)) {
      stringField(
        errors,
        value.recovery.recoveryId,
        "projection.recovery.recoveryId",
        {
          max: 73,
          pattern: /^recovery_[a-f0-9]{64}$/,
        },
      );
      if (
        value.recovery.reason !==
        "legacy-history-quarantined"
      ) {
        errors.push(
          "projection.recovery.reason must be legacy-history-quarantined",
        );
      }
    }
  }
  if (
    (value.recovery === undefined) !==
    (value.counts?.recoveries === 0)
  ) {
    errors.push(
      "projection.recovery must exist exactly when one recovery is applied",
    );
  }

  if (!Array.isArray(value.timeline) || value.timeline.length > 32) {
    errors.push("projection.timeline must contain at most 32 items");
  } else {
    for (const [index, item] of value.timeline.entries()) {
      const name = `projection.timeline[${index}]`;
      rejectUnknown(
        errors,
        item,
        new Set(["kind", "id", "at", "label", "role"]),
        name,
      );
      if (!isPlainObject(item)) {
        continue;
      }
      if (
        ![
          "event",
          "report",
          "transition",
          "governor-decision",
          "recovery",
        ].includes(item.kind)
      ) {
        errors.push(`${name}.kind is invalid`);
      }
      stringField(errors, item.id, `${name}.id`, { max: 128 });
      if (!isTimestamp(item.at)) {
        errors.push(`${name}.at must be an ISO date-time`);
      }
      stringField(errors, item.label, `${name}.label`, { max: 128 });
      if (item.role !== undefined && !WORKER_ROLES.has(item.role)) {
        errors.push(`${name}.role is invalid`);
      }
    }
  }
  stringField(
    errors,
    value.projectionDigest,
    "projection.projectionDigest",
    { max: 64, pattern: SHA256 },
  );
  return errors;
}

export function validateLegacyNativeTargetEvidence(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "evidenceVersion",
    "runId",
    "stateRevision",
    "historyDigest",
    "entries",
    "evidenceDigest",
  ]);
  rejectUnknown(errors, value, allowed, "legacyEvidence");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("legacyEvidence.schemaVersion must be 1");
  }
  if (value.evidenceVersion !== LEGACY_EVIDENCE_VERSION) {
    errors.push("legacyEvidence.evidenceVersion must be 1");
  }
  stringField(errors, value.runId, "legacyEvidence.runId", {
    max: 128,
  });
  integerField(
    errors,
    value.stateRevision,
    "legacyEvidence.stateRevision",
  );
  stringField(
    errors,
    value.historyDigest,
    "legacyEvidence.historyDigest",
    { max: 64, pattern: SHA256 },
  );
  if (
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > MAX_LEGACY_NATIVE_TARGET_FACTS
  ) {
    errors.push(
      `legacyEvidence.entries must contain 1 to ${MAX_LEGACY_NATIVE_TARGET_FACTS} items`,
    );
  } else {
    const keys = [];
    for (const [index, entry] of value.entries.entries()) {
      const name = `legacyEvidence.entries[${index}]`;
      rejectUnknown(
        errors,
        entry,
        new Set([
          "factKind",
          "factId",
          "factDigest",
          "field",
          "role",
          "bindingId",
          "bindingDigest",
        ]),
        name,
      );
      if (!isPlainObject(entry)) {
        continue;
      }
      if (!["transition", "report"].includes(entry.factKind)) {
        errors.push(`${name}.factKind is invalid`);
      }
      stringField(errors, entry.factId, `${name}.factId`, {
        max: 128,
      });
      stringField(
        errors,
        entry.factDigest,
        `${name}.factDigest`,
        { max: 64, pattern: SHA256 },
      );
      const expectedField =
        entry.factKind === "transition"
          ? "toNode"
          : entry.factKind === "report"
            ? "routedToNode"
            : null;
      if (entry.field !== expectedField) {
        errors.push(`${name}.field does not match factKind`);
      }
      if (!WORKER_ROLES.has(entry.role)) {
        errors.push(`${name}.role is invalid`);
      }
      stringField(
        errors,
        entry.bindingId,
        `${name}.bindingId`,
        {
          max: 72,
          pattern: /^binding_[a-f0-9]{64}$/,
        },
      );
      stringField(
        errors,
        entry.bindingDigest,
        `${name}.bindingDigest`,
        { max: 64, pattern: SHA256 },
      );
      keys.push(
        `${entry.factKind}:${entry.factId}:${entry.field}`,
      );
    }
    if (new Set(keys).size !== keys.length) {
      errors.push("legacyEvidence.entries must be unique");
    }
    const sorted = [...value.entries].sort((left, right) =>
      compareCodePoints(
        `${left.factKind}:${left.factId}:${left.field}`,
        `${right.factKind}:${right.factId}:${right.field}`,
      ),
    );
    if (canonicalJson(sorted) !== canonicalJson(value.entries)) {
      errors.push(
        "legacyEvidence.entries must be code-point sorted",
      );
    }
  }
  stringField(
    errors,
    value.evidenceDigest,
    "legacyEvidence.evidenceDigest",
    { max: 64, pattern: SHA256 },
  );
  if (errors.length === 0) {
    const { evidenceDigest, ...base } = value;
    if (evidenceDigest !== digestJson(base)) {
      errors.push(
        "legacyEvidence.evidenceDigest must match canonical evidence",
      );
    }
  }
  return errors;
}

export function validateLegacyQuarantineReceipt(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "recoveryVersion",
    "recoveryId",
    "runId",
    "requestId",
    "requestDigest",
    "actorKind",
    "actorId",
    "reason",
    "evidenceDigest",
    "legacyFactCount",
    "priorStateDigest",
    "terminalStateDigest",
    "fromRevision",
    "toRevision",
    "createdAt",
  ]);
  rejectUnknown(errors, value, allowed, "recovery");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("recovery.schemaVersion must be 1");
  }
  if (value.recoveryVersion !== LEGACY_RECOVERY_VERSION) {
    errors.push("recovery.recoveryVersion must be 1");
  }
  stringField(errors, value.recoveryId, "recovery.recoveryId", {
    max: 73,
    pattern: /^recovery_[a-f0-9]{64}$/,
  });
  stringField(errors, value.runId, "recovery.runId", {
    max: 128,
  });
  stringField(errors, value.requestId, "recovery.requestId", {
    max: 128,
    pattern: SAFE_FILE_ID,
  });
  for (const field of [
    "requestDigest",
    "evidenceDigest",
    "priorStateDigest",
    "terminalStateDigest",
  ]) {
    stringField(errors, value[field], `recovery.${field}`, {
      max: 64,
      pattern: SHA256,
    });
  }
  if (value.actorKind !== "root") {
    errors.push("recovery.actorKind must be root");
  }
  stringField(errors, value.actorId, "recovery.actorId");
  if (
    value.reason !== "unsupported-native-target-history"
  ) {
    errors.push(
      "recovery.reason must be unsupported-native-target-history",
    );
  }
  integerField(
    errors,
    value.legacyFactCount,
    "recovery.legacyFactCount",
    { min: 1, max: MAX_LEGACY_NATIVE_TARGET_FACTS },
  );
  integerField(
    errors,
    value.fromRevision,
    "recovery.fromRevision",
  );
  integerField(
    errors,
    value.toRevision,
    "recovery.toRevision",
    { min: 1 },
  );
  if (
    Number.isInteger(value.fromRevision) &&
    Number.isInteger(value.toRevision) &&
    value.toRevision !== value.fromRevision + 1
  ) {
    errors.push(
      "recovery.toRevision must equal fromRevision + 1",
    );
  }
  if (!isTimestamp(value.createdAt)) {
    errors.push("recovery.createdAt must be an ISO date-time");
  }
  return errors;
}

export function validateIdentityBinding(value) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "bindingId",
    "runId",
    "agentId",
    "rootSessionId",
    "method",
    "tokenDigest",
    "hostIdentityDigest",
    "role",
    "requestId",
    "requestDigest",
    "observationId",
    "originEventId",
    "createdAt",
    "revokedAt",
  ]);
  rejectUnknown(errors, value, allowed, "binding");
  if (!isPlainObject(value)) {
    return errors;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push("binding.schemaVersion must be 1");
  }
  stringField(errors, value.bindingId, "binding.bindingId", { max: 128 });
  stringField(errors, value.runId, "binding.runId", { max: 128 });
  stringField(errors, value.agentId, "binding.agentId");
  stringField(errors, value.rootSessionId, "binding.rootSessionId");
  if (!["host-metadata-v1", "capability-token-v1"].includes(value.method)) {
    errors.push("binding.method is invalid");
  }
  if (
    value.role !== undefined &&
    !WORKER_ROLES.has(value.role)
  ) {
    errors.push("binding.role is invalid");
  }
  stringField(errors, value.requestId, "binding.requestId", {
    optional: value.requestDigest === undefined,
    max: 128,
    pattern: SAFE_FILE_ID,
  });
  stringField(errors, value.requestDigest, "binding.requestDigest", {
    optional: value.requestId === undefined,
    max: 64,
    pattern: SHA256,
  });
  stringField(errors, value.observationId, "binding.observationId", {
    optional: true,
    max: 128,
    pattern: /^observation_[a-f0-9]{64}$/,
  });
  stringField(errors, value.originEventId, "binding.originEventId", {
    optional: true,
    max: 68,
    pattern: /^evt_[a-f0-9]{64}$/,
  });
  if (
    (value.observationId === undefined) !==
    (value.originEventId === undefined)
  ) {
    errors.push(
      "binding observationId and originEventId must appear together",
    );
  }
  const productFields = [
    "requestId",
    "requestDigest",
    "observationId",
    "originEventId",
  ];
  const productFieldCount = productFields.filter(
    (field) => value[field] !== undefined,
  ).length;
  if (
    productFieldCount > 0 &&
    productFieldCount !== productFields.length
  ) {
    errors.push(
      "product identity bindings require role, requestId, requestDigest, observationId, and originEventId together",
    );
  }
  if (
    productFieldCount > 0 &&
    value.role === undefined
  ) {
    errors.push(
      "observed identity bindings require a role",
    );
  }
  stringField(errors, value.tokenDigest, "binding.tokenDigest", {
    optional: value.method !== "capability-token-v1",
    max: 64,
    pattern: SHA256,
  });
  stringField(errors, value.hostIdentityDigest, "binding.hostIdentityDigest", {
    optional: value.method !== "host-metadata-v1",
    max: 64,
    pattern: SHA256,
  });
  if (!isTimestamp(value.createdAt)) {
    errors.push("binding.createdAt must be an ISO date-time");
  }
  if (value.revokedAt !== undefined && !isTimestamp(value.revokedAt)) {
    errors.push("binding.revokedAt must be an ISO date-time");
  }
  return errors;
}

export function assertContract(name, value, validator) {
  const errors = validator(value);
  if (errors.length > 0) {
    const error = new TypeError(`${name} contract failed: ${errors.join("; ")}`);
    error.code = "INVALID_CONTRACT";
    error.details = errors;
    throw error;
  }
  return value;
}

export function assertSafeFileId(value, name = "id") {
  if (typeof value !== "string" || !SAFE_FILE_ID.test(value)) {
    const error = new TypeError(`${name} is not a safe store identifier`);
    error.code = "INVALID_STORE_ID";
    throw error;
  }
  return value;
}

function shortString(value, max = 256) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;
}

function sortedObjectKeys(value) {
  return isPlainObject(value)
    ? Object.keys(value).sort(compareCodePoints)
    : undefined;
}

function normalizedToolName(value) {
  return typeof value === "string"
    ? value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
    : "";
}

export function isNativeSpawnPreToolUse(event) {
  if (event?.event !== "PreToolUse") {
    return false;
  }
  const toolName = normalizedToolName(
    event?.payloadSummary?.toolName,
  );
  return [
    "collaborationspawnagent",
    "spawnagent",
  ].includes(toolName);
}

export function isWorkerObservationEvent(event) {
  return (
    event?.event === "SubagentStart" ||
    isNativeSpawnPreToolUse(event)
  );
}

function hasRequiredHookIdentity(event, fields) {
  if (fields.sessionId === "unknown") {
    return false;
  }
  switch (event) {
    case "SessionStart":
      return fields.source !== undefined;
    case "UserPromptSubmit":
    case "Stop":
      return fields.turnId !== undefined;
    case "PreToolUse":
    case "PostToolUse":
      return (
        fields.turnId !== undefined &&
        fields.toolUseId !== undefined
      );
    case "SubagentStart":
    case "SubagentStop":
      return (
        fields.turnId !== undefined &&
        fields.agentId !== undefined
      );
    default:
      return false;
  }
}

export function normalizeHookEvent(
  input,
  options = {},
) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const event = shortString(input?.hook_event_name, 64) ?? "Unknown";
  const sessionId = shortString(input?.session_id) ?? "unknown";
  const turnId = shortString(input?.turn_id);
  const agentId = shortString(input?.agent_id);
  const agentType = shortString(input?.agent_type, 128);
  const toolUseId = shortString(input?.tool_use_id);
  const stopHookActive =
    typeof input?.stop_hook_active === "boolean"
      ? input.stop_hook_active
      : undefined;
  const source = shortString(input?.source, 64);
  const toolName = shortString(input?.tool_name, 128);
  const hookDefinitionDigest =
    typeof options.hookDefinitionDigest === "string" &&
    /^[a-f0-9]{64}$/.test(options.hookDefinitionDigest)
      ? options.hookDefinitionDigest
      : undefined;
  const payloadSummary = {
    event,
    ...(event === "UserPromptSubmit" &&
    options.hookCollectorProtocol ===
      HOOK_COLLECTOR_PROTOCOL &&
    hookDefinitionDigest
      ? {
          hookCollectorProtocol:
            options.hookCollectorProtocol,
          hookDefinitionDigest,
        }
      : {}),
    ...(source ? { source } : {}),
    ...(toolName ? { toolName } : {}),
    ...(sortedObjectKeys(input?.tool_input)
      ? { toolInputKeys: sortedObjectKeys(input.tool_input) }
      : {}),
    ...(input?.tool_response === undefined
      ? {}
      : { toolResponseType: Array.isArray(input.tool_response)
          ? "array"
          : typeof input.tool_response }),
  };
  const conflictEligible =
    KNOWN_HOOK_EVENTS.has(event) &&
    hasRequiredHookIdentity(event, {
      sessionId,
      turnId,
      agentId,
      toolUseId,
      source,
    });
  const identity = conflictEligible
    ? {
        semanticKeyVersion: SEMANTIC_KEY_VERSION,
        sessionId,
        ...(turnId ? { turnId } : {}),
        event,
        ...(agentId ? { agentId } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(stopHookActive === undefined ? {} : { stopHookActive }),
        ...(event === "SessionStart" && source ? { source } : {}),
      }
    : {
        semanticKeyVersion: SEMANTIC_KEY_VERSION,
        unknownDelivery:
          options.deliveryDigest ??
          sha256(`${process.pid}:${process.hrtime.bigint()}:${randomUUID()}`),
      };
  const semanticKey = `sem-v1:${digestJson(identity)}`;
  const payloadDigest = digestJson({
    schemaVersion: SCHEMA_VERSION,
    semanticKey,
    sessionId,
    ...(turnId ? { turnId } : {}),
    event,
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(stopHookActive === undefined ? {} : { stopHookActive }),
    payloadSummary,
  });
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    semanticKeyVersion: SEMANTIC_KEY_VERSION,
    eventId: `evt_${sha256(canonicalJson({ semanticKey, payloadDigest }))}`,
    semanticKey,
    sessionId,
    ...(turnId ? { turnId } : {}),
    event,
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(stopHookActive === undefined ? {} : { stopHookActive }),
    observedAt,
    payloadDigest,
    payloadSummary,
    conflictEligible,
  };
  return assertContract(
    "normalized hook event",
    normalized,
    validateNormalizedHookEvent,
  );
}

export function createInterruptedRun(runId, event = undefined) {
  assertSafeFileId(runId, "runId");
  const now = event?.observedAt ?? new Date(0).toISOString();
  const sessionId = event?.sessionId ?? "unknown";
  const turnId = event?.turnId ?? "unknown";
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    rootSessionId: sessionId,
    originatingTurnId: turnId,
    scope: { kind: "task" },
    masterNode: sessionId,
    recipe: "review-until-clean",
    status: "interrupted",
    currentLap: 0,
    continuationLease: { granted: 0, consumed: 0 },
    cancelRequested: false,
    needsHuman: true,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}
