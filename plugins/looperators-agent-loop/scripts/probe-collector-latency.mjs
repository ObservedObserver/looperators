#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";
import { LoopStore } from "../lib/store.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function numberArgument(name, fallback) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`--${name} must be an integer between 1 and 1000`);
  }
  return value;
}

async function invokeHook(hook, env, index) {
  const started = performance.now();
  const child = spawn(process.execPath, [hook], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(
    JSON.stringify({
      session_id: "collector-latency-session",
      turn_id: `collector-latency-turn-${index}`,
      hook_event_name: "UserPromptSubmit",
      prompt: "redacted-by-contract",
    }),
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return {
    durationMs: performance.now() - started,
    exitCode,
    stdoutBytes: Buffer.concat(stdout).length,
    stderrBytes: Buffer.concat(stderr).length,
  };
}

function percentile(sorted, quantile) {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index];
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

const output = argument("output");
if (!output || !path.isAbsolute(output)) {
  throw new Error("--output must be an absolute path");
}
const samples = numberArgument("samples", 30);
const warmupSamples = numberArgument("warmup-samples", 3);
const targetP95Ms = numberArgument("target-p95-ms", 50);
const dataRoot = await mkdtemp(
  path.join(os.tmpdir(), "looperators-p1a-collector-latency-"),
);
try {
  const pluginRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const hook = path.join(pluginRoot, "hooks", "collect-event.mjs");
  const runId = "run-collector-latency";
  const sessionId = "collector-latency-session";
  const env = {
    ...process.env,
    LOOPERATORS_DATA_DIR: dataRoot,
    LOOPERATORS_RUN_ID: runId,
  };
  const rootInfo = await resolveDataRoot({ env });
  const store = new LoopStore(rootInfo);
  const timestamp = new Date().toISOString();
  await store.initializeRun({
    schemaVersion: 1,
    runId,
    rootSessionId: sessionId,
    originatingTurnId: "collector-latency-origin",
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
  const observations = [];
  for (
    let index = 0;
    index < warmupSamples + samples;
    index += 1
  ) {
    observations.push(await invokeHook(hook, env, index));
  }
  const measured = observations.slice(warmupSamples);
  const durations = measured
    .map((observation) => observation.durationMs)
    .sort((left, right) => left - right);
  const processesPassed = observations.every(
    (observation) =>
      observation.exitCode === 0 &&
      observation.stdoutBytes === 0 &&
      observation.stderrBytes === 0,
  );
  const result = {
    schemaVersion: 1,
    samples,
    warmupSamples,
    minMs: rounded(durations[0]),
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(percentile(durations, 0.95)),
    maxMs: rounded(durations.at(-1)),
    includesProcessStartup: true,
    targetP95Ms,
    processesPassed,
  };
  result.passed =
    processesPassed && result.p95Ms < result.targetP95Ms;
  await atomicReplaceJson(output, result);
  process.stdout.write(`${JSON.stringify({ ...result, output })}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
