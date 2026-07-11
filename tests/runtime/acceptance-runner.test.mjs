import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const runnerPath = path.resolve('scripts/acceptance-runner.mjs')

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

const grokOnlyScenario = `export const name = 'runner-grok-only'
export const description = 'provider-specific discovery check'
export const providers = ['grok']
export async function run() {}
`

const timeoutCleanupScenario = `import { spawn } from 'node:child_process'
import fs from 'node:fs'

export const name = 'runner-timeout-cleanup'
export const description = 'abort signal terminates scenario-owned child process'

export async function run({ workDir, signal }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  fs.writeFileSync(workDir + '/child.pid', String(child.pid))
  await new Promise((resolve) => {
    child.once('exit', () => {
      fs.writeFileSync(workDir + '/child-exited', 'yes')
      resolve()
    })
    signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
  })
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
  fs.writeFileSync(
    path.join(scenariosDir, 'passing.scenario.mjs'),
    passingScenario
  )
  fs.writeFileSync(
    path.join(scenariosDir, 'failing.scenario.mjs'),
    failingScenario
  )
  fs.writeFileSync(
    path.join(scenariosDir, 'grok-only.scenario.mjs'),
    grokOnlyScenario
  )
  const env = {
    ORRERY_RUNTIME_CLI_PATH: path.resolve('tests/runtime/support/deterministic-runtime-cli.mjs'),
  }
  const baseArgs = [
    '--dir',
    scenariosDir,
    '--out',
    outDir,
    '--provider',
    'claude-code',
    '--timeout',
    '30000',
  ]

  try {
    const listed = await runRunner([...baseArgs, '--list'], env)
    assert.equal(listed.code, 0)
    assert.match(listed.stdout, /runner-passing/)
    assert.match(listed.stdout, /runner-failing/)
    assert.doesNotMatch(listed.stdout, /runner-grok-only/)

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

    const badPreset = await runRunner([...baseArgs, '--preset', 'no-such-preset'], env)
    assert.equal(badPreset.code, 2, 'unknown preset must fail before spawning runtimes')
    assert.match(badPreset.stderr, /--preset must be one of/)

    const coveredGrokPreset = await runRunner(
      [...baseArgs, '--provider', 'grok', '--list'],
      env
    )
    assert.equal(coveredGrokPreset.code, 0)
    assert.match(coveredGrokPreset.stdout, /runner-passing/)
    assert.match(coveredGrokPreset.stdout, /runner-grok-only/)

    const timeoutScenariosDir = path.join(tempRoot, 'timeout-scenarios')
    const timeoutOutDir = path.join(tempRoot, 'timeout-out')
    fs.mkdirSync(timeoutScenariosDir)
    fs.writeFileSync(
      path.join(timeoutScenariosDir, 'timeout.scenario.mjs'),
      timeoutCleanupScenario
    )
    const timedOut = await runRunner(
      [
        '--dir',
        timeoutScenariosDir,
        '--out',
        timeoutOutDir,
        '--provider',
        'claude-code',
        '--timeout',
        '100',
        '--skip-preflight',
      ],
      env
    )
    assert.equal(timedOut.code, 1)
    assert.match(timedOut.stdout, /Scenario timed out after 100ms/)
    const timeoutRunDir = path.join(timeoutOutDir, fs.readdirSync(timeoutOutDir)[0])
    const timeoutResult = JSON.parse(
      fs.readFileSync(
        path.join(timeoutRunDir, 'runner-timeout-cleanup', 'result.json'),
        'utf8'
      )
    )
    assert.equal(timeoutResult.ok, false)
    assert.equal(
      fs.readFileSync(path.join(timeoutResult.workDir, 'child-exited'), 'utf8'),
      'yes'
    )
    const childPid = Number(
      fs.readFileSync(path.join(timeoutResult.workDir, 'child.pid'), 'utf8')
    )
    assert.throws(() => process.kill(childPid, 0), /ESRCH/)
    fs.rmSync(timeoutResult.workDir, { recursive: true, force: true })
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
