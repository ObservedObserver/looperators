#!/usr/bin/env node

import { createInterface } from "node:readline";
import process from "node:process";
import {
  LoopController,
  rootContextFromMcpMessage,
} from "../lib/control.mjs";
import { LoopStore } from "../lib/store.mjs";
import { startSidecar } from "../scripts/sidecar-server.mjs";

const SUPPORTED_NODE_MAJOR = 24;
const nodeMajor = Number.parseInt(
  process.versions.node.split(".")[0] ?? "",
  10,
);
if (nodeMajor !== SUPPORTED_NODE_MAJOR) {
  process.stderr.write(
    `looperators Agent Loop requires Node.js ${SUPPORTED_NODE_MAJOR}.x; received ${process.versions.node}.\n`,
  );
  process.exit(1);
}

const REQUEST_ID = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
};
const RUN_ID = { ...REQUEST_ID };
const STATE_OUTPUT = {
  schemaVersion: { type: "integer", const: 1 },
  runId: { type: "string" },
  status: { type: "string" },
  revision: { type: "integer" },
  currentLap: { type: "integer" },
  lapCap: { type: "integer" },
  duplicate: { type: "boolean" },
};
const SNAPSHOT_OUTPUT = {
  schemaVersion: { type: "integer", const: 1 },
  storeVersion: { type: "integer", const: 1 },
  projectionVersion: { type: "integer", const: 3 },
  runId: { type: "string" },
  revision: { type: "integer" },
  status: { type: "string" },
  recipe: { type: "string", const: "review-until-clean" },
  currentLap: { type: "integer" },
  lapCap: { type: "integer" },
  continuationLease: { type: "object" },
  cancelRequested: { type: "boolean" },
  needsHuman: { type: "boolean" },
  integrity: { type: "object" },
  eventWatermark: { type: "object" },
  nodes: { type: "array" },
  edges: { type: "array" },
  counts: { type: "object" },
  timeline: { type: "array" },
  projectionDigest: {
    type: "string",
    pattern: "^[a-f0-9]{64}$",
  },
};

function tool(
  name,
  description,
  properties,
  required,
  outputProperties,
  options = {},
) {
  return {
    name,
    title: name
      .split("_")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" "),
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: outputProperties,
      required:
        options.outputRequired ?? Object.keys(outputProperties),
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: options.readOnlyHint ?? false,
      destructiveHint: options.destructiveHint ?? false,
      idempotentHint: options.idempotentHint ?? true,
      openWorldHint: false,
    },
  };
}

function toolsList() {
  const control = [
    [
      "start",
      "Start a user-confirmed draft and return the current cooperative role capability. This does not create a subagent.",
      {},
    ],
    ["pause", "Pause a running or interrupted loop.", {}],
    ["resume", "Resume a paused or interrupted loop.", {}],
    [
      "cancel",
      "Cancel a non-terminal loop and revoke its action.",
      { destructiveHint: true },
    ],
  ];
  return [
    tool(
      "looperators_preview_loop",
      "Create or replay a task-scoped draft without starting provider work.",
      {
        requestId: REQUEST_ID,
        goal: { type: "string", minLength: 1, maxLength: 8192 },
        implementerInstructions: {
          type: "string",
          minLength: 1,
          maxLength: 16384,
        },
        reviewerInstructions: {
          type: "string",
          minLength: 1,
          maxLength: 16384,
        },
        lapCap: {
          type: "integer",
          minimum: 1,
          maximum: 6,
          default: 3,
        },
      },
      [
        "requestId",
        "goal",
        "implementerInstructions",
        "reviewerInstructions",
      ],
      STATE_OUTPUT,
    ),
    ...control.map(([action, description, options]) =>
      tool(
        `looperators_${action}_loop`,
        description,
        { runId: RUN_ID, requestId: REQUEST_ID },
        ["runId", "requestId"],
        STATE_OUTPUT,
        options,
      ),
    ),
    tool(
      "looperators_report",
      "Submit one action-scoped typed implementer or reviewer report.",
      {
        runId: RUN_ID,
        requestId: REQUEST_ID,
        role: { enum: ["implementer", "reviewer"] },
        capabilityToken: {
          type: "string",
          minLength: 64,
          maxLength: 2048,
        },
        type: { enum: ["info", "verdict"] },
        status: { const: "done" },
        verdict: { enum: ["clean", "issues"] },
        issues: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["message"],
            properties: {
              message: {
                type: "string",
                minLength: 1,
                maxLength: 4000,
              },
              file: {
                type: "string",
                minLength: 1,
                maxLength: 2000,
              },
              line: { type: "integer", minimum: 1 },
              severity: { enum: ["info", "warn", "error"] },
            },
          },
        },
        summary: { type: "string", minLength: 1, maxLength: 8000 },
      },
      ["runId", "requestId", "role", "capabilityToken", "type"],
      STATE_OUTPUT,
    ),
    tool(
      "looperators_get_loop",
      "Read authoritative loop state and return the current cooperative role capability for this root task; a new Governor MCP process rotates the token.",
      { runId: RUN_ID },
      ["runId"],
      STATE_OUTPUT,
      { readOnlyHint: false },
    ),
    tool(
      "looperators_get_snapshot",
      "Read the complete verified graph projection for this root task.",
      { runId: RUN_ID },
      ["runId"],
      SNAPSHOT_OUTPUT,
      { readOnlyHint: true },
    ),
    tool(
      "looperators_open_review_surface",
      "Open or refresh the authenticated localhost live review surface for this root task. Return the URL for Codex Desktop's built-in Browser.",
      { runId: RUN_ID },
      ["runId"],
      {
        schemaVersion: { type: "integer", const: 1 },
        runId: { type: "string" },
        status: { const: "ready" },
        reviewUrl: { type: "string" },
        origin: { type: "string" },
        expiresAt: { type: "string" },
      },
      { idempotentHint: false },
    ),
    tool(
      "looperators_close_review_surface",
      "Close the localhost live review surface for this root task.",
      { runId: RUN_ID },
      ["runId"],
      {
        schemaVersion: { type: "integer", const: 1 },
        runId: { type: "string" },
        status: { const: "closed" },
      },
    ),
  ];
}

const TOOL_ARGUMENT_KEYS = new Map([
  [
    "looperators_preview_loop",
    new Set([
      "requestId",
      "goal",
      "implementerInstructions",
      "reviewerInstructions",
      "lapCap",
    ]),
  ],
  ...["start", "pause", "resume", "cancel"].map((action) => [
    `looperators_${action}_loop`,
    new Set(["runId", "requestId"]),
  ]),
  [
    "looperators_report",
    new Set([
      "runId",
      "requestId",
      "role",
      "capabilityToken",
      "type",
      "status",
      "verdict",
      "issues",
      "summary",
    ]),
  ],
  ["looperators_get_loop", new Set(["runId"])],
  ["looperators_get_snapshot", new Set(["runId"])],
  ["looperators_open_review_surface", new Set(["runId"])],
  ["looperators_close_review_surface", new Set(["runId"])],
]);

function validatedArguments(message, name) {
  const value = message.params?.arguments;
  const allowed = TOOL_ARGUMENT_KEYS.get(name);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !allowed ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    const error = new TypeError("tool arguments are invalid");
    error.code = "INVALID_TOOL_INPUT";
    throw error;
  }
  return value;
}

let runtimePromise;

async function runtime() {
  runtimePromise ??= LoopStore.open().then((store) => ({
    store,
    control: new LoopController(store),
    sidecars: new Map(),
  }));
  return runtimePromise;
}

async function openReviewSurface(message, args) {
  const current = await runtime();
  const context = rootContextFromMcpMessage(message);
  await current.control.getLoop(context, args);
  let entry = current.sidecars.get(args.runId);
  if (!entry) {
    entry = { context, sidecar: undefined };
    entry.sidecar = await startSidecar({
      runId: args.runId,
      host: "127.0.0.1",
      port: 0,
      store: current.store,
      controller: current.control,
      onControl: ({ action, requestId }) =>
        current.control[action](entry.context, {
          runId: args.runId,
          requestId,
        }),
    });
    current.sidecars.set(args.runId, entry);
  } else {
    entry.context = context;
  }
  const ticket = entry.sidecar.issueTicket();
  return {
    schemaVersion: 1,
    runId: args.runId,
    status: "ready",
    reviewUrl: ticket.url,
    origin: entry.sidecar.origin,
    expiresAt: ticket.expiresAt,
  };
}

async function closeReviewSurface(message, args) {
  const current = await runtime();
  const context = rootContextFromMcpMessage(message);
  await current.control.getLoop(context, args);
  const entry = current.sidecars.get(args.runId);
  if (entry) {
    await entry.sidecar.close();
    current.sidecars.delete(args.runId);
  }
  return {
    schemaVersion: 1,
    runId: args.runId,
    status: "closed",
  };
}

async function callProductTool(message, name) {
  const args = validatedArguments(message, name);
  const { control } = await runtime();
  switch (name) {
    case "looperators_preview_loop":
      return control.preview(rootContextFromMcpMessage(message), args);
    case "looperators_start_loop":
      return control.start(rootContextFromMcpMessage(message), args);
    case "looperators_pause_loop":
      return control.pause(rootContextFromMcpMessage(message), args);
    case "looperators_resume_loop":
      return control.resume(rootContextFromMcpMessage(message), args);
    case "looperators_cancel_loop":
      return control.cancel(rootContextFromMcpMessage(message), args);
    case "looperators_report":
      return control.report(args);
    case "looperators_get_loop":
      return control.getLoop(rootContextFromMcpMessage(message), args);
    case "looperators_get_snapshot":
      return control.getSnapshot(rootContextFromMcpMessage(message), args);
    case "looperators_open_review_surface":
      return openReviewSurface(message, args);
    case "looperators_close_review_surface":
      return closeReviewSurface(message, args);
    default: {
      const error = new Error(`unknown tool: ${name}`);
      error.code = -32601;
      throw error;
    }
  }
}

function toolExecutionError(error) {
  const code =
    typeof error?.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : "TOOL_EXECUTION_ERROR";
  return {
    content: [{ type: "text", text: `looperators tool failed: ${code}` }],
    isError: true,
  };
}

async function dispatch(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "looperators-agent-loop", version: "0.3.2" },
      };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return { tools: toolsList() };
    case "tools/call": {
      const name = message.params?.name;
      if (!TOOL_ARGUMENT_KEYS.has(name)) {
        const error = new Error(`unknown tool: ${String(name)}`);
        error.code = -32601;
        throw error;
      }
      let structuredContent;
      try {
        structuredContent = await callProductTool(message, name);
      } catch (error) {
        return toolExecutionError(error);
      }
      return {
        content: [
          {
            type: "text",
            text: `looperators ${structuredContent.runId} is ${structuredContent.status}`,
          },
        ],
        structuredContent,
        isError: false,
      };
    }
    default: {
      if (message.id === undefined) return undefined;
      const error = new Error(`method not found: ${message.method}`);
      error.code = -32601;
      throw error;
    }
  }
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      })}\n`,
    );
    continue;
  }
  try {
    const result = await dispatch(message);
    if (message.id !== undefined && result !== undefined) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
      );
    }
  } catch (error) {
    if (message.id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: Number.isInteger(error?.code) ? error.code : -32603,
            message: String(error?.code ?? "internal error"),
          },
        })}\n`,
      );
    }
  }
}

if (runtimePromise) {
  const current = await runtimePromise;
  await Promise.allSettled(
    [...current.sidecars.values()].map((entry) => entry.sidecar.close()),
  );
}
