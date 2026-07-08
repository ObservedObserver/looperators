import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nextDailyOccurrenceMs,
  normalizeDailyAt,
  parseDailyAt,
  scheduleDelayMs,
} from '../../dist-electron/shared/graph-core/index.js'

// Local-time helpers: dailyAt is wall-clock on the runtime host, so the
// expectations are built with the same local Date semantics the
// implementation uses. July dates on purpose — no region switches DST in
// July, keeping the fixtures stable in any CI timezone.
const local = (y, m, d, h, min) => new Date(y, m, d, h, min, 0, 0).getTime()

test('parseDailyAt accepts 24h HH:MM and rejects everything else', () => {
  assert.deepEqual(parseDailyAt('09:00'), { hour: 9, minute: 0 })
  assert.deepEqual(parseDailyAt('9:05'), { hour: 9, minute: 5 })
  assert.deepEqual(parseDailyAt('23:59'), { hour: 23, minute: 59 })
  assert.equal(parseDailyAt('24:00'), undefined)
  assert.equal(parseDailyAt('9:5'), undefined)
  assert.equal(parseDailyAt('09:60'), undefined)
  assert.equal(parseDailyAt('nine'), undefined)
  assert.equal(parseDailyAt(undefined), undefined)
})

test('normalizeDailyAt zero-pads for stable display and storage', () => {
  assert.equal(normalizeDailyAt('9:05'), '09:05')
  assert.equal(normalizeDailyAt('09:05'), '09:05')
  assert.equal(normalizeDailyAt('25:00'), undefined)
})

test('nextDailyOccurrenceMs: same day when the time is still ahead', () => {
  const anchor = local(2026, 6, 8, 8, 0)
  assert.equal(nextDailyOccurrenceMs('09:00', anchor), local(2026, 6, 8, 9, 0))
})

test('nextDailyOccurrenceMs: next day when the time already passed', () => {
  const anchor = local(2026, 6, 8, 10, 0)
  assert.equal(nextDailyOccurrenceMs('09:00', anchor), local(2026, 6, 9, 9, 0))
})

test('nextDailyOccurrenceMs is strictly after the anchor', () => {
  const anchor = local(2026, 6, 8, 9, 0)
  assert.equal(
    nextDailyOccurrenceMs('09:00', anchor),
    local(2026, 6, 9, 9, 0),
    'an anchor exactly on the tick never repeats the same instant'
  )
})

test('scheduleDelayMs: interval counts from the anchor', () => {
  const on = { on: 'schedule', everySeconds: 60 }
  const anchor = local(2026, 6, 8, 9, 0)
  assert.equal(scheduleDelayMs(on, anchor, anchor + 10_000), 50_000)
})

test('scheduleDelayMs: an overdue interval fires immediately, once', () => {
  const on = { on: 'schedule', everySeconds: 60 }
  const anchor = local(2026, 6, 8, 9, 0)
  assert.equal(
    scheduleDelayMs(on, anchor, anchor + 10 * 60_000),
    0,
    'ten missed minutes yield one catch-up tick, not a backlog'
  )
})

test('scheduleDelayMs: an unparseable anchor falls back to now', () => {
  const on = { on: 'schedule', everySeconds: 60 }
  const now = local(2026, 6, 8, 9, 0)
  assert.equal(scheduleDelayMs(on, Number.NaN, now), 60_000)
})

test('scheduleDelayMs: dailyAt waits for the next wall-clock occurrence', () => {
  const on = { on: 'schedule', dailyAt: '09:00' }
  const anchor = local(2026, 6, 8, 8, 0)
  const now = local(2026, 6, 8, 8, 30)
  assert.equal(scheduleDelayMs(on, anchor, now), 30 * 60_000)
})

test('scheduleDelayMs: a missed dailyAt yields exactly one overdue tick', () => {
  const on = { on: 'schedule', dailyAt: '09:00' }
  const anchor = local(2026, 6, 7, 9, 30) // last tick: yesterday, after nine
  const now = local(2026, 6, 8, 10, 0) // restart: today, an hour past nine
  assert.equal(
    scheduleDelayMs(on, anchor, now),
    0,
    'downtime across the daily time fires one catch-up tick on restart'
  )
})

test('scheduleDelayMs: dailyAt already ticked today waits for tomorrow', () => {
  const on = { on: 'schedule', dailyAt: '09:00' }
  const anchor = local(2026, 6, 8, 9, 0) // ticked at nine sharp today
  const now = local(2026, 6, 8, 9, 0)
  assert.equal(scheduleDelayMs(on, anchor, now), 24 * 60 * 60_000)
})
