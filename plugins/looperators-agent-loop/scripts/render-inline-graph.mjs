#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { sha256 } from "../lib/canonical-json.mjs";
import { LoopController } from "../lib/control.mjs";
import { renderGraphFragment } from "../lib/graph-view.mjs";
import { LoopStore } from "../lib/store.mjs";

export const MAX_INLINE_FRAGMENT_BYTES = 2 * 1024 * 1024;
const OUTPUT_NAME_PATTERN =
  /^looperators-agent-loop-[a-f0-9]{12}-r(?:0|[1-9]\d*)-[a-f0-9]{12}\.html$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const WRITER_OUTPUT_LIMIT = 8 * 1024;
const WRITER_TIMEOUT_MS = 10_000;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function unsafeRoot(message) {
  return Object.assign(new Error(message), {
    code: "UNSAFE_VISUALIZATION_ROOT",
  });
}

function unsafeOutput(message) {
  return Object.assign(new Error(message), {
    code: "UNSAFE_VISUALIZATION_OUTPUT",
  });
}

async function openVisualizationRoot(
  directory,
  { afterCanonicalPathCheck } = {},
) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = resolved.slice(parsed.root.length);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw unsafeRoot(
        "visualization root cannot contain symlink components",
      );
    }
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory()) {
    throw unsafeRoot(
      "visualization root must be an existing directory",
    );
  }
  if ((await realpath(resolved)) !== resolved) {
    throw unsafeRoot(
      "visualization root must use its canonical path",
    );
  }
  await afterCanonicalPathCheck?.();
  const handle = await open(
    resolved,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory()) {
      throw unsafeRoot(
        "visualization root must be an existing directory",
      );
    }
    const anchor = {
      path: resolved,
      handle,
      device: String(identity.dev),
      inode: String(identity.ino),
    };
    await assertCurrentRoot(anchor);
    return anchor;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertCurrentRoot(anchor) {
  let metadata;
  let canonical;
  try {
    metadata = await lstat(anchor.path, {
      bigint: true,
    });
    canonical = await realpath(anchor.path);
  } catch {
    throw unsafeRoot("visualization root identity changed");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    String(metadata.dev) !== anchor.device ||
    String(metadata.ino) !== anchor.inode ||
    canonical !== anchor.path
  ) {
    throw unsafeRoot("visualization root identity changed");
  }
}

function assertOutputTarget(root, output) {
  const relative = path.relative(root, output);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "."
  ) {
    throw unsafeOutput(
      "inline output must be directly contained by its root",
    );
  }
  if (!OUTPUT_NAME_PATTERN.test(path.basename(output))) {
    throw unsafeOutput("inline output basename is invalid");
  }
}

function assertFragmentContract(fragment) {
  const bytes = Buffer.byteLength(fragment, "utf8");
  if (bytes >= MAX_INLINE_FRAGMENT_BYTES) {
    throw Object.assign(
      new Error("inline fragment exceeds the 2 MiB bound"),
      { code: "INLINE_FRAGMENT_TOO_LARGE" },
    );
  }
  if (
    /<(?:!doctype|html|head|body)\b/iu.test(fragment) ||
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u.test(
      fragment,
    ) ||
    /(?:src|href)\s*=\s*["']https?:/iu.test(fragment)
  ) {
    throw Object.assign(
      new Error("inline fragment contains a forbidden shell or network API"),
      { code: "UNSAFE_INLINE_FRAGMENT" },
    );
  }
  return bytes;
}

async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes >= MAX_INLINE_FRAGMENT_BYTES) {
      throw Object.assign(
        new Error("anchored writer input exceeds its bound"),
        { code: "UNSAFE_INLINE_FRAGMENT" },
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function childError(stderr) {
  const code =
    stderr.match(/^([A-Z][A-Z0-9_]{0,63}):/u)?.[1] ??
    "INLINE_ANCHORED_WRITE_FAILED";
  return Object.assign(
    new Error("anchored inline writer rejected the output"),
    { code },
  );
}

async function childWriteFragment(
  anchor,
  outputName,
  fragment,
) {
  const contentDigest = sha256(
    Buffer.from(fragment, "utf8"),
  );
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--anchored-write",
        "--output-name",
        outputName,
        "--expected-device",
        anchor.device,
        "--expected-inode",
        anchor.inode,
        "--content-digest",
        contentDigest,
      ],
      {
        cwd: anchor.path,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const overflow = () => {
      child.kill("SIGKILL");
      finish(
        Object.assign(
          new Error("anchored inline writer output exceeded its bound"),
          { code: "INLINE_ANCHORED_WRITE_FAILED" },
        ),
      );
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (
        Buffer.byteLength(stdout, "utf8") >
        WRITER_OUTPUT_LIMIT
      ) {
        overflow();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (
        Buffer.byteLength(stderr, "utf8") >
        WRITER_OUTPUT_LIMIT
      ) {
        overflow();
      }
    });
    child.once("error", (error) => {
      finish(
        Object.assign(
          new Error("anchored inline writer could not start"),
          {
            code:
              error?.code === "ENOENT"
                ? "INLINE_ANCHORED_WRITE_UNAVAILABLE"
                : "INLINE_ANCHORED_WRITE_FAILED",
          },
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        finish(childError(stderr));
        return;
      }
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        finish(
          Object.assign(
            new Error("anchored inline writer returned invalid output"),
            { code: "INLINE_ANCHORED_WRITE_FAILED" },
          ),
        );
        return;
      }
      if (
        result?.status !== "written" ||
        result.outputName !== outputName ||
        result.bytes !==
          Buffer.byteLength(fragment, "utf8") ||
        result.contentDigest !== contentDigest
      ) {
        finish(
          Object.assign(
            new Error("anchored inline writer result did not match"),
            { code: "INLINE_ANCHORED_WRITE_FAILED" },
          ),
        );
        return;
      }
      finish();
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        Object.assign(
          new Error("anchored inline writer timed out"),
          { code: "INLINE_ANCHORED_WRITE_FAILED" },
        ),
      );
    }, WRITER_TIMEOUT_MS);
    timer.unref?.();
    child.stdin.on("error", () => {});
    child.stdin.end(fragment, "utf8");
  });
  await assertCurrentRoot(anchor);
}

async function anchoredWriteMain() {
  const outputName = argument("output-name");
  const expectedDevice = argument("expected-device");
  const expectedInode = argument("expected-inode");
  const expectedDigest = argument("content-digest");
  if (
    !OUTPUT_NAME_PATTERN.test(outputName ?? "") ||
    !/^\d+$/u.test(expectedDevice ?? "") ||
    !/^\d+$/u.test(expectedInode ?? "") ||
    !DIGEST_PATTERN.test(expectedDigest ?? "")
  ) {
    throw unsafeOutput("anchored writer arguments are invalid");
  }
  const directory = await stat(".", { bigint: true });
  if (
    !directory.isDirectory() ||
    String(directory.dev) !== expectedDevice ||
    String(directory.ino) !== expectedInode
  ) {
    throw unsafeRoot("visualization root identity changed");
  }
  const fragmentBuffer = await readBoundedStdin();
  if (
    fragmentBuffer.length >= MAX_INLINE_FRAGMENT_BYTES ||
    sha256(fragmentBuffer) !== expectedDigest
  ) {
    throw Object.assign(
      new Error("anchored writer input is invalid"),
      { code: "UNSAFE_INLINE_FRAGMENT" },
    );
  }
  const fragment = fragmentBuffer.toString("utf8");
  const bytes = assertFragmentContract(fragment);
  try {
    const existing = await lstat(outputName);
    if (
      existing.isSymbolicLink() ||
      !existing.isFile()
    ) {
      throw unsafeOutput(
        "inline output must be a regular file",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporary =
    `.${outputName}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(fragmentBuffer);
    await handle.sync();
    await rename(temporary, outputName);
    const metadata = await handle.stat({
      bigint: true,
    });
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777n) !== 0o600n
    ) {
      throw Object.assign(
        new Error("inline output read-back metadata is invalid"),
        { code: "INLINE_READBACK_FAILED" },
      );
    }
    const readBack = Buffer.alloc(fragmentBuffer.length);
    let offset = 0;
    while (offset < readBack.length) {
      const result = await handle.read(
        readBack,
        offset,
        readBack.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (
      offset !== fragmentBuffer.length ||
      !readBack.equals(fragmentBuffer)
    ) {
      throw Object.assign(
        new Error("inline output read-back differs from generated bytes"),
        { code: "INLINE_READBACK_FAILED" },
      );
    }
    const linked = await lstat(outputName, {
      bigint: true,
    });
    if (
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      linked.dev !== metadata.dev ||
      linked.ino !== metadata.ino
    ) {
      throw Object.assign(
        new Error("inline output path changed during read-back"),
        { code: "INLINE_READBACK_FAILED" },
      );
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "written",
      outputName,
      bytes,
      contentDigest: expectedDigest,
    })}\n`,
  );
}

export async function renderInlineGraph(options) {
  const anchor = await openVisualizationRoot(
    options.visualizationRoot,
    {
      afterCanonicalPathCheck:
        options.testHooks?.afterRootCanonicalPathCheck,
    },
  );
  try {
    const expectedTaskIds = [
      ...(options.expectedTaskId === undefined
        ? []
        : [options.expectedTaskId]),
      ...(options.expectedHostTaskId === undefined
        ? []
        : [options.expectedHostTaskId]),
    ];
    if (
      expectedTaskIds.some(
        (taskId) =>
          typeof taskId !== "string" ||
          taskId.length === 0 ||
          taskId.length > 512,
      ) ||
      (expectedTaskIds.length > 0 &&
        !expectedTaskIds.includes(path.basename(anchor.path)))
    ) {
      throw Object.assign(
        new Error(
          "visualization root does not belong to the current or delegated host task",
        ),
        { code: "VISUALIZATION_ROOT_MISMATCH" },
      );
    }
    if (
      options.expectedProjectionDigest !== undefined &&
      !DIGEST_PATTERN.test(options.expectedProjectionDigest)
    ) {
      throw Object.assign(
        new TypeError("expected projection digest is invalid"),
        { code: "INVALID_EXPECTED_DIGEST" },
      );
    }
    const controller =
      options.controller ??
      new LoopController(
        options.store ?? (await LoopStore.open()),
      );
    let projection = await controller.snapshotForRun(
      options.runId,
    );
    if (projection.runId !== options.runId) {
      throw Object.assign(
        new Error("snapshot belongs to another run"),
        { code: "SNAPSHOT_IDENTITY_MISMATCH" },
      );
    }
    let rereads = 0;
    let driftNote = "";
    if (
      options.expectedProjectionDigest &&
      projection.projectionDigest !==
        options.expectedProjectionDigest
    ) {
      projection = await controller.snapshotForRun(
        options.runId,
      );
      if (projection.runId !== options.runId) {
        throw Object.assign(
          new Error("snapshot belongs to another run"),
          { code: "SNAPSHOT_IDENTITY_MISMATCH" },
        );
      }
      rereads = 1;
      driftNote =
        "Snapshot advanced while rendering: expected " +
        options.expectedProjectionDigest.slice(0, 12) +
        ", rendered " +
        projection.projectionDigest.slice(0, 12) +
        ".";
    }
    const fragment = renderGraphFragment(projection, {
      mode: "inline",
      driftNote,
    });
    const bytes = assertFragmentContract(fragment);
    const outputName =
      `looperators-agent-loop-${sha256(projection.runId).slice(0, 12)}` +
      `-r${projection.revision}-${projection.projectionDigest.slice(0, 12)}.html`;
    const output = path.join(anchor.path, outputName);
    assertOutputTarget(anchor.path, output);
    await childWriteFragment(
      anchor,
      outputName,
      fragment,
    );
    return {
      output,
      outputName,
      bytes,
      projection,
      projectionDigest: projection.projectionDigest,
      snapshotIdentity: {
        runId: projection.runId,
        revision: projection.revision,
        eventWatermark: projection.eventWatermark,
      },
      rereads,
      drifted: Boolean(driftNote),
    };
  } finally {
    await anchor.handle.close();
  }
}

async function main() {
  const runId = argument("run-id");
  const visualizationRoot = argument("visualization-root");
  if (!runId || !visualizationRoot) {
    throw new Error(
      "Usage: render-inline-graph.mjs --run-id <id> --visualization-root <absolute-existing-directory> [--expected-projection-digest <sha256>]",
    );
  }
  if (!path.isAbsolute(visualizationRoot)) {
    throw unsafeRoot(
      "--visualization-root must be absolute",
    );
  }
  const result = await renderInlineGraph({
    runId,
    visualizationRoot,
    expectedProjectionDigest: argument(
      "expected-projection-digest",
    ),
  });
  process.stdout.write(
    `${JSON.stringify({
      output: result.output,
      outputName: result.outputName,
      bytes: result.bytes,
      projectionDigest: result.projectionDigest,
      snapshotIdentity: result.snapshotIdentity,
      rereads: result.rereads,
      drifted: result.drifted,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const entry = process.argv.includes("--anchored-write")
    ? anchoredWriteMain
    : main;
  entry().catch((error) => {
    process.stderr.write(
      `${String(error?.code ?? "RENDER_FAILED")}: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
