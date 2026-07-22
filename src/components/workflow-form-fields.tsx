import type { ProviderInstance, ProviderKind, ProviderReasoningEffort, ProviderRuntimeMode } from '@/shared/provider-runtime';
import { defaultProviderRuntimeSettings, providerCapability, providerReasoningEfforts, providerSupportsReasoningEffort } from '@/shared/provider-runtime';
import { modelOptionsForInstance, providerInstanceForKind, providerOptions, reasoningEffortOptionsForKind } from '@/lib/provider-catalog';
import type { GraphState } from '@/shared/graph-state';
import type { ReviewBlockingMode } from '@shared/review-workflow';

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-term-accent-hi/60';

export type AgentRuntimeConfigValue = {
  providerKind: ProviderKind;
  providerInstanceId: string;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
  runtimeMode: ProviderRuntimeMode;
};

export function AgentRuntimeFields({
  value,
  instances,
  modelCatalogs,
  idPrefix,
  onChange,
}: {
  value: AgentRuntimeConfigValue;
  instances: ProviderInstance[];
  modelCatalogs?: GraphState['providerModelCatalogs'];
  idPrefix: string;
  onChange: (value: AgentRuntimeConfigValue) => void;
}) {
  const updateProvider = (providerKind: ProviderKind) => {
    const reasoningEfforts = providerReasoningEfforts(providerKind);
    onChange({
      ...value,
      providerKind,
      providerInstanceId: providerInstanceForKind(instances, providerKind).providerInstanceId,
      model: '',
      reasoningEffort: reasoningEfforts.includes(value.reasoningEffort)
        ? value.reasoningEffort
        : (reasoningEfforts.includes('medium') ? 'medium' : (reasoningEfforts[0] ?? value.reasoningEffort)),
      runtimeMode: providerCapability(providerKind).runtimeModes[0]?.id ?? defaultProviderRuntimeSettings.runtimeMode,
    });
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Provider</span>
          <select className={fieldClass} value={value.providerKind} onChange={(event) => updateProvider(event.target.value as ProviderKind)}>
            {providerOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Profile</span>
          <select
            className={fieldClass}
            value={value.providerInstanceId}
            onChange={(event) => onChange({ ...value, providerInstanceId: event.target.value, model: '' })}
          >
            {instances
              .filter((instance) => instance.kind === value.providerKind)
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
          <input
            className={fieldClass}
            list={`${idPrefix}-models`}
            aria-label={`Model for ${idPrefix}: ${value.model.trim() || 'Provider default'}`}
            value={value.model}
            placeholder="Provider default"
            onChange={(event) => onChange({ ...value, model: event.target.value })}
          />
          <datalist id={`${idPrefix}-models`}>
            {modelOptionsForInstance(modelCatalogs, value.providerKind, value.providerInstanceId).map((option) => (
              <option key={option.value} value={option.value} />
            ))}
          </datalist>
        </label>
        <label className="space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Runtime</span>
          <select
            className={fieldClass}
            value={value.runtimeMode}
            onChange={(event) => onChange({ ...value, runtimeMode: event.target.value as ProviderRuntimeMode })}
          >
            {providerCapability(value.providerKind).runtimeModes.length > 0 ? (
              providerCapability(value.providerKind).runtimeModes.map((option) => (
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
      {providerSupportsReasoningEffort(value.providerKind) ? (
        <label className="block space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Reasoning</span>
          <select
            className={fieldClass}
            value={value.reasoningEffort}
            onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value as ProviderReasoningEffort })}
          >
            {reasoningEffortOptionsForKind(value.providerKind).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export type ReviewPolicyValue = {
  blockingMode: ReviewBlockingMode;
  customCriteria: string;
  maxLaps: string;
};

export function ReviewPolicyFields({ value, onChange }: { value: ReviewPolicyValue; onChange: (value: ReviewPolicyValue) => void }) {
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Blocking issues</span>
        <select
          className={fieldClass}
          value={value.blockingMode}
          onChange={(event) => onChange({ ...value, blockingMode: event.target.value as ReviewBlockingMode })}
        >
          <option value="any-issue">Any issue blocks</option>
          <option value="p0-p1">P0/P1 only</option>
          <option value="custom">Custom criteria</option>
        </select>
      </label>
      {value.blockingMode === 'custom' ? (
        <textarea
          className="min-h-16 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[11.5px]"
          value={value.customCriteria}
          placeholder="Example: security, data loss, or failing acceptance tests"
          onChange={(event) => onChange({ ...value, customCriteria: event.target.value })}
        />
      ) : null}
      <label className="block space-y-1">
        <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Max laps · 1–99</span>
        <input
          className={fieldClass}
          type="number"
          min={1}
          max={99}
          value={value.maxLaps}
          onChange={(event) => onChange({ ...value, maxLaps: event.target.value })}
        />
      </label>
    </div>
  );
}
