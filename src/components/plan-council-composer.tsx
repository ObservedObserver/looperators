import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentRuntimeFields, type AgentRuntimeConfigValue } from '@/components/workflow-form-fields';
import type { GraphState, StartPlanCouncilInput, StartPlanCouncilResult } from '@/shared/graph-state';
import { providerReasoningEfforts, providerSupportsReasoningEffort, type ProviderKind } from '@/shared/provider-runtime';
import type { RuntimeApi } from '@/runtime-client';
import { providerInstanceForKind } from '@/lib/provider-catalog';
import { validatePlanCouncilStart, type PlanCouncilAgentSpec } from '@shared/plan-council';
import { authorAndCommitWorkflow } from '@/lib/workflow-authoring';

const fieldClass = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const textAreaClass =
  'min-h-20 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring';

type AgentDraft = AgentRuntimeConfigValue & { key: string; label: string; instructions: string };

function createAgent(runtimeState: GraphState, key: string, label: string, providerKind: ProviderKind): AgentDraft {
  const efforts = providerReasoningEfforts(providerKind);
  return {
    key,
    label,
    instructions: '',
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
    instructions: agent.instructions,
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
  initialPlanners,
  initialSynthesizer,
  initialObjective = '',
  initialReviewFocus = '',
}: {
  runtimeApi: RuntimeApi | undefined;
  runtimeState: GraphState;
  defaultCwd: string;
  onStateChange: (state: GraphState) => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onStarted: (result: StartPlanCouncilResult) => void;
  initialPlanners?: PlanCouncilAgentSpec[];
  initialSynthesizer?: PlanCouncilAgentSpec;
  initialObjective?: string;
  initialReviewFocus?: string;
}) {
  const fromSpec = (spec: PlanCouncilAgentSpec): AgentDraft => ({
    ...createAgent(runtimeState, spec.key, spec.label, spec.providerKind),
    providerInstanceId: spec.providerInstanceId,
    instructions: spec.instructions ?? '',
    model: spec.runtimeSettings.model ?? '',
    reasoningEffort: spec.runtimeSettings.reasoningEffort ?? 'high',
  });
  const defaultProvider = runtimeState.providerInstances[0]?.kind ?? 'codex';
  const [objective, setObjective] = useState(initialObjective);
  const [cwd, setCwd] = useState(defaultCwd);
  const [reviewFocus, setReviewFocus] = useState(initialReviewFocus);
  const [planners, setPlanners] = useState<AgentDraft[]>(() =>
    initialPlanners?.length
      ? initialPlanners.slice(0, 4).map(fromSpec)
      : [
          {
            ...createAgent(runtimeState, 'planner-a', 'Solution designer', defaultProvider),
            instructions: 'Find the simplest viable approach and explain its tradeoffs.',
          },
          {
            ...createAgent(runtimeState, 'planner-b', 'Critical reviewer', defaultProvider),
            instructions: 'Find counterexamples, missing constraints, and implementation risks.',
          },
        ],
  );
  const [synthesizer, setSynthesizer] = useState<AgentDraft>(() =>
    initialSynthesizer ? fromSpec(initialSynthesizer) : createAgent(runtimeState, 'synthesizer', 'Decision writer', defaultProvider),
  );
  const [advancement, setAdvancement] = useState<'human' | 'auto'>('human');
  const [isStarting, setIsStarting] = useState(false);
  const initialRef = useRef<string | undefined>(undefined);

  const payload = useMemo<StartPlanCouncilInput>(
    () => ({
      objective,
      cwd,
      ...(reviewFocus.trim() ? { reviewFocus } : {}),
      planners: planners.map(toSpec),
      synthesizer: toSpec(synthesizer),
      advancement: { crossReview: advancement, synthesis: advancement },
    }),
    [cwd, objective, planners, reviewFocus, synthesizer, advancement],
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
        <span className="text-xs font-medium">What do you need to decide?</span>
        <textarea className={textAreaClass} value={objective} placeholder="Compare approaches for…" onChange={(event) => setObjective(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Workspace · read-only</span>
        <input className={fieldClass} value={cwd} onChange={(event) => setCwd(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Constraints and questions · optional</span>
        <textarea
          className={textAreaClass}
          value={reviewFocus}
          placeholder="Budget, compatibility, deadlines, or assumptions to challenge"
          onChange={(event) => setReviewFocus(event.target.value)}
        />
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
            <label className="block space-y-1 text-xs">
              Responsibility
              <input
                className={fieldClass}
                value={planner.instructions}
                maxLength={2000}
                onChange={(event) => updatePlanner(index, { instructions: event.target.value })}
              />
            </label>
            <details>
              <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
                {planner.providerKind} · {planner.model || 'Provider default'} · Configure model
              </summary>
              <AgentRuntimeFields
                hideRuntime
                value={planner}
                instances={runtimeState.providerInstances}
                modelCatalogs={runtimeState.providerModelCatalogs}
                idPrefix={`plan-council-planner-${index}`}
                onChange={(value) => updatePlanner(index, value)}
              />
            </details>
          </div>
        ))}
        <Button
          className="w-full"
          variant="outline"
          size="sm"
          disabled={planners.length >= 4}
          onClick={() => {
            const index = planners.length + 1;
            setPlanners((current) => [...current, createAgent(runtimeState, globalThis.crypto.randomUUID(), `Perspective ${index}`, defaultProvider)]);
          }}
        >
          <Plus className="size-3.5" /> Add planner
        </Button>
      </section>

      <section className="space-y-2 rounded-xl border border-border bg-background p-3">
        <h3 className="text-sm font-medium">Final recommendation</h3>
        <input
          className={fieldClass}
          value={synthesizer.label}
          onChange={(event) => setSynthesizer((current) => ({ ...current, label: event.target.value }))}
        />
        <details>
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
            {synthesizer.providerKind} · {synthesizer.model || 'Provider default'} · Configure model
          </summary>
          <AgentRuntimeFields
            hideRuntime
            value={synthesizer}
            instances={runtimeState.providerInstances}
            modelCatalogs={runtimeState.providerModelCatalogs}
            idPrefix="plan-council-synthesizer"
            onChange={(value) => setSynthesizer((current) => ({ ...current, ...value }))}
          />
        </details>
      </section>

      <label className="block space-y-1 text-xs font-medium">
        Between stages
        <select className={fieldClass} value={advancement} onChange={(event) => setAdvancement(event.target.value as 'human' | 'auto')}>
          <option value="human">Pause for my input</option>
          <option value="auto">Continue automatically</option>
        </select>
      </label>
      <section className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-3 text-sm leading-6" data-testid="comparison-preview">
        <p className="font-semibold uppercase tracking-[0.1em]">Preview</p>
        <p className="mt-1 text-muted-foreground">
          {planners.length} independent proposals → {planners.length} peer reviews → one recommendation.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {2 * planners.length + 1} Agent turns before follow-up. Fresh, read-only sessions.{' '}
          {advancement === 'human' ? 'You can add constraints at each stage gate.' : 'Stages advance automatically.'} Nothing runs until you start.
        </p>
      </section>

      {validation.issues.length ? (
        <ul className="space-y-1 text-[10.5px] text-term-amber">
          {validation.issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>• {issue.message}</li>
          ))}
        </ul>
      ) : null}
      <Button
        className="h-8 w-full font-mono text-[10.5px] uppercase tracking-[0.06em]"
        size="sm"
        disabled={!runtimeApi || !validation.ok || isStarting}
        onClick={() => void start()}
      >
        <Play className="size-3" /> {isStarting ? 'Starting comparison…' : 'Run comparison'}
      </Button>
    </div>
  );
}
