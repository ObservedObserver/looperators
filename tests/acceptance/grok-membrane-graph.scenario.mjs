import assert from 'node:assert/strict'

export const name = 'grok-membrane-graph'
export const description = 'Real Grok uses the injected membrane to create, link, report, and later resume a Grok child.'
export const timeoutMs = 600_000
export const providers = ['grok']

export async function run({ orrery, provider, workDir }) {
  const parent = await orrery.createSession({
    ...provider,
    providerInstanceId: 'default-grok',
    cwd: workDir,
    runtimeSettings: { runtimeMode: 'full-access', reasoningEffort: 'low' },
    prompt: [
      'Use Orrery membrane tools; do not merely describe them.',
      '1. Call create_session with agent "grok", prompt "Reply exactly CHILD-READY", and label "Grok Membrane Child".',
      '2. Call link_sessions using the returned child session id, label "grok-created", and a short reason.',
      '3. Call report with type "info" and payload {"phase":"created"}.',
      'Then reply exactly PARENT-CREATED.',
    ].join('\n'),
  })
  await orrery.waitForIdle(parent.sessionId)
  const afterCreate = await orrery.state()
  const createEdge = (afterCreate.edges ?? []).find(
    (edge) => edge.kind === 'create-session' && edge.source === parent.sessionId,
  )
  const child = createEdge ? afterCreate.sessions[createEdge.target] : undefined
  assert.ok(child, 'Grok must create a real child session through the membrane')
  await orrery.waitForIdle(child.sessionId)
  assert.ok(
    (afterCreate.reports ?? []).some(
      (report) => report.from === parent.sessionId && report.payload?.payload?.phase === 'created',
    ),
  )
  assert.ok(
    (afterCreate.edges ?? []).some(
      (edge) =>
        edge.kind === 'link' &&
        edge.label === 'grok-created' &&
        edge.source === parent.sessionId &&
        edge.target === child.sessionId,
    ),
  )

  await orrery.resumeSession(parent.sessionId, {
    message: [
      'Use the child session id returned by create_session in the previous turn.',
      'Call resume_session on that child with message "Reply exactly RESUMED-BY-GROK".',
      'Then call report with type "info" and payload {"phase":"resumed"}.',
      'After both tools succeed, reply exactly PARENT-RESUMED.',
    ].join('\n'),
  })
  await orrery.waitForIdle(parent.sessionId)
  await orrery.waitForIdle(child.sessionId)
  const finalState = await orrery.state()
  assert.ok(
    (finalState.edges ?? []).some(
      (edge) =>
        edge.kind === 'resume-session' &&
        edge.source === parent.sessionId &&
        edge.target === child.sessionId,
    ),
  )
  assert.ok(
    (finalState.reports ?? []).some(
      (report) => report.from === parent.sessionId && report.payload?.payload?.phase === 'resumed',
    ),
  )
  const childTranscript = await orrery.transcript(child.sessionId)
  assert.match(
    childTranscript.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n'),
    /RESUMED-BY-GROK/,
  )
}
