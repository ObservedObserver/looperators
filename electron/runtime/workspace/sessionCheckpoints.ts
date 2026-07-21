// Per-turn git checkpoints and diff projections for sessions: checkpoint
// ref capture, checkpoint-range diff summaries, working-tree diffs, and
// checkpoint ref pruning. Split out of sessionManager.ts (move-only).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type JsonRecord,
  boundedText,
  isObject,
  nonEmptyString,
  now,
} from '../runtimeCommon.js'
import {
  checkpointRef,
  checkpointSessionRefRoot,
  emptyGitTree,
  gitCheckpointEnv,
  gitDiffMaxBuffer,
  gitOutput,
  gitRepoRoot,
  hasGitHead,
  validateRunnableCwd,
  parseDiffFilesFromPatch,
  totalsForDiffFiles,
} from './gitWorkspace.js'

const uiPatchMaxLength = 2 * 1024 * 1024

// The minimal manager surface the checkpoint/diff projections need.
export type CheckpointHost = {
  readonly state: JsonRecord
  readonly runContext: Map<string, JsonRecord>
  appendProviderRuntimeEvent(sessionId: string, event: JsonRecord): void
}

export function completedTurnCount(host: CheckpointHost, session) {
  return (session.runtimeEvents ?? []).filter(
    (event) => event.type === 'turn.completed',
  ).length
}

export function captureTurnCheckpoint(host: CheckpointHost, { sessionId, turnId, turnCount, stage }) {
  const session = host.state.sessions[sessionId]
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
    throw new Error(
      `Project folder is not a Git work tree: ${cwd}. ${message}`,
    )
  }

  const ref = checkpointRef({
    sessionId,
    turnCount,
    turnId,
    stage,
  })
  const tempIndex = path.join(
    os.tmpdir(),
    `orrery-checkpoint-${process.pid}-${randomUUID()}.index`,
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

export function diffSummaryForCheckpointRange(host: CheckpointHost, {
  sessionId,
  turnId,
  cwd,
  repoRoot,
  fromCheckpointRef,
  toCheckpointRef,
  fromTurnCount,
  toTurnCount,
  ignoreWhitespace = false,
  unbounded = false,
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
    { maxBuffer: gitDiffMaxBuffer },
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
    patch: unbounded ? rawPatch : boundedText(rawPatch, uiPatchMaxLength),
    truncated: unbounded ? false : rawPatch.length > uiPatchMaxLength,
  }
}

export function recordTurnCheckpointDiff(host: CheckpointHost, sessionId, ts) {
  const session = host.state.sessions[sessionId]
  const context = host.runContext.get(sessionId)
  if (!session || !context || context.turnDiffRecorded === true) {
    return
  }

  context.turnDiffRecorded = true
  const turnId = context.runId
  const fromTurnCount = Number.isInteger(
    context.turnCheckpoint?.fromTurnCount,
  )
    ? context.turnCheckpoint.fromTurnCount
    : completedTurnCount(host, session)
  const toTurnCount = fromTurnCount + 1

  if (context.turnCheckpoint?.error || !context.turnCheckpoint?.ref) {
    host.appendProviderRuntimeEvent(sessionId, {
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
    const after = captureTurnCheckpoint(host, {
      sessionId,
      turnId,
      turnCount: toTurnCount,
      stage: 'after',
    })
    const diff = diffSummaryForCheckpointRange(host, {
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
    host.appendProviderRuntimeEvent(sessionId, {
      id: randomUUID(),
      ts,
      type: 'turn.diff.updated',
      sessionId,
      turnId,
      diff: summary,
    })
  } catch (error) {
    host.appendProviderRuntimeEvent(sessionId, {
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

export function pruneTurnCheckpointRefs(host: CheckpointHost, sessionId) {
  const session = host.state.sessions[sessionId]
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
  const activeContext = host.runContext.get(sessionId)
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

export function gitDiffForSession(host: CheckpointHost, sessionId) {
  try {
    const result = workingTreeDiffForSession(host, sessionId)
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
    const cwd = host.state.sessions[sessionId]?.cwd ?? process.cwd()
    return `Unable to read git diff for ${cwd}: ${message}`
  }
}

export function checkpointDiffForSession(host: CheckpointHost, sessionId, options: JsonRecord = {}) {
  const session = host.state.sessions[sessionId]
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`)
  }

  const turnId = nonEmptyString(options.turnId)
    ? options.turnId.trim()
    : undefined
  if (!turnId) {
    throw new Error('Turn id is required for checkpoint diff.')
  }

  const diffEvent = [...(session.runtimeEvents ?? [])]
    .reverse()
    .find(
      (event) =>
        event.type === 'turn.diff.updated' &&
        event.turnId === turnId &&
        isObject(event.diff),
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
  const result = diffSummaryForCheckpointRange(host, {
    sessionId,
    turnId,
    cwd,
    repoRoot: diffEvent.diff.repoRoot ?? gitRepoRoot(cwd) ?? cwd,
    fromCheckpointRef: range.fromCheckpointRef,
    toCheckpointRef: range.toCheckpointRef,
    fromTurnCount: range.fromTurnCount,
    toTurnCount: range.toTurnCount,
    ignoreWhitespace: options.ignoreWhitespace === true,
    unbounded: options.unbounded === true,
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

export function workingTreeDiffForSession(host: CheckpointHost, sessionId, options: JsonRecord = {}) {
  const session = host.state.sessions[sessionId]
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
    throw new Error(
      `Project folder is not a Git work tree: ${cwd}. ${message}`,
    )
  }

  const tempIndex = path.join(
    os.tmpdir(),
    `orrery-diff-${process.pid}-${randomUUID()}.index`,
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
    const workingTree = gitOutput(cwd, ['write-tree'], {
      env,
    })
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

    const stagedPatch = gitOutput(
      cwd,
      [...diffArgs, baseTree, indexTree, '--', '.'],
      {
        maxBuffer: gitDiffMaxBuffer,
      },
    )
    const unstagedPatch = gitOutput(
      cwd,
      [...diffArgs, indexTree, workingTree, '--', '.'],
      { maxBuffer: gitDiffMaxBuffer },
    )
    const rawPatch = [stagedPatch, unstagedPatch]
      .filter((section) => section.trim().length > 0)
      .join('\n\n')
    const files = parseDiffFilesFromPatch(rawPatch)
    const patch = boundedText(rawPatch, uiPatchMaxLength)
    const statusOutput = gitOutput(
      cwd,
      ['status', '--short', '--untracked-files=all', '--', '.'],
      { maxBuffer: 4 * 1024 * 1024 },
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

