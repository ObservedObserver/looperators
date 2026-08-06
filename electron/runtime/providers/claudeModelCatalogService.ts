import { providerClaudeCommand, providerEnv, providerExtraArgs } from './claudeAgentSdkAdapter.js';
import { spawn } from 'node:child_process';
import { resolveProviderLaunch } from './providerLaunch.js';

const inFlight = new Map<string, Promise<any>>();
const cache = new Map<string, { result: any; checkedAt: number }>();
const probeTtlMs = 60_000;

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function externalClaudeAuth(env: NodeJS.ProcessEnv) {
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') return { status: 'external' as const, method: 'Amazon Bedrock' };
  if (env.CLAUDE_CODE_USE_VERTEX === '1') return { status: 'external' as const, method: 'Google Vertex AI' };
  if (env.CLAUDE_CODE_USE_FOUNDRY === '1') return { status: 'external' as const, method: 'Microsoft Foundry' };
  if (nonEmptyString(env.ANTHROPIC_API_KEY) || nonEmptyString(env.ANTHROPIC_AUTH_TOKEN)) {
    return { status: 'external' as const, method: 'environment credential' };
  }
  return undefined;
}

export function normalizeClaudeAuthStatus(payload: any, env: NodeJS.ProcessEnv = {}) {
  const external = externalClaudeAuth(env);
  if (external) return external;
  if (payload?.loggedIn === false) return { status: 'unauthenticated' as const };
  if (payload?.loggedIn !== true) return { status: 'unknown' as const };
  const method = nonEmptyString(payload?.authMethod) ? payload.authMethod.trim() : undefined;
  const accountLabel = nonEmptyString(payload?.email)
    ? payload.email.trim()
    : nonEmptyString(payload?.orgName)
      ? payload.orgName.trim()
      : undefined;
  if (nonEmptyString(payload?.apiProvider) && payload.apiProvider !== 'firstParty') {
    return {
      status: 'external' as const,
      ...(method ? { method } : { method: payload.apiProvider.trim() }),
      ...(accountLabel ? { accountLabel } : {}),
    };
  }
  return {
    status: 'authenticated' as const,
    ...(method ? { method } : {}),
    ...(accountLabel ? { accountLabel } : {}),
  };
}

function claudeAccountLabel(account: any) {
  if (nonEmptyString(account?.email)) return account.email.trim();
  if (nonEmptyString(account?.organization)) return account.organization.trim();
  return undefined;
}

function claudeAuthMethod(account: any) {
  return [account?.apiProvider, account?.subscriptionType, account?.tokenSource, account?.apiKeySource]
    .find(nonEmptyString)
    ?.trim();
}

function authFromSdkAccount(account: any, env: NodeJS.ProcessEnv) {
  const external = externalClaudeAuth(env);
  if (external) return external;
  if (!account || typeof account !== 'object') return { status: 'unknown' as const };
  const method = claudeAuthMethod(account);
  const accountLabel = claudeAccountLabel(account);
  const hasAccountEvidence = Boolean(method || accountLabel || account?.organization || account?.organizationId);
  if (!hasAccountEvidence) return { status: 'unknown' as const };
  return {
    status: account.apiProvider && account.apiProvider !== 'firstParty'
      ? 'external' as const
      : 'authenticated' as const,
    ...(accountLabel ? { accountLabel } : {}),
    ...(method ? { method } : {}),
  };
}

function runClaudeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      forceTimer.unref?.();
      reject(new Error(`Timed out running Claude Code ${args.join(' ')}.`));
    }, Math.max(1, timeoutMs));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function probeVersion(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) {
  const result = await runClaudeCommand(command, [...args, '--version'], env, cwd, timeoutMs);
  const output = result.stdout || result.stderr;
  if (result.code === 0 && output) return output.split(/\r?\n/, 1)[0];
  throw new Error(output || `Claude Code --version exited with code ${result.code}.`);
}

export async function probeClaudeAuthStatus({
  providerInstance,
  cwd,
  timeoutMs = 4_000,
}: {
  providerInstance?: any;
  cwd: string;
  timeoutMs?: number;
}) {
  const launch = resolveProviderLaunch('claude-code', providerInstance);
  const result = await runClaudeCommand(
    launch.command,
    [...launch.launchArgs, 'auth', 'status', '--json'],
    launch.env,
    cwd,
    timeoutMs,
  );
  const output = result.stdout || result.stderr;
  let payload: any;
  try {
    payload = output ? JSON.parse(output) : undefined;
  } catch {
    throw new Error('Claude Code auth status returned invalid JSON.');
  }
  const auth = normalizeClaudeAuthStatus(payload, launch.env);
  if (result.code !== 0 && auth.status === 'unknown') {
    throw new Error(output || `Claude Code auth status exited with code ${result.code}.`);
  }
  return auth;
}

async function executeClaudeProviderProbe({
  providerInstance,
  cwd,
  totalTimeoutMs = 15_000,
  queryFactory,
}: {
  providerInstance?: any;
  cwd: string;
  totalTimeoutMs?: number;
  queryFactory?: (input: any) => any;
}) {
  const deadline = Date.now() + totalTimeoutMs;
  const launch = resolveProviderLaunch('claude-code', providerInstance);
  let version: string | undefined;
  let versionError: string | undefined;
  try {
    version = await probeVersion(
      launch.command,
      launch.launchArgs,
      launch.env,
      cwd,
      Math.min(4_000, Math.max(1, deadline - Date.now())),
    );
  } catch (error) {
    versionError = errorMessage(error);
  }

  let auth = { status: 'unknown' as const } as ReturnType<typeof normalizeClaudeAuthStatus>;
  let authError: string | undefined;
  try {
    auth = await probeClaudeAuthStatus({
      providerInstance,
      cwd,
      timeoutMs: Math.min(4_000, Math.max(1, deadline - Date.now())),
    });
  } catch (error) {
    authError = errorMessage(error);
    auth = normalizeClaudeAuthStatus(undefined, launch.env);
  }

  if (auth.status === 'unauthenticated') {
    return {
      ...(version ? { version } : {}),
      ...(versionError ? { versionError } : {}),
      auth,
      protocolChecked: false,
      catalog: {
        currentModelId: 'default',
        availableModels: [],
        setupCreatesSession: false as const,
      },
    };
  }

  const abortController = new AbortController();
  let q: any;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    q = query(
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
    const init: any = await Promise.race([
      q.initializationResult(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out initializing Claude Code.')),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
    const availableModels = normalizeClaudeCatalogModels(Array.isArray(init?.models) ? init.models : []);
    const resolvedAuth = auth.status === 'unknown'
      ? authFromSdkAccount(init?.account, launch.env)
      : auth;
    return {
      ...(version ? { version } : {}),
      ...(versionError ? { versionError } : {}),
      ...(authError ? { authError } : {}),
      auth: resolvedAuth,
      account: init?.account,
      protocolChecked: true,
      catalog: {
        currentModelId: 'default',
        availableModels,
        setupCreatesSession: false as const,
      },
    };
  } catch (error) {
    const protocolError = errorMessage(error);
    return {
      ...(version ? { version } : {}),
      ...(versionError ? { versionError } : {}),
      protocolError,
      ...(authError ? { authError } : {}),
      auth: /auth|login|credential|not logged|unauthorized/i.test(protocolError)
        ? { status: 'unauthenticated' }
        : auth,
      protocolChecked: true,
      catalog: {
        currentModelId: 'default',
        availableModels: [],
        setupCreatesSession: false as const,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
    q?.close();
  }
}

export function probeClaudeModelCatalog(input: { providerInstance?: any; cwd: string; totalTimeoutMs?: number; forceRefresh?: boolean; queryFactory?: (input: any) => any }) {
  return probeClaudeProvider(input).then((result) => {
    if (result.protocolError) throw new Error(result.protocolError);
    return result.catalog;
  });
}

export function probeClaudeProvider(input: { providerInstance?: any; cwd: string; totalTimeoutMs?: number; forceRefresh?: boolean; queryFactory?: (input: any) => any }) {
  const key = probeKey(input.providerInstance, input.cwd);
  const cached = cache.get(key);
  if (!input.forceRefresh && cached && Date.now() - cached.checkedAt < probeTtlMs) {
    return Promise.resolve(cached.result);
  }
  const active = inFlight.get(key);
  if (active) return active;
  const promise = executeClaudeProviderProbe(input)
    .then((result) => {
      cache.set(key, { result, checkedAt: Date.now() });
      return result;
    })
    .finally(() => inFlight.delete(key));
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
