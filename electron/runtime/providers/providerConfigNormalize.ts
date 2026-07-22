// Provider instance/config normalization: CLI command resolution, launch
// args/env normalization, provider runtime settings and effective runtime
// config. Split out of sessionManager.ts (move-only).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  defaultProviderInstances,
  providerMetadata,
} from '../../../shared/provider-metadata.js'
import { providerEnvKeyIsSensitive } from '../../../shared/provider-setup.js'
import { buildPath } from '../claudeRuntimeShared.js'
import {
  type JsonRecord,
  diagnostic,
  isObject,
  nonEmptyString,
  optionalTrimmedString,
  validProviderApprovalPolicies,
  validProviderInteractionModes,
  validProviderKinds,
  validProviderReasoningEfforts,
  validProviderRuntimeModes,
  validProviderSandboxModes,
} from '../runtimeCommon.js'

export const defaultProviderRuntimeSettings = {
  runtimeMode: 'auto',
}
export function providerConfig(
  input: JsonRecord = {},
  providerInstances: JsonRecord[] = [],
) {
  const requestedInstanceId = optionalTrimmedString(input.providerInstanceId)
  const requestedInstance = requestedInstanceId
    ? providerInstances.find(
        (instance) => instance.providerInstanceId === requestedInstanceId,
      )
    : undefined
  if (requestedInstanceId && !requestedInstance) {
    throw new Error(`Unknown provider instance: ${requestedInstanceId}`)
  }

  const requested =
    input.providerKind ??
    requestedInstance?.kind ??
    (typeof input.agent === 'string' && validProviderKinds.has(input.agent)
      ? input.agent
      : undefined) ??
    'claude-code'
  if (!validProviderKinds.has(requested)) {
    throw new Error(`Unsupported provider kind: ${String(requested)}`)
  }
  const requestedKind = requested
  const providerInstance =
    requestedInstance ??
    providerInstances.find((instance) => instance.kind === requestedKind) ??
    defaultProviderInstanceForKind(requestedKind)

  if (providerInstance.kind !== requestedKind) {
    throw new Error(
      `Provider instance ${providerInstance.providerInstanceId} is ${providerInstance.kind}, not ${requestedKind}.`,
    )
  }

  const metadata = providerMetadata[requestedKind]
  return {
    agent: metadata.agent,
    backend: metadata.backend,
    providerKind: requestedKind,
    providerInstanceId: providerInstance.providerInstanceId,
    labelPrefix: metadata.labelPrefix,
  }
}

export function defaultCommandForProvider(providerKind) {
  const metadata = providerMetadata[providerKind]
  return process.env[metadata.commandEnv] || metadata.defaultCommand
}

export function commandForProviderInstance(providerKind, providerInstance) {
  if (nonEmptyString(providerInstance?.binaryPath)) {
    return providerInstance.binaryPath.trim()
  }

  return defaultCommandForProvider(providerKind)
}

export function commandExists(command) {
  if (!nonEmptyString(command)) {
    return { ok: false, detail: 'No binary configured.' }
  }

  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK)
      return { ok: true, detail: command }
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  try {
    const resolved = execFileSync('which', [command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: buildPath(),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return {
      ok: resolved.length > 0,
      detail: resolved || command,
    }
  } catch {
    return {
      ok: false,
      detail: `Could not find ${command} on PATH.`,
    }
  }
}

export function providerSetupErrorDiagnostic(providerKind, diagnostics = []) {
  const providerPattern =
    providerMetadata[providerKind]?.diagnosticPattern ?? /auth|login|account|rate.?limit/i
  return diagnostics.find((diagnostic) =>
    providerPattern.test(`${diagnostic.type} ${diagnostic.message}`),
  )
}

export function defaultProviderInstanceForKind(providerKind) {
  const metadata = providerMetadata[providerKind] ?? providerMetadata['claude-code']
  return {
    providerInstanceId: metadata.defaultInstanceId,
    kind: providerKind in providerMetadata ? providerKind : 'claude-code',
    label: metadata.instanceLabel,
  }
}

export function normalizeLaunchArgs(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : []

  return values
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

export function normalizeEnv(value) {
  if (!isObject(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [
      key.trim(),
      typeof entryValue === 'string' ? entryValue : String(entryValue),
    ])
    .filter(([key]) => key.length > 0 && !providerEnvKeyIsSensitive(key))

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function normalizeProviderInstance(
  value: JsonRecord = {},
  fallback?: JsonRecord,
  { reuseOptionalFallback = true }: { reuseOptionalFallback?: boolean } = {},
) {
  const input = isObject(value) ? value : {}
  const fallbackInstance = isObject(fallback) ? fallback : undefined
  const providerInstanceId =
    optionalTrimmedString(input.providerInstanceId) ??
    optionalTrimmedString(fallbackInstance?.providerInstanceId)
  if (!providerInstanceId) {
    throw new Error('Provider instance id is required.')
  }

  if (input.kind !== undefined && !validProviderKinds.has(input.kind)) {
    throw new Error(`Unsupported provider instance kind: ${String(input.kind)}`)
  }
  const kind = validProviderKinds.has(input.kind)
    ? input.kind
    : validProviderKinds.has(fallbackInstance?.kind)
      ? fallbackInstance.kind
      : defaultProviderInstanceForKind('claude-code').kind
  if (fallbackInstance && fallbackInstance.kind !== kind) {
    throw new Error(
      `Provider instance ${providerInstanceId} is ${fallbackInstance.kind}, not ${kind}.`,
    )
  }

  const label =
    optionalTrimmedString(input.label) ??
    optionalTrimmedString(fallbackInstance?.label) ??
    providerInstanceId
  const hasOwn = (key: string) =>
    Object.prototype.hasOwnProperty.call(input, key)
  const optionalValue = (key: string) =>
    hasOwn(key)
      ? input[key]
      : reuseOptionalFallback
        ? fallbackInstance?.[key]
        : undefined
  const launchArgs = normalizeLaunchArgs(optionalValue('launchArgs'))
  const env = normalizeEnv(optionalValue('env'))
  const normalized: JsonRecord = {
    providerInstanceId,
    kind,
    label,
  }

  for (const key of ['binaryPath', 'homePath', 'shadowHomePath']) {
    const valueForKey = optionalTrimmedString(optionalValue(key))
    if (valueForKey) {
      normalized[key] = valueForKey
    }
  }
  if (launchArgs.length > 0) {
    normalized.launchArgs = launchArgs
  }
  if (env) {
    normalized.env = env
  }

  return normalized
}

export function normalizeProviderInstances(value) {
  const byId = new Map<string, JsonRecord>(
    defaultProviderInstances.map((instance) => [
      instance.providerInstanceId,
      { ...instance },
    ]),
  )
  const sourceInstances = Array.isArray(value) ? value : []

  for (const sourceInstance of sourceInstances) {
    if (!isObject(sourceInstance)) {
      continue
    }
    const id = optionalTrimmedString(sourceInstance.providerInstanceId)
    if (!id) {
      continue
    }
    const existing = byId.get(id)
    try {
      byId.set(id, normalizeProviderInstance(sourceInstance, existing))
    } catch {
      // Invalid persisted provider instances are ignored; defaults keep the UI usable.
    }
  }

  return [...byId.values()]
}

export function normalizeProviderRuntimeSettings(value: JsonRecord = {}) {
  const input = isObject(value) ? value : {}
  const runtimeMode = validProviderRuntimeModes.has(input.runtimeMode)
    ? input.runtimeMode
    : defaultProviderRuntimeSettings.runtimeMode
  const settings: JsonRecord = {
    runtimeMode,
  }

  if (validProviderApprovalPolicies.has(input.approvalPolicy)) {
    settings.approvalPolicy = input.approvalPolicy
  }
  if (validProviderSandboxModes.has(input.sandbox)) {
    settings.sandbox = input.sandbox
  }
  if (nonEmptyString(input.model)) {
    settings.model = input.model.trim()
  }
  if (validProviderReasoningEfforts.has(input.reasoningEffort)) {
    settings.reasoningEffort = input.reasoningEffort
  }
  if (nonEmptyString(input.serviceTier)) {
    settings.serviceTier = input.serviceTier.trim()
  }
  if (validProviderInteractionModes.has(input.interactionMode)) {
    settings.interactionMode = input.interactionMode.trim()
  }

  return settings
}

export function normalizeProviderEffectiveRuntimeConfig(
  value,
  providerKind,
  runtimeSettings,
) {
  const input = isObject(value) ? value : {}
  const native = isObject(input.native) ? input.native : {}
  const runtimeMode = validProviderRuntimeModes.has(input.runtimeMode)
    ? input.runtimeMode
    : (runtimeSettings?.runtimeMode ??
      defaultProviderRuntimeSettings.runtimeMode)
  return {
    providerKind: validProviderKinds.has(input.providerKind)
      ? input.providerKind
      : providerKind,
    runtimeMode,
    modeLabel: nonEmptyString(input.modeLabel)
      ? input.modeLabel.trim()
      : runtimeMode,
    ...(nonEmptyString(input.model) ? { model: input.model.trim() } : {}),
    ...(validProviderReasoningEfforts.has(input.reasoningEffort)
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    native,
    ...(Array.isArray(input.notes)
      ? {
          notes: input.notes.filter(nonEmptyString).map((note) => note.trim()),
        }
      : {}),
  }
}
