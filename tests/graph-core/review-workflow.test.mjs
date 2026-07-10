import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockingCriteriaText,
  coderActivationInstruction,
  coderFixInstruction,
  reviewerActivationInstruction,
  validateReviewWorkflowStart,
} from '../../dist-electron/shared/review-workflow.js';

const newCoder = {
  kind: 'new',
  prompt: 'Implement the requested change.',
  cwd: '/tmp/project',
  workMode: 'local',
  providerKind: 'claude-code',
  providerInstanceId: 'claude',
  runtimeSettings: { runtimeMode: 'auto-accept-edits', model: 'coder-model' },
};

const newReviewer = {
  kind: 'new',
  instruction: 'Review against SPEC.md.',
  providerKind: 'codex',
  providerInstanceId: 'codex',
  runtimeSettings: { runtimeMode: 'approval-required', model: 'review-model', reasoningEffort: 'high' },
};

const base = {
  coder: newCoder,
  reviewer: newReviewer,
  blocking: { mode: 'p0-p1' },
  maxLaps: 6,
};

test('Review Workflow Draft validates all new/existing endpoint combinations and workspace compatibility', () => {
  const sessions = {
    coder: { sessionId: 'coder', cwd: '/tmp/project', status: 'idle' },
    reviewer: { sessionId: 'reviewer', cwd: '/tmp/project', status: 'failed' },
    elsewhere: { sessionId: 'elsewhere', cwd: '/tmp/other', status: 'idle' },
    busy: { sessionId: 'busy', cwd: '/tmp/project', status: 'running' },
  };
  const context = { sessions, providerInstanceIds: ['claude', 'codex'] };

  for (const input of [
    base,
    { ...base, coder: { kind: 'existing', sessionId: 'coder', prompt: 'continue' } },
    { ...base, reviewer: { kind: 'existing', sessionId: 'reviewer', instruction: 'review' } },
    {
      ...base,
      coder: { kind: 'existing', sessionId: 'coder', prompt: 'continue' },
      reviewer: { kind: 'existing', sessionId: 'reviewer', instruction: 'review' },
    },
  ]) {
    assert.equal(validateReviewWorkflowStart(input, context).ok, true);
  }

  assert.match(
    validateReviewWorkflowStart(
      {
        ...base,
        coder: { kind: 'existing', sessionId: 'coder', prompt: 'continue' },
        reviewer: { kind: 'existing', sessionId: 'elsewhere', instruction: 'review' },
      },
      context,
    )
      .issues.map((issue) => issue.message)
      .join(' '),
    /same workspace/,
  );
  assert.match(
    validateReviewWorkflowStart({ ...base, coder: { kind: 'existing', sessionId: 'busy', prompt: 'continue' } }, context)
      .issues.map((issue) => issue.message)
      .join(' '),
    /running/,
  );
  assert.match(
    validateReviewWorkflowStart(
      {
        ...base,
        coder: { kind: 'existing', sessionId: 'coder', prompt: 'continue' },
        reviewer: { kind: 'existing', sessionId: 'coder', instruction: 'review' },
      },
      context,
    ).issues.map((issue) => issue.message).join(' '),
    /different Agents/,
  );
});

test('provider/model settings stay independent in the single start payload', () => {
  const result = validateReviewWorkflowStart(base, {
    providerInstanceIds: ['claude', 'codex'],
  });
  assert.equal(result.ok, true);
  assert.equal(base.coder.providerInstanceId, 'claude');
  assert.equal(base.coder.runtimeSettings.model, 'coder-model');
  assert.equal(base.reviewer.providerInstanceId, 'codex');
  assert.equal(base.reviewer.runtimeSettings.model, 'review-model');
});

test('blocking modes compile into every Reviewer activation contract', () => {
  for (const [blocking, expected] of [
    [{ mode: 'any-issue' }, /Every actionable issue is blocking/],
    [{ mode: 'p0-p1' }, /Only P0 or P1 issues are blocking/],
    [{ mode: 'custom', customCriteria: 'security or data loss' }, /security or data loss/],
  ]) {
    assert.match(blockingCriteriaText(blocking), expected);
    const note = reviewerActivationInstruction('Read SPEC.md.', blocking);
    assert.match(note, expected);
    assert.match(note, /verdict "issues".*ONLY/s);
    assert.match(note, /verdict "clean"/);
  }
});

test('Coder instructions keep orchestration inside the preconfigured review pair', () => {
  const initial = coderActivationInstruction('Implement the requested change.');
  assert.match(initial, /already created and connected the Reviewer/);
  assert.match(initial, /Do not create, resume, deliver to, activate, link, or report for another Agent/);
  assert.match(initial, /Implement the requested change/);
  assert.match(initial, /finish your turn/);

  const fix = coderFixInstruction();
  assert.match(fix, /already owns the Reviewer and review relationships/);
  assert.match(fix, /Do not create, resume, deliver to, activate, link, or report for another Agent/);
  assert.match(fix, /request another review automatically/);
});

test('max laps and custom criteria are bounded before Run', () => {
  for (const maxLaps of [0, 100, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateReviewWorkflowStart({ ...base, maxLaps }).ok, false);
  }
  assert.equal(validateReviewWorkflowStart({ ...base, blocking: { mode: 'custom', customCriteria: ' ' } }).ok, false);
  assert.equal(validateReviewWorkflowStart({ ...base, maxLaps: 1 }).ok, true);
  assert.equal(validateReviewWorkflowStart({ ...base, maxLaps: 99 }).ok, true);
});
