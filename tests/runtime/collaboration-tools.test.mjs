import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createMcpHandoff, cleanupMcpHandoff } from '../../dist-electron/electron/runtime/claudeRuntimeShared.js'

test('collaboration MCP inventory is directly loaded and rejects graph control before bridge dispatch', () => {
  const handoff = createMcpHandoff({ bridgeUrl: 'http://127.0.0.1:1', token: 'test-only', toolProfile: 'collaboration' }, { alwaysLoadTools: true })
  try {
    const config = JSON.parse(fs.readFileSync(handoff.configPath, 'utf8')).mcpServers.orrery_membrane
    assert.equal(config.alwaysLoad, true)
    const processResult = spawnSync(config.command, config.args, {
      env: { ...process.env, ...config.env }, encoding: 'utf8', timeout: 5000,
      input: [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_session', arguments: { prompt: 'Must not run' } } },
      ].map(JSON.stringify).join('\n') + '\n',
    })
    assert.equal(processResult.status, 0, processResult.stderr)
    const replies = processResult.stdout.trim().split('\n').map(JSON.parse)
    assert.deepEqual(replies.find((reply) => reply.id === 1).result.tools.map((tool) => tool.name), [
      'read_collaboration_updates', 'post_collaboration_message', 'set_discussion_assessment',
    ])
    assert.equal(replies.find((reply) => reply.id === 2).error.code, -32602)
  } finally { cleanupMcpHandoff(handoff) }
})

test('ordinary membrane clients retain their existing loading policy and graph tools', () => {
  const handoff = createMcpHandoff({ bridgeUrl: 'http://127.0.0.1:1', token: 'test-only' })
  try {
    const config = JSON.parse(fs.readFileSync(handoff.configPath, 'utf8')).mcpServers.orrery_membrane
    assert.equal(config.alwaysLoad, undefined)
    const processResult = spawnSync(config.command, config.args, {
      env: { ...process.env, ...config.env }, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    })
    assert.equal(processResult.status, 0, processResult.stderr)
    assert.ok(JSON.parse(processResult.stdout).result.tools.some((tool) => tool.name === 'create_session'))
  } finally { cleanupMcpHandoff(handoff) }
})
