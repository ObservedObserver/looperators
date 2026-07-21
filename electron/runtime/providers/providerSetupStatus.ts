// Provider setup status probing: CLI presence checks, per-provider setup
// diagnostics, and dynamic model catalog probing with a TTL cache kept on
// runtime state. Split out of sessionManager.ts (move-only).
import {
  type JsonRecord,
  isObject,
  nonEmptyString,
  now,
  optionalTrimmedString,
  validProviderKinds,
} from '../runtimeCommon.js'
import { isValidCwd, safeCwd } from '../workspace/gitWorkspace.js'
import {
  commandExists,
  commandForProviderInstance,
  defaultProviderInstanceForKind,
  providerSetupErrorDiagnostic,
} from './providerConfigNormalize.js'
import { probeGrokProvider } from './grokAcpProbeService.js'
import { probeCodexModelCatalog } from './codexModelCatalogService.js'
import { probeClaudeModelCatalog } from './claudeModelCatalogService.js'
import { fallbackProviderModelCatalog } from '../../../shared/provider-model-catalog.js'

const providerModelCatalogTtlMs = 5 * 60 * 1000

// The minimal manager surface the setup-status probe needs.
export type ProviderSetupHost = {
  readonly state: JsonRecord
  getState(): JsonRecord
  touchDeferred(): void
  broadcast(event: JsonRecord): void
}

export async function getProviderSetupStatus(
host: ProviderSetupHost,
input: JsonRecord = {},
) {
  const request = isObject(input) ? input : {}
  const requestedProviderKind = request.providerKind ?? 'claude-code'
  if (!validProviderKinds.has(requestedProviderKind)) {
    throw new Error(
      `Unsupported provider kind: ${String(requestedProviderKind)}`,
    )
  }
  const requestedInstanceId = optionalTrimmedString(
    request.providerInstanceId,
  )
  const requestedInstance = requestedInstanceId
    ? host.state.providerInstances.find(
        (instance) => instance.providerInstanceId === requestedInstanceId,
      )
    : undefined
  if (requestedInstanceId && !requestedInstance) {
    throw new Error(`Unknown provider instance: ${requestedInstanceId}`)
  }
  if (requestedInstance && requestedInstance.kind !== requestedProviderKind) {
    throw new Error(
      `Provider instance ${requestedInstance.providerInstanceId} is ${requestedInstance.kind}, not ${requestedProviderKind}.`,
    )
  }
  const providerKind = requestedProviderKind
  const providerInstance =
    requestedInstance ??
    host.state.providerInstances.find(
      (instance) => instance.kind === providerKind,
    )
  const command = commandForProviderInstance(providerKind, providerInstance)
  const binary = commandExists(command)
  const cwd = nonEmptyString(request.cwd)
    ? safeCwd(request.cwd)
    : process.cwd()
  const cwdValid = isValidCwd(cwd)
  const providerDiagnostic = providerSetupErrorDiagnostic(
    providerKind,
    host.state.diagnostics ?? [],
  )
  const grokProbe =
    providerKind === 'grok' && binary.ok && cwdValid
      ? await probeGrokProvider({
          providerInstance,
          cwd,
          totalTimeoutMs:
            typeof request.timeoutMs === 'number' && request.timeoutMs > 0
              ? request.timeoutMs
              : 15_000,
        })
      : undefined
  const grokReady = grokProbe?.status === 'ready'
  const providerInstanceId =
    providerInstance?.providerInstanceId ??
    defaultProviderInstanceForKind(providerKind).providerInstanceId
  const previousCatalog = isObject(
    host.state.providerModelCatalogs?.[providerInstanceId],
  )
    ? host.state.providerModelCatalogs[providerInstanceId]
    : undefined
  const previousFetchedAt = Date.parse(previousCatalog?.fetchedAt ?? '')
  const previousIsFresh =
    request.forceRefresh !== true &&
    previousCatalog?.source === 'live' &&
    Number.isFinite(previousFetchedAt) &&
    Date.now() - previousFetchedAt < providerModelCatalogTtlMs
  let models = previousCatalog
  let modelDiscoveryError

  if (binary.ok && cwdValid && !previousIsFresh) {
    try {
      const discovered =
        providerKind === 'codex'
          ? await probeCodexModelCatalog({
              providerInstance,
              cwd,
              totalTimeoutMs:
                typeof request.timeoutMs === 'number' && request.timeoutMs > 0
                  ? request.timeoutMs
                  : 15_000,
            })
          : providerKind === 'claude-code'
            ? await probeClaudeModelCatalog({
                providerInstance,
                cwd,
                totalTimeoutMs:
                  typeof request.timeoutMs === 'number' && request.timeoutMs > 0
                    ? request.timeoutMs
                    : 15_000,
              })
            : grokProbe?.catalog

      if (!discovered) {
        throw new Error(
          grokProbe?.message ?? `${providerKind} returned no model catalog.`,
        )
      }
      if (discovered.availableModels.length === 0) {
        throw new Error(`${providerKind} returned an empty model catalog.`)
      }
      models = {
        ...discovered,
        providerKind,
        providerInstanceId,
        fetchedAt: now(),
        source: 'live',
        stale: false,
      }
    } catch (error) {
      modelDiscoveryError =
        error instanceof Error ? error.message : String(error)
      models = previousCatalog?.availableModels?.length
        ? {
            ...previousCatalog,
            source: 'cache',
            stale: true,
            error: modelDiscoveryError,
          }
        : fallbackProviderModelCatalog(
            providerKind,
            providerInstanceId,
            modelDiscoveryError,
          )
    }
  } else if (!models) {
    const reason = !binary.ok
      ? `Provider binary is not available: ${command}.`
      : !cwdValid
        ? `Workspace is not available: ${cwd}.`
        : undefined
    models = fallbackProviderModelCatalog(
      providerKind,
      providerInstanceId,
      reason,
    )
    modelDiscoveryError = reason
  }

  host.state.providerModelCatalogs = {
    ...(isObject(host.state.providerModelCatalogs)
      ? host.state.providerModelCatalogs
      : {}),
    [providerInstanceId]: models,
  }
  host.touchDeferred()
  host.broadcast({ type: 'runtime.state', state: host.getState() })

  return {
    providerKind,
    providerInstanceId,
    generatedAt: now(),
    models,
    checks: [
      {
        id: 'runtime',
        label: 'Runtime',
        status: 'ok',
        message: 'Orrery runtime is connected.',
      },
      {
        id: 'provider-instance',
        label: 'Provider profile',
        status: providerInstance ? 'ok' : 'warning',
        message: providerInstance
          ? `Using ${providerInstance.label}.`
          : `No saved provider profile for ${providerKind}; using runtime defaults.`,
        detail: providerInstance?.providerInstanceId,
      },
      {
        id: 'binary',
        label: 'Binary',
        status: binary.ok ? 'ok' : 'error',
        message: binary.ok
          ? `Using ${command}.`
          : `Provider binary is not available: ${command}.`,
        detail: binary.detail,
      },
      {
        id: 'models',
        label: 'Models',
        status: modelDiscoveryError
          ? 'warning'
          : models.stale
            ? 'warning'
            : 'ok',
        message: modelDiscoveryError
          ? `Using ${models.source} model catalog: ${modelDiscoveryError}`
          : `Discovered ${models.availableModels.length} model${models.availableModels.length === 1 ? '' : 's'} from ${providerKind}.`,
      },
      {
        id: 'cwd',
        label: 'Project cwd',
        status: cwdValid ? 'ok' : 'error',
        message: cwdValid
          ? `Project folder is available: ${cwd}.`
          : `Project folder is not available: ${cwd}.`,
      },
      {
        id: 'auth',
        label: 'Auth/account',
        status:
          providerKind === 'grok'
            ? grokReady
              ? 'ok'
              : grokProbe
                ? 'error'
                : 'unknown'
            : providerDiagnostic
              ? 'warning'
              : 'unknown',
        message:
          providerKind === 'grok'
            ? grokProbe?.message ??
              'Grok auth was not probed because the binary or project folder is unavailable.'
            : providerDiagnostic
              ? providerDiagnostic.message
              : 'Provider auth and account status are managed by the local CLI; start a chat to verify.',
        detail:
          providerKind === 'grok'
            ? grokProbe?.detail
            : providerDiagnostic?.type,
      },
      ...(providerKind === 'grok'
        ? [
            {
              id: 'acp-session',
              label: 'ACP session setup',
              status: grokReady ? 'ok' : grokProbe ? 'error' : 'unknown',
              message: grokReady
                ? 'initialize, authenticate, and session/new completed successfully.'
                : grokProbe
                  ? grokProbe.message
                  : 'ACP session setup was not attempted.',
              detail:
                grokProbe?.catalog?.setupCreatesSession === true
                  ? 'The readiness probe creates an upstream Grok session.'
                  : undefined,
            },
          ]
        : []),
      {
        id: 'mcp',
        label: 'MCP / tools',
        status: 'ok',
        message:
          providerKind === 'codex'
            ? 'Orrery membrane MCP bridge is mounted per-thread for Codex sessions.'
            : providerKind === 'grok'
              ? 'Orrery membrane MCP bridge will be injected into Grok ACP sessions.'
              : 'Orrery membrane MCP bridge is available for Claude sessions.',
      },
    ],
  }
}

