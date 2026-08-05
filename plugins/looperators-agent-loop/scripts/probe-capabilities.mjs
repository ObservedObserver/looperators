#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function parseFeatures(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s{2,}(.+?)\s{2,}(true|false)$/);
      return match
        ? {
            name: match[1],
            maturity: match[2].trim(),
            enabled: match[3] === "true",
          }
        : { raw: line };
    });
}

const outputValue = argument("output");
if (!outputValue || !path.isAbsolute(outputValue)) {
  throw new Error("--output must be an absolute path");
}
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const codexBin =
  argument("codex-bin") ??
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const appRoot = "/Applications/ChatGPT.app";
const versionResult = run(codexBin, ["--version"]);
const featuresResult = run(codexBin, ["features", "list"]);
const manifest = JSON.parse(
  await readFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    "utf8",
  ),
);
const infoPlist = path.join(appRoot, "Contents", "Info.plist");
const appMetadata = await stat(infoPlist).then(
  () => ({
    shortVersion: run("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      infoPlist,
    ]).stdout,
    buildVersion: run("/usr/bin/plutil", [
      "-extract",
      "CFBundleVersion",
      "raw",
      "-o",
      "-",
      infoPlist,
    ]).stdout,
  }),
  () => null,
);
const features = parseFeatures(featuresResult.stdout);
const byName = new Map(
  features
    .filter((feature) => feature.name)
    .map((feature) => [feature.name, feature]),
);
const evidence = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  platform: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  desktop: appMetadata,
  codex: {
    binary: codexBin,
    version: versionResult.stdout,
    versionStatus: versionResult.status,
    featuresStatus: featuresResult.status,
    required: {
      hooks: byName.get("hooks") ?? null,
      plugins: byName.get("plugins") ?? null,
      multiAgent: byName.get("multi_agent") ?? null,
      mcpApps: byName.get("enable_mcp_apps") ?? null,
      inlineVisualization:
        byName.get("terminal_visualization_instructions") ?? null,
      agentIdentity: byName.get("use_agent_identity") ?? null,
    },
  },
  plugin: {
    name: manifest.name,
    version: manifest.version,
  },
};
await atomicReplaceJson(outputValue, evidence);
process.stdout.write(
  `${JSON.stringify({
    output: outputValue,
    codex: evidence.codex.version,
    desktop: evidence.desktop,
  })}\n`,
);
