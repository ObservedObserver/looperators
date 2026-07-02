import { type AgentSession, type WorkMode } from '@/shared/graph-state';
import {
  type ProviderAgentKind,
  type ProviderInstance,
  type ProviderKind,
  type ProviderReasoningEffort,
  type ProviderRuntimeMode,
  type ProviderRuntimeSettings,
  providerCapability,
  providerRuntimeModeCapability,
  providerSupportsReasoningEffort,
} from '@/shared/provider-runtime';

export const providerOptions: {
  id: ProviderKind;
  agent: ProviderAgentKind;
  label: string;
}[] = [
  {
    id: 'claude-code',
    agent: providerCapability('claude-code').agent,
    label: providerCapability('claude-code').label,
  },
  {
    id: 'codex',
    agent: providerCapability('codex').agent,
    label: providerCapability('codex').label,
  },
  {
    id: 'legacy-claude-cli',
    agent: providerCapability('legacy-claude-cli').agent,
    label: providerCapability('legacy-claude-cli').label,
  },
];

export function providerOption(providerKind: ProviderKind) {
  return providerOptions.find((option) => option.id === providerKind) ?? providerOptions[0];
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

export function defaultProviderInstanceIdForKind(providerKind: ProviderKind) {
  switch (providerKind) {
    case 'codex':
      return 'default-codex';
    case 'legacy-claude-cli':
      return 'legacy-claude-cli';
    case 'claude-code':
    default:
      return 'default-claude-sdk';
  }
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

export function providerInstanceFromDraft(input: {
  instance: ProviderInstance;
  label: string;
  binaryPath: string;
  homePath: string;
  shadowHomePath: string;
  launchArgs: string;
}): ProviderInstance {
  const launchArgs = input.launchArgs
    .split('\n')
    .map((arg) => arg.trim())
    .filter(Boolean);
  return {
    providerInstanceId: input.instance.providerInstanceId,
    kind: input.instance.kind,
    label: input.label.trim() || input.instance.label,
    ...(input.binaryPath.trim() ? { binaryPath: input.binaryPath.trim() } : {}),
    ...(input.homePath.trim() ? { homePath: input.homePath.trim() } : {}),
    ...(input.shadowHomePath.trim() ? { shadowHomePath: input.shadowHomePath.trim() } : {}),
    ...(launchArgs.length ? { launchArgs } : {}),
    ...(input.instance.env ? { env: input.instance.env } : {}),
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

export function providerSetupHints(providerKind: ProviderKind) {
  switch (providerKind) {
    case 'claude-code':
      return [
        'Confirm Claude SDK auth is available to the runtime.',
        'Check that this app can start @anthropic-ai/claude-agent-sdk.',
        'Use Legacy Claude CLI to isolate SDK setup from account setup.',
      ];
    case 'codex':
      return [
        'Confirm the Codex provider is enabled and authenticated.',
        'Check that the Codex app-server can access this workspace path.',
        'Restart the runtime after auth or provider changes.',
      ];
    case 'legacy-claude-cli':
      return [
        'Install the claude CLI and make sure the runtime can find it on PATH.',
        'Run claude login in the same user environment.',
        'Check shell startup files if Terminal works but Orrery cannot start it.',
      ];
  }
}
