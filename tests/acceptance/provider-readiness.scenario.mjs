import assert from 'node:assert/strict'
import path from 'node:path'

export const name = 'provider-readiness'
export const description =
  'Desktop provider acceptance: the selected real Codex or Claude executable is resolved, versioned, authenticated, protocol-ready, and launches one real chat through the same profile.'
export const providers = ['claude-code', 'codex']

export async function run({ orrery, provider, workDir, log }) {
  const providerInstanceId =
    provider.providerKind === 'codex' ? 'default-codex' : 'default-claude-sdk'
  const setup = await orrery.providerSetupStatus({
    providerKind: provider.providerKind,
    providerInstanceId,
    cwd: workDir,
    forceRefresh: true,
  })

  assert.equal(setup.installed, true)
  assert.equal(setup.readiness, 'ready')
  assert.ok(path.isAbsolute(setup.command?.resolved), 'the provider command must resolve to an absolute executable')
  assert.ok(setup.version?.trim(), 'the provider must report a version')
  assert.ok(
    ['authenticated', 'external', 'not-required'].includes(setup.auth?.status),
    `unexpected auth state: ${setup.auth?.status}`,
  )
  assert.equal(setup.checks.find((check) => check.id === 'protocol')?.status, 'ok')

  const session = await orrery.createSession({
    ...provider,
    providerInstanceId,
    cwd: workDir,
    label: 'Provider readiness',
    runtimeSettings: { runtimeMode: 'approval-required' },
    prompt: 'Reply with exactly: provider ready',
  })
  await orrery.waitForIdle(session.sessionId)
  const transcript = await orrery.transcript(session.sessionId)
  const reply = transcript.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')
  assert.match(reply, /provider ready/i)
  log(`verified ${provider.providerKind} setup and real chat use ${setup.command.resolved}`)
}
