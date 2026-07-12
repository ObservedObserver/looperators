import type { ProviderKind } from './provider-metadata.js';

export type ProviderModelCatalogSource = 'live' | 'cache' | 'fallback';

export type ProviderModel = {
  modelId: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEfforts?: string[];
  serviceTiers?: string[];
  metadata?: Record<string, unknown>;
};

export type ProviderModelCatalog = {
  providerKind: ProviderKind;
  providerInstanceId: string;
  fetchedAt: string;
  source: ProviderModelCatalogSource;
  stale: boolean;
  currentModelId?: string;
  defaultModelId?: string;
  availableModels: ProviderModel[];
  setupCreatesSession: boolean;
  error?: string;
};

export const fallbackProviderModels: Record<ProviderKind, ProviderModel[]> = {
  'claude-code': [
    { modelId: 'sonnet', name: 'Sonnet' },
    { modelId: 'opus', name: 'Opus' },
    { modelId: 'haiku', name: 'Haiku' },
  ],
  codex: [],
  grok: [{ modelId: 'grok-build', name: 'Grok Build' }],
};

export function fallbackProviderModelCatalog(providerKind: ProviderKind, providerInstanceId: string, error?: string): ProviderModelCatalog {
  return {
    providerKind,
    providerInstanceId,
    fetchedAt: new Date().toISOString(),
    source: 'fallback',
    stale: true,
    availableModels: fallbackProviderModels[providerKind].map((model) => ({ ...model })),
    setupCreatesSession: providerKind === 'grok',
    ...(error ? { error } : {}),
  };
}
