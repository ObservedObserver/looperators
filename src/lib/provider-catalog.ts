import { type AgentSession, type WorkMode } from '@/shared/graph-state';
import {
  type ProviderAgentKind,
  type ProviderInstance,
  type ProviderKind,
  type ProviderReasoningEffort,
  type ProviderRuntimeMode,
  type ProviderRuntimeSettings,
  providerCapabilities,
  providerRuntimeModeCapability,
  providerReasoningEfforts,
  providerSupportsReasoningEffort,
} from '@/shared/provider-runtime';
import { parseProviderEnvText } from '@shared/provider-setup';

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

// Curated, per-agent model presets. Values are the real model ids each runtime
// accepts (Claude Agent SDK / Codex app-server); the picker also exposes a
// "Default" (no override — let the provider decide) and a "Custom…" escape
// hatch for ids not listed here.

export const modelCatalog: Record<ProviderAgentKind, { value: string; label: string }[]> = {
  'claude-code': [
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  ],
  // Grok model ids are discovered lazily from ACP initialize metadata. Until
  // discovery is available, the picker keeps Default plus its Custom escape hatch.
  grok: [],
};

export function modelOptionsForKind(providerKind: ProviderKind) {
  return modelCatalog[providerOption(providerKind).agent] ?? [];
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
    effectiveRuntimeConfig?.modeLabel ?? providerRuntimeModeCapability(providerKind, runtimeSettings?.runtimeMode ?? 'approval-required')?.effectiveLabel;
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
    'Orrery reuses the local Grok CLI login or XAI_API_KEY; it does not store credentials.',
  ],
};

export function providerSetupHints(providerKind: ProviderKind) {
  return providerSetupHintCatalog[providerKind];
}
