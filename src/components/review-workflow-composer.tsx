import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, CheckCircle2, FolderOpen, GitPullRequestArrow, Loader2, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { AgentSession, GraphState, ProjectContext, StartReviewWorkflowInput } from '@/shared/graph-state';
import { providerCapability, type ProviderKind, type ProviderReasoningEffort, type ProviderRuntimeMode } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { cn } from '@/lib/utils';
import { modelOptionsForKind, providerInstanceForKind, providerOptions, reasoningEffortOptions } from '@/lib/provider-catalog';
import { blockingCriteriaText, validateReviewWorkflowStart, type ReviewBlockingMode } from '@shared/review-workflow';

type EndpointMode = 'new' | 'existing';

type AgentDraft = {
  mode: EndpointMode;
  sessionId: string;
  providerKind: ProviderKind;
  providerInstanceId: string;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
  runtimeMode: ProviderRuntimeMode;
};

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-lime-hi/60';

// A provider-level default can move ahead of the locally installed runtime.
// Review workflows need a deterministic, cross-provider cold start, so Codex
// starts on Orrery's first curated compatible model instead of delegating the
// choice to an older app-server binary.
function workflowModelDefault(providerKind: ProviderKind) {
  return providerKind === 'codex' ? (modelOptionsForKind(providerKind)[0]?.value ?? '') : '';
}

function runtimeSettings(agent: AgentDraft) {
  return {
    runtimeMode: agent.runtimeMode,
    reasoningEffort: agent.reasoningEffort,
    ...(agent.model.trim() ? { model: agent.model.trim() } : {}),
  };
}

function sessionSummary(session: AgentSession) {
  return `${session.label} · ${session.providerKind} · ${session.status}`;
}

export function ReviewWorkflowComposer({
  runtimeApi,
  runtimeState,
  defaultCwd,
  onStateChange,
  onError,
  onDirtyChange,
  onStarted,
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  defaultCwd: string;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onStarted: (result: { coderSessionId: string; loopId?: string }) => void;
}) {
  const instances = runtimeState.providerInstances;
  const initialCoderKind: ProviderKind = 'claude-code';
  const initialReviewerKind: ProviderKind = 'codex';
  const [coder, setCoder] = useState<AgentDraft>(() => ({
    mode: 'new',
    sessionId: '',
    providerKind: initialCoderKind,
    providerInstanceId: providerInstanceForKind(instances, initialCoderKind).providerInstanceId,
    model: '',
    reasoningEffort: 'medium',
    runtimeMode: 'auto-accept-edits',
  }));
  const [reviewer, setReviewer] = useState<AgentDraft>(() => ({
    mode: 'new',
    sessionId: '',
    providerKind: initialReviewerKind,
    providerInstanceId: providerInstanceForKind(instances, initialReviewerKind).providerInstanceId,
    model: workflowModelDefault(initialReviewerKind),
    reasoningEffort: 'high',
    runtimeMode: 'approval-required',
  }));
  const [cwd, setCwd] = useState(defaultCwd);
  const [workMode, setWorkMode] = useState<'local' | 'worktree'>('local');
  const [branch, setBranch] = useState('');
  const [coderPrompt, setCoderPrompt] = useState('');
  const [reviewInstruction, setReviewInstruction] = useState(
    'Review the implementation against the requested behavior. Verify the actual workspace diff and run focused checks when useful.',
  );
  const [blockingMode, setBlockingMode] = useState<ReviewBlockingMode>('p0-p1');
  const [customCriteria, setCustomCriteria] = useState('');
  const [maxLaps, setMaxLaps] = useState('6');
  const [projectContext, setProjectContext] = useState<ProjectContext>();
  const [checkedProjectCwd, setCheckedProjectCwd] = useState<string>();
  const [isCheckingProject, setIsCheckingProject] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [setupMessages, setSetupMessages] = useState<string[]>([]);
  const [setupNotices, setSetupNotices] = useState<string[]>([]);
  const [isCheckingProviders, setIsCheckingProviders] = useState(false);
  const [checkedProviderKey, setCheckedProviderKey] = useState<string>();

  const sessions = useMemo(() => Object.values(runtimeState.sessions).filter((session) => session.status !== 'killed'), [runtimeState.sessions]);
  const sessionContext = useMemo(
    () =>
      Object.fromEntries(
        sessions.map((session) => [
          session.sessionId,
          {
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
            frozen: runtimeState.nodes.find((node) => node.sessionId === session.sessionId)?.frozen,
          },
        ]),
      ),
    [runtimeState.nodes, sessions],
  );

  const payload = useMemo<StartReviewWorkflowInput>(
    () => ({
      coder:
        coder.mode === 'new'
          ? {
              kind: 'new',
              label: 'Coder',
              prompt: coderPrompt,
              cwd,
              workMode,
              ...(branch.trim() ? { branch: branch.trim() } : {}),
              providerKind: coder.providerKind,
              providerInstanceId: coder.providerInstanceId,
              runtimeSettings: runtimeSettings(coder),
            }
          : { kind: 'existing', sessionId: coder.sessionId, prompt: coderPrompt },
      reviewer:
        reviewer.mode === 'new'
          ? {
              kind: 'new',
              label: 'Reviewer',
              instruction: reviewInstruction,
              providerKind: reviewer.providerKind,
              providerInstanceId: reviewer.providerInstanceId,
              runtimeSettings: runtimeSettings(reviewer),
            }
          : { kind: 'existing', sessionId: reviewer.sessionId, instruction: reviewInstruction },
      blocking: { mode: blockingMode, ...(blockingMode === 'custom' ? { customCriteria } : {}) },
      maxLaps: Number(maxLaps),
    }),
    [blockingMode, branch, coder, coderPrompt, customCriteria, cwd, maxLaps, reviewInstruction, reviewer, workMode],
  );

  const validation = useMemo(() => {
    const result = validateReviewWorkflowStart(payload, {
      sessions: sessionContext,
      providerInstanceIds: instances.map((instance) => instance.providerInstanceId),
    });
    const issues = [...result.issues];
    if (payload.coder.kind === 'new' && projectContext?.error) {
      issues.push({ field: 'coder.cwd', message: projectContext.error });
    }
    if (payload.coder.kind === 'new' && workMode === 'worktree' && projectContext && !projectContext.isGitRepo) {
      issues.push({ field: 'coder.workMode', message: 'New worktree requires a Git project.' });
    }
    return { ok: issues.length === 0, issues };
  }, [instances, payload, projectContext, sessionContext, workMode]);

  const providerCheckKey = useMemo(
    () =>
      JSON.stringify({
        endpoints: [coder, reviewer]
          .filter((agent) => agent.mode === 'new')
          .map((agent) => [agent.providerKind, agent.providerInstanceId]),
        cwd: coder.mode === 'new' ? cwd.trim() : sessionContext[coder.sessionId]?.cwd,
      }),
    [coder, cwd, reviewer, sessionContext],
  );
  const preflightPending =
    (coder.mode === 'new' && Boolean(cwd.trim()) && checkedProjectCwd !== cwd.trim()) ||
    checkedProviderKey !== providerCheckKey ||
    isCheckingProject ||
    isCheckingProviders;

  useEffect(() => {
    onDirtyChange(true);
    return () => onDirtyChange(false);
  }, [onDirtyChange]);

  useEffect(() => {
    if (!runtimeApi || coder.mode !== 'new' || !cwd.trim()) {
      setProjectContext(undefined);
      setCheckedProjectCwd(undefined);
      setIsCheckingProject(false);
      return;
    }
    let active = true;
    const requestedCwd = cwd.trim();
    setProjectContext(undefined);
    setIsCheckingProject(true);
    runtimeApi
      .getProjectContext({ cwd: requestedCwd })
      .then((result) => {
        if (active) {
          setProjectContext(result);
          setCheckedProjectCwd(requestedCwd);
          setIsCheckingProject(false);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setProjectContext({
            cwd: cwd.trim(),
            projectName: cwd.trim().split('/').at(-1) ?? cwd.trim(),
            isGitRepo: false,
            branches: [],
            error: error instanceof Error ? error.message : String(error),
          });
          setCheckedProjectCwd(requestedCwd);
          setIsCheckingProject(false);
        }
      });
    return () => {
      active = false;
    };
  }, [coder.mode, cwd, runtimeApi]);

  useEffect(() => {
    if (!runtimeApi) {
      setIsCheckingProviders(false);
      return;
    }
    let active = true;
    setSetupMessages([]);
    setSetupNotices([]);
    setIsCheckingProviders(true);
    const checks = [coder, reviewer]
      .filter((agent) => agent.mode === 'new')
      .map((agent) =>
        runtimeApi.getProviderSetupStatus({
          providerKind: agent.providerKind,
          providerInstanceId: agent.providerInstanceId,
          cwd: coder.mode === 'new' ? cwd.trim() || undefined : sessionContext[coder.sessionId]?.cwd,
        }),
      );
    Promise.all(checks)
      .then((statuses) => {
        if (!active) return;
        const checks = statuses.flatMap((status) =>
          status.checks.map((check) => ({
            ...check,
            message: `${status.providerKind}: ${check.message}`,
          })),
        );
        setSetupMessages([...new Set(checks.filter((check) => check.status === 'error').map((check) => check.message))]);
        setSetupNotices([...new Set(checks.filter((check) => check.status === 'warning' || check.status === 'unknown').map((check) => check.message))]);
        setCheckedProviderKey(providerCheckKey);
        setIsCheckingProviders(false);
      })
      .catch((error: unknown) => {
        if (active) {
          setSetupMessages([error instanceof Error ? error.message : String(error)]);
          setSetupNotices([]);
          setCheckedProviderKey(providerCheckKey);
          setIsCheckingProviders(false);
        }
      });
    return () => {
      active = false;
    };
  }, [coder, cwd, providerCheckKey, reviewer, runtimeApi, sessionContext]);

  const updateProvider = (which: 'coder' | 'reviewer', providerKind: ProviderKind) => {
    const setter = which === 'coder' ? setCoder : setReviewer;
    setter((current) => ({
      ...current,
      providerKind,
      providerInstanceId: providerInstanceForKind(instances, providerKind).providerInstanceId,
      model: workflowModelDefault(providerKind),
      runtimeMode: providerCapability(providerKind).runtimeModes[0]?.id ?? 'approval-required',
    }));
  };

  const chooseFolder = async () => {
    if (!runtimeApi) return;
    try {
      const result = await runtimeApi.chooseProjectFolder();
      if (result.cwd) setCwd(result.cwd);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async () => {
    if (!runtimeApi || !validation.ok || setupMessages.length > 0 || preflightPending || isStarting) return;
    setIsStarting(true);
    try {
      const result = await runtimeApi.startReviewWorkflow(payload);
      onStateChange(result.state);
      onDirtyChange(false);
      onStarted({ coderSessionId: result.coderSessionId, loopId: result.loop?.loopId });
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStarting(false);
    }
  };

  const agentFields = (which: 'coder' | 'reviewer', agent: AgentDraft, setAgent: typeof setCoder) => (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
        {(['new', 'existing'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={cn('rounded-md px-2 py-1.5 text-[10.5px]', agent.mode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
            onClick={() => setAgent((current) => ({ ...current, mode }))}
          >
            {mode === 'new' ? 'Create new' : 'Use existing'}
          </button>
        ))}
      </div>
      {agent.mode === 'existing' ? (
        <select className={fieldClass} value={agent.sessionId} onChange={(event) => setAgent((current) => ({ ...current, sessionId: event.target.value }))}>
          <option value="">Choose an Agent…</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {sessionSummary(session)}
            </option>
          ))}
        </select>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Provider</span>
              <select className={fieldClass} value={agent.providerKind} onChange={(event) => updateProvider(which, event.target.value as ProviderKind)}>
                {providerOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Instance</span>
              <select
                className={fieldClass}
                value={agent.providerInstanceId}
                onChange={(event) => setAgent((current) => ({ ...current, providerInstanceId: event.target.value }))}
              >
                {instances
                  .filter((instance) => instance.kind === agent.providerKind)
                  .map((instance) => (
                    <option key={instance.providerInstanceId} value={instance.providerInstanceId}>
                      {instance.label}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Model</span>
              <select className={fieldClass} value={agent.model} onChange={(event) => setAgent((current) => ({ ...current, model: event.target.value }))}>
                <option value="">Provider default</option>
                {modelOptionsForKind(agent.providerKind).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Runtime</span>
              <select
                className={fieldClass}
                value={agent.runtimeMode}
                onChange={(event) => setAgent((current) => ({ ...current, runtimeMode: event.target.value as ProviderRuntimeMode }))}
              >
                {providerCapability(agent.providerKind).runtimeModes.length > 0 ? (
                  providerCapability(agent.providerKind).runtimeModes.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="approval-required">CLI default</option>
                )}
              </select>
            </label>
          </div>
          {agent.providerKind === 'codex' ? (
            <label className="block space-y-1">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Reasoning</span>
              <select
                className={fieldClass}
                value={agent.reasoningEffort}
                onChange={(event) => setAgent((current) => ({ ...current, reasoningEffort: event.target.value as ProviderReasoningEffort }))}
              >
                {reasoningEffortOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      )}
      {agent.mode === 'existing' && agent.sessionId ? (
        <p className="rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
          {sessionContext[agent.sessionId]?.cwd} · {sessionContext[agent.sessionId]?.status}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-3 border-t border-border/70 pt-3">
      <section className="rounded-xl border border-border bg-background p-3">
        <h3 className="text-[11px] font-medium text-foreground">1 · Coder</h3>
        <div className="mt-2">{agentFields('coder', coder, setCoder)}</div>
        {coder.mode === 'new' ? (
          <div className="mt-2 space-y-2">
            <label className="block space-y-1">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Workspace</span>
              <div className="flex gap-1.5">
                <input className={fieldClass} value={cwd} placeholder="/path/to/project" onChange={(event) => setCwd(event.target.value)} />
                <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label="Choose workspace" onClick={() => void chooseFolder()}>
                  <FolderOpen className="size-3.5" />
                </Button>
              </div>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Work mode</span>
                <select className={fieldClass} value={workMode} onChange={(event) => setWorkMode(event.target.value as 'local' | 'worktree')}>
                  <option value="local">Use local checkout</option>
                  <option value="worktree">Create worktree</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Base branch</span>
                <input
                  className={fieldClass}
                  value={branch}
                  placeholder={projectContext?.currentBranch ?? 'current'}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
            </div>
          </div>
        ) : null}
        <label className="mt-2 block space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Work prompt</span>
          <textarea
            className="min-h-24 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px] leading-4 outline-none focus:border-lime-hi/60"
            value={coderPrompt}
            placeholder="Describe the code change and acceptance criteria…"
            onChange={(event) => setCoderPrompt(event.target.value)}
          />
        </label>
      </section>

      <ArrowDown className="mx-auto size-4 text-muted-foreground" />

      <section className="rounded-xl border border-border bg-background p-3">
        <h3 className="text-[11px] font-medium text-foreground">2 · Reviewer</h3>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          A new Reviewer shares the Coder workspace automatically and waits without running a setup turn.
        </p>
        <div className="mt-2">{agentFields('reviewer', reviewer, setReviewer)}</div>
        <label className="mt-2 block space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Review instruction</span>
          <textarea
            className="min-h-20 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px] leading-4 outline-none focus:border-lime-hi/60"
            value={reviewInstruction}
            onChange={(event) => setReviewInstruction(event.target.value)}
          />
        </label>
      </section>

      <section className="rounded-xl border border-border bg-background p-3">
        <h3 className="text-[11px] font-medium text-foreground">3 · Stop when clean</h3>
        <label className="mt-2 block space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Blocking issues</span>
          <select className={fieldClass} value={blockingMode} onChange={(event) => setBlockingMode(event.target.value as ReviewBlockingMode)}>
            <option value="any-issue">Any issue blocks</option>
            <option value="p0-p1">P0/P1 only</option>
            <option value="custom">Custom criteria</option>
          </select>
        </label>
        {blockingMode === 'custom' ? (
          <textarea
            className="mt-2 min-h-16 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px]"
            value={customCriteria}
            placeholder="Example: security, data loss, or failing acceptance tests"
            onChange={(event) => setCustomCriteria(event.target.value)}
          />
        ) : null}
        <label className="mt-2 block space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Max laps · 1–99</span>
          <input className={fieldClass} type="number" min={1} max={99} value={maxLaps} onChange={(event) => setMaxLaps(event.target.value)} />
        </label>
      </section>

      <section className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          <GitPullRequestArrow className="size-3.5 text-sky-500" />
          Preview
        </div>
        <ol className="mt-2 space-y-1.5 text-[10.5px] leading-4 text-muted-foreground">
          <li>
            <span className="text-foreground">Start:</span> Coder runs the work prompt.
          </li>
          <li>
            <span className="text-foreground">review pass:</span> coder finished → deliver diff → reviewer
          </li>
          <li>
            <span className="text-foreground">blocking issues:</span> reviewer issues → deliver review → coder
          </li>
          <li>
            <span className="text-foreground">Until:</span> no blocking issues · {blockingCriteriaText(payload.blocking)}
          </li>
          <li>
            <span className="text-foreground">Guardrail:</span> max {payload.maxLaps || '—'} laps
          </li>
        </ol>
      </section>

      {setupMessages.length > 0 ? (
        <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-2 text-[10px] leading-4 text-destructive">
          <p className="font-medium">Provider setup needs attention before Run:</p>
          {setupMessages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      {setupNotices.length > 0 ? (
        <div className="rounded-lg border border-border bg-muted/30 p-2 text-[10px] leading-4 text-muted-foreground">
          <p className="font-medium text-foreground">Provider check</p>
          {setupNotices.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      {preflightPending ? (
        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Checking workspace and provider setup…
        </p>
      ) : null}
      {!validation.ok ? (
        <ul className="space-y-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300">
          {validation.issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>• {issue.message}</li>
          ))}
        </ul>
      ) : !preflightPending ? (
        <p className="flex items-center gap-1.5 text-[10px] text-lime-700 dark:text-lime-300">
          <CheckCircle2 className="size-3" />
          Ready. Run creates the full ring before starting the Coder.
        </p>
      ) : null}
      <Button
        className="h-9 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
        disabled={!runtimeApi || !validation.ok || setupMessages.length > 0 || preflightPending || isStarting}
        onClick={() => void start()}
      >
        {isStarting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        {isStarting ? 'Starting atomically…' : 'Run workflow'}
      </Button>
    </div>
  );
}
