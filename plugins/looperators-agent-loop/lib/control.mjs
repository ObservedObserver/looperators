import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  compareCodePoints,
  digestJson,
  sha256,
} from "./canonical-json.mjs";
import {
  ACTIVE_RUN_STATUSES,
  SCHEMA_VERSION,
  WORKER_ROLES,
  assertContract,
  assertSafeFileId,
  isNativeSpawnPreToolUse,
  validateGovernorDecision,
  validateIdentityBinding,
  validateLoopDefinition,
  validateLoopOperation,
  validateLoopReport,
  validateLoopTransition,
  validateWorkerObservation,
} from "./contracts.mjs";
import { buildAgentLoopProjection } from "./projection.mjs";
import {
  buildLegacyNativeTargetEvidence,
  collectLegacyNativeTargetEntries,
  createLegacyQuarantineReceipt,
  legacyEntryKey,
  recoveryIdFor,
  recoveryRequestDigest,
  terminalStateForRecovery,
} from "./recovery.mjs";

const NATIVE_SUBAGENT_SOURCE = "subagent";
const ROOT_METADATA_KEY = "x-codex-turn-metadata";
const ROOT_CONTROL_STATUSES = new Set([
  "draft",
  "running",
  "paused",
  "interrupted",
]);

export class LoopControlError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LoopControlError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new LoopControlError(code, message, details);
}

function boundedString(value, name, max = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max
  ) {
    fail("INVALID_TOOL_INPUT", `${name} is invalid`);
  }
  return value;
}

function requestId(value) {
  boundedString(value, "requestId", 128);
  try {
    assertSafeFileId(value, "requestId");
  } catch {
    fail("INVALID_TOOL_INPUT", "requestId is invalid");
  }
  if (value.startsWith("internal-")) {
    fail(
      "INVALID_TOOL_INPUT",
      "requestId uses a reserved internal namespace",
    );
  }
  return value;
}

function runId(value) {
  try {
    return assertSafeFileId(value, "runId");
  } catch {
    fail("INVALID_TOOL_INPUT", "runId is invalid");
  }
}

function agentId(value) {
  boundedString(value, "agentId", 256);
  return value;
}

function roleAgentId(role) {
  return `role:${role}`;
}

function digestsEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function derivedId(prefix, value) {
  return `${prefix}_${sha256(canonicalJson(value))}`;
}

function runIdFor(rootSessionId, previewRequestId) {
  return derivedId("run", {
    rootSessionId,
    requestId: previewRequestId,
  });
}

function definitionIdFor(value) {
  return derivedId("definition", {
    runId: value,
    kind: "definition",
  });
}

function operationIdFor(value, mutationRequestId) {
  return derivedId("op", {
    runId: value,
    requestId: mutationRequestId,
  });
}

function reportIdFor(value, mutationRequestId) {
  return derivedId("report", {
    runId: value,
    requestId: mutationRequestId,
    kind: "report",
  });
}

function transitionIdFor(value, mutationRequestId) {
  return derivedId("transition", {
    runId: value,
    requestId: mutationRequestId,
    kind: "transition",
  });
}

function factLimitRequestId(fromRevision) {
  return `internal-fact-limit-${fromRevision}`;
}

function reportPayload(report) {
  return {
    type: report.type,
    ...(report.status ? { status: report.status } : {}),
    ...(report.verdict ? { verdict: report.verdict } : {}),
    ...(report.issues ? { issues: report.issues } : {}),
    ...(report.summary ? { summary: report.summary } : {}),
  };
}

function bindingRequestDigest(input) {
  return digestJson({
    kind: "bind-worker",
    runId: input.runId,
    requestId: input.requestId,
    agentId: input.agentId,
    role: input.role,
    observationId: input.observationId,
    originEventId: input.originEventId,
  });
}

function observationIdFor(value, mutationRequestId) {
  return derivedId("observation", {
    runId: value,
    requestId: mutationRequestId,
    kind: "prepare-worker-spawn",
  });
}

function observationRequestDigest(input) {
  return digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: "prepare-worker-spawn",
    runId: input.runId,
    requestId: input.requestId,
    rootSessionId: input.rootSessionId,
    role: input.role,
  });
}

function mutationRequestDigest(input) {
  return digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: input.kind,
    runId: input.runId,
    requestId: input.requestId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: input.payload ?? {},
  });
}

function definitionRequestDigest(input) {
  return digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: "preview",
    rootSessionId: input.rootSessionId,
    requestId: input.requestId,
    recipe: "review-until-clean",
    goal: input.goal,
    implementerInstructions: input.implementerInstructions,
    reviewerInstructions: input.reviewerInstructions,
    lapCap: input.lapCap,
  });
}

function assertRootContext(context) {
  if (
    !context ||
    typeof context.rootSessionId !== "string" ||
    typeof context.turnId !== "string"
  ) {
    fail(
      "ROOT_IDENTITY_UNAVAILABLE",
      "trusted root task metadata is unavailable",
    );
  }
  return context;
}

export function rootContextFromMcpMessage(message) {
  const metadata =
    message?.params?._meta?.[ROOT_METADATA_KEY];
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    typeof metadata.session_id !== "string" ||
    metadata.session_id.length === 0 ||
    metadata.session_id.length > 512 ||
    typeof metadata.turn_id !== "string" ||
    metadata.turn_id.length === 0 ||
    metadata.turn_id.length > 512 ||
    typeof metadata.thread_source !== "string" ||
    metadata.thread_source.length === 0 ||
    metadata.thread_source.length > 128
  ) {
    fail(
      "ROOT_IDENTITY_UNAVAILABLE",
      "trusted root task metadata is unavailable",
    );
  }
  const rootSessionId = metadata.session_id;
  const turnId = metadata.turn_id;
  const threadSource = metadata.thread_source;
  const nativeAgentId = metadata.agent_id;
  if (
    nativeAgentId !== undefined &&
    (typeof nativeAgentId !== "string" ||
      nativeAgentId.length === 0 ||
      nativeAgentId.length > 512)
  ) {
    fail(
      "ROOT_IDENTITY_UNAVAILABLE",
      "trusted root task metadata is unavailable",
    );
  }
  if (threadSource === NATIVE_SUBAGENT_SOURCE) {
    fail(
      "ROOT_ONLY_TOOL",
      "this tool may only be called by the root task",
    );
  }
  return Object.freeze({ rootSessionId, turnId, threadSource });
}

async function maybeRead(reader) {
  try {
    return await reader();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function stateSummary(state, definition, duplicate = false) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    status: state.status,
    revision: state.revision,
    currentLap: state.currentLap,
    lapCap: definition.lapCap,
    continuationLease: state.continuationLease,
    cancelRequested: state.cancelRequested,
    needsHuman: state.needsHuman ?? false,
    duplicate,
    ...(state.pendingTransitionId
      ? { pendingTransitionId: state.pendingTransitionId }
      : {}),
    ...(state.latestReportId
      ? { latestReportId: state.latestReportId }
      : {}),
    ...(state.latestGovernorDecisionId
      ? {
          latestGovernorDecisionId:
            state.latestGovernorDecisionId,
        }
      : {}),
    ...(state.latestRecoveryId
      ? { latestRecoveryId: state.latestRecoveryId }
      : {}),
  };
}

function previewGraph() {
  return {
    nodes: [
      { id: "root-master", role: "root" },
      { id: "role:implementer", role: "implementer" },
      { id: "role:reviewer", role: "reviewer" },
    ],
    edges: [
      {
        from: "role:implementer",
        to: "role:reviewer",
        on: "done",
      },
      {
        from: "role:reviewer",
        to: "role:implementer",
        on: "issues",
      },
      {
        from: "role:reviewer",
        to: "root-master",
        on: "clean",
      },
    ],
  };
}

function withoutPending(state) {
  const { pendingTransitionId: _pending, ...rest } = state;
  return rest;
}

function governedTransitionRole(transition) {
  if (transition.kind === "activate-implementer") {
    return "implementer";
  }
  if (transition.kind === "activate-reviewer") {
    return "reviewer";
  }
  return null;
}

function workerObservationSnapshot(
  evidence,
  bindings,
  rootSessionId,
) {
  const spawnToolUseIds = [
    ...new Set(
      evidence
        .filter(
          (event) =>
            event.conflictEligible === true &&
            event.sessionId === rootSessionId &&
            isNativeSpawnPreToolUse(event) &&
            typeof event.toolUseId === "string",
        )
        .map((event) => event.toolUseId),
    ),
  ].sort(compareCodePoints);
  const starts = evidence
    .filter(
      (event) =>
        event.event === "SubagentStart" &&
        event.conflictEligible === true &&
        event.sessionId === rootSessionId &&
        typeof event.agentId === "string",
    )
    .sort((left, right) => {
      const observedOrder = compareCodePoints(
        left.observedAt,
        right.observedAt,
      );
      return observedOrder !== 0
        ? observedOrder
        : compareCodePoints(left.eventId, right.eventId);
    });
  const subagentStartEventIds = starts
    .map((event) => event.eventId)
    .sort(compareCodePoints);
  const bindingIds = bindings
    .map((binding) => binding.bindingId)
    .sort(compareCodePoints);
  const base = {
    spawnToolUseIds,
    subagentStartEventIds,
    bindingIds,
  };
  return {
    ...base,
    starts,
    observationDigest: digestJson(base),
  };
}

function difference(values, baseline) {
  const prior = new Set(baseline);
  return values.filter((value) => !prior.has(value));
}

export class LoopController {
  constructor(store, options = {}) {
    this.store = store;
    this.now =
      options.now ?? (() => new Date().toISOString());
    this.fault = options.fault ?? (async () => {});
    this.actionTokens = new Map();
  }

  async preview(contextValue, input) {
    const context = assertRootContext(contextValue);
    const previewRequestId = requestId(input?.requestId);
    const lapCap = input?.lapCap ?? 3;
    const goal = boundedString(input?.goal, "goal", 8192);
    const implementerInstructions = boundedString(
      input?.implementerInstructions,
      "implementerInstructions",
      16384,
    );
    const reviewerInstructions = boundedString(
      input?.reviewerInstructions,
      "reviewerInstructions",
      16384,
    );
    if (!Number.isInteger(lapCap) || lapCap < 1 || lapCap > 6) {
      fail("INVALID_TOOL_INPUT", "lapCap is invalid");
    }
    const desiredRunId = runIdFor(
      context.rootSessionId,
      previewRequestId,
    );
    const desired = assertContract(
      "loop definition",
      {
        schemaVersion: SCHEMA_VERSION,
        definitionId: definitionIdFor(desiredRunId),
        runId: desiredRunId,
        requestId: previewRequestId,
        requestDigest: definitionRequestDigest({
          rootSessionId: context.rootSessionId,
          requestId: previewRequestId,
          goal,
          implementerInstructions,
          reviewerInstructions,
          lapCap,
        }),
        recipe: "review-until-clean",
        goal,
        implementerInstructions,
        reviewerInstructions,
        lapCap,
        createdAt: this.now(),
      },
      validateLoopDefinition,
    );

    const existingDefinition = await maybeRead(() =>
      this.store.readDefinition(desiredRunId),
    );
    if (existingDefinition) {
      if (
        existingDefinition.requestDigest !==
        desired.requestDigest
      ) {
        fail(
          "REQUEST_ID_CONFLICT",
          "preview request id already has different content",
        );
      }
      const state = await this.#ensurePreviewDraft(
        context,
        existingDefinition,
      );
      return this.#previewResult(
        state,
        existingDefinition,
        true,
      );
    }

    const bound = await this.store.boundRunsForSession(
      context.rootSessionId,
    );
    const occupied = bound.find(
      ({ state }) =>
        state === null || ACTIVE_RUN_STATUSES.has(state.status),
    );
    if (occupied) {
      fail(
        "ACTIVE_RUN_EXISTS",
        "another non-terminal loop run already exists in this task",
        { runId: occupied.binding.runId },
      );
    }

    const published = await this.store.putDefinition(
      desiredRunId,
      desired,
    );
    if (published.status === "conflict") {
      fail(
        "REQUEST_ID_CONFLICT",
        "preview request id already has different content",
      );
    }
    await this.fault("afterDefinition", {
      runId: desiredRunId,
    });
    const state = await this.#ensurePreviewDraft(
      context,
      desired,
    );
    return this.#previewResult(
      state,
      desired,
      published.status === "duplicate",
    );
  }

  async #ensurePreviewDraft(context, definition) {
    try {
      return await this.#ensureDraftState(context, definition);
    } catch (error) {
      if (
        ![
          "SESSION_BINDING_CONFLICT",
          "SESSION_BINDING_RESERVED",
        ].includes(error?.code)
      ) {
        throw error;
      }
      const current = await this.store.boundRunsForSession(
        context.rootSessionId,
      );
      fail(
        "ACTIVE_RUN_EXISTS",
        "another non-terminal loop run already exists in this task",
        { runId: current[0]?.binding.runId },
      );
    }
  }

  async #ensureDraftState(context, definition) {
    const existing = await maybeRead(() =>
      this.store.readState(definition.runId),
    );
    if (existing) {
      this.#assertRoot(existing, context);
      if (existing.status !== "draft") {
        fail(
          "RUN_ALREADY_STARTED",
          "preview request already belongs to a started run",
          { runId: existing.runId, status: existing.status },
        );
      }
      return existing;
    }
    const state = {
      schemaVersion: SCHEMA_VERSION,
      runId: definition.runId,
      rootSessionId: context.rootSessionId,
      originatingTurnId: context.turnId,
      scope: { kind: "task" },
      masterNode: context.rootSessionId,
      recipe: "review-until-clean",
      status: "draft",
      currentLap: 0,
      continuationLease: {
        granted: definition.lapCap,
        consumed: 0,
      },
      cancelRequested: false,
      revision: 0,
      createdAt: definition.createdAt,
      updatedAt: definition.createdAt,
    };
    const result = await this.store.initializeRun(state);
    return result.existing ?? state;
  }

  #previewResult(state, definition, duplicate) {
    return {
      ...stateSummary(state, definition, duplicate),
      definition,
      preview: previewGraph(),
    };
  }

  #assertRoot(state, context) {
    assertRootContext(context);
    if (state.rootSessionId !== context.rootSessionId) {
      fail(
        "ROOT_IDENTITY_MISMATCH",
        "root task does not own this loop run",
      );
    }
  }

  #assertIdentityBindingTopology(
    bindingRead,
    rootSessionId,
  ) {
    const bindings = bindingRead.facts;
    if (
      bindings.some(
        (binding) =>
          binding.rootSessionId !== rootSessionId ||
          !WORKER_ROLES.has(binding.role),
      ) ||
      bindings.length > 2
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "worker identity bindings do not match the authoritative root and role topology",
      );
    }
    const roleCounts = new Map();
    for (const binding of bindings) {
      roleCounts.set(
        binding.role,
        (roleCounts.get(binding.role) ?? 0) + 1,
      );
    }
    const topologyIsValid =
      bindings.length === 0 ||
      (bindings.length === 1 &&
        roleCounts.get("implementer") === 1) ||
      (bindings.length === 2 &&
        roleCounts.get("implementer") === 1 &&
        roleCounts.get("reviewer") === 1);
    if (!topologyIsValid) {
      fail(
        "RECOVERY_REQUIRED",
        "worker identity bindings violate implementer-first topology",
      );
    }
  }

  #assertRequestNamespace(
    targetRequestId,
    expectedNamespace,
    values,
  ) {
    const claims = [
      ...(values.definition.requestId === targetRequestId
        ? ["definition"]
        : []),
      ...values.operations
        .filter(
          (operation) =>
            operation.requestId === targetRequestId,
        )
        .map(() => "operations"),
      ...values.observations
        .filter(
          (observation) =>
            observation.requestId === targetRequestId,
        )
        .map(() => "observations"),
      ...values.bindings
        .filter(
          (binding) =>
            binding.requestId === targetRequestId,
        )
        .map(() => "identity"),
      ...(values.recoveries ?? [])
        .filter(
          (recovery) =>
            recovery.requestId === targetRequestId,
        )
        .map(() => "recoveries"),
    ];
    if (
      claims.some(
        (namespace) => namespace !== expectedNamespace,
      )
    ) {
      fail(
        "REQUEST_ID_CONFLICT",
        "request id already belongs to another mutation namespace",
      );
    }
  }

  #assertDurableRequestNamespaces(values) {
    const claims = new Map();
    const claim = (request, namespace) => {
      if (typeof request !== "string") {
        return;
      }
      const namespaces = claims.get(request) ?? new Set();
      namespaces.add(namespace);
      claims.set(request, namespaces);
    };
    claim(values.definition.requestId, "definition");
    for (const operation of values.operations) {
      claim(operation.requestId, "operations");
    }
    for (const observation of values.observations) {
      claim(observation.requestId, "observations");
    }
    for (const binding of values.bindings) {
      claim(binding.requestId, "identity");
    }
    for (const recovery of values.recoveries) {
      claim(recovery.requestId, "recoveries");
    }
    const collisions = [...claims.entries()]
      .filter(([, namespaces]) => namespaces.size > 1)
      .map(([request, namespaces]) => ({
        requestIdDigest: sha256(request),
        namespaces: [...namespaces].sort(compareCodePoints),
      }))
      .sort((left, right) =>
        compareCodePoints(
          left.requestIdDigest,
          right.requestIdDigest,
        ),
      );
    if (collisions.length > 0) {
      fail(
        "HISTORY_CORRUPT",
        "durable request ids cross mutation namespaces",
        { collisions },
      );
    }
  }

  async #readRequestNamespacePlane(targetRunId) {
    const [
      definition,
      operationRead,
      observationRead,
      bindingRead,
      recoveryRead,
    ] = await Promise.all([
      this.store.readDefinition(targetRunId),
      this.store.listOperations(targetRunId),
      this.store.listWorkerObservations(targetRunId),
      this.store.listIdentityBindings(targetRunId),
      this.store.listRecoveries(targetRunId),
    ]);
    if (
      [
        operationRead,
        observationRead,
        bindingRead,
        recoveryRead,
      ].some((read) => read.corrupt.length > 0)
    ) {
      fail(
        "HISTORY_CORRUPT",
        "request namespace history could not be verified",
      );
    }
    this.#assertDurableRequestNamespaces({
      definition,
      operations: operationRead.facts,
      observations: observationRead.facts,
      bindings: bindingRead.facts,
      recoveries: recoveryRead.facts,
    });
    return {
      definition,
      operationRead,
      observationRead,
      bindingRead,
      recoveryRead,
    };
  }

  async #readLegacyRecoveryPlane(targetRunId) {
    const [
      state,
      definition,
      operationRead,
      governorDecisionRead,
      recoveryRead,
      reportRead,
      transitionRead,
      bindingRead,
      observationRead,
    ] = await Promise.all([
      this.store.readState(targetRunId),
      this.store.readDefinition(targetRunId),
      this.store.listOperations(targetRunId),
      this.store.listGovernorDecisions(targetRunId),
      this.store.listRecoveries(targetRunId),
      this.store.listReports(targetRunId),
      this.store.listTransitions(targetRunId),
      this.store.listIdentityBindings(targetRunId),
      this.store.listWorkerObservations(targetRunId),
    ]);
    const reads = [
      operationRead,
      governorDecisionRead,
      recoveryRead,
      reportRead,
      transitionRead,
      bindingRead,
      observationRead,
    ];
    if (reads.some((read) => read.corrupt.length > 0)) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery history could not be verified",
      );
    }
    this.#assertIdentityBindingTopology(
      bindingRead,
      state.rootSessionId,
    );
    this.#assertDurableRequestNamespaces({
      definition,
      operations: operationRead.facts,
      observations: observationRead.facts,
      bindings: bindingRead.facts,
      recoveries: recoveryRead.facts,
    });
    return {
      definition,
      operationRead,
      governorDecisionRead,
      recoveryRead,
      reportRead,
      transitionRead,
      bindingRead,
      observationRead,
    };
  }

  #legacyEvidenceFromPlane(state, plane) {
    return buildLegacyNativeTargetEvidence({
      state,
      definition: plane.definition,
      operations: plane.operationRead.facts,
      governorDecisions:
        plane.governorDecisionRead.facts,
      transitions: plane.transitionRead.facts,
      reports: plane.reportRead.facts,
      bindings: plane.bindingRead.facts,
    });
  }

  async #verifyLegacyEvidence(state, plane) {
    const evidence = this.#legacyEvidenceFromPlane(
      state,
      plane,
    );
    await this.#validateDurableControlHistory(
      state,
      plane.operationRead,
      plane.governorDecisionRead,
      { facts: [], corrupt: [] },
      {
        reportRead: plane.reportRead,
        transitionRead: plane.transitionRead,
        ...(evidence ? { legacyEvidence: evidence } : {}),
      },
    );
    return evidence;
  }

  #assertPreparedRecoveryIdentity(
    state,
    receipt,
    context,
    input,
  ) {
    this.#assertRecoveryReceiptInvariant(state, receipt);
    if (
      receipt.requestId !== input.requestId ||
      receipt.actorId !== context.rootSessionId ||
      receipt.fromRevision !== input.expectedRevision ||
      receipt.evidenceDigest !==
        input.expectedEvidenceDigest
    ) {
      fail(
        "REQUEST_ID_CONFLICT",
        "legacy recovery request does not match its immutable receipt",
      );
    }
  }

  #assertRecoveryReceiptInvariant(state, receipt) {
    if (
      receipt.recoveryId !==
        recoveryIdFor(
          receipt.runId,
          receipt.requestId,
        ) ||
      receipt.runId !== state.runId ||
      receipt.actorKind !== "root" ||
      receipt.actorId !== state.rootSessionId ||
      receipt.requestDigest !==
        recoveryRequestDigest({
          runId: receipt.runId,
          requestId: receipt.requestId,
          actorId: receipt.actorId,
          expectedRevision: receipt.fromRevision,
          expectedEvidenceDigest:
            receipt.evidenceDigest,
        })
    ) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery receipt identity is invalid",
      );
    }
  }

  #assertPreparedRecoveryBarrier(
    state,
    recoveryRead,
    options = {},
  ) {
    if (recoveryRead.corrupt.length > 0) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery receipt is corrupt",
      );
    }
    if (recoveryRead.facts.length > 1) {
      fail(
        "RECOVERY_REQUIRED",
        "multiple legacy recovery receipts exist for one run",
      );
    }
    const receipt = recoveryRead.facts[0];
    if (!receipt) {
      return;
    }
    this.#assertRecoveryReceiptInvariant(state, receipt);
    if (
      state.latestRecoveryId === receipt.recoveryId &&
      state.revision === receipt.toRevision
    ) {
      if (
        digestJson(state) !== receipt.terminalStateDigest
      ) {
        fail(
          "HISTORY_CORRUPT",
          "quarantined state does not match its recovery receipt",
        );
      }
      return;
    }
    if (
      state.revision !== receipt.fromRevision ||
      digestJson(state) !== receipt.priorStateDigest
    ) {
      fail(
        "LEGACY_RECOVERY_ORPHANED",
        "prepared legacy recovery no longer matches durable state",
      );
    }
    if (
      digestJson(
        terminalStateForRecovery(state, receipt),
      ) !== receipt.terminalStateDigest
    ) {
      fail(
        "HISTORY_CORRUPT",
        "prepared legacy recovery terminal state is invalid",
      );
    }
    if ((options.normalPreparedCount ?? 0) > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "legacy recovery competes with another prepared receipt",
      );
    }
    fail(
      "LEGACY_RECOVERY_PENDING",
      "a legacy recovery receipt awaits explicit confirmation",
    );
  }

  #legacyRecoveryResult(
    state,
    receipt,
    duplicate,
    verification,
  ) {
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: state.runId,
      status: state.status,
      revision: state.revision,
      recoveryId: receipt.recoveryId,
      duplicate,
      verification,
    };
  }

  async #appliedRecoveryVerification(
    state,
    receipt,
  ) {
    try {
      const plane =
        await this.#readLegacyRecoveryPlane(state.runId);
      await this.#validateDurableControlHistory(
        state,
        plane.operationRead,
        plane.governorDecisionRead,
        plane.recoveryRead,
        {
          reportRead: plane.reportRead,
          transitionRead: plane.transitionRead,
        },
      );
      return state.latestRecoveryId === receipt.recoveryId
        ? "verified"
        : "quarantined-unverified";
    } catch {
      return "quarantined-unverified";
    }
  }

  async previewLegacyRecovery(contextValue, input) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    return this.store.withControlLock(
      targetRunId,
      async () => {
        const state = await this.store.readState(targetRunId);
        this.#assertRoot(state, context);
        const plane =
          await this.#readLegacyRecoveryPlane(targetRunId);
        if (plane.recoveryRead.facts.length > 1) {
          fail(
            "RECOVERY_REQUIRED",
            "multiple legacy recovery receipts exist for one run",
          );
        }
        const receipt = plane.recoveryRead.facts[0];
        if (receipt) {
          this.#assertRecoveryReceiptInvariant(
            state,
            receipt,
          );
          if (
            state.latestRecoveryId === receipt.recoveryId &&
            state.revision === receipt.toRevision &&
            digestJson(state) ===
              receipt.terminalStateDigest
          ) {
            await this.#validateDurableControlHistory(
              state,
              plane.operationRead,
              plane.governorDecisionRead,
              plane.recoveryRead,
              {
                reportRead: plane.reportRead,
                transitionRead: plane.transitionRead,
              },
            );
            return {
              schemaVersion: SCHEMA_VERSION,
              runId: targetRunId,
              eligible: false,
              quarantined: true,
              pendingRecovery: false,
              revision: state.revision,
              legacyFactCount:
                receipt.legacyFactCount,
              evidenceDigest: receipt.evidenceDigest,
              terminalStatus: "failed",
              warningCode:
                "LEGACY_HISTORY_ALREADY_QUARANTINED",
            };
          }
          if (
            state.revision !== receipt.fromRevision ||
            digestJson(state) !== receipt.priorStateDigest
          ) {
            fail(
              "LEGACY_RECOVERY_ORPHANED",
              "prepared legacy recovery no longer matches durable state",
            );
          }
          if (
            digestJson(
              terminalStateForRecovery(state, receipt),
            ) !== receipt.terminalStateDigest
          ) {
            fail(
              "HISTORY_CORRUPT",
              "prepared legacy recovery terminal state is invalid",
            );
          }
          let evidenceMatches = false;
          try {
            const current =
              this.#legacyEvidenceFromPlane(state, plane);
            evidenceMatches =
              current?.evidenceDigest ===
                receipt.evidenceDigest &&
              current.entries.length ===
                receipt.legacyFactCount;
          } catch {
            evidenceMatches = false;
          }
          return {
            schemaVersion: SCHEMA_VERSION,
            runId: targetRunId,
            eligible: true,
            quarantined: false,
            pendingRecovery: true,
            revision: state.revision,
            legacyFactCount: receipt.legacyFactCount,
            evidenceDigest: receipt.evidenceDigest,
            evidenceMatches,
            terminalStatus: "failed",
            warningCode:
              "LEGACY_RECOVERY_CONFIRM_REQUIRED",
          };
        }
        if (!ROOT_CONTROL_STATUSES.has(state.status)) {
          fail(
            "INVALID_STATE_TRANSITION",
            "only a non-terminal run can enter legacy quarantine",
          );
        }
        const evidence = await this.#verifyLegacyEvidence(
          state,
          plane,
        );
        return {
          schemaVersion: SCHEMA_VERSION,
          runId: targetRunId,
          eligible: Boolean(evidence),
          quarantined: false,
          pendingRecovery: false,
          revision: state.revision,
          legacyFactCount: evidence?.entries.length ?? 0,
          ...(evidence
            ? { evidenceDigest: evidence.evidenceDigest }
            : {}),
          terminalStatus: "failed",
          warningCode: evidence
            ? "LEGACY_HISTORY_QUARANTINE_AVAILABLE"
            : "NO_LEGACY_NATIVE_TARGET_HISTORY",
        };
      },
    );
  }

  async quarantineLegacy(contextValue, input) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    const targetRequestId = requestId(input?.requestId);
    const expectedRevision = input?.expectedRevision;
    const expectedEvidenceDigest =
      input?.expectedEvidenceDigest;
    if (
      input?.confirm !== true ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0 ||
      typeof expectedEvidenceDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedEvidenceDigest)
    ) {
      fail(
        "INVALID_TOOL_INPUT",
        "legacy quarantine confirmation is invalid",
      );
    }
    return this.store.withControlLock(
      targetRunId,
      async () => {
        let state = await this.store.readState(targetRunId);
        this.#assertRoot(state, context);
        const namespacePlane =
          await this.#readRequestNamespacePlane(
            targetRunId,
          );
        const { recoveryRead } = namespacePlane;
        if (recoveryRead.facts.length > 1) {
          fail(
            "RECOVERY_REQUIRED",
            "multiple legacy recovery receipts exist for one run",
          );
        }
        const existing = recoveryRead.facts[0];
        if (existing) {
          this.#assertPreparedRecoveryIdentity(
            state,
            existing,
            context,
            {
              requestId: targetRequestId,
              expectedRevision,
              expectedEvidenceDigest,
            },
          );
          if (
            state.latestRecoveryId ===
              existing.recoveryId &&
            state.revision === existing.toRevision
          ) {
            if (
              digestJson(state) !==
              existing.terminalStateDigest
            ) {
              fail(
                "HISTORY_CORRUPT",
                "quarantined state does not match its recovery receipt",
              );
            }
            return this.#legacyRecoveryResult(
              state,
              existing,
              true,
              await this.#appliedRecoveryVerification(
                state,
                existing,
              ),
            );
          }
          if (
            state.revision !== existing.fromRevision ||
            digestJson(state) !==
              existing.priorStateDigest
          ) {
            fail(
              "LEGACY_RECOVERY_ORPHANED",
              "prepared legacy recovery no longer matches durable state",
            );
          }
          let verified = false;
          try {
            const plane =
              await this.#readLegacyRecoveryPlane(
                targetRunId,
              );
            const evidence =
              this.#legacyEvidenceFromPlane(state, plane);
            verified =
              evidence?.evidenceDigest ===
                existing.evidenceDigest &&
              evidence.entries.length ===
                existing.legacyFactCount;
          } catch {
            verified = false;
          }
          const next = terminalStateForRecovery(
            state,
            existing,
          );
          if (
            digestJson(next) !==
              existing.terminalStateDigest
          ) {
            fail(
              "HISTORY_CORRUPT",
              "prepared recovery terminal state is invalid",
            );
          }
          state = await this.store.compareAndSwapState(
            targetRunId,
            state.revision,
            next,
          );
          await this.fault("afterRecoveryCas", {
            runId: targetRunId,
            requestId: targetRequestId,
          });
          return this.#legacyRecoveryResult(
            state,
            existing,
            false,
            verified
              ? "verified"
              : "quarantined-unverified",
          );
        }

        if (
          state.revision !== expectedRevision ||
          !ROOT_CONTROL_STATUSES.has(state.status)
        ) {
          fail(
            "STALE_RECOVERY_PREVIEW",
            "legacy recovery preview no longer matches durable state",
          );
        }
        const plane =
          await this.#readLegacyRecoveryPlane(targetRunId);
        this.#assertRequestNamespace(
          targetRequestId,
          "recoveries",
          {
            definition: plane.definition,
            operations: plane.operationRead.facts,
            observations: plane.observationRead.facts,
            bindings: plane.bindingRead.facts,
            recoveries: plane.recoveryRead.facts,
          },
        );
        const normalPrepared = [
          ...plane.operationRead.facts,
          ...plane.governorDecisionRead.facts,
        ].filter(
          (receipt) =>
            receipt.fromRevision === state.revision,
        );
        if (normalPrepared.length > 0) {
          fail(
            "RECOVERY_REQUIRED",
            "legacy recovery competes with a prepared control receipt",
          );
        }
        const evidence = await this.#verifyLegacyEvidence(
          state,
          plane,
        );
        if (!evidence) {
          fail(
            "NO_LEGACY_NATIVE_TARGET_HISTORY",
            "run has no eligible legacy native-target history",
          );
        }
        if (
          evidence.evidenceDigest !==
          expectedEvidenceDigest
        ) {
          fail(
            "STALE_RECOVERY_PREVIEW",
            "legacy recovery evidence changed after preview",
          );
        }
        const receipt = createLegacyQuarantineReceipt({
          state,
          requestId: targetRequestId,
          actorId: context.rootSessionId,
          evidence,
          createdAt: this.now(),
        });
        const published = await this.store.putRecovery(
          targetRunId,
          receipt,
        );
        if (published.status === "conflict") {
          fail(
            "REQUEST_ID_CONFLICT",
            "legacy recovery receipt conflicts with this request",
          );
        }
        if (published.status === "limit") {
          fail(
            "FACT_LIMIT_REACHED",
            "legacy recovery receipt capacity was reached before publication",
          );
        }
        if (
          !["created", "duplicate"].includes(
            published.status,
          )
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "legacy recovery receipt could not be published",
          );
        }
        await this.fault("afterRecoveryReceipt", {
          runId: targetRunId,
          requestId: targetRequestId,
        });
        const next = terminalStateForRecovery(
          state,
          receipt,
        );
        state = await this.store.compareAndSwapState(
          targetRunId,
          state.revision,
          next,
        );
        await this.fault("afterRecoveryCas", {
          runId: targetRunId,
          requestId: targetRequestId,
        });
        return this.#legacyRecoveryResult(
          state,
          receipt,
          false,
          "verified",
        );
      },
    );
  }

  async getLoop(contextValue, input) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.snapshotForRun(targetRunId, {
        rootContext: context,
      });
      const state = await this.store.readState(targetRunId);
      this.#assertRoot(state, context);
      const definition =
        await this.store.readDefinition(targetRunId);
      const roleCapability =
        await this.#currentRoleCapability(state);
      const identityPlane =
        await this.store.withWorkerObservationSnapshotLock(
          targetRunId,
          () =>
            this.#readIdentityPlane(
              targetRunId,
              context.rootSessionId,
            ),
        );
      const { bindingRead, observedRead, snapshot } =
        identityPlane;
      const roleByAgentId = new Map(
        bindingRead.facts.map((binding) => [
          binding.agentId,
          binding.role,
        ]),
      );
      const pendingTransition = state.pendingTransitionId
        ? await maybeRead(() =>
            this.store.readTransition(
              targetRunId,
              state.pendingTransitionId,
            ),
          )
        : null;
      const latestReport = state.latestReportId
        ? await maybeRead(() =>
            this.store.readReport(
              targetRunId,
              state.latestReportId,
            ),
          )
        : null;
      const after = await this.snapshotForRun(targetRunId, {
        rootContext: context,
      });
      const coherentState =
        canonicalJson({
          runId: state.runId,
          revision: state.revision,
          status: state.status,
          currentLap: state.currentLap,
          lapCap: definition.lapCap,
          continuationLease: state.continuationLease,
          cancelRequested: state.cancelRequested,
          needsHuman: state.needsHuman ?? false,
          pendingTransitionId:
            state.pendingTransitionId ?? null,
          latestReportId:
            state.latestReportId ?? null,
          latestRecoveryId:
            state.latestRecoveryId ?? null,
        }) ===
        canonicalJson({
          runId: after.runId,
          revision: after.revision,
          status: after.status,
          currentLap: after.currentLap,
          lapCap: after.lapCap,
          continuationLease:
            after.continuationLease,
          cancelRequested: after.cancelRequested,
          needsHuman: after.needsHuman,
          pendingTransitionId:
            after.pending?.transitionId ?? null,
          latestReportId:
            after.latestReport?.reportId ?? null,
          latestRecoveryId:
            after.recovery?.recoveryId ?? null,
        });
      if (
        before.projectionDigest !==
          after.projectionDigest ||
        !coherentState
      ) {
        continue;
      }
      return {
        ...stateSummary(state, definition),
        definition,
        bindings: bindingRead.facts
          .map((binding) => ({
            agentId: binding.agentId,
            role: binding.role,
            method: binding.method,
            createdAt: binding.createdAt,
          }))
          .sort((left, right) =>
            compareCodePoints(
              `${left.role}:${left.agentId}`,
              `${right.role}:${right.agentId}`,
            ),
          ),
        observedWorkers: observedRead.facts.map((event) => ({
          agentId: event.agentId,
          agentType: event.agentType ?? "unknown",
          eventId: event.eventId,
          observedAt: event.observedAt,
          ...(roleByAgentId.has(event.agentId)
            ? {
                boundRole: roleByAgentId.get(
                  event.agentId,
                ),
              }
            : {}),
        })),
        workerObservation: {
          observationDigest:
            snapshot.observationDigest,
          spawnCount: snapshot.spawnToolUseIds.length,
          workerStartCount:
            snapshot.subagentStartEventIds.length,
          pendingCount: identityPlane.pendingCount,
          balanced:
            snapshot.spawnToolUseIds.length ===
            snapshot.subagentStartEventIds.length,
        },
        ...(roleCapability ? { roleCapability } : {}),
        ...(pendingTransition
          ? { pendingTransition }
          : {}),
        ...(latestReport ? { latestReport } : {}),
        projectionDigest: after.projectionDigest,
        eventWatermark: after.eventWatermark,
      };
    }
    fail(
      "SNAPSHOT_BUSY",
      "authoritative loop changed while it was being read",
    );
  }

  async getSnapshot(contextValue, input) {
    const context = assertRootContext(contextValue);
    return this.snapshotForRun(runId(input?.runId), {
      rootContext: context,
    });
  }

  async snapshotForRun(targetRunIdValue, options = {}) {
    const targetRunId = runId(targetRunIdValue);
    const lockTimeoutMs = options.lockTimeoutMs ?? 250;
    if (
      !Number.isInteger(lockTimeoutMs) ||
      lockTimeoutMs < 1 ||
      lockTimeoutMs > 5_000
    ) {
      fail(
        "INVALID_SNAPSHOT_OPTIONS",
        "snapshot lock timeout is invalid",
      );
    }
    try {
      return await this.store.withControlLock(
        targetRunId,
        async () => {
          const state = await this.store.readState(targetRunId);
          if (options.rootContext) {
            this.#assertRoot(state, options.rootContext);
          }
          const [
            operationRead,
            governorDecisionRead,
            eventRead,
            reportRead,
            transitionRead,
            bindingRead,
            observationRead,
            diagnosticRead,
            recoveryRead,
          ] = await Promise.all([
            this.store.listOperations(targetRunId),
            this.store.listGovernorDecisions(targetRunId),
            this.store.listEvents(targetRunId),
            this.store.listReports(targetRunId),
            this.store.listTransitions(targetRunId),
            this.store.listIdentityBindings(targetRunId),
            this.store.listWorkerObservations(targetRunId),
            this.store.listDiagnostics(targetRunId),
            this.store.listRecoveries(targetRunId),
          ]);
          const reads = [
            operationRead,
            governorDecisionRead,
            eventRead,
            reportRead,
            transitionRead,
            bindingRead,
            observationRead,
            diagnosticRead,
            recoveryRead,
          ];
          if (reads.some((read) => read.corrupt.length > 0)) {
            fail(
              "HISTORY_CORRUPT",
              "authoritative loop history could not be verified",
            );
          }
          const definition =
            await this.store.readDefinition(targetRunId);
          this.#assertDurableRequestNamespaces({
            definition,
            operations: operationRead.facts,
            observations: observationRead.facts,
            bindings: bindingRead.facts,
            recoveries: recoveryRead.facts,
          });
          this.#assertPreparedRecoveryBarrier(
            state,
            recoveryRead,
            {
              normalPreparedCount: [
                ...operationRead.facts,
                ...governorDecisionRead.facts,
              ].filter(
                (receipt) =>
                  receipt.fromRevision ===
                  state.revision,
              ).length,
            },
          );
          if (!state.latestRecoveryId) {
            this.#detectUnsupportedNativeTargets(
              state,
              bindingRead,
              operationRead,
              reportRead,
              transitionRead,
            );
          }
          const verified =
            await this.#validateDurableControlHistory(
              state,
              operationRead,
              governorDecisionRead,
              recoveryRead,
              { reportRead, transitionRead },
            );
          return buildAgentLoopProjection({
            state,
            definition: verified.definition,
            bindings: verified.bindingRead.facts,
            events: eventRead.facts,
            reports: reportRead.facts,
            transitions: transitionRead.facts,
            operations: operationRead.facts,
            governorDecisions: governorDecisionRead.facts,
            recoveries: verified.appliedRecoveries,
            diagnostics: diagnosticRead.facts,
          });
        },
        { timeoutMs: lockTimeoutMs },
      );
    } catch (error) {
      if (error?.code === "STORE_LOCK_TIMEOUT") {
        fail(
          "SNAPSHOT_BUSY",
          "authoritative snapshot is temporarily busy",
        );
      }
      if (
        [
          "ROOT_ONLY_TOOL",
          "ROOT_IDENTITY_MISMATCH",
          "UNSUPPORTED_NATIVE_TARGET_HISTORY",
          "LEGACY_RECOVERY_PENDING",
          "LEGACY_RECOVERY_LIMIT",
          "HISTORY_CORRUPT",
          "PROJECTION_TOO_LARGE",
          "INVALID_SNAPSHOT_OPTIONS",
        ].includes(error?.code)
      ) {
        throw error;
      }
      fail(
        "HISTORY_CORRUPT",
        "authoritative loop history could not be verified",
      );
    }
  }

  async #readIdentityPlane(
    targetRunId,
    rootSessionId,
    options = {},
  ) {
    if (options.reconcile === true) {
      const reconciled =
        await this.store.reconcilePendingWorkerObservations(
          targetRunId,
        );
      if (
        reconciled.corrupt.length > 0 ||
        reconciled.unresolved.length > 0
      ) {
        fail(
          "OBSERVATION_INCOMPLETE",
          "pending worker observations require recovery",
        );
      }
    }
    const [bindingRead, evidenceRead] = await Promise.all([
      this.store.listIdentityBindings(targetRunId),
      this.store.readWorkerObservationEvidence(targetRunId),
    ]);
    if (
      bindingRead.corrupt.length > 0 ||
      evidenceRead.corrupt.length > 0 ||
      evidenceRead.conflicts.length > 0
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "worker identity evidence is corrupt",
      );
    }
    this.#assertIdentityBindingTopology(
      bindingRead,
      rootSessionId,
    );
    const observedRead = {
      facts: evidenceRead.facts
        .filter(
          (event) =>
            event.event === "SubagentStart" &&
            event.conflictEligible === true &&
            event.sessionId === rootSessionId &&
            typeof event.agentId === "string",
        )
        .sort((left, right) => {
          const timeOrder = compareCodePoints(
            left.observedAt,
            right.observedAt,
          );
          return timeOrder !== 0
            ? timeOrder
            : compareCodePoints(left.eventId, right.eventId);
        }),
      corrupt: evidenceRead.corrupt,
    };
    const snapshot = workerObservationSnapshot(
      evidenceRead.facts,
      bindingRead.facts,
      rootSessionId,
    );
    if (
      observedRead.facts.length > 64 ||
      snapshot.spawnToolUseIds.length > 64 ||
      bindingRead.facts.length > 64
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "worker observation exceeds the bounded identity view",
      );
    }
    return {
      bindingRead,
      observedRead,
      evidenceRead,
      snapshot,
      pendingCount: evidenceRead.pendingCount,
    };
  }

  async start(contextValue, input) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    const before = await this.store.readState(targetRunId);
    this.#assertRoot(before, context);
    await this.#ensureCooperativeRoleBindings(before);
    const result = await this.#rootMutation(
      context,
      input,
      "start",
      async (state, definition, createdAt, ids) => {
        if (state.status !== "draft") {
          fail(
            "INVALID_STATE_TRANSITION",
            "only a draft run can start",
          );
        }
        return {
          transition: this.#transition({
            ...ids,
            kind: "activate-implementer",
            fromNode: state.masterNode,
            toNode: await this.#roleNode(
              state.runId,
              "implementer",
            ),
            lap: 0,
            createdAt,
          }),
        };
      },
    );
    return this.#withCurrentRoleCapability(result);
  }

  async #ensureCooperativeRoleBindings(state) {
    const current = await this.store.listIdentityBindings(
      state.runId,
    );
    if (current.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "cooperative role bindings are corrupt",
      );
    }
    for (const role of ["implementer", "reviewer"]) {
      const targetAgentId = roleAgentId(role);
      const existing = current.facts.find(
        (binding) => binding.role === role,
      );
      if (existing) {
        if (
          existing.agentId !== targetAgentId ||
          existing.rootSessionId !== state.rootSessionId ||
          existing.method !== "capability-token-v1" ||
          existing.revokedAt !== undefined
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "cooperative role binding conflicts with the fixed topology",
          );
        }
        continue;
      }
      const binding = assertContract(
        "identity binding",
        {
          schemaVersion: SCHEMA_VERSION,
          bindingId: `binding_${sha256(
            canonicalJson({
              runId: state.runId,
              agentId: targetAgentId,
            }),
          )}`,
          runId: state.runId,
          agentId: targetAgentId,
          rootSessionId: state.rootSessionId,
          method: "capability-token-v1",
          tokenDigest: sha256(
            canonicalJson({
              kind: "cooperative-role-binding",
              runId: state.runId,
              role,
            }),
          ),
          role,
          createdAt: state.createdAt,
        },
        validateIdentityBinding,
      );
      const published = await this.store.putIdentityBinding(
        state.runId,
        binding,
      );
      if (!["created", "duplicate"].includes(published.status)) {
        fail(
          "RECOVERY_REQUIRED",
          "cooperative role binding could not be published",
        );
      }
      current.facts.push(binding);
    }
  }

  async #currentRoleCapability(state) {
    if (
      !["running", "paused", "interrupted"].includes(
        state.status,
      ) ||
      !state.pendingTransitionId
    ) {
      return null;
    }
    return this.store.withControlLock(state.runId, async () => {
      const current = await this.store.readState(state.runId);
      if (
        !["running", "paused", "interrupted"].includes(
          current.status,
        ) ||
        !current.pendingTransitionId
      ) {
        return null;
      }
      const transition = await this.store.readTransition(
        current.runId,
        current.pendingTransitionId,
      );
      const role = governedTransitionRole(transition);
      if (!role) {
        fail(
          "RECOVERY_REQUIRED",
          "pending transition has no cooperative role",
        );
      }
      const key = canonicalJson({
        runId: current.runId,
        role,
        pendingTransitionId: transition.transitionId,
        actionRevision: transition.toRevision,
      });
      const cachedToken = this.actionTokens.get(key);
      const existing = await maybeRead(() =>
        this.store.readActionCapability(
          current.runId,
          transition.transitionId,
        ),
      );
      if (
        cachedToken &&
        this.#validActionCapabilityRecord(
          existing,
          current.runId,
          role,
          transition,
        ) &&
        digestsEqual(existing.tokenDigest, sha256(cachedToken))
      ) {
        return {
          role,
          pendingTransitionId: transition.transitionId,
          actionRevision: transition.toRevision,
          capabilityToken: cachedToken,
        };
      }
      const capabilityToken = randomBytes(48).toString("base64url");
      await this.store.replaceActionCapability(
        current.runId,
        transition.transitionId,
        {
          schemaVersion: SCHEMA_VERSION,
          runId: current.runId,
          role,
          pendingTransitionId: transition.transitionId,
          actionRevision: transition.toRevision,
          tokenDigest: sha256(capabilityToken),
          issuedAt: this.now(),
        },
      );
      this.actionTokens.set(key, capabilityToken);
      return {
        role,
        pendingTransitionId: transition.transitionId,
        actionRevision: transition.toRevision,
        capabilityToken,
      };
    });
  }

  async #withCurrentRoleCapability(result) {
    const state = await this.store.readState(result.runId);
    const roleCapability =
      await this.#currentRoleCapability(state);
    return roleCapability
      ? { ...result, roleCapability }
      : result;
  }

  #validActionCapabilityRecord(
    record,
    runIdValue,
    role,
    transition,
  ) {
    return (
      record?.schemaVersion === SCHEMA_VERSION &&
      record.runId === runIdValue &&
      record.role === role &&
      record.pendingTransitionId === transition.transitionId &&
      record.actionRevision === transition.toRevision &&
      typeof record.tokenDigest === "string" &&
      /^[a-f0-9]{64}$/.test(record.tokenDigest) &&
      typeof record.issuedAt === "string"
    );
  }

  #assertCapabilityTokenShape(role, token) {
    if (
      !WORKER_ROLES.has(role) ||
      typeof token !== "string" ||
      token.length < 64 ||
      token.length > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    ) {
      fail(
        "CAPABILITY_REJECTED",
        "role capability is missing, stale, or invalid",
      );
    }
  }

  async #assertRoleCapability(state, role, token) {
    this.#assertCapabilityTokenShape(role, token);
    if (
      state.status !== "running" ||
      !state.pendingTransitionId
    ) {
      fail(
        "CAPABILITY_REJECTED",
        "role capability is missing, stale, or invalid",
      );
    }
    const transition = await this.store.readTransition(
      state.runId,
      state.pendingTransitionId,
    );
    const record = await maybeRead(() =>
      this.store.readActionCapability(
        state.runId,
        state.pendingTransitionId,
      ),
    );
    if (
      governedTransitionRole(transition) !== role ||
      !this.#validActionCapabilityRecord(
        record,
        state.runId,
        role,
        transition,
      ) ||
      !digestsEqual(record.tokenDigest, sha256(token))
    ) {
      fail(
        "CAPABILITY_REJECTED",
        "role capability is missing, stale, or invalid",
      );
    }
  }

  async #assertConsumedRoleCapability(
    operation,
    role,
    token,
    operations,
  ) {
    this.#assertCapabilityTokenShape(role, token);
    const anchor = operations.find(
      (candidate) =>
        candidate.toRevision === operation.fromRevision,
    );
    if (!anchor) {
      fail(
        "CAPABILITY_REJECTED",
        "role capability is missing, stale, or invalid",
      );
    }
    const transition = await this.store.readTransition(
      operation.runId,
      anchor.transitionId,
    );
    const record = await maybeRead(() =>
      this.store.readActionCapability(
        operation.runId,
        transition.transitionId,
      ),
    );
    if (
      governedTransitionRole(transition) !== role ||
      !this.#validActionCapabilityRecord(
        record,
        operation.runId,
        role,
        transition,
      ) ||
      !digestsEqual(record.tokenDigest, sha256(token))
    ) {
      fail(
        "CAPABILITY_REJECTED",
        "role capability is missing, stale, or invalid",
      );
    }
  }

  async pause(contextValue, input) {
    return this.#rootMutation(
      contextValue,
      input,
      "pause",
      async (state, _definition, createdAt, ids) => {
        if (!["running", "interrupted"].includes(state.status)) {
          fail(
            "INVALID_STATE_TRANSITION",
            "only a running or interrupted run can pause",
          );
        }
        return {
          transition: this.#transition({
            ...ids,
            kind: "pause",
            fromNode: state.masterNode,
            toNode: state.masterNode,
            lap: state.currentLap,
            createdAt,
          }),
        };
      },
    );
  }

  async resume(contextValue, input) {
    return this.#rootMutation(
      contextValue,
      input,
      "resume",
      async (state, _definition, createdAt, ids) => {
        if (!["paused", "interrupted"].includes(state.status)) {
          fail(
            "INVALID_STATE_TRANSITION",
            "only a paused or interrupted run can resume",
          );
        }
        return {
          transition: this.#transition({
            ...ids,
            kind: "resume",
            fromNode: state.masterNode,
            toNode: state.masterNode,
            lap: state.currentLap,
            createdAt,
          }),
        };
      },
    );
  }

  async cancel(contextValue, input) {
    return this.#rootMutation(
      contextValue,
      input,
      "cancel",
      async (state, _definition, createdAt, ids) => {
        if (!ROOT_CONTROL_STATUSES.has(state.status)) {
          fail(
            "INVALID_STATE_TRANSITION",
            "terminal runs cannot be cancelled again",
          );
        }
        return {
          transition: this.#transition({
            ...ids,
            kind: "cancel",
            fromNode: state.masterNode,
            toNode: state.masterNode,
            lap: state.currentLap,
            createdAt,
          }),
        };
      },
    );
  }

  async #rootMutation(
    contextValue,
    input,
    kind,
    build,
  ) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    const mutationRequestId = requestId(input?.requestId);
    const actor = {
      kind: "root",
      id: context.rootSessionId,
    };
    const digest = mutationRequestDigest({
      kind,
      runId: targetRunId,
      requestId: mutationRequestId,
      actorKind: actor.kind,
      actorId: actor.id,
    });
    return this.#mutate({
      runId: targetRunId,
      requestId: mutationRequestId,
      requestDigest: digest,
      kind,
      actor,
      authorize: (state) => this.#assertRoot(state, context),
      build,
    });
  }

  async prepareWorkerSpawn(contextValue, input) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    const prepareRequestId = requestId(input?.requestId);
    const role = input?.role;
    if (!WORKER_ROLES.has(role)) {
      fail("INVALID_TOOL_INPUT", "role is invalid");
    }
    const desiredObservationId = observationIdFor(
      targetRunId,
      prepareRequestId,
    );
    const requestDigest = observationRequestDigest({
      runId: targetRunId,
      requestId: prepareRequestId,
      rootSessionId: context.rootSessionId,
      role,
    });
    return this.store.withControlLock(
      targetRunId,
      () =>
        this.store.withWorkerObservationSnapshotLock(
          targetRunId,
          async () => {
            let state =
              await this.store.readState(targetRunId);
            this.#assertRoot(state, context);
            state =
              await this.#rollForwardPrepared(state);
            this.#assertRoot(state, context);
            if (state.status !== "running") {
              fail(
                "INVALID_STATE_TRANSITION",
                "worker spawn can only prepare on a running loop",
              );
            }
            const [
              plane,
              observations,
              operations,
              recoveries,
              definition,
            ] =
              await Promise.all([
                this.#readIdentityPlane(
                  targetRunId,
                  context.rootSessionId,
                  { reconcile: true },
                ),
                this.store.listWorkerObservations(
                  targetRunId,
                ),
                this.store.listOperations(targetRunId),
                this.store.listRecoveries(targetRunId),
                this.store.readDefinition(targetRunId),
              ]);
            if (
              observations.corrupt.length > 0 ||
              operations.corrupt.length > 0 ||
              recoveries.corrupt.length > 0
            ) {
              fail(
                "RECOVERY_REQUIRED",
                "prepare receipts are corrupt",
              );
            }
            this.#assertRequestNamespace(
              prepareRequestId,
              "observations",
              {
                definition,
                operations: operations.facts,
                observations: observations.facts,
                bindings: plane.bindingRead.facts,
                recoveries: recoveries.facts,
              },
            );
            const sameRequest = observations.facts.filter(
              (item) => item.requestId === prepareRequestId,
            );
            if (sameRequest.length > 1) {
              fail(
                "RECOVERY_REQUIRED",
                "multiple prepare receipts reuse one request id",
              );
            }
            if (sameRequest.length === 1) {
              const existing = sameRequest[0];
              if (
                existing.observationId ===
                  desiredObservationId &&
                existing.requestDigest === requestDigest &&
                existing.role === role
              ) {
                return {
                  schemaVersion: SCHEMA_VERSION,
                  runId: targetRunId,
                  observationId: existing.observationId,
                  role,
                  observationDigest:
                    existing.observationDigest,
                  duplicate: true,
                  consumed: plane.bindingRead.facts.some(
                    (binding) =>
                      binding.observationId ===
                      existing.observationId,
                  ),
                };
              }
              fail(
                "REQUEST_ID_CONFLICT",
                "prepare request id already has different content",
              );
            }
            if (
              definition.requestId === prepareRequestId ||
              operations.facts.some(
                (operation) =>
                  operation.requestId === prepareRequestId,
              ) ||
              plane.bindingRead.facts.some(
                (binding) =>
                  binding.requestId === prepareRequestId,
              )
            ) {
              fail(
                "REQUEST_ID_CONFLICT",
                "request id already belongs to another mutation",
              );
            }
            const consumed = new Set(
              plane.bindingRead.facts
                .map((binding) => binding.observationId)
                .filter(Boolean),
            );
            if (
              observations.facts.some(
                (item) => !consumed.has(item.observationId),
              )
            ) {
              fail(
                "SPAWN_ALREADY_PREPARED",
                "another worker spawn baseline is still unconsumed",
              );
            }
            const roleBindings = new Map(
              plane.bindingRead.facts
                .filter((binding) => binding.role)
                .map((binding) => [binding.role, binding]),
            );
            if (roleBindings.has(role)) {
              fail(
                "ROLE_ALREADY_BOUND",
                "worker role is already bound",
              );
            }
            if (
              (role === "implementer" &&
                roleBindings.size !== 0) ||
              (role === "reviewer" &&
                (!roleBindings.has("implementer") ||
                  roleBindings.size !== 1))
            ) {
              fail(
                "WORKER_ROLE_ORDER",
                "workers must prepare implementer then reviewer",
              );
            }
            if (
              plane.snapshot.spawnToolUseIds.length !==
              plane.snapshot.subagentStartEventIds.length
            ) {
              fail(
                "OBSERVATION_UNBALANCED",
                "native spawn and worker-start observations are not balanced",
              );
            }
            const boundAgentIds = new Set(
              plane.bindingRead.facts.map(
                (binding) => binding.agentId,
              ),
            );
            if (
              plane.snapshot.starts.some(
                (event) => !boundAgentIds.has(event.agentId),
              )
            ) {
              fail(
                "UNEXPLAINED_WORKER",
                "an observed worker is not bound to this loop",
              );
            }
            const observation = assertContract(
              "worker observation",
              {
                schemaVersion: SCHEMA_VERSION,
                observationId: desiredObservationId,
                runId: targetRunId,
                requestId: prepareRequestId,
                requestDigest,
                rootSessionId: context.rootSessionId,
                role,
                spawnToolUseIds:
                  plane.snapshot.spawnToolUseIds,
                subagentStartEventIds:
                  plane.snapshot.subagentStartEventIds,
                bindingIds: plane.snapshot.bindingIds,
                observationDigest:
                  plane.snapshot.observationDigest,
                createdAt: this.now(),
              },
              validateWorkerObservation,
            );
            const published =
              await this.store.putWorkerObservation(
                targetRunId,
                observation,
              );
            if (
              !["created", "duplicate"].includes(
                published.status,
              )
            ) {
              fail(
                published.status === "limit"
                  ? "FACT_LIMIT_REACHED"
                  : "REQUEST_ID_CONFLICT",
                "worker spawn baseline could not be published",
              );
            }
            return {
              schemaVersion: SCHEMA_VERSION,
              runId: targetRunId,
              observationId: observation.observationId,
              role,
              observationDigest:
                observation.observationDigest,
              duplicate:
                published.status === "duplicate",
              consumed: false,
            };
          },
        ),
    );
  }

  async bindWorker(contextValue, input) {
    const context = assertRootContext(contextValue);
    const targetRunId = runId(input?.runId);
    const bindRequestId = requestId(input?.requestId);
    const targetAgentId = agentId(input?.agentId);
    const targetObservationId = runId(
      input?.observationId,
    );
    const targetOriginEventId = runId(
      input?.originEventId,
    );
    const role = input?.role;
    if (!WORKER_ROLES.has(role)) {
      fail("INVALID_TOOL_INPUT", "role is invalid");
    }
    const digest = bindingRequestDigest({
      runId: targetRunId,
      requestId: bindRequestId,
      agentId: targetAgentId,
      role,
      observationId: targetObservationId,
      originEventId: targetOriginEventId,
    });
    return this.store.withControlLock(
      targetRunId,
      () =>
        this.store.withWorkerObservationSnapshotLock(
          targetRunId,
          async () => {
        let state = await this.store.readState(targetRunId);
        this.#assertRoot(state, context);
        state = await this.#rollForwardPrepared(state);
        this.#assertRoot(state, context);
        if (state.status !== "running") {
          fail(
            "INVALID_STATE_TRANSITION",
            "workers can only bind to a running loop",
          );
        }
        const [
          plane,
          observations,
          operations,
          recoveries,
          definition,
        ] =
          await Promise.all([
            this.#readIdentityPlane(
              targetRunId,
              context.rootSessionId,
              { reconcile: true },
            ),
            this.store.listWorkerObservations(targetRunId),
            this.store.listOperations(targetRunId),
            this.store.listRecoveries(targetRunId),
            this.store.readDefinition(targetRunId),
          ]);
        const bindings = plane.bindingRead;
        if (
          observations.corrupt.length > 0 ||
          operations.corrupt.length > 0 ||
          recoveries.corrupt.length > 0
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "worker bind receipts are corrupt",
          );
        }
        if (bindings.corrupt.length > 0) {
          fail(
            "RECOVERY_REQUIRED",
            "identity bindings are corrupt",
          );
        }
        this.#assertRequestNamespace(
          bindRequestId,
          "identity",
          {
            definition,
            operations: operations.facts,
            observations: observations.facts,
            bindings: bindings.facts,
            recoveries: recoveries.facts,
          },
        );
        const sameRequests = bindings.facts.filter(
          (binding) => binding.requestId === bindRequestId,
        );
        if (sameRequests.length > 1) {
          fail(
            "RECOVERY_REQUIRED",
            "multiple worker bindings reuse one request id",
          );
        }
        if (sameRequests.length === 1) {
          const existing = sameRequests[0];
          if (
              existing.agentId === targetAgentId &&
              existing.role === role &&
              existing.requestDigest === digest &&
              existing.observationId ===
                targetObservationId &&
              existing.originEventId ===
                targetOriginEventId
          ) {
            return {
              schemaVersion: SCHEMA_VERSION,
              runId: targetRunId,
              agentId: targetAgentId,
              role,
              issued: false,
              duplicate: true,
              capabilityReissueRequired: true,
            };
          }
          fail(
            "REQUEST_ID_CONFLICT",
            "bind request id already has different content",
          );
        }
        if (
          definition.requestId === bindRequestId ||
          operations.facts.some(
            (operation) =>
              operation.requestId === bindRequestId,
          ) ||
          observations.facts.some(
            (observation) =>
              observation.requestId === bindRequestId,
          )
        ) {
          fail(
            "REQUEST_ID_CONFLICT",
            "request id already belongs to another mutation",
          );
        }
        let baseline;
        try {
          baseline =
            await this.store.readWorkerObservation(
              targetRunId,
              targetObservationId,
            );
        } catch (error) {
          if (error?.code === "ENOENT") {
            fail(
              "OBSERVATION_BASELINE_MISSING",
              "worker spawn baseline does not exist",
            );
          }
          throw error;
        }
        if (
          baseline.rootSessionId !== context.rootSessionId ||
          baseline.role !== role
        ) {
          fail(
            "OBSERVATION_BASELINE_MISMATCH",
            "worker spawn baseline belongs to another root or role",
          );
        }
        if (
          bindings.facts.some(
            (binding) =>
              binding.observationId ===
              targetObservationId,
          )
        ) {
          fail(
            "OBSERVATION_BASELINE_CONSUMED",
            "worker spawn baseline is already consumed",
          );
        }
        const consumed = new Set(
          bindings.facts
            .map((binding) => binding.observationId)
            .filter(Boolean),
        );
        const unconsumed = observations.facts.filter(
          (observation) =>
            !consumed.has(observation.observationId),
        );
        if (
          unconsumed.length !== 1 ||
          unconsumed[0].observationId !==
            targetObservationId
        ) {
          fail(
            "OBSERVATION_BASELINE_SUPERSEDED",
            "worker spawn baseline is not the current permit",
          );
        }
        const sameAgent = bindings.facts.find(
          (binding) => binding.agentId === targetAgentId,
        );
        if (sameAgent) {
          fail(
            "AGENT_ALREADY_BOUND",
            "agent is already bound with different intent",
          );
        }
        if (
          bindings.facts.some(
            (binding) => binding.role === role,
          )
        ) {
          fail(
            "ROLE_ALREADY_BOUND",
            "worker role is already bound",
          );
        }
        if (
          (bindings.facts.length === 0 &&
            role !== "implementer") ||
          (bindings.facts.length === 1 &&
            role !== "reviewer")
        ) {
          fail(
            "WORKER_ROLE_ORDER",
            "workers must bind implementer then reviewer",
          );
        }
        const baselineBase = {
          spawnToolUseIds: baseline.spawnToolUseIds,
          subagentStartEventIds:
            baseline.subagentStartEventIds,
          bindingIds: baseline.bindingIds,
        };
        if (
          digestJson(baselineBase) !==
          baseline.observationDigest
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "worker spawn baseline digest is invalid",
          );
        }
        for (const [current, prior] of [
          [
            plane.snapshot.spawnToolUseIds,
            baseline.spawnToolUseIds,
          ],
          [
            plane.snapshot.subagentStartEventIds,
            baseline.subagentStartEventIds,
          ],
          [plane.snapshot.bindingIds, baseline.bindingIds],
        ]) {
          if (
            prior.some((id) => !current.includes(id))
          ) {
            fail(
              "RECOVERY_REQUIRED",
              "worker observation moved behind its baseline",
            );
          }
        }
        if (
          canonicalJson(plane.snapshot.bindingIds) !==
          canonicalJson(baseline.bindingIds)
        ) {
          fail(
            "OBSERVATION_AMBIGUOUS",
            "identity bindings changed after worker prepare",
          );
        }
        const newSpawnToolUseIds = difference(
          plane.snapshot.spawnToolUseIds,
          baseline.spawnToolUseIds,
        );
        const newStartEventIds = difference(
          plane.snapshot.subagentStartEventIds,
          baseline.subagentStartEventIds,
        );
        if (
          newSpawnToolUseIds.length !== 1 ||
          newStartEventIds.length !== 1
        ) {
          fail(
            "OBSERVATION_AMBIGUOUS",
            "worker bind requires exactly one spawn and one worker-start delta",
            {
              spawnDelta: newSpawnToolUseIds.length,
              workerStartDelta: newStartEventIds.length,
            },
          );
        }
        if (
          newStartEventIds[0] !== targetOriginEventId
        ) {
          fail(
            "OBSERVATION_CANDIDATE_CHANGED",
            "selected worker event is no longer the unique delta",
          );
        }
        const originEvent = plane.snapshot.starts.find(
          (event) =>
            event.eventId === targetOriginEventId,
        );
        if (
          !originEvent ||
          originEvent.agentId !== targetAgentId
        ) {
          fail(
            "OBSERVATION_CANDIDATE_MISMATCH",
            "selected worker does not match the observed event",
          );
        }
        const boundAgentIds = new Set(
          bindings.facts.map((binding) => binding.agentId),
        );
        const unboundStarts =
          plane.snapshot.starts.filter(
            (event) =>
              !boundAgentIds.has(event.agentId),
          );
        if (
          unboundStarts.length !== 1 ||
          unboundStarts[0].eventId !==
            targetOriginEventId
        ) {
          fail(
            "OBSERVATION_AMBIGUOUS",
            "worker observation contains unexplained unbound workers",
          );
        }
        const issued = await issueRunCapability(this.store, {
          runId: targetRunId,
          rootSessionId: context.rootSessionId,
          agentId: targetAgentId,
          role,
          requestId: bindRequestId,
          requestDigest: digest,
          observationId: targetObservationId,
          originEventId: targetOriginEventId,
          createdAt: this.now(),
        });
        return {
          schemaVersion: SCHEMA_VERSION,
          runId: targetRunId,
          agentId: targetAgentId,
          role,
          issued: true,
          duplicate: false,
          capabilityToken: issued.token,
        };
          },
        ),
    );
  }

  async report(input) {
    const targetRunId = runId(input?.runId);
    const mutationRequestId = requestId(input?.requestId);
    const role = input?.role;
    if (!WORKER_ROLES.has(role)) {
      fail("INVALID_TOOL_INPUT", "role is invalid");
    }
    const targetAgentId = roleAgentId(role);
    const token = boundedString(
      input?.capabilityToken,
      "capabilityToken",
      2048,
    );
    if (!["info", "verdict"].includes(input?.type)) {
      fail("INVALID_REPORT", "report type is invalid");
    }
    const payload = {
      type: input?.type,
      ...(input?.status ? { status: input.status } : {}),
      ...(input?.verdict ? { verdict: input.verdict } : {}),
      ...(input?.issues ? { issues: input.issues } : {}),
      ...(input?.summary ? { summary: input.summary } : {}),
    };
    const digest = mutationRequestDigest({
      kind: "report",
      runId: targetRunId,
      requestId: mutationRequestId,
      actorKind: "worker",
      actorId: targetAgentId,
      payload,
    });
    const [stateBefore, operationRead] = await Promise.all([
      this.store.readState(targetRunId),
      this.store.listOperations(targetRunId),
    ]);
    if (operationRead.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "report operation history is corrupt",
      );
    }
    const existingOperation = operationRead.facts.find(
      (operation) =>
        operation.operationId ===
        operationIdFor(targetRunId, mutationRequestId),
    );
    if (
      existingOperation &&
      stateBefore.revision >= existingOperation.toRevision
    ) {
      if (
        existingOperation.kind !== "report" ||
        existingOperation.actorId !== targetAgentId ||
        existingOperation.requestDigest !== digest
      ) {
        fail(
          "REQUEST_ID_CONFLICT",
          "report request id already has different content",
        );
      }
      await this.#assertConsumedRoleCapability(
        existingOperation,
        role,
        token,
        operationRead.facts,
      );
      return this.#mutationResult(
        stateBefore,
        await this.store.readDefinition(targetRunId),
        existingOperation,
        true,
      );
    }
    await this.#assertRoleCapability(
      stateBefore,
      role,
      token,
    );
    return this.#mutate({
      runId: targetRunId,
      requestId: mutationRequestId,
      requestDigest: digest,
      kind: "report",
      actor: { kind: "worker", id: targetAgentId },
      authorize: (state) =>
        this.#assertRoleCapability(state, role, token),
      reportPayload: payload,
      build: (state, definition, createdAt, ids) =>
        this.#buildReportMutation(
          state,
          definition,
          createdAt,
          ids,
          targetAgentId,
          payload,
        ),
    });
  }

  async #buildReportMutation(
    state,
    definition,
    createdAt,
    ids,
    targetAgentId,
    payload,
  ) {
    if (state.status !== "running") {
      fail(
        "REPORT_NOT_ACCEPTED",
        "run is not accepting worker reports",
      );
    }
    const bindings =
      await this.store.listIdentityBindings(state.runId);
    if (bindings.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "identity bindings are corrupt",
      );
    }
    const binding = bindings.facts.find(
      (candidate) => candidate.agentId === targetAgentId,
    );
    if (!binding?.role) {
      fail(
        "AGENT_NOT_BOUND",
        "worker has no governed role binding",
      );
    }
    if (!state.pendingTransitionId) {
      fail("REPORT_OUT_OF_TURN", "run has no pending worker action");
    }
    const pending = await this.store.readTransition(
      state.runId,
      state.pendingTransitionId,
    );
    const expectedRole =
      pending.kind === "activate-implementer"
        ? "implementer"
        : pending.kind === "activate-reviewer"
          ? "reviewer"
          : null;
    if (binding.role !== expectedRole) {
      fail(
        "REPORT_OUT_OF_TURN",
        "worker role does not match the pending action",
      );
    }

    let transitionKind;
    let transitionTarget;
    let transitionLap = state.currentLap;
    if (binding.role === "implementer") {
      if (
        payload.type !== "info" ||
        payload.status !== "done" ||
        payload.verdict !== undefined ||
        payload.issues !== undefined
      ) {
        fail(
          "INVALID_REPORT",
          "implementer must submit only info/status=done",
        );
      }
      transitionKind = "activate-reviewer";
      transitionTarget = await this.#roleNode(
        state.runId,
        "reviewer",
      );
    } else {
      if (
        payload.type !== "verdict" ||
        !["issues", "clean"].includes(payload.verdict) ||
        payload.status !== undefined
      ) {
        fail(
          "INVALID_REPORT",
          "reviewer must submit a typed clean/issues verdict",
        );
      }
      if (
        payload.verdict === "issues" &&
        (!Array.isArray(payload.issues) ||
          payload.issues.length === 0)
      ) {
        fail(
          "INVALID_REPORT",
          "issues verdict requires at least one issue",
        );
      }
      if (
        payload.verdict === "clean" &&
        Array.isArray(payload.issues) &&
        payload.issues.length > 0
      ) {
        fail(
          "INVALID_REPORT",
          "clean verdict cannot contain issues",
        );
      }
      if (payload.verdict === "clean") {
        transitionKind = "succeed";
        transitionTarget = state.masterNode;
      } else if (state.currentLap + 1 > definition.lapCap) {
        transitionKind = "cap";
        transitionTarget = state.masterNode;
      } else {
        transitionKind = "activate-implementer";
        transitionTarget = await this.#roleNode(
          state.runId,
          "implementer",
        );
        transitionLap = state.currentLap + 1;
      }
    }

    const report = assertContract(
      "loop report",
      {
        schemaVersion: SCHEMA_VERSION,
        reportId: ids.reportId,
        runId: state.runId,
        requestId: ids.requestId,
        requestDigest: ids.requestDigest,
        fromRevision: ids.fromRevision,
        toRevision: ids.toRevision,
        fromNode: targetAgentId,
        receiver: "root-master",
        ...(transitionKind.startsWith("activate-")
          ? { routedToNode: transitionTarget }
          : {}),
        type: payload.type,
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.verdict ? { verdict: payload.verdict } : {}),
        ...(payload.issues ? { issues: payload.issues } : {}),
        ...(payload.summary ? { summary: payload.summary } : {}),
        createdAt,
      },
      validateLoopReport,
    );
    const transition = this.#transition({
      ...ids,
      kind: transitionKind,
      fromNode: targetAgentId,
      toNode: transitionTarget,
      originReportId: report.reportId,
      lap: transitionLap,
      createdAt,
    });
    return { report, transition };
  }

  async #roleNode(targetRunId, role) {
    const bindings =
      await this.store.listIdentityBindings(targetRunId);
    if (bindings.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "identity bindings are corrupt",
      );
    }
    const matches = bindings.facts.filter(
      (binding) => binding.role === role,
    );
    if (matches.length > 1) {
      fail(
        "IDENTITY_BINDING_CONFLICT",
        "multiple workers are bound to one role",
      );
    }
    return `role:${role}`;
  }

  #transition(input) {
    return assertContract(
      "loop transition",
      {
        schemaVersion: SCHEMA_VERSION,
        transitionId: input.transitionId,
        runId: input.runId,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        kind: input.kind,
        ...(input.fromNode ? { fromNode: input.fromNode } : {}),
        ...(input.toNode ? { toNode: input.toNode } : {}),
        ...(input.originReportId
          ? { originReportId: input.originReportId }
          : {}),
        lap: input.lap,
        fromRevision: input.fromRevision,
        toRevision: input.toRevision,
        createdAt: input.createdAt,
      },
      validateLoopTransition,
    );
  }

  async #mutate(spec) {
    return this.store.withControlLock(
      spec.runId,
      async () => {
        let state = await this.store.readState(spec.runId);
        await spec.authorize(state);
        state = await this.#rollForwardPrepared(state);
        await spec.authorize(state);
        const targetOperationId = operationIdFor(
          spec.runId,
          spec.requestId,
        );
        const [
          definition,
          operationRead,
          observationRead,
          bindingRead,
          recoveryRead,
        ] = await Promise.all([
          this.store.readDefinition(spec.runId),
          this.store.listOperations(spec.runId),
          this.store.listWorkerObservations(spec.runId),
          this.store.listIdentityBindings(spec.runId),
          this.store.listRecoveries(spec.runId),
        ]);
        if (
          operationRead.corrupt.length > 0 ||
          observationRead.corrupt.length > 0 ||
          bindingRead.corrupt.length > 0 ||
          recoveryRead.corrupt.length > 0
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "request namespace receipts are corrupt",
          );
        }
        this.#assertIdentityBindingTopology(
          bindingRead,
          state.rootSessionId,
        );
        this.#assertRequestNamespace(
          spec.requestId,
          "operations",
          {
            definition,
            operations: operationRead.facts,
            observations: observationRead.facts,
            bindings: bindingRead.facts,
            recoveries: recoveryRead.facts,
          },
        );
        const existingOperation = operationRead.facts.find(
          (operation) =>
            operation.operationId === targetOperationId,
        );
        if (existingOperation) {
          if (
            existingOperation.requestDigest !==
              spec.requestDigest ||
            existingOperation.kind !== spec.kind
          ) {
            fail(
              "REQUEST_ID_CONFLICT",
              "request id already has different content",
            );
          }
          state = await this.#applyOperation(
            state,
            existingOperation,
          );
          return this.#mutationResult(
            state,
            definition,
            existingOperation,
            true,
          );
        }

        const ids = {
          runId: spec.runId,
          requestId: spec.requestId,
          requestDigest: spec.requestDigest,
          transitionId: transitionIdFor(
            spec.runId,
            spec.requestId,
          ),
          ...(spec.kind === "report"
            ? {
                reportId: reportIdFor(
                  spec.runId,
                  spec.requestId,
                ),
              }
            : {}),
          fromRevision: state.revision,
          toRevision: state.revision + 1,
        };
        const existingTransition = await maybeRead(() =>
          this.store.readTransition(
            spec.runId,
            ids.transitionId,
          ),
        );
        const existingReport = ids.reportId
          ? await maybeRead(() =>
              this.store.readReport(
                spec.runId,
                ids.reportId,
              ),
            )
          : null;
        for (const orphan of [
          existingTransition,
          existingReport,
        ].filter(Boolean)) {
          if (
            orphan.requestDigest !== spec.requestDigest ||
            orphan.requestId !== spec.requestId
          ) {
            fail(
              "REQUEST_ID_CONFLICT",
              "request id already has different facts",
            );
          }
          if (
            orphan.fromRevision !== undefined &&
            orphan.fromRevision !== state.revision
          ) {
            fail(
              "STALE_UNCOMMITTED_REQUEST",
              "uncommitted request belongs to an older revision",
            );
          }
        }
        const createdAt =
          existingTransition?.createdAt ??
          existingReport?.createdAt ??
          this.now();
        if (
          existingTransition &&
          existingReport &&
          existingTransition.createdAt !== existingReport.createdAt
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "uncommitted request facts disagree",
          );
        }
        const built = await spec.build(
          state,
          definition,
          createdAt,
          ids,
        );
        const transitionResult =
          await this.store.putTransition(
            spec.runId,
            built.transition,
          );
        await this.#requireFactPublication(
          "transitions",
          transitionResult,
          spec.runId,
          "transition fact conflicts with this request",
        );
        await this.fault("afterTransitionFact", {
          runId: spec.runId,
          requestId: spec.requestId,
        });
        if (built.report) {
          const reportResult = await this.store.putReport(
            spec.runId,
            built.report,
          );
          await this.#requireFactPublication(
            "reports",
            reportResult,
            spec.runId,
            "report fact conflicts with this request",
          );
          await this.fault("afterReportFact", {
            runId: spec.runId,
            requestId: spec.requestId,
          });
        }
        await this.fault("afterFacts", {
          runId: spec.runId,
          requestId: spec.requestId,
        });
        const operation = assertContract(
          "loop operation",
          {
            schemaVersion: SCHEMA_VERSION,
            operationId: targetOperationId,
            runId: spec.runId,
            requestId: spec.requestId,
            requestDigest: spec.requestDigest,
            kind: spec.kind,
            actorKind: spec.actor.kind,
            actorId: spec.actor.id,
            fromRevision: state.revision,
            toRevision: state.revision + 1,
            ...(built.report
              ? { reportId: built.report.reportId }
              : {}),
            transitionId: built.transition.transitionId,
            createdAt,
          },
          validateLoopOperation,
        );
        const operationResult =
          await this.store.putOperation(
            spec.runId,
            operation,
          );
        await this.#requireFactPublication(
          "operations",
          operationResult,
          spec.runId,
          "operation receipt conflicts with this request",
        );
        await this.fault("afterReceipt", {
          runId: spec.runId,
          requestId: spec.requestId,
        });
        state = await this.#applyOperation(state, operation);
        await this.fault("afterCas", {
          runId: spec.runId,
          requestId: spec.requestId,
        });
        return this.#mutationResult(
          state,
          definition,
          operation,
          false,
        );
      },
    );
  }

  async #requireFactPublication(
    factKind,
    result,
    targetRunId,
    conflictMessage,
  ) {
    if (["created", "duplicate"].includes(result?.status)) {
      return;
    }
    if (result?.status === "conflict") {
      fail("REQUEST_ID_CONFLICT", conflictMessage);
    }
    if (result?.status === "limit") {
      let durableState = await maybeRead(() =>
        this.store.readState(targetRunId),
      );
      if (
        durableState &&
        ACTIVE_RUN_STATUSES.has(durableState.status) &&
        !(
          durableState.status === "interrupted" &&
          durableState.needsHuman === true
        )
      ) {
        durableState = await this.interruptForFactLimit(
          durableState,
          {
            factKind,
            limit: result.limit,
          },
        );
      }
      fail(
        "FACT_LIMIT_REACHED",
        `${factKind} capacity was reached; the run requires human recovery`,
        {
          factKind,
          limit: result.limit,
          status: durableState?.status ?? "unknown",
          needsHuman: durableState?.needsHuman === true,
        },
      );
    }
    fail(
      "RECOVERY_REQUIRED",
      `${factKind} publication returned an unsupported result`,
    );
  }

  async interruptForFactLimit(initialState, details = {}) {
    let state = await this.store.readState(initialState.runId);
    if (
      canonicalJson({
        runId: state.runId,
        rootSessionId: state.rootSessionId,
      }) !==
      canonicalJson({
        runId: initialState.runId,
        rootSessionId: initialState.rootSessionId,
      })
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "fact-limit interruption targets a different run identity",
      );
    }
    state = await this.#rollForwardPrepared(state);
    if (
      !ACTIVE_RUN_STATUSES.has(state.status) ||
      (state.status === "interrupted" &&
        state.needsHuman === true)
    ) {
      return state;
    }
    await this.#readAndValidateDefinition(state);
    const internalRequestId = factLimitRequestId(
      state.revision,
    );
    const requestDigest = mutationRequestDigest({
      kind: "interrupt",
      runId: state.runId,
      requestId: internalRequestId,
      actorKind: "root",
      actorId: state.rootSessionId,
    });
    const ids = {
      runId: state.runId,
      requestId: internalRequestId,
      requestDigest,
      transitionId: transitionIdFor(
        state.runId,
        internalRequestId,
      ),
      fromRevision: state.revision,
      toRevision: state.revision + 1,
    };
    const existingTransition = await maybeRead(() =>
      this.store.readTransition(
        state.runId,
        ids.transitionId,
      ),
    );
    const existingOperation = await maybeRead(() =>
      this.store.readOperation(
        state.runId,
        operationIdFor(state.runId, internalRequestId),
      ),
    );
    const createdAt =
      existingTransition?.createdAt ??
      existingOperation?.createdAt ??
      this.now();
    if (
      existingTransition &&
      existingOperation &&
      existingTransition.createdAt !==
        existingOperation.createdAt
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "fact-limit interruption facts disagree",
      );
    }
    const transition = this.#transition({
      ...ids,
      kind: "interrupt",
      fromNode: state.masterNode,
      toNode: state.masterNode,
      lap: state.currentLap,
      createdAt,
    });
    const transitionResult =
      await this.store.putTransition(
        state.runId,
        transition,
        { allowSafetyReserve: true },
      );
    if (
      !["created", "duplicate"].includes(
        transitionResult?.status,
      )
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "fact-limit interruption transition could not be published",
        {
          factKind: details.factKind ?? "unknown",
          limit: details.limit ?? null,
          status: transitionResult?.status ?? "unknown",
        },
      );
    }
    await this.fault("afterSafetyTransition", {
      runId: state.runId,
      requestId: internalRequestId,
    });
    const operation = assertContract(
      "loop operation",
      {
        schemaVersion: SCHEMA_VERSION,
        operationId: operationIdFor(
          state.runId,
          internalRequestId,
        ),
        runId: state.runId,
        requestId: internalRequestId,
        requestDigest,
        kind: "interrupt",
        actorKind: "root",
        actorId: state.rootSessionId,
        fromRevision: state.revision,
        toRevision: state.revision + 1,
        transitionId: transition.transitionId,
        createdAt,
      },
      validateLoopOperation,
    );
    const operationResult =
      await this.store.putOperation(
        state.runId,
        operation,
        { allowSafetyReserve: true },
      );
    if (
      !["created", "duplicate"].includes(
        operationResult?.status,
      )
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "fact-limit interruption receipt could not be published",
        {
          factKind: details.factKind ?? "unknown",
          limit: details.limit ?? null,
          status: operationResult?.status ?? "unknown",
        },
      );
    }
    await this.fault("afterSafetyReceipt", {
      runId: state.runId,
      requestId: internalRequestId,
    });
    state = await this.#applyOperation(state, operation);
    await this.fault("afterSafetyCas", {
      runId: state.runId,
      requestId: internalRequestId,
    });
    return state;
  }

  async #readAndValidateDefinition(state) {
    let definition;
    try {
      definition = await this.store.readDefinition(state.runId);
    } catch (error) {
      fail(
        "RECOVERY_REQUIRED",
        "run definition is missing or unreadable",
        { code: error?.code ?? "READ_ERROR" },
      );
    }
    const expectedDigest = definitionRequestDigest({
      rootSessionId: state.rootSessionId,
      requestId: definition.requestId,
      goal: definition.goal,
      implementerInstructions:
        definition.implementerInstructions,
      reviewerInstructions:
        definition.reviewerInstructions,
      lapCap: definition.lapCap,
    });
    if (
      definition.runId !== state.runId ||
      definition.definitionId !==
        definitionIdFor(state.runId) ||
      definition.requestDigest !== expectedDigest ||
      definition.recipe !== state.recipe ||
      definition.createdAt !== state.createdAt ||
      state.masterNode !== state.rootSessionId ||
      definition.lapCap !==
        state.continuationLease.granted
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "run definition conflicts with durable loop state",
      );
    }
    return definition;
  }

  async #readAndValidateOperation(operation, state) {
    let durable;
    try {
      durable = await this.store.readOperation(
        operation.runId,
        operation.operationId,
      );
    } catch (error) {
      fail(
        "RECOVERY_REQUIRED",
        "operation receipt is missing or unreadable",
        { code: error?.code ?? "READ_ERROR" },
      );
    }
    const expectsReport = operation.kind === "report";
    if (
      canonicalJson(durable) !== canonicalJson(operation) ||
      operation.runId !== state.runId ||
      operation.operationId !==
        operationIdFor(operation.runId, operation.requestId) ||
      operation.transitionId !==
        transitionIdFor(operation.runId, operation.requestId) ||
      (expectsReport &&
        operation.reportId !==
          reportIdFor(operation.runId, operation.requestId)) ||
      (!expectsReport && operation.reportId !== undefined) ||
      (expectsReport &&
        (operation.actorKind !== "worker" ||
          operation.actorId === state.rootSessionId)) ||
      (!expectsReport &&
        (operation.actorKind !== "root" ||
          operation.actorId !== state.rootSessionId))
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "operation receipt identity or actor is invalid",
      );
    }
    return this.#readOperationFacts(operation);
  }

  async #readGovernorDecisionReferences(
    state,
    decision,
    appliedOperations,
  ) {
    let event;
    let transition;
    try {
      [event, transition] = await Promise.all([
        this.store.readEvent(
          decision.runId,
          decision.originEventId,
        ),
        this.store.readTransition(
          decision.runId,
          decision.pendingTransitionId,
        ),
      ]);
    } catch (error) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt references missing or unreadable facts",
        { code: error?.code ?? "READ_ERROR" },
      );
    }
    const role = governedTransitionRole(transition);
    const eventTurnId = event.turnId;
    const decisionTurnId = decision.turnId;
    const anchor = appliedOperations.find(
      (operation) =>
        operation.transitionId === transition.transitionId &&
        operation.toRevision <= decision.fromRevision,
    );
    if (
      decision.runId !== state.runId ||
      decision.rootSessionId !== state.rootSessionId ||
      decision.obligationId !==
        decision.pendingTransitionId ||
      event.eventId !== decision.originEventId ||
      event.conflictEligible !== true ||
      event.event !== decision.hookEvent ||
      event.sessionId !== decision.rootSessionId ||
      eventTurnId !== decisionTurnId ||
      transition.runId !== state.runId ||
      transition.transitionId !==
        decision.pendingTransitionId ||
      transition.toRevision === undefined ||
      transition.toRevision > decision.fromRevision ||
      role === null ||
      !anchor
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt conflicts with its durable event or obligation",
      );
    }
    if (
      decision.hookEvent === "SessionStart" &&
      event.payloadSummary?.source !== "resume"
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "resume interruption receipt lacks a durable resume event",
      );
    }
    if (decision.hookEvent === "SubagentStop") {
      const bindingRead =
        await this.store.listIdentityBindings(state.runId);
      if (bindingRead.corrupt.length > 0) {
        fail(
          "RECOVERY_REQUIRED",
          "worker identity bindings are corrupt",
        );
      }
      const matches = bindingRead.facts.filter(
        (binding) =>
          binding.agentId === decision.agentId &&
          event.agentId === decision.agentId &&
          binding.role === role &&
          binding.rootSessionId === state.rootSessionId &&
          binding.method === "capability-token-v1" &&
          binding.revokedAt === undefined,
      );
      if (matches.length !== 1) {
        fail(
          "RECOVERY_REQUIRED",
          "SubagentStop receipt lacks one authoritative worker binding",
        );
      }
    } else if (
      event.agentId !== undefined ||
      decision.agentId !== undefined
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "root governor receipt contains worker identity",
      );
    }
    return { event, transition, role };
  }

  async #readValidatedBindings(state) {
    const bindingRead =
      await this.store.listIdentityBindings(state.runId);
    if (bindingRead.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "worker identity bindings are corrupt",
      );
    }
    this.#assertIdentityBindingTopology(
      bindingRead,
      state.rootSessionId,
    );
    return bindingRead;
  }

  #roleTargetMatches(
    role,
    nodeId,
    compatibilityKey,
    compatibilityKeys,
  ) {
    return (
      nodeId === `role:${role}` ||
      compatibilityKeys?.has(compatibilityKey) === true
    );
  }

  #detectUnsupportedNativeTargets(
    state,
    bindingRead,
    operationRead,
    reportRead,
    transitionRead,
  ) {
    const entries = collectLegacyNativeTargetEntries({
      state,
      operations: operationRead.facts,
      reports: reportRead.facts,
      transitions: transitionRead.facts,
      bindings: bindingRead.facts,
    });
    if (entries.length > 0) {
      fail(
        "UNSUPPORTED_NATIVE_TARGET_HISTORY",
        "loop history uses an unsupported native worker target shape",
      );
    }
  }

  #bindingForAgent(bindingRead, state, targetAgentId) {
    const matches = bindingRead.facts.filter(
      (binding) =>
        binding.agentId === targetAgentId &&
        binding.rootSessionId === state.rootSessionId &&
        binding.method === "capability-token-v1" &&
        binding.revokedAt === undefined,
    );
    if (matches.length !== 1) {
      fail(
        "RECOVERY_REQUIRED",
        "operation actor lacks one authoritative worker binding",
      );
    }
    return matches[0];
  }

  #initialReplayState(state, definition) {
    return {
      schemaVersion: state.schemaVersion,
      runId: state.runId,
      rootSessionId: state.rootSessionId,
      originatingTurnId: state.originatingTurnId,
      scope: state.scope,
      masterNode: state.masterNode,
      recipe: state.recipe,
      status: "draft",
      currentLap: 0,
      continuationLease: {
        granted: definition.lapCap,
        consumed: 0,
      },
      cancelRequested: false,
      revision: 0,
      createdAt: definition.createdAt,
      updatedAt: definition.createdAt,
    };
  }

  async #nextStateForOperation(
    state,
    operation,
    facts,
    definition,
    bindingRead,
    options = {},
  ) {
    const { transition, report } = facts;
    if (
      state.runId !== operation.runId ||
      state.revision !== operation.fromRevision ||
      operation.toRevision !== state.revision + 1
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "operation revision does not match replay state",
      );
    }
    const expectedDigest = mutationRequestDigest({
      kind: operation.kind,
      runId: operation.runId,
      requestId: operation.requestId,
      actorKind: operation.actorKind,
      actorId: operation.actorId,
      payload: report ? reportPayload(report) : {},
    });
    if (operation.requestDigest !== expectedDigest) {
      fail(
        "RECOVERY_REQUIRED",
        "operation request digest is not reproducible",
      );
    }
    const transitionMatches = (expected) =>
      transition.kind === expected.kind &&
      transition.fromNode === expected.fromNode &&
      transition.lap === expected.lap &&
      (expected.toRole
        ? this.#roleTargetMatches(
            expected.toRole,
            transition.toNode,
            `transition:${transition.transitionId}:toNode`,
            options.compatibilityKeys,
          )
        : transition.toNode === expected.toNode);
    const reportRouteMatches = (expectedRole = null) =>
      report?.fromNode === operation.actorId &&
      report?.receiver === "root-master" &&
      (expectedRole
        ? report.routedToNode === transition.toNode &&
          this.#roleTargetMatches(
            expectedRole,
            report.routedToNode,
            `report:${report.reportId}:routedToNode`,
            options.compatibilityKeys,
          )
        : report?.routedToNode === undefined);
    let next = {
      ...state,
      revision: operation.toRevision,
      updatedAt: operation.createdAt,
      latestOperationId: operation.operationId,
    };

    if (operation.kind === "start") {
      if (
        state.status !== "draft" ||
        state.currentLap !== 0 ||
        report !== null ||
        !transitionMatches({
          kind: "activate-implementer",
          fromNode: state.masterNode,
          toRole: "implementer",
          lap: 0,
        })
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "start receipt has invalid transition semantics",
        );
      }
      return {
        ...next,
        status: "running",
        pendingTransitionId: transition.transitionId,
      };
    }

    if (operation.kind === "report") {
      if (
        state.status !== "running" ||
        !state.pendingTransitionId ||
        report === null
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "report receipt does not match an active obligation",
        );
      }
      let pending;
      try {
        pending = await this.store.readTransition(
          state.runId,
          state.pendingTransitionId,
        );
      } catch (error) {
        fail(
          "RECOVERY_REQUIRED",
          "report receipt references an unreadable prior obligation",
          { code: error?.code ?? "READ_ERROR" },
        );
      }
      const binding = this.#bindingForAgent(
        bindingRead,
        state,
        operation.actorId,
      );
      const pendingRole = governedTransitionRole(pending);
      if (
        pendingRole === null ||
        binding.role !== pendingRole
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "report actor does not own the replayed obligation",
        );
      }
      if (binding.role === "implementer") {
        if (
          report.type !== "info" ||
          report.status !== "done" ||
          report.verdict !== undefined ||
          report.issues !== undefined ||
          !transitionMatches({
            kind: "activate-reviewer",
            fromNode: operation.actorId,
            toRole: "reviewer",
            lap: state.currentLap,
          }) ||
          !reportRouteMatches("reviewer")
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "implementer report has invalid transition semantics",
          );
        }
        return {
          ...next,
          currentLap: transition.lap,
          pendingTransitionId: transition.transitionId,
          latestReportId: report.reportId,
        };
      }

      if (
        report.type !== "verdict" ||
        !["clean", "issues"].includes(report.verdict) ||
        report.status !== undefined
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "reviewer report has invalid typed semantics",
        );
      }
      if (report.verdict === "clean") {
        if (
          !transitionMatches({
            kind: "succeed",
            fromNode: operation.actorId,
            toNode: state.masterNode,
            lap: state.currentLap,
          }) ||
          !reportRouteMatches()
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "clean verdict has invalid transition semantics",
          );
        }
        return {
          ...withoutPending(next),
          status: "succeeded",
          latestReportId: report.reportId,
        };
      }
      if (
        !Array.isArray(report.issues) ||
        report.issues.length === 0
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "issues verdict lacks typed issues",
        );
      }
      if (state.currentLap + 1 > definition.lapCap) {
        if (
          !transitionMatches({
            kind: "cap",
            fromNode: operation.actorId,
            toNode: state.masterNode,
            lap: state.currentLap,
          }) ||
          !reportRouteMatches()
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "lap-cap verdict has invalid transition semantics",
          );
        }
        return {
          ...withoutPending(next),
          status: "capped",
          latestReportId: report.reportId,
        };
      }
      if (
        !transitionMatches({
          kind: "activate-implementer",
          fromNode: operation.actorId,
          toRole: "implementer",
          lap: state.currentLap + 1,
        }) ||
        !reportRouteMatches("implementer")
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "issues verdict has invalid transition semantics",
        );
      }
      return {
        ...next,
        currentLap: transition.lap,
        pendingTransitionId: transition.transitionId,
        latestReportId: report.reportId,
      };
    }

    if (report !== null) {
      fail(
        "RECOVERY_REQUIRED",
        "non-report operation unexpectedly references a report",
      );
    }
    const rootTransitionMatches = (kind) =>
      transitionMatches({
        kind,
        fromNode: state.masterNode,
        toNode: state.masterNode,
        lap: state.currentLap,
      });
    switch (operation.kind) {
      case "pause":
        if (
          !["running", "interrupted"].includes(state.status) ||
          !rootTransitionMatches("pause")
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "pause receipt has invalid transition semantics",
          );
        }
        return { ...next, status: "paused" };
      case "resume":
        if (
          !["paused", "interrupted"].includes(state.status) ||
          !rootTransitionMatches("resume")
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "resume receipt has invalid transition semantics",
          );
        }
        return {
          ...next,
          status: "running",
          needsHuman: false,
        };
      case "cancel":
        if (
          !ROOT_CONTROL_STATUSES.has(state.status) ||
          !rootTransitionMatches("cancel")
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "cancel receipt has invalid transition semantics",
          );
        }
        return {
          ...withoutPending(next),
          status: "cancelled",
          cancelRequested: true,
        };
      case "interrupt":
        if (
          operation.requestId !==
            factLimitRequestId(operation.fromRevision) ||
          !ACTIVE_RUN_STATUSES.has(state.status) ||
          (state.status === "interrupted" &&
            state.needsHuman === true) ||
          !rootTransitionMatches("interrupt")
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "fact-limit interruption receipt has invalid semantics",
          );
        }
        return {
          ...next,
          status: "interrupted",
          needsHuman: true,
        };
      default:
        fail(
          "RECOVERY_REQUIRED",
          "operation kind is unsupported during replay",
        );
    }
  }

  #nextStateForGovernorDecision(state, decision) {
    if (
      state.runId !== decision.runId ||
      state.rootSessionId !== decision.rootSessionId ||
      state.revision !== decision.fromRevision ||
      decision.toRevision !== state.revision + 1 ||
      state.pendingTransitionId !==
        decision.pendingTransitionId ||
      decision.obligationId !==
        decision.pendingTransitionId
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt does not match replay state",
      );
    }
    let next = {
      ...state,
      revision: decision.toRevision,
      updatedAt: decision.createdAt,
      latestGovernorDecisionId: decision.decisionId,
    };
    switch (decision.action) {
      case "block":
        if (
          state.status !== "running" ||
          decision.leaseEpoch !==
            state.continuationLease.consumed + 1 ||
          decision.leaseEpoch >
            state.continuationLease.granted
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "continuation receipt has an invalid lease epoch",
          );
        }
        return {
          ...next,
          continuationLease: {
            ...state.continuationLease,
            consumed: decision.leaseEpoch,
          },
        };
      case "cap":
        if (
          state.status !== "running" ||
          state.continuationLease.consumed <
            state.continuationLease.granted
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "cap receipt does not match an exhausted lease",
          );
        }
        return {
          ...withoutPending(next),
          status: "capped",
          needsHuman: true,
        };
      case "interrupt":
        if (state.status !== "running") {
          fail(
            "RECOVERY_REQUIRED",
            "interrupt receipt does not match a running state",
          );
        }
        return {
          ...next,
          status: "interrupted",
          needsHuman: true,
        };
      default:
        fail(
          "RECOVERY_REQUIRED",
          "governor receipt action is unsupported",
        );
    }
  }

  #nextStateForRecovery(state, receipt, context) {
    if (
      state.runId !== receipt.runId ||
      state.rootSessionId !== receipt.actorId ||
      state.revision !== receipt.fromRevision ||
      receipt.toRevision !== state.revision + 1 ||
      receipt.recoveryId !==
        recoveryIdFor(receipt.runId, receipt.requestId) ||
      receipt.requestDigest !==
        recoveryRequestDigest({
          runId: receipt.runId,
          requestId: receipt.requestId,
          actorId: receipt.actorId,
          expectedRevision: receipt.fromRevision,
          expectedEvidenceDigest:
            receipt.evidenceDigest,
        }) ||
      !ROOT_CONTROL_STATUSES.has(state.status) ||
      digestJson(state) !== receipt.priorStateDigest
    ) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery receipt does not match its prior state",
      );
    }
    const evidence = buildLegacyNativeTargetEvidence({
      state,
      definition: context.definition,
      operations: context.operations,
      governorDecisions: context.governorDecisions,
      transitions: context.transitions,
      reports: context.reports,
      bindings: context.bindings,
      entries: context.entries,
    });
    if (
      !evidence ||
      evidence.evidenceDigest !== receipt.evidenceDigest ||
      evidence.entries.length !== receipt.legacyFactCount
    ) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery evidence no longer matches its immutable receipt",
      );
    }
    const next = terminalStateForRecovery(state, receipt);
    if (
      digestJson(next) !== receipt.terminalStateDigest
    ) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery terminal state digest is invalid",
      );
    }
    return next;
  }

  async #validateDurableControlHistory(
    state,
    operationRead,
    governorDecisionRead,
    recoveryRead = { facts: [], corrupt: [] },
    options = {},
  ) {
    const definition =
      await this.#readAndValidateDefinition(state);
    const bindingRead =
      await this.#readValidatedBindings(state);
    const observationRead =
      options.observationRead ??
      (await this.store.listWorkerObservations(
        state.runId,
      ));
    if (observationRead.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "worker observation receipts are corrupt",
      );
    }
    if (recoveryRead.corrupt.length > 0) {
      fail(
        "HISTORY_CORRUPT",
        "legacy recovery receipts are corrupt",
      );
    }
    if (recoveryRead.facts.length > 1) {
      fail(
        "RECOVERY_REQUIRED",
        "multiple legacy recovery receipts exist for one run",
      );
    }
    this.#assertDurableRequestNamespaces({
      definition,
      operations: operationRead.facts,
      observations: observationRead.facts,
      bindings: bindingRead.facts,
      recoveries: recoveryRead.facts,
    });
    this.#assertPreparedRecoveryBarrier(
      state,
      recoveryRead,
      {
        normalPreparedCount: [
          ...operationRead.facts,
          ...governorDecisionRead.facts,
        ].filter(
          (receipt) =>
            receipt.fromRevision === state.revision,
        ).length,
      },
    );
    for (const receipt of recoveryRead.facts) {
      let durable;
      try {
        durable = await this.store.readRecovery(
          state.runId,
          receipt.recoveryId,
        );
      } catch (error) {
        fail(
          "HISTORY_CORRUPT",
          "legacy recovery receipt is missing or unreadable",
          { code: error?.code ?? "READ_ERROR" },
        );
      }
      if (
        canonicalJson(durable) !== canonicalJson(receipt) ||
        receipt.runId !== state.runId ||
        receipt.actorKind !== "root" ||
        receipt.fromRevision > state.revision
      ) {
        fail(
          "HISTORY_CORRUPT",
          "legacy recovery receipt identity is unstable",
        );
      }
    }
    const operationFacts = new Map();
    for (const operation of operationRead.facts) {
      if (operation.fromRevision > state.revision) {
        fail(
          "RECOVERY_REQUIRED",
          "operation receipt is ahead of durable state",
        );
      }
      operationFacts.set(
        operation.operationId,
        await this.#readAndValidateOperation(operation, state),
      );
    }
    const appliedOperationReceipts =
      operationRead.facts.filter(
        (operation) =>
          operation.toRevision <= state.revision,
      );
    for (const decision of governorDecisionRead.facts) {
      if (decision.fromRevision > state.revision) {
        fail(
          "RECOVERY_REQUIRED",
          "governor receipt is ahead of durable state",
        );
      }
      let durable;
      try {
        durable = await this.store.readGovernorDecision(
          state.runId,
          decision.decisionId,
        );
      } catch (error) {
        fail(
          "RECOVERY_REQUIRED",
          "governor receipt is missing or unreadable",
          { code: error?.code ?? "READ_ERROR" },
        );
      }
      if (canonicalJson(durable) !== canonicalJson(decision)) {
        fail(
          "RECOVERY_REQUIRED",
          "governor receipt identity is unstable",
        );
      }
      await this.#readGovernorDecisionReferences(
        state,
        decision,
        appliedOperationReceipts,
      );
    }

    const receipts = [
      ...operationRead.facts.map((receipt) => ({
        kind: "operation",
        id: receipt.operationId,
        receipt,
      })),
      ...governorDecisionRead.facts.map((receipt) => ({
        kind: "governor-decision",
        id: receipt.decisionId,
        receipt,
      })),
      ...recoveryRead.facts.map((receipt) => ({
        kind: "recovery",
        id: receipt.recoveryId,
        receipt,
      })),
    ];
    const applied = receipts.filter(
      ({ receipt }) => receipt.toRevision <= state.revision,
    );
    const appliedByRevision = new Map();
    for (const item of applied) {
      const revision = item.receipt.fromRevision;
      const values = appliedByRevision.get(revision) ?? [];
      values.push(item);
      appliedByRevision.set(revision, values);
    }
    for (
      let revision = 0;
      revision < state.revision;
      revision += 1
    ) {
      const matches = (
        appliedByRevision.get(revision) ?? []
      ).filter(
        ({ receipt }) =>
          receipt.toRevision === revision + 1,
      );
      if (matches.length !== 1) {
        fail(
          "RECOVERY_REQUIRED",
          "durable control receipt history has a gap or collision",
          { revision, receipts: matches.length },
        );
      }
    }

    let replay = this.#initialReplayState(
      state,
      definition,
    );
    const transitionFacts =
      options.transitionRead?.facts ??
      [...operationFacts.values()].map(
        ({ transition }) => transition,
      );
    const reportFacts =
      options.reportRead?.facts ??
      [...operationFacts.values()]
        .map(({ report }) => report)
        .filter(Boolean);
    const appliedRecovery = recoveryRead.facts.find(
      (receipt) => receipt.toRevision <= state.revision,
    );
    const compatibilityEntries =
      options.legacyEvidence?.entries ??
      (appliedRecovery
        ? collectLegacyNativeTargetEntries({
            state,
            operations: operationRead.facts,
            transitions: transitionFacts,
            reports: reportFacts,
            bindings: bindingRead.facts,
          })
        : []);
    const compatibilityKeys =
      options.legacyEvidence || appliedRecovery
        ? new Set(
            compatibilityEntries.map(legacyEntryKey),
          )
        : undefined;
    for (
      let revision = 0;
      revision < state.revision;
      revision += 1
    ) {
      const [item] = (
        appliedByRevision.get(revision) ?? []
      ).filter(
        ({ receipt }) =>
          receipt.toRevision === revision + 1,
      );
      if (item.kind === "operation") {
        replay = await this.#nextStateForOperation(
              replay,
              item.receipt,
              operationFacts.get(item.receipt.operationId),
              definition,
              bindingRead,
              { compatibilityKeys },
            );
      } else if (item.kind === "governor-decision") {
        replay = this.#nextStateForGovernorDecision(
              replay,
              item.receipt,
            );
      } else {
        replay = this.#nextStateForRecovery(
          replay,
          item.receipt,
          {
            definition,
            operations: operationRead.facts,
            governorDecisions:
              governorDecisionRead.facts,
            transitions: transitionFacts,
            reports: reportFacts,
            bindings: bindingRead.facts,
            entries: compatibilityEntries,
          },
        );
      }
    }
    if (canonicalJson(replay) !== canonicalJson(state)) {
      fail(
        "RECOVERY_REQUIRED",
        "durable state does not equal deterministic receipt replay",
      );
    }
    const prepared = receipts.filter(
      ({ receipt }) =>
        receipt.fromRevision === state.revision,
    );
    if (prepared.length > 1) {
      fail(
        "RECOVERY_REQUIRED",
        "durable control history has competing prepared receipts",
      );
    }
    for (const item of prepared) {
      if (item.receipt.toRevision !== state.revision + 1) {
        fail(
          "RECOVERY_REQUIRED",
          "prepared receipt has an invalid target revision",
        );
      }
      if (item.kind === "operation") {
        await this.#nextStateForOperation(
          replay,
          item.receipt,
          operationFacts.get(item.receipt.operationId),
          definition,
          bindingRead,
          { compatibilityKeys },
        );
      } else if (item.kind === "governor-decision") {
        this.#nextStateForGovernorDecision(
          replay,
          item.receipt,
        );
      } else {
        fail(
          "LEGACY_RECOVERY_PENDING",
          "a legacy recovery receipt awaits explicit confirmation",
        );
      }
    }

    const appliedOperations = appliedOperationReceipts
      .sort(
        (left, right) =>
          left.toRevision - right.toRevision ||
          compareCodePoints(
            left.operationId,
            right.operationId,
          ),
      );
    const appliedDecisions = governorDecisionRead.facts
      .filter(
        (decision) =>
          decision.toRevision <= state.revision,
      )
      .sort(
        (left, right) =>
          left.toRevision - right.toRevision ||
          compareCodePoints(
            left.decisionId,
            right.decisionId,
          ),
      );
    const expectedOperationId =
      appliedOperations.at(-1)?.operationId;
    const expectedDecisionId =
      appliedDecisions.at(-1)?.decisionId;
    const appliedRecoveries = recoveryRead.facts
      .filter(
        (receipt) =>
          receipt.toRevision <= state.revision,
      )
      .sort(
        (left, right) =>
          left.toRevision - right.toRevision ||
          compareCodePoints(
            left.recoveryId,
            right.recoveryId,
          ),
      );
    const expectedRecoveryId =
      appliedRecoveries.at(-1)?.recoveryId;
    if (
      state.latestOperationId !== expectedOperationId ||
      state.latestGovernorDecisionId !== expectedDecisionId ||
      state.latestRecoveryId !== expectedRecoveryId
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "durable state points to missing or stale control receipts",
      );
    }
    const expectedReportId = [...appliedOperations]
      .reverse()
      .find((operation) => operation.reportId)?.reportId;
    if (state.latestReportId !== expectedReportId) {
      fail(
        "RECOVERY_REQUIRED",
        "durable state points to a missing or stale report",
      );
    }

    const blocks = appliedDecisions
      .filter((decision) => decision.action === "block")
      .sort(
        (left, right) =>
          left.leaseEpoch - right.leaseEpoch ||
          compareCodePoints(
            left.decisionId,
            right.decisionId,
          ),
      );
    if (
      blocks.length !== state.continuationLease.consumed ||
      blocks.some(
        (decision, index) =>
          decision.leaseEpoch !== index + 1,
      )
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "continuation lease does not match applied decision receipts",
      );
    }

    if (state.pendingTransitionId) {
      const anchors = appliedOperations.filter(
        (operation) =>
          operation.transitionId ===
          state.pendingTransitionId,
      );
      const transition =
        anchors.length === 1
          ? operationFacts.get(anchors[0].operationId)
              ?.transition
          : null;
      if (
        !transition ||
        governedTransitionRole(transition) === null ||
        transition.lap !== state.currentLap
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "pending transition is not anchored in applied operation history",
        );
      }
    }
    return {
      definition,
      bindingRead,
      operationFacts,
      appliedOperations,
      appliedDecisions,
      appliedRecoveries,
    };
  }

  async rollForwardPrepared(initialState) {
    return this.#rollForwardPrepared(initialState);
  }

  async applyGovernorDecision(state, decision) {
    return this.#applyGovernorDecision(state, decision);
  }

  async #rollForwardPrepared(initialState) {
    let state = initialState;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const [
        operationRead,
        governorDecisionRead,
        recoveryRead,
        reportRead,
        transitionRead,
      ] =
        await Promise.all([
          this.store.listOperations(state.runId),
          this.store.listGovernorDecisions(state.runId),
          this.store.listRecoveries(state.runId),
          this.store.listReports(state.runId),
          this.store.listTransitions(state.runId),
        ]);
      if (
        operationRead.corrupt.length > 0 ||
        governorDecisionRead.corrupt.length > 0 ||
        reportRead.corrupt.length > 0 ||
        transitionRead.corrupt.length > 0
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "prepared receipts are corrupt",
        );
      }
      if (recoveryRead.corrupt.length > 0) {
        fail(
          "HISTORY_CORRUPT",
          "legacy recovery receipt is corrupt",
        );
      }
      await this.#validateDurableControlHistory(
        state,
        operationRead,
        governorDecisionRead,
        recoveryRead,
        { reportRead, transitionRead },
      );
      const prepared = [
        ...operationRead.facts.map((receipt) => ({
          kind: "operation",
          id: receipt.operationId,
          receipt,
        })),
        ...governorDecisionRead.facts.map((receipt) => ({
          kind: "governor-decision",
          id: receipt.decisionId,
          receipt,
        })),
      ]
        .filter(
          ({ receipt }) =>
            receipt.fromRevision === state.revision,
        )
        .sort((left, right) =>
          compareCodePoints(left.id, right.id),
        );
      if (prepared.length === 0) {
        return state;
      }
      if (prepared.length > 1) {
        fail(
          "RECOVERY_REQUIRED",
          "multiple prepared receipts target the same revision",
        );
      }
      const [next] = prepared;
      state =
        next.kind === "operation"
          ? await this.#applyOperation(
              state,
              next.receipt,
            )
          : await this.#applyGovernorDecision(
              state,
              next.receipt,
            );
    }
    fail(
      "RECOVERY_REQUIRED",
      "prepared receipt chain exceeds the recovery bound",
    );
  }

  async #applyOperation(state, operation) {
    if (state.runId !== operation.runId) {
      fail(
        "RECOVERY_REQUIRED",
        "operation receipt belongs to a different run",
      );
    }
    const facts = await this.#readAndValidateOperation(
      operation,
      state,
    );
    if (state.revision >= operation.toRevision) {
      return state;
    }
    const [
      definition,
      bindingRead,
    ] = await Promise.all([
      this.#readAndValidateDefinition(state),
      this.#readValidatedBindings(state),
    ]);
    const next = await this.#nextStateForOperation(
      state,
      operation,
      facts,
      definition,
      bindingRead,
    );
    return this.store.compareAndSwapState(
      state.runId,
      state.revision,
      next,
    );
  }

  async #applyGovernorDecision(state, decisionValue) {
    const decision = assertContract(
      "governor decision",
      decisionValue,
      validateGovernorDecision,
    );
    let durable;
    try {
      durable = await this.store.readGovernorDecision(
        decision.runId,
        decision.decisionId,
      );
    } catch (error) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt is missing or unreadable",
        { code: error?.code ?? "READ_ERROR" },
      );
    }
    if (canonicalJson(durable) !== canonicalJson(decision)) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt conflicts with the prepared decision",
      );
    }
    await this.#readAndValidateDefinition(state);
    const operationRead =
      await this.store.listOperations(state.runId);
    if (operationRead.corrupt.length > 0) {
      fail(
        "RECOVERY_REQUIRED",
        "operation receipts are corrupt",
      );
    }
    await this.#readGovernorDecisionReferences(
      state,
      decision,
      operationRead.facts.filter(
        (operation) =>
          operation.toRevision <= state.revision,
      ),
    );
    if (
      state.runId !== decision.runId ||
      state.rootSessionId !== decision.rootSessionId ||
      decision.obligationId !==
        decision.pendingTransitionId
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt belongs to a different run or root",
      );
    }
    if (state.revision >= decision.toRevision) {
      return state;
    }
    if (
      state.revision !== decision.fromRevision ||
      state.pendingTransitionId !==
        decision.pendingTransitionId
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "governor receipt does not match durable state",
      );
    }
    const next = this.#nextStateForGovernorDecision(
      state,
      decision,
    );
    return this.store.compareAndSwapState(
      state.runId,
      state.revision,
      next,
    );
  }

  async #readOperationFacts(operation) {
    let transition;
    let report = null;
    try {
      transition = await this.store.readTransition(
        operation.runId,
        operation.transitionId,
      );
      if (operation.reportId) {
        report = await this.store.readReport(
          operation.runId,
          operation.reportId,
        );
      }
    } catch (error) {
      fail(
        "RECOVERY_REQUIRED",
        "operation receipt references missing or unreadable facts",
        { code: error?.code ?? "READ_ERROR" },
      );
    }
    const expectsReport = operation.kind === "report";
    if (
      Boolean(operation.reportId) !== expectsReport ||
      Boolean(report) !== expectsReport ||
      transition.transitionId !== operation.transitionId ||
      transition.runId !== operation.runId ||
      transition.requestId !== operation.requestId ||
      transition.requestDigest !== operation.requestDigest ||
      transition.fromRevision !== operation.fromRevision ||
      transition.toRevision !== operation.toRevision ||
      transition.createdAt !== operation.createdAt ||
      (expectsReport &&
        (report.reportId !== operation.reportId ||
          report.runId !== operation.runId ||
          report.requestId !== operation.requestId ||
          report.requestDigest !== operation.requestDigest ||
          report.fromRevision !== operation.fromRevision ||
          report.toRevision !== operation.toRevision ||
          report.createdAt !== operation.createdAt ||
          transition.originReportId !== operation.reportId)) ||
      (!expectsReport && transition.originReportId !== undefined)
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "operation receipt references missing or conflicting facts",
      );
    }
    return { transition, report };
  }

  async #mutationResult(
    state,
    definition,
    operation,
    duplicate,
  ) {
    const { transition, report } =
      await this.#readOperationFacts(operation);
    return {
      ...stateSummary(state, definition, duplicate),
      operationId: operation.operationId,
      transition,
      ...(report ? { report } : {}),
    };
  }
}
