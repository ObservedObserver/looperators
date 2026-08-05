#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { sha256 } from "../lib/canonical-json.mjs";
import { assertSafeFileId } from "../lib/contracts.mjs";
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
const transitions = facts(
  await store.listTransitions(runId),
  "TRANSITIONS",
  errors,
);
const resumeEvents = events.filter(
  (event) =>
    event.event === "SessionStart" &&
    event.payloadSummary?.source === "resume",
);
const interrupt = decisions[0];
const origin = events.find(
  (event) => event.eventId === interrupt?.originEventId,
);

addError(
  errors,
  state.status === "cancelled" &&
    state.revision === 3 &&
    state.cancelRequested === true &&
    state.continuationLease.granted === 2 &&
    state.continuationLease.consumed === 0 &&
    state.pendingTransitionId === undefined,
  "FINAL_STATE_MISMATCH",
);
addError(
  errors,
  operations.map((operation) => operation.kind).join(",") ===
    "start,cancel" &&
    operations[0]?.fromRevision === 0 &&
    operations[0]?.toRevision === 1 &&
    operations[1]?.fromRevision === 2 &&
    operations[1]?.toRevision === 3,
  "OPERATION_SEQUENCE_MISMATCH",
);
addError(
  errors,
  decisions.length === 1 &&
    interrupt?.action === "interrupt" &&
    interrupt?.hookEvent === "SessionStart" &&
    interrupt?.reasonCode === "resume-in-flight" &&
    interrupt?.fromRevision === 1 &&
    interrupt?.toRevision === 2 &&
    interrupt?.leaseEpoch === undefined &&
    origin?.event === "SessionStart" &&
    origin?.payloadSummary?.source === "resume",
  "INTERRUPT_DECISION_MISMATCH",
);
addError(
  errors,
  resumeEvents.length === 1 &&
    events.every(
      (event) => event.sessionId === state.rootSessionId,
    ) &&
    interrupt?.rootSessionId === state.rootSessionId,
  "RESUME_SESSION_CONTINUITY_MISMATCH",
);
addError(
  errors,
  transitions.length === 2 &&
    transitions.some(
      (transition) => transition.kind === "activate-implementer",
    ) &&
    transitions.some(
      (transition) => transition.kind === "cancel",
    ),
  "TRANSITION_SEQUENCE_MISMATCH",
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
  probe: "p1c-real-resume",
  passed: errors.length === 0,
  errors,
  storeInstanceDigest: rootInfo.instanceIdDigest,
  runDigest: sha256(runId),
  rootSessionDigest: sha256(state.rootSessionId),
  status: state.status,
  revision: state.revision,
  cancelRequested: state.cancelRequested,
  continuationLease: state.continuationLease,
  counts: {
    events: events.length,
    operations: operations.length,
    transitions: transitions.length,
    governorDecisions: decisions.length,
    resumeEvents: resumeEvents.length,
  },
  sequence: [
    {
      kind: operations[0]?.kind,
      fromRevision: operations[0]?.fromRevision,
      toRevision: operations[0]?.toRevision,
    },
    {
      kind: interrupt?.action,
      hookEvent: interrupt?.hookEvent,
      reasonCode: interrupt?.reasonCode,
      fromRevision: interrupt?.fromRevision,
      toRevision: interrupt?.toRevision,
    },
    {
      kind: operations[1]?.kind,
      fromRevision: operations[1]?.fromRevision,
      toRevision: operations[1]?.toRevision,
    },
  ],
  sameSessionRootAcrossEvents: events.every(
    (event) => event.sessionId === state.rootSessionId,
  ),
  storeScan,
  finalMarker: "P1C_RESUME_OK",
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
