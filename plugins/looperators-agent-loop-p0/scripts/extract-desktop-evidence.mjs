#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function filesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesRecursively(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

const asarDirValue = argument("asar-dir");
const outputValue = argument("output");
if (!asarDirValue || !outputValue) {
  throw new Error("--asar-dir and --output are required");
}
const asarDir = path.resolve(asarDirValue);
const output = path.resolve(outputValue);
const needles = [
  "var ige=5e6",
  "followSymlinks:!1",
  "/^[a-z0-9]+(?:-[a-z0-9]+)*\\.html$/",
  "Inline visualization file exceeds the 5 MB limit",
  "Inline visualizations cannot call tools",
  "VPa=`codex-inline-vis`",
  "WPa=/^::codex-(?:inline-vis|live-vis)",
  "text/html;profile=mcp-app",
  "t.data.ui?.resourceUri",
  "method:fl(`tools/call`)",
];
const files = await filesRecursively(asarDir);
const cache = new Map();
const excerpts = [];
for (const needle of needles) {
  let match = null;
  for (const file of files) {
    let text = cache.get(file);
    if (text === undefined) {
      text = await readFile(file, "utf8");
      cache.set(file, text);
    }
    const index = text.indexOf(needle);
    if (index >= 0) {
      match = {
        needle,
        relative_file: path.relative(asarDir, file),
        byte_offset: Buffer.byteLength(text.slice(0, index)),
        excerpt: text.slice(Math.max(0, index - 420), index + needle.length + 820),
        source_sha256: createHash("sha256").update(text).digest("hex"),
      };
      break;
    }
  }
  excerpts.push(match ?? { needle, missing: true });
}
await atomicWriteJson(output, {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  asar_directory: asarDir,
  excerpts,
});
process.stdout.write(
  `${JSON.stringify({
    output,
    matched: excerpts.filter((entry) => !entry.missing).length,
    missing: excerpts.filter((entry) => entry.missing).map((entry) => entry.needle),
  })}\n`,
);
