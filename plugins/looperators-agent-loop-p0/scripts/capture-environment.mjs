#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    command: [command, ...args],
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function filePrefixSha256(filePath, prefixBytes) {
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(prefixBytes);
  const { bytesRead } = await handle.read(buffer, 0, prefixBytes, 0);
  await handle.close();
  const hash = createHash("sha256");
  hash.update(buffer.subarray(0, bytesRead));
  return { bytes_read: bytesRead, sha256: hash.digest("hex") };
}

const outputValue = argument("output");
if (!outputValue) {
  throw new Error("--output is required");
}
const output = path.resolve(outputValue);
const repo = process.cwd();
const appRoot = "/Applications/ChatGPT.app";
const embeddedCodex = path.join(appRoot, "Contents", "Resources", "codex");
const infoPlist = path.join(appRoot, "Contents", "Info.plist");
const appAsar = path.join(appRoot, "Contents", "Resources", "app.asar");
const appAsarStat = await stat(appAsar);
const evidence = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  repo,
  platform: {
    arch: process.arch,
    node: process.version,
    sw_vers: run("/usr/bin/sw_vers", []),
  },
  git: {
    head: run("/usr/bin/git", ["rev-parse", "HEAD"], repo),
    status: run("/usr/bin/git", ["status", "--short"], repo),
  },
  codex: {
    path_cli: run("codex", ["--version"], repo),
    embedded_cli: run(embeddedCodex, ["--version"], repo),
    embedded_features: run(embeddedCodex, ["features", "list"], repo),
  },
  desktop: {
    bundle_identifier: run("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      infoPlist,
    ]),
    short_version: run("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      infoPlist,
    ]),
    build_version: run("/usr/bin/plutil", [
      "-extract",
      "CFBundleVersion",
      "raw",
      "-o",
      "-",
      infoPlist,
    ]),
    app_asar_size_bytes: appAsarStat.size,
    app_asar_prefix: await filePrefixSha256(appAsar, 65_536),
  },
};
await atomicWriteJson(output, evidence);
process.stdout.write(`${JSON.stringify({ output, captured_at: evidence.captured_at })}\n`);
