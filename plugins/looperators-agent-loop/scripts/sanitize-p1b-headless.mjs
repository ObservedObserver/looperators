#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { compareCodePoints, sha256 } from "../lib/canonical-json.mjs";
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

function sortedFacts(read, kind, errors) {
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
    const entries = await readdir(current, {
      withFileTypes: true,
    });
    for (const entry of entries) {
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
const runEntries = (
  await readdir(path.join(rootInfo.path, "runs"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => assertSafeFileId(entry.name, "runId"));

const errors = [];
const inspected = [];
for (const runId of runEntries) {
  const state = await store.readState(runId);
  const definition = await store.readDefinition(runId);
  const events = sortedFacts(
    await store.listEvents(runId),
    "EVENTS",
    errors,
  );
  const operations = sortedFacts(
    await store.listOperations(runId),
    "OPERATIONS",
    errors,
  ).sort((left, right) => left.fromRevision - right.fromRevision);
  const reports = sortedFacts(
    await store.listReports(runId),
    "REPORTS",
    errors,
  );
  const transitions = sortedFacts(
    await store.listTransitions(runId),
    "TRANSITIONS",
    errors,
  );
  const bindings = sortedFacts(
    await store.listIdentityBindings(runId),
    "IDENTITY",
    errors,
  );
  const observations = sortedFacts(
    await store.listWorkerObservations(runId),
    "WORKER_OBSERVATIONS",
    errors,
  ).sort((left, right) =>
    compareCodePoints(left.createdAt, right.createdAt),
  );
  const pending = sortedFacts(
    await store.readPendingWorkerObservations(runId),
    "PENDING_WORKER_OBSERVATIONS",
    errors,
  );
  const observed = sortedFacts(
    await store.listObservedSubagentStarts(
      runId,
      state.rootSessionId,
    ),
    "OBSERVED_WORKERS",
    errors,
  );
  const reportById = new Map(
    reports.map((report) => [report.reportId, report]),
  );
  const transitionById = new Map(
    transitions.map((transition) => [
      transition.transitionId,
      transition,
    ]),
  );
  const bindingByAgent = new Map(
    bindings.map((binding) => [binding.agentId, binding]),
  );
  const observedByAgent = new Map(
    observed.map((event) => [event.agentId, event]),
  );
  const observationById = new Map(
    observations.map((observation) => [
      observation.observationId,
      observation,
    ]),
  );
  const observedByEvent = new Map(
    observed.map((event) => [event.eventId, event]),
  );
  const spawnToolUseIds = [
    ...new Set(
      events
        .filter(isNativeSpawnPreToolUse)
        .map((event) => event.toolUseId),
    ),
  ].sort(compareCodePoints);

  const steps = operations.map((operation) => {
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
    addError(
      errors,
      transition?.fromRevision === operation.fromRevision &&
        transition?.toRevision === operation.toRevision,
      "TRANSITION_REVISION_MISMATCH",
    );
    addError(
      errors,
      !report ||
        (report.fromRevision === operation.fromRevision &&
          report.toRevision === operation.toRevision),
      "REPORT_REVISION_MISMATCH",
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
              ...(report.status
                ? { status: report.status }
                : {}),
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

  const sessionIds = new Set(
    events
      .map((event) => event.sessionId)
      .filter((value) => typeof value === "string"),
  );
  addError(
    errors,
    [...sessionIds].every(
      (sessionId) => sessionId === state.rootSessionId,
    ),
    "HOOK_MCP_SESSION_MISMATCH",
  );
  addError(
    errors,
    bindings.every((binding) =>
      observedByAgent.has(binding.agentId),
    ),
    "BOUND_AGENT_NOT_OBSERVED",
  );
  addError(
    errors,
    pending.length === 0,
    "PENDING_WORKER_OBSERVATION_REMAINS",
  );
  addError(
    errors,
    bindings.every((binding) => {
      const baseline = observationById.get(
        binding.observationId,
      );
      const origin = observedByEvent.get(
        binding.originEventId,
      );
      return (
        baseline?.role === binding.role &&
        origin?.agentId === binding.agentId &&
        !baseline.subagentStartEventIds.includes(
          binding.originEventId,
        )
      );
    }),
    "BINDING_OBSERVATION_PROVENANCE_MISMATCH",
  );
  addError(
    errors,
    new Set(
      bindings.map((binding) => binding.observationId),
    ).size === bindings.length,
    "OBSERVATION_REUSED_BY_BINDINGS",
  );
  addError(
    errors,
    new Set(bindings.map((binding) => binding.role)).size ===
      bindings.length,
    "DUPLICATE_BOUND_ROLE",
  );
  addError(
    errors,
    new Set(operations.map((operation) => operation.requestId))
      .size === operations.length,
    "DUPLICATE_OPERATION_REQUEST",
  );
  const start = operations.find(
    (operation) => operation.kind === "start",
  );
  const firstObserved = observed[0];
  addError(
    errors,
    !firstObserved ||
      (start &&
        Date.parse(firstObserved.observedAt) >
          Date.parse(start.createdAt)),
    "WORKER_OBSERVED_BEFORE_START",
  );

  inspected.push({
    createdAt: definition.createdAt,
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
      bindings: bindings.length,
      observations: observations.length,
      pendingWorkerObservations: pending.length,
      observedWorkers: observed.length,
      nativeSpawnAttempts: spawnToolUseIds.length,
    },
    eventCounts: countsBy(events, "event"),
    observedWorkers: observed.map((event) => ({
      agentDigest: sha256(event.agentId),
      eventDigest: sha256(event.eventId),
      boundRole:
        bindingByAgent.get(event.agentId)?.role ?? null,
    })),
    workerObservations: observations.map(
      (observation) => ({
        observationDigest: sha256(
          observation.observationId,
        ),
        role: observation.role,
        baselineSpawnCount:
          observation.spawnToolUseIds.length,
        baselineWorkerCount:
          observation.subagentStartEventIds.length,
        baselineBindingCount:
          observation.bindingIds.length,
        consumed: bindings.some(
          (binding) =>
            binding.observationId ===
            observation.observationId,
        ),
      }),
    ),
    hookSessionMatchesMcpRoot: [...sessionIds].every(
      (sessionId) => sessionId === state.rootSessionId,
    ),
    workerObservedAfterStart:
      !firstObserved ||
      (start &&
        Date.parse(firstObserved.observedAt) >
          Date.parse(start.createdAt)),
    steps,
  });
}

inspected.sort((left, right) =>
  compareCodePoints(left.createdAt, right.createdAt),
);
for (const run of inspected) {
  delete run.createdAt;
}

addError(errors, inspected.length === 2, "EXPECTED_TWO_RUNS");
const reviewRun = inspected[0];
const controlRun = inspected[1];
addError(
  errors,
  reviewRun?.status === "succeeded" &&
    reviewRun.revision === 3 &&
    reviewRun.counts.observedWorkers === 2 &&
    reviewRun.counts.bindings === 2 &&
    reviewRun.counts.observations === 2 &&
    reviewRun.counts.pendingWorkerObservations === 0 &&
    reviewRun.counts.nativeSpawnAttempts === 2 &&
    reviewRun.workerObservations
      .map(
        (observation) =>
          `${observation.role}:${observation.baselineSpawnCount}:${observation.baselineWorkerCount}:${observation.baselineBindingCount}:${observation.consumed}`,
      )
      .join(",") ===
      "implementer:0:0:0:true,reviewer:1:1:1:true" &&
    reviewRun.steps.map((step) => step.kind).join(",") ===
      "start,report,report" &&
    reviewRun.steps[1]?.report?.status === "done" &&
    reviewRun.steps[2]?.report?.verdict === "clean",
  "REVIEW_LOOP_SEQUENCE_MISMATCH",
);
addError(
  errors,
  controlRun?.status === "cancelled" &&
    controlRun.revision === 4 &&
    controlRun.steps.map((step) => step.kind).join(",") ===
      "start,pause,resume,cancel",
  "CONTROL_LOOP_SEQUENCE_MISMATCH",
);
addError(
  errors,
  new Set(
    inspected.map((run) => run.rootSessionDigest),
  ).size === 1,
  "RUN_ROOT_SESSION_MISMATCH",
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

const evidence = {
  schemaVersion: 1,
  probe: "p1b-real-headless",
  passed: errors.length === 0,
  errors,
  storeInstanceDigest: rootInfo.instanceIdDigest,
  runCount: inspected.length,
  runs: inspected,
  storeScan,
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
