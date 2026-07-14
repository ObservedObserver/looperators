import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentRuntimeFields, type AgentRuntimeConfigValue } from '@/components/workflow-form-fields';
import type { GraphState, StartPlanCouncilInput, StartPlanCouncilResult } from '@/shared/graph-state';
import { providerReasoningEfforts, providerSupportsReasoningEffort, type ProviderKind } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { providerInstanceForKind } from '@/lib/provider-catalog';
import { validatePlanCouncilStart } from '@shared/plan-council';
import { authorAndCommitWorkflow } from '@/lib/workflow-authoring';

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-term-accent-hi/60';
const textAreaClass = 'min-h-20 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px] leading-5 outline-none focus:border-term-accent-hi/60';

type AgentDraft = AgentRuntimeConfigValue & { key: string; label: string };

function createAgent(runtimeState: GraphState, key: string, label: string, providerKind: ProviderKind): AgentDraft {
  const efforts = providerReasoningEfforts(providerKind);
  return {
    key,
    label,
    providerKind,
    providerInstanceId: providerInstanceForKind(runtimeState.providerInstances, providerKind).providerInstanceId,
    model: '',
    reasoningEffort: efforts.includes('high') ? 'high' : (efforts[0] ?? 'medium'),
    runtimeMode: 'approval-required',
  };
}

function toSpec(agent: AgentDraft) {
  return {
    key: agent.key,
    label: agent.label,
    providerKind: agent.providerKind,
    providerInstanceId: agent.providerInstanceId,
    runtimeSettings: {
      runtimeMode: 'approval-required' as const,
      sandbox: 'read-only' as const,
      ...(providerSupportsReasoningEffort(agent.providerKind) ? { reasoningEffort: agent.reasoningEffort } : {}),
      interactionMode: 'plan' as const,
      ...(agent.model.trim() ? { model: agent.model.trim() } : {}),
    },
  };
}

export function PlanCouncilComposer({
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
  onStarted: (result: StartPlanCouncilResult) => void;
}) {
  const [objective, setObjective] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [reviewFocus, setReviewFocus] = useState('');
  const [planners, setPlanners] = useState<AgentDraft[]>(() => [
    createAgent(runtimeState, 'planner-a', 'Planner A', 'claude-code'),
    createAgent(runtimeState, 'planner-b', 'Planner B', 'codex'),
    createAgent(runtimeState, 'planner-c', 'Planner C', 'grok'),
  ]);
  const [synthesizer, setSynthesizer] = useState<AgentDraft>(() =>
    createAgent(runtimeState, 'synthesizer', 'Synthesizer', 'codex'),
  );
  const [isStarting, setIsStarting] = useState(false);
  const initialRef = useRef<string | undefined>(undefined);

  const payload = useMemo<StartPlanCouncilInput>(
    () => ({
      objective,
      cwd,
      ...(reviewFocus.trim() ? { reviewFocus } : {}),
      planners: planners.map(toSpec),
      synthesizer: toSpec(synthesizer),
    }),
    [cwd, objective, planners, reviewFocus, synthesizer],
  );
  const validation = useMemo(
    () =>
      validatePlanCouncilStart(payload, {
        providerInstanceIds: runtimeState.providerInstances.map((instance) => instance.providerInstanceId),
      }),
    [payload, runtimeState.providerInstances],
  );

  useEffect(() => {
    const serialized = JSON.stringify(payload);
    initialRef.current ??= serialized;
    onDirtyChange(serialized !== initialRef.current);
  }, [onDirtyChange, payload]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const updatePlanner = (index: number, patch: Partial<AgentDraft>) => {
    setPlanners((current) => current.map((planner, candidate) => (candidate === index ? { ...planner, ...patch } : planner)));
  };

  const start = async () => {
    if (!runtimeApi || !validation.ok || isStarting) return;
    setIsStarting(true);
    try {
      const committed = await authorAndCommitWorkflow<StartPlanCouncilResult>(runtimeApi, {
        recipe: 'plan-council',
        objective: payload.objective,
        recipeInput: payload as unknown as Record<string, unknown>,
        reason: 'The human configured and explicitly ran Plan Council from the standalone composer.',
      });
      const result = { ...committed.result, state: committed.state };
      onStateChange(committed.state);
      onDirtyChange(false);
      onStarted(result);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-border/70 pt-3">
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Planning task</span>
        <textarea className={textAreaClass} value={objective} onChange={(event) => setObjective(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Workspace · read-only</span>
        <input className={fieldClass} value={cwd} onChange={(event) => setCwd(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Review focus · optional</span>
        <textarea className={textAreaClass} value={reviewFocus} onChange={(event) => setReviewFocus(event.target.value)} />
      </label>

      <section className="space-y-2 rounded-xl border border-border bg-background p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-medium">Independent planners</h3>
          <span className="ml-auto text-[10px] text-muted-foreground">{planners.length} · max 4</span>
        </div>
        {planners.map((planner, index) => (
          <div key={planner.key} className="space-y-2 rounded-lg border border-border/70 p-2.5">
            <div className="flex gap-2">
              <input
                className={fieldClass}
                aria-label={`Planner ${index + 1} name`}
                value={planner.label}
                onChange={(event) => updatePlanner(index, { label: event.target.value })}
              />
              <Button
                variant="ghost"
                size="icon"
                disabled={planners.length <= 2}
                aria-label={`Remove ${planner.label}`}
                onClick={() => setPlanners((current) => current.filter((_, candidate) => candidate !== index))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <AgentRuntimeFields
              value={planner}
              instances={runtimeState.providerInstances}
              modelCatalogs={runtimeState.providerModelCatalogs}
              idPrefix={`plan-council-planner-${index}`}
              onChange={(value) => updatePlanner(index, value)}
            />
          </div>
        ))}
        <Button
          className="w-full"
          variant="outline"
          size="sm"
          disabled={planners.length >= 4}
          onClick={() => {
            const index = planners.length + 1;
            setPlanners((current) => [
              ...current,
              createAgent(runtimeState, `planner-${index}`, `Planner ${index}`, 'codex'),
            ]);
          }}
        >
          <Plus className="size-3.5" /> Add planner
        </Button>
      </section>

      <section className="space-y-2 rounded-xl border border-border bg-background p-3">
        <h3 className="text-[11px] font-medium">Synthesizer</h3>
        <input className={fieldClass} value={synthesizer.label} onChange={(event) => setSynthesizer((current) => ({ ...current, label: event.target.value }))} />
        <AgentRuntimeFields
          value={synthesizer}
          instances={runtimeState.providerInstances}
          modelCatalogs={runtimeState.providerModelCatalogs}
          idPrefix="plan-council-synthesizer"
          onChange={(value) => setSynthesizer((current) => ({ ...current, ...value }))}
        />
      </section>

      <section className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-2.5 text-[10.5px] leading-4">
        <p className="font-semibold uppercase tracking-[0.1em]">Preview</p>
        <p className="mt-1 text-muted-foreground">
          {planners.length} read-only plans in parallel → human gate → one peer-review turn each → human gate → final synthesis.
        </p>
        <p className="mt-1 text-term-faint">Nothing runs until Run workflow.</p>
      </section>

      {validation.issues.length ? (
        <ul className="space-y-1 text-[10.5px] text-term-amber">
          {validation.issues.map((issue) => <li key={`${issue.field}:${issue.message}`}>• {issue.message}</li>)}
        </ul>
      ) : null}
      <Button className="h-8 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]" size="sm" disabled={!runtimeApi || !validation.ok || isStarting} onClick={() => void start()}>
        <Play className="size-3" /> {isStarting ? 'Starting atomically…' : 'Run workflow'}
      </Button>
    </div>
  );
}
