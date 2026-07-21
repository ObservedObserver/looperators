import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  grokPermissionCancelled,
  grokQuestionCancelled,
  grokRecoveryCapabilities,
  permissionProbeResponse,
  questionProbeResponse,
  selectGrokRecoveryMethod,
  selectPermissionOption,
} from '../../scripts/grok-acp-probe.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureFile = path.join(
  repoRoot,
  'tests/runtime/fixtures/grok-acp-0.2.93-initialize.json',
)
const observedFixtureFile = path.join(
  repoRoot,
  'tests/runtime/fixtures/grok-acp-0.2.93-observed.json',
)
const wireFixtureFile = path.join(
  repoRoot,
  'tests/runtime/fixtures/grok-acp-0.2.93-wire.json',
)
const fakeAgentFile = path.join(
  repoRoot,
  'tests/runtime/fixtures/fake-grok-probe-agent.mjs',
)
const cliHelpFixtureFile = path.join(
  repoRoot,
  'tests/runtime/fixtures/grok-cli-0.2.93-help.txt',
)
const probeFile = path.join(repoRoot, 'scripts/grok-acp-probe.mjs')
const execFileAsync = promisify(execFile)

async function runFakeProbe(scenario, extraArgs = [], timeoutMs = 6_000) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-probe-test-'))
  const captureFile = path.join(cwd, 'capture.ndjson')
  const startedAt = performance.now()
  const result = await execFileAsync(
    process.execPath,
    [
      probeFile,
      '--binary',
      fakeAgentFile,
      '--cwd',
      cwd,
      '--timeout',
      scenario === 'timeout' ? '100' : '1000',
      ...(!extraArgs.includes('--idle-gap') ? ['--idle-gap', '20'] : []),
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        FAKE_GROK_SCENARIO: scenario,
        FAKE_GROK_CAPTURE: captureFile,
      },
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  )
  return {
    ...result,
    durationMs: performance.now() - startedAt,
    capture: fs.existsSync(captureFile)
      ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [],
  }
}

test('pinned Grok initialize fixture requires load and does not advertise unstable resume', () => {
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
  assert.equal(fixture.grokVersion, '0.2.93')
  assert.deepEqual(grokRecoveryCapabilities(fixture.initializeResult), {
    load: true,
    resume: false,
  })
  assert.equal(selectGrokRecoveryMethod(fixture.initializeResult), 'session/load')
  assert.deepEqual(fixture.initializeRequest.params.clientCapabilities.fs, {
    readTextFile: false,
    writeTextFile: false,
  })
})

test('pinned CLI help proves the stdio entry point and launch capabilities', () => {
  const help = fs.readFileSync(cliHelpFixtureFile, 'utf8')
  assert.match(help, /grok 0\.2\.93/)
  assert.match(help, /stdio\s+Run the agent over stdio/)
  assert.match(help, /--reasoning-effort <EFFORT>/)
})

test('unstable resume is selected only when the capability is explicitly present', () => {
  const initialize = {
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
    },
  }
  assert.equal(selectGrokRecoveryMethod(initialize), 'session/resume')
})

test('permission selection never crosses the user decision direction', () => {
  const options = [
    { optionId: 'reject', kind: 'reject_once' },
    { optionId: 'allow', kind: 'allow_once' },
  ]
  assert.equal(selectPermissionOption(options, 'allow'), 'allow')
  assert.equal(selectPermissionOption(options, 'reject'), 'reject')
  assert.deepEqual(permissionProbeResponse({ options }), grokPermissionCancelled)
  assert.deepEqual(permissionProbeResponse({ options }, true), {
    outcome: { outcome: 'selected', optionId: 'allow' },
  })
  assert.deepEqual(permissionProbeResponse({ options: [options[0]] }, true), grokPermissionCancelled)
})

test('permission and ask-user-question cancellation shapes stay intentionally different', () => {
  assert.deepEqual(grokPermissionCancelled, { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(grokQuestionCancelled, { outcome: 'cancelled' })
})

test('probe answers structured questions without inventing an unseen option', () => {
  assert.deepEqual(
    questionProbeResponse(
      {
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      true,
    ),
    { outcome: 'accepted', answers: { 'Continue?': ['Yes'] } },
  )
  assert.deepEqual(
    questionProbeResponse({ questions: [{ question: 'Continue?', options: [] }] }),
    grokQuestionCancelled,
  )
  assert.deepEqual(questionProbeResponse({ questions: [] }, true), grokQuestionCancelled)
})

test('real wire fixture contains auditable new/load/replay/completion/tool/question envelopes', () => {
  const fixture = JSON.parse(fs.readFileSync(wireFixtureFile, 'utf8'))
  const messages = fixture.messages.map((entry) => entry.message)
  assert.ok(messages.some((message) => message.method === 'authenticate'))
  assert.ok(messages.some((message) => message.method === 'session/new'))
  assert.ok(messages.some((message) => message.method === 'session/load'))
  assert.ok(messages.some((message) => message.method === 'session/set_model'))
  assert.ok(
    messages.some(
      (message) =>
        message.method === 'session/update' &&
        message.params?._meta?.isReplay === true &&
        message.params?.update?.sessionUpdate === 'agent_message_chunk',
    ),
  )
  assert.ok(
    messages.some(
      (message) =>
        message.method === 'session/update' &&
        message.params?.update?.sessionUpdate === 'tool_call_update' &&
        message.params?.update?.status === 'completed',
    ),
  )
  assert.ok(
    messages.some(
      (message) =>
        message.method === 'session/update' &&
        message.params?.update?.sessionUpdate === 'tool_call' &&
        message.params?.update?._meta?.['x.ai/tool']?.read_only === false,
    ),
  )
  const privateCompletion = messages.find(
    (message) => message.method === '_x.ai/session/prompt_complete',
  )
  const standardCompletion = messages.find(
    (message) => message.id === 4 && message.result?.stopReason === 'end_turn',
  )
  assert.equal(privateCompletion.params.promptId, '$PROMPT_ID_1')
  assert.equal(standardCompletion.result._meta.promptId, '$PROMPT_ID_1')
  const question = messages.find(
    (message) => message.method === '_x.ai/ask_user_question',
  )
  const questionResponse = messages.find(
    (message) => message.id === question.id && message.result?.outcome === 'accepted',
  )
  assert.equal(question.params.questions[0].multiSelect, null)
  assert.deepEqual(questionResponse.result.answers, {
    'Which option do you prefer?': ['Alpha'],
  })
  assert.deepEqual(questionProbeResponse(question.params, true), questionResponse.result)
})

test('committed Grok fixtures contain placeholders instead of local identifiers or secrets', () => {
  const forbiddenKeys = new Set([
    'agentId',
    'agentInstanceId',
    'hostname',
    'team_id',
    'email',
  ])
  const inspect = (value, key = '') => {
    if (forbiddenKeys.has(key)) assert.fail(`forbidden fixture key: ${key}`)
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /\/Users\//)
      assert.doesNotMatch(value, /\/private\/tmp\//)
      assert.doesNotMatch(value, /\/tmp\/orrery-grok-/)
      assert.doesNotMatch(value, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      assert.doesNotMatch(value, /XAI_API_KEY=/)
      if (key === 'sessionId' || key === 'promptId' || key === 'requestId') {
        assert.match(value, /^\$/)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry)
      return
    }
    if (value && typeof value === 'object') {
      for (const [entryKey, entryValue] of Object.entries(value)) {
        inspect(entryValue, entryKey)
      }
    }
  }

  for (const file of [fixtureFile, observedFixtureFile, wireFixtureFile]) {
    const raw = fs.readFileSync(file, 'utf8')
    inspect(JSON.parse(raw))
  }
})

test('committed Grok delivery surfaces contain no personal absolute user path', () => {
  const files = [
    path.join(repoRoot, 'scripts/grok-acp-probe.mjs'),
    path.join(repoRoot, 'scripts/grok-interaction-smoke.mjs'),
    path.join(repoRoot, 'scripts/grok-membrane-smoke.mjs'),
    path.join(repoRoot, 'README.md'),
  ]
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/Users\/[A-Za-z0-9._-]+\//)
  }
})

test('probe transport handles malformed frames, server requests, correlation, and completion', async () => {
  const run = await runFakeProbe('malformed', [
    '--prompt',
    'hello',
    '--answer-questions',
  ])
  const result = JSON.parse(run.stdout)
  assert.equal(result.promptResponse.stopReason, 'end_turn')
  assert.ok(result.notificationMethods.includes('_x.ai/session/prompt_complete'))
  const permissionResponse = run.capture.find(
    (message) => message.id === 91 && message.result,
  )
  assert.deepEqual(permissionResponse.result, grokPermissionCancelled)
  const questionResponse = run.capture.find(
    (message) => message.id === 92 && message.result,
  )
  assert.deepEqual(questionResponse.result, {
    outcome: 'accepted',
    answers: { 'Continue?': ['Yes'] },
  })
})

test('probe cancels structured questions unless answering is explicitly enabled', async () => {
  const run = await runFakeProbe('happy', ['--prompt', 'hello'])
  const response = run.capture.find((message) => message.id === 92 && message.result)
  assert.deepEqual(response.result, grokQuestionCancelled)
})

test('probe keeps both late completion orderings inside the settle window', async () => {
  for (const scenario of ['late-private', 'late-response']) {
    const run = await runFakeProbe(scenario, [
      '--prompt',
      'hello',
      '--answer-questions',
      '--idle-gap',
      '120',
    ])
    const result = JSON.parse(run.stdout)
    assert.equal(result.promptResponse.stopReason, 'end_turn')
    assert.ok(
      result.notificationMethods.includes('_x.ai/session/prompt_complete'),
      `${scenario} lost private completion`,
    )
  }
})

test('probe captures replay that arrives after the load response', async () => {
  const run = await runFakeProbe('late-replay', [
    '--session-id',
    'fake-grok-session',
    '--force-load',
    '--idle-gap',
    '120',
  ])
  const result = JSON.parse(run.stdout)
  assert.equal(result.setupMethod, 'session/load')
  assert.equal(result.setupReplay.count, 1)
  assert.deepEqual(result.setupReplay.updateKinds, ['agent_message_chunk'])
})

test('probe can explicitly exercise session/cancel', async () => {
  const run = await runFakeProbe('cancel', [
    '--prompt',
    'long task',
    '--cancel-after',
    '10',
  ])
  const result = JSON.parse(run.stdout)
  assert.equal(result.promptResponse.stopReason, 'cancelled')
  assert.ok(run.capture.some((message) => message.method === 'session/cancel'))
})

test('probe reports timeout and early child exit instead of hanging', async () => {
  await assert.rejects(runFakeProbe('timeout'), /timed out: initialize/)
  await assert.rejects(runFakeProbe('early-exit'), /closed with code 7/)
  await assert.rejects(runFakeProbe('exit-after-auth'), /closed|EPIPE/i)
})

test('probe escalates shutdown when the child ignores SIGTERM', async () => {
  const run = await runFakeProbe('ignore-term', [], 5_000)
  assert.ok(run.durationMs >= 1_800, `shutdown returned too early: ${run.durationMs}ms`)
  assert.ok(run.durationMs < 4_000, `shutdown took too long: ${run.durationMs}ms`)
})

test('human observation summary keeps explicit permission evidence boundary', () => {
  const fixture = JSON.parse(fs.readFileSync(observedFixtureFile, 'utf8'))
  assert.equal(fixture.permissionRequest.observed, false)
  assert.equal(fixture.permissionRequest.fixtureRequired, true)
  assert.equal(fixture.cancel.standardResponseStopReason, 'cancelled')
  assert.deepEqual(
    fixture.loadMeasurements.map((entry) => entry.replayUpdateCount),
    [10, 13, 16, 19, 22, 25, 28, 31],
  )
  assert.ok(
    fixture.loadMeasurements
      .filter((entry) => entry.processRssKb)
      .every((entry) => entry.processRssKb.afterSetup > 0),
  )
  assert.equal(fixture.modelSwitchBoundary.sameSessionAccepted, false)
})
