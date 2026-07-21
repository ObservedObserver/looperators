// Workspace file browsing and "open in app" knowledge: bounded file-tree
// scanning, safe path resolution, and per-platform open commands.
// Split out of sessionManager.ts (move-only).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { type JsonRecord, validOpenWorkspaceTargets } from '../runtimeCommon.js'

export const workspaceFilesMaxDepth = 4
export const workspaceFilesMaxEntries = 500
export const workspaceFilesMaxCountedFiles = 50_000
export const workspaceFileContentMaxBytes = 256 * 1024
export const workspaceFilesIgnoredDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  '__pycache__',
])
export const macWorkspaceOpenAppNames = {
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  terminal: 'Terminal',
  ghostty: 'Ghostty',
  xcode: 'Xcode',
}

export const cliWorkspaceOpenCommands = {
  vscode: 'code',
  cursor: 'cursor',
  windsurf: 'windsurf',
  antigravity: 'antigravity',
  ghostty: 'ghostty',
}

export function workspaceFileKind(dirent) {
  if (dirent.isDirectory()) {
    return 'directory'
  }
  if (dirent.isFile()) {
    return 'file'
  }
  if (dirent.isSymbolicLink()) {
    return 'symlink'
  }
  return 'other'
}

export function normalizeWorkspaceFilesLimit(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function sortedWorkspaceDirents(cwd) {
  return fs.readdirSync(cwd, { withFileTypes: true }).sort((left, right) => {
    const leftDirectory = left.isDirectory()
    const rightDirectory = right.isDirectory()
    if (leftDirectory !== rightDirectory) {
      return leftDirectory ? -1 : 1
    }
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  })
}

export function countWorkspaceFiles(cwd, state) {
  if (state.truncated || state.totalFiles >= workspaceFilesMaxCountedFiles) {
    state.truncated = true
    return
  }

  let dirents
  try {
    dirents = sortedWorkspaceDirents(cwd)
  } catch {
    return
  }

  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      if (workspaceFilesIgnoredDirectories.has(dirent.name)) {
        continue
      }
      countWorkspaceFiles(path.join(cwd, dirent.name), state)
      if (state.truncated) {
        return
      }
      continue
    }

    if (dirent.isFile()) {
      state.totalFiles += 1
      if (state.totalFiles >= workspaceFilesMaxCountedFiles) {
        state.truncated = true
        return
      }
    }
  }
}

export function workspaceEntryForDirent(root, parentRelativePath, dirent) {
  const relativePath = parentRelativePath
    ? `${parentRelativePath}/${dirent.name}`
    : dirent.name
  const absolutePath = path.join(root, relativePath)
  const entry: JsonRecord = {
    path: relativePath,
    name: dirent.name,
    kind: workspaceFileKind(dirent),
  }

  if (dirent.isFile()) {
    try {
      entry.size = fs.statSync(absolutePath).size
    } catch {
      // Size is metadata for display only; omit it if the file disappeared.
    }
  }

  return entry
}

export function buildWorkspaceFileTree(root, parentRelativePath, depth, state) {
  if (state.remainingEntries <= 0) {
    state.truncated = true
    return []
  }

  const absoluteParent = parentRelativePath
    ? path.join(root, parentRelativePath)
    : root
  let dirents
  try {
    dirents = sortedWorkspaceDirents(absoluteParent)
  } catch {
    return []
  }

  const entries = []
  for (const dirent of dirents) {
    if (
      dirent.isDirectory() &&
      workspaceFilesIgnoredDirectories.has(dirent.name)
    ) {
      continue
    }

    if (state.remainingEntries <= 0) {
      state.truncated = true
      break
    }

    const entry = workspaceEntryForDirent(root, parentRelativePath, dirent)
    state.remainingEntries -= 1

    if (dirent.isDirectory() && depth < state.maxDepth) {
      entry.children = buildWorkspaceFileTree(
        root,
        entry.path,
        depth + 1,
        state,
      )
    }

    entries.push(entry)
  }

  return entries
}

export function resolveWorkspaceFilePath(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new Error('Workspace file path is required.')
  }

  const rawPath = requestedPath.trim()
  if (path.isAbsolute(rawPath)) {
    throw new Error(
      'Workspace file path must be relative to the project folder.',
    )
  }

  const normalizedPath = path.normalize(rawPath)
  if (
    normalizedPath === '.' ||
    normalizedPath.startsWith('..') ||
    path.isAbsolute(normalizedPath)
  ) {
    throw new Error('Workspace file path must stay inside the project folder.')
  }

  const root = fs.realpathSync(cwd)
  const absolutePath = path.resolve(cwd, normalizedPath)
  let realFilePath
  try {
    realFilePath = fs.realpathSync(absolutePath)
  } catch {
    throw new Error(`Workspace file not found: ${normalizedPath}`)
  }

  if (realFilePath !== root && !realFilePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Workspace file path must stay inside the project folder.')
  }

  return {
    absolutePath: realFilePath,
    relativePath: normalizedPath.split(path.sep).join('/'),
  }
}

export function normalizeOpenWorkspaceTarget(value) {
  if (validOpenWorkspaceTargets.has(value)) {
    return value
  }

  throw new Error(`Unsupported workspace open target: ${String(value)}`)
}

export function workspaceOpenCommand(target, cwd) {
  if (process.platform === 'darwin') {
    if (target === 'finder') {
      return { command: 'open', args: [cwd] }
    }

    const appName = macWorkspaceOpenAppNames[target]
    if (!appName) {
      throw new Error(`Unsupported macOS workspace open target: ${target}`)
    }
    return { command: 'open', args: ['-a', appName, cwd] }
  }

  if (process.platform === 'win32') {
    if (target === 'finder') {
      return { command: 'explorer.exe', args: [cwd] }
    }
    if (target === 'terminal') {
      return { command: 'wt.exe', args: ['-d', cwd] }
    }
    if (target === 'xcode') {
      throw new Error('Xcode is only available on macOS.')
    }

    const command = cliWorkspaceOpenCommands[target]
    if (!command) {
      throw new Error(`Unsupported Windows workspace open target: ${target}`)
    }
    return { command: `${command}.cmd`, args: [cwd] }
  }

  if (target === 'finder') {
    return { command: 'xdg-open', args: [cwd] }
  }
  if (target === 'terminal') {
    return {
      command: 'x-terminal-emulator',
      args: ['--working-directory', cwd],
    }
  }
  if (target === 'xcode') {
    throw new Error('Xcode is only available on macOS.')
  }

  const command = cliWorkspaceOpenCommands[target]
  if (!command) {
    throw new Error(`Unsupported workspace open target: ${target}`)
  }
  return { command, args: [cwd] }
}

export function runWorkspaceOpenCommand(command, args, cwd) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout
    const child = spawn(command, args, {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
    })

    const settle = (callback) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      callback()
    }

    timeout = setTimeout(() => {
      child.unref()
      settle(resolve)
    }, 3000)

    child.once('error', (error) => {
      settle(() => reject(error))
    })
    child.once('close', (code) => {
      if (code === 0 || code === null) {
        settle(resolve)
        return
      }
      settle(() =>
        reject(new Error(`${command} failed with exit code ${String(code)}`)),
      )
    })
  })
}

