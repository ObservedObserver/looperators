import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  canonicalJson,
  digestJson,
} from "../lib/canonical-json.mjs";
import {
  normalizeHookEvent,
  validateGraphProjection,
} from "../lib/contracts.mjs";
import { LoopController } from "../lib/control.mjs";
import { renderSidecarDocument } from "../lib/graph-view.mjs";
import {
  buildAgentLoopProjection,
  canonicalProjectionBytes,
} from "../lib/projection.mjs";
import { startSidecar } from "../scripts/sidecar-server.mjs";
import {
  loopState,
  tempStore,
} from "./helpers.mjs";

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    definitionId: `definition_${"a".repeat(64)}`,
    runId: "run-projection",
    requestId: "projection-preview",
    requestDigest: "b".repeat(64),
    recipe: "review-until-clean",
    goal: "Synthetic projection goal.",
    implementerInstructions: "Implement.",
    reviewerInstructions: "Review.",
    lapCap: 3,
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function projectionState(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-projection",
    rootSessionId: "session-projection",
    originatingTurnId: "turn-projection",
    scope: { kind: "task" },
    masterNode: "session-projection",
    recipe: "review-until-clean",
    status: "draft",
    currentLap: 0,
    continuationLease: { granted: 3, consumed: 0 },
    cancelRequested: false,
    revision: 0,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function hookEvent(overrides = {}) {
  return normalizeHookEvent(
    {
      session_id: "session-projection",
      turn_id: "turn-projection",
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-projection",
      tool_name: "collaborationspawn_agent",
      tool_input: { task_name: "redacted" },
      ...overrides,
    },
    {
      observedAt:
        overrides.observedAt ??
        "2026-07-26T00:00:01.000Z",
    },
  );
}

function draftProjection(options = {}) {
  return buildAgentLoopProjection({
    state: projectionState(options.state),
    definition: definition(options.definition),
    bindings: options.bindings ?? [],
    events: options.events ?? [],
    reports: options.reports ?? [],
    transitions: options.transitions ?? [],
    operations: options.operations ?? [],
    governorDecisions: options.governorDecisions ?? [],
    recoveries: options.recoveries ?? [],
    diagnostics: options.diagnostics ?? [],
  });
}

function request({
  port,
  pathname,
  method = "GET",
  headers = {},
}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function openEventStream({ port, cookie, pathname, headers = {} }) {
  return new Promise((resolve, reject) => {
    const state = {
      text: "",
      waiters: new Set(),
    };
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        headers: {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
          ...headers,
        },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          state.text += chunk;
          for (const waiter of [...state.waiters]) {
            if (waiter.predicate(state.text)) {
              state.waiters.delete(waiter);
              clearTimeout(waiter.timer);
              waiter.resolve(state.text);
            }
          }
        });
        resolve({
          response,
          outgoing,
          text: () => state.text,
          waitFor(predicate, timeoutMs = 2_000) {
            if (predicate(state.text)) {
              return Promise.resolve(state.text);
            }
            return new Promise((waitResolve, waitReject) => {
              const waiter = {
                predicate,
                resolve: waitResolve,
                timer: setTimeout(() => {
                  state.waiters.delete(waiter);
                  waitReject(
                    new Error(
                      `timed out waiting for SSE: ${state.text}`,
                    ),
                  );
                }, timeoutMs),
              };
              state.waiters.add(waiter);
            });
          },
          close() {
            response.destroy();
            outgoing.destroy();
          },
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("graph-projection-v3 is deterministic, bounded, and role-stable", () => {
  const eventA = hookEvent();
  const eventB = hookEvent({
    tool_name: "collaboration.spawn_agent",
  });
  const left = draftProjection({
    events: [eventA, eventB],
  });
  const right = draftProjection({
    events: [eventB, eventA],
  });
  assert.equal(left.projectionVersion, 3);
  assert.equal(left.integrity.status, "verified");
  assert.deepEqual(
    left.nodes.map((node) => node.id),
    ["root", "role:implementer", "role:reviewer"],
  );
  assert.equal(left.edges.length, 4);
  assert.equal(left.counts.events, 1);
  assert.equal(left.counts.conflicts, 1);
  assert.equal(left.eventWatermark.eventCount, 2);
  assert.equal(
    left.projectionDigest,
    right.projectionDigest,
  );
  assert.equal(
    canonicalProjectionBytes(left),
    canonicalProjectionBytes(right),
  );
  assert.equal(
    left.eventWatermark.lastEventId,
    [eventA.eventId, eventB.eventId].sort().at(-1),
  );
  assert.notEqual(
    left.projectionDigest,
    draftProjection({ events: [eventA] })
      .projectionDigest,
  );
  assert.deepEqual(validateGraphProjection(left), []);
  assert.ok(
    validateGraphProjection({
      ...left,
      nodes: [{ ...left.nodes[0], id: "agent-native" }],
    }).length > 0,
  );
});

test("graph-projection-v3 renders one bounded recovery receipt without native targets", () => {
  const recoveryId = `recovery_${"d".repeat(64)}`;
  const projection = draftProjection({
    state: {
      status: "failed",
      revision: 1,
      needsHuman: true,
      latestRecoveryId: recoveryId,
      updatedAt: "2026-07-26T00:00:02.000Z",
    },
    recoveries: [
      {
        recoveryId,
        toRevision: 1,
        createdAt: "2026-07-26T00:00:02.000Z",
      },
    ],
  });
  assert.equal(projection.counts.recoveries, 1);
  assert.deepEqual(projection.recovery, {
    recoveryId,
    reason: "legacy-history-quarantined",
  });
  assert.equal(
    projection.timeline.at(-1).kind,
    "recovery",
  );
  assert.equal(
    projection.nodes.every(
      (node) => node.state === "terminal",
    ),
    true,
  );
  assert.deepEqual(validateGraphProjection(projection), []);
});

test("projection size stays O(roles) across long receipt histories", () => {
  const bindings = [
    {
      method: "capability-token-v1",
      rootSessionId: "session-projection",
      role: "implementer",
      agentId: "native-implementer",
    },
    {
      method: "capability-token-v1",
      rootSessionId: "session-projection",
      role: "reviewer",
      agentId: "native-reviewer",
    },
  ];
  const operations = [];
  const transitions = [];
  const reports = [];
  for (let revision = 0; revision < 100; revision += 1) {
    const implementer = revision % 2 === 0;
    const transitionId = `transition-${revision}`;
    const reportId =
      revision === 0 ? undefined : `report-${revision}`;
    operations.push({
      operationId: `operation-${revision}`,
      transitionId,
      ...(reportId ? { reportId } : {}),
      toRevision: revision + 1,
    });
    transitions.push({
      transitionId,
      kind: implementer
        ? "activate-implementer"
        : "activate-reviewer",
      lap: Math.floor(revision / 2),
      createdAt: new Date(
        Date.UTC(2026, 6, 26, 0, 0, revision),
      ).toISOString(),
    });
    if (reportId) {
      reports.push({
        reportId,
        fromNode: implementer
          ? "native-reviewer"
          : "native-implementer",
        type: implementer ? "verdict" : "info",
        ...(implementer
          ? {
              verdict: "issues",
              issues: [{ message: "Synthetic issue." }],
            }
          : { status: "done" }),
        createdAt: new Date(
          Date.UTC(2026, 6, 26, 0, 0, revision),
        ).toISOString(),
      });
    }
  }
  const projection = draftProjection({
    state: {
      status: "running",
      revision: 100,
      currentLap: 6,
      pendingTransitionId: "transition-99",
      latestReportId: "report-99",
      updatedAt: "2026-07-26T00:01:40.000Z",
    },
    definition: { lapCap: 6 },
    bindings,
    operations,
    transitions,
    reports,
  });
  assert.equal(projection.nodes.length, 3);
  assert.equal(projection.edges.length, 4);
  assert.equal(projection.timeline.length, 32);
  assert.equal(projection.counts.operations, 100);
  assert.equal(projection.counts.reports, 99);
  assert.ok(
    Buffer.byteLength(
      canonicalProjectionBytes(projection),
      "utf8",
    ) < 64 * 1024,
  );
});

test("sidecar enforces one-time auth, exact loopback headers, and live canonical SSE", async (t) => {
  const { store } = await tempStore(t);
  await store.initializeRun(
    loopState({
      runId: "run-projection",
      status: "draft",
    }),
  );
  let current = draftProjection();
  let busy = false;
  const controller = {
    async snapshotForRun() {
      if (busy) {
        const error = new Error("busy");
        error.code = "SNAPSHOT_BUSY";
        throw error;
      }
      return current;
    },
  };
  const token = "t".repeat(32);
  let sidecar;
  try {
    sidecar = await startSidecar({
      runId: "run-projection",
      host: "127.0.0.1",
      port: 0,
      token,
      store,
      controller,
      heartbeatMs: 500,
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox does not permit a loopback listener");
      return;
    }
    throw error;
  }
  t.after(() => sidecar.close());
  assert.equal(sidecar.host, "127.0.0.1");
  assert.match(
    sidecar.loginUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/runs\/run-projection\?ticket=/u,
  );

  const unauthorized = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}/snapshot`,
  });
  assert.equal(unauthorized.status, 401);
  const badHost = await request({
    port: sidecar.port,
    pathname: "/",
    headers: { Host: `localhost:${sidecar.port}` },
  });
  assert.equal(badHost.status, 421);
  const login = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}?ticket=${encodeURIComponent(token)}`,
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, sidecar.basePath);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  assert.match(cookie, /^looperators_loop_[a-f0-9]{12}=/u);
  assert.notEqual(cookie.split("=")[1], token);
  assert.match(
    login.headers["set-cookie"][0],
    new RegExp(
      `HttpOnly; SameSite=Strict; Path=${sidecar.basePath}`,
      "u",
    ),
  );
  const replay = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}?ticket=${encodeURIComponent(token)}`,
  });
  assert.equal(replay.status, 401);

  const snapshot = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}/snapshot`,
    headers: { Cookie: cookie },
  });
  assert.equal(snapshot.status, 200);
  assert.equal(
    snapshot.body,
    `${canonicalProjectionBytes(current)}\n`,
  );
  assert.equal(
    snapshot.headers["cache-control"],
    "no-store",
  );
  assert.equal(
    snapshot.headers["x-content-type-options"],
    "nosniff",
  );
  const page = await request({
    port: sidecar.port,
    pathname: sidecar.basePath,
    headers: { Cookie: cookie },
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /<!doctype html>/iu);
  assert.match(page.body, /new EventSource/u);
  assert.match(page.body, new RegExp(`${sidecar.basePath}/events`, "u"));
  assert.match(page.body, /react-flow__node/u);
  assert.match(
    page.headers["content-security-policy"],
    /frame-ancestors 'none'/u,
  );
  const mutation = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}/control`,
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(mutation.status, 503);
  const absentMutationRoute = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}/missing`,
    headers: { Cookie: cookie },
  });
  assert.equal(absentMutationRoute.status, 404);
  const badOrigin = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}/events`,
    headers: {
      Cookie: cookie,
      Origin: "http://attacker.invalid",
    },
  });
  assert.equal(badOrigin.status, 403);

  const stream = await openEventStream({
    port: sidecar.port,
    cookie,
    pathname: `${sidecar.basePath}/events`,
  });
  t.after(() => stream.close());
  await stream.waitFor((text) =>
    text.includes(`id: ${current.projectionDigest}`),
  );
  assert.match(stream.text(), /event: snapshot/u);
  const originalDigest = current.projectionDigest;
  current = draftProjection({ events: [hookEvent()] });
  await sidecar.refresh();
  await stream.waitFor(
    (text) =>
      text.includes(`id: ${current.projectionDigest}`) &&
      text.match(/event: snapshot/gu)?.length >= 2,
  );
  assert.notEqual(current.projectionDigest, originalDigest);
  assert.equal(
    canonicalJson(sidecar.projection()),
    canonicalJson(current),
  );
  const beforeUnchanged = sidecar.stats().unchanged;
  await sidecar.refresh();
  assert.equal(
    sidecar.stats().unchanged,
    beforeUnchanged + 1,
  );
  busy = true;
  const beforeBusy = sidecar.stats().busySkips;
  await sidecar.refresh();
  busy = false;
  assert.equal(
    sidecar.stats().busySkips,
    beforeBusy + 1,
  );

  const extraStreams = [];
  for (let index = 0; index < 7; index += 1) {
    const extra = await openEventStream({
      port: sidecar.port,
      cookie,
      pathname: `${sidecar.basePath}/events`,
    });
    extraStreams.push(extra);
    await extra.waitFor((text) =>
      text.includes("event: snapshot"),
    );
  }
  const overCapacity = await request({
    port: sidecar.port,
    pathname: `${sidecar.basePath}/events`,
    headers: {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${sidecar.port}`,
    },
  });
  assert.equal(overCapacity.status, 503);
  for (const extra of extraStreams) {
    extra.close();
  }
  for (
    let attempt = 0;
    attempt < 100 && sidecar.stats().clients !== 1;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sidecar.stats().clients, 1);

  const resumed = await openEventStream({
    port: sidecar.port,
    cookie,
    pathname: `${sidecar.basePath}/events`,
    headers: {
      "Last-Event-ID": current.projectionDigest,
    },
  });
  t.after(() => resumed.close());
  await resumed.waitFor((text) => text.includes(": current"));
  assert.doesNotMatch(resumed.text(), /event: snapshot/u);
  const closedPort = sidecar.port;
  await sidecar.close();
  await assert.rejects(
    request({
      port: closedPort,
      pathname: sidecar.basePath,
    }),
    (error) =>
      ["ECONNREFUSED", "ECONNRESET"].includes(error?.code),
  );

  const randomSidecar = await startSidecar({
    runId: "run-projection",
    host: "127.0.0.1",
    port: 0,
    store,
    controller,
  });
  assert.ok(
    Buffer.byteLength(
      randomSidecar.loginToken,
      "utf8",
    ) >= 32,
  );
  assert.match(
    randomSidecar.loginUrl,
    new RegExp(
      encodeURIComponent(randomSidecar.loginToken),
      "u",
    ),
  );
  await randomSidecar.close();
});

test("sidecar watches the real run directory and refreshes through authoritative replay", async (t) => {
  const { store } = await tempStore(t);
  const controller = new LoopController(store, {
    now: (() => {
      let second = 0;
      return () => {
        const value = new Date(
          Date.UTC(2026, 6, 26, 23, 30, second),
        ).toISOString();
        second += 1;
        return value;
      };
    })(),
  });
  const context = {
    rootSessionId: "sidecar-real-root",
    turnId: "sidecar-real-turn",
    threadSource: "user",
  };
  const preview = await controller.preview(context, {
    requestId: "sidecar-real-preview",
    goal: "Verify the real sidecar watcher.",
    implementerInstructions: "Return done.",
    reviewerInstructions: "Return a verdict.",
    lapCap: 2,
  });
  const startContext = {
    ...context,
    turnId: "sidecar-real-confirmed-turn",
  };
  await controller.start(startContext, {
    runId: preview.runId,
    requestId: "sidecar-real-start",
  });
  let sidecar;
  try {
    sidecar = await startSidecar({
      runId: preview.runId,
      host: "127.0.0.1",
      port: 0,
      token: "w".repeat(32),
      store,
      controller,
      heartbeatMs: 500,
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox does not permit a loopback listener");
      return;
    }
    throw error;
  }
  t.after(() => sidecar.close());
  const login = await request({
    port: sidecar.port,
    pathname:
      `${sidecar.basePath}?ticket=${"w".repeat(32)}`,
  });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const stream = await openEventStream({
    port: sidecar.port,
    cookie,
    pathname: `${sidecar.basePath}/events`,
  });
  t.after(() => stream.close());
  const initialDigest = sidecar.projection().projectionDigest;
  await stream.waitFor((text) =>
    text.includes(`id: ${initialDigest}`),
  );
  const observed = normalizeHookEvent(
    {
      session_id: context.rootSessionId,
      turn_id: context.turnId,
      hook_event_name: "PreToolUse",
      tool_use_id: "sidecar-real-tool",
      tool_name: "functions.exec",
      tool_input: { command: "redacted" },
    },
    {
      observedAt: "2026-07-26T23:31:00.000Z",
    },
  );
  await store.putEvent(preview.runId, observed);
  await stream.waitFor(
    (text) =>
      text.match(/event: snapshot/gu)?.length >= 2,
    3_000,
  );
  const refreshed = sidecar.projection();
  assert.notEqual(
    refreshed.projectionDigest,
    initialDigest,
  );
  const eventIds = (
    await store.listEvents(preview.runId)
  ).facts.map((event) => event.eventId);
  assert.equal(refreshed.eventWatermark.eventCount, 1);
  assert.equal(
    refreshed.eventWatermark.lastEventId,
    eventIds.sort().at(-1),
  );
  assert.equal(
    refreshed.projectionDigest,
    (
      await controller.snapshotForRun(preview.runId)
    ).projectionDigest,
  );
  await sidecar.close();
});

test("sidecar and view reject unsafe configuration without binding", async () => {
  await assert.rejects(
    startSidecar({
      runId: "run-projection",
      host: "0.0.0.0",
      port: 0,
    }),
    { code: "SIDECAR_HOST_REJECTED" },
  );
  await assert.rejects(
    startSidecar({
      runId: "run-projection",
      host: "127.0.0.1",
      port: 0,
      token: "short",
    }),
    { code: "SIDECAR_TOKEN_REJECTED" },
  );
  const projection = draftProjection();
  const sidecar = renderSidecarDocument(projection, {
    eventsUrl: "/runs/run-projection/events",
  });
  assert.match(sidecar, /new EventSource/u);
  assert.match(sidecar, /\/runs\/run-projection\/events/u);
  assert.equal(
    digestJson(
      JSON.parse(canonicalProjectionBytes(projection)),
    ),
    digestJson(projection),
  );
});
