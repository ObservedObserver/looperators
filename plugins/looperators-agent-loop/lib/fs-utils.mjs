import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, compareCodePoints } from "./canonical-json.mjs";

export const MAX_STORE_JSON_BYTES = 2 * 1024 * 1024;

export class UnsafeStoreFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeStoreFileError";
    this.code = "UNSAFE_STORE_FILE";
  }
}

export class LockTimeoutError extends Error {
  constructor(message = "store lock timed out") {
    super(message);
    this.name = "LockTimeoutError";
    this.code = "STORE_LOCK_TIMEOUT";
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function assertContainedPath(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new UnsafeStoreFileError("store path escapes its data root");
  }
  return { rootPath, candidatePath, relative };
}

export async function ensureSafeDirectory(
  root,
  directory,
  options = {},
) {
  const { create = false } = options;
  const { rootPath, candidatePath, relative } = assertContainedPath(
    root,
    directory,
  );
  const rootMetadata = await lstat(rootPath);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new UnsafeStoreFileError(
      "store root must be a canonical directory",
    );
  }
  let current = rootPath;
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new UnsafeStoreFileError(
        "store path components must be real directories",
      );
    }
  }
  return candidatePath;
}

async function prepareParent(target, options = {}) {
  const directory = path.dirname(target);
  if (options.root) {
    await ensureSafeDirectory(options.root, directory, { create: true });
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return directory;
}

function encodeJson(value, maxBytes) {
  const encoded = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    const error = new RangeError("store JSON file exceeds the write limit");
    error.code = "STORE_FILE_TOO_LARGE";
    throw error;
  }
  return encoded;
}

async function writeTempJson(target, value, options = {}) {
  const {
    durable = true,
    maxBytes = MAX_STORE_JSON_BYTES,
  } = options;
  const encoded = encodeJson(value, maxBytes);
  const directory = await prepareParent(target, options);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    if (durable) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  return temporary;
}

async function publishExclusiveJson(target, value, options = {}) {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = await writeTempJson(target, value, {
    ...options,
    durable: false,
  });
  try {
    try {
      await link(temporary, target);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export async function readBoundedFile(file, options = {}) {
  const {
    maxBytes = MAX_STORE_JSON_BYTES,
    root,
  } = options;
  if (root) {
    await ensureSafeDirectory(root, path.dirname(file));
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new UnsafeStoreFileError(
        "store JSON path must be a regular file",
      );
    }
    if (metadata.size > maxBytes) {
      const error = new RangeError(
        "store JSON file exceeds the read limit",
      );
      error.code = "STORE_FILE_TOO_LARGE";
      throw error;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readJsonFile(file, options = {}) {
  const buffer = await readBoundedFile(file, options);
  return JSON.parse(buffer.toString("utf8"));
}

export async function atomicCreateJson(target, value, options = {}) {
  const {
    equivalent = (left, right) =>
      canonicalJson(left) === canonicalJson(right),
    root,
  } = options;
  const temporary = await writeTempJson(target, value, options);
  try {
    try {
      await link(temporary, target);
      await syncDirectory(path.dirname(target));
      return { status: "created", path: target };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const existing = await readJsonFile(target, { root });
      if (equivalent(existing, value)) {
        return { status: "duplicate", path: target, existing };
      }
      return { status: "conflict", path: target, existing };
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export async function atomicReplaceJson(target, value, options = {}) {
  const temporary = await writeTempJson(target, value, options);
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
    await syncDirectory(path.dirname(target));
    return { status: "replaced", path: target };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function listJsonFiles(directory, options = {}) {
  let entries;
  try {
    if (options.root) {
      await ensureSafeDirectory(options.root, directory);
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith(".") &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort(compareCodePoints);
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function restoreMovedGuard(quarantinePath, guardPath) {
  try {
    await link(quarantinePath, guardPath);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  } finally {
    await unlink(quarantinePath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function tryReclaimStaleGuard(guardPath, observed, options) {
  if (Date.now() - observed.mtimeMs <= options.staleMs) {
    return false;
  }
  let observedGuard = null;
  try {
    observedGuard = await readJsonFile(guardPath, {
      root: options.root,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
  }
  if (processIsAlive(observedGuard?.pid)) {
    return false;
  }
  const quarantinePath =
    `${guardPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(guardPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  let moved;
  let movedGuard = null;
  try {
    moved = await lstat(quarantinePath);
    try {
      movedGuard = await readJsonFile(quarantinePath, {
        root: options.root,
      });
    } catch {
      movedGuard = null;
    }
    const sameObservedGuard =
      moved.dev === observed.dev &&
      moved.ino === observed.ino &&
      (observedGuard?.token === undefined ||
        movedGuard?.token === observedGuard.token);
    if (!sameObservedGuard) {
      await restoreMovedGuard(quarantinePath, guardPath);
      return false;
    }
    await unlink(quarantinePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function tryReclaimStaleLock(
  lockPath,
  observed,
  options,
) {
  const guardPath = `${lockPath}.reclaim`;
  const guardToken = randomUUID();
  let ownsGuard = false;
  for (
    let attempt = 0;
    attempt < 2 && !ownsGuard;
    attempt += 1
  ) {
    ownsGuard = await publishExclusiveJson(
      guardPath,
      {
        schemaVersion: 1,
        token: guardToken,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      },
      { root: options.root },
    );
    if (!ownsGuard) {
      let guardMetadata;
      try {
        guardMetadata = await lstat(guardPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (
        await tryReclaimStaleGuard(
          guardPath,
          guardMetadata,
          options,
        )
      ) {
        continue;
      }
      return false;
    }
  }
  if (!ownsGuard) {
    return false;
  }

  let reclaimed;
  let reclaimError;
  try {
    reclaimed = await (async () => {
      let current;
      try {
        current = await lstat(lockPath);
      } catch (error) {
        return error?.code === "ENOENT";
      }
      if (
        current.dev !== observed.dev ||
        current.ino !== observed.ino ||
        Date.now() - current.mtimeMs <= options.staleMs
      ) {
        return false;
      }
      let ownerAlive = false;
      try {
        const lock = await readJsonFile(lockPath, { root: options.root });
        ownerAlive = processIsAlive(lock.pid);
      } catch (error) {
        if (error?.code === "ENOENT") {
          return true;
        }
      }
      if (ownerAlive) {
        return false;
      }
      let currentGuard;
      try {
        currentGuard = await readJsonFile(guardPath, {
          root: options.root,
        });
      } catch {
        return false;
      }
      if (
        currentGuard.token !== guardToken ||
        currentGuard.pid !== process.pid
      ) {
        return false;
      }
      const finalCurrent = await lstat(lockPath);
      if (
        finalCurrent.dev !== observed.dev ||
        finalCurrent.ino !== observed.ino
      ) {
        return false;
      }
      await unlink(lockPath);
      return true;
    })();
  } catch (error) {
    reclaimError = error;
  }

  let cleanupError;
  try {
    const currentGuard = await readJsonFile(guardPath, {
      root: options.root,
    });
    if (currentGuard.token === guardToken) {
      await unlink(guardPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && cleanupError === undefined) {
      cleanupError = error;
    }
  }
  if (reclaimError !== undefined) {
    throw reclaimError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return reclaimed;
}

export async function withFileLock(lockPath, callback, options = {}) {
  const {
    timeoutMs = 250,
    staleMs = 5_000,
    retryMs = 5,
    root,
  } = options;
  await prepareParent(lockPath, { root });
  const started = Date.now();
  const token = randomUUID();
  let acquired = false;
  while (!acquired) {
    acquired = await publishExclusiveJson(
      lockPath,
      {
        schemaVersion: 1,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      },
      { root },
    );
    if (!acquired) {
      try {
        const metadata = await lstat(lockPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new UnsafeStoreFileError(
            "store lock path must be a regular file",
          );
        }
        if (Date.now() - metadata.mtimeMs > staleMs) {
          const reclaimed = await tryReclaimStaleLock(
            lockPath,
            metadata,
            { staleMs, root },
          );
          if (reclaimed) {
            continue;
          }
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new LockTimeoutError();
      }
      await wait(retryMs);
    }
  }
  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }

  let cleanupError;
  try {
    const current = await readJsonFile(lockPath, { root });
    if (current.token === token) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && cleanupError === undefined) {
      cleanupError = error;
    }
  }

  if (callbackError !== undefined) {
    throw callbackError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return result;
}
