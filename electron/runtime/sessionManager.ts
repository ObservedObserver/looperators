import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import {
  createEmptyGraphState,
  graphEdgeKinds,
  graphStateVersion,
  openWorkspaceTargetIds,
  runtimeTerminalStreams,
} from '../../shared/graph-state.js'
import { projectSession } from '../../shared/session-projection.js'
import {
  defaultCycleMaxFirings,
  evaluate as evaluateSubscriptions,
  eventSourceSession,
  governingMaster,
  loopsOf,
  loopTimelineOf,
  normalizeDailyAt,
  scheduleDelayMs,
  scheduleSummary,
  staticCheck,
} from '../../shared/graph-core/index.js'
import {
  ContextChannelStore,
  activationPreamble,
} from './contextChannel.js'
import {
  KernelStore,
  kernelActorKinds,
  kernelDatabaseFileFor,
} from './kernelStore.js'
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
// The unified command channel (kernel doc §7.5): every state mutation from any
// actor (human/IPC, master/agent via membrane, rule via loop automation) goes
// through dispatchCommand → validate → execute → append kernel event.
const kernelCommandKinds = new Set([
  'create_session',
  'resume_session',
  'deliver',
  'activate',
  'archive_session',
  'kill_session',
  'respond_runtime_request',
  'answer_user_input',
  'upsert_scope',
  'create_master',
  'assign_master',
  'set_loop_policy',
  'update_node_positions',
  'start_loop',
  'stop_loop',
  'freeze',
  'link_sessions',
  'remove_edge',
  'report',
  'upsert_provider_instance',
  'author_subscription',
  'stop_subscription',
  'approve_activation',
  'deny_activation',
])
const validSubscriptionGates = new Set(['auto', 'master', 'human'])
const validSubscriptionConcurrencies = new Set([
  'coalesce',
  'queue',
  'drop',
  'interrupt',
])
const validSubscriptionOnStops = new Set([
  'freeze-edge',
  'freeze-target',
  'freeze-cluster',
])
const validSubscriptionPatterns = new Set([
  'finished',
  'failed',
  'report',
  'delivered',
  'schedule',
])
// Source-side minimum interval for timer subscriptions (L1): the guardrail
// against high-frequency runaway lives on the source, not on the operator.
// Overridable for tests via ORRERY_TIMER_MIN_INTERVAL_SECONDS.
const defaultTimerMinIntervalSeconds = 15
function timerMinIntervalSeconds() {
  const fromEnv = Number(process.env.ORRERY_TIMER_MIN_INTERVAL_SECONDS)
  return Number.isFinite(fromEnv) && fromEnv >= 1
    ? fromEnv
    : defaultTimerMinIntervalSeconds
}
// Kernel facts the subscription scheduler evaluates (§6.1 event patterns).
// session.killed is not a trigger pattern; it sweeps subscriptions whose
// participants died (kill parity with the old hero loop).
const schedulerTriggerEventTypes = new Set([
  'session.finished',
  'session.failed',
  'report.received',
  'delivered',
  'session.killed',
  // L1 timer source ticks (external event source, §2.4).
  'external.timer',
])
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
const validRuntimeRequestDecisions = new Set([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
  'approved',
  'denied',
])
const validRuntimeRequestStatuses = new Set([
  'open',
  'approved',
  'approved_for_session',
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
const validOpenWorkspaceTargets = new Set(openWorkspaceTargetIds)
const validRuntimeTerminalStreams = new Set(runtimeTerminalStreams)
const validLoopStatuses = new Set(['running', 'stopped'])
const emptyGitTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const gitDiffMaxBuffer = 64 * 1024 * 1024
const uiPatchMaxLength = 2 * 1024 * 1024
const runtimeTerminalMaxChunks = 1000
const workspaceFilesMaxDepth = 4
const workspaceFilesMaxEntries = 500
const workspaceFilesMaxCountedFiles = 50_000
const workspaceFileContentMaxBytes = 256 * 1024
const workspaceFilesIgnoredDirectories = new Set([
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
const runtimeTerminalSentinelPrefix = '__ORRERY_COMMAND_DONE_'
const runtimeTerminalSentinelPattern =
  /^__ORRERY_COMMAND_DONE_([0-9a-f-]+):(-?\d+)__\s*$/
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

const macWorkspaceOpenAppNames = {
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  terminal: 'Terminal',
  ghostty: 'Ghostty',
  xcode: 'Xcode',
}

const cliWorkspaceOpenCommands = {
  vscode: 'code',
  cursor: 'cursor',
  windsurf: 'windsurf',
  antigravity: 'antigravity',
  ghostty: 'ghostty',
}

type JsonRecord = Record<string, any>
type RuntimeEventEmitter = (event: JsonRecord) => void
type RuntimeRun = JsonRecord & {
  kill: () => boolean
  respondRuntimeRequest?: (input: JsonRecord) => void
  answerUserInput?: (input: JsonRecord) => void
}
type RuntimeTerminalRun = {
  child: ReturnType<typeof spawn>
  terminal: JsonRecord
  stdoutLineBuffer: string
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

function workspaceFileKind(dirent) {
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

function normalizeWorkspaceFilesLimit(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function sortedWorkspaceDirents(cwd) {
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

function countWorkspaceFiles(cwd, state) {
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

function workspaceEntryForDirent(root, parentRelativePath, dirent) {
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

function buildWorkspaceFileTree(root, parentRelativePath, depth, state) {
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
        state
      )
    }

    entries.push(entry)
  }

  return entries
}

function resolveWorkspaceFilePath(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new Error('Workspace file path is required.')
  }

  const rawPath = requestedPath.trim()
  if (path.isAbsolute(rawPath)) {
    throw new Error('Workspace file path must be relative to the project folder.')
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

function normalizeOpenWorkspaceTarget(value) {
  if (validOpenWorkspaceTargets.has(value)) {
    return value
  }

  throw new Error(`Unsupported workspace open target: ${String(value)}`)
}

function workspaceOpenCommand(target, cwd) {
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
    return { command: 'x-terminal-emulator', args: ['--working-directory', cwd] }
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

function runWorkspaceOpenCommand(command, args, cwd) {
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
        reject(new Error(`${command} failed with exit code ${String(code)}`))
      )
    })
  })
}

function defaultTerminalShell() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: [],
    }
  }

  if (process.platform === 'darwin' && fs.existsSync('/bin/zsh')) {
    return { command: '/bin/zsh', args: ['-f'] }
  }

  const configuredShell = nonEmptyString(process.env.SHELL)
    ? process.env.SHELL.trim()
    : undefined
  return {
    command: configuredShell || '/bin/sh',
    args: [],
  }
}

function terminalShellLabel(command, args = []) {
  return [command, ...args].join(' ')
}

function terminalPrompt(cwd) {
  const username = os.userInfo().username || 'user'
  const host = os.hostname().split('.')[0] || 'localhost'
  const folder = path.basename(cwd) || cwd
  const suffix = process.platform === 'win32' ? '>' : '%'
  return `${username}@${host} ${folder} ${suffix} `
}

function terminalCommandSentinel(commandId) {
  if (process.platform === 'win32') {
    return `echo ${runtimeTerminalSentinelPrefix}${commandId}:%ERRORLEVEL%__`
  }

  return `printf '\\n${runtimeTerminalSentinelPrefix}${commandId}:%s__\\n' "$?"`
}

function truncateTerminalChunks(chunks) {
  if (chunks.length > runtimeTerminalMaxChunks) {
    chunks.splice(0, chunks.length - runtimeTerminalMaxChunks)
  }
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

function truncateForLog(value, maxLength = 200) {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
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

function normalizeProviderEffectiveRuntimeConfig(value, providerKind, runtimeSettings) {
  const input = isObject(value) ? value : {}
  const native = isObject(input.native) ? input.native : {}
  const runtimeMode = validProviderRuntimeModes.has(input.runtimeMode)
    ? input.runtimeMode
    : runtimeSettings?.runtimeMode ?? defaultProviderRuntimeSettings.runtimeMode
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
      ? { notes: input.notes.filter(nonEmptyString).map((note) => note.trim()) }
      : {}),
  }
}

function normalizeRuntimeRequestDecision(decision) {
  if (decision === 'approved') {
    return 'accept'
  }
  if (decision === 'denied') {
    return 'decline'
  }
  return decision
}

function runtimeRequestSupportsCancellation(request) {
  return !(
    request?.raw?.source === 'codex.app-server.request' &&
    request.raw.method === 'item/permissions/requestApproval'
  )
}

function runtimeRequestStatusForDecision(decision, request) {
  switch (decision) {
    case 'accept':
      return 'approved'
    case 'acceptForSession':
      return 'approved_for_session'
    case 'cancel':
      return runtimeRequestSupportsCancellation(request) ? 'canceled' : 'denied'
    case 'decline':
    default:
      return 'denied'
  }
}

function normalizeUserInputAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .map(([key, answer]) => {
      const trimmedKey = String(key).trim()
      if (!trimmedKey) {
        return undefined
      }
      if (Array.isArray(answer)) {
        return [
          trimmedKey,
          answer
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ]
      }
      if (typeof answer === 'string') {
        return [trimmedKey, answer]
      }
      return undefined
    })
    .filter(Boolean)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function firstUserInputAnswer(answer, answers) {
  if (typeof answer === 'string') {
    return answer
  }
  const value = Object.values(answers ?? {})[0]
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  return typeof value === 'string' ? value : undefined
}

export class RuntimeSessionManager {
  #state: JsonRecord = createEmptyGraphState()
  #runs = new Map<string, RuntimeRun>()
  #runContext = new Map<string, JsonRecord>()
  #terminals = new Map<string, JsonRecord>()
  #terminalRuns = new Map<string, RuntimeTerminalRun>()
  #storageFile: string | undefined
  #kernelStore: KernelStore
  #channelStore: ContextChannelStore
  #schedulerChain: Promise<void> = Promise.resolve()
  // L1 timer source: one armed timeout per active schedule subscription.
  #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #legacyImportKind: 'migration' | 'fossil-rollback' | undefined
  #restartInterruptedSessionIds: string[] = []
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
    this.#kernelStore = new KernelStore({
      databaseFile: this.#storageFile
        ? kernelDatabaseFileFor(this.#storageFile)
        : undefined,
    })
    // Per-session inbox directories live next to the storage (outside any
    // project repo, §4.2.5); storage-less managers get an isolated temp root.
    this.#channelStore = new ContextChannelStore({
      root: this.#storageFile
        ? path.join(path.dirname(this.#storageFile), 'channels')
        : fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-channels-')),
    })
    this.#state = this.#loadState()
    if (this.#legacyImportKind === 'migration') {
      this.#appendKernelEvent(
        'storage.migrated',
        { fromFile: this.#storageFile },
        { actor: { kind: 'runtime' } },
        { reason: 'Imported legacy JSON snapshot into the SQLite kernel store.' }
      )
    } else if (this.#legacyImportKind === 'fossil-rollback') {
      this.#appendKernelEvent(
        'storage.restored-from-fossil',
        { fromFile: this.#storageFile },
        { actor: { kind: 'runtime' } },
        {
          reason:
            'Kernel store was corrupt; restored the legacy JSON snapshot. State may have rolled back to the migration point.',
        }
      )
    }
    for (const sessionId of this.#restartInterruptedSessionIds) {
      // Sessions that were mid-run when the previous runtime stopped are
      // flipped to failed on load; without this fact their causal chain in
      // the kernel log would simply stop dead.
      this.#appendKernelEvent(
        'session.failed',
        { sessionId, interruptedByRestart: true },
        { actor: { kind: 'runtime' } },
        { reason: 'Interrupted by runtime restart.' }
      )
    }
    this.#restartInterruptedSessionIds = []
    this.#bridge = new MembraneBridge({
      handler: (request) => this.handleMembraneRequest(request),
    })
    this.#providerService = new ProviderService({
      providerInstances: this.#state.providerInstances,
    })
    this.#persistState()
    this.#sweepKilledParticipantSubscriptions()
    this.#recoverSchedulerState()
    this.#recoverTimers()
  }

  getState() {
    const state = clone(this.#state)
    // L4 thin projection: rings are derived from the intent graph on every
    // read, never stored — the loop is a reading of subscriptions, not an
    // object (proposal L4 "no new storage objects").
    state.loops = loopsOf(this.#kernelView())
    return state
  }

  // Unified command channel (kernel doc §7.5). All mutating entry points --
  // human (IPC/HTTP wrappers), master/agent (membrane), rule (loop automation)
  // -- converge here: validate → execute → append kernel event(s).
  async dispatchCommand(command: JsonRecord = {}): Promise<any> {
    const kind = optionalTrimmedString(command.kind)
    if (!kind || !kernelCommandKinds.has(kind)) {
      throw new Error(`Unknown kernel command: ${kind ?? ''}`)
    }

    const actor = isObject(command.actor) ? command.actor : undefined
    if (!actor || !kernelActorKinds.has(actor.kind)) {
      throw new Error(
        `Kernel command requires a valid actor: ${JSON.stringify(command.actor)}`
      )
    }
    if (
      (actor.kind === 'master' || actor.kind === 'agent') &&
      !this.#state.sessions[optionalTrimmedString(actor.ref) ?? '']
    ) {
      throw new Error(`Kernel command actor session is unknown: ${actor.ref ?? ''}`)
    }

    const ctx = {
      actor: { kind: actor.kind, ref: optionalTrimmedString(actor.ref) },
      causeId: optionalTrimmedString(command.causeId),
      reason: optionalTrimmedString(command.reason),
    }
    const input = isObject(command.input) ? command.input : {}

    switch (kind) {
      case 'create_session':
        return this.#cmdCreateSession(input, ctx)
      case 'resume_session':
        return this.#cmdResumeSession(input, ctx)
      case 'deliver':
        return this.#cmdDeliver(input, ctx)
      case 'activate':
        return this.#cmdActivate(input, ctx)
      case 'archive_session':
        return this.#cmdArchiveSession(input, ctx)
      case 'kill_session':
        return this.#cmdKillSession(input, ctx)
      case 'respond_runtime_request':
        return this.#cmdRespondRuntimeRequest(input, ctx)
      case 'answer_user_input':
        return this.#cmdAnswerUserInput(input, ctx)
      case 'upsert_scope':
        return this.#cmdUpsertCluster(input, ctx)
      case 'create_master':
        return this.#cmdCreateMasterForCluster(input, ctx)
      case 'assign_master':
        return this.#cmdAssignMaster(input, ctx)
      case 'set_loop_policy':
        return this.#cmdSetLoopPolicy(input, ctx)
      case 'update_node_positions':
        return this.#cmdUpdateNodePositions(input, ctx)
      case 'start_loop':
        return this.#cmdStartLoop(input, ctx)
      case 'stop_loop':
        return this.#cmdStopLoop(input, ctx)
      case 'freeze':
        return this.#cmdFreeze(input, ctx)
      case 'link_sessions':
        return this.#cmdLinkSessions(input, ctx)
      case 'remove_edge':
        return this.#cmdRemoveEdge(input, ctx)
      case 'report':
        return this.#cmdReport(input, ctx)
      case 'upsert_provider_instance':
        return this.#cmdUpsertProviderInstance(input, ctx)
      case 'author_subscription':
        return this.#cmdAuthorSubscription(input, ctx)
      case 'stop_subscription':
        return this.#cmdStopSubscription(input, ctx)
      case 'approve_activation':
        return this.#cmdApproveActivation(input, ctx)
      case 'deny_activation':
        return this.#cmdDenyActivation(input, ctx)
    }

    throw new Error(`Unhandled kernel command: ${kind}`)
  }

  getKernelEvents(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const events = this.#kernelStore.listEvents({
      sinceSeq: Number(request.since ?? request.sinceSeq ?? 0) || 0,
      limit: Number(request.limit ?? 0) || undefined,
      type: optionalTrimmedString(request.type),
      tail: request.tail === true || request.tail === 'true',
    })
    return { events, latestSeq: this.#kernelStore.latestSeq() }
  }

  // The whole log in ascending seq order. listEvents caps a single page at
  // 2000 rows, so page by the last seen seq — a lap timeline must never
  // silently drop the ring's early laps.
  #allKernelEvents() {
    const events = []
    let sinceSeq = 0
    for (;;) {
      const batch = this.#kernelStore.listEvents({ sinceSeq, limit: 2000 })
      events.push(...batch)
      if (batch.length < 2000) {
        return events
      }
      sinceSeq = batch[batch.length - 1].seq
    }
  }

  // L4 loop timeline: one ring's history, grouped lap by lap from the event
  // log (pure derivation via graph-core; the kernel stores no loop object).
  getLoopTimeline(input: JsonRecord = {}) {
    const loopId = optionalTrimmedString(input.loopId)
    if (!loopId) {
      throw new Error('getLoopTimeline requires a loopId')
    }
    const view = this.#kernelView()
    const loop = loopsOf(view).find((candidate) => candidate.loopId === loopId)
    if (!loop) {
      throw new Error(`Unknown loop: ${loopId}`)
    }
    const timeline = loopTimelineOf(view, this.#allKernelEvents(), loop)
    return { loop, timeline }
  }

  #humanCtx() {
    return { actor: { kind: 'human' } }
  }

  #subscriptionRuleCtx(subscriptionId, causeId) {
    return { actor: { kind: 'rule', ref: subscriptionId }, causeId }
  }

  // ---- Intent layer: subscriptions, gates, and the scheduling loop (G3) ----

  // Builds the graph-core view of the kernel state from live runtime state.
  // graph-core's fold() remains the replay/derivation contract (G1 tests pin
  // that the same events reproduce this shape); the runtime evaluates
  // against its live state so scheduling sees current session statuses.
  #kernelView() {
    const sessions = {}
    for (const session of Object.values(this.#state.sessions as JsonRecord)) {
      const node = this.#state.nodes.find(
        (item) => item.sessionId === session.sessionId
      )
      sessions[session.sessionId] = {
        sessionId: session.sessionId,
        status: session.status,
        frozen: node?.frozen === true,
        freezeReason: node?.freezeReason,
        archived: session.archived === true,
        createdBy: undefined,
      }
    }
    const scopes = {}
    for (const cluster of Object.values(this.#state.clusters as JsonRecord)) {
      scopes[cluster.clusterId] = {
        scopeId: cluster.clusterId,
        kind: 'cluster',
        parentId: undefined,
        members: cluster.nodeIds.filter(
          (id) => id !== cluster.masterSessionId
        ),
        masterSessionId: cluster.masterSessionId,
      }
    }
    const pending = {}
    for (const slot of Object.values(
      (this.#state.pendingActivations ?? {}) as JsonRecord
    )) {
      pending[slot.slotKey] = {
        slotKey: slot.slotKey,
        subscriptionId: slot.subscriptionId,
        target: slot.target,
        triggerEventId: slot.triggerEventId,
        status: slot.status,
        createdAtSeq: Number.isFinite(slot.orderSeq) ? slot.orderSeq : 0,
      }
    }
    return {
      lastSeq: this.#kernelStore.latestSeq(),
      sessions,
      subscriptions: clone(this.#state.subscriptions ?? {}),
      scopes,
      pending,
      links: {},
    }
  }

  #activeSubscriptionCount() {
    return Object.values((this.#state.subscriptions ?? {}) as JsonRecord).filter(
      (subscription) => subscription.state === 'active'
    ).length
  }

  // Single-threaded scheduler (§2.4): kernel facts are processed strictly in
  // append order through one promise chain.
  #enqueueSchedulerEvent(event) {
    if (!schedulerTriggerEventTypes.has(event.type)) {
      return
    }
    if (this.#activeSubscriptionCount() === 0 && Object.keys(this.#state.pendingActivations ?? {}).length === 0) {
      return
    }
    this.#schedulerChain = this.#schedulerChain
      .catch(() => undefined)
      .then(() => this.#processSchedulerEvent(event))
      .catch((error) => {
        console.error(
          `Subscription scheduler failed on ${event.type} (${event.id}): ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
  }

  async #processSchedulerEvent(event) {
    if (event.type === 'session.killed') {
      // Kill parity with the old hero loop: a killed participant stops the
      // subscriptions it takes part in (a killed session never emits again
      // and cannot be activated). Failed participants keep their
      // subscriptions — a failed session can be resumed and the loop then
      // self-heals.
      this.#stopSubscriptionsForKilledParticipant(event)
      await this.#drainApprovedSlots()
      return
    }

    const decisions = evaluateSubscriptions(this.#kernelView(), event)
    for (const decision of decisions) {
      const ctx = this.#subscriptionRuleCtx(decision.subscriptionId, event.id)
      if (decision.kind === 'stop-subscription') {
        await this.#stopSubscriptionWithOnStop(decision, ctx)
        continue
      }
      if (decision.kind === 'deliver') {
        // Data-plane firing: forward the trigger source's artifact bundle.
        const subscription = this.#state.subscriptions?.[decision.subscriptionId]
        try {
          this.#cmdDeliver(
            {
              sessionId: decision.target,
              source: eventSourceSession(event),
              topic: decision.topic,
              subscriptionId: decision.subscriptionId,
              reportId: event.type === 'report.received' ? event.payload.reportId : undefined,
            },
            ctx
          )
          if (subscription) {
            subscription.firings += 1
            this.#touch()
          }
        } catch (error) {
          console.error(
            `Subscription ${decision.subscriptionId} delivery failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
        continue
      }
      if (decision.kind === 'interrupt-target') {
        try {
          this.#cmdKillSession({ sessionId: decision.target }, ctx)
        } catch {
          // The target may have finished in the meantime; the pend below
          // still lands.
        }
        continue
      }
      if (decision.kind === 'drop-firing') {
        this.#appendKernelEvent(
          'activation.dropped',
          { subscriptionId: decision.subscriptionId },
          ctx,
          { reason: decision.reason }
        )
        continue
      }
      if (decision.kind === 'pend-activation') {
        await this.#createPendingActivation(decision, event, ctx)
      }
    }

    await this.#drainApprovedSlots()
  }

  async #createPendingActivation(decision, event, ctx) {
    if (decision.supersedes && this.#state.pendingActivations?.[decision.supersedes]) {
      delete this.#state.pendingActivations[decision.supersedes]
      this.#appendKernelEvent(
        'activation.superseded',
        { subscriptionId: decision.subscriptionId, target: decision.target, slotKey: decision.supersedes },
        ctx,
        { reason: 'A newer trigger superseded the pending activation (coalesce).' }
      )
    }

    const subscription = this.#state.subscriptions?.[decision.subscriptionId]
    this.#state.pendingActivations = this.#state.pendingActivations ?? {}
    // Queue keeps an ordered backlog (§6.1): a firing that arrives while a
    // slot is already parked takes a suffixed key instead of overwriting it.
    // Every entry gets its own pending → approved/denied/… fact chain;
    // orderSeq (the pending fact's log seq) drives FIFO drain.
    const baseKey = `${decision.subscriptionId}→${decision.target}`
    let slotKey = baseKey
    if (subscription?.concurrency === 'queue') {
      let ordinal = 2
      while (this.#state.pendingActivations[slotKey]) {
        slotKey = `${baseKey}#${ordinal}`
        ordinal += 1
      }
    }
    const slot = {
      slotKey,
      subscriptionId: decision.subscriptionId,
      target: decision.target,
      triggerEventId: event.id,
      sourceSessionId: eventSourceSession(event),
      reportId: event.type === 'report.received' ? event.payload.reportId : undefined,
      gate: decision.gate,
      masterSessionId: decision.masterSessionId,
      status: 'pending',
      createdAt: now(),
      // Set from the pending fact's log seq below; drives FIFO drain.
      orderSeq: undefined as number | undefined,
    }
    this.#state.pendingActivations[slotKey] = slot
    const pendingEvent = this.#appendKernelEvent(
      'activation.pending',
      {
        subscriptionId: decision.subscriptionId,
        target: decision.target,
        slotKey,
        triggerEventId: event.id,
        gate: decision.gate,
        masterSessionId: decision.masterSessionId,
      },
      ctx
    )
    slot.orderSeq = pendingEvent?.seq
    this.#touch()

    if (decision.gate === 'auto') {
      await this.#cmdApproveActivation(
        { slotKey },
        {
          actor: { kind: 'rule', ref: decision.subscriptionId },
          causeId: pendingEvent?.id,
          reason: 'Auto gate: approved deterministically.',
        }
      )
      return
    }

    if (decision.gate === 'master' && decision.masterSessionId) {
      await this.#notifyMasterOfPending(slot, subscription, event, ctx)
      return
    }
    // gate === 'human' (or master with nobody to route to): the slot waits
    // for an approve/deny command from the UI/CLI.
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
  }

  #pendingRequestText(slot, subscription) {
    const sourceLabel = slot.sourceSessionId
      ? this.#state.sessions[slot.sourceSessionId]?.label ?? slot.sourceSessionId
      : 'unknown'
    const targetLabel =
      this.#state.sessions[slot.target]?.label ?? slot.target
    return [
      `Pending activation requires your decision (slotKey: ${slot.slotKey}).`,
      `Subscription ${subscription?.label ?? slot.subscriptionId}: ${sourceLabel} → ${targetLabel}, triggered by ${slot.reportId ? `report ${slot.reportId}` : 'a finished turn'} from ${sourceLabel}.`,
      `To allow it, call mcp__orrery_membrane__approve_activation exactly once with {"slotKey":"${slot.slotKey}"} — you may add "note" with extra instructions for the target.`,
      `To reject it, call mcp__orrery_membrane__deny_activation exactly once with {"slotKey":"${slot.slotKey}","reason":"..."}.`,
      'Then stop.',
    ].join('\n')
  }

  async #notifyMasterOfPending(slot, subscription, event, ctx) {
    const master = this.#state.sessions[slot.masterSessionId]
    if (!master) {
      return
    }
    const request = this.#pendingRequestText(slot, subscription)
    try {
      await this.#cmdActivate(
        { sessionId: slot.masterSessionId, note: request },
        { actor: ctx.actor, causeId: slot.triggerEventId }
      )
    } catch {
      // Master is busy (or frozen): park the request in its channel so the
      // next activation surfaces it.
      try {
        this.#deliverToChannel(
          {
            target: slot.masterSessionId,
            from: undefined,
            topic: `pending-${slot.slotKey}`,
            note: request,
          },
          { actor: ctx.actor, causeId: slot.triggerEventId }
        )
      } catch {
        // Nothing else to do; the slot stays approvable via UI/CLI.
      }
    }
  }

  async #cmdApproveActivation(input: JsonRecord = {}, ctx: JsonRecord) {
    const slotKey = optionalTrimmedString(input.slotKey)
    const slot = slotKey ? this.#state.pendingActivations?.[slotKey] : undefined
    if (!slot) {
      throw new Error(`Unknown pending activation: ${slotKey ?? ''}`)
    }
    this.#assertGateAuthority(slot, ctx)
    if (slot.status !== 'approved') {
      slot.status = 'approved'
      slot.approvalNote = optionalTrimmedString(input.note)
      slot.approvedBy = ctx.actor
      this.#appendKernelEvent(
        'activation.approved',
        { subscriptionId: slot.subscriptionId, target: slot.target, slotKey },
        ctx,
        { reason: ctx.reason ?? slot.approvalNote }
      )
      this.#touch()
    }
    await this.#drainApprovedSlots()
    return { ok: true, slotKey }
  }

  #cmdDenyActivation(input: JsonRecord = {}, ctx: JsonRecord) {
    const slotKey = optionalTrimmedString(input.slotKey)
    const slot = slotKey ? this.#state.pendingActivations?.[slotKey] : undefined
    if (!slot) {
      throw new Error(`Unknown pending activation: ${slotKey ?? ''}`)
    }
    this.#assertGateAuthority(slot, ctx)
    delete this.#state.pendingActivations[slotKey]
    this.#appendKernelEvent(
      'activation.denied',
      { subscriptionId: slot.subscriptionId, target: slot.target, slotKey },
      ctx,
      { reason: ctx.reason ?? optionalTrimmedString(input.reason) }
    )
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { ok: true, slotKey }
  }

  #assertGateAuthority(slot, ctx: JsonRecord) {
    const kind = ctx.actor?.kind
    if (kind === 'human' || kind === 'rule' || kind === 'runtime') {
      return
    }
    // Authority is recomputed live (R1) so a master reassignment takes
    // effect on already-parked slots: the demoted master loses the gate,
    // the new governor gains it.
    const subscription = this.#state.subscriptions?.[slot.subscriptionId]
    const governor = subscription
      ? governingMaster(this.#kernelView(), subscription)
      : slot.masterSessionId
    if (
      kind === 'master' &&
      governor &&
      ctx.actor?.ref === governor &&
      this.#state.sessions[governor]?.role === 'master'
    ) {
      return
    }
    throw new Error(
      `Session ${ctx.actor?.ref ?? ''} does not govern pending activation ${slot.slotKey}`
    )
  }

  // Executes approved slots whose targets are free. Called after every
  // scheduler event; targets going idle (session.finished) re-drain here —
  // this is where coalesce's "fire once when idle, with the latest context"
  // becomes real.
  async #drainApprovedSlots() {
    // Oldest pending fact first: this is the ordered drain for queue
    // backlogs (§6.1). Coalesce/drop/interrupt hold at most one slot per
    // edge, so the order is inert for them. Firing a queue entry makes the
    // target busy, so the rest of its backlog parks until the next drain.
    const slots = Object.values(
      (this.#state.pendingActivations ?? {}) as JsonRecord
    )
      .filter((slot) => slot.status === 'approved')
      .sort((a, b) => (a.orderSeq ?? 0) - (b.orderSeq ?? 0))
    for (const slot of slots) {
      if (!this.#state.pendingActivations?.[slot.slotKey]) {
        continue
      }
      const target = this.#state.sessions[slot.target]
      const subscription = this.#state.subscriptions?.[slot.subscriptionId]
      if (!target || !subscription || subscription.state !== 'active') {
        delete this.#state.pendingActivations[slot.slotKey]
        this.#appendKernelEvent(
          'activation.dropped',
          { subscriptionId: slot.subscriptionId, target: slot.target, slotKey: slot.slotKey },
          { actor: { kind: 'runtime' } },
          { reason: 'The subscription or target is gone.' }
        )
        continue
      }
      if (target.status === 'killed' || target.status === 'failed') {
        delete this.#state.pendingActivations[slot.slotKey]
        this.#appendKernelEvent(
          'activation.dropped',
          { subscriptionId: slot.subscriptionId, target: slot.target, slotKey: slot.slotKey },
          { actor: { kind: 'runtime' } },
          { reason: `Target session is ${target.status}.` }
        )
        continue
      }
      if (
        this.#runs.has(slot.target) ||
        target.status === 'running' ||
        target.status === 'pending' ||
        this.#isSessionFrozen(slot.target)
      ) {
        // Busy or frozen: the slot is the dirty flag (§5/§6.1); it fires on
        // a later drain.
        continue
      }
      await this.#executeApprovedSlot(slot, subscription)
    }
  }

  async #executeApprovedSlot(slot, subscription) {
    const ctx = this.#subscriptionRuleCtx(slot.subscriptionId, slot.triggerEventId)
    try {
      // Data first (§2.5): the firing's payload is the trigger source's
      // artifact bundle (plus the rendered report for report triggers).
      if (slot.sourceSessionId && this.#state.sessions[slot.sourceSessionId]) {
        const entries = this.#firingEntries(slot.sourceSessionId, slot.reportId)
        if (entries.length > 0) {
          this.#deliverToChannel(
            {
              target: slot.target,
              from: slot.sourceSessionId,
              topic: subscription.action.topic,
              entries,
              subscriptionId: slot.subscriptionId,
            },
            ctx
          )
        }
      }

      const note = [subscription.action.note, slot.approvalNote]
        .filter(Boolean)
        .join('\n\n')
      delete this.#state.pendingActivations[slot.slotKey]
      await this.#runActivation(slot.target, {
        note: note.length > 0 ? note : undefined,
        ctx: {
          actor: slot.approvedBy?.kind === 'master' ? slot.approvedBy : ctx.actor,
          causeId: slot.triggerEventId,
        },
        edgeSourceSessionId:
          slot.approvedBy?.kind === 'master' ? slot.approvedBy.ref : undefined,
        subscriptionId: slot.subscriptionId,
        slotKey: slot.slotKey,
      })
      subscription.firings += 1
      this.#syncLoopStateForSubscription(subscription, 'activated')
      this.#touch()
      this.#broadcast({ type: 'runtime.state', state: this.getState() })
    } catch (error) {
      console.error(
        `Approved activation ${slot.slotKey} failed to execute: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  // The payload of a subscription firing: the trigger source's artifact
  // bundle; report triggers lead with the rendered report instead of the
  // turn summary.
  #firingEntries(sourceSessionId, reportId) {
    const report = reportId
      ? this.#state.reports.find((item) => item.id === reportId)
      : undefined
    if (!report) {
      return this.#artifactBundleEntries(sourceSessionId)
    }
    return [
      { name: 'review.md', content: this.#renderReportMarkdown(report) },
      ...this.#artifactBundleEntries(sourceSessionId).filter(
        (entry) => entry.name !== 'turn-summary.md'
      ),
    ]
  }

  #renderReportMarkdown(report) {
    const payload = report.payload ?? {}
    const lines = [`# Report from ${this.#state.sessions[report.from]?.label ?? report.from}`]
    if (payload.type === 'verdict') {
      lines.push(`Verdict: ${payload.verdict}`)
      if (payload.summary) {
        lines.push('', String(payload.summary))
      }
      const issues = Array.isArray(payload.issues) ? payload.issues : []
      if (issues.length > 0) {
        lines.push('', '## Issues')
        for (const issue of issues) {
          const location = [issue.file, Number.isFinite(issue.line) ? issue.line : undefined]
            .filter(Boolean)
            .join(':')
          lines.push(`- ${issue.message}${location ? ` (${location})` : ''}`)
        }
      }
    } else {
      lines.push('', JSON.stringify(payload, null, 2))
    }
    return `${lines.join('\n')}\n`
  }

  // --- Subscription authoring / stopping ---

  #cmdAuthorSubscription(input: JsonRecord = {}, ctx: JsonRecord) {
    const subscription = this.#normalizeSubscriptionInput(input)

    // Static safety check on the prospective intent graph (§6.4).
    const prospective = this.#kernelView()
    prospective.subscriptions[subscription.id] = clone(subscription)
    let check = staticCheck(prospective)

    const onCycle = check.cyclicSubscriptionIds.includes(subscription.id)
    if (!input.gate) {
      // Default rule: master on cycles, auto elsewhere (§6.1).
      subscription.gate = onCycle ? 'master' : 'auto'
      prospective.subscriptions[subscription.id].gate = subscription.gate
    }
    const guarded = []
    for (const id of check.needsDefaultMaxFirings) {
      if (id === subscription.id) {
        subscription.stop = {
          ...(subscription.stop ?? {}),
          maxFirings: defaultCycleMaxFirings,
        }
        prospective.subscriptions[id].stop = clone(subscription.stop)
        guarded.push(id)
        continue
      }
      const existing = this.#state.subscriptions?.[id]
      if (existing) {
        existing.stop = {
          ...(existing.stop ?? {}),
          maxFirings: defaultCycleMaxFirings,
        }
        prospective.subscriptions[id].stop = clone(existing.stop)
        guarded.push(id)
        this.#appendKernelEvent(
          'subscription.guarded',
          { subscriptionId: id, maxFirings: defaultCycleMaxFirings },
          { actor: { kind: 'runtime' } },
          { reason: 'Static cycle check applied the default maxFirings guardrail.' }
        )
      }
    }
    check = staticCheck(prospective)
    if (!check.ok) {
      throw new Error(
        'Subscription would create an unguarded activation cycle; add a stop condition or a non-auto gate.'
      )
    }

    this.#state.subscriptions = this.#state.subscriptions ?? {}
    this.#state.subscriptions[subscription.id] = subscription
    this.#appendKernelEvent(
      'subscription.authored',
      { subscription: clone(subscription) },
      ctx,
      { reason: ctx.reason ?? optionalTrimmedString(input.reason) }
    )
    this.#syncLoopStateForSubscription(subscription, 'subscription.authored')
    this.#syncTimerForSubscription(subscription)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return {
      subscription: clone(subscription),
      staticCheck: {
        onCycle,
        cyclicSubscriptionIds: check.cyclicSubscriptionIds,
        guardedSubscriptionIds: guarded,
      },
    }
  }

  #normalizeSubscriptionInput(input: JsonRecord = {}) {
    const sourceSessionId = optionalTrimmedString(input.sourceSessionId)
    const sourceClusterId = optionalTrimmedString(input.sourceClusterId)
    let source = isObject(input.source) ? input.source : undefined
    if (!source && sourceSessionId) {
      source = { kind: 'session', sessionId: sourceSessionId }
    }
    if (!source && sourceClusterId) {
      source = { kind: 'cluster', clusterId: sourceClusterId }
    }
    if (
      !source ||
      (source.kind === 'session' && !this.#state.sessions[source.sessionId]) ||
      (source.kind === 'cluster' && !this.#state.clusters[source.clusterId]) ||
      (source.kind !== 'session' && source.kind !== 'cluster' && source.kind !== 'timer')
    ) {
      throw new Error(
        'Subscription source must be an existing session or cluster, or {kind:"timer"}'
      )
    }

    const targetSessionId =
      optionalTrimmedString(input.targetSessionId) ??
      (isObject(input.target) ? optionalTrimmedString(input.target.sessionId) : undefined)
    if (!targetSessionId || !this.#state.sessions[targetSessionId]) {
      throw new Error('Subscription target must be an existing session')
    }

    const on = isObject(input.on) ? input.on : { on: input.on }
    if (!validSubscriptionPatterns.has(on.on)) {
      throw new Error(
        `Subscription pattern must be one of finished|failed|report|delivered|schedule`
      )
    }
    // Timer source ⟺ schedule pattern: a clock emits nothing but ticks, and
    // a schedule can be driven by nothing but a clock.
    if ((source.kind === 'timer') !== (on.on === 'schedule')) {
      throw new Error(
        'A schedule pattern requires source {kind:"timer"}, and a timer source requires the schedule pattern'
      )
    }
    const pattern: JsonRecord = { on: on.on }
    if (on.on === 'report' && isObject(on.match)) {
      pattern.match = {
        ...(optionalTrimmedString(on.match.type) ? { type: on.match.type.trim() } : {}),
        ...(optionalTrimmedString(on.match.verdict)
          ? { verdict: on.match.verdict.trim() }
          : {}),
      }
    }
    if (on.on === 'delivered' && optionalTrimmedString(on.topic)) {
      pattern.topic = on.topic.trim()
    }
    if (on.on === 'schedule') {
      // Exactly one schedule form: an interval or a wall-clock daily time
      // (the cron-shaped case the proposal's morning-report scenario needs).
      const hasInterval = on.everySeconds !== undefined
      const hasDailyAt = optionalTrimmedString(on.dailyAt) !== undefined
      if (hasInterval === hasDailyAt) {
        throw new Error(
          'Subscription schedule requires exactly one of everySeconds or dailyAt'
        )
      }
      if (hasDailyAt) {
        const dailyAt = normalizeDailyAt(on.dailyAt.trim())
        if (!dailyAt) {
          throw new Error(
            'Subscription schedule.dailyAt must be HH:MM (24h, runtime-host local time)'
          )
        }
        pattern.dailyAt = dailyAt
      } else {
        const everySeconds = Number(on.everySeconds)
        const minimum = timerMinIntervalSeconds()
        if (!Number.isInteger(everySeconds) || everySeconds < minimum) {
          throw new Error(
            `Subscription schedule.everySeconds must be an integer >= ${minimum}`
          )
        }
        pattern.everySeconds = everySeconds
      }
    }

    const action = isObject(input.action) ? input.action : { kind: input.action }
    if (action.kind === 'create') {
      throw new Error('Subscription action "create" lands in a later version; use a one-shot command')
    }
    if (action.kind !== 'deliver' && action.kind !== 'deliver+activate') {
      throw new Error('Subscription action must be deliver or deliver+activate')
    }
    if (source.kind === 'timer' && action.kind !== 'deliver+activate') {
      // A clock has no artifacts to forward; a deliver-only schedule would
      // fire empty deliveries forever.
      throw new Error('A timer subscription requires action deliver+activate')
    }

    const gate = optionalTrimmedString(input.gate)
    if (gate && !validSubscriptionGates.has(gate)) {
      throw new Error('Subscription gate must be auto, master, or human')
    }
    const concurrency = optionalTrimmedString(input.concurrency) ?? 'coalesce'
    if (!validSubscriptionConcurrencies.has(concurrency)) {
      throw new Error('Subscription concurrency must be coalesce, queue, drop, or interrupt')
    }
    if (source.kind === 'timer' && concurrency === 'queue') {
      // Ticks are fungible: a backlog of stale ticks is exactly the
      // anti-pattern §6.1 warns about, so timer edges never queue even
      // though session/cluster edges may keep an ordered backlog.
      throw new Error(
        'A timer subscription cannot use queue concurrency; ticks coalesce (or drop/interrupt)'
      )
    }
    const onStop = optionalTrimmedString(input.onStop) ?? 'freeze-edge'
    if (!validSubscriptionOnStops.has(onStop)) {
      throw new Error('Subscription onStop must be freeze-edge, freeze-target, or freeze-cluster')
    }

    let stop
    if (isObject(input.stop)) {
      stop = {}
      if (isObject(input.stop.whenReport) && optionalTrimmedString(input.stop.whenReport.verdict)) {
        stop.whenReport = { verdict: input.stop.whenReport.verdict.trim() }
      }
      if (input.stop.maxFirings !== undefined) {
        const maxFirings = Number(input.stop.maxFirings)
        if (!Number.isInteger(maxFirings) || maxFirings <= 0) {
          throw new Error('Subscription stop.maxFirings must be a positive integer')
        }
        stop.maxFirings = maxFirings
      }
      if (optionalTrimmedString(input.stop.deadline)) {
        if (Number.isNaN(Date.parse(input.stop.deadline))) {
          throw new Error('Subscription stop.deadline must be a parseable date-time')
        }
        stop.deadline = input.stop.deadline.trim()
      }
      if (Object.keys(stop).length === 0) {
        stop = undefined
      }
    }

    // A scheduled activation carries no upstream artifacts, so the note is
    // the whole activation message; default to a deterministic template.
    const note = optionalTrimmedString(action.note)
      ?? (source.kind === 'timer'
        ? `Scheduled activation: this session runs on a timer (${scheduleSummary(pattern as { on: 'schedule' })}).`
        : undefined)

    return {
      id: optionalTrimmedString(input.id) ?? `sub-${randomUUID().slice(0, 8)}`,
      source:
        source.kind === 'session'
          ? { kind: 'session', sessionId: source.sessionId }
          : source.kind === 'timer'
            ? { kind: 'timer' }
            : { kind: 'cluster', clusterId: source.clusterId },
      on: pattern,
      target: { kind: 'session', sessionId: targetSessionId },
      action: {
        kind: action.kind,
        ...(optionalTrimmedString(action.topic) ? { topic: action.topic.trim() } : {}),
        ...(note ? { note } : {}),
      },
      gate: gate ?? undefined,
      concurrency,
      stop,
      onStop,
      state: 'active',
      firings: 0,
      label: optionalTrimmedString(input.label),
      preset: optionalTrimmedString(input.preset),
      createdAt: now(),
    }
  }

  #cmdStopSubscription(input: JsonRecord = {}, ctx: JsonRecord) {
    const subscriptionId = optionalTrimmedString(input.subscriptionId)
    const subscription = subscriptionId
      ? this.#state.subscriptions?.[subscriptionId]
      : undefined
    if (!subscription) {
      throw new Error(`Unknown subscription: ${subscriptionId ?? ''}`)
    }
    if (subscription.state === 'stopped') {
      return { ok: true, subscription: clone(subscription) }
    }
    subscription.state = 'stopped'
    this.#clearTimer(subscriptionId)
    this.#appendKernelEvent(
      'subscription.stopped',
      { subscriptionId },
      ctx,
      { reason: ctx.reason ?? optionalTrimmedString(input.reason) }
    )
    this.#discardSlotsForSubscription(subscriptionId, ctx)
    this.#syncLoopStateForSubscription(subscription, 'subscription.stopped')
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { ok: true, subscription: clone(subscription) }
  }

  #stopSubscriptionsForKilledParticipant(event) {
    const sessionId =
      typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : undefined
    if (!sessionId) {
      return
    }
    for (const subscription of Object.values(
      (this.#state.subscriptions ?? {}) as JsonRecord
    )) {
      if (subscription.state !== 'active') {
        continue
      }
      const participates =
        subscription.target.sessionId === sessionId ||
        (subscription.source.kind === 'session' &&
          subscription.source.sessionId === sessionId)
      if (participates) {
        this.#cmdStopSubscription(
          {
            subscriptionId: subscription.id,
            reason: 'Participant session was killed.',
          },
          { actor: { kind: 'runtime' }, causeId: event.id }
        )
      }
    }
  }

  // --- L1 timer source: the clock as an external event source (§2.4) ---
  //
  // One armed setTimeout per active schedule subscription. A tick appends an
  // `external.timer` fact; matching, gate, coalesce, and stop conditions all
  // run through the ordinary scheduler path — the timer service knows nothing
  // about activation. Handles are unref'd so an idle runtime can exit.
  //
  // Restart catch-up (proposal L1): the next tick is computed from
  // lastTickAt, so downtime longer than the interval yields delay 0 — exactly
  // one immediate catch-up tick, never a replay of the missed backlog.

  #timerDelayMs(subscription) {
    const anchor = Date.parse(subscription.lastTickAt ?? subscription.createdAt ?? '')
    return scheduleDelayMs(subscription.on ?? {}, anchor, Date.now())
  }

  #syncTimerForSubscription(subscription) {
    if (!subscription || subscription.on?.on !== 'schedule') {
      return
    }
    this.#clearTimer(subscription.id)
    if (subscription.state !== 'active') {
      return
    }
    const handle = setTimeout(
      () => this.#fireTimerTick(subscription.id),
      this.#timerDelayMs(subscription)
    )
    handle.unref?.()
    this.#timers.set(subscription.id, handle)
  }

  #clearTimer(subscriptionId) {
    const handle = this.#timers.get(subscriptionId)
    if (handle) {
      clearTimeout(handle)
      this.#timers.delete(subscriptionId)
    }
  }

  #clearAllTimers() {
    for (const subscriptionId of [...this.#timers.keys()]) {
      this.#clearTimer(subscriptionId)
    }
  }

  #fireTimerTick(subscriptionId) {
    this.#timers.delete(subscriptionId)
    const subscription = this.#state.subscriptions?.[subscriptionId]
    if (
      !subscription ||
      subscription.state !== 'active' ||
      subscription.on?.on !== 'schedule'
    ) {
      return
    }
    // Kill parity at the source: a killed target can never be activated
    // again, so ticking it would only churn create/drop pairs forever.
    const target = this.#state.sessions[subscription.target.sessionId]
    if (!target || target.status === 'killed') {
      this.#cmdStopSubscription(
        {
          subscriptionId,
          reason: 'Participant session was killed.',
        },
        { actor: { kind: 'runtime' } }
      )
      return
    }
    // Log first (events are truth): the snapshot's lastTickAt is a cache of
    // the appended fact's ts, and fold() derives the same value on replay.
    // No `sessionId` key on purpose: a tick has no source session, and
    // eventSourceSession() must not mistake the target for one.
    const tickEvent = this.#appendKernelEvent(
      'external.timer',
      {
        subscriptionId,
        targetSessionId: subscription.target.sessionId,
        ...(subscription.on.everySeconds !== undefined
          ? { everySeconds: subscription.on.everySeconds }
          : {}),
        ...(subscription.on.dailyAt !== undefined
          ? { dailyAt: subscription.on.dailyAt }
          : {}),
      },
      { actor: { kind: 'runtime' } },
      { reason: `Timer tick (${scheduleSummary(subscription.on)}).` }
    )
    subscription.lastTickAt = tickEvent?.ts ?? now()
    this.#touch()
    this.#syncTimerForSubscription(subscription)
  }

  #recoverTimers() {
    for (const subscription of Object.values(
      (this.#state.subscriptions ?? {}) as JsonRecord
    )) {
      if (subscription.on?.on !== 'schedule' || subscription.state !== 'active') {
        continue
      }
      // Reconcile the tick anchor from the event log before arming: the
      // snapshot may be older than the last appended tick (events are
      // truth). Exact per-subscription lookup — a bounded tail scan could
      // miss the latest tick of a quiet, long-interval subscription.
      const logged = this.#kernelStore.latestEventWithPayloadValue(
        'external.timer',
        'subscriptionId',
        subscription.id
      )
      // An unparseable cached anchor counts as missing — otherwise the
      // NaN comparison would silently discard the exact logged fact.
      const cachedMs = Date.parse(subscription.lastTickAt ?? '')
      if (
        logged &&
        (!Number.isFinite(cachedMs) || Date.parse(logged.ts) > cachedMs)
      ) {
        subscription.lastTickAt = logged.ts
      }
      this.#syncTimerForSubscription(subscription)
    }
  }

  // Kill parity across restarts: the session.killed scheduler sweep is
  // async, so a shutdown can persist a snapshot where a participant is
  // killed but its subscriptions are still active. Re-run the sweep on load
  // so recovery (and #recoverTimers) never resurrects such an edge.
  #sweepKilledParticipantSubscriptions() {
    for (const subscription of Object.values(
      (this.#state.subscriptions ?? {}) as JsonRecord
    )) {
      if (subscription.state !== 'active') {
        continue
      }
      const participants = [
        subscription.target?.sessionId,
        subscription.source?.kind === 'session'
          ? subscription.source.sessionId
          : undefined,
      ].filter(Boolean)
      if (
        participants.some(
          (sessionId) => this.#state.sessions[sessionId]?.status === 'killed'
        )
      ) {
        this.#cmdStopSubscription(
          {
            subscriptionId: subscription.id,
            reason: 'Participant session was killed.',
          },
          { actor: { kind: 'runtime' } }
        )
      }
    }
  }

  #discardSlotsForSubscription(subscriptionId, ctx) {
    for (const slot of Object.values(
      (this.#state.pendingActivations ?? {}) as JsonRecord
    )) {
      if (slot.subscriptionId === subscriptionId) {
        delete this.#state.pendingActivations[slot.slotKey]
        this.#appendKernelEvent(
          'activation.dropped',
          { subscriptionId, target: slot.target, slotKey: slot.slotKey },
          ctx,
          { reason: 'The subscription stopped.' }
        )
      }
    }
  }

  // Scheduler-driven stop (a stop condition fired): the subscription stops
  // AND its onStop escalation runs (§6.2).
  async #stopSubscriptionWithOnStop(decision, ctx) {
    const subscription = this.#state.subscriptions?.[decision.subscriptionId]
    if (!subscription || subscription.state === 'stopped') {
      return
    }
    this.#cmdStopSubscription(
      { subscriptionId: decision.subscriptionId },
      { ...ctx, reason: decision.reason }
    )
    if (decision.onStop === 'freeze-target') {
      this.#applyFreeze(
        { targetId: subscription.target.sessionId, reason: decision.reason },
        ctx
      )
      return
    }
    if (decision.onStop === 'freeze-cluster') {
      const clusterId =
        this.#managedClusterId(subscription.target.sessionId) ??
        this.#managedClusterId(
          subscription.source.kind === 'session'
            ? subscription.source.sessionId
            : undefined
        ) ??
        (subscription.source.kind === 'cluster'
          ? subscription.source.clusterId
          : undefined)
      this.#applyFreeze(
        {
          targetId: clusterId ?? subscription.target.sessionId,
          reason: decision.reason,
        },
        ctx
      )
    }
  }

  // Keeps the renderer-facing cluster.loopState in sync for preset-compiled
  // loop subscriptions (the old loop state machine is gone; this is a
  // derived view).
  #syncLoopStateForSubscription(subscription, lastEventType) {
    const preset = optionalTrimmedString(subscription?.preset)
    if (!preset || !preset.startsWith('hero-loop:')) {
      return
    }
    const clusterId = preset.slice('hero-loop:'.length)
    this.#syncLoopStateForCluster(clusterId, lastEventType)
  }

  #loopSubscriptionsForCluster(clusterId) {
    return Object.values((this.#state.subscriptions ?? {}) as JsonRecord).filter(
      (subscription) => subscription.preset === `hero-loop:${clusterId}`
    )
  }

  #syncLoopStateForCluster(clusterId, lastEventType) {
    const cluster = this.#state.clusters[clusterId]
    if (!cluster) {
      return
    }
    const subs = this.#loopSubscriptionsForCluster(clusterId)
    if (subs.length === 0) {
      return
    }
    const s1 = subs.find((subscription) => subscription.label === 'S1')
    const s2 = subs.find((subscription) => subscription.label === 'S2')
    const running = subs.some((subscription) => subscription.state === 'active')
    const previous = cluster.loopState ?? {}
    cluster.loopState = {
      status: running ? 'running' : 'stopped',
      iterations: s2?.firings ?? 0,
      coderSessionId: s2?.target.sessionId,
      reviewerSessionId: s1?.target.sessionId,
      lastEvent: lastEventType
        ? { type: lastEventType, ts: now() }
        : previous.lastEvent,
      reason: running
        ? `Loop subscriptions active (S2 firings: ${s2?.firings ?? 0}).`
        : previous.reason ?? 'Loop subscriptions stopped.',
      startedAt: previous.startedAt,
      stoppedAt: running ? undefined : previous.stoppedAt ?? now(),
    }
  }

  #appendKernelEvent(type, payload, ctx, { reason }: JsonRecord = {}) {
    const event = this.#kernelStore.appendEvent({
      type,
      actor: ctx?.actor ?? { kind: 'runtime' },
      causeId: ctx?.causeId,
      reason: reason ?? ctx?.reason,
      payload,
    })
    if (event) {
      // Lightweight broadcast (no state payload); the canvas timeline and
      // acceptance scenarios can follow the kernel log live.
      this.#broadcast({ type: 'kernel.event', event })
      // Every kernel fact flows through the subscription scheduler (§2.4):
      // Log → fold → State → match → Pending → gate → Commands.
      this.#enqueueSchedulerEvent(event)
    }
    return event
  }

  listSessionSummaries() {
    const sessions = Object.values(this.#state.sessions ?? {})
      .map((session) => this.#sessionSummary(session))
      .sort((left, right) =>
        String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
      )
    return { sessions }
  }

  getSessionView(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const session = this.#requireSession(request.sessionId)
    const view = optionalTrimmedString(request.view) ?? 'summary'
    if (view === 'summary') {
      return { view, session: this.#sessionSummary(session) }
    }
    if (view === 'raw') {
      return { view, session: clone(session) }
    }
    if (view === 'transcript') {
      return {
        view,
        session: this.#sessionSummary(session),
        projection: projectSession(clone(session)),
      }
    }
    throw new Error(`Unknown session view: ${view}`)
  }

  getGraphTopology() {
    return clone({
      version: this.#state.version,
      updatedAt: this.#state.updatedAt,
      nodes: this.#state.nodes,
      edges: this.#state.edges,
      clusters: this.#state.clusters,
    })
  }

  getSessionEvents(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const session = this.#requireSession(request.sessionId)
    const events = session.runtimeEvents ?? []
    const since = optionalTrimmedString(request.since)
    let startIndex = 0
    let reset = false
    if (since) {
      const sinceIndex = events.findIndex((event) => event.id === since)
      if (sinceIndex >= 0) {
        startIndex = sinceIndex + 1
      } else {
        // Cursor fell out of the truncated event window (or never existed):
        // replay from the start and let the caller resynchronize.
        reset = true
      }
    }
    return {
      sessionId: session.sessionId,
      status: session.status,
      events: clone(events.slice(startIndex)),
      cursor: events.at(-1)?.id,
      reset,
    }
  }

  #requireSession(sessionId) {
    const id = optionalTrimmedString(sessionId)
    const session = id ? this.#state.sessions[id] : undefined
    if (!session) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    return session
  }

  #sessionSummary(session) {
    const node = this.#state.nodes.find(
      (candidate) => candidate.sessionId === session.sessionId
    )
    return {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      label: session.label,
      role: session.role,
      status: session.status,
      providerKind: session.providerKind,
      providerInstanceId: session.providerInstanceId,
      agent: session.agent,
      cwd: session.cwd,
      project: clone(session.project),
      clusterId: node?.clusterId,
      frozen: node?.frozen,
      archived: session.archived,
      error: session.error,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      finishedAt: session.finishedAt,
      messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      runtimeSettings: clone(session.runtimeSettings),
    }
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

  createTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const sessionId = optionalTrimmedString(request.sessionId)
    const session = sessionId ? this.#state.sessions[sessionId] : undefined
    if (!session) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const cwd = validateRunnableCwd(request.cwd ?? session.cwd)
    const existing = this.#runningTerminalForSession(sessionId, cwd)
    if (existing) {
      return { ok: true, terminal: this.#cloneTerminal(existing.terminalId) }
    }

    const shell = defaultTerminalShell()
    const terminalId = randomUUID()
    const ts = now()
    const terminal = {
      terminalId,
      sessionId,
      cwd,
      shell: terminalShellLabel(shell.command, shell.args),
      prompt: terminalPrompt(cwd),
      status: 'running',
      createdAt: ts,
      updatedAt: ts,
      chunks: [],
    }
    const child = spawn(shell.command, shell.args, {
      cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? 'xterm-256color',
        ORRERY_SESSION_ID: sessionId,
        ORRERY_TERMINAL_ID: terminalId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const run = {
      child,
      terminal,
      stdoutLineBuffer: '',
    }

    this.#terminals.set(terminalId, terminal)
    this.#terminalRuns.set(terminalId, run)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data) =>
      this.#appendTerminalStdout(terminalId, String(data))
    )
    child.stderr.on('data', (data) =>
      this.#appendTerminalChunk(terminalId, 'stderr', String(data))
    )
    child.once('error', (error) => {
      this.#appendTerminalChunk(
        terminalId,
        'system',
        `Terminal failed: ${error.message}\n`
      )
    })
    child.once('close', (code, signal) =>
      this.#handleTerminalClose(terminalId, code, signal)
    )

    this.#broadcast({
      type: 'terminal.created',
      terminal: this.#cloneTerminal(terminalId),
    })
    this.#appendTerminalChunk(
      terminalId,
      'system',
      `Orrery terminal attached to ${cwd}\n`
    )

    return { ok: true, terminal: this.#cloneTerminal(terminalId) }
  }

  getTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const terminal = this.#terminalById(request.terminalId)
    return { ok: true, terminal: this.#cloneTerminal(terminal.terminalId) }
  }

  runTerminalCommand(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const run = this.#runningTerminalRun(request.terminalId)
    const terminal = run.terminal
    if (typeof request.command !== 'string') {
      throw new Error('Terminal command must be a string.')
    }
    const command = request.command
    if (terminal.currentCommand?.status === 'running') {
      throw new Error('Terminal command is already running.')
    }

    const commandId = randomUUID()
    const ts = now()
    terminal.currentCommand = {
      commandId,
      command,
      status: 'running',
      startedAt: ts,
    }
    terminal.updatedAt = ts
    this.#appendTerminalChunk(
      terminal.terminalId,
      'stdin',
      `${terminal.prompt ?? terminalPrompt(terminal.cwd)}${command}\n`
    )
    run.child.stdin.write(`${command}\n${terminalCommandSentinel(commandId)}\n`)

    return {
      ok: true,
      commandId,
      terminal: this.#cloneTerminal(terminal.terminalId),
    }
  }

  writeTerminalInput(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const run = this.#runningTerminalRun(request.terminalId)
    if (typeof request.input !== 'string') {
      throw new Error('Terminal stdin input must be a string.')
    }

    run.child.stdin.write(request.input)
    run.terminal.updatedAt = now()
    return { ok: true, terminal: this.#cloneTerminal(run.terminal.terminalId) }
  }

  clearTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const terminal = this.#terminalById(request.terminalId)
    terminal.chunks = []
    terminal.updatedAt = now()
    this.#broadcast({
      type: 'terminal.cleared',
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      terminal: this.#cloneTerminal(terminal.terminalId),
    })
    return { ok: true, terminal: this.#cloneTerminal(terminal.terminalId) }
  }

  closeTerminal(input: JsonRecord = {}) {
    const request = isObject(input) ? input : {}
    const terminal = this.#terminalById(request.terminalId)
    const run = this.#terminalRuns.get(terminal.terminalId)
    terminal.status = 'closed'
    terminal.updatedAt = now()

    if (run) {
      try {
        run.child.stdin.end()
      } catch {
        // Process may already have closed stdin.
      }
      try {
        run.child.kill()
      } catch {
        // Closing is best-effort once the shell process is already gone.
      }
    }

    this.#broadcast({
      type: 'terminal.closed',
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      terminal: this.#cloneTerminal(terminal.terminalId),
    })
    return { ok: true, terminal: this.#cloneTerminal(terminal.terminalId) }
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
    return this.#cmdUpsertProviderInstance(input, this.#humanCtx())
  }

  #cmdUpsertProviderInstance(input: JsonRecord = {}, ctx: JsonRecord) {
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
    this.#appendKernelEvent(
      'provider.instance-upserted',
      {
        providerInstanceId: providerInstance.providerInstanceId,
        kind: providerInstance.kind,
      },
      ctx
    )
    this.#touch()
    this.#broadcast({ type: 'provider.instances.updated', state: this.getState() })
    return { providerInstance: clone(providerInstance), state: this.getState() }
  }

  async createSession(input: JsonRecord = {}) {
    return this.#cmdCreateSession(input, this.#humanCtx())
  }

  async #cmdCreateSession(input: JsonRecord = {}, ctx: JsonRecord) {
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
    // Everything that can reject the command must run before the channel is
    // written: a failed create must not leave an orphan delivery with no
    // `delivered` fact behind it (events are the truth, files follow).
    const runtimeSettings = normalizeProviderRuntimeSettings(input.runtimeSettings)
    const workspace =
      normalizeWorkMode(input.workMode) === 'worktree'
        ? createSessionWorktree(input.cwd, sessionId, input.branch)
        : localSessionWorkspace(input.cwd, input.branch)
    const cwd = workspace.cwd

    // Handoff content is pre-seeded into the new session's channel instead
    // of being inlined into the prompt (§4.1 create_session): the chat
    // history starts with a short bootstrap plus the delivery listing, and
    // large payloads never scroll out of the context window.
    const handoffContext =
      typeof input.context === 'string' && input.context.trim().length > 0
        ? input.context
        : undefined
    let handoffDelivery
    if (handoffContext) {
      handoffDelivery = this.#channelStore.deliver({
        target: sessionId,
        from: sourceSessionId ?? 'human',
        fromLabel: sourceSessionId
          ? this.#state.sessions[sourceSessionId]?.label
          : undefined,
        topic: optionalTrimmedString(input.contextTopic) ?? 'handoff',
        entries: [{ name: 'context.md', content: handoffContext }],
      })
    }
    const preamble = handoffDelivery
      ? activationPreamble(this.#channelStore.unread(sessionId), {
          channelDir: this.#channelStore.channelDir(sessionId),
        })
      : undefined
    const initialContent = [prompt, preamble].filter(Boolean).join('\n\n')
    const providerPrompt = providerPromptContent({
      providerKind: provider.providerKind,
      message: initialContent,
      context: undefined,
      attachments,
    })
    if (handoffDelivery) {
      this.#channelStore.markRead(sessionId, handoffDelivery.seq)
    }
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
    const createdEvent = this.#appendKernelEvent(
      'session.created',
      {
        sessionId,
        label,
        role,
        providerKind: provider.providerKind,
        agent: provider.agent,
        clusterId: cluster,
        sourceSessionId,
        cwd,
      },
      ctx,
      { reason: ctx.reason ?? this.#masterReasonFromInput(sourceSessionId, input) }
    )
    if (handoffDelivery) {
      // The channel write happened before message composition; the fact
      // lands after session.created so the log reads create → deliver (§8.1).
      this.#appendKernelEvent(
        'delivered',
        {
          source: sourceSessionId ?? 'human',
          target: sessionId,
          topic: handoffDelivery.topic,
          channelSeq: handoffDelivery.seq,
          files: handoffDelivery.files,
        },
        { ...ctx, causeId: createdEvent?.id ?? ctx.causeId }
      )
    }
    this.#touch()
    this.#broadcast({ type: 'session.created', sessionId, state: this.getState() })

    await this.#startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: 'create',
      userMessageId: this.#state.sessions[sessionId].messages[0].id,
      activationEventId: createdEvent?.id,
      // Same rollback contract as activations: if the first run dies before
      // producing output, the pre-seeded handoff becomes unread again.
      channelReadSeqs: handoffDelivery ? [handoffDelivery.seq] : [],
    })

    return { sessionId, state: this.getState() }
  }

  async resumeSession(input: JsonRecord = {}) {
    return this.#cmdResumeSession(input, this.#humanCtx())
  }

  deliverToSession(input: JsonRecord = {}) {
    return this.#cmdDeliver(input, this.#humanCtx())
  }

  async activateSession(input: JsonRecord = {}) {
    return this.#cmdActivate(input, this.#humanCtx())
  }

  // resume = deliver + activate (kernel doc §4.1). The external verb stays
  // compatible: context (when present) lands in the target's channel as a
  // delivery instead of being inlined into the chat message, and the
  // activation message is the note plus the deterministic channel preamble.
  async #cmdResumeSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = input.sessionId
    this.#assertActivatable(sessionId, ctx)

    const message =
      typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message.trim()
        : undefined
    if (!message) {
      throw new Error('Resume message is required')
    }

    const context =
      typeof input.context === 'string' && input.context.trim().length > 0
        ? input.context
        : undefined
    if (context) {
      this.#deliverToChannel(
        {
          target: sessionId,
          from:
            optionalTrimmedString(input.edgeSourceSessionId) ??
            optionalTrimmedString(ctx.actor?.ref),
          topic: optionalTrimmedString(input.contextTopic) ?? 'context',
          entries: [{ name: 'context.md', content: context }],
        },
        ctx
      )
    }

    return this.#runActivation(sessionId, {
      note: message,
      attachments: normalizeChatAttachments(input.attachments),
      edgeSourceSessionId: optionalTrimmedString(input.edgeSourceSessionId),
      edgeInput: input,
      ctx,
    })
  }

  // Pure data-plane delivery (§4.1 deliver): writes to the target's channel
  // and records the `delivered` fact. Never activates.
  #cmdDeliver(input: JsonRecord = {}, ctx: JsonRecord) {
    const target = optionalTrimmedString(input.sessionId) ?? optionalTrimmedString(input.target)
    if (!target || !this.#state.sessions[target]) {
      throw new Error(`Unknown session: ${target ?? ''}`)
    }

    const topic = optionalTrimmedString(input.topic)
    const note = optionalTrimmedString(input.note)
    const content = typeof input.content === 'string' ? input.content : undefined
    // Attribution: a caller session (membrane actor.ref) cannot be spoofed;
    // rule actors reference a subscription rather than a session, so
    // subscription firings pass the trigger source explicitly instead.
    const actorRef = optionalTrimmedString(ctx.actor?.ref)
    const from =
      (actorRef && this.#state.sessions[actorRef] ? actorRef : undefined) ??
      optionalTrimmedString(input.source)

    let entries
    if (content) {
      entries = [
        {
          name: optionalTrimmedString(input.filename) ?? 'content.md',
          content,
        },
      ]
    } else if (from && this.#state.sessions[from]) {
      // No explicit payload: forward the source's artifact bundle — the
      // fixed convention for machine-fired deliveries (§4.2.6). Report
      // triggers additionally carry the rendered report.
      entries = this.#firingEntries(from, optionalTrimmedString(input.reportId))
    }
    if ((!entries || entries.length === 0) && !note) {
      throw new Error('deliver requires content, a note, or a session source with artifacts')
    }

    const delivery = this.#deliverToChannel(
      {
        target,
        from,
        topic,
        note,
        entries,
        subscriptionId: input.subscriptionId,
      },
      ctx
    )
    return {
      ok: true,
      delivery: {
        seq: delivery.seq,
        topic: delivery.topic,
        files: delivery.files,
      },
    }
  }

  // Pure activation (§4.1 activate): run one turn on the target with a
  // deterministically assembled message (note + unread channel preamble).
  async #cmdActivate(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = optionalTrimmedString(input.sessionId)
    this.#assertActivatable(sessionId, ctx)

    const note = optionalTrimmedString(input.note)
    const unread = this.#channelStore.unread(sessionId)
    if (!note && unread.current.length === 0) {
      throw new Error('activate requires a note or pending channel deliveries')
    }

    return this.#runActivation(sessionId, {
      note,
      attachments: normalizeChatAttachments(input.attachments),
      edgeSourceSessionId: optionalTrimmedString(input.edgeSourceSessionId),
      edgeInput: input,
      ctx,
    })
  }

  #assertActivatable(sessionId, ctx: JsonRecord) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
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
      this.#failSession(sessionId, message, {
        actor: { kind: 'runtime' },
        causeId: ctx.causeId,
      })
      throw error
    }
  }

  #deliverToChannel(
    { target, from, fromLabel, topic, note, entries, subscriptionId }: JsonRecord,
    ctx: JsonRecord
  ) {
    const sourceSession = from ? this.#state.sessions[from] : undefined
    const delivery = this.#channelStore.deliver({
      target,
      from: from ?? 'human',
      fromLabel: fromLabel ?? sourceSession?.label,
      topic,
      note,
      entries,
    })
    this.#appendKernelEvent(
      'delivered',
      {
        source: from ?? 'human',
        target,
        topic,
        channelSeq: delivery.seq,
        files: delivery.files,
        notePreview: truncateForLog(note, 200),
        // Provenance for subscription-fired deliveries; fold counts a
        // deliver-only subscription's firings from this field.
        subscriptionId: optionalTrimmedString(subscriptionId),
      },
      ctx
    )
    return delivery
  }

  // Assembles the source session's artifact bundle on demand: the last
  // assistant turn summary plus the workspace diff when there is one.
  #artifactBundleEntries(sessionId) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return []
    }
    const entries = []
    // Only completed turns feed the bundle (§4.2.6): a mid-stream delivery
    // must not snapshot a half-written assistant message.
    const lastAssistant = [...(session.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'complete' &&
          message.content
      )
    const summary = lastAssistant?.content ?? session.result
    if (typeof summary === 'string' && summary.trim().length > 0) {
      entries.push({ name: 'turn-summary.md', content: summary })
    }
    try {
      const diff = this.#gitDiffForSession(sessionId)
      if (typeof diff === 'string' && diff.trim().length > 0) {
        entries.push({ name: 'workspace-diff.patch', content: diff })
      }
      // An empty diff (no git repo / no changes) is a normal case: no file.
    } catch (error) {
      entries.push({
        name: 'workspace-diff-unavailable.md',
        content: `Workspace diff could not be captured: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      })
    }
    return entries
  }

  async #runActivation(
    sessionId,
    {
      note,
      attachments = [],
      edgeSourceSessionId,
      edgeInput = {},
      ctx,
      subscriptionId,
      slotKey,
    }: JsonRecord
  ) {
    const session = this.#state.sessions[sessionId]
    const unread = this.#channelStore.unread(sessionId)
    const preamble = activationPreamble(unread, {
      channelDir: this.#channelStore.channelDir(sessionId),
    })
    const content = [note, preamble].filter(Boolean).join('\n\n')
    const providerPrompt = providerPromptContent({
      providerKind: session.providerKind,
      message: content,
      context: undefined,
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

    const deliveredSeqs = unread.current.map((entry) => entry.seq)
    // Everything this activation's preamble listed counts as seen. If the
    // run turns out to never start (spawn-level failure produces no output),
    // #failSession rolls exactly these seqs back to unread — the agent
    // never saw the listing. Marked before the run to stay deterministic
    // against the async arrival of spawn errors.
    const listedSeqs = [
      ...unread.current.map((entry) => entry.seq),
      ...unread.superseded.map((entry) => entry.seq),
    ]
    if (listedSeqs.length > 0) {
      this.#channelStore.markRead(sessionId, Math.max(...listedSeqs))
    }

    if (edgeSourceSessionId && this.#state.sessions[edgeSourceSessionId]) {
      this.#addEdge({
        source: edgeSourceSessionId,
        target: sessionId,
        kind: 'resume-session',
        envelope: this.#createEnvelope(edgeSourceSessionId),
        label: 'resume_session',
        masterReason: this.#masterReasonFromInput(edgeSourceSessionId, edgeInput),
      })
    }

    const activatedEvent = this.#appendKernelEvent(
      'activated',
      {
        target: sessionId,
        sessionId,
        edgeSourceSessionId,
        notePreview: truncateForLog(note, 200),
        deliveries: deliveredSeqs,
        // Present when a subscription firing executed this activation; fold
        // counts the subscription's firings from it and frees the slot.
        subscriptionId: optionalTrimmedString(subscriptionId),
        slotKey: optionalTrimmedString(slotKey),
      },
      ctx,
      {
        reason:
          ctx.reason ?? this.#masterReasonFromInput(edgeSourceSessionId, edgeInput),
      }
    )
    this.#touch()
    // Broadcast keeps the runtime-plane name the renderer already consumes.
    this.#broadcast({ type: 'session.resumed', sessionId, state: this.getState() })

    await this.#startRun(sessionId, {
      prompt: providerPrompt,
      attachments,
      runKind: 'resume',
      userMessageId: userMessage.id,
      activationEventId: activatedEvent?.id,
      channelReadSeqs: listedSeqs,
    })

    return { ok: true, state: this.getState() }
  }

  archiveSession(input: JsonRecord | string = {}) {
    const normalized = typeof input === 'string' ? { sessionId: input } : input
    return this.#cmdArchiveSession(normalized, this.#humanCtx())
  }

  #cmdArchiveSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const archived = input.archived === false ? false : true
    this.#state.sessions[sessionId].archived = archived
    this.#appendKernelEvent('session.archived', { sessionId, archived }, ctx)
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

  getWorkspaceFiles(input: JsonRecord | string = {}) {
    const request = isObject(input) ? input : {}
    const sessionId =
      typeof input === 'string'
        ? input
        : typeof request.sessionId === 'string' &&
            request.sessionId.trim().length > 0
          ? request.sessionId.trim()
          : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const session = this.#state.sessions[sessionId]
    const cwd = validateRunnableCwd(session.cwd)
    const countState = { totalFiles: 0, truncated: false }
    countWorkspaceFiles(cwd, countState)

    const treeState = {
      maxDepth: normalizeWorkspaceFilesLimit(
        request.maxDepth,
        workspaceFilesMaxDepth,
        1,
        workspaceFilesMaxDepth
      ),
      remainingEntries: normalizeWorkspaceFilesLimit(
        request.maxEntries,
        workspaceFilesMaxEntries,
        25,
        workspaceFilesMaxEntries
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
      typeof request.sessionId === 'string' && request.sessionId.trim().length > 0
        ? request.sessionId.trim()
        : undefined

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }

    const session = this.#state.sessions[sessionId]
    const cwd = validateRunnableCwd(session.cwd)
    const { absolutePath, relativePath } = resolveWorkspaceFilePath(
      cwd,
      request.path
    )
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) {
      throw new Error(`Workspace path is not a file: ${relativePath}`)
    }

    const maxBytes = normalizeWorkspaceFilesLimit(
      request.maxBytes,
      workspaceFileContentMaxBytes,
      1024,
      workspaceFileContentMaxBytes
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

  killSession(sessionId) {
    return this.#cmdKillSession({ sessionId }, this.#humanCtx())
  }

  #cmdKillSession(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId = input.sessionId
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
      const killedEvent = this.#appendKernelEvent(
        'session.killed',
        { sessionId },
        ctx
      )
      const context = this.#runContext.get(sessionId)
      if (context) {
        // The provider run's close handler re-broadcasts session.killed once
        // the process actually exits; point it at this kernel fact.
        context.killedEventId = killedEvent?.id
      }
      this.#touch()
      this.#emitRuntimeEvent({
        type: 'session.killed',
        sessionId,
        state: this.getState(),
        kernelEventId: killedEvent?.id,
      })
    }

    return { ok, state: this.getState() }
  }

  killAll() {
    for (const sessionId of this.#runs.keys()) {
      this.killSession(sessionId)
    }
    for (const terminalId of [...this.#terminalRuns.keys()]) {
      this.closeTerminal({ terminalId })
    }
    // Armed timers die with the runtime; construction re-arms them from the
    // persisted subscriptions (with a single catch-up tick if overdue).
    this.#clearAllTimers()
    this.#providerService?.closeAll?.()
    this.#bridge?.close()
    // The kernel store intentionally stays open: killAll is revivable (the
    // bridge and provider service relaunch lazily), and a closed store would
    // silently drop later kernel events. If a newer runtime takes over the
    // same store, this connection's snapshot writes are dropped by the
    // snapshot-owner check instead of clobbering the newer state.
  }

  respondRuntimeRequest(input: JsonRecord = {}) {
    return this.#cmdRespondRuntimeRequest(input, this.#humanCtx())
  }

  #cmdRespondRuntimeRequest(input: JsonRecord = {}, ctx: JsonRecord) {
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
      throw new Error(
        'Runtime request decision must be accept, acceptForSession, decline, or cancel'
      )
    }
    const normalizedDecision = normalizeRuntimeRequestDecision(decision)

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

    run.respondRuntimeRequest({ requestId, decision: normalizedDecision })
    const event = {
      id: randomUUID(),
      ts: now(),
      type: 'request.resolved',
      sessionId,
      requestId,
      status: runtimeRequestStatusForDecision(normalizedDecision, request),
    }
    this.#appendExternalProviderRuntimeEvent(sessionId, event)
    this.#appendKernelEvent(
      'interaction.responded',
      { sessionId, requestId, decision: normalizedDecision },
      ctx
    )
    return { ok: true, state: this.getState() }
  }

  answerUserInput(input: JsonRecord = {}) {
    return this.#cmdAnswerUserInput(input, this.#humanCtx())
  }

  #cmdAnswerUserInput(input: JsonRecord = {}, ctx: JsonRecord) {
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : undefined
    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim().length > 0
        ? input.requestId.trim()
        : undefined
    const answer = typeof input.answer === 'string' ? input.answer : undefined
    const answers = normalizeUserInputAnswers(input.answers)
    const primaryAnswer = firstUserInputAnswer(answer, answers)

    if (!sessionId || !this.#state.sessions[sessionId]) {
      throw new Error(`Unknown session: ${sessionId ?? ''}`)
    }
    if (!requestId) {
      throw new Error('User input request id is required')
    }
    if (primaryAnswer === undefined && !answers) {
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

    run.answerUserInput({ requestId, answer: primaryAnswer, answers })
    const event = {
      id: randomUUID(),
      ts: now(),
      type: 'user-input.answered',
      sessionId,
      requestId,
      answer: primaryAnswer,
      ...(answers ? { answers } : {}),
    }
    this.#appendExternalProviderRuntimeEvent(sessionId, event)
    this.#appendKernelEvent(
      'interaction.answered',
      { sessionId, requestId },
      ctx
    )
    return { ok: true, state: this.getState() }
  }

  upsertCluster(input: JsonRecord = {}) {
    return this.#cmdUpsertCluster(input, this.#humanCtx())
  }

  #cmdUpsertCluster(input: JsonRecord = {}, ctx: JsonRecord) {
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

    this.#appendKernelEvent(
      'scope.upserted',
      { clusterId, label, nodeIds },
      ctx
    )
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { clusterId, state: this.getState() }
  }

  async createMasterForCluster(input: JsonRecord = {}) {
    return this.#cmdCreateMasterForCluster(input, this.#humanCtx())
  }

  async #cmdCreateMasterForCluster(input: JsonRecord = {}, ctx: JsonRecord) {
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
      this.#appendKernelEvent(
        'loop.policy-set',
        { clusterId, policy: clone(cluster.loopPolicy) },
        ctx
      )
    }

    if (cluster.masterSessionId) {
      if (this.#state.sessions[cluster.masterSessionId]) {
        this.#assignMaster(clusterId, cluster.masterSessionId, ctx)
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

    const result = await this.#cmdCreateSession(
      {
        agent: input.agent === 'codex' ? 'codex' : 'claude-code',
        providerKind: input.providerKind,
        providerInstanceId: input.providerInstanceId,
        prompt,
        cwd: input.cwd,
        label,
        cluster: clusterId,
        role: 'master',
        runtimeSettings: input.runtimeSettings,
      },
      ctx
    )
    this.#assignMaster(clusterId, result.sessionId, ctx)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { sessionId: result.sessionId, state: this.getState() }
  }

  assignMasterToCluster(input: JsonRecord = {}) {
    return this.#cmdAssignMaster(input, this.#humanCtx())
  }

  #cmdAssignMaster(input: JsonRecord = {}, ctx: JsonRecord) {
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

    this.#assignMaster(clusterId, sessionId, ctx)
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { state: this.getState() }
  }

  setClusterLoopPolicy(input: JsonRecord = {}) {
    return this.#cmdSetLoopPolicy(input, this.#humanCtx())
  }

  #cmdSetLoopPolicy(input: JsonRecord = {}, ctx: JsonRecord) {
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
    this.#appendKernelEvent(
      'loop.policy-set',
      { clusterId, policy: clone(this.#state.clusters[clusterId].loopPolicy) },
      ctx
    )
    this.#touch()
    this.#broadcast({ type: 'runtime.state', state: this.getState() })
    return { state: this.getState() }
  }

  updateNodePositions(input: JsonRecord = {}) {
    return this.#cmdUpdateNodePositions(input, this.#humanCtx())
  }

  // Canvas layout is view-layer state, not a kernel fact: the command still
  // flows through the unified channel, but no kernel event is appended.
  #cmdUpdateNodePositions(input: JsonRecord = {}, _ctx: JsonRecord) {
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
    return this.#cmdStartLoop(input, this.#humanCtx())
  }

  // LoopPolicy is a preset (kernel doc §6.2): starting the loop compiles it
  // into the two hero-loop subscriptions of §8.2 —
  //   S1: coder finished        → deliver diff  + activate reviewer (gate master)
  //   S2: reviewer verdict=issues → deliver review + activate coder  (gate master,
  //       stop at whenReport verdict / maxFirings, onStop freeze-cluster)
  // The runtime does the clerical work (matching, stop guards, deliveries,
  // message assembly); the master only approves or denies each firing.
  async #cmdStartLoop(input: JsonRecord = {}, ctx: JsonRecord) {
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

    const masterSessionId = cluster.masterSessionId
    if (!masterSessionId || !this.#state.sessions[masterSessionId]) {
      throw new Error(`Cluster has no master session: ${clusterId}`)
    }

    const coderSessionId = this.#loopCoderSessionId(cluster)
    if (!coderSessionId) {
      throw new Error(`Cluster has no managed worker session: ${clusterId}`)
    }

    if (
      this.#loopSubscriptionsForCluster(clusterId).some(
        (subscription) => subscription.state === 'active'
      )
    ) {
      throw new Error(`Cluster loop is already running: ${clusterId}`)
    }

    const ts = now()
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'Loop started by user.'

    // The reviewer exists up front (§8.2 subscriptions connect existing
    // nodes; the in-subscription create action lands in a later version).
    const reviewer = await this.#cmdCreateSession(
      this.#membraneCreateInput(masterSessionId, {
        agent: 'claude-code',
        label: 'Reviewer',
        cluster: clusterId,
        prompt: this.#reviewerBootstrapPrompt(),
        masterReason: 'Loop preset created the reviewer.',
      }),
      ctx
    )
    const reviewerSessionId = reviewer.sessionId

    const policy = cluster.loopPolicy
    const s1 = this.#cmdAuthorSubscription(
      {
        label: 'S1',
        preset: `hero-loop:${clusterId}`,
        sourceSessionId: coderSessionId,
        on: { on: 'finished' },
        targetSessionId: reviewerSessionId,
        action: {
          kind: 'deliver+activate',
          topic: 'diff',
          note: this.#reviewerActivationNote(),
        },
        gate: 'master',
        concurrency: 'coalesce',
      },
      ctx
    )
    const s2 = this.#cmdAuthorSubscription(
      {
        label: 'S2',
        preset: `hero-loop:${clusterId}`,
        sourceSessionId: reviewerSessionId,
        on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
        targetSessionId: coderSessionId,
        action: {
          kind: 'deliver+activate',
          topic: 'review',
          note: this.#coderActivationNote(),
        },
        gate: 'master',
        concurrency: 'coalesce',
        stop: {
          ...(optionalTrimmedString(policy.until?.whenReport?.verdict)
            ? { whenReport: { verdict: policy.until.whenReport.verdict } }
            : {}),
          maxFirings: policy.maxIterations ?? defaultCycleMaxFirings,
        },
        onStop: 'freeze-cluster',
      },
      ctx
    )

    cluster.loopState = {
      status: 'running',
      iterations: 0,
      coderSessionId,
      reviewerSessionId,
      lastEvent: { type: 'loop.started', ts },
      reason,
      startedAt: ts,
      stoppedAt: undefined,
    }

    const startedEvent = this.#appendKernelEvent(
      'loop.started',
      {
        clusterId,
        coderSessionId,
        reviewerSessionId,
        subscriptionIds: [s1.subscription.id, s2.subscription.id],
      },
      ctx,
      { reason: ctx.reason ?? reason }
    )
    this.#touch()
    this.#broadcast({
      type: 'loop.started',
      clusterId,
      state: this.getState(),
      kernelEventId: startedEvent?.id,
    })

    // Kick the first review: if the coder already finished its work, the
    // loop starts by reviewing the current state (same as the old wakeup).
    const coder = this.#state.sessions[coderSessionId]
    if (coder && coder.status === 'idle') {
      const syntheticTrigger = {
        id: startedEvent?.id,
        type: 'loop.started',
        payload: { sessionId: coderSessionId },
      }
      this.#schedulerChain = this.#schedulerChain
        .catch(() => undefined)
        .then(() =>
          this.#createPendingActivation(
            {
              kind: 'pend-activation',
              subscriptionId: s1.subscription.id,
              target: reviewerSessionId,
              action: s1.subscription.action,
              gate: s1.subscription.gate,
              masterSessionId:
                s1.subscription.gate === 'master' ? masterSessionId : undefined,
              triggerEventId: startedEvent?.id,
            },
            syntheticTrigger,
            this.#subscriptionRuleCtx(s1.subscription.id, startedEvent?.id)
          )
        )
        .catch((error) => {
          console.error(
            `Loop kick failed for ${clusterId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
    }

    return { state: this.getState() }
  }

  stopMasterLoop(input: JsonRecord = {}) {
    return this.#cmdStopLoop(input, this.#humanCtx())
  }

  #cmdStopLoop(input: JsonRecord = {}, ctx: JsonRecord) {
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
    this.#stopClusterLoopSubscriptions(clusterId, reason, ctx)

    if (input.killRunning === true) {
      const cluster = this.#state.clusters[clusterId]
      const runningIds = [
        ...cluster.nodeIds,
        cluster.masterSessionId,
      ].filter((sessionId) => this.#runs.has(sessionId))
      for (const sessionId of runningIds) {
        this.#cmdKillSession({ sessionId }, ctx)
      }
    }

    return { state: this.getState() }
  }

  #stopClusterLoopSubscriptions(clusterId, reason, ctx) {
    const active = this.#loopSubscriptionsForCluster(clusterId).filter(
      (subscription) => subscription.state === 'active'
    )
    for (const subscription of active) {
      this.#cmdStopSubscription(
        { subscriptionId: subscription.id, reason },
        ctx
      )
    }
    const cluster = this.#state.clusters[clusterId]
    if (cluster?.loopState && active.length > 0) {
      cluster.loopState = {
        ...cluster.loopState,
        status: 'stopped',
        lastEvent: { type: 'loop.stopped', ts: now() },
        reason,
        stoppedAt: now(),
      }
      this.#appendKernelEvent('loop.stopped', { clusterId }, ctx, { reason })
      this.#touch()
      this.#broadcast({
        type: 'loop.stopped',
        clusterId,
        reason,
        state: this.getState(),
      })
    }
  }

  #reviewerBootstrapPrompt() {
    return [
      'You are the Reviewer in an Orrery hero review loop.',
      'Your job on each activation: read the diff delivered in your context channel, then call mcp__orrery_membrane__report exactly once with type "verdict" — verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain.',
      'Do not edit files.',
      'For now, reply with exactly: ready. Then stop and wait for activations.',
    ].join('\n')
  }

  #reviewerActivationNote() {
    return [
      'Review the latest diff delivered in your context channel (file paths listed below).',
      'Do not edit files.',
      'Call mcp__orrery_membrane__report exactly once with type "verdict": verdict "issues" with an issues array when fixes are needed, or verdict "clean" when no fixes remain. Then stop.',
    ].join('\n')
  }

  #coderActivationNote() {
    return [
      'The reviewer reported issues; the review is delivered in your context channel (file paths listed below).',
      'Fix the listed issues, then stop so the loop can run the reviewer again.',
    ].join('\n')
  }

  authorSubscription(input: JsonRecord = {}) {
    return this.#cmdAuthorSubscription(input, this.#humanCtx())
  }

  stopSubscription(input: JsonRecord = {}) {
    return this.#cmdStopSubscription(input, this.#humanCtx())
  }

  async approveActivation(input: JsonRecord = {}) {
    return this.#cmdApproveActivation(input, this.#humanCtx())
  }

  denyActivation(input: JsonRecord = {}) {
    return this.#cmdDenyActivation(input, this.#humanCtx())
  }

  freeze(input: JsonRecord = {}) {
    return this.#cmdFreeze(input, this.#humanCtx())
  }

  #cmdFreeze(input: JsonRecord = {}, ctx: JsonRecord) {
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
    return this.#applyFreeze(
      {
        targetId: target,
        reason,
        source: input.source,
        masterReason: input.masterReason,
      },
      ctx
    )
  }

  linkSessions(input: JsonRecord = {}) {
    return this.#cmdLinkSessions(input, this.#humanCtx())
  }

  #cmdLinkSessions(input: JsonRecord = {}, ctx: JsonRecord) {
    const request = isObject(input) ? input : {}
    const source = this.#requireSession(request.source).sessionId
    const target = this.#requireSession(request.target).sessionId
    if (source === target) {
      throw new Error('Cannot link a session to itself')
    }

    const label = nonEmptyString(request.label) ? request.label.trim() : 'link'
    const reason = nonEmptyString(request.reason) ? request.reason.trim() : undefined

    const existing = this.#state.edges.find(
      (edge) =>
        edge.kind === 'link' &&
        edge.source === source &&
        edge.target === target &&
        edge.label === label
    )
    if (existing) {
      // Idempotent on source+target+label, but a fresh reason replaces the
      // stored detail so re-declaring a link never silently drops rationale.
      if (reason && existing.summary !== reason) {
        existing.summary = reason
        this.#appendKernelEvent(
          'edge.linked',
          { edgeId: existing.edgeId, source, target, label, refreshedReason: true },
          ctx,
          { reason: ctx.reason ?? reason }
        )
        this.#touch()
        this.#broadcast({ type: 'runtime.state', state: this.getState() })
      }
      return { edge: clone(existing) }
    }

    const envelope = this.#createEnvelope(source)
    this.#addEdge({
      source,
      target,
      kind: 'link',
      envelope,
      label,
      summary: reason,
    })
    const edge = this.#state.edges.at(-1)
    this.#appendKernelEvent(
      'edge.linked',
      { edgeId: edge.edgeId, source, target, label },
      ctx,
      { reason: ctx.reason ?? reason }
    )
    this.#touch()
    this.#broadcast({
      type: 'edge.created',
      edgeId: edge.edgeId,
      state: this.getState(),
    })
    return { edge: clone(edge) }
  }

  removeEdge(input: JsonRecord = {}) {
    return this.#cmdRemoveEdge(input, this.#humanCtx())
  }

  #cmdRemoveEdge(input: JsonRecord = {}, ctx: JsonRecord) {
    const request = isObject(input) ? input : {}
    const edgeId = nonEmptyString(request.edgeId) ? request.edgeId.trim() : undefined
    if (!edgeId) {
      throw new Error('removeEdge edgeId is required')
    }

    const index = this.#state.edges.findIndex((edge) => edge.edgeId === edgeId)
    if (index < 0) {
      throw new Error(`Unknown edge: ${edgeId}`)
    }

    const edge = this.#state.edges[index]
    if (edge.kind !== 'link') {
      // Runtime-semantic edges (create/resume/report/freeze) are history of
      // what actually happened; only declared relationships are removable.
      throw new Error(`Only link edges can be removed, ${edgeId} is ${edge.kind}`)
    }

    this.#state.edges.splice(index, 1)
    this.#appendKernelEvent(
      'edge.removed',
      { edgeId, source: edge.source, target: edge.target },
      ctx
    )
    this.#touch()
    this.#broadcast({
      type: 'edge.removed',
      edgeId,
      state: this.getState(),
    })
    return { ok: true }
  }

  async handleMembraneRequest({ tool, source, input }: JsonRecord) {
    if (!this.#state.sessions[source]) {
      throw new Error(`Unknown membrane source session: ${source}`)
    }

    const actor = this.#membraneActor(source)
    const request = isObject(input) ? input : {}

    if (tool === 'create_session') {
      const result = await this.dispatchCommand({
        kind: 'create_session',
        actor,
        input: this.#membraneCreateInput(source, request),
      })
      return { sessionId: result.sessionId }
    }

    if (tool === 'resume_session') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('resume_session sessionId is required')
      }
      const message = optionalTrimmedString(request.message)
      if (!message) {
        throw new Error('resume_session message is required')
      }
      await this.dispatchCommand({
        kind: 'resume_session',
        actor,
        input: {
          sessionId: target,
          message,
          context: request.context,
          edgeSourceSessionId: source,
          masterReason: request.masterReason,
          reason: request.reason,
        },
      })
      return { ok: true }
    }

    if (tool === 'deliver') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('deliver sessionId is required')
      }
      const result = await this.dispatchCommand({
        kind: 'deliver',
        actor,
        input: {
          sessionId: target,
          topic: request.topic,
          note: request.note,
          content: request.content,
          filename: request.filename,
        },
      })
      return { ok: true, delivery: result.delivery }
    }

    if (tool === 'activate') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('activate sessionId is required')
      }
      await this.dispatchCommand({
        kind: 'activate',
        actor,
        input: {
          sessionId: target,
          note: request.note,
          edgeSourceSessionId: source,
          masterReason: request.masterReason,
          reason: request.reason,
        },
      })
      return { ok: true }
    }

    if (tool === 'approve_activation') {
      return this.dispatchCommand({
        kind: 'approve_activation',
        actor,
        reason: optionalTrimmedString(request.note) ?? optionalTrimmedString(request.reason),
        input: { slotKey: request.slotKey, note: request.note },
      })
    }

    if (tool === 'deny_activation') {
      return this.dispatchCommand({
        kind: 'deny_activation',
        actor,
        reason: optionalTrimmedString(request.reason),
        input: { slotKey: request.slotKey, reason: request.reason },
      })
    }

    if (tool === 'report') {
      return this.dispatchCommand({
        kind: 'report',
        actor,
        input: request,
      })
    }

    if (tool === 'link_sessions') {
      const target = optionalTrimmedString(request.sessionId)
      if (!target) {
        throw new Error('link_sessions sessionId is required')
      }
      const { edge } = await this.dispatchCommand({
        kind: 'link_sessions',
        actor,
        input: {
          source,
          target,
          label: request.label,
          reason: request.reason,
        },
      })
      return { ok: true, edgeId: edge.edgeId }
    }

    throw new Error(`Unknown membrane tool: ${tool}`)
  }

  #membraneActor(source) {
    return {
      kind: this.#state.sessions[source]?.role === 'master' ? 'master' : 'agent',
      ref: source,
    }
  }

  // Maps a membrane create_session request onto the unified command input:
  // children inherit the creator's cwd and runtime settings (a cheap-model
  // master never silently spawns default-model sessions), and the creator
  // becomes the lineage edge source.
  #membraneCreateInput(source, input: JsonRecord = {}) {
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
    const label = optionalTrimmedString(input.label)

    return {
      agent: 'claude-code',
      prompt,
      cwd: sourceSession?.cwd,
      context: input.context,
      contextTopic: input.contextTopic,
      cluster,
      label: input.label,
      runtimeSettings: sourceSession?.runtimeSettings,
      sourceSessionId: source,
      linkLabel: label ? `create: ${label}` : 'create_session',
      masterReason: input.masterReason,
      reason: input.reason,
    }
  }

  async #startRun(
    sessionId,
    {
      prompt,
      attachments = [],
      runKind,
      userMessageId,
      activationEventId,
      channelReadSeqs = [],
    }
  ) {
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
      // Kernel event id of the session.created/activated fact that started
      // this run; provider lifecycle facts chain to it via causeId.
      activationEventId,
      // Channel deliveries listed in this run's activation message; rolled
      // back to unread if the run dies without ever producing output.
      channelReadSeqs,
      runProducedOutput: false,
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
        // The session's own inbox: providers grant read access up front so
        // channel deliveries never stall on a permission prompt (§4.2.5).
        // ensureChannelDir: the dir must exist (and be canonical) when the
        // provider session controller initializes its allowlist.
        channelDir: this.#channelStore.ensureChannelDir(sessionId),
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

      const context = this.#runContext.get(sessionId)
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
          // The kernel fact was appended by the kill command; the process
          // exit is only its completion, not a second fact.
          kernelEventId: context?.killedEventId,
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
        const finishedEvent = this.#appendKernelEvent(
          'session.finished',
          { sessionId, exitCode: code },
          { actor: { kind: 'provider' }, causeId: context?.activationEventId }
        )
        this.#touch()
        this.#emitRuntimeEvent({
          type: 'session.finished',
          sessionId,
          state: this.getState(),
          kernelEventId: finishedEvent?.id,
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

    this.#markRunProducedOutput(sessionId)
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

    this.#markRunProducedOutput(sessionId)
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

    this.#markRunProducedOutput(sessionId)
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

    if (event.type === 'runtime.configured') {
      session.effectiveRuntimeConfig = normalizeProviderEffectiveRuntimeConfig(
        event.effectiveRuntimeConfig,
        session.providerKind,
        session.runtimeSettings
      )
      return
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
        request.answers = event.answers
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

  #markRunProducedOutput(sessionId) {
    const context = this.#runContext.get(sessionId)
    if (context) {
      context.runProducedOutput = true
    }
  }

  #failSession(sessionId, error, ctx: JsonRecord = undefined) {
    const session = this.#state.sessions[sessionId]
    if (!session) {
      return
    }

    const context = this.#runContext.get(sessionId)
    if (
      context &&
      context.runProducedOutput === false &&
      Array.isArray(context.channelReadSeqs) &&
      context.channelReadSeqs.length > 0
    ) {
      // The run died before producing any output: the agent never saw the
      // activation message, so its listed deliveries become unread again.
      this.#channelStore.unmarkRead(sessionId, context.channelReadSeqs)
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
    const failedEvent = this.#appendKernelEvent(
      'session.failed',
      { sessionId, error: truncateForLog(String(error ?? ''), 400) },
      ctx ?? {
        actor: { kind: 'provider' },
        causeId: context?.activationEventId,
      }
    )
    this.#touch()
    this.#emitRuntimeEvent({
      type: 'session.failed',
      sessionId,
      error,
      state: this.getState(),
      kernelEventId: failedEvent?.id,
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

  #assignMaster(clusterId, sessionId, ctx: JsonRecord = undefined) {
    const cluster = this.#ensureCluster(clusterId)
    const session = this.#state.sessions[sessionId]
    const node = this.#state.nodes.find((item) => item.sessionId === sessionId)

    if (!session || !node) {
      throw new Error(`Unknown master session: ${sessionId}`)
    }

    const alreadyAssigned = cluster.masterSessionId === sessionId

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

    if (!alreadyAssigned) {
      this.#appendKernelEvent(
        'role.assigned',
        { clusterId, masterSessionId: sessionId },
        ctx ?? { actor: { kind: 'runtime' } }
      )
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

  #normalizeSubscriptions(value, diagnostics: JsonRecord[] = []) {
    if (!isObject(value)) {
      return {}
    }
    const subscriptions: JsonRecord = {}
    for (const [id, candidate] of Object.entries(value)) {
      if (
        !isObject(candidate) ||
        !nonEmptyString(candidate.id) ||
        !isObject(candidate.source) ||
        !isObject(candidate.on) ||
        !isObject(candidate.target) ||
        !isObject(candidate.action)
      ) {
        diagnostics.push(
          diagnostic(
            'storage.subscription_skipped',
            'Skipped an invalid persisted subscription.',
            { id }
          )
        )
        continue
      }
      subscriptions[candidate.id] = {
        ...candidate,
        gate: validSubscriptionGates.has(candidate.gate) ? candidate.gate : 'master',
        concurrency: validSubscriptionConcurrencies.has(candidate.concurrency)
          ? candidate.concurrency
          : 'coalesce',
        onStop: validSubscriptionOnStops.has(candidate.onStop)
          ? candidate.onStop
          : 'freeze-edge',
        state: candidate.state === 'stopped' ? 'stopped' : 'active',
        firings: Number.isInteger(candidate.firings)
          ? Math.max(0, candidate.firings)
          : 0,
      }
    }
    return subscriptions
  }

  #normalizePendingActivations(value, diagnostics: JsonRecord[] = []) {
    if (!isObject(value)) {
      return {}
    }
    const slots: JsonRecord = {}
    for (const [slotKey, candidate] of Object.entries(value)) {
      if (
        !isObject(candidate) ||
        !nonEmptyString(candidate.slotKey) ||
        !nonEmptyString(candidate.subscriptionId) ||
        !nonEmptyString(candidate.target)
      ) {
        diagnostics.push(
          diagnostic(
            'storage.pending_activation_skipped',
            'Skipped an invalid persisted pending activation.',
            { slotKey }
          )
        )
        continue
      }
      slots[candidate.slotKey] = {
        ...candidate,
        status: candidate.status === 'approved' ? 'approved' : 'pending',
        orderSeq: Number.isFinite(candidate.orderSeq) ? candidate.orderSeq : undefined,
      }
    }
    return slots
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
      lastEvent:
        isObject(loopState.lastEvent) && nonEmptyString(loopState.lastEvent.type)
          ? {
              type: loopState.lastEvent.type,
              ts: nonEmptyString(loopState.lastEvent.ts)
                ? loopState.lastEvent.ts
                : undefined,
            }
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
      'When the loop runs, the runtime will activate you with pending activation requests (each has a slotKey).',
      'For each request, decide once: call mcp__orrery_membrane__approve_activation with {"slotKey": ...} to allow it (optionally add "note" with extra instructions), or mcp__orrery_membrane__deny_activation with a reason to reject it. Then stop.',
      'The runtime handles the clerical work (deliveries, message assembly, stop conditions); you only judge whether each firing should proceed.',
    ].join('\n')
  }

  // Restart recovery for the intent layer: subscriptions and pending slots
  // persist in the snapshot; approved slots drain once targets are free.
  // Master-gated slots that were pending at shutdown stay approvable via
  // membrane/HTTP (they are not re-notified automatically).
  #recoverSchedulerState() {
    this.#schedulerChain = this.#schedulerChain
      .catch(() => undefined)
      .then(() => this.#drainApprovedSlots())
      .catch((error) => {
        console.error(
          `Scheduler recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
  }

  #emitRuntimeEvent(event) {
    this.#broadcast(event)
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

  #applyFreeze({ targetId, reason, source, masterReason }: JsonRecord, ctx: JsonRecord) {
    const cluster = this.#state.clusters[targetId]
    const session = this.#state.sessions[targetId]
    const sourceSessionId =
      typeof source === 'string' && this.#state.sessions[source] ? source : undefined
    const finalReason = reason ?? masterReason ?? 'Frozen.'

    let targetSessionIds = []
    if (cluster) {
      cluster.frozen = true
      cluster.freezeReason = finalReason
      this.#stopClusterLoopSubscriptions(cluster.clusterId, finalReason, ctx)
      targetSessionIds = [...cluster.nodeIds]
    } else if (session) {
      targetSessionIds = [session.sessionId]
      const clusterId =
        this.#managedClusterId(session.sessionId) ??
        this.#masterClusterId(session.sessionId)
      if (clusterId) {
        this.#stopClusterLoopSubscriptions(clusterId, finalReason, ctx)
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

    this.#appendKernelEvent(
      'freeze.applied',
      { targetId, targetSessionIds, sourceSessionId },
      ctx,
      { reason: finalReason }
    )
    this.#touch()
    this.#broadcast({
      type: 'freeze.applied',
      targetId,
      reason: finalReason,
      state: this.getState(),
    })
    return { ok: true, state: this.getState() }
  }

  #cmdReport(input: JsonRecord = {}, ctx: JsonRecord) {
    const source = ctx.actor?.ref
    if (!source || !this.#state.sessions[source]) {
      throw new Error(`Unknown report source session: ${source ?? ''}`)
    }

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

    const reportEvent = this.#appendKernelEvent(
      'report.received',
      {
        reportId: report.id,
        from: source,
        reportType: payload.type,
        verdict: payload.type === 'verdict' ? payload.verdict : undefined,
        summary: truncateForLog(this.#reportSummary(payload), 200),
      },
      ctx
    )
    this.#touch()
    this.#emitRuntimeEvent({
      type: 'report.received',
      from: source,
      report,
      state: this.getState(),
      kernelEventId: reportEvent?.id,
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

  #runningTerminalForSession(sessionId, cwd) {
    for (const terminal of this.#terminals.values()) {
      if (
        terminal.sessionId === sessionId &&
        terminal.cwd === cwd &&
        terminal.status === 'running'
      ) {
        return terminal
      }
    }

    return undefined
  }

  #terminalById(terminalId) {
    const id =
      typeof terminalId === 'string' && terminalId.trim().length > 0
        ? terminalId.trim()
        : undefined
    const terminal = id ? this.#terminals.get(id) : undefined
    if (!terminal) {
      throw new Error(`Unknown terminal: ${id ?? ''}`)
    }

    return terminal
  }

  #runningTerminalRun(terminalId) {
    const terminal = this.#terminalById(terminalId)
    const run = this.#terminalRuns.get(terminal.terminalId)
    if (!run || terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${terminal.terminalId}`)
    }

    return run
  }

  #cloneTerminal(terminalId) {
    return clone(this.#terminalById(terminalId))
  }

  #appendTerminalChunk(terminalId, stream, text) {
    const terminal = this.#terminals.get(terminalId)
    if (!terminal || typeof text !== 'string' || text.length === 0) {
      return
    }

    const chunk = {
      id: randomUUID(),
      terminalId,
      sessionId: terminal.sessionId,
      ts: now(),
      stream: validRuntimeTerminalStreams.has(stream) ? stream : 'system',
      text,
    }
    terminal.chunks.push(chunk)
    truncateTerminalChunks(terminal.chunks)
    terminal.updatedAt = chunk.ts
    this.#broadcast({
      type: 'terminal.output',
      terminalId,
      sessionId: terminal.sessionId,
      chunk,
      terminal: this.#cloneTerminal(terminalId),
    })
  }

  #appendTerminalStdout(terminalId, text) {
    const run = this.#terminalRuns.get(terminalId)
    if (!run || typeof text !== 'string' || text.length === 0) {
      return
    }

    const buffer = `${run.stdoutLineBuffer}${text}`
    let lineStart = 0

    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index]
      if (char !== '\n' && char !== '\r') {
        continue
      }

      let ending = char
      if (char === '\r' && buffer[index + 1] === '\n') {
        ending = '\r\n'
        index += 1
      }

      const line = buffer.slice(lineStart, index - ending.length + 1)
      this.#appendTerminalStdoutLine(terminalId, line, ending)
      lineStart = index + 1
    }

    run.stdoutLineBuffer = buffer.slice(lineStart)
    if (run.stdoutLineBuffer.length > 8192) {
      this.#appendTerminalChunk(terminalId, 'stdout', run.stdoutLineBuffer)
      run.stdoutLineBuffer = ''
    }
  }

  #appendTerminalStdoutLine(terminalId, line, ending = '\n') {
    const sentinelMatch = runtimeTerminalSentinelPattern.exec(line.trim())
    if (sentinelMatch) {
      this.#finishTerminalCommand(
        terminalId,
        sentinelMatch[1],
        Number(sentinelMatch[2])
      )
      return
    }

    this.#appendTerminalChunk(terminalId, 'stdout', `${line}${ending}`)
  }

  #finishTerminalCommand(terminalId, commandId, exitCode) {
    const terminal = this.#terminals.get(terminalId)
    if (!terminal) {
      return
    }

    const current = terminal.currentCommand
    if (!current || current.commandId !== commandId) {
      return
    }

    const finished = {
      ...current,
      status: 'finished',
      finishedAt: now(),
      exitCode,
    }
    terminal.lastCommand = finished
    delete terminal.currentCommand
    terminal.updatedAt = finished.finishedAt
    this.#broadcast({
      type: 'terminal.command.finished',
      terminalId,
      sessionId: terminal.sessionId,
      command: finished,
      terminal: this.#cloneTerminal(terminalId),
    })
  }

  #handleTerminalClose(terminalId, code, signal) {
    const terminal = this.#terminals.get(terminalId)
    const run = this.#terminalRuns.get(terminalId)
    if (!terminal) {
      return
    }

    if (run?.stdoutLineBuffer) {
      const line = run.stdoutLineBuffer
      run.stdoutLineBuffer = ''
      this.#appendTerminalStdoutLine(terminalId, line, '')
    }

    this.#terminalRuns.delete(terminalId)
    const ts = now()
    const wasClosedByUser = terminal.status === 'closed'
    terminal.status = wasClosedByUser ? 'closed' : 'exited'
    terminal.exitCode = code
    terminal.signal = signal
    terminal.updatedAt = ts

    if (terminal.currentCommand?.status === 'running') {
      const finished = {
        ...terminal.currentCommand,
        status: 'finished',
        finishedAt: ts,
        exitCode: Number.isInteger(code) ? code : undefined,
      }
      terminal.lastCommand = finished
      delete terminal.currentCommand
      this.#broadcast({
        type: 'terminal.command.finished',
        terminalId,
        sessionId: terminal.sessionId,
        command: finished,
        terminal: this.#cloneTerminal(terminalId),
      })
    }

    if (!wasClosedByUser) {
      this.#broadcast({
        type: 'terminal.exited',
        terminalId,
        sessionId: terminal.sessionId,
        terminal: this.#cloneTerminal(terminalId),
      })
    }
  }

  #touch() {
    this.#state.updatedAt = now()
    this.#persistState()
  }

  #broadcast(event) {
    this.#emitRuntimeEventToHost?.(event)
  }

  #persistState() {
    this.#kernelStore.saveSnapshot(this.#state)
  }

  #kernelStoreDiagnostics() {
    return this.#kernelStore.diagnostics.map((item) =>
      diagnostic(item.code, item.message, item.context ?? {})
    )
  }

  #loadState() {
    const snapshot = this.#kernelStore.loadSnapshot()
    const storeDiagnostics = this.#kernelStoreDiagnostics()
    if (snapshot) {
      return this.#normalizeState(snapshot.state, storeDiagnostics)
    }

    // No snapshot. Distinguish first-run migration from corruption recovery:
    // after a preserved-corrupt store, the JSON file is a stale fossil -- we
    // still restore it (better than empty), but the rollback must be loud.
    const storeWasCorrupted = this.#kernelStore.diagnostics.some((item) =>
      String(item.code ?? '').startsWith('kernel-store.')
    )
    const fossilExists = this.#storageFile && fs.existsSync(this.#storageFile)
    if (storeWasCorrupted && fossilExists) {
      let fossilModifiedAt
      try {
        fossilModifiedAt = fs.statSync(this.#storageFile).mtime.toISOString()
      } catch {
        fossilModifiedAt = undefined
      }
      storeDiagnostics.push(
        diagnostic(
          'storage.state_rolled_back',
          'Kernel store was corrupt; state was restored from the legacy JSON snapshot and may be older than your latest work.',
          { storageFile: this.#storageFile, fossilModifiedAt }
        )
      )
    }

    const legacy = this.#loadLegacyJsonState(storeDiagnostics)
    if (legacy) {
      if (legacy.imported) {
        this.#legacyImportKind = storeWasCorrupted ? 'fossil-rollback' : 'migration'
      }
      return legacy.state
    }

    if (storeDiagnostics.length > 0) {
      return this.#withDiagnostics(createEmptyGraphState(), storeDiagnostics)
    }
    return createEmptyGraphState()
  }

  // Reads the pre-G0 JSON storage format. Returns { state, imported } where
  // `imported` is true only when real data was parsed -- an empty recovery
  // state must not masquerade as a completed import in the kernel log.
  #loadLegacyJsonState(diagnostics: JsonRecord[] = []) {
    if (!this.#storageFile || !fs.existsSync(this.#storageFile)) {
      return undefined
    }

    const primary = readJsonFile(this.#storageFile)
    if (primary.ok) {
      return {
        state: this.#normalizeState(primary.value, diagnostics),
        imported: true,
      }
    }

    diagnostics.push(
      diagnostic(
        'storage.primary_parse_failed',
        'Primary Orrery runtime state could not be parsed.',
        {
          storageFile: this.#storageFile,
          error: primary.error.message,
          preservedFile: preserveCorruptFile(this.#storageFile),
        }
      )
    )

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
        return {
          state: this.#normalizeState(backup.value, diagnostics),
          imported: true,
        }
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
    return {
      state: this.#withDiagnostics(createEmptyGraphState(), diagnostics),
      imported: false,
    }
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
      subscriptions: this.#normalizeSubscriptions(source.subscriptions, diagnostics),
      pendingActivations: this.#normalizePendingActivations(
        source.pendingActivations,
        diagnostics
      ),
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
    const runtimeSettings = normalizeProviderRuntimeSettings(value.runtimeSettings)
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
      runtimeSettings,
      effectiveRuntimeConfig: isObject(value.effectiveRuntimeConfig)
        ? normalizeProviderEffectiveRuntimeConfig(
            value.effectiveRuntimeConfig,
            providerKind,
            runtimeSettings
          )
        : undefined,
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
      this.#restartInterruptedSessionIds.push(sessionId)
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
