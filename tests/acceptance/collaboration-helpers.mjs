import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function memberInput(ctx, label) {
  const { providerKind } = ctx.provider
  const preset = ctx.modelPreset?.[providerKind]
  assert.ok(preset, `Explicit model preset is required for ${providerKind}`)
  assert.ok(preset.model, `A verified cheap model is required for ${providerKind}`)
  return {
    label,
    role: 'Follow the small acceptance task exactly. Do not edit files or delegate.',
    providerKind,
    providerInstanceId: providerKind === 'codex' ? 'default-codex' : 'default-claude-sdk',
    cwd: ctx.workDir,
    runtimeSettings: { ...preset, runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
  }
}

export function command(orrery, kind, input) {
  const commandId = randomUUID()
  return orrery.dispatchCommand({ kind, commandId, idempotencyKey: commandId, actor: { kind: 'human' }, input })
}

export function roomFrom(state, sessionId) {
  const room = state.collaborationSessions?.[sessionId]
  assert.ok(room, `Missing collaboration session ${sessionId}`)
  return room
}

export function assertSettled(state, room) {
  assert.ok(Object.values(room.triggers).every((trigger) =>
    !['pending', 'running'].includes(trigger.status)), 'All collaboration triggers must settle')
  for (const member of room.members) {
    const session = state.sessions[member.sessionId]
    assert.ok(session, `Missing member session ${member.sessionId}`)
    assert.equal(session.status, 'idle', `${member.label} must finish its provider turn`)
  }
  assert.equal(state.runQueue.length, 0, 'No queued provider work may remain')
}

export function assertNoOpenInteractions(session) {
  const request = session?.runtimeRequests?.find((item) => item.status === 'open')
  if (request) throw new Error(`${session.label} waits for permission: ${request.title}. This unattended scenario requires no approval.`)
  if (session?.runtimeUserInputRequests?.some((item) => item.status === 'open')) {
    throw new Error(`${session.label} waits for user input in a fully specified acceptance task.`)
  }
}

export async function waitForRoom(orrery, sessionId, label, predicate) {
  return orrery.waitFor(label, async () => {
    const state = await orrery.state()
    const room = roomFrom(state, sessionId)
    for (const member of room.members) {
      const session = state.sessions[member.sessionId]
      assertNoOpenInteractions(session)
      if (['failed', 'killed'].includes(session?.status)) {
        throw new Error(`${member.label} ${session.status}: ${session.error ?? 'no detail'}`)
      }
      if (member.attention) throw new Error(`${member.label} requires attention: ${member.attention}`)
    }
    const failed = Object.values(room.triggers).find((trigger) => trigger.status === 'failed')
    if (failed) throw new Error(`Collaboration trigger failed: ${failed.error ?? failed.triggerId}`)
    return predicate(room, state)
      ? { done: true, value: { room, state } }
      : { detail: JSON.stringify({ triggers: Object.values(room.triggers).map((t) => t.status),
          discussions: Object.values(room.discussions).map((d) => ({ status: d.status, turnsUsed: d.turnsUsed })) }) }
  }, { timeoutMs: 300_000 })
}

export function isSettled(state, room) {
  return Object.values(room.triggers).every((trigger) => !['pending', 'running'].includes(trigger.status)) &&
    room.members.every((member) => state.sessions[member.sessionId]?.status === 'idle') &&
    state.runQueue.length === 0
}

export function isQuiescent(state, room) {
  return Object.values(room.triggers).every((trigger) => trigger.status !== 'running') &&
    room.members.every((member) => state.sessions[member.sessionId]?.status === 'idle') &&
    state.runQueue.length === 0
}

export function saveEvidence(ctx, filename, value) {
  fs.writeFileSync(path.join(ctx.artifactsDir, filename), `${JSON.stringify(value, null, 2)}\n`)
}

export function assertUnanimousCompletion(room, discussion) {
  assert.equal(discussion.status, 'completed')
  assert.equal(discussion.health, 'healthy')
  assert.equal(discussion.requiredMemberIds.length, 2)
  assert.equal(Object.values(discussion.issues).some((issue) => issue.status === 'open'), false)
  for (const memberId of discussion.requiredMemberIds) {
    const assessment = discussion.assessments[memberId]
    assert.ok(assessment, `Missing explicit assessment for ${memberId}`)
    assert.equal(assessment.verdict, 'satisfied')
    assert.equal(assessment.goalRevision, discussion.goalRevision)
    assert.equal(assessment.cohortRevision, discussion.cohortRevision)
    assert.equal(assessment.basedOnSeq, discussion.latestSubstantiveSeq)
    assert.ok(assessment.runId)
    assert.ok(room.events.some((event) => event.kind === 'assessment' &&
      event.discussionId === discussion.discussionId && event.author === memberId),
    'Each assessment must be visible in the shared discussion')
  }
}
