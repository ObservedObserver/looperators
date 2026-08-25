import { ACTIVE_RUN_STATUSES, assertContract, SCHEMA_VERSION, validateLoopDefinition } from '../contracts.mjs';
import { fail } from './errors.mjs';
import { definitionIdFor, definitionRequestDigest, runIdFor } from './identifiers.mjs';
import { assertRootContext, boundedString, requestId } from './input.mjs';
import { assertRoot } from './invariants.mjs';
import { maybeRead, previewGraph, stateSummary } from './state.mjs';

export async function preview(runtime, contextValue, input) {
  const context = assertRootContext(contextValue);
  const previewRequestId = requestId(input?.requestId);
  const lapCap = input?.lapCap ?? 3;
  const goal = boundedString(input?.goal, 'goal', 8192);
  const implementerInstructions = boundedString(input?.implementerInstructions, 'implementerInstructions', 16384);
  const reviewerInstructions = boundedString(input?.reviewerInstructions, 'reviewerInstructions', 16384);
  if (!Number.isInteger(lapCap) || lapCap < 1 || lapCap > 6) {
    fail('INVALID_TOOL_INPUT', 'lapCap is invalid');
  }
  const desiredRunId = runIdFor(context.rootSessionId, previewRequestId);
  const desired = assertContract(
    'loop definition',
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
      recipe: 'review-until-clean',
      goal,
      implementerInstructions,
      reviewerInstructions,
      lapCap,
      createdAt: runtime.now(),
    },
    validateLoopDefinition,
  );

  const existingDefinition = await maybeRead(() => runtime.store.readDefinition(desiredRunId));
  if (existingDefinition) {
    if (existingDefinition.requestDigest !== desired.requestDigest) {
      fail('REQUEST_ID_CONFLICT', 'preview request id already has different content');
    }
    const state = await ensurePreviewDraft(runtime, context, existingDefinition);
    return previewResult(runtime, state, existingDefinition, true);
  }

  const bound = await runtime.store.boundRunsForSession(context.rootSessionId);
  const occupied = bound.find(({ state }) => state === null || ACTIVE_RUN_STATUSES.has(state.status));
  if (occupied) {
    fail('ACTIVE_RUN_EXISTS', 'another non-terminal loop run already exists in this task', { runId: occupied.binding.runId });
  }

  const published = await runtime.store.putDefinition(desiredRunId, desired);
  if (published.status === 'conflict') {
    fail('REQUEST_ID_CONFLICT', 'preview request id already has different content');
  }
  await runtime.fault('afterDefinition', {
    runId: desiredRunId,
  });
  const state = await ensurePreviewDraft(runtime, context, desired);
  return previewResult(runtime, state, desired, published.status === 'duplicate');
}

export async function ensurePreviewDraft(runtime, context, definition) {
  try {
    return await ensureDraftState(runtime, context, definition);
  } catch (error) {
    if (!['SESSION_BINDING_CONFLICT', 'SESSION_BINDING_RESERVED'].includes(error?.code)) {
      throw error;
    }
    const current = await runtime.store.boundRunsForSession(context.rootSessionId);
    fail('ACTIVE_RUN_EXISTS', 'another non-terminal loop run already exists in this task', { runId: current[0]?.binding.runId });
  }
}

export async function ensureDraftState(runtime, context, definition) {
  const existing = await maybeRead(() => runtime.store.readState(definition.runId));
  if (existing) {
    assertRoot(runtime, existing, context);
    if (existing.status !== 'draft') {
      fail('RUN_ALREADY_STARTED', 'preview request already belongs to a started run', { runId: existing.runId, status: existing.status });
    }
    return existing;
  }
  const state = {
    schemaVersion: SCHEMA_VERSION,
    runId: definition.runId,
    rootSessionId: context.rootSessionId,
    originatingTurnId: context.turnId,
    scope: { kind: 'task' },
    masterNode: context.rootSessionId,
    recipe: 'review-until-clean',
    status: 'draft',
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
  const result = await runtime.store.initializeRun(state);
  return result.existing ?? state;
}

export function previewResult(runtime, state, definition, duplicate) {
  return {
    ...stateSummary(state, definition, duplicate),
    definition,
    preview: previewGraph(),
  };
}
