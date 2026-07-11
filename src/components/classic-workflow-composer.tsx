import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, CheckCircle2, Flag, GitBranch, Loader2, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AgentRuntimeFields } from '@/components/workflow-form-fields';
import { cn } from '@/lib/utils';
import { modelOptionsForKind, providerInstanceForKind } from '@/lib/provider-catalog';
import { providerSetupProfileFingerprint } from '@shared/provider-setup';
import type { GraphState } from '@/shared/graph-state';
import type { SavedWorkflowSpec } from '@/shared/graph-state';
import type { ProviderKind, ProviderReasoningEffort, ProviderRuntimeMode } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import {
  validateGoalWorkflowStart,
  validateHandoffWorkflowStart,
  classicWorkflowPreflightKey,
  type ClassicWorkflowPreflightTarget,
  type GoalWorkflowStartInput,
  type HandoffWorkflowStartInput,
  type WorkflowAgentEndpoint,
} from '@shared/classic-workflow';

type WorkflowKind = 'handoff' | 'goal-loop';
type AgentDraft = {
  mode: 'new' | 'existing';
  sessionId: string;
  label: string;
  prompt: string;
  cwd: string;
  workMode: 'local' | 'worktree';
  branch: string;
  providerKind: ProviderKind;
  providerInstanceId: string;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
  runtimeMode: ProviderRuntimeMode;
};

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-lime-hi/60';
const textAreaClass =
  'min-h-20 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px] leading-5 outline-none focus:border-lime-hi/60';

function newAgent(instances: GraphState['providerInstances'], role: string, providerKind: ProviderKind, cwd: string): AgentDraft {
  return {
    mode: 'new',
    sessionId: '',
    label: role,
    prompt: '',
    cwd,
    workMode: 'local',
    branch: '',
    providerKind,
    providerInstanceId: providerInstanceForKind(instances, providerKind).providerInstanceId,
    model: providerKind === 'codex' ? (modelOptionsForKind(providerKind)[0]?.value ?? '') : '',
    reasoningEffort: role === 'Receiver' ? 'high' : 'medium',
    runtimeMode: role === 'Receiver' ? 'approval-required' : 'auto-accept-edits',
  };
}

function endpoint(agent: AgentDraft): WorkflowAgentEndpoint {
  if (agent.mode === 'existing') return { kind: 'existing', sessionId: agent.sessionId, prompt: agent.prompt };
  return {
    kind: 'new',
    label: agent.label,
    prompt: agent.prompt,
    cwd: agent.cwd,
    workMode: agent.workMode,
    ...(agent.branch.trim() ? { branch: agent.branch.trim() } : {}),
    providerKind: agent.providerKind,
    providerInstanceId: agent.providerInstanceId,
    runtimeSettings: {
      runtimeMode: agent.runtimeMode,
      reasoningEffort: agent.reasoningEffort,
      ...(agent.model.trim() ? { model: agent.model.trim() } : {}),
    },
  };
}

function agentFromEndpoint(
  instances: GraphState['providerInstances'],
  role: string,
  providerKind: ProviderKind,
  cwd: string,
  saved?: WorkflowAgentEndpoint,
): AgentDraft {
  const base = newAgent(instances, role, providerKind, cwd);
  if (!saved) return base;
  if (saved.kind === 'existing') return { ...base, mode: 'existing', sessionId: saved.sessionId, prompt: saved.prompt };
  return {
    ...base,
    mode: 'new',
    label: saved.label,
    prompt: saved.prompt,
    cwd: saved.cwd,
    workMode: saved.workMode,
    branch: saved.branch ?? '',
    providerKind: saved.providerKind,
    providerInstanceId: saved.providerInstanceId,
    model: saved.runtimeSettings.model ?? '',
    reasoningEffort: saved.runtimeSettings.reasoningEffort ?? 'medium',
    runtimeMode: saved.runtimeSettings.runtimeMode,
  };
}

export function ClassicWorkflowComposer({
  kind,
  runtimeApi,
  runtimeState,
  defaultCwd,
  onStateChange,
  onError,
  onDirtyChange,
  onStarted,
  initialSpec,
  onSaved,
}: {
  kind: WorkflowKind;
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  defaultCwd: string;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onStarted: (result: { primarySessionId: string; loopId?: string; notice: string }) => void;
  initialSpec?: SavedWorkflowSpec;
  onSaved: () => Promise<void> | void;
}) {
  const instances = runtimeState.providerInstances;
  const initialInput = initialSpec?.input;
  const [source, setSource] = useState(() =>
    agentFromEndpoint(
      instances,
      kind === 'goal-loop' ? 'Worker' : 'Source',
      'claude-code',
      defaultCwd,
      kind === 'goal-loop' ? (initialInput as GoalWorkflowStartInput | undefined)?.worker : (initialInput as HandoffWorkflowStartInput | undefined)?.source,
    ),
  );
  const [target, setTarget] = useState(() =>
    agentFromEndpoint(instances, 'Receiver', 'codex', defaultCwd, (initialInput as HandoffWorkflowStartInput | undefined)?.target),
  );
  const [note, setNote] = useState(
    (initialInput as HandoffWorkflowStartInput | undefined)?.note ?? 'Continue from the delivered result and complete the requested next step.',
  );
  const [goal, setGoal] = useState((initialInput as GoalWorkflowStartInput | undefined)?.goal ?? '');
  const [maxLaps, setMaxLaps] = useState(String((initialInput as GoalWorkflowStartInput | undefined)?.maxLaps ?? 6));
  const [judgeProviderInstanceId, setJudgeProviderInstanceId] = useState((initialInput as GoalWorkflowStartInput | undefined)?.judgeProviderInstanceId ?? '');
  const [judgeModel, setJudgeModel] = useState((initialInput as GoalWorkflowStartInput | undefined)?.judgeModel ?? '');
  const [isStarting, setIsStarting] = useState(false);
  const [isCheckingPreflight, setIsCheckingPreflight] = useState(false);
  const [checkedPreflightKey, setCheckedPreflightKey] = useState<string>();
  const [setupMessages, setSetupMessages] = useState<string[]>([]);
  const [setupNotices, setSetupNotices] = useState<string[]>([]);
  const [startError, setStartError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const sessions = useMemo(() => Object.values(runtimeState.sessions).filter((session) => session.status !== 'killed'), [runtimeState.sessions]);
  const context = useMemo(
    () => ({
      sessions: Object.fromEntries(
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
      providerInstanceIds: instances.map((instance) => instance.providerInstanceId),
    }),
    [instances, runtimeState.nodes, sessions],
  );
  const payload = useMemo<HandoffWorkflowStartInput | GoalWorkflowStartInput>(
    () =>
      kind === 'handoff'
        ? { source: endpoint(source), target: endpoint(target), note }
        : {
            worker: endpoint(source),
            goal,
            maxLaps: Number(maxLaps),
            ...(judgeProviderInstanceId ? { judgeProviderInstanceId } : {}),
            ...(judgeModel.trim() ? { judgeModel: judgeModel.trim() } : {}),
          },
    [goal, judgeModel, judgeProviderInstanceId, kind, maxLaps, note, source, target],
  );
  const validation = useMemo(
    () =>
      kind === 'handoff'
        ? validateHandoffWorkflowStart(payload as HandoffWorkflowStartInput, context)
        : validateGoalWorkflowStart(payload as GoalWorkflowStartInput, context),
    [context, kind, payload],
  );
  const selectedSourceSession = source.mode === 'existing' ? runtimeState.sessions[source.sessionId] : undefined;
  const inheritedJudgeProviderInstanceId = source.mode === 'new' ? source.providerInstanceId : selectedSourceSession?.providerInstanceId;
  const selectedJudgeProviderInstanceId = judgeProviderInstanceId || inheritedJudgeProviderInstanceId || '';
  const selectedJudgeProviderKind = instances.find((instance) => instance.providerInstanceId === selectedJudgeProviderInstanceId)?.kind;
  const preflightTargets = (() => {
    const targets: ClassicWorkflowPreflightTarget[] = [];
    const addNewAgent = (role: string, agent: AgentDraft) => {
      if (agent.mode !== 'new') return;
      targets.push({
        role,
        cwd: agent.cwd.trim() || undefined,
        workMode: agent.workMode,
        checkProject: true,
        providerKind: agent.providerKind,
        providerInstanceId: agent.providerInstanceId,
        providerProfileFingerprint: providerSetupProfileFingerprint(
          instances.find((instance) => instance.providerInstanceId === agent.providerInstanceId),
        ),
      });
    };

    addNewAgent(kind === 'goal-loop' ? 'Worker' : 'Source', source);
    if (kind === 'handoff') addNewAgent('Receiver', target);

    if (kind === 'goal-loop') {
      const judgeInstanceId = selectedJudgeProviderInstanceId;
      const judgeKind = selectedJudgeProviderKind ?? (source.mode === 'new' ? source.providerKind : selectedSourceSession?.providerKind);
      if (judgeKind && judgeInstanceId) {
        targets.push({
          role: 'Judge',
          cwd: source.mode === 'new' ? source.cwd.trim() || undefined : selectedSourceSession?.cwd,
          checkProject: false,
          providerKind: judgeKind,
          providerInstanceId: judgeInstanceId,
          providerProfileFingerprint: providerSetupProfileFingerprint(
            instances.find((instance) => instance.providerInstanceId === judgeInstanceId),
          ),
        });
      }
    }
    return targets;
  })();
  const preflightKey = classicWorkflowPreflightKey(preflightTargets);
  const preflightPending = isCheckingPreflight || checkedPreflightKey !== preflightKey;
  const initialPayloadRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const signature = JSON.stringify(payload);
    if (initialPayloadRef.current === undefined) initialPayloadRef.current = signature;
    onDirtyChange(signature !== initialPayloadRef.current);
  }, [onDirtyChange, payload]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    setStartError('');
  }, [payload]);

  useEffect(() => {
    if (!runtimeApi) {
      setIsCheckingPreflight(false);
      setCheckedPreflightKey(undefined);
      return;
    }
    let active = true;
    setIsCheckingPreflight(true);
    setSetupMessages([]);
    setSetupNotices([]);
    const targets = JSON.parse(preflightKey) as ClassicWorkflowPreflightTarget[];

    Promise.all(
      targets.flatMap((target) => {
        const checks: Array<Promise<{ role: string; kind: 'project' | 'provider'; result: unknown }>> = [
          runtimeApi
            .getProviderSetupStatus({
              providerKind: target.providerKind,
              providerInstanceId: target.providerInstanceId,
              cwd: target.cwd,
            })
            .then((result) => ({ role: target.role, kind: 'provider' as const, result })),
        ];
        if (target.checkProject && target.cwd) {
          checks.push(
            runtimeApi.getProjectContext({ cwd: target.cwd }).then((result) => ({
              role: target.role,
              kind: 'project' as const,
              result: { ...result, workMode: target.workMode },
            })),
          );
        }
        return checks;
      }),
    )
      .then((results) => {
        if (!active) return;
        const errors: string[] = [];
        const notices: string[] = [];
        for (const entry of results) {
          if (entry.kind === 'provider') {
            const status = entry.result as Awaited<ReturnType<RuntimeApi['getProviderSetupStatus']>>;
            for (const check of status.checks) {
              const message = `${entry.role}: ${check.message}`;
              if (check.status === 'error') errors.push(message);
              else if (check.status === 'warning' || check.status === 'unknown') notices.push(message);
            }
          } else {
            const project = entry.result as Awaited<ReturnType<RuntimeApi['getProjectContext']>> & { workMode?: 'local' | 'worktree' };
            if (project.error) errors.push(`${entry.role} workspace: ${project.error}`);
            if (project.workMode === 'worktree' && !project.isGitRepo) {
              errors.push(`${entry.role} workspace: choose a Git repository for a new worktree.`);
            }
          }
        }
        setSetupMessages([...new Set(errors)]);
        setSetupNotices([...new Set(notices)]);
        setCheckedPreflightKey(preflightKey);
        setIsCheckingPreflight(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSetupMessages([`${error instanceof Error ? error.message : String(error)} Open Provider settings or choose a valid workspace, then retry.`]);
        setSetupNotices([]);
        setCheckedPreflightKey(preflightKey);
        setIsCheckingPreflight(false);
      });
    return () => {
      active = false;
    };
  }, [preflightKey, runtimeApi]);

  const agentFields = (title: string, value: AgentDraft, setValue: typeof setSource) => (
    <section className="space-y-2 rounded-xl border border-border bg-card/60 p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em]">
        <GitBranch className="size-3.5 text-sky-500" />
        {title}
      </div>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
        {(['new', 'existing'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={cn('rounded-md px-2 py-1.5 text-[10.5px]', value.mode === mode ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            onClick={() => setValue((current) => ({ ...current, mode }))}
          >
            {mode === 'new' ? 'Create new' : 'Use existing'}
          </button>
        ))}
      </div>
      {value.mode === 'existing' ? (
        <select
          className={fieldClass}
          aria-label={`${title} Agent`}
          value={value.sessionId}
          onChange={(event) => setValue((current) => ({ ...current, sessionId: event.target.value }))}
        >
          <option value="">Choose an Agent…</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.label} · {session.status}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            className={fieldClass}
            aria-label={`${title} name`}
            value={value.label}
            onChange={(event) => setValue((current) => ({ ...current, label: event.target.value }))}
          />
          <AgentRuntimeFields
            value={{
              providerKind: value.providerKind,
              providerInstanceId: value.providerInstanceId,
              model: value.model,
              reasoningEffort: value.reasoningEffort,
              runtimeMode: value.runtimeMode,
            }}
            instances={instances}
            idPrefix={`classic-${kind}-${title.toLowerCase()}`}
            onChange={(next) => setValue((current) => ({ ...current, ...next }))}
          />
          <input
            className={fieldClass}
            aria-label={`${title} workspace`}
            value={value.cwd}
            onChange={(event) => setValue((current) => ({ ...current, cwd: event.target.value }))}
          />
        </>
      )}
      {value.mode === 'new' || kind === 'goal-loop' ? (
        <textarea
          className={textAreaClass}
          aria-label={`${title} Prompt`}
          placeholder={`What should the ${title} do?`}
          value={value.prompt}
          onChange={(event) => setValue((current) => ({ ...current, prompt: event.target.value }))}
        />
      ) : (
        <p className="text-[10.5px] leading-4 text-muted-foreground">Uses this Agent&apos;s current completed result. No new source prompt is needed.</p>
      )}
    </section>
  );

  const start = async () => {
    if (!runtimeApi || !validation.ok || setupMessages.length > 0 || preflightPending || isStarting) return;
    setIsStarting(true);
    setStartError('');
    try {
      if (kind === 'handoff') {
        const result = await runtimeApi.startHandoffWorkflow(payload as HandoffWorkflowStartInput);
        onStateChange(result.state);
        onDirtyChange(false);
        onStarted({
          primarySessionId: result.sourceSessionId,
          notice: result.deliveredTo.length ? 'Handoff delivered · Receiver started' : 'Source started · Handoff armed once',
        });
      } else {
        const result = await runtimeApi.startGoalWorkflow(payload as GoalWorkflowStartInput);
        onStateChange(result.state);
        onDirtyChange(false);
        onStarted({ primarySessionId: result.workerSessionId, loopId: result.loop?.loopId, notice: 'Worker started · Judge ready' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setStartError(`${message} Resolve the reported provider, workspace, or Agent state, then retry Run workflow.`);
      onError(message);
    } finally {
      setIsStarting(false);
    }
  };

  const save = async () => {
    if (!runtimeApi || !validation.ok || !saveName.trim() || isSaving) return;
    setIsSaving(true);
    try {
      await runtimeApi.saveTemplate({
        name: saveName.trim(),
        workflowSpec: { version: 1, kind, input: payload } as SavedWorkflowSpec,
      });
      initialPayloadRef.current = JSON.stringify(payload);
      onDirtyChange(false);
      setSaveName('');
      await onSaved();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-2.5 space-y-3 border-t border-border/70 pt-3">
      {agentFields(kind === 'goal-loop' ? 'Worker' : 'Source', source, setSource)}
      {kind === 'handoff' ? (
        <>
          <ArrowDown className="mx-auto size-4 text-muted-foreground" />
          {agentFields('Receiver', target, setTarget)}
        </>
      ) : null}
      {kind === 'handoff' ? (
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Handoff note</span>
          <textarea className={textAreaClass} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      ) : (
        <section className="space-y-2 rounded-xl border border-border bg-card/60 p-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em]">
            <Flag className="size-3.5 text-lime-500" />
            Stop when
          </div>
          <textarea
            className={textAreaClass}
            aria-label="Goal"
            placeholder="Define done in one sentence"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <input
            className={fieldClass}
            type="number"
            min={1}
            max={99}
            aria-label="Max laps"
            value={maxLaps}
            onChange={(event) => setMaxLaps(event.target.value)}
          />
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Judge provider</span>
            <select
              className={fieldClass}
              value={judgeProviderInstanceId}
              onChange={(event) => {
                const providerInstanceId = event.target.value;
                setJudgeProviderInstanceId(providerInstanceId);
                const providerKind = instances.find((instance) => instance.providerInstanceId === providerInstanceId)?.kind;
                setJudgeModel(providerKind ? (modelOptionsForKind(providerKind)[0]?.value ?? '') : '');
              }}
            >
              <option value="">Inherit Worker provider</option>
              {instances.map((instance) => (
                <option key={instance.providerInstanceId} value={instance.providerInstanceId}>
                  {instance.label}
                </option>
              ))}
            </select>
          </label>
          {judgeProviderInstanceId ? (
            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Judge model</span>
              <input className={fieldClass} value={judgeModel} placeholder="Provider default" onChange={(event) => setJudgeModel(event.target.value)} />
            </label>
          ) : null}
          <p className="rounded-lg border border-border bg-background px-2.5 py-2 text-[10.5px] leading-4 text-muted-foreground">
            {judgeProviderInstanceId
              ? 'Judge uses this provider while inheriting the Worker workspace and trust settings.'
              : 'Judge inherits the Worker provider, model, workspace, and trust level so it can run the same checks.'}
          </p>
        </section>
      )}
      <section className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-3 text-[10.5px] leading-4">
        <div className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.1em]">
          <CheckCircle2 className="size-3.5" />
          Preview
        </div>
        <p className="mt-1.5 text-muted-foreground">
          {kind === 'handoff'
            ? source.mode === 'existing'
              ? 'Current result → Receiver now · one shot · no ongoing Relationship'
              : 'Source runs → one handoff → Receiver starts · Relationship stops after firing'
            : `Worker → Judge → Worker until done · max ${maxLaps || '?'} laps`}
        </p>
        <p className="mt-1 text-term-faint">Nothing runs until you press Run workflow.</p>
      </section>
      {validation.issues.length ? (
        <ul className="space-y-1 text-[10.5px] text-amber-700 dark:text-amber-300">
          {validation.issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>• {issue.message}</li>
          ))}
        </ul>
      ) : null}
      {setupMessages.length > 0 ? (
        <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-2 text-[10px] leading-4 text-destructive">
          <p className="font-medium">Setup needs attention before Run:</p>
          {setupMessages.map((message) => (
            <p key={message}>{message}</p>
          ))}
          <p>Open Provider settings or choose a valid workspace, then retry.</p>
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
      {startError ? <p className="rounded-lg border border-destructive/35 bg-destructive/10 p-2 text-[10px] leading-4 text-destructive">{startError}</p> : null}
      <div className="flex gap-2">
        <input
          className={fieldClass}
          aria-label="Saved workflow name"
          placeholder="Save this workflow as…"
          value={saveName}
          onChange={(event) => setSaveName(event.target.value)}
        />
        <Button variant="outline" size="sm" disabled={!runtimeApi || !validation.ok || !saveName.trim() || isSaving} onClick={() => void save()}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <Button
        className="h-8 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
        disabled={!runtimeApi || !validation.ok || setupMessages.length > 0 || preflightPending || isStarting}
        onClick={() => void start()}
      >
        {isStarting ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
        {isStarting ? 'Starting…' : 'Run workflow'}
      </Button>
    </div>
  );
}
