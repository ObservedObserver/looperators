import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrreryHarness } from '../../scripts/lib/orrery-client.mjs'

export const name = 'grok-runtime-restart'
export const description = 'A persisted Grok session cold-loads after the whole Orrery runtime process restarts.'
export const timeoutMs = 600_000
export const providers = ['grok']

export async function run({ workDir, artifactsDir, signal }) {
  const storageFile = path.join(workDir, 'restart-runtime-state.sqlite')
  const nonce = `ORRERY-RESTART-${randomUUID().slice(0, 8).toUpperCase()}`
  let sessionId
  let activeHarness
  const closeActive = () => activeHarness?.close().catch(() => undefined)
  signal.addEventListener('abort', closeActive, { once: true })
  const first = await OrreryHarness.start({ storageFile, modelPreset: 'cheap' })
  activeHarness = first
  let firstReplyCount = 0
  try {
    const created = await first.createSession({
      providerKind: 'grok',
      providerInstanceId: 'default-grok',
      cwd: workDir,
      runtimeSettings: { runtimeMode: 'approval-required', reasoningEffort: 'low' },
      prompt: `Remember this nonce across a runtime restart: ${nonce}. Reply exactly STORED.`,
    })
    sessionId = created.sessionId
    await first.waitForIdle(sessionId)
    const transcript = await first.transcript(sessionId)
    const replies = transcript.messages.filter((message) => message.role === 'assistant')
    assert.equal(replies.at(-1)?.content.trim(), 'STORED')
    firstReplyCount = replies.length
    fs.writeFileSync(
      path.join(artifactsDir, 'restart-before-state.json'),
      JSON.stringify(await first.state(), null, 2),
    )
    fs.writeFileSync(
      path.join(artifactsDir, 'restart-before-transcript.json'),
      JSON.stringify(transcript, null, 2),
    )
    fs.writeFileSync(
      path.join(artifactsDir, 'restart-before-kernel-events.json'),
      JSON.stringify(await first.kernelEvents({ limit: 5000 }), null, 2),
    )
  } finally {
    await first.close()
    if (activeHarness === first) activeHarness = undefined
  }

  signal.throwIfAborted()
  const second = await OrreryHarness.start({ storageFile, modelPreset: 'cheap' })
  activeHarness = second
  try {
    await second.resumeSession(sessionId, {
      message: 'Without reading files, reply only with the nonce remembered before the runtime restart.',
    })
    await second.waitForIdle(sessionId)
    const transcript = await second.transcript(sessionId)
    const replies = transcript.messages.filter((message) => message.role === 'assistant')
    assert.ok(replies.length > firstReplyCount)
    assert.equal(replies.at(-1)?.content.trim(), nonce)
    fs.writeFileSync(
      path.join(artifactsDir, 'restart-after-state.json'),
      JSON.stringify(await second.state(), null, 2),
    )
    fs.writeFileSync(
      path.join(artifactsDir, 'restart-after-transcript.json'),
      JSON.stringify(transcript, null, 2),
    )
    fs.writeFileSync(
      path.join(artifactsDir, 'restart-after-kernel-events.json'),
      JSON.stringify(await second.kernelEvents({ limit: 5000 }), null, 2),
    )
  } finally {
    await second.close()
    if (activeHarness === second) activeHarness = undefined
    signal.removeEventListener('abort', closeActive)
  }
}
