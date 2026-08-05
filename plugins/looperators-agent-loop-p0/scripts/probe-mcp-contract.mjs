#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const outputValue = argument("output");
if (!outputValue) {
  throw new Error("--output is required");
}
const output = path.resolve(outputValue);
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const pending = new Map();
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
let nextId = 1;
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => reject(new Error(`MCP timeout for ${method}: ${stderr}`)),
      3_000,
    );
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

try {
  const initialize = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "looperators-p0-contract-probe", version: "1" },
  });
  const toolList = await request("tools/list");
  const resourceList = await request("resources/list");
  const resource = await request("resources/read", {
    uri: "ui://looperators/agent-loop-p0.html",
  });
  const widget = await request("tools/call", {
    name: "loop_widget",
    arguments: {},
  });
  const ping = await request("tools/call", {
    name: "loop_ping",
    arguments: { message: "component-call" },
  });
  const html = resource.contents[0].text;
  await atomicWriteJson(output, {
    schema_version: 1,
    initialize,
    tools: toolList.tools,
    resources: resourceList.resources,
    resource_read: {
      uri: resource.contents[0].uri,
      mimeType: resource.contents[0].mimeType,
      html_sha256: createHash("sha256").update(html).digest("hex"),
      html_bytes: Buffer.byteLength(html),
      contains_ui_initialize: html.includes("ui/initialize"),
      contains_tool_result_notification: html.includes(
        "ui/notifications/tool-result",
      ),
      contains_component_tools_call: html.includes("tools/call"),
    },
    widget_result: widget,
    component_ping_result: ping,
  });
} finally {
  child.stdin.end();
}
process.stdout.write(`${JSON.stringify({ output })}\n`);
