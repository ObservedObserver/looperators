import type { CollaborationSession } from '../../../shared/collaboration.js'
import { diagnostic, isObject, type JsonRecord } from '../runtimeCommon.js'

/** Reject broken domain records without losing ordinary chats or other workspaces. */
export function normalizeCollaborationSessions(value: unknown, diagnostics: JsonRecord[]): Record<string, CollaborationSession> {
  const result: Record<string, CollaborationSession> = {}
  if (!isObject(value)) return result
  for (const [sessionId, raw] of Object.entries(value as JsonRecord)) {
    try {
      const workspace = structuredClone(raw) as CollaborationSession
      if (!workspace || workspace.sessionId !== sessionId || workspace.sessionType !== 'collaboration' || typeof workspace.title !== 'string' || typeof workspace.cwd !== 'string' || !Array.isArray(workspace.members) || workspace.members.length < 2 || !Array.isArray(workspace.events) || !isObject(workspace.discussions) || !isObject(workspace.triggers) || !Array.isArray(workspace.councilIds)) throw new Error('Invalid workspace shape.')
      const memberIds = new Set<string>()
      const sessionIds = new Set<string>()
      for (const member of workspace.members) {
        if (!member.memberId || !member.sessionId || !member.label || memberIds.has(member.memberId) || sessionIds.has(member.sessionId) || !Number.isSafeInteger(member.lastReadSeq)) throw new Error('Invalid member identity or cursor.')
        memberIds.add(member.memberId); sessionIds.add(member.sessionId)
        if (!isObject(member.readCursors)) member.readCursors = {}
        if (Object.values(member.readCursors).some((cursor) => !Number.isSafeInteger(cursor) || cursor < 0)) throw new Error('Invalid member read cursor.')
      }
      let previousSeq = 0
      const threadRoots = new Set(workspace.events.filter((event) => event.scope === 'room' && event.kind === 'message' && !event.threadId).map((event) => event.eventId))
      for (const event of workspace.events) {
        if (!event.eventId || !Number.isSafeInteger(event.seq) || event.seq <= previousSeq || !['room', 'discussion'].includes(event.scope) || !['message', 'assessment', 'system'].includes(event.kind) || typeof event.content !== 'string' || !Array.isArray(event.mentionedMemberIds)) throw new Error('Invalid shared event log.')
        previousSeq = event.seq
        if (event.threadId !== undefined && (event.scope !== 'room' || !threadRoots.has(event.threadId))) throw new Error('Invalid reply thread reference.')
      }
      for (const [id, discussion] of Object.entries(workspace.discussions)) {
        if (discussion.sourceThreadId !== undefined && !threadRoots.has(discussion.sourceThreadId)) throw new Error('Invalid discussion thread reference.')
        if (discussion.discussionId !== id || !discussion.goal || !['active', 'paused', 'completed', 'cancelled'].includes(discussion.status) || !Array.isArray(discussion.requiredMemberIds) || !discussion.requiredMemberIds.length || discussion.requiredMemberIds.some((memberId) => !memberIds.has(memberId)) || !isObject(discussion.assessments) || !isObject(discussion.issues) || !Number.isSafeInteger(discussion.latestSubstantiveSeq) || discussion.latestSubstantiveSeq > previousSeq || !Number.isSafeInteger(discussion.goalRevision) || !Number.isSafeInteger(discussion.cohortRevision) || !Number.isSafeInteger(discussion.maxTurns) || discussion.maxTurns < 1 || !Number.isSafeInteger(discussion.turnsUsed)) throw new Error('Invalid discussion state.')
      }
      for (const [id, trigger] of Object.entries(workspace.triggers)) {
        if (trigger.threadId !== undefined && (trigger.scope !== 'room' || !threadRoots.has(trigger.threadId))) throw new Error('Invalid trigger thread reference.')
        if (trigger.triggerId !== id || !memberIds.has(trigger.memberId) || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(trigger.status) || !['room', 'discussion'].includes(trigger.scope) || !Number.isSafeInteger(trigger.throughSeq) || (trigger.discussionId && !workspace.discussions[trigger.discussionId])) throw new Error('Invalid durable trigger.')
      }
      for (const member of workspace.members) {
        if (member.attentionTriggerId !== undefined && workspace.triggers[member.attentionTriggerId]?.memberId !== member.memberId) throw new Error('Invalid member attention source.')
      }
      if (workspace.activeDiscussionId && !workspace.discussions[workspace.activeDiscussionId]) throw new Error('Missing active discussion.')
      result[sessionId] = workspace
    } catch (error) {
      diagnostics.push(diagnostic('storage.collaboration_skipped', 'Skipped an invalid collaboration workspace.', { sessionId, error: error instanceof Error ? error.message : String(error) }))
    }
  }
  return result
}
