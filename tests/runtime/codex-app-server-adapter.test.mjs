import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  codexApprovalResponseForTest,
  codexElicitationResponseForTest,
  codexInputItemsForTest,
  codexMembraneThreadParamsForTest,
  codexUserInputResponseForTest,
} from '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'
import { CodexJsonRpcClient } from '../../dist-electron/electron/runtime/providers/codexJsonRpcClient.js'
import { codexRuntimeEventsFromRequest } from '../../dist-electron/electron/runtime/providers/codexRuntimeMapper.js'
import {
  cleanupMcpHandoff,
  createMcpHandoff,
  membraneSystemPrompt,
} from '../../dist-electron/electron/runtime/claudeRuntimeShared.js'

test('Codex app-server input uses provider-native image attachment payloads', () => {
  const dataUrl = 'data:image/png;base64,aW1hZ2U='
  const input = codexInputItemsForTest({
    prompt: 'review image',
    attachments: [
      {
        id: 'image-1',
        name: 'screen.png',
        mediaType: 'image/png',
        size: 5,
        kind: 'image',
        dataUrl,
      },
      {
        id: 'text-1',
        name: 'notes.md',
        mediaType: 'text/markdown',
        size: 7,
        kind: 'text',
        text: '# notes',
      },
      {
        id: 'binary-1',
        name: 'diagram.svg',
        mediaType: 'image/svg+xml',
        size: 12,
        kind: 'binary',
      },
    ],
  })

  assert.deepEqual(input[0], {
    type: 'text',
    text: 'review image',
    text_elements: [],
  })
  assert.deepEqual(input[1], {
    type: 'image',
    url: dataUrl,
  })
  assert.equal(input[2].type, 'text')
  assert.match(input[2].text, /notes\.md/)
  assert.match(input[2].text, /# notes/)
  assert.equal(input[3].type, 'text')
  assert.match(input[3].text, /diagram\.svg/)
  assert.doesNotMatch(input[3].text, /data:image/)
})

test('Codex app-server approval responses preserve provider-style decisions', () => {
  assert.deepEqual(
    codexApprovalResponseForTest(
      { method: 'item/fileChange/requestApproval', params: {} },
      'acceptForSession'
    ),
    { decision: 'acceptForSession' }
  )
  assert.deepEqual(
    codexApprovalResponseForTest(
      { method: 'item/commandExecution/requestApproval', params: {} },
      'cancel'
    ),
    { decision: 'cancel' }
  )
  assert.deepEqual(
    codexApprovalResponseForTest(
      {
        method: 'item/permissions/requestApproval',
        params: {
          permissions: {
            network: null,
            fileSystem: { read: ['/tmp/project'], write: null },
          },
          scope: 'turn',
        },
      },
      'acceptForSession'
    ),
    {
      permissions: {
        network: null,
        fileSystem: { read: ['/tmp/project'], write: null },
      },
      scope: 'session',
      strictAutoReview: false,
    }
  )
})

test('Codex app-server user input preserves structured questions and answers', () => {
  const message = {
    id: 'input-1',
    method: 'item/tool/requestUserInput',
    params: {
      questions: [
        {
          id: 'branch',
          header: 'Branch',
          question: 'Which branch?',
          options: [
            { id: 'main', label: 'main', description: 'Use main.' },
            { id: 'feature', label: 'feature', description: 'Use feature.' },
          ],
        },
        {
          id: 'checks',
          header: 'Checks',
          question: 'Which checks?',
          multiSelect: true,
          options: [
            { id: 'tests', label: 'tests' },
            { id: 'build', label: 'build' },
          ],
        },
      ],
    },
  }

  const [event] = codexRuntimeEventsFromRequest({
    sessionId: 'session-1',
    turnId: 'turn-1',
    message,
  })
  assert.equal(event.type, 'user-input.requested')
  assert.equal(event.request.questions.length, 2)
  assert.equal(event.request.questions[0].options[1].label, 'feature')
  assert.equal(event.request.questions[1].multiSelect, true)

  assert.deepEqual(
    codexUserInputResponseForTest(message, undefined, {
      branch: 'feature',
      checks: ['tests', 'build'],
    }),
    {
      answers: {
        branch: { answers: ['feature'] },
        checks: { answers: ['tests', 'build'] },
      },
    }
  )
})

test('Codex JSON-RPC client launches through provider instance settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-client-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const markerFile = path.join(tempRoot, 'launch.json')
  const homePath = path.join(tempRoot, 'codex-home')
  const shadowHomePath = path.join(tempRoot, 'codex-shadow')

  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  sharedHome: process.env.ORRERY_CODEX_SHARED_HOME,
  custom: process.env.ORRERY_CODEX_TEST,
  path: process.env.PATH
}))
setTimeout(() => process.exit(0), 25)
`
  )
  fs.chmodSync(fakeCodex, 0o755)

  const client = new CodexJsonRpcClient({
    cwd: tempRoot,
    providerInstance: {
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Test',
      binaryPath: fakeCodex,
      homePath,
      shadowHomePath,
      launchArgs: ['--profile-flag'],
      env: { ORRERY_CODEX_TEST: 'yes' },
    },
  })

  try {
    await new Promise((resolve) => client.once('close', resolve))
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.deepEqual(marker.argv, [
      'app-server',
      '--listen',
      'stdio://',
      '--profile-flag',
    ])
    assert.equal(marker.codexHome, shadowHomePath)
    assert.equal(marker.sharedHome, homePath)
    assert.equal(marker.custom, 'yes')
    assert.ok(marker.path.startsWith(process.env.PATH), 'the existing PATH keeps precedence over GUI fallbacks')
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Codex membrane thread params mount the handoff server under the mcp__ name', () => {
  const membrane = { bridgeUrl: 'http://127.0.0.1:9999', token: 'unit-token' }
  const handoff = createMcpHandoff(membrane, { keepBootstrap: true })

  try {
    const params = codexMembraneThreadParamsForTest(handoff)
    const server = params.config.mcp_servers.mcp__orrery_membrane
    assert.ok(server, 'membrane server is registered under mcp__orrery_membrane')
    assert.equal(server.command, process.execPath)
    assert.match(server.args[0], /membraneMcpServer\.js$/)
    assert.equal(
      server.env.ORRERY_MEMBRANE_BOOTSTRAP_KEEP,
      '1',
      'codex multi-spawn clients keep the bootstrap file'
    )
    const bootstrap = JSON.parse(
      fs.readFileSync(server.env.ORRERY_MEMBRANE_BOOTSTRAP_FILE, 'utf8')
    )
    assert.deepEqual(bootstrap, { bridgeUrl: membrane.bridgeUrl, token: membrane.token })
    assert.equal(params.developerInstructions, membraneSystemPrompt())
  } finally {
    cleanupMcpHandoff(handoff)
  }

  assert.deepEqual(codexMembraneThreadParamsForTest(undefined), {})
})

test('Codex elicitation responses gate MCP tool approvals by server and mode', () => {
  const membraneApproval = {
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'mcp__orrery_membrane',
      mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      message: 'Allow the mcp__orrery_membrane MCP server to run tool "report"?',
      requestedSchema: { type: 'object', properties: {} },
    },
  }
  // Membrane tools are always sanctioned, regardless of runtime mode.
  assert.deepEqual(codexElicitationResponseForTest(membraneApproval, {}), {
    action: 'accept',
    content: {},
  })
  assert.deepEqual(
    codexElicitationResponseForTest(membraneApproval, { runtimeMode: 'approval-required' }),
    { action: 'accept', content: {} }
  )

  const otherApproval = {
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'some_other_server',
      mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: { type: 'object', properties: {} },
    },
  }
  assert.deepEqual(
    codexElicitationResponseForTest(otherApproval, { runtimeMode: 'full-access' }),
    { action: 'accept', content: {} }
  )
  assert.deepEqual(
    codexElicitationResponseForTest(otherApproval, { runtimeMode: 'approval-required' }),
    { action: 'decline' }
  )
  assert.deepEqual(codexElicitationResponseForTest(otherApproval, undefined), {
    action: 'decline',
  })

  // A true elicitation (interactive user input) is declined headlessly.
  const trueElicitation = {
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'mcp__orrery_membrane',
      mode: 'form',
      message: 'Fill in this form',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  }
  assert.deepEqual(
    codexElicitationResponseForTest(trueElicitation, { runtimeMode: 'full-access' }),
    { action: 'decline' }
  )
})

test('membrane MCP server keeps the bootstrap file only when asked to', async () => {
  const { spawnSync } = await import('node:child_process')
  const serverPath = path.resolve(
    'dist-electron/electron/runtime/membraneMcpServer.js'
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'membrane-keep-'))
  const bootstrapPath = path.join(dir, 'bootstrap.json')
  const initialize = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  })}\n`

  try {
    for (const [keep, survives] of [
      ['1', true],
      [undefined, false],
    ]) {
      fs.writeFileSync(
        bootstrapPath,
        JSON.stringify({ bridgeUrl: 'http://127.0.0.1:1', token: 't' })
      )
      const result = spawnSync(process.execPath, [serverPath], {
        input: initialize,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          ORRERY_MEMBRANE_BOOTSTRAP_FILE: bootstrapPath,
          ...(keep ? { ORRERY_MEMBRANE_BOOTSTRAP_KEEP: keep } : {}),
        },
      })
      assert.match(result.stdout, /"protocolVersion"/)
      assert.equal(
        fs.existsSync(bootstrapPath),
        survives,
        `keep=${keep} bootstrap survives=${survives}`
      )
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function writeFakeCodexAppServer(dir, { exitAfterTurnStartMs, turnCompletion }) {
  const requestLog = path.join(dir, 'requests.jsonl')
  // The fake is the `codex` binary itself (shebang script), mirroring the
  // JSON-RPC client test above: it receives `app-server --listen stdio://`
  // and speaks just enough protocol to park a run on turn completion.
  const fakeCodex = path.join(dir, 'codex')
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs')
const requestLog = ${JSON.stringify(requestLog)}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    fs.appendFileSync(requestLog, JSON.stringify(message) + '\\n')
    const respond = (result) =>
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
    if (message.method === 'initialize') respond({})
    if (message.method === 'thread/start') respond({ thread: { id: 'thread-1' } })
    if (message.method === 'turn/start') {
      respond({ turn: { id: 'turn-1' } })
      const exitAfter = ${JSON.stringify(exitAfterTurnStartMs)}
      const turnCompletion = ${JSON.stringify(turnCompletion ?? null)}
      if (turnCompletion) {
        setTimeout(() => process.stdout.write(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: turnCompletion }
        }) + '\\n'), 10)
      }
      if (exitAfter !== null) setTimeout(() => process.exit(0), exitAfter)
    }
  }
})
`
  )
  fs.chmodSync(fakeCodex, 0o755)
  return { fakeCodex, requestLog }
}

test('Codex run mounts the membrane per thread and settles when the app-server dies', async () => {
  const { CodexAppServerRun } = await import(
    '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'
  )
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-membrane-run-'))
  const { fakeCodex, requestLog } = writeFakeCodexAppServer(tempRoot, {
    exitAfterTurnStartMs: 50,
  })

  const run = new CodexAppServerRun({
    prompt: 'hello',
    cwd: tempRoot,
    sessionId: 'session-1',
    turnId: 'orrery-turn-1',
    runtimeSettings: { runtimeMode: 'full-access' },
    membrane: { bridgeUrl: 'http://127.0.0.1:9999', token: 'run-token' },
    providerInstance: {
      providerInstanceId: 'default-codex',
      kind: 'codex',
      binaryPath: fakeCodex,
    },
  })

  try {
    const errors = []
    run.on('error', (error) => errors.push(error))
    // The fake app-server exits shortly after turn/start without ever
    // sending turn/completed; the run must close promptly (not after the
    // 30-minute turn timeout) so the handoff dir and token are released.
    const closed = await Promise.race([
      new Promise((resolve) => run.once('close', resolve)),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('run did not close after app-server death')), 15000)
      ),
    ])
    assert.equal(closed.killed, false)
    assert.ok(
      errors.some((error) => /closed before turn completion/.test(error.message)),
      'the premature close surfaces as a run error'
    )

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const threadStart = requests.find((message) => message.method === 'thread/start')
    const membraneServer =
      threadStart.params.config.mcp_servers.mcp__orrery_membrane
    assert.ok(membraneServer, 'thread/start carries the membrane mcp server')
    assert.equal(membraneServer.env.ORRERY_MEMBRANE_BOOTSTRAP_KEEP, '1')
    assert.equal(threadStart.params.developerInstructions, membraneSystemPrompt())
    assert.equal(
      fs.existsSync(membraneServer.env.ORRERY_MEMBRANE_BOOTSTRAP_FILE),
      false,
      'the credentials handoff is cleaned up when the run closes'
    )
  } finally {
    run.kill()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Codex failed turn is a failed run instead of a successful idle completion', async () => {
  const { CodexAppServerRun } = await import(
    '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'
  )
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-failed-turn-'))
  const { fakeCodex } = writeFakeCodexAppServer(tempRoot, {
    exitAfterTurnStartMs: null,
    turnCompletion: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'selected model requires a newer Codex runtime' },
    },
  })
  const run = new CodexAppServerRun({
    prompt: 'hello',
    cwd: tempRoot,
    sessionId: 'session-1',
    turnId: 'orrery-turn-1',
    runtimeSettings: { runtimeMode: 'full-access', model: 'future-model' },
    providerInstance: {
      providerInstanceId: 'default-codex',
      kind: 'codex',
      binaryPath: fakeCodex,
    },
  })

  try {
    const errors = []
    run.on('error', (error) => errors.push(error))
    const closed = await Promise.race([
      new Promise((resolve) => run.once('close', resolve)),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('failed Codex turn did not close')), 15000)
      ),
    ])
    assert.equal(closed.code, 1)
    assert.ok(
      errors.some((error) => /requires a newer Codex runtime/.test(error.message)),
      'the native turn failure reaches the runtime error path'
    )
  } finally {
    run.kill()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Codex run kill settles promptly while waiting on turn completion', async () => {
  const { CodexAppServerRun } = await import(
    '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'
  )
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-kill-run-'))
  const { fakeCodex, requestLog } = writeFakeCodexAppServer(tempRoot, {
    exitAfterTurnStartMs: null,
  })

  const run = new CodexAppServerRun({
    prompt: 'hello',
    cwd: tempRoot,
    sessionId: 'session-1',
    turnId: 'orrery-turn-1',
    runtimeSettings: { runtimeMode: 'full-access' },
    membrane: { bridgeUrl: 'http://127.0.0.1:9999', token: 'run-token' },
    providerInstance: {
      providerInstanceId: 'default-codex',
      kind: 'codex',
      binaryPath: fakeCodex,
    },
  })
  run.on('error', () => {})

  try {
    // Wait until the run is parked on turn completion (turn/start logged).
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('fake app-server never saw turn/start')),
        15000
      )
      const poll = setInterval(() => {
        if (
          fs.existsSync(requestLog) &&
          /"turn\/start"/.test(fs.readFileSync(requestLog, 'utf8'))
        ) {
          clearTimeout(deadline)
          clearInterval(poll)
          resolve()
        }
      }, 25)
    })

    const closePromise = new Promise((resolve) => run.once('close', resolve))
    run.kill()
    const closed = await Promise.race([
      closePromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('kill did not close the run promptly')), 15000)
      ),
    ])
    assert.equal(closed.killed, true)
  } finally {
    run.kill()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
