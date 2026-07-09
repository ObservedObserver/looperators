// Pure ingestion logic for external event sources (L2, kernel doc §2.4).
//
// The runtime's choke point (emitExternalEvent) makes exactly one decision
// per emit — accept or drop — and this module is that decision as a pure
// function of (source, emit, now). No IO, no clocks: callers pass `nowMs`.
//
// Sampling semantics are DROP, not delay: a too-soon emit is rejected and
// the adapter re-emits current state on its next beat (a watcher's next
// poll naturally carries a fresh dedupeKey if anything actually changed).

import type { ExternalSource, ExternalSourceKind } from './types.js'

export const externalSourceKinds = new Set<ExternalSourceKind>([
  'script',
  'git',
  'webhook',
  'manual',
])

// Fact names are `external.<topic>`; 'timer' is the L1 clock's reserved
// name and can never be claimed by a registered source.
export const reservedExternalTopics = new Set<string>(['timer'])

const topicPattern = /^[a-z][a-z0-9_-]{0,63}$/

export function isValidExternalTopic(topic: unknown): topic is string {
  return (
    typeof topic === 'string' &&
    topicPattern.test(topic) &&
    !reservedExternalTopics.has(topic)
  )
}

// Conservative source-side sampling defaults by kind (proposal L2
// guardrail 1). Watcher-shaped sources get a floor even when the user
// leaves the field empty; 'manual' emits are human-paced already.
export const defaultMinIntervalSecondsByKind: Record<ExternalSourceKind, number> = {
  script: 1,
  git: 5,
  webhook: 1,
  manual: 0,
}

export function sourceMinIntervalSeconds(source: {
  kind: ExternalSourceKind
  minIntervalSeconds?: number
}): number {
  const explicit = source.minIntervalSeconds
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return explicit
  }
  return defaultMinIntervalSecondsByKind[source.kind] ?? 0
}

export type IngestionDecision =
  | { ok: true }
  | { ok: false; reason: string }

// Accept-or-drop for one emit against the source's folded anchors.
// - min interval: measured from the last ACCEPTED event (lastEventAt);
//   an unparseable/absent anchor never blocks (first emit always passes).
// - dedupe: consecutive suppression — an emit whose dedupeKey equals the
//   last accepted one is a repeat of a state the graph already heard about.
export function externalIngestionDecision(
  source: Pick<
    ExternalSource,
    'kind' | 'state' | 'minIntervalSeconds' | 'lastEventAt' | 'lastDedupeKey'
  >,
  emit: { dedupeKey?: string },
  nowMs: number
): IngestionDecision {
  if (source.state !== 'active') {
    return { ok: false, reason: 'Source is removed.' }
  }

  if (emit.dedupeKey !== undefined && emit.dedupeKey === source.lastDedupeKey) {
    return {
      ok: false,
      reason: `Duplicate of the last accepted event (dedupeKey ${emit.dedupeKey}).`,
    }
  }

  const minIntervalMs = sourceMinIntervalSeconds(source) * 1000
  const anchorMs = Date.parse(source.lastEventAt ?? '')
  if (minIntervalMs > 0 && Number.isFinite(anchorMs)) {
    const earliestMs = anchorMs + minIntervalMs
    if (nowMs < earliestMs) {
      return {
        ok: false,
        reason: `Sampling: next emit accepted in ${Math.ceil((earliestMs - nowMs) / 1000)}s (min interval ${minIntervalMs / 1000}s).`,
      }
    }
  }

  return { ok: true }
}

// Human-readable origin line for canvas nodes and default activation notes,
// mirroring scheduleSummary for timers.
export function externalSourceSummary(source: {
  kind: ExternalSourceKind
  topic: string
  label?: string
}): string {
  return source.label ?? `${source.kind} source · external.${source.topic}`
}
