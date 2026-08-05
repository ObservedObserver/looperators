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
const collector = path.join(pluginRoot, "hooks", "collect-event.mjs");
const command = (lane, delayMs = 0) =>
  [
    JSON.stringify(process.execPath),
    JSON.stringify(collector),
    "--lane",
    lane,
    ...(delayMs ? ["--delay-ms", String(delayMs)] : []),
  ].join(" ");
const handler = (lane, delayMs = 0, statusMessage) => ({
  type: "command",
  command: command(lane, delayMs),
  timeout: 5,
  statusMessage,
});
const single = (eventName, statusMessage) => ({
  [eventName]: [
    {
      hooks: [handler("primary", 0, statusMessage)],
    },
  ],
});
const config = {
  hooks: {
    ...single("SessionStart", "P0 collecting SessionStart"),
    ...single("UserPromptSubmit", "P0 collecting UserPromptSubmit"),
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          handler("primary", 120, "P0 PreToolUse lane primary"),
          handler("parallel", 120, "P0 PreToolUse lane parallel"),
        ],
      },
    ],
    ...single("PostToolUse", "P0 collecting PostToolUse"),
    ...single("SubagentStart", "P0 collecting SubagentStart"),
    ...single("SubagentStop", "P0 applying SubagentStop lap cap"),
    ...single("Stop", "P0 applying Stop lap cap"),
  },
};

await mkdir(path.join(probeDir, ".codex"), { recursive: true, mode: 0o700 });
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(probeDir, ".codex", "hooks.json"),
  `${JSON.stringify(config, null, 2)}\n`,
  { mode: 0o600 },
);
await atomicWriteJson(path.join(artifactDir, "probe-hooks.json"), config);
await atomicWriteJson(path.join(artifactDir, "probe-metadata.json"), {
  schema_version: 1,
  created_at: new Date().toISOString(),
  probe_dir: probeDir,
  plugin_root: pluginRoot,
  artifact_dir: artifactDir,
  continuation_mode: "lap",
  lap_cap: 1,
  parallel_probe_delay_ms: 120,
});
process.stdout.write(
  `${JSON.stringify({
    probe_dir: probeDir,
    hooks_file: path.join(probeDir, ".codex", "hooks.json"),
    artifact_dir: artifactDir,
  })}\n`,
);
