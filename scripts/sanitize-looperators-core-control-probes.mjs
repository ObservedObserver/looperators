#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  compareCodePoints,
  sha256,
} from "../plugins/looperators-agent-loop/lib/canonical-json.mjs";
import {
  assertSafeFileId,
  isNativeSpawnPreToolUse,
} from "../plugins/looperators-agent-loop/lib/contracts.mjs";
import { resolveDataRoot } from "../plugins/looperators-agent-loop/lib/data-root.mjs";
import { atomicReplaceJson } from "../plugins/looperators-agent-loop/lib/fs-utils.mjs";
import { LoopStore } from "../plugins/looperators-agent-loop/lib/store.mjs";

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

function facts(read, label, errors) {
  addError(errors, read.corrupt.length === 0, `CORRUPT_${label}`);
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
  if (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    result.plaintextCapabilityCandidates += 1;
  }
}

async function scanStoreJson(directory) {
  const result = {
    jsonFiles: 0,
    plaintextCapabilityFields: 0,
    plaintextCapabilityCandidates: 0,
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

async function inspectRun(dataRoot, label, errors) {
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
  addError(
    errors,
    runIds.length === 1,
    `${label}_EXPECTED_ONE_RUN`,
  );
  const runId = runIds[0];
  const state = await store.readState(runId);
  const definition = await store.readDefinition(runId);
  const events = facts(
    await store.listEvents(runId),
    `${label}_EVENTS`,
    errors,
  );
  const operations = facts(
    await store.listOperations(runId),
    `${label}_OPERATIONS`,
    errors,
  ).sort((left, right) => left.fromRevision - right.fromRevision);
  const transitions = facts(
    await store.listTransitions(runId),
    `${label}_TRANSITIONS`,
    errors,
  ).sort((left, right) => left.fromRevision - right.fromRevision);
  const decisions = facts(
    await store.listGovernorDecisions(runId),
    `${label}_GOVERNOR_DECISIONS`,
    errors,
  ).sort((left, right) => left.fromRevision - right.fromRevision);
  const reports = facts(
    await store.listReports(runId),
    `${label}_REPORTS`,
    errors,
  );
  const bindings = facts(
    await store.listIdentityBindings(runId),
    `${label}_IDENTITY`,
    errors,
  );
  const observations = facts(
    await store.listWorkerObservations(runId),
    `${label}_WORKER_OBSERVATIONS`,
    errors,
  );
  const pendingObservations = facts(
    await store.readPendingWorkerObservations(runId),
    `${label}_PENDING_WORKER_OBSERVATIONS`,
    errors,
  );
  const observedWorkers = facts(
    await store.listObservedSubagentStarts(
      runId,
      state.rootSessionId,
    ),
    `${label}_OBSERVED_WORKERS`,
    errors,
  );
  const nativeSpawnAttempts = new Set(
    events
      .filter(isNativeSpawnPreToolUse)
      .map((event) => event.toolUseId),
  );
  const storeScan = await scanStoreJson(rootInfo.path);
  addError(
    errors,
    storeScan.plaintextCapabilityFields === 0,
    `${label}_PLAINTEXT_CAPABILITY_FIELD_FOUND`,
  );
  addError(
    errors,
    storeScan.plaintextCapabilityCandidates === 0,
    `${label}_PLAINTEXT_CAPABILITY_CANDIDATE_FOUND`,
  );
  addError(
    errors,
    events.every(
      (event) => event.sessionId === state.rootSessionId,
    ),
    `${label}_SESSION_ROOT_MISMATCH`,
  );
  return {
    rootInfo,
    runId,
    state,
    definition,
    events,
    operations,
    transitions,
    decisions,
    reports,
    bindings,
    observations,
    pendingObservations,
    observedWorkers,
    nativeSpawnAttempts,
    storeScan,
  };
}

function revisionSteps(factsToMap) {
  return factsToMap.map((fact) => ({
    kind: fact.kind,
    fromRevision: fact.fromRevision,
    toRevision: fact.toRevision,
  }));
}

function assertControl(run, errors) {
  addError(
    errors,
    run.definition.requestId === "core-control-20260728-01" &&
      run.definition.lapCap === 2,
    "CONTROL_DEFINITION_MISMATCH",
  );
  addError(
    errors,
    run.state.status === "cancelled" &&
      run.state.revision === 4 &&
      run.state.cancelRequested === true &&
      run.state.needsHuman === false &&
      run.state.continuationLease.granted === 2 &&
      run.state.continuationLease.consumed === 0 &&
      run.state.pendingTransitionId === undefined,
    "CONTROL_FINAL_STATE_MISMATCH",
  );
  addError(
    errors,
    run.operations
      .map(
        (fact) =>
          `${fact.kind}:${fact.fromRevision}:${fact.toRevision}`,
      )
      .join(",") ===
      "start:0:1,pause:1:2,resume:2:3,cancel:3:4",
    "CONTROL_OPERATION_SEQUENCE_MISMATCH",
  );
  addError(
    errors,
    run.transitions
      .map(
        (fact) =>
          `${fact.kind}:${fact.fromRevision}:${fact.toRevision}`,
      )
      .join(",") ===
      "activate-implementer:0:1,pause:1:2,resume:2:3,cancel:3:4",
    "CONTROL_TRANSITION_SEQUENCE_MISMATCH",
  );
  addError(
    errors,
    run.decisions.length === 0 &&
      run.reports.length === 0 &&
      run.bindings.length === 0 &&
      run.observations.length === 0 &&
      run.pendingObservations.length === 0 &&
      run.observedWorkers.length === 0 &&
      run.nativeSpawnAttempts.size === 0,
    "CONTROL_UNEXPECTED_WORK_FOUND",
  );
}

function assertCap(run, errors) {
  addError(
    errors,
    run.definition.requestId === "core-cap-20260728-01" &&
      run.definition.lapCap === 1,
    "CAP_DEFINITION_MISMATCH",
  );
  addError(
    errors,
    run.state.status === "capped" &&
      run.state.revision === 4 &&
      run.state.currentLap === 0 &&
      run.state.cancelRequested === false &&
      run.state.needsHuman === true &&
      run.state.continuationLease.granted === 1 &&
      run.state.continuationLease.consumed === 1 &&
      run.state.pendingTransitionId === undefined &&
      run.state.latestGovernorDecisionId ===
        run.decisions.at(-1)?.decisionId,
    "CAP_FINAL_STATE_MISMATCH",
  );
  addError(
    errors,
    run.operations
      .map(
        (fact) =>
          `${fact.kind}:${fact.fromRevision}:${fact.toRevision}`,
      )
      .join(",") === "start:0:1,report:2:3",
    "CAP_OPERATION_SEQUENCE_MISMATCH",
  );
  addError(
    errors,
    run.transitions
      .map(
        (fact) =>
          `${fact.kind}:${fact.fromRevision}:${fact.toRevision}`,
      )
      .join(",") ===
      "activate-implementer:0:1,activate-reviewer:2:3",
    "CAP_TRANSITION_SEQUENCE_MISMATCH",
  );
  addError(
    errors,
    run.decisions
      .map(
        (fact) =>
          [
            fact.action,
            fact.hookEvent,
            fact.reasonCode,
            fact.fromRevision,
            fact.toRevision,
            fact.leaseEpoch ?? "none",
          ].join(":"),
      )
      .join(",") ===
      [
        "block:Stop:pending-root-transition:1:2:1",
        "cap:Stop:lease-exhausted:3:4:none",
      ].join(","),
    "CAP_GOVERNOR_SEQUENCE_MISMATCH",
  );
  const report = run.reports[0];
  const binding = run.bindings[0];
  addError(
    errors,
    run.reports.length === 1 &&
      report?.type === "info" &&
      report?.status === "done" &&
      report?.fromNode === binding?.agentId,
    "CAP_TYPED_REPORT_MISMATCH",
  );
  addError(
    errors,
    run.bindings.length === 1 &&
      binding?.role === "implementer" &&
      run.observations.length === 1 &&
      run.pendingObservations.length === 0 &&
      run.observedWorkers.length === 1 &&
      run.nativeSpawnAttempts.size === 1 &&
      run.observedWorkers[0]?.agentId === binding?.agentId,
    "CAP_WORKER_PROVENANCE_MISMATCH",
  );
  const eventById = new Map(
    run.events.map((event) => [event.eventId, event]),
  );
  addError(
    errors,
    run.decisions.every(
      (decision) =>
        eventById.get(decision.originEventId)?.event ===
        decision.hookEvent,
    ),
    "CAP_DECISION_ORIGIN_MISMATCH",
  );
}

function summarize(run) {
  return {
    storeInstanceDigest: run.rootInfo.instanceIdDigest,
    runDigest: sha256(run.runId),
    rootSessionDigest: sha256(run.state.rootSessionId),
    status: run.state.status,
    revision: run.state.revision,
    currentLap: run.state.currentLap,
    lapCap: run.definition.lapCap,
    continuationLease: run.state.continuationLease,
    cancelRequested: run.state.cancelRequested,
    needsHuman: run.state.needsHuman ?? false,
    counts: {
      events: run.events.length,
      operations: run.operations.length,
      transitions: run.transitions.length,
      governorDecisions: run.decisions.length,
      reports: run.reports.length,
      bindings: run.bindings.length,
      observations: run.observations.length,
      pendingWorkerObservations:
        run.pendingObservations.length,
      observedWorkers: run.observedWorkers.length,
      nativeSpawnAttempts: run.nativeSpawnAttempts.size,
    },
    eventCounts: countsBy(run.events, "event"),
    operationSteps: revisionSteps(run.operations),
    transitionSteps: revisionSteps(run.transitions),
    continuationSteps: run.decisions.map((decision) => ({
      action: decision.action,
      hookEvent: decision.hookEvent,
      reasonCode: decision.reasonCode,
      fromRevision: decision.fromRevision,
      toRevision: decision.toRevision,
      ...(decision.leaseEpoch
        ? { leaseEpoch: decision.leaseEpoch }
        : {}),
      obligationDigest: sha256(decision.obligationId),
    })),
    workerRoles: run.bindings.map((binding) => ({
      role: binding.role,
      agentDigest: sha256(binding.agentId),
    })),
    storeScan: run.storeScan,
  };
}

const controlDataRoot = requiredAbsoluteArgument(
  "control-data-root",
);
const capDataRoot = requiredAbsoluteArgument("cap-data-root");
const output = requiredAbsoluteArgument("output");
const errors = [];
const control = await inspectRun(
  controlDataRoot,
  "CONTROL",
  errors,
);
const cap = await inspectRun(capDataRoot, "CAP", errors);
assertControl(control, errors);
assertCap(cap, errors);

const evidence = {
  schemaVersion: 1,
  probe: "trusted-hooks-core-controls",
  passed: errors.length === 0,
  errors,
  control: summarize(control),
  cap: summarize(cap),
  finalMarker: "CORE_CONTROL_CAP_OK",
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
