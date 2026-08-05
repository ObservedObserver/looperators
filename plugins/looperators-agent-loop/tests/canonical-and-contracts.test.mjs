import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  canonicalJson,
  digestJson,
} from "../lib/canonical-json.mjs";
import {
  normalizeHookEvent,
  validateGraphProjection,
  validateGovernorDecision,
  validateIdentityBinding,
  validateLegacyNativeTargetEvidence,
  validateLegacyQuarantineReceipt,
  validateLoopDefinition,
  validateLoopOperation,
  validateLoopReport,
  validateLoopRun,
  validateLoopTransition,
  validateNormalizedHookEvent,
  validateWorkerObservation,
} from "../lib/contracts.mjs";
import {
  buildLegacyNativeTargetEvidence,
  collectLegacyNativeTargetEntries,
  terminalStateForRecovery,
} from "../lib/recovery.mjs";
import { PLUGIN_ROOT, loopState } from "./helpers.mjs";

test("canonical JSON v1 is key-order independent and rejects unsafe values", () => {
  const left = { z: [3, { b: true, a: -0 }], a: "ok" };
  const right = { a: "ok", z: [3, { a: 0, b: true }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(digestJson(left), digestJson(right));
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ bad: undefined }), /rejects undefined/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular/);
});

test("legacy evidence is bounded and never serializes native worker ids", () => {
  const state = {
    ...loopState({
      runId: "run-legacy-evidence",
      rootSessionId: "session-legacy-evidence",
    }),
    revision: 1,
  };
  const definition = {
    schemaVersion: 1,
    definitionId: `definition_${"1".repeat(64)}`,
    runId: state.runId,
    requestId: "preview-legacy-evidence",
    requestDigest: "2".repeat(64),
    recipe: "review-until-clean",
    goal: "Synthetic evidence fixture.",
    implementerInstructions: "Implement.",
    reviewerInstructions: "Review.",
    lapCap: 3,
    createdAt: state.createdAt,
  };
  const binding = {
    schemaVersion: 1,
    bindingId: `binding_${"3".repeat(64)}`,
    runId: state.runId,
    agentId: "native-agent-secret-shape",
    rootSessionId: state.rootSessionId,
    method: "capability-token-v1",
    tokenDigest: "4".repeat(64),
    role: "implementer",
    requestId: "bind-legacy-evidence",
    requestDigest: "5".repeat(64),
    observationId: `observation_${"6".repeat(64)}`,
    originEventId: `evt_${"7".repeat(64)}`,
    createdAt: state.createdAt,
  };
  const operation = {
    schemaVersion: 1,
    operationId: `op_${"8".repeat(64)}`,
    runId: state.runId,
    requestId: "start-legacy-evidence",
    requestDigest: "9".repeat(64),
    kind: "start",
    actorKind: "root",
    actorId: state.rootSessionId,
    fromRevision: 0,
    toRevision: 1,
    transitionId: `transition_${"a".repeat(64)}`,
    createdAt: state.createdAt,
  };
  const transition = {
    schemaVersion: 1,
    transitionId: operation.transitionId,
    runId: state.runId,
    requestId: operation.requestId,
    requestDigest: operation.requestDigest,
    kind: "activate-implementer",
    fromNode: state.masterNode,
    toNode: binding.agentId,
    lap: 0,
    fromRevision: 0,
    toRevision: 1,
    createdAt: state.createdAt,
  };
  const evidence = buildLegacyNativeTargetEvidence({
    state,
    definition,
    operations: [operation],
    governorDecisions: [],
    transitions: [transition],
    reports: [],
    bindings: [binding],
  });
  assert.deepEqual(
    validateLegacyNativeTargetEvidence(evidence),
    [],
  );
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /native-agent-secret-shape/,
  );

  const operations = [];
  const transitions = [];
  for (let index = 0; index < 17; index += 1) {
    const transitionId = `legacy-transition-${index}`;
    operations.push({
      ...operation,
      operationId: `legacy-operation-${index}`,
      requestId: `legacy-request-${index}`,
      transitionId,
      fromRevision: index,
      toRevision: index + 1,
    });
    transitions.push({
      ...transition,
      transitionId,
      requestId: `legacy-request-${index}`,
      fromRevision: index,
      toRevision: index + 1,
    });
  }
  assert.throws(
    () =>
      collectLegacyNativeTargetEntries({
        state: { ...state, revision: 17 },
        operations,
        transitions,
        reports: [],
        bindings: [binding],
      }),
    { code: "LEGACY_RECOVERY_LIMIT" },
  );
  const preserved = terminalStateForRecovery(
    { ...state, cancelRequested: true },
    {
      recoveryId: `recovery_${"c".repeat(64)}`,
      toRevision: state.revision + 1,
      createdAt: "2026-07-26T00:00:02.000Z",
    },
  );
  assert.equal(preserved.cancelRequested, true);
  assert.equal(preserved.status, "failed");
});

test("hook normalization is deterministic and excludes prompt and tool payloads", () => {
  const input = {
    session_id: "session-1",
    turn_id: "turn-1",
    hook_event_name: "PreToolUse",
    tool_use_id: "call-1",
    tool_name: "Bash",
    prompt: "private prompt must not persist",
    last_assistant_message: "private transcript tail",
    tool_input: {
      command: "SECRET_VALUE=should-not-persist",
      nested: { secret: "also-private" },
    },
  };
  const first = normalizeHookEvent(input, {
    observedAt: "2026-07-26T00:00:00.000Z",
  });
  const duplicate = normalizeHookEvent(input, {
    observedAt: "2026-07-26T01:00:00.000Z",
  });
  assert.equal(first.eventId, duplicate.eventId);
  assert.equal(first.semanticKey, duplicate.semanticKey);
  assert.equal(first.payloadDigest, duplicate.payloadDigest);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(
    serialized,
    /private prompt|transcript tail|SECRET_VALUE|also-private/,
  );
  assert.deepEqual(first.payloadSummary.toolInputKeys, ["command", "nested"]);
  assert.deepEqual(validateNormalizedHookEvent(first), []);

  const conflicting = normalizeHookEvent(
    { ...input, tool_name: "functions.exec" },
    { observedAt: "2026-07-26T00:00:01.000Z" },
  );
  assert.equal(conflicting.semanticKey, first.semanticKey);
  assert.notEqual(conflicting.payloadDigest, first.payloadDigest);
  assert.notEqual(conflicting.eventId, first.eventId);
});

test("unknown deliveries are isolated and do not enter semantic conflicts", () => {
  const first = normalizeHookEvent(
    { hook_event_name: "FutureHook", session_id: "session-1" },
    {
      observedAt: "2026-07-26T00:00:00.000Z",
      deliveryDigest: "delivery-one",
    },
  );
  const second = normalizeHookEvent(
    { hook_event_name: "FutureHook", session_id: "session-1" },
    {
      observedAt: "2026-07-26T00:00:00.000Z",
      deliveryDigest: "delivery-two",
    },
  );
  assert.equal(first.conflictEligible, false);
  assert.equal(second.conflictEligible, false);
  assert.notEqual(first.semanticKey, second.semanticKey);
});

test("known hook deliveries without required correlation ids are isolated", () => {
  const first = normalizeHookEvent(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "first",
    },
    {
      observedAt: "2026-07-26T00:00:00.000Z",
      deliveryDigest: "missing-turn-one",
    },
  );
  const second = normalizeHookEvent(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "second",
    },
    {
      observedAt: "2026-07-26T00:00:01.000Z",
      deliveryDigest: "missing-turn-two",
    },
  );
  assert.equal(first.conflictEligible, false);
  assert.equal(second.conflictEligible, false);
  assert.notEqual(first.semanticKey, second.semanticKey);
  assert.notEqual(first.eventId, second.eventId);
});

test("versioned loop contracts reject invalid shapes", () => {
  const timestamp = "2026-07-26T00:00:00.000Z";
  const definition = {
    schemaVersion: 1,
    definitionId: `definition_${"a".repeat(64)}`,
    runId: `run_${"b".repeat(64)}`,
    requestId: "request-preview",
    requestDigest: "c".repeat(64),
    recipe: "review-until-clean",
    goal: "Keep the review loop bounded.",
    implementerInstructions: "Address the current review findings.",
    reviewerInstructions: "Report issues or a clean verdict.",
    lapCap: 3,
    createdAt: timestamp,
  };
  const operation = {
    schemaVersion: 1,
    operationId: `op_${"d".repeat(64)}`,
    runId: definition.runId,
    requestId: "request-report",
    requestDigest: "e".repeat(64),
    kind: "report",
    actorKind: "worker",
    actorId: "agent-reviewer",
    fromRevision: 1,
    toRevision: 2,
    reportId: "report-1",
    transitionId: "transition-1",
    createdAt: timestamp,
  };
  const report = {
    schemaVersion: 1,
    reportId: "report-1",
    runId: "run-p1a",
    requestId: "request-report",
    requestDigest: "e".repeat(64),
    fromRevision: 1,
    toRevision: 2,
    fromNode: "agent-reviewer",
    receiver: "root-master",
    type: "verdict",
    verdict: "clean",
    createdAt: timestamp,
  };
  const transition = {
    schemaVersion: 1,
    transitionId: "transition-1",
    runId: "run-p1a",
    kind: "succeed",
    lap: 1,
    createdAt: timestamp,
  };
  const binding = {
    schemaVersion: 1,
    bindingId: "binding-1",
    runId: "run-p1a",
    agentId: "agent-reviewer",
    rootSessionId: "session-root",
    method: "capability-token-v1",
    tokenDigest: "a".repeat(64),
    createdAt: timestamp,
  };
  assert.deepEqual(validateLoopDefinition(definition), []);
  assert.deepEqual(validateLoopOperation(operation), []);
  assert.deepEqual(validateLoopReport(report), []);
  assert.deepEqual(validateLoopTransition(transition), []);
  assert.deepEqual(validateLoopRun(loopState()), []);
  assert.deepEqual(validateIdentityBinding(binding), []);
  assert.ok(validateLoopReport({ ...report, verdict: "maybe" }).length > 0);
  assert.ok(
    validateLoopDefinition({ ...definition, lapCap: 7 }).length > 0,
  );
  assert.ok(
    validateLoopOperation({
      ...operation,
      reportId: undefined,
    }).length > 0,
  );
  assert.ok(
    validateLoopOperation({
      ...operation,
      toRevision: 3,
    }).length > 0,
  );
  assert.ok(
    validateLoopReport({ ...report, verdict: undefined }).length > 0,
  );
  assert.ok(
    validateLoopReport({ ...report, toRevision: 3 }).length > 0,
  );
  assert.ok(
    validateLoopRun({
      ...loopState(),
      continuationLease: { granted: 2, consumed: 3 },
    }).length > 0,
  );
  assert.ok(
    validateIdentityBinding({ ...binding, tokenDigest: "raw-token" }).length >
      0,
  );
  assert.ok(
    validateIdentityBinding({ ...binding, tokenDigest: undefined }).length >
      0,
  );
  assert.ok(
    validateIdentityBinding({
      ...binding,
      method: "host-metadata-v1",
      tokenDigest: undefined,
      hostIdentityDigest: undefined,
    }).length > 0,
  );
});

test("all checked-in JSON schemas are parseable and versioned", async () => {
  const schemas = [
    "event.schema.json",
    "definition.schema.json",
    "operation.schema.json",
    "report.schema.json",
    "transition.schema.json",
    "run.schema.json",
    "identity-binding.schema.json",
    "worker-observation.schema.json",
    "graph-projection.schema.json",
  ];
  for (const name of schemas) {
    const schema = JSON.parse(
      await readFile(path.join(PLUGIN_ROOT, "schemas", name), "utf8"),
    );
    assert.match(schema.$schema, /2020-12/);
    assert.equal(schema.type, "object");
    assert.equal(schema.properties.schemaVersion.const, 1);
  }
  const reportSchema = JSON.parse(
    await readFile(
      path.join(PLUGIN_ROOT, "schemas", "report.schema.json"),
      "utf8",
    ),
  );
  assert.deepEqual(reportSchema.allOf[0].then.required, ["verdict"]);
  const bindingSchema = JSON.parse(
    await readFile(
      path.join(
        PLUGIN_ROOT,
        "schemas",
        "identity-binding.schema.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    bindingSchema.allOf.map((rule) => rule.then.required[0]),
    [
      "tokenDigest",
      "hostIdentityDigest",
      "requestDigest",
      "requestId",
      "originEventId",
      "observationId",
      "role",
    ],
  );
  assert.deepEqual(bindingSchema.allOf.at(-1).then.required, [
    "role",
    "requestId",
    "requestDigest",
    "observationId",
    "originEventId",
  ]);
  const runSchema = JSON.parse(
    await readFile(
      path.join(PLUGIN_ROOT, "schemas", "run.schema.json"),
      "utf8",
    ),
  );
  assert.equal(
    runSchema.properties.continuationLease.oneOf.length,
    7,
  );
});

test("schema fixtures agree with the runtime conditional contracts", async () => {
  const fixtures = [
    {
      name: "governor-decision-valid.json",
      validator: validateGovernorDecision,
      valid: true,
    },
    {
      name: "governor-decision-invalid-missing-lease.json",
      validator: validateGovernorDecision,
      valid: false,
    },
    {
      name: "worker-observation-valid.json",
      validator: validateWorkerObservation,
      valid: true,
    },
    {
      name: "worker-observation-invalid-duplicate.json",
      validator: validateWorkerObservation,
      valid: false,
    },
    {
      name: "definition-valid.json",
      validator: validateLoopDefinition,
      valid: true,
    },
    {
      name: "definition-invalid-lap-cap.json",
      validator: validateLoopDefinition,
      valid: false,
    },
    {
      name: "operation-valid-report.json",
      validator: validateLoopOperation,
      valid: true,
    },
    {
      name: "operation-invalid-missing-report.json",
      validator: validateLoopOperation,
      valid: false,
    },
    {
      name: "report-valid.json",
      validator: validateLoopReport,
      valid: true,
    },
    {
      name: "report-valid-product.json",
      validator: validateLoopReport,
      valid: true,
    },
    {
      name: "report-invalid-missing-verdict.json",
      validator: validateLoopReport,
      valid: false,
    },
    {
      name: "report-invalid-missing-revisions.json",
      validator: validateLoopReport,
      valid: false,
    },
    {
      name: "identity-valid-capability.json",
      validator: validateIdentityBinding,
      valid: true,
    },
    {
      name: "identity-invalid-missing-token.json",
      validator: validateIdentityBinding,
      valid: false,
    },
    {
      name: "run-valid.json",
      validator: validateLoopRun,
      valid: true,
    },
    {
      name: "run-invalid-consumed-over-granted.json",
      validator: validateLoopRun,
      valid: false,
    },
    {
      name: "graph-projection-valid.json",
      validator: validateGraphProjection,
      valid: true,
    },
    {
      name: "graph-projection-invalid-corrupt.json",
      validator: validateGraphProjection,
      valid: false,
    },
    {
      name: "legacy-native-target-evidence-valid.json",
      validator: validateLegacyNativeTargetEvidence,
      valid: true,
    },
    {
      name: "legacy-native-target-evidence-invalid-field.json",
      validator: validateLegacyNativeTargetEvidence,
      valid: false,
    },
    {
      name: "legacy-quarantine-valid.json",
      validator: validateLegacyQuarantineReceipt,
      valid: true,
    },
    {
      name: "legacy-quarantine-invalid-count.json",
      validator: validateLegacyQuarantineReceipt,
      valid: false,
    },
    {
      name: "legacy-quarantine-invalid-adjacency.json",
      validator: validateLegacyQuarantineReceipt,
      valid: false,
    },
  ];
  for (const fixture of fixtures) {
    const value = JSON.parse(
      await readFile(
        path.join(
          PLUGIN_ROOT,
          "tests",
          "fixtures",
          "schema",
          fixture.name,
        ),
        "utf8",
      ),
    );
    const errors = fixture.validator(value);
    assert.equal(
      errors.length === 0,
      fixture.valid,
      `${fixture.name}: ${errors.join("; ")}`,
    );
  }
});
