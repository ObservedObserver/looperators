import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import {
  discussionCanComplete,
  discussionHasAttention,
  type CollaborationSession,
  type CollaborationDiscussion,
  type CollaborationEvent,
  type DiscussionAssessment,
} from '../../../shared/collaboration.js'
import type { JsonRecord } from '../runtimeCommon.js'

export type CollaborationContext = { actor: { kind: string; ref?: string }; causeId?: string }
type Context = CollaborationContext
export interface CollaborationRuntimeHost {
  state(): JsonRecord
  getState(): JsonRecord
  createSession(input: JsonRecord, ctx: Context): Promise<{ sessionId: string }>
  activate(input: { sessionId: string; note: string }, ctx: Context): Promise<{ runId: string }>
  dispatch(command: JsonRecord): Promise<JsonRecord>
  stageEffect(label: string, run: () => void): void
  touch(): void
  broadcast(event: JsonRecord): void
  appendEvent(type: string, payload: JsonRecord, ctx: Context): unknown
  runId(sessionId: string): string | undefined
  isBusy(sessionId: string): boolean
}

const timestamp = () => new Date().toISOString()
const text = (value: unknown, label: string, max = 32000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must contain 1–${max} characters.`)
  return value.trim()
}
const optionalText = (value: unknown, max = 32000) => value === undefined || value === '' ? undefined : text(value, 'Text', max)
const human = (ctx: Context) => { if (ctx.actor.kind !== 'human') throw new Error('Only a human can configure or control a collaboration workspace.') }
const runtime = (ctx: Context) => { if (ctx.actor.kind !== 'runtime') throw new Error('This collaboration command is runtime-only.') }
const maxTurns = (value: unknown) => {
  const count = value ?? 24
  if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 1000) throw new Error('Discussion turn cap must be between 1 and 1000.')
  return Number(count)
}

/** The durable trigger table is the domain outbox; post-commit callbacks only drain it. */
export class CollaborationRuntime {
  #host: CollaborationRuntimeHost
  #suspended = false
  constructor(host: CollaborationRuntimeHost) { this.#host = host }
  private get workspaces(): Record<string, CollaborationSession> {
    return this.#host.state().collaborationSessions ??= {}
  }
  memberForSession(source: string) {
    for (const workspace of Object.values(this.workspaces)) {
      const member = workspace.members.find((candidate) => candidate.sessionId === source)
      if (member) return { workspace, member }
    }
    return undefined
  }
  private workspace(id: unknown) {
    const workspace = this.workspaces[text(id, 'Workspace id', 200)]
    if (!workspace) throw new Error('Unknown collaboration workspace.')
    return workspace
  }
  private discussion(workspace: CollaborationSession, id: unknown) {
    const discussion = workspace.discussions[text(id ?? workspace.activeDiscussionId, 'Discussion id', 200)]
    if (!discussion) throw new Error('Unknown collaboration discussion.')
    return discussion
  }
  private threadRoot(workspace: CollaborationSession, id: unknown) {
    const rootId = text(id, 'Thread id', 200)
    const root = workspace.events.find((event) => event.eventId === rootId && event.kind === 'message' && event.scope === 'room' && !event.threadId)
    if (!root) throw new Error('A thread must reply to a top-level message in this workspace.')
    return root
  }
  private members(workspace: CollaborationSession, ids: unknown, minimum = 1): string[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !workspace.members.some((member) => member.memberId === id))) throw new Error('Select existing workspace members.')
    const memberIds = [...new Set(ids)] as string[]
    if (memberIds.length < minimum) throw new Error('A discussion requires at least two different members.')
    return memberIds
  }
  private emit(workspace: CollaborationSession, event: Omit<CollaborationEvent, 'eventId' | 'seq' | 'createdAt'>) {
    const entry: CollaborationEvent = { ...event, eventId: randomUUID(), seq: (workspace.events.at(-1)?.seq ?? 0) + 1, createdAt: timestamp() }
    workspace.events.push(entry)
    return entry
  }
  private system(workspace: CollaborationSession, content: string, discussion?: CollaborationDiscussion) {
    return this.emit(workspace, { kind: 'system', scope: discussion ? 'discussion' : 'room', discussionId: discussion?.discussionId, author: 'runtime', content, mentionedMemberIds: [] })
  }
  private changed(workspace: CollaborationSession, ctx: Context, kind: string) {
    workspace.updatedAt = timestamp()
    this.#host.appendEvent(`collaboration.${kind}`, { sessionId: workspace.sessionId, latestSeq: workspace.events.at(-1)?.seq ?? 0 }, ctx)
    this.#host.touch()
    this.#host.broadcast({ type: 'runtime.state', state: this.#host.getState() })
    this.scheduleDrain()
    return { workspace: structuredClone(workspace), state: this.#host.getState() }
  }
  private scheduleDrain() {
    this.#host.stageEffect('drain collaboration triggers', () => queueMicrotask(() => this.drain()))
  }
  suspend() { this.#suspended = true }
  resume() { this.#suspended = false; this.scheduleDrain() }
  private queue(workspace: CollaborationSession, memberId: string, scope: 'room' | 'discussion', throughSeq: number, discussionId?: string, threadId?: string) {
    const pending = Object.values(workspace.triggers).find((trigger) => trigger.memberId === memberId && trigger.scope === scope && trigger.discussionId === discussionId && trigger.threadId === threadId && trigger.status === 'pending')
    if (pending) { pending.throughSeq = Math.max(pending.throughSeq, throughSeq); return }
    const triggerId = randomUUID()
    workspace.triggers[triggerId] = { triggerId, memberId, scope, discussionId, ...(threadId ? { threadId } : {}), throughSeq, status: 'pending' }
  }
  private notifyDiscussion(workspace: CollaborationSession, discussion: CollaborationDiscussion, seq: number, except?: string) {
    for (const memberId of discussion.requiredMemberIds) {
      if (memberId !== except) this.queue(workspace, memberId, 'discussion', seq, discussion.discussionId)
    }
  }
  private drain() {
    if (this.#suspended) return
    for (const workspace of Object.values(this.workspaces)) {
      if (workspace.archived) continue
      const dispatchedMembers = new Set<string>()
      for (const trigger of Object.values(workspace.triggers)) {
        const member = workspace.members.find((candidate) => candidate.memberId === trigger.memberId)
        if (trigger.status !== 'pending' || !member || member.attention || dispatchedMembers.has(member.memberId) || this.#host.isBusy(member.sessionId)) continue
        if (Object.values(workspace.triggers).some((candidate) => candidate.memberId === member.memberId && candidate.status === 'running')) continue
        if (trigger.discussionId && workspace.discussions[trigger.discussionId]?.status !== 'active') continue
        dispatchedMembers.add(member.memberId)
        void this.#host.dispatch({ kind: 'dispatch_collaboration_trigger', actor: { kind: 'runtime' }, input: { sessionId: workspace.sessionId, triggerId: trigger.triggerId } }).catch(() => { /* command rollback retains a recoverable pending trigger */ })
      }
    }
  }
  async create(input: JsonRecord, ctx: Context) {
    human(ctx)
    const title = text(input.title, 'Workspace title', 160)
    const cwd = fs.realpathSync(text(input.cwd, 'Workspace directory', 4096))
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Workspace directory must be a directory.')
    if (!Array.isArray(input.members) || input.members.length < 2 || input.members.length > 8) throw new Error('Choose 2–8 collaboration members.')
    const labels = new Set<string>()
    for (const spec of input.members) {
      const label = text(spec.label, 'Member name', 100)
      if (labels.has(label.toLocaleLowerCase())) throw new Error('Member names must be unique.')
      labels.add(label.toLocaleLowerCase())
      if (!['claude-code', 'codex', 'grok'].includes(spec.providerKind)) throw new Error('Unknown member provider.')
      if (spec.providerKind === 'grok') throw new Error('Grok collaboration is unavailable until its provider exposes a verified read-only mode. Choose Codex or Claude.')
      if (!this.#host.state().providerInstances.some((provider: JsonRecord) => provider.providerInstanceId === spec.providerInstanceId && provider.kind === spec.providerKind)) throw new Error('Member provider instance is unavailable.')
      if (spec.cwd && fs.realpathSync(spec.cwd) !== cwd) throw new Error('Read-only collaboration members must use the workspace directory.')
    }
    const ts = timestamp()
    const workspace: CollaborationSession = { sessionType: 'collaboration', sessionId: `collaboration-${randomUUID()}`, title, cwd, createdAt: ts, updatedAt: ts, archived: false, members: [], events: [], discussions: {}, triggers: {}, councilIds: [] }
    for (const spec of input.members) {
      const created = await this.#host.createSession({
        label: spec.label.trim(), cwd, workMode: 'local', providerKind: spec.providerKind, providerInstanceId: spec.providerInstanceId,
        runtimeSettings: { ...spec.runtimeSettings, runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
        prompt: `You are ${spec.label.trim()} in collaboration workspace ${title}. ${optionalText(spec.role, 1000) ?? ''}\nYour provider transcript is private. Only mcp__orrery_membrane__post_collaboration_message publishes to the shared workspace. Use mcp__orrery_membrane__read_collaboration_updates first, publish substantive findings, and use mcp__orrery_membrane__set_discussion_assessment for goal discussions. Never create, activate, deliver to, or control other sessions. Work read-only; do not edit files, spawn agents, or poll. Follow the current room or goal turn instructions. In a goal turn, publish only new findings and finish with a current assessment. In ordinary chat, publish the requested reply and stop.`,
      }, ctx)
      workspace.members.push({ memberId: randomUUID(), label: spec.label.trim(), role: optionalText(spec.role, 1000), sessionId: created.sessionId, lastReadSeq: 0, readCursors: {} })
    }
    this.workspaces[workspace.sessionId] = workspace
    this.system(workspace, 'Workspace created. Members start only when mentioned or when a discussion begins.')
    return { sessionId: workspace.sessionId, ...this.changed(workspace, ctx, 'created') }
  }
  private authenticated(ctx: Context) {
    if (ctx.actor.kind !== 'agent' || !ctx.actor.ref) throw new Error('This tool requires a collaboration member.')
    const found = this.memberForSession(ctx.actor.ref)
    if (!found || found.workspace.archived) throw new Error('No active collaboration membership for this session.')
    const runId = this.#host.runId(ctx.actor.ref)
    const trigger = Object.values(found.workspace.triggers).find((item) => item.memberId === found.member.memberId && item.status === 'running' && item.runId === runId)
    if (!runId || !trigger) throw new Error('Collaboration tools require the currently dispatched member turn.')
    return { ...found, trigger, runId }
  }
  post(input: JsonRecord, ctx: Context) {
    const memberContext = ctx.actor.kind === 'agent' ? this.authenticated(ctx) : undefined
    if (!memberContext) human(ctx)
    const workspace = memberContext?.workspace ?? this.workspace(input.sessionId)
    if (workspace.archived) throw new Error('Restore this workspace before posting.')
    const scope = input.scope ?? memberContext?.trigger.scope ?? 'room'
    if (!['room', 'discussion'].includes(scope)) throw new Error('Message scope must be room or discussion.')
    const discussion = scope === 'discussion' ? this.discussion(workspace, input.discussionId ?? memberContext?.trigger.discussionId) : undefined
    const threadId = input.threadId ?? memberContext?.trigger.threadId
    if (threadId !== undefined) {
      if (scope !== 'room') throw new Error('Goal discussion messages use their discussion scope, not a Room thread id.')
      this.threadRoot(workspace, threadId)
    }
    if (memberContext && (scope !== memberContext.trigger.scope || discussion?.discussionId !== memberContext.trigger.discussionId)) throw new Error('Members may publish only to the scope of their active turn.')
    if (memberContext && threadId !== memberContext.trigger.threadId) throw new Error('Members may publish only to the thread of their active turn.')
    if (memberContext && discussion && !discussion.requiredMemberIds.includes(memberContext.member.memberId)) throw new Error('This member has been removed from the discussion.')
    if (discussion && ['completed', 'cancelled'].includes(discussion.status)) throw new Error('This discussion has ended.')
    const content = text(input.content, 'Message')
    const mentionedMemberIds = input.mentionedMemberIds?.length ? this.members(workspace, input.mentionedMemberIds) : []
    let issue: CollaborationEvent['issue']
    if (input.issue) {
      if (!discussion) throw new Error('Issues belong to a goal discussion.')
      issue = { issueId: text(input.issue.issueId, 'Issue id', 120), summary: text(input.issue.summary, 'Issue summary', 2000), status: input.issue.status }
      if (!['open', 'resolved'].includes(issue.status)) throw new Error('Issue status must be open or resolved.')
      if (issue.status === 'resolved' && !discussion.issues[issue.issueId]) throw new Error('Cannot resolve an unknown issue.')
      discussion.issues[issue.issueId] = { ...issue, authorMemberId: memberContext?.member.memberId ?? 'human' }
    }
    const event = this.emit(workspace, { scope, discussionId: discussion?.discussionId, ...(threadId ? { threadId } : {}), kind: 'message', author: memberContext?.member.memberId ?? 'human', content, mentionedMemberIds, ...(issue ? { issue } : {}) })
    if (memberContext) memberContext.trigger.published = true
    const activeDiscussion = workspace.activeDiscussionId ? workspace.discussions[workspace.activeDiscussionId] : undefined
    const linkedDiscussion = threadId && activeDiscussion?.sourceThreadId === threadId && ['active', 'paused'].includes(activeDiscussion.status) ? activeDiscussion : undefined
    if (discussion) {
      discussion.latestSubstantiveSeq = event.seq
      // Every participant, including the author, must assess newly published evidence.
      // Settlement removes the author's queued turn if it assesses before returning.
      this.notifyDiscussion(workspace, discussion, event.seq)
      // The publishing member knows its own newly published material.
      if (memberContext) memberContext.trigger.readThroughSeq = event.seq
    } else if (!memberContext) {
      for (const memberId of mentionedMemberIds) {
        if (!linkedDiscussion?.requiredMemberIds.includes(memberId)) this.queue(workspace, memberId, 'room', event.seq, undefined, threadId)
      }
    }
    // A late reply from an already-running thread turn is still new evidence for
    // an automatic discussion started in that thread. It cannot be missed by consensus.
    if (linkedDiscussion) {
      linkedDiscussion.latestSubstantiveSeq = event.seq
      this.notifyDiscussion(workspace, linkedDiscussion, event.seq)
    }
    return { event, ...this.changed(workspace, ctx, 'message-posted') }
  }
  start(input: JsonRecord, ctx: Context) {
    human(ctx)
    const workspace = this.workspace(input.sessionId)
    if (workspace.archived) throw new Error('Restore this workspace before starting a discussion.')
    if (workspace.activeDiscussionId && ['active', 'paused'].includes(workspace.discussions[workspace.activeDiscussionId]?.status)) throw new Error('Finish or cancel the current discussion first.')
    const sourceThreadId = input.sourceThreadId === undefined ? undefined : this.threadRoot(workspace, input.sourceThreadId).eventId
    const discussionId = randomUUID()
    const discussion: CollaborationDiscussion = { discussionId, ...(sourceThreadId ? { sourceThreadId } : {}), goal: text(input.goal, 'Discussion goal', 8000), acceptanceCriteria: optionalText(input.acceptanceCriteria, 8000), goalRevision: 1, cohortRevision: 1, requiredMemberIds: this.members(workspace, input.requiredMemberIds, 2), status: 'active', health: 'healthy', startedSeq: 0, latestSubstantiveSeq: 0, assessments: {}, issues: {}, maxTurns: maxTurns(input.maxTurns), turnsUsed: 0, createdAt: timestamp() }
    workspace.discussions[discussionId] = discussion
    discussion.health = discussionHasAttention(workspace, discussion) ? 'degraded' : 'healthy'
    workspace.activeDiscussionId = discussionId
    const event = this.system(workspace, `Discussion started: ${discussion.goal}`, discussion)
    discussion.startedSeq = event.seq
    discussion.latestSubstantiveSeq = event.seq
    this.notifyDiscussion(workspace, discussion, event.seq)
    return this.changed(workspace, ctx, 'discussion-started')
  }
  update(input: JsonRecord, ctx: Context) {
    human(ctx)
    const workspace = this.workspace(input.sessionId)
    const discussion = this.discussion(workspace, input.discussionId)
    if (['completed', 'cancelled'].includes(discussion.status)) throw new Error('This discussion has ended; start a new discussion.')
    if (!['pause', 'resume', 'cancel', 'revise'].includes(input.action)) throw new Error('Unknown discussion action.')
    if (input.maxTurns !== undefined) discussion.maxTurns = maxTurns(input.maxTurns)
    if (input.action === 'pause') { discussion.status = 'paused'; discussion.pauseReason = 'Paused by user.' }
    if (input.action === 'resume') {
      if (workspace.archived) throw new Error('Restore the workspace first.')
      if (discussion.turnsUsed >= discussion.maxTurns) throw new Error('Increase the discussion turn cap before resuming.')
      discussion.status = 'active'; delete discussion.pauseReason
    }
    if (input.action === 'cancel') {
      discussion.status = 'cancelled'
      for (const trigger of Object.values(workspace.triggers)) if (trigger.discussionId === discussion.discussionId && trigger.status === 'pending') trigger.status = 'cancelled'
      delete workspace.activeDiscussionId
    }
    if (input.action === 'revise') {
      if (input.goal !== undefined || input.acceptanceCriteria !== undefined) {
        if (input.goal !== undefined) discussion.goal = text(input.goal, 'Discussion goal', 8000)
        if (input.acceptanceCriteria !== undefined) discussion.acceptanceCriteria = optionalText(input.acceptanceCriteria, 8000)
        discussion.goalRevision += 1
      }
      if (input.requiredMemberIds !== undefined) {
        discussion.requiredMemberIds = this.members(workspace, input.requiredMemberIds, 2)
        discussion.cohortRevision += 1
        for (const trigger of Object.values(workspace.triggers)) if (trigger.discussionId === discussion.discussionId && trigger.status === 'pending' && !discussion.requiredMemberIds.includes(trigger.memberId)) trigger.status = 'cancelled'
      }
      const event = this.system(workspace, 'Discussion goal or participant set revised. Previous assessments are no longer sufficient.', discussion)
      discussion.latestSubstantiveSeq = event.seq
      discussion.health = discussionHasAttention(workspace, discussion) ? 'degraded' : 'healthy'
      this.notifyDiscussion(workspace, discussion, event.seq)
    } else this.system(workspace, `Discussion ${input.action === 'resume' ? 'resumed' : input.action === 'pause' ? 'paused' : 'cancelled'}.`, discussion)
    this.complete(workspace, discussion)
    return this.changed(workspace, ctx, 'discussion-updated')
  }
  archive(input: JsonRecord, ctx: Context) {
    human(ctx)
    const workspace = this.workspace(input.sessionId)
    workspace.archived = input.archived !== false
    const discussion = workspace.activeDiscussionId ? workspace.discussions[workspace.activeDiscussionId] : undefined
    if (workspace.archived && discussion?.status === 'active') { discussion.status = 'paused'; discussion.pauseReason = 'Workspace archived.' }
    this.system(workspace, workspace.archived ? 'Workspace archived; active discussion paused.' : 'Workspace restored.')
    return this.changed(workspace, ctx, 'archived')
  }
  attachCouncil(input: JsonRecord, ctx: Context) {
    human(ctx)
    const workspace = this.workspace(input.sessionId)
    const council = this.#host.state().planCouncils?.[input.workflowId]
    if (!council) throw new Error('Unknown Plan Council.')
    if (fs.realpathSync(council.cwd) !== fs.realpathSync(workspace.cwd)) throw new Error('Council and collaboration workspace must use the same directory.')
    if (!workspace.councilIds.includes(council.workflowId)) {
      workspace.councilIds.push(council.workflowId)
      this.system(workspace, 'A Plan Council was attached. Its phases and completion remain independent of discussion agreement.')
    }
    return this.changed(workspace, ctx, 'council-attached')
  }
  read(input: JsonRecord, ctx: Context) {
    const { workspace, member, trigger } = this.authenticated(ctx)
    const discussion = trigger.discussionId ? workspace.discussions[trigger.discussionId] : undefined
    const cursorKey = trigger.threadId ? `thread:${trigger.threadId}` : trigger.discussionId ?? 'room'
    const previousCursor = member.readCursors[cursorKey] ?? 0
    const afterSeq = input.afterSeq === undefined ? previousCursor : Number(input.afterSeq)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > previousCursor) throw new Error('Read cursor must not skip unseen collaboration events.')
    const belongsToThread = (event: CollaborationEvent, threadId: string) =>
      event.scope === 'room' ? event.eventId === threadId || event.threadId === threadId : Boolean(event.discussionId && workspace.discussions[event.discussionId]?.sourceThreadId === threadId)
    const all = workspace.events.filter((event) => event.seq > afterSeq && (discussion
      ? event.discussionId === discussion.discussionId || Boolean(discussion.sourceThreadId && belongsToThread(event, discussion.sourceThreadId))
      : trigger.threadId ? belongsToThread(event, trigger.threadId) : event.scope === 'room' && !event.threadId))
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 50))
    const events = all.slice(0, limit)
    const throughSeq = events.at(-1)?.seq ?? afterSeq
    member.lastReadSeq = Math.max(member.lastReadSeq, throughSeq)
    member.readCursors[cursorKey] = Math.max(previousCursor, throughSeq)
    trigger.readThroughSeq = Math.max(trigger.readThroughSeq ?? 0, throughSeq)
    const result = { workspace: { sessionId: workspace.sessionId, title: workspace.title, cwd: workspace.cwd }, memberId: member.memberId, scope: trigger.scope, threadId: trigger.threadId, discussion: discussion ? structuredClone(discussion) : undefined, members: workspace.members.map(({ memberId, label, role }) => ({ memberId, label, role })), events: structuredClone(events), throughSeq, hasMore: all.length > events.length }
    this.changed(workspace, ctx, 'updates-read')
    return result
  }
  assess(input: JsonRecord, ctx: Context) {
    const { workspace, member, trigger, runId } = this.authenticated(ctx)
    if (!trigger.discussionId) throw new Error('Room turns do not submit goal assessments.')
    const discussion = this.discussion(workspace, trigger.discussionId)
    if (!['active', 'paused'].includes(discussion.status) || !discussion.requiredMemberIds.includes(member.memberId)) throw new Error('This member is no longer participating in an open discussion.')
    if (!['satisfied', 'not_satisfied', 'blocked'].includes(input.verdict)) throw new Error('Unknown discussion assessment.')
    if (input.goalRevision !== discussion.goalRevision || input.cohortRevision !== discussion.cohortRevision || input.basedOnSeq !== discussion.latestSubstantiveSeq || (trigger.readThroughSeq ?? 0) < discussion.latestSubstantiveSeq) throw new Error('Assessment is stale. Read the latest collaboration updates and use their current revisions and latestSubstantiveSeq.')
    const reason = text(input.reason, 'Assessment reason', 8000)
    const issueId = optionalText(input.issueId, 120)
    if (input.verdict !== 'satisfied' && !issueId) throw new Error('A not_satisfied or blocked assessment requires a stable issueId.')
    const previousIssue = issueId ? discussion.issues[issueId] : undefined
    const newObjection = input.verdict !== 'satisfied' && (!previousIssue || previousIssue.status !== 'open' || previousIssue.summary !== reason)
    let basedOnSeq = discussion.latestSubstantiveSeq
    if (newObjection && issueId) {
      const issue = { issueId, summary: reason, status: 'open' as const }
      discussion.issues[issueId] = { ...issue, authorMemberId: member.memberId }
      const event = this.emit(workspace, { scope: 'discussion', discussionId: discussion.discussionId, kind: 'message', author: member.memberId, content: reason, issue, mentionedMemberIds: [] })
      basedOnSeq = event.seq
      discussion.latestSubstantiveSeq = event.seq
      trigger.readThroughSeq = event.seq
      this.notifyDiscussion(workspace, discussion, event.seq, member.memberId)
    }
    const assessment: DiscussionAssessment = { memberId: member.memberId, verdict: input.verdict, reason, issueId, goalRevision: discussion.goalRevision, cohortRevision: discussion.cohortRevision, basedOnSeq, runId, createdAt: timestamp() }
    discussion.assessments[member.memberId] = assessment
    trigger.assessed = true
    this.emit(workspace, { scope: 'discussion', discussionId: discussion.discussionId, kind: 'assessment', author: member.memberId, content: `${assessment.verdict}: ${reason}`, mentionedMemberIds: [] })
    return { assessment, ...this.changed(workspace, ctx, 'assessed') }
  }
  async dispatchTrigger(input: JsonRecord, ctx: Context) {
    runtime(ctx)
    const workspace = this.workspace(input.sessionId)
    const trigger = workspace.triggers[input.triggerId]
    if (!trigger || trigger.status !== 'pending' || workspace.archived || this.#suspended) return { skipped: true }
    const member = workspace.members.find((item) => item.memberId === trigger.memberId)
    if (!member || member.attention || this.#host.isBusy(member.sessionId) || Object.values(workspace.triggers).some((item) => item.memberId === member.memberId && item.status === 'running')) return { skipped: true }
    const discussion = trigger.discussionId ? workspace.discussions[trigger.discussionId] : undefined
    if (discussion && discussion.status !== 'active') return { skipped: true }
    if (discussion && discussion.turnsUsed >= discussion.maxTurns) {
      discussion.status = 'paused'; discussion.pauseReason = `Discussion reached its ${discussion.maxTurns}-turn cap.`
      this.system(workspace, discussion.pauseReason, discussion)
      return this.changed(workspace, ctx, 'turn-cap-reached')
    }
    trigger.status = 'running'
    if (discussion) discussion.turnsUsed += 1
    const note = [
      `Collaboration workspace: ${workspace.title}. You are ${member.label}. ${member.role ?? ''}`,
      `This is a ${trigger.scope} turn, triggered by shared events through sequence ${trigger.throughSeq}.`,
      discussion ? `Goal revision ${discussion.goalRevision}, cohort revision ${discussion.cohortRevision}: ${discussion.goal}\nAcceptance criteria: ${discussion.acceptanceCriteria ?? 'Use the stated goal.'}` : trigger.threadId ? 'Respond to the user mentions in this reply thread. Updates include its root message and replies. Your posts stay in this thread.' : 'Respond to the user mentions in the room.',
      'First call mcp__orrery_membrane__read_collaboration_updates. Read all pages before assessing. Use its current revisions and latestSubstantiveSeq.',
      'These are real MCP tools: invoke the exposed tool directly, using tool search first if your provider defers its schema. Never simulate a tool call with assistant text, shell commands, scripts, or placeholder output. If a tool is unavailable, explain the failure and end your turn; do not invent shared updates or assessments.',
      discussion
        ? 'Publish through mcp__orrery_membrane__post_collaboration_message only when you have NEW evidence, a changed proposal, or an issue resolution. Do not publish acknowledgements, repeated answers, status updates, or completion announcements. Agreement belongs in the assessment tool, which is already visible to the user. Publishing any message invalidates earlier assessments and wakes the team again.'
        : 'Publish your reply only through mcp__orrery_membrane__post_collaboration_message. Your final assistant text is private. Do not merely promise to publish.',
      discussion ? 'This turn MUST end with mcp__orrery_membrane__set_discussion_assessment using the latest read revisions, even if you already agreed on an earlier turn or have nothing new to add. For unresolved objections use not_satisfied or blocked and a stable issueId. A novel objection is shared automatically. Repeating the same issueId and reason adds no new substantive update. Resolve an issue explicitly through mcp__orrery_membrane__post_collaboration_message with issue:{issueId,summary,status:"resolved"} before marking satisfied. A satisfied reason must not introduce new facts. After a successful assessment, stop immediately without any further tool calls or public message. If the assessment is rejected because newer updates arrived, read those updates and assess again. The runtime, not an Agent, determines when everyone has finished.' : 'After publishing your reply, stop.',
      'Do not activate other agents, spawn sessions, edit files, poll, or read anyone else\'s private transcript. Use project tools only for read-only investigation.',
    ].join('\n\n')
    try {
      const result = await this.#host.activate({ sessionId: member.sessionId, note }, ctx)
      trigger.runId = result.runId
    } catch (error) {
      trigger.status = 'failed'
      trigger.error = error instanceof Error ? error.message : String(error)
      member.attention = trigger.error
      member.attentionTriggerId = trigger.triggerId
      if (discussion) discussion.health = 'degraded'
      this.system(workspace, `${member.label} could not start: ${trigger.error}`, discussion)
    }
    return this.changed(workspace, ctx, 'trigger-dispatched')
  }
  private complete(workspace: CollaborationSession, discussion: CollaborationDiscussion) {
    if (!discussionCanComplete(workspace, discussion)) return
    discussion.status = 'completed'; discussion.completedAt = timestamp(); discussion.health = 'healthy'
    delete workspace.activeDiscussionId
    this.system(workspace, 'All required members accepted the current goal and shared evidence. Discussion completed.', discussion)
  }
  settled(input: JsonRecord, ctx: Context) {
    runtime(ctx)
    const found = this.memberForSession(input.providerSessionId)
    if (!found) return { ignored: true }
    const { workspace, member } = found
    const trigger = Object.values(workspace.triggers).find((item) => item.memberId === member.memberId && item.status === 'running' && (!input.runId || !item.runId || item.runId === input.runId))
    if (!trigger) { this.scheduleDrain(); return { ignored: true } }
    const discussion = trigger.discussionId ? workspace.discussions[trigger.discussionId] : undefined
    const activeDiscussion = workspace.activeDiscussionId ? workspace.discussions[workspace.activeDiscussionId] : undefined
    const linkedDiscussion = trigger.threadId && activeDiscussion?.sourceThreadId === trigger.threadId ? activeDiscussion : undefined
    if (input.outcome === 'completed') {
      trigger.status = 'completed'
      if (!trigger.published && !trigger.assessed && discussion?.status !== 'cancelled') {
        member.attention = 'This turn ended without publishing or assessing. Retry the member to continue.'
        member.attentionTriggerId = trigger.triggerId
        if (discussion) discussion.health = 'degraded'
        if (linkedDiscussion) linkedDiscussion.health = 'degraded'
        this.system(workspace, `${member.label} did not participate in this turn.`, discussion)
      }
    } else {
      trigger.status = 'failed'; trigger.error = String(input.error ?? 'Member turn was interrupted.')
      member.attention = trigger.error
      member.attentionTriggerId = trigger.triggerId
      if (discussion) { discussion.health = 'degraded'; delete discussion.assessments[member.memberId] }
      if (linkedDiscussion) { linkedDiscussion.health = 'degraded'; delete linkedDiscussion.assessments[member.memberId] }
      this.system(workspace, `${member.label}: ${trigger.error}`, discussion)
    }
    // A member that read and assessed the latest revision during this turn needs no duplicate queued turn.
    const assessment = discussion?.assessments[member.memberId]
    const currentAssessment = assessment && assessment.runId === trigger.runId &&
      assessment.goalRevision === discussion?.goalRevision && assessment.cohortRevision === discussion?.cohortRevision &&
      assessment.basedOnSeq === discussion?.latestSubstantiveSeq
    for (const pending of Object.values(workspace.triggers)) {
      if (pending.memberId === member.memberId && pending.status === 'pending' && pending.discussionId === trigger.discussionId && pending.threadId === trigger.threadId && pending.scope === trigger.scope && pending.throughSeq <= (trigger.readThroughSeq ?? 0) && (currentAssessment || !discussion)) pending.status = 'completed'
    }
    if (input.outcome === 'completed' && discussion && ['active', 'paused'].includes(discussion.status) && discussion.requiredMemberIds.includes(member.memberId) && trigger.assessed && !currentAssessment) this.queue(workspace, member.memberId, 'discussion', discussion.latestSubstantiveSeq, discussion.discussionId)
    if (discussion) this.complete(workspace, discussion)
    if (linkedDiscussion) this.complete(workspace, linkedDiscussion)
    return this.changed(workspace, ctx, 'member-settled')
  }
  retry(input: JsonRecord, ctx: Context) {
    human(ctx)
    const workspace = this.workspace(input.sessionId)
    const member = workspace.members.find((item) => item.memberId === input.memberId)
    if (!member) throw new Error('Unknown collaboration member.')
    if (workspace.archived || this.#host.isBusy(member.sessionId)) throw new Error('Restore the workspace and wait for the member to settle before retrying.')
    const session = this.#host.state().sessions[member.sessionId]
    if (!session || session.status === 'killed') throw new Error('Killed or missing member sessions cannot be retried.')
    delete member.attention
    const attentionTrigger = member.attentionTriggerId ? workspace.triggers[member.attentionTriggerId] : undefined
    delete member.attentionTriggerId
    const failedThread = Object.values(workspace.triggers).filter((trigger) => trigger.memberId === member.memberId && trigger.status === 'failed').at(-1)?.threadId
    const threadId = input.threadId !== undefined ? this.threadRoot(workspace, input.threadId).eventId : attentionTrigger ? attentionTrigger.threadId : failedThread
    const activeDiscussion = workspace.activeDiscussionId ? workspace.discussions[workspace.activeDiscussionId] : undefined
    const discussion = activeDiscussion && (!threadId || activeDiscussion.sourceThreadId === threadId) ? activeDiscussion : undefined
    if (discussion && discussion.requiredMemberIds.includes(member.memberId)) this.queue(workspace, member.memberId, 'discussion', discussion.latestSubstantiveSeq, discussion.discussionId)
    else this.queue(workspace, member.memberId, 'room', workspace.events.at(-1)?.seq ?? 0, undefined, threadId)
    if (discussion && !discussionHasAttention(workspace, discussion)) discussion.health = 'healthy'
    this.system(workspace, `${member.label} retry requested.`, discussion)
    return this.changed(workspace, ctx, 'member-retried')
  }
  onKernelEvent(event: JsonRecord) {
    if (!['session.finished', 'session.failed', 'session.killed'].includes(event.type)) return
    const providerSessionId = event.payload?.sessionId
    if (!providerSessionId || !this.memberForSession(providerSessionId)) return
    queueMicrotask(() => {
      void this.#host.dispatch({ kind: 'collaboration_member_settled', actor: { kind: 'runtime' }, commandId: `collaboration-settle:${event.id}`, idempotencyKey: `collaboration-settle:${event.id}`, input: { providerSessionId, runId: event.payload?.turnId, outcome: event.type === 'session.finished' ? 'completed' : 'failed', error: event.payload?.error ?? (event.type === 'session.killed' ? 'Member was stopped.' : undefined) } }).catch(() => { /* durable source event is reconciled on restart */ })
    })
  }
  hasInterruptedTurns() {
    return Object.values(this.workspaces).some((workspace) =>
      Object.values(workspace.triggers).some((trigger) => trigger.status === 'running'))
  }
  recover(_input: JsonRecord, ctx: Context) {
    runtime(ctx)
    for (const workspace of Object.values(this.workspaces)) {
      if (!Object.values(workspace.triggers).some((trigger) => trigger.status === 'running')) continue
      for (const trigger of Object.values(workspace.triggers)) {
        if (trigger.status !== 'running') continue
        const member = workspace.members.find((item) => item.memberId === trigger.memberId)
        const session = member ? this.#host.state().sessions[member.sessionId] : undefined
        const completed = session?.status === 'idle' && session.messages?.some((message: JsonRecord) => message.runId === trigger.runId && message.role === 'assistant' && message.status === 'complete')
        this.settled({ providerSessionId: member?.sessionId, runId: trigger.runId, outcome: completed ? 'completed' : 'failed', error: 'Member turn interrupted by runtime restart. Retry explicitly.' }, ctx)
      }
      this.changed(workspace, ctx, 'recovered')
    }
    return { state: this.#host.getState() }
  }
  async handleTool(tool: string, source: string, input: JsonRecord) {
    const found = this.memberForSession(source)
    if (!found) throw new Error('This tool is available only to collaboration members.')
    const runId = this.#host.runId(source)
    const payload = { ...input }; delete payload.__collaborationCallId
    const identity = input.__collaborationCallId ?? (tool === 'read_collaboration_updates' ? randomUUID() : createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    const key = `collaboration-tool:${source}:${runId}:${tool}:${identity}`
    const result = await this.#host.dispatch({ kind: tool, commandId: key, idempotencyKey: key, actor: { kind: 'agent', ref: source }, input: payload })
    if (tool === 'read_collaboration_updates') return result
    return { ok: true, event: result.event, assessment: result.assessment, discussion: result.workspace?.activeDiscussionId ? result.workspace.discussions[result.workspace.activeDiscussionId] : undefined }
  }
}
