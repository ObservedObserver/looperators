#!/usr/bin/env node

import {
  readFile,
  readdir,
} from "node:fs/promises";
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
import { LoopController } from "../lib/control.mjs";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";
import {
  createPrivacyScanResult,
  scanPrivacyValue,
} from "../lib/privacy-scan.mjs";
import { LoopStore } from "../lib/store.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function absoluteArgument(name) {
  const value = argument(name);
  if (!value || !path.isAbsolute(value)) {
    throw new TypeError(`--${name} must be absolute`);
  }
  return path.normalize(value);
}

function addError(errors, condition, code) {
  if (!condition && !errors.includes(code)) {
    errors.push(code);
  }
}

function facts(read, kind, errors) {
  addError(
    errors,
    read.corrupt.length === 0,
    `CORRUPT_${kind}`,
  );
  return read.facts;
}

function countsBy(values, field) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value[field] ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) =>
      compareCodePoints(left, right),
    ),
  );
}

async function scanStore(directory) {
  const result = createPrivacyScanResult();
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
        scanPrivacyValue(
          JSON.parse(await readFile(target, "utf8")),
          result,
        );
      }
    }
  }
  await walk(directory);
  return result;
}

const dataRoot = absoluteArgument("data-root");
const output = absoluteArgument("output");
const lastMessageFile = absoluteArgument("last-message");
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
  .map((entry) => assertSafeFileId(entry.name, "runId"))
  .sort(compareCodePoints);
const errors = [];
addError(errors, runIds.length === 1, "EXPECTED_ONE_RUN");
const runId = runIds[0];
if (!runId) {
  throw new Error("P1-E headless data root contains no run");
}

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
).sort(
  (left, right) =>
    left.fromRevision - right.fromRevision,
);
const decisions = facts(
  await store.listGovernorDecisions(runId),
  "GOVERNOR_DECISIONS",
  errors,
).sort(
  (left, right) =>
    left.fromRevision - right.fromRevision,
);
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
  "OBSERVATIONS",
  errors,
);
const pendingObservations = facts(
  await store.readPendingWorkerObservations(runId),
  "PENDING_OBSERVATIONS",
  errors,
);
const recoveries = facts(
  await store.listRecoveries(runId),
  "RECOVERIES",
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
const transitionById = new Map(
  transitions.map((transition) => [
    transition.transitionId,
    transition,
  ]),
);
const reportById = new Map(
  reports.map((report) => [
    report.reportId,
    report,
  ]),
);
const bindingByAgent = new Map(
  bindings.map((binding) => [
    binding.agentId,
    binding,
  ]),
);

const operationSteps = operations.map((operation) => {
  const transition = transitionById.get(
    operation.transitionId,
  );
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
    actorRole:
      operation.actorKind === "worker"
        ? bindingByAgent.get(operation.actorId)?.role ??
          "unbound"
        : "root",
    actorDigest: sha256(operation.actorId),
    fromRevision: operation.fromRevision,
    toRevision: operation.toRevision,
    transitionKind: transition?.kind ?? "missing",
    ...(report
      ? {
          report: {
            type: report.type,
            ...(report.status
              ? { status: report.status }
              : {}),
            ...(report.verdict
              ? { verdict: report.verdict }
              : {}),
            issueCount: report.issues?.length ?? 0,
          },
        }
      : {}),
  };
});

const decisionSteps = decisions.map((decision) => ({
  action: decision.action,
  hookEvent: decision.hookEvent,
  reasonCode: decision.reasonCode,
  leaseEpoch: decision.leaseEpoch,
  fromRevision: decision.fromRevision,
  toRevision: decision.toRevision,
  ...(decision.agentId
    ? {
        actorRole:
          bindingByAgent.get(decision.agentId)?.role ??
          "unbound",
      }
    : {}),
}));
const combinedRevisions = [
  ...operations,
  ...decisions,
].sort(
  (left, right) =>
    left.fromRevision - right.fromRevision,
);
const revisionShape = combinedRevisions
  .map(
    (item) =>
      `${item.fromRevision}:${item.toRevision}`,
  )
  .join(",");
addError(
  errors,
  revisionShape ===
    "0:1,1:2,2:3,3:4,4:5,5:6,6:7",
  "REVISION_CHAIN_MISMATCH",
);
addError(
  errors,
  state.status === "succeeded" &&
    state.revision === 7 &&
    state.currentLap === 1 &&
    state.continuationLease.granted === 3 &&
    state.continuationLease.consumed === 2 &&
    state.pendingTransitionId === undefined &&
    state.cancelRequested === false &&
    state.needsHuman !== true &&
    state.latestRecoveryId === undefined,
  "FINAL_STATE_MISMATCH",
);
addError(
  errors,
  operationSteps
    .map(
      (step) =>
        `${step.actorRole}:${step.transitionKind}:${
          step.report?.status ??
          step.report?.verdict ??
          "none"
        }`,
    )
    .join(",") ===
    [
      "root:activate-implementer:none",
      "implementer:activate-reviewer:done",
      "reviewer:activate-implementer:issues",
      "implementer:activate-reviewer:done",
      "reviewer:succeed:clean",
    ].join(","),
  "TYPED_REVIEW_SEQUENCE_MISMATCH",
);
addError(
  errors,
  operationSteps[1]?.actorDigest ===
    operationSteps[3]?.actorDigest &&
    operationSteps[2]?.actorDigest ===
      operationSteps[4]?.actorDigest,
  "WORKER_FOLLOWUP_IDENTITY_MISMATCH",
);
addError(
  errors,
  decisionSteps
    .map(
      (step) =>
        `${step.action}:${step.hookEvent}:${step.leaseEpoch}`,
    )
    .join(",") ===
    "block:Stop:1,block:SubagentStop:2" &&
    decisionSteps[1]?.actorRole === "reviewer",
  "CONTINUATION_SEQUENCE_MISMATCH",
);
addError(
  errors,
  bindings.length === 2 &&
    new Set(
      bindings.map((binding) => binding.role),
    ).size === 2 &&
    observations.length === 2 &&
    pendingObservations.length === 0 &&
    observedWorkers.length === 2 &&
    new Set(
      events
        .filter(isNativeSpawnPreToolUse)
        .map((event) => event.toolUseId),
    ).size === 2,
  "WORKER_PROVENANCE_MISMATCH",
);
addError(
  errors,
  recoveries.length === 0,
  "FRESH_RUN_UNEXPECTED_RECOVERY",
);

const projection =
  await new LoopController(store).snapshotForRun(runId);
addError(
  errors,
  projection.projectionVersion === 3 &&
    projection.status === "succeeded" &&
    projection.recovery === undefined &&
    projection.counts.recoveries === 0 &&
    projection.integrity.status === "verified" &&
    projection.nodes
      .map((node) => node.id)
      .join(",") ===
      "root,role:implementer,role:reviewer",
  "PROJECTION_MISMATCH",
);

const lastMessage = (
  await readFile(lastMessageFile, "utf8")
).trim();
addError(
  errors,
  lastMessage === "P1E_HEADLESS_OK",
  "FINAL_MARKER_MISMATCH",
);
const storeScan = await scanStore(rootInfo.path);
addError(
  errors,
  storeScan.plaintextCapabilityFields === 0 &&
    storeScan.plaintextCapabilityCandidates === 0,
  "PLAINTEXT_CAPABILITY_FOUND",
);
addError(
  errors,
  storeScan.rawAcceptancePromptFragments === 0,
  "RAW_ACCEPTANCE_PROMPT_FOUND",
);

const evidence = {
  schemaVersion: 1,
  probe: "p1e-real-headless",
  passed: errors.length === 0,
  errors,
  codexLane: "desktop-bundled",
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
    counts: {
      events: events.length,
      operations: operations.length,
      reports: reports.length,
      transitions: transitions.length,
      governorDecisions: decisions.length,
      recoveries: recoveries.length,
      bindings: bindings.length,
      observations: observations.length,
      pendingObservations:
        pendingObservations.length,
      observedWorkers: observedWorkers.length,
    },
    eventCounts: countsBy(events, "event"),
    operationSteps,
    decisionSteps,
    revisionShape,
  },
  projection: {
    projectionVersion: projection.projectionVersion,
    status: projection.status,
    revision: projection.revision,
    digest: projection.projectionDigest,
    stableNodeIds: projection.nodes.map(
      (node) => node.id,
    ),
    timelineCount: projection.timeline.length,
    recoveryCount: projection.counts.recoveries,
  },
  storeScan,
  finalMarkerMatched: lastMessage === "P1E_HEADLESS_OK",
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
