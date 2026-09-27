import assert from 'node:assert/strict'
import {
  assertSettled, assertUnanimousCompletion, command, isQuiescent, isSettled, memberInput, roomFrom,
  saveEvidence, waitForRoom,
} from './collaboration-helpers.mjs'

export const name = 'collaboration-discussion'
export const description =
  'Real two-member discussion pauses, accepts a new human fact without waking agents, resumes, and completes only with explicit matching assessments of the latest fact.'
export const providers = ['claude-code', 'codex']
export const timeoutMs = 600_000

export async function run(ctx) {
  const { orrery, workDir, log } = ctx
  const created = await command(orrery, 'create_collaboration_session', {
    title: 'Discussion convergence acceptance', cwd: workDir,
    members: [memberInput(ctx, 'Checker One'), memberInput(ctx, 'Checker Two')],
  })
  const sessionId = created.sessionId
  const room = roomFrom(await orrery.state(), sessionId)
  const started = await command(orrery, 'start_collaboration_discussion', {
    sessionId,
    goal: [
      'Verify the latest human fact is one of the two accepted values INITIAL_BLUE_271 or FINAL_BLUE_271.',
      'The initial human fact is INITIAL_BLUE_271. A later human message can replace it with FINAL_BLUE_271.',
      'Actually call mcp__orrery_membrane__read_collaboration_updates, then mcp__orrery_membrane__set_discussion_assessment exactly once with verdict satisfied and reason equal to the latest human fact.',
      'Pass the current discussion goalRevision, cohortRevision, and latestSubstantiveSeq as basedOnSeq. If rejected as stale, read the updates and assess the current version.',
      'There are no new findings to publish: your explicit assessment is your public contribution. Do not post a separate message, mention anyone, edit files, or delegate. Then stop.',
      'Use only the exposed collaboration MCP tools. Never use Bash, shell commands, scripts, or helpers to simulate a tool call. If a tool is unavailable, explicitly report that instead of simulating it.',
    ].join(' '),
    acceptanceCriteria: 'Both required members explicitly assess the latest accepted human fact as satisfied.',
    requiredMemberIds: room.members.map((member) => member.memberId),
    maxTurns: 8,
  })
  const discussionId = started.workspace.activeDiscussionId
  assert.ok(discussionId)
  await command(orrery, 'update_collaboration_discussion', { sessionId, discussionId, action: 'pause' })
  const paused = await waitForRoom(orrery, sessionId, 'paused discussion provider turns to settle',
    (current, state) => current.discussions[discussionId]?.status === 'paused' && isQuiescent(state, current))
  const turnsBeforeMessage = paused.room.discussions[discussionId].turnsUsed
  await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'discussion', discussionId,
    content: 'The latest human fact is FINAL_BLUE_271. It replaces INITIAL_BLUE_271. Assess this new fact after the discussion resumes.',
    mentionedMemberIds: [],
  })
  const pausedState = await orrery.state()
  const updated = roomFrom(pausedState, sessionId)
  const humanFact = updated.events.findLast((event) => event.scope === 'discussion' && event.author === 'human')
  assert.ok(humanFact)
  assert.equal(updated.discussions[discussionId].status, 'paused')
  assert.equal(updated.discussions[discussionId].turnsUsed, turnsBeforeMessage, 'A paused discussion must not start provider work')
  assert.ok(isQuiescent(pausedState, updated), 'New shared facts can queue attention while provider execution remains paused')
  assert.ok(updated.discussions[discussionId].latestSubstantiveSeq >= humanFact.seq)
  saveEvidence(ctx, 'paused-discussion-evidence.json', { room: updated, humanFact })

  await command(orrery, 'update_collaboration_discussion', { sessionId, discussionId, action: 'resume' })
  const final = await waitForRoom(orrery, sessionId, 'both members to endorse the current discussion version',
    (current, state) => {
      const discussion = current.discussions[discussionId]
      if (discussion?.status === 'paused') throw new Error(`Discussion paused before consensus: ${discussion.pauseReason}`)
      return discussion?.status === 'completed' && isSettled(state, current)
    })
  assertSettled(final.state, final.room)
  const discussion = final.room.discussions[discussionId]
  assertUnanimousCompletion(final.room, discussion)
  for (const assessment of Object.values(discussion.assessments)) {
    assert.match(assessment.reason, /FINAL_BLUE_271/)
    assert.ok(assessment.basedOnSeq >= humanFact.seq, 'An assessment must include the human update sent while paused')
  }
  assert.ok(discussion.turnsUsed <= discussion.maxTurns)
  saveEvidence(ctx, 'discussion-completion-evidence.json', { sessionId, discussion, events: final.room.events,
    triggers: final.room.triggers, model: ctx.modelPreset[ctx.provider.providerKind].model })
  log('verified pause, persisted human update, resume, and two explicit current-version endorsements before completion')
}
