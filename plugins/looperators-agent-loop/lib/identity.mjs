import { randomBytes } from "node:crypto";
import {
  canonicalJson,
  compareCodePoints,
  digestEqual,
  digestJson,
  sha256,
} from "./canonical-json.mjs";
import {
  SCHEMA_VERSION,
  assertContract,
  validateIdentityBinding,
} from "./contracts.mjs";

const THREAD_KEYS = new Set([
  "threadid",
  "sessionid",
  "codexthreadid",
  "codexsessionid",
  "openaithreadid",
  "openaisessionid",
]);
const TURN_KEYS = new Set([
  "turnid",
  "codexturnid",
  "openaiturnid",
]);
const AGENT_KEYS = new Set([
  "agentid",
  "codexagentid",
  "openaiagentid",
]);
const TRUSTED_HOST_METADATA_FIELDS = new Map([
  ["params.threadId", "thread"],
  ["params.x-codex-turn-metadata.session_id", "thread"],
  ["params.x-codex-turn-metadata.thread_id", "thread"],
  ["params.x-codex-turn-metadata.parent_thread_id", "thread"],
  ["params.x-codex-turn-metadata.forked_from_thread_id", "thread"],
  ["params.x-codex-turn-metadata.turn_id", "turn"],
  ["params.x-codex-turn-metadata.agent_id", "agent"],
]);
const HOST_IDENTITY_PROOF = Symbol("looperators.host-identity-proof");

function normalizedKey(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function valueType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function flattenMetadata(value, prefix = "", depth = 0, output = []) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    depth > 3
  ) {
    return output;
  }
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const item = value[key];
    output.push({ key: fullKey, type: valueType(item) });
    if (item && typeof item === "object" && !Array.isArray(item)) {
      flattenMetadata(item, fullKey, depth + 1, output);
    }
  }
  return output;
}

function candidateValues(value, prefix = "", depth = 0, output = []) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    depth > 3
  ) {
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const kind = TRUSTED_HOST_METADATA_FIELDS.get(fullKey);
    if (
      kind &&
      (typeof item === "string" || typeof item === "number")
    ) {
      output.push({
        kind,
        key: fullKey,
        type: typeof item,
        valueDigest: digestJson({ key: fullKey, value: String(item) }),
      });
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      candidateValues(item, fullKey, depth + 1, output);
    }
  }
  return output;
}

function identityClaimKeys(argumentsValue) {
  if (
    argumentsValue === null ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  ) {
    return [];
  }
  return Object.keys(argumentsValue)
    .filter((key) => {
      const normalized = normalizedKey(key);
      return (
        [...THREAD_KEYS, ...TURN_KEYS, ...AGENT_KEYS].includes(normalized) ||
        normalized === "fromnode"
      );
    })
    .sort(compareCodePoints);
}

export function summarizeMcpIdentity(message) {
  const metadata = {
    ...(message?._meta && typeof message._meta === "object"
      ? { request: message._meta }
      : {}),
    ...(message?.params?._meta && typeof message.params._meta === "object"
      ? { params: message.params._meta }
      : {}),
  };
  const shape = flattenMetadata(metadata);
  const candidates = candidateValues(metadata).sort((left, right) =>
    compareCodePoints(
      `${left.kind}:${left.key}`,
      `${right.kind}:${right.key}`,
    ),
  );
  const kinds = new Set(candidates.map((candidate) => candidate.kind));
  const trustedIdentityAvailable = kinds.has("thread") && kinds.has("agent");
  const turnMetadata = message?.params?._meta?.["x-codex-turn-metadata"];
  const threadSource =
    typeof turnMetadata?.thread_source === "string"
      ? turnMetadata.thread_source.slice(0, 128)
      : undefined;
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    classification: trustedIdentityAvailable
      ? "host-metadata-v1"
      : "trusted_identity_unavailable",
    trustedIdentityAvailable,
    metadataShape: shape,
    candidateFields: candidates,
    ...(threadSource ? { contextHints: { threadSource } } : {}),
    untrustedArgumentIdentityClaims: identityClaimKeys(
      message?.params?.arguments,
    ),
  };
  for (const candidate of summary.candidateFields) {
    Object.freeze(candidate);
  }
  Object.freeze(summary.candidateFields);
  Object.defineProperty(summary, HOST_IDENTITY_PROOF, {
    value: digestJson({
      schemaVersion: summary.schemaVersion,
      classification: summary.classification,
      trustedIdentityAvailable: summary.trustedIdentityAvailable,
      candidateFields: summary.candidateFields,
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(summary);
  return summary;
}

export class CapabilityAlreadyIssuedError extends Error {
  constructor() {
    super("a capability binding already exists for this agent");
    this.name = "CapabilityAlreadyIssuedError";
    this.code = "CAPABILITY_ALREADY_ISSUED";
  }
}

export class AgentNotObservedError extends Error {
  constructor(message = "agent was not observed by a SubagentStart hook") {
    super(message);
    this.name = "AgentNotObservedError";
    this.code = "AGENT_NOT_OBSERVED";
  }
}

export async function issueRunCapability(store, input) {
  const {
    runId,
    agentId,
    rootSessionId,
    role,
    requestId,
    requestDigest,
    observationId,
    originEventId,
    createdAt = new Date().toISOString(),
  } = input;
  const state = await store.readState(runId);
  if (state.rootSessionId !== rootSessionId) {
    throw new AgentNotObservedError(
      "capability root does not match the authoritative run",
    );
  }
  const observed = await store.findObservedSubagentStart(
    runId,
    rootSessionId,
    agentId,
  );
  if (!observed) {
    throw new AgentNotObservedError();
  }
  try {
    await store.readIdentityBinding(runId, agentId);
    throw new CapabilityAlreadyIssuedError();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const token = randomBytes(32).toString("base64url");
  const binding = assertContract(
    "identity binding",
    {
      schemaVersion: SCHEMA_VERSION,
      bindingId: `binding_${sha256(
        canonicalJson({ runId, agentId }),
      )}`,
      runId,
      agentId,
      rootSessionId,
      method: "capability-token-v1",
      tokenDigest: sha256(token),
      ...(role ? { role } : {}),
      ...(requestId ? { requestId } : {}),
      ...(requestDigest ? { requestDigest } : {}),
      ...(observationId ? { observationId } : {}),
      ...(originEventId ? { originEventId } : {}),
      createdAt,
    },
    validateIdentityBinding,
  );
  const result = await store.putIdentityBinding(runId, binding);
  if (result.status !== "created") {
    throw new CapabilityAlreadyIssuedError();
  }
  return {
    token,
    binding: {
      ...binding,
      tokenDigest: binding.tokenDigest,
    },
  };
}

export async function bindHostIdentity(store, input) {
  const {
    runId,
    agentId,
    rootSessionId,
    identitySummary,
    createdAt = new Date().toISOString(),
  } = input;
  if (
    identitySummary?.classification !== "host-metadata-v1" ||
    identitySummary?.trustedIdentityAvailable !== true ||
    !Array.isArray(identitySummary?.candidateFields)
  ) {
    const error = new TypeError("trusted host metadata is unavailable");
    error.code = "TRUSTED_IDENTITY_UNAVAILABLE";
    throw error;
  }
  const candidateFields = identitySummary.candidateFields.map(
    (candidate) => ({ ...candidate }),
  );
  const expectedProof = digestJson({
    schemaVersion: identitySummary.schemaVersion,
    classification: identitySummary.classification,
    trustedIdentityAvailable: identitySummary.trustedIdentityAvailable,
    candidateFields,
  });
  if (identitySummary[HOST_IDENTITY_PROOF] !== expectedProof) {
    const error = new TypeError("trusted host metadata is unavailable");
    error.code = "TRUSTED_IDENTITY_UNAVAILABLE";
    throw error;
  }
  const state = await store.readState(runId);
  if (state.rootSessionId !== rootSessionId) {
    throw new AgentNotObservedError(
      "host identity root does not match the authoritative run",
    );
  }
  const observed = await store.findObservedSubagentStart(
    runId,
    rootSessionId,
    agentId,
  );
  if (!observed) {
    throw new AgentNotObservedError();
  }
  const agentMatches = candidateFields.some(
    (candidate) =>
      candidate?.kind === "agent" &&
      candidate?.key ===
        "params.x-codex-turn-metadata.agent_id" &&
      candidate?.valueDigest ===
        digestJson({
          key: candidate.key,
          value: String(agentId),
        }),
  );
  const rootMatches = candidateFields.some(
    (candidate) =>
      candidate?.kind === "thread" &&
      candidate?.valueDigest ===
        digestJson({
          key: candidate.key,
          value: String(rootSessionId),
        }),
  );
  if (!agentMatches || !rootMatches) {
    const error = new TypeError(
      "host identity metadata does not match the observed agent lineage",
    );
    error.code = "HOST_IDENTITY_MISMATCH";
    throw error;
  }
  const binding = assertContract(
    "identity binding",
    {
      schemaVersion: SCHEMA_VERSION,
      bindingId: `binding_${sha256(
        canonicalJson({ runId, agentId }),
      )}`,
      runId,
      agentId,
      rootSessionId,
      method: "host-metadata-v1",
      hostIdentityDigest: digestJson(candidateFields),
      createdAt,
    },
    validateIdentityBinding,
  );
  const result = await store.putIdentityBinding(runId, binding);
  if (result.status === "conflict") {
    const error = new TypeError("host identity binding conflicts");
    error.code = "IDENTITY_BINDING_CONFLICT";
    throw error;
  }
  return binding;
}

export async function verifyRunCapability(store, input) {
  const { runId, agentId, token } = input;
  if (typeof token !== "string" || token.length < 32) {
    return false;
  }
  let binding;
  let state;
  try {
    [binding, state] = await Promise.all([
      store.readIdentityBinding(runId, agentId),
      store.readState(runId),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (
    binding.runId !== runId ||
    state.runId !== runId ||
    binding.rootSessionId !== state.rootSessionId ||
    binding.method !== "capability-token-v1" ||
    binding.revokedAt !== undefined
  ) {
    return false;
  }
  return digestEqual(binding.tokenDigest, sha256(token));
}
