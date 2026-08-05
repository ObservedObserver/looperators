#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digestJson } from "../lib/canonical-json.mjs";
import { assertSafeFileId } from "../lib/contracts.mjs";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { atomicReplaceJson, readJsonFile } from "../lib/fs-utils.mjs";
import { LoopStore } from "../lib/store.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function runHook(hookPath, env, input) {
  const child = spawn(process.execPath, [hookPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(input));
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function callMcp(serverPath, env, probeId) {
  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buffer = "";
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 5_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "looperators-p1a-shared-root-probe", version: "1" },
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })}\n`,
  );
  const result = await request(2, "tools/call", {
    name: "looperators_shared_root_probe",
    arguments: { probeId },
  });
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return {
    exitCode,
    response: result,
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

const outputValue = argument("output");
if (!outputValue || !path.isAbsolute(outputValue)) {
  throw new Error("--output must be an absolute path");
}
const probeId = argument("probe-id", `shared-${randomUUID()}`);
assertSafeFileId(probeId, "probeId");
const requestedDataRoot = argument("data-root");
const dataRoot =
  requestedDataRoot ??
  (await mkdtemp(path.join(os.tmpdir(), "looperators-p1a-shared-root-")));
if (!path.isAbsolute(dataRoot)) {
  throw new Error("--data-root must be absolute");
}
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const hookPath = path.join(pluginRoot, "hooks", "collect-event.mjs");
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");
const sessionId = "p1a-shared-root-session";
const runId = "run-shared-root-probe";
const env = {
  ...process.env,
  LOOPERATORS_DATA_DIR: dataRoot,
  PLUGIN_DATA: dataRoot,
  LOOPERATORS_SHARED_ROOT_PROBE_ID: probeId,
  LOOPERATORS_RUN_ID: runId,
};
const timestamp = new Date().toISOString();
const rootInfo = await resolveDataRoot({ env });
const store = new LoopStore(rootInfo);
await store.initializeRun({
  schemaVersion: 1,
  runId,
  rootSessionId: sessionId,
  originatingTurnId: "p1a-shared-root-turn",
  scope: { kind: "task" },
  masterNode: sessionId,
  recipe: "review-until-clean",
  status: "running",
  currentLap: 0,
  continuationLease: { granted: 0, consumed: 0 },
  cancelRequested: false,
  revision: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const hook = await runHook(hookPath, env, {
  session_id: sessionId,
  turn_id: "p1a-shared-root-turn",
  hook_event_name: "SessionStart",
  source: "startup",
});
const mcp = await callMcp(serverPath, env, probeId);
const hookMarker = await readJsonFile(
  path.join(dataRoot, "probes", "shared-root", `${probeId}-hook.json`),
);
const mcpMarker = await readJsonFile(
  path.join(dataRoot, "probes", "shared-root", `${probeId}-mcp.json`),
);
const result = {
  schemaVersion: 1,
  probeId,
  dataRootDigest: digestJson({ dataRoot }),
  hook: {
    exitCode: hook.exitCode,
    stdoutEmpty: hook.stdout.length === 0,
    stderrEmpty: hook.stderr.length === 0,
    marker: hookMarker,
  },
  mcp: {
    exitCode: mcp.exitCode,
    error: mcp.response.error ?? null,
    structuredContent: mcp.response.result?.structuredContent ?? null,
    stderrEmpty: mcp.stderr.length === 0,
    marker: mcpMarker,
  },
  sameInstance:
    hookMarker.instanceIdDigest === mcpMarker.instanceIdDigest,
  passed:
    hook.exitCode === 0 &&
    mcp.exitCode === 0 &&
    !mcp.response.error &&
    hookMarker.instanceIdDigest === mcpMarker.instanceIdDigest,
};
await atomicReplaceJson(outputValue, result);
process.stdout.write(
  `${JSON.stringify({
    output: outputValue,
    probeId,
    sameInstance: result.sameInstance,
    passed: result.passed,
  })}\n`,
);
if (!result.passed) {
  process.exitCode = 1;
}
if (!requestedDataRoot) {
  await rm(dataRoot, { recursive: true, force: true });
}
