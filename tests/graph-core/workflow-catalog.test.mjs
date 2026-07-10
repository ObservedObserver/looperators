import assert from 'node:assert/strict';
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
