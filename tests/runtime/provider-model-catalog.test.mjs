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
