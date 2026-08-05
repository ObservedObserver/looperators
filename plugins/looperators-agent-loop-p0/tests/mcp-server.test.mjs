import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");

test("MCP server exposes structured content, ui resource, and component tool", async (t) => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
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
        () => reject(new Error(`MCP timeout for ${method}; stderr=${stderr}`)),
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

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "p0-test", version: "1" },
  });
  assert.equal(initialized.serverInfo.name, "looperators-agent-loop-p0");

  const tools = await request("tools/list");
  const widget = tools.tools.find((tool) => tool.name === "loop_widget");
  assert.equal(widget._meta.ui.resourceUri, "ui://looperators/agent-loop-p0.html");
  assert.equal(
    widget._meta["openai/outputTemplate"],
    "ui://looperators/agent-loop-p0.html",
  );

  const resource = await request("resources/read", {
    uri: "ui://looperators/agent-loop-p0.html",
  });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /ui\/initialize/);
  assert.match(resource.contents[0].text, /tools\/call/);

  const rendered = await request("tools/call", {
    name: "loop_widget",
    arguments: {},
  });
  assert.equal(rendered.structuredContent.graph.nodes.length, 3);

  const ping = await request("tools/call", {
    name: "loop_ping",
    arguments: { message: "component-call" },
  });
  assert.equal(ping.structuredContent.ack, "ack:component-call");
  child.stdin.end();
});
