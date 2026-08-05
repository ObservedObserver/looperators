import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function startServer(t, dataRoot) {
  const child = spawn(
    process.execPath,
    [path.join(pluginRoot, "mcp", "server.mjs")],
    {
      cwd: pluginRoot,
      env: { ...process.env, LOOPERATORS_DATA_DIR: dataRoot },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params = {}) => {
    const id = nextId;
    nextId += 1;
    const response = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return response;
  };
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  return { request };
}

function rootTool(name, args, turnId) {
  return {
    name,
    arguments: args,
    _meta: {
      "x-codex-turn-metadata": {
        session_id: "mcp-cooperative-root",
        turn_id: turnId,
        thread_source: "user",
      },
    },
  };
}

function subagentTool(name, args, turnId) {
  return {
    name,
    arguments: args,
    _meta: {
      "x-codex-turn-metadata": {
        session_id: "mcp-cooperative-worker",
        turn_id: turnId,
        thread_source: "subagent",
      },
    },
  };
}

test("default MCP surface is hook-free and runs the typed cooperative happy path across MCP processes", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "looperators-cooperative-mcp-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = startServer(t, root);
  const implementerServer = startServer(t, root);
  const reviewerServer = startServer(t, root);
  const initialized = await server.request("initialize", {
    protocolVersion: "2025-06-18",
  });
  await Promise.all([
    implementerServer.request("initialize", {
      protocolVersion: "2025-06-18",
    }),
    reviewerServer.request("initialize", {
      protocolVersion: "2025-06-18",
    }),
  ]);
  assert.equal(
    initialized.result.serverInfo.name,
    "looperators-agent-loop",
  );
  const listed = await server.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "looperators_preview_loop",
      "looperators_start_loop",
      "looperators_pause_loop",
      "looperators_resume_loop",
      "looperators_cancel_loop",
      "looperators_report",
      "looperators_get_loop",
      "looperators_get_snapshot",
      "looperators_open_review_surface",
      "looperators_close_review_surface",
    ],
  );
  assert.equal(
    listed.result.tools.some((tool) =>
      /hook|probe|bind_worker|render_graph|legacy/u.test(tool.name),
    ),
    false,
  );
  const getLoopTool = listed.result.tools.find(
    (tool) => tool.name === "looperators_get_loop",
  );
  assert.equal(getLoopTool.annotations.readOnlyHint, false);
  const cancelTool = listed.result.tools.find(
    (tool) => tool.name === "looperators_cancel_loop",
  );
  assert.equal(cancelTool.annotations.destructiveHint, true);

  const rejectedSubagentPreview = await implementerServer.request(
    "tools/call",
    subagentTool(
      "looperators_preview_loop",
      {
        requestId: "mcp-subagent-preview",
        goal: "Attempt a nested loop.",
        implementerInstructions: "Return done.",
        reviewerInstructions: "Return clean.",
        lapCap: 1,
      },
      "subagent-preview-turn",
    ),
  );
  assert.equal(rejectedSubagentPreview.result.isError, true);
  assert.match(
    rejectedSubagentPreview.result.content[0].text,
    /ROOT_ONLY_TOOL$/u,
  );

  const preview = await server.request(
    "tools/call",
    rootTool(
      "looperators_preview_loop",
      {
        requestId: "mcp-preview-1",
        goal: "Run one cooperative typed review.",
        implementerInstructions: "Return done.",
        reviewerInstructions: "Return clean.",
        lapCap: 2,
      },
      "preview-turn",
    ),
  );
  assert.equal(preview.result.isError, false);
  assert.equal(preview.result.structuredContent.status, "draft");
  const runId = preview.result.structuredContent.runId;

  const started = await server.request(
    "tools/call",
    rootTool(
      "looperators_start_loop",
      { runId, requestId: "mcp-start-1" },
      "confirmed-turn",
    ),
  );
  assert.equal(started.result.isError, false);
  assert.equal(
    started.result.structuredContent.roleCapability.role,
    "implementer",
  );

  const opened = await server.request(
    "tools/call",
    rootTool(
      "looperators_open_review_surface",
      { runId },
      "open-surface-turn",
    ),
  );
  assert.equal(opened.result.isError, false);
  assert.equal(opened.result.structuredContent.status, "ready");
  assert.match(
    opened.result.structuredContent.reviewUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/runs\//u,
  );
  const login = await fetch(
    opened.result.structuredContent.reviewUrl,
    { redirect: "manual" },
  );
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const reviewPageUrl = new URL(
    login.headers.get("location"),
    opened.result.structuredContent.origin,
  );
  const page = await fetch(reviewPageUrl, {
    headers: { Cookie: cookie },
  });
  assert.equal(page.status, 200);
  const pageBody = await page.text();
  assert.match(pageBody, /react-flow__node/u);
  assert.match(pageBody, /Agent Loop relationship graph/u);
  const envelope = JSON.parse(
    pageBody.match(
      /id="looperators-agent-loop-data">([^<]+)<\/script>/u,
    )[1],
  );
  assert.equal(envelope.runId, runId);
  assert.equal(envelope.mode, "sidecar");
  assert.match(envelope.controlUrl, /\/control$/u);
  assert.match(envelope.eventsUrl, /\/events$/u);
  const replayed = await fetch(
    opened.result.structuredContent.reviewUrl,
    { redirect: "manual" },
  );
  assert.equal(replayed.status, 401);
  assert.match(await replayed.text(), /Review link unavailable/u);

  const forbiddenControl = await fetch(
    new URL(envelope.controlUrl, opened.result.structuredContent.origin),
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://attacker.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "pause",
        requestId: "surface-forbidden-1",
      }),
    },
  );
  assert.equal(forbiddenControl.status, 403);
  assert.deepEqual(await forbiddenControl.json(), {
    code: "CONTROL_FORBIDDEN",
  });

  const control = async (action, requestId) => {
    const response = await fetch(
      new URL(envelope.controlUrl, opened.result.structuredContent.origin),
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: opened.result.structuredContent.origin,
          "Content-Type": "application/json",
          "X-Looperators-CSRF": envelope.csrfToken,
        },
        body: JSON.stringify({ action, requestId }),
      },
    );
    return { response, value: await response.json() };
  };
  const paused = await control("pause", "surface-pause-1");
  assert.equal(paused.response.status, 200);
  assert.equal(paused.value.status, "paused");
  const resumed = await control("resume", "surface-resume-1");
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.value.status, "running");

  const implemented = await implementerServer.request("tools/call", {
    name: "looperators_report",
    arguments: {
      runId,
      requestId: "mcp-implementer-report",
      role: "implementer",
      capabilityToken:
        started.result.structuredContent.roleCapability.capabilityToken,
      type: "info",
      status: "done",
    },
  });
  assert.equal(implemented.result.isError, false);

  const current = await server.request(
    "tools/call",
    rootTool(
      "looperators_get_loop",
      { runId },
      "governor-read",
    ),
  );
  assert.equal(
    current.result.structuredContent.roleCapability.role,
    "reviewer",
  );
  const reviewed = await reviewerServer.request("tools/call", {
    name: "looperators_report",
    arguments: {
      runId,
      requestId: "mcp-reviewer-report",
      role: "reviewer",
      capabilityToken:
        current.result.structuredContent.roleCapability.capabilityToken,
      type: "verdict",
      verdict: "clean",
      issues: [],
    },
  });
  assert.equal(reviewed.result.isError, false);
  assert.equal(reviewed.result.structuredContent.status, "succeeded");

  const closed = await server.request(
    "tools/call",
    rootTool(
      "looperators_close_review_surface",
      { runId },
      "close-surface-turn",
    ),
  );
  assert.equal(closed.result.isError, false);
  assert.equal(closed.result.structuredContent.status, "closed");
  await assert.rejects(fetch(reviewPageUrl));

  const hidden = await server.request("tools/call", {
    name: "looperators_render_graph",
    arguments: {},
  });
  assert.equal(hidden.error.code, -32601);
});

test("a new Governor MCP process rotates the pending action token", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "looperators-cooperative-restart-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalRoot = startServer(t, root);
  const restartedRoot = startServer(t, root);
  const worker = startServer(t, root);
  await Promise.all(
    [originalRoot, restartedRoot, worker].map((server) =>
      server.request("initialize", {
        protocolVersion: "2025-06-18",
      }),
    ),
  );

  const preview = await originalRoot.request(
    "tools/call",
    rootTool(
      "looperators_preview_loop",
      {
        requestId: "restart-preview",
        goal: "Verify cross-process restart rotation.",
        implementerInstructions: "Return done.",
        reviewerInstructions: "Return clean.",
        lapCap: 2,
      },
      "restart-preview-turn",
    ),
  );
  const runId = preview.result.structuredContent.runId;
  const started = await originalRoot.request(
    "tools/call",
    rootTool(
      "looperators_start_loop",
      { runId, requestId: "restart-start" },
      "restart-start-turn",
    ),
  );
  const oldToken =
    started.result.structuredContent.roleCapability.capabilityToken;

  const recovered = await restartedRoot.request(
    "tools/call",
    rootTool(
      "looperators_get_loop",
      { runId },
      "restart-recovery-turn",
    ),
  );
  const newToken =
    recovered.result.structuredContent.roleCapability.capabilityToken;
  assert.notEqual(newToken, oldToken);

  const stale = await worker.request("tools/call", {
    name: "looperators_report",
    arguments: {
      runId,
      requestId: "restart-stale-report",
      role: "implementer",
      capabilityToken: oldToken,
      type: "info",
      status: "done",
    },
  });
  assert.equal(stale.result.isError, true);
  assert.match(
    stale.result.content[0].text,
    /CAPABILITY_REJECTED$/u,
  );

  const accepted = await worker.request("tools/call", {
    name: "looperators_report",
    arguments: {
      runId,
      requestId: "restart-current-report",
      role: "implementer",
      capabilityToken: newToken,
      type: "info",
      status: "done",
    },
  });
  assert.equal(accepted.result.isError, false);
  assert.equal(accepted.result.structuredContent.revision, 2);

  const cancelled = await restartedRoot.request(
    "tools/call",
    rootTool(
      "looperators_cancel_loop",
      { runId, requestId: "restart-cancel" },
      "restart-cancel-turn",
    ),
  );
  assert.equal(cancelled.result.structuredContent.status, "cancelled");
});
