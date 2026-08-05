#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const codexBin = path.resolve(argument("codex-bin"));
const probeDir = path.resolve(argument("probe-dir"));
const artifactDir = path.resolve(argument("artifact-dir"));
const runId = argument("run-id", "default");
const includeUserConfig = process.argv.includes("--include-user-config");
if (!codexBin || !probeDir || !artifactDir) {
  throw new Error("--codex-bin, --probe-dir, and --artifact-dir are required");
}

const lastMessagePath = path.join(
  artifactDir,
  `codex-${runId}-last-message.txt`,
);
const prompt = [
  "Run a synthetic looperators Codex hook compatibility probe. Do not inspect",
  "credentials, user configuration, or files outside this temporary project.",
  "First call the shell tool exactly once with a harmless command that prints",
  "P0_TOOL_OK. Then use the Agent/spawn_agent capability to launch exactly two",
  "independent subagents concurrently. Ask subagent A to return only P0_SUBAGENT_A",
  "and subagent B to return only P0_SUBAGENT_B; they must not call tools. Wait for",
  "both. Report P0_TOOL_OK and both markers, then stop. If a Stop or SubagentStop",
  "hook requests one continuation lap, obey it, output P0_LAP_CONTINUED, call no",
  "more tools, and stop again.",
].join(" ");
const args = [
  "exec",
  "--cd",
  probeDir,
  "--add-dir",
  artifactDir,
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  "--dangerously-bypass-hook-trust",
  ...(!includeUserConfig ? ["--ignore-user-config"] : []),
  "--config",
  'model_reasoning_effort="high"',
  "--config",
  "features.multi_agent=true",
  "--json",
  "--output-last-message",
  lastMessagePath,
  prompt,
];

await mkdir(artifactDir, { recursive: true, mode: 0o700 });
await atomicWriteJson(path.join(artifactDir, `codex-${runId}-command.json`), {
  executable: codexBin,
  arguments: args,
  cwd: probeDir,
  includes_user_config: includeUserConfig,
  environment_overrides: {
    LOOPERATORS_P0_ARTIFACT_DIR: artifactDir,
    LOOPERATORS_P0_CONTINUATION_MODE: "lap",
  },
});

const child = spawn(codexBin, args, {
  cwd: probeDir,
  env: {
    ...process.env,
    LOOPERATORS_P0_ARTIFACT_DIR: artifactDir,
    LOOPERATORS_P0_CONTINUATION_MODE: "lap",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const stdoutChunks = [];
const stderrChunks = [];
child.stdout.on("data", (chunk) => {
  stdoutChunks.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
  process.stderr.write(chunk);
});
const exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
await writeFile(
  path.join(artifactDir, `codex-${runId}.jsonl`),
  Buffer.concat(stdoutChunks),
  { mode: 0o600 },
);
await writeFile(
  path.join(artifactDir, `codex-${runId}.stderr.txt`),
  Buffer.concat(stderrChunks),
  { mode: 0o600 },
);
await atomicWriteJson(path.join(artifactDir, `codex-${runId}-result.json`), {
  exit_code: exitCode,
  completed_at: new Date().toISOString(),
});
process.exitCode = exitCode ?? 1;
