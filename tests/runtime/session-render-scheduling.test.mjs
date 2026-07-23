import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const hookSource = fs.readFileSync(
  new URL('../../src/hooks/use-runtime-session-view.ts', import.meta.url),
  'utf8',
);
const timelineSource = fs.readFileSync(
  new URL('../../src/components/timeline.tsx', import.meta.url),
  'utf8',
);

test('Session streaming is scheduled as interruptible transition work', () => {
  assert.doesNotMatch(
    hookSource,
    /\buseSyncExternalStore\s*\(/,
    'external-store notifications force React SyncLane and can starve Canvas pointer events',
  );
  assert.match(hookSource, /\bstartTransition\b/);
  assert.match(hookSource, /subscribeSession\(sessionId, enqueueRender\)/);
});

test('the active streaming message avoids full Markdown parsing', () => {
  assert.match(timelineSource, /isStreaming \? \(/);
  assert.match(timelineSource, /whitespace-pre-wrap break-words/);
  assert.match(timelineSource, /<AgentMarkdown text=\{message\.content\} \/>/);
});
