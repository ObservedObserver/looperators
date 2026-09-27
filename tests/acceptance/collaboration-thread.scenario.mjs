import assert from 'node:assert/strict'
import {
  assertSettled, assertUnanimousCompletion, command, isQuiescent, isSettled, memberInput,
  roomFrom, saveEvidence, waitForRoom,
} from './collaboration-helpers.mjs'

export const name = 'collaboration-thread'
export const description = 'A real reply thread reuses its members, supplies context to a goal, retains a paused thread update, and completes with current explicit assessments.'
export const providers = ['claude-code', 'codex']
export const timeoutMs = 600_000

export async function run(ctx) {
  const { orrery, workDir, log } = ctx
  const created = await command(orrery, 'create_collaboration_session', {
    title: 'Thread to goal acceptance', cwd: workDir,
    members: [memberInput(ctx, 'Thread Reader'), memberInput(ctx, 'Thread Checker')],
  })
  const sessionId = created.sessionId
  const original = roomFrom(await orrery.state(), sessionId)
  const sessionIds = original.members.map((member) => member.sessionId).sort()
  const root = (await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', content: 'Root marker: ROOT_THREAD_271. Initial accepted fact: INITIAL_THREAD_271.',
  })).event
  await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', content: 'Unrelated conversation marker: OTHER_THREAD_999. This is not evidence for the first thread.',
  })
  assert.equal(Object.values(roomFrom(await orrery.state(), sessionId).triggers).length, 0)
  await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', threadId: root.eventId, mentionedMemberIds: [original.members[0].memberId],
    content: 'Call mcp__orrery_membrane__read_collaboration_updates to read this thread. Then call mcp__orrery_membrane__post_collaboration_message once with content exactly THREAD_READ_OK and no mentions. Let the tool inherit your thread. Then stop. Use actual exposed MCP tools, never shell scripts or simulated calls. No file access, no delegation, no extra messages.',
  })
  const replied = await waitForRoom(orrery, sessionId, 'one explicitly mentioned member to reply in the original thread',
    (room, state) => room.events.some((event) => event.threadId === root.eventId && event.author === original.members[0].memberId) && isSettled(state, room))
  assertSettled(replied.state, replied.room)
  const replies = replied.room.events.filter((event) => event.author === original.members[0].memberId)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].threadId, root.eventId)
  assert.equal(replies[0].content.trim(), 'THREAD_READ_OK')
  assert.ok(Object.values(replied.room.triggers).every((trigger) => trigger.memberId === original.members[0].memberId && trigger.threadId === root.eventId))

  const started = await command(orrery, 'start_collaboration_discussion', {
    sessionId, sourceThreadId: root.eventId,
    goal: 'Verify the original thread root marker and the latest accepted human fact from this thread. Read all pages using mcp__orrery_membrane__read_collaboration_updates. Call mcp__orrery_membrane__set_discussion_assessment with verdict satisfied, current goalRevision/cohortRevision/latestSubstantiveSeq, and a reason containing both the exact root marker and the latest accepted fact. A later human thread reply can replace the initial fact. If the assessment is stale, read again and assess the latest version. There is no new finding to publish: the assessment is your public contribution. Do not post a separate message. Use actual exposed MCP tools only, no shell or helper scripts, no file access or delegation. Stop after the assessment.',
    acceptanceCriteria: 'Both members explicitly endorse the original root marker and the newest human fact from this same thread.',
    requiredMemberIds: original.members.map((member) => member.memberId), maxTurns: 8,
  })
  const discussionId = started.workspace.activeDiscussionId
  await command(orrery, 'update_collaboration_discussion', { sessionId, discussionId, action: 'pause' })
  const paused = await waitForRoom(orrery, sessionId, 'initial goal turns to settle while paused',
    (room, state) => room.discussions[discussionId].status === 'paused' && isQuiescent(state, room))
  const turnsBefore = paused.room.discussions[discussionId].turnsUsed
  const finalFact = (await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', threadId: root.eventId,
    mentionedMemberIds: original.members.map((member) => member.memberId),
    content: 'The latest accepted human fact is FINAL_THREAD_271, replacing INITIAL_THREAD_271. Keep the original thread root marker. Assess after resume.',
  })).event
  const updatedState = await orrery.state()
  const updated = roomFrom(updatedState, sessionId)
  assert.equal(updated.discussions[discussionId].sourceThreadId, root.eventId)
  assert.equal(updated.discussions[discussionId].latestSubstantiveSeq, finalFact.seq)
  assert.equal(updated.discussions[discussionId].turnsUsed, turnsBefore)
  assert.ok(isQuiescent(updatedState, updated), 'Mentioning required goal members in a paused thread must not start a separate room turn')
  assert.equal(Object.values(updated.triggers).filter((trigger) => trigger.scope === 'room').length, 1)
  saveEvidence(ctx, 'thread-paused-evidence.json', { root, finalFact, room: updated })
  await command(orrery, 'update_collaboration_discussion', { sessionId, discussionId, action: 'resume' })
  const final = await waitForRoom(orrery, sessionId, 'both members to endorse the latest thread context', (room, state) => {
    const discussion = room.discussions[discussionId]
    if (discussion.status === 'paused') throw new Error(`Unexpected goal pause: ${discussion.pauseReason}`)
    return discussion.status === 'completed' && isSettled(state, room)
  })
  assertSettled(final.state, final.room)
  const discussion = final.room.discussions[discussionId]
  assertUnanimousCompletion(final.room, discussion)
  for (const assessment of Object.values(discussion.assessments)) {
    assert.match(assessment.reason, /ROOT_THREAD_271/)
    assert.match(assessment.reason, /FINAL_THREAD_271/)
    assert.doesNotMatch(assessment.reason, /OTHER_THREAD_999/)
  }
  assert.deepEqual(Object.keys(final.state.sessions).sort(), sessionIds, 'Thread and goal transitions must reuse the two member sessions')
  const turnsAfterCompletion = final.state.usageFacts.length
  await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', threadId: root.eventId, content: 'Ordinary follow-up after the completed goal; no recipients.',
  })
  const closedState = await orrery.state()
  const closedRoom = roomFrom(closedState, sessionId)
  assert.equal(closedRoom.discussions[discussionId].status, 'completed')
  assert.equal(closedRoom.discussions[discussionId].latestSubstantiveSeq, discussion.latestSubstantiveSeq)
  assert.equal(closedRoom.activeDiscussionId, undefined)
  assert.equal(closedState.usageFacts.length, turnsAfterCompletion)
  assertSettled(closedState, closedRoom)
  saveEvidence(ctx, 'thread-completion-evidence.json', { root, finalFact, discussion, events: closedRoom.events,
    triggers: closedRoom.triggers, model: ctx.modelPreset[ctx.provider.providerKind].model, settledTurns: turnsAfterCompletion })
  log('verified same-session thread reply, thread-to-goal context, paused mention without duplicate room turns, current consensus, and closed goal stability')
}
