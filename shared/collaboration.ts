/** Shared collaboration domain. Provider transcripts remain private. */
export type CollaborationMemberInput = {
  label: string
  role?: string
  providerKind: 'claude-code' | 'codex' | 'grok'
  providerInstanceId: string
  runtimeSettings?: Record<string, unknown>
  cwd?: string
}

export type CollaborationMember = {
  memberId: string
  label: string
  role?: string
  sessionId: string
  lastReadSeq: number
  readCursors: Record<string, number>
  attention?: string
  attentionTriggerId?: string
}

export type CollaborationEvent = {
  eventId: string
  seq: number
  scope: 'room' | 'discussion'
  discussionId?: string
  /** The top-level Room message whose reply thread contains this event. */
  threadId?: string
  kind: 'message' | 'assessment' | 'system'
  author: 'human' | 'runtime' | string
  content: string
  mentionedMemberIds: string[]
  createdAt: string
  issue?: { issueId: string; summary: string; status: 'open' | 'resolved' }
}

export type DiscussionAssessment = {
  memberId: string
  verdict: 'satisfied' | 'not_satisfied' | 'blocked'
  reason: string
  issueId?: string
  goalRevision: number
  cohortRevision: number
  basedOnSeq: number
  runId: string
  createdAt: string
}

export type CollaborationDiscussion = {
  discussionId: string
  /** Optional Room thread that supplied the discussion's starting context. */
  sourceThreadId?: string
  goal: string
  acceptanceCriteria?: string
  goalRevision: number
  cohortRevision: number
  requiredMemberIds: string[]
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  health: 'healthy' | 'degraded'
  startedSeq: number
  latestSubstantiveSeq: number
  assessments: Record<string, DiscussionAssessment>
  issues: Record<string, { issueId: string; summary: string; status: 'open' | 'resolved'; authorMemberId: string }>
  maxTurns: number
  turnsUsed: number
  createdAt: string
  completedAt?: string
  pauseReason?: string
}

export type CollaborationTrigger = {
  triggerId: string
  memberId: string
  scope: 'room' | 'discussion'
  discussionId?: string
  threadId?: string
  throughSeq: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  runId?: string
  readThroughSeq?: number
  published?: boolean
  assessed?: boolean
  error?: string
}

export type CollaborationSession = {
  sessionType: 'collaboration'
  sessionId: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  archived: boolean
  members: CollaborationMember[]
  events: CollaborationEvent[]
  discussions: Record<string, CollaborationDiscussion>
  activeDiscussionId?: string
  triggers: Record<string, CollaborationTrigger>
  councilIds: string[]
}

export type CreateCollaborationSessionInput = {
  title: string
  cwd: string
  members: CollaborationMemberInput[]
}

export function discussionHasAttention(workspace: CollaborationSession, discussion: CollaborationDiscussion): boolean {
  return workspace.members.some((member) => member.attention && (
    discussion.requiredMemberIds.includes(member.memberId) || Boolean(discussion.sourceThreadId && member.attentionTriggerId &&
      workspace.triggers[member.attentionTriggerId]?.threadId === discussion.sourceThreadId)
  ))
}

export function discussionCanComplete(workspace: CollaborationSession, discussion: CollaborationDiscussion): boolean {
  return discussion.status === 'active' && discussion.requiredMemberIds.length > 0 &&
    !discussionHasAttention(workspace, discussion) &&
    !Object.values(discussion.issues).some((issue) => issue.status === 'open') &&
    !Object.values(workspace.triggers).some((trigger) => (trigger.discussionId === discussion.discussionId && discussion.requiredMemberIds.includes(trigger.memberId) || Boolean(discussion.sourceThreadId && trigger.threadId === discussion.sourceThreadId)) &&
      ['pending', 'running'].includes(trigger.status)) &&
    discussion.requiredMemberIds.every((memberId) => {
      const assessment = discussion.assessments[memberId]
      const member = workspace.members.find((item) => item.memberId === memberId)
      return member && !member.attention && assessment?.verdict === 'satisfied' &&
        assessment.goalRevision === discussion.goalRevision &&
        assessment.cohortRevision === discussion.cohortRevision &&
        assessment.basedOnSeq === discussion.latestSubstantiveSeq
    })
}
