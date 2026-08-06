import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  providerMetadata,
  type ProviderKind,
} from '../../../shared/provider-metadata.js'
import { mergePathValues } from '../hostEnvironment.js'

type JsonRecord = Record<string, any>

export type ProviderCommandSource =
  | 'profile'
  | 'environment'
  | 'path'
  | 'unresolved'

export type ResolvedProviderLaunch = {
  providerKind: ProviderKind
  requestedCommand: string
  command: string
  resolvedCommand?: string
  commandSource: ProviderCommandSource
  available: boolean
  detail: string
  launchArgs: string[]
  env: NodeJS.ProcessEnv
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function expandHomePath(value: unknown, home = os.homedir()) {
  if (!nonEmptyString(value)) return undefined
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2))
  }
  return trimmed
}

export function providerLaunchArgs(providerInstance?: JsonRecord) {
  return Array.isArray(providerInstance?.launchArgs)
    ? providerInstance.launchArgs
        .filter(nonEmptyString)
        .map((arg: string) => arg.trim())
    : []
}

export function requestedProviderCommand(
  providerKind: ProviderKind,
  providerInstance?: JsonRecord,
) {
  if (nonEmptyString(providerInstance?.binaryPath)) {
    return providerInstance.binaryPath.trim()
  }
  const metadata = providerMetadata[providerKind]
  return process.env[metadata.commandEnv] || metadata.defaultCommand
}

function executableCandidates(command: string, env: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32' || path.extname(command)) return [command]
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
  return [command, ...extensions.map((extension) => `${command}${extension}`)]
}

function executableFile(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function resolveExecutable(
  requestedCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
) {
  const expanded = expandHomePath(requestedCommand) ?? requestedCommand
  if (path.isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\')) {
    const candidate = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(expanded)
    return executableFile(candidate) ? candidate : undefined
  }

  for (const rawDirectory of (env.PATH ?? '').split(path.delimiter)) {
    const unquotedDirectory = rawDirectory.trim().replace(/^"(.*)"$/, '$1')
    const expandedDirectory =
      expandHomePath(unquotedDirectory || '.', env.HOME ?? os.homedir()) ?? '.'
    const directory = path.isAbsolute(expandedDirectory)
      ? path.normalize(expandedDirectory)
      : path.resolve(baseDirectory, expandedDirectory)
    for (const command of executableCandidates(expanded, env)) {
      const candidate = path.join(directory, command)
      if (executableFile(candidate)) return candidate
    }
  }
  return undefined
}

export function providerLaunchEnvironment(
  providerKind: ProviderKind,
  providerInstance?: JsonRecord,
) {
  const homePath = expandHomePath(providerInstance?.homePath)
  const shadowHomePath = expandHomePath(providerInstance?.shadowHomePath)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(providerInstance?.env ?? {}),
    PATH: mergePathValues([process.env.PATH]),
    NO_COLOR: '1',
  }

  if (providerKind === 'claude-code' && homePath) env.HOME = homePath
  if (providerKind === 'codex') {
    if (homePath) env.ORRERY_CODEX_SHARED_HOME = homePath
    if (shadowHomePath || homePath) env.CODEX_HOME = shadowHomePath ?? homePath
  }
  if (providerKind === 'grok') env.GROK_OAUTH2_REFERRER = 'orrery'
  return env
}

export function resolveProviderLaunch(
  providerKind: ProviderKind,
  providerInstance?: JsonRecord,
): ResolvedProviderLaunch {
  const requestedCommand = requestedProviderCommand(
    providerKind,
    providerInstance,
  )
  const env = providerLaunchEnvironment(providerKind, providerInstance)
  const resolvedCommand = resolveExecutable(requestedCommand, env)
  const hasProfilePath = nonEmptyString(providerInstance?.binaryPath)
  const hasEnvironmentOverride = nonEmptyString(
    process.env[providerMetadata[providerKind].commandEnv],
  )
  const commandSource: ProviderCommandSource = resolvedCommand
    ? hasProfilePath
      ? 'profile'
      : hasEnvironmentOverride
        ? 'environment'
        : 'path'
    : 'unresolved'

  return {
    providerKind,
    requestedCommand,
    command: resolvedCommand ?? expandHomePath(requestedCommand) ?? requestedCommand,
    ...(resolvedCommand ? { resolvedCommand } : {}),
    commandSource,
    available: Boolean(resolvedCommand),
    detail: resolvedCommand ?? `Could not find ${requestedCommand} on the desktop runtime PATH.`,
    launchArgs: providerLaunchArgs(providerInstance),
    env,
  }
}
