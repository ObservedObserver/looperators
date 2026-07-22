export const planCouncilPhases = [
  'configured',
  'drafting-plans',
  'ready-for-cross-review',
  'reviewing-peers',
  'ready-for-synthesis',
  'synthesizing',
  'blocked',
  'completed',
  'stopped',
  'failed',
] as const

export type PlanCouncilPhase = (typeof planCouncilPhases)[number]
export type PlanCouncilArtifactKind = 'proposal' | 'peer-review' | 'synthesis'

export type PlanCouncilRuntimeSettings = {
  runtimeMode: 'approval-required' | 'auto' | 'auto-accept-edits' | 'full-access'
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  interactionMode?: 'default' | 'plan'
}

export type PlanCouncilAgentSpec = {
  key: string
  label: string
  providerKind: 'claude-code' | 'codex' | 'grok'
  providerInstanceId: string
  runtimeSettings: PlanCouncilRuntimeSettings
}

export type StartPlanCouncilInput = {
  objective: string
  cwd: string
  reviewFocus?: string
  planners: PlanCouncilAgentSpec[]
  synthesizer: PlanCouncilAgentSpec
  /** Councils above four planners must use a linear hub review topology. */
  reviewTopology?: 'full-mesh' | 'hub-and-spoke'
  coordinatorSessionId?: string
  advancement?: {
    crossReview: 'human' | 'master' | 'auto'
    synthesis: 'human' | 'master' | 'auto'
  }
  workflowPlanRef?: { workflowId: string; version: number }
}

export type PlanCouncilParticipant = PlanCouncilAgentSpec & {
  role: 'planner' | 'reviewer' | 'synthesizer'
  sessionId: string
  expectedTurnId?: string
  expectedArtifactKind?: PlanCouncilArtifactKind
  expectedExecutionEnvelope?: import('./execution-envelope.js').ExecutionEnvelope
}

export type PlanCouncilArtifact = {
  artifactId: string
  kind: PlanCouncilArtifactKind
  workflowId: string
  runId: string
  phaseId: string
  round: number
  version: number
  authorSessionId: string
  contentRef: string
  digest: string
  sizeBytes: number
  createdAt: string
  execution?: import('./execution-envelope.js').ExecutionEnvelope
  governingWorkflowId?: string
}

export type PlanCouncilHistoryEntry = {
  id: string
  type: 'started' | 'phase-changed' | 'artifact-created' | 'blocked' | 'retried' | 'stopped' | 'failed'
  ts: string
  phase: PlanCouncilPhase
  summary: string
}

export type PlanCouncil = {
  workflowId: string
  runId: string
  objective: string
  cwd: string
  reviewFocus?: string
  phase: PlanCouncilPhase
  round: 1
  coordinatorSessionId?: string
  synthesizerSessionId: string
  reviewTopology: 'full-mesh' | 'hub-and-spoke'
  participantOrder: string[]
  participants: Record<string, PlanCouncilParticipant>
  artifacts: PlanCouncilArtifact[]
  history: PlanCouncilHistoryEntry[]
  createdAt: string
  updatedAt: string
  stoppedAt?: string
  failure?: string
  blockedAt?: string
  blockedFromPhase?: Exclude<PlanCouncilPhase, 'blocked'>
  blockedParticipantId?: string
  blockedParticipantIds?: string[]
  blockReason?: string
  blockKind?: 'resource-budget'
  advancement: {
    crossReview: 'human' | 'master' | 'auto'
    synthesis: 'human' | 'master' | 'auto'
  }
  barrierIds?: Partial<Record<'proposal' | 'peer-review' | 'synthesis', string>>
}

export function planCouncilProductView(council: PlanCouncil) {
  const plannerIds = council.participantOrder.filter(
    (sessionId) => council.participants[sessionId]?.role === 'planner',
  )
  const proposalAuthors = new Set(
    council.artifacts.filter((artifact) => artifact.kind === 'proposal').map((artifact) => artifact.authorSessionId),
  )
  const reviewAuthors = new Set(
    council.artifacts.filter((artifact) => artifact.kind === 'peer-review').map((artifact) => artifact.authorSessionId),
  )
  const reviewerIds = council.reviewTopology === 'hub-and-spoke'
    ? [council.synthesizerSessionId]
    : council.participantOrder.filter(
        (sessionId) => ['planner', 'reviewer'].includes(council.participants[sessionId]?.role),
      )
  const waitingGate = council.phase === 'ready-for-cross-review'
    ? { phase: 'cross-review' as const, policy: council.advancement?.crossReview ?? 'human' }
    : council.phase === 'ready-for-synthesis'
      ? { phase: 'synthesis' as const, policy: council.advancement?.synthesis ?? 'human' }
      : undefined
  return {
    plannerCount: plannerIds.length,
    reviewerCount: reviewerIds.length,
    proposalsReady: plannerIds.filter((id) => proposalAuthors.has(id)).length,
    reviewsReady: reviewerIds.filter((id) => reviewAuthors.has(id)).length,
    canStartCrossReview: council.phase === 'ready-for-cross-review' && waitingGate?.policy === 'human',
    canStartSynthesis: council.phase === 'ready-for-synthesis' && waitingGate?.policy === 'human',
    waitingGate,
    canRetryBlockedParticipant: council.phase === 'blocked' && Boolean(council.blockedParticipantId),
    canStop: !['completed', 'stopped', 'failed'].includes(council.phase),
    terminal: ['completed', 'stopped', 'failed'].includes(council.phase),
  }
}

export type PlanCouncilValidationIssue = { field: string; message: string }

function trimmed(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateAgent(
  field: string,
  agent: PlanCouncilAgentSpec | undefined,
  providerIds: Set<string>,
  issues: PlanCouncilValidationIssue[],
) {
  if (!agent) {
    issues.push({ field, message: `Configure ${field}.` })
    return
  }
  if (!trimmed(agent.key)) issues.push({ field: `${field}.key`, message: `${field} needs a stable key.` })
  if (!trimmed(agent.label)) issues.push({ field: `${field}.label`, message: `${field} needs a name.` })
  if (!trimmed(agent.providerInstanceId)) {
    issues.push({ field: `${field}.providerInstanceId`, message: `${field} needs a provider.` })
  } else if (providerIds.size > 0 && !providerIds.has(agent.providerInstanceId)) {
    issues.push({ field: `${field}.providerInstanceId`, message: `${field} provider is unavailable.` })
  }
  if (agent.runtimeSettings?.sandbox !== 'read-only') {
    issues.push({ field: `${field}.runtimeSettings.sandbox`, message: `${field} must use the read-only sandbox in Plan Council v1.` })
  }
}

export function validatePlanCouncilStart(
  input: StartPlanCouncilInput,
  context: { providerInstanceIds?: string[]; sessionIds?: string[] } = {},
) {
  const issues: PlanCouncilValidationIssue[] = []
  const providerIds = new Set(context.providerInstanceIds ?? [])
  if (!trimmed(input?.objective)) issues.push({ field: 'objective', message: 'Describe the planning task.' })
  if (!trimmed(input?.cwd)) issues.push({ field: 'cwd', message: 'Choose a workspace.' })
  if (!Array.isArray(input?.planners) || input.planners.length < 2 || input.planners.length > 8) {
    issues.push({ field: 'planners', message: 'Plan Council requires 2 to 8 planners.' })
  }
  const reviewTopology = input?.reviewTopology ?? 'full-mesh'
  if (!['full-mesh', 'hub-and-spoke'].includes(reviewTopology)) {
    issues.push({ field: 'reviewTopology', message: 'Review topology must be full-mesh or hub-and-spoke.' })
  }
  if ((input?.planners?.length ?? 0) > 4 && reviewTopology !== 'hub-and-spoke') {
    issues.push({ field: 'reviewTopology', message: 'Councils above four planners require hub-and-spoke review.' })
  }
  const keys = new Set<string>()
  for (const [index, planner] of (input?.planners ?? []).entries()) {
    validateAgent(`planners.${index}`, planner, providerIds, issues)
    const key = trimmed(planner?.key)
    if (key && keys.has(key)) issues.push({ field: `planners.${index}.key`, message: `Planner key must be unique: ${key}.` })
    keys.add(key)
  }
  validateAgent('synthesizer', input?.synthesizer, providerIds, issues)
  if (trimmed(input?.synthesizer?.key) && keys.has(trimmed(input.synthesizer.key))) {
    issues.push({ field: 'synthesizer.key', message: 'Synthesizer key must be different from planner keys.' })
  }
  if (
    trimmed(input?.coordinatorSessionId) &&
    context.sessionIds &&
    !context.sessionIds.includes(trimmed(input.coordinatorSessionId))
  ) {
    issues.push({ field: 'coordinatorSessionId', message: 'The selected Coordinator session no longer exists.' })
  }
  for (const field of ['crossReview', 'synthesis'] as const) {
    const gate = input?.advancement?.[field]
    if (gate !== undefined && !['human', 'master', 'auto'].includes(gate)) {
      issues.push({ field: `advancement.${field}`, message: `${field} advancement must be human, master, or auto.` })
    }
  }
  return { ok: issues.length === 0, issues }
}

export function plannerPrompt(objective: string, reviewFocus?: string, roleLabel?: string) {
  return [
    'You are an independent Planner in an Orrery Plan Council.',
    'This is the independent proposal phase. No peer proposal has been delivered yet; cross-review will happen in a later activation.',
    'Inspect only the project workspace in read-only mode. Never inspect Orrery channel/inbox directories or search for other Council participants.',
    'Use provider-native file read/search tools when needed. Do not run shell commands, edit files, create commits, or start other Agents.',
    `Planning task: ${trimmed(objective)}`,
    trimmed(roleLabel) ? `Your independent perspective: ${trimmed(roleLabel)}. Use that perspective as an emphasis, while still covering the whole task.` : undefined,
    trimmed(reviewFocus) ? `Review focus: ${trimmed(reviewFocus)}` : undefined,
    'Produce a concrete implementation plan with architecture, important tradeoffs, risks, staged tasks, and verification. State uncertainties explicitly. Keep the response under 1,400 words, prioritize decisions over boilerplate, then stop.',
  ].filter(Boolean).join('\n\n')
}

export function crossReviewPrompt(reviewFocus?: string) {
  return [
    'Cross-review the other planners\' proposals delivered in your context channel.',
    'Do not revise your original proposal and do not edit files.',
    trimmed(reviewFocus) ? `Review focus: ${trimmed(reviewFocus)}` : undefined,
    'For each peer proposal, cite at least one specific claim or design choice. Identify agreements, conflicts, missing constraints, and recommended changes. Finish with the decisions a synthesizer should make. Keep the response under 900 words, then stop.',
  ].filter(Boolean).join('\n\n')
}

export function synthesizerPrompt(objective: string, reviewFocus?: string) {
  return [
    'You are the Synthesizer in an Orrery Plan Council.',
    `Original planning task: ${trimmed(objective)}`,
    trimmed(reviewFocus) ? `Review focus: ${trimmed(reviewFocus)}` : undefined,
    'Read every proposal and peer review delivered in your context channel.',
    'Produce one final plan with: consensus, material disagreements, explicit choices and reasons, rejected alternatives, staged implementation tasks, risks, and a concrete verification plan. Keep the response under 1,800 words. Do not edit files, then stop.',
  ].filter(Boolean).join('\n\n')
}
