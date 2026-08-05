import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LoopController } from "../lib/control.mjs";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { LoopStore } from "../lib/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "looperators-cooperative-loop-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootInfo = await resolveDataRoot({
    env: { LOOPERATORS_DATA_DIR: root },
  });
  const store = new LoopStore(rootInfo);
  const context = {
    rootSessionId: "cooperative-root",
    turnId: "preview-turn",
    threadSource: "user",
  };
  return { root, store, context };
}

async function jsonText(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      if (entry.isFile() && entry.name.endsWith(".json")) {
        output.push(await readFile(target, "utf8"));
      }
    }
  }
  await walk(root);
  return output.join("\n");
}

async function startedRun(t) {
  const value = await fixture(t);
  const controller = new LoopController(value.store);
  const preview = await controller.preview(value.context, {
    requestId: "preview-1",
    goal: "Review until clean without default hooks.",
    implementerInstructions: "Implement the requested change.",
    reviewerInstructions: "Return a typed clean or issues verdict.",
    lapCap: 3,
  });
  const started = await controller.start(
    { ...value.context, turnId: "confirmed-turn" },
    { runId: preview.runId, requestId: "start-1" },
  );
  return { ...value, controller, preview, started };
}

test("confirmed start needs no hook and issues an action-scoped role capability", async (t) => {
  const value = await startedRun(t);
  assert.equal(value.started.status, "running");
  assert.equal(value.started.roleCapability.role, "implementer");
  assert.equal(
    value.started.roleCapability.pendingTransitionId,
    value.started.pendingTransitionId,
  );
  const bindings = await value.store.listIdentityBindings(
    value.preview.runId,
  );
  assert.deepEqual(
    bindings.facts
      .map(({ agentId, role }) => ({ agentId, role }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    [
      { agentId: "role:implementer", role: "implementer" },
      { agentId: "role:reviewer", role: "reviewer" },
    ],
  );
  assert.doesNotMatch(
    await jsonText(value.root),
    new RegExp(value.started.roleCapability.capabilityToken),
  );
  const snapshot = await value.controller.getSnapshot(
    { ...value.context, turnId: "logical-binding-snapshot" },
    { runId: value.preview.runId },
  );
  assert.equal(
    snapshot.nodes.some((node) => node.nativeAgentId !== undefined),
    false,
  );
});

test("typed reports advance only the current role and reject stale action tokens", async (t) => {
  const value = await startedRun(t);
  const implementerToken =
    value.started.roleCapability.capabilityToken;
  const implemented = await value.controller.report({
    runId: value.preview.runId,
    requestId: "report-implementer-1",
    role: "implementer",
    capabilityToken: implementerToken,
    type: "info",
    status: "done",
    summary: "implementation complete",
  });
  assert.equal(implemented.status, "running");
  const reviewerAction = await value.controller.getLoop(
    { ...value.context, turnId: "governor-read-1" },
    { runId: value.preview.runId },
  );
  assert.equal(reviewerAction.roleCapability.role, "reviewer");
  await assert.rejects(
    value.controller.report({
      runId: value.preview.runId,
      requestId: "stale-implementer",
      role: "implementer",
      capabilityToken: implementerToken,
      type: "info",
      status: "done",
    }),
    { code: "CAPABILITY_REJECTED" },
  );
  const completed = await value.controller.report({
    runId: value.preview.runId,
    requestId: "report-reviewer-clean",
    role: "reviewer",
    capabilityToken:
      reviewerAction.roleCapability.capabilityToken,
    type: "verdict",
    verdict: "clean",
    issues: [],
    summary: "clean",
  });
  assert.equal(completed.status, "succeeded");
});

test("action capabilities work across independent MCP controller processes", async (t) => {
  const value = await startedRun(t);
  const implementerProcess = new LoopController(value.store);
  const implemented = await implementerProcess.report({
    runId: value.preview.runId,
    requestId: "cross-process-implementer",
    role: "implementer",
    capabilityToken:
      value.started.roleCapability.capabilityToken,
    type: "info",
    status: "done",
    summary: "reported from an independent controller",
  });
  assert.equal(implemented.status, "running");

  const reviewerAction = await value.controller.getLoop(
    { ...value.context, turnId: "cross-process-reviewer-read" },
    { runId: value.preview.runId },
  );
  const reviewerProcess = new LoopController(value.store);
  const completed = await reviewerProcess.report({
    runId: value.preview.runId,
    requestId: "cross-process-reviewer",
    role: "reviewer",
    capabilityToken:
      reviewerAction.roleCapability.capabilityToken,
    type: "verdict",
    verdict: "clean",
    issues: [],
  });
  assert.equal(completed.status, "succeeded");
});

test("pause preserves the action, cancel revokes it, and restart rotates it", async (t) => {
  const value = await startedRun(t);
  const originalToken =
    value.started.roleCapability.capabilityToken;
  await value.controller.pause(
    { ...value.context, turnId: "pause-turn" },
    { runId: value.preview.runId, requestId: "pause-1" },
  );
  await assert.rejects(
    value.controller.report({
      runId: value.preview.runId,
      requestId: "report-while-paused",
      role: "implementer",
      capabilityToken: originalToken,
      type: "info",
      status: "done",
    }),
    { code: "CAPABILITY_REJECTED" },
  );
  await value.controller.resume(
    { ...value.context, turnId: "resume-turn" },
    { runId: value.preview.runId, requestId: "resume-1" },
  );
  const restarted = new LoopController(value.store);
  const resigned = await restarted.getLoop(
    { ...value.context, turnId: "restart-read" },
    { runId: value.preview.runId },
  );
  assert.equal(resigned.roleCapability.role, "implementer");
  assert.notEqual(
    resigned.roleCapability.capabilityToken,
    originalToken,
  );
  await assert.rejects(
    restarted.report({
      runId: value.preview.runId,
      requestId: "pre-rotation-report",
      role: "implementer",
      capabilityToken: originalToken,
      type: "info",
      status: "done",
    }),
    { code: "CAPABILITY_REJECTED" },
  );
  await restarted.cancel(
    { ...value.context, turnId: "cancel-turn" },
    { runId: value.preview.runId, requestId: "cancel-1" },
  );
  await assert.rejects(
    restarted.report({
      runId: value.preview.runId,
      requestId: "report-after-cancel",
      role: "implementer",
      capabilityToken:
        resigned.roleCapability.capabilityToken,
      type: "info",
      status: "done",
    }),
    { code: "CAPABILITY_REJECTED" },
  );
});

test("start and report retries are idempotent but conflicting payloads fail", async (t) => {
  const value = await startedRun(t);
  const retriedStart = await value.controller.start(
    { ...value.context, turnId: "retry-start-turn" },
    { runId: value.preview.runId, requestId: "start-1" },
  );
  assert.equal(retriedStart.duplicate, true);
  assert.equal(
    retriedStart.roleCapability.capabilityToken,
    value.started.roleCapability.capabilityToken,
  );
  const report = {
    runId: value.preview.runId,
    requestId: "idempotent-report",
    role: "implementer",
    capabilityToken:
      value.started.roleCapability.capabilityToken,
    type: "info",
    status: "done",
    summary: "done once",
  };
  const first = await value.controller.report(report);
  assert.equal(first.duplicate, false);
  const current = await value.controller.getLoop(
    { ...value.context, turnId: "read-after-idempotent" },
    { runId: value.preview.runId },
  );
  const duplicate = await value.controller.report(report);
  assert.equal(duplicate.duplicate, true);
  assert.equal(current.roleCapability.role, "reviewer");
});

test("concurrent reports serialize exactly one legal transition", async (t) => {
  const value = await startedRun(t);
  const base = {
    runId: value.preview.runId,
    role: "implementer",
    capabilityToken:
      value.started.roleCapability.capabilityToken,
    type: "info",
    status: "done",
  };
  const results = await Promise.allSettled([
    value.controller.report({ ...base, requestId: "race-a" }),
    value.controller.report({ ...base, requestId: "race-b" }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason?.code === "CAPABILITY_REJECTED",
    ).length,
    1,
  );
  const state = await value.store.readState(value.preview.runId);
  assert.equal(state.revision, 2);
});

test("issues loop reaches its finite lap cap and exposes verified snapshots", async (t) => {
  const value = await fixture(t);
  const controller = new LoopController(value.store);
  const preview = await controller.preview(value.context, {
    requestId: "cap-preview",
    goal: "Reach a finite cap.",
    implementerInstructions: "Return done.",
    reviewerInstructions: "Return issues.",
    lapCap: 1,
  });
  await controller.start(
    { ...value.context, turnId: "cap-start" },
    { runId: preview.runId, requestId: "cap-start" },
  );
  for (let lap = 0; lap < 2; lap += 1) {
    const implementer = await controller.getLoop(
      { ...value.context, turnId: `cap-read-i-${lap}` },
      { runId: preview.runId },
    );
    await controller.report({
      runId: preview.runId,
      requestId: `cap-implementer-${lap}`,
      role: "implementer",
      capabilityToken:
        implementer.roleCapability.capabilityToken,
      type: "info",
      status: "done",
    });
    const reviewer = await controller.getLoop(
      { ...value.context, turnId: `cap-read-r-${lap}` },
      { runId: preview.runId },
    );
    await controller.report({
      runId: preview.runId,
      requestId: `cap-reviewer-${lap}`,
      role: "reviewer",
      capabilityToken:
        reviewer.roleCapability.capabilityToken,
      type: "verdict",
      verdict: "issues",
      issues: [{ message: `blocking issue ${lap}` }],
    });
  }
  const state = await controller.getLoop(
    { ...value.context, turnId: "cap-final-read" },
    { runId: preview.runId },
  );
  assert.equal(state.status, "capped");
  assert.equal("roleCapability" in state, false);
  const snapshot = await controller.getSnapshot(
    { ...value.context, turnId: "cap-snapshot" },
    { runId: preview.runId },
  );
  assert.equal(snapshot.integrity.status, "verified");
  assert.equal(snapshot.status, "capped");
  assert.deepEqual(
    snapshot.nodes.map((node) => node.id),
    ["root", "role:implementer", "role:reviewer"],
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /native-agent/u);
});

test("a prepared start crash rolls forward on exact retry", async (t) => {
  const value = await fixture(t);
  let injected = false;
  const crashing = new LoopController(value.store, {
    fault: async (point) => {
      if (!injected && point === "afterFacts") {
        injected = true;
        throw Object.assign(new Error("injected crash"), {
          code: "INJECTED_CRASH",
        });
      }
    },
  });
  const preview = await crashing.preview(value.context, {
    requestId: "crash-preview",
    goal: "Recover exact start.",
    implementerInstructions: "Return done.",
    reviewerInstructions: "Return clean.",
    lapCap: 2,
  });
  await assert.rejects(
    crashing.start(
      { ...value.context, turnId: "crash-start" },
      { runId: preview.runId, requestId: "crash-start" },
    ),
    { code: "INJECTED_CRASH" },
  );
  const recovered = new LoopController(value.store);
  const result = await recovered.start(
    { ...value.context, turnId: "crash-retry" },
    { runId: preview.runId, requestId: "crash-start" },
  );
  assert.equal(result.status, "running");
  assert.equal(result.duplicate, false);
  assert.equal(result.roleCapability.role, "implementer");
});
