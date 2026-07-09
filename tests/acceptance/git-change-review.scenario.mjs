import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'git-change-review'
export const description =
  'L2 acceptance, half 1 (proposal §L2 验收): on a real repo, the git watcher source drives a review-on-change edge end to end — a real commit becomes an external.git fact, the fact activates a real reviewer with the event in its channel, and the reviewer reads the commit and answers with its subject.'
export const timeoutMs = 480_000

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=orrery-acceptance', '-c', 'user.email=acceptance@orrery.local', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

export async function run({ orrery, provider, workDir, log }) {
  git(workDir, 'init', '-b', 'main')
  const appFile = path.join(workDir, 'greeting.js')
  fs.writeFileSync(appFile, "export const greeting = 'helo world';\n")
  git(workDir, 'add', '.')
  git(workDir, 'commit', '-m', 'baseline greeting')

  const reviewer = await orrery.createSession({
    ...provider,
    label: 'Change Reviewer',
    cwd: workDir,
    prompt: 'Reply with exactly: reviewer ready.',
  })
  await orrery.waitForIdle(reviewer.sessionId)

  // Register the watcher FIRST and let it report the baseline head before
  // any edge exists — the baseline fact then predates the subscription and
  // must not fire it.
  const { source } = await orrery.registerExternalSource({
    id: 'src-repo-watch',
    kind: 'git',
    label: 'Repo watcher',
    minIntervalSeconds: 0,
    config: { repoPath: workDir, pollSeconds: 2 },
  })
  const baselineHead = git(workDir, 'rev-parse', 'HEAD')
  await orrery.waitFor('baseline head fact', async () => {
    const { events } = await orrery.kernelEvents({ type: 'external.git', limit: 100 })
    const fact = events.find((event) => event.payload.head === baselineHead)
    return fact ? { done: true, value: fact } : { detail: 'watcher has not reported yet' }
  })
  log('watcher reported the baseline head')

  const sub = (
    await orrery.authorSubscription({
      label: 'review-on-change',
      source: { kind: 'external', sourceId: source.id },
      on: { on: 'external', topic: 'git' },
      targetSessionId: reviewer.sessionId,
      action: {
        kind: 'deliver+activate',
        note:
          'A git commit event was delivered to your context channel as external-event.md. ' +
          'Read it to find the new head sha and the commit subject, run `git show --stat <that sha>` in your workspace to confirm, ' +
          'then reply with exactly one line: REVIEWED: <the commit subject>. Then stop.',
      },
      gate: 'auto',
      stop: { maxFirings: 2 },
    })
  ).subscription
  log(`review edge ${sub.id}`)

  // The real change: a commit made with real git, no emit shortcut.
  fs.writeFileSync(appFile, "export const greeting = 'hello world';\n")
  git(workDir, 'add', '.')
  git(workDir, 'commit', '-m', 'fix: correct the greeting spelling')
  const changedHead = git(workDir, 'rev-parse', 'HEAD')
  log(`committed ${changedHead.slice(0, 8)}`)

  await orrery.waitFor('review firing', async () => {
    const state = await orrery.state()
    const current = state.subscriptions?.[sub.id]
    const busy = Object.values(state.sessions).some(
      (session) => session.status === 'running' || session.status === 'pending'
    )
    return current?.firings >= 1 && !busy
      ? { done: true }
      : { detail: `firings=${current?.firings ?? 0}` }
  }, { timeoutMs: 240_000 })

  // The reviewer actually read the event and named the commit.
  const transcript = await orrery.transcript(reviewer.sessionId)
  const reply = transcript.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')
  assert.match(
    reply,
    /REVIEWED: .*greeting spelling/i,
    `the reviewer must surface the commit subject, got: ${reply}`
  )

  // Kernel-log evidence: real commit → external.git fact → activation chain.
  const { events } = await orrery.kernelEvents({ limit: 5000 })
  const changeFact = events.find(
    (event) => event.type === 'external.git' && event.payload.head === changedHead
  )
  assert.ok(changeFact, 'the commit became an external.git fact')
  assert.equal(changeFact.payload.previousHead, baselineHead)
  assert.equal(changeFact.payload.subject, 'fix: correct the greeting spelling')
  const pending = events.find(
    (event) =>
      event.type === 'activation.pending' &&
      event.payload.subscriptionId === sub.id &&
      event.causeId === changeFact.id
  )
  assert.ok(pending, 'the activation chains to the commit fact')
  const activated = events.find(
    (event) => event.type === 'activated' && event.payload.subscriptionId === sub.id
  )
  assert.ok(activated, 'the review edge fired')

  // Cleanup: removing the source stops the watcher AND the edge
  // (participant parity), leaving the graph quiet.
  await orrery.stopSubscription(sub.id, { reason: 'scenario cleanup' })
  await orrery.removeExternalSource(source.id, { reason: 'scenario cleanup' })
  const state = await orrery.state()
  assert.equal(state.sources[source.id].state, 'removed')
  for (const session of Object.values(state.sessions)) {
    assert.equal(
      session.status === 'running' || session.status === 'pending',
      false,
      `session ${session.label} must be settled before the scenario passes`
    )
  }
  log('git change-review verified: real commit → fact → activation → informed review')
}
