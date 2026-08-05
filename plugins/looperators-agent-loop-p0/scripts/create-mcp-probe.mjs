#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function tomlString(value) {
  return JSON.stringify(value);
}

const probeDirValue = argument("probe-dir");
const artifactDirValue = argument("artifact-dir");
if (!probeDirValue || !artifactDirValue) {
  throw new Error("--probe-dir and --artifact-dir are required");
}
const probeDir = path.resolve(probeDirValue);
const artifactDir = path.resolve(artifactDirValue);
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const server = path.join(pluginRoot, "mcp", "server.mjs");
const config = [
  "[mcp_servers.looperators_agent_loop_p0]",
  `command = ${tomlString(process.execPath)}`,
  `args = [${tomlString(server)}]`,
  `env = { LOOPERATORS_P0_ARTIFACT_DIR = ${tomlString(artifactDir)} }`,
  "startup_timeout_sec = 10",
  "tool_timeout_sec = 10",
  "",
].join("\n");

await mkdir(path.join(probeDir, ".codex"), { recursive: true, mode: 0o700 });
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
await writeFile(path.join(probeDir, ".codex", "config.toml"), config, {
  mode: 0o600,
});
await writeFile(path.join(artifactDir, "project-config.toml"), config, {
  mode: 0o600,
});
await atomicWriteJson(path.join(artifactDir, "probe-metadata.json"), {
  schema_version: 1,
  created_at: new Date().toISOString(),
  probe_dir: probeDir,
  plugin_root: pluginRoot,
  server,
  resource_uri: "ui://looperators/agent-loop-p0.html",
  mime_type: "text/html;profile=mcp-app",
});
process.stdout.write(
  `${JSON.stringify({
    probe_dir: probeDir,
    config_file: path.join(probeDir, ".codex", "config.toml"),
    artifact_dir: artifactDir,
  })}\n`,
);
