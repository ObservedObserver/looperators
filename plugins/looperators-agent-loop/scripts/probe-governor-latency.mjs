#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { LoopController } from "../lib/control.mjs";
import {
  HOOK_COLLECTOR_PROTOCOL,
  normalizeHookEvent,
} from "../lib/contracts.mjs";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";
import { currentHookDefinitionDigest } from "../lib/hook-readiness.mjs";
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

async function putHookReadiness(store, runId, context) {
  const state = await store.readState(runId);
  await store.putEvent(
    runId,
    normalizeHookEvent(
      {
        session_id: context.rootSessionId,
        turn_id: context.turnId,
        hook_event_name: "UserPromptSubmit",
      },
      {
        observedAt: new Date(
          Date.parse(state.createdAt) + 1,
        ).toISOString(),
        hookCollectorProtocol: HOOK_COLLECTOR_PROTOCOL,
        hookDefinitionDigest:
          await currentHookDefinitionDigest(),
      },
    ),
  );
}

async function invokeHook(
  hook,
  env,
  rootSessionId = "governor-latency-session",
) {
  const started = performance.now();
  const child = spawn(process.execPath, [hook], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(
    JSON.stringify({
      session_id: rootSessionId,
      turn_id: "governor-latency-turn",
      hook_event_name: "Stop",
      stop_hook_active: false,
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
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  let output = null;
  try {
    output = stdoutText ? JSON.parse(stdoutText) : null;
  } catch {
    output = { invalidJson: true };
  }
  return {
    durationMs: performance.now() - started,
    exitCode,
    stderrBytes: Buffer.concat(stderr).length,
    outputKind:
      output?.decision === "block"
        ? "block"
        : output?.continue === true
          ? "allow"
          : "invalid",
    recoveryFailOpen:
      output?.continue === true &&
      /RECOVERY_REQUIRED/.test(output?.systemMessage ?? ""),
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
const errorPathSamples = numberArgument(
  "error-path-samples",
  10,
);
const targetP95Ms = numberArgument("target-p95-ms", 100);
const dataRoot = await mkdtemp(
  path.join(os.tmpdir(), "looperators-p1c-governor-latency-"),
);

try {
  const pluginRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const hook = path.join(pluginRoot, "hooks", "collect-event.mjs");
  const rootInfo = await resolveDataRoot({
    env: { LOOPERATORS_DATA_DIR: dataRoot },
  });
  const store = new LoopStore(rootInfo);
  const context = {
    rootSessionId: "governor-latency-session",
    turnId: "governor-latency-turn",
    threadSource: "user",
  };
  const controller = new LoopController(store);
  const preview = await controller.preview(context, {
    requestId: "governor-latency-preview",
    goal: "Measure bounded governor hook latency.",
    implementerInstructions: "Return a typed done report.",
    reviewerInstructions: "Return a typed verdict.",
    lapCap: 1,
  });
  const { runId } = preview;
  const startContext = {
    ...context,
    turnId: "governor-latency-confirmed-turn",
  };
  await putHookReadiness(store, runId, startContext);
  await controller.start(startContext, {
    runId,
    requestId: "governor-latency-start",
  });
  const env = {
    ...process.env,
    LOOPERATORS_DATA_DIR: dataRoot,
    LOOPERATORS_RUN_ID: runId,
  };
  const observations = [];
  for (
    let index = 0;
    index < warmupSamples + samples;
    index += 1
  ) {
    observations.push(await invokeHook(hook, env));
  }
  const measured = observations.slice(warmupSamples);
  const durations = measured
    .map((observation) => observation.durationMs)
    .sort((left, right) => left - right);
  const blocks = observations.filter(
    (observation) => observation.outputKind === "block",
  ).length;
  const invalidOutputs = observations.filter(
    (observation) => observation.outputKind === "invalid",
  ).length;
  const processesPassed = observations.every(
    (observation) =>
      observation.exitCode === 0 && observation.stderrBytes === 0,
  );
  const state = await store.readState(runId);
  const decisions = await store.listGovernorDecisions(runId);
  const errorContext = {
    rootSessionId: "governor-error-latency-session",
    turnId: "governor-error-latency-turn",
    threadSource: "user",
  };
  const errorPreview = await controller.preview(
    errorContext,
    {
      requestId: "governor-error-latency-preview",
      goal: "Measure fail-open governor hook latency.",
      implementerInstructions: "Return a typed done report.",
      reviewerInstructions: "Return a typed verdict.",
      lapCap: 1,
    },
  );
  const errorStartContext = {
    ...errorContext,
    turnId: "governor-error-latency-confirmed-turn",
  };
  await putHookReadiness(
    store,
    errorPreview.runId,
    errorStartContext,
  );
  await controller.start(errorStartContext, {
    runId: errorPreview.runId,
    requestId: "governor-error-latency-start",
  });
  const errorState = await store.readState(
    errorPreview.runId,
  );
  await unlink(
    path.join(
      store.factDirectory(
        errorPreview.runId,
        "operations",
      ),
      `${errorState.latestOperationId}.json`,
    ),
  );
  const errorEnv = {
    ...process.env,
    LOOPERATORS_DATA_DIR: dataRoot,
    LOOPERATORS_RUN_ID: errorPreview.runId,
  };
  const errorObservations = [];
  for (let index = 0; index < errorPathSamples; index += 1) {
    errorObservations.push(
      await invokeHook(
        hook,
        errorEnv,
        errorContext.rootSessionId,
      ),
    );
  }
  const errorDurations = errorObservations
    .map((observation) => observation.durationMs)
    .sort((left, right) => left - right);
  const errorStateAfter = await store.readState(
    errorPreview.runId,
  );
  const errorDecisions =
    await store.listGovernorDecisions(errorPreview.runId);
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
    blocks,
    invalidOutputs,
    processesPassed,
    leaseConsumed: state.continuationLease.consumed,
    decisionFacts: decisions.facts.length,
    corruptDecisionFacts: decisions.corrupt.length,
    errorPathSamples,
    errorPathP50Ms: rounded(
      percentile(errorDurations, 0.5),
    ),
    errorPathP95Ms: rounded(
      percentile(errorDurations, 0.95),
    ),
    errorPathMaxMs: rounded(errorDurations.at(-1)),
    errorPathPassed:
      errorObservations.every(
        (observation) =>
          observation.exitCode === 0 &&
          observation.stderrBytes === 0 &&
          observation.outputKind === "allow" &&
          observation.recoveryFailOpen,
      ) &&
      errorStateAfter.revision === 1 &&
      errorStateAfter.continuationLease.consumed === 0 &&
      errorDecisions.facts.length === 0 &&
      errorDecisions.corrupt.length === 0,
  };
  result.passed =
    processesPassed &&
    result.p95Ms < result.targetP95Ms &&
    blocks === 1 &&
    invalidOutputs === 0 &&
    result.leaseConsumed === 1 &&
    result.decisionFacts === 1 &&
    result.corruptDecisionFacts === 0 &&
    result.errorPathP95Ms < result.targetP95Ms &&
    result.errorPathPassed;
  await atomicReplaceJson(output, result);
  process.stdout.write(`${JSON.stringify({ ...result, output })}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
