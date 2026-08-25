import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoopControlError, LoopController, rootContextFromMcpMessage } from '../lib/control.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controlPath = path.join(pluginRoot, 'lib', 'control.mjs');
const moduleDirectory = path.join(pluginRoot, 'lib', 'control');

const EXPECTED_CONTROLLER_METHODS = [
  'applyGovernorDecision',
  'bindWorker',
  'cancel',
  'getLoop',
  'getSnapshot',
  'interruptForFactLimit',
  'pause',
  'prepareWorkerSpawn',
  'preview',
  'previewLegacyRecovery',
  'quarantineLegacy',
  'report',
  'resume',
  'rollForwardPrepared',
  'snapshotForRun',
  'start',
];

test('control facade preserves the public controller contract', async () => {
  assert.equal(typeof LoopControlError, 'function');
  assert.equal(typeof rootContextFromMcpMessage, 'function');
  assert.deepEqual(
    Object.getOwnPropertyNames(LoopController.prototype)
      .filter((name) => name !== 'constructor')
      .sort(),
    EXPECTED_CONTROLLER_METHODS,
  );

  const facade = await readFile(controlPath, 'utf8');
  assert.ok(facade.split('\n').length <= 150, 'control.mjs must remain a thin compatibility facade');
  assert.deepEqual(Object.keys(await import(pathToFileURL(controlPath))).sort(), ['LoopControlError', 'LoopController', 'rootContextFromMcpMessage']);
});

test('control modules stay bounded, loadable, and acyclic', async () => {
  const files = (await readdir(moduleDirectory)).filter((name) => name.endsWith('.mjs')).sort();
  assert.ok(files.length >= 15, 'control responsibilities collapsed back into too few modules');

  const graph = new Map(files.map((name) => [name, []]));
  for (const file of files) {
    const source = await readFile(path.join(moduleDirectory, file), 'utf8');
    assert.ok(source.split('\n').length <= 500, `${file} exceeds the control module size boundary`);
    for (const match of source.matchAll(/from ['"]\.\/([^'"]+\.mjs)['"]/gu)) {
      if (graph.has(match[1])) graph.get(file).push(match[1]);
    }
  }

  const complete = new Set();
  const active = [];
  const visit = (file) => {
    const cycleStart = active.indexOf(file);
    assert.equal(cycleStart, -1, `control import cycle: ${[...active.slice(cycleStart), file].join(' -> ')}`);
    if (complete.has(file)) return;
    active.push(file);
    for (const dependency of graph.get(file)) visit(dependency);
    active.pop();
    complete.add(file);
  };
  for (const file of files) visit(file);

  await Promise.all(files.map((file) => import(pathToFileURL(path.join(moduleDirectory, file)))));
});
