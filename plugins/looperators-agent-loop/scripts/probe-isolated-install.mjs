#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  compareCodePoints,
  sha256,
} from "../lib/canonical-json.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";

const run = promisify(execFile);
const MARKETPLACE = "looperators-p0";
const PLUGIN_NAME = "looperators-agent-loop";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;
const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PLUGIN_VERSION = JSON.parse(
  await readFile(
    path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
    "utf8",
  ),
).version;
export const ISOLATED_ENV_ALLOWLIST = Object.freeze([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
]);

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function treeManifest(root) {
  const entries = [];
  async function walk(current) {
    for (const entry of await readdir(current, {
      withFileTypes: true,
    })) {
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `install comparison rejects symlink: ${relative}`,
        );
      }
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        const metadata = await lstat(target);
        const bytes = await readFile(target);
        entries.push({
          path: relative,
          bytes: metadata.size,
          digest: sha256(bytes),
        });
      } else {
        throw new Error(
          `install comparison rejects special file: ${relative}`,
        );
      }
    }
  }
  await walk(root);
  entries.sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
  return {
    entries,
    digest: sha256(canonicalJson(entries)),
  };
}

export function isolatedCommandEnvironment(
  codexHome,
  parentEnvironment = process.env,
) {
  const environment = { CODEX_HOME: codexHome };
  for (const name of ISOLATED_ENV_ALLOWLIST) {
    const value = parentEnvironment[name];
    if (typeof value === "string" && value.length > 0) {
      environment[name] = value;
    }
  }
  return environment;
}

function parsedJson(stdout) {
  try {
    return { valid: true, value: JSON.parse(stdout) };
  } catch {
    return { valid: false, value: null };
  }
}

export function inspectPluginCommandOutputs(input) {
  const add = parsedJson(input.addStdout);
  const list = parsedJson(input.listStdout);
  const installed =
    list.valid && Array.isArray(list.value?.installed)
      ? list.value.installed
      : [];
  const matches = installed.filter(
    (record) => record?.pluginId === PLUGIN_ID,
  );
  const record = matches.length === 1 ? matches[0] : null;
  const normalizedSource = record?.source?.path
    ? path.normalize(record.source.path)
    : null;
  const normalizedMarketplace =
    record?.marketplaceSource?.source
      ? path.normalize(record.marketplaceSource.source)
      : null;
  const addMatches =
    add.valid &&
    add.value?.pluginId === PLUGIN_ID &&
    add.value?.name === PLUGIN_NAME &&
    add.value?.marketplaceName === MARKETPLACE &&
    add.value?.version === PLUGIN_VERSION;
  const listMatches =
    list.valid &&
    matches.length === 1 &&
    record?.name === PLUGIN_NAME &&
    record?.marketplaceName === MARKETPLACE &&
    record?.version === PLUGIN_VERSION &&
    record?.installed === true &&
    record?.enabled === true &&
    record?.source?.source === "local" &&
    normalizedSource === path.normalize(input.sourceRoot) &&
    record?.marketplaceSource?.sourceType === "local" &&
    normalizedMarketplace ===
      path.normalize(input.repoRoot);
  return {
    passed: Boolean(addMatches && listMatches),
    addJsonValid: add.valid,
    addMatches,
    listJsonValid: list.valid,
    exactRecordCount: matches.length,
    listMatches,
    enabled: record?.enabled === true,
    installed: record?.installed === true,
    versionMatches: record?.version === PLUGIN_VERSION,
    sourceMatches:
      record?.source?.source === "local" &&
      normalizedSource === path.normalize(input.sourceRoot),
    marketplaceSourceMatches:
      record?.marketplaceSource?.sourceType === "local" &&
      normalizedMarketplace ===
        path.normalize(input.repoRoot),
  };
}

async function codexCommand(binary, codexHome, args) {
  return run(binary, args, {
    env: isolatedCommandEnvironment(codexHome),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function main(argv = process.argv) {
  const output = argument("output", argv);
  if (!output || !path.isAbsolute(output)) {
    throw new TypeError("--output must be absolute");
  }
  const binary =
    argument("codex", argv) ??
    "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (!path.isAbsolute(binary)) {
    throw new TypeError("--codex must be absolute");
  }
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const sourceRoot = path.join(
    repoRoot,
    "plugins",
    PLUGIN_NAME,
  );
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p1e-install-"),
  );
  try {
    const versionResult = await codexCommand(
      binary,
      temporary,
      ["--version"],
    );
    await codexCommand(binary, temporary, [
      "plugin",
      "marketplace",
      "add",
      repoRoot,
    ]);
    const addResult = await codexCommand(
      binary,
      temporary,
      ["plugin", "add", PLUGIN_ID, "--json"],
    );
    const listResult = await codexCommand(
      binary,
      temporary,
      ["plugin", "list", "--json"],
    );
    const inspection = inspectPluginCommandOutputs({
      addStdout: addResult.stdout,
      listStdout: listResult.stdout,
      repoRoot,
      sourceRoot,
    });
    const installedRoot = path.join(
      temporary,
      "plugins",
      "cache",
      MARKETPLACE,
      PLUGIN_NAME,
      PLUGIN_VERSION,
    );
    const [source, installed] = await Promise.all([
      treeManifest(sourceRoot),
      treeManifest(installedRoot),
    ]);
    const treeMatches =
      source.digest === installed.digest &&
      canonicalJson(source.entries) ===
        canonicalJson(installed.entries);
    const passed = inspection.passed && treeMatches;
    const evidence = {
      schemaVersion: 1,
      probe: "p1e-isolated-plugin-install",
      capturedAt: new Date().toISOString(),
      passed,
      desktopRestarted: false,
      globalConfigModified: false,
      isolation: {
        temporaryCodexHome: true,
        codexHomePathRecorded: false,
        cleanedAfterProbe: true,
        inheritedCredentialVariables: false,
        environmentAllowlist: [
          "CODEX_HOME",
          ...ISOLATED_ENV_ALLOWLIST,
        ],
      },
      codex: {
        lane: "desktop-bundled",
        version: versionResult.stdout.trim(),
      },
      marketplace: {
        name: MARKETPLACE,
        added: true,
      },
      plugin: {
        pluginId: PLUGIN_ID,
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        addReturnedJson: inspection.addJsonValid,
        addMatches: inspection.addMatches,
        listReturnedJson: inspection.listJsonValid,
        exactListRecordCount:
          inspection.exactRecordCount,
        listed: inspection.listMatches,
        installed: inspection.installed,
        enabled: inspection.enabled,
        versionMatches: inspection.versionMatches,
        sourceMatches: inspection.sourceMatches,
        marketplaceSourceMatches:
          inspection.marketplaceSourceMatches,
        sourceMatchesInstalledCache: treeMatches,
        fileCount: source.entries.length,
        sourceTreeDigest: source.digest,
        installedTreeDigest: installed.digest,
      },
      commands: [
        "env -i <allowlist> CODEX_HOME=<temporary> <desktop-bundled-codex> --version",
        "env -i <allowlist> CODEX_HOME=<temporary> <desktop-bundled-codex> plugin marketplace add <repo>",
        `env -i <allowlist> CODEX_HOME=<temporary> <desktop-bundled-codex> plugin add ${PLUGIN_ID} --json`,
        "env -i <allowlist> CODEX_HOME=<temporary> <desktop-bundled-codex> plugin list --json",
        `compare canonical source tree with plugins/cache/${MARKETPLACE}/${PLUGIN_NAME}/${PLUGIN_VERSION}`,
      ],
    };
    await atomicReplaceJson(output, evidence);
    process.stdout.write(
      `${JSON.stringify({
        passed,
        output,
        version: evidence.codex.version,
        fileCount: evidence.plugin.fileCount,
        treeDigest: evidence.plugin.sourceTreeDigest,
      })}\n`,
    );
    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
    });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  await main();
}
