import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProviderEnvText,
  providerEnvKeyIsSensitive,
  providerSetupProfileFingerprint,
  providerSetupSafeDiagnostics,
  providerSetupSnapshotMatchesProfile,
  providerSetupStatusForSnapshot,
  providerSetupStatusFromSnapshot,
  selectProviderSetupProfile,
} from '../../dist-electron/shared/provider-setup.js';
import {
  nextProviderKind,
  providerKindForOrdinal,
} from '../../dist-electron/shared/provider-metadata.js';

test('provider defaults rotate through Claude, Codex, and Grok without a binary fallback', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(providerKindForOrdinal),
    ['claude-code', 'codex', 'grok', 'claude-code'],
  );
  assert.equal(nextProviderKind('claude-code'), 'codex');
  assert.equal(nextProviderKind('codex'), 'grok');
  assert.equal(nextProviderKind('grok'), 'claude-code');
});

test('provider setup selects the exact profile when multiple instances share a kind', () => {
  const instances = [
    { providerInstanceId: 'codex-primary', kind: 'codex', binaryPath: '/bin/codex-primary' },
    { providerInstanceId: 'codex-reviewer', kind: 'codex', binaryPath: '/bin/codex-reviewer' },
  ];

  assert.equal(selectProviderSetupProfile(instances, 'codex', 'codex-reviewer'), instances[1]);
  assert.equal(selectProviderSetupProfile(instances, 'codex', 'missing-profile'), undefined);
});

test('provider setup request fingerprint changes after any launch-relevant profile edit', () => {
  const original = {
    providerInstanceId: 'codex-reviewer',
    kind: 'codex',
    binaryPath: '/old/codex',
    homePath: '/old/home',
    shadowHomePath: '/old/shadow',
    launchArgs: ['--old'],
    env: { CODEX_FLAG: 'old' },
  };
  const originalKey = providerSetupProfileFingerprint(original);
  assert.match(originalKey, /^profile-v1-[0-9a-f]{16}$/);
  for (const privateValue of ['/old/codex', '/old/home', '/old/shadow', '--old', 'old']) {
    assert.equal(originalKey.includes(privateValue), false);
  }

  for (const changed of [
    { ...original, label: 'Renamed reviewer' },
    { ...original, binaryPath: '/new/codex' },
    { ...original, homePath: '/new/home' },
    { ...original, shadowHomePath: '/new/shadow' },
    { ...original, launchArgs: ['--new'] },
    { ...original, env: { CODEX_FLAG: 'new' } },
  ]) {
    assert.notEqual(providerSetupProfileFingerprint(changed), originalKey);
  }
});

test('provider setup snapshots only match the exact profile and project cwd', () => {
  const profile = {
    providerInstanceId: 'codex-reviewer',
    kind: 'codex',
    binaryPath: '/bin/codex',
  };
  const snapshot = {
    profileFingerprint: providerSetupProfileFingerprint(profile),
    cwd: '/workspace/one',
    checkedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T00:05:00.000Z',
    status: {},
  };

  assert.equal(providerSetupSnapshotMatchesProfile(snapshot, profile, '/workspace/one'), true);
  assert.equal(providerSetupSnapshotMatchesProfile(snapshot, { ...profile, label: 'Renamed' }, '/workspace/one'), false);
  assert.equal(providerSetupSnapshotMatchesProfile(snapshot, profile, '/workspace/two'), false);
  assert.equal(providerSetupStatusFromSnapshot(snapshot, Date.parse(snapshot.expiresAt) - 1).stale, false);
  assert.equal(providerSetupStatusFromSnapshot(snapshot, Date.parse(snapshot.expiresAt)).stale, true);
});

test('provider env text accepts non-secret values and rejects credential-like keys', () => {
  assert.deepEqual(parseProviderEnvText('PROFILE=local\nFEATURE_FLAG=1'), {
    PROFILE: 'local',
    FEATURE_FLAG: '1',
  });
  assert.equal(providerEnvKeyIsSensitive('XAI_API_KEY'), true);
  assert.equal(providerEnvKeyIsSensitive('ACCESS_TOKEN'), true);
  assert.throws(() => parseProviderEnvText('ACCESS_TOKEN=secret'), /looks sensitive/);
  assert.throws(() => parseProviderEnvText('not valid'), /KEY=value/);
});

test('copied provider diagnostics omit account labels, environment values, and raw errors', () => {
  const safe = providerSetupSafeDiagnostics({
    providerKind: 'codex',
    providerInstanceId: 'codex-work',
    profileFingerprint: 'profile-v1-private',
    cwd: '/Users/private/workspace',
    generatedAt: '2026-08-06T00:00:00.000Z',
    readiness: 'ready',
    command: { requested: 'codex', resolved: '/safe/bin/codex', source: 'path' },
    auth: { status: 'authenticated', method: 'chatgpt', accountLabel: 'private@example.com' },
    models: { source: 'cache', stale: true, availableModels: [{ modelId: 'model' }], error: 'secret-model-error' },
    diagnostics: {
      hostEnvironment: { source: 'login-shell', shell: '/bin/zsh', pathEntryCount: 8, path: 'secret-path' },
      profile: {
        label: 'Work',
        commandSource: 'path',
        binaryOverride: false,
        homeOverride: false,
        shadowHomeOverride: false,
        launchArgumentCount: 0,
        environmentKeys: ['SAFE_FLAG'],
        environmentValues: ['secret-env-value'],
      },
    },
    checks: [{ id: 'auth', status: 'ok', message: 'private@example.com', detail: 'secret-detail' }],
  });
  const serialized = JSON.stringify(safe);

  assert.match(serialized, /SAFE_FLAG/);
  assert.match(serialized, /\/safe\/bin\/codex/);
  for (const secret of ['private@example.com', 'profile-v1-private', '/Users/private/workspace', 'secret-model-error', 'secret-path', 'secret-env-value', 'secret-detail']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('persisted provider readiness omits account labels and raw probe details', () => {
  const snapshotStatus = providerSetupStatusForSnapshot({
    providerKind: 'codex',
    providerInstanceId: 'codex-work',
    profileFingerprint: 'profile-v1-deadbeefdeadbeef',
    cwd: '/workspace',
    generatedAt: '2026-08-06T00:00:00.000Z',
    auth: { status: 'authenticated', method: 'chatgpt', accountLabel: 'private@example.com' },
    models: { source: 'cache', stale: true, availableModels: [], error: 'secret-model-error' },
    checks: [{ id: 'auth', label: 'Auth/account', status: 'error', message: 'private@example.com', detail: 'secret-detail' }],
  });
  const serialized = JSON.stringify(snapshotStatus);

  assert.match(serialized, /cached readiness check/);
  assert.match(serialized, /profile-v1-deadbeefdeadbeef/);
  for (const secret of ['private@example.com', 'secret-model-error', 'secret-detail']) {
    assert.equal(serialized.includes(secret), false);
  }
});
