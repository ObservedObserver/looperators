import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import {
  createEmptyGraphState,
  graphEdgeKinds,
  graphStateVersion,
} from '../../shared/graph-state.js'
import { MembraneBridge } from './membraneBridge.js'
import { ProviderService } from './providerService.js'
import { buildPath, claudeCommand } from './claudeCliAdapter.js'
import {
  legacyClaudeRuntimeEventsFromChunk,
  resultSublines,
} from './providers/legacyClaudeRuntimeMapper.js'

const defaultPrompt =
  'You are running under Orrery P1 live session verification. Reply with one short sentence confirming stream-json is working, then stop.'
const defaultProviderRuntimeSettings = {
  runtimeMode: 'approval-required',
}

const storageBackupSuffix = '.bak'
const recoverableActiveStatuses = new Set(['pending', 'running'])
const validSessionStatuses = new Set(['pending', 'running', 'idle', 'failed', 'killed'])
const validMessageStatuses = new Set(['streaming', 'complete', 'failed'])
const validAgentBackends = new Set([
  'claude-cli',
  'claude-agent-sdk',
  'codex-app-server',
])
const validProviderKinds = new Set([
  'legacy-claude-cli',
  'claude-code',
  'codex',
])
const validWorkModes = new Set(['local', 'worktree'])
const validRuntimeItemStatuses = new Set([
  'pending',
  'running',
  'completed',
  'failed',
])
const validRuntimeRequestDecisions = new Set(['approved', 'denied'])
const validRuntimeRequestStatuses = new Set([
  'open',
  'approved',
  'denied',
  'resolved',
  'stale',
  'canceled',
])
const validUserInputRequestStatuses = new Set([
  'open',
  'answered',
  'resolved',
  'stale',
  'canceled',
])
const validProviderRuntimeModes = new Set([
  'approval-required',
  'auto-accept-edits',
  'full-access',
])
const validProviderApprovalPolicies = new Set([
  'untrusted',
  'on-request',
  'never',
])
const validProviderSandboxModes = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
const validProviderReasoningEfforts = new Set(['low', 'medium', 'high', 'xhigh'])
const validProviderInteractionModes = new Set(['default', 'plan'])
const validGraphEdgeKinds = new Set(graphEdgeKinds)
const validLoopStatuses = new Set(['running', 'stopped'])
const emptyGitTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const gitDiffMaxBuffer = 64 * 1024 * 1024
const uiPatchMaxLength = 2 * 1024 * 1024
const checkpointGitRefRoot = 'refs/orrery/checkpoints'
const attachmentTextMaxLength = 12_000
const attachmentImageMaxBytes = 1_500_000
const supportedAttachmentImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])
const defaultProviderInstances = [
  {
    providerInstanceId: 'default-claude-sdk',
    kind: 'claude-code',
    label: 'Claude SDK',
  },
  {
    providerInstanceId: 'default-codex',
    kind: 'codex',
    label: 'Codex',
  },
  {
    providerInstanceId: 'legacy-claude-cli',
    kind: 'legacy-claude-cli',
    label: 'Claude CLI',
  },
]

type JsonRecord = Record<string, any>
type RuntimeEventEmitter = (event: JsonRecord) => void
type RuntimeRun = JsonRecord & {
  kill: () => boolean
  respondRuntimeRequest?: (input: JsonRecord) => void
  answerUserInput?: (input: JsonRecord) => void
}

function now() {
  return new Date().toISOString()
}

function clone(value) {
  return structuredClone(value)
}

function safeCwd(cwd) {
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

function cwdStat(cwd) {
  try {
    return fs.statSync(cwd)
  } catch {
    return undefined
  }
}

function isValidCwd(cwd) {
  return cwdStat(cwd)?.isDirectory() === true
}

function validateRunnableCwd(cwd) {
  const resolved = safeCwd(cwd)
  const stat = cwdStat(resolved)
  if (!stat) {
    throw new Error(
      `Project folder not found: ${resolved}. Choose an existing cwd before starting the chat.`
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Project cwd is not a folder: ${resolved}. Choose an existing project directory.`
    )
  }

  return resolved
}

function truncateChunks(chunks) {
  if (chunks.length > 1000) {
    chunks.splice(0, chunks.length - 1000)
  }
}

function truncateEvents(events) {
  if (events.length > 2000) {
    const removed = events.length - 2000
    return events.splice(0, removed)
  }
  return []
}

function truncateActivities(activities) {
  if (activities.length > 500) {
    activities.splice(0, activities.length - 500)
  }
}

function isObject(value): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function boundedText(value, maxLength = 50000) {
  if (typeof value !== 'string') {
    return ''
  }

  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}\n\n[truncated by Orrery]`
}

function normalizeChatAttachments(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isObject).map((attachment) => {
    const mediaType = nonEmptyString(attachment.mediaType)
      ? attachment.mediaType.trim()
      : nonEmptyString(attachment.type)
        ? attachment.type.trim()
        : 'application/octet-stream'
    const requestedKind =
      attachment.kind === 'image'
        ? 'image'
        : attachment.kind === 'text' || attachment.kind === 'file'
          ? 'text'
          : 'binary'
    const size = Number.isFinite(attachment.size) ? Math.max(0, attachment.size) : 0
    const kind =
      requestedKind === 'image' &&
      supportedAttachmentImageMimeTypes.has(mediaType) &&
      size <= attachmentImageMaxBytes
        ? 'image'
        : requestedKind === 'image'
          ? 'binary'
          : requestedKind
    const text =
      typeof attachment.text === 'string'
        ? boundedText(attachment.text, attachmentTextMaxLength)
        : undefined
    const dataUrl =
      kind === 'image' &&
      typeof attachment.dataUrl === 'string' &&
      attachment.dataUrl.length <= attachmentImageMaxBytes * 2
        ? attachment.dataUrl
        : undefined

    return {
      id: nonEmptyString(attachment.id) ? attachment.id : randomUUID(),
      name: nonEmptyString(attachment.name) ? attachment.name.trim() : 'attachment',
      mediaType,
      size,
      kind,
      ...(text !== undefined ? { text } : {}),
      ...(dataUrl !== undefined ? { dataUrl } : {}),
      truncated: attachment.truncated === true,
    }
  })
}

function legacyAttachmentContext(attachments = []) {
  if (!attachments.length) {
    return undefined
  }

  return [
    'Attached files:',
    ...attachments.map((attachment, index) => {
      const header = [
        `Attachment ${index + 1}: ${attachment.name}`,
        `Type: ${attachment.mediaType}`,
        `Size: ${attachment.size} bytes`,
        `Kind: ${attachment.kind}`,
      ].join('\n')

      if (attachment.kind === 'text' && typeof attachment.text === 'string') {
        return `${header}\nText content${
          attachment.truncated ? ' (truncated)' : ''
        }:\n${attachment.text}`
      }

      if (attachment.kind === 'image') {
        return `${header}\nImage data is available as a structured attachment in native providers; legacy CLI receives metadata only.`
      }

      return `${header}\nContent is not inlined; only metadata is available.`
    }),
  ].join('\n\n')
}

function gitOutput(cwd, args, options: JsonRecord = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? gitDiffMaxBuffer,
    stdio: ['ignore', 'pipe', options.quietStderr ? 'ignore' : 'pipe'],
  }).trimEnd()
}

function hasGitHead(cwd, env) {
  try {
    gitOutput(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], { env })
    return true
  } catch {
    return false
  }
}

function projectNameFromCwd(cwd) {
  return path.basename(cwd.replace(/\/$/, '')) || 'Project'
}

function validCwdCandidate(value) {
  if (!nonEmptyString(value)) {
    return undefined
  }

  const cwd = safeCwd(value)
  return isValidCwd(cwd) ? cwd : undefined
}

function cwdPathParts(cwd) {
  return safeCwd(cwd).split(path.sep).filter(Boolean)
}

function ephemeralWorktreeProjectName(cwd) {
  const parts = cwdPathParts(cwd)
  const codexIndex = parts.findIndex(
    (part, index) => part === '.codex' && parts[index + 1] === 'worktrees'
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

function cwdRepairCandidate(cwd, value) {
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

function currentGitBranch(cwd) {
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

function localGitBranches(cwd) {
  try {
    return gitOutput(cwd, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ], { quietStderr: true })
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

function gitRepoRoot(cwd) {
  try {
    const root = gitOutput(cwd, ['rev-parse', '--show-toplevel'], {
      quietStderr: true,
    })
    return root.length > 0 ? root : undefined
  } catch {
    return undefined
  }
}

function gitProjectContext(cwd) {
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

function normalizeWorkMode(value) {
  return validWorkModes.has(value) ? value : 'local'
}

function normalizeBranchName(value) {
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

function branchSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .replace(/\/+/g, '/')
    .slice(0, 48)
}

function gitRefSlug(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/[/.]+$/g, '')
    .replace(/^\.+/g, '')
    .slice(0, 96) || 'unknown'
}

function checkpointRef({ sessionId, turnCount, turnId, stage }) {
  return [
    checkpointSessionRefRoot(sessionId),
    'turns',
    String(turnCount),
    `${gitRefSlug(turnId)}-${stage}`,
  ].join('/')
}

function checkpointSessionRefRoot(sessionId) {
  return [checkpointGitRefRoot, gitRefSlug(sessionId)].join('/')
}

function gitCheckpointEnv(tempIndex) {
  return {
    ...process.env,
    GIT_INDEX_FILE: tempIndex,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Orrery',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'orrery@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Orrery',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'orrery@local',
  }
}

function sessionProjectFromContext(context, workMode, branch, baseBranch) {
  return {
    name: context.projectName,
    cwd: context.repoRoot ?? context.cwd,
    repoRoot: context.repoRoot,
    workMode,
    baseBranch,
    branch,
  }
}

function normalizeSessionProject(value, cwd) {
  if (!isObject(value)) {
    return undefined
  }

  const workMode = normalizeWorkMode(value.workMode)
  const name =
    nonEmptyString(value.name) ? value.name.trim() : projectNameFromCwd(cwd)
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
  }
}

function createSessionWorktree(projectCwd, sessionId, requestedBranch) {
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
  const worktreeRoot = path.join(
    path.dirname(context.repoRoot),
    '.orrery-worktrees',
    context.projectName
  )
  const worktreePath = path.join(worktreeRoot, shortId)

  fs.mkdirSync(worktreeRoot, { recursive: true })
  gitOutput(context.repoRoot, [
    'worktree',
    'add',
    '-b',
    sessionBranch,
    worktreePath,
    baseBranch,
  ])

  return {
    cwd: worktreePath,
    project: sessionProjectFromContext(
      context,
      'worktree',
      sessionBranch,
      baseBranch
    ),
  }
}

function localSessionWorkspace(projectCwd, requestedBranch) {
  const context = gitProjectContext(projectCwd)
  const currentBranch = normalizeBranchName(context.currentBranch)
  const requested = normalizeBranchName(requestedBranch)
  if (requested && currentBranch && requested !== currentBranch) {
    throw new Error(
      `Work locally uses the currently checked out branch (${currentBranch}). Choose New worktree to start from ${requested}.`
    )
  }

  return {
    cwd: context.cwd,
    project: sessionProjectFromContext(
      context,
      'local',
      currentBranch ?? requested,
      undefined
    ),
  }
}

function parseDiffFilesFromPatch(patch) {
  if (patch.trim().length === 0) {
    return []
  }

  const files = parsePatchFiles(patch)
    .flatMap((parsedPatch) =>
      parsedPatch.files.map((file) => ({
        path: file.name,
        previousPath:
          typeof file.prevName === 'string' && file.prevName.length > 0
            ? file.prevName
            : undefined,
        changeType: typeof file.type === 'string' ? file.type : 'change',
        additions: file.hunks.reduce(
          (total, hunk) => total + hunk.additionLines,
          0
        ),
        deletions: file.hunks.reduce(
          (total, hunk) => total + hunk.deletionLines,
          0
        ),
      }))
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
    left.path.localeCompare(right.path)
  )
}

function totalsForDiffFiles(files) {
  return files.reduce(
    (totals, file) => ({
      files: totals.files + 1,
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 }
  )
}

function diagnostic(type, message, details = {}) {
  return {
    id: randomUUID(),
    type,
    message,
    details,
    ts: now(),
  }
}

function backupFileFor(storageFile) {
  return `${storageFile}${storageBackupSuffix}`
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, error }
  }
}

function preserveCorruptFile(storageFile) {
  if (!fs.existsSync(storageFile)) {
    return undefined
  }

  const corruptFile = `${storageFile}.corrupt.${Date.now()}`
  try {
    fs.copyFileSync(storageFile, corruptFile)
    return corruptFile
  } catch {
    return undefined
  }
}

function writeJsonAtomically(storageFile, value) {
  fs.mkdirSync(path.dirname(storageFile), { recursive: true })

  if (fs.existsSync(storageFile)) {
    if (readJsonFile(storageFile).ok) {
      fs.copyFileSync(storageFile, backupFileFor(storageFile))
    } else {
      preserveCorruptFile(storageFile)
    }
  }

  const tempFile = `${storageFile}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tempFile, storageFile)
  } catch (error) {
    try {
      fs.rmSync(tempFile, { force: true })
    } catch {
      // Best-effort cleanup only; the next load ignores orphan temp files.
    }
    throw error
  }
}

function messageContent(message, context) {
  if (typeof context === 'string' && context.trim().length > 0) {
    return `${message}\n\nContext:\n${context}`
  }

  return message
}

function combinedContext(...values) {
  const sections = values
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

function providerPromptContent({ providerKind, message, context, attachments }) {
  if (providerKind === 'legacy-claude-cli') {
    return messageContent(
      message,
      combinedContext(context, legacyAttachmentContext(attachments))
    )
  }

  return messageContent(message, context)
}

function providerConfig(input: JsonRecord = {}, providerInstances: JsonRecord[] = []) {
  const requestedInstanceId = optionalTrimmedString(input.providerInstanceId)
  const requestedInstance = requestedInstanceId
    ? providerInstances.find(
        (instance) => instance.providerInstanceId === requestedInstanceId
      )
    : undefined
  if (requestedInstanceId && !requestedInstance) {
    throw new Error(`Unknown provider instance: ${requestedInstanceId}`)
  }

  const requested =
    input.providerKind ??
    (input.agent === 'codex' ? 'codex' : undefined) ??
    requestedInstance?.kind
  const requestedKind = validProviderKinds.has(requested)
    ? requested
    : 'legacy-claude-cli'
  const providerInstance =
    requestedInstance ??
    providerInstances.find((instance) => instance.kind === requestedKind) ??
    defaultProviderInstanceForKind(requestedKind)

  if (providerInstance.kind !== requestedKind) {
    throw new Error(
      `Provider instance ${providerInstance.providerInstanceId} is ${providerInstance.kind}, not ${requestedKind}.`
    )
  }

  if (requestedKind === 'codex') {
    return {
      agent: 'codex',
      backend: 'codex-app-server',
      providerKind: 'codex',
      providerInstanceId: providerInstance.providerInstanceId,
      labelPrefix: 'Codex',
    }
  }

  if (requestedKind === 'claude-code') {
    return {
      agent: 'claude-code',
      backend: 'claude-agent-sdk',
      providerKind: 'claude-code',
      providerInstanceId: providerInstance.providerInstanceId,
      labelPrefix: 'Claude',
    }
  }

  return {
    agent: 'claude-code',
    backend: 'claude-cli',
    providerKind: 'legacy-claude-cli',
    providerInstanceId: providerInstance.providerInstanceId,
    labelPrefix: 'Claude',
  }
}

function defaultCommandForProvider(providerKind) {
  if (providerKind === 'codex') {
    return process.env.ORRERY_CODEX_BIN || 'codex'
  }

  return claudeCommand()
}

function commandForProviderInstance(providerKind, providerInstance) {
  if (nonEmptyString(providerInstance?.binaryPath)) {
    return providerInstance.binaryPath.trim()
  }

  return defaultCommandForProvider(providerKind)
}

function commandExists(command) {
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
    return { ok: resolved.length > 0, detail: resolved || command }
  } catch {
    return { ok: false, detail: `Could not find ${command} on PATH.` }
  }
}

function providerSetupErrorDiagnostic(providerKind, diagnostics = []) {
  const providerPattern =
    providerKind === 'codex'
      ? /codex|auth|login|account|rate.?limit/i
      : /claude|auth|login|account|rate.?limit/i
  return diagnostics.find((diagnostic) =>
    providerPattern.test(`${diagnostic.type} ${diagnostic.message}`)
  )
}

function defaultProviderInstanceForKind(providerKind) {
  return (
    defaultProviderInstances.find((instance) => instance.kind === providerKind) ??
    defaultProviderInstances[0]
  )
}

function normalizeSessionProviderInstanceId(providerKind, providerInstanceId) {
  const id = optionalTrimmedString(providerInstanceId)
  if (!id) {
    return defaultProviderInstanceForKind(providerKind).providerInstanceId
  }
  if (validProviderKinds.has(id)) {
    return defaultProviderInstanceForKind(id).providerInstanceId
  }
  return id
}

function normalizeLaunchArgs(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : []

  return values
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

function normalizeEnv(value) {
  if (!isObject(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [
      key.trim(),
      typeof entryValue === 'string' ? entryValue : String(entryValue),
    ])
    .filter(([key]) => key.length > 0)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function optionalTrimmedString(value) {
  return nonEmptyString(value) ? value.trim() : undefined
}

function normalizeProviderInstance(
  value: JsonRecord = {},
  fallback?: JsonRecord,
  { reuseOptionalFallback = true }: { reuseOptionalFallback?: boolean } = {}
) {
  const input = isObject(value) ? value : {}
  const fallbackInstance = isObject(fallback) ? fallback : undefined
  const providerInstanceId =
    optionalTrimmedString(input.providerInstanceId) ??
    optionalTrimmedString(fallbackInstance?.providerInstanceId)
  if (!providerInstanceId) {
    throw new Error('Provider instance id is required.')
  }

  const kind = validProviderKinds.has(input.kind)
    ? input.kind
    : validProviderKinds.has(fallbackInstance?.kind)
      ? fallbackInstance.kind
      : defaultProviderInstanceForKind('claude-code').kind
  if (fallbackInstance && fallbackInstance.kind !== kind) {
    throw new Error(
      `Provider instance ${providerInstanceId} is ${fallbackInstance.kind}, not ${kind}.`
    )
  }

  const label =
    optionalTrimmedString(input.label) ??
    optionalTrimmedString(fallbackInstance?.label) ??
    providerInstanceId
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(input, key)
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

function normalizeProviderInstances(value) {
  const byId = new Map<string, JsonRecord>(
    defaultProviderInstances.map((instance) => [
      instance.providerInstanceId,
      { ...instance },
    ])
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

function normalizeProviderRuntimeSettings(value: JsonRecord = {}) {
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

export class RuntimeSessionManager {
  #state: JsonRecord = createEmptyGraphState()
  #runs = new Map<string, RuntimeRun>()
  #runContext = new Map<string, JsonRecord>()
  #loopTasks = new Map<string, Promise<void>>()
  #storageFile: string | undefined
  #emitRuntimeEventToHost: RuntimeEventEmitter | undefined
  #bridge: MembraneBridge
  #providerService: ProviderService

  constructor({
    storageFile,
    broadcastRuntimeEvent,
    emitRuntimeEvent,
    broadcast,
    emit,
  }: JsonRecord = {}) {
    this.#storageFile =
      typeof storageFile === 'string' && storageFile.length > 0
        ? storageFile
        : undefined
    this.#emitRuntimeEventToHost =
      typeof broadcastRuntimeEvent === 'function'
        ? broadcastRuntimeEvent
        : typeof emitRuntimeEvent === 'function'
          ? emitRuntimeEvent
          : typeof broadcast === 'function'
            ? broadcast
            : typeof emit === 'function'
              ? emit
              : undefined
    this.#state = this.#loadState()
    this.#bridge = new MembraneBridge({
      handler: (request) => this.handleMembraneRequest(request),
    })
    this.#providerService = new ProviderService({
      providerInstances: this.#state.providerInstances,
    })
    this.#persistState()
    this.#recoverRunningLoops()
  }

  getState() {
    return clone(this.#state)
  }

  getProjectContext(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    try {
      return gitProjectContext(request.cwd)
    } catch (error) {
      const cwd = safeCwd(request.cwd)
      return {
        cwd,
        projectName: projectNameFromCwd(cwd),
        isGitRepo: false,
        branches: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  getProviderSetupStatus(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const requestedProviderKind = validProviderKinds.has(request.providerKind)
      ? request.providerKind
      : 'legacy-claude-cli'
    const requestedInstanceId = optionalTrimmedString(request.providerInstanceId)
    const requestedInstance = requestedInstanceId
      ? this.#state.providerInstances.find(
          (instance) => instance.providerInstanceId === requestedInstanceId
        )
      : undefined
    if (requestedInstanceId && !requestedInstance) {
      throw new Error(`Unknown provider instance: ${requestedInstanceId}`)
    }
    if (requestedInstance && requestedInstance.kind !== requestedProviderKind) {
      throw new Error(
        `Provider instance ${requestedInstance.providerInstanceId} is ${requestedInstance.kind}, not ${requestedProviderKind}.`
      )
    }
    const providerKind = requestedProviderKind
    const providerInstance =
      requestedInstance ??
      this.#state.providerInstances.find((instance) => instance.kind === providerKind)
    const command = commandForProviderInstance(providerKind, providerInstance)
    const binary = commandExists(command)
    const cwd = nonEmptyString(request.cwd) ? safeCwd(request.cwd) : process.cwd()
    const cwdValid = isValidCwd(cwd)
    const providerDiagnostic = providerSetupErrorDiagnostic(
      providerKind,
      this.#state.diagnostics ?? []
    )

    return {
      providerKind,
      providerInstanceId: providerInstance?.providerInstanceId,
      generatedAt: now(),
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
          status: providerDiagnostic ? 'warning' : 'unknown',
          message: providerDiagnostic
            ? providerDiagnostic.message
            : 'Provider auth and account status are managed by the local CLI; start a chat to verify.',
          detail: providerDiagnostic?.type,
        },
        {
          id: 'mcp',
          label: 'MCP / tools',
          status: providerKind === 'codex' ? 'unknown' : 'ok',
          message:
            providerKind === 'codex'
              ? 'Codex app-server tool/MCP availability is reported through runtime events during a turn.'
              : 'Orrery membrane MCP bridge is available for Claude sessions.',
        },
      ],
    }
  }

  upsertProviderInstance(input: JsonRecord = {}) {
    if (!validProviderKinds.has(input.kind)) {
      throw new Error(`Unsupported provider instance kind: ${String(input.kind)}`)
    }
    const requestedId = optionalTrimmedString(input.providerInstanceId)
    const existing = requestedId
      ? this.#state.providerInstances.find(
          (instance) => instance.providerInstanceId === requestedId
        )
      : undefined
    const normalizedInput = {
      ...input,
      providerInstanceId:
        requestedId ??
        defaultProviderInstanceForKind(input.kind).providerInstanceId,
    }
    const providerInstance = normalizeProviderInstance(normalizedInput, existing, {
      reuseOptionalFallback: false,
    })
    const nextInstances = [...this.#state.providerInstances]
    const index = nextInstances.findIndex(
      (instance) => instance.providerInstanceId === providerInstance.providerInstanceId
    )
    if (index >= 0) {
      nextInstances[index] = providerInstance
    } else {
      nextInstances.push(providerInstance)
    }

    this.#state.providerInstances = nextInstances
    this.#providerService.registerProviderInstance(providerInstance)
    this.#touch()
    this.#broadcast({ type: 'provider.instances.updated', state: this.getState() })
    return { providerInstance: clone(providerInstance), state: this.getState() }
  }

  async createSession(input: JsonRecord = {}) {
    const sessionId = randomUUID()
    const role = input.role === 'master' ? 'master' : 'worker'
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : undefined
    if (cluster && this.#state.clusters[cluster]?.frozen) {
      throw new Error(`Frozen cluster cannot create new sessions: ${cluster}`)
    }
    const sourceSessionId =
      typeof input.sourceSessionId === 'string' &&
      input.sourceSessionId.trim().length > 0
        ? input.sourceSessionId.trim()
        : undefined
    if (sourceSessionId && !this.#state.sessions[sourceSessionId]) {
      throw new Error(`Unknown linked chat source session: ${sourceSessionId}`)
    }

    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt
        : defaultPrompt
    const attachments = normalizeChatAttachments(input.attachments)
    const provider = providerConfig(input, this.#state.providerInstances)
    const initialContent = messageContent(prompt, input.context)
    const providerPrompt = providerPromptContent({
      providerKind: provider.providerKind,
      message: prompt,
      context: input.context,
      attachments,
    })
    const runtimeSettings = normalizeProviderRuntimeSettings(input.runtimeSettings)
    const workspace =
      normalizeWorkMode(input.workMode) === 'worktree'
        ? createSessionWorktree(input.cwd, sessionId, input.branch)
        : localSessionWorkspace(input.cwd, input.branch)
    const cwd = workspace.cwd
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `${provider.labelPrefix} ${this.#state.nodes.length + 1}`
    const ts = now()

    this.#state.sessions[sessionId] = {
      sessionId,
      nodeId: sessionId,
      backend: provider.backend,
      backendSessionId:
        provider.providerKind === 'legacy-claude-cli' ? sessionId : undefined,
      providerKind: provider.providerKind,
      providerInstanceId: provider.providerInstanceId,
      providerSessionId:
        provider.providerKind === 'legacy-claude-cli' ? sessionId : undefined,
      agent: provider.agent,
      label,
      prompt: initialContent,
      cwd,
      project: workspace.project,
      role,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
      nativeEvents: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
      runtimeSettings,
      messages: [
        {
          id: randomUUID(),
          sessionId,
          role: 'user',
          content: initialContent,
          attachments,
          ts,
          runId: undefined,
          status: 'complete',
        },
      ],
    }

    this.#state.nodes.push({
      nodeId: sessionId,
      sessionId,
      label,
      role,
      agent: provider.agent,
      clusterId: cluster,
      status: 'pending',
      position: {
        x: 96 + (this.#state.nodes.length % 4) * 280,
        y: 96 + Math.floor(this.#state.nodes.length / 4) * 180,
      },
    })
    if (cluster) {
      this.#ensureCluster(cluster)
      if (role !== 'master') {
        this.#addNodeToCluster(sessionId, cluster)
      }
    }
    if (sourceSessionId) {
      const linkLabel =
        typeof input.linkLabel === 'string' && input.linkLabel.trim().length > 0
          ? input.linkLabel.trim()
          : 'linked chat'
      this.#addEdge({
        source: sourceSessionId,
        target: sessionId,
        kind: 'create-session',
        envelope: this.#createEnvelope(sourceSessionId),
        label: linkLabel,
        masterReason: this.#masterReasonFromInput(sourceSessionId, input),
      })
    }
    this.#touch()
    this.#broadcast({ type: 'session.created', sessionId, state: this.getState() })

    await this.#startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: 'create',
      userMessageId: this.#state.sessions[sessionId].messages[0].id,
    })

    return { sessionId, state: this.getState() }
  }

  async resumeSession(input: JsonRecord = {}) {
    const sessionId = input.sessionId
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    if (this.#runs.has(sessionId)) {
      throw new Error(`Session is already running: ${sessionId}`)
    }

    if (session.status === 'killed') {
      throw new Error(`Killed session cannot be resumed: ${sessionId}`)
    }

    if (this.#isSessionFrozen(sessionId)) {
      throw new Error(`Frozen session cannot be resumed: ${sessionId}`)
    }

    try {
      session.cwd = validateRunnableCwd(session.cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#failSession(sessionId, message)
      throw error
    }

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('Resume message is required')
    }

    const attachments = normalizeChatAttachments(input.attachments)
    const content = messageContent(message, input.context)
    const providerPrompt = providerPromptContent({
      providerKind: session.providerKind,
      message,
      context: input.context,
      attachments,
    })
    const ts = now()
    const userMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content,
      attachments,
      ts,
      runId: undefined,
      status: 'complete',
    }
    session.messages.push(userMessage)
    session.prompt = content
    session.status = 'pending'
    session.error = undefined
    session.exitCode = undefined
    session.signal = undefined
    session.updatedAt = ts
    this.#updateNodeStatus(sessionId, 'pending')
    this.#touch()
    this.#broadcast({ type: 'session.resumed', sessionId, state: this.getState() })

    await this.#startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: 'resume',
      userMessageId: userMessage.id,
    })

    return { ok: true, state: this.getState() }
  }

  archiveSession(input: JsonRecord | string = {}) {
    const sessionId =
      typeof input === 'string'
        ? input
        : typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
          ? input.sessionId.trim()
          : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const archived = typeof input === 'object' && input.archived === false ? false : true
    this.#state.sessions[sessionId].archived = archived
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { ok: true, state: this.getState() }
  }

  getWorkingTreeDiff(input: JsonRecord | string = {}) {
    const sessionId =
      typeof input === 'string'
        ? input
        : typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
          ? input.sessionId.trim()
          : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    if (typeof input === 'object' && nonEmptyString(input.turnId)) {
      return this.#checkpointDiffForSession(sessionId, {
        turnId: input.turnId.trim(),
        ignoreWhitespace: input.ignoreWhitespace === true,
      })
    }

    return this.#workingTreeDiffForSession(sessionId, {
      ignoreWhitespace:
        typeof input === 'object' && input.ignoreWhitespace === true,
    })
  }

  killSession(sessionId) {
    const run = this.#runs.get(sessionId)
    const session = this.#state.sessions[sessionId]

    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    if (!run) {
      return { ok: false, state: this.getState() }
    }

    const ok = run.kill()
    if (ok) {
      session.status = 'killed'
      session.updatedAt = now()
      this.#markActiveAssistant(sessionId, 'failed')
      this.#updateNodeStatus(sessionId, 'killed')
      this.#appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts: session.updatedAt,
        type: 'session.state',
        sessionId,
        status: 'killed',
      })
      this.#cancelOpenRuntimeInteractions(sessionId, session.updatedAt)
      this.#touch()
      this.#emitRuntimeEvent({
        type: 'session.killed',
        sessionId,
        state: this.getState(),
      })
    }

    return { ok, state: this.getState() }
  }

  killAll() {
    for (const sessionId of this.#runs.keys()) {
      this.killSession(sessionId)
    }
    this.#providerService?.closeAll?.()
    this.#bridge?.close()
  }

  respondRuntimeRequest(input: JsonRecord = {}) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const decision = input.decision

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('Runtime request id is required')
    }
    if (!validRuntimeRequestDecisions.has(decision)) {
      throw new Error('Runtime request decision must be approved or denied')
    }

    const session = this.#state.sessions[sessionId]
    const request = session.runtimeRequests?.find((item) => item.id === requestId)
    if (!request) {
      throw new Error(`Unknown runtime request: ${requestId}`)
    }
    if (request.status !== 'open') {
      return { ok: false, state: this.getState() }
    }

    const run = this.#runs.get(sessionId)
    if (typeof run?.respondRuntimeRequest !== 'function') {
      throw new Error(`Session cannot respond to runtime requests: ${sessionId}`)
    }

    run.respondRuntimeRequest({ requestId, decision })
    const event = {
      id: randomUUID(),
      ts: now(),
      type: 'request.resolved',
      sessionId,
      requestId,
      status: decision,
    }
    this.#appendExternalProviderRuntimeEvent(sessionId, event)
    return { ok: true, state: this.getState() }
  }

  answerUserInput(input: JsonRecord = {}) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const answer = typeof input.answer === 'string' ? input.answer : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('User input request id is required')
    }
    if (answer === undefined) {
      throw new Error('User input answer is required')
    }

    const session = this.#state.sessions[sessionId]
    const request = session.runtimeUserInputRequests?.find(
      (item) => item.id === requestId
    )
    if (!request) {
      throw new Error(`Unknown user input request: ${requestId}`)
    }
    if (request.status !== 'open') {
      return { ok: false, state: this.getState() }
    }

    const run = this.#runs.get(sessionId)
    if (typeof run?.answerUserInput !== 'function') {
      throw new Error(`Session cannot answer user input requests: ${sessionId}`)
    }

    run.answerUserInput({ requestId, answer })
    const event = {
      id: randomUUID(),
      ts: now(),
      type: 'user-input.answered',
      sessionId,
      requestId,
      answer,
    }
    this.#appendExternalProviderRuntimeEvent(sessionId, event)
    return { ok: true, state: this.getState() }
  }

  upsertCluster(input: JsonRecord = {}) {
    const nodeIds = this.#normalizeClusterNodeIds(input.nodeIds)
    if (nodeIds.length === 0) {
      throw new Error('Cluster requires at least one managed session node')
    }

    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : `cluster-${randomUUID().slice(0, 8)}`
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : clusterId
    const existing = this.#state.clusters[clusterId]

    this.#state.clusters[clusterId] = {
      ...(existing ?? {}),
      clusterId,
      label,
      nodeIds,
      loopPolicy:
        input.loopPolicy !== undefined
          ? this.#normalizeLoopPolicy(input.loopPolicy)
          : existing?.loopPolicy,
    }

    const masterSessionId = this.#state.clusters[clusterId].masterSessionId
    for (const node of this.#state.nodes) {
      if (
        node.clusterId === clusterId &&
        !nodeIds.includes(node.sessionId) &&
        node.sessionId !== masterSessionId
      ) {
        node.clusterId = undefined
      }
      if (nodeIds.includes(node.sessionId)) {
        node.clusterId = clusterId
      }
      if (node.sessionId === masterSessionId) {
        node.clusterId = clusterId
      }
    }

    for (const sessionId of nodeIds) {
      this.#removeNodeFromOtherClusters(sessionId, clusterId)
    }

    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { clusterId, state: this.getState() }
  }

  async createMasterForCluster(input: JsonRecord = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const cluster = this.#state.clusters[clusterId]
    if (input.loopPolicy !== undefined) {
      cluster.loopPolicy = this.#normalizeLoopPolicy(input.loopPolicy)
    }

    if (cluster.masterSessionId) {
      if (this.#state.sessions[cluster.masterSessionId]) {
        this.#assignMaster(clusterId, cluster.masterSessionId)
        this.#touch()
        this.#broadcast({ type: 'runtime.state', state: this.getState() })
        return { sessionId: cluster.masterSessionId, state: this.getState() }
      }

      delete cluster.masterSessionId
    }

    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : this.#defaultMasterPrompt(clusterId)
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : `${cluster.label} Master`

    const result = await this.createSession({
      agent: input.agent === 'codex' ? 'codex' : 'claude-code',
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId,
      prompt,
      cwd: input.cwd,
      label,
      cluster: clusterId,
      role: 'master',
      runtimeSettings: input.runtimeSettings,
    })
    this.#assignMaster(clusterId, result.sessionId)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { sessionId: result.sessionId, state: this.getState() }
  }

  assignMasterToCluster(input: JsonRecord = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined

    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }
    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    this.#assignMaster(clusterId, sessionId)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { state: this.getState() }
  }

  setClusterLoopPolicy(input: JsonRecord = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    this.#state.clusters[clusterId].loopPolicy = this.#normalizeLoopPolicy(
      input.loopPolicy
    )
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { state: this.getState() }
  }

  updateNodePositions(input: JsonRecord = {}) {
    const positions = Array.isArray(input.positions) ? input.positions : []
    let changed = false

    for (const item of positions) {
      if (!isObject(item) || !isObject(item.position)) {
        continue
      }

      const nodeId =
        typeof item.nodeId === 'string' && item.nodeId.trim().length > 0
          ? item.nodeId.trim()
          : undefined
      const x = item.position.x
      const y = item.position.y
      if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
        continue
      }

      const node = this.#state.nodes.find((candidate) => candidate.nodeId === nodeId)
      if (!node) {
        continue
      }

      if (node.position.x === x && node.position.y === y) {
        continue
      }

      node.position = { x, y }
      changed = true
    }

    if (changed) {
      this.#touch()
      this.#broadcast({ type: 'runtime.state', state: this.getState() })
    }

    return { state: this.getState() }
  }

  startMasterLoop(input: JsonRecord = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const cluster = this.#state.clusters[clusterId]
    if (cluster.frozen) {
      throw new Error(`Frozen cluster cannot run a loop: ${clusterId}`)
    }

    if (!cluster.loopPolicy) {
      throw new Error(`Cluster has no LoopPolicy: ${clusterId}`)
    }

    if (!cluster.masterSessionId || !this.#state.sessions[cluster.masterSessionId]) {
      throw new Error(`Cluster has no master session: ${clusterId}`)
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      throw new Error(`Cluster has no managed worker session: ${clusterId}`)
    }

    const ts = now()
    cluster.loopState = {
      ...(cluster.loopState ?? {}),
      status: 'running',
      iterations: 0,
      coderSessionId,
      reviewerSessionId: this.#loopReviewerSessionId(cluster, coderSessionId),
      lastEvent: { type: 'loop.started', ts },
      lastProcessedEventKey: undefined,
      reason:
        typeof input.reason === 'string' && input.reason.trim().length > 0
          ? input.reason.trim()
          : 'Loop started by user.',
      startedAt: ts,
      stoppedAt: undefined,
    }

    this.#touch()
    this.#broadcast({
      type: 'loop.started',
      clusterId,
      state: this.getState(),
    })
    this.#queueLoopWakeup(clusterId, { type: 'loop.started', ts })
    return { state: this.getState() }
  }

  stopMasterLoop(input: JsonRecord = {}) {
    const clusterId =
      typeof input.clusterId === 'string' && input.clusterId.trim().length > 0
        ? input.clusterId.trim()
        : undefined
    if (!clusterId || !this.#state.clusters[clusterId]) {
      throw new Error(`Unknown cluster: ${clusterId ?? ''}`)
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Loop stopped by user.'
    this.#stopLoop(clusterId, reason, {
      event: { type: 'loop.stopped', ts: now() },
      broadcast: true,
    })

    if (input.killRunning === true) {
      const cluster = this.#state.clusters[clusterId]
      const runningIds = [
        ...cluster.nodeIds,
        cluster.masterSessionId,
      ].filter((sessionId) => this.#runs.has(sessionId))
      for (const sessionId of runningIds) {
        this.killSession(sessionId)
      }
    }

    return { state: this.getState() }
  }

  freeze(input: JsonRecord = {}) {
    const target =
      typeof input.target === 'string' && input.target.trim().length > 0
        ? input.target.trim()
        : typeof input.targetId === 'string' && input.targetId.trim().length > 0
          ? input.targetId.trim()
          : undefined
    if (!target) {
      throw new Error('freeze target is required')
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Frozen by user.'
    return this.#applyFreeze({
      targetId: target,
      reason,
      source: input.source,
      masterReason: input.masterReason,
    })
  }

  async handleMembraneRequest({ tool, source, input }: JsonRecord) {
    if (!this.#state.sessions[source]) {
      throw new Error(`Unknown membrane source session: ${source}`)
    }

    if (tool === 'create_session') {
      return this.#membraneCreateSession(source, input)
    }

    if (tool === 'resume_session') {
      return this.#membraneResumeSession(source, input)
    }

    if (tool === 'report') {
      return this.#membraneReport(source, input)
    }

    throw new Error(`Unknown membrane tool: ${tool}`)
  }

  async #startRun(sessionId, { prompt, attachments = [], runKind, userMessageId }) {
    const session = this.#state.sessions[sessionId]
    const runId = randomUUID()
    const bridgeUrl = await this.#bridge.start()
    const membraneToken = this.#bridge.createRunToken(sessionId)
    const fromTurnCount = this.#completedTurnCount(session)
    let turnCheckpoint
    session.status = 'running'
    session.startedAt = now()
    session.finishedAt = undefined
    session.updatedAt = session.startedAt
    try {
      turnCheckpoint = {
        ...this.#captureTurnCheckpoint({
          sessionId,
          turnId: runId,
          turnCount: fromTurnCount,
          stage: 'before',
        }),
        fromTurnCount,
      }
    } catch (error) {
      turnCheckpoint = {
        fromTurnCount,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.#updateMessageRunId(session, userMessageId, runId)
    this.#updateNodeStatus(sessionId, 'running')
    this.#runContext.set(sessionId, {
      runId,
      runKind,
      assistantMessageId: undefined,
      sawTextDelta: false,
      turnCheckpoint,
      turnDiffRecorded: false,
    })
    this.#appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.startedAt,
      type: 'turn.started',
      sessionId,
      turnId: runId,
    })
    this.#appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.startedAt,
      type: 'session.state',
      sessionId,
      status: 'running',
    })
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    let run
    try {
      run = this.#providerService.startTurn({
        providerKind: session.providerKind,
        providerInstanceId: session.providerInstanceId,
        turnId: runId,
        prompt,
        attachments,
        cwd: session.cwd,
        backendSessionId:
          runKind === 'resume'
            ? session.providerSessionId ?? session.backendSessionId
            : undefined,
        providerResumeCursor: session.providerResumeCursor,
        sessionId,
        runtimeSettings: session.runtimeSettings,
        membrane: {
          bridgeUrl,
          token: membraneToken,
        },
      })
    } catch (error) {
      this.#bridge.revokeRunToken(membraneToken)
      this.#failSession(sessionId, error.message)
      return
    }

    this.#runs.set(sessionId, run)

    run.on('stream', (chunk) => this.#appendStreamChunk(sessionId, chunk))
    run.on('native', (event) => this.#appendNativeProviderEnvelope(sessionId, event))
    run.on('providerEvent', (event) =>
      this.#appendExternalProviderRuntimeEvent(sessionId, event)
    )
    run.on('providerSession', (event) =>
      this.#recordProviderSession(sessionId, event)
    )
    run.on('stderr', (data) => this.#appendProviderStderr(sessionId, data))
    run.on('result', (event) => this.#recordResult(sessionId, event))
    run.on('error', (error) => this.#failSession(sessionId, error.message))
    run.on('close', ({ code, signal, killed }) => {
      this.#runs.delete(sessionId)
      this.#bridge.revokeRunToken(membraneToken)

      const current = this.#state.sessions[sessionId]
      if (!current) {
        return
      }

      current.exitCode = code
      current.signal = signal
      current.finishedAt = now()
      current.updatedAt = current.finishedAt
      this.#recordTurnCheckpointDiff(sessionId, current.finishedAt)
      this.#appendTurnCompletedIfMissing(sessionId, current.finishedAt)
      this.#cancelOpenRuntimeInteractions(sessionId, current.finishedAt)

      if (killed || current.status === 'killed') {
        current.status = 'killed'
        this.#markActiveAssistant(sessionId, 'failed')
        this.#updateNodeStatus(sessionId, 'killed')
        this.#appendProviderRuntimeEvent(sessionId, {
          id: randomUUID(),
          ts: current.updatedAt,
          type: 'session.state',
          sessionId,
          status: 'killed',
        })
        this.#runContext.delete(sessionId)
        this.#touch()
        this.#emitRuntimeEvent({
          type: 'session.killed',
          sessionId,
          state: this.getState(),
        })
        return
      }

      if (code === 0 && current.status !== 'failed') {
        current.status = 'idle'
        this.#markActiveAssistant(sessionId, 'complete')
        this.#updateNodeStatus(sessionId, 'idle')
        this.#appendProviderRuntimeEvent(sessionId, {
          id: randomUUID(),
          ts: current.updatedAt,
          type: 'session.state',
          sessionId,
          status: 'idle',
        })
        this.#runContext.delete(sessionId)
        this.#touch()
        this.#emitRuntimeEvent({
          type: 'session.finished',
          sessionId,
          state: this.getState(),
        })
        return
      }

      this.#failSession(
        sessionId,
        current.error ?? `Claude exited with code ${code ?? 'null'}`
      )
    })
  }

  #appendStreamChunk(sessionId, chunk) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    const backendSessionId = chunk.event?.session_id ?? chunk.event?.event?.session_id
    if (typeof backendSessionId === 'string') {
      session.backendSessionId = backendSessionId
      session.providerSessionId = backendSessionId
    }

    const streamChunk = {
      id: randomUUID(),
      sessionId,
      ts: now(),
      stream: chunk.stream,
      raw: chunk.raw,
      eventType: chunk.eventType,
      text: chunk.text,
    }

    session.chunks.push(streamChunk)
    truncateChunks(session.chunks)

    this.#appendNativeProviderEvent(session, streamChunk, chunk)
    this.#appendLegacyProviderRuntimeEvents(sessionId, streamChunk, chunk)
    this.#appendAssistantMessage(sessionId, chunk)
    session.updatedAt = streamChunk.ts
    this.#touch()
    this.#broadcast({
      type: 'session.stream',
      sessionId,
      chunk: streamChunk,
      state: this.getState(),
    })
  }

  #appendNativeProviderEvent(session, streamChunk, chunk) {
    if (!chunk.event) {
      return
    }

    session.nativeEvents ??= []
    const event = {
      id: randomUUID(),
      ts: streamChunk.ts,
      sessionId: session.sessionId,
      providerKind: session.providerKind ?? 'legacy-claude-cli',
      turnId: this.#runContext.get(session.sessionId)?.runId,
      raw: {
        source: 'legacy.claude-cli.stream-json',
        messageType: streamChunk.eventType,
        payload: chunk.event,
      },
    }
    session.nativeEvents.push(event)
    this.#providerService.recordNativeEvent(event)
    truncateEvents(session.nativeEvents)
  }

  #appendNativeProviderEnvelope(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session || !event?.raw) {
      return
    }

    session.nativeEvents ??= []
    const nativeEvent = {
      id: randomUUID(),
      ts: nonEmptyString(event.ts) ? event.ts : now(),
      sessionId,
      providerKind: validProviderKinds.has(event.providerKind)
        ? event.providerKind
        : session.providerKind,
      turnId: nonEmptyString(event.turnId)
        ? event.turnId
        : this.#runContext.get(sessionId)?.runId,
      raw: event.raw,
    }
    session.nativeEvents.push(nativeEvent)
    this.#providerService.recordNativeEvent(nativeEvent)
    truncateEvents(session.nativeEvents)
  }

  #recordProviderSession(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session || !nonEmptyString(event?.providerSessionId)) {
      return
    }

    session.providerSessionId = event.providerSessionId
    session.backendSessionId = event.providerSessionId
    if (nonEmptyString(event.resumeCursor)) {
      session.providerResumeCursor = event.resumeCursor
    }
    session.updatedAt = now()
    this.#touch()
  }

  #appendExternalProviderRuntimeEvent(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    const normalizedEvent = {
      ...event,
      sessionId,
    }
    this.#appendProviderRuntimeEvent(sessionId, normalizedEvent)

    if (normalizedEvent.type === 'content.delta') {
      this.#appendContentDeltaMessage(sessionId, normalizedEvent)
    }

    session.updatedAt = normalizedEvent.ts ?? now()
    this.#touch()
    this.#broadcast({
      type: 'provider.runtime',
      sessionId,
      providerEvent: normalizedEvent,
      state: this.getState(),
    })
  }

  #appendContentDeltaMessage(sessionId, event) {
    if (event.streamKind !== 'assistant_text' || typeof event.text !== 'string') {
      return
    }

    const session = this.#state.sessions[sessionId]
    const context = this.#runContext.get(sessionId)
    if (!session || !context) {
      return
    }

    const message = this.#ensureAssistantMessage(session, context)
    if (event.isSnapshot) {
      if (!context.sawTextDelta || message.content.trim().length === 0) {
        message.content = event.text
      }
    } else {
      message.content += event.text
      context.sawTextDelta = true
    }
    message.status = 'streaming'
  }

  #appendProviderStderr(sessionId, data) {
    const session = this.#state.sessions[sessionId]
    if (!session || typeof data !== 'string' || data.length === 0) {
      return
    }

    const chunk = {
      id: randomUUID(),
      sessionId,
      ts: now(),
      stream: 'stderr',
      raw: data,
      text: data,
    }
    session.chunks.push(chunk)
    truncateChunks(session.chunks)
  }

  #appendLegacyProviderRuntimeEvents(sessionId, streamChunk, chunk) {
    const context = this.#runContext.get(sessionId)
    const events = legacyClaudeRuntimeEventsFromChunk({
      sessionId,
      turnId: context?.runId,
      ts: streamChunk.ts,
      chunk,
      sawTextDelta: context?.sawTextDelta === true,
    })

    for (const event of events) {
      this.#appendProviderRuntimeEvent(sessionId, event)
    }
  }

  #appendProviderRuntimeEvent(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    session.runtimeEvents ??= []
    session.runtimeEvents.push(event)
    this.#providerService.recordRuntimeEvent(sessionId, event)
    const removedEvents = truncateEvents(session.runtimeEvents)
    const removedDiffEvent = removedEvents.some(
      (removedEvent) => removedEvent.type === 'turn.diff.updated'
    )
    if (event.type === 'turn.diff.updated' || removedDiffEvent) {
      this.#pruneTurnCheckpointRefs(sessionId)
    }

    if (
      event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed'
    ) {
      this.#upsertRuntimeActivity(session, event.item)
      return
    }

    if (event.type === 'request.opened') {
      session.runtimeRequests ??= []
      const existing = session.runtimeRequests.find(
        (item) => item.id === event.request.id
      )
      if (existing) {
        Object.assign(existing, event.request)
      } else {
        session.runtimeRequests.push(event.request)
      }
      truncateActivities(session.runtimeRequests)
      return
    }

    if (event.type === 'request.resolved') {
      session.runtimeRequests ??= []
      const request = session.runtimeRequests.find(
        (item) => item.id === event.requestId
      )
      if (request) {
        request.status = event.status ?? 'resolved'
        request.resolvedAt = event.ts
      }
      return
    }

    if (event.type === 'user-input.requested') {
      session.runtimeUserInputRequests ??= []
      const existing = session.runtimeUserInputRequests.find(
        (item) => item.id === event.request.id
      )
      const nextRequest = {
        status: 'open',
        ...event.request,
      }
      if (existing) {
        Object.assign(existing, nextRequest)
      } else {
        session.runtimeUserInputRequests.push(nextRequest)
      }
      truncateActivities(session.runtimeUserInputRequests)
      return
    }

    if (event.type === 'user-input.answered') {
      session.runtimeUserInputRequests ??= []
      const request = session.runtimeUserInputRequests.find(
        (item) => item.id === event.requestId
      )
      if (request) {
        request.status = 'answered'
        request.answeredAt = event.ts
        request.answer = event.answer
      }
      return
    }

    if (event.type === 'user-input.resolved') {
      session.runtimeUserInputRequests ??= []
      const request = session.runtimeUserInputRequests.find(
        (item) => item.id === event.requestId
      )
      if (request) {
        request.status = event.status ?? 'resolved'
        request.answeredAt = event.ts
      }
      return
    }

    if (event.type === 'plan.updated') {
      session.runtimePlans ??= []
      const index = session.runtimePlans.findIndex(
        (plan) => plan.id === event.plan.id
      )
      if (index >= 0) {
        session.runtimePlans[index] = event.plan
      } else {
        session.runtimePlans.push(event.plan)
      }
      truncateActivities(session.runtimePlans)
    }
  }

  #cancelOpenRuntimeInteractions(sessionId, ts) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    const openRequests = (session.runtimeRequests ?? []).filter(
      (request) => request.status === 'open'
    )
    for (const request of openRequests) {
      this.#appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'request.resolved',
        sessionId,
        requestId: request.id,
        status: 'canceled',
      })
    }

    const openUserInputRequests = (session.runtimeUserInputRequests ?? []).filter(
      (request) => request.status === 'open'
    )
    for (const request of openUserInputRequests) {
      this.#appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'user-input.resolved',
        sessionId,
        requestId: request.id,
        status: 'canceled',
      })
    }
  }

  #appendTurnCompletedIfMissing(sessionId, ts) {
    const session = this.#state.sessions[sessionId]
    const turnId = this.#runContext.get(sessionId)?.runId
    if (!session || !turnId) {
      return
    }

    const alreadyCompleted = session.runtimeEvents?.some(
      (event) => event.type === 'turn.completed' && event.turnId === turnId
    )
    if (alreadyCompleted) {
      return
    }

    this.#appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts,
      type: 'turn.completed',
      sessionId,
      turnId,
    })
  }

  #upsertRuntimeActivity(session, item) {
    session.runtimeActivities ??= []
    const existing = session.runtimeActivities.find(
      (activity) => activity.id === item.id
    )
    const next = {
      ...(existing ?? {}),
      ...item,
      sessionId: session.sessionId,
      title: item.title ?? existing?.title ?? item.command ?? item.providerName ?? item.id,
      status:
        item.status ??
        existing?.status ??
        (item.completedAt ? 'completed' : 'running'),
      startedAt: existing?.startedAt ?? item.startedAt,
      updatedAt: item.updatedAt ?? item.completedAt ?? now(),
    }

    if (item.completedAt) {
      next.completedAt = item.completedAt
    }
    if (next.startedAt && next.completedAt && next.durationMs === undefined) {
      const start = Date.parse(next.startedAt)
      const end = Date.parse(next.completedAt)
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        next.durationMs = end - start
      }
    }
    if (typeof next.output === 'string') {
      next.sublines = resultSublines(next.output)
    }

    if (existing) {
      Object.assign(existing, next)
    } else {
      session.runtimeActivities.push(next)
      truncateActivities(session.runtimeActivities)
    }
  }

  #appendAssistantMessage(sessionId, chunk) {
    const session = this.#state.sessions[sessionId]
    const context = this.#runContext.get(sessionId)
    if (!session || !context || chunk.stream !== 'stdout') {
      return
    }

    if (
      chunk.event?.type === 'stream_event' &&
      chunk.event.event?.type === 'content_block_delta' &&
      typeof chunk.text === 'string'
    ) {
      const message = this.#ensureAssistantMessage(session, context)
      message.content += chunk.text
      message.status = 'streaming'
      context.sawTextDelta = true
      return
    }

    if (chunk.event?.type === 'assistant' && typeof chunk.text === 'string') {
      const message = this.#ensureAssistantMessage(session, context)
      if (!context.sawTextDelta || message.content.trim().length === 0) {
        message.content = chunk.text
      }
      message.status = 'streaming'
    }
  }

  #ensureAssistantMessage(session, context) {
    let message = context.assistantMessageId
      ? session.messages.find((item) => item.id === context.assistantMessageId)
      : undefined

    if (!message) {
      message = {
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'assistant',
        content: '',
        ts: now(),
        runId: context.runId,
        status: 'streaming',
      }
      session.messages.push(message)
      context.assistantMessageId = message.id
    }

    return message
  }

  #recordResult(sessionId, event) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    session.backendSessionId = event.session_id ?? session.backendSessionId
    session.providerSessionId = event.session_id ?? session.providerSessionId
    session.result = typeof event.result === 'string' ? event.result : undefined
    if (session.result) {
      const context = this.#runContext.get(sessionId)
      if (context) {
        const message = this.#ensureAssistantMessage(session, context)
        if (!context.sawTextDelta || message.content.trim().length === 0) {
          message.content = session.result
        }
      }
    }
    session.updatedAt = now()
    this.#touch()
  }

  #failSession(sessionId, error) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    session.status = 'failed'
    session.error = error
    session.finishedAt = now()
    session.updatedAt = session.finishedAt
    this.#markActiveAssistant(sessionId, 'failed')
    this.#updateNodeStatus(sessionId, 'failed')
    this.#recordTurnCheckpointDiff(sessionId, session.finishedAt)
    this.#appendTurnCompletedIfMissing(sessionId, session.finishedAt)
    this.#cancelOpenRuntimeInteractions(sessionId, session.finishedAt)
    this.#appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts: session.finishedAt,
      type: 'session.state',
      sessionId,
      status: 'failed',
    })
    this.#runContext.delete(sessionId)
    this.#touch()
    this.#emitRuntimeEvent({
      type: 'session.failed',
      sessionId,
      error,
      state: this.getState(),
    })
  }

  #markActiveAssistant(sessionId, status) {
    const session = this.#state.sessions[sessionId]
    const context = this.#runContext.get(sessionId)
    if (!session || !context?.assistantMessageId) {
      return
    }

    const message = session.messages.find(
      (item) => item.id === context.assistantMessageId
    )
    if (message) {
      message.status = status
    }
  }

  #updateMessageRunId(session, messageId, runId) {
    const message = session.messages.find((item) => item.id === messageId)
    if (message) {
      message.runId = runId
    }
  }

  #updateNodeStatus(sessionId, status) {
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    if (node) {
      node.status = status
    }
  }

  #ensureCluster(clusterId) {
    if (!this.#state.clusters[clusterId]) {
      this.#state.clusters[clusterId] = {
        clusterId,
        label: clusterId,
        nodeIds: [],
      }
    }

    return this.#state.clusters[clusterId]
  }

  #addNodeToCluster(sessionId, clusterId) {
    if (typeof clusterId !== 'string' || clusterId.trim().length === 0) {
      return
    }

    const normalizedClusterId = clusterId.trim()
    const cluster = this.#ensureCluster(normalizedClusterId)
    if (!cluster.nodeIds.includes(sessionId)) {
      cluster.nodeIds.push(sessionId)
    }
  }

  #removeNodeFromOtherClusters(sessionId, clusterId) {
    for (const [candidateId, cluster] of Object.entries(
      this.#state.clusters as JsonRecord
    )) {
      if (candidateId === clusterId) {
        continue
      }
      cluster.nodeIds = cluster.nodeIds.filter((nodeId) => nodeId !== sessionId)
    }
  }

  #masterClusterId(sessionId) {
    return Object.values(this.#state.clusters as JsonRecord).find(
      (cluster) => cluster.masterSessionId === sessionId
    )?.clusterId
  }

  #managedClusterId(sessionId) {
    return Object.values(this.#state.clusters as JsonRecord).find((cluster) =>
      cluster.nodeIds.includes(sessionId)
    )?.clusterId
  }

  #managingMasterSessionId(sessionId) {
    const clusterId = this.#managedClusterId(sessionId)
    if (!clusterId) {
      return undefined
    }

    const masterSessionId = this.#state.clusters[clusterId]?.masterSessionId
    return masterSessionId && this.#state.sessions[masterSessionId]
      ? masterSessionId
      : undefined
  }

  #isSessionFrozen(sessionId) {
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    const clusterId = this.#managedClusterId(sessionId)
    return node?.frozen === true || this.#state.clusters[clusterId]?.frozen === true
  }

  #reportSummary(payload) {
    if (payload.type === 'verdict') {
      if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
        return payload.summary.trim()
      }

      if (Array.isArray(payload.issues) && payload.issues.length > 0) {
        return payload.issues
          .map((issue) =>
            issue.file ? `${issue.message} (${issue.file})` : issue.message
          )
          .join('\n')
      }

      return payload.verdict
    }

    if (payload.type === 'relationship') {
      return payload.nature ?? payload.target
    }

    try {
      return boundedText(JSON.stringify(payload.payload), 500)
    } catch {
      return 'info'
    }
  }

  #syncSessionRoleAndCluster(sessionId) {
    const session = this.#state.sessions[sessionId]
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)
    if (!session || !node) {
      return
    }

    const masterClusterId = this.#masterClusterId(sessionId)
    if (masterClusterId) {
      session.role = 'master'
      node.role = 'master'
      node.clusterId = masterClusterId
      session.updatedAt = now()
      return
    }

    session.role = 'worker'
    node.role = 'worker'
    node.clusterId = this.#managedClusterId(sessionId)
    session.updatedAt = now()
  }

  #normalizeClusterNodeIds(nodeIds) {
    if (!Array.isArray(nodeIds)) {
      return []
    }

    const seen = new Set()
    const normalized = []
    for (const nodeId of nodeIds) {
      if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
        continue
      }

      const sessionId = nodeId.trim()
      if (seen.has(sessionId)) {
        continue
      }

      const session = this.#state.sessions[sessionId]
      if (!session || session.role === 'master') {
        continue
      }

      seen.add(sessionId)
      normalized.push(sessionId)
    }

    return normalized
  }

  #assignMaster(clusterId, sessionId) {
    const cluster = this.#ensureCluster(clusterId)
    const session = this.#state.sessions[sessionId]
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)

    if (!session || !node) {
      throw new Error(`Unknown master session: ${sessionId}`)
    }

    const staleMasterIds = new Set()
    if (cluster.masterSessionId && cluster.masterSessionId !== sessionId) {
      staleMasterIds.add(cluster.masterSessionId)
    }

    for (const [candidateClusterId, candidateCluster] of Object.entries(
      this.#state.clusters as JsonRecord
    )) {
      candidateCluster.nodeIds = candidateCluster.nodeIds.filter(
        (nodeId) => nodeId !== sessionId
      )

      if (
        candidateClusterId !== clusterId &&
        candidateCluster.masterSessionId === sessionId
      ) {
        delete candidateCluster.masterSessionId
      }
    }

    for (const candidateNode of this.#state.nodes) {
      if (
        candidateNode.clusterId === clusterId &&
        candidateNode.role === 'master' &&
        candidateNode.sessionId !== sessionId
      ) {
        staleMasterIds.add(candidateNode.sessionId)
      }
    }

    cluster.masterSessionId = sessionId
    cluster.nodeIds = cluster.nodeIds.filter((nodeId) => nodeId !== sessionId)
    session.role = 'master'
    session.updatedAt = now()
    node.role = 'master'
    node.clusterId = clusterId

    for (const staleMasterId of staleMasterIds) {
      this.#syncSessionRoleAndCluster(staleMasterId)
    }
  }

  #normalizeLoopPolicy(policy) {
    if (!isObject(policy)) {
      throw new Error('LoopPolicy must be an object')
    }

    if (policy.onStop !== 'freeze') {
      throw new Error('LoopPolicy onStop must be freeze')
    }

    let until
    const verdict = policy.until?.whenReport?.verdict
    if (typeof verdict === 'string' && verdict.trim().length > 0) {
      until = { whenReport: { verdict: verdict.trim() } }
    }

    let maxIterations
    if (policy.maxIterations !== undefined) {
      const value = Number(policy.maxIterations)
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error('LoopPolicy maxIterations must be an integer from 1 to 100')
      }
      maxIterations = value
    }

    return {
      ...(until ? { until } : {}),
      onStop: 'freeze',
      ...(maxIterations ? { maxIterations } : {}),
    }
  }

  #normalizeLoopState(loopState) {
    if (!isObject(loopState)) {
      return undefined
    }

    return {
      status: validLoopStatuses.has(loopState.status)
        ? loopState.status
        : 'stopped',
      iterations: Number.isInteger(loopState.iterations)
        ? Math.max(0, loopState.iterations)
        : 0,
      coderSessionId: nonEmptyString(loopState.coderSessionId)
        ? loopState.coderSessionId
        : undefined,
      reviewerSessionId: nonEmptyString(loopState.reviewerSessionId)
        ? loopState.reviewerSessionId
        : undefined,
      lastEvent: isObject(loopState.lastEvent)
        ? this.#serializeLoopEvent(loopState.lastEvent)
        : undefined,
      lastProcessedEventKey: nonEmptyString(loopState.lastProcessedEventKey)
        ? loopState.lastProcessedEventKey
        : undefined,
      reason: nonEmptyString(loopState.reason) ? loopState.reason : undefined,
      startedAt: nonEmptyString(loopState.startedAt)
        ? loopState.startedAt
        : undefined,
      stoppedAt: nonEmptyString(loopState.stoppedAt)
        ? loopState.stoppedAt
        : undefined,
    }
  }

  #defaultMasterPrompt(clusterId) {
    const cluster = this.#state.clusters[clusterId]
    const policy = cluster.loopPolicy
    const until = policy?.until?.whenReport?.verdict
      ? `until a report verdict is "${policy.until.whenReport.verdict}"`
      : 'until the authored stop condition is met'
    const maxIterations = policy?.maxIterations
      ? `Respect maxIterations=${policy.maxIterations}.`
      : 'Ask before continuing if the loop looks unbounded.'

    return [
      `You are the Orrery master session for cluster ${cluster.label}.`,
      'Read the graph as a blackboard and coordinate only the sessions in your cluster scope.',
      `The current LoopPolicy is: ${until}; onStop=freeze. ${maxIterations}`,
      'Do not execute an autonomous loop yet. Discuss the plan with the user and use Orrery membrane tools when asked to create, resume, or report agent work.',
    ].join('\n')
  }

  #recoverRunningLoops() {
    for (const cluster of Object.values(this.#state.clusters as JsonRecord)) {
      if (cluster.loopState?.status === 'running' && !cluster.frozen) {
        this.#queueLoopWakeup(cluster.clusterId, {
          type: 'runtime.recovered',
          ts: now(),
        })
      }
    }
  }

  #emitRuntimeEvent(event) {
    this.#broadcast(event)
    this.#queueLoopWakeupsForRuntimeEvent(event)
  }

  #queueLoopWakeupsForRuntimeEvent(event) {
    const clusterIds = this.#clusterIdsForRuntimeEvent(event)
    for (const clusterId of clusterIds) {
      this.#queueLoopWakeup(clusterId, this.#loopEventFromRuntimeEvent(event))
    }
  }

  #clusterIdsForRuntimeEvent(event) {
    if (
      event.type === 'session.finished' ||
      event.type === 'session.failed' ||
      event.type === 'session.killed'
    ) {
      const clusterId =
        this.#managedClusterId(event.sessionId) ??
        (event.type === 'session.failed' || event.type === 'session.killed'
          ? this.#masterClusterId(event.sessionId)
          : undefined)
      return clusterId ? [clusterId] : []
    }

    if (event.type === 'report.received') {
      const clusterId = this.#managedClusterId(event.from)
      return clusterId ? [clusterId] : []
    }

    return []
  }

  #loopEventFromRuntimeEvent(event) {
    if (event.type === 'report.received') {
      return {
        type: event.type,
        ts: event.report.envelope.ts,
        from: event.from,
        reportId: event.report.id,
        report: event.report,
      }
    }

    return {
      type: event.type,
      ts: now(),
      sessionId: event.sessionId,
      error: event.error,
    }
  }

  #queueLoopWakeup(clusterId, event) {
    const previous = this.#loopTasks.get(clusterId) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() => this.#runLoopWakeup(clusterId, event))
      .catch((error) => this.#recordLoopError(clusterId, event, error))

    this.#loopTasks.set(clusterId, task)
    void task.finally(() => {
      if (this.#loopTasks.get(clusterId) === task) {
        this.#loopTasks.delete(clusterId)
      }
    })
  }

  async #runLoopWakeup(clusterId, event) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }

    const loopState = this.#ensureLoopState(cluster)
    if (loopState.status !== 'running') {
      return
    }

    const eventKey = this.#loopEventKey(event)
    if (eventKey && loopState.lastProcessedEventKey === eventKey) {
      return
    }

    loopState.lastEvent = this.#serializeLoopEvent(event)
    loopState.lastProcessedEventKey = eventKey
    loopState.reason = `Woke on ${event.type}.`
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    if (cluster.frozen) {
      this.#stopLoop(clusterId, 'Cluster is frozen; loop stopped.', {
        event,
        broadcast: true,
      })
      return
    }

    if (!cluster.loopPolicy) {
      this.#stopLoop(clusterId, 'Cluster has no LoopPolicy.', {
        event,
        broadcast: true,
      })
      return
    }

    const masterSessionId = cluster.masterSessionId
    const masterSession = masterSessionId
      ? this.#state.sessions[masterSessionId]
      : undefined
    if (!masterSessionId || !masterSession) {
      this.#stopLoop(clusterId, 'Cluster has no master session.', {
        event,
        broadcast: true,
      })
      return
    }

    if (
      masterSession.status === 'killed' ||
      masterSession.status === 'failed' ||
      this.#isSessionFrozen(masterSessionId)
    ) {
      this.#stopLoop(
        clusterId,
        `Master session cannot continue: ${masterSession.status}.`,
        { event, broadcast: true }
      )
      return
    }

    if (event.type === 'session.failed' || event.type === 'session.killed') {
      const killed = event.type === 'session.killed'
      this.#stopLoop(
        clusterId,
        killed
          ? 'Managed session was killed; loop stopped.'
          : event.error
            ? `Managed session failed: ${event.error}`
            : 'Managed session failed.',
        { event, broadcast: true }
      )
      return
    }

    if (event.type === 'report.received') {
      await this.#handleLoopReport(clusterId, event.report)
      return
    }

    if (
      event.type === 'session.finished' ||
      event.type === 'loop.started' ||
      event.type === 'runtime.recovered'
    ) {
      await this.#handleLoopSessionFinished(clusterId, event.sessionId)
    }
  }

  #recordLoopError(clusterId, event, error) {
    const message = error instanceof Error ? error.message : String(error)
    this.#stopLoop(clusterId, `Loop error: ${message}`, {
      event,
      broadcast: true,
    })
  }

  async #handleLoopSessionFinished(clusterId, finishedSessionId) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster || cluster.loopState?.status !== 'running') {
      return
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      this.#stopLoop(clusterId, 'Cluster has no coder session.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    const reviewerSessionId = this.#loopReviewerSessionId(cluster, coderSessionId)
    if (finishedSessionId && reviewerSessionId === finishedSessionId) {
      this.#setLoopReason(
        clusterId,
        'Reviewer finished; waiting for typed report.'
      )
      return
    }

    if (finishedSessionId && finishedSessionId !== coderSessionId) {
      this.#setLoopReason(clusterId, 'Finished session is outside the hero loop.')
      return
    }

    const coder = this.#state.sessions[coderSessionId]
    if (!coder) {
      this.#stopLoop(clusterId, 'Coder session is missing.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    if (coder.status === 'running' || coder.status === 'pending') {
      this.#setLoopReason(clusterId, 'Waiting for coder to finish.')
      return
    }

    if (
      coder.status === 'failed' ||
      coder.status === 'killed' ||
      this.#isSessionFrozen(coderSessionId)
    ) {
      this.#stopLoop(clusterId, 'Coder cannot be resumed by the loop.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    if (!reviewerSessionId) {
      await this.#createLoopReviewer(clusterId, coderSessionId)
      return
    }

    await this.#resumeLoopReviewer(clusterId, coderSessionId, reviewerSessionId)
  }

  async #handleLoopReport(clusterId, report) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster || cluster.loopState?.status !== 'running') {
      return
    }

    if (!report || report.payload?.type !== 'verdict') {
      this.#setLoopReason(clusterId, 'Report is not a verdict; loop is waiting.')
      return
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      this.#stopLoop(clusterId, 'Cluster has no coder session.', {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      return
    }

    if (report.from === coderSessionId) {
      this.#setLoopReason(clusterId, 'Coder report ignored for review loop.')
      return
    }

    cluster.loopState.reviewerSessionId =
      cluster.loopState.reviewerSessionId ?? report.from

    const stopVerdict = cluster.loopPolicy?.until?.whenReport?.verdict
    if (stopVerdict && report.payload.verdict === stopVerdict) {
      const reason = `Review verdict ${stopVerdict}; freezing loop scope.`
      this.#stopLoop(clusterId, reason, {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      this.#applyFreeze({
        targetId: clusterId,
        source: cluster.masterSessionId,
        reason,
        masterReason: reason,
      })
      return
    }

    const maxIterations = cluster.loopPolicy?.maxIterations
    const iterations = cluster.loopState.iterations ?? 0
    if (maxIterations && iterations >= maxIterations) {
      const reason = `maxIterations=${maxIterations} reached after verdict ${report.payload.verdict}.`
      this.#stopLoop(clusterId, reason, {
        event: cluster.loopState.lastEvent,
        broadcast: true,
      })
      this.#applyFreeze({
        targetId: clusterId,
        source: cluster.masterSessionId,
        reason,
        masterReason: reason,
      })
      return
    }

    await this.#resumeCoderFromReport(clusterId, coderSessionId, report)
  }

  async #createLoopReviewer(clusterId, coderSessionId) {
    const cluster = this.#state.clusters[clusterId]
    const masterSessionId = cluster?.masterSessionId
    if (!cluster || !masterSessionId) {
      return
    }

    const coder = this.#state.sessions[coderSessionId]
    const reason = `Coder ${coder?.label ?? coderSessionId} finished; create reviewer.`
    const result = await this.#membraneCreateSession(masterSessionId, {
      agent: 'claude-code',
      label: 'Reviewer',
      cluster: clusterId,
      prompt: this.#reviewerCreatePrompt(),
      context: this.#gitDiffForSession(coderSessionId),
      masterReason: reason,
    })

    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      reviewerSessionId: result.sessionId,
      reason,
    }
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  async #resumeLoopReviewer(clusterId, coderSessionId, reviewerSessionId) {
    const cluster = this.#state.clusters[clusterId]
    const masterSessionId = cluster?.masterSessionId
    const reviewer = this.#state.sessions[reviewerSessionId]
    if (!cluster || !masterSessionId || !reviewer) {
      return
    }

    if (reviewer.status === 'running' || reviewer.status === 'pending') {
      this.#setLoopReason(clusterId, 'Waiting for reviewer to finish.')
      return
    }

    if (
      reviewer.status === 'failed' ||
      reviewer.status === 'killed' ||
      this.#isSessionFrozen(reviewerSessionId)
    ) {
      this.#stopLoop(clusterId, 'Reviewer cannot be resumed by the loop.', {
        event: cluster.loopState?.lastEvent,
        broadcast: true,
      })
      return
    }

    const reason = `Coder finished fixes; resume reviewer ${reviewer.label}.`
    await this.#membraneResumeSession(masterSessionId, {
      sessionId: reviewerSessionId,
      message: this.#reviewerResumeMessage(),
      context: this.#gitDiffForSession(coderSessionId),
      masterReason: reason,
    })
    this.#setLoopReason(clusterId, reason)
  }

  async #resumeCoderFromReport(clusterId, coderSessionId, report) {
    const cluster = this.#state.clusters[clusterId]
    const masterSessionId = cluster?.masterSessionId
    const coder = this.#state.sessions[coderSessionId]
    if (!cluster || !masterSessionId || !coder) {
      return
    }

    if (coder.status === 'running' || coder.status === 'pending') {
      this.#setLoopReason(clusterId, 'Coder is already running; waiting.')
      return
    }

    if (
      coder.status === 'failed' ||
      coder.status === 'killed' ||
      this.#isSessionFrozen(coderSessionId)
    ) {
      this.#stopLoop(clusterId, 'Coder cannot be resumed by the loop.', {
        event: cluster.loopState?.lastEvent,
        broadcast: true,
      })
      return
    }

    const nextIteration = (cluster.loopState?.iterations ?? 0) + 1
    const reason = `Reviewer reported ${report.payload.verdict}; resume coder for iteration ${nextIteration}.`
    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      iterations: nextIteration,
      reason,
    }
    this.#touch()

    await this.#membraneResumeSession(masterSessionId, {
      sessionId: coderSessionId,
      message: this.#coderIssueMessage(report, nextIteration),
      masterReason: reason,
    })
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  #reviewerCreatePrompt() {
    return [
      'Review the latest diff for this Orrery hero review loop.',
      'Do not edit files.',
      'When finished, call mcp__orrery_membrane__report exactly once with type "verdict".',
      'Use verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain.',
    ].join('\n')
  }

  #reviewerResumeMessage() {
    return [
      'The coder has finished another turn.',
      'Review the latest diff again, preserving context from earlier findings.',
      'Call mcp__orrery_membrane__report exactly once with verdict "issues" or "clean".',
    ].join('\n')
  }

  #coderIssueMessage(report, iteration) {
    const issues = Array.isArray(report.payload.issues)
      ? report.payload.issues
      : []
    const issueText =
      issues.length > 0
        ? issues
            .map((issue) => {
              const location = [
                issue.file,
                Number.isFinite(issue.line) ? issue.line : undefined,
              ]
                .filter(Boolean)
                .join(':')
              return location
                ? `- ${issue.message} (${location})`
                : `- ${issue.message}`
            })
            .join('\n')
        : `- ${report.payload.summary ?? report.payload.verdict}`

    return [
      `Reviewer found issues for loop iteration ${iteration}.`,
      'Please fix them, then stop so the master loop can run the reviewer again.',
      '',
      issueText,
    ].join('\n')
  }

  #completedTurnCount(session) {
    return (session.runtimeEvents ?? []).filter(
      (event) => event.type === 'turn.completed'
    ).length
  }

  #captureTurnCheckpoint({ sessionId, turnId, turnCount, stage }) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    const cwd = validateRunnableCwd(session.cwd)
    let repoRoot
    try {
      gitOutput(cwd, ['rev-parse', '--is-inside-work-tree'])
      repoRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Project folder is not a Git work tree: ${cwd}. ${message}`)
    }

    const ref = checkpointRef({ sessionId, turnCount, turnId, stage })
    const tempIndex = path.join(
      os.tmpdir(),
      `orrery-checkpoint-${process.pid}-${randomUUID()}.index`
    )
    const env = gitCheckpointEnv(tempIndex)

    try {
      const hasHead = hasGitHead(cwd, env)
      const indexTree = hasHead ? gitOutput(cwd, ['write-tree']) : emptyGitTree
      gitOutput(cwd, ['read-tree', indexTree], { env })
      gitOutput(cwd, ['add', '-A', '--', '.'], { env })
      const tree = gitOutput(cwd, ['write-tree'], { env })
      const commitArgs = ['commit-tree', tree]
      if (hasHead) {
        commitArgs.push('-p', gitOutput(cwd, ['rev-parse', 'HEAD']))
      }
      const commit = gitOutput(cwd, commitArgs, { env })
      gitOutput(cwd, ['update-ref', ref, commit])

      return {
        ref,
        commit,
        cwd,
        repoRoot,
        turnCount,
        stage,
      }
    } finally {
      try {
        fs.rmSync(tempIndex, { force: true })
        fs.rmSync(`${tempIndex}.lock`, { force: true })
      } catch {
        // Best-effort cleanup; the temp index is outside the user's repo.
      }
    }
  }

  #diffSummaryForCheckpointRange({
    sessionId,
    turnId,
    cwd,
    repoRoot,
    fromCheckpointRef,
    toCheckpointRef,
    fromTurnCount,
    toTurnCount,
    ignoreWhitespace = false,
  }) {
    const diffArgs = [
      'diff',
      '--patch',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--relative',
    ]

    if (ignoreWhitespace === true) {
      diffArgs.push('--ignore-all-space')
    }

    const rawPatch = gitOutput(
      cwd,
      [...diffArgs, fromCheckpointRef, toCheckpointRef, '--', '.'],
      { maxBuffer: gitDiffMaxBuffer }
    )
    const files = parseDiffFilesFromPatch(rawPatch)

    return {
      sessionId,
      turnId,
      cwd,
      repoRoot,
      generatedAt: now(),
      range: {
        kind: 'checkpoint',
        fromCheckpointRef,
        toCheckpointRef,
        fromTurnCount,
        toTurnCount,
      },
      files,
      totals: totalsForDiffFiles(files),
      patch: boundedText(rawPatch, uiPatchMaxLength),
      truncated: rawPatch.length > uiPatchMaxLength,
    }
  }

  #recordTurnCheckpointDiff(sessionId, ts) {
    const session = this.#state.sessions[sessionId]
    const context = this.#runContext.get(sessionId)
    if (!session || !context || context.turnDiffRecorded === true) {
      return
    }

    context.turnDiffRecorded = true
    const turnId = context.runId
    const fromTurnCount = Number.isInteger(context.turnCheckpoint?.fromTurnCount)
      ? context.turnCheckpoint.fromTurnCount
      : this.#completedTurnCount(session)
    const toTurnCount = fromTurnCount + 1

    if (context.turnCheckpoint?.error || !context.turnCheckpoint?.ref) {
      this.#appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'turn.diff.updated',
        sessionId,
        turnId,
        diff: {
          sessionId,
          turnId,
          cwd: session.cwd,
          generatedAt: ts,
          files: [],
          totals: { files: 0, additions: 0, deletions: 0 },
          error:
            context.turnCheckpoint?.error ??
            'No baseline checkpoint was captured for this turn.',
        },
      })
      return
    }

    try {
      const after = this.#captureTurnCheckpoint({
        sessionId,
        turnId,
        turnCount: toTurnCount,
        stage: 'after',
      })
      const diff = this.#diffSummaryForCheckpointRange({
        sessionId,
        turnId,
        cwd: after.cwd,
        repoRoot: after.repoRoot,
        fromCheckpointRef: context.turnCheckpoint.ref,
        toCheckpointRef: after.ref,
        fromTurnCount,
        toTurnCount,
      })

      const { patch: _patch, ...summary } = diff
      this.#appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'turn.diff.updated',
        sessionId,
        turnId,
        diff: summary,
      })
    } catch (error) {
      this.#appendProviderRuntimeEvent(sessionId, {
        id: randomUUID(),
        ts,
        type: 'turn.diff.updated',
        sessionId,
        turnId,
        diff: {
          sessionId,
          turnId,
          cwd: session.cwd,
          generatedAt: ts,
          files: [],
          totals: { files: 0, additions: 0, deletions: 0 },
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  #pruneTurnCheckpointRefs(sessionId) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    let cwd
    try {
      cwd = validateRunnableCwd(session.cwd)
    } catch {
      return
    }

    const keepRefs = new Set()
    const activeContext = this.#runContext.get(sessionId)
    if (nonEmptyString(activeContext?.turnCheckpoint?.ref)) {
      keepRefs.add(activeContext.turnCheckpoint.ref)
    }

    for (const event of session.runtimeEvents ?? []) {
      if (event.type !== 'turn.diff.updated' || !isObject(event.diff?.range)) {
        continue
      }
      const { fromCheckpointRef, toCheckpointRef } = event.diff.range
      if (nonEmptyString(fromCheckpointRef)) {
        keepRefs.add(fromCheckpointRef)
      }
      if (nonEmptyString(toCheckpointRef)) {
        keepRefs.add(toCheckpointRef)
      }
    }

    let refs
    try {
      refs = gitOutput(cwd, [
        'for-each-ref',
        '--format=%(refname)',
        checkpointSessionRefRoot(sessionId),
      ])
        .split('\n')
        .map((ref) => ref.trim())
        .filter(Boolean)
    } catch {
      return
    }

    for (const ref of refs) {
      if (keepRefs.has(ref)) {
        continue
      }
      try {
        gitOutput(cwd, ['update-ref', '-d', ref])
      } catch {
        // Stale checkpoint cleanup is best-effort; the persisted diff event remains authoritative.
      }
    }
  }

  #gitDiffForSession(sessionId) {
    try {
      const result = this.#workingTreeDiffForSession(sessionId)
      const stat = result.files
        .map((file) => `${file.path} | +${file.additions} -${file.deletions}`)
        .join('\n')
      const content = [
        `Project cwd: ${result.cwd}`,
        stat ? `Diff stat:\n${stat}` : undefined,
        result.patch ? `Patch:\n${result.patch}` : 'No current git diff.',
      ].filter(Boolean)

      return boundedText(content.join('\n\n'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cwd = this.#state.sessions[sessionId]?.cwd ?? process.cwd()
      return `Unable to read git diff for ${cwd}: ${message}`
    }
  }

  #checkpointDiffForSession(sessionId, options: JsonRecord = {}) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    const turnId = nonEmptyString(options.turnId) ? options.turnId.trim() : undefined
    if (!turnId) {
      throw new Error('Turn id is required for checkpoint diff.')
    }

    const diffEvent = [...(session.runtimeEvents ?? [])]
      .reverse()
      .find(
        (event) =>
          event.type === 'turn.diff.updated' &&
          event.turnId === turnId &&
          isObject(event.diff)
      )
    if (!diffEvent) {
      throw new Error(`No checkpoint diff found for turn: ${turnId}`)
    }
    if (nonEmptyString(diffEvent.diff.error)) {
      throw new Error(diffEvent.diff.error)
    }
    if (!isObject(diffEvent.diff.range)) {
      throw new Error(`Checkpoint diff range is missing for turn: ${turnId}`)
    }

    const cwd = validateRunnableCwd(diffEvent.diff.cwd ?? session.cwd)
    const range = diffEvent.diff.range
    const result = this.#diffSummaryForCheckpointRange({
      sessionId,
      turnId,
      cwd,
      repoRoot: diffEvent.diff.repoRoot ?? gitRepoRoot(cwd) ?? cwd,
      fromCheckpointRef: range.fromCheckpointRef,
      toCheckpointRef: range.toCheckpointRef,
      fromTurnCount: range.fromTurnCount,
      toTurnCount: range.toTurnCount,
      ignoreWhitespace: options.ignoreWhitespace === true,
    })

    return {
      sessionId,
      cwd,
      repoRoot: result.repoRoot,
      generatedAt: result.generatedAt,
      range: result.range,
      files: result.files,
      totals: result.totals,
      statusEntries: [],
      patch: result.patch,
      truncated: result.truncated,
    }
  }

  #workingTreeDiffForSession(sessionId, options: JsonRecord = {}) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    const cwd = validateRunnableCwd(session.cwd)
    let repoRoot
    try {
      gitOutput(cwd, ['rev-parse', '--is-inside-work-tree'])
      repoRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Project folder is not a Git work tree: ${cwd}. ${message}`)
    }

    const tempIndex = path.join(
      os.tmpdir(),
      `orrery-diff-${process.pid}-${randomUUID()}.index`
    )
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tempIndex,
    }

    try {
      const hasHead = hasGitHead(cwd, env)
      const baseTree = hasHead ? 'HEAD' : emptyGitTree
      const indexTree = gitOutput(cwd, ['write-tree'])
      gitOutput(cwd, ['read-tree', indexTree], { env })
      gitOutput(cwd, ['add', '-A', '--', '.'], { env })
      const workingTree = gitOutput(cwd, ['write-tree'], { env })
      const diffArgs = [
        'diff',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--relative',
      ]

      if (options.ignoreWhitespace === true) {
        diffArgs.push('--ignore-all-space')
      }

      const stagedPatch = gitOutput(cwd, [...diffArgs, baseTree, indexTree, '--', '.'], {
        maxBuffer: gitDiffMaxBuffer,
      })
      const unstagedPatch = gitOutput(
        cwd,
        [...diffArgs, indexTree, workingTree, '--', '.'],
        { maxBuffer: gitDiffMaxBuffer }
      )
      const rawPatch = [stagedPatch, unstagedPatch]
        .filter((section) => section.trim().length > 0)
        .join('\n\n')
      const files = parseDiffFilesFromPatch(rawPatch)
      const patch = boundedText(rawPatch, uiPatchMaxLength)
      const statusOutput = gitOutput(
        cwd,
        ['status', '--short', '--untracked-files=all', '--', '.'],
        { maxBuffer: 4 * 1024 * 1024 }
      )

      return {
        sessionId,
        cwd,
        repoRoot,
        generatedAt: now(),
        range: {
          kind: 'working-tree',
          base: 'HEAD',
          target: 'workspace',
        },
        files,
        totals: totalsForDiffFiles(files),
        statusEntries: statusOutput
          ? statusOutput.split('\n').filter((line) => line.trim().length > 0)
          : [],
        patch,
        truncated: rawPatch.length > uiPatchMaxLength,
      }
    } finally {
      try {
        fs.rmSync(tempIndex, { force: true })
        fs.rmSync(`${tempIndex}.lock`, { force: true })
      } catch {
        // Best-effort cleanup; the temp index is outside the user's repo.
      }
    }
  }

  #loopCoderSessionId(cluster) {
    const existing = cluster.loopState?.coderSessionId
    if (existing && cluster.nodeIds.includes(existing) && this.#state.sessions[existing]) {
      return existing
    }

    return cluster.nodeIds.find((sessionId) => {
      const session = this.#state.sessions[sessionId]
      return session && session.role !== 'master'
    })
  }

  #loopReviewerSessionId(cluster, coderSessionId) {
    const existing = cluster.loopState?.reviewerSessionId
    if (
      existing &&
      existing !== coderSessionId &&
      cluster.nodeIds.includes(existing) &&
      this.#state.sessions[existing]
    ) {
      return existing
    }

    return cluster.nodeIds.find((sessionId) => {
      if (sessionId === coderSessionId) {
        return false
      }

      const session = this.#state.sessions[sessionId]
      return session && session.role !== 'master'
    })
  }

  #ensureLoopState(cluster) {
    const loopState = cluster.loopState ?? {}
    const iterations = Number.isInteger(loopState.iterations)
      ? Math.max(0, loopState.iterations)
      : 0
    cluster.loopState = {
      status: loopState.status === 'running' ? 'running' : 'stopped',
      iterations,
      coderSessionId: nonEmptyString(loopState.coderSessionId)
        ? loopState.coderSessionId
        : undefined,
      reviewerSessionId: nonEmptyString(loopState.reviewerSessionId)
        ? loopState.reviewerSessionId
        : undefined,
      lastEvent: isObject(loopState.lastEvent)
        ? this.#serializeLoopEvent(loopState.lastEvent)
        : undefined,
      lastProcessedEventKey: nonEmptyString(loopState.lastProcessedEventKey)
        ? loopState.lastProcessedEventKey
        : undefined,
      reason: nonEmptyString(loopState.reason) ? loopState.reason : undefined,
      startedAt: nonEmptyString(loopState.startedAt)
        ? loopState.startedAt
        : undefined,
      stoppedAt: nonEmptyString(loopState.stoppedAt)
        ? loopState.stoppedAt
        : undefined,
    }

    return cluster.loopState
  }

  #setLoopReason(clusterId, reason) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }

    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      reason,
    }
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  #stopLoop(clusterId, reason, { event, broadcast = false }: JsonRecord = {}) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }

    const ts = now()
    cluster.loopState = {
      ...this.#ensureLoopState(cluster),
      status: 'stopped',
      reason,
      stoppedAt: ts,
      lastEvent: this.#serializeLoopEvent(event ?? { type: 'loop.stopped', ts }),
    }
    this.#touch()

    if (broadcast) {
      this.#broadcast({
        type: 'loop.stopped',
        clusterId,
        reason,
        state: this.getState(),
      })
    }
  }

  #applyFreeze({ targetId, reason, source, masterReason }: JsonRecord) {
    const cluster = this.#state.clusters[targetId]
    const session = this.#state.sessions[targetId]
    const sourceSessionId =
      typeof source === 'string' && this.#state.sessions[source] ? source : undefined
    const finalReason = reason ?? masterReason ?? 'Frozen.'

    let targetSessionIds = []
    if (cluster) {
      cluster.frozen = true
      cluster.freezeReason = finalReason
      this.#stopLoop(cluster.clusterId, finalReason, {
        event: { type: 'freeze.applied', targetId, ts: now() },
      })
      targetSessionIds = [...cluster.nodeIds]
    } else if (session) {
      targetSessionIds = [session.sessionId]
      const clusterId =
        this.#managedClusterId(session.sessionId) ??
        this.#masterClusterId(session.sessionId)
      if (clusterId) {
        this.#stopLoop(clusterId, finalReason, {
          event: { type: 'freeze.applied', targetId, ts: now() },
        })
      }
    } else {
      throw new Error(`Unknown freeze target: ${targetId}`)
    }

    const envelope = sourceSessionId ? this.#createEnvelope(sourceSessionId) : undefined
    for (const targetSessionId of targetSessionIds) {
      const node = this.#state.nodes.find(
        (item) => item.sessionId === targetSessionId
      )
      if (node) {
        node.frozen = true
        node.freezeReason = finalReason
        node.masterReason =
          typeof masterReason === 'string' && masterReason.trim().length > 0
            ? masterReason.trim()
            : node.masterReason
      }

      if (envelope && this.#state.sessions[targetSessionId]) {
        this.#addEdge({
          source: sourceSessionId,
          target: targetSessionId,
          kind: 'freeze',
          envelope: { ...envelope, callId: randomUUID() },
          label: 'freeze',
          frozen: true,
          freezeReason: finalReason,
          masterReason,
        })
      }
    }

    this.#touch()
    this.#broadcast({
      type: 'freeze.applied',
      targetId,
      reason: finalReason,
      state: this.getState(),
    })
    return { ok: true, state: this.getState() }
  }

  #loopEventKey(event) {
    if (!event) {
      return undefined
    }

    if (event.type === 'report.received' && event.reportId) {
      return `${event.type}:${event.reportId}`
    }

    if (event.sessionId) {
      const session = this.#state.sessions[event.sessionId]
      return `${event.type}:${event.sessionId}:${
        session?.finishedAt ?? session?.updatedAt ?? event.ts ?? ''
      }`
    }

    return event.ts ? `${event.type}:${event.ts}` : undefined
  }

  #serializeLoopEvent(event) {
    if (!event || typeof event !== 'object') {
      return undefined
    }

    return {
      type: typeof event.type === 'string' ? event.type : 'unknown',
      ts: nonEmptyString(event.ts) ? event.ts : now(),
      sessionId: nonEmptyString(event.sessionId) ? event.sessionId : undefined,
      from: nonEmptyString(event.from) ? event.from : undefined,
      reportId: nonEmptyString(event.reportId) ? event.reportId : undefined,
      targetId: nonEmptyString(event.targetId) ? event.targetId : undefined,
      error: nonEmptyString(event.error) ? event.error : undefined,
    }
  }

  async #membraneCreateSession(source, input: JsonRecord = {}) {
    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : undefined
    if (!prompt) {
      throw new Error('create_session prompt is required')
    }

    if (input.agent && input.agent !== 'claude-code') {
      throw new Error(`Unsupported agent for P2 membrane: ${input.agent}`)
    }

    const sourceNode = this.#state.nodes.find((node) => node.sessionId === source)
    const sourceSession = this.#state.sessions[source]
    const cluster =
      typeof input.cluster === 'string' && input.cluster.trim().length > 0
        ? input.cluster.trim()
        : sourceNode?.clusterId
    const envelope = this.#createEnvelope(source)
    const result = await this.createSession({
      agent: 'claude-code',
      prompt,
      cwd: sourceSession?.cwd,
      context: input.context,
      cluster,
      label: input.label,
    })
    this.#addEdge({
      source,
      target: result.sessionId,
      kind: 'create-session',
      envelope,
      label: input.label ? `create: ${input.label}` : 'create_session',
      masterReason: this.#masterReasonFromInput(source, input),
    })
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { sessionId: result.sessionId }
  }

  async #membraneResumeSession(source, input: JsonRecord = {}) {
    const target = input.sessionId
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new Error('resume_session sessionId is required')
    }

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('resume_session message is required')
    }

    const envelope = this.#createEnvelope(source)
    await this.resumeSession({
      sessionId: target,
      message,
      context: input.context,
    })

    this.#addEdge({
      source,
      target,
      kind: 'resume-session',
      envelope,
      label: 'resume_session',
      masterReason: this.#masterReasonFromInput(source, input),
    })
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })

    return { ok: true }
  }

  #membraneReport(source, input: JsonRecord = {}) {
    const payload = this.#normalizeReportPayload(input)
    const envelope = this.#createEnvelope(source)
    const report = {
      id: randomUUID(),
      from: source,
      envelope,
      payload,
    }

    this.#state.reports.push(report)
    if (this.#state.reports.length > 250) {
      this.#state.reports.splice(0, this.#state.reports.length - 250)
    }

    if (
      payload.type === 'relationship' &&
      typeof payload.sessionRef === 'string' &&
      this.#state.sessions[payload.sessionRef]
    ) {
      this.#addEdge({
        source,
        target: payload.sessionRef,
        kind: 'report',
        envelope,
        label: payload.nature ?? 'relationship',
        reportId: report.id,
        summary: payload.target,
      })
    }

    const masterSessionId = this.#managingMasterSessionId(source)
    if (masterSessionId && masterSessionId !== source) {
      this.#addEdge({
        source,
        target: masterSessionId,
        kind: 'report',
        envelope,
        label: payload.type,
        reportId: report.id,
        verdict: payload.type === 'verdict' ? payload.verdict : undefined,
        issueCount:
          payload.type === 'verdict' ? (payload.issues?.length ?? 0) : undefined,
        summary: this.#reportSummary(payload),
      })
    }

    this.#touch()
    this.#emitRuntimeEvent({
      type: 'report.received',
      from: source,
      report,
      state: this.getState(),
    })
    return { ok: true }
  }

  #createEnvelope(source) {
    return {
      callId: randomUUID(),
      source,
      ts: now(),
    }
  }

  #addEdge({
    source,
    target,
    kind,
    envelope,
    label,
    reportId,
    verdict,
    issueCount,
    summary,
    masterReason,
    frozen,
    freezeReason,
  }: JsonRecord) {
    if (!this.#state.sessions[source]) {
      throw new Error(`Unknown edge source session: ${source}`)
    }

    if (!this.#state.sessions[target]) {
      throw new Error(`Unknown edge target session: ${target}`)
    }

    const baseEdgeId = `${kind}:${envelope.callId}`
    const edgeId = this.#state.edges.some((edge) => edge.edgeId === baseEdgeId)
      ? `${baseEdgeId}:${randomUUID().slice(0, 8)}`
      : baseEdgeId

    this.#state.edges.push({
      edgeId,
      source,
      target,
      kind,
      call: envelope,
      label,
      ts: envelope.ts,
      reportId,
      verdict,
      issueCount,
      summary,
      masterReason,
      frozen,
      freezeReason,
    })
  }

  #masterReasonFromInput(source, input) {
    if (this.#state.sessions[source]?.role !== 'master') {
      return undefined
    }

    const reason = input?.masterReason ?? input?.reason
    return typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : undefined
  }

  #normalizeReportPayload(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('report payload is required')
    }

    if (input.type === 'verdict') {
      if (typeof input.verdict !== 'string' || input.verdict.trim().length === 0) {
        throw new Error('report verdict is required')
      }

      let issues
      if (input.issues !== undefined) {
        if (!Array.isArray(input.issues)) {
          throw new Error('verdict report issues must be an array')
        }

        issues = input.issues.map((issue, index) => {
          if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
            throw new Error(`verdict issue ${index} must be an object`)
          }

          if (
            typeof issue.message !== 'string' ||
            issue.message.trim().length === 0
          ) {
            throw new Error(`verdict issue ${index} message is required`)
          }

          if (issue.file !== undefined && typeof issue.file !== 'string') {
            throw new Error(`verdict issue ${index} file must be a string`)
          }

          if (
            issue.line !== undefined &&
            (typeof issue.line !== 'number' || !Number.isFinite(issue.line))
          ) {
            throw new Error(`verdict issue ${index} line must be a finite number`)
          }

          if (
            issue.severity !== undefined &&
            !['info', 'warn', 'error'].includes(issue.severity)
          ) {
            throw new Error(
              `verdict issue ${index} severity must be info, warn, or error`
            )
          }

          return {
            message: issue.message.trim(),
            file: issue.file,
            line: issue.line,
            severity: issue.severity,
          }
        })
      }

      if (input.summary !== undefined && typeof input.summary !== 'string') {
        throw new Error('verdict report summary must be a string')
      }

      return {
        type: 'verdict',
        verdict: input.verdict.trim(),
        issues,
        summary: input.summary,
      }
    }

    if (input.type === 'relationship') {
      if (typeof input.target !== 'string' || input.target.trim().length === 0) {
        throw new Error('relationship report target is required')
      }

      return {
        type: 'relationship',
        target: input.target.trim(),
        nature: this.#optionalString(input.nature, 'relationship nature'),
        sessionRef: this.#optionalString(
          input.sessionRef,
          'relationship sessionRef'
        ),
      }
    }

    if (input.type === 'info') {
      if (!Object.hasOwn(input, 'payload')) {
        throw new Error('info report payload is required')
      }

      return {
        type: 'info',
        payload: input.payload,
      }
    }

    throw new Error(`Unknown report type: ${input.type}`)
  }

  #optionalString(value, label) {
    if (value === undefined) {
      return undefined
    }

    if (typeof value !== 'string') {
      throw new Error(`${label} must be a string`)
    }

    return value
  }

  #touch() {
    this.#state.updatedAt = now()
    this.#persistState()
  }

  #broadcast(event) {
    this.#emitRuntimeEventToHost?.(event)
  }

  #persistState() {
    if (!this.#storageFile) {
      return
    }

    writeJsonAtomically(this.#storageFile, this.#state)
  }

  #loadState() {
    if (!this.#storageFile || !fs.existsSync(this.#storageFile)) {
      return createEmptyGraphState()
    }

    const primary = readJsonFile(this.#storageFile)
    if (primary.ok) {
      return this.#normalizeState(primary.value)
    }

    const diagnostics = [
      diagnostic(
        'storage.primary_parse_failed',
        'Primary Orrery runtime state could not be parsed.',
        {
          storageFile: this.#storageFile,
          error: primary.error.message,
          preservedFile: preserveCorruptFile(this.#storageFile),
        }
      ),
    ]

    const backupFile = backupFileFor(this.#storageFile)
    if (fs.existsSync(backupFile)) {
      const backup = readJsonFile(backupFile)
      if (backup.ok) {
        diagnostics.push(
          diagnostic(
            'storage.recovered_from_backup',
            'Recovered Orrery runtime state from the last valid backup.',
            { backupFile }
          )
        )
        return this.#normalizeState(backup.value, diagnostics)
      }

      diagnostics.push(
        diagnostic(
          'storage.backup_parse_failed',
          'Backup Orrery runtime state could not be parsed.',
          { backupFile, error: backup.error.message }
        )
      )
    }

    console.error(
      `Failed to load Orrery runtime state: ${primary.error.message}; starting with an empty recoverable state.`
    )
    return this.#withDiagnostics(createEmptyGraphState(), diagnostics)
  }

  #normalizeState(value, diagnostics: JsonRecord[] = []) {
    const fallback = createEmptyGraphState()
    const source = isObject(value) ? value : {}
    const state: JsonRecord = {
      ...fallback,
      ...source,
      version: graphStateVersion,
      updatedAt: nonEmptyString(source.updatedAt) ? source.updatedAt : fallback.updatedAt,
      nodes: [],
      edges: Array.isArray(source.edges)
        ? source.edges.map((edge) => this.#normalizeEdge(edge))
        : [],
      sessions: {},
      providerInstances: normalizeProviderInstances(source.providerInstances),
      clusters: isObject(source.clusters) ? this.#normalizeClusters(source.clusters) : {},
      reports: Array.isArray(source.reports)
        ? source.reports.map((report) => this.#normalizeReport(report))
        : [],
    }

    const sourceSessions = isObject(source.sessions) ? source.sessions : {}
    for (const [storageKey, sessionValue] of Object.entries(sourceSessions)) {
      if (!isObject(sessionValue)) {
        diagnostics.push(
          diagnostic('storage.session_skipped', 'Skipped an invalid session record.', {
            storageKey,
          })
        )
        continue
      }
      const session = this.#normalizeSession(storageKey, sessionValue, diagnostics)
      state.sessions[session.sessionId] = session
    }

    const seenNodeSessionIds = new Set()
    const sourceNodes = Array.isArray(source.nodes) ? source.nodes : []
    for (const nodeValue of sourceNodes) {
      if (!isObject(nodeValue)) {
        diagnostics.push(
          diagnostic('storage.node_skipped', 'Skipped an invalid graph node record.')
        )
        continue
      }

      const nodeSessionId = this.#nodeSessionId(nodeValue)
      if (!nodeSessionId || seenNodeSessionIds.has(nodeSessionId)) {
        diagnostics.push(
          diagnostic('storage.node_skipped', 'Skipped a duplicate or unidentified graph node.', {
            nodeId: nodeValue.nodeId,
            sessionId: nodeValue.sessionId,
          })
        )
        continue
      }

      if (!state.sessions[nodeSessionId]) {
        diagnostics.push(
          diagnostic(
            'storage.placeholder_session_created',
            'Created a failed placeholder session for a graph node without a session record.',
            { sessionId: nodeSessionId }
          )
        )
        state.sessions[nodeSessionId] = this.#placeholderSessionFromNode(
          nodeSessionId,
          nodeValue
        )
      }

      const session = state.sessions[nodeSessionId]
      state.nodes.push(this.#normalizeNode(nodeValue, session, diagnostics))
      seenNodeSessionIds.add(nodeSessionId)
    }

    for (const session of Object.values(state.sessions as JsonRecord)) {
      if (seenNodeSessionIds.has(session.sessionId)) {
        continue
      }

      diagnostics.push(
        diagnostic(
          'storage.node_created',
          'Created a graph node for a session without a node record.',
          { sessionId: session.sessionId }
        )
      )
      state.nodes.push(this.#nodeFromSession(session))
    }

    state.diagnostics = this.#activePersistedDiagnostics(state, source.diagnostics)

    return this.#withDiagnostics(state, diagnostics)
  }

  #activePersistedDiagnostics(state, diagnostics) {
    if (!Array.isArray(diagnostics)) {
      return undefined
    }

    return diagnostics
      .filter((item) => isObject(item))
      .filter((item) => {
        if (item.type !== 'storage.cwd_invalid') {
          return true
        }

        const sessionId =
          isObject(item.details) && typeof item.details.sessionId === 'string'
            ? item.details.sessionId
            : undefined
        const session = sessionId ? state.sessions[sessionId] : undefined
        return !session || !isValidCwd(session.cwd)
      })
      .slice(-50)
  }

  #withDiagnostics(state, diagnostics) {
    if (diagnostics.length === 0) {
      return state
    }

    return {
      ...state,
      diagnostics: [
        ...(Array.isArray(state.diagnostics) ? state.diagnostics : []),
        ...diagnostics,
      ].slice(-50),
    }
  }

  #normalizeSession(storageKey, value, diagnostics) {
    const sessionId = nonEmptyString(value.sessionId)
      ? value.sessionId
      : nonEmptyString(storageKey)
        ? storageKey
        : randomUUID()
    const ts = now()
    const recoveredActiveSession = recoverableActiveStatuses.has(value.status)
    const status = this.#normalizeSessionStatus(sessionId, value, diagnostics)
    const backend = validAgentBackends.has(value.backend)
      ? value.backend
      : 'claude-cli'
    const providerKind = validProviderKinds.has(value.providerKind)
      ? value.providerKind
      : backend === 'codex-app-server'
        ? 'codex'
        : backend === 'claude-agent-sdk'
          ? 'claude-code'
          : 'legacy-claude-cli'
    let cwd = safeCwd(value.cwd)
    const cwdRepair = !isValidCwd(cwd) ? cwdRepairCandidate(cwd, value) : undefined
    if (cwdRepair) {
      diagnostics.push(
        diagnostic(
          'storage.cwd_repaired',
          'Repointed a restored session from a missing worktree to an available project folder.',
          { sessionId, oldCwd: cwd, cwd: cwdRepair.cwd, reason: cwdRepair.reason }
        )
      )
      cwd = cwdRepair.cwd
      if (
        typeof value.error === 'string' &&
        value.error.includes('Project folder is no longer available')
      ) {
        delete value.error
      }
    }
    if (!isValidCwd(cwd)) {
      diagnostics.push(
        diagnostic(
          'storage.cwd_invalid',
          'A restored session points at a project folder that is no longer available.',
          { sessionId, cwd }
        )
      )
      value.error =
        value.error ??
        `Project folder is no longer available: ${cwd}. Restore the folder or start a linked chat with a valid cwd.`
    }
    let project = normalizeSessionProject(value.project, cwd)
    if (cwdRepair && project?.workMode === 'worktree') {
      project = {
        ...project,
        cwd,
        repoRoot:
          nonEmptyString(project.repoRoot) && isValidCwd(project.repoRoot)
            ? project.repoRoot
            : undefined,
        workMode: 'local',
        baseBranch: undefined,
        branch: currentGitBranch(cwd) ?? project.baseBranch ?? project.branch,
      }
    }
    const session = {
      ...value,
      sessionId,
      nodeId: sessionId,
      backend,
      backendSessionId: nonEmptyString(value.backendSessionId)
        ? value.backendSessionId
        : sessionId,
      providerKind,
      providerInstanceId: normalizeSessionProviderInstanceId(
        providerKind,
        value.providerInstanceId
      ),
      providerSessionId: nonEmptyString(value.providerSessionId)
        ? value.providerSessionId
        : nonEmptyString(value.backendSessionId)
          ? value.backendSessionId
          : sessionId,
      providerResumeCursor: nonEmptyString(value.providerResumeCursor)
        ? value.providerResumeCursor
        : undefined,
      agent: nonEmptyString(value.agent) ? value.agent : 'claude-code',
      label: nonEmptyString(value.label) ? value.label : `Claude ${sessionId.slice(0, 8)}`,
      prompt: typeof value.prompt === 'string' ? value.prompt : '',
      cwd,
      project,
      role: value.role === 'master' ? 'master' : 'worker',
      status,
      createdAt: nonEmptyString(value.createdAt) ? value.createdAt : ts,
      updatedAt: nonEmptyString(value.updatedAt) ? value.updatedAt : ts,
      chunks: Array.isArray(value.chunks)
        ? value.chunks.map((chunk) => this.#normalizeChunk(sessionId, chunk))
        : [],
      messages: Array.isArray(value.messages)
        ? value.messages.map((message) =>
            this.#normalizeMessage(sessionId, message, status, diagnostics)
          )
        : this.#messagesFromLegacySession({ ...value, sessionId }),
      nativeEvents: Array.isArray(value.nativeEvents)
        ? value.nativeEvents.map((event) =>
            this.#normalizeNativeProviderEvent(sessionId, providerKind, event)
          )
        : [],
      runtimeEvents: Array.isArray(value.runtimeEvents)
        ? value.runtimeEvents.map((event) =>
            this.#normalizeProviderRuntimeEvent(sessionId, event)
          )
        : [],
      runtimeActivities: Array.isArray(value.runtimeActivities)
        ? value.runtimeActivities.map((activity) =>
            this.#normalizeRuntimeActivity(sessionId, activity)
          )
        : [],
      runtimeRequests: Array.isArray(value.runtimeRequests)
        ? this.#normalizeRuntimeRequests(
            sessionId,
            value.runtimeRequests,
            recoveredActiveSession,
            diagnostics
          )
        : [],
      runtimeUserInputRequests: Array.isArray(value.runtimeUserInputRequests)
        ? this.#normalizeUserInputRequests(
            sessionId,
            value.runtimeUserInputRequests,
            recoveredActiveSession,
            diagnostics
          )
        : [],
      runtimePlans: Array.isArray(value.runtimePlans)
        ? value.runtimePlans.filter(isObject)
        : [],
      runtimeSettings: normalizeProviderRuntimeSettings(value.runtimeSettings),
      archived: value.archived === true,
    }

    if (value.nodeId !== sessionId) {
      diagnostics.push(
        diagnostic(
          'storage.session_identity_repaired',
          'Repaired a session whose nodeId did not match sessionId.',
          { sessionId, previousNodeId: value.nodeId }
        )
      )
    }

    return session
  }

  #normalizeSessionStatus(sessionId, session, diagnostics) {
    if (recoverableActiveStatuses.has(session.status)) {
      diagnostics.push(
        diagnostic(
          'runtime.active_session_recovered',
          'Recovered a session that was active when the previous runtime stopped.',
          { sessionId, previousStatus: session.status }
        )
      )
      session.error =
        session.error ??
        `Interrupted by runtime restart while ${session.status}; review the last messages and resume when ready.`
      session.finishedAt = session.finishedAt ?? now()
      return 'failed'
    }

    if (session.status === 'finished') {
      diagnostics.push(
        diagnostic(
          'storage.legacy_status_migrated',
          'Migrated legacy finished status to idle.',
          { sessionId }
        )
      )
      return 'idle'
    }

    if (validSessionStatuses.has(session.status)) {
      return session.status
    }

    diagnostics.push(
      diagnostic(
        'storage.invalid_status_repaired',
        'Repaired a session with an unknown status.',
        { sessionId, previousStatus: session.status }
      )
    )
    session.error =
      session.error ?? `Recovered unknown persisted status: ${String(session.status)}`
    return 'failed'
  }

  #normalizeChunk(sessionId, value) {
    if (!isObject(value)) {
      return {
        id: randomUUID(),
        sessionId,
        ts: now(),
        stream: 'stderr',
        raw: String(value ?? ''),
      }
    }

    return {
      ...value,
      id: nonEmptyString(value.id) ? value.id : randomUUID(),
      sessionId,
      ts: nonEmptyString(value.ts) ? value.ts : now(),
      stream: value.stream === 'stderr' ? 'stderr' : 'stdout',
      raw: typeof value.raw === 'string' ? value.raw : '',
    }
  }

  #normalizeNativeProviderEvent(sessionId, providerKind, value) {
    const event = isObject(value) ? value : {}
    const raw = isObject(event.raw)
      ? event.raw
      : {
          source: 'legacy.claude-cli.stream-json',
          payload: value,
        }

    return {
      ...event,
      id: nonEmptyString(event.id) ? event.id : randomUUID(),
      ts: nonEmptyString(event.ts) ? event.ts : now(),
      sessionId,
      providerKind: validProviderKinds.has(event.providerKind)
        ? event.providerKind
        : providerKind,
      turnId: nonEmptyString(event.turnId) ? event.turnId : undefined,
      raw,
    }
  }

  #normalizeProviderRuntimeEvent(sessionId, value) {
    const event = isObject(value) ? value : {}
    return {
      ...event,
      id: nonEmptyString(event.id) ? event.id : randomUUID(),
      ts: nonEmptyString(event.ts) ? event.ts : now(),
      type: nonEmptyString(event.type) ? event.type : 'session.state',
      sessionId,
    }
  }

  #normalizeRuntimeActivity(sessionId, value) {
    const activity = isObject(value) ? value : {}
    const status = validRuntimeItemStatuses.has(activity.status)
      ? activity.status
      : activity.completedAt
        ? 'completed'
        : 'running'

    return {
      ...activity,
      id: nonEmptyString(activity.id) ? activity.id : randomUUID(),
      sessionId,
      kind: nonEmptyString(activity.kind) ? activity.kind : 'tool_call',
      title: nonEmptyString(activity.title)
        ? activity.title
        : nonEmptyString(activity.command)
          ? activity.command
          : 'activity',
      status,
      startedAt: nonEmptyString(activity.startedAt)
        ? activity.startedAt
        : undefined,
      updatedAt: nonEmptyString(activity.updatedAt) ? activity.updatedAt : now(),
      completedAt: nonEmptyString(activity.completedAt)
        ? activity.completedAt
        : undefined,
      durationMs: Number.isFinite(activity.durationMs)
        ? activity.durationMs
        : undefined,
      sublines: Array.isArray(activity.sublines)
        ? activity.sublines.filter(isObject)
        : [],
    }
  }

  #normalizeRuntimeRequests(sessionId, values, recoveredActiveSession, diagnostics) {
    return values.filter(isObject).map((value) => {
      const status = validRuntimeRequestStatuses.has(value.status)
        ? value.status
        : 'open'
      const becameStale = recoveredActiveSession && status === 'open'
      if (becameStale) {
        diagnostics.push(
          diagnostic(
            'runtime.request_stale',
            'Marked an open provider approval request as stale after runtime restart.',
            { sessionId, requestId: value.id }
          )
        )
      }

      return {
        ...value,
        id: nonEmptyString(value.id) ? value.id : randomUUID(),
        sessionId,
        kind:
          value.kind === 'permission' || value.kind === 'confirmation'
            ? value.kind
            : 'approval',
        title: nonEmptyString(value.title) ? value.title : 'Runtime request',
        status: becameStale ? 'stale' : status,
        createdAt: nonEmptyString(value.createdAt) ? value.createdAt : now(),
        resolvedAt: becameStale
          ? now()
          : nonEmptyString(value.resolvedAt)
            ? value.resolvedAt
            : undefined,
      }
    })
  }

  #normalizeUserInputRequests(sessionId, values, recoveredActiveSession, diagnostics) {
    return values.filter(isObject).map((value) => {
      const status = validUserInputRequestStatuses.has(value.status)
        ? value.status
        : 'open'
      const becameStale = recoveredActiveSession && status === 'open'
      if (becameStale) {
        diagnostics.push(
          diagnostic(
            'runtime.user_input_stale',
            'Marked an open provider user-input request as stale after runtime restart.',
            { sessionId, requestId: value.id }
          )
        )
      }

      return {
        ...value,
        id: nonEmptyString(value.id) ? value.id : randomUUID(),
        sessionId,
        prompt: nonEmptyString(value.prompt) ? value.prompt : 'Input requested',
        status: becameStale ? 'stale' : status,
        createdAt: nonEmptyString(value.createdAt) ? value.createdAt : now(),
        answeredAt: becameStale
          ? now()
          : nonEmptyString(value.answeredAt)
            ? value.answeredAt
            : undefined,
      }
    })
  }

  #normalizeMessage(sessionId, value, sessionStatus, diagnostics) {
    const message = isObject(value) ? value : { content: String(value ?? '') }
    const status = validMessageStatuses.has(message.status)
      ? message.status
      : message.status === undefined
        ? undefined
        : 'failed'
    const normalized = {
      ...message,
      id: nonEmptyString(message.id) ? message.id : randomUUID(),
      sessionId,
      role:
        message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
      content: typeof message.content === 'string' ? message.content : '',
      attachments: normalizeChatAttachments(message.attachments),
      ts: nonEmptyString(message.ts) ? message.ts : now(),
      status,
    }

    if (message.status === 'streaming' && sessionStatus === 'failed') {
      normalized.status = 'failed'
      diagnostics.push(
        diagnostic(
          'runtime.streaming_message_recovered',
          'Marked an interrupted streaming assistant message as failed.',
          { sessionId, messageId: normalized.id }
        )
      )
    }

    return normalized
  }

  #nodeSessionId(node) {
    if (nonEmptyString(node.sessionId)) {
      return node.sessionId
    }
    if (nonEmptyString(node.nodeId)) {
      return node.nodeId
    }
    return undefined
  }

  #normalizeNode(node, session, diagnostics) {
    if (node.nodeId !== session.sessionId || node.sessionId !== session.sessionId) {
      diagnostics.push(
        diagnostic(
          'storage.node_identity_repaired',
          'Repaired a graph node so nodeId equals sessionId.',
          {
            sessionId: session.sessionId,
            previousNodeId: node.nodeId,
            previousSessionId: node.sessionId,
          }
        )
      )
    }

    return {
      ...node,
      nodeId: session.sessionId,
      sessionId: session.sessionId,
      label: nonEmptyString(node.label) ? node.label : session.label,
      role: session.role,
      agent: nonEmptyString(node.agent) ? node.agent : session.agent,
      status: session.status,
      position: isObject(node.position)
        ? {
            x: Number.isFinite(node.position.x) ? node.position.x : 96,
            y: Number.isFinite(node.position.y) ? node.position.y : 96,
          }
        : { x: 96, y: 96 },
      frozen: node.frozen === true,
      freezeReason: nonEmptyString(node.freezeReason) ? node.freezeReason : undefined,
      masterReason: nonEmptyString(node.masterReason) ? node.masterReason : undefined,
    }
  }

  #nodeFromSession(session) {
    return {
      nodeId: session.sessionId,
      sessionId: session.sessionId,
      label: session.label,
      role: session.role,
      agent: session.agent,
      status: session.status,
      position: {
        x: 96,
        y: 96,
      },
      frozen: false,
    }
  }

  #placeholderSessionFromNode(sessionId, node) {
    const ts = now()
    return {
      sessionId,
      nodeId: sessionId,
      backend: 'claude-cli',
      backendSessionId: sessionId,
      providerKind: 'legacy-claude-cli',
      providerInstanceId: 'legacy-claude-cli',
      providerSessionId: sessionId,
      agent: nonEmptyString(node.agent) ? node.agent : 'claude-code',
      label: nonEmptyString(node.label) ? node.label : `Recovered ${sessionId.slice(0, 8)}`,
      prompt: '',
      cwd: process.cwd(),
      role: node.role === 'master' ? 'master' : 'worker',
      status: 'failed',
      createdAt: ts,
      updatedAt: ts,
      finishedAt: ts,
      error: 'Recovered graph node without a persisted session record.',
      chunks: [],
      messages: [],
      nativeEvents: [],
      runtimeEvents: [],
      runtimeActivities: [],
      runtimeRequests: [],
      runtimeUserInputRequests: [],
      runtimePlans: [],
      runtimeSettings: normalizeProviderRuntimeSettings(),
    }
  }

  #normalizeEdge(value) {
    if (!isObject(value)) {
      return {
        edgeId: randomUUID(),
        source: '',
        target: '',
        kind: 'create-session',
        ts: now(),
      }
    }

    const kind = validGraphEdgeKinds.has(value.kind) ? value.kind : 'create-session'

    return {
      ...value,
      edgeId: nonEmptyString(value.edgeId) ? value.edgeId : randomUUID(),
      source: nonEmptyString(value.source) ? value.source : '',
      target: nonEmptyString(value.target) ? value.target : '',
      kind,
      ts: nonEmptyString(value.ts) ? value.ts : now(),
      reportId: nonEmptyString(value.reportId) ? value.reportId : undefined,
      verdict: nonEmptyString(value.verdict) ? value.verdict : undefined,
      issueCount: Number.isFinite(value.issueCount) ? value.issueCount : undefined,
      summary: nonEmptyString(value.summary) ? value.summary : undefined,
      masterReason: nonEmptyString(value.masterReason)
        ? value.masterReason
        : nonEmptyString(value.reason)
          ? value.reason
          : undefined,
      frozen: value.frozen === true,
      freezeReason: nonEmptyString(value.freezeReason)
        ? value.freezeReason
        : undefined,
    }
  }

  #normalizeReport(value) {
    if (!isObject(value)) {
      return {
        id: randomUUID(),
        from: '',
        payload: { type: 'info', payload: value },
      }
    }

    return {
      ...value,
      id: nonEmptyString(value.id) ? value.id : randomUUID(),
    }
  }

  #normalizeClusters(clusters: JsonRecord) {
    return Object.fromEntries(
      Object.entries(clusters)
        .filter(([, cluster]) => isObject(cluster))
        .map(([clusterId, cluster]) => {
          let loopPolicy
          try {
            loopPolicy = cluster.loopPolicy
              ? this.#normalizeLoopPolicy(cluster.loopPolicy)
              : undefined
          } catch {
            loopPolicy = undefined
          }

          const loopState = this.#normalizeLoopState(cluster.loopState)

          return [
            clusterId,
            {
              ...cluster,
              clusterId: nonEmptyString(cluster.clusterId) ? cluster.clusterId : clusterId,
              label: nonEmptyString(cluster.label) ? cluster.label : clusterId,
              nodeIds: Array.isArray(cluster.nodeIds)
                ? cluster.nodeIds.filter(nonEmptyString)
                : [],
              frozen: cluster.frozen === true,
              freezeReason: nonEmptyString(cluster.freezeReason)
                ? cluster.freezeReason
                : undefined,
              ...(nonEmptyString(cluster.masterSessionId)
                ? { masterSessionId: cluster.masterSessionId }
                : {}),
              ...(loopPolicy ? { loopPolicy } : {}),
              ...(loopState ? { loopState } : {}),
            },
          ]
        })
    )
  }

  #messagesFromLegacySession(session) {
    const messages = []
    if (typeof session.prompt === 'string' && session.prompt.length > 0) {
      messages.push({
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'user',
        content: session.prompt,
        ts: session.createdAt ?? now(),
        status: 'complete',
      })
    }
    if (typeof session.result === 'string' && session.result.length > 0) {
      messages.push({
        id: randomUUID(),
        sessionId: session.sessionId,
        role: 'assistant',
        content: session.result,
        ts: session.finishedAt ?? session.updatedAt ?? now(),
        status: 'complete',
      })
    }
    return messages
  }
}
