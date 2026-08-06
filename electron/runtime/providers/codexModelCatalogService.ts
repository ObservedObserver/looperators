import { CodexJsonRpcClient } from './codexJsonRpcClient.js';

const inFlight = new Map<string, Promise<any>>();
const cache = new Map<string, { result: any; checkedAt: number }>();
const probeTtlMs = 60_000;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function reasoningEfforts(model: any) {
  return Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((entry: any) => (nonEmptyString(entry?.reasoningEffort) ? [entry.reasoningEffort.trim()] : []))
    : [];
}

function serviceTiers(model: any) {
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
  return tiers.flatMap((entry: any) => {
    if (nonEmptyString(entry)) return [entry.trim()];
    return nonEmptyString(entry?.id) ? [entry.id.trim()] : [];
  });
}

export function normalizeCodexCatalogModel(model: any) {
  const modelId = nonEmptyString(model?.model) ? model.model.trim() : nonEmptyString(model?.id) ? model.id.trim() : undefined;
  if (!modelId) return undefined;
  const efforts = reasoningEfforts(model);
  const tiers = serviceTiers(model);
  return {
    modelId,
    name: nonEmptyString(model?.displayName) ? model.displayName.trim() : modelId,
    ...(nonEmptyString(model?.description) ? { description: model.description.trim() } : {}),
    ...(model?.isDefault === true ? { isDefault: true } : {}),
    ...(efforts.length > 0 ? { supportsReasoningEffort: true, reasoningEfforts: efforts } : {}),
    ...(tiers.length > 0 ? { serviceTiers: tiers } : {}),
    metadata: {
      hidden: model?.hidden === true,
      inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities : [],
      supportsPersonality: model?.supportsPersonality === true,
      ...(nonEmptyString(model?.defaultReasoningEffort) ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      ...(nonEmptyString(model?.defaultServiceTier) ? { defaultServiceTier: model.defaultServiceTier } : {}),
    },
  };
}

function probeKey(providerInstance: any, cwd: string) {
  return JSON.stringify([
    providerInstance?.providerInstanceId ?? 'default-codex',
    providerInstance?.binaryPath ?? '',
    providerInstance?.homePath ?? '',
    providerInstance?.shadowHomePath ?? '',
    providerInstance?.launchArgs ?? [],
    Object.entries(providerInstance?.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    cwd,
  ]);
}

function codexAccountLabel(account: any) {
  if (nonEmptyString(account?.email)) return account.email.trim();
  if (nonEmptyString(account?.type)) return account.type.trim();
  return undefined;
}

async function executeCodexProviderProbe({
  providerInstance,
  cwd,
  totalTimeoutMs = 15_000,
}: {
  providerInstance?: any;
  cwd: string;
  totalTimeoutMs?: number;
}) {
  const deadline = Date.now() + totalTimeoutMs;
  const client = new CodexJsonRpcClient({ cwd, providerInstance });
  // Probe failures are reported through the pending request promise. Keep the
  // EventEmitter error channel observed so a malformed/failed child cannot
  // become an uncaught process-level exception.
  client.on('error', () => {});
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const initialize: any = await client.request(
      'initialize',
      {
        clientInfo: { name: 'orrery', title: 'Orrery', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: remaining() },
    );
    client.notify('initialized');

    let accountResponse: any;
    let accountError: string | undefined;
    try {
      accountResponse = await client.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: remaining() },
      );
    } catch (error) {
      accountError = error instanceof Error ? error.message : String(error);
    }

    const account = accountResponse?.account;
    const requiresOpenaiAuth = accountResponse?.requiresOpenaiAuth;
    const auth = account
      ? {
          status: 'authenticated' as const,
          ...(codexAccountLabel(account) ? { accountLabel: codexAccountLabel(account) } : {}),
          ...(nonEmptyString(account?.type) ? { method: account.type.trim() } : {}),
        }
      : requiresOpenaiAuth === false
        ? {
            status: 'not-required' as const,
            method: 'custom-provider',
          }
        : requiresOpenaiAuth === true
          ? { status: 'unauthenticated' as const }
          : { status: 'unknown' as const };

    const availableModels: any[] = [];
    let modelError: string | undefined;
    if (auth.status !== 'unauthenticated') {
      try {
        let cursor: string | null | undefined;
        do {
          const response: any = await client.request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: false }, { timeoutMs: remaining() });
          for (const raw of Array.isArray(response?.data) ? response.data : []) {
            const model = normalizeCodexCatalogModel(raw);
            if (model) availableModels.push(model);
          }
          cursor = nonEmptyString(response?.nextCursor) ? response.nextCursor.trim() : undefined;
        } while (cursor);
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
    }

    const defaultModelId = availableModels.find((model) => model.isDefault)?.modelId;
    return {
      version: nonEmptyString(initialize?.userAgent) ? initialize.userAgent.trim() : undefined,
      auth,
      ...(accountError ? { accountError } : {}),
      ...(modelError ? { modelError } : {}),
      catalog: {
        ...(defaultModelId ? { defaultModelId, currentModelId: defaultModelId } : {}),
        availableModels,
        setupCreatesSession: false as const,
      },
    };
  } finally {
    client.close();
  }
}

export function probeCodexModelCatalog(input: { providerInstance?: any; cwd: string; totalTimeoutMs?: number; forceRefresh?: boolean }) {
  return probeCodexProvider(input).then((result) => result.catalog);
}

export function probeCodexProvider(input: { providerInstance?: any; cwd: string; totalTimeoutMs?: number; forceRefresh?: boolean }) {
  const key = probeKey(input.providerInstance, input.cwd);
  const cached = cache.get(key);
  if (!input.forceRefresh && cached && Date.now() - cached.checkedAt < probeTtlMs) {
    return Promise.resolve(cached.result);
  }
  const active = inFlight.get(key);
  if (active) return active;
  const promise = executeCodexProviderProbe(input)
    .then((result) => {
      cache.set(key, { result, checkedAt: Date.now() });
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
