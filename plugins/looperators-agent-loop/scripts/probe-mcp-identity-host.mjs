#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digestJson } from "../lib/canonical-json.mjs";
import { assertSafeFileId } from "../lib/contracts.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseJsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "unparsed" };
      }
    });
}

function summarizeStderr(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stateDbDiscrepancyCount = lines.filter((line) =>
    line.includes("state db discrepancy"),
  ).length;
  return {
    lineCount: lines.length,
    stateDbDiscrepancyCount,
    categories: {
      pathAliasPermission: lines.filter((line) =>
        line.includes("could not create PATH aliases"),
      ).length,
      stateDbReadOnly: lines.filter((line) =>
        line.includes("readonly database"),
      ).length,
      appServerPermission: lines.filter((line) =>
        line.includes("in-process app-server"),
      ).length,
      parentThreadLookup: lines.filter((line) =>
        line.includes("parent thread"),
      ).length,
    },
  };
}

const outputValue = argument("output");
const artifactDir = argument("artifact-dir");
if (
  !outputValue ||
  !artifactDir ||
  !path.isAbsolute(outputValue) ||
  !path.isAbsolute(artifactDir)
) {
  throw new Error("--output and --artifact-dir must be absolute paths");
}
const probeId = argument("probe-id", `host-${randomUUID()}`);
assertSafeFileId(probeId, "probeId");
const mode = argument("mode", "root");
if (!["root", "subagent"].includes(mode)) {
  throw new Error("--mode must be root or subagent");
}
const persistThread = process.argv.includes("--persist-thread");
const codexBin =
  argument("codex-bin") ??
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const requestedDataRoot = argument("data-root");
const dataRoot =
  requestedDataRoot ??
  (await mkdtemp(path.join(os.tmpdir(), "looperators-p1a-host-root-")));
const requestedProbeCwd = argument("probe-cwd");
const probeCwd =
  requestedProbeCwd ??
  (await mkdtemp(path.join(os.tmpdir(), "looperators-p1a-host-cwd-")));
const ownedTemporaryPaths = [
  ...(requestedDataRoot ? [] : [dataRoot]),
  ...(requestedProbeCwd ? [] : [probeCwd]),
];
process.once("exit", () => {
  for (const temporaryPath of ownedTemporaryPaths) {
    rmSync(temporaryPath, { recursive: true, force: true });
  }
});
for (const value of [dataRoot, probeCwd]) {
  if (!path.isAbsolute(value)) {
    throw new Error("probe paths must be absolute");
  }
}
await Promise.all([
  mkdir(dataRoot, { recursive: true, mode: 0o700 }),
  mkdir(probeCwd, { recursive: true, mode: 0o700 }),
  mkdir(artifactDir, { recursive: true, mode: 0o700 }),
]);
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");
const prompt =
  mode === "subagent"
    ? [
        "Run one synthetic looperators P1-A subagent identity gate.",
        "Spawn exactly one native subagent named identity_worker.",
        `Tell that subagent to call the MCP tool looperators_identity_probe from server looperators_agent_loop with probeId ${probeId} exactly once and report the returned classification.`,
        "The root must not call the identity tool.",
        "Do not inspect files or use unrelated tools.",
        "Wait for the subagent and then stop.",
      ].join(" ")
    : [
        "Run one synthetic looperators P1-A root identity gate.",
        `Call the MCP tool looperators_identity_probe from server looperators_agent_loop with probeId ${probeId} exactly once.`,
        "Do not call any other tool, do not inspect files, and stop after reporting the returned classification.",
      ].join(" ");
const args = [
  "exec",
  "--cd",
  probeCwd,
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  ...(persistThread ? [] : ["--ephemeral"]),
  "--ignore-user-config",
  "--ignore-rules",
  "--config",
  `mcp_servers.looperators_agent_loop.command=${JSON.stringify(process.execPath)}`,
  "--config",
  `mcp_servers.looperators_agent_loop.args=${JSON.stringify([serverPath])}`,
  "--config",
  `mcp_servers.looperators_agent_loop.env={ LOOPERATORS_DATA_DIR = ${JSON.stringify(dataRoot)}, LOOPERATORS_PROBE_ARTIFACT_DIR = ${JSON.stringify(artifactDir)} }`,
  "--config",
  `model_reasoning_effort=${JSON.stringify(
    mode === "subagent" ? "high" : "low",
  )}`,
  "--json",
  prompt,
];
const child = spawn(codexBin, args, {
  cwd: probeCwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));
const exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
const stdoutText = Buffer.concat(stdout).toString("utf8");
const stderrText = Buffer.concat(stderr).toString("utf8");
const events = parseJsonLines(stdoutText);
const toolCall = events
  .filter((event) => event.type === "item.completed")
  .map((event) => event.item)
  .find(
    (item) =>
      item?.type === "mcp_tool_call" &&
      item?.tool === "looperators_identity_probe",
  );
let serverRecord = null;
try {
  serverRecord = JSON.parse(
    await readFile(
      path.join(artifactDir, `mcp-identity-${probeId}.json`),
      "utf8",
    ),
  );
} catch {
  serverRecord = null;
}
const completedItems = events
  .filter((event) => event.type === "item.completed")
  .map((event) => event.item)
  .filter(Boolean)
  .map((item) => {
    if (item.type === "mcp_tool_call") {
      return {
        type: item.type,
        server: item.server,
        tool: item.tool,
        status: item.status,
        errorPresent: item.error !== undefined && item.error !== null,
      };
    }
    if (item.type === "error") {
      return {
        type: item.type,
        messageDigest: digestJson({
          message: String(item.message ?? "").slice(0, 2000),
        }),
      };
    }
    if (item.type === "agent_message") {
      const text = String(item.text ?? "").slice(0, 2000);
      return {
        type: item.type,
        textBytes: Buffer.byteLength(text, "utf8"),
        textDigest: digestJson({ text }),
      };
    }
    if (item.type === "collab_tool_call") {
      return {
        type: item.type,
        tool: item.tool ?? item.name ?? null,
        status: item.status ?? null,
        errorPresent: item.error !== undefined && item.error !== null,
      };
    }
    return { type: item.type ?? "unknown" };
  });
const passed =
  exitCode === 0 &&
  serverRecord?.probeId === probeId &&
  (mode === "subagent"
    ? serverRecord?.contextHints?.threadSource === "subagent"
    : toolCall?.status === "completed");
const result = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  probeId,
  codexBin,
  dataRootDigest: digestJson({ dataRoot }),
  probeCwdDigest: digestJson({ probeCwd }),
  isolation: {
    ephemeral: !persistThread,
    persistedIndependentThread: persistThread,
    ignoredUserConfig: true,
    ignoredRules: true,
    desktopRestarted: false,
    globalConfigModified: false,
  },
  commandShape: {
    subcommand: "exec",
    sandbox: "read-only",
    injectedMcpServer: "looperators_agent_loop",
    mode,
    reasoningEffort: mode === "subagent" ? "high" : "low",
  },
  exitCode,
  stderrSummary: summarizeStderr(stderrText),
  eventTypes: events.reduce((counts, event) => {
    counts[event.type ?? "unknown"] =
      (counts[event.type ?? "unknown"] ?? 0) + 1;
    return counts;
  }, {}),
  completedItems,
  threadIdDigest: events.find(
    (event) => event.type === "thread.started",
  )?.thread_id
    ? digestJson({
        threadId: events.find(
          (event) => event.type === "thread.started",
        ).thread_id,
      })
    : null,
  toolCall: toolCall
    ? {
        server: toolCall.server,
        tool: toolCall.tool,
        status: toolCall.status,
        errorPresent:
          toolCall.error !== undefined && toolCall.error !== null,
        structuredContent: toolCall.result?.structured_content ?? null,
      }
    : null,
  serverRecord,
  passed,
};
await atomicReplaceJson(outputValue, result);
process.stdout.write(
  `${JSON.stringify({
    output: outputValue,
    probeId,
    passed: result.passed,
    classification: serverRecord?.classification ?? null,
  })}\n`,
);
if (!result.passed) {
  process.exitCode = 1;
}
