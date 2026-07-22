// Public workspace reads and open-in-app operations. Checkpoint capture stays
// with the run lifecycle; this facade only projects already-recorded state.
import fs from 'node:fs'
import {
  isObject,
  nonEmptyString,
  now,
  type JsonRecord,
} from '../runtimeCommon.js'
import {
  checkpointDiffForSession,
  workingTreeDiffForSession,
  type CheckpointHost,
} from './sessionCheckpoints.js'
import { validateRunnableCwd } from './gitWorkspace.js'
import {
  buildWorkspaceFileTree,
  countWorkspaceFiles,
  normalizeOpenWorkspaceTarget,
  normalizeWorkspaceFilesLimit,
  resolveWorkspaceFilePath,
  runWorkspaceOpenCommand,
  workspaceFileContentMaxBytes,
  workspaceFilesIgnoredDirectories,
  workspaceFilesMaxDepth,
  workspaceFilesMaxEntries,
  workspaceOpenCommand,
} from './workspaceFiles.js'

export type WorkspaceServiceHost = {
  readState: () => JsonRecord
  checkpointHost: () => CheckpointHost
}

export class WorkspaceService {
  #host: WorkspaceServiceHost

  constructor(host: WorkspaceServiceHost) {
    this.#host = host
  }

  async openWorkspace(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const cwd = validateRunnableCwd(request.cwd)
    const target = normalizeOpenWorkspaceTarget(request.target ?? 'vscode')
    const { command, args } = workspaceOpenCommand(target, cwd)
    await runWorkspaceOpenCommand(command, args, cwd)
    return {
      ok: true,
      cwd,
      target,
      platform: process.platform,
    }
  }

  getWorkingTreeDiff(input: JsonRecord | string = {}) {
    const sessionId =
      typeof input === 'string'
        ? input
        : typeof input.sessionId === 'string' &&
            input.sessionId.trim().length > 0
          ? input.sessionId.trim()
          : undefined

    const state = this.#host.readState()
    if (!sessionId || !state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    if (typeof input === 'object' && nonEmptyString(input.turnId)) {
      return checkpointDiffForSession(this.#host.checkpointHost(), sessionId, {
        turnId: input.turnId.trim(),
        ignoreWhitespace: input.ignoreWhitespace === true,
      })
    }

    return workingTreeDiffForSession(this.#host.checkpointHost(), sessionId, {
      ignoreWhitespace:
        typeof input === 'object' && input.ignoreWhitespace === true,
    })
  }

  getWorkspaceFiles(input: JsonRecord | string = {}) {
    const request = isObject(input) ? input : {}
    const sessionId =
      typeof input === 'string'
        ? input
        : typeof request.sessionId === 'string' &&
            request.sessionId.trim().length > 0
          ? request.sessionId.trim()
          : undefined

    const state = this.#host.readState()
    if (!sessionId || !state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const session = state.sessions[sessionId]
    const cwd = validateRunnableCwd(session.cwd)
    const countState = { totalFiles: 0, truncated: false }
    countWorkspaceFiles(cwd, countState)

    const treeState = {
      maxDepth: normalizeWorkspaceFilesLimit(
        request.maxDepth,
        workspaceFilesMaxDepth,
        1,
        workspaceFilesMaxDepth,
      ),
      remainingEntries: normalizeWorkspaceFilesLimit(
        request.maxEntries,
        workspaceFilesMaxEntries,
        25,
        workspaceFilesMaxEntries,
      ),
      truncated: false,
    }

    const entries = buildWorkspaceFileTree(cwd, '', 1, treeState)
    return {
      sessionId,
      cwd,
      generatedAt: now(),
      totalFiles: countState.totalFiles,
      entries,
      truncated: countState.truncated || treeState.truncated,
      ignoredDirectories: [...workspaceFilesIgnoredDirectories].sort(),
    }
  }

  getWorkspaceFileContent(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const sessionId =
      typeof request.sessionId === 'string' &&
      request.sessionId.trim().length > 0
        ? request.sessionId.trim()
        : undefined

    const state = this.#host.readState()
    if (!sessionId || !state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const session = state.sessions[sessionId]
    const cwd = validateRunnableCwd(session.cwd)
    const { absolutePath, relativePath } = resolveWorkspaceFilePath(
      cwd,
      request.path,
    )
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) {
      throw new Error(`Workspace path is not a file: ${relativePath}`)
    }

    const maxBytes = normalizeWorkspaceFilesLimit(
      request.maxBytes,
      workspaceFileContentMaxBytes,
      1024,
      workspaceFileContentMaxBytes,
    )
    const bytesToRead = Math.min(stat.size, maxBytes + 1)
    const buffer = Buffer.alloc(bytesToRead)
    const fd = fs.openSync(absolutePath, 'r')
    let bytesRead = 0
    try {
      bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0)
    } finally {
      fs.closeSync(fd)
    }

    const contentBytes = buffer.subarray(0, Math.min(bytesRead, maxBytes))
    const truncated = stat.size > maxBytes || bytesRead > maxBytes
    const isBinary = contentBytes.includes(0)

    return {
      sessionId,
      cwd,
      path: relativePath,
      generatedAt: now(),
      size: stat.size,
      content: isBinary ? '' : contentBytes.toString('utf8'),
      truncated,
      isBinary,
    }
  }
}
