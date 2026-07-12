import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { partitionWorkflowIds, primaryWorkflowCatalog, primaryWorkflowIds, workflowEmptyState } from '../../dist-electron/shared/workflow-catalog.js';
import { builtinTemplates } from '../../dist-electron/shared/templates.js';

test('the first-run workflow catalog exposes the three golden entries in product order', () => {
  assert.deepEqual(
    primaryWorkflowCatalog.map((entry) => entry.id),
    [...primaryWorkflowIds],
  );
  assert.deepEqual(
    primaryWorkflowCatalog.map((entry) => entry.name),
    ['Review until clean', 'Handoff', 'Run until goal'],
  );
});

test('every golden workflow entry is backed by a runtime template', () => {
  const runtimeIds = new Set(builtinTemplates.map((template) => template.id));
  for (const entry of primaryWorkflowCatalog) {
    assert.equal(runtimeIds.has(entry.id), true, `${entry.id} must exist in the runtime template registry`);
  }
  assert.deepEqual(partitionWorkflowIds(builtinTemplates.map((template) => template.id)).primary, [...primaryWorkflowIds]);
});

test('primary workflow copy explains outcomes without kernel vocabulary', () => {
  const copy = primaryWorkflowCatalog.flatMap((entry) => [entry.name, entry.summary, entry.needs, entry.result]).join(' ');
  for (const internalTerm of ['subscription', 'gate', 'concurrency', 'causeId', 'cluster', 'master']) {
    assert.doesNotMatch(copy, new RegExp(internalTerm, 'i'));
  }
});

test('catalog routing keeps golden entries first and moves the rest to More workflows', () => {
  assert.deepEqual(partitionWorkflowIds(['scheduled-routine', 'goal-loop', 'tpl-team', 'handoff', 'review-until-clean', 'watch-and-summarize']), {
    primary: ['review-until-clean', 'handoff', 'goal-loop'],
    more: ['scheduled-routine', 'tpl-team', 'watch-and-summarize'],
  });
});

test('empty graph decisions always offer Chat before Workflow', () => {
  assert.deepEqual(workflowEmptyState(0), {
    show: true,
    actions: ['start-chat', 'build-workflow'],
  });
  assert.equal(workflowEmptyState(1).show, false);
  assert.equal(workflowEmptyState(8).show, false);
});

test('legacy shortcuts do not compete with the three golden workflow composers', () => {
  const chat = fs.readFileSync(new URL('../../src/components/chat-detail.tsx', import.meta.url), 'utf8');
  const catalog = fs.readFileSync(new URL('../../src/components/template-library.tsx', import.meta.url), 'utf8');
  const advanced = fs.readFileSync(new URL('../../src/components/orchestrate-panel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(chat, /GoalLoopButton/);
  assert.match(catalog, /ClassicWorkflowComposer/);
  assert.match(catalog, /Save this workflow/);
  const classicComposer = fs.readFileSync(new URL('../../src/components/classic-workflow-composer.tsx', import.meta.url), 'utf8');
  const reviewComposer = fs.readFileSync(new URL('../../src/components/review-workflow-composer.tsx', import.meta.url), 'utf8');
  assert.match(classicComposer, /initialInput as GoalWorkflowStartInput[^\n]+\?\.judgeProviderInstanceId/);
  assert.match(classicComposer, /judgeProviderInstanceId \? \{ judgeProviderInstanceId \}/);
  assert.match(classicComposer, /judgeModel\.trim\(\) \? \{ judgeModel:/);
  assert.match(classicComposer, /model: ''/);
  assert.doesNotMatch(classicComposer, /modelOptionsForKind\(providerKind\)\[0\]/);
  assert.match(reviewComposer, /label: endpoint\.label \?\? fallback\.label/);
  assert.match(reviewComposer, /label: coder\.label/);
  assert.match(reviewComposer, /label: reviewer\.label/);
  assert.match(classicComposer, /initialPayloadRef\.current = JSON\.stringify\(payload\);\s+onDirtyChange\(false\)/);
  assert.match(reviewComposer, /initialPayloadRef\.current = JSON\.stringify\(payload\);\s+onDirtyChange\(false\)/);
  assert.match(advanced, /Governed loop policy/);
  assert.doesNotMatch(advanced, />Review until clean</);
});

test('Handoff and Goal share the provider/workspace preflight gate', () => {
  const classicComposer = fs.readFileSync(new URL('../../src/components/classic-workflow-composer.tsx', import.meta.url), 'utf8');
  assert.match(classicComposer, /runtimeApi\s*\.getProviderSetupStatus/);
  assert.match(classicComposer, /runtimeApi\s*\.getProjectContext/);
  assert.match(classicComposer, /\[preflightKey, runtimeApi\]/);
  assert.doesNotMatch(classicComposer, /\[preflightKey, preflightTargets, runtimeApi\]/);
  assert.match(classicComposer, /role: 'Judge'/);
  assert.match(classicComposer, /setupMessages\.length > 0 \|\| preflightPending \|\| isStarting/);
  assert.match(classicComposer, /Open Provider settings or choose a valid workspace, then retry/);
  assert.match(classicComposer, /Resolve the reported provider, workspace, or Agent state, then retry Run workflow/);
});
