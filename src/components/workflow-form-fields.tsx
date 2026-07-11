import type { ProviderInstance, ProviderKind, ProviderReasoningEffort, ProviderRuntimeMode } from '@/shared/provider-runtime';
import { providerCapability } from '@/shared/provider-runtime';
import { modelOptionsForKind, providerInstanceForKind, providerOptions, reasoningEffortOptions } from '@/lib/provider-catalog';
import type { ReviewBlockingMode } from '@shared/review-workflow';

const fieldClass = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[11.5px] outline-none focus:border-lime-hi/60';

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
  idPrefix,
  onChange,
}: {
  value: AgentRuntimeConfigValue;
  instances: ProviderInstance[];
  idPrefix: string;
  onChange: (value: AgentRuntimeConfigValue) => void;
}) {
  const updateProvider = (providerKind: ProviderKind) => {
    onChange({
      ...value,
      providerKind,
      providerInstanceId: providerInstanceForKind(instances, providerKind).providerInstanceId,
      model: providerKind === 'codex' ? (modelOptionsForKind(providerKind)[0]?.value ?? '') : '',
      runtimeMode: providerCapability(providerKind).runtimeModes[0]?.id ?? 'approval-required',
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
          <select className={fieldClass} value={value.providerInstanceId} onChange={(event) => onChange({ ...value, providerInstanceId: event.target.value })}>
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
            value={value.model}
            placeholder="Provider default"
            onChange={(event) => onChange({ ...value, model: event.target.value })}
          />
          <datalist id={`${idPrefix}-models`}>
            {modelOptionsForKind(value.providerKind).map((option) => (
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
      {value.providerKind === 'codex' ? (
        <label className="block space-y-1">
          <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Reasoning</span>
          <select
            className={fieldClass}
            value={value.reasoningEffort}
            onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value as ProviderReasoningEffort })}
          >
            {reasoningEffortOptions.map((option) => (
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
