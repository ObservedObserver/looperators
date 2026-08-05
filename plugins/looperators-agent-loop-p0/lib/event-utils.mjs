import { createHash, timingSafeEqual } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const P0_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sensitiveSummary(value, label) {
  const serialized = typeof value === "string" ? value : stableJson(value);
  return {
    _redacted: label,
    sha256: sha256(serialized),
    bytes: Buffer.byteLength(serialized),
    ...(value && typeof value === "object" && !Array.isArray(value)
      ? { keys: Object.keys(value).sort() }
      : {}),
  };
}

export function redactHookInput(input) {
  const sensitiveKeys = new Set([
    "prompt",
    "last_assistant_message",
    "tool_input",
    "tool_response",
  ]);
  const walk = (value, key = "") => {
    if (sensitiveKeys.has(key)) {
      return sensitiveSummary(value, key);
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          walk(childValue, childKey),
        ]),
      );
    }
    return value;
  };
  return walk(input);
}

export function semanticEventKey(input) {
  return [
    input.session_id ?? "-",
    input.turn_id ?? "-",
    input.hook_event_name ?? "-",
    input.tool_use_id ?? input.agent_id ?? "-",
    input.stop_hook_active === true ? "continuation" : "initial",
  ].join(":");
}

export function deliveryEventKey(input, lane) {
  return `${semanticEventKey(input)}:${lane}`;
}

export async function atomicWriteJson(filePath, value, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  if (options.exclusive) {
    await writeFile(temporaryPath, body, { flag: "wx", mode: 0o600 });
    try {
      await link(temporaryPath, filePath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    return;
  }
  await writeFile(temporaryPath, body, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual ?? "");
  const expectedBuffer = Buffer.from(expected ?? "");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
