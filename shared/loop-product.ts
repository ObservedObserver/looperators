export type LoopProductPhase =
  | 'coder-working'
  | 'waiting-review'
  | 'reviewer-working'
  | 'fixing-blocking-issues'
  | 'waiting-blocked'
  | 'failed'
  | 'stopped-clean'
  | 'stopped-cap'
  | 'stopped-manual'
  | 'stopped-guarded'
  | 'workflow-running'
  | 'workflow-waiting'
  | 'stopped-goal';

export type LoopProductTone = 'active' | 'waiting' | 'success' | 'warning' | 'danger' | 'neutral';

type ProductSession = {
  sessionId: string;
  label?: string;
  status?: string;
  error?: string;
  frozen?: boolean;
  freezeReason?: string;
  messages?: Array<{ role?: string; status?: string; ts?: string }>;
  runtimeRequests?: Array<{ status?: string; title?: string; body?: string; kind?: string }>;
  runtimeUserInputRequests?: Array<{ status?: string; prompt?: string }>;
};

type ProductSubscription = {
  id: string;
  source: { kind: string; sessionId?: string };
  on: { on: string; match?: { type?: string; verdict?: string } };
  target: { sessionId: string };
  action: { kind: string };
  state: 'active' | 'stopped';
  firings: number;
  label?: string;
  createdAt?: string;
};

type ProductIssue = { message: string; severity?: string; file?: string; line?: number };

type ProductReport = {
  id: string;
  from: string;
  envelope?: { ts?: string };
  payload: { type: 'verdict'; verdict: string; issues?: ProductIssue[]; summary?: string } | { type: string; [key: string]: unknown };
};

type ProductLoop = {
  loopId: string;
  kind: 'review' | 'goal' | 'generic';
  memberSessionIds: string[];
  subscriptionIds: string[];
  designatedSubscriptionId: string;
  lapCount: number;
  lapCap?: number;
  status: 'spinning' | 'waiting-gate' | 'frozen' | 'stopped' | 'idle';
  statusDetail?: string;
  stopSummary?: string;
  createdAt?: string;
  terminal?: { type: string; ts: string; reason?: string };
};

type ProductTimeline = {
  laps: Array<{
    index: number;
    hops: Array<{
      target: string;
      outcome?: { type: 'finished' | 'failed'; ts: string };
      reports: Array<{ reportId?: string; verdict?: string; summary?: string }>;
    }>;
  }>;
  stops: Array<{ type: string; subscriptionId: string; ts: string; reason?: string }>;
  refusals: Array<{ type: string; reason?: string }>;
};

export type LoopProductInput = {
  loop: ProductLoop;
  sessions: Record<string, ProductSession>;
  subscriptions?: Record<string, ProductSubscription>;
  reports?: ProductReport[];
  timeline?: ProductTimeline;
};

export type LoopProductRecovery = {
  kind: 'open-agent' | 'open-provider-settings' | 'resume-manually';
  label: string;
  sessionId?: string;
  guidance: string;
};

export type LoopProductView = {
  phase: LoopProductPhase;
  headline: string;
  detail: string;
  tone: LoopProductTone;
  lapLabel: string;
  coderSessionId?: string;
  reviewerSessionId?: string;
  responsibleSessionId?: string;
  responsibleLabel?: string;
  lastVerdict?: string;
  lastSummary?: string;
  blockingIssues: ProductIssue[];
  stopReason?: string;
  failureKind?: 'provider' | 'model' | 'auth' | 'workspace' | 'busy' | 'frozen' | 'missing-report' | 'guarded' | 'unknown';
  recovery?: LoopProductRecovery;
  canStop: boolean;
  canRetry: false;
};

function reviewParticipants(input: LoopProductInput) {
  const subscriptions = input.loop.subscriptionIds.map((id) => input.subscriptions?.[id]).filter(Boolean) as ProductSubscription[];
  const pass = subscriptions.find(
    (subscription) =>
      subscription.source.kind === 'session' &&
      subscription.on.on === 'finished' &&
      subscription.action.kind === 'deliver+activate' &&
      (subscription.id.startsWith('review-pass-') || subscription.label === 'review pass'),
  );
  const fix = pass
    ? subscriptions.find(
        (subscription) =>
          subscription.source.kind === 'session' &&
          subscription.source.sessionId === pass.target.sessionId &&
          subscription.target.sessionId === pass.source.sessionId &&
          subscription.on.on === 'report' &&
          subscription.on.match?.verdict === 'issues',
      )
    : undefined;
  return {
    coderSessionId: pass?.source.sessionId ?? fix?.target.sessionId,
    reviewerSessionId: pass?.target.sessionId ?? fix?.source.sessionId,
    reviewPass: pass,
  };
}

function workflowWindow(input: LoopProductInput) {
  const subscriptions = input.loop.subscriptionIds.map((id) => input.subscriptions?.[id]).filter(Boolean) as ProductSubscription[];
  const start =
    input.loop.createdAt ??
    subscriptions
      .map((subscription) => subscription.createdAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
  const end = input.loop.terminal?.ts ?? input.timeline?.stops.at(-1)?.ts;
  return { start, end };
}

function inWorkflowWindow(ts: string | undefined, window: { start?: string; end?: string }) {
  if (!ts) return !window.start && !window.end;
  return (!window.start || ts >= window.start) && (!window.end || ts <= window.end);
}

function latestVerdictReport(input: LoopProductInput, reviewerSessionId?: string) {
  const window = workflowWindow(input);
  return [...(input.reports ?? [])]
    .filter(
      (report) =>
        report.payload?.type === 'verdict' &&
        reviewerSessionId !== undefined &&
        report.from === reviewerSessionId &&
        inWorkflowWindow(report.envelope?.ts, window),
    )
    .sort((left, right) => String(left.envelope?.ts ?? '').localeCompare(String(right.envelope?.ts ?? '')))
    .at(-1) as (ProductReport & { payload: { type: 'verdict'; verdict: string; issues?: ProductIssue[]; summary?: string } }) | undefined;
}

function latestStopReason(input: LoopProductInput) {
  return [...(input.timeline?.stops ?? [])].reverse().find((stop) => stop.reason)?.reason ?? input.loop.terminal?.reason;
}

function latestHop(input: LoopProductInput) {
  const lap = input.timeline?.laps.at(-1);
  return lap?.hops.at(-1);
}

function classifyError(error: string | undefined) {
  const text = error ?? '';
  if (/auth|login|credential|unauthori[sz]ed|\b401\b|\b403\b/i.test(text)) return 'auth' as const;
  if (/model|newer version of codex|unsupported.*version/i.test(text)) return 'model' as const;
  if (/spawn\s+\S+\s+enoent|binary.*(?:missing|not found|unavailable)|command not found|executable.*not found/i.test(text)) return 'provider' as const;
  if (/cwd|workspace|repository|not a git|git baseline|project folder|(?:cwd|workspace|path).*enoent|enoent.*(?:cwd|workspace|path)/i.test(text))
    return 'workspace' as const;
  if (/busy|already running|pending activation/i.test(text)) return 'busy' as const;
  if (/provider|app-server|sdk|cli|binary/i.test(text)) return 'provider' as const;
  return 'unknown' as const;
}

function deriveGenericProductView(input: LoopProductInput): LoopProductView {
  const lapLabel = input.loop.lapCap === undefined ? `${input.loop.lapCount}` : `${input.loop.lapCount}/${input.loop.lapCap}`;
  const sessions = input.loop.memberSessionIds.map((id) => input.sessions[id]).filter(Boolean);
  const failed = sessions.find((session) => session.status === 'failed');
  const stopReason = latestStopReason(input);
  const common = {
    lapLabel,
    blockingIssues: [],
    canStop: input.loop.status !== 'stopped',
    canRetry: false as const,
  };
  if (failed) {
    const failureKind = classifyError(failed.error);
    const providerSetupFailure = failureKind === 'auth' || failureKind === 'provider';
    return {
      ...common,
      phase: 'failed',
      headline: `${failed.label ?? 'Agent'} failed`,
      detail: failed.error || 'An Agent in this workflow failed.',
      tone: 'danger',
      responsibleSessionId: failed.sessionId,
      responsibleLabel: failed.label,
      failureKind,
      recovery: providerSetupFailure
        ? {
            kind: 'open-provider-settings',
            label: 'Open Provider setup',
            sessionId: failed.sessionId,
            guidance: 'Open Provider setup, correct the binary or sign-in problem, then resume the Agent manually.',
          }
        : {
            kind: 'open-agent',
            label: `Open ${failed.label ?? 'Agent'}`,
            sessionId: failed.sessionId,
            guidance: 'Open the failed Agent, correct the error, and decide whether to resume manually.',
          },
    };
  }
  if (input.loop.status === 'stopped') {
    if (input.loop.kind === 'goal' && /whenReport\(done\)|verdict.?done|until done/i.test(stopReason ?? '')) {
      return {
        ...common,
        phase: 'stopped-goal',
        headline: 'Goal reached',
        detail: 'The Judge reported done. Both Goal Loop relationships are stopped.',
        tone: 'success',
        stopReason: stopReason || 'Judge reported done.',
      };
    }
    const manual = /stopped by user|manual stop|stop future handoffs/i.test(stopReason ?? '');
    const cap =
      /maxfirings|lap cap|guardrail.*max|reached.*cap/i.test(stopReason ?? '') ||
      (!manual && input.loop.lapCap !== undefined && input.loop.lapCount >= input.loop.lapCap);
    if (cap) {
      return {
        ...common,
        phase: 'stopped-cap',
        headline: 'Stopped at lap limit',
        detail: `The workflow reached ${lapLabel}. Inspect the Agents before continuing manually.`,
        tone: 'warning',
        stopReason: stopReason || `Reached max ${input.loop.lapCap} laps.`,
        failureKind: 'guarded',
      };
    }
    if (!manual && /guarded|deadline|safety|policy/i.test(stopReason ?? '')) {
      return {
        ...common,
        phase: 'stopped-guarded',
        headline: 'Stopped by guardrail',
        detail: stopReason || 'A workflow guardrail stopped future activations.',
        tone: 'warning',
        stopReason,
        failureKind: 'guarded',
      };
    }
    return {
      ...common,
      phase: 'stopped-manual',
      headline: input.loop.kind === 'goal' ? 'Goal Loop stopped' : 'Loop stopped',
      detail: 'Future activations are stopped. Any Agent turn already running may finish.',
      tone: 'neutral',
      stopReason: stopReason || 'Stopped manually.',
    };
  }
  const waitingInteraction = sessions
    .map((session) => ({
      session,
      request: session.runtimeRequests?.find((request) => request.status === 'open'),
      input: session.runtimeUserInputRequests?.find((request) => request.status === 'open'),
    }))
    .find((entry) => entry.request || entry.input);
  if (waitingInteraction) {
    const label = waitingInteraction.session.label ?? 'Agent';
    return {
      ...common,
      phase: 'waiting-blocked',
      headline: `${label} needs your response`,
      detail:
        waitingInteraction.request?.title ??
        waitingInteraction.request?.body ??
        waitingInteraction.input?.prompt ??
        'The Agent needs a response before this workflow can continue.',
      tone: 'waiting',
      responsibleSessionId: waitingInteraction.session.sessionId,
      responsibleLabel: label,
      failureKind: 'busy',
      recovery: {
        kind: 'open-agent',
        label: `Open ${label}`,
        sessionId: waitingInteraction.session.sessionId,
        guidance: 'Open the Agent to approve, decline, or answer the pending request.',
      },
    };
  }
  const running = sessions.find((session) => session.status === 'running' || session.status === 'pending');
  if (running) {
    return {
      ...common,
      phase: 'workflow-running',
      headline: `${running.label ?? 'Agent'} working`,
      detail: input.loop.kind === 'goal' ? 'The Goal Loop is working toward its next judgment.' : 'The Loop is running its next activation.',
      tone: 'active',
      responsibleSessionId: running.sessionId,
      responsibleLabel: running.label,
    };
  }
  if (input.loop.status === 'frozen' || input.loop.status === 'waiting-gate') {
    const frozen = input.loop.status === 'frozen';
    const responsible = sessions.find((session) => session.frozen) ?? sessions[0];
    return {
      ...common,
      phase: 'waiting-blocked',
      headline: frozen ? `${input.loop.kind === 'goal' ? 'Goal Loop' : 'Loop'} frozen` : 'Waiting for approval',
      detail: input.loop.statusDetail || (frozen ? 'A participant is frozen.' : 'A gate must be approved before the next Agent can run.'),
      tone: 'waiting',
      responsibleSessionId: responsible?.sessionId,
      responsibleLabel: responsible?.label,
      failureKind: frozen ? 'frozen' : 'unknown',
      recovery: responsible
        ? {
            kind: 'open-agent',
            label: `Open ${responsible.label ?? 'Agent'}`,
            sessionId: responsible.sessionId,
            guidance: frozen
              ? 'Freeze is an Advanced control. Open the Agent to inspect why it was frozen.'
              : 'Open the responsible Agent or approval surface.',
          }
        : undefined,
    };
  }
  return {
    ...common,
    phase: 'workflow-waiting',
    headline: input.loop.kind === 'goal' ? 'Goal Loop waiting' : 'Loop waiting',
    detail: input.loop.statusDetail || 'No Agent is running; the workflow is waiting for its next trigger.',
    tone: 'waiting',
  };
}

function labelOf(input: LoopProductInput, sessionId: string | undefined, fallback: string) {
  return (sessionId && input.sessions[sessionId]?.label) || fallback;
}

function base(input: LoopProductInput) {
  const { coderSessionId, reviewerSessionId, reviewPass } = reviewParticipants(input);
  const report = latestVerdictReport(input, reviewerSessionId);
  const payload = report?.payload;
  const lapLabel = input.loop.lapCap === undefined ? `${input.loop.lapCount}` : `${input.loop.lapCount}/${input.loop.lapCap}`;
  return {
    coderSessionId,
    reviewerSessionId,
    reviewPass,
    report,
    payload,
    lapLabel,
    blockingIssues: payload?.verdict === 'issues' ? (payload.issues ?? []) : [],
    common: {
      lapLabel,
      coderSessionId,
      reviewerSessionId,
      lastVerdict: payload?.verdict,
      lastSummary: payload?.summary,
      blockingIssues: payload?.verdict === 'issues' ? (payload.issues ?? []) : [],
      canStop: input.loop.status !== 'stopped',
      canRetry: false as const,
    },
  };
}

export function deriveLoopProductView(input: LoopProductInput): LoopProductView {
  if (input.loop.kind !== 'review') {
    return deriveGenericProductView(input);
  }
  const { coderSessionId, reviewerSessionId, reviewPass, payload, common } = base(input);
  const coder = coderSessionId ? input.sessions[coderSessionId] : undefined;
  const reviewer = reviewerSessionId ? input.sessions[reviewerSessionId] : undefined;
  const failed = [reviewer, coder].find((session) => session?.status === 'failed');

  if (failed) {
    const failureKind = classifyError(failed.error);
    const providerSetupFailure = failureKind === 'auth' || failureKind === 'provider';
    const guidance =
      failureKind === 'auth'
        ? 'Open the Agent, then check Provider setup and sign in before resuming manually.'
        : failureKind === 'model'
          ? 'Open the Agent and choose a model supported by its local runtime before resuming manually.'
          : failureKind === 'workspace'
            ? 'Open the Agent and fix its workspace path or Git baseline before resuming manually.'
            : 'Open the failed Agent, inspect the provider error, and resume manually after correcting it.';
    return {
      ...common,
      phase: 'failed',
      headline: `${failed.label ?? 'Agent'} failed`,
      detail: failed.error || 'The Agent failed before the workflow received a usable result.',
      tone: 'danger',
      responsibleSessionId: failed.sessionId,
      responsibleLabel: failed.label,
      failureKind,
      recovery: {
        kind: providerSetupFailure ? 'open-provider-settings' : 'open-agent',
        label: providerSetupFailure ? 'Open Provider setup' : `Open ${failed.label ?? 'Agent'}`,
        sessionId: failed.sessionId,
        guidance: providerSetupFailure ? 'Open Provider setup, correct the binary or sign-in problem, then resume the Agent manually.' : guidance,
      },
    };
  }

  const stopReason = latestStopReason(input);
  if (input.loop.status === 'stopped') {
    const stoppedClean = /whenReport\(clean\)|verdict.?clean|until clean/i.test(stopReason ?? '') || (!stopReason && payload?.verdict === 'clean');
    if (stoppedClean) {
      return {
        ...common,
        phase: 'stopped-clean',
        headline: 'Review passed',
        detail: payload?.summary || 'The Reviewer found no blocking issues. Both workflow relationships are stopped.',
        tone: 'success',
        stopReason: stopReason || 'Reviewer reported clean.',
      };
    }
    const stoppedManually = /stopped by user|manual stop|stop future handoffs/i.test(stopReason ?? '');
    if (stoppedManually) {
      return {
        ...common,
        phase: 'stopped-manual',
        headline: 'Loop stopped',
        detail: 'Future handoffs are stopped. Any Agent turn that was already running may finish on its own.',
        tone: 'neutral',
        stopReason,
      };
    }
    const stoppedAtCap =
      /maxfirings|lap cap|guardrail.*max|reached.*cap/i.test(stopReason ?? '') || (input.loop.lapCap !== undefined && input.loop.lapCount >= input.loop.lapCap);
    if (stoppedAtCap) {
      return {
        ...common,
        phase: 'stopped-cap',
        headline: 'Stopped at lap limit',
        detail: `The workflow reached ${common.lapLabel} without a clean verdict. Review the last blocking issues before continuing manually.`,
        tone: 'warning',
        stopReason: stopReason || `Reached max ${input.loop.lapCap} laps.`,
        failureKind: 'guarded',
        responsibleSessionId: coderSessionId,
        responsibleLabel: labelOf(input, coderSessionId, 'Coder'),
        recovery: {
          kind: 'open-agent',
          label: `Open ${labelOf(input, coderSessionId, 'Coder')}`,
          sessionId: coderSessionId,
          guidance: 'Inspect the remaining blocking issues and decide whether to resume the Agent manually.',
        },
      };
    }
    if (/guarded|deadline|safety|policy/i.test(stopReason ?? '')) {
      return {
        ...common,
        phase: 'stopped-guarded',
        headline: 'Stopped by guardrail',
        detail: stopReason || 'A workflow guardrail stopped future activations.',
        tone: 'warning',
        stopReason,
        failureKind: 'guarded',
      };
    }
    return {
      ...common,
      phase: 'stopped-manual',
      headline: 'Loop stopped',
      detail: 'Future handoffs are stopped. Any Agent turn that was already running may finish on its own.',
      tone: 'neutral',
      stopReason: stopReason || 'Stopped manually.',
    };
  }

  const waitingInteraction = [coder, reviewer]
    .filter(Boolean)
    .map((session) => ({
      session: session!,
      request: session!.runtimeRequests?.find((request) => request.status === 'open'),
      input: session!.runtimeUserInputRequests?.find((request) => request.status === 'open'),
    }))
    .find((entry) => entry.request || entry.input);
  if (waitingInteraction) {
    const label = waitingInteraction.session.label ?? 'Agent';
    const requestText =
      waitingInteraction.request?.title ?? waitingInteraction.request?.body ?? waitingInteraction.input?.prompt ?? 'The Agent needs a response.';
    return {
      ...common,
      phase: 'waiting-blocked',
      headline: `${label} needs your response`,
      detail: requestText,
      tone: 'waiting',
      responsibleSessionId: waitingInteraction.session.sessionId,
      responsibleLabel: label,
      failureKind: 'busy',
      recovery: {
        kind: 'open-agent',
        label: `Open ${label}`,
        sessionId: waitingInteraction.session.sessionId,
        guidance: 'Open the Agent to approve, decline, or answer the pending request. The Loop will continue after the Agent finishes.',
      },
    };
  }

  if (reviewer?.status === 'running' || reviewer?.status === 'pending') {
    return {
      ...common,
      phase: 'reviewer-working',
      headline: 'Reviewer working',
      detail: 'The Reviewer is checking the latest workspace diff and must submit a typed verdict.',
      tone: 'active',
      responsibleSessionId: reviewerSessionId,
      responsibleLabel: labelOf(input, reviewerSessionId, 'Reviewer'),
    };
  }

  if (coder?.status === 'running' || coder?.status === 'pending') {
    const fixing = payload?.verdict === 'issues';
    return {
      ...common,
      phase: fixing ? 'fixing-blocking-issues' : 'coder-working',
      headline: fixing ? 'Coder fixing blocking issues' : 'Coder working',
      detail: fixing
        ? `${common.blockingIssues.length || 'Blocking'} issue${common.blockingIssues.length === 1 ? '' : 's'} sent back to the Coder.`
        : 'The Coder is implementing and verifying the requested change.',
      tone: 'active',
      responsibleSessionId: coderSessionId,
      responsibleLabel: labelOf(input, coderSessionId, 'Coder'),
    };
  }

  if (input.loop.status === 'frozen' || input.loop.status === 'waiting-gate') {
    const frozen = input.loop.status === 'frozen';
    const responsible = [coder, reviewer].find((session) => session?.frozen) ?? reviewer ?? coder;
    return {
      ...common,
      phase: 'waiting-blocked',
      headline: frozen ? 'Loop frozen' : 'Waiting for approval',
      detail: input.loop.statusDetail || (frozen ? 'A participant is frozen.' : 'A gate must be approved before the next Agent can run.'),
      tone: 'waiting',
      responsibleSessionId: responsible?.sessionId,
      responsibleLabel: responsible?.label,
      failureKind: frozen ? 'frozen' : 'unknown',
      recovery: responsible
        ? {
            kind: 'open-agent',
            label: `Open ${responsible.label ?? 'Agent'}`,
            sessionId: responsible.sessionId,
            guidance: frozen
              ? 'Freeze is an Advanced control. Open the Agent to inspect why it was frozen.'
              : 'Open the responsible Agent or approval surface.',
          }
        : undefined,
    };
  }

  const hop = latestHop(input);
  const window = workflowWindow(input);
  const reviewerVerdictCount = (input.reports ?? []).filter(
    (report) => report.from === reviewerSessionId && report.payload?.type === 'verdict' && inWorkflowWindow(report.envelope?.ts, window),
  ).length;
  const reviewerCompletedTurns =
    reviewer?.messages?.filter((message) => message.role === 'assistant' && message.status !== 'streaming' && inWorkflowWindow(message.ts, window)).length ?? 0;
  const reviewerFinishedWithoutReport =
    Boolean(hop && hop.target === reviewerSessionId && hop.outcome?.type === 'finished' && hop.reports.length === 0) ||
    (reviewer?.status === 'idle' &&
      (reviewPass?.firings ?? 0) > reviewerVerdictCount &&
      reviewerCompletedTurns >= (reviewPass?.firings ?? 0) &&
      (reviewPass?.firings ?? 0) > 0);
  if (reviewerFinishedWithoutReport) {
    return {
      ...common,
      phase: 'waiting-blocked',
      headline: 'Reviewer did not report',
      detail: 'The Reviewer finished without the typed verdict that controls this loop. Orrery will not guess from chat text.',
      tone: 'danger',
      responsibleSessionId: reviewerSessionId,
      responsibleLabel: labelOf(input, reviewerSessionId, 'Reviewer'),
      failureKind: 'missing-report',
      recovery: {
        kind: 'resume-manually',
        label: `Open ${labelOf(input, reviewerSessionId, 'Reviewer')}`,
        sessionId: reviewerSessionId,
        guidance:
          'Open the Reviewer, then resume it manually with an instruction to submit one typed verdict. Automatic Retry is disabled to avoid duplicate review work.',
      },
    };
  }

  if (payload?.verdict === 'issues') {
    return {
      ...common,
      phase: 'waiting-blocked',
      headline: 'Waiting for Coder',
      detail: 'Blocking issues are ready, but the Coder has not started the fix turn.',
      tone: 'waiting',
      responsibleSessionId: coderSessionId,
      responsibleLabel: labelOf(input, coderSessionId, 'Coder'),
      failureKind: 'busy',
      recovery: {
        kind: 'open-agent',
        label: `Open ${labelOf(input, coderSessionId, 'Coder')}`,
        sessionId: coderSessionId,
        guidance: 'Open the Coder to check for a permission request, busy state, or another blocked interaction.',
      },
    };
  }

  return {
    ...common,
    phase: 'waiting-review',
    headline: 'Waiting for review',
    detail: 'The Coder has finished or is idle; the next expected step is the Reviewer.',
    tone: 'waiting',
    responsibleSessionId: reviewerSessionId,
    responsibleLabel: labelOf(input, reviewerSessionId, 'Reviewer'),
  };
}
