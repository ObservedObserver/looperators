import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeCodexCatalogModel } from '../../dist-electron/electron/runtime/providers/codexModelCatalogService.js';
import {
  normalizeClaudeAuthStatus,
  normalizeClaudeCatalogModels,
  probeClaudeAuthStatus,
  probeClaudeProvider,
} from '../../dist-electron/electron/runtime/providers/claudeModelCatalogService.js';
import { fallbackProviderModelCatalog } from '../../dist-electron/shared/provider-model-catalog.js';
import { createEmptyGraphState } from '../../dist-electron/shared/graph-state.js';
import { normalizeState } from '../../dist-electron/electron/runtime/persistence/runtimeStateRecovery.js';
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js';

test('Codex catalog preserves provider ids, defaults, reasoning, and service tiers', () => {
  const model = normalizeCodexCatalogModel({
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Frontier coding model',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
    serviceTiers: [{ id: 'fast' }],
    defaultReasoningEffort: 'high',
    defaultServiceTier: 'fast',
  });

  assert.equal(model.modelId, 'gpt-5.6-sol');
  assert.equal(model.isDefault, true);
  assert.deepEqual(model.reasoningEfforts, ['high', 'ultra']);
  assert.deepEqual(model.serviceTiers, ['fast']);
  assert.equal(model.metadata.defaultReasoningEffort, 'high');
});

test('Claude catalog uses SDK values verbatim and removes the duplicate default alias', () => {
  const models = normalizeClaudeCatalogModels([
    { value: 'default', displayName: 'Default (recommended)', description: 'Provider default' },
    {
      value: 'opus[1m]',
      displayName: 'Opus',
      description: 'Long-context model',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'max'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
    },
  ]);

  assert.equal(models.length, 1);
  assert.equal(models[0].modelId, 'opus[1m]');
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'max']);
  assert.equal(models[0].metadata.supportsFastMode, true);
});

test('Claude auth status distinguishes signed-in, signed-out, and external providers', () => {
  assert.deepEqual(
    normalizeClaudeAuthStatus({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'dev@example.com',
    }),
    { status: 'authenticated', method: 'claude.ai', accountLabel: 'dev@example.com' },
  );
  assert.deepEqual(
    normalizeClaudeAuthStatus({ loggedIn: false }),
    { status: 'unauthenticated' },
  );
  assert.deepEqual(
    normalizeClaudeAuthStatus(
      { loggedIn: false },
      { CLAUDE_CODE_USE_BEDROCK: '1' },
    ),
    { status: 'external', method: 'Amazon Bedrock' },
  );
  assert.equal(normalizeClaudeAuthStatus({}, {}).status, 'unknown');
});

function createClaudeProbeFixture(authPayload, authExitCode = 0) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-claude-auth-'));
  const fakeClaude = path.join(tempRoot, 'claude');
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.0'
  exit 0
fi
if [ "$1 $2 $3" = "auth status --json" ]; then
  printf '%s' '${JSON.stringify(authPayload).replaceAll("'", "'\\\"'\\\"'")}'
  exit ${authExitCode}
fi
exit 2
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  return {
    tempRoot,
    providerInstance: {
      providerInstanceId: `claude-auth-${Date.now()}-${Math.random()}`,
      kind: 'claude-code',
      label: 'Claude auth fixture',
      binaryPath: fakeClaude,
    },
  };
}

test('Claude auth command treats logged-out JSON as unauthenticated even with a nonzero exit', async () => {
  const fixture = createClaudeProbeFixture({ loggedIn: false }, 1);
  try {
    const auth = await probeClaudeAuthStatus({
      providerInstance: fixture.providerInstance,
      cwd: fixture.tempRoot,
    });
    assert.deepEqual(auth, { status: 'unauthenticated' });
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('Claude auth command rejects contradictory authenticated JSON with a nonzero exit', async () => {
  const fixture = createClaudeProbeFixture({ loggedIn: true, apiProvider: 'firstParty' }, 1);
  try {
    await assert.rejects(
      () => probeClaudeAuthStatus({
        providerInstance: fixture.providerInstance,
        cwd: fixture.tempRoot,
      }),
      /auth status exited with code 1/,
    );
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('Claude provider keeps auth evidence but reports a bounded SDK initialization timeout', async () => {
  const fixture = createClaudeProbeFixture({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'dev@example.com',
  });
  let closed = false;
  try {
    const result = await probeClaudeProvider({
      providerInstance: fixture.providerInstance,
      cwd: fixture.tempRoot,
      totalTimeoutMs: 500,
      forceRefresh: true,
      queryFactory: () => ({
        initializationResult: () => new Promise(() => {}),
        close: () => { closed = true; },
      }),
    });
    assert.equal(result.auth.status, 'authenticated');
    assert.match(result.protocolError, /Timed out initializing Claude Code/);
    assert.equal(result.protocolChecked, true);
    assert.equal(closed, true);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('offline fallback is explicit, stale, and never invents a Codex model', () => {
  const catalog = fallbackProviderModelCatalog('codex', 'default-codex', 'offline');
  assert.equal(catalog.source, 'fallback');
  assert.equal(catalog.stale, true);
  assert.deepEqual(catalog.availableModels, []);
  assert.equal(catalog.error, 'offline');
});

test('RuntimeSessionManager persists a live Codex catalog and keeps it stale on refresh failure', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-catalog-'));
  const fakeCodex = path.join(tempRoot, 'codex');
  const launchMarker = path.join(tempRoot, 'launches');
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(launchMarker)}, '1')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'codex/1.0.0' } }) + '\\n')
    } else if (message.method === 'account/read') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt', email: 'dev@example.com' }, requiresOpenaiAuth: true } }) + '\\n')
    } else if (message.method === 'model/list') {
      const second = message.params?.cursor === 'page-2'
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: second
          ? { data: [{ model: 'gpt-5.5', displayName: 'GPT-5.5', supportedReasoningEfforts: [], isDefault: false }], nextCursor: null }
          : { data: [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], isDefault: true }], nextCursor: 'page-2' },
      }) + '\\n')
    }
  }
})
`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const runtime = new RuntimeSessionManager({
    storageFile: path.join(tempRoot, 'runtime-state.json'),
  });
  try {
    runtime.upsertProviderInstance({
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Fake Codex',
      binaryPath: fakeCodex,
    });
    const [live] = await Promise.all([
      runtime.getProviderSetupStatus({
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
        cwd: tempRoot,
        forceRefresh: true,
      }),
      runtime.getProviderSetupStatus({
        providerKind: 'codex',
        providerInstanceId: 'default-codex',
        cwd: tempRoot,
        forceRefresh: true,
      }),
    ]);
    assert.equal(live.models.source, 'live');
    assert.equal(live.readiness, 'ready');
    assert.equal(live.auth.status, 'authenticated');
    assert.equal(live.auth.accountLabel, 'dev@example.com');
    assert.equal(live.version, 'codex/1.0.0');
    assert.equal(live.command.resolved, fakeCodex);
    assert.equal(live.models.defaultModelId, 'gpt-5.6-sol');
    assert.deepEqual(
      live.models.availableModels.map((model) => model.modelId),
      ['gpt-5.6-sol', 'gpt-5.5'],
    );
    assert.equal(fs.readFileSync(launchMarker, 'utf8'), '1');
    assert.equal(runtime.getState().providerModelCatalogs['default-codex'].source, 'live');

    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(fakeCodex, 0o755);
    const stale = await runtime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      cwd: tempRoot,
      forceRefresh: true,
    });
    assert.equal(stale.models.source, 'cache');
    assert.equal(stale.models.stale, true);
    assert.equal(stale.models.availableModels[0].modelId, 'gpt-5.6-sol');
  } finally {
    runtime.killAll();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function codexStatusForAccountResult(accountResult) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-codex-auth-'));
  const fakeCodex = path.join(tempRoot, 'codex');
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'codex/test-auth' } }) + '\\n')
    } else if (message.method === 'account/read') {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${JSON.stringify(accountResult)} }) + '\\n')
    } else if (message.method === 'model/list') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ model: 'local-model', displayName: 'Local model', isDefault: true }], nextCursor: null } }) + '\\n')
    }
  }
})
`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const runtime = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') });
  runtime.upsertProviderInstance({
    providerInstanceId: 'default-codex',
    kind: 'codex',
    label: 'Auth fixture',
    binaryPath: fakeCodex,
  });
  return {
    tempRoot,
    runtime,
    status: await runtime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      cwd: tempRoot,
      forceRefresh: true,
    }),
  };
}

test('Codex setup accepts custom providers that do not require OpenAI authentication', async () => {
  const fixture = await codexStatusForAccountResult({ account: null, requiresOpenaiAuth: false });
  try {
    assert.equal(fixture.status.readiness, 'ready');
    assert.equal(fixture.status.auth.status, 'not-required');
    assert.equal(fixture.status.models.availableModels[0].modelId, 'local-model');
    assert.equal(fixture.status.checks.find((check) => check.id === 'auth')?.status, 'ok');
  } finally {
    fixture.runtime.killAll();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('Codex setup reports sign-in required without starting a model request', async () => {
  const fixture = await codexStatusForAccountResult({ account: null, requiresOpenaiAuth: true });
  try {
    assert.equal(fixture.status.readiness, 'needs-attention');
    assert.equal(fixture.status.auth.status, 'unauthenticated');
    assert.equal(fixture.status.checks.find((check) => check.id === 'auth')?.status, 'error');
    assert.equal(fixture.status.checks.find((check) => check.id === 'protocol')?.status, 'ok');
  } finally {
    fixture.runtime.killAll();
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('provider readiness snapshots persist across restart and profile edits invalidate them', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-provider-snapshot-'));
  const storageFile = path.join(tempRoot, 'runtime-state.json');
  const fakeCodex = path.join(tempRoot, 'codex');
  const launchMarker = path.join(tempRoot, 'launches');
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(launchMarker)}, '1')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'codex/snapshot-test' } }) + '\\n')
    } else if (message.method === 'account/read') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } }) + '\\n')
    } else if (message.method === 'model/list') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ model: 'snapshot-model', displayName: 'Snapshot model', isDefault: true }], nextCursor: null } }) + '\\n')
    }
  }
})
`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const providerInstance = {
    providerInstanceId: 'snapshot-codex',
    kind: 'codex',
    label: 'Snapshot Codex',
    binaryPath: fakeCodex,
  };
  const firstRuntime = new RuntimeSessionManager({ storageFile });
  try {
    firstRuntime.upsertProviderInstance(providerInstance);
    const live = await firstRuntime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      cwd: tempRoot,
      forceRefresh: true,
    });
    assert.equal(live.source, 'live');
    assert.equal(live.stale, false);
    assert.equal(live.readiness, 'ready');
    assert.equal(live.diagnostics.profile.label, 'Snapshot Codex');
    assert.equal(live.diagnostics.profile.environmentKeys.length, 0);
    assert.equal(typeof live.durationMs, 'number');
    assert.equal(firstRuntime.getState().providerSetupSnapshots['snapshot-codex'].status.version, 'codex/snapshot-test');
  } finally {
    await firstRuntime.killAll();
  }

  const secondRuntime = new RuntimeSessionManager({ storageFile });
  try {
    const beforeLaunches = fs.readFileSync(launchMarker, 'utf8');
    const cached = await secondRuntime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      cwd: tempRoot,
    });
    assert.equal(cached.source, 'snapshot');
    assert.equal(cached.stale, false);
    assert.equal(cached.readiness, 'ready');
    assert.equal(fs.readFileSync(launchMarker, 'utf8'), beforeLaunches);

    secondRuntime.upsertProviderInstance({ ...providerInstance, label: 'Renamed Snapshot Codex' });
    assert.equal(secondRuntime.getState().providerSetupSnapshots['snapshot-codex'], undefined);
    assert.equal(secondRuntime.getState().providerModelCatalogs['snapshot-codex'], undefined);
  } finally {
    await secondRuntime.killAll();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('provider readiness does not restore a snapshot with an invalid status schema', () => {
  const state = createEmptyGraphState();
  state.providerSetupSnapshots['default-codex'] = {
    profileFingerprint: 'profile-v1-deadbeefdeadbeef',
    cwd: '/workspace',
    checkedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T00:05:00.000Z',
    status: {
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      generatedAt: '2026-08-06T00:00:00.000Z',
    },
  };

  assert.deepEqual(normalizeState(state).providerSetupSnapshots, {});
});

test('provider readiness recovery reapplies snapshot sanitization', () => {
  const state = createEmptyGraphState();
  const profileFingerprint = 'profile-v1-deadbeefdeadbeef';
  state.providerSetupSnapshots['default-codex'] = {
    profileFingerprint,
    cwd: '/workspace',
    checkedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T00:05:00.000Z',
    status: {
      providerKind: 'codex',
      providerInstanceId: 'default-codex',
      profileFingerprint,
      cwd: '/workspace',
      generatedAt: '2026-08-06T00:00:00.000Z',
      auth: { status: 'authenticated', accountLabel: 'private@example.com' },
      checks: [{ id: 'auth', label: 'Auth/account', status: 'ok', message: 'private@example.com', detail: 'private-detail' }],
    },
  };

  const serialized = JSON.stringify(normalizeState(state).providerSetupSnapshots);
  assert.match(serialized, /cached readiness check/);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.equal(serialized.includes('private-detail'), false);
});

test('newer cached scope and profile edits both prevent slow readiness writeback', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'looperators-provider-probe-race-'));
  const fakeCodex = path.join(tempRoot, 'codex');
  const launchMarker = path.join(tempRoot, 'started');
  const cwdA = path.join(tempRoot, 'workspace-a');
  const cwdB = path.join(tempRoot, 'workspace-b');
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(launchMarker)}, '1')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const send = (result) => process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
    if (message.method === 'initialize') {
      setTimeout(() => send({ userAgent: 'codex/slow-probe' }), 150)
    } else if (message.method === 'account/read') {
      send({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
    } else if (message.method === 'model/list') {
      send({ data: [{ model: 'slow-model', displayName: 'Slow model', isDefault: true }], nextCursor: null })
    }
  }
})
`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const runtime = new RuntimeSessionManager({ storageFile: path.join(tempRoot, 'state.json') });
  const providerInstance = {
    providerInstanceId: 'race-codex',
    kind: 'codex',
    label: 'Race Codex',
    binaryPath: fakeCodex,
  };
  try {
    runtime.upsertProviderInstance(providerInstance);
    await runtime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      cwd: cwdB,
      forceRefresh: true,
    });
    const oldScopePromise = runtime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      cwd: cwdA,
      forceRefresh: true,
    });
    let deadline = Date.now() + 2_000;
    while ((!fs.existsSync(launchMarker) || fs.readFileSync(launchMarker, 'utf8').length < 2) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cached = await runtime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      cwd: cwdB,
    });
    assert.equal(cached.source, 'snapshot');
    await assert.rejects(oldScopePromise, /newer readiness check.*superseded/i);
    assert.equal(runtime.getState().providerSetupSnapshots[providerInstance.providerInstanceId].cwd, cwdB);

    const changedProfilePromise = runtime.getProviderSetupStatus({
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      cwd: cwdB,
      forceRefresh: true,
    });
    deadline = Date.now() + 2_000;
    while (fs.readFileSync(launchMarker, 'utf8').length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runtime.upsertProviderInstance({ ...providerInstance, env: { SAFE_FLAG: 'new-profile' } });

    await assert.rejects(changedProfilePromise, /Provider profile changed while its readiness check was running/);
    assert.equal(runtime.getState().providerSetupSnapshots[providerInstance.providerInstanceId], undefined);
    assert.equal(runtime.getState().providerModelCatalogs[providerInstance.providerInstanceId], undefined);
  } finally {
    await runtime.killAll();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
