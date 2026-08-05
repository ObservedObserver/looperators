import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const embedScript = new URL(
  '../dist/embed/agent-graph-ui.iife.js',
  import.meta.url,
);
const embedStyle = new URL('../dist/embed/agent-graph-ui.css', import.meta.url);
const libraryScript = new URL(
  '../dist/library/agent-graph-ui.js',
  import.meta.url,
);
const inlineScript = new URL(
  '../dist/inline/agent-graph-ui-inline.js',
  import.meta.url,
);
const inlineStyle = new URL(
  '../dist/inline/agent-graph-ui-inline.css',
  import.meta.url,
);

test('plugin-target assets leave at least 512 KiB of inline fragment headroom', async () => {
  const [scriptStat, styleStat] = await Promise.all([
    stat(embedScript),
    stat(embedStyle),
  ]);
  const total = scriptStat.size + styleStat.size;
  assert.ok(total < 1.5 * 1024 * 1024, `embed assets are ${total} bytes`);
});

test('shipped assets contain no remote or plugin runtime dependency', async () => {
  const [script, style, library, inline, inlineCss] = await Promise.all([
    readFile(embedScript, 'utf8'),
    readFile(embedStyle, 'utf8'),
    readFile(libraryScript, 'utf8'),
    readFile(inlineScript, 'utf8'),
    readFile(inlineStyle, 'utf8'),
  ]);
  for (const source of [script, style]) {
    // Bundled React and SVG metadata contain inert namespace, help, and
    // attribution URLs. Network isolation is asserted in the browser
    // acceptance; this static guard rejects executable network primitives.
    assert.doesNotMatch(source, /\b(?:window|globalThis)\.fetch\s*\(/u);
    assert.doesNotMatch(source, /\bXMLHttpRequest\b/u);
    assert.doesNotMatch(source, /\bWebSocket\b/u);
    assert.doesNotMatch(source, /\bEventSource\b/u);
  }
  assert.doesNotMatch(library, /electron|sessionManager|workflowKernel/u);
  assert.doesNotMatch(library, /from\s*["']@\//u);
  assert.match(script, /looperatorsAgentGraphView/u);
  assert.match(inline, /mountInlineAgentLoopGraph/u);
  assert.match(inline, /Agent Loop relationship graph/u);
  assert.match(inlineCss, /looperators-inline-agent-graph/u);
  assert.doesNotMatch(inline, /\bResizeObserver\b/u);
  assert.doesNotMatch(inline, /\bcreateRoot\b/u);
  assert.doesNotMatch(inline, /react-flow__node/u);
});
