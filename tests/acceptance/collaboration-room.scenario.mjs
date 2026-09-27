import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  assertSettled, command, isSettled, memberInput, roomFrom, saveEvidence, waitForRoom,
} from './collaboration-helpers.mjs'

export const name = 'collaboration-room'
export const description =
  'Real collaboration room: configuration and unaddressed messages stay idle; a directed mention wakes only its recipient and publishes a shared response.'
export const providers = ['claude-code', 'codex']
export const timeoutMs = 420_000

export async function run(ctx) {
  const { orrery, workDir, log } = ctx
  const created = await command(orrery, 'create_collaboration_session', {
    title: 'Room routing acceptance', cwd: workDir,
    members: [memberInput(ctx, 'Reader'), memberInput(ctx, 'Observer')],
  })
  const sessionId = created.sessionId
  assert.ok(sessionId)
  const initial = await orrery.state()
  const room = roomFrom(initial, sessionId)
  assert.equal(room.members.length, 2)
  assert.equal(Object.keys(room.triggers).length, 0, 'Creating a room must not wake providers')
  assertSettled(initial, room)
  for (const member of room.members) {
    const session = initial.sessions[member.sessionId]
    assert.equal(session.runtimeSettings.model, ctx.modelPreset[ctx.provider.providerKind].model)
    assert.equal(session.cwd, fs.realpathSync(workDir))
    assert.equal(session.messages.some((message) => message.role === 'assistant'), false)
  }

  await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', content: 'The shared token is ROOM_BLUE_271. This message has no recipients.',
    mentionedMemberIds: [],
  })
  const quiet = roomFrom(await orrery.state(), sessionId)
  assert.equal(Object.keys(quiet.triggers).length, 0, 'A message without mentions must not wake providers')
  const [reader, observer] = room.members
  await command(orrery, 'post_collaboration_message', {
    sessionId, scope: 'room', mentionedMemberIds: [reader.memberId],
    content: [
      'Actually call mcp__orrery_membrane__read_collaboration_updates to read the earlier room message, then call mcp__orrery_membrane__post_collaboration_message exactly once to publish its shared token.',
      'Your published content must be exactly ROOM_BLUE_271. Publish to the room with no mentions, then stop.',
      'Do not create a discussion, call other agents, edit files, or merely answer in your private transcript.',
      'Use only the exposed collaboration MCP tools. Never use Bash, shell commands, scripts, or helpers to simulate a tool call. If a tool is unavailable, explicitly report that instead of simulating it.',
    ].join(' '),
  })
  const final = await waitForRoom(orrery, sessionId, 'one directed room response to finish',
    (current, state) => Object.values(current.triggers).some((trigger) =>
      trigger.memberId === reader.memberId && trigger.status === 'completed') && isSettled(state, current))
  assertSettled(final.state, final.room)
  const responses = final.room.events.filter((event) => event.author === reader.memberId && event.kind === 'message')
  assert.equal(responses.length, 1, 'The recipient must publish exactly once')
  assert.equal(responses[0].scope, 'room')
  assert.equal(responses[0].content.trim(), 'ROOM_BLUE_271')
  assert.deepEqual(responses[0].mentionedMemberIds, [])
  assert.equal(Object.values(final.room.triggers).filter((trigger) => trigger.memberId === reader.memberId).length, 1)
  assert.equal(Object.values(final.room.triggers).some((trigger) => trigger.memberId === observer.memberId), false)
  assert.equal(final.state.sessions[observer.sessionId].messages.some((message) => message.role === 'assistant'), false)
  saveEvidence(ctx, 'room-routing-evidence.json', { sessionId, reader, observer, events: final.room.events,
    triggers: final.room.triggers, model: ctx.modelPreset[ctx.provider.providerKind].model })
  log('verified idle configuration, explicit recipient routing, one public response, and zero Observer turns')
}
