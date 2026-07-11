import { createHash } from 'node:crypto'
import { GrokAcpClient } from './grokAcpClient.js'
import type { GrokAcpProviderInstance } from './grokAcpTypes.js'

type ModelCatalogEntry = {
  modelId: string
  name: string
  supportsReasoningEffort?: boolean
  reasoningEfforts?: string[]
  metadata?: Record<string, unknown>
}

export type GrokProbeCatalog = {
  currentModelId?: string
  availableModels: ModelCatalogEntry[]
  setupCreatesSession: true
}

export type GrokProbeResult = {
  status: 'ready' | 'auth-error' | 'setup-error' | 'timeout' | 'unavailable'
  message: string
  detail?: string
  catalog?: GrokProbeCatalog
}

const successTtlMs = 30_000
const cache = new Map<string, { expiresAt: number; result: GrokProbeResult }>()
const inFlight = new Map<string, Promise<GrokProbeResult>>()
const catalogCache = new Map<string, GrokProbeCatalog>()

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hashedKey(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
}

function launchIdentity(providerInstance: GrokAcpProviderInstance | undefined) {
  return [
    providerInstance?.providerInstanceId ?? 'default-grok',
    providerInstance?.binaryPath ?? '',
    providerInstance?.launchArgs ?? [],
    Object.entries(providerInstance?.env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]
}

function probeKey(providerInstance: GrokAcpProviderInstance | undefined, cwd: string) {
  return hashedKey([...launchIdentity(providerInstance), cwd])
}

function catalogKey(providerInstance: GrokAcpProviderInstance | undefined) {
  return hashedKey(launchIdentity(providerInstance))
}

function remaining(deadline: number, stage: string) {
  const value = deadline - Date.now()
  if (value <= 0) throw new Error(`Timed out during Grok provider ${stage}.`)
  return value
}

function normalizeCatalog(initialize: any, setup: any): GrokProbeCatalog {
  const initializeState = initialize?._meta?.modelState ?? {}
  const setupState = setup?.models ?? {}
  const initializeModels = Array.isArray(initializeState.availableModels)
    ? initializeState.availableModels
    : []
  const setupModels = Array.isArray(setupState.availableModels)
    ? setupState.availableModels
    : []
  const byId = new Map<string, any>(
    initializeModels.flatMap((model: any) =>
      nonEmptyString(model?.modelId) ? [[model.modelId, model]] : [],
    ),
  )
  for (const model of setupModels) {
    if (!nonEmptyString(model?.modelId)) continue
    byId.set(model.modelId, { ...(byId.get(model.modelId) ?? {}), ...model })
  }
  const available = [...byId.values()]
  const currentModelId = nonEmptyString(setupState.currentModelId)
    ? setupState.currentModelId
    : initializeState.currentModelId
  return {
    ...(nonEmptyString(currentModelId)
      ? { currentModelId: currentModelId.trim() }
      : {}),
    availableModels: available.flatMap((model: any) => {
      if (!nonEmptyString(model?.modelId)) return []
      const metadata =
        model?._meta && typeof model._meta === 'object' && !Array.isArray(model._meta)
          ? model._meta
          : undefined
      const reasoningEfforts = Array.isArray(metadata?.reasoningEfforts)
        ? metadata.reasoningEfforts.flatMap((effort: any) =>
            nonEmptyString(effort?.id) ? [effort.id.trim()] : [],
          )
        : undefined
      return [
        {
          modelId: model.modelId.trim(),
          name: nonEmptyString(model.name) ? model.name.trim() : model.modelId.trim(),
          ...(typeof metadata?.supportsReasoningEffort === 'boolean'
            ? { supportsReasoningEffort: metadata.supportsReasoningEffort }
            : {}),
          ...(reasoningEfforts ? { reasoningEfforts } : {}),
          ...(metadata ? { metadata } : {}),
        },
      ]
    }),
    setupCreatesSession: true,
  }
}

function classifyFailure(stage: string, error: unknown, stderr: string[]) {
  const message = error instanceof Error ? error.message : String(error)
  const detail = [...stderr, message].filter(Boolean).join('\n').slice(-4000)
  if (/timed out/i.test(message)) {
    return {
      status: 'timeout' as const,
      message: `Grok ACP ${stage} timed out.`,
      detail,
    }
  }
  if (stage === 'authenticate') {
    return {
      status: 'auth-error' as const,
      message: 'Grok authentication failed. Run `grok login` or provide XAI_API_KEY to the Orrery runtime.',
      detail,
    }
  }
  return {
    status: 'setup-error' as const,
    message: `Grok ACP ${stage} failed.`,
    detail,
  }
}

async function executeProbe({
  providerInstance,
  cwd,
  totalTimeoutMs,
}: {
  providerInstance?: GrokAcpProviderInstance
  cwd: string
  totalTimeoutMs: number
}): Promise<GrokProbeResult> {
  const deadline = Date.now() + totalTimeoutMs
  const client = new GrokAcpClient({ cwd, providerInstance })
  let stage = 'initialize'
  try {
    const initialize: any = await client.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'orrery', title: 'Orrery', version: '0.0.0' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      { timeoutMs: remaining(deadline, stage) },
    )
    stage = 'authenticate'
    const authMethod =
      nonEmptyString(providerInstance?.env?.XAI_API_KEY) ||
      nonEmptyString(process.env.XAI_API_KEY)
        ? 'xai.api_key'
        : 'cached_token'
    await client.request(
      'authenticate',
      { methodId: authMethod },
      { timeoutMs: remaining(deadline, stage) },
    )
    stage = 'session/new'
    const setup = await client.request(
      'session/new',
      { cwd, mcpServers: [] },
      { timeoutMs: remaining(deadline, stage) },
    )
    return {
      status: 'ready',
      message: 'Grok ACP authenticated and completed session setup.',
      catalog: normalizeCatalog(initialize, setup),
    }
  } catch (error) {
    return classifyFailure(stage, error, client.stderrTail)
  } finally {
    client.close({ graceMs: 250 })
    await Promise.race([
      client.waitForClose(),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ])
  }
}

export function probeGrokProvider({
  providerInstance,
  cwd,
  totalTimeoutMs = 15_000,
  force = false,
}: {
  providerInstance?: GrokAcpProviderInstance
  cwd: string
  totalTimeoutMs?: number
  force?: boolean
}) {
  const key = probeKey(providerInstance, cwd)
  const cached = cache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result)
  }
  const active = inFlight.get(key)
  if (active) return active
  const promise = executeProbe({ providerInstance, cwd, totalTimeoutMs })
    .then((result) => {
      if (result.status === 'ready') {
        cache.set(key, { expiresAt: Date.now() + successTtlMs, result })
        if (result.catalog) catalogCache.set(catalogKey(providerInstance), result.catalog)
      }
      return result
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

export function cachedGrokModelCatalog(
  providerInstance: GrokAcpProviderInstance | undefined,
  _cwd?: string,
) {
  return catalogCache.get(catalogKey(providerInstance))
}

export function clearGrokProbeCacheForTest() {
  cache.clear()
  inFlight.clear()
  catalogCache.clear()
}

export function expireGrokReadinessCacheForTest() {
  cache.clear()
}
