import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  cleanupMcpHandoff,
  createMcpHandoff,
} from '../dist-electron/electron/runtime/claudeRuntimeShared.js'
import { RuntimeSessionManager as BaseRuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'
import { deterministicRuntimeSessionManager } from '../tests/runtime/support/deterministic-provider.mjs'
import { cleanupRuntimeStorage } from './runtime-storage-cleanup.mjs'

const RuntimeSessionManager = deterministicRuntimeSessionManager(BaseRuntimeSessionManager)
const storageFile = path.join(
  os.tmpdir(),
  `orrery-membrane-validation-${process.pid}.json`,
)
const runtime = new RuntimeSessionManager({ storageFile })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777
}

async function expectReject(source, input, label) {
  const before = runtime.getState().reports.length
  let rejected = false
  try {
    await runtime.handleMembraneRequest({ tool: 'report', source, input })
  } catch {
    rejected = true
  }
  assert(rejected, `${label} should be rejected`)
  assert(runtime.getState().reports.length === before, `${label} should not add reports`)
}

try {
  const handoff = createMcpHandoff({
    bridgeUrl: 'http://127.0.0.1:48274',
    token: 'test-secret-token',
  })
  const configPath = handoff.configPath
  const bootstrapPath = path.join(handoff.dir, 'bootstrap.json')
  assert(mode(handoff.dir) === 0o700, 'handoff directory should be 0700')
  assert(mode(configPath) === 0o600, 'MCP config should be 0600')
  assert(mode(bootstrapPath) === 0o600, 'bootstrap should be 0600')

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const serializedConfig = JSON.stringify(config)
  assert(!serializedConfig.includes('test-secret-token'), 'MCP config must not contain the bearer token')
  assert(
    config.mcpServers?.orrery_membrane?.env?.ORRERY_MEMBRANE_BOOTSTRAP_FILE === bootstrapPath,
    'MCP config should reference the protected bootstrap file',
  )
  assert(
    config.mcpServers?.orrery_membrane?.env?.ELECTRON_RUN_AS_NODE === '1',
    'MCP config should launch the membrane server in Electron Node mode',
  )
  cleanupMcpHandoff(handoff)
  assert(!fs.existsSync(handoff.dir), 'handoff cleanup should remove the protected directory')

  const { sessionId } = await runtime.createSession({
    label: 'P2 Validation Source',
    prompt: 'deterministic membrane validation source',
  })

  await expectReject(
    sessionId,
    { type: 'verdict', verdict: 'issues', issues: [{ file: 'x.ts' }] },
    'missing issue message',
  )
  await expectReject(
    sessionId,
    { type: 'verdict', verdict: 'issues', issues: 'bad' },
    'non-array issues',
  )
  await expectReject(
    sessionId,
    {
      type: 'verdict',
      verdict: 'issues',
      issues: [{ message: 'bad severity', severity: 'fatal' }],
    },
    'invalid issue severity',
  )
  await expectReject(
    sessionId,
    { type: 'relationship', target: 'target', nature: 42 },
    'invalid relationship nature',
  )
  await expectReject(sessionId, { type: 'info' }, 'missing info payload')

  console.log('[validation] ok handoff permissions, cleanup, and report validation')
} finally {
  await cleanupRuntimeStorage(runtime, storageFile)
}
