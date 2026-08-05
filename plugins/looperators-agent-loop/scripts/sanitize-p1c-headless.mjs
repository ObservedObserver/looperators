#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  compareCodePoints,
  sha256,
} from "../lib/canonical-json.mjs";
import {
  assertSafeFileId,
  isNativeSpawnPreToolUse,
} from "../lib/contracts.mjs";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";
import { LoopStore } from "../lib/store.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredAbsoluteArgument(name) {
  const value = argument(name);
  if (!value || !path.isAbsolute(value)) {
    throw new TypeError(`--${name} must be an absolute path`);
  }
  return path.normalize(value);
}

function addError(errors, condition, code) {
  if (!condition && !errors.includes(code)) {
    errors.push(code);
  }
}

function countsBy(values, key) {
  const result = {};
  for (const value of values) {
    const label = String(value[key] ?? "unknown");
    result[label] = (result[label] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) =>
      compareCodePoints(left, right),
    ),
  );
}

function facts(read, kind, errors) {
  addError(errors, read.corrupt.length === 0, `CORRUPT_${kind}`);
  return read.facts;
}

function scanJson(value, result) {
  if (Array.isArray(value)) {
    for (const item of value) {
      scanJson(item, result);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["capabilityToken", "token"].includes(key)) {
        result.plaintextCapabilityFields += 1;
      }
      scanJson(item, result);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    result.plaintextCapabilityCandidates += 1;
  }
  if (
    value.includes(
      "Run a disposable looperators P1-C native headless acceptance",
    ) ||
    value.includes("P1C_ROOT_STOP_PROBE")
  ) {
    result.rawAcceptancePromptFragments += 1;
  }
}

async function scanStoreJson(directory) {
  const result = {
    jsonFiles: 0,
    plaintextCapabilityFields: 0,
    plaintextCapabilityCandidates: 0,
    rawAcceptancePromptFragments: 0,
  };
  async function walk(current) {
    for (const entry of await readdir(current, {
      withFileTypes: true,
    })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".json")
      ) {
        result.jsonFiles += 1;
        scanJson(
          JSON.parse(await readFile(target, "utf8")),
          result,
        );
      }
    }
  }
  await walk(directory);
  return result;
}

const dataRoot = requiredAbsoluteArgument("data-root");
const output = requiredAbsoluteArgument("output");
const rootInfo = await resolveDataRoot({
  env: { LOOPERATORS_DATA_DIR: dataRoot },
});
const store = new LoopStore(rootInfo);
const runIds = (
  await readdir(path.join(rootInfo.path, "runs"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => assertSafeFileId(entry.name, "runId"));
const errors = [];
addError(errors, runIds.length === 1, "EXPECTED_ONE_RUN");

const runId = runIds[0];
const state = await store.readState(runId);
const definition = await store.readDefinition(runId);
const events = facts(
  await store.listEvents(runId),
  "EVENTS",
  errors,
);
const operations = facts(
  await store.listOperations(runId),
  "OPERATIONS",
  errors,
).sort((left, right) => left.fromRevision - right.fromRevision);
const decisions = facts(
  await store.listGovernorDecisions(runId),
  "GOVERNOR_DECISIONS",
  errors,
).sort((left, right) => left.fromRevision - right.fromRevision);
const reports = facts(
  await store.listReports(runId),
  "REPORTS",
  errors,
);
const transitions = facts(
  await store.listTransitions(runId),
  "TRANSITIONS",
  errors,
);
const bindings = facts(
  await store.listIdentityBindings(runId),
  "IDENTITY",
  errors,
);
const observations = facts(
  await store.listWorkerObservations(runId),
  "WORKER_OBSERVATIONS",
  errors,
);
const pendingObservations = facts(
  await store.readPendingWorkerObservations(runId),
  "PENDING_WORKER_OBSERVATIONS",
  errors,
);
const observedWorkers = facts(
  await store.listObservedSubagentStarts(
    runId,
    state.rootSessionId,
  ),
  "OBSERVED_WORKERS",
  errors,
);
const eventById = new Map(
  events.map((event) => [event.eventId, event]),
);
const transitionById = new Map(
  transitions.map((transition) => [
    transition.transitionId,
    transition,
  ]),
);
const reportById = new Map(
  reports.map((report) => [report.reportId, report]),
);
const bindingByAgent = new Map(
  bindings.map((binding) => [binding.agentId, binding]),
);
const nativeSpawnAttempts = new Set(
  events
    .filter(isNativeSpawnPreToolUse)
    .map((event) => event.toolUseId),
);

const operationSteps = operations.map((operation) => {
  const transition = transitionById.get(operation.transitionId);
  const report = operation.reportId
    ? reportById.get(operation.reportId)
    : null;
  addError(
    errors,
    Boolean(transition),
    "OPERATION_TRANSITION_MISSING",
  );
  addError(
    errors,
    !operation.reportId || Boolean(report),
    "OPERATION_REPORT_MISSING",
  );
  return {
    kind: operation.kind,
    actorKind: operation.actorKind,
    fromRevision: operation.fromRevision,
    toRevision: operation.toRevision,
    transitionKind: transition?.kind ?? "missing",
    ...(report
      ? {
          report: {
            type: report.type,
            ...(report.status ? { status: report.status } : {}),
            ...(report.verdict
              ? { verdict: report.verdict }
              : {}),
            actorMatchesBinding:
              bindingByAgent.has(report.fromNode),
          },
        }
      : {}),
  };
});

const continuationSteps = decisions.map((decision) => {
  const origin = eventById.get(decision.originEventId);
  addError(
    errors,
    origin?.event === decision.hookEvent,
    "DECISION_ORIGIN_EVENT_MISMATCH",
  );
  addError(
    errors,
    decision.hookEvent !== "SubagentStop" ||
      (origin?.agentId === decision.agentId &&
        bindingByAgent.has(decision.agentId)),
    "DECISION_WORKER_BINDING_MISMATCH",
  );
  return {
    action: decision.action,
    hookEvent: decision.hookEvent,
    reasonCode: decision.reasonCode,
    fromRevision: decision.fromRevision,
    toRevision: decision.toRevision,
    leaseEpoch: decision.leaseEpoch,
    obligationDigest: sha256(decision.obligationId),
    originEventMatches: origin?.event === decision.hookEvent,
    ...(decision.agentId
      ? {
          boundRole:
            bindingByAgent.get(decision.agentId)?.role ?? null,
        }
      : {}),
  };
});

const combinedRevisions = [
  ...operations.map((operation) => ({
    fromRevision: operation.fromRevision,
    toRevision: operation.toRevision,
  })),
  ...decisions.map((decision) => ({
    fromRevision: decision.fromRevision,
    toRevision: decision.toRevision,
  })),
].sort((left, right) => left.fromRevision - right.fromRevision);
addError(
  errors,
  combinedRevisions
    .map((step) => `${step.fromRevision}:${step.toRevision}`)
    .join(",") === "0:1,1:2,2:3,3:4,4:5",
  "REVISION_CHAIN_MISMATCH",
);
addError(
  errors,
  state.status === "succeeded" &&
    state.revision === 5 &&
    state.continuationLease.granted === 3 &&
    state.continuationLease.consumed === 2 &&
    state.pendingTransitionId === undefined &&
    state.latestGovernorDecisionId ===
      decisions.at(-1)?.decisionId,
  "FINAL_STATE_MISMATCH",
);
addError(
  errors,
  operationSteps.map((step) => step.kind).join(",") ===
    "start,report,report" &&
    operationSteps[1]?.report?.status === "done" &&
    operationSteps[2]?.report?.verdict === "clean",
  "TYPED_REVIEW_SEQUENCE_MISMATCH",
);
addError(
  errors,
  continuationSteps
    .map(
      (step) =>
        `${step.action}:${step.hookEvent}:${step.leaseEpoch}`,
    )
    .join(",") ===
    "block:Stop:1,block:SubagentStop:2" &&
    continuationSteps[1]?.boundRole === "reviewer",
  "CONTINUATION_SEQUENCE_MISMATCH",
);
addError(
  errors,
  bindings.length === 2 &&
    new Set(bindings.map((binding) => binding.role)).size === 2 &&
    observedWorkers.length === 2 &&
    observations.length === 2 &&
    pendingObservations.length === 0 &&
    nativeSpawnAttempts.size === 2,
  "WORKER_PROVENANCE_MISMATCH",
);
addError(
  errors,
  events.every(
    (event) => event.sessionId === state.rootSessionId,
  ),
  "HOOK_MCP_SESSION_MISMATCH",
);

const storeScan = await scanStoreJson(rootInfo.path);
addError(
  errors,
  storeScan.plaintextCapabilityFields === 0,
  "PLAINTEXT_CAPABILITY_FIELD_FOUND",
);
addError(
  errors,
  storeScan.plaintextCapabilityCandidates === 0,
  "PLAINTEXT_CAPABILITY_CANDIDATE_FOUND",
);
addError(
  errors,
  storeScan.rawAcceptancePromptFragments === 0,
  "RAW_ACCEPTANCE_PROMPT_FOUND",
);

const evidence = {
  schemaVersion: 1,
  probe: "p1c-real-headless",
  passed: errors.length === 0,
  errors,
  storeInstanceDigest: rootInfo.instanceIdDigest,
  runCount: runIds.length,
  run: {
    runDigest: sha256(runId),
    rootSessionDigest: sha256(state.rootSessionId),
    status: state.status,
    revision: state.revision,
    currentLap: state.currentLap,
    lapCap: definition.lapCap,
    continuationLease: state.continuationLease,
    cancelRequested: state.cancelRequested,
    needsHuman: state.needsHuman ?? false,
    counts: {
      events: events.length,
      operations: operations.length,
      reports: reports.length,
      transitions: transitions.length,
      governorDecisions: decisions.length,
      bindings: bindings.length,
      observations: observations.length,
      pendingWorkerObservations: pendingObservations.length,
      observedWorkers: observedWorkers.length,
      nativeSpawnAttempts: nativeSpawnAttempts.size,
    },
    eventCounts: countsBy(events, "event"),
    operationSteps,
    continuationSteps,
    observedWorkers: observedWorkers.map((event) => ({
      agentDigest: sha256(event.agentId),
      eventDigest: sha256(event.eventId),
      boundRole:
        bindingByAgent.get(event.agentId)?.role ?? null,
    })),
  },
  storeScan,
  finalMarker: "P1C_HEADLESS_OK",
  privacy: {
    rawHostIdsIncluded: false,
    rawPromptIncluded: false,
    capabilityPlaintextIncluded: false,
  },
};
await atomicReplaceJson(output, evidence);
process.stdout.write(
  `${JSON.stringify({
    passed: evidence.passed,
    errors: evidence.errors,
    output,
  })}\n`,
);
if (!evidence.passed) {
  process.exitCode = 1;
}
