import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  canonicalJson,
  sha256,
} from "../lib/canonical-json.mjs";
import { normalizeHookEvent } from "../lib/contracts.mjs";
import { withFileLock } from "../lib/fs-utils.mjs";
import { LoopStore } from "../lib/store.mjs";
import {
  createLegacyQuarantineReceipt,
  terminalStateForRecovery,
} from "../lib/recovery.mjs";
import {
  PLUGIN_ROOT,
  loopState,
  spawnNode,
  tempStore,
} from "./helpers.mjs";

function eventInput(overrides = {}) {
  return {
    session_id: "session-root",
    turn_id: "turn-root",
    hook_event_name: "PreToolUse",
    tool_use_id: "call-1",
    tool_name: "Bash",
    tool_input: { command: "redacted" },
    ...overrides,
  };
}

function event(overrides = {}, observedAt = "2026-07-26T00:00:01.000Z") {
  return normalizeHookEvent(eventInput(overrides), { observedAt });
}

function governorDecision(overrides = {}) {
  const runId = overrides.runId ?? "run-p1a";
  const obligationId =
    overrides.obligationId ?? "transition-pending";
  const action = overrides.action ?? "block";
  const kind =
    action === "block"
      ? "continuation-block"
      : action === "cap"
        ? "continuation-cap"
        : "resume-interrupt";
  const identity =
    action === "interrupt"
      ? {
          runId,
          sessionStartEventId:
            overrides.originEventId ??
            `evt_${"b".repeat(64)}`,
          stateRevision: overrides.fromRevision ?? 0,
          kind,
        }
      : { runId, obligationId, kind };
  return {
    schemaVersion: 1,
    decisionId: `decision_${sha256(
      canonicalJson(identity),
    )}`,
    runId,
    obligationId,
    originEventId:
      overrides.originEventId ?? `evt_${"b".repeat(64)}`,
    hookEvent: "Stop",
    rootSessionId: "session-root",
    turnId: "turn-root",
    action,
    reasonCode:
      action === "block"
        ? "pending-root-transition"
        : action === "cap"
          ? "lease-exhausted"
          : "resume-in-flight",
    pendingTransitionId: obligationId,
    fromRevision: 0,
    toRevision: 1,
    ...(action === "block" ? { leaseEpoch: 1 } : {}),
    createdAt: "2026-07-26T00:00:02.000Z",
    ...overrides,
  };
}

function legacyRecovery(state, overrides = {}) {
  return createLegacyQuarantineReceipt({
    state,
    requestId: overrides.requestId ?? "recover-store-1",
    actorId: state.rootSessionId,
    evidence: {
      evidenceDigest:
        overrides.evidenceDigest ?? "a".repeat(64),
      entries: [
        {
          factKind: "transition",
          factId: "synthetic-transition",
        },
      ],
    },
    createdAt:
      overrides.createdAt ??
      "2026-07-26T00:00:02.000Z",
  });
}

test("duplicate events are idempotent and semantic conflicts are diagnosed deterministically", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  const first = event();
  const duplicate = event({}, "2026-07-26T00:10:00.000Z");
  const conflict = event({ tool_name: "functions.exec" });
  assert.equal((await store.putEvent("run-p1a", first)).status, "created");
  assert.equal(
    (await store.putEvent("run-p1a", duplicate)).status,
    "duplicate",
  );
  assert.equal((await store.putEvent("run-p1a", conflict)).status, "created");
  const projections = [];
  for (let index = 0; index < 3; index += 1) {
    projections.push(await store.foldRun("run-p1a"));
  }
  assert.equal(
    new Set(projections.map((item) => item.projectionDigest)).size,
    1,
  );
  assert.equal(projections[0].counts.events, 1);
  assert.equal(projections[0].counts.eventCandidates, 2);
  assert.equal(projections[0].counts.conflicts, 1);
  assert.equal(projections[0].counts.diagnostics, 1);
  const projectionText = await readFile(
    path.join(root, "runs", "run-p1a", "projection.json"),
    "utf8",
  );
  assert.match(projectionText, new RegExp(projections[0].projectionDigest));
});

test("independent concurrent writers converge on one immutable event", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  const value = event();
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  const worker = path.join(
    PLUGIN_ROOT,
    "tests",
    "fixtures",
    "put-event-worker.mjs",
  );
  const results = await Promise.all(
    Array.from({ length: 24 }, () =>
      spawnNode([worker, "run-p1a", encoded], {
        env: {
          ...process.env,
          LOOPERATORS_DATA_DIR: root,
        },
      }),
    ),
  );
  assert.ok(
    results.every((result) => result.exitCode === 0),
    JSON.stringify(results),
  );
  const statuses = results.map(
    (result) => JSON.parse(result.stdout.trim()).status,
  );
  assert.equal(
    statuses.filter((status) => status === "created").length,
    1,
  );
  assert.equal(
    statuses.filter((status) => status === "duplicate").length,
    23,
  );
  const projection = await store.foldRun("run-p1a");
  assert.equal(projection.counts.events, 1);
  assert.equal(projection.counts.eventCandidates, 1);
});

test("governor decisions are immutable, location-bound, and projected", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  const decision = governorDecision();
  assert.equal(
    (await store.putGovernorDecision("run-p1a", decision))
      .status,
    "created",
  );
  assert.equal(
    (await store.putGovernorDecision("run-p1a", decision))
      .status,
    "duplicate",
  );
  assert.equal(
    (
      await store.putGovernorDecision("run-p1a", {
        ...decision,
        originEventId: `evt_${"c".repeat(64)}`,
      })
    ).status,
    "conflict",
  );
  assert.deepEqual(
    await store.readGovernorDecision(
      "run-p1a",
      decision.decisionId,
    ),
    decision,
  );
  const projection = await store.foldRun("run-p1a");
  assert.equal(projection.counts.governorDecisions, 1);
  assert.ok(
    projection.timeline.some(
      (item) =>
        item.kind === "governor-decision" &&
        item.id === decision.decisionId,
    ),
  );

  const file = path.join(
    root,
    "runs",
    "run-p1a",
    "governor-decisions",
    `${decision.decisionId}.json`,
  );
  await writeFile(
    file,
    `${JSON.stringify({
      ...decision,
      obligationId: "transition-forged",
      pendingTransitionId: "transition-forged",
    })}\n`,
  );
  await assert.rejects(
    store.readGovernorDecision(
      "run-p1a",
      decision.decisionId,
    ),
    { code: "INVALID_CONTRACT" },
  );
  const listed = await store.listGovernorDecisions(
    "run-p1a",
  );
  assert.equal(listed.facts.length, 0);
  assert.equal(listed.corrupt.length, 1);
});

test("fold ignores temp residues and rebuilds corrupt state without losing facts", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  await store.putEvent("run-p1a", event());
  const runDirectory = path.join(root, "runs", "run-p1a");
  const indexDirectory = path.join(runDirectory, "indexes", "events");
  await mkdir(indexDirectory, { recursive: true });
  await writeFile(
    path.join(runDirectory, "events", ".partial.tmp-crash"),
    "{\"partial\":",
  );
  await writeFile(path.join(runDirectory, "events", "bad.json"), "{\"bad\":");
  const danglingIndex = path.join(indexDirectory, "dangling.json");
  await writeFile(
    danglingIndex,
    `${JSON.stringify({
      schemaVersion: 1,
      canonicalEventId: "evt_missing",
    })}\n`,
  );
  await writeFile(path.join(runDirectory, "state.json"), "{\"revision\":");
  const projection = await store.foldRun("run-p1a");
  assert.equal(projection.status, "interrupted");
  assert.equal(projection.needsHuman, true);
  assert.equal(projection.counts.events, 1);
  assert.equal(projection.counts.corrupt, 1);
  assert.ok(projection.counts.diagnostics >= 2);
  await assert.rejects(access(danglingIndex), { code: "ENOENT" });
  const rebuilt = await store.readState("run-p1a");
  assert.equal(rebuilt.status, "interrupted");
});

test("state location is part of the validated run identity", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  await writeFile(
    path.join(root, "runs", "run-p1a", "state.json"),
    `${JSON.stringify(loopState({ runId: "run-other" }))}\n`,
  );
  await assert.rejects(store.readState("run-p1a"), {
    code: "INVALID_CONTRACT",
  });
  const rebuilt = await store.foldRun("run-p1a");
  assert.equal(rebuilt.runId, "run-p1a");
  assert.equal(rebuilt.status, "interrupted");
});

test("session initialization publishes binding first and allows only one active run", async (t) => {
  const { root, store } = await tempStore(t);
  const first = loopState({
    runId: "run-session-first",
  });
  const second = loopState({
    runId: "run-session-second",
  });
  const initialized = await Promise.allSettled([
    store.initializeRun(first),
    store.initializeRun(second),
  ]);
  assert.equal(
    initialized.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = initialized.find(
    (result) => result.status === "rejected",
  );
  assert.equal(rejected.reason.code, "SESSION_BINDING_CONFLICT");
  const active = await store.activeRunForSession("session-root");
  assert.ok(
    ["run-session-first", "run-session-second"].includes(active),
  );

  const retryState = loopState({
    runId: "run-binding-first-retry",
    rootSessionId: "session-retry",
    masterNode: "session-retry",
  });
  const bindingDirectory = path.join(
    root,
    "session-bindings",
    sha256(retryState.rootSessionId),
  );
  await mkdir(bindingDirectory, { recursive: true });
  const binding = {
    schemaVersion: 1,
    bindingId: `session_${sha256(
      canonicalJson({
        runId: retryState.runId,
        rootSessionId: retryState.rootSessionId,
      }),
    )}`,
    runId: retryState.runId,
    rootSessionId: retryState.rootSessionId,
    createdAt: retryState.createdAt,
  };
  await writeFile(
    path.join(bindingDirectory, `${retryState.runId}.json`),
    `${JSON.stringify(binding)}\n`,
  );
  await store.initializeRun(retryState);
  assert.equal(
    await store.activeRunForSession(retryState.rootSessionId),
    retryState.runId,
  );
});

test("cross-task run-id collisions do not publish a poisoned session binding", async (t) => {
  const { store } = await tempStore(t);
  const first = loopState({
    runId: "run-shared-id",
    rootSessionId: "session-a",
    masterNode: "session-a",
  });
  await store.initializeRun(first);
  const collision = loopState({
    runId: "run-shared-id",
    rootSessionId: "session-b",
    masterNode: "session-b",
  });
  await assert.rejects(store.initializeRun(collision), {
    code: "RUN_ID_CONFLICT",
  });
  await assert.rejects(
    access(
      store.sessionBindingPath(
        collision.runId,
        collision.rootSessionId,
      ),
    ),
    { code: "ENOENT" },
  );
  const fresh = loopState({
    runId: "run-session-b-fresh",
    rootSessionId: "session-b",
    masterNode: "session-b",
  });
  await store.initializeRun(fresh);
  assert.equal(
    await store.activeRunForSession("session-a"),
    first.runId,
  );
  assert.equal(
    await store.activeRunForSession("session-b"),
    fresh.runId,
  );
});

test("store writes reject symlinked run directories", async (t) => {
  const { root, store } = await tempStore(t);
  const victim = await mkdtemp(
    path.join(path.dirname(root), "looperators-p1a-victim-"),
  );
  t.after(() => rm(victim, { recursive: true, force: true }));
  await mkdir(path.join(root, "runs"), { recursive: true });
  await symlink(victim, path.join(root, "runs", "run-p1a"), "dir");
  await assert.rejects(store.initializeRun(loopState()), {
    code: "UNSAFE_STORE_FILE",
  });
  await assert.rejects(access(path.join(victim, "state.json")), {
    code: "ENOENT",
  });
});

test("store rejects a contract-valid report above its UTF-8 read limit", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  const report = {
    schemaVersion: 1,
    reportId: "report-too-large",
    runId: "run-p1a",
    fromNode: "agent-reviewer",
    receiver: "root-master",
    type: "verdict",
    verdict: "issues",
    issues: Array.from({ length: 200 }, () => ({
      message: "界".repeat(4_000),
      file: "路".repeat(2_000),
    })),
    createdAt: "2026-07-26T00:00:01.000Z",
  };
  await assert.rejects(store.putReport("run-p1a", report), {
    code: "STORE_FILE_TOO_LARGE",
  });
  let reportFiles = [];
  try {
    reportFiles = await readdir(
      path.join(root, "runs", "run-p1a", "reports"),
    );
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
  assert.deepEqual(reportFiles, []);
  const projection = await store.foldRun("run-p1a");
  assert.equal(projection.counts.reports, 0);
  assert.equal(projection.counts.corrupt, 0);
});

test("state compare-and-swap rejects stale revisions and lock timeouts", async (t) => {
  const { root, store } = await tempStore(t);
  const state = loopState();
  await store.initializeRun(state);
  const updated = await store.compareAndSwapState("run-p1a", 0, {
    ...state,
    revision: 1,
    currentLap: 1,
    updatedAt: "2026-07-26T00:01:00.000Z",
  });
  assert.equal(updated.revision, 1);
  await assert.rejects(
    store.compareAndSwapState("run-p1a", 0, {
      ...updated,
      revision: 1,
    }),
    { code: "REVISION_CONFLICT" },
  );
  await assert.rejects(
    store.compareAndSwapState("run-p1a", 1, {
      ...updated,
      rootSessionId: "session-other",
      revision: 2,
      updatedAt: "2026-07-26T00:01:30.000Z",
    }),
    { code: "INVALID_STATE_TRANSITION" },
  );
  await assert.rejects(
    store.compareAndSwapState("run-p1a", 1, {
      ...updated,
      continuationLease: { granted: 4, consumed: 0 },
      revision: 2,
      updatedAt: "2026-07-26T00:01:30.000Z",
    }),
    { code: "INVALID_STATE_TRANSITION" },
  );
  const lockPath = path.join(
    root,
    "runs",
    "run-p1a",
    "locks",
    "state.lock",
  );
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(
    `${JSON.stringify({
      schemaVersion: 1,
      token: "held-lock",
      acquiredAt: new Date().toISOString(),
    })}\n`,
  );
  await handle.close();
  await assert.rejects(
    store.compareAndSwapState(
      "run-p1a",
      1,
      {
        ...updated,
        revision: 2,
        updatedAt: "2026-07-26T00:02:00.000Z",
      },
      { timeoutMs: 20, staleMs: 60_000, retryMs: 2 },
    ),
    { code: "STORE_LOCK_TIMEOUT" },
  );
});

test("file locks preserve callback failures and remain reusable after cleanup", async (t) => {
  const { root } = await tempStore(t);
  const lockPath = path.join(root, "locks", "callback.lock");
  const callbackError = new Error("callback failed");
  await assert.rejects(
    withFileLock(lockPath, async () => {
      throw callbackError;
    }),
    (error) => error === callbackError,
  );
  await assert.rejects(access(lockPath), { code: "ENOENT" });
  assert.equal(
    await withFileLock(lockPath, async () => "reacquired"),
    "reacquired",
  );
});

test("stale lock recovery never steals a lock from a live owner", async (t) => {
  const { root } = await tempStore(t);
  const lockPath = path.join(root, "locks", "owner.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token: "live-owner",
      pid: process.pid,
      acquiredAt: "2026-07-26T00:00:00.000Z",
    })}\n`,
  );
  await assert.rejects(
    withFileLock(lockPath, async () => "stolen", {
      staleMs: 0,
      timeoutMs: 20,
      retryMs: 2,
    }),
    { code: "STORE_LOCK_TIMEOUT" },
  );
  await unlink(lockPath);
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-07-26T00:00:00.000Z",
    })}\n`,
  );
  assert.equal(
    await withFileLock(lockPath, async () => "recovered", {
      staleMs: 0,
      timeoutMs: 100,
      retryMs: 2,
    }),
    "recovered",
  );
});

test("concurrent stale-lock reclaimers preserve mutual exclusion", async (t) => {
  const { root } = await tempStore(t);
  const lockPath = path.join(root, "locks", "contended-stale.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-07-26T00:00:00.000Z",
    })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  let inside = 0;
  let maximumInside = 0;
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      withFileLock(
        lockPath,
        async () => {
          inside += 1;
          maximumInside = Math.max(maximumInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 3));
          inside -= 1;
          return index;
        },
        {
          root,
          staleMs: 0,
          timeoutMs: 2_000,
          retryMs: 1,
        },
      ),
    ),
  );
  assert.equal(new Set(results).size, 16);
  assert.equal(maximumInside, 1);
});

test("stale lock recovery reclaims an abandoned guard but preserves a live guard", async (t) => {
  const { root } = await tempStore(t);
  const lockPath = path.join(root, "locks", "guarded-stale.lock");
  const guardPath = `${lockPath}.reclaim`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lock = {
    schemaVersion: 1,
    token: "dead-lock-owner",
    pid: 2_147_483_647,
    acquiredAt: "2026-07-26T00:00:00.000Z",
  };
  await writeFile(lockPath, `${JSON.stringify(lock)}\n`);
  await writeFile(
    guardPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token: "dead-reclaimer",
      pid: 2_147_483_647,
      acquiredAt: "2026-07-26T00:00:00.000Z",
    })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    await withFileLock(lockPath, async () => "guard-recovered", {
      root,
      staleMs: 0,
      timeoutMs: 500,
      retryMs: 1,
    }),
    "guard-recovered",
  );
  await assert.rejects(access(guardPath), { code: "ENOENT" });

  await writeFile(lockPath, `${JSON.stringify(lock)}\n`);
  await writeFile(
    guardPath,
    `${JSON.stringify({
      schemaVersion: 1,
      token: "live-reclaimer",
      pid: process.pid,
      acquiredAt: "2026-07-26T00:00:00.000Z",
    })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  await assert.rejects(
    withFileLock(lockPath, async () => "guard-stolen", {
      root,
      staleMs: 0,
      timeoutMs: 20,
      retryMs: 1,
    }),
    { code: "STORE_LOCK_TIMEOUT" },
  );
});

test("independent processes recover an abandoned guard without overlapping", async (t) => {
  const { root } = await tempStore(t);
  const lockPath = path.join(root, "locks", "process-stale.lock");
  const guardPath = `${lockPath}.reclaim`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (const [target, token] of [
    [lockPath, "dead-lock-owner"],
    [guardPath, "dead-reclaimer"],
  ]) {
    await writeFile(
      target,
      `${JSON.stringify({
        schemaVersion: 1,
        token,
        pid: 2_147_483_647,
        acquiredAt: "2026-07-26T00:00:00.000Z",
      })}\n`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2));
  const worker = path.join(
    PLUGIN_ROOT,
    "tests",
    "fixtures",
    "lock-worker.mjs",
  );
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      spawnNode([worker, root, lockPath]),
    ),
  );
  assert.ok(
    results.every((result) => result.exitCode === 0),
    JSON.stringify(results),
  );
  assert.ok(
    results.every(
      (result) => JSON.parse(result.stdout).overlap === false,
    ),
    JSON.stringify(results),
  );
  await assert.rejects(access(guardPath), { code: "ENOENT" });
});

test("diagnostics obey the active hard cap without mutating control state", async (t) => {
  const { root, store } = await tempStore(t, {
    retention: {
      diagnostics: 1,
      activeMultiplier: 2,
    },
  });
  await store.initializeRun(loopState());
  const results = [];
  for (let index = 0; index < 5; index += 1) {
    results.push(
      await store.writeDiagnostic(
        "run-p1a",
        "synthetic",
        { index },
      ),
    );
  }
  const files = await readdir(
    path.join(root, "runs", "run-p1a", "diagnostics"),
  );
  assert.equal(files.filter((name) => name.endsWith(".json")).length, 2);
  assert.equal(results.at(-1).status, "limit");
  const state = await store.readState("run-p1a");
  assert.equal(state.status, "running");
  assert.equal(state.revision, 0);
  assert.equal(state.needsHuman, undefined);
  const projection = await store.foldRun("run-p1a");
  assert.equal(projection.counts.diagnostics, 2);
});

test("active hard limits report capacity without creating an unreceipted revision", async (t) => {
  const { store } = await tempStore(t, {
    retention: {
      events: 2,
      reports: 2,
      transitions: 2,
      diagnostics: 4,
      activeMultiplier: 2,
      terminalBytes: 1_000_000,
    },
  });
  const state = loopState();
  await store.initializeRun(state);
  for (let index = 0; index < 4; index += 1) {
    const result = await store.putEvent(
      "run-p1a",
      event(
        {
          turn_id: `turn-${index}`,
          tool_use_id: `call-${index}`,
        },
        `2026-07-26T00:00:0${index}.000Z`,
      ),
    );
    assert.equal(result.status, "created");
  }
  const limited = await store.putEvent(
    "run-p1a",
    event(
      { turn_id: "turn-5", tool_use_id: "call-5" },
      "2026-07-26T00:00:05.000Z",
    ),
  );
  assert.equal(limited.status, "limit");
  const active = await store.readState("run-p1a");
  assert.equal(active.status, "running");
  assert.equal(active.revision, 0);
  assert.equal(active.needsHuman, undefined);
  const terminal = {
    ...active,
    status: "succeeded",
    revision: active.revision + 1,
    updatedAt: "2026-07-26T00:10:00.000Z",
  };
  await store.compareAndSwapState(
    "run-p1a",
    active.revision,
    terminal,
  );
  const retention = await store.enforceRetention("run-p1a");
  assert.equal(retention.status, "pruned");
  assert.equal(
    retention.removed.filter((item) => item.kind === "events").length,
    2,
  );
  const projection = await store.foldRun("run-p1a");
  assert.equal(projection.counts.events, 2);
});

test("terminal retention preserves state-referenced report and transition facts", async (t) => {
  const { root, store } = await tempStore(t, {
    retention: {
      events: 2,
      reports: 1,
      transitions: 1,
      diagnostics: 4,
      terminalBytes: 1_000_000,
    },
  });
  const state = loopState();
  await store.initializeRun(state);
  const reports = [
    {
      schemaVersion: 1,
      reportId: "report-protected",
      runId: "run-p1a",
      fromNode: "agent-reviewer",
      receiver: "root-master",
      type: "verdict",
      verdict: "clean",
      createdAt: "2026-07-26T00:00:01.000Z",
    },
    {
      schemaVersion: 1,
      reportId: "report-removable",
      runId: "run-p1a",
      fromNode: "agent-reviewer",
      receiver: "root-master",
      type: "info",
      createdAt: "2026-07-26T00:00:02.000Z",
    },
  ];
  const transitions = [
    {
      schemaVersion: 1,
      transitionId: "transition-protected",
      runId: "run-p1a",
      kind: "succeed",
      lap: 1,
      createdAt: "2026-07-26T00:00:01.000Z",
    },
    {
      schemaVersion: 1,
      transitionId: "transition-removable",
      runId: "run-p1a",
      kind: "interrupt",
      lap: 1,
      createdAt: "2026-07-26T00:00:02.000Z",
    },
  ];
  for (const report of reports) {
    assert.equal((await store.putReport("run-p1a", report)).status, "created");
  }
  for (const transition of transitions) {
    assert.equal(
      (await store.putTransition("run-p1a", transition)).status,
      "created",
    );
  }
  await store.compareAndSwapState("run-p1a", 0, {
    ...state,
    status: "succeeded",
    latestReportId: "report-protected",
    pendingTransitionId: "transition-protected",
    revision: 1,
    updatedAt: "2026-07-26T00:00:03.000Z",
  });
  const retention = await store.enforceRetention("run-p1a");
  assert.deepEqual(
    retention.removed
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "reports:report-removable",
      "transitions:transition-removable",
    ],
  );
  await access(
    path.join(
      root,
      "runs",
      "run-p1a",
      "reports",
      "report-protected.json",
    ),
  );
  await access(
    path.join(
      root,
      "runs",
      "run-p1a",
      "transitions",
      "transition-protected.json",
    ),
  );
});

test("terminal retention preserves governor receipts and their origin events", async (t) => {
  const { rootInfo, store } = await tempStore(t);
  const initial = loopState();
  await store.initializeRun(initial);
  const events = [
    normalizeHookEvent(
      {
        session_id: "session-root",
        turn_id: "turn-governor-retention-1",
        hook_event_name: "Stop",
        stop_hook_active: false,
      },
      { observedAt: "2026-07-26T00:00:01.000Z" },
    ),
    normalizeHookEvent(
      {
        session_id: "session-root",
        turn_id: "turn-governor-retention-2",
        hook_event_name: "Stop",
        stop_hook_active: true,
      },
      { observedAt: "2026-07-26T00:00:02.000Z" },
    ),
  ];
  const decisions = events.map((origin, index) =>
    governorDecision({
      obligationId: `transition-retention-${index + 1}`,
      originEventId: origin.eventId,
      turnId: origin.turnId,
      fromRevision: index,
      toRevision: index + 1,
      leaseEpoch: index + 1,
      createdAt: `2026-07-26T00:00:0${index + 3}.000Z`,
    }),
  );
  for (const origin of events) {
    await store.putEvent("run-p1a", origin);
  }
  for (const decision of decisions) {
    await store.putGovernorDecision(
      "run-p1a",
      decision,
    );
  }
  const afterFirst =
    await store.compareAndSwapState("run-p1a", 0, {
      ...initial,
      continuationLease: { granted: 3, consumed: 1 },
      latestGovernorDecisionId: decisions[0].decisionId,
      revision: 1,
      updatedAt: "2026-07-26T00:00:04.000Z",
    });
  await store.compareAndSwapState("run-p1a", 1, {
    ...afterFirst,
    status: "capped",
    continuationLease: { granted: 3, consumed: 2 },
    latestGovernorDecisionId:
      decisions.at(-1).decisionId,
    revision: 2,
    updatedAt: "2026-07-26T00:00:05.000Z",
  });
  const constrained = new LoopStore(rootInfo, {
    events: 1,
    "governor-decisions": 1,
    diagnostics: 4,
    terminalBytes: 1_000_000,
  });
  const retention =
    await constrained.enforceRetention("run-p1a");
  assert.equal(retention.status, "pruned");
  assert.equal(
    retention.removed.filter(
      ({ kind }) =>
        kind === "events" ||
        kind === "governor-decisions",
    ).length,
    0,
  );
  assert.equal(
    (await constrained.listEvents("run-p1a")).facts.length,
    2,
  );
  assert.equal(
    (
      await constrained.listGovernorDecisions(
        "run-p1a",
      )
    ).facts.length,
    2,
  );
});

test("terminal retention participates in the state CAS lock protocol", async (t) => {
  const { root, store } = await tempStore(t, {
    retention: {
      events: 1,
      diagnostics: 4,
      terminalBytes: 1_000_000,
    },
  });
  const initial = loopState();
  await store.initializeRun(initial);
  for (let index = 0; index < 4; index += 1) {
    await store.putEvent(
      "run-p1a",
      event(
        {
          turn_id: `turn-retention-${index}`,
          tool_use_id: `call-retention-${index}`,
        },
        `2026-07-26T00:00:0${index}.000Z`,
      ),
    );
  }
  const terminal = {
    ...initial,
    status: "succeeded",
    revision: 1,
    updatedAt: "2026-07-26T00:01:00.000Z",
  };
  await store.compareAndSwapState("run-p1a", 0, terminal);
  const lockPath = path.join(
    root,
    "runs",
    "run-p1a",
    "locks",
    "state.lock",
  );
  let retentionSettled = false;
  let resumeSettled = false;
  let retentionPromise;
  let resumePromise;
  await withFileLock(
    lockPath,
    async () => {
      retentionPromise = store
        .enforceRetention("run-p1a", {
          timeoutMs: 2_000,
          retryMs: 1,
        })
        .finally(() => {
          retentionSettled = true;
        });
      resumePromise = store
        .compareAndSwapState(
          "run-p1a",
          1,
          {
            ...terminal,
            status: "running",
            revision: 2,
            updatedAt: "2026-07-26T00:02:00.000Z",
          },
          { timeoutMs: 2_000, retryMs: 1 },
        )
        .finally(() => {
          resumeSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(retentionSettled, false);
      assert.equal(resumeSettled, false);
    },
    { root, timeoutMs: 2_000 },
  );
  await Promise.all([
    retentionPromise,
    assert.rejects(resumePromise, {
      code: "INVALID_STATE_TRANSITION",
    }),
  ]);
  assert.equal((await store.readState("run-p1a")).status, "succeeded");
  const remainingEvents = await readdir(
    path.join(root, "runs", "run-p1a", "events"),
  );
  assert.equal(
    remainingEvents.filter((name) => name.endsWith(".json")).length,
    1,
  );
});

test("legacy recovery receipts are atomic, immutable, and corrupt finals are never overwritten", async (t) => {
  const { store } = await tempStore(t);
  const state = loopState({
    runId: "run-recovery-store",
    revision: 1,
  });
  await store.initializeRun(state);
  const receipt = legacyRecovery(state);
  assert.equal(
    (await store.putRecovery(state.runId, receipt)).status,
    "created",
  );
  assert.equal(
    (await store.putRecovery(state.runId, receipt)).status,
    "duplicate",
  );
  assert.deepEqual(
    await store.readRecovery(
      state.runId,
      receipt.recoveryId,
    ),
    receipt,
  );
  assert.equal(
    (await store.listRecoveries(state.runId)).facts.length,
    1,
  );
  assert.equal(
    (
      await store.putRecovery(state.runId, {
        ...receipt,
        terminalStateDigest: "b".repeat(64),
      })
    ).status,
    "conflict",
  );

  const file = path.join(
    store.factDirectory(state.runId, "recoveries"),
    `${receipt.recoveryId}.json`,
  );
  await writeFile(file, "{\"schemaVersion\":1");
  const corruptBytes = await readFile(file, "utf8");
  await assert.rejects(
    store.putRecovery(state.runId, receipt),
  );
  assert.equal(await readFile(file, "utf8"), corruptBytes);
  const listed = await store.listRecoveries(state.runId);
  assert.equal(listed.facts.length, 0);
  assert.equal(listed.corrupt.length, 1);
});

test("legacy recovery storage rejects schema-valid semantic forgery and wrong locations", async (t) => {
  const { store } = await tempStore(t);
  const state = loopState({
    runId: "run-recovery-semantic-integrity",
    revision: 1,
  });
  await store.initializeRun(state);
  const receipt = legacyRecovery(state, {
    requestId: "recover-semantic-integrity",
  });
  await assert.rejects(
    store.putRecovery(state.runId, {
      ...receipt,
      requestDigest: "f".repeat(64),
    }),
    { code: "INVALID_CONTRACT" },
  );
  assert.deepEqual(
    await store.listRecoveries(state.runId),
    { facts: [], corrupt: [] },
  );

  await store.putRecovery(state.runId, receipt);
  const file = path.join(
    store.factDirectory(state.runId, "recoveries"),
    `${receipt.recoveryId}.json`,
  );
  await writeFile(
    file,
    `${JSON.stringify({
      ...receipt,
      requestDigest: "f".repeat(64),
    })}\n`,
  );
  await assert.rejects(
    store.readRecovery(
      state.runId,
      receipt.recoveryId,
    ),
    { code: "INVALID_CONTRACT" },
  );
  let listed = await store.listRecoveries(state.runId);
  assert.equal(listed.facts.length, 0);
  assert.equal(listed.corrupt.length, 1);

  await writeFile(file, `${JSON.stringify(receipt)}\n`);
  const wrongLocation = path.join(
    store.factDirectory(state.runId, "recoveries"),
    `recovery_${"f".repeat(64)}.json`,
  );
  await writeFile(
    wrongLocation,
    `${JSON.stringify(receipt)}\n`,
  );
  listed = await store.listRecoveries(state.runId);
  assert.equal(listed.facts.length, 1);
  assert.equal(listed.corrupt.length, 1);
});

test("terminal retention permanently protects an applied recovery receipt", async (t) => {
  const { store } = await tempStore(t);
  const state = loopState({
    runId: "run-recovery-retention",
    revision: 1,
  });
  await store.initializeRun(state);
  const receipt = legacyRecovery(state, {
    requestId: "recover-retention-1",
  });
  await store.putRecovery(state.runId, receipt);
  await store.compareAndSwapState(
    state.runId,
    state.revision,
    terminalStateForRecovery(state, receipt),
  );
  store.retention.recoveries = 0;
  const result = await store.enforceRetention(state.runId);
  assert.equal(
    result.removed.some(
      (item) => item.id === receipt.recoveryId,
    ),
    false,
  );
  assert.deepEqual(
    await store.readRecovery(
      state.runId,
      receipt.recoveryId,
    ),
    receipt,
  );
});
