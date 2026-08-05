#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  atomicWriteJson,
  deliveryEventKey,
  redactHookInput,
  semanticEventKey,
  sha256,
  stableJson,
} from "../lib/event-utils.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function continuationOutput(input, stateCreated) {
  if (!["Stop", "SubagentStop"].includes(input.hook_event_name)) {
    return null;
  }
  if (process.env.LOOPERATORS_P0_CONTINUATION_MODE !== "lap") {
    return null;
  }
  if (input.stop_hook_active === true || !stateCreated) {
    return { continue: true };
  }
  const scope =
    input.hook_event_name === "SubagentStop"
      ? `subagent ${input.agent_id ?? "unknown"}`
      : "root agent";
  return {
    decision: "block",
    reason:
      `looperators P0 continuation lap 1/1 for ${scope}. ` +
      "Acknowledge the continuation with the exact marker P0_LAP_CONTINUED, " +
      "do not call tools, and then stop. The next Stop hook invocation must be allowed.",
  };
}

async function main() {
  const startedWall = new Date().toISOString();
  const startedMonotonicNs = process.hrtime.bigint();
  const lane = argument("lane", "primary");
  const delayMs = Number(argument("delay-ms", "0"));
  const artifactDir =
    process.env.LOOPERATORS_P0_ARTIFACT_DIR ??
    path.join(process.cwd(), "output", "looperators-agent-loop-p0");
  const rawText = await readStdin();
  let input;
  try {
    input = JSON.parse(rawText);
  } catch {
    input = {
      hook_event_name: "ParseError",
      malformed_input: {
        sha256: sha256(rawText),
        bytes: Buffer.byteLength(rawText),
      },
    };
  }

  const redactedInput = redactHookInput(input);
  const semanticKey = semanticEventKey(input);
  const deliveryKey = deliveryEventKey(input, lane);
  const identityHash = sha256(
    stableJson({
      deliveryKey,
      redactedInput,
    }),
  );
  const stateKey = sha256(
    stableJson({
      session_id: input.session_id ?? null,
      turn_id: input.turn_id ?? null,
      event: input.hook_event_name ?? null,
      agent_id: input.agent_id ?? null,
    }),
  );
  const statePath = path.join(artifactDir, "hook-state", `${stateKey}.json`);
  let stateCreated = false;
  if (
    lane === "primary" &&
    process.env.LOOPERATORS_P0_CONTINUATION_MODE === "lap" &&
    ["Stop", "SubagentStop"].includes(input.hook_event_name) &&
    input.stop_hook_active !== true
  ) {
    try {
      await atomicWriteJson(
        statePath,
        {
          semantic_key: semanticKey,
          first_blocked_at: startedWall,
          lap_cap: 1,
        },
        { exclusive: true },
      );
      stateCreated = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }

  if (Number.isFinite(delayMs) && delayMs > 0 && delayMs <= 500) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const finishedMonotonicNs = process.hrtime.bigint();
  const record = {
    schema_version: 1,
    semantic_key: semanticKey,
    delivery_key: deliveryKey,
    identity_hash: identityHash,
    lane,
    process_id: process.pid,
    captured_at: startedWall,
    started_monotonic_ns: startedMonotonicNs.toString(),
    finished_monotonic_ns: finishedMonotonicNs.toString(),
    duration_ms: Number(finishedMonotonicNs - startedMonotonicNs) / 1e6,
    input: redactedInput,
  };
  const eventPath = path.join(
    artifactDir,
    "hook-events",
    `${identityHash}.json`,
  );
  try {
    await atomicWriteJson(eventPath, record, { exclusive: true });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  const output = lane === "primary" ? continuationOutput(input, stateCreated) : null;
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
}

main().catch(async (error) => {
  const fallback = {
    continue: true,
    systemMessage: `looperators P0 collector failed safely: ${error?.code ?? "error"}`,
  };
  process.stdout.write(JSON.stringify(fallback));
  process.exitCode = 0;
});
