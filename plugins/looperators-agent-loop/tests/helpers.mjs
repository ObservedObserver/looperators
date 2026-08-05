import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { LoopStore } from "../lib/store.mjs";

export const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function tempStore(t, options = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "looperators-agent-loop-p1a-test-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const rootInfo = await resolveDataRoot({
    env: { LOOPERATORS_DATA_DIR: root },
  });
  return {
    root,
    rootInfo,
    store: new LoopStore(rootInfo, options.retention),
  };
}

export function loopState(overrides = {}) {
  const timestamp = "2026-07-26T00:00:00.000Z";
  return {
    schemaVersion: 1,
    runId: "run-p1a",
    rootSessionId: "session-root",
    originatingTurnId: "turn-root",
    scope: { kind: "task" },
    masterNode: "session-root",
    recipe: "review-until-clean",
    status: "running",
    currentLap: 0,
    continuationLease: { granted: 3, consumed: 0 },
    cancelRequested: false,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export async function spawnNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? PLUGIN_ROOT,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }
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
