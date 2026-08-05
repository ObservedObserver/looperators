import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeArtifactDirectory } from "../scripts/normalize-events.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const collector = path.join(pluginRoot, "hooks", "collect-event.mjs");

function runCollector(artifactDir, input, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collector, "--lane", "primary", ...extraArgs], {
      env: {
        ...process.env,
        LOOPERATORS_P0_ARTIFACT_DIR: artifactDir,
        LOOPERATORS_P0_CONTINUATION_MODE: "lap",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`collector exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout ? JSON.parse(stdout) : null);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test("collector is idempotent and caps Stop continuation at one lap", async () => {
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-hooks-"),
  );
  const base = {
    session_id: "session-test",
    turn_id: "turn-test",
    hook_event_name: "Stop",
    transcript_path: "/tmp/transcript.jsonl",
    stop_hook_active: false,
    last_assistant_message: "synthetic private-looking text",
  };
  const first = await runCollector(artifactDir, base);
  const duplicate = await runCollector(artifactDir, base);
  const continuation = await runCollector(artifactDir, {
    ...base,
    stop_hook_active: true,
    last_assistant_message: "P0_LAP_CONTINUED",
  });
  assert.equal(first.decision, "block");
  assert.equal(duplicate.continue, true);
  assert.equal(continuation.continue, true);

  const result = await normalizeArtifactDirectory(artifactDir);
  assert.equal(result.events.length, 2, "duplicate delivery is not written twice");
  assert.equal(result.summary.continuation_pairs[
    "session-test:turn-test:Stop:-"
  ].initial, 1);
  assert.equal(result.summary.continuation_pairs[
    "session-test:turn-test:Stop:-"
  ].continuation, 1);

  const raw = JSON.parse(
    await readFile(
      path.join(artifactDir, result.events[0].evidence_file),
      "utf8",
    ),
  );
  assert.equal(raw.input.last_assistant_message._redacted, "last_assistant_message");
  assert.equal(raw.input.last_assistant_message.bytes > 0, true);
});

test("normalizer reports overlap for parallel matching handlers", async () => {
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-concurrency-"),
  );
  const input = {
    session_id: "session-test",
    turn_id: "turn-test",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-test",
    tool_input: { command: "printf synthetic" },
  };
  const runLane = (lane) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [collector, "--lane", lane, "--delay-ms", "100"],
        {
          env: {
            ...process.env,
            LOOPERATORS_P0_ARTIFACT_DIR: artifactDir,
          },
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`collector exited ${code}: ${stderr}`)),
      );
      child.stdin.end(JSON.stringify(input));
    });
  await Promise.all([runLane("parallel-a"), runLane("parallel-b")]);
  const result = await normalizeArtifactDirectory(artifactDir);
  assert.equal(result.summary.concurrency_probes.length, 1);
  assert.equal(result.summary.concurrency_probes[0].overlaps, true);
});
