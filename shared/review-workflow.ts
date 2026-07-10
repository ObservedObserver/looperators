export const reviewBlockingModes = ['any-issue', 'p0-p1', 'custom'] as const;

export type ReviewBlockingMode = (typeof reviewBlockingModes)[number];

export type ReviewRuntimeSettings = {
  runtimeMode: 'approval-required' | 'auto-accept-edits' | 'full-access';
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
};

export type ReviewNewCoderEndpoint = {
  kind: 'new';
  label?: string;
  prompt: string;
  cwd: string;
  workMode: 'local' | 'worktree';
  branch?: string;
  providerKind: 'claude-code' | 'codex' | 'legacy-claude-cli';
  providerInstanceId: string;
  runtimeSettings: ReviewRuntimeSettings;
};

export type ReviewExistingCoderEndpoint = {
  kind: 'existing';
  sessionId: string;
  prompt: string;
};

export type ReviewNewReviewerEndpoint = {
  kind: 'new';
  label?: string;
  instruction: string;
  providerKind: 'claude-code' | 'codex' | 'legacy-claude-cli';
  providerInstanceId: string;
  runtimeSettings: ReviewRuntimeSettings;
};

export type ReviewExistingReviewerEndpoint = {
  kind: 'existing';
  sessionId: string;
  instruction: string;
};

export type ReviewWorkflowStartInput = {
  coder: ReviewNewCoderEndpoint | ReviewExistingCoderEndpoint;
  reviewer: ReviewNewReviewerEndpoint | ReviewExistingReviewerEndpoint;
  blocking: {
    mode: ReviewBlockingMode;
    customCriteria?: string;
  };
  maxLaps: number;
};

export type ReviewWorkflowSessionSummary = {
  sessionId: string;
  cwd: string;
  status: string;
  frozen?: boolean;
};

export type ReviewWorkflowValidationContext = {
  sessions?: Record<string, ReviewWorkflowSessionSummary>;
  providerInstanceIds?: string[];
};

export type ReviewWorkflowValidationIssue = {
  field: string;
  message: string;
};

function trimmed(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function blockingCriteriaText(blocking: ReviewWorkflowStartInput['blocking']) {
  if (blocking.mode === 'any-issue') {
    return 'Every actionable issue is blocking, regardless of severity.';
  }
  if (blocking.mode === 'p0-p1') {
    return 'Only P0 or P1 issues are blocking. P2, P3, suggestions, and nits must not keep the loop running.';
  }
  return `Only issues matching this user-defined criterion are blocking: ${trimmed(blocking.customCriteria)}`;
}

export function reviewerActivationInstruction(instruction: string, blocking: ReviewWorkflowStartInput['blocking']) {
  return [
    'Review the latest implementation and workspace diff delivered in your context channel (file paths are listed below).',
    trimmed(instruction),
    '',
    `Blocking rule: ${blockingCriteriaText(blocking)}`,
    'Do not edit files. Classify findings before deciding the verdict.',
    'Call mcp__orrery_membrane__report exactly once with type "verdict":',
    '- verdict "issues" with an issues array ONLY when at least one finding matches the blocking rule;',
    '- verdict "clean" when no finding matches the blocking rule, even if non-blocking suggestions remain.',
    'Each issue must include a concrete message and should include severity (P0, P1, P2, or P3), file, and line when known. Then stop.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

export function reviewerBootstrapInstruction(instruction: string) {
  return [
    'You are the Reviewer in an Orrery Review until clean workflow.',
    trimmed(instruction),
    'You will run only after the Coder finishes and Orrery delivers the latest artifacts. Do not edit files.',
  ].join('\n');
}

export function coderActivationInstruction(prompt: string) {
  return [
    'You are the Coder in a preconfigured Orrery Review until clean workflow.',
    'Orrery has already created and connected the Reviewer. Do not create, resume, deliver to, activate, link, or report for another Agent; Orrery will request each review automatically after you finish.',
    '',
    trimmed(prompt),
    '',
    'Implement and verify the requested change, then finish your turn. Do not run or request a review yourself.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

export function coderFixInstruction() {
  return [
    'The Reviewer found blocking issues. Its typed report and artifacts are delivered in your context channel (file paths are listed below).',
    'Orrery already owns the Reviewer and review relationships. Do not create, resume, deliver to, activate, link, or report for another Agent.',
    'Fix every blocking issue, verify the result, then finish your turn so Orrery can request another review automatically.',
  ].join('\n');
}

export function validateReviewWorkflowStart(input: ReviewWorkflowStartInput, context: ReviewWorkflowValidationContext = {}) {
  const issues: ReviewWorkflowValidationIssue[] = [];
  const providerIds = new Set(context.providerInstanceIds ?? []);

  if (!input || (input.coder?.kind !== 'new' && input.coder?.kind !== 'existing')) {
    issues.push({ field: 'coder', message: 'Choose or create a Coder Agent.' });
  } else {
    if (!trimmed(input.coder.prompt)) {
      issues.push({ field: 'coder.prompt', message: 'Add the work prompt for the Coder.' });
    }
    if (input.coder.kind === 'new') {
      if (!trimmed(input.coder.cwd)) {
        issues.push({ field: 'coder.cwd', message: 'Choose a workspace for the Coder.' });
      }
      if (!trimmed(input.coder.providerInstanceId)) {
        issues.push({ field: 'coder.providerInstanceId', message: 'Choose a Coder provider.' });
      } else if (providerIds.size > 0 && !providerIds.has(input.coder.providerInstanceId)) {
        issues.push({ field: 'coder.providerInstanceId', message: 'The selected Coder provider is unavailable.' });
      }
    } else {
      validateExisting('coder', input.coder.sessionId, context, issues);
    }
  }

  if (!input || (input.reviewer?.kind !== 'new' && input.reviewer?.kind !== 'existing')) {
    issues.push({ field: 'reviewer', message: 'Choose or create a Reviewer Agent.' });
  } else {
    if (!trimmed(input.reviewer.instruction)) {
      issues.push({ field: 'reviewer.instruction', message: 'Add the review instruction.' });
    }
    if (input.reviewer.kind === 'new') {
      if (!trimmed(input.reviewer.providerInstanceId)) {
        issues.push({ field: 'reviewer.providerInstanceId', message: 'Choose a Reviewer provider.' });
      } else if (providerIds.size > 0 && !providerIds.has(input.reviewer.providerInstanceId)) {
        issues.push({ field: 'reviewer.providerInstanceId', message: 'The selected Reviewer provider is unavailable.' });
      }
    } else {
      validateExisting('reviewer', input.reviewer.sessionId, context, issues);
    }
  }

  if (!reviewBlockingModes.includes(input?.blocking?.mode)) {
    issues.push({ field: 'blocking.mode', message: 'Choose what counts as a blocking issue.' });
  } else if (input.blocking.mode === 'custom' && !trimmed(input.blocking.customCriteria)) {
    issues.push({ field: 'blocking.customCriteria', message: 'Describe the custom blocking criteria.' });
  }

  if (!Number.isSafeInteger(input?.maxLaps) || input.maxLaps < 1 || input.maxLaps > 99) {
    issues.push({ field: 'maxLaps', message: 'Max laps must be a whole number from 1 to 99.' });
  }

  const sessions = context.sessions ?? {};
  if (
    input?.coder?.kind === 'existing' &&
    input.reviewer?.kind === 'existing' &&
    trimmed(input.coder.sessionId) &&
    input.coder.sessionId === input.reviewer.sessionId
  ) {
    issues.push({
      field: 'reviewer.sessionId',
      message: 'Coder and Reviewer must be different Agents.',
    });
  }
  const coderCwd = input?.coder?.kind === 'existing' ? sessions[input.coder.sessionId]?.cwd : undefined;
  const reviewerCwd = input?.reviewer?.kind === 'existing' ? sessions[input.reviewer.sessionId]?.cwd : undefined;
  if (coderCwd && reviewerCwd && coderCwd !== reviewerCwd) {
    issues.push({
      field: 'reviewer.sessionId',
      message: 'Coder and Reviewer must use the same workspace so the Reviewer can verify the diff.',
    });
  }
  if (
    input?.coder?.kind === 'new' &&
    input.reviewer?.kind === 'existing' &&
    (input.coder.workMode === 'worktree' || (reviewerCwd && trimmed(input.coder.cwd) !== reviewerCwd))
  ) {
    issues.push({
      field: 'reviewer.sessionId',
      message:
        input.coder.workMode === 'worktree'
          ? 'A new Coder worktree needs a new Reviewer that Orrery can attach to the same worktree.'
          : 'The existing Reviewer is attached to a different workspace.',
    });
  }

  return { ok: issues.length === 0, issues };
}

function validateExisting(field: string, sessionId: string, context: ReviewWorkflowValidationContext, issues: ReviewWorkflowValidationIssue[]) {
  const id = trimmed(sessionId);
  const session = id ? context.sessions?.[id] : undefined;
  if (!id) {
    issues.push({ field: `${field}.sessionId`, message: `Choose an existing ${field === 'coder' ? 'Coder' : 'Reviewer'} Agent.` });
    return;
  }
  if (context.sessions && !session) {
    issues.push({ field: `${field}.sessionId`, message: 'The selected Agent no longer exists.' });
    return;
  }
  if (session && !['idle', 'failed'].includes(session.status)) {
    issues.push({ field: `${field}.sessionId`, message: `The selected Agent is ${session.status}; wait until it is idle.` });
  }
  if (session?.frozen) {
    issues.push({ field: `${field}.sessionId`, message: 'The selected Agent is frozen.' });
  }
}
