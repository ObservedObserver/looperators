#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const codexBinValue = argument("codex-bin");
const probeDirValue = argument("probe-dir");
const artifactDirValue = argument("artifact-dir");
if (!codexBinValue || !probeDirValue || !artifactDirValue) {
  throw new Error("--codex-bin, --probe-dir, and --artifact-dir are required");
}
const codexBin = path.resolve(codexBinValue);
const probeDir = path.resolve(probeDirValue);
const artifactDir = path.resolve(artifactDirValue);
const runId = argument("run-id", "project-config");
const injectConfig = process.argv.includes("--inject-config");
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mcpServer = path.join(pluginRoot, "mcp", "server.mjs");
const prompt = [
  "Run the synthetic looperators MCP App host probe.",
  "Call the MCP tool loop_widget from server looperators_agent_loop_p0 exactly once.",
  "Do not call any other tool and do not inspect local files.",
  "Report the number of nodes in structuredContent and whether the tool advertises",
  "the resource ui://looperators/agent-loop-p0.html, then stop.",
].join(" ");
const args = [
  "exec",
  "--cd",
  probeDir,
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "--enable",
  "enable_mcp_apps",
  ...(injectConfig
    ? [
        "--config",
        `mcp_servers.looperators_agent_loop_p0.command=${JSON.stringify(process.execPath)}`,
        "--config",
        `mcp_servers.looperators_agent_loop_p0.args=${JSON.stringify([mcpServer])}`,
        "--config",
        `mcp_servers.looperators_agent_loop_p0.env={ LOOPERATORS_P0_ARTIFACT_DIR = ${JSON.stringify(artifactDir)} }`,
      ]
    : []),
  "--config",
  'model_reasoning_effort="high"',
  "--json",
  "--output-last-message",
  path.join(artifactDir, `codex-${runId}-last-message.txt`),
  prompt,
];

await mkdir(artifactDir, { recursive: true, mode: 0o700 });
await atomicWriteJson(path.join(artifactDir, `codex-${runId}-command.json`), {
  executable: codexBin,
  arguments: args,
  cwd: probeDir,
  injected_config: injectConfig,
});
const child = spawn(codexBin, args, {
  cwd: probeDir,
  env: process.env,
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
