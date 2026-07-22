import { type AgentSession, type GraphState, type WorkMode } from '@/shared/graph-state';
import {
  type ProviderAgentKind,
  type ProviderInstance,
  type ProviderKind,
  type ProviderReasoningEffort,
  type ProviderRuntimeMode,
  type ProviderRuntimeSettings,
  defaultProviderRuntimeSettings,
  providerCapabilities,
  providerRuntimeModeCapability,
  providerReasoningEfforts,
  providerSupportsReasoningEffort,
} from '@/shared/provider-runtime';
import { parseProviderEnvText } from '@shared/provider-setup';
import { fallbackProviderModels, type ProviderModelCatalog } from '@shared/provider-model-catalog';

export const providerOptions: {
  id: ProviderKind;
  agent: ProviderAgentKind;
  label: string;
}[] = Object.values(providerCapabilities).map((capability) => ({
  id: capability.providerKind,
  agent: capability.agent,
  label: capability.label,
}));

export function providerOption(providerKind: ProviderKind) {
  return providerOptions.find((option) => option.id === providerKind)!;
}

// Offline-only fallback. Live catalogs are stored per provider instance in
// GraphState and take precedence everywhere in the UI.
export const modelCatalog: Record<ProviderAgentKind, { value: string; label: string }[]> = Object.fromEntries(
  Object.entries(fallbackProviderModels).map(([kind, models]) => [
    kind,
    models.map((model) => ({ value: model.modelId, label: model.name })),
  ]),
) as Record<ProviderAgentKind, { value: string; label: string }[]>;

export function modelOptionsForKind(providerKind: ProviderKind) {
  return modelCatalog[providerOption(providerKind).agent] ?? [];
}

export function modelOptionsForCatalog(catalog: ProviderModelCatalog | undefined, providerKind: ProviderKind) {
  if (!catalog) return modelOptionsForKind(providerKind);
  return catalog.availableModels.map((model) => ({ value: model.modelId, label: model.name }));
}

export function modelCatalogForInstance(
  catalogs: GraphState['providerModelCatalogs'],
  providerInstanceId: string,
) {
  return catalogs?.[providerInstanceId];
}

export function modelOptionsForInstance(
  catalogs: GraphState['providerModelCatalogs'],
  providerKind: ProviderKind,
  providerInstanceId: string,
) {
  return modelOptionsForCatalog(modelCatalogForInstance(catalogs, providerInstanceId), providerKind);
}

export function modelLabelForKind(providerKind: ProviderKind, model: string | undefined) {
  const trimmed = (model ?? '').trim();
  if (!trimmed) {
    return 'Default';
  }
  return modelOptionsForKind(providerKind).find((option) => option.value === trimmed)?.label ?? trimmed;
}

const providerDefaultInstanceIds: Record<ProviderKind, string> = {
  'claude-code': 'default-claude-sdk',
  codex: 'default-codex',
  grok: 'default-grok',
};

export function defaultProviderInstanceIdForKind(providerKind: ProviderKind) {
  return providerDefaultInstanceIds[providerKind];
}

export function fallbackProviderInstance(providerKind: ProviderKind): ProviderInstance {
  const provider = providerOption(providerKind);
  return {
    providerInstanceId: defaultProviderInstanceIdForKind(providerKind),
    kind: providerKind,
    label: provider.label,
  };
}

export function providerInstanceForKind(providerInstances: ProviderInstance[], providerKind: ProviderKind) {
  return providerInstances.find((instance) => instance.kind === providerKind) ?? fallbackProviderInstance(providerKind);
}

export function launchArgsText(instance: ProviderInstance) {
  return (instance.launchArgs ?? []).join('\n');
}

export function providerEnvText(instance: ProviderInstance) {
  return Object.entries(instance.env ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function providerEnvFromText(value: string) {
  return parseProviderEnvText(value);
}

export function providerInstanceFromDraft(input: {
  instance: ProviderInstance;
  label: string;
  binaryPath: string;
  homePath: string;
  shadowHomePath: string;
  launchArgs: string;
  envText?: string;
}): ProviderInstance {
  const launchArgs = input.launchArgs
    .split('\n')
    .map((arg) => arg.trim())
    .filter(Boolean);
  const env = input.envText === undefined ? input.instance.env : providerEnvFromText(input.envText);
  return {
    providerInstanceId: input.instance.providerInstanceId,
    kind: input.instance.kind,
    label: input.label.trim() || input.instance.label,
    ...(input.binaryPath.trim() ? { binaryPath: input.binaryPath.trim() } : {}),
    ...(input.homePath.trim() ? { homePath: input.homePath.trim() } : {}),
    ...(input.shadowHomePath.trim() ? { shadowHomePath: input.shadowHomePath.trim() } : {}),
    ...(launchArgs.length ? { launchArgs } : {}),
    ...(env ? { env } : {}),
  };
}

export function providerRuntimeSettingsDraft({
  runtimeMode,
  model,
  reasoningEffort,
}: {
  runtimeMode: ProviderRuntimeMode;
  model: string;
  reasoningEffort: ProviderReasoningEffort;
}): ProviderRuntimeSettings {
  const trimmedModel = model.trim();
  return {
    runtimeMode,
    reasoningEffort,
    ...(trimmedModel ? { model: trimmedModel } : {}),
  };
}

export const workModeOptions: { id: WorkMode; label: string }[] = [
  { id: 'local', label: 'Local' },
  { id: 'worktree', label: 'Worktree' },
];

export const reasoningEffortOptions: { id: ProviderReasoningEffort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
];

export function reasoningEffortOptionsForKind(providerKind: ProviderKind) {
  const supported = new Set(providerReasoningEfforts(providerKind));
  return reasoningEffortOptions.filter((option) => supported.has(option.id));
}

// One-line summary of the runtime config (model · [effort] · mode), used in the
// chat header so the effective agent setup is always visible.

export function runtimeConfigSummary(
  providerKind: ProviderKind,
  runtimeSettings?: ProviderRuntimeSettings,
  effectiveRuntimeConfig?: AgentSession['effectiveRuntimeConfig'],
) {
  const parts: string[] = [modelLabelForKind(providerKind, effectiveRuntimeConfig?.model ?? runtimeSettings?.model)];
  const effort = effectiveRuntimeConfig?.reasoningEffort ?? runtimeSettings?.reasoningEffort;
  if (providerSupportsReasoningEffort(providerKind) && effort) {
    const effortLabel = reasoningEffortOptions.find((option) => option.id === effort)?.label;
    if (effortLabel) {
      parts.push(effortLabel);
    }
  }
  const modeLabel =
    effectiveRuntimeConfig?.modeLabel ?? providerRuntimeModeCapability(providerKind, runtimeSettings?.runtimeMode ?? defaultProviderRuntimeSettings.runtimeMode)?.effectiveLabel;
  if (modeLabel) {
    parts.push(modeLabel);
  }
  return parts.join(' · ');
}

const providerSetupHintCatalog: Record<ProviderKind, string[]> = {
  'claude-code': [
    'Confirm Claude SDK auth is available to the runtime.',
    'Check that this app can start @anthropic-ai/claude-agent-sdk.',
  ],
  codex: [
    'Confirm the Codex provider is enabled and authenticated.',
    'Check that the Codex app-server can access this workspace path.',
    'Restart the runtime after auth or provider changes.',
  ],
  grok: [
    'Confirm the Grok CLI is installed and authenticated.',
    'Check that `grok agent stdio` can access this workspace path.',
    'looperators reuses the local Grok CLI login or XAI_API_KEY; it does not store credentials.',
  ],
};

export function providerSetupHints(providerKind: ProviderKind) {
  return providerSetupHintCatalog[providerKind];
}
