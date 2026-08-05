#!/usr/bin/env node

import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson, sha256, stableJson } from "../lib/event-utils.mjs";

const RESOURCE_URI = "ui://looperators/agent-loop-p0.html";
const MIME_TYPE = "text/html;profile=mcp-app";
const artifactDir = process.env.LOOPERATORS_P0_ARTIFACT_DIR;
let protocolSequence = 0;

const widgetHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>looperators Agent Loop MCP App</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; padding: 16px; background: #0b1020; color: #edf1ff; }
      .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      h1 { margin: 0; font-size: 18px; }
      .badge { border: 1px solid #5671bd; border-radius: 999px; padding: 3px 8px; color: #adc0ff; font: 11px ui-monospace, monospace; }
      #graph { display: flex; gap: 10px; align-items: stretch; margin: 16px 0; }
      .node { flex: 1; border: 1px solid #4e64a4; border-radius: 10px; padding: 10px; background: #121a33; }
      .node small { display: block; margin-top: 4px; color: #9faedd; }
      button { border: 1px solid #7192ee; border-radius: 8px; padding: 7px 10px; background: #26478f; color: white; cursor: pointer; }
      #status { margin-left: 8px; color: #aab8e5; font: 12px ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <div class="top"><h1>looperators Agent Loop</h1><span class="badge">MCP App P0</span></div>
    <div id="graph"><div class="node">Root<small>waiting for structuredContent</small></div></div>
    <button id="ping">Call component tool</button><span id="status">initializing…</span>
    <script type="module">
      const status = document.querySelector("#status");
      const graph = document.querySelector("#graph");
      let nextId = 1;
      const pending = new Map();
      function send(method, params) {
        const id = nextId++;
        parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }
      function render(data) {
        const nodes = data?.graph?.nodes ?? data?.nodes ?? [];
        graph.innerHTML = nodes.length
          ? nodes.map((node) => '<div class="node">' + String(node.label ?? node.id) +
              '<small>' + String(node.kind ?? "node") + "</small></div>").join("")
          : '<div class="node">Root<small>no graph rows yet</small></div>';
      }
      addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id && pending.has(message.id)) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          render(message.params?.structuredContent);
          status.textContent = "structuredContent received";
        }
      });
      try {
        await send("ui/initialize", {
          protocolVersion: "2026-01-26",
          appInfo: { name: "looperators-agent-loop-p0", version: "0.1.0" },
          appCapabilities: {}
        });
        parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
        status.textContent = "MCP App initialized";
      } catch {
        status.textContent = "host did not initialize MCP App";
      }
      document.querySelector("#ping").addEventListener("click", async () => {
        status.textContent = "calling loop_ping…";
        try {
          const result = await send("tools/call", {
            name: "loop_ping",
            arguments: { message: "component-call" }
          });
          status.textContent = result?.structuredContent?.ack ?? "tool returned";
        } catch {
          status.textContent = "component tool call rejected";
        }
      });
    </script>
  </body>
</html>`;

function graphPayload() {
  return {
    graph: {
      nodes: [
        { id: "root", kind: "root", label: "Root turn" },
        { id: "agent-a", kind: "subagent", label: "Subagent A" },
        { id: "agent-b", kind: "subagent", label: "Subagent B" },
      ],
      edges: [
        { source: "root", target: "agent-a", kind: "spawned" },
        { source: "root", target: "agent-b", kind: "spawned" },
      ],
    },
    source: "looperators-agent-loop-p0",
  };
}

async function logProtocol(direction, message) {
  if (!artifactDir) {
    return;
  }
  protocolSequence += 1;
  const redacted = {
    direction,
    method: message.method ?? null,
    id: message.id ?? null,
    sequence: protocolSequence,
    captured_at: new Date().toISOString(),
    payload_sha256: sha256(stableJson(message)),
  };
  const fileName = `${String(protocolSequence).padStart(4, "0")}-${direction}-${redacted.method ?? "response"}.json`
    .replaceAll("/", "-")
    .replaceAll(":", "-");
  await atomicWriteJson(path.join(artifactDir, "mcp-protocol", fileName), redacted);
}

function toolDescriptor(name, description, inputSchema, outputSchema, meta = undefined) {
  return {
    name,
    title: name
      .split("_")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" "),
    description,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: name !== "loop_ping" },
    ...(meta ? { _meta: meta } : {}),
  };
}

function toolsList() {
  const outputSchema = {
    type: "object",
    properties: {
      graph: { type: "object" },
      source: { type: "string" },
    },
    required: ["graph", "source"],
    additionalProperties: true,
  };
  return [
    toolDescriptor(
      "loop_snapshot",
      "Return the normalized looperators Agent Loop graph as structured content.",
      { type: "object", properties: {}, additionalProperties: false },
      outputSchema,
    ),
    toolDescriptor(
      "loop_widget",
      "Return the graph and ask a compatible host to render the MCP App.",
      { type: "object", properties: {}, additionalProperties: false },
      outputSchema,
      {
        ui: { resourceUri: RESOURCE_URI },
        "ui/resourceUri": RESOURCE_URI,
        "openai/outputTemplate": RESOURCE_URI,
      },
    ),
    toolDescriptor(
      "loop_ping",
      "A deterministic component-to-server tools/call probe.",
      {
        type: "object",
        properties: { message: { type: "string" } },
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { ack: { type: "string" } },
        required: ["ack"],
        additionalProperties: false,
      },
    ),
  ];
}

async function dispatch(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: "looperators-agent-loop-p0", version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: toolsList() };
    case "resources/list":
      return {
        resources: [
          {
            uri: RESOURCE_URI,
            name: "looperators Agent Loop P0",
            title: "looperators Agent Loop P0",
            description: "Minimal MCP App graph for the compatibility probe.",
            mimeType: MIME_TYPE,
          },
        ],
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read":
      if (message.params?.uri !== RESOURCE_URI) {
        throw Object.assign(new Error("Unknown resource"), { code: -32002 });
      }
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: MIME_TYPE,
            text: widgetHtml,
          },
        ],
      };
    case "tools/call": {
      const name = message.params?.name;
      if (name === "loop_snapshot" || name === "loop_widget") {
        const structuredContent = graphPayload();
        return {
          content: [
            {
              type: "text",
              text: "looperators Agent Loop graph is available in structuredContent.",
            },
          ],
          structuredContent,
        };
      }
      if (name === "loop_ping") {
        const messageText = message.params?.arguments?.message ?? "ping";
        return {
          content: [{ type: "text", text: `ack:${messageText}` }],
          structuredContent: { ack: `ack:${messageText}` },
        };
      }
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
    default:
      if (message.method?.startsWith("notifications/")) {
        return undefined;
      }
      throw Object.assign(new Error(`Method not found: ${message.method}`), {
        code: -32601,
      });
  }
}

async function handle(message) {
  await logProtocol("in", message);
  if (message.id === undefined || message.id === null) {
    await dispatch(message);
    return;
  }
  let response;
  try {
    response = {
      jsonrpc: "2.0",
      id: message.id,
      result: await dispatch(message),
    };
  } catch (error) {
    response = {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: Number.isInteger(error?.code) ? error.code : -32603,
        message: error?.message ?? "Internal error",
      },
    };
  }
  await logProtocol("out", response);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  chain = chain
    .then(() => handle(JSON.parse(line)))
    .catch((error) => {
      process.stderr.write(`looperators P0 MCP error: ${error?.message ?? error}\n`);
    });
});
