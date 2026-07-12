import assert from 'node:assert/strict'

export const name = 'dynamic-topology-triage'
export const description =
  'M4 real-provider acceptance: one typed issue report creates a bounded set of fixed-template triage participants in the inherited Scope and records the capped remainder.'
export const timeoutMs = 600_000

export async function run({ orrery, provider, workDir, log }) {
  const owner = await orrery.createSession({
    ...provider,
    cwd: workDir,
    label: 'Dynamic Triage Owner',
    prompt: 'Reply with exactly: triage owner ready. Then stop.',
  })
  await orrery.waitForIdle(owner.sessionId)
  await orrery.dispatchCommand({
    kind: 'upsert_scope', actor: { kind: 'human' },
    input: { clusterId: 'acceptance-triage', label: 'Acceptance Triage', nodeIds: [owner.sessionId] },
  })
  const providerInstanceId = provider.providerKind === 'codex'
    ? 'default-codex'
    : provider.providerKind === 'grok'
      ? 'default-grok'
      : 'default-claude-sdk'
  const authored = await orrery.authorSubscription({
    id: 'acceptance-dynamic-triage',
    sourceSessionId: owner.sessionId,
    on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
    targetSessionId: owner.sessionId,
    action: {
      kind: 'create', forEach: { kind: 'report-issues' },
      template: {
        templateId: 'acceptance-triage-v1', labelPrefix: 'Issue Triage', role: 'triage',
        prompt: 'Read the assigned issue from your Orrery channel. Give a concise root-cause hypothesis and verification checklist. Do not edit files, then stop.',
        providerKind: provider.providerKind, providerInstanceId,
        runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' },
        workspace: { access: 'read-only', workMode: 'local' },
        retention: 'keep',
      },
      limits: { maxGenerationDepth: 2, maxSessions: 8, maxFanOut: 2, maxPlanVersions: 10 },
    },
    gate: 'auto', concurrency: 'queue', stop: { maxFirings: 1 },
  })
  await orrery.resumeSession(owner.sessionId, {
    message: [
      'Call mcp__orrery_membrane__report exactly once with type "verdict", verdict "issues",',
      'summary "Three independently triageable findings", and this exact issues array:',
      JSON.stringify([
        { id: 'durability', message: 'Crash between dequeue and acknowledgement may lose work.' },
        { id: 'ordering', message: 'Concurrent workers may violate per-tenant FIFO.' },
        { id: 'backpressure', message: 'The producer has no queue capacity guard.' },
      ]),
      'After the tool succeeds, reply briefly and stop.',
    ].join(' '),
  })
  const group = await orrery.waitFor('bounded real-provider triage group', async () => {
    const state = await orrery.state()
    const candidate = Object.values(state.dynamicSpawnGroups ?? {})[0]
    if (!candidate) return { detail: 'spawn group missing' }
    const sessions = candidate.children.map((child) => state.sessions[child.sessionId])
    return sessions.every((session) => session?.status === 'idle')
      ? { done: true, value: { candidate, state } }
      : { detail: `${candidate.status} · ${sessions.map((session) => session?.status).join(',')}` }
  }, { timeoutMs: 480_000 })
  assert.equal(group.candidate.requestedCount, 3)
  assert.equal(group.candidate.createdCount, 2)
  assert.equal(group.candidate.skippedCount, 1)
  assert.equal(group.candidate.status, 'capped')
  assert.ok(group.candidate.children.every((child) =>
    group.state.clusters['acceptance-triage'].nodeIds.includes(child.sessionId),
  ))
  assert.ok(group.candidate.children.every((child) =>
    group.state.sessions[child.sessionId].dynamicTopology?.scopeId === 'acceptance-triage',
  ))
  assert.equal(group.state.subscriptions[authored.subscription.id].state, 'stopped')
  const { events } = await orrery.kernelEvents({ limit: 3000 })
  assert.equal(events.filter((event) => event.type === 'dynamic.spawned').length, 1)
  log('verified 3 typed issues → bounded 2 real triage Agents + explicit cap explanation in one inherited Scope')
}
