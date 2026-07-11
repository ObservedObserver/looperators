import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { OrreryHarness } from '../../scripts/lib/orrery-client.mjs'

const execFileAsync = promisify(execFile)
const cliPath = path.resolve('scripts/orrery-cli.mjs')
const deterministicCliPath = path.resolve('tests/runtime/support/deterministic-runtime-cli.mjs')

async function runCli(baseUrl, args, { expectFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, '--url', baseUrl, ...args],
      { timeout: 30_000 }
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (!expectFailure || error.killed || error.signal) {
      // A timed-out/killed CLI is never an "expected failure" — surface it
      // instead of letting it masquerade as a nonzero exit code.
      throw error
    }
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('debug CLI covers the session/graph/state surface', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-cli-test-'))
  const harness = await OrreryHarness.start({
    cliPath: deterministicCliPath,
  })
  const base = harness.baseUrl

  try {
    const empty = await runCli(base, ['sessions'])
    assert.match(empty.stdout, /No sessions\./)

    const created = await runCli(base, [
      'session',
      'create',
      '--prompt',
      'cli smoke prompt',
      '--cwd',
      process.cwd(),
      '--label',
      'CliSmoke',
      '--model',
      'cli-test-model',
      '--wait',
      '--timeout',
      '10000',
    ])
    const sessionId = created.stdout.trim().split('\n')[0]
    assert.match(sessionId, /^[0-9a-f-]{36}$/)
    assert.match(created.stdout, /status: idle/)
    assert.match(created.stdout, /handled: cli smoke prompt/)

    const list = await runCli(base, ['sessions'])
    assert.match(list.stdout, /CliSmoke/)
    assert.match(list.stdout, /idle/)

    const shortPrefix = sessionId.slice(0, 8)
    const shown = await runCli(base, ['session', 'show', shortPrefix])
    assert.match(shown.stdout, /CliSmoke/)
    assert.match(shown.stdout, /model: cli-test-model/)
    assert.match(shown.stdout, /cli smoke prompt/)
    assert.match(shown.stdout, /handled: cli smoke prompt/)

    const raw = await runCli(base, ['session', 'show', sessionId, '--view', 'raw'])
    const rawParsed = JSON.parse(raw.stdout)
    assert.equal(rawParsed.session.sessionId, sessionId)

    const graph = await runCli(base, ['graph'])
    assert.match(graph.stdout, new RegExp(shortPrefix))
    assert.match(graph.stdout, /CliSmoke/)

    const state = await runCli(base, ['state'])
    assert.match(state.stdout, /sessions: 1 \(idle=1\)/)

    const events = await runCli(base, ['events', sessionId])
    const eventsParsed = JSON.parse(events.stdout)
    assert.equal(eventsParsed.sessionId, sessionId)
    assert.equal(eventsParsed.events.length > 0, true)

    const kernel = await runCli(base, ['kernel'])
    assert.match(kernel.stdout, /session\.created/)
    assert.match(kernel.stdout, /actor=human/)
    assert.match(kernel.stdout, /latestSeq=/)
    const kernelJson = await runCli(base, ['kernel', '--json', '--type', 'session.finished'])
    const kernelParsed = JSON.parse(kernelJson.stdout)
    assert.ok(kernelParsed.events.length >= 1)
    assert.ok(kernelParsed.events.every((event) => event.type === 'session.finished'))
    assert.ok(kernelParsed.events[0].causeId, 'finish must carry its causal link')

    const deliverBlocked = await runCli(
      base,
      ['--readonly', 'session', 'deliver', sessionId, '--content', 'x'],
      { expectFailure: true }
    )
    assert.notEqual(deliverBlocked.code, 0)
    assert.match(deliverBlocked.stderr, /--readonly: refusing/)

    const deliverRes = await runCli(base, [
      'session',
      'deliver',
      sessionId,
      '--topic',
      'notes',
      '--content',
      'cli delivery payload',
    ])
    assert.match(deliverRes.stdout, /delivered #1 \(topic notes\)/)

    const activateRes = await runCli(base, [
      'session',
      'activate',
      sessionId,
      '--wait',
      '--timeout',
      '10000',
    ])
    assert.match(activateRes.stdout, /activated /)
    assert.match(activateRes.stdout, /status: idle/)

    const missing = await runCli(base, ['session', 'show', 'zzz'], {
      expectFailure: true,
    })
    assert.notEqual(missing.code, 0)
    assert.match(missing.stderr, /No session matches/)

    const blocked = await runCli(
      base,
      ['--readonly', 'session', 'archive', sessionId],
      { expectFailure: true }
    )
    assert.notEqual(blocked.code, 0)
    assert.match(blocked.stderr, /--readonly: refusing/)

    const archived = await runCli(base, ['session', 'archive', sessionId])
    assert.match(archived.stdout, /archived/)
    const afterArchive = await runCli(base, ['sessions'])
    assert.match(afterArchive.stdout, /No sessions\./)
    const withArchived = await runCli(base, ['sessions', '--all'])
    assert.match(withArchived.stdout, /\[archived\]/)

    const restored = await runCli(base, [
      'session',
      'archive',
      sessionId,
      '--restore',
    ])
    assert.match(restored.stdout, /restored/)

    const killIdle = await runCli(base, ['session', 'kill', sessionId])
    assert.match(killIdle.stdout, /no active run to kill/)

    const second = await runCli(base, [
      'session',
      'create',
      '--prompt',
      'cli smoke second session',
      '--cwd',
      process.cwd(),
      '--label',
      'CliSmokeTwo',
      '--wait',
      '--timeout',
      '10000',
    ])
    const secondId = second.stdout.trim().split('\n')[0]

    const blockedEdge = await runCli(
      base,
      ['--readonly', 'edge', 'add', shortPrefix, secondId.slice(0, 8)],
      { expectFailure: true }
    )
    assert.notEqual(blockedEdge.code, 0)
    assert.match(blockedEdge.stderr, /--readonly: refusing/)

    const edgeAdded = await runCli(base, [
      'edge',
      'add',
      shortPrefix,
      secondId.slice(0, 8),
      '--label',
      'reviews',
      '--reason',
      'cli link smoke',
    ])
    const edgeId = edgeAdded.stdout.trim().split('\n')[0]
    assert.equal(edgeId.startsWith('link:'), true)
    assert.match(edgeAdded.stdout, /-\[link "reviews"\]->/)

    const graphWithEdge = await runCli(base, ['graph'])
    assert.match(graphWithEdge.stdout, /-\[link "reviews"\]->/)
    assert.match(graphWithEdge.stdout, /\(link:/)

    const unknownEdge = await runCli(base, ['edge', 'remove', 'zzz'], {
      expectFailure: true,
    })
    assert.match(unknownEdge.stderr, /No edge matches/)

    const edgeRemoved = await runCli(base, ['edge', 'remove', edgeId.slice(0, 13)])
    assert.match(edgeRemoved.stdout, /removed link:/)
    const graphAfterRemove = await runCli(base, ['graph'])
    assert.doesNotMatch(graphAfterRemove.stdout, /-\[link/)

    const badTimeout = await runCli(
      base,
      ['session', 'create', '--prompt', 'x', '--wait', '--timeout', '5s'],
      { expectFailure: true }
    )
    assert.equal(badTimeout.code, 2)
    assert.match(badTimeout.stderr, /--timeout must be a positive integer/)

    const badMaxEvents = await runCli(
      base,
      ['session', 'tail', sessionId, '--max-events', '0'],
      { expectFailure: true }
    )
    assert.equal(badMaxEvents.code, 2)
    assert.match(badMaxEvents.stderr, /--max-events must be a positive integer/)

    const tailConflict = await runCli(
      base,
      ['session', 'tail', sessionId, '--all'],
      { expectFailure: true }
    )
    assert.equal(tailConflict.code, 2)
    assert.match(tailConflict.stderr, /either an id or --all/)

    const badProvider = await runCli(
      base,
      ['session', 'create', '--prompt', 'x', '--provider', 'claude'],
      { expectFailure: true }
    )
    assert.equal(badProvider.code, 2)
    assert.match(badProvider.stderr, /--provider must be one of/)
  } finally {
    await harness.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

function spawnTail(baseUrl, args) {
  const tail = spawn(process.execPath, [
    cliPath,
    '--url',
    baseUrl,
    'session',
    'tail',
    ...args,
  ])
  let output = ''
  tail.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  return { tail, getOutput: () => output }
}

function waitForTailOutput(tail, getOutput, needle) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(probe)
      tail.kill('SIGKILL')
      reject(new Error(`tail output never contained "${needle}": ${getOutput()}`))
    }, 10_000)
    const probe = setInterval(() => {
      if (getOutput().includes(needle)) {
        clearTimeout(timer)
        clearInterval(probe)
        resolve()
      }
    }, 50)
  })
}

function waitForTailExit(tail, getOutput) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tail.kill('SIGKILL')
      reject(new Error(`tail did not exit: ${getOutput()}`))
    }, 10_000)
    tail.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

test('debug CLI tail follows live events after its ready signal', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-cli-tail-test-'))
  const harness = await OrreryHarness.start({
    cliPath: deterministicCliPath,
  })

  try {
    const created = await harness.createSession({
      prompt: 'tail target session',
      label: 'TailTarget',
      cwd: process.cwd(),
    })
    await harness.waitForIdle(created.sessionId, { timeoutMs: 10_000 })

    const first = spawnTail(harness.baseUrl, [created.sessionId, '--max-events', '1'])
    await waitForTailOutput(first.tail, first.getOutput, 'Tailing TailTarget')
    await harness.resumeSession(created.sessionId, { message: 'tail trigger' })
    const firstExit = await waitForTailExit(first.tail, first.getOutput)
    assert.equal(firstExit, 0)
    assert.match(first.getOutput(), /session\.resumed|session\.finished/)
  } finally {
    await harness.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('tail printer counts a streamed assistant reply as one event', async () => {
  const { createTailEventPrinter } = await import('../../scripts/orrery-cli.mjs')
  const streamDelta = (text) => ({
    type: 'provider.runtime',
    sessionId: 'session-a',
    providerEvent: {
      type: 'content.delta',
      streamKind: 'assistant_text',
      text,
    },
  })
  const lineEvent = (type) => ({ type, sessionId: 'session-a' })

  // The reviewer scenario: assistant output arrives purely as content.delta
  // (SDK/Codex paths). With --max-events 1 the stream claims the only slot,
  // prints in full, and the segment close stops the tail.
  {
    const writes = []
    let stopped = 0
    const printer = createTailEventPrinter({
      sessionId: 'session-a',
      eventLimit: 1,
      write: (text) => writes.push(text),
      stop: () => {
        stopped += 1
      },
    })
    printer.handle(streamDelta('unbounded '))
    printer.handle(streamDelta('assistant '))
    printer.handle(streamDelta('stream'))
    printer.handle(lineEvent('turn.completed'))
    printer.handle(lineEvent('session.finished'))
    assert.equal(writes.join(''), 'unbounded assistant stream\n')
    assert.equal(stopped >= 1, true, 'segment close must stop the tail')
  }

  // Limit 2: one line event + one full stream, nothing after the close.
  {
    const writes = []
    let stopped = 0
    const printer = createTailEventPrinter({
      sessionId: 'session-a',
      eventLimit: 2,
      write: (text) => writes.push(text),
      stop: () => {
        stopped += 1
      },
    })
    printer.handle(lineEvent('session.resumed'))
    printer.handle(streamDelta('hello '))
    printer.handle(streamDelta('world'))
    printer.handle(lineEvent('session.finished'))
    printer.handle(streamDelta('must not print'))
    const output = writes.join('')
    assert.match(output, /session\.resumed/)
    assert.match(output, /hello world\n/)
    assert.doesNotMatch(output, /session\.finished/)
    assert.doesNotMatch(output, /must not print/)
    assert.equal(stopped >= 1, true)
  }

  // Limit reached by a line event: buffered same-chunk stream deltas and
  // lines must all be suppressed.
  {
    const writes = []
    const printer = createTailEventPrinter({
      sessionId: 'session-a',
      eventLimit: 1,
      write: (text) => writes.push(text),
      stop: () => {},
    })
    printer.handle(lineEvent('session.resumed'))
    printer.handle(streamDelta('suppressed'))
    printer.handle(lineEvent('session.finished'))
    assert.equal(writes.join(''), '[session-] session.resumed\n')
    assert.doesNotMatch(writes.join(''), /suppressed|session\.finished/)
  }

  // Other sessions' events never consume the budget.
  {
    const writes = []
    const printer = createTailEventPrinter({
      sessionId: 'session-a',
      eventLimit: 1,
      write: (text) => writes.push(text),
      stop: () => {},
    })
    printer.handle({ type: 'session.resumed', sessionId: 'session-b' })
    printer.handle(lineEvent('session.resumed'))
    assert.match(writes.join(''), /session\.resumed/)
    assert.equal(writes.length, 1)
  }

  // flush terminates a dangling stream segment.
  {
    const writes = []
    const printer = createTailEventPrinter({
      sessionId: 'session-a',
      eventLimit: undefined,
      write: (text) => writes.push(text),
      stop: () => {},
    })
    printer.handle(streamDelta('dangling'))
    printer.flush()
    assert.equal(writes.join(''), 'dangling\n')
  }
})

test('debug CLI reports an unreachable runtime clearly', async () => {
  const result = await runCli('http://127.0.0.1:9', ['sessions'], {
    expectFailure: true,
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Cannot reach the runtime server/)
})
