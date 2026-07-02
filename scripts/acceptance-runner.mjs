#!/usr/bin/env node
// Real-scenario acceptance runner. Discovers tests/acceptance/*.scenario.mjs,
// runs each against a fresh isolated runtime with REAL providers on the cheap
// model preset, and persists artifacts (per-session transcripts, final graph
// state, event timeline, result) under output/acceptance/<run-id>/ so failed
// minute-scale runs can be diagnosed without re-running.
//
//   npm run acceptance:headless
//   npm run acceptance:headless -- --filter linked-chat
//   node scripts/acceptance-runner.mjs --list
//
// This is the real-scenario tier of the test taxonomy: provider fakes are
// deliberately unsupported here — kernel logic belongs in test:kernel:*.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { OrreryHarness } from './lib/orrery-client.mjs'
import { modelPresets } from './lib/model-presets.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultScenarioDir = path.join(repoRoot, 'tests', 'acceptance')
const defaultOutDir = path.join(repoRoot, 'output', 'acceptance')
const defaultScenarioTimeoutMs = 600_000

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(exitCode)
}

function shortId(id) {
  return String(id ?? '').slice(0, 8)
}

// Broadcast events embed the full graph state; the timeline only needs the
// event identity, so strip the heavy payload before persisting.
function slimEvent(event) {
  const { state: _state, ...rest } = event
  return rest
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Scenario timed out after ${timeoutMs}ms: ${label}`)),
      timeoutMs
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function discoverScenarios(dir, filter) {
  if (!fs.existsSync(dir)) {
    fail(`Scenario directory not found: ${dir}`, 2)
  }
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.scenario.mjs'))
    .sort()
  const scenarios = []
  const seenNames = new Set()
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dir, file)).href)
    if (typeof module.run !== 'function' || typeof module.name !== 'string') {
      fail(`Scenario ${file} must export a string \`name\` and an async \`run(ctx)\``, 2)
    }
    // The name becomes an artifact directory segment; keep it path-safe and
    // unique so scenarios cannot clobber (or escape) each other's artifacts.
    if (!/^[A-Za-z0-9_-]+$/.test(module.name)) {
      fail(`Scenario ${file} name "${module.name}" must match [A-Za-z0-9_-]+`, 2)
    }
    if (seenNames.has(module.name)) {
      fail(`Duplicate scenario name "${module.name}" (${file})`, 2)
    }
    seenNames.add(module.name)
    scenarios.push({
      file,
      name: module.name,
      description: module.description ?? '',
      timeoutMs: module.timeoutMs,
      run: module.run,
    })
  }
  return filter
    ? scenarios.filter((scenario) => scenario.name.includes(filter))
    : scenarios
}

async function preflight(providerKind) {
  const harness = await OrreryHarness.start({})
  try {
    const status = await harness.providerSetupStatus({ providerKind })
    const errors = (status.checks ?? []).filter((check) => check.status === 'error')
    return { checks: status.checks ?? [], errors }
  } finally {
    await harness.close()
  }
}

async function dumpArtifacts(harness, scenarioDir, log) {
  try {
    const state = await harness.state()
    fs.writeFileSync(
      path.join(scenarioDir, 'graph-state.json'),
      JSON.stringify(state, null, 2)
    )
    for (const sessionId of Object.keys(state.sessions ?? {})) {
      try {
        const projection = await harness.transcript(sessionId)
        fs.writeFileSync(
          path.join(scenarioDir, `transcript-${sessionId}.json`),
          JSON.stringify(projection, null, 2)
        )
      } catch (error) {
        log(`transcript dump failed for ${shortId(sessionId)}: ${error.message}`)
      }
    }
  } catch (error) {
    log(`artifact dump failed: ${error.message}`)
  }
}

async function runScenario(scenario, config) {
  const scenarioDir = path.join(config.runDir, scenario.name)
  fs.mkdirSync(scenarioDir, { recursive: true })
  // The workspace must live OUTSIDE the repo tree: real agents run git from
  // their cwd, and a workspace under output/ would hand them the host repo's
  // working tree (the loop reviewer would literally review this repo's
  // uncommitted diff). Left on disk after the run for diagnosis.
  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `orrery-acceptance-${scenario.name}-`)
  )

  const log = (message) =>
    process.stdout.write(`[${scenario.name}] ${message}\n`)

  const startedAt = Date.now()
  let harness
  try {
    harness = await OrreryHarness.start({ modelPreset: config.preset })
  } catch (error) {
    // A harness that fails to start must not discard the results of the
    // scenarios that already spent real-model minutes before it.
    const result = {
      name: scenario.name,
      description: scenario.description,
      ok: false,
      durationMs: Date.now() - startedAt,
      workDir,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    fs.writeFileSync(
      path.join(scenarioDir, 'result.json'),
      JSON.stringify(result, null, 2)
    )
    log(`FAILED: runtime harness did not start: ${result.error.split('\n')[0]}`)
    return result
  }

  const eventLog = fs.createWriteStream(path.join(scenarioDir, 'events.jsonl'))
  eventLog.on('error', (error) => {
    log(`event log write error: ${error.message}`)
  })
  const subscription = harness.subscribeEvents((event) => {
    eventLog.write(`${JSON.stringify(slimEvent(event))}\n`)
  })
  subscription.done.catch((error) => {
    if (error?.name !== 'AbortError') {
      log(`event capture dropped: ${error.message}`)
    }
  })

  let ok = false
  let errorDetail
  try {
    // done rejects when the SSE connection fails outright; racing it keeps a
    // dead stream from hanging the whole run before the timeout even starts.
    await Promise.race([subscription.ready, subscription.done])
    await withTimeout(
      scenario.run({
        orrery: harness,
        provider: { providerKind: config.providerKind },
        modelPreset: harness.modelPreset,
        workDir,
        artifactsDir: scenarioDir,
        timeoutMs: scenario.timeoutMs ?? config.timeoutMs,
        log,
      }),
      scenario.timeoutMs ?? config.timeoutMs,
      scenario.name
    )
    ok = true
    log('passed')
  } catch (error) {
    errorDetail =
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await dumpArtifacts(harness, scenarioDir, log)
    subscription.stop()
    await new Promise((resolve) => eventLog.end(resolve))
    await harness.close()
  }

  const result = {
    name: scenario.name,
    description: scenario.description,
    ok,
    durationMs: Date.now() - startedAt,
    workDir,
    ...(errorDetail ? { error: errorDetail } : {}),
  }
  fs.writeFileSync(
    path.join(scenarioDir, 'result.json'),
    JSON.stringify(result, null, 2)
  )
  return result
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      filter: { type: 'string' },
      dir: { type: 'string' },
      out: { type: 'string' },
      provider: { type: 'string' },
      preset: { type: 'string' },
      timeout: { type: 'string' },
      list: { type: 'boolean' },
      'skip-preflight': { type: 'boolean' },
    },
  })

  const scenarioDir = values.dir ? path.resolve(values.dir) : defaultScenarioDir
  const outDir = values.out ? path.resolve(values.out) : defaultOutDir
  const providerKind = values.provider ?? 'claude-code'
  const validProviders = ['claude-code', 'codex', 'legacy-claude-cli']
  if (!validProviders.includes(providerKind)) {
    // Preflight and session creation both silently fall back to the legacy
    // provider (with no cheap-preset entry) for unknown kinds — a typo would
    // burn default-model sessions without any error.
    fail(`--provider must be one of: ${validProviders.join(', ')}`, 2)
  }
  const preset = values.preset ?? 'cheap'
  if (!Object.hasOwn(modelPresets, preset)) {
    // The harness would only reject the name after spawning a runtime child
    // per scenario; fail at parse time like --provider.
    fail(
      `--preset must be one of: ${Object.keys(modelPresets).join(', ')}`,
      2
    )
  }
  const timeoutMs = values.timeout ? Number(values.timeout) : defaultScenarioTimeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    fail(`--timeout must be a positive integer, got "${values.timeout}"`, 2)
  }

  const scenarios = await discoverScenarios(scenarioDir, values.filter)
  if (values.list) {
    for (const scenario of scenarios) {
      process.stdout.write(`${scenario.name}  ${scenario.description}\n`)
    }
    return
  }
  if (scenarios.length === 0) {
    fail(
      values.filter
        ? `No scenario matches --filter ${values.filter}`
        : `No *.scenario.mjs files in ${scenarioDir}`,
      2
    )
  }

  if (!values['skip-preflight']) {
    const { checks, errors } = await preflight(providerKind)
    for (const check of checks) {
      process.stdout.write(
        `[preflight] ${check.status === 'ok' ? 'ok ' : check.status} ${check.label}: ${check.message}\n`
      )
    }
    if (errors.length > 0) {
      fail(
        `Provider ${providerKind} is not ready for real acceptance runs (see checks above).`
      )
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = path.join(outDir, runId)
  fs.mkdirSync(runDir, { recursive: true })
  process.stdout.write(
    `Running ${scenarios.length} scenario(s) with provider=${providerKind} preset=${preset}\nArtifacts: ${runDir}\n\n`
  )

  const config = { runDir, providerKind, preset, timeoutMs }
  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, config))
  }

  const summary = {
    runId,
    providerKind,
    preset,
    startedAt: runId,
    results,
  }
  fs.writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  )

  const failed = results.filter((result) => !result.ok)
  process.stdout.write('\n')
  for (const result of results) {
    process.stdout.write(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${Math.round(result.durationMs / 1000)}s)\n`
    )
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} scenarios passed. Artifacts: ${runDir}\n`)
  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
