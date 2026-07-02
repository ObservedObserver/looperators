import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const runnerPath = path.resolve('scripts/acceptance-runner.mjs')

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

const passingScenario = `import assert from 'node:assert/strict'

export const name = 'runner-passing'
export const description = 'kernel-level runner machinery check'

export async function run({ orrery, provider, workDir, log }) {
  const created = await orrery.createSession({
    ...provider,
    label: 'Runner Pass',
    cwd: workDir,
    prompt: 'runner machinery prompt',
  })
  log('created ' + created.sessionId)
  await orrery.waitForIdle(created.sessionId, { timeoutMs: 10_000 })
  const transcript = await orrery.transcript(created.sessionId)
  assert.equal(
    transcript.messages.some((message) =>
      String(message.content).includes('runner machinery prompt')
    ),
    true
  )
}
`

const failingScenario = `export const name = 'runner-failing'
export const description = 'deliberately failing scenario'

export async function run() {
  throw new Error('deliberate scenario failure for the runner test')
}
`

async function runRunner(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [runnerPath, ...args],
      { timeout: 120_000, env: { ...process.env, ...env } }
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (error.killed || error.signal) {
      throw error
    }
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('acceptance runner persists artifacts and reports failures', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-acceptance-runner-'))
  const scenariosDir = path.join(tempRoot, 'scenarios')
  const outDir = path.join(tempRoot, 'out')
  fs.mkdirSync(scenariosDir, { recursive: true })
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  fs.writeFileSync(
    path.join(scenariosDir, 'passing.scenario.mjs'),
    passingScenario
  )
  fs.writeFileSync(
    path.join(scenariosDir, 'failing.scenario.mjs'),
    failingScenario
  )
  const env = { ORRERY_CLAUDE_BIN: fakeClaude }
  const baseArgs = [
    '--dir',
    scenariosDir,
    '--out',
    outDir,
    '--provider',
    'legacy-claude-cli',
    '--timeout',
    '30000',
  ]

  try {
    const listed = await runRunner([...baseArgs, '--list'], env)
    assert.equal(listed.code, 0)
    assert.match(listed.stdout, /runner-passing/)
    assert.match(listed.stdout, /runner-failing/)

    const full = await runRunner(baseArgs, env)
    assert.equal(full.code, 1, 'a failing scenario must fail the run')
    assert.match(full.stdout, /PASS {2}runner-passing/)
    assert.match(full.stdout, /FAIL {2}runner-failing/)

    const runDirs = fs.readdirSync(outDir)
    assert.equal(runDirs.length, 1)
    const runDir = path.join(outDir, runDirs[0])

    const summary = JSON.parse(
      fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8')
    )
    assert.equal(summary.results.length, 2)
    assert.equal(summary.results.find((r) => r.name === 'runner-passing').ok, true)
    assert.equal(summary.results.find((r) => r.name === 'runner-failing').ok, false)

    const passDir = path.join(runDir, 'runner-passing')
    const passResult = JSON.parse(
      fs.readFileSync(path.join(passDir, 'result.json'), 'utf8')
    )
    assert.equal(passResult.ok, true)
    const passState = JSON.parse(
      fs.readFileSync(path.join(passDir, 'graph-state.json'), 'utf8')
    )
    assert.equal(Object.keys(passState.sessions).length, 1)
    const transcriptDumps = fs
      .readdirSync(passDir)
      .filter((file) => file.startsWith('transcript-'))
    assert.equal(transcriptDumps.length, 1)
    const events = fs
      .readFileSync(path.join(passDir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(events.length > 0, true)
    assert.equal(
      events.every((event) => event.state === undefined),
      true,
      'persisted events must strip the embedded graph state'
    )
    assert.equal(
      events.some((event) => event.type === 'session.created'),
      true
    )

    const failResult = JSON.parse(
      fs.readFileSync(path.join(runDir, 'runner-failing', 'result.json'), 'utf8')
    )
    assert.equal(failResult.ok, false)
    assert.match(failResult.error, /deliberate scenario failure/)

    const filtered = await runRunner([...baseArgs, '--filter', 'passing'], env)
    assert.equal(filtered.code, 0, 'filtered run with only passing scenarios must exit 0')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
