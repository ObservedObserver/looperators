import type { CollaborationDiscussion, CollaborationSession, DiscussionAssessment } from '@shared/collaboration';

export function assessmentIsCurrent(assessment: DiscussionAssessment | undefined, discussion: CollaborationDiscussion) {
  return Boolean(
    assessment &&
    assessment.goalRevision === discussion.goalRevision &&
    assessment.cohortRevision === discussion.cohortRevision &&
    assessment.basedOnSeq === discussion.latestSubstantiveSeq,
  );
}

export function workspaceMatchesSearch(workspace: CollaborationSession, search: string) {
  const text = search.trim().toLocaleLowerCase();
  return (
    !text ||
    [
      workspace.title,
      workspace.cwd,
      ...workspace.members.flatMap((member) => [member.label, member.role ?? '']),
      ...Object.values(workspace.discussions).map((discussion) => discussion.goal),
      ...workspace.events.map((event) => event.content),
    ].some((value) => value.toLocaleLowerCase().includes(text))
  );
}

export type CollaborationCommand = (kind: string, input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

export function threadEvents(workspace: CollaborationSession, threadId: string) {
  const discussions = new Set(
    Object.values(workspace.discussions)
      .filter((discussion) => discussion.sourceThreadId === threadId)
      .map((discussion) => discussion.discussionId),
  );
  return workspace.events.filter(
    (event) => event.eventId !== threadId && (event.threadId === threadId || Boolean(event.discussionId && discussions.has(event.discussionId))),
  );
}

export function threadReplyCounts(workspace: CollaborationSession) {
  const counts: Record<string, number> = {};
  for (const event of workspace.events) {
    if (event.kind !== 'message') continue;
    const root = event.threadId ?? (event.discussionId ? workspace.discussions[event.discussionId]?.sourceThreadId : undefined);
    if (root) counts[root] = (counts[root] ?? 0) + 1;
  }
  return counts;
}
