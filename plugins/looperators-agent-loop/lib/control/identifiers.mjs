import { canonicalJson, digestJson, sha256 } from '../canonical-json.mjs';
import { SCHEMA_VERSION } from '../contracts.mjs';
import { timingSafeEqual } from 'node:crypto';

export function roleAgentId(role) {
  return `role:${role}`;
}

export function digestsEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function derivedId(prefix, value) {
  return `${prefix}_${sha256(canonicalJson(value))}`;
}

export function runIdFor(rootSessionId, previewRequestId) {
  return derivedId('run', {
    rootSessionId,
    requestId: previewRequestId,
  });
}

export function definitionIdFor(value) {
  return derivedId('definition', {
    runId: value,
    kind: 'definition',
  });
}

export function operationIdFor(value, mutationRequestId) {
  return derivedId('op', {
    runId: value,
    requestId: mutationRequestId,
  });
}

export function reportIdFor(value, mutationRequestId) {
  return derivedId('report', {
    runId: value,
    requestId: mutationRequestId,
    kind: 'report',
  });
}

export function transitionIdFor(value, mutationRequestId) {
  return derivedId('transition', {
    runId: value,
    requestId: mutationRequestId,
    kind: 'transition',
  });
}

export function factLimitRequestId(fromRevision) {
  return `internal-fact-limit-${fromRevision}`;
}

export function reportPayload(report) {
  return {
    type: report.type,
    ...(report.status ? { status: report.status } : {}),
    ...(report.verdict ? { verdict: report.verdict } : {}),
    ...(report.issues ? { issues: report.issues } : {}),
    ...(report.summary ? { summary: report.summary } : {}),
  };
}

export function bindingRequestDigest(input) {
  return digestJson({
    kind: 'bind-worker',
    runId: input.runId,
    requestId: input.requestId,
    agentId: input.agentId,
    role: input.role,
    observationId: input.observationId,
    originEventId: input.originEventId,
  });
}

export function observationIdFor(value, mutationRequestId) {
  return derivedId('observation', {
    runId: value,
    requestId: mutationRequestId,
    kind: 'prepare-worker-spawn',
  });
}

export function observationRequestDigest(input) {
  return digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: 'prepare-worker-spawn',
    runId: input.runId,
    requestId: input.requestId,
    rootSessionId: input.rootSessionId,
    role: input.role,
  });
}

export function mutationRequestDigest(input) {
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

export function definitionRequestDigest(input) {
  return digestJson({
    schemaVersion: SCHEMA_VERSION,
    kind: 'preview',
    rootSessionId: input.rootSessionId,
    requestId: input.requestId,
    recipe: 'review-until-clean',
    goal: input.goal,
    implementerInstructions: input.implementerInstructions,
    reviewerInstructions: input.reviewerInstructions,
    lapCap: input.lapCap,
  });
}
