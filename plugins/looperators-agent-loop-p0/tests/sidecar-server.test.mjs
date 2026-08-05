import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverPath = path.join(pluginRoot, "scripts", "sidecar-server.mjs");

test("sidecar binds loopback, requires a token, and streams SSE updates", async (t) => {
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-sidecar-"),
  );
  const token = "synthetic-test-token-12345";
  const child = spawn(
    process.execPath,
    [serverPath, "--artifact-dir", artifactDir, "--host", "127.0.0.1", "--port", "0"],
    {
      env: { ...process.env, LOOPERATORS_P0_SIDECAR_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill("SIGTERM"));
  const ready = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => reject(new Error("sidecar did not start")), 3_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  assert.equal(ready.host, "127.0.0.1");
  assert.equal(ready.token_required, true);
  assert.equal("token" in ready, false);

  const unauthorized = await fetch(ready.base_url, { redirect: "manual" });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${ready.base_url}?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const page = await fetch(ready.base_url, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${ready.base_url}events`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let body = decoder.decode((await reader.read()).value);
  assert.match(body, /event: snapshot/);

  await writeFile(
    path.join(artifactDir, "normalized-graph.json"),
    `${JSON.stringify({
      nodes: [{ id: "root", kind: "root", label: "Root turn" }],
      edges: [],
    })}\n`,
  );
  const deadline = Date.now() + 3_000;
  while (!body.includes("Root turn") && Date.now() < deadline) {
    const chunk = await reader.read();
    body += decoder.decode(chunk.value);
  }
  assert.match(body, /Root turn/);
  await reader.cancel();
});

test("sidecar rejects non-loopback binding", async () => {
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-sidecar-bind-"),
  );
  const child = spawn(
    process.execPath,
    [serverPath, "--artifact-dir", artifactDir, "--host", "0.0.0.0"],
    {
      env: {
        ...process.env,
        LOOPERATORS_P0_SIDECAR_TOKEN: "synthetic-test-token-12345",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const result = await new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /only permits --host 127\.0\.0\.1/);
});
