// Pure schedule math for the L1 timer source (kernel doc §2.4).
//
// Two schedule forms share one contract: given the anchor (the last tick, or
// the subscription's creation) and the current instant, when is the next
// tick due? Interval schedules are plain arithmetic; dailyAt schedules are
// wall-clock local time ("daily at 09:00" means 09:00 on the runtime host's
// clock). Restart catch-up falls out of the anchor semantics: if the next
// occurrence after the anchor is already in the past, the delay is 0 —
// exactly one immediate catch-up tick, never a replay of the missed backlog.

export type ScheduleOn = {
  on: 'schedule'
  // Exactly one of the two forms; the runtime validates the pairing.
  everySeconds?: number
  dailyAt?: string
}

// Parses 'HH:MM' (24h). Returns undefined on anything else; the runtime
// rejects such input at authoring time, so a undefined here means a
// malformed subscription snapshot rather than user input.
export function parseDailyAt(
  dailyAt: string | undefined
): { hour: number; minute: number } | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(dailyAt ?? '')
  if (!match) {
    return undefined
  }
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function normalizeDailyAt(dailyAt: string | undefined): string | undefined {
  const parsed = parseDailyAt(dailyAt)
  if (!parsed) {
    return undefined
  }
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`
}

// The earliest local-time occurrence of HH:MM strictly after `afterMs`.
// Local Date arithmetic on purpose: "daily at 09:00" tracks the host's
// wall clock across DST shifts (a spring-forward day may run a tick an
// hour off once; wall-clock alignment thereafter beats fixed 24h periods).
export function nextDailyOccurrenceMs(dailyAt: string, afterMs: number): number {
  const parsed = parseDailyAt(dailyAt)
  if (!parsed || !Number.isFinite(afterMs)) {
    return Number.NaN
  }
  const candidate = new Date(afterMs)
  candidate.setHours(parsed.hour, parsed.minute, 0, 0)
  // Roll forward day by day (bounded: two steps suffice outside DST edge
  // cases, but the loop guards against setHours landing inside a skipped
  // hour and mapping backwards).
  for (let step = 0; step < 4 && candidate.getTime() <= afterMs; step += 1) {
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(parsed.hour, parsed.minute, 0, 0)
  }
  return candidate.getTime()
}

// Delay until the next tick. `anchorMs` is Date.parse(lastTickAt ?? createdAt);
// callers pass `nowMs` for an unparseable anchor (fresh start, no history).
export function scheduleDelayMs(
  on: ScheduleOn,
  anchorMs: number,
  nowMs: number
): number {
  const base = Number.isFinite(anchorMs) ? anchorMs : nowMs
  if (on.dailyAt !== undefined) {
    const next = nextDailyOccurrenceMs(on.dailyAt, base)
    return Number.isFinite(next) ? Math.max(0, next - nowMs) : 0
  }
  const everyMs = Number(on.everySeconds) * 1000
  return Math.max(0, base + everyMs - nowMs)
}

// Human-readable schedule summary, shared by default notes and tick reasons.
export function scheduleSummary(on: ScheduleOn): string {
  if (on.dailyAt !== undefined) {
    return `daily at ${normalizeDailyAt(on.dailyAt) ?? on.dailyAt}`
  }
  return `every ${on.everySeconds}s`
}
