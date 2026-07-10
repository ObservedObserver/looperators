import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KernelStore } from '../../dist-electron/electron/runtime/kernelStore.js';
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js';

function fakeBurstingCodexSource() {
  return `#!/usr/bin/env node
const readline = require('node:readline')
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'burst-thread' } } })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'burst-turn' } } })
    send({ method: 'turn/started', params: { turn: { id: 'burst-turn' } } })
    for (let index = 0; index < 40; index += 1) {
      send({
        method: 'item/agentMessage/delta',
        params: { itemId: 'burst-message', delta: String(index % 10) },
      })
    }
    setTimeout(() => {
      send({ method: 'turn/completed', params: { turnId: 'burst-turn' } })
      setTimeout(() => process.exit(0), 20)
    }, 250)
    return
  }
  send({ id: message.id, result: {} })
})
`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error('Timed out waiting for streaming persistence test state');
}

test('streaming bursts broadcast deltas and coalesce durable snapshots', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-stream-persist-'));
  const fakeCodex = path.join(tempRoot, 'codex');
  const storageFile = path.join(tempRoot, 'runtime-state.json');
  const project = path.join(tempRoot, 'project');
  const emittedEvents = [];
  let snapshotWrites = 0;
  const originalSaveSnapshot = KernelStore.prototype.saveSnapshot;

  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(fakeCodex, fakeBurstingCodexSource());
  fs.chmodSync(fakeCodex, 0o755);
  KernelStore.prototype.saveSnapshot = function countedSaveSnapshot(state) {
    snapshotWrites += 1;
    return originalSaveSnapshot.call(this, state);
  };

  let runtime;

  try {
    runtime = new RuntimeSessionManager({
      storageFile,
      broadcastRuntimeEvent: (event) => emittedEvents.push(event),
    });
    runtime.upsertProviderInstance({
      providerInstanceId: 'burst-codex',
      kind: 'codex',
      label: 'Burst Codex',
      binaryPath: fakeCodex,
    });
    const created = await runtime.createSession({
      prompt: 'stream quickly',
      providerInstanceId: 'burst-codex',
      cwd: project,
    });
    await waitFor(() => runtime.getState().sessions[created.sessionId]?.status === 'idle');

    const providerEvents = emittedEvents.filter((event) => event.type === 'provider.runtime');
    assert.ok(providerEvents.length >= 40);
    assert.equal(
      providerEvents.every((event) => !('state' in event)),
      true,
    );
    assert.ok(snapshotWrites <= 8, `${snapshotWrites} snapshots for ${providerEvents.length} provider events`);
    assert.match(runtime.getState().sessions[created.sessionId].messages.at(-1).content, /^0123456789/);
  } finally {
    runtime?.killAll();
    KernelStore.prototype.saveSnapshot = originalSaveSnapshot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
