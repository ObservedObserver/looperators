import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const name = 'grok-two-turn-resume'
export const description = 'Real Grok create plus a second Orrery turn recovers context through a fresh ACP process/session/load.'
export const providers = ['grok']

export async function run({ orrery, provider, workDir }) {
  const nonce = `ORRERY-RESUME-${randomUUID().slice(0, 8).toUpperCase()}`
  const created = await orrery.createSession({
    ...provider,
    providerInstanceId: 'default-grok',
    cwd: workDir,
    runtimeSettings: { runtimeMode: 'approval-required', reasoningEffort: 'low' },
    prompt: `Remember this nonce for the next turn: ${nonce}. Reply exactly STORED.`,
  })
  await orrery.waitForIdle(created.sessionId)
  const firstTranscript = await orrery.transcript(created.sessionId)
  const firstReplies = firstTranscript.messages.filter(
    (message) => message.role === 'assistant',
  )
  assert.equal(firstReplies.at(-1)?.content.trim(), 'STORED')
  const firstReplyCount = firstReplies.length
  await orrery.resumeSession(created.sessionId, {
    message: 'Without reading files, reply with the nonce from the previous turn and nothing else.',
  })
  await orrery.waitForIdle(created.sessionId)
  const transcript = await orrery.transcript(created.sessionId)
  const replies = transcript.messages.filter((message) => message.role === 'assistant')
  assert.ok(replies.length > firstReplyCount)
  assert.equal(replies.at(-1)?.content.trim(), nonce)
}
