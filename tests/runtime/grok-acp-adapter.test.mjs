import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  GrokAcpAdapter,
  grokPermissionResponseForDecision,
  grokQuestionResponseForAnswer,
} from '../../dist-electron/electron/runtime/providers/grokAcpAdapter.js'
import {
  clearGrokProbeCacheForTest,
  expireGrokReadinessCacheForTest,
  probeGrokProvider,
} from '../../dist-electron/electron/runtime/providers/grokAcpProbeService.js'

const fakeGrok = path.resolve('tests/runtime/fixtures/fake-grok-agent.mjs')

function startRun(tempRoot, scenario = 'normal', overrides = {}) {
  const logFile = path.join(tempRoot, `${scenario}-${Math.random()}.jsonl`)
  const adapter = new GrokAcpAdapter({
    timeouts: {
      initializeMs: 1000,
      setupMs: 1000,
      promptMs: 1000,
      replayIdleMs: 40,
      closeGraceMs: 80,
      ...(overrides.timeouts ?? {}),
    },
  })
  const run = adapter.startTurn({
    prompt: 'hello grok',
    cwd: tempRoot,
    sessionId: overrides.sessionId ?? 'orrery-session',
    turnId: overrides.turnId ?? 'orrery-turn',
    runtimeSettings: overrides.runtimeSettings ?? {
      runtimeMode: 'approval-required',
      reasoningEffort: 'low',
    },
    attachments: overrides.attachments ?? [],
    backendSessionId: overrides.backendSessionId,
    membrane: overrides.membrane,
    providerInstance: {
      providerInstanceId: 'default-grok',
      kind: 'grok',
      label: 'Grok Build',
      binaryPath: fakeGrok,
      env: {
        FAKE_GROK_SCENARIO: scenario,
        FAKE_GROK_LOG: logFile,
      },
    },
  })
  return { adapter, run, logFile }
}

function capture(run) {
  const captured = {
    native: [],
    providerEvents: [],
    providerSessions: [],
    results: [],
    errors: [],
    closes: [],
  }
  run.on('native', (event) => captured.native.push(event))
  run.on('providerEvent', (event) => captured.providerEvents.push(event))
  run.on('providerSession', (event) => captured.providerSessions.push(event))
  run.on('result', (event) => captured.results.push(event))
  run.on('error', (error) => captured.errors.push(error))
  run.on('close', (event) => captured.closes.push(event))
  return captured
}

function waitForClose(run) {
  return new Promise((resolve) => run.once('close', resolve))
}

function wire(logFile) {
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
}

test('Grok adapter runs initialize/auth/new/prompt and emits canonical output', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-adapter-'))
  const { run, logFile } = startRun(tempRoot)
  const captured = capture(run)
  try {
    const close = await waitForClose(run)
    assert.equal(close.code, 0)
    assert.equal(captured.errors.length, 0)
    assert.equal(captured.results.length, 1)
    assert.equal(captured.providerSessions[0].providerSessionId, 'fake-grok-session')
    assert.deepEqual(JSON.parse(captured.providerSessions[0].resumeCursor), {
      version: 1,
      method: 'session/load',
      sessionId: 'fake-grok-session',
    })
    assert.equal(
      captured.providerEvents.filter((event) => event.type === 'content.delta')[0].text,
      'FAKE_GROK_TEXT'
    )
    assert.ok(captured.native.some((event) => event.raw.source === 'grok.acp.response'))
    const messages = wire(logFile)
    assert.deepEqual(
      messages.filter((message) => message.method).map((message) => message.method),
      ['initialize', 'authenticate', 'session/new', 'session/prompt']
    )
    assert.equal(messages[0].startup.referrer, 'orrery')
    assert.deepEqual(messages[0].startup.argv, [
      'agent',
      '--reasoning-effort',
      'low',
      'stdio',
    ])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok native auto mode is applied as a global CLI permission mode', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-auto-mode-'))
  const { run, logFile } = startRun(tempRoot, 'normal', {
    runtimeSettings: { runtimeMode: 'auto', reasoningEffort: 'low' },
  })
  const captured = capture(run)
  try {
    await waitForClose(run)
    assert.equal(captured.errors.length, 0)
    assert.deepEqual(wire(logFile)[0].startup.argv, [
      '--permission-mode',
      'auto',
      'agent',
      '--reasoning-effort',
      'low',
      'stdio',
    ])
    const configured = captured.providerEvents.find(
      (event) => event.type === 'runtime.configured',
    )
    assert.equal(configured.effectiveRuntimeConfig.modeLabel, 'Auto')
    assert.equal(
      configured.effectiveRuntimeConfig.native.permissionPolicy,
      'provider-auto',
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok adapter cold-loads and suppresses late replay projection', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-load-'))
  const { run, logFile } = startRun(tempRoot, 'delayed-load-late-replay', {
    backendSessionId: 'persisted-grok-session',
    turnId: 'turn-2',
  })
  const captured = capture(run)
  try {
    await waitForClose(run)
    assert.equal(captured.errors.length, 0)
    const deltas = captured.providerEvents.filter((event) => event.type === 'content.delta')
    assert.deepEqual(deltas.map((event) => event.text), ['FAKE_GROK_TEXT'])
    assert.equal(captured.providerSessions[0].providerSessionId, 'persisted-grok-session')
    const messages = wire(logFile)
    assert.ok(messages.some((message) => message.method === 'session/load'))
    const replaySent = messages.find((message) => message.marker === 'replay-sent')
    const promptAfterReplay = messages.find(
      (message) => message.marker === 'prompt-after-replay',
    )
    assert.ok(replaySent)
    assert.ok(promptAfterReplay)
    assert.ok(
      promptAfterReplay.at - replaySent.at >= 35,
      `prompt waited only ${promptAfterReplay.at - replaySent.at}ms after replay`,
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

for (const scenario of ['private-only', 'duplicate-completion', 'delayed-exit']) {
  test(`Grok adapter settles ${scenario} exactly once`, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `orrery-grok-${scenario}-`))
    const { run } = startRun(tempRoot, scenario)
    const captured = capture(run)
    try {
      await waitForClose(run)
      assert.equal(captured.errors.length, 0)
      assert.equal(captured.results.length, 1)
      assert.equal(captured.closes.length, 1)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
}

for (const [scenario, settings, pattern] of [
  ['auth-fail', {}, /fake auth failed/],
  ['session-new-fail', {}, /fake session\/new failed/],
  ['set-model-fail', { model: 'other-model' }, /fake set_model failed/],
  ['prompt-fail', {}, /fake prompt failed/],
  ['early-exit', {}, /closed before response/],
]) {
  test(`Grok adapter closes cleanly after ${scenario}`, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `orrery-grok-${scenario}-`))
    const { run } = startRun(tempRoot, scenario, {
      runtimeSettings: { runtimeMode: 'approval-required', ...settings },
    })
    const captured = capture(run)
    try {
      const close = await waitForClose(run)
      assert.equal(close.code, 1)
      assert.equal(captured.errors.length, 1)
      assert.match(captured.errors[0].message, pattern)
      assert.equal(captured.closes.length, 1)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
}

test('Grok adapter kill sends session/cancel and closes as killed', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-kill-'))
  const { run, logFile } = startRun(tempRoot, 'hang')
  const captured = capture(run)
  try {
    await new Promise((resolve) => run.once('providerSession', resolve))
    assert.equal(run.kill(), true)
    assert.equal(run.kill(), false)
    const close = await waitForClose(run)
    assert.equal(close.killed, true)
    assert.equal(captured.errors.length, 0)
    assert.ok(wire(logFile).some((message) => message.method === 'session/cancel'))
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok adapter closeAll cancels and drains every active run', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-close-all-'))
  const { adapter, run, logFile } = startRun(tempRoot, 'hang')
  const captured = capture(run)
  try {
    await new Promise((resolve) => run.once('providerSession', resolve))
    adapter.closeAll()
    const close = await waitForClose(run)
    assert.equal(close.killed, true)
    assert.equal(captured.errors.length, 0)
    assert.equal(captured.closes.length, 1)
    assert.ok(wire(logFile).some((message) => message.method === 'session/cancel'))
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok adapter shares one setup deadline across initialize, auth, and session setup', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-setup-budget-'))
  const startedAt = Date.now()
  const { run } = startRun(tempRoot, 'slow-setup-budget', {
    timeouts: { initializeMs: 1000, setupMs: 800 },
  })
  const captured = capture(run)
  try {
    const close = await waitForClose(run)
    const elapsed = Date.now() - startedAt
    assert.equal(close.code, 1)
    assert.equal(captured.errors.length, 1)
    assert.match(captured.errors[0].message, /session\/new.*timed out|timed out.*session\/new/i)
    assert.ok(elapsed >= 700, `expected deadline near 800ms, got ${elapsed}ms`)
    assert.ok(elapsed < 1200, `setup phases exceeded shared deadline: ${elapsed}ms`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok adapter rejects unsupported recovery, effort, and image capability', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-capability-'))
  try {
    for (const [scenario, overrides, pattern] of [
      ['no-load', { backendSessionId: 'old-session' }, /does not support session\/load/],
      ['normal', { runtimeSettings: { reasoningEffort: 'xhigh' } }, /does not support xhigh/],
      [
        'normal',
        {
          attachments: [
            {
              kind: 'image',
              name: 'screen.png',
              mediaType: 'image/png',
              dataUrl: 'data:image/png;base64,aA==',
            },
          ],
        },
        /does not support image attachments/,
      ],
    ]) {
      const { run } = startRun(tempRoot, scenario, overrides)
      const captured = capture(run)
      await waitForClose(run)
      assert.equal(captured.errors.length, 1)
      assert.match(captured.errors[0].message, pattern)
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok permission decisions select only a same-direction wire option', () => {
  const message = {
    params: {
      options: [
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow-once', kind: 'allow_once' },
      ],
    },
  }
  assert.deepEqual(grokPermissionResponseForDecision(message, 'accept'), {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  })
  assert.deepEqual(grokPermissionResponseForDecision(message, 'acceptForSession'), {
    outcome: { outcome: 'cancelled' },
  })
  assert.deepEqual(grokPermissionResponseForDecision(message, 'decline'), {
    outcome: { outcome: 'selected', optionId: 'reject' },
  })
  assert.deepEqual(grokPermissionResponseForDecision(message, 'cancel'), {
    outcome: { outcome: 'cancelled' },
  })
})

test('Grok adapter routes permissions and structured questions through Orrery', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-interaction-'))
  const { run, logFile } = startRun(tempRoot, 'interaction-flow')
  const captured = capture(run)
  run.on('providerEvent', (event) => {
    if (event.type === 'request.opened') {
      run.respondRuntimeRequest({
        requestId: event.request.id,
        decision: 'acceptForSession',
      })
    }
    if (event.type === 'user-input.requested') {
      run.answerUserInput({
        requestId: event.request.id,
        answers: {
          choice: 'alpha-id',
          many: ['docs-id', 'custom note'],
        },
      })
    }
  })
  try {
    const close = await waitForClose(run)
    assert.equal(close.code, 0)
    assert.equal(captured.errors.length, 0)
    const messages = wire(logFile)
    assert.deepEqual(messages.find((message) => message.id === 910)?.result, {
      outcome: { outcome: 'selected', optionId: 'allow-session' },
    })
    assert.deepEqual(messages.find((message) => message.id === 911)?.result, {
      outcome: 'accepted',
      answers: {
        'Pick one': ['Alpha'],
        'Pick many': ['Docs', 'Other'],
      },
      annotations: {
        'Pick one': { preview: 'Alpha preview' },
        'Pick many': { notes: 'custom note' },
      },
    })
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok kill cancels a pending structured question before closing transport', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-question-kill-'))
  const { run, logFile } = startRun(tempRoot, 'interaction-flow')
  const captured = capture(run)
  run.on('providerEvent', (event) => {
    if (event.type === 'request.opened') {
      run.respondRuntimeRequest({ requestId: event.request.id, decision: 'accept' })
    }
    if (event.type === 'user-input.requested') run.kill()
  })
  try {
    const close = await waitForClose(run)
    assert.equal(close.killed, true)
    assert.equal(captured.errors.length, 0)
    assert.deepEqual(wire(logFile).find((message) => message.id === 911)?.result, {
      outcome: 'cancelled',
    })
    assert.ok(wire(logFile).some((message) => message.method === 'session/cancel'))
    assert.ok(
      captured.providerEvents.some(
        (event) => event.type === 'user-input.resolved' && event.status === 'canceled',
      ),
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

for (const [scenario, runtimeMode, expectedOption] of [
  ['full-access-permission', 'full-access', 'allow-session'],
  ['auto-edit-permission', 'auto-accept-edits', 'allow-once'],
]) {
  test(`Grok ${runtimeMode} conservatively auto-selects ${expectedOption}`, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `orrery-grok-${runtimeMode}-`))
    const { run, logFile } = startRun(tempRoot, scenario, {
      runtimeSettings: { runtimeMode },
    })
    const captured = capture(run)
    try {
      await waitForClose(run)
      assert.equal(captured.errors.length, 0)
      assert.equal(
        captured.providerEvents.filter((event) => event.type === 'request.opened').length,
        0,
      )
      assert.deepEqual(wire(logFile).find((message) => message.id === 910)?.result, {
        outcome: { outcome: 'selected', optionId: expectedOption },
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
}

test('Grok question encoding uses Other annotations without widening the common answer contract', () => {
  const message = {
    params: {
      questions: [
        {
          id: 'flavor',
          question: 'Flavor?',
          options: [{ id: 'vanilla-id', label: 'Vanilla' }],
        },
      ],
    },
  }
  assert.deepEqual(grokQuestionResponseForAnswer(message, undefined, { flavor: 'Pistachio' }), {
    outcome: 'accepted',
    answers: { 'Flavor?': ['Other'] },
    annotations: { 'Flavor?': { notes: 'Pistachio' } },
  })
})

test('Grok auto-accept-edits keeps non-edit tool kinds supervised', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-auto-execute-'))
  const { run, logFile } = startRun(tempRoot, 'auto-execute-permission', {
    runtimeSettings: { runtimeMode: 'auto-accept-edits' },
  })
  const captured = capture(run)
  run.on('providerEvent', (event) => {
    if (event.type === 'request.opened') {
      run.respondRuntimeRequest({ requestId: event.request.id, decision: 'decline' })
    }
  })
  try {
    await waitForClose(run)
    assert.equal(captured.errors.length, 0)
    assert.equal(
      captured.providerEvents.filter((event) => event.type === 'request.opened').length,
      1,
    )
    assert.deepEqual(wire(logFile).find((message) => message.id === 910)?.result, {
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    })
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok mounts the per-run membrane in ACP setup and guides only fresh sessions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-membrane-'))
  const { run, logFile } = startRun(tempRoot, 'normal', {
    membrane: { bridgeUrl: 'http://127.0.0.1:9999', token: 'membrane-token' },
  })
  try {
    await waitForClose(run)
    const messages = wire(logFile)
    const setup = messages.find((message) => message.method === 'session/new')
    const server = setup.params.mcpServers[0]
    assert.equal(server.type, 'stdio')
    assert.equal(server.name, 'orrery_membrane')
    assert.match(server.args[0], /membraneMcpServer\.js$/)
    assert.ok(Array.isArray(server.env))
    const bootstrap = server.env.find(
      (entry) => entry.name === 'ORRERY_MEMBRANE_BOOTSTRAP_FILE',
    )
    assert.ok(bootstrap)
    assert.equal(fs.existsSync(bootstrap.value), false)
    const prompt = messages.find((message) => message.method === 'session/prompt')
    assert.match(prompt.params.prompt[0].text, /running inside Orrery/)
    assert.equal(prompt.params.prompt[1].text, 'hello grok')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok remounts membrane on load without repeating fresh-session guidance', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-membrane-load-'))
  const { run, logFile } = startRun(tempRoot, 'late-replay', {
    backendSessionId: 'persisted-grok-session',
    membrane: { bridgeUrl: 'http://127.0.0.1:9999', token: 'membrane-token' },
  })
  try {
    await waitForClose(run)
    const messages = wire(logFile)
    const setup = messages.find((message) => message.method === 'session/load')
    assert.equal(setup.params.mcpServers[0].name, 'orrery_membrane')
    const prompt = messages.find((message) => message.method === 'session/prompt')
    assert.equal(prompt.params.prompt.length, 1)
    assert.equal(prompt.params.prompt[0].text, 'hello grok')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Grok omits an unsupported reasoning effort learned from the probe catalog', async () => {
  clearGrokProbeCacheForTest()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-grok-model-capability-'))
  const logFile = path.join(tempRoot, 'wire.jsonl')
  const worktreeRoot = path.join(tempRoot, 'worktree')
  fs.mkdirSync(worktreeRoot)
  const providerInstance = {
    providerInstanceId: 'capability-grok',
    kind: 'grok',
    label: 'Capability Grok',
    binaryPath: fakeGrok,
    env: { FAKE_GROK_SCENARIO: 'probe-models', FAKE_GROK_LOG: logFile },
  }
  try {
    const probe = await probeGrokProvider({ providerInstance, cwd: tempRoot })
    assert.equal(probe.status, 'ready')
    expireGrokReadinessCacheForTest()
    const adapter = new GrokAcpAdapter()
    const run = adapter.startTurn({
      prompt: 'capability-aware turn',
      cwd: worktreeRoot,
      sessionId: 'capability-session',
      turnId: 'capability-turn',
      runtimeSettings: {
        runtimeMode: 'approval-required',
        model: 'grok-no-reasoning',
        reasoningEffort: 'high',
      },
      attachments: [],
      providerInstance,
    })
    const captured = capture(run)
    await waitForClose(run)
    assert.equal(captured.errors.length, 0)
    const startups = wire(logFile).filter((entry) => entry.startup)
    assert.deepEqual(startups.at(-1).startup.argv, ['agent', 'stdio'])
    const configured = captured.providerEvents.find(
      (event) => event.type === 'runtime.configured',
    )
    assert.equal(configured.effectiveRuntimeConfig.reasoningEffort, undefined)
    assert.ok(
      configured.effectiveRuntimeConfig.notes.some((note) =>
        note.includes('does not support'),
      ),
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
