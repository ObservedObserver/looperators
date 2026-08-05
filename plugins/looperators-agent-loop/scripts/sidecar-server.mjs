#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch } from "node:fs";
import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  digestEqual,
  sha256,
} from "../lib/canonical-json.mjs";
import { LoopController } from "../lib/control.mjs";
import { renderSidecarDocument } from "../lib/graph-view.mjs";
import {
  MAX_PROJECTION_BYTES,
  assertGraphProjectionIntegrity,
  canonicalProjectionBytes,
} from "../lib/projection.mjs";
import { LoopStore } from "../lib/store.mjs";

const MAX_CLIENTS = 8;
const MAX_CONTROL_BYTES = 4096;
const HEARTBEAT_MS = 15_000;
const DEBOUNCE_MS = 75;
const SNAPSHOT_LOCK_TIMEOUT_MS = 100;
const TICKET_TTL_MS = 120_000;
const SAFE_INTEGRITY_CODES = new Set([
  "HISTORY_CORRUPT",
  "UNSUPPORTED_NATIVE_TARGET_HISTORY",
  "PROJECTION_TOO_LARGE",
]);
const CONTROL_ACTIONS = new Set(["pause", "resume", "cancel"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function tokenEqual(left, right) {
  const leftBytes = Buffer.from(String(left), "utf8");
  const rightBytes = Buffer.from(String(right), "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function parseCookies(header) {
  const result = new Map();
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    result.set(
      part.slice(0, separator).trim(),
      part.slice(separator + 1).trim(),
    );
  }
  return result;
}

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; " +
      "style-src 'unsafe-inline'; connect-src 'self'; " +
      "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; " +
      "form-action 'none'",
  };
}

function boundedIntegrityCode(error) {
  return SAFE_INTEGRITY_CODES.has(error?.code)
    ? error.code
    : "HISTORY_CORRUPT";
}

function ignoredWatchPath(fileName) {
  if (!fileName) return false;
  const normalized = String(fileName).replaceAll("\\", "/");
  return (
    normalized === "locks" ||
    normalized.startsWith("locks/") ||
    normalized.includes("/locks/") ||
    normalized.endsWith(".lock") ||
    normalized.endsWith(".reclaim") ||
    normalized.includes(".lock.") ||
    normalized.includes(".tmp-")
  );
}

function safetyPage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function publicControlResult(value) {
  return {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    status: value.status,
    revision: value.revision,
    currentLap: value.currentLap,
    lapCap: value.lapCap,
  };
}

export async function startSidecar(options) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (host !== "127.0.0.1") {
    throw Object.assign(
      new TypeError("sidecar host must be the literal 127.0.0.1"),
      { code: "SIDECAR_HOST_REJECTED" },
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw Object.assign(
      new TypeError("sidecar port must be an integer from 0 to 65535"),
      { code: "SIDECAR_PORT_REJECTED" },
    );
  }
  const ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;
  if (
    !Number.isInteger(ticketTtlMs) ||
    ticketTtlMs < 1_000 ||
    ticketTtlMs > 10 * 60_000
  ) {
    throw Object.assign(new TypeError("sidecar ticket TTL is invalid"), {
      code: "SIDECAR_TICKET_TTL_REJECTED",
    });
  }
  if (
    options.token !== undefined &&
    Buffer.byteLength(String(options.token), "utf8") < 32
  ) {
    throw Object.assign(
      new TypeError("sidecar ticket must contain at least 32 UTF-8 bytes"),
      { code: "SIDECAR_TOKEN_REJECTED" },
    );
  }
  const store = options.store ?? (await LoopStore.open());
  const controller = options.controller ?? new LoopController(store);
  const runId = options.runId;
  const basePath = `/runs/${encodeURIComponent(runId)}`;
  const cookieName = `looperators_loop_${sha256(runId).slice(0, 12)}`;
  const sessionSecret = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const tickets = new Map();
  let latestProjection = assertGraphProjectionIntegrity(
    await controller.snapshotForRun(runId, {
      lockTimeoutMs:
        options.snapshotLockTimeoutMs ?? SNAPSHOT_LOCK_TIMEOUT_MS,
    }),
  );
  if (latestProjection.runId !== runId) {
    throw Object.assign(
      new Error("sidecar snapshot belongs to another run"),
      { code: "SNAPSHOT_IDENTITY_MISMATCH" },
    );
  }
  let latestCanonical = canonicalProjectionBytes(latestProjection);
  let boundPort = null;
  let closed = false;
  let watcher = null;
  let debounceTimer = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let refreshPromise = null;
  const clients = new Set();
  const stats = {
    broadcasts: 0,
    unchanged: 0,
    busySkips: 0,
    integrityErrors: 0,
    slowClientsClosed: 0,
    controls: 0,
  };

  function exactOrigin() {
    return `http://${host}:${boundPort}`;
  }

  function issueTicket(candidate = undefined) {
    if (closed) {
      throw Object.assign(new Error("sidecar is closed"), {
        code: "SIDECAR_CLOSED",
      });
    }
    const ticket = candidate ?? randomBytes(32).toString("base64url");
    if (Buffer.byteLength(ticket, "utf8") < 32) {
      throw Object.assign(
        new TypeError("sidecar ticket must contain at least 32 UTF-8 bytes"),
        { code: "SIDECAR_TOKEN_REJECTED" },
      );
    }
    tickets.set(ticket, Date.now() + ticketTtlMs);
    return {
      ticket,
      expiresAt: new Date(Date.now() + ticketTtlMs).toISOString(),
      url: `${exactOrigin()}${basePath}?ticket=${encodeURIComponent(ticket)}`,
    };
  }

  function closeClient(response, slow = false) {
    clients.delete(response);
    if (slow) stats.slowClientsClosed += 1;
    response.end();
  }

  function writeSse(response, event, value, id = undefined) {
    const data = canonicalJson(value);
    if (Buffer.byteLength(data, "utf8") > MAX_PROJECTION_BYTES) {
      closeClient(response, true);
      return false;
    }
    const frame =
      `${id ? `id: ${id}\n` : ""}` +
      `event: ${event}\n` +
      `data: ${data}\n\n`;
    if (!response.write(frame)) {
      closeClient(response, true);
      return false;
    }
    return true;
  }

  function broadcastSnapshot(projection) {
    for (const response of [...clients]) {
      writeSse(
        response,
        "snapshot",
        projection,
        projection.projectionDigest,
      );
    }
    stats.broadcasts += 1;
  }

  function broadcastIntegrityError(error) {
    const payload = { code: boundedIntegrityCode(error) };
    for (const response of [...clients]) {
      writeSse(response, "integrity-error", payload);
    }
    stats.integrityErrors += 1;
  }

  async function refresh() {
    if (closed) return;
    refreshPromise ??= (async () => {
      try {
        const next = assertGraphProjectionIntegrity(
          await controller.snapshotForRun(runId, {
            lockTimeoutMs:
              options.snapshotLockTimeoutMs ?? SNAPSHOT_LOCK_TIMEOUT_MS,
          }),
        );
        if (next.runId !== runId) {
          throw Object.assign(
            new Error("sidecar snapshot belongs to another run"),
            { code: "SNAPSHOT_IDENTITY_MISMATCH" },
          );
        }
        const canonical = canonicalProjectionBytes(next);
        if (
          digestEqual(
            next.projectionDigest,
            latestProjection.projectionDigest,
          )
        ) {
          stats.unchanged += 1;
          return;
        }
        latestProjection = next;
        latestCanonical = canonical;
        broadcastSnapshot(latestProjection);
      } catch (error) {
        if (error?.code === "SNAPSHOT_BUSY") {
          stats.busySkips += 1;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            refresh().catch(() => {});
          }, DEBOUNCE_MS * 2);
          retryTimer.unref?.();
          return;
        }
        broadcastIntegrityError(error);
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function scheduleRefresh(fileName) {
    if (closed || ignoredWatchPath(fileName)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      refresh().catch(() => {});
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  function authenticated(request) {
    const cookie = parseCookies(request.headers.cookie).get(cookieName);
    return Boolean(cookie && tokenEqual(cookie, sessionSecret));
  }

  async function readControlBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_BYTES) {
        throw Object.assign(new Error("control body is too large"), {
          code: "CONTROL_BODY_TOO_LARGE",
          status: 413,
        });
      }
      chunks.push(chunk);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("control body is invalid"), {
        code: "INVALID_CONTROL_REQUEST",
        status: 400,
      });
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !CONTROL_ACTIONS.has(value.action) ||
      typeof value.requestId !== "string" ||
      !REQUEST_ID_PATTERN.test(value.requestId) ||
      Object.keys(value).some(
        (key) => !["action", "requestId"].includes(key),
      )
    ) {
      throw Object.assign(new Error("control body is invalid"), {
        code: "INVALID_CONTROL_REQUEST",
        status: 400,
      });
    }
    return value;
  }

  const server = http.createServer(async (request, response) => {
    const expectedHost = `${host}:${boundPort}`;
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, securityHeaders("text/plain; charset=utf-8"));
      response.end("Misdirected request\n");
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "/", exactOrigin());
    } catch {
      response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
      response.end("Bad request\n");
      return;
    }
    if (url.origin !== exactOrigin()) {
      response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
      response.end("Bad request\n");
      return;
    }

    const ticket = url.searchParams.get("ticket");
    if (ticket !== null) {
      const expiresAt = tickets.get(ticket);
      const exactTicketRoute =
        request.method === "GET" &&
        url.pathname === basePath &&
        url.searchParams.getAll("ticket").length === 1 &&
        [...url.searchParams.keys()].every((key) => key === "ticket");
      if (!exactTicketRoute || !expiresAt) {
        response.writeHead(401, securityHeaders("text/html; charset=utf-8"));
        response.end(
          safetyPage(
            "Review link unavailable",
            "Return to the looperators task and open the live review surface again.",
          ),
        );
        return;
      }
      tickets.delete(ticket);
      if (expiresAt < Date.now()) {
        response.writeHead(410, securityHeaders("text/html; charset=utf-8"));
        response.end(
          safetyPage(
            "Review link expired",
            "Return to the looperators task and request a fresh review link.",
          ),
        );
        return;
      }
      response.writeHead(303, {
        ...securityHeaders("text/plain; charset=utf-8"),
        Location: basePath,
        "Set-Cookie":
          `${cookieName}=${sessionSecret}; ` +
          `HttpOnly; SameSite=Strict; Path=${basePath}`,
      });
      response.end("Authenticated\n");
      return;
    }

    if (!authenticated(request)) {
      response.writeHead(401, securityHeaders("text/html; charset=utf-8"));
      response.end(
        safetyPage(
          "Review session unavailable",
          "Return to the looperators task and reopen the live review surface.",
        ),
      );
      return;
    }

    const eventsPath = `${basePath}/events`;
    const snapshotPath = `${basePath}/snapshot`;
    const controlPath = `${basePath}/control`;

    if (request.method === "GET" && url.pathname === basePath) {
      response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
      response.end(
        renderSidecarDocument(latestProjection, {
          eventsUrl: eventsPath,
          ...(options.onControl
            ? { controlUrl: controlPath, csrfToken }
            : {}),
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === snapshotPath) {
      response.writeHead(
        200,
        securityHeaders("application/json; charset=utf-8"),
      );
      response.end(`${latestCanonical}\n`);
      return;
    }
    if (request.method === "GET" && url.pathname === eventsPath) {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== exactOrigin()) {
        response.writeHead(403, securityHeaders("text/plain; charset=utf-8"));
        response.end("Origin rejected\n");
        return;
      }
      if (clients.size >= MAX_CLIENTS) {
        response.writeHead(503, securityHeaders("text/plain; charset=utf-8"));
        response.end("Too many clients\n");
        return;
      }
      response.writeHead(200, {
        ...securityHeaders("text/event-stream; charset=utf-8"),
        Connection: "keep-alive",
      });
      clients.add(response);
      const lastEventId = request.headers["last-event-id"];
      if (
        !lastEventId ||
        !digestEqual(
          String(lastEventId),
          latestProjection.projectionDigest,
        )
      ) {
        writeSse(
          response,
          "snapshot",
          latestProjection,
          latestProjection.projectionDigest,
        );
      } else if (!response.write(": current\n\n")) {
        closeClient(response, true);
      }
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === controlPath) {
      if (!options.onControl) {
        response.writeHead(503, securityHeaders("application/json; charset=utf-8"));
        response.end(`${canonicalJson({ code: "CONTROL_UNAVAILABLE" })}\n`);
        return;
      }
      if (
        request.headers.origin !== exactOrigin() ||
        !tokenEqual(request.headers["x-looperators-csrf"] ?? "", csrfToken) ||
        !String(request.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        response.writeHead(403, securityHeaders("application/json; charset=utf-8"));
        response.end(`${canonicalJson({ code: "CONTROL_FORBIDDEN" })}\n`);
        return;
      }
      try {
        const input = await readControlBody(request);
        const result = await options.onControl(input);
        stats.controls += 1;
        await refresh();
        response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
        response.end(`${canonicalJson(publicControlResult(result))}\n`);
      } catch (error) {
        const code =
          typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
            ? error.code
            : "CONTROL_FAILED";
        const status = Number.isInteger(error?.status) ? error.status : 409;
        response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
        response.end(`${canonicalJson({ code })}\n`);
      }
      return;
    }
    if (!["GET", "POST"].includes(request.method ?? "")) {
      response.writeHead(405, {
        ...securityHeaders("text/plain; charset=utf-8"),
        Allow: "GET, POST",
      });
      response.end("Method not allowed\n");
      return;
    }
    response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
    response.end("Not found\n");
  });
  server.maxHeadersCount = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

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
    server.listen(port, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("sidecar did not bind a TCP address");
  }
  boundPort = address.port;

  try {
    watcher = watch(
      store.runDirectory(runId),
      { recursive: true },
      (_eventType, fileName) => scheduleRefresh(fileName),
    );
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw error;
  }
  watcher.on("error", (error) => broadcastIntegrityError(error));
  heartbeatTimer = setInterval(() => {
    refresh().catch(() => {});
    for (const response of [...clients]) {
      if (!response.write(": heartbeat\n\n")) closeClient(response, true);
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  async function close() {
    if (closed) return;
    closed = true;
    tickets.clear();
    clearTimeout(debounceTimer);
    clearTimeout(retryTimer);
    clearInterval(heartbeatTimer);
    watcher?.close();
    for (const response of [...clients]) closeClient(response);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  const initialTicket = issueTicket(options.token);
  return {
    host,
    port: boundPort,
    origin: exactOrigin(),
    runId,
    basePath,
    loginUrl: initialTicket.url,
    loginToken: initialTicket.ticket,
    issueTicket,
    projection: () => latestProjection,
    canonicalProjection: () => latestCanonical,
    stats: () => ({ ...stats, clients: clients.size }),
    refresh,
    close,
  };
}

async function main() {
  const runId = argument("run-id");
  const host = argument("host", "127.0.0.1");
  const rawPort = argument("port", "0");
  if (!runId || !/^\d{1,5}$/u.test(rawPort)) {
    throw new Error(
      "Usage: sidecar-server.mjs --run-id <id> --host 127.0.0.1 --port <0-65535> [--token <32-byte-minimum>]",
    );
  }
  const sidecar = await startSidecar({
    runId,
    host,
    port: Number(rawPort),
    token: argument("token") ?? process.env.LOOPERATORS_SIDECAR_TOKEN,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      host: sidecar.host,
      port: sidecar.port,
      loginUrl: sidecar.loginUrl,
      tokenPolicy: "one-time-ticket-to-run-scoped-session-cookie",
    })}\n`,
  );
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await sidecar.close();
  };
  process.once("SIGINT", () => {
    shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${String(error?.code ?? "SIDECAR_FAILED")}: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
