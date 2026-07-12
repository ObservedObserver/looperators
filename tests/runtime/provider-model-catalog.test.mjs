import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeCodexCatalogModel } from '../../dist-electron/electron/runtime/providers/codexModelCatalogService.js';
import { normalizeClaudeCatalogModels } from '../../dist-electron/electron/runtime/providers/claudeModelCatalogService.js';
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
