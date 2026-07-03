import assert from 'node:assert/strict'

export const name = 'linked-chat-context'
export const description =
  'Create session A, spawn a linked session B with handoff context, verify B uses the context and the create-session edge exists.'

export async function run({ orrery, provider, workDir, log }) {
  const source = await orrery.createSession({
    ...provider,
    label: 'Context Source',
    cwd: workDir,
    prompt: 'Remember this codeword: PLUM-42. Reply with exactly: stored.',
  })
  log(`source session ${source.sessionId}`)
  await orrery.waitForIdle(source.sessionId)

  const linked = await orrery.createSession({
    ...provider,
    label: 'Linked Follow-up',
    cwd: workDir,
    sourceSessionId: source.sessionId,
    linkLabel: 'handoff',
    context: 'Handoff from the previous session: the codeword is PLUM-42.',
    // G2: handoff context arrives as a channel delivery listed below the
    // prompt; the agent must read the delivered file.
    prompt:
      'Your context channel has a handoff delivery; its file paths are listed below. ' +
      'Read the delivered file, find the codeword in it, and reply with only that codeword and nothing else.',
  })
  log(`linked session ${linked.sessionId}`)
  await orrery.waitForIdle(linked.sessionId)

  const transcript = await orrery.transcript(linked.sessionId)
  const assistantReply = transcript.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')
  assert.match(
    assistantReply,
    /PLUM-42/,
    `linked session must surface the handoff codeword, got: ${assistantReply}`
  )

  const graph = await orrery.graph()
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.kind === 'create-session' &&
        edge.source === source.sessionId &&
        edge.target === linked.sessionId &&
        edge.label === 'handoff'
    ),
    true,
    'linked chat must produce a labeled create-session edge'
  )
}
