#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { digestJson } from "../lib/canonical-json.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function digestValue(name, value) {
  return digestJson({ [name]: value });
}

function sanitizeItem(item) {
  const sanitized = { ...item };
  if (typeof sanitized.text === "string") {
    sanitized.textBytes = Buffer.byteLength(sanitized.text, "utf8");
    sanitized.textDigest = digestValue("text", sanitized.text);
    delete sanitized.text;
  }
  if (typeof sanitized.message === "string") {
    sanitized.messageDigest = digestValue(
      "message",
      sanitized.message,
    );
    delete sanitized.message;
  }
  if (Object.hasOwn(sanitized, "error")) {
    sanitized.errorPresent =
      sanitized.error !== undefined && sanitized.error !== null;
    delete sanitized.error;
  }
  return sanitized;
}

function sanitizeArtifact(value) {
  const sanitized = structuredClone(value);
  for (const key of ["threadId", "dataRoot", "probeCwd"]) {
    if (typeof sanitized[key] === "string") {
      sanitized[`${key}Digest`] = digestValue(key, sanitized[key]);
      delete sanitized[key];
    }
  }
  for (const key of ["stderr", "stderrHead", "stderrTail"]) {
    if (typeof sanitized[key] === "string") {
      sanitized[`${key}Bytes`] = Buffer.byteLength(
        sanitized[key],
        "utf8",
      );
      sanitized[`${key}Digest`] = digestValue(key, sanitized[key]);
      delete sanitized[key];
    }
  }
  if (Array.isArray(sanitized.stderrSummary?.noteworthy)) {
    sanitized.stderrSummary.noteworthyDigests =
      sanitized.stderrSummary.noteworthy.map((line) =>
        digestValue("stderrLine", line),
      );
    delete sanitized.stderrSummary.noteworthy;
  }
  if (Array.isArray(sanitized.completedItems)) {
    sanitized.completedItems =
      sanitized.completedItems.map(sanitizeItem);
  }
  if (
    sanitized.toolCall &&
    typeof sanitized.toolCall === "object" &&
    Object.hasOwn(sanitized.toolCall, "error")
  ) {
    sanitized.toolCall.errorPresent =
      sanitized.toolCall.error !== undefined &&
      sanitized.toolCall.error !== null;
    delete sanitized.toolCall.error;
  }
  return sanitized;
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(target)));
    } else if (
      entry.isFile() &&
      entry.name.startsWith("mcp-identity-") &&
      entry.name.endsWith(".json")
    ) {
      files.push(target);
    }
  }
  return files;
}

const artifactDirectory = argument("artifact-dir");
if (!artifactDirectory || !path.isAbsolute(artifactDirectory)) {
  throw new Error("--artifact-dir must be an absolute path");
}
const changed = [];
for (const file of await filesBelow(artifactDirectory)) {
  const before = JSON.parse(await readFile(file, "utf8"));
  const after = sanitizeArtifact(before);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await atomicReplaceJson(file, after);
    changed.push(path.relative(artifactDirectory, file));
  }
}
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 1, changed })}\n`,
);
