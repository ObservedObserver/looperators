// Runtime state recovery: durable/legacy snapshot loading, storage-schema
// normalization of every persisted slice (sessions, nodes, edges, clusters,
// subscriptions, workflows, councils, barriers...), repair diagnostics, and
// legacy migration. Split out of sessionManager.ts (move-only).
//
// These are storage-schema projections with recovery side effects (fs reads,
// corrupt-file preservation); they never touch live runtime state. The
// restartInterruptedSessionIds collector threads interrupted-session repair
// back to the manager's recovery orchestration.
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  createEmptyGraphState,
  graphStateVersion,
} from '../../../shared/graph-state.js'
import { providerMetadata } from '../../../shared/provider-metadata.js'
import { planCouncilPhases } from '../../../shared/plan-council.js'
import { validateExecutionEnvelope } from '../../../shared/execution-envelope.js'
import { validateDynamicCreateAction } from '../../../shared/dynamic-topology.js'
import {
  defaultRuntimeResourcePolicy,
  runtimeConsumptionBudgetKeys,
} from '../../../shared/resource-governance.js'
import {
  type JsonRecord,
  clone,
  compactProviderRuntimeEvent,
  compactRuntimeItem,
  compactRuntimePlan,
  diagnostic,
  isObject,
  nonEmptyString,
  now,
  optionalTrimmedString,
  planCouncilArtifactMaxBytes,
  recoverableActiveStatuses,
  validAgentBackends,
  validBarrierModes,
  validBarrierStatuses,
  validGraphEdgeKinds,
  validLoopStatuses,
  validMessageStatuses,
  validProviderKinds,
  validRuntimeItemStatuses,
  validRuntimeRequestStatuses,
  validSessionStatuses,
  validSubscriptionConcurrencies,
  validSubscriptionGates,
  validSubscriptionOnStops,
  validSubscriptionPatterns,
  validUserInputRequestStatuses,
  validWorkflowPlanStatuses,
  validWorkflowProposalStatuses,
  validWorkflowRecipes,
  validWorkflowWakeupKinds,
  validWorkflowWakeupStatuses,
  validWorkModes,
} from '../runtimeCommon.js'
import {
  currentGitBranch,
  cwdRepairCandidate,
  isValidCwd,
  normalizeSessionProject,
  safeCwd,
} from '../workspace/gitWorkspace.js'
import {
  defaultProviderInstanceForKind,
  normalizeProviderEffectiveRuntimeConfig,
  normalizeProviderInstances,
  normalizeProviderRuntimeSettings,
} from '../providers/providerConfigNormalize.js'
import { normalizeChatAttachments } from '../sessions/sessionInteraction.js'

const storageBackupSuffix = '.bak'
function backupFileFor(storageFile) {
  return `${storageFile}${storageBackupSuffix}`
}

function readJsonFile(file) {
  try {
    return {
      ok: true,
      value: JSON.parse(fs.readFileSync(file, 'utf8')),
    }
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

export function normalizeLoopPolicy(policy) {
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
      throw new Error(
        'LoopPolicy maxIterations must be an integer from 1 to 100',
      )
    }
    maxIterations = value
  }

  return {
    ...(until ? { until } : {}),
    onStop: 'freeze',
    ...(maxIterations ? { maxIterations } : {}),
  }
}

export function normalizeSubscriptions(value, diagnostics: JsonRecord[] = []) {
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
          { id },
        ),
      )
      continue
    }
    if (candidate.action.kind === 'create') {
      const validation = validateDynamicCreateAction(candidate.action)
      if (!validation.ok || candidate.on.on !== 'report' || !Number.isSafeInteger(candidate.stop?.maxFirings)) {
        diagnostics.push(diagnostic(
          'storage.subscription_skipped',
          'Skipped an unsafe persisted dynamic create subscription.',
          { id, errors: validation.errors },
        ))
        continue
      }
    } else if (!['deliver', 'deliver+activate'].includes(candidate.action.kind)) {
      diagnostics.push(diagnostic(
        'storage.subscription_skipped',
        'Skipped a subscription with an unsupported action.',
        { id },
      ))
      continue
    }
    if (candidate.executionRef !== undefined && (
      !isObject(candidate.executionRef) ||
      !nonEmptyString(candidate.executionRef.workflowId) ||
      !Number.isSafeInteger(candidate.executionRef.workflowVersion) ||
      candidate.executionRef.workflowVersion < 1 ||
      !nonEmptyString(candidate.executionRef.runId) ||
      !nonEmptyString(candidate.executionRef.phaseId)
    )) {
      diagnostics.push(diagnostic(
        'storage.subscription_skipped',
        'Skipped a subscription with invalid governing execution identity.',
        { id },
      ))
      continue
    }
    subscriptions[candidate.id] = {
      ...candidate,
      gate: validSubscriptionGates.has(candidate.gate)
        ? candidate.gate
        : 'master',
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

export function normalizePendingActivations(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) {
    return {}
  }
  const slots: JsonRecord = {}
  for (const [slotKey, candidate] of Object.entries(value)) {
    if (
      !isObject(candidate) ||
      !nonEmptyString(candidate.slotKey) ||
      !nonEmptyString(candidate.subscriptionId) ||
      !nonEmptyString(candidate.target) ||
      (candidate.execution !== undefined && !validateExecutionEnvelope(candidate.execution))
    ) {
      diagnostics.push(
        diagnostic(
          'storage.pending_activation_skipped',
          'Skipped an invalid persisted pending activation.',
          { slotKey },
        ),
      )
      continue
    }
    slots[candidate.slotKey] = {
      ...candidate,
      status: candidate.status === 'approved' ? 'approved' : 'pending',
      orderSeq: Number.isFinite(candidate.orderSeq)
        ? candidate.orderSeq
        : undefined,
    }
  }
  return slots
}

export function normalizeLoopState(loopState) {
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
      isObject(loopState.lastEvent) &&
      nonEmptyString(loopState.lastEvent.type)
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

// Reads the pre-G0 JSON storage format. Returns { state, imported } where
// `imported` is true only when real data was parsed -- an empty recovery
// state must not masquerade as a completed import in the kernel log.
export function loadLegacyJsonState(
  storageFile: string | undefined,
  diagnostics: JsonRecord[] = [],
  restartInterruptedSessionIds: string[] = [],
) {
  if (!storageFile || !fs.existsSync(storageFile)) {
    return undefined
  }

  const primary = readJsonFile(storageFile)
  if (primary.ok) {
    return {
      state: normalizeState(
        primary.value,
        diagnostics,
        restartInterruptedSessionIds,
      ),
      imported: true,
    }
  }

  diagnostics.push(
    diagnostic(
      'storage.primary_parse_failed',
      'Primary Orrery runtime state could not be parsed.',
      {
        storageFile: storageFile,
        error: primary.error.message,
        preservedFile: preserveCorruptFile(storageFile),
      },
    ),
  )

  const backupFile = backupFileFor(storageFile)
  if (fs.existsSync(backupFile)) {
    const backup = readJsonFile(backupFile)
    if (backup.ok) {
      diagnostics.push(
        diagnostic(
          'storage.recovered_from_backup',
          'Recovered Orrery runtime state from the last valid backup.',
          { backupFile },
        ),
      )
      return {
        state: normalizeState(
          backup.value,
          diagnostics,
          restartInterruptedSessionIds,
        ),
        imported: true,
      }
    }

    diagnostics.push(
      diagnostic(
        'storage.backup_parse_failed',
        'Backup Orrery runtime state could not be parsed.',
        { backupFile, error: backup.error.message },
      ),
    )
  }

  console.error(
    `Failed to load Orrery runtime state: ${primary.error.message}; starting with an empty recoverable state.`,
  )
  return {
    state: withDiagnostics(createEmptyGraphState(), diagnostics),
    imported: false,
  }
}

export function normalizeResourcePolicies(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const normalized = {}
  for (const [scopeId, candidate] of Object.entries(value)) {
    if (!isObject(candidate)) {
      diagnostics.push(diagnostic('storage.resource_policy_skipped', 'Skipped an invalid resource policy.', { scopeId }))
      continue
    }
    const hadExplicitEnforcement = ['off', 'warn', 'hard'].includes(candidate.consumptionEnforcement)
    const consumptionEnforcement = hadExplicitEnforcement
      ? candidate.consumptionEnforcement
      : 'off'
    const policy: JsonRecord = {
      scopeId,
      ...defaultRuntimeResourcePolicy,
      consumptionEnforcement,
      serializeWorkspaceAccess: candidate.serializeWorkspaceAccess === true,
      updatedAt: nonEmptyString(candidate.updatedAt) ? candidate.updatedAt : now(),
      updatedBy: candidate.updatedBy === 'human' ? 'human' : 'runtime',
      ...(nonEmptyString(candidate.budgetStartedAt) ? { budgetStartedAt: candidate.budgetStartedAt } : {}),
    }
    for (const key of ['maxConcurrentSessions', 'maxConcurrentPerProvider', 'maxQueuedRuns', 'maxFanout']) {
      const numeric = Number(candidate[key])
      if (Number.isSafeInteger(numeric) && numeric > 0) policy[key] = numeric
    }
    if (hadExplicitEnforcement) {
      for (const key of runtimeConsumptionBudgetKeys) {
        const numeric = Number(candidate[key])
        if (Number.isSafeInteger(numeric) && numeric > 0) policy[key] = numeric
      }
    }
    normalized[scopeId] = policy
  }
  return normalized
}

export function normalizeState(
  value,
  diagnostics: JsonRecord[] = [],
  restartInterruptedSessionIds: string[] = [],
) {
  const fallback = createEmptyGraphState()
  const source = isObject(value) ? value : {}
  if (source.version !== graphStateVersion) {
    throw new Error(
      `Unsupported Orrery graph state version: ${String(source.version)}. Expected ${graphStateVersion}. Clear the local Orrery runtime data before starting this build.`,
    )
  }
  const state: JsonRecord = {
    ...fallback,
    ...source,
    version: graphStateVersion,
    updatedAt: nonEmptyString(source.updatedAt)
      ? source.updatedAt
      : fallback.updatedAt,
    nodes: [],
    edges: Array.isArray(source.edges)
      ? source.edges.map((edge) => normalizeEdge(edge))
      : [],
    sessions: {},
    providerInstances: normalizeProviderInstances(source.providerInstances),
    clusters: isObject(source.clusters)
      ? normalizeClusters(source.clusters)
      : {},
    reports: Array.isArray(source.reports)
      ? source.reports.map((report) => normalizeReport(report))
      : [],
    subscriptions: normalizeSubscriptions(
      source.subscriptions,
      diagnostics,
    ),
    pendingActivations: normalizePendingActivations(
      source.pendingActivations,
      diagnostics,
    ),
    planCouncils: normalizePlanCouncils(
      source.planCouncils,
      diagnostics,
    ),
    workflowPlans: normalizeWorkflowPlans(
      source.workflowPlans,
      diagnostics,
    ),
    workflowProposals: normalizeWorkflowProposals(
      source.workflowProposals,
      diagnostics,
    ),
    workflowCapabilities: normalizeWorkflowCapabilities(
      source.workflowCapabilities,
      diagnostics,
    ),
    workflowWakeups: normalizeWorkflowWakeups(
      source.workflowWakeups,
      diagnostics,
    ),
    barriers: normalizeBarriers(source.barriers, diagnostics),
    dynamicSpawnGroups: normalizeDynamicSpawnGroups(
      source.dynamicSpawnGroups,
      diagnostics,
    ),
    workspaceLeases: Array.isArray(source.workspaceLeases)
      ? source.workspaceLeases.filter(isObject).map(clone)
      : [],
    runQueue: Array.isArray(source.runQueue)
      ? source.runQueue.filter(isObject).map(clone)
      : [],
    usageFacts: Array.isArray(source.usageFacts)
      ? source.usageFacts.filter(isObject).map(clone)
      : [],
    resourcePolicies: normalizeResourcePolicies(source.resourcePolicies, diagnostics),
    schedulerMetrics: isObject(source.schedulerMetrics)
      ? { ...fallback.schedulerMetrics, ...clone(source.schedulerMetrics) }
      : clone(fallback.schedulerMetrics),
  }

  const sourceSessions = isObject(source.sessions) ? source.sessions : {}
  for (const [storageKey, sessionValue] of Object.entries(sourceSessions)) {
    if (!isObject(sessionValue)) {
      diagnostics.push(
        diagnostic(
          'storage.session_skipped',
          'Skipped an invalid session record.',
          {
            storageKey,
          },
        ),
      )
      continue
    }
    const session = normalizeSession(
      storageKey,
      sessionValue,
      diagnostics,
      state.providerInstances,
      restartInterruptedSessionIds,
    )
    state.sessions[session.sessionId] = session
  }

  const seenNodeSessionIds = new Set()
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : []
  for (const nodeValue of sourceNodes) {
    if (!isObject(nodeValue)) {
      diagnostics.push(
        diagnostic(
          'storage.node_skipped',
          'Skipped an invalid graph node record.',
        ),
      )
      continue
    }

    const nodeSessionId = sessionIdOfNode(nodeValue)
    if (!nodeSessionId || seenNodeSessionIds.has(nodeSessionId)) {
      diagnostics.push(
        diagnostic(
          'storage.node_skipped',
          'Skipped a duplicate or unidentified graph node.',
          {
            nodeId: nodeValue.nodeId,
            sessionId: nodeValue.sessionId,
          },
        ),
      )
      continue
    }

    if (!state.sessions[nodeSessionId]) {
      diagnostics.push(
        diagnostic(
          'storage.placeholder_session_created',
          'Created a failed placeholder session for a graph node without a session record.',
          {
            sessionId: nodeSessionId,
          },
        ),
      )
      state.sessions[nodeSessionId] = placeholderSessionFromNode(
        nodeSessionId,
        nodeValue,
      )
    }

    const session = state.sessions[nodeSessionId]
    state.nodes.push(normalizeNode(nodeValue, session, diagnostics))
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
        { sessionId: session.sessionId },
      ),
    )
    state.nodes.push(nodeFromSession(session))
  }

  state.diagnostics = activePersistedDiagnostics(
    state,
    source.diagnostics,
  )

  return withDiagnostics(state, diagnostics)
}

export function activePersistedDiagnostics(state, diagnostics) {
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

export function withDiagnostics(state, diagnostics) {
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

export function normalizeSession(
  storageKey,
  value,
  diagnostics,
  providerInstances,
  restartInterruptedSessionIds: string[] = [],
) {
  const sessionId = nonEmptyString(value.sessionId)
    ? value.sessionId
    : nonEmptyString(storageKey)
      ? storageKey
      : randomUUID()
  const ts = now()
  const recoveredActiveSession = recoverableActiveStatuses.has(value.status)
  const status = normalizeSessionStatus(
    sessionId,
    value,
    diagnostics,
    restartInterruptedSessionIds,
  )
  if (value.backend !== undefined && !validAgentBackends.has(value.backend)) {
    throw new Error(
      `Unsupported backend for restored session ${sessionId}: ${String(value.backend)}`,
    )
  }
  const backend = validAgentBackends.has(value.backend)
    ? value.backend
    : providerMetadata[value.agent]?.backend ?? 'claude-agent-sdk'
  if (
    value.providerKind !== undefined &&
    !validProviderKinds.has(value.providerKind)
  ) {
    throw new Error(
      `Unsupported provider kind for restored session ${sessionId}: ${String(value.providerKind)}`,
    )
  }
  const providerKind = validProviderKinds.has(value.providerKind)
    ? value.providerKind
    : Object.entries(providerMetadata).find(
        ([, metadata]) => metadata.backend === backend,
      )?.[0] ?? 'claude-code'
  const providerInstanceId =
    optionalTrimmedString(value.providerInstanceId) ??
    defaultProviderInstanceForKind(providerKind).providerInstanceId
  const providerInstance = providerInstances.find(
    (instance) => instance.providerInstanceId === providerInstanceId,
  )
  if (!providerInstance) {
    throw new Error(
      `Unknown provider instance for restored session ${sessionId}: ${providerInstanceId}`,
    )
  }
  if (providerInstance.kind !== providerKind) {
    throw new Error(
      `Provider instance ${providerInstanceId} is ${providerInstance.kind}, not ${providerKind}, for restored session ${sessionId}.`,
    )
  }
  let cwd = safeCwd(value.cwd)
  const cwdRepair = !isValidCwd(cwd)
    ? cwdRepairCandidate(cwd, value)
    : undefined
  if (cwdRepair) {
    diagnostics.push(
      diagnostic(
        'storage.cwd_repaired',
        'Repointed a restored session from a missing worktree to an available project folder.',
        {
          sessionId,
          oldCwd: cwd,
          cwd: cwdRepair.cwd,
          reason: cwdRepair.reason,
        },
      ),
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
        { sessionId, cwd },
      ),
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
  const runtimeSettings = normalizeProviderRuntimeSettings(
    value.runtimeSettings,
  )
  const session = {
    ...value,
    sessionId,
    nodeId: sessionId,
    backend,
    backendSessionId: nonEmptyString(value.backendSessionId)
      ? value.backendSessionId
      : undefined,
    providerKind,
    providerInstanceId,
    providerSessionId: nonEmptyString(value.providerSessionId)
      ? value.providerSessionId
      : nonEmptyString(value.backendSessionId)
        ? value.backendSessionId
        : undefined,
    providerResumeCursor: nonEmptyString(value.providerResumeCursor)
      ? value.providerResumeCursor
      : undefined,
    agent: nonEmptyString(value.agent)
      ? value.agent
      : providerMetadata[providerKind].agent,
    label: nonEmptyString(value.label)
      ? value.label
      : `${providerMetadata[providerKind].labelPrefix} ${sessionId.slice(0, 8)}`,
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    cwd,
    project,
    role: value.role === 'master' ? 'master' : 'worker',
    status,
    createdAt: nonEmptyString(value.createdAt) ? value.createdAt : ts,
    updatedAt: nonEmptyString(value.updatedAt) ? value.updatedAt : ts,
    chunks: Array.isArray(value.chunks)
      ? value.chunks.map((chunk) => normalizeChunk(sessionId, chunk))
      : [],
    messages: Array.isArray(value.messages)
      ? value.messages.map((message) =>
          normalizeMessage(sessionId, message, status, diagnostics),
        )
      : messagesFromLegacySession({
          ...value,
          sessionId,
        }),
    nativeEvents: Array.isArray(value.nativeEvents)
      ? value.nativeEvents
          .slice(-40)
          .map((event) =>
            normalizeNativeProviderEvent(sessionId, providerKind, event),
          )
      : [],
    runtimeEvents: Array.isArray(value.runtimeEvents)
      ? value.runtimeEvents.map((event) =>
          normalizeProviderRuntimeEvent(sessionId, event),
        )
      : [],
    runtimeActivities: Array.isArray(value.runtimeActivities)
      ? value.runtimeActivities.map((activity) =>
          normalizeRuntimeActivity(sessionId, activity),
        )
      : [],
    runtimeRequests: Array.isArray(value.runtimeRequests)
      ? normalizeRuntimeRequests(
          sessionId,
          value.runtimeRequests,
          recoveredActiveSession,
          diagnostics,
        )
      : [],
    runtimeUserInputRequests: Array.isArray(value.runtimeUserInputRequests)
      ? normalizeUserInputRequests(
          sessionId,
          value.runtimeUserInputRequests,
          recoveredActiveSession,
          diagnostics,
        )
      : [],
    runtimePlans: Array.isArray(value.runtimePlans)
      ? value.runtimePlans.filter(isObject).map(compactRuntimePlan)
      : [],
    runtimeSettings,
    effectiveRuntimeConfig: isObject(value.effectiveRuntimeConfig)
      ? normalizeProviderEffectiveRuntimeConfig(
          value.effectiveRuntimeConfig,
          providerKind,
          runtimeSettings,
        )
      : undefined,
    archived: value.archived === true,
  }

  if (value.nodeId !== sessionId) {
    diagnostics.push(
      diagnostic(
        'storage.session_identity_repaired',
        'Repaired a session whose nodeId did not match sessionId.',
        {
          sessionId,
          previousNodeId: value.nodeId,
        },
      ),
    )
  }

  return session
}

export function normalizeSessionStatus(
  sessionId,
  session,
  diagnostics,
  restartInterruptedSessionIds: string[] = [],
) {
  if (recoverableActiveStatuses.has(session.status)) {
    diagnostics.push(
      diagnostic(
        'runtime.active_session_recovered',
        'Recovered a session that was active when the previous runtime stopped.',
        {
          sessionId,
          previousStatus: session.status,
        },
      ),
    )
    session.error =
      session.error ??
      `Interrupted by runtime restart while ${session.status}; review the last messages and resume when ready.`
    session.finishedAt = session.finishedAt ?? now()
    restartInterruptedSessionIds.push(sessionId)
    return 'failed'
  }

  if (session.status === 'finished') {
    diagnostics.push(
      diagnostic(
        'storage.legacy_status_migrated',
        'Migrated legacy finished status to idle.',
        { sessionId },
      ),
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
      { sessionId, previousStatus: session.status },
    ),
  )
  session.error =
    session.error ??
    `Recovered unknown persisted status: ${String(session.status)}`
  return 'failed'
}

export function normalizeChunk(sessionId, value) {
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

export function normalizeNativeProviderEvent(sessionId, providerKind, value) {
  const event = isObject(value) ? value : {}
  const raw = isObject(event.raw)
    ? event.raw
    : {
        source: 'claude.sdk',
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

export function normalizeProviderRuntimeEvent(sessionId, value) {
  const event = isObject(value) ? value : {}
  return compactProviderRuntimeEvent({
    ...event,
    id: nonEmptyString(event.id) ? event.id : randomUUID(),
    ts: nonEmptyString(event.ts) ? event.ts : now(),
    type: nonEmptyString(event.type) ? event.type : 'session.state',
    sessionId,
  })
}

export function normalizeRuntimeActivity(sessionId, value) {
  const activity = isObject(value) ? value : {}
  const status = validRuntimeItemStatuses.has(activity.status)
    ? activity.status
    : activity.completedAt
      ? 'completed'
      : 'running'

  return compactRuntimeItem({
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
    updatedAt: nonEmptyString(activity.updatedAt)
      ? activity.updatedAt
      : now(),
    completedAt: nonEmptyString(activity.completedAt)
      ? activity.completedAt
      : undefined,
    durationMs: Number.isFinite(activity.durationMs)
      ? activity.durationMs
      : undefined,
    sublines: Array.isArray(activity.sublines)
      ? activity.sublines.filter(isObject)
      : [],
  })
}

export function normalizeRuntimeRequests(
  sessionId,
  values,
  recoveredActiveSession,
  diagnostics,
) {
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
          { sessionId, requestId: value.id },
        ),
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

export function normalizeUserInputRequests(
  sessionId,
  values,
  recoveredActiveSession,
  diagnostics,
) {
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
          {
            sessionId,
            requestId: value.id,
          },
        ),
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

export function normalizeMessage(sessionId, value, sessionStatus, diagnostics) {
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
      message.role === 'assistant' || message.role === 'system'
        ? message.role
        : 'user',
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
        {
          sessionId,
          messageId: normalized.id,
        },
      ),
    )
  }

  return normalized
}

export function nodeSessionId(node) {
  return sessionIdOfNode(node)
}

function sessionIdOfNode(node) {
  if (nonEmptyString(node.sessionId)) {
    return node.sessionId
  }
  if (nonEmptyString(node.nodeId)) {
    return node.nodeId
  }
  return undefined
}

export function normalizeNode(node, session, diagnostics) {
  if (
    node.nodeId !== session.sessionId ||
    node.sessionId !== session.sessionId
  ) {
    diagnostics.push(
      diagnostic(
        'storage.node_identity_repaired',
        'Repaired a graph node so nodeId equals sessionId.',
        {
          sessionId: session.sessionId,
          previousNodeId: node.nodeId,
          previousSessionId: node.sessionId,
        },
      ),
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
    freezeReason: nonEmptyString(node.freezeReason)
      ? node.freezeReason
      : undefined,
    masterReason: nonEmptyString(node.masterReason)
      ? node.masterReason
      : undefined,
  }
}

export function nodeFromSession(session) {
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

export function placeholderSessionFromNode(sessionId, node) {
  const ts = now()
  return {
    sessionId,
    nodeId: sessionId,
    backend: 'claude-agent-sdk',
    backendSessionId: undefined,
    providerKind: 'claude-code',
    providerInstanceId: 'default-claude-sdk',
    providerSessionId: undefined,
    agent: nonEmptyString(node.agent) ? node.agent : 'claude-code',
    label: nonEmptyString(node.label)
      ? node.label
      : `Recovered ${sessionId.slice(0, 8)}`,
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

export function normalizeEdge(value) {
  if (!isObject(value)) {
    return {
      edgeId: randomUUID(),
      source: '',
      target: '',
      kind: 'create-session',
      ts: now(),
    }
  }

  const kind = validGraphEdgeKinds.has(value.kind)
    ? value.kind
    : 'create-session'

  return {
    ...value,
    edgeId: nonEmptyString(value.edgeId) ? value.edgeId : randomUUID(),
    source: nonEmptyString(value.source) ? value.source : '',
    target: nonEmptyString(value.target) ? value.target : '',
    kind,
    ts: nonEmptyString(value.ts) ? value.ts : now(),
    reportId: nonEmptyString(value.reportId) ? value.reportId : undefined,
    verdict: nonEmptyString(value.verdict) ? value.verdict : undefined,
    issueCount: Number.isFinite(value.issueCount)
      ? value.issueCount
      : undefined,
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

export function normalizeReport(value) {
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

export function normalizePlanCouncils(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  const validPhases = new Set(planCouncilPhases)
  const validArtifactKinds = new Set(['proposal', 'peer-review', 'synthesis'])
  for (const [workflowId, council] of Object.entries(value)) {
    const participantOrder = isObject(council) && Array.isArray(council.participantOrder)
      ? council.participantOrder
      : []
    const participants = isObject(council) && isObject(council.participants)
      ? council.participants
      : {}
    const participantIds = new Set(participantOrder)
    const artifactAuthorIds = new Set([
      ...participantOrder,
      ...(isObject(council) && Array.isArray(council.supersededParticipantIds)
        ? council.supersededParticipantIds
        : []),
    ])
    const participantRecords = participantOrder.map((sessionId) => participants[sessionId])
    const plannerCount = participantRecords.filter((participant) => participant?.role === 'planner').length
    const synthesizers = participantRecords.filter((participant) => participant?.role === 'synthesizer')
    const artifacts = isObject(council) && Array.isArray(council.artifacts)
      ? council.artifacts
      : []
    if (
      !isObject(council) ||
      !nonEmptyString(council.workflowId) ||
      council.workflowId !== workflowId ||
      !nonEmptyString(council.runId) ||
      !nonEmptyString(council.objective) ||
      !nonEmptyString(council.cwd) ||
      !validPhases.has(council.phase) ||
      participantIds.size !== participantOrder.length ||
      plannerCount < 2 ||
      plannerCount > 8 ||
      synthesizers.length !== 1 ||
      !nonEmptyString(council.synthesizerSessionId) ||
      synthesizers[0]?.sessionId !== council.synthesizerSessionId ||
      participantRecords.some(
        (participant, index) =>
          !isObject(participant) ||
          participant.sessionId !== participantOrder[index] ||
          !nonEmptyString(participant.key) ||
          !nonEmptyString(participant.label) ||
          !validProviderKinds.has(participant.providerKind) ||
          !nonEmptyString(participant.providerInstanceId) ||
          !isObject(participant.runtimeSettings),
      ) ||
      !Array.isArray(council.history) ||
      artifacts.some(
        (artifact) =>
          !isObject(artifact) ||
          !nonEmptyString(artifact.artifactId) ||
          !validArtifactKinds.has(artifact.kind) ||
          artifact.workflowId !== workflowId ||
          artifact.runId !== council.runId ||
          !artifactAuthorIds.has(artifact.authorSessionId) ||
          !nonEmptyString(artifact.contentRef) ||
          !nonEmptyString(artifact.digest) ||
          !Number.isInteger(artifact.sizeBytes) ||
          artifact.sizeBytes < 0 ||
          artifact.sizeBytes > planCouncilArtifactMaxBytes,
      )
    ) {
      diagnostics.push(
        diagnostic('storage.plan_council_skipped', 'Skipped an invalid Plan Council record.', { workflowId }),
      )
      continue
    }
    const normalized = clone(council)
    normalized.reviewTopology = council.reviewTopology === 'hub-and-spoke'
      ? 'hub-and-spoke'
      : 'full-mesh'
    if (plannerCount > 4 && normalized.reviewTopology !== 'hub-and-spoke') {
      diagnostics.push(
        diagnostic('storage.plan_council_skipped', 'Skipped a large Plan Council without hub-and-spoke review.', { workflowId }),
      )
      continue
    }
    normalized.advancement = {
      crossReview: ['human', 'master', 'auto'].includes(council.advancement?.crossReview)
        ? council.advancement.crossReview
        : 'human',
      synthesis: ['human', 'master', 'auto'].includes(council.advancement?.synthesis)
        ? council.advancement.synthesis
        : 'human',
    }
    normalized.barrierIds = isObject(council.barrierIds)
      ? clone(council.barrierIds)
      : {}
    for (const participant of Object.values(normalized.participants) as JsonRecord[]) {
      if (
        participant.expectedExecutionEnvelope !== undefined &&
        !validateExecutionEnvelope(participant.expectedExecutionEnvelope)
      ) {
        delete participant.expectedExecutionEnvelope
      }
    }
    for (const artifact of normalized.artifacts) {
      if (artifact.execution !== undefined && !validateExecutionEnvelope(artifact.execution)) {
        delete artifact.execution
      }
    }
    result[workflowId] = normalized
  }
  return result
}

export function normalizeWorkflowPlans(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  for (const [workflowId, versions] of Object.entries(value)) {
    if (!nonEmptyString(workflowId) || !isObject(versions)) {
      diagnostics.push(
        diagnostic('storage.workflow_plan_skipped', 'Skipped an invalid Workflow Plan collection.', { workflowId }),
      )
      continue
    }
    const normalizedVersions = {}
    for (const [versionKey, plan] of Object.entries(versions)) {
      const version = Number(versionKey)
      if (
        !isObject(plan) ||
        plan.workflowId !== workflowId ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        plan.version !== version ||
        !validWorkflowRecipes.has(plan.recipe) ||
        !validWorkflowPlanStatuses.has(plan.status) ||
        !nonEmptyString(plan.objective) ||
        !nonEmptyString(plan.scopeId) ||
        !Array.isArray(plan.participants) ||
        !Array.isArray(plan.relationships) ||
        !isObject(plan.recipeInput) ||
        plan.recipeInput.recipe !== plan.recipe ||
        !isObject(plan.autonomyPolicy)
      ) {
        diagnostics.push(
          diagnostic('storage.workflow_plan_skipped', 'Skipped an invalid Workflow Plan version.', { workflowId, version: versionKey }),
        )
        continue
      }
      normalizedVersions[version] = clone(plan)
    }
    if (Object.keys(normalizedVersions).length > 0) result[workflowId] = normalizedVersions
  }
  return result
}

export function normalizeWorkflowProposals(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  for (const [proposalId, proposal] of Object.entries(value)) {
    if (
      !isObject(proposal) ||
      proposal.proposalId !== proposalId ||
      !nonEmptyString(proposal.workflowId) ||
      !Number.isSafeInteger(proposal.baseVersion) ||
      proposal.baseVersion < 0 ||
      !isObject(proposal.proposedPlan) ||
      proposal.proposedPlan.workflowId !== proposal.workflowId ||
      !isObject(proposal.graphDiff) ||
      !isObject(proposal.validation) ||
      !validWorkflowProposalStatuses.has(proposal.status) ||
      !nonEmptyString(proposal.idempotencyKey) ||
      !nonEmptyString(proposal.createdAt) ||
      !nonEmptyString(proposal.updatedAt)
    ) {
      diagnostics.push(
        diagnostic('storage.workflow_proposal_skipped', 'Skipped an invalid Workflow Proposal.', { proposalId }),
      )
      continue
    }
    result[proposalId] = clone(proposal)
  }
  return result
}

export function normalizeWorkflowCapabilities(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  for (const [scopeId, capability] of Object.entries(value)) {
    if (
      !isObject(capability) ||
      capability.scopeId !== scopeId ||
      !isObject(capability.policy) ||
      !['review-first', 'auto-within-scope', 'ask-on-expansion'].includes(capability.policy.mode) ||
      !Array.isArray(capability.policy.allowedProviderInstanceIds) ||
      !Number.isSafeInteger(capability.policy.maxSessions) ||
      !Number.isSafeInteger(capability.policy.maxConcurrentSessions)
    ) {
      diagnostics.push(
        diagnostic('storage.workflow_capability_skipped', 'Skipped an invalid Scope Workflow Capability.', { scopeId }),
      )
      continue
    }
    result[scopeId] = clone(capability)
  }
  return result
}

export function normalizeDynamicSpawnGroups(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  const validStatuses = new Set(['creating', 'active', 'completed', 'failed', 'cancelled', 'capped'])
  const validChildStatuses = new Set(['prepared', 'running', 'completed', 'failed', 'cancelled', 'recycled'])
  for (const [groupId, group] of Object.entries(value)) {
    if (
      !isObject(group) || group.groupId !== groupId ||
      !nonEmptyString(group.subscriptionId) || !nonEmptyString(group.triggerEventId) ||
      !nonEmptyString(group.correlationKey) ||
      (group.execution !== undefined && !validateExecutionEnvelope(group.execution)) ||
      !nonEmptyString(group.templateId) ||
      !nonEmptyString(group.scopeId) || !nonEmptyString(group.parentSessionId) ||
      !Number.isSafeInteger(group.generationDepth) || group.generationDepth < 1 ||
      !validStatuses.has(group.status) || !Array.isArray(group.children) ||
      group.children.some((child) => !isObject(child) || !nonEmptyString(child.itemKey) ||
        !nonEmptyString(child.sessionId) || !validChildStatuses.has(child.status))
    ) {
      diagnostics.push(diagnostic(
        'storage.dynamic_spawn_group_skipped',
        'Skipped an invalid dynamic spawn group.',
        { groupId },
      ))
      continue
    }
    result[groupId] = clone(group)
  }
  return result
}

export function normalizeWorkflowWakeups(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  for (const [wakeupId, wakeup] of Object.entries(value)) {
    if (
      !isObject(wakeup) ||
      wakeup.wakeupId !== wakeupId ||
      !nonEmptyString(wakeup.workflowId) ||
      !Number.isSafeInteger(wakeup.workflowVersion) ||
      wakeup.workflowVersion < 1 ||
      !nonEmptyString(wakeup.scopeId) ||
      !nonEmptyString(wakeup.masterSessionId) ||
      !validWorkflowWakeupKinds.has(wakeup.kind) ||
      !validWorkflowWakeupStatuses.has(wakeup.status) ||
      !nonEmptyString(wakeup.summary) ||
      !Array.isArray(wakeup.sourceEventIds) ||
      !Array.isArray(wakeup.sourceSessionIds) ||
      !Array.isArray(wakeup.sourceSubscriptionIds) ||
      !nonEmptyString(wakeup.firstObservedAt) ||
      !nonEmptyString(wakeup.lastObservedAt) ||
      !Number.isSafeInteger(wakeup.occurrenceCount) ||
      wakeup.occurrenceCount < 1
    ) {
      diagnostics.push(
        diagnostic('storage.workflow_wakeup_skipped', 'Skipped an invalid Workflow Master wakeup.', { wakeupId }),
      )
      continue
    }
    result[wakeupId] = clone(wakeup)
  }
  return result
}

export function normalizeBarriers(value, diagnostics: JsonRecord[] = []) {
  if (!isObject(value)) return {}
  const result = {}
  for (const [barrierId, barrier] of Object.entries(value)) {
    const expected = isObject(barrier) && Array.isArray(barrier.expectedParticipantKeys)
      ? barrier.expectedParticipantKeys
      : []
    const arrivals = isObject(barrier) && isObject(barrier.arrivals)
      ? Object.entries(barrier.arrivals)
      : []
    const invalidArrival = arrivals.some(([participantKey, arrival]) =>
      !isObject(arrival) ||
      arrival.participantKey !== participantKey ||
      !expected.includes(participantKey) ||
      !Number.isSafeInteger(arrival.attempt) || arrival.attempt < 1 ||
      !nonEmptyString(arrival.eventId) || !nonEmptyString(arrival.arrivedAt) ||
      !validateExecutionEnvelope(arrival.envelope) ||
      arrival.envelope.attempt !== arrival.attempt ||
      arrival.envelope.workflowId !== barrier.workflowId ||
      arrival.envelope.workflowVersion !== barrier.workflowVersion ||
      arrival.envelope.runId !== barrier.runId ||
      arrival.envelope.phaseId !== barrier.phaseId ||
      arrival.envelope.correlationKey !== barrier.correlationKey,
    )
    const invalidQuorum = isObject(barrier) && barrier.mode === 'quorum' &&
      (!Number.isSafeInteger(barrier.quorum) || barrier.quorum < 1 || barrier.quorum > expected.length)
    const releasedWithoutProof = isObject(barrier) && barrier.status === 'released' &&
      (!nonEmptyString(barrier.releasedAt) || !nonEmptyString(barrier.releasedEventId) ||
        arrivals.length < (barrier.mode === 'any' ? 1 : barrier.mode === 'quorum' ? barrier.quorum : expected.length))
    const invalidTerminal = isObject(barrier) && (
      (barrier.status === 'timed-out' &&
        (!nonEmptyString(barrier.timedOutAt) || !nonEmptyString(barrier.terminalReason))) ||
      (barrier.status === 'cancelled' &&
        (!nonEmptyString(barrier.cancelledAt) || !nonEmptyString(barrier.terminalReason)))
    )
    const pendingAlreadySatisfied = isObject(barrier) && barrier.status === 'pending' &&
      arrivals.length >= (barrier.mode === 'any'
        ? 1
        : barrier.mode === 'quorum'
          ? barrier.quorum
          : expected.length)
    if (
      !isObject(barrier) || barrier.barrierId !== barrierId ||
      !nonEmptyString(barrier.workflowId) || !Number.isSafeInteger(barrier.workflowVersion) ||
      !nonEmptyString(barrier.runId) || !nonEmptyString(barrier.phaseId) ||
      !nonEmptyString(barrier.correlationKey) || !validBarrierModes.has(barrier.mode) ||
      !validBarrierStatuses.has(barrier.status) || !Array.isArray(barrier.expectedParticipantKeys) ||
      barrier.expectedParticipantKeys.length === 0 ||
      new Set(barrier.expectedParticipantKeys).size !== barrier.expectedParticipantKeys.length ||
      barrier.expectedParticipantKeys.some((key) => !nonEmptyString(key)) ||
      !isObject(barrier.arrivals) || invalidArrival || invalidQuorum || releasedWithoutProof ||
      invalidTerminal || pendingAlreadySatisfied ||
      (barrier.deadline !== undefined && !Number.isFinite(Date.parse(barrier.deadline))) ||
      !nonEmptyString(barrier.createdAt)
    ) {
      diagnostics.push(diagnostic('storage.barrier_skipped', 'Skipped an invalid Workflow Barrier.', { barrierId }))
      continue
    }
    result[barrierId] = clone(barrier)
  }
  return result
}

export function normalizeClusters(clusters: JsonRecord) {
  return Object.fromEntries(
    Object.entries(clusters)
      .filter(([, cluster]) => isObject(cluster))
      .map(([clusterId, cluster]) => {
        let loopPolicy
        try {
          loopPolicy = cluster.loopPolicy
            ? normalizeLoopPolicy(cluster.loopPolicy)
            : undefined
        } catch {
          loopPolicy = undefined
        }

        const loopState = normalizeLoopState(cluster.loopState)

        return [
          clusterId,
          {
            ...cluster,
            clusterId: nonEmptyString(cluster.clusterId)
              ? cluster.clusterId
              : clusterId,
            label: nonEmptyString(cluster.label) ? cluster.label : clusterId,
            nodeIds: Array.isArray(cluster.nodeIds)
              ? cluster.nodeIds.filter(nonEmptyString)
              : [],
            frozen: cluster.frozen === true,
            freezeReason: nonEmptyString(cluster.freezeReason)
              ? cluster.freezeReason
              : undefined,
            ...(nonEmptyString(cluster.masterSessionId)
              ? {
                  masterSessionId: cluster.masterSessionId,
                }
              : {}),
            ...(loopPolicy ? { loopPolicy } : {}),
            ...(loopState ? { loopState } : {}),
          },
        ]
      }),
  )
}

export function messagesFromLegacySession(session) {
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
