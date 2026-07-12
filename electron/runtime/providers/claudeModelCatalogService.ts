import { providerClaudeCommand, providerEnv, providerExtraArgs } from './claudeAgentSdkAdapter.js';

const inFlight = new Map<string, Promise<any>>();

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function probeKey(providerInstance: any, cwd: string) {
  return JSON.stringify([
    providerInstance?.providerInstanceId ?? 'default-claude-sdk',
    providerInstance?.binaryPath ?? '',
    providerInstance?.homePath ?? '',
    providerInstance?.launchArgs ?? [],
    Object.entries(providerInstance?.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    cwd,
  ]);
}

async function executeClaudeModelCatalogProbe({
  providerInstance,
  cwd,
  totalTimeoutMs = 15_000,
}: {
  providerInstance?: any;
  cwd: string;
  totalTimeoutMs?: number;
}) {
  const abortController = new AbortController();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query(
    /** @type {any} */ {
      // oxlint-disable-next-line require-yield -- initialization-only SDK probe
      prompt: (async function* () {
        await waitForAbort(abortController.signal);
      })(),
      options: {
        cwd,
        persistSession: false,
        pathToClaudeCodeExecutable: providerClaudeCommand(providerInstance),
        ...(providerExtraArgs(providerInstance) ? { extraArgs: providerExtraArgs(providerInstance) } : {}),
        settingSources: ['user', 'project', 'local'],
        allowedTools: [],
        abortController,
        env: providerEnv(providerInstance),
        stderr: () => {},
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init: any = await Promise.race([
      q.initializationResult(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out discovering Claude models.')), totalTimeoutMs);
      }),
    ]);
    const availableModels = normalizeClaudeCatalogModels(Array.isArray(init?.models) ? init.models : []);
    return {
      currentModelId: 'default',
      availableModels,
      setupCreatesSession: false as const,
    };
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
    q.close();
  }
}

export function probeClaudeModelCatalog(input: { providerInstance?: any; cwd: string; totalTimeoutMs?: number }) {
  const key = probeKey(input.providerInstance, input.cwd);
  const active = inFlight.get(key);
  if (active) return active;
  const promise = executeClaudeModelCatalogProbe(input).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export function normalizeClaudeCatalogModels(models: any[]) {
  return models.flatMap((model: any) => {
    if (!nonEmptyString(model?.value) || model.value.trim() === 'default') {
      return [];
    }
    const efforts = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter(nonEmptyString).map((value: string) => value.trim()) : [];
    return [
      {
        modelId: model.value.trim(),
        name: nonEmptyString(model.displayName) ? model.displayName.trim() : model.value.trim(),
        ...(nonEmptyString(model.description) ? { description: model.description.trim() } : {}),
        ...(model.supportsEffort === true || efforts.length > 0
          ? {
              supportsReasoningEffort: true,
              ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
            }
          : {}),
        metadata: {
          supportsAdaptiveThinking: model.supportsAdaptiveThinking === true,
          supportsFastMode: model.supportsFastMode === true,
          supportsAutoMode: model.supportsAutoMode === true,
        },
      },
    ];
  });
}
