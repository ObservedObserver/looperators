#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { renderGraphFragment } from "../lib/graph-view.mjs";
import { startSidecar } from "./sidecar-server.mjs";
import { runP1dHeadless } from "./run-p1d-headless.mjs";

const HOST = "127.0.0.1";
const UPDATE_TIMEOUT_MS = 3_000;

function documentFor(projection) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>looperators inline graph acceptance</title>
  <link rel="icon" href="data:,">
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, Canvas);
      color: var(--foreground, CanvasText);
    }
  </style>
</head>
<body>
${renderGraphFragment(projection)}
</body>
</html>`;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("inline acceptance server did not bind a TCP address");
  }
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function startGraphUiBrowserAcceptance() {
  const temporary = await realpath(
    await mkdtemp(
      path.join(os.tmpdir(), "looperators-graph-ui-browser-"),
    ),
  );
  const fixtureDirectory = path.join(temporary, "fixture");
  const watchDirectory = path.join(temporary, "watch");
  await mkdir(watchDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await runP1dHeadless(fixtureDirectory);
  const [issuesProjection, succeededProjection] =
    await Promise.all(
      ["issues", "succeeded"].map(async (name) =>
        JSON.parse(
          await readFile(
            path.join(
              fixtureDirectory,
              `${name}-projection.json`,
            ),
            "utf8",
          ),
        ),
      ),
    );
  if (issuesProjection.runId !== succeededProjection.runId) {
    throw new Error("browser acceptance projections belong to different runs");
  }

  let currentProjection = issuesProjection;
  const store = {
    runDirectory(runId) {
      if (runId !== currentProjection.runId) {
        throw new Error("browser acceptance run identity mismatch");
      }
      return watchDirectory;
    },
  };
  const controller = {
    async snapshotForRun(runId) {
      if (runId !== currentProjection.runId) {
        throw new Error("browser acceptance run identity mismatch");
      }
      return currentProjection;
    },
  };
  const sidecar = await startSidecar({
    runId: currentProjection.runId,
    host: HOST,
    port: 0,
    store,
    controller,
    heartbeatMs: 2_000,
  });

  const inlineToken = randomBytes(24).toString("base64url");
  const inlinePath = `/inline/${inlineToken}`;
  let inlinePort = null;
  const inlineServer = http.createServer((request, response) => {
    const expectedHost = `${HOST}:${inlinePort}`;
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      request.url !== inlinePath
    ) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; img-src data:; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(documentFor(issuesProjection));
  });
  inlineServer.maxHeadersCount = 32;
  inlineServer.requestTimeout = 10_000;
  inlineServer.headersTimeout = 10_000;
  inlinePort = await listen(inlineServer);

  let closed = false;
  async function advance() {
    currentProjection = succeededProjection;
    await writeFile(
      path.join(watchDirectory, "acceptance-update.json"),
      `${JSON.stringify({
        projectionDigest: succeededProjection.projectionDigest,
      })}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    const deadline = Date.now() + UPDATE_TIMEOUT_MS;
    while (
      sidecar.projection().projectionDigest !==
        succeededProjection.projectionDigest &&
      Date.now() < deadline
    ) {
      await delay(25);
    }
    if (
      sidecar.projection().projectionDigest !==
      succeededProjection.projectionDigest
    ) {
      throw Object.assign(
        new Error("sidecar did not observe the browser acceptance update"),
        { code: "SIDECAR_WATCH_TIMEOUT" },
      );
    }
    return {
      status: "advanced",
      projectionDigest: succeededProjection.projectionDigest,
      sidecarStats: sidecar.stats(),
    };
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    await Promise.all([
      sidecar.close(),
      closeServer(inlineServer),
    ]);
    await rm(temporary, {
      recursive: true,
      force: true,
    });
  }

  return {
    ready: {
      status: "ready",
      runId: issuesProjection.runId,
      inlineUrl: `http://${HOST}:${inlinePort}${inlinePath}`,
      sidecarLoginUrl: sidecar.loginUrl,
      issuesProjectionDigest: issuesProjection.projectionDigest,
      succeededProjectionDigest: succeededProjection.projectionDigest,
      tokenPolicy:
        "random inline path; one-time sidecar query token to independent session cookie",
    },
    advance,
    close,
  };
}

async function main() {
  const acceptance = await startGraphUiBrowserAcceptance();
  process.stdout.write(`${JSON.stringify(acceptance.ready)}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let buffer = "";
  let stopping = false;

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await acceptance.close();
    process.stdin.pause();
  };

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const command = line.trim();
      if (!command) {
        continue;
      }
      if (command === "advance") {
        acceptance
          .advance()
          .then((result) => {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          })
          .catch((error) => {
            process.stderr.write(
              `${String(error?.code ?? "ADVANCE_FAILED")}: ${error?.message ?? error}\n`,
            );
            process.exitCode = 1;
          });
      } else if (command === "close") {
        stop().catch((error) => {
          process.stderr.write(
            `${String(error?.code ?? "CLOSE_FAILED")}: ${error?.message ?? error}\n`,
          );
          process.exitCode = 1;
        });
      } else {
        process.stderr.write(`UNKNOWN_COMMAND: ${command}\n`);
        process.exitCode = 1;
      }
    }
  });
  process.once("SIGINT", () => {
    stop().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    stop().catch(() => {
      process.exitCode = 1;
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${String(error?.code ?? "BROWSER_ACCEPTANCE_FAILED")}: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
