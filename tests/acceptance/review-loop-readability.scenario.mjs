import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { deriveLoopProductView } from '../../dist-electron/shared/loop-product.js';
import { run as runColdStartReview } from './review-workflow-cold-start.scenario.mjs';

export const name = 'review-loop-readability';
export const description =
  'Interaction P2 clean-path acceptance: a real cold-start review loop finishes issues → fix → clean, then the product-facing view alone identifies the clean terminal state, lap count, participants, verdict, and stop reason.';
export const timeoutMs = 900_000;

export async function run(context) {
  await runColdStartReview(context);

  const state = await context.orrery.state();
  assert.equal(state.loops?.length, 1, 'the real review ring remains projectable after stop');
  const loop = state.loops[0];
  const { timeline } = await context.orrery.getLoopTimeline(loop.loopId);
  const product = deriveLoopProductView({
    loop,
    sessions: state.sessions,
    subscriptions: state.subscriptions,
    reports: state.reports,
    timeline,
  });

  assert.equal(product.phase, 'stopped-clean');
  assert.equal(product.lastVerdict, 'clean');
  assert.equal(product.canStop, false);
  assert.ok(product.coderSessionId);
  assert.ok(product.reviewerSessionId);
  assert.match(product.stopReason ?? '', /clean/i);
  assert.match(product.lapLabel, /^\d+\/4$/);

  fs.writeFileSync(
    path.join(context.artifactsDir, 'product-view.json'),
    JSON.stringify(product, null, 2),
  );
  context.log(`product view verified: ${product.headline} · ${product.lapLabel} · ${product.stopReason}`);
}
