import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

// L2 git watcher tests — real git, fully local, deterministic:
// - "commit trigger" = a real `git commit` in a temp repo;
// - "push trigger"   = a real `git push` to a local bare repo over file://.
// No GitHub, no network, no mocks.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate()
    if (value) {
      return value
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Orrery Test',
  GIT_AUTHOR_EMAIL: 'test@orrery.local',
  GIT_COMMITTER_NAME: 'Orrery Test',
  GIT_COMMITTER_EMAIL: 'test@orrery.local',
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: gitEnv,
    encoding: 'utf8',
  }).trim()
}

function initRepo(root, name) {
  const repo = path.join(root, name)
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', repo], { env: gitEnv })
  return repo
}

function commit(repo, message) {
  git(repo, 'commit', '--allow-empty', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function harness(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input = { storageFile }) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }
  const cleanup = () => {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, storageFile, manager, cleanup }
}

const factsOf = (runtime) => runtime.getKernelEvents({ type: 'external.git' }).events

test('a local commit moves HEAD and becomes exactly one external.git fact per change', async () => {
  const { tempRoot, manager, cleanup } = harness('orrery-git-commit-')
  try {
    const repo = initRepo(tempRoot, 'work')
    const initialHead = commit(repo, 'initial state')

    const runtime = manager()
    runtime.registerExternalSource({
      id: 'src-repo',
      kind: 'git',
      minIntervalSeconds: 0,
      config: { repoPath: repo, pollSeconds: 1 },
    })

    // The watcher reports the current head on its first beat.
    await waitFor('initial head fact', () =>
      factsOf(runtime).some((event) => event.payload.head === initialHead)
    )

    const nextHead = commit(repo, 'fix: teach the parser about unicode')
    const changed = await waitFor('commit detected', () =>
      factsOf(runtime).find((event) => event.payload.head === nextHead)
    )
    assert.equal(changed.payload.previousHead, initialHead)
    assert.equal(changed.payload.subject, 'fix: teach the parser about unicode')
    assert.equal(changed.payload.ref, 'HEAD')
    assert.equal(changed.payload.sourceId, 'src-repo')

    // Idle polls stay silent (dedupe by head sha).
    await delay(2500)
    assert.equal(factsOf(runtime).length, 2)
  } finally {
    cleanup()
  }
})

test('a real push to a local bare repo is a push trigger — no forge required', async () => {
  const { tempRoot, manager, cleanup } = harness('orrery-git-push-')
  try {
    const bare = path.join(tempRoot, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { env: gitEnv })
    const work = initRepo(tempRoot, 'clone')
    git(work, 'remote', 'add', 'origin', `file://${bare}`)
    commit(work, 'first change')
    git(work, 'push', 'origin', 'main')
    const pushedHead = git(work, 'rev-parse', 'HEAD')

    const runtime = manager()
    runtime.registerExternalSource({
      id: 'src-origin',
      kind: 'git',
      minIntervalSeconds: 0,
      config: { repoPath: bare, ref: 'refs/heads/main', pollSeconds: 1 },
    })
    await waitFor('pre-existing head reported', () =>
      factsOf(runtime).some((event) => event.payload.head === pushedHead)
    )

    const secondHead = commit(work, 'second change, pushed')
    git(work, 'push', 'origin', 'main')
    const pushed = await waitFor('push detected on the bare repo', () =>
      factsOf(runtime).find((event) => event.payload.head === secondHead)
    )
    assert.equal(pushed.payload.previousHead, pushedHead)
    assert.equal(pushed.payload.ref, 'refs/heads/main')
  } finally {
    cleanup()
  }
})

test('an unreadable repo lands on lastError and recovers when the repo appears', async () => {
  const { tempRoot, manager, cleanup } = harness('orrery-git-error-')
  try {
    const dir = path.join(tempRoot, 'not-a-repo')
    fs.mkdirSync(dir)
    const runtime = manager()
    runtime.registerExternalSource({
      id: 'src-broken',
      kind: 'git',
      minIntervalSeconds: 0,
      config: { repoPath: dir, pollSeconds: 1 },
    })
    await waitFor('poll error recorded', () =>
      /Git watcher poll failed/.test(runtime.getState().sources['src-broken'].lastError ?? '')
    )
    assert.equal(factsOf(runtime).length, 0, 'no kernel pollution')

    // The directory becomes a real repo; the watcher self-heals and the
    // accepted emit clears the operational error.
    execFileSync('git', ['init', '-b', 'main', dir], { env: gitEnv })
    const head = commit(dir, 'now a repo')
    await waitFor('recovered head fact', () =>
      factsOf(runtime).some((event) => event.payload.head === head)
    )
    await waitFor(
      'lastError cleared by the accepted emit',
      () => runtime.getState().sources['src-broken'].lastError === undefined
    )
  } finally {
    cleanup()
  }
})

test('registration validates the git config up front', async () => {
  const { tempRoot, manager, cleanup } = harness('orrery-git-validate-')
  try {
    const runtime = manager()
    assert.throws(
      () => runtime.registerExternalSource({ kind: 'git' }),
      /requires config\.repoPath/
    )
    assert.throws(
      () =>
        runtime.registerExternalSource({
          kind: 'git',
          config: { repoPath: path.join(tempRoot, 'missing') },
        }),
      /existing repository/
    )
    const repo = initRepo(tempRoot, 'ok')
    assert.throws(
      () =>
        runtime.registerExternalSource({
          kind: 'git',
          config: { repoPath: repo, pollSeconds: 0 },
        }),
      /pollSeconds/
    )
  } finally {
    cleanup()
  }
})
