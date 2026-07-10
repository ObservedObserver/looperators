import assert from 'node:assert/strict';
import test from 'node:test';

import { providerSetupProfileFingerprint, selectProviderSetupProfile } from '../../dist-electron/shared/provider-setup.js';

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
