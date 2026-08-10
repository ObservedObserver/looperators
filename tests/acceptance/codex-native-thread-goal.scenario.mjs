import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'codex-native-thread-goal'
export const description =
  'A real Codex thread goal materializes without a normal user turn, pauses, resumes through native continuation, completes, and clears.'
export const providers = ['codex']
export const timeoutMs = 600_000

async function waitForGoal(orrery, sessionId, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await orrery.state()
    const session = state.sessions?.[sessionId]
    if (session && predicate(session)) return session
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export async function run({ orrery, provider, workDir, log }) {
  const releaseFile = path.join(workDir, 'release.txt')
  const proofFile = path.join(workDir, 'native-goal-proof.txt')
  const created = await orrery.setThreadGoal({
    ...provider,
    providerInstanceId: 'default-codex',
    cwd: workDir,
    label: 'Native thread goal',
    status: 'active',
    objective:
      'Keep this goal active until release.txt exists. While it is absent, do not mark the goal blocked or complete and do not create it. Once it exists, create native-goal-proof.txt containing exactly NATIVE_GOAL_OK, verify the file, then mark the current goal complete.',
  })
  const sessionId = created.sessionId
  assert.ok(sessionId, 'new goal must create a local chat session')

  await waitForGoal(
    orrery,
    sessionId,
    (session) => session.threadGoal?.status === 'active',
    'the native goal to become active',
  )
  await orrery.setThreadGoal({ sessionId, status: 'paused' })
  const paused = await waitForGoal(
    orrery,
    sessionId,
    (session) => session.threadGoal?.status === 'paused' && session.status === 'idle',
    'the native goal to pause and release its run',
  )
  assert.equal(paused.threadGoal.objective.includes('release.txt'), true)

  fs.writeFileSync(releaseFile, 'release\n')
  await orrery.setThreadGoal({ sessionId, status: 'active' })
  const completed = await waitForGoal(
    orrery,
    sessionId,
    (session) => session.threadGoal?.status === 'complete' && session.status === 'idle',
    'the resumed native goal to complete',
    300_000,
  )
  assert.equal(fs.readFileSync(proofFile, 'utf8'), 'NATIVE_GOAL_OK')
  assert.ok(completed.threadGoal.tokensUsed >= 0)
  assert.ok(completed.threadGoal.timeUsedSeconds >= 0)

  await orrery.clearThreadGoal(sessionId)
  await waitForGoal(
    orrery,
    sessionId,
    (session) => session.threadGoal === undefined && session.status === 'idle',
    'the completed native goal to clear',
  )
  log(`verified native goal lifecycle in ${sessionId.slice(0, 8)}`)
}
