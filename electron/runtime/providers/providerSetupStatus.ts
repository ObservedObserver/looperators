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
  defaultProviderInstanceForKind,
  providerSetupErrorDiagnostic,
} from './providerConfigNormalize.js'
import { probeGrokProvider } from './grokAcpProbeService.js'
import { probeCodexProvider } from './codexModelCatalogService.js'
import { probeClaudeProvider } from './claudeModelCatalogService.js'
import { resolveProviderLaunch } from './providerLaunch.js'
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
  const launch = resolveProviderLaunch(providerKind, providerInstance)
  const binary = { ok: launch.available, detail: launch.detail }
  const cwd = nonEmptyString(request.cwd)
    ? safeCwd(request.cwd)
    : process.cwd()
  const cwdValid = isValidCwd(cwd)
  const providerDiagnostic = providerSetupErrorDiagnostic(
    providerKind,
    host.state.diagnostics ?? [],
  )
  const timeoutMs =
    typeof request.timeoutMs === 'number' && request.timeoutMs > 0
      ? request.timeoutMs
      : 15_000
  let providerProbe: any
  let providerProbeError: string | undefined
  if (binary.ok && cwdValid) {
    try {
      providerProbe =
        providerKind === 'codex'
          ? await probeCodexProvider({
              providerInstance,
              cwd,
              totalTimeoutMs: timeoutMs,
              forceRefresh: request.forceRefresh === true,
            })
          : providerKind === 'claude-code'
            ? await probeClaudeProvider({
                providerInstance,
                cwd,
                totalTimeoutMs: timeoutMs,
                forceRefresh: request.forceRefresh === true,
              })
            : await probeGrokProvider({
                providerInstance,
                cwd,
                totalTimeoutMs: timeoutMs,
              })
    } catch (error) {
      providerProbeError = error instanceof Error ? error.message : String(error)
    }
  }
  const grokProbe = providerKind === 'grok' ? providerProbe : undefined
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
    const discovered = providerProbe?.catalog
    modelDiscoveryError =
      providerProbeError ??
      providerProbe?.protocolError ??
      providerProbe?.modelError ??
      (!discovered
        ? grokProbe?.message ?? `${providerKind} returned no model catalog.`
        : discovered.availableModels.length === 0
          ? `${providerKind} returned an empty model catalog.`
          : undefined)
    if (!modelDiscoveryError && discovered) {
      models = {
        ...discovered,
        providerKind,
        providerInstanceId,
        fetchedAt: now(),
        source: 'live',
        stale: false,
      }
    } else {
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
      ? `Provider binary is not available: ${launch.requestedCommand}.`
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

  const auth = providerProbe?.auth ??
    (grokReady
      ? { status: 'authenticated', method: 'provider-cli' }
      : { status: 'unknown' })
  const protocolError =
    providerProbeError ??
    providerProbe?.protocolError ??
    (grokProbe && !grokReady ? grokProbe.message : undefined)
  const protocolChecked = providerProbe?.protocolChecked !== false
  const authProbeError = providerProbe?.authError ?? providerProbe?.accountError
  const readiness = !binary.ok
    ? 'unavailable'
    : auth.status === 'unauthenticated'
      ? 'needs-attention'
      : protocolError
        ? 'unavailable'
        : !cwdValid
          ? 'unknown'
          : auth.status === 'unknown'
            ? 'needs-attention'
            : 'ready'
  const version = providerProbe?.version

  return {
    providerKind,
    providerInstanceId,
    generatedAt: now(),
    readiness,
    installed: binary.ok,
    ...(version ? { version } : {}),
    command: {
      requested: launch.requestedCommand,
      ...(launch.resolvedCommand ? { resolved: launch.resolvedCommand } : {}),
      source: launch.commandSource,
    },
    auth,
    models,
    checks: [
      {
        id: 'runtime',
        label: 'Runtime',
        status: 'ok',
        message: 'looperators runtime is connected.',
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
          ? `Resolved ${launch.requestedCommand} from ${launch.commandSource}.`
          : `Provider binary is not available: ${launch.requestedCommand}.`,
        detail: binary.detail,
      },
      {
        id: 'version',
        label: 'Version',
        status: version ? 'ok' : binary.ok ? 'warning' : 'unknown',
        message: version
          ? `Provider reported ${version}.`
          : providerProbe?.versionError ??
            (binary.ok
              ? 'The executable was found, but its version could not be read.'
              : 'Version was not checked because the executable is unavailable.'),
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
          auth.status === 'authenticated' || auth.status === 'external' || auth.status === 'not-required'
            ? 'ok'
            : auth.status === 'unauthenticated'
              ? 'error'
              : providerDiagnostic
                ? 'warning'
                : 'unknown',
        message:
          auth.status === 'authenticated'
            ? `Authenticated${auth.accountLabel ? ` as ${auth.accountLabel}` : ''}.`
            : auth.status === 'external'
              ? `Authentication is provided by ${auth.method ?? 'an external provider'}.`
              : auth.status === 'not-required'
                ? 'The configured model provider does not require OpenAI authentication.'
                : auth.status === 'unauthenticated'
                  ? `Sign in with the local ${providerKind === 'claude-code' ? 'Claude Code' : providerKind === 'codex' ? 'Codex' : 'Grok'} CLI.`
                  : authProbeError ?? providerDiagnostic?.message ?? 'Authentication status could not be confirmed.',
        detail: auth.method ?? authProbeError ?? providerDiagnostic?.type,
      },
      {
        id: 'protocol',
        label: 'Provider protocol',
        status: protocolError
          ? 'error'
          : providerProbe && protocolChecked
            ? 'ok'
            : 'unknown',
        message: protocolError
          ? protocolError
          : providerProbe && protocolChecked
            ? providerKind === 'codex'
              ? 'Codex app-server initialized successfully.'
              : providerKind === 'claude-code'
                ? 'Claude Agent SDK initialized successfully without starting a turn.'
                : grokProbe?.message ?? 'Provider protocol initialized successfully.'
            : auth.status === 'unauthenticated'
              ? 'Provider protocol was not checked because sign-in is required.'
              : 'Provider protocol was not checked.',
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
        status: 'unknown',
        message:
          providerKind === 'codex'
            ? 'The looperators membrane will be mounted when a Codex thread starts.'
            : providerKind === 'grok'
              ? 'The looperators membrane will be injected when a Grok ACP session starts.'
              : 'The looperators membrane will be mounted when a Claude session starts.',
      },
    ],
  }
}
