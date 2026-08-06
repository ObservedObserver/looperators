import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  mergePathValues,
  resolveHostEnvironment,
} from '../../dist-electron/electron/runtime/hostEnvironment.js'
import {
  expandHomePath,
  resolveExecutable,
  resolveProviderLaunch,
} from '../../dist-electron/electron/runtime/providers/providerLaunch.js'
import { providerSetupStatusFromSnapshot } from '../../dist-electron/shared/provider-setup.js'

function completedExecFile(outputForCommand) {
  return (command, args, options, callback) => {
    queueMicrotask(() => {
      try {
        callback(null, outputForCommand(command, args, options), '')
      } catch (error) {
        callback(error, '', '')
      }
    })
    return { kill() {} }
  }
}

test('desktop environment prefers login-shell PATH and keeps inherited and native install locations', async () => {
  const home = path.join(os.tmpdir(), 'looperators-home')
  const loginBin = path.join(home, '.toolchain', 'bin')
  const inherited = ['/usr/bin', '/bin'].join(path.delimiter)
  const snapshot = await resolveHostEnvironment({
    env: { PATH: inherited, HOME: home, SHELL: '/bin/sh' },
    homedir: home,
    loginShell: '/bin/sh',
    platform: 'darwin',
    execFile: completedExecFile((command) => {
      assert.equal(command, '/bin/sh')
      return `noisy profile output\n__LOOPERATORS_PATH_START__${loginBin}${path.delimiter}/usr/bin\n__LOOPERATORS_PATH_END__\n`
    }),
  })

  assert.equal(snapshot.source, 'login-shell')
  assert.equal(snapshot.shell, '/bin/sh')
  assert.deepEqual(snapshot.path.split(path.delimiter).slice(0, 3), [loginBin, '/usr/bin', '/bin'])
  assert.ok(snapshot.path.split(path.delimiter).includes(path.join(home, '.local', 'bin')))
})

test('desktop environment falls back to launchctl when login shells cannot be read', async () => {
  const home = path.join(os.tmpdir(), 'looperators-launchctl-home')
  const launchctlBin = path.join(home, 'launchctl-bin')
  const snapshot = await resolveHostEnvironment({
    env: { PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/sh' },
    homedir: home,
    loginShell: '/bin/sh',
    platform: 'darwin',
    execFile: completedExecFile((command) => {
      if (command === '/bin/launchctl') return `${launchctlBin}:/usr/bin\n`
      throw new Error('shell profile failed')
    }),
  })

  assert.equal(snapshot.source, 'launchctl')
  assert.equal(snapshot.path.split(path.delimiter)[0], launchctlBin)
})

test('desktop environment bounds a stuck login shell with one deadline and falls back', async () => {
  const home = path.join(os.tmpdir(), 'looperators-stuck-shell-home')
  const launchctlBin = path.join(home, 'launchctl-bin')
  let shellKilled = false
  const startedAt = Date.now()
  const snapshot = await resolveHostEnvironment({
    env: { PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/sh' },
    homedir: home,
    loginShell: '/bin/sh',
    platform: 'darwin',
    timeoutMs: 90,
    execFile: (command, args, options, callback) => {
      if (command === '/bin/launchctl') {
        queueMicrotask(() => callback(null, `${launchctlBin}:/usr/bin\n`, ''))
      }
      return {
        kill(signal) {
          if (command === '/bin/sh' && signal === 'SIGKILL') shellKilled = true
        },
      }
    },
  })

  assert.equal(snapshot.source, 'launchctl')
  assert.equal(snapshot.path.split(path.delimiter)[0], launchctlBin)
  assert.equal(shellKilled, true)
  assert.ok(Date.now() - startedAt < 250)
})

test('PATH merging is stable and removes duplicate directories', () => {
  assert.equal(
    mergePathValues(['/custom:/usr/bin', '/usr/bin:/bin']),
    '/custom:/usr/bin:/bin',
  )
})

test('provider resolver uses one configured absolute executable and launch environment', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-provider-launch-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(fakeCodex, 0o755)
  try {
    const launch = resolveProviderLaunch('codex', {
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex',
      binaryPath: fakeCodex,
      launchArgs: ['--custom'],
      env: { LOOPERATORS_PROVIDER_TEST: 'yes' },
    })
    assert.equal(launch.available, true)
    assert.equal(launch.commandSource, 'profile')
    assert.equal(launch.command, fakeCodex)
    assert.equal(launch.resolvedCommand, fakeCodex)
    assert.deepEqual(launch.launchArgs, ['--custom'])
    assert.equal(launch.env.LOOPERATORS_PROVIDER_TEST, 'yes')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('provider resolver searches the hydrated PATH without invoking which', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-provider-path-'))
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(fakeClaude, 0o755)
  const previousPath = process.env.PATH
  const previousOverride = process.env.ORRERY_CLAUDE_BIN
  try {
    process.env.PATH = [tempRoot, '/usr/bin', '/bin'].join(path.delimiter)
    delete process.env.ORRERY_CLAUDE_BIN
    const launch = resolveProviderLaunch('claude-code')
    assert.equal(resolveExecutable('claude'), fakeClaude)
    assert.equal(launch.command, fakeClaude)
    assert.equal(launch.commandSource, 'path')
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousOverride === undefined) delete process.env.ORRERY_CLAUDE_BIN
    else process.env.ORRERY_CLAUDE_BIN = previousOverride
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('provider resolver normalizes relative and home PATH entries to absolute commands', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-provider-relative-path-'))
  const relativeBin = path.join(tempRoot, 'bin')
  const homeBin = path.join(tempRoot, 'home', 'tools')
  fs.mkdirSync(relativeBin, { recursive: true })
  fs.mkdirSync(homeBin, { recursive: true })
  const relativeCommand = path.join(relativeBin, 'codex')
  const homeCommand = path.join(homeBin, 'claude')
  fs.writeFileSync(relativeCommand, '#!/bin/sh\nexit 0\n')
  fs.writeFileSync(homeCommand, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(relativeCommand, 0o755)
  fs.chmodSync(homeCommand, 0o755)
  try {
    assert.equal(
      resolveExecutable('codex', { PATH: './bin' }, tempRoot),
      relativeCommand,
    )
    assert.equal(
      resolveExecutable('claude', { PATH: '"~/tools"', HOME: path.join(tempRoot, 'home') }, '/different/provider/cwd'),
      homeCommand,
    )
    assert.equal(path.isAbsolute(resolveExecutable('codex', { PATH: './bin' }, tempRoot)), true)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('home expansion is deterministic for provider profile paths', () => {
  assert.equal(expandHomePath('~/bin/codex', '/tmp/profile-home'), '/tmp/profile-home/bin/codex')
})

test('durable provider snapshots become stale exactly at their expiry boundary', () => {
  const snapshot = {
    profileFingerprint: 'profile',
    cwd: '/workspace',
    checkedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T00:05:00.000Z',
    status: { readiness: 'ready', source: 'live', stale: false },
  }
  assert.equal(
    providerSetupStatusFromSnapshot(snapshot, Date.parse('2026-08-06T00:04:59.999Z')).stale,
    false,
  )
  const stale = providerSetupStatusFromSnapshot(snapshot, Date.parse(snapshot.expiresAt))
  assert.equal(stale.stale, true)
  assert.equal(stale.source, 'snapshot')
})
