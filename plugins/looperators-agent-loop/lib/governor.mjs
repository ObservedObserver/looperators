import {
  canonicalJson,
  sha256,
} from "./canonical-json.mjs";
import {
  SCHEMA_VERSION,
  assertContract,
  assertSafeFileId,
  validateGovernorDecision,
  validateNormalizedHookEvent,
} from "./contracts.mjs";
import { LoopController } from "./control.mjs";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "capped",
  "cancelled",
  "failed",
]);

const NON_BLOCKING_STATUSES = new Set([
  "draft",
  "paused",
  "interrupted",
]);

export class GovernorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "GovernorError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new GovernorError(code, message, details);
}

function expectedRole(transition) {
  if (transition.kind === "activate-implementer") {
    return "implementer";
  }
  if (transition.kind === "activate-reviewer") {
    return "reviewer";
  }
  return null;
}

function decisionIdentity(input) {
  if (input.action === "block") {
    return {
      runId: input.runId,
      obligationId: input.obligationId,
      kind: "continuation-block",
    };
  }
  if (input.action === "cap") {
    return {
      runId: input.runId,
      obligationId: input.obligationId,
      kind: "continuation-cap",
    };
  }
  return {
    runId: input.runId,
    sessionStartEventId: input.originEventId,
    stateRevision: input.fromRevision,
    kind: "resume-interrupt",
  };
}

export function governorDecisionId(input) {
  return `decision_${sha256(
    canonicalJson(decisionIdentity(input)),
  )}`;
}

function allow(reasonCode, options = {}) {
  return {
    decision: "allow",
    reasonCode,
    ...(options.systemMessage
      ? { systemMessage: options.systemMessage }
      : {}),
    ...(options.state ? { state: options.state } : {}),
  };
}

function continuationCommittedMessage(runId, obligationId) {
  return (
    `looperators already committed the bounded continuation for run ${runId} ` +
    `obligation ${obligationId}; it will not be sent again. ` +
    "Read authoritative loop state, then explicitly complete, resume, or cancel."
  ).slice(0, 960);
}

function blockReason(runId, transition, role = undefined) {
  if (role) {
    return (
      `looperators run ${runId} still requires the bound ${role} typed report ` +
      `for ${transition.transitionId}. Use the capability already provided to ` +
      "call looperators_report; do not infer completion from prose."
    ).slice(0, 960);
  }
  return (
    `looperators run ${runId} still has pending ${transition.kind} ` +
    `${transition.transitionId}. Read looperators_get_loop, perform only that ` +
    "native worker action, and stop when authoritative state is terminal, " +
    "paused, or cancelled."
  ).slice(0, 960);
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

export class ContinuationGovernor {
  constructor(store, options = {}) {
    this.store = store;
    this.now =
      options.now ?? (() => new Date().toISOString());
    this.fault = options.fault ?? (async () => {});
    this.controller =
      options.controller ??
      new LoopController(store, {
        now: this.now,
      });
  }

  async evaluate(runIdValue, eventValue) {
    if (!runIdValue) {
      return allow("no-active-run");
    }
    const runId = assertSafeFileId(runIdValue, "runId");
    const event = assertContract(
      "normalized hook event",
      eventValue,
      validateNormalizedHookEvent,
    );
    if (
      !["Stop", "SubagentStop"].includes(event.event) ||
      event.conflictEligible !== true
    ) {
      return allow("unsupported-or-incomplete-event");
    }
    return this.store.withControlLock(runId, async () => {
      let state = await this.store.readState(runId);
      if (state.rootSessionId !== event.sessionId) {
        fail(
          "ROOT_IDENTITY_MISMATCH",
          "hook session does not own this loop run",
        );
      }
      state =
        await this.controller.rollForwardPrepared(state);
      if (
        state.cancelRequested ||
        TERMINAL_STATUSES.has(state.status)
      ) {
        return allow("terminal-or-cancelled", { state });
      }
      if (NON_BLOCKING_STATUSES.has(state.status)) {
        await this.#diagnose(runId, "governor_state_allows_stop", {
          eventId: event.eventId,
          status: state.status,
        });
        return allow("non-blocking-state", { state });
      }
      if (
        state.status !== "running" ||
        !state.pendingTransitionId
      ) {
        await this.#diagnose(runId, "governor_missing_obligation", {
          eventId: event.eventId,
          status: state.status,
        });
        return allow("missing-obligation", { state });
      }
      await this.#readDurableHookEvent(runId, event);

      const transition = await this.store.readTransition(
        runId,
        state.pendingTransitionId,
      );
      if (
        transition.runId !== runId ||
        transition.transitionId !==
          state.pendingTransitionId
      ) {
        fail(
          "RECOVERY_REQUIRED",
          "pending transition identity is invalid",
        );
      }
      const role = expectedRole(transition);
      if (!role) {
        await this.#diagnose(
          runId,
          "governor_terminal_transition_pending",
          {
            eventId: event.eventId,
            transitionId: transition.transitionId,
            transitionKind: transition.kind,
          },
        );
        return allow("non-actionable-transition", { state });
      }
      if (event.event === "SubagentStop") {
        const bindingRead =
          await this.store.listIdentityBindings(runId);
        if (bindingRead.corrupt.length > 0) {
          fail(
            "RECOVERY_REQUIRED",
            "worker identity bindings are corrupt",
          );
        }
        const agentMatches = bindingRead.facts.filter(
          (binding) =>
            binding.agentId === event.agentId &&
            binding.rootSessionId === state.rootSessionId &&
            binding.method === "capability-token-v1" &&
            binding.revokedAt === undefined,
        );
        if (
          agentMatches.length === 1 &&
          agentMatches[0].role !== role
        ) {
          return allow("stale-bound-worker", { state });
        }
        if (
          agentMatches.length !== 1 ||
          agentMatches[0].role !== role
        ) {
          await this.#diagnose(
            runId,
            "governor_worker_not_authorized",
            {
              eventId: event.eventId,
              agentId: event.agentId,
              expectedRole: role,
            },
          );
          return allow("worker-not-authorized", { state });
        }
      }

      const obligationId = state.pendingTransitionId;
      const existingBlockId = governorDecisionId({
        action: "block",
        runId,
        obligationId,
      });
      const existingBlock = await maybeRead(() =>
        this.store.readGovernorDecision(
          runId,
          existingBlockId,
        ),
      );
      if (existingBlock) {
        if (
          existingBlock.action !== "block" ||
          existingBlock.obligationId !== obligationId
        ) {
          fail(
            "RECOVERY_REQUIRED",
            "continuation receipt conflicts with its obligation",
          );
        }
        await this.#diagnose(
          runId,
          "continuation_no_progress",
          {
            eventId: event.eventId,
            obligationId,
            decisionId: existingBlock.decisionId,
          },
        );
        return allow("continuation-already-committed", {
          state,
          systemMessage: continuationCommittedMessage(
            runId,
            obligationId,
          ),
        });
      }

      if (
        state.continuationLease.consumed >=
        state.continuationLease.granted
      ) {
        const decision = this.#buildDecision({
          action: "cap",
          event,
          runId,
          state,
          obligationId,
          reasonCode: "lease-exhausted",
        });
        const published =
          await this.store.putGovernorDecision(
            runId,
            decision,
          );
        await this.#requirePublished(
          published,
          "cap",
          runId,
        );
        await this.fault("afterGovernorReceipt", {
          runId,
          decisionId: decision.decisionId,
        });
        state = await this.controller.applyGovernorDecision(
          state,
          decision,
        );
        await this.fault("afterGovernorCas", {
          runId,
          decisionId: decision.decisionId,
        });
        return allow("lease-exhausted", { state });
      }

      const decision = this.#buildDecision({
        action: "block",
        event,
        runId,
        state,
        obligationId,
        reasonCode:
          event.event === "SubagentStop"
            ? "pending-worker-report"
            : "pending-root-transition",
        leaseEpoch:
          state.continuationLease.consumed + 1,
      });
      const published =
        await this.store.putGovernorDecision(runId, decision);
      await this.#requirePublished(
        published,
        "block",
        runId,
      );
      await this.fault("afterGovernorReceipt", {
        runId,
        decisionId: decision.decisionId,
      });
      state = await this.controller.applyGovernorDecision(
        state,
        decision,
      );
      await this.fault("afterGovernorCas", {
        runId,
        decisionId: decision.decisionId,
      });
      await this.fault("beforeGovernorOutput", {
        runId,
        decisionId: decision.decisionId,
      });
      return {
        decision: "block",
        reasonCode: decision.reasonCode,
        reason: blockReason(
          runId,
          transition,
          event.event === "SubagentStop" ? role : undefined,
        ),
        state,
        decisionReceipt: decision,
      };
    });
  }

  async recover(runIdValue, eventValue) {
    if (!runIdValue) {
      return allow("no-active-run");
    }
    const runId = assertSafeFileId(runIdValue, "runId");
    const event = assertContract(
      "normalized hook event",
      eventValue,
      validateNormalizedHookEvent,
    );
    if (
      event.event !== "SessionStart" ||
      event.payloadSummary?.source !== "resume"
    ) {
      return allow("session-start-does-not-recover");
    }
    return this.store.withControlLock(runId, async () => {
      let state = await this.store.readState(runId);
      if (state.rootSessionId !== event.sessionId) {
        fail(
          "ROOT_IDENTITY_MISMATCH",
          "resumed session does not own this loop run",
        );
      }
      state =
        await this.controller.rollForwardPrepared(state);
      if (
        state.status !== "running" ||
        !state.pendingTransitionId
      ) {
        if (
          state.status === "running" &&
          !state.pendingTransitionId
        ) {
          await this.#diagnose(
            runId,
            "resume_running_without_obligation",
            { eventId: event.eventId },
          );
        }
        return allow("resume-needs-no-recovery", { state });
      }
      await this.#readDurableHookEvent(runId, event);
      const decision = this.#buildDecision({
        action: "interrupt",
        event,
        runId,
        state,
        obligationId: state.pendingTransitionId,
        reasonCode: "resume-in-flight",
      });
      const existing = await maybeRead(() =>
        this.store.readGovernorDecision(
          runId,
          decision.decisionId,
        ),
      );
      if (existing) {
        return allow("resume-already-recovered", { state });
      }
      const published =
        await this.store.putGovernorDecision(
          runId,
          decision,
        );
      await this.#requirePublished(
        published,
        "interrupt",
        runId,
      );
      await this.fault("afterGovernorReceipt", {
        runId,
        decisionId: decision.decisionId,
      });
      state = await this.controller.applyGovernorDecision(
        state,
        decision,
      );
      await this.fault("afterGovernorCas", {
        runId,
        decisionId: decision.decisionId,
      });
      return allow("resume-interrupted", { state });
    });
  }

  async #readDurableHookEvent(runId, event) {
    let durable;
    try {
      durable = await this.store.readEvent(
        runId,
        event.eventId,
      );
    } catch (error) {
      fail(
        "RECOVERY_REQUIRED",
        "governor hook event is not durably recorded",
        { code: error?.code ?? "READ_ERROR" },
      );
    }
    if (
      durable.eventId !== event.eventId ||
      durable.semanticKey !== event.semanticKey ||
      durable.payloadDigest !== event.payloadDigest ||
      durable.sessionId !== event.sessionId ||
      durable.turnId !== event.turnId ||
      durable.event !== event.event ||
      durable.agentId !== event.agentId ||
      durable.conflictEligible !== true
    ) {
      fail(
        "RECOVERY_REQUIRED",
        "governor hook event conflicts with durable evidence",
      );
    }
    return durable;
  }

  #buildDecision(input) {
    const value = {
      schemaVersion: SCHEMA_VERSION,
      decisionId: governorDecisionId({
        action: input.action,
        runId: input.runId,
        obligationId: input.obligationId,
        originEventId: input.event.eventId,
        fromRevision: input.state.revision,
      }),
      runId: input.runId,
      obligationId: input.obligationId,
      originEventId: input.event.eventId,
      hookEvent: input.event.event,
      rootSessionId: input.state.rootSessionId,
      ...(input.event.turnId
        ? { turnId: input.event.turnId }
        : {}),
      ...(input.event.event === "SubagentStop"
        ? { agentId: input.event.agentId }
        : {}),
      action: input.action,
      reasonCode: input.reasonCode,
      pendingTransitionId: input.obligationId,
      fromRevision: input.state.revision,
      toRevision: input.state.revision + 1,
      ...(input.leaseEpoch
        ? { leaseEpoch: input.leaseEpoch }
        : {}),
      createdAt: this.now(),
    };
    return assertContract(
      "governor decision",
      value,
      validateGovernorDecision,
    );
  }

  async #requirePublished(result, action, runId) {
    if (result?.status === "created") {
      return;
    }
    if (result?.status === "duplicate") {
      fail(
        "DELIVERY_UNCERTAIN",
        `${action} receipt was already committed`,
      );
    }
    if (result?.status === "limit") {
      const interrupted =
        await this.controller.interruptForFactLimit(
          await this.store.readState(runId),
          {
            factKind: "governor-decisions",
            limit: result.limit,
          },
        );
      fail(
        "FACT_LIMIT_REACHED",
        "governor receipt capacity was reached",
        {
          status: interrupted.status,
          needsHuman: interrupted.needsHuman === true,
        },
      );
    }
    fail(
      "RECOVERY_REQUIRED",
      "governor receipt could not be published",
    );
  }

  async #diagnose(runId, kind, details) {
    try {
      await this.store.writeDiagnostic(
        runId,
        kind,
        details,
      );
    } catch {
      // Diagnostics are observational. Their failure must never turn an allow
      // decision into a continuation block.
    }
  }
}
