import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  compareCodePoints,
  digestJson,
  sha256,
} from "./canonical-json.mjs";
import {
  ACTIVE_RUN_STATUSES,
  SCHEMA_VERSION,
  SEMANTIC_KEY_VERSION,
  STORE_VERSION,
  assertContract,
  assertSafeFileId,
  createInterruptedRun,
  isWorkerObservationEvent,
  validateGovernorDecision,
  validateIdentityBinding,
  validateLegacyQuarantineReceipt,
  validateLoopDefinition,
  validateLoopOperation,
  validateLoopReport,
  validateLoopRun,
  validateLoopTransition,
  validateNormalizedHookEvent,
  validateWorkerObservation,
} from "./contracts.mjs";
import { resolveDataRoot } from "./data-root.mjs";
import {
  atomicCreateJson,
  atomicReplaceJson,
  listJsonFiles,
  readBoundedFile,
  readJsonFile,
  withFileLock,
} from "./fs-utils.mjs";
import {
  recoveryIdFor,
  recoveryRequestDigest,
} from "./recovery.mjs";

export const DEFAULT_RETENTION = Object.freeze({
  definitions: 1,
  events: 1_000,
  operations: 1_000,
  observations: 8,
  reports: 250,
  transitions: 250,
  "governor-decisions": 250,
  recoveries: 8,
  diagnostics: 250,
  terminalBytes: 8 * 1024 * 1024,
  activeMultiplier: 4,
  timeline: 32,
});

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "capped",
  "cancelled",
  "failed",
]);

const HOOK_COLLECTION_STATUSES = new Set([
  "running",
  "paused",
  "interrupted",
]);

// A burst of independent hook processes can all miss the optimistic read
// before one of them publishes the fact. Keep the uncontended path lock-free,
// but give the serialized retention check enough time to survive scheduler
// pressure without dropping otherwise valid events.
const FACT_LOCK_TIMEOUT_MS = 1_000;
const SAFETY_RECEIPT_RESERVE = 8;
const LEGACY_FOLD_PROJECTION_VERSION = 1;

export class InvalidStateTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidStateTransitionError";
    this.code = "INVALID_STATE_TRANSITION";
  }
}

export class StoreConflictError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "StoreConflictError";
    this.code = "STORE_CONFLICT";
    this.details = details;
  }
}

export class RevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`state revision mismatch: expected ${expected}, received ${actual}`);
    this.name = "RevisionConflictError";
    this.code = "REVISION_CONFLICT";
    this.expected = expected;
    this.actual = actual;
  }
}

function factTime(kind, value) {
  if (kind === "events") {
    return value.observedAt;
  }
  return value.createdAt;
}

function factId(kind, value) {
  if (kind === "definitions") {
    return value.definitionId;
  }
  if (kind === "events") {
    return value.eventId;
  }
  if (kind === "reports") {
    return value.reportId;
  }
  if (kind === "transitions") {
    return value.transitionId;
  }
  if (kind === "operations") {
    return value.operationId;
  }
  if (kind === "governor-decisions") {
    return value.decisionId;
  }
  if (kind === "recoveries") {
    return value.recoveryId;
  }
  if (kind === "observations") {
    return value.observationId;
  }
  return value.diagnosticId;
}

function validatorFor(kind) {
  if (kind === "definitions") {
    return validateLoopDefinition;
  }
  if (kind === "events") {
    return validateNormalizedHookEvent;
  }
  if (kind === "reports") {
    return validateLoopReport;
  }
  if (kind === "transitions") {
    return validateLoopTransition;
  }
  if (kind === "identity") {
    return validateIdentityBinding;
  }
  if (kind === "operations") {
    return validateLoopOperation;
  }
  if (kind === "governor-decisions") {
    return validateGovernorDecision;
  }
  if (kind === "recoveries") {
    return validateLegacyQuarantineReceipt;
  }
  if (kind === "observations") {
    return validateWorkerObservation;
  }
  throw new TypeError(`unsupported fact kind: ${kind}`);
}

function assertWorkerObservationIntegrity(
  observation,
  runId,
  file = undefined,
) {
  assertContract(
    "worker observation",
    observation,
    validateWorkerObservation,
  );
  const expectedId = `observation_${sha256(
    canonicalJson({
      runId,
      requestId: observation.requestId,
      kind: "prepare-worker-spawn",
    }),
  )}`;
  const expectedDigest = digestJson({
    spawnToolUseIds: observation.spawnToolUseIds,
    subagentStartEventIds:
      observation.subagentStartEventIds,
    bindingIds: observation.bindingIds,
  });
  const expectedRequestDigest = digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: "prepare-worker-spawn",
    runId,
    requestId: observation.requestId,
    rootSessionId: observation.rootSessionId,
    role: observation.role,
  });
  if (
    observation.runId !== runId ||
    observation.observationId !== expectedId ||
    observation.requestDigest !== expectedRequestDigest ||
    observation.observationDigest !== expectedDigest ||
    (file &&
      path.basename(file) !==
        `${observation.observationId}.json`)
  ) {
    const error = new TypeError(
      "worker observation identity, digest, or location is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return observation;
}

function assertLoopDefinitionIntegrity(
  definition,
  runId,
  file = undefined,
) {
  assertContract(
    "loop definition",
    definition,
    validateLoopDefinition,
  );
  const expectedId = `definition_${sha256(
    canonicalJson({ runId, kind: "definition" }),
  )}`;
  if (
    definition.runId !== runId ||
    definition.definitionId !== expectedId ||
    (file &&
      path.basename(file) !==
        `${definition.definitionId}.json`)
  ) {
    const error = new TypeError(
      "loop definition identity or location is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return definition;
}

function governorDecisionIdentity(decision) {
  if (decision.action === "block") {
    return {
      runId: decision.runId,
      obligationId: decision.obligationId,
      kind: "continuation-block",
    };
  }
  if (decision.action === "cap") {
    return {
      runId: decision.runId,
      obligationId: decision.obligationId,
      kind: "continuation-cap",
    };
  }
  return {
    runId: decision.runId,
    sessionStartEventId: decision.originEventId,
    stateRevision: decision.fromRevision,
    kind: "resume-interrupt",
  };
}

function assertGovernorDecisionIntegrity(
  decision,
  runId,
  file = undefined,
) {
  assertContract(
    "governor decision",
    decision,
    validateGovernorDecision,
  );
  const expectedId = `decision_${sha256(
    canonicalJson(governorDecisionIdentity(decision)),
  )}`;
  if (
    decision.runId !== runId ||
    decision.obligationId !==
      decision.pendingTransitionId ||
    decision.decisionId !== expectedId ||
    (file &&
      path.basename(file) !== `${decision.decisionId}.json`)
  ) {
    const error = new TypeError(
      "governor decision identity or location is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return decision;
}

function assertLegacyRecoveryIntegrity(
  recovery,
  runId,
  file = undefined,
) {
  assertContract(
    "legacy quarantine receipt",
    recovery,
    validateLegacyQuarantineReceipt,
  );
  const expectedId = recoveryIdFor(
    runId,
    recovery.requestId,
  );
  const expectedRequestDigest = recoveryRequestDigest({
    runId,
    requestId: recovery.requestId,
    actorId: recovery.actorId,
    expectedRevision: recovery.fromRevision,
    expectedEvidenceDigest: recovery.evidenceDigest,
  });
  if (
    recovery.runId !== runId ||
    recovery.recoveryId !== expectedId ||
    recovery.requestDigest !== expectedRequestDigest ||
    (file &&
      path.basename(file) !== `${expectedId}.json`)
  ) {
    const error = new TypeError(
      "legacy recovery identity, request digest, or location is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return recovery;
}

function assertStoredEventIntegrity(event, file = undefined) {
  assertContract(
    "normalized hook event",
    event,
    validateNormalizedHookEvent,
  );
  if (
    file &&
    path.basename(file) !== `${event.eventId}.json`
  ) {
    const error = new TypeError(
      "normalized hook event location is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  if (event.conflictEligible !== true) {
    return event;
  }
  const identity = {
    semanticKeyVersion: SEMANTIC_KEY_VERSION,
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    event: event.event,
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
    ...(event.stopHookActive === undefined
      ? {}
      : { stopHookActive: event.stopHookActive }),
    ...(event.event === "SessionStart" &&
    event.payloadSummary?.source
      ? { source: event.payloadSummary.source }
      : {}),
  };
  const semanticKey = `sem-v${SEMANTIC_KEY_VERSION}:${digestJson(identity)}`;
  const payloadDigest = digestJson({
    schemaVersion: SCHEMA_VERSION,
    semanticKey,
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    event: event.event,
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.agentType ? { agentType: event.agentType } : {}),
    ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
    ...(event.stopHookActive === undefined
      ? {}
      : { stopHookActive: event.stopHookActive }),
    payloadSummary: event.payloadSummary,
  });
  const eventId = `evt_${sha256(
    canonicalJson({ semanticKey, payloadDigest }),
  )}`;
  if (
    event.semanticKey !== semanticKey ||
    event.payloadDigest !== payloadDigest ||
    event.eventId !== eventId
  ) {
    const error = new TypeError(
      "normalized hook event identity or digest is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return event;
}

function assertIdentityBindingIntegrity(
  binding,
  runId,
  file = undefined,
  expectedAgentId = undefined,
) {
  assertContract(
    "identity binding",
    binding,
    validateIdentityBinding,
  );
  const expectedBindingId = `binding_${sha256(
    canonicalJson({ runId, agentId: binding.agentId }),
  )}`;
  const expectedFileName = `binding_${sha256(
    binding.agentId,
  )}.json`;
  const productFields = [
    "requestId",
    "requestDigest",
    "observationId",
    "originEventId",
  ];
  const hasProductBindingFields = productFields.some(
    (field) => binding[field] !== undefined,
  );
  const completeProductBinding = productFields.every(
    (field) => binding[field] !== undefined,
  ) && binding.role !== undefined;
  const expectedRequestDigest = completeProductBinding
    ? digestJson({
        kind: "bind-worker",
        runId,
        requestId: binding.requestId,
        agentId: binding.agentId,
        role: binding.role,
        observationId: binding.observationId,
        originEventId: binding.originEventId,
      })
    : undefined;
  if (
    binding.runId !== runId ||
    binding.bindingId !== expectedBindingId ||
    (expectedAgentId !== undefined &&
      binding.agentId !== expectedAgentId) ||
    (file && path.basename(file) !== expectedFileName) ||
    (hasProductBindingFields &&
      (!completeProductBinding ||
        binding.requestDigest !==
          expectedRequestDigest))
  ) {
    const error = new TypeError(
      "identity binding identity, request digest, or location is invalid",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return binding;
}

function compareFacts(kind, left, right) {
  const timeOrder = compareCodePoints(
    String(factTime(kind, left)),
    String(factTime(kind, right)),
  );
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return compareCodePoints(factId(kind, left), factId(kind, right));
}

function diagnosticId(runId, kind, details) {
  return `diag_${sha256(canonicalJson({ runId, kind, details }))}`;
}

function diagnosticPayload(runId, kind, details, severity = "warn") {
  return {
    schemaVersion: SCHEMA_VERSION,
    diagnosticId: diagnosticId(runId, kind, details),
    runId,
    kind,
    severity,
    details,
    createdAt: new Date().toISOString(),
  };
}

function validateDiagnostic(value) {
  const errors = [];
  if (value?.schemaVersion !== SCHEMA_VERSION) {
    errors.push("diagnostic.schemaVersion must be 1");
  }
  if (
    typeof value?.diagnosticId !== "string" ||
    !/^diag_[a-f0-9]{64}$/.test(value.diagnosticId)
  ) {
    errors.push("diagnostic.diagnosticId is invalid");
  }
  if (typeof value?.runId !== "string" || value.runId.length === 0) {
    errors.push("diagnostic.runId is invalid");
  }
  if (typeof value?.kind !== "string" || value.kind.length === 0) {
    errors.push("diagnostic.kind is invalid");
  }
  if (!["info", "warn", "error"].includes(value?.severity)) {
    errors.push("diagnostic.severity is invalid");
  }
  if (
    value?.details === null ||
    typeof value?.details !== "object" ||
    Array.isArray(value.details)
  ) {
    errors.push("diagnostic.details must be an object");
  }
  return errors;
}

function sessionBinding(run) {
  return {
    schemaVersion: SCHEMA_VERSION,
    bindingId: `session_${sha256(
      canonicalJson({
        runId: run.runId,
        rootSessionId: run.rootSessionId,
      }),
    )}`,
    runId: run.runId,
    rootSessionId: run.rootSessionId,
    createdAt: run.createdAt,
  };
}

function validateSessionBinding(value) {
  const errors = [];
  if (value?.schemaVersion !== SCHEMA_VERSION) {
    errors.push("session binding schemaVersion must be 1");
  }
  if (
    typeof value?.bindingId !== "string" ||
    !/^session_[a-f0-9]{64}$/.test(value.bindingId)
  ) {
    errors.push("session binding id is invalid");
  }
  if (typeof value?.runId !== "string" || value.runId.length === 0) {
    errors.push("session binding runId is invalid");
  }
  if (
    typeof value?.rootSessionId !== "string" ||
    value.rootSessionId.length === 0
  ) {
    errors.push("session binding rootSessionId is invalid");
  }
  if (
    typeof value?.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    errors.push("session binding createdAt is invalid");
  }
  return errors;
}

function assertSessionBindingLocation(binding, file, rootSessionId) {
  assertContract(
    "session binding",
    binding,
    validateSessionBinding,
  );
  const expectedBindingId = `session_${sha256(
    canonicalJson({
      runId: binding.runId,
      rootSessionId: binding.rootSessionId,
    }),
  )}`;
  if (
    binding.rootSessionId !== rootSessionId ||
    binding.bindingId !== expectedBindingId ||
    path.basename(file) !== `${binding.runId}.json`
  ) {
    const error = new TypeError(
      "session binding does not match its store location",
    );
    error.code = "INVALID_CONTRACT";
    throw error;
  }
  return binding;
}

function runIdentity(value) {
  return {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    rootSessionId: value.rootSessionId,
    originatingTurnId: value.originatingTurnId,
    scope: value.scope,
    masterNode: value.masterNode,
    recipe: value.recipe,
    createdAt: value.createdAt,
  };
}

function assertStateTransition(current, next) {
  if (
    canonicalJson(runIdentity(current)) !==
    canonicalJson(runIdentity(next))
  ) {
    throw new InvalidStateTransitionError(
      "run identity fields are immutable",
    );
  }
  if (
    TERMINAL_STATUSES.has(current.status) &&
    next.status !== current.status
  ) {
    throw new InvalidStateTransitionError(
      "terminal runs cannot transition to another status",
    );
  }
  if (current.cancelRequested && !next.cancelRequested) {
    throw new InvalidStateTransitionError(
      "cancelRequested cannot be cleared",
    );
  }
  if (next.currentLap < current.currentLap) {
    throw new InvalidStateTransitionError(
      "currentLap cannot move backwards",
    );
  }
  if (
    next.continuationLease.granted !==
      current.continuationLease.granted ||
    next.continuationLease.consumed <
      current.continuationLease.consumed
  ) {
    throw new InvalidStateTransitionError(
      "continuation lease cannot be expanded or rewound",
    );
  }
}

async function fileDigest(file, root) {
  try {
    const buffer = await readBoundedFile(file, { root });
    return {
      sha256: sha256(buffer),
      bytes: buffer.length,
    };
  } catch (error) {
    return {
      sha256: sha256(String(error?.code ?? "read-error")),
      bytes: null,
    };
  }
}

export class LoopStore {
  static async open(options = {}) {
    const rootInfo = options.rootInfo ?? (await resolveDataRoot(options));
    return new LoopStore(rootInfo, options.retention);
  }

  constructor(rootInfo, retention = {}) {
    if (!rootInfo?.path || !rootInfo?.marker?.instanceId) {
      throw new TypeError("LoopStore requires a resolved data root");
    }
    this.rootInfo = rootInfo;
    this.dataRoot = rootInfo.path;
    this.retention = { ...DEFAULT_RETENTION, ...retention };
  }

  runDirectory(runId) {
    assertSafeFileId(runId, "runId");
    return path.join(this.dataRoot, "runs", runId);
  }

  factDirectory(runId, kind) {
    return path.join(this.runDirectory(runId), kind);
  }

  statePath(runId) {
    return path.join(this.runDirectory(runId), "state.json");
  }

  projectionPath(runId) {
    return path.join(this.runDirectory(runId), "projection.json");
  }

  actionCapabilityPath(runId, transitionId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(transitionId, "transitionId");
    return path.join(
      this.runDirectory(runId),
      "action-capabilities",
      `${transitionId}.json`,
    );
  }

  sessionBindingDirectory(rootSessionId) {
    return path.join(
      this.dataRoot,
      "session-bindings",
      sha256(rootSessionId),
    );
  }

  sessionBindingPath(runId, rootSessionId) {
    assertSafeFileId(runId, "runId");
    return path.join(
      this.sessionBindingDirectory(rootSessionId),
      `${runId}.json`,
    );
  }

  async initializeRun(state) {
    assertContract("loop run", state, validateLoopRun);
    assertSafeFileId(state.runId, "runId");
    const sessionDirectory = this.sessionBindingDirectory(
      state.rootSessionId,
    );
    const sessionLockPath = path.join(
      sessionDirectory,
      "session.lock",
    );
    const runLockPath = path.join(
      this.runDirectory(state.runId),
      "locks",
      "initialize.lock",
    );
    return withFileLock(
      sessionLockPath,
      () =>
        withFileLock(
          runLockPath,
          async () => {
            const files = await listJsonFiles(sessionDirectory, {
              root: this.dataRoot,
            });
            let sameRunBindingPath = null;
            for (const file of files) {
              const existingBinding = assertSessionBindingLocation(
                await readJsonFile(file, { root: this.dataRoot }),
                file,
                state.rootSessionId,
              );
              if (existingBinding.runId === state.runId) {
                sameRunBindingPath = file;
                continue;
              }
              let existingState;
              try {
                existingState = await this.readState(
                  existingBinding.runId,
                );
              } catch (error) {
                if (error?.code === "ENOENT") {
                  const reservation = new StoreConflictError(
                    "another run reserved this task before publishing state",
                    {
                      rootSessionIdDigest: sha256(
                        state.rootSessionId,
                      ),
                    },
                  );
                  reservation.code = "SESSION_BINDING_RESERVED";
                  throw reservation;
                }
                throw error;
              }
              if (
                existingState.rootSessionId !==
                  state.rootSessionId
              ) {
                const error = new TypeError(
                  "session binding state belongs to another task",
                );
                error.code = "INVALID_CONTRACT";
                throw error;
              }
              if (ACTIVE_RUN_STATUSES.has(existingState.status)) {
                const conflict = new StoreConflictError(
                  "another active loop run is already bound to this task",
                  {
                    rootSessionIdDigest: sha256(
                      state.rootSessionId,
                    ),
                  },
                );
                conflict.code = "SESSION_BINDING_CONFLICT";
                throw conflict;
              }
            }

            let existingRun = null;
            try {
              existingRun = await this.readState(state.runId);
            } catch (error) {
              if (error?.code !== "ENOENT") {
                throw error;
              }
            }
            if (existingRun) {
              if (
                canonicalJson(runIdentity(existingRun)) !==
                canonicalJson(runIdentity(state))
              ) {
                if (
                  sameRunBindingPath &&
                  existingRun.rootSessionId !== state.rootSessionId
                ) {
                  await unlink(sameRunBindingPath);
                }
                const conflict = new StoreConflictError(
                  "run id already belongs to another task or identity",
                  { runId: state.runId },
                );
                conflict.code = "RUN_ID_CONFLICT";
                throw conflict;
              }
              const repaired = await atomicCreateJson(
                this.sessionBindingPath(
                  existingRun.runId,
                  existingRun.rootSessionId,
                ),
                sessionBinding(existingRun),
                {
                  root: this.dataRoot,
                  equivalent: (left, right) =>
                    canonicalJson(left) ===
                    canonicalJson(right),
                },
              );
              if (repaired.status === "conflict") {
                throw new StoreConflictError(
                  "session binding conflicts with the authoritative run",
                  { runId: state.runId },
                );
              }
              return {
                status: "duplicate",
                path: this.statePath(state.runId),
                existing: existingRun,
              };
            }

            const bindingPath = this.sessionBindingPath(
              state.runId,
              state.rootSessionId,
            );
            const bindingResult = await atomicCreateJson(
              bindingPath,
              sessionBinding(state),
              {
                root: this.dataRoot,
                equivalent: (left, right) =>
                  canonicalJson(left) === canonicalJson(right),
              },
            );
            if (bindingResult.status === "conflict") {
              throw new StoreConflictError(
                "session binding already exists with different state",
                { runId: state.runId },
              );
            }

            const result = await atomicCreateJson(
              this.statePath(state.runId),
              state,
              { root: this.dataRoot },
            );
            if (result.status === "conflict") {
              if (bindingResult.status === "created") {
                await unlink(bindingPath);
              }
              throw new StoreConflictError(
                "run already exists with different state",
                { runId: state.runId },
              );
            }
            return result;
          },
          { root: this.dataRoot },
        ),
      { root: this.dataRoot },
    );
  }

  async boundRunIdsForSession(rootSessionId) {
    if (
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0
    ) {
      return [];
    }
    const directory = this.sessionBindingDirectory(rootSessionId);
    const files = await listJsonFiles(directory, {
      root: this.dataRoot,
    });
    const runIds = [];
    for (const file of files) {
      const binding = assertSessionBindingLocation(
        await readJsonFile(file, {
          root: this.dataRoot,
        }),
        file,
        rootSessionId,
      );
      runIds.push(binding.runId);
    }
    return [...new Set(runIds)].sort(compareCodePoints);
  }

  async activeRunForSession(rootSessionId, options = {}) {
    if (
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0
    ) {
      return null;
    }
    const runIds =
      options.boundRunIds ??
      (await this.boundRunIdsForSession(rootSessionId));
    const active = [];
    for (const runId of runIds) {
      let state;
      try {
        state = await this.readState(runId);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (state.rootSessionId !== rootSessionId) {
        const error = new TypeError(
          "session binding state belongs to another task",
        );
        error.code = "INVALID_CONTRACT";
        throw error;
      }
      if (HOOK_COLLECTION_STATUSES.has(state.status)) {
        active.push(runId);
      }
    }
    active.sort(compareCodePoints);
    if (active.length > 1) {
      const error = new StoreConflictError(
        "multiple active loop runs are bound to one task",
        { rootSessionIdDigest: sha256(rootSessionId) },
      );
      error.code = "SESSION_BINDING_AMBIGUOUS";
      throw error;
    }
    return active[0] ?? null;
  }

  async boundRunsForSession(rootSessionId) {
    if (
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0
    ) {
      return [];
    }
    const directory = this.sessionBindingDirectory(rootSessionId);
    const files = await listJsonFiles(directory, {
      root: this.dataRoot,
    });
    const results = [];
    for (const file of files) {
      const binding = assertSessionBindingLocation(
        await readJsonFile(file, { root: this.dataRoot }),
        file,
        rootSessionId,
      );
      try {
        const state = await this.readState(binding.runId);
        if (state.rootSessionId !== rootSessionId) {
          const error = new TypeError(
            "session binding state belongs to another task",
          );
          error.code = "INVALID_CONTRACT";
          throw error;
        }
        results.push({ binding, state });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        results.push({ binding, state: null });
      }
    }
    return results.sort((left, right) =>
      compareCodePoints(left.binding.runId, right.binding.runId),
    );
  }

  async readState(runId) {
    const value = await readJsonFile(this.statePath(runId), {
      root: this.dataRoot,
    });
    assertContract("loop run", value, validateLoopRun);
    if (value.runId !== runId) {
      const error = new TypeError("loop run is stored under a different run id");
      error.code = "INVALID_CONTRACT";
      throw error;
    }
    return value;
  }

  async readActionCapability(runId, transitionId) {
    return readJsonFile(
      this.actionCapabilityPath(runId, transitionId),
      { root: this.dataRoot },
    );
  }

  async replaceActionCapability(runId, transitionId, value) {
    if (
      value?.runId !== runId ||
      value?.pendingTransitionId !== transitionId
    ) {
      throw new TypeError(
        "action capability belongs to a different run or transition",
      );
    }
    return atomicReplaceJson(
      this.actionCapabilityPath(runId, transitionId),
      value,
      { root: this.dataRoot },
    );
  }

  async compareAndSwapState(runId, expectedRevision, nextState, options = {}) {
    assertSafeFileId(runId, "runId");
    assertContract("loop run", nextState, validateLoopRun);
    if (nextState.runId !== runId) {
      throw new TypeError("next state belongs to a different run");
    }
    if (nextState.revision !== expectedRevision + 1) {
      throw new RevisionConflictError(expectedRevision + 1, nextState.revision);
    }
    const lockPath = path.join(this.runDirectory(runId), "locks", "state.lock");
    return withFileLock(
      lockPath,
      async () => {
        const current = await this.readState(runId);
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError(expectedRevision, current.revision);
        }
        assertStateTransition(current, nextState);
        await atomicReplaceJson(this.statePath(runId), nextState, {
          root: this.dataRoot,
        });
        return nextState;
      },
      { ...options, root: this.dataRoot },
    );
  }

  async withControlLock(runId, callback, options = {}) {
    assertSafeFileId(runId, "runId");
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      "control.lock",
    );
    return withFileLock(lockPath, callback, {
      ...options,
      root: this.dataRoot,
    });
  }

  async withWorkerObservationLock(
    runId,
    callback,
    options = {},
  ) {
    assertSafeFileId(runId, "runId");
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      "worker-observation.lock",
    );
    return withFileLock(lockPath, callback, {
      timeoutMs: FACT_LOCK_TIMEOUT_MS,
      ...options,
      root: this.dataRoot,
    });
  }

  async withWorkerObservationIntentLock(
    runId,
    callback,
    options = {},
  ) {
    assertSafeFileId(runId, "runId");
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      "worker-observation-intent.lock",
    );
    return withFileLock(lockPath, callback, {
      timeoutMs: FACT_LOCK_TIMEOUT_MS,
      ...options,
      root: this.dataRoot,
    });
  }

  async withWorkerObservationSnapshotLock(
    runId,
    callback,
    options = {},
  ) {
    return this.withWorkerObservationIntentLock(
      runId,
      () =>
        this.withWorkerObservationLock(
          runId,
          callback,
          options,
        ),
      options,
    );
  }

  async #stateStatus(runId) {
    try {
      return (await this.readState(runId)).status;
    } catch {
      return "interrupted";
    }
  }

  async #putFact(runId, kind, value, options = {}) {
    assertSafeFileId(runId, "runId");
    const validator = validatorFor(kind);
    assertContract(kind.slice(0, -1), value, validator);
    if (value.runId !== undefined && value.runId !== runId) {
      throw new TypeError(`${kind} fact belongs to a different run`);
    }
    const id = options.id ?? factId(kind, value);
    assertSafeFileId(id, `${kind} id`);
    const target = path.join(this.factDirectory(runId, kind), `${id}.json`);
    const equivalent =
      options.equivalent ??
      ((left, right) => canonicalJson(left) === canonicalJson(right));
    try {
      const existing = await readJsonFile(target, {
        root: this.dataRoot,
      });
      if (equivalent(existing, value)) {
        return { status: "duplicate", id };
      }
      await this.writeDiagnostic(
        runId,
        `${kind.slice(0, -1)}_id_conflict`,
        {
          id,
          existingDigest: digestJson(existing),
          incomingDigest: digestJson(value),
        },
        "error",
      );
      return { status: "conflict", id };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      `${kind}.lock`,
    );
    const result = await withFileLock(
      lockPath,
      async () => {
        try {
          const existing = await readJsonFile(target, {
            root: this.dataRoot,
          });
          if (equivalent(existing, value)) {
            return { status: "duplicate", id };
          }
          return {
            status: "conflict",
            id,
            existingDigest: digestJson(existing),
          };
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
        const status = await this.#stateStatus(runId);
        const active = ACTIVE_RUN_STATUSES.has(status);
        const baseLimit =
          this.retention[kind] ?? this.retention.diagnostics;
        const limit = active
          ? baseLimit * this.retention.activeMultiplier
          : baseLimit;
        const files = await listJsonFiles(
          this.factDirectory(runId, kind),
          { root: this.dataRoot },
        );
        const safetyReserve =
          options.allowSafetyReserve === true &&
          ["operations", "transitions"].includes(kind) &&
          value.kind === "interrupt" &&
          files.length < limit + SAFETY_RECEIPT_RESERVE;
        const cancelReserve =
          ["operations", "transitions"].includes(kind) &&
          value.kind === "cancel" &&
          files.length < limit + SAFETY_RECEIPT_RESERVE;
        if (
          files.length >= limit &&
          !safetyReserve &&
          !cancelReserve
        ) {
          return { status: "limit", id, limit, active };
        }
        const published = await atomicCreateJson(target, value, {
          equivalent,
          root: this.dataRoot,
        });
        return {
          status: published.status,
          id,
          ...(published.status === "conflict"
            ? { existingDigest: digestJson(published.existing) }
            : {}),
        };
      },
      {
        root: this.dataRoot,
        timeoutMs: FACT_LOCK_TIMEOUT_MS,
      },
    );
    if (result.status === "conflict") {
      await this.writeDiagnostic(
        runId,
        `${kind.slice(0, -1)}_id_conflict`,
        {
          id,
          existingDigest: result.existingDigest,
          incomingDigest: digestJson(value),
        },
        "error",
      );
    }
    if (result.status === "limit") {
      await this.writeDiagnostic(
        runId,
        "active_run_limit",
        {
          factKind: kind,
          limit: result.limit,
          active: result.active,
        },
        "error",
      );
    }
    return result;
  }

  pendingWorkerObservationDirectory(runId) {
    return path.join(
      this.runDirectory(runId),
      "pending-worker-observations",
    );
  }

  async #putEventFact(runId, event) {
    return this.#putFact(runId, "events", event, {
      id: event.eventId,
      equivalent: (left, right) =>
        left?.eventId === right?.eventId &&
        left?.payloadDigest === right?.payloadDigest,
    });
  }

  async #stageWorkerObservation(runId, event) {
    const target = path.join(
      this.pendingWorkerObservationDirectory(runId),
      `${event.eventId}.json`,
    );
    const result = await atomicCreateJson(target, event, {
      root: this.dataRoot,
      equivalent: (left, right) =>
        left?.eventId === right?.eventId &&
        left?.payloadDigest === right?.payloadDigest,
    });
    if (result.status === "conflict") {
      throw new StoreConflictError(
        "pending worker observation conflicts",
        { eventId: event.eventId },
      );
    }
    return result;
  }

  async readPendingWorkerObservations(runId) {
    assertSafeFileId(runId, "runId");
    const directory =
      this.pendingWorkerObservationDirectory(runId);
    const files = await listJsonFiles(directory, {
      root: this.dataRoot,
    });
    const facts = [];
    const corrupt = [];
    for (const file of files) {
      try {
        const value = await readJsonFile(file, {
          root: this.dataRoot,
        });
        assertContract(
          "pending worker observation",
          value,
          validateNormalizedHookEvent,
        );
        if (
          !isWorkerObservationEvent(value) ||
          path.basename(file) !== `${value.eventId}.json`
        ) {
          const error = new TypeError(
            "pending worker observation has an invalid location",
          );
          error.code = "INVALID_CONTRACT";
          throw error;
        }
        facts.push(value);
      } catch (error) {
        corrupt.push({
          relativeFile: path.relative(
            this.runDirectory(runId),
            file,
          ),
          code: error?.code ?? "READ_ERROR",
          digest: await fileDigest(file, this.dataRoot),
        });
      }
    }
    facts.sort((left, right) =>
      compareFacts("events", left, right),
    );
    return { facts, corrupt };
  }

  async reconcilePendingWorkerObservations(runId) {
    const pending = await this.readPendingWorkerObservations(
      runId,
    );
    const published = [];
    const unresolved = [];
    for (const event of pending.facts) {
      const result = await this.#putEventFact(runId, event);
      if (["created", "duplicate"].includes(result.status)) {
        await unlink(
          path.join(
            this.pendingWorkerObservationDirectory(runId),
            `${event.eventId}.json`,
          ),
        );
        published.push({ eventId: event.eventId, status: result.status });
      } else {
        unresolved.push({
          eventId: event.eventId,
          status: result.status,
        });
      }
    }
    return {
      published,
      unresolved,
      corrupt: pending.corrupt,
    };
  }

  async readWorkerObservationEvidence(runId) {
    const [eventRead, pendingRead] = await Promise.all([
      this.listEvents(runId),
      this.readPendingWorkerObservations(runId),
    ]);
    const byEventId = new Map();
    const conflicts = [];
    for (const event of [
      ...eventRead.facts,
      ...pendingRead.facts,
    ]) {
      const existing = byEventId.get(event.eventId);
      if (
        existing &&
        existing.payloadDigest !== event.payloadDigest
      ) {
        conflicts.push({
          eventId: event.eventId,
          payloadDigests: [
            existing.payloadDigest,
            event.payloadDigest,
          ].sort(compareCodePoints),
        });
        continue;
      }
      byEventId.set(event.eventId, event);
    }
    return {
      facts: [...byEventId.values()].sort((left, right) =>
        compareFacts("events", left, right),
      ),
      corrupt: [
        ...eventRead.corrupt,
        ...pendingRead.corrupt,
      ],
      conflicts,
      pendingCount: pendingRead.facts.length,
    };
  }

  async putEvent(runId, event) {
    assertContract(
      "normalized hook event",
      event,
      validateNormalizedHookEvent,
    );
    if (!isWorkerObservationEvent(event)) {
      return this.#putEventFact(runId, event);
    }
    await this.withWorkerObservationIntentLock(
      runId,
      () => this.#stageWorkerObservation(runId, event),
    );
    return this.withWorkerObservationLock(
      runId,
      async () => {
        const reconciled =
          await this.reconcilePendingWorkerObservations(runId);
        if (
          reconciled.corrupt.length > 0 ||
          reconciled.unresolved.length > 0
        ) {
          const error = new StoreConflictError(
            "worker observation could not be published",
            {
              corrupt: reconciled.corrupt.length,
              unresolved: reconciled.unresolved.length,
            },
          );
          error.code = "OBSERVATION_INCOMPLETE";
          throw error;
        }
        return (
          reconciled.published.find(
            ({ eventId }) => eventId === event.eventId,
          ) ?? { eventId: event.eventId, status: "duplicate" }
        );
      },
    );
  }

  async listEvents(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readFacts(
      runId,
      "events",
      validateNormalizedHookEvent,
    );
  }

  async readEvent(runId, eventId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(eventId, "eventId");
    const file = path.join(
      this.factDirectory(runId, "events"),
      `${eventId}.json`,
    );
    return assertStoredEventIntegrity(
      await readJsonFile(file, { root: this.dataRoot }),
      file,
    );
  }

  async putDefinition(runId, definition) {
    assertLoopDefinitionIntegrity(definition, runId);
    return this.#putFact(runId, "definitions", definition, {
      id: definition.definitionId,
    });
  }

  async readDefinition(runId) {
    assertSafeFileId(runId, "runId");
    const { facts, corrupt } = await this.#readFacts(
      runId,
      "definitions",
      validateLoopDefinition,
    );
    if (corrupt.length > 0 || facts.length !== 1) {
      const error = new TypeError(
        "run must contain exactly one valid loop definition",
      );
      error.code =
        corrupt.length > 0 ? "INVALID_CONTRACT" : "ENOENT";
      error.details = {
        facts: facts.length,
        corrupt: corrupt.length,
      };
      throw error;
    }
    return facts[0];
  }

  async findObservedSubagentStart(runId, rootSessionId, agentId) {
    assertSafeFileId(runId, "runId");
    const state = await this.readState(runId);
    if (state.rootSessionId !== rootSessionId) {
      return null;
    }
    const { facts } = await this.#readFacts(
      runId,
      "events",
      validateNormalizedHookEvent,
    );
    return (
      facts
        .filter(
          (event) =>
            event.event === "SubagentStart" &&
            event.conflictEligible === true &&
            event.sessionId === rootSessionId &&
            event.agentId === agentId,
        )
        .sort((left, right) =>
          compareCodePoints(left.eventId, right.eventId),
        )[0] ?? null
    );
  }

  async listObservedSubagentStarts(runId, rootSessionId) {
    assertSafeFileId(runId, "runId");
    const state = await this.readState(runId);
    if (state.rootSessionId !== rootSessionId) {
      return { facts: [], corrupt: [] };
    }
    const read = await this.#readFacts(
      runId,
      "events",
      validateNormalizedHookEvent,
    );
    return {
      ...read,
      facts: read.facts
        .filter(
          (event) =>
            event.event === "SubagentStart" &&
            event.conflictEligible === true &&
            event.sessionId === rootSessionId &&
            typeof event.agentId === "string",
        )
        .sort((left, right) =>
          compareFacts("events", left, right),
        ),
    };
  }

  async putWorkerObservation(runId, observation) {
    assertWorkerObservationIntegrity(
      observation,
      runId,
    );
    return this.#putFact(
      runId,
      "observations",
      observation,
      { id: observation.observationId },
    );
  }

  async readWorkerObservation(runId, observationId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(observationId, "observationId");
    const value = await readJsonFile(
      path.join(
        this.factDirectory(runId, "observations"),
        `${observationId}.json`,
      ),
      { root: this.dataRoot },
    );
    assertWorkerObservationIntegrity(
      value,
      runId,
      path.join(
        this.factDirectory(runId, "observations"),
        `${observationId}.json`,
      ),
    );
    if (value.observationId !== observationId) {
      const error = new TypeError(
        "worker observation does not match its requested id",
      );
      error.code = "INVALID_CONTRACT";
      throw error;
    }
    return value;
  }

  async listWorkerObservations(runId) {
    assertSafeFileId(runId, "runId");
    const directory = this.factDirectory(
      runId,
      "observations",
    );
    const files = await listJsonFiles(directory, {
      root: this.dataRoot,
    });
    const facts = [];
    const corrupt = [];
    for (const file of files) {
      try {
        facts.push(
          assertWorkerObservationIntegrity(
            await readJsonFile(file, {
              root: this.dataRoot,
            }),
            runId,
            file,
          ),
        );
      } catch (error) {
        corrupt.push({
          relativeFile: path.relative(
            this.runDirectory(runId),
            file,
          ),
          code: error?.code ?? "READ_ERROR",
          digest: await fileDigest(file, this.dataRoot),
        });
      }
    }
    facts.sort((left, right) =>
      compareFacts("observations", left, right),
    );
    return { facts, corrupt };
  }

  async putReport(runId, report) {
    return this.#putFact(runId, "reports", report, { id: report.reportId });
  }

  async readReport(runId, reportId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(reportId, "reportId");
    const value = await readJsonFile(
      path.join(
        this.factDirectory(runId, "reports"),
        `${reportId}.json`,
      ),
      { root: this.dataRoot },
    );
    return assertContract(
      "report",
      value,
      validateLoopReport,
    );
  }

  async listReports(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readFacts(
      runId,
      "reports",
      validateLoopReport,
    );
  }

  async putTransition(runId, transition, options = {}) {
    return this.#putFact(runId, "transitions", transition, {
      id: transition.transitionId,
      allowSafetyReserve:
        options.allowSafetyReserve === true,
    });
  }

  async readTransition(runId, transitionId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(transitionId, "transitionId");
    const value = await readJsonFile(
      path.join(
        this.factDirectory(runId, "transitions"),
        `${transitionId}.json`,
      ),
      { root: this.dataRoot },
    );
    return assertContract(
      "transition",
      value,
      validateLoopTransition,
    );
  }

  async listTransitions(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readFacts(
      runId,
      "transitions",
      validateLoopTransition,
    );
  }

  async putOperation(runId, operation, options = {}) {
    return this.#putFact(runId, "operations", operation, {
      id: operation.operationId,
      allowSafetyReserve:
        options.allowSafetyReserve === true,
    });
  }

  async readOperation(runId, operationId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(operationId, "operationId");
    const value = await readJsonFile(
      path.join(
        this.factDirectory(runId, "operations"),
        `${operationId}.json`,
      ),
      { root: this.dataRoot },
    );
    return assertContract(
      "operation",
      value,
      validateLoopOperation,
    );
  }

  async listOperations(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readFacts(
      runId,
      "operations",
      validateLoopOperation,
    );
  }

  async putGovernorDecision(runId, decision) {
    assertGovernorDecisionIntegrity(decision, runId);
    return this.#putFact(
      runId,
      "governor-decisions",
      decision,
      { id: decision.decisionId },
    );
  }

  async readGovernorDecision(runId, decisionId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(decisionId, "decisionId");
    const file = path.join(
      this.factDirectory(runId, "governor-decisions"),
      `${decisionId}.json`,
    );
    return assertGovernorDecisionIntegrity(
      await readJsonFile(file, { root: this.dataRoot }),
      runId,
      file,
    );
  }

  async listGovernorDecisions(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readFacts(
      runId,
      "governor-decisions",
      validateGovernorDecision,
    );
  }

  async putRecovery(runId, recovery) {
    assertLegacyRecoveryIntegrity(recovery, runId);
    return this.#putFact(runId, "recoveries", recovery, {
      id: recovery.recoveryId,
    });
  }

  async readRecovery(runId, recoveryId) {
    assertSafeFileId(runId, "runId");
    assertSafeFileId(recoveryId, "recoveryId");
    const file = path.join(
      this.factDirectory(runId, "recoveries"),
      `${recoveryId}.json`,
    );
    const value = assertLegacyRecoveryIntegrity(
      await readJsonFile(file, { root: this.dataRoot }),
      runId,
      file,
    );
    if (value.recoveryId !== recoveryId) {
      const error = new TypeError(
        "legacy recovery does not match its requested id",
      );
      error.code = "INVALID_CONTRACT";
      throw error;
    }
    return value;
  }

  async listRecoveries(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readFacts(
      runId,
      "recoveries",
      validateLegacyQuarantineReceipt,
    );
  }

  async putIdentityBinding(runId, binding) {
    assertIdentityBindingIntegrity(binding, runId);
    const id = `binding_${sha256(binding.agentId)}`;
    return this.#putFact(runId, "identity", binding, { id });
  }

  async readIdentityBinding(runId, agentId) {
    assertSafeFileId(runId, "runId");
    const id = `binding_${sha256(agentId)}`;
    const file = path.join(
      this.factDirectory(runId, "identity"),
      `${id}.json`,
    );
    const value = await readJsonFile(
      file,
      { root: this.dataRoot },
    );
    return assertIdentityBindingIntegrity(
      value,
      runId,
      file,
      agentId,
    );
  }

  async listIdentityBindings(runId) {
    assertSafeFileId(runId, "runId");
    const directory = this.factDirectory(
      runId,
      "identity",
    );
    const files = await listJsonFiles(directory, {
      root: this.dataRoot,
    });
    const facts = [];
    const corrupt = [];
    for (const file of files) {
      try {
        facts.push(
          assertIdentityBindingIntegrity(
            await readJsonFile(file, {
              root: this.dataRoot,
            }),
            runId,
            file,
          ),
        );
      } catch (error) {
        corrupt.push({
          relativeFile: path.relative(
            this.runDirectory(runId),
            file,
          ),
          code: error?.code ?? "READ_ERROR",
          digest: await fileDigest(file, this.dataRoot),
        });
      }
    }
    facts.sort((left, right) =>
      compareCodePoints(left.bindingId, right.bindingId),
    );
    return { facts, corrupt };
  }

  async writeDiagnostic(runId, kind, details, severity = "warn") {
    assertSafeFileId(runId, "runId");
    const value = diagnosticPayload(runId, kind, details, severity);
    const target = path.join(
      this.factDirectory(runId, "diagnostics"),
      `${value.diagnosticId}.json`,
    );
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      "diagnostics.lock",
    );
    const reservedLimitDiagnostic =
      ["active_run_limit", "diagnostic_limit"].includes(kind) &&
      details?.factKind === "diagnostics";
    const result = await withFileLock(
      lockPath,
      async () => {
        try {
          const existing = await readJsonFile(target, {
            root: this.dataRoot,
          });
          if (existing?.diagnosticId === value.diagnosticId) {
            return { status: "duplicate", existing };
          }
          return { status: "conflict", existing };
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
        const status = await this.#stateStatus(runId);
        const active = ACTIVE_RUN_STATUSES.has(status);
        const limit = active
          ? this.retention.diagnostics * this.retention.activeMultiplier
          : this.retention.diagnostics;
        const files = await listJsonFiles(
          this.factDirectory(runId, "diagnostics"),
          { root: this.dataRoot },
        );
        const allowed = reservedLimitDiagnostic
          ? limit
          : Math.max(0, limit - 1);
        if (files.length >= allowed) {
          return { status: "limit", active, limit };
        }
        return atomicCreateJson(target, value, {
          equivalent: (left, right) =>
            left?.diagnosticId === right?.diagnosticId,
          root: this.dataRoot,
        });
      },
      { root: this.dataRoot },
    );
    if (result.status === "limit" && !reservedLimitDiagnostic) {
      const limitKind = result.active
        ? "active_run_limit"
        : "diagnostic_limit";
      await this.writeDiagnostic(
        runId,
        limitKind,
        {
          factKind: "diagnostics",
          limit: result.limit,
          active: result.active,
        },
        "error",
      );
    }
    return { ...result, diagnostic: value };
  }

  async #readFacts(runId, kind, validator) {
    const directory = this.factDirectory(runId, kind);
    const files = await listJsonFiles(directory, {
      root: this.dataRoot,
    });
    const facts = [];
    const corrupt = [];
    for (const file of files) {
      try {
        const value = await readJsonFile(file, {
          root: this.dataRoot,
        });
        const errors = validator(value);
        if (errors.length > 0) {
          const error = new TypeError(errors.join("; "));
          error.code = "INVALID_CONTRACT";
          throw error;
        }
        facts.push(
          kind === "definitions"
            ? assertLoopDefinitionIntegrity(
                value,
                runId,
                file,
              )
            : kind === "events"
            ? assertStoredEventIntegrity(value, file)
            : kind === "governor-decisions"
            ? assertGovernorDecisionIntegrity(
                value,
                runId,
                file,
              )
            : kind === "recoveries"
            ? assertLegacyRecoveryIntegrity(
                value,
                runId,
                file,
              )
            : value,
        );
      } catch (error) {
        corrupt.push({
          relativeFile: path.relative(this.runDirectory(runId), file),
          code: error?.code ?? "READ_ERROR",
          digest: await fileDigest(file, this.dataRoot),
        });
      }
    }
    return { facts, corrupt };
  }

  async #readDiagnostics(runId) {
    return this.#readFacts(runId, "diagnostics", validateDiagnostic);
  }

  async listDiagnostics(runId) {
    assertSafeFileId(runId, "runId");
    return this.#readDiagnostics(runId);
  }

  async #readOrRebuildState(runId, canonicalEvents) {
    try {
      return await this.readState(runId);
    } catch {
      // Recheck under the same state lock used by CAS so a recovery fold
      // cannot overwrite a concurrently repaired or resumed run.
    }
    const stateFile = this.statePath(runId);
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      "state.lock",
    );
    const outcome = await withFileLock(
      lockPath,
      async () => {
        try {
          return { state: await this.readState(runId) };
        } catch (error) {
          const details = {
            relativeFile: "state.json",
            code: error?.code ?? "STATE_MISSING_OR_CORRUPT",
            digest: await fileDigest(stateFile, this.dataRoot),
          };
          const rebuilt = createInterruptedRun(
            runId,
            canonicalEvents[0],
          );
          await atomicReplaceJson(stateFile, rebuilt, {
            root: this.dataRoot,
          });
          return { state: rebuilt, diagnosticDetails: details };
        }
      },
      { root: this.dataRoot },
    );
    if (outcome.diagnosticDetails) {
      await this.writeDiagnostic(
        runId,
        "state_rebuilt",
        outcome.diagnosticDetails,
        "error",
      );
    }
    return outcome.state;
  }

  async #writeSemanticIndexes(runId, groups) {
    const indexDirectory = path.join(
      this.runDirectory(runId),
      "indexes",
      "events",
    );
    const expectedFiles = new Set(
      [...groups.keys()].map((semanticKey) => `${sha256(semanticKey)}.json`),
    );
    const existingFiles = await listJsonFiles(indexDirectory, {
      root: this.dataRoot,
    });
    for (const file of existingFiles) {
      if (!expectedFiles.has(path.basename(file))) {
        await unlink(file);
      }
    }
    for (const [semanticKey, values] of groups) {
      const sorted = [...values].sort((left, right) =>
        compareCodePoints(left.eventId, right.eventId),
      );
      const index = {
        schemaVersion: SCHEMA_VERSION,
        semanticKeyVersion: 1,
        semanticKey,
        canonicalEventId: sorted[0].eventId,
        candidateEventIds: sorted.map((event) => event.eventId),
        payloadDigests: [
          ...new Set(sorted.map((event) => event.payloadDigest)),
        ].sort(compareCodePoints),
      };
      await atomicReplaceJson(
        path.join(indexDirectory, `${sha256(semanticKey)}.json`),
        index,
        { root: this.dataRoot },
      );
    }
  }

  async foldRun(runId, options = {}) {
    assertSafeFileId(runId, "runId");
    const {
      writeProjection = true,
      timelineLimit = this.retention.timeline,
    } = options;
    const [
      eventRead,
      reportCandidates,
      transitionCandidates,
      operationRead,
      governorDecisionRead,
    ] = await Promise.all([
      this.#readFacts(runId, "events", validateNormalizedHookEvent),
      this.#readFacts(runId, "reports", validateLoopReport),
      this.#readFacts(runId, "transitions", validateLoopTransition),
      this.#readFacts(runId, "operations", validateLoopOperation),
      this.#readFacts(
        runId,
        "governor-decisions",
        validateGovernorDecision,
      ),
    ]);
    const committedReportIds = new Set(
      operationRead.facts
        .map((operation) => operation.reportId)
        .filter(Boolean),
    );
    const committedTransitionIds = new Set(
      operationRead.facts.map((operation) => operation.transitionId),
    );
    const reportRead = {
      ...reportCandidates,
      facts: reportCandidates.facts.filter(
        (report) =>
          report.requestId === undefined ||
          committedReportIds.has(report.reportId),
      ),
    };
    const transitionRead = {
      ...transitionCandidates,
      facts: transitionCandidates.facts.filter(
        (transition) =>
          transition.requestId === undefined ||
          committedTransitionIds.has(transition.transitionId),
      ),
    };
    const corruptRecords = [
      ...eventRead.corrupt,
      ...reportCandidates.corrupt,
      ...transitionCandidates.corrupt,
      ...operationRead.corrupt,
      ...governorDecisionRead.corrupt,
    ];
    for (const corrupt of corruptRecords) {
      await this.writeDiagnostic(runId, "corrupt_fact", corrupt, "error");
    }

    const groups = new Map();
    for (const event of eventRead.facts) {
      const key = event.conflictEligible
        ? event.semanticKey
        : `${event.semanticKey}:${event.eventId}`;
      const values = groups.get(key) ?? [];
      values.push(event);
      groups.set(key, values);
    }
    const canonicalEvents = [];
    const conflictGroups = [];
    for (const [key, values] of groups) {
      const sorted = [...values].sort((left, right) =>
        compareCodePoints(left.eventId, right.eventId),
      );
      canonicalEvents.push(sorted[0]);
      const payloadDigests = [
        ...new Set(sorted.map((event) => event.payloadDigest)),
      ].sort(compareCodePoints);
      if (sorted[0].conflictEligible && payloadDigests.length > 1) {
        const details = {
          semanticKey: sorted[0].semanticKey,
          payloadDigests,
          candidateEventIds: sorted.map((event) => event.eventId),
          canonicalEventId: sorted[0].eventId,
        };
        conflictGroups.push(details);
        await this.writeDiagnostic(
          runId,
          "semantic_event_conflict",
          details,
          "error",
        );
      }
      if (!key.includes(":evt_")) {
        groups.set(sorted[0].semanticKey, sorted);
      }
    }
    const eligibleGroups = new Map(
      [...groups.entries()].filter(
        ([key, values]) =>
          !key.includes(":evt_") && values[0]?.conflictEligible === true,
      ),
    );
    await this.#writeSemanticIndexes(runId, eligibleGroups);
    canonicalEvents.sort((left, right) => compareFacts("events", left, right));
    eventRead.facts.sort((left, right) => compareFacts("events", left, right));
    reportRead.facts.sort((left, right) => compareFacts("reports", left, right));
    transitionRead.facts.sort((left, right) =>
      compareFacts("transitions", left, right),
    );
    governorDecisionRead.facts.sort((left, right) =>
      compareFacts("governor-decisions", left, right),
    );

    const state = await this.#readOrRebuildState(runId, canonicalEvents);
    const diagnosticRead = await this.#readDiagnostics(runId);
    for (const corrupt of diagnosticRead.corrupt) {
      // A corrupt diagnostic cannot safely diagnose itself in the same
      // directory. Count it separately and keep folding fail-open.
      corruptRecords.push(corrupt);
    }
    const nodes = new Map();
    nodes.set(state.rootSessionId, {
      id: state.rootSessionId,
      kind: "root",
    });
    for (const event of canonicalEvents) {
      if (event.agentId) {
        nodes.set(event.agentId, {
          id: event.agentId,
          kind: "subagent",
          ...(event.agentType ? { agentType: event.agentType } : {}),
        });
      }
    }
    const timeline = [
      ...canonicalEvents.map((event) => ({
        kind: "event",
        id: event.eventId,
        at: event.observedAt,
        event: event.event,
        ...(event.agentId ? { agentId: event.agentId } : {}),
      })),
      ...reportRead.facts.map((report) => ({
        kind: "report",
        id: report.reportId,
        at: report.createdAt,
        type: report.type,
        fromNode: report.fromNode,
        ...(report.verdict ? { verdict: report.verdict } : {}),
      })),
      ...transitionRead.facts.map((transition) => ({
        kind: "transition",
        id: transition.transitionId,
        at: transition.createdAt,
        transitionKind: transition.kind,
        lap: transition.lap,
      })),
      ...governorDecisionRead.facts.map((decision) => ({
        kind: "governor-decision",
        id: decision.decisionId,
        at: decision.createdAt,
        action: decision.action,
        reasonCode: decision.reasonCode,
      })),
    ]
      .sort((left, right) => {
        const timeOrder = compareCodePoints(left.at, right.at);
        if (timeOrder !== 0) {
          return timeOrder;
        }
        const kindOrder = compareCodePoints(left.kind, right.kind);
        return kindOrder !== 0
          ? kindOrder
          : compareCodePoints(left.id, right.id);
      })
      .slice(-timelineLimit);
    const latestReport =
      reportRead.facts.find((report) => report.reportId === state.latestReportId) ??
      reportRead.facts.at(-1);
    const baseProjection = {
      schemaVersion: SCHEMA_VERSION,
      storeVersion: STORE_VERSION,
      // foldRun remains the P1-A maintenance/recovery projection. Product
      // viewers use LoopController.snapshotForRun and graph-projection-v3.
      projectionVersion: LEGACY_FOLD_PROJECTION_VERSION,
      runId,
      status: state.status,
      revision: state.revision,
      currentLap: state.currentLap,
      continuationLease: state.continuationLease,
      cancelRequested: state.cancelRequested,
      needsHuman: state.needsHuman ?? false,
      nodes: [...nodes.values()].sort((left, right) =>
        compareCodePoints(left.id, right.id),
      ),
      counts: {
        events: canonicalEvents.length,
        eventCandidates: eventRead.facts.length,
        reports: reportRead.facts.length,
        transitions: transitionRead.facts.length,
        operations: operationRead.facts.length,
        governorDecisions:
          governorDecisionRead.facts.length,
        orphanReports:
          reportCandidates.facts.length - reportRead.facts.length,
        orphanTransitions:
          transitionCandidates.facts.length -
          transitionRead.facts.length,
        diagnostics: diagnosticRead.facts.length,
        conflicts: conflictGroups.length,
        corrupt: corruptRecords.length,
      },
      ...(latestReport
        ? {
            latestReport: {
              reportId: latestReport.reportId,
              fromNode: latestReport.fromNode,
              type: latestReport.type,
              ...(latestReport.verdict
                ? { verdict: latestReport.verdict }
                : {}),
            },
          }
        : {}),
      ...(state.pendingTransitionId
        ? { pendingTransitionId: state.pendingTransitionId }
        : {}),
      ...(state.latestGovernorDecisionId
        ? {
            latestGovernorDecisionId:
              state.latestGovernorDecisionId,
          }
        : {}),
      timeline,
    };
    const projection = {
      ...baseProjection,
      projectionDigest: digestJson(baseProjection),
    };
    if (writeProjection) {
      await atomicReplaceJson(this.projectionPath(runId), projection, {
        root: this.dataRoot,
      });
    }
    return projection;
  }

  async enforceRetention(runId, options = {}) {
    assertSafeFileId(runId, "runId");
    const lockPath = path.join(
      this.runDirectory(runId),
      "locks",
      "state.lock",
    );
    return withFileLock(
      lockPath,
      () => this.#enforceRetentionLocked(runId),
      { ...options, root: this.dataRoot },
    );
  }

  async #enforceRetentionLocked(runId) {
    const state = await this.readState(runId);
    if (!TERMINAL_STATUSES.has(state.status)) {
      return { status: "skipped-active", removed: [] };
    }
    const operationRead = await this.#readFacts(
      runId,
      "operations",
      validateLoopOperation,
    );
    const governorDecisionRead = await this.#readFacts(
      runId,
      "governor-decisions",
      validateGovernorDecision,
    );
    const recoveryRead = await this.#readFacts(
      runId,
      "recoveries",
      validateLegacyQuarantineReceipt,
    );
    const protectedIds = new Set(
      [
        state.latestReportId,
        state.pendingTransitionId,
        state.latestGovernorDecisionId,
        state.latestRecoveryId,
        ...operationRead.facts.flatMap((operation) => [
          operation.reportId,
          operation.transitionId,
        ]),
        ...governorDecisionRead.facts.flatMap(
          (decision) => [
            decision.decisionId,
            decision.originEventId,
            decision.pendingTransitionId,
          ],
        ),
        ...recoveryRead.facts.map(
          (recovery) => recovery.recoveryId,
        ),
      ].filter(Boolean),
    );
    const records = [];
    const retentionKinds = [
      "definitions",
      "events",
      "observations",
      "operations",
      "governor-decisions",
      "recoveries",
      "reports",
      "transitions",
      "diagnostics",
    ];
    for (const kind of retentionKinds) {
      const validator =
        kind === "diagnostics" ? validateDiagnostic : validatorFor(kind);
      const { facts } =
        kind === "operations"
          ? operationRead
          : kind === "governor-decisions"
            ? governorDecisionRead
            : kind === "recoveries"
              ? recoveryRead
            : await this.#readFacts(runId, kind, validator);
      for (const value of facts) {
        const id = factId(kind, value);
        const file = path.join(this.factDirectory(runId, kind), `${id}.json`);
        const metadata = await stat(file);
        records.push({
          kind,
          id,
          file,
          bytes: metadata.size,
          at:
            kind === "diagnostics"
              ? value.createdAt
              : factTime(kind, value),
          protected:
            [
              "definitions",
              "operations",
              "governor-decisions",
              "recoveries",
            ].includes(kind) ||
            protectedIds.has(id),
        });
      }
    }
    const removed = [];
    for (const kind of retentionKinds) {
      const limit =
        kind === "diagnostics"
          ? Math.max(0, this.retention[kind] - 1)
          : this.retention[kind];
      const candidates = records
        .filter((record) => record.kind === kind)
        .sort((left, right) => {
          const timeOrder = compareCodePoints(
            String(left.at),
            String(right.at),
          );
          return timeOrder !== 0
            ? timeOrder
            : compareCodePoints(left.id, right.id);
        });
      while (candidates.length > limit) {
        const index = candidates.findIndex((record) => !record.protected);
        if (index < 0) {
          break;
        }
        const [record] = candidates.splice(index, 1);
        await unlink(record.file);
        removed.push(record);
      }
    }
    let remainingBytes = records
      .filter((record) => !removed.includes(record))
      .reduce((sum, record) => sum + record.bytes, 0);
    const byteCandidates = records
      .filter((record) => !record.protected && !removed.includes(record))
      .sort((left, right) => {
        const timeOrder = compareCodePoints(
          String(left.at),
          String(right.at),
        );
        return timeOrder !== 0
          ? timeOrder
          : compareCodePoints(left.id, right.id);
      });
    while (
      remainingBytes > this.retention.terminalBytes &&
      byteCandidates.length > 0
    ) {
      const record = byteCandidates.shift();
      await unlink(record.file);
      removed.push(record);
      remainingBytes -= record.bytes;
    }
    if (removed.length > 0) {
      await this.writeDiagnostic(runId, "retention_pruned", {
        removedCount: removed.length,
        removedDigest: digestJson(
          removed
            .map((record) => ({ kind: record.kind, id: record.id }))
            .sort((left, right) =>
              compareCodePoints(
                `${left.kind}:${left.id}`,
                `${right.kind}:${right.id}`,
              ),
            ),
        ),
        remainingBytes,
      });
    }
    return {
      status: "pruned",
      removed: removed.map((record) => ({
        kind: record.kind,
        id: record.id,
      })),
      remainingBytes,
    };
  }
}
