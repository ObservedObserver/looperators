#!/usr/bin/env node

import { watch } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { safeTokenEqual } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const host = argument("host", "127.0.0.1");
const port = Number(argument("port", "0"));
const artifactDir = path.resolve(
  argument(
    "artifact-dir",
    process.env.LOOPERATORS_P0_ARTIFACT_DIR ??
      path.join(process.cwd(), "output", "looperators-agent-loop-p0"),
  ),
);
const token =
  process.env.LOOPERATORS_P0_SIDECAR_TOKEN ?? argument("token", "");

if (host !== "127.0.0.1") {
  throw new Error("The P0 sidecar only permits --host 127.0.0.1");
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("--port must be an integer from 0 through 65535");
}
if (token.length < 16) {
  throw new Error(
    "Set LOOPERATORS_P0_SIDECAR_TOKEN to an explicit or random token of at least 16 characters",
  );
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>looperators Agent Loop sidecar</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; padding: 20px; background: #0a0f1e; color: #edf1ff; }
      header { display: flex; align-items: baseline; justify-content: space-between; }
      h1 { margin: 0; font-size: 20px; }
      #status { color: #96f0c8; font: 12px ui-monospace, monospace; }
      #graph { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0; }
      .node { border: 1px solid #5068ad; border-radius: 10px; padding: 12px; background: #121a33; }
      .node small { display: block; margin-top: 5px; color: #9eaddb; }
      table { width: 100%; border-collapse: collapse; font: 12px ui-monospace, monospace; }
      th, td { padding: 7px; border-bottom: 1px solid #283454; text-align: left; }
    </style>
  </head>
  <body>
    <header><h1>looperators Agent Loop</h1><span id="status">connecting…</span></header>
    <div id="graph"></div>
    <table>
      <thead><tr><th>#</th><th>event</th><th>turn</th><th>agent/tool</th></tr></thead>
      <tbody id="events"></tbody>
    </table>
    <script>
      const status = document.querySelector("#status");
      const graph = document.querySelector("#graph");
      const events = document.querySelector("#events");
      const stream = new EventSource("/events");
      stream.addEventListener("snapshot", (event) => {
        const data = JSON.parse(event.data);
        graph.innerHTML = (data.graph?.nodes ?? []).map((node) =>
          '<div class="node">' + escapeHtml(node.label ?? node.id) +
          '<small>' + escapeHtml(node.kind ?? "node") + "</small></div>"
        ).join("");
        events.innerHTML = (data.events ?? []).slice(-20).reverse().map((row) =>
          "<tr><td>" + row.sequence + "</td><td>" + escapeHtml(row.event) +
          "</td><td>" + escapeHtml(row.turn_id ?? "-") + "</td><td>" +
          escapeHtml(row.agent_id ?? row.tool_name ?? "-") + "</td></tr>"
        ).join("");
        status.textContent = "live · " + new Date().toLocaleTimeString();
      });
      stream.onerror = () => { status.textContent = "reconnecting…"; };
      function escapeHtml(value) {
        const span = document.createElement("span");
        span.textContent = String(value);
        return span.innerHTML;
      }
    </script>
  </body>
</html>`;

const clients = new Set();
let watcher;
let debounceTimer;

async function loadJson(fileName, fallback) {
  try {
    return JSON.parse(await readFile(path.join(artifactDir, fileName), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function loadEvents() {
  try {
    const body = await readFile(
      path.join(artifactDir, "normalized-events.jsonl"),
      "utf8",
    );
    return body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    let names = [];
    try {
      names = await readdir(path.join(artifactDir, "hook-events"));
    } catch (nestedError) {
      if (nestedError?.code === "ENOENT") {
        return [];
      }
      throw nestedError;
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(-20)
      .map((name, index) => ({
        sequence: index + 1,
        event: "un-normalized delivery",
        turn_id: null,
        agent_id: null,
        evidence_file: name,
      }));
  }
}

async function snapshot() {
  return {
    generated_at: new Date().toISOString(),
    graph: await loadJson("normalized-graph.json", { nodes: [], edges: [] }),
    events: await loadEvents(),
  };
}

async function broadcast() {
  const payload = `event: snapshot\ndata: ${JSON.stringify(await snapshot())}\n\n`;
  for (const response of clients) {
    response.write(payload);
  }
}

function scheduleBroadcast() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    broadcast().catch(() => {});
  }, 40);
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [
          part.slice(0, separator),
          decodeURIComponent(part.slice(separator + 1)),
        ];
      }),
  );
}

function authenticated(request) {
  const bearer = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length)
    : "";
  const cookie = parseCookies(request.headers.cookie).looperators_p0;
  return safeTokenEqual(bearer || cookie || "", token);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  const queryToken = url.searchParams.get("token") ?? "";
  if (queryToken && safeTokenEqual(queryToken, token)) {
    response.writeHead(303, {
      Location: url.pathname,
      "Set-Cookie": `looperators_p0=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }
  if (!authenticated(request)) {
    response.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("Unauthorized\n");
    return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(html);
    return;
  }
  if (url.pathname === "/snapshot") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`${JSON.stringify(await snapshot())}\n`);
    return;
  }
  if (url.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(await snapshot())}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

await mkdir(artifactDir, { recursive: true, mode: 0o700 });
watcher = watch(artifactDir, { recursive: true }, scheduleBroadcast);
server.listen(port, host, () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      host,
      port: address.port,
      base_url: `http://${host}:${address.port}/`,
      token_required: true,
      artifact_dir: artifactDir,
    })}\n`,
  );
});

function shutdown() {
  watcher?.close();
  for (const response of clients) {
    response.end();
  }
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
