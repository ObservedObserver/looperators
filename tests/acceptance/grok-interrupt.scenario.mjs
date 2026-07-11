import assert from 'node:assert/strict'

export const name = 'grok-interrupt'
export const description = 'A real Grok turn can be interrupted headlessly and reaches one authoritative killed terminal state.'
export const providers = ['grok']

export async function run({ orrery, provider, workDir }) {
  const baseline = await orrery.kernelEvents()
  const created = await orrery.createSession({
    ...provider,
    providerInstanceId: 'default-grok',
    cwd: workDir,
    runtimeSettings: { runtimeMode: 'approval-required', reasoningEffort: 'low' },
    prompt: 'Analyze every file under this workspace in exhaustive detail, then write a very long report. Do not answer until the analysis is complete.',
  })
  await orrery.waitFor(
    'real Grok ACP session setup before interrupt',
    async () => {
      const state = await orrery.state()
      const session = state.sessions[created.sessionId]
      return session?.providerSessionId
        ? { done: true, value: session }
        : { detail: `status=${session?.status} providerSession=${Boolean(session?.providerSessionId)}` }
    },
    { timeoutMs: 30_000 },
  )
  await orrery.killSession(created.sessionId)
  const killed = await orrery.waitForStatus(created.sessionId, 'killed', {
    timeoutMs: 30_000,
  })
  assert.equal(killed.status, 'killed')
  const { events } = await orrery.kernelEvents({ since: baseline.latestSeq, limit: 1000 })
  assert.equal(
    events.filter(
      (event) =>
        event.type === 'session.killed' &&
        event.payload?.sessionId === created.sessionId,
    ).length,
    1,
  )
  assert.equal(
    events.some(
      (event) =>
        (event.type === 'session.finished' || event.type === 'session.failed') &&
        event.payload?.sessionId === created.sessionId,
    ),
    false,
  )
}
