import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { homedir as systemHomeDirectory } from "node:os";
import path from "node:path";
import { digestJson } from "./canonical-json.mjs";
import { atomicCreateJson, readJsonFile } from "./fs-utils.mjs";

const MARKER_FILE = ".looperators-store-v1.json";
const PRODUCT_DIRECTORY = [
  "looperators",
  "codex-agent-loop",
  "v1",
];

export class DataRootUnavailableError extends Error {
  constructor(message = "no supported looperators data root is available") {
    super(message);
    this.name = "DataRootUnavailableError";
    this.code = "DATA_ROOT_UNAVAILABLE";
  }
}

export class DataRootSplitError extends Error {
  constructor(message = "hook and MCP data roots do not agree") {
    super(message);
    this.name = "DataRootSplitError";
    this.code = "DATA_ROOT_SPLIT";
  }
}

export class InvalidDataRootError extends Error {
  constructor(message = "looperators data root is invalid") {
    super(message);
    this.name = "InvalidDataRootError";
    this.code = "INVALID_DATA_ROOT";
  }
}

function requireAbsolute(value, name) {
  if (!path.isAbsolute(value)) {
    throw new InvalidDataRootError(`${name} must be an absolute path`);
  }
}

function requirePlatformBase(value, pathImplementation) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !pathImplementation.isAbsolute(value)
  ) {
    throw new DataRootUnavailableError(
      "no absolute platform data directory is available",
    );
  }
  return value;
}

function resolveHomeDirectory(options, env) {
  const configured = options.homeDirectory ?? env.HOME;
  if (configured) {
    return configured;
  }
  try {
    return (
      options.systemHomeDirectory?.() ??
      systemHomeDirectory()
    );
  } catch {
    return undefined;
  }
}

export function defaultDataRoot(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathImplementation =
    options.pathImplementation ??
    (platform === "win32" ? path.win32 : path);
  let base;
  if (platform === "darwin") {
    base = pathImplementation.join(
      requirePlatformBase(
        resolveHomeDirectory(options, env),
        pathImplementation,
      ),
      "Library",
      "Application Support",
    );
  } else if (platform === "win32") {
    base = requirePlatformBase(
      options.localAppData ?? env.LOCALAPPDATA,
      pathImplementation,
    );
  } else {
    const xdgDataHome =
      options.xdgDataHome ?? env.XDG_DATA_HOME;
    base = xdgDataHome
      ? requirePlatformBase(xdgDataHome, pathImplementation)
      : pathImplementation.join(
          requirePlatformBase(
            resolveHomeDirectory(options, env),
            pathImplementation,
          ),
          ".local",
          "share",
        );
  }
  return pathImplementation.join(base, ...PRODUCT_DIRECTORY);
}

function validateMarker(marker) {
  if (
    marker?.schemaVersion !== 1 ||
    marker?.storeVersion !== 1 ||
    typeof marker?.instanceId !== "string" ||
    marker.instanceId.length < 16
  ) {
    throw new InvalidDataRootError("data-root marker is malformed");
  }
  return marker;
}

async function writeDataRootSplitDiagnostic(root, details) {
  const fingerprint = digestJson({
    kind: "data_root_split",
    details,
  });
  const diagnostic = {
    schemaVersion: 1,
    diagnosticId: `data_root_split_${fingerprint}`,
    kind: "data_root_split",
    severity: "error",
    details,
    createdAt: new Date().toISOString(),
  };
  try {
    await atomicCreateJson(
      path.join(
        root,
        "diagnostics",
        "data-root-split",
        `${fingerprint}.json`,
      ),
      diagnostic,
      {
        equivalent: (left) =>
          left?.diagnosticId === diagnostic.diagnosticId,
        root,
      },
    );
  } catch {
    // The resolver must still reject a split root when the best-effort
    // diagnostic cannot be persisted.
  }
}

export async function resolveDataRoot(options = {}) {
  const {
    env = process.env,
    expectedInstanceId,
    create = true,
    platform = process.platform,
  } = options;
  const explicit = env.LOOPERATORS_DATA_DIR;
  if (explicit) {
    requireAbsolute(explicit, "LOOPERATORS_DATA_DIR");
  }
  const selectedValue =
    explicit ??
    defaultDataRoot({
      ...options,
      env,
      platform,
    });
  const source = explicit
    ? "LOOPERATORS_DATA_DIR"
    : "looperators-platform-data";
  let createdDirectory;
  if (create) {
    createdDirectory = await mkdir(selectedValue, {
      recursive: true,
      mode: 0o700,
    });
  }
  let root;
  try {
    root = await realpath(selectedValue);
  } catch (error) {
    if (error?.code === "ENOENT" && !create) {
      throw new DataRootUnavailableError(
        "looperators data root has not been initialized",
      );
    }
    throw error;
  }
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    throw new InvalidDataRootError("data root must be a directory");
  }
  if (
    create &&
    createdDirectory &&
    !explicit &&
    platform !== "win32"
  ) {
    await chmod(root, 0o700);
  }
  const markerPath = path.join(root, MARKER_FILE);
  let marker;
  if (create) {
    const candidate = {
      schemaVersion: 1,
      storeVersion: 1,
      instanceId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const published = await atomicCreateJson(markerPath, candidate, {
      equivalent: (left) =>
        left?.schemaVersion === 1 &&
        left?.storeVersion === 1 &&
        typeof left?.instanceId === "string",
      root,
    });
    marker =
      published.status === "created"
        ? candidate
        : validateMarker(await readJsonFile(markerPath, { root }));
  } else {
    try {
      marker = validateMarker(
        await readJsonFile(markerPath, { root }),
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new DataRootUnavailableError(
          "looperators data root marker is unavailable",
        );
      }
      throw error;
    }
  }
  validateMarker(marker);
  if (expectedInstanceId && marker.instanceId !== expectedInstanceId) {
    await writeDataRootSplitDiagnostic(root, {
      reason: "instance-marker-mismatch",
      expectedInstanceIdDigest: digestJson({
        instanceId: expectedInstanceId,
      }),
      actualInstanceIdDigest: digestJson({
        instanceId: marker.instanceId,
      }),
    });
    throw new DataRootSplitError("data-root instance marker does not match");
  }
  return {
    path: root,
    source,
    marker,
    instanceIdDigest: digestJson({ instanceId: marker.instanceId }),
  };
}

export function dataRootEnvironmentSummary(env = process.env) {
  return {
    explicitPresent: Boolean(env.LOOPERATORS_DATA_DIR),
    pluginDataPresent: Boolean(env.PLUGIN_DATA),
  };
}
