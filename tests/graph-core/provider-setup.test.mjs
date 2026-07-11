import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProviderEnvText,
  providerEnvKeyIsSensitive,
  providerSetupProfileFingerprint,
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

  for (const changed of [
    { ...original, binaryPath: '/new/codex' },
    { ...original, homePath: '/new/home' },
    { ...original, shadowHomePath: '/new/shadow' },
    { ...original, launchArgs: ['--new'] },
    { ...original, env: { CODEX_FLAG: 'new' } },
  ]) {
    assert.notEqual(providerSetupProfileFingerprint(changed), originalKey);
  }
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
