import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pathStartMarker = '__LOOPERATORS_PATH_START__'
const pathEndMarker = '__LOOPERATORS_PATH_END__'
const environmentProbeDeadlineMs = 2_500
const launchctlReserveMs = 300

export type HostEnvironmentSource =
  | 'login-shell'
  | 'launchctl'
  | 'inherited'

export type HostEnvironmentSnapshot = {
  source: HostEnvironmentSource
  shell?: string
  home: string
  path: string
  inheritedPath: string
  discoveredPath?: string
}

type ExecFileLike = typeof execFile

type HostEnvironmentOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homedir?: string
  loginShell?: string
  execFile?: ExecFileLike
  timeoutMs?: number
}

let currentSnapshot: HostEnvironmentSnapshot | undefined

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function unique(values: string[]) {
  const seen = new Set<string>()
  return values.filter((value) => {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

export function mergePathValues(
  values: Array<string | undefined>,
  delimiter = path.delimiter,
) {
  return unique(
    values.flatMap((value) =>
      nonEmptyString(value) ? value.split(delimiter) : [],
    ),
  ).join(delimiter)
}

function fallbackDirectories(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
) {
  if (platform === 'win32') {
    return [
      path.join(home, '.local', 'bin'),
      env.APPDATA ? path.join(env.APPDATA, 'npm') : undefined,
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Programs', 'nodejs')
        : undefined,
      env.VOLTA_HOME ? path.join(env.VOLTA_HOME, 'bin') : undefined,
    ].filter(nonEmptyString)
  }

  return [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
}

function shellCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  loginShell?: string,
) {
  const candidates = [loginShell, env.SHELL]
  try {
    candidates.push(os.userInfo().shell)
  } catch {
    // Sandboxed or synthetic users may not have an OS account record.
  }
  candidates.push(platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return unique(candidates.filter(nonEmptyString)).filter((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  })
}

function parseMarkedPath(output: string) {
  const start = output.lastIndexOf(pathStartMarker)
  const end = output.indexOf(pathEndMarker, start + pathStartMarker.length)
  if (start < 0 || end < 0) return undefined
  const value = output.slice(start + pathStartMarker.length, end).trim()
  return nonEmptyString(value) ? value : undefined
}

function execFileText(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  execFileImpl: ExecFileLike,
) {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let child: ReturnType<ExecFileLike> | undefined
    const finish = (error?: Error | null, stdout?: string | Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      if (error) reject(error)
      else resolve(String(stdout ?? ''))
    }
    const deadlineTimer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish(new Error(`Timed out reading host environment from ${executable}.`))
    }, Math.max(1, timeoutMs))
    try {
      child = execFileImpl(
        executable,
        args,
        {
          encoding: 'utf8',
          env,
          timeout: Math.max(1, timeoutMs),
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => finish(error, stdout),
      )
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function readLoginShellPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  execFileImpl: ExecFileLike,
  timeoutMs: number,
  loginShell?: string,
) {
  if (platform === 'win32') return undefined
  const shell = shellCandidates(env, platform, loginShell)[0]
  if (!shell || timeoutMs <= 0) return undefined
  const script = `printf '${pathStartMarker}'; printenv PATH; printf '${pathEndMarker}'`
  try {
    const output = await execFileText(
      shell,
      ['-ilc', script],
      env,
      timeoutMs,
      execFileImpl,
    )
    const discoveredPath = parseMarkedPath(output)
    return discoveredPath ? { shell, path: discoveredPath } : undefined
  } catch {
    return undefined
  }
}

async function readLaunchctlPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execFileImpl: ExecFileLike,
  timeoutMs: number,
) {
  if (platform !== 'darwin' || timeoutMs <= 0) return undefined
  try {
    const value = (
      await execFileText(
        '/bin/launchctl',
        ['getenv', 'PATH'],
        env,
        timeoutMs,
        execFileImpl,
      )
    ).trim()
    return nonEmptyString(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function resolveHostEnvironment(
  options: HostEnvironmentOptions = {},
): Promise<HostEnvironmentSnapshot> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.homedir ?? env.HOME ?? os.homedir()
  const inheritedPath = env.PATH ?? ''
  const execFileImpl = options.execFile ?? execFile
  const totalTimeoutMs = Math.max(1, options.timeoutMs ?? environmentProbeDeadlineMs)
  const deadline = Date.now() + totalTimeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const shellBudget = Math.max(
    1,
    remaining() - Math.min(launchctlReserveMs, Math.floor(totalTimeoutMs / 3)),
  )
  const login = await readLoginShellPath(
    env,
    platform,
    execFileImpl,
    shellBudget,
    options.loginShell,
  )
  const launchctlPath = login
    ? undefined
    : await readLaunchctlPath(
        platform,
        env,
        execFileImpl,
        remaining(),
      )
  const discoveredPath = login?.path ?? launchctlPath
  const pathValue = mergePathValues([
    discoveredPath,
    inheritedPath,
    fallbackDirectories(platform, home, env).join(path.delimiter),
  ])

  return {
    source: login
      ? 'login-shell'
      : launchctlPath
        ? 'launchctl'
        : 'inherited',
    ...(login?.shell ? { shell: login.shell } : {}),
    home,
    path: pathValue,
    inheritedPath,
    ...(discoveredPath ? { discoveredPath } : {}),
  }
}

export async function hydrateProcessEnvironment(
  options: HostEnvironmentOptions = {},
) {
  const snapshot = await resolveHostEnvironment(options)
  process.env.HOME ||= snapshot.home
  process.env.PATH = snapshot.path
  currentSnapshot = snapshot
  return snapshot
}

export function hostEnvironmentSnapshot() {
  if (currentSnapshot) return { ...currentSnapshot }
  const home = process.env.HOME ?? os.homedir()
  const inheritedPath = process.env.PATH ?? ''
  return {
    source: 'inherited' as const,
    home,
    inheritedPath,
    path: mergePathValues([
      inheritedPath,
      fallbackDirectories(process.platform, home, process.env).join(path.delimiter),
    ]),
  }
}
