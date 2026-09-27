import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'
import { normalizeCollaborationSessions } from '../../dist-electron/electron/runtime/collaboration/collaborationRecovery.js'

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate) {
  for (let i = 0; i < 300; i++) { const value = predicate(); if (value) return value; await pause() }
  throw new Error('Timed out waiting for collaboration state')
}
class ControlledProvider {
  kind = 'claude-code'
  turns = []
  startTurn(input) {
    const handle = new EventEmitter()
    let ended = false
    const turn = { input, handle, finish: (error) => {
      if (ended) return
      ended = true
      if (error) handle.emit('error', new Error(error))
      else {
        handle.emit('providerSession', { providerSessionId: input.sessionId })
        handle.emit('providerEvent', { id: `private-${input.turnId}`, ts: new Date().toISOString(), type: 'content.delta', sessionId: input.sessionId, turnId: input.turnId, streamKind: 'assistant_text', text: 'PRIVATE_TRANSCRIPT_NOT_SHARED' })
        handle.emit('result', { session_id: input.sessionId, result: 'PRIVATE_TRANSCRIPT_NOT_SHARED' })
      }
      handle.emit('close', { code: error ? 1 : 0, signal: null, killed: false })
    } }
    handle.kill = () => { if (ended) return false; ended = true; queueMicrotask(() => handle.emit('close', { code: null, signal: 'SIGTERM', killed: true })); return true }
    this.turns.push(turn)
    return handle
  }
  closeAll() {}
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-collaboration-'))
  const provider = new ControlledProvider()
  const options = { storageFile: path.join(directory, 'state.json'), providerAdapters: new Map([['claude-code', provider]]) }
  let runtime = new RuntimeSessionManager(options)
  const command = (kind, input) => runtime.dispatchCommand({ kind, actor: { kind: 'human' }, input })
  const tool = (member, name, input = {}) => runtime.handleMembraneRequest({ tool: name, source: member.sessionId, input })
  return {
    provider, directory, options, command, tool,
    get runtime() { return runtime },
    async create(labels = ['Alice', 'Bob']) { const result = await command('create_collaboration_session', { title: 'Design room', cwd: directory, members: labels.map((label) => ({ label, providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk' })) }); return result.workspace },
    workspace(id) { return runtime.getState().collaborationSessions[id] },
    async restart() { runtime.killAll(); await pause(50); runtime = new RuntimeSessionManager(options); await pause(50) },
    async cleanup() { runtime.killAll(); await pause(30); fs.rmSync(directory, { recursive: true, force: true }) },
  }
}
async function start(f, workspace, extra = {}) {
  const result = await f.command('start_collaboration_discussion', { sessionId: workspace.sessionId, goal: 'Agree on the API', requiredMemberIds: workspace.members.map((member) => member.memberId), maxTurns: 12, ...extra })
  return result.workspace.activeDiscussionId
}
async function read(f, member) { return f.tool(member, 'read_collaboration_updates') }
async function assess(f, member, verdict = 'satisfied', reason = 'The current goal is met.', issueId) {
  const view = await read(f, member)
  return f.tool(member, 'set_discussion_assessment', { verdict, reason, issueId, goalRevision: view.discussion.goalRevision, cohortRevision: view.discussion.cohortRevision, basedOnSeq: view.discussion.latestSubstantiveSeq })
}

async function roomPost(f, w, content, extra = {}) {
  return (await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'room', content, ...extra })).event
}

test('reply threads isolate reads and pending turns for the same member, and bind publication to the active thread', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const [alice] = w.members
    const a = await roomPost(f, w, 'Thread A root')
    const b = await roomPost(f, w, 'Thread B secret root')
    await roomPost(f, w, 'A first request', { threadId: a.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    await roomPost(f, w, 'B private to its thread', { threadId: b.eventId, mentionedMemberIds: [alice.memberId] })
    await roomPost(f, w, 'A latest update', { threadId: a.eventId, mentionedMemberIds: [alice.memberId] })
    assert.equal(Object.values(f.workspace(w.sessionId).triggers).filter((t) => t.status === 'pending').length, 2)
    const viewA = await read(f, alice)
    assert.equal(viewA.threadId, a.eventId)
    assert.deepEqual(viewA.events.map((e) => e.content), ['Thread A root', 'A first request', 'A latest update'])
    const spoofedRead = await f.tool(alice, 'read_collaboration_updates', { afterSeq: 0, threadId: b.eventId, scope: 'room', discussionId: 'invented' })
    assert.equal(spoofedRead.threadId, a.eventId)
    assert.ok(spoofedRead.events.every((event) => event.eventId === a.eventId || event.threadId === a.eventId))
    await assert.rejects(f.tool(alice, 'post_collaboration_message', { threadId: b.eventId, content: 'Wrong thread' }), /thread of their active turn/)
    await assert.rejects(f.tool(alice, 'post_collaboration_message', { scope: 'discussion', discussionId: 'invented', content: 'Wrong scope' }), /Unknown collaboration discussion/)
    const reply = await f.tool(alice, 'post_collaboration_message', { content: 'A answer' })
    assert.equal(reply.event.threadId, a.eventId)
    f.provider.turns[0].finish()
    await waitFor(() => f.provider.turns.length === 2)
    const viewB = await read(f, alice)
    assert.equal(viewB.threadId, b.eventId)
    assert.deepEqual(viewB.events.map((e) => e.content), ['Thread B secret root', 'B private to its thread'])
    await f.tool(alice, 'post_collaboration_message', { content: 'B answer' })
    f.provider.turns[1].finish()
    await waitFor(() => Object.values(f.workspace(w.sessionId).triggers).every((t) => t.status === 'completed'))
    assert.equal(f.provider.turns.length, 2, 'Read A update clears only A pending; B still runs once')
    assert.equal(Object.keys(f.runtime.getState().sessions).length, 2, 'Threads reuse the configured members')
    await f.restart()
    const restored = f.workspace(w.sessionId)
    assert.equal(restored.events.find((e) => e.content === 'B answer').threadId, b.eventId)
    assert.ok(restored.members[0].readCursors[`thread:${a.eventId}`])
    assert.ok(restored.members[0].readCursors[`thread:${b.eventId}`])
  } finally { await f.cleanup() }
})

test('thread roots must be top-level messages in the same workspace and corrupt references are rejected on recovery', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const other = await f.create()
    const root = await roomPost(f, w, 'Valid root')
    const reply = await roomPost(f, w, 'Nested reply', { threadId: root.eventId })
    const foreign = await roomPost(f, other, 'Foreign root')
    for (const threadId of ['missing', w.events[0]?.eventId ?? 'system', reply.eventId, foreign.eventId]) {
      await assert.rejects(roomPost(f, w, 'Invalid reply', { threadId }), /top-level message/)
      await assert.rejects(start(f, w, { sourceThreadId: threadId }), /top-level message/)
    }
    const snapshot = f.workspace(w.sessionId)
    for (const corrupt of [
      (copy) => { copy.events.find((e) => e.eventId === reply.eventId).threadId = 'missing' },
      (copy) => { copy.triggers.bad = { triggerId: 'bad', memberId: w.members[0].memberId, scope: 'room', threadId: reply.eventId, throughSeq: reply.seq, status: 'pending' } },
    ]) {
      const copy = structuredClone(snapshot); corrupt(copy)
      const diagnostics = []
      assert.deepEqual(normalizeCollaborationSessions({ [w.sessionId]: copy }, diagnostics), {})
      assert.equal(diagnostics.length, 1)
    }
    assert.equal(f.provider.turns.length, 0)
  } finally { await f.cleanup() }
})

test('thread goal includes public history, invalidates assessments on paused and late replies, and never reopens a closed goal', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const [alice, bob] = w.members
    const root = await roomPost(f, w, 'Original thread fact')
    const unrelated = await roomPost(f, w, 'Unrelated secret')
    await roomPost(f, w, 'Thread evidence before goal', { threadId: root.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    const id = await start(f, w, { sourceThreadId: root.eventId })
    await waitFor(() => f.provider.turns.length === 2)
    await assert.rejects(f.tool(bob, 'post_collaboration_message', { scope: 'room', threadId: root.eventId, content: 'Escape goal scope' }), /scope of their active turn/)
    const corrupt = f.workspace(w.sessionId)
    corrupt.discussions[id].sourceThreadId = 'missing-root'
    const diagnostics = []
    assert.deepEqual(normalizeCollaborationSessions({ [w.sessionId]: corrupt }, diagnostics), {})
    assert.equal(diagnostics.length, 1)
    const bobView = await read(f, bob)
    assert.ok(bobView.events.some((e) => e.eventId === root.eventId))
    assert.ok(bobView.events.some((e) => e.content === 'Thread evidence before goal'))
    assert.ok(!bobView.events.some((e) => e.eventId === unrelated.eventId))
    await assess(f, bob)
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'pause' })
    const late = await f.tool(alice, 'post_collaboration_message', { content: 'Late provider thread evidence' })
    assert.equal(late.event.threadId, root.eventId)
    assert.equal(f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq, late.event.seq)
    assert.ok(f.workspace(w.sessionId).discussions[id].assessments[bob.memberId].basedOnSeq < late.event.seq)
    f.provider.turns[0].finish(); f.provider.turns[1].finish()
    await waitFor(() => Object.values(f.workspace(w.sessionId).triggers).every((t) => t.status !== 'running'))
    const human = await roomPost(f, w, 'Human paused final evidence', { threadId: root.eventId, mentionedMemberIds: w.members.map((m) => m.memberId) })
    assert.equal(f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq, human.seq)
    assert.equal(f.provider.turns.length, 2)
    assert.equal(Object.values(f.workspace(w.sessionId).triggers).filter((t) => t.scope === 'room').length, 1, 'Required mentions route only to their paused goal')
    await f.restart()
    assert.equal(f.workspace(w.sessionId).discussions[id].sourceThreadId, root.eventId)
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'resume' })
    await waitFor(() => f.provider.turns.length === 4)
    for (const member of w.members) {
      const view = await read(f, member)
      assert.ok(view.events.some((e) => e.eventId === human.eventId))
      await assess(f, member)
    }
    f.provider.turns.slice(2).forEach((t) => t.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
    const completedSeq = f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq
    await roomPost(f, w, 'Ordinary reply after completed goal', { threadId: root.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 5)
    const after = await read(f, alice)
    assert.ok(after.events.some((e) => e.kind === 'assessment' && e.discussionId === id))
    await f.tool(alice, 'post_collaboration_message', { content: 'Ordinary thread answer' })
    f.provider.turns[4].finish()
    await waitFor(() => Object.values(f.workspace(w.sessionId).triggers).every((t) => !['pending', 'running'].includes(t.status)))
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'completed')
    assert.equal(f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq, completedSeq)
    assert.equal(f.workspace(w.sessionId).activeDiscussionId, undefined)
    const next = await start(f, w, { sourceThreadId: root.eventId })
    await waitFor(() => f.provider.turns.length === 7)
    const history = await read(f, bob)
    assert.ok(history.events.some((e) => e.discussionId === id && e.kind === 'assessment'))
    assert.equal(history.discussion.discussionId, next)
    await assess(f, alice); await assess(f, bob)
    f.provider.turns.slice(5).forEach((t) => t.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[next].status === 'completed')
  } finally { await f.cleanup() }
})

test('failed thread turns persist and retry in their original scope', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const alice = w.members[0]
    const root = await roomPost(f, w, 'Retry root')
    await roomPost(f, w, 'Please respond', { threadId: root.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    f.provider.turns[0].finish('Disconnected')
    await waitFor(() => f.workspace(w.sessionId).members[0].attention)
    await f.restart()
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: alice.memberId })
    await waitFor(() => f.provider.turns.length === 2)
    const view = await read(f, alice)
    assert.equal(view.threadId, root.eventId)
    await f.tool(alice, 'post_collaboration_message', { content: 'Recovered reply' })
    f.provider.turns[1].finish()
    await waitFor(() => f.workspace(w.sessionId).triggers[Object.keys(f.workspace(w.sessionId).triggers).at(-1)].status === 'completed')
    assert.equal(f.workspace(w.sessionId).events.find((e) => e.content === 'Recovered reply').threadId, root.eventId)
  } finally { await f.cleanup() }
})

test('an associated thread turn outside the required cohort blocks completion until it settles', async () => {
  const f = fixture()
  try {
    const w = await f.create(['Alice', 'Bob', 'Source']); const [alice, bob, source] = w.members
    const root = await roomPost(f, w, 'Source thread')
    await roomPost(f, w, 'Source, provide evidence', { threadId: root.eventId, mentionedMemberIds: [source.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    const id = await start(f, w, { sourceThreadId: root.eventId, requiredMemberIds: [alice.memberId, bob.memberId] })
    await waitFor(() => f.provider.turns.length === 3)
    await assess(f, alice); await assess(f, bob)
    f.provider.turns[1].finish(); f.provider.turns[2].finish()
    await waitFor(() => Object.values(f.workspace(w.sessionId).triggers).filter((t) => t.scope === 'discussion').every((t) => t.status === 'completed'))
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active', 'The source can still produce newer evidence')
    const late = await f.tool(source, 'post_collaboration_message', { content: 'Late source evidence' })
    assert.equal(f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq, late.event.seq)
    await waitFor(() => f.provider.turns.length === 5)
    await assess(f, alice); await assess(f, bob)
    f.provider.turns[3].finish(); f.provider.turns[4].finish()
    await waitFor(() => Object.values(f.workspace(w.sessionId).triggers).filter((t) => t.scope === 'discussion').every((t) => t.status === 'completed'))
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active', 'Current endorsements still wait for source settlement')
    f.provider.turns[0].finish()
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
  } finally { await f.cleanup() }
})

test('failed associated thread evidence degrades the goal until the source is explicitly retried', async () => {
  const f = fixture()
  try {
    const w = await f.create(['Alice', 'Bob', 'Source']); const [alice, bob, source] = w.members
    const root = await roomPost(f, w, 'Source failure thread')
    await roomPost(f, w, 'Source, investigate', { threadId: root.eventId, mentionedMemberIds: [source.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    const id = await start(f, w, { sourceThreadId: root.eventId, requiredMemberIds: [alice.memberId, bob.memberId] })
    await waitFor(() => f.provider.turns.length === 3)
    await assess(f, alice); await assess(f, bob)
    f.provider.turns[1].finish(); f.provider.turns[2].finish()
    f.provider.turns[0].finish('Source disconnected before sharing evidence')
    await waitFor(() => f.workspace(w.sessionId).members[2].attention)
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active')
    assert.equal(f.workspace(w.sessionId).discussions[id].health, 'degraded')
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: source.memberId })
    await waitFor(() => f.provider.turns.length === 4)
    assert.equal((await read(f, source)).threadId, root.eventId)
    await f.tool(source, 'post_collaboration_message', { content: 'Recovered source evidence' })
    await waitFor(() => f.provider.turns.length === 6)
    await assess(f, alice); await assess(f, bob)
    f.provider.turns.slice(3).forEach((t) => t.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
  } finally { await f.cleanup() }
})

test('an unrelated thread failure does not attach old source-member attention to a new goal', async () => {
  const f = fixture()
  try {
    const w = await f.create(['Alice', 'Bob', 'Source']); const [alice, bob, source] = w.members
    const a = await roomPost(f, w, 'Healthy source thread')
    const b = await roomPost(f, w, 'Unrelated failing thread')
    await roomPost(f, w, 'Source answer in A', { threadId: a.eventId, mentionedMemberIds: [source.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    await read(f, source)
    await f.tool(source, 'post_collaboration_message', { content: 'Healthy A evidence' })
    f.provider.turns[0].finish()
    await waitFor(() => Object.values(f.workspace(w.sessionId).triggers).every((t) => t.status === 'completed'))
    await roomPost(f, w, 'Source answer in B', { threadId: b.eventId, mentionedMemberIds: [source.memberId] })
    await waitFor(() => f.provider.turns.length === 2)
    f.provider.turns[1].finish('Failure only in B')
    await waitFor(() => f.workspace(w.sessionId).members[2].attention)
    const id = await start(f, w, { sourceThreadId: a.eventId, requiredMemberIds: [alice.memberId, bob.memberId] })
    assert.equal(f.workspace(w.sessionId).discussions[id].health, 'healthy', 'A previous successful source turn does not import B failure')
    await waitFor(() => f.provider.turns.length === 4)
    await assess(f, alice); await assess(f, bob)
    f.provider.turns.slice(2).forEach((t) => t.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
    assert.ok(f.workspace(w.sessionId).members[2].attention, 'Unrelated B failure remains visible')
  } finally { await f.cleanup() }
})

test('a completed turn without participation retries its own thread instead of an older failed thread', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const alice = w.members[0]
    const a = await roomPost(f, w, 'Older failure thread')
    const b = await roomPost(f, w, 'Current non-participation thread')
    await roomPost(f, w, 'A request', { threadId: a.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    f.provider.turns[0].finish('Old failure')
    await waitFor(() => f.workspace(w.sessionId).members[0].attention)
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: alice.memberId })
    await waitFor(() => f.provider.turns.length === 2)
    await f.tool(alice, 'post_collaboration_message', { content: 'A recovered' })
    f.provider.turns[1].finish()
    await waitFor(() => f.runtime.getState().sessions[alice.sessionId].status === 'idle')
    await roomPost(f, w, 'B request', { threadId: b.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 3)
    f.provider.turns[2].finish()
    await waitFor(() => f.workspace(w.sessionId).members[0].attention)
    const before = f.workspace(w.sessionId)
    const origin = before.triggers[before.members[0].attentionTriggerId]
    assert.equal(origin.status, 'completed')
    assert.equal(origin.threadId, b.eventId)
    await f.restart()
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: alice.memberId })
    await waitFor(() => f.provider.turns.length === 4)
    const view = await read(f, alice)
    assert.equal(view.threadId, b.eventId)
    assert.ok(view.events.some((event) => event.eventId === b.eventId))
    assert.ok(!view.events.some((event) => event.eventId === a.eventId))
    await f.tool(alice, 'post_collaboration_message', { content: 'B finally participated' })
    f.provider.turns[3].finish()
    await waitFor(() => f.runtime.getState().sessions[alice.sessionId].status === 'idle')
    assert.equal(f.workspace(w.sessionId).members[0].attentionTriggerId, undefined)
  } finally { await f.cleanup() }
})

test('a goal attention origin without a thread id must not fall back to an unrelated historical thread failure', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const [alice, bob] = w.members
    const a = await roomPost(f, w, 'Old failed thread')
    const b = await roomPost(f, w, 'Current goal thread')
    await roomPost(f, w, 'A request', { threadId: a.eventId, mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    f.provider.turns[0].finish('Old thread error')
    await waitFor(() => f.workspace(w.sessionId).members[0].attention)
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: alice.memberId })
    await waitFor(() => f.provider.turns.length === 2)
    await f.tool(alice, 'post_collaboration_message', { content: 'Old thread recovered' })
    f.provider.turns[1].finish()
    await waitFor(() => f.runtime.getState().sessions[alice.sessionId].status === 'idle')
    const id = await start(f, w, { sourceThreadId: b.eventId })
    await waitFor(() => f.provider.turns.length === 4)
    await assess(f, bob)
    f.provider.turns[2].finish(); f.provider.turns[3].finish()
    await waitFor(() => f.workspace(w.sessionId).members[0].attention)
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: alice.memberId })
    await waitFor(() => f.provider.turns.length === 5)
    const view = await read(f, alice)
    assert.equal(view.scope, 'discussion')
    assert.equal(view.discussion?.discussionId, id)
    await assess(f, alice)
    f.provider.turns[4].finish()
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
  } finally { await f.cleanup() }
})

test('prepared members stay cold; room mentions coalesce and only explicit posts are shared', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const [alice, bob] = w.members
    assert.equal(f.provider.turns.length, 0)
    await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'room', content: 'A quiet note.', mentionedMemberIds: [] })
    await pause(30); assert.equal(f.provider.turns.length, 0)
    await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'room', content: 'Alice, reply.', mentionedMemberIds: [alice.memberId] })
    await waitFor(() => f.provider.turns.length === 1)
    assert.equal(f.provider.turns[0].input.membrane.toolProfile, 'collaboration')
    await assert.rejects(f.tool(alice, 'activate', { sessionId: bob.sessionId }), /runtime/)
    for (const content of ['Update one.', 'Update two.']) await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'room', content, mentionedMemberIds: [alice.memberId] })
    assert.equal(Object.values(f.workspace(w.sessionId).triggers).filter((item) => item.status === 'pending').length, 1)
    await read(f, alice)
    const input = { content: 'Public answer.', __collaborationCallId: 'same-call' }
    await f.tool(alice, 'post_collaboration_message', input)
    await f.tool(alice, 'post_collaboration_message', input)
    f.provider.turns[0].finish()
    await waitFor(() => f.workspace(w.sessionId).triggers[Object.keys(f.workspace(w.sessionId).triggers)[0]].status === 'completed')
    assert.equal(f.workspace(w.sessionId).events.filter((event) => event.content === 'Public answer.').length, 1)
    assert.ok(!f.workspace(w.sessionId).events.some((event) => event.content.includes('PRIVATE_TRANSCRIPT')))
    assert.ok(f.provider.turns.every((turn) => turn.input.sessionId === alice.sessionId))
  } finally { await f.cleanup() }
})

test('all current assessments and settled turns are required for completion', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    await assess(f, w.members[0]); await assess(f, w.members[1])
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active')
    f.provider.turns[0].finish(); await pause(25)
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active')
    f.provider.turns[1].finish()
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
    await f.restart()
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'completed')
  } finally { await f.cleanup() }
})

test('new evidence invalidates old assessments; repeating one objection cannot cause a wakeup loop', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    const old = await read(f, w.members[0])
    await assess(f, w.members[1], 'not_satisfied', 'The rollback case is missing.', 'rollback')
    const seq = f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq
    await assess(f, w.members[1], 'not_satisfied', 'The rollback case is missing.', 'rollback')
    assert.equal(f.workspace(w.sessionId).discussions[id].latestSubstantiveSeq, seq)
    await assert.rejects(f.tool(w.members[0], 'set_discussion_assessment', { verdict: 'satisfied', reason: 'Done', goalRevision: old.discussion.goalRevision, cohortRevision: old.discussion.cohortRevision, basedOnSeq: old.discussion.latestSubstantiveSeq }), /stale/)
    await f.tool(w.members[0], 'post_collaboration_message', { content: 'Rollback uses the durable checkpoint.', issue: { issueId: 'rollback', summary: 'Checkpoint verified.', status: 'resolved' } })
    await assess(f, w.members[0]); await assess(f, w.members[1])
    f.provider.turns.forEach((turn) => turn.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
  } finally { await f.cleanup() }
})

test('pause retains pending updates, resume drains them, and cancelled turns cannot publish into a new discussion', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    for (const member of w.members) await f.tool(member, 'post_collaboration_message', { content: `${member.label} initial observation.` })
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'pause' })
    await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'discussion', discussionId: id, content: 'A new constraint.' })
    f.provider.turns.forEach((turn) => turn.finish()); await pause(60)
    assert.equal(f.provider.turns.length, 2)
    assert.ok(Object.values(f.workspace(w.sessionId).triggers).some((trigger) => trigger.status === 'pending'))
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'resume' })
    await waitFor(() => f.provider.turns.length === 4)
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'cancel' })
    const next = await start(f, w)
    await assert.rejects(f.tool(w.members[0], 'post_collaboration_message', { content: 'Late result.' }), /ended/)
    f.provider.turns.slice(2).forEach((turn) => turn.finish())
    await waitFor(() => f.provider.turns.length === 6)
    assert.equal(f.workspace(w.sessionId).discussions[next].status, 'active')
  } finally { await f.cleanup() }
})

test('turn cap pauses safely and restarting interrupted turns never reports success', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w, { maxTurns: 1 })
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'paused')
    assert.equal(f.provider.turns.length, 1)
    assert.equal(f.workspace(w.sessionId).discussions[id].turnsUsed, 1)
    await assert.rejects(f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'resume' }), /cap/)
    await f.restart()
    const restored = f.workspace(w.sessionId)
    assert.notEqual(restored.discussions[id].status, 'completed')
    assert.equal(restored.discussions[id].health, 'degraded')
    assert.ok(restored.members.some((member) => member.attention))
  } finally { await f.cleanup() }
})

test('failed members can retry without losing peers; revisions require fresh assessments', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    await assess(f, w.members[1]); f.provider.turns[1].finish()
    f.provider.turns[0].finish('Provider disconnected.')
    await waitFor(() => f.workspace(w.sessionId).members[0].attention)
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active')
    await f.command('retry_collaboration_member', { sessionId: w.sessionId, memberId: w.members[0].memberId })
    await waitFor(() => f.provider.turns.length === 3)
    const previous = await read(f, w.members[0])
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'revise', goal: 'Agree on rollback too.', requiredMemberIds: w.members.map((member) => member.memberId).reverse() })
    await assert.rejects(f.tool(w.members[0], 'set_discussion_assessment', { verdict: 'satisfied', reason: 'Done', goalRevision: previous.discussion.goalRevision, cohortRevision: previous.discussion.cohortRevision, basedOnSeq: previous.discussion.latestSubstantiveSeq }), /stale/)
    await waitFor(() => f.provider.turns.length === 4)
    await assess(f, w.members[0]); await assess(f, w.members[1])
    f.provider.turns.slice(2).forEach((turn) => turn.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
  } finally { await f.cleanup() }
})

test('read cursors are paged and scoped; a room cursor cannot skip discussion evidence', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const alice = w.members[0]
    for (let i = 0; i < 4; i++) await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'room', content: `Room fact ${i}`, mentionedMemberIds: i === 3 ? [alice.memberId] : [] })
    await waitFor(() => f.provider.turns.length === 1)
    const page = await f.tool(alice, 'read_collaboration_updates', { afterSeq: 0, limit: 2 })
    assert.equal(page.events.length, 2); assert.equal(page.hasMore, true)
    await assert.rejects(f.tool(alice, 'read_collaboration_updates', { afterSeq: 999 }), /skip unseen/)
    const remaining = await f.tool(alice, 'read_collaboration_updates', { afterSeq: page.throughSeq })
    assert.equal(remaining.hasMore, false)
    assert.equal(remaining.state, undefined, 'member tool never exposes global state or other transcripts')
    await f.tool(alice, 'post_collaboration_message', { content: 'Room facts received.' })
    f.provider.turns[0].finish()
    await waitFor(() => f.workspace(w.sessionId).triggers[Object.keys(f.workspace(w.sessionId).triggers)[0]].status === 'completed')
    await start(f, w)
    await waitFor(() => f.provider.turns.length === 3)
    await assert.rejects(f.tool(alice, 'read_collaboration_updates', { afterSeq: remaining.throughSeq }), /skip unseen/)
    const discussion = await read(f, alice)
    assert.ok(discussion.events.every((event) => event.scope === 'discussion'))
    assert.equal(discussion.members.some((member) => member.sessionId), false)
  } finally { await f.cleanup() }
})

test('Council attachment validates directory and never substitutes for discussion completion', async () => {
  const f = fixture()
  try {
    const w = await f.create()
    await assert.rejects(f.command('attach_collaboration_council', { sessionId: w.sessionId, workflowId: 'missing' }), /Unknown Plan Council/)
    const agent = (key) => ({ key, label: key, providerKind: 'claude-code', providerInstanceId: 'default-claude-sdk', runtimeSettings: { runtimeMode: 'approval-required', sandbox: 'read-only' } })
    const council = await f.runtime.startPlanCouncil({ objective: 'Compare plans', cwd: f.directory, planners: [agent('A'), agent('B')], synthesizer: agent('S') })
    await f.command('attach_collaboration_council', { sessionId: w.sessionId, workflowId: council.workflowId })
    await f.command('attach_collaboration_council', { sessionId: w.sessionId, workflowId: council.workflowId })
    assert.deepEqual(f.workspace(w.sessionId).councilIds, [council.workflowId])
    assert.equal(Object.keys(f.workspace(w.sessionId).discussions).length, 0)
    const other = await f.runtime.startPlanCouncil({ objective: 'Compare elsewhere', cwd: os.tmpdir(), planners: [agent('C'), agent('D')], synthesizer: agent('T') })
    await assert.rejects(f.command('attach_collaboration_council', { sessionId: w.sessionId, workflowId: other.workflowId }), /same directory/)
  } finally { await f.cleanup() }
})

test('pending paused triggers survive restart and archive never counts as successful completion', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'pause' })
    for (const member of w.members) await f.tool(member, 'post_collaboration_message', { content: `${member.label} has evidence.` })
    await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'discussion', discussionId: id, content: 'A pending update.' })
    f.provider.turns.forEach((turn) => turn.finish()); await pause(60)
    await f.restart()
    assert.equal(f.provider.turns.length, 2)
    assert.ok(Object.values(f.workspace(w.sessionId).triggers).some((trigger) => trigger.status === 'pending'))
    await f.command('archive_collaboration_session', { sessionId: w.sessionId, archived: true })
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'paused')
    await f.command('archive_collaboration_session', { sessionId: w.sessionId, archived: false })
    await f.command('update_collaboration_discussion', { sessionId: w.sessionId, discussionId: id, action: 'resume' })
    await waitFor(() => f.provider.turns.length === 4)
  } finally { await f.cleanup() }
})

test('reading newer evidence without reassessing preserves the required follow-up turn', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    await assess(f, w.members[0])
    await f.tool(w.members[1], 'post_collaboration_message', { content: 'New evidence changes the current revision.' })
    await read(f, w.members[0])
    await assess(f, w.members[1])
    f.provider.turns[0].finish(); f.provider.turns[1].finish()
    await waitFor(() => f.provider.turns.length === 3)
    assert.equal(f.provider.turns[2].input.sessionId, w.members[0].sessionId)
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active')
    await assess(f, w.members[0]); f.provider.turns[2].finish()
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
  } finally { await f.cleanup() }
})

test('an author that publishes again without assessing keeps a follow-up until current evidence is endorsed', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const [alice, bob] = w.members; const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    await assess(f, alice)
    await f.tool(alice, 'post_collaboration_message', { content: 'Additional evidence after the assessment.' })
    await assess(f, bob)
    f.provider.turns[0].finish(); f.provider.turns[1].finish()
    await waitFor(() => f.provider.turns.length === 3)
    assert.equal(f.provider.turns[2].input.sessionId, alice.sessionId)
    await read(f, alice)
    await f.tool(alice, 'post_collaboration_message', { content: 'A second finding without an assessment.' })
    f.provider.turns[2].finish()
    await waitFor(() => f.provider.turns.length === 5)
    assert.equal(f.workspace(w.sessionId).discussions[id].status, 'active')
    assert.ok(Object.values(f.workspace(w.sessionId).triggers).some((trigger) => trigger.memberId === alice.memberId && trigger.status === 'running'))
    await assess(f, bob); await assess(f, alice)
    f.provider.turns.slice(3).forEach((turn) => turn.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
    assert.equal(f.provider.turns.length, 5)
  } finally { await f.cleanup() }
})

test('publishing and then assessing in one turn does not schedule a duplicate author turn', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const id = await start(f, w)
    await waitFor(() => f.provider.turns.length === 2)
    await f.tool(w.members[0], 'post_collaboration_message', { content: 'Evidence published before assessment.' })
    await assess(f, w.members[0]); await assess(f, w.members[1])
    f.provider.turns.forEach((turn) => turn.finish())
    await waitFor(() => f.workspace(w.sessionId).discussions[id].status === 'completed')
    assert.equal(f.provider.turns.length, 2)
  } finally { await f.cleanup() }
})

test('a room mention queued behind a private chat turn starts when that private turn settles', async () => {
  const f = fixture()
  try {
    const w = await f.create(); const alice = w.members[0]
    await f.runtime.resumeSession({ sessionId: alice.sessionId, message: 'Private question.' })
    await waitFor(() => f.provider.turns.length === 1)
    await f.command('post_collaboration_message', { sessionId: w.sessionId, scope: 'room', content: 'A public question for Alice.', mentionedMemberIds: [alice.memberId] })
    assert.equal(f.provider.turns.length, 1)
    f.provider.turns[0].finish()
    await waitFor(() => f.provider.turns.length === 2)
    assert.equal(f.provider.turns[1].input.sessionId, alice.sessionId)
  } finally { await f.cleanup() }
})


test('starting and revising a discussion require at least two distinct members', async () => {
  const f = fixture()
  try {
    const w = await f.create()
    const oneMember = [w.members[0].memberId]
    const repeatedMember = [w.members[0].memberId, w.members[0].memberId]
    for (const requiredMemberIds of [oneMember, repeatedMember]) {
      await assert.rejects(start(f, w, { requiredMemberIds }), /at least two different members/)
    }
    assert.equal(f.provider.turns.length, 0)
    assert.equal(Object.keys(f.workspace(w.sessionId).discussions).length, 0)
    const id = await start(f, w)
    const original = f.workspace(w.sessionId).discussions[id]
    for (const requiredMemberIds of [oneMember, repeatedMember]) {
      await assert.rejects(f.command('update_collaboration_discussion', {
        sessionId: w.sessionId, discussionId: id, action: 'revise', requiredMemberIds,
      }), /at least two different members/)
    }
    const unchanged = f.workspace(w.sessionId).discussions[id]
    assert.deepEqual(unchanged.requiredMemberIds, original.requiredMemberIds)
    assert.equal(unchanged.cohortRevision, original.cohortRevision)
  } finally { await f.cleanup() }
})


test('constructing a runtime does not schedule a no-op collaboration recovery command', async () => {
  const f = fixture()
  try {
    const w = await f.create()
    await f.restart()
    const commandsAtConstruction = f.runtime.getKernelEvents({ type: 'collaboration.recovered' }).events.length
    await pause(30)
    assert.equal(commandsAtConstruction, 0)
    assert.equal(f.runtime.getKernelEvents({ type: 'collaboration.recovered' }).events.length, 0)
    assert.equal(f.workspace(w.sessionId).members.length, 2)
  } finally { await f.cleanup() }
})
