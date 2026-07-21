// Git/worktree knowledge for runtime sessions: cwd validation and repair,
// repo/branch context, per-session worktree planning, checkpoint git refs,
// and diff-patch parsing. Split out of sessionManager.ts (move-only).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import {
  type JsonRecord,
  isObject,
  nonEmptyString,
  optionalTrimmedString,
  validWorkModes,
} from '../runtimeCommon.js'

export const emptyGitTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const gitDiffMaxBuffer = 64 * 1024 * 1024
export const checkpointGitRefRoot = 'refs/orrery/checkpoints'
export function safeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return process.cwd()
  }

  const trimmed = cwd.trim()
  if (trimmed === '~') {
    return os.homedir()
  }
  if (trimmed.startsWith('~/')) {
    return path.resolve(os.homedir(), trimmed.slice(2))
  }

  return path.resolve(trimmed)
}

export function cwdStat(cwd) {
  try {
    return fs.statSync(cwd)
  } catch {
    return undefined
  }
}

export function isValidCwd(cwd) {
  return cwdStat(cwd)?.isDirectory() === true
}

export function validateRunnableCwd(cwd) {
  const resolved = safeCwd(cwd)
  const stat = cwdStat(resolved)
  if (!stat) {
    throw new Error(
      `Project folder not found: ${resolved}. Choose an existing cwd before starting the chat.`,
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Project cwd is not a folder: ${resolved}. Choose an existing project directory.`,
    )
  }

  return resolved
}

export function gitOutput(cwd, args, options: JsonRecord = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? gitDiffMaxBuffer,
    stdio: ['ignore', 'pipe', options.quietStderr ? 'ignore' : 'pipe'],
  }).trimEnd()
}

export function hasGitHead(cwd, env) {
  try {
    gitOutput(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], { env })
    return true
  } catch {
    return false
  }
}

export function projectNameFromCwd(cwd) {
  return path.basename(cwd.replace(/\/$/, '')) || 'Project'
}

export function validCwdCandidate(value) {
  if (!nonEmptyString(value)) {
    return undefined
  }

  const cwd = safeCwd(value)
  return isValidCwd(cwd) ? cwd : undefined
}

export function cwdPathParts(cwd) {
  return safeCwd(cwd).split(path.sep).filter(Boolean)
}

export function ephemeralWorktreeProjectName(cwd) {
  const parts = cwdPathParts(cwd)
  const codexIndex = parts.findIndex(
    (part, index) => part === '.codex' && parts[index + 1] === 'worktrees',
  )
  if (codexIndex >= 0) {
    return parts[codexIndex + 3]
  }

  const orreryIndex = parts.indexOf('.orrery-worktrees')
  if (orreryIndex >= 0) {
    return parts[orreryIndex + 1]
  }

  return undefined
}

export function cwdRepairCandidate(cwd, value) {
  const project = isObject(value.project) ? value.project : undefined
  const projectCwd =
    validCwdCandidate(project?.cwd) ?? validCwdCandidate(project?.repoRoot)
  if (projectCwd) {
    return { cwd: projectCwd, reason: 'project-cwd' }
  }

  const runtimeCwd = validCwdCandidate(process.cwd())
  const ephemeralProjectName = ephemeralWorktreeProjectName(cwd)
  if (
    runtimeCwd &&
    ephemeralProjectName &&
    ephemeralProjectName === projectNameFromCwd(runtimeCwd)
  ) {
    return { cwd: runtimeCwd, reason: 'runtime-workspace' }
  }

  return undefined
}

export function currentGitBranch(cwd) {
  try {
    const branch = gitOutput(cwd, ['branch', '--show-current'], {
      quietStderr: true,
    })
    if (branch.length > 0) {
      return branch
    }
  } catch {
    return undefined
  }

  try {
    const commit = gitOutput(cwd, ['rev-parse', '--short', 'HEAD'], {
      quietStderr: true,
    })
    return commit.length > 0 ? commit : undefined
  } catch {
    return undefined
  }
}

export function localGitBranches(cwd) {
  try {
    return gitOutput(
      cwd,
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { quietStderr: true },
    )
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

export function gitRepoRoot(cwd) {
  try {
    const root = gitOutput(cwd, ['rev-parse', '--show-toplevel'], {
      quietStderr: true,
    })
    return root.length > 0 ? root : undefined
  } catch {
    return undefined
  }
}

export function gitProjectContext(cwd) {
  const resolved = validateRunnableCwd(cwd)
  const repoRoot = gitRepoRoot(resolved)
  const isGitRepo = Boolean(repoRoot)
  const currentBranch = isGitRepo ? currentGitBranch(resolved) : undefined
  const branches = isGitRepo ? localGitBranches(resolved) : []

  return {
    cwd: resolved,
    projectName: projectNameFromCwd(repoRoot ?? resolved),
    isGitRepo,
    repoRoot,
    currentBranch,
    branches:
      currentBranch && !branches.includes(currentBranch)
        ? [currentBranch, ...branches]
        : branches,
  }
}

export function normalizeWorkMode(value) {
  return validWorkModes.has(value) ? value : 'local'
}

export function normalizeBranchName(value) {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    /[\s~^:?*[\\]/.test(trimmed)
  ) {
    return undefined
  }

  return trimmed
}

export function branchSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .replace(/\/+/g, '/')
    .slice(0, 48)
}

export function gitRefSlug(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/[/.]+$/g, '')
      .replace(/^\.+/g, '')
      .slice(0, 96) || 'unknown'
  )
}

export function checkpointRef({ sessionId, turnCount, turnId, stage }) {
  return [
    checkpointSessionRefRoot(sessionId),
    'turns',
    String(turnCount),
    `${gitRefSlug(turnId)}-${stage}`,
  ].join('/')
}

export function checkpointSessionRefRoot(sessionId) {
  return [checkpointGitRefRoot, gitRefSlug(sessionId)].join('/')
}

export function gitCheckpointEnv(tempIndex) {
  return {
    ...process.env,
    GIT_INDEX_FILE: tempIndex,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Orrery',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'orrery@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Orrery',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'orrery@local',
  }
}

export function sessionProjectFromContext(context, workMode, branch, baseBranch, forkPoint = undefined) {
  return {
    name: context.projectName,
    cwd: context.repoRoot ?? context.cwd,
    repoRoot: context.repoRoot,
    workMode,
    baseBranch,
    branch,
    forkPoint,
  }
}

export function normalizeSessionProject(value, cwd) {
  if (!isObject(value)) {
    return undefined
  }

  const workMode = normalizeWorkMode(value.workMode)
  const name = nonEmptyString(value.name)
    ? value.name.trim()
    : projectNameFromCwd(cwd)
  const projectCwd = nonEmptyString(value.cwd) ? safeCwd(value.cwd) : cwd
  const repoRoot = nonEmptyString(value.repoRoot)
    ? safeCwd(value.repoRoot)
    : undefined

  return {
    name,
    cwd: projectCwd,
    repoRoot,
    workMode,
    baseBranch: normalizeBranchName(value.baseBranch),
    branch: normalizeBranchName(value.branch),
    forkPoint: optionalTrimmedString(value.forkPoint),
    mergedAt: optionalTrimmedString(value.mergedAt),
    mergedTurnId: optionalTrimmedString(value.mergedTurnId),
    cleanupStatus: ['ready', 'cleaned'].includes(value.cleanupStatus) ? value.cleanupStatus : undefined,
    cleanedAt: optionalTrimmedString(value.cleanedAt),
  }
}

export function planSessionWorktree(projectCwd, sessionId, requestedBranch) {
  const context = gitProjectContext(projectCwd)
  if (!context.repoRoot) {
    throw new Error('New worktree requires a Git project.')
  }

  const baseBranch =
    normalizeBranchName(requestedBranch) ??
    normalizeBranchName(context.currentBranch) ??
    'HEAD'
  const shortId = sessionId.slice(0, 8)
  const slug = branchSlug(baseBranch) || 'branch'
  const sessionBranch = `orrery/${slug}-${shortId}`
  const forkPoint = gitOutput(context.repoRoot, ['rev-parse', baseBranch])
  const worktreeRoot = path.join(
    path.dirname(context.repoRoot),
    '.orrery-worktrees',
    context.projectName,
  )
  const worktreePath = path.join(worktreeRoot, shortId)

  return {
    context,
    baseBranch,
    sessionBranch,
    worktreeRoot,
    worktreePath,
    workspace: {
      cwd: worktreePath,
      project: sessionProjectFromContext(
        context,
        'worktree',
        sessionBranch,
        baseBranch,
        forkPoint,
      ),
    },
  }
}

export function createPlannedSessionWorktree(plan) {
  fs.mkdirSync(plan.worktreeRoot, { recursive: true })
  gitOutput(plan.context.repoRoot, [
    'worktree',
    'add',
    '-b',
    plan.sessionBranch,
    plan.worktreePath,
    plan.baseBranch,
  ])
  return plan.workspace
}

export function localSessionWorkspace(projectCwd, requestedBranch) {
  const context = gitProjectContext(projectCwd)
  const currentBranch = normalizeBranchName(context.currentBranch)
  const requested = normalizeBranchName(requestedBranch)
  if (requested && currentBranch && requested !== currentBranch) {
    throw new Error(
      `Work locally uses the currently checked out branch (${currentBranch}). Choose New worktree to start from ${requested}.`,
    )
  }

  return {
    cwd: context.cwd,
    project: sessionProjectFromContext(
      context,
      'local',
      currentBranch ?? requested,
      undefined,
    ),
  }
}

export function parseDiffFilesFromPatch(patch) {
  if (patch.trim().length === 0) {
    return []
  }

  const files = parsePatchFiles(patch).flatMap((parsedPatch) =>
    parsedPatch.files.map((file) => ({
      path: file.name,
      previousPath:
        typeof file.prevName === 'string' && file.prevName.length > 0
          ? file.prevName
          : undefined,
      changeType: typeof file.type === 'string' ? file.type : 'change',
      additions: file.hunks.reduce(
        (total, hunk) => total + hunk.additionLines,
        0,
      ),
      deletions: file.hunks.reduce(
        (total, hunk) => total + hunk.deletionLines,
        0,
      ),
    })),
  )
  const filesByPath = new Map()
  for (const file of files) {
    const existing = filesByPath.get(file.path)
    if (!existing) {
      filesByPath.set(file.path, file)
      continue
    }

    existing.additions += file.additions
    existing.deletions += file.deletions
    existing.changeType =
      existing.changeType === file.changeType ? existing.changeType : 'mixed'
    existing.previousPath = existing.previousPath ?? file.previousPath
  }

  return [...filesByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
}

export function totalsForDiffFiles(files) {
  return files.reduce(
    (totals, file) => ({
      files: totals.files + 1,
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}

