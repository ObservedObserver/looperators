import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'
import { cleanupRuntimeStorage } from './runtime-storage-cleanup.mjs'

const storageFile = path.join(
  os.tmpdir(),
  `orrery-membrane-validation-${process.pid}.json`
)
const runtime = new RuntimeSessionManager({ storageFile })

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function psOutput() {
  return execFileSync('/bin/ps', ['-eww', '-o', 'pid=,command='], {
    encoding: 'utf8',
  })
}

async function waitForProcessLine(sessionId) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15000) {
    const line = psOutput()
      .split('\n')
      .find((item) => item.includes(' claude ') && item.includes(sessionId))
    if (line) {
      return line
    }
    await sleep(250)
  }

  throw new Error(`Could not find Claude process for session ${sessionId}`)
}

async function waitForRemoved(filePath) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15000) {
    if (!fs.existsSync(filePath)) {
      return
    }
    await sleep(250)
  }

  throw new Error(`Bootstrap file was not consumed: ${filePath}`)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777
}

async function expectReject(source, input, label) {
  const before = runtime.getState().reports.length
  let rejected = false

  try {
    await runtime.handleMembraneRequest({
      tool: 'report',
      source,
      input,
    })
  } catch {
    rejected = true
  }

  const after = runtime.getState().reports.length
  assert(rejected, `${label} should be rejected`)
  assert(after === before, `${label} should not add reports`)
  console.log(`[validation] rejected malformed report: ${label}`)
}

try {
  const { sessionId } = await runtime.createSession({
    label: 'P2 Validation Source',
    prompt:
      'Reply START, then count upward slowly until stopped. Do not call any tools.',
  })

  const processLine = await waitForProcessLine(sessionId)
  assert(
    processLine.includes('--mcp-config '),
    'Claude argv should include --mcp-config'
  )
  assert(
    !processLine.includes('ORRERY_MEMBRANE_TOKEN') &&
      !processLine.includes('ORRERY_MEMBRANE_BRIDGE_URL') &&
      !processLine.includes('"mcpServers"'),
    'Claude argv must not contain membrane secrets or inline MCP JSON'
  )

  const configPathMatch = /--mcp-config\s+(\S+)/.exec(processLine)
  assert(configPathMatch, 'Could not parse --mcp-config path')

  const configPath = configPathMatch[1]
  assert(fs.existsSync(configPath), 'MCP config file should exist while running')
  assert(mode(configPath) === 0o600, 'MCP config file should be 0600')

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const bootstrapFile =
    config.mcpServers?.orrery_membrane?.env?.ORRERY_MEMBRANE_BOOTSTRAP_FILE
  assert(
    typeof bootstrapFile === 'string' && bootstrapFile.length > 0,
    'MCP config should point at a bootstrap file'
  )
  assert(
    !JSON.stringify(config).includes('ORRERY_MEMBRANE_TOKEN') &&
      !JSON.stringify(config).includes('bridgeUrl') &&
      !JSON.stringify(config).includes('token'),
    'MCP config file must not contain the bearer token'
  )
  await waitForRemoved(bootstrapFile)
  console.log('[validation] token absent from Claude argv and config')

  runtime.killSession(sessionId)

  await expectReject(
    sessionId,
    { type: 'verdict', verdict: 'issues', issues: [{ file: 'x.ts' }] },
    'missing issue message'
  )
  await expectReject(
    sessionId,
    { type: 'verdict', verdict: 'issues', issues: 'bad' },
    'non-array issues'
  )
  await expectReject(
    sessionId,
    {
      type: 'verdict',
      verdict: 'issues',
      issues: [{ message: 'bad severity', severity: 'fatal' }],
    },
    'invalid issue severity'
  )
  await expectReject(
    sessionId,
    {
      type: 'verdict',
      verdict: 'issues',
      issues: [{ message: 'bad line', line: '12' }],
    },
    'invalid issue line'
  )
  await expectReject(
    sessionId,
    { type: 'relationship', target: 'target', nature: 42 },
    'invalid relationship nature'
  )
  await expectReject(sessionId, { type: 'info' }, 'missing info payload')

  console.log('[validation] ok malformed reports rejected without graph writes')
} finally {
  await cleanupRuntimeStorage(runtime, storageFile)
}
