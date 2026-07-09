import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

// L2 script source adapter tests — the "local reproducible reality" floor:
// real child processes (node fixtures in a temp dir), no runtime mocks.
// Everything downstream of the choke point is covered by
// external-source.test.mjs; here we test the translation only.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate()
    if (value) {
      return value
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function harness(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input = { storageFile }) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }
  const fixture = (name, source) => {
    const file = path.join(tempRoot, name)
    fs.writeFileSync(file, source)
    return file
  }
  const cleanup = () => {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, storageFile, manager, fixture, cleanup }
}

const factsOf = (runtime, topic) =>
  runtime.getKernelEvents({ type: `external.${topic}` }).events

test('lines mode: each stdout line is one event; JSON lines carry payload and dedupeKey', async () => {
  const { manager, fixture, cleanup } = harness('orrery-script-lines-')
  try {
    const runtime = manager()
    const script = fixture(
      'lines.mjs',
      [
        `console.log(JSON.stringify({ dedupeKey: 'run-9', status: 'failed', suite: 'unit' }))`,
        `console.log(JSON.stringify({ status: 'flaky' }))`,
        `console.log('plain text heartbeat')`,
      ].join('\n')
    )
    runtime.registerExternalSource({
      id: 'src-lines',
      kind: 'script',
      topic: 'ci',
      minIntervalSeconds: 0,
      config: { command: process.execPath, args: [script] },
    })

    await waitFor('three line events', () => factsOf(runtime, 'ci').length === 3)
    const facts = factsOf(runtime, 'ci')
    assert.deepEqual(
      facts.map((event) => event.payload.status ?? event.payload.line),
      ['failed', 'flaky', 'plain text heartbeat']
    )
    // The top-level dedupeKey field was extracted, not kept in the payload.
    assert.equal(facts[0].payload.dedupeKey, 'run-9')
    assert.equal(facts[0].payload.suite, 'unit')
    // The anchor tracks the LAST accepted line, whose key is absent — the
    // key-less lines after 'run-9' cleared it (consecutive dedupe only).
    assert.equal(runtime.getState().sources['src-lines'].lastDedupeKey, undefined)
  } finally {
    cleanup()
  }
})

test('lines mode: default sampling tames a spamming script without polluting the log', async () => {
  const { manager, fixture, cleanup } = harness('orrery-script-spam-')
  try {
    const runtime = manager()
    const script = fixture(
      'spam.mjs',
      `for (let i = 0; i < 200; i += 1) console.log(JSON.stringify({ tick: i }))`
    )
    // Default script-kind sampling is 1s: a burst collapses to ~1 accepted.
    runtime.registerExternalSource({
      id: 'src-spam',
      kind: 'script',
      topic: 'spam',
      config: { command: process.execPath, args: [script] },
    })
    await waitFor('first accepted emit', () => factsOf(runtime, 'spam').length >= 1)
    await delay(500)
    assert.ok(
      factsOf(runtime, 'spam').length <= 2,
      `sampling should drop the burst (got ${factsOf(runtime, 'spam').length})`
    )
  } finally {
    cleanup()
  }
})

test('lines mode: garbage output and a nonzero exit land on lastError, never in the kernel', async () => {
  const { manager, fixture, cleanup } = harness('orrery-script-garbage-')
  try {
    const runtime = manager()
    const script = fixture(
      'garbage.mjs',
      [
        // One oversized JSON line (rejected by the payload cap)…
        `console.log(JSON.stringify({ blob: 'x'.repeat(20 * 1024) }))`,
        // …then a crash.
        `process.exit(3)`,
      ].join('\n')
    )
    runtime.registerExternalSource({
      id: 'src-bad',
      kind: 'script',
      topic: 'bad',
      minIntervalSeconds: 0,
      config: { command: process.execPath, args: [script] },
    })
    await waitFor(
      'exit error recorded',
      () => /exited with code 3/.test(runtime.getState().sources['src-bad'].lastError ?? '')
    )
    assert.equal(factsOf(runtime, 'bad').length, 0, 'no kernel pollution')
  } finally {
    cleanup()
  }
})

test('lines mode: restartSeconds respawns a finished watcher', async () => {
  const { manager, fixture, tempRoot, cleanup } = harness('orrery-script-restart-')
  try {
    const runtime = manager()
    const counterFile = path.join(tempRoot, 'counter.txt')
    const script = fixture(
      'counting.mjs',
      [
        `import fs from 'node:fs'`,
        `const file = ${JSON.stringify(counterFile)}`,
        `const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1`,
        `fs.writeFileSync(file, String(count))`,
        `console.log(JSON.stringify({ dedupeKey: 'count-' + count, count }))`,
      ].join('\n')
    )
    runtime.registerExternalSource({
      id: 'src-restart',
      kind: 'script',
      topic: 'count',
      minIntervalSeconds: 0,
      config: { command: process.execPath, args: [script], restartSeconds: 1 },
    })
    await waitFor(
      'two runs across a respawn',
      () => factsOf(runtime, 'count').length >= 2,
      15000
    )
    const counts = factsOf(runtime, 'count').map((event) => event.payload.count)
    assert.deepEqual(counts.slice(0, 2), [1, 2])
  } finally {
    cleanup()
  }
})

test('exit mode: each run is one event and an unchanged outcome dedupes away', async () => {
  const { manager, fixture, tempRoot, cleanup } = harness('orrery-script-exit-')
  try {
    const runtime = manager()
    const statusFile = path.join(tempRoot, 'status.txt')
    fs.writeFileSync(statusFile, 'green')
    const script = fixture(
      'poll.mjs',
      [
        `import fs from 'node:fs'`,
        `console.log('status: ' + fs.readFileSync(${JSON.stringify(statusFile)}, 'utf8'))`,
      ].join('\n')
    )
    runtime.registerExternalSource({
      id: 'src-poll',
      kind: 'script',
      topic: 'poll',
      minIntervalSeconds: 0,
      config: {
        command: process.execPath,
        args: [script],
        mode: 'exit',
        everySeconds: 5,
      },
    })

    // First run fires immediately.
    await waitFor('first poll event', () => factsOf(runtime, 'poll').length === 1)
    const first = factsOf(runtime, 'poll')[0]
    assert.equal(first.payload.exitCode, 0)
    assert.match(first.payload.output, /status: green/)

    // Second run (t+5s) sees the same outcome → consecutive dedupe drops it.
    await delay(6500)
    assert.equal(factsOf(runtime, 'poll').length, 1, 'unchanged poll stays silent')

    // Change the observed state; the next run emits again.
    fs.writeFileSync(statusFile, 'red')
    await waitFor(
      'changed poll outcome',
      () => factsOf(runtime, 'poll').length === 2,
      15000
    )
    assert.match(factsOf(runtime, 'poll')[1].payload.output, /status: red/)
  } finally {
    cleanup()
  }
})

test('an adapter with no accepted events still restarts after a runtime restart', async () => {
  const { manager, fixture, tempRoot, storageFile, cleanup } = harness('orrery-script-revive-')
  try {
    const runFile = path.join(tempRoot, 'runs.txt')
    // Run 1 (before the restart) emits nothing — the source has NO logged
    // events; run 2+ emits one line. The second manager must still start
    // the adapter (revival must not depend on emit history).
    const script = fixture(
      'two-phase.mjs',
      [
        `import fs from 'node:fs'`,
        `const file = ${JSON.stringify(runFile)}`,
        `const run = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1`,
        `fs.writeFileSync(file, String(run))`,
        `if (run > 1) console.log(JSON.stringify({ run }))`,
      ].join('\n')
    )
    const first = manager()
    first.registerExternalSource({
      id: 'src-revive',
      kind: 'script',
      topic: 'revive',
      minIntervalSeconds: 0,
      config: { command: process.execPath, args: [script] },
    })
    await waitFor('first (silent) run happened', () => fs.existsSync(runFile))
    assert.equal(factsOf(first, 'revive').length, 0, 'no events before the restart')
    first.killAll()

    const second = manager({ storageFile })
    await waitFor('revived adapter emits', () => factsOf(second, 'revive').length === 1, 15000)
    assert.equal(factsOf(second, 'revive')[0].payload.run, 2)
  } finally {
    cleanup()
  }
})

test('removing a source terminates an in-flight exit-mode poll process', async () => {
  const { manager, fixture, tempRoot, cleanup } = harness('orrery-script-kill-poll-')
  try {
    const pidFile = path.join(tempRoot, 'poll.pid')
    const script = fixture(
      'stuck-poll.mjs',
      [
        `import fs from 'node:fs'`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
        `setTimeout(() => {}, 30000)`,
      ].join('\n')
    )
    const runtime = manager()
    runtime.registerExternalSource({
      id: 'src-stuck',
      kind: 'script',
      topic: 'stuck',
      config: { command: process.execPath, args: [script], mode: 'exit', everySeconds: 5 },
    })
    await waitFor('in-flight poll started', () => fs.existsSync(pidFile))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))

    runtime.removeExternalSource({ sourceId: 'src-stuck' })
    await waitFor('stuck poll terminated', () => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  } finally {
    cleanup()
  }
})

test('registration validates script config up front', async () => {
  const { manager, cleanup } = harness('orrery-script-validate-')
  try {
    const runtime = manager()
    assert.throws(
      () => runtime.registerExternalSource({ kind: 'script' }),
      /requires config\.command/
    )
    assert.throws(
      () =>
        runtime.registerExternalSource({
          kind: 'script',
          config: { command: 'x', args: 'not-an-array' },
        }),
      /array of strings/
    )
    assert.throws(
      () =>
        runtime.registerExternalSource({
          kind: 'script',
          config: { command: 'x', mode: 'cron' },
        }),
      /"lines" or "exit"/
    )
    assert.throws(
      () =>
        runtime.registerExternalSource({
          kind: 'script',
          config: { command: 'x', mode: 'exit', everySeconds: 1 },
        }),
      /integer >= 5/
    )
  } finally {
    cleanup()
  }
})
