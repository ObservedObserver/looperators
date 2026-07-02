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

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
emit({
  type: 'assistant',
  session_id: backendSessionId,
  message: { content: [{ type: 'text', text: 'fake response for ' + backendSessionId }] },
})
emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
`

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
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  const harness = await OrreryHarness.start({
    env: { ORRERY_CLAUDE_BIN: fakeClaude },
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
    assert.match(created.stdout, /fake response/)

    const list = await runCli(base, ['sessions'])
    assert.match(list.stdout, /CliSmoke/)
    assert.match(list.stdout, /idle/)

    const shortPrefix = sessionId.slice(0, 8)
    const shown = await runCli(base, ['session', 'show', shortPrefix])
    assert.match(shown.stdout, /CliSmoke/)
    assert.match(shown.stdout, /model: cli-test-model/)
    assert.match(shown.stdout, /cli smoke prompt/)
    assert.match(shown.stdout, /fake response/)

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

test('debug CLI tail follows live events after its ready signal', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-cli-tail-test-'))
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  const harness = await OrreryHarness.start({
    env: { ORRERY_CLAUDE_BIN: fakeClaude },
  })

  try {
    const created = await harness.createSession({
      prompt: 'tail target session',
      label: 'TailTarget',
      cwd: process.cwd(),
    })
    await harness.waitForIdle(created.sessionId, { timeoutMs: 10_000 })

    const tail = spawn(process.execPath, [
      cliPath,
      '--url',
      harness.baseUrl,
      'session',
      'tail',
      created.sessionId,
      '--max-events',
      '1',
    ])
    let output = ''
    tail.stdout.on('data', (chunk) => {
      output += String(chunk)
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(probe)
        tail.kill('SIGKILL')
        reject(new Error(`tail header never appeared: ${output}`))
      }, 10_000)
      const probe = setInterval(() => {
        if (output.includes('Tailing TailTarget')) {
          clearTimeout(timer)
          clearInterval(probe)
          resolve()
        }
      }, 50)
    })

    await harness.resumeSession(created.sessionId, { message: 'tail trigger' })

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tail.kill('SIGKILL')
        reject(new Error(`tail did not exit after event: ${output}`))
      }, 10_000)
      tail.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    assert.equal(exitCode, 0)
    assert.match(output, /session\.resumed|session\.finished/)
  } finally {
    await harness.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('debug CLI reports an unreachable runtime clearly', async () => {
  const result = await runCli('http://127.0.0.1:9', ['sessions'], {
    expectFailure: true,
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Cannot reach the runtime server/)
})
