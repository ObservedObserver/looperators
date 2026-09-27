import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { assertNoOpenInteractions, command, saveEvidence } from './collaboration-helpers.mjs'

export const name = 'plan-council-follow-up'
export const description =
  'A real seven-turn Council accepts stage updates, produces proposals/reviews/synthesis, previews a specialist without running it, verifies a fixture fact, and resynthesizes under a new constraint.'
export const providers = ['claude-code', 'codex']
export const timeoutMs = 1_200_000

function participant(ctx, key, label) {
  const { providerKind } = ctx.provider
  assert.ok(ctx.modelPreset?.[providerKind]?.model, 'Council requires an explicit cheap model')
  return {
    key, label, providerKind,
    providerInstanceId: providerKind === 'codex' ? 'default-codex' : 'default-claude-sdk',
    instructions: 'Keep your response under 180 words. Make a concrete small plan without editing files.',
    runtimeSettings: { ...ctx.modelPreset[providerKind], runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' },
  }
}

async function approveAndCommit(orrery, proposal) {
  await command(orrery, 'approve_workflow_proposal', { proposalId: proposal.proposalId })
  return command(orrery, 'commit_workflow', { proposalId: proposal.proposalId, expectedBaseVersion: proposal.baseVersion })
}

async function approveFixtureRead(ctx, session) {
  for (const request of session.runtimeRequests ?? []) {
    if (request.status !== 'open') continue
    const params = request.raw?.payload?.params
    const readCommand = "sed -n '1,240p' README.md"
    const allowedCommands = [readCommand, `/bin/zsh -lc "${readCommand}"`]
    const actions = params?.commandActions
    assert.ok(request.raw?.source === 'codex.app-server.request' &&
      request.raw?.method === 'item/commandExecution/requestApproval' &&
      allowedCommands.includes(params?.command) &&
      params?.cwd && fs.realpathSync(params.cwd) === fs.realpathSync(ctx.workDir) &&
      fs.realpathSync(session.cwd) === fs.realpathSync(ctx.workDir) &&
      actions?.length === 1 && actions[0].type === 'read' && actions[0].command === readCommand &&
      actions[0].path && fs.realpathSync(actions[0].path) === fs.realpathSync(path.join(ctx.workDir, 'README.md')),
    `Unexpected permission request from ${session.label}: ${request.title}`)
    const key = `${session.sessionId}:${request.turnId}:${request.id}`
    if (ctx.readApprovals.some((approval) => approval.key === key)) continue
    await ctx.orrery.respondRequest(request.id, { sessionId: session.sessionId, decision: 'accept' })
    ctx.readApprovals.push({ key, sessionId: session.sessionId, label: session.label, command: params.command,
      cwd: params.cwd, decision: 'accept', approvedAt: new Date().toISOString() })
    saveEvidence(ctx, 'fixture-read-approvals.json', ctx.readApprovals)
    ctx.log(`accepted one exact README.md read for ${session.label}; no persistent permission granted`)
  }
  assertNoOpenInteractions({ ...session, runtimeRequests: [] })
}

async function waitForPhase(ctx, workflowId, phase) {
  const { orrery } = ctx
  return orrery.waitFor(`Council ${phase}`, async () => {
    const state = await orrery.state()
    const council = state.planCouncils[workflowId]
    for (const id of council?.participantOrder ?? []) await approveFixtureRead(ctx, state.sessions[id])
    if (['failed', 'blocked', 'stopped'].includes(council?.phase)) throw new Error(`Council ${council.phase}: ${council.failure ?? 'no detail'}`)
    const settled = council?.participantOrder.every((id) => state.sessions[id]?.status === 'idle')
    return council?.phase === phase && settled && state.runQueue.length === 0
      ? { done: true, value: { state, council } }
      : { detail: `${council?.phase ?? 'missing'}; ${council?.artifacts.length ?? 0} artifacts; settled=${settled}` }
  }, { timeoutMs: 300_000 })
}

export async function run(ctx) {
  const { orrery, workDir, log } = ctx
  ctx.readApprovals = []
  const fixture = '# Queue fixture\n\nThe queue currently exists only in memory.\nA single host must retain jobs across restarts.\nDeployment verification token: VERIFY_BLUE_271.\n'
  fs.writeFileSync(path.join(workDir, 'README.md'), fixture)
  const recipeInput = {
    cwd: workDir,
    objective: "Read README.md with a provider-native read tool. If reads use a shell-backed tool, use exactly: sed -n '1,240p' README.md. Propose a minimal change from the in-memory queue to durable single-host storage. No code changes. Give a short staged plan and one restart test.",
    reviewFocus: 'Prefer the smallest solution. Keep proposals and reviews under 180 words; synthesis under 350 words.',
    planners: [participant(ctx, 'storage', 'Storage Planner'), participant(ctx, 'recovery', 'Recovery Planner')],
    synthesizer: participant(ctx, 'synthesizer', 'Decision Writer'),
    advancement: { crossReview: 'human', synthesis: 'human' },
  }
  const proposed = await command(orrery, 'propose_workflow', {
    recipe: 'plan-council', objective: recipeInput.objective, input: recipeInput,
    reason: 'Run the explicit seven-turn Council acceptance fixture.',
  })
  assert.equal(Object.keys((await orrery.state()).sessions).length, 0, 'Preview must not create provider sessions')
  const committed = await approveAndCommit(orrery, proposed.proposal)
  const workflowId = committed.executionMapping.productWorkflowId
  assert.ok(workflowId)
  const workflowPlanId = committed.plan.workflowId
  const proposals = await waitForPhase(ctx, workflowId, 'ready-for-cross-review')
  assert.equal(proposals.council.artifacts.filter((item) => item.kind === 'proposal').length, 2)
  log('two independent proposals settled; adding a human constraint before review')

  await command(orrery, 'start_plan_council_cross_review', {
    workflowId, note: 'SINGLE_HOST_271: only one deployment host is required. Apply this constraint in your review.',
  })
  const reviews = await waitForPhase(ctx, workflowId, 'ready-for-synthesis')
  assert.equal(reviews.council.artifacts.filter((item) => item.kind === 'peer-review').length, 2)
  assert.equal(reviews.council.interventions.length, 1)
  for (const memberId of reviews.council.participantOrder.filter((id) => reviews.council.participants[id].role === 'planner')) {
    assert.ok(reviews.state.sessions[memberId].messages.some((message) => message.role === 'user' && message.content.includes('SINGLE_HOST_271')))
  }
  await command(orrery, 'start_plan_council_synthesis', {
    workflowId, note: 'Preserve a restart verification step and explicitly distinguish recommendation from unanimous agreement.',
  })
  const first = await waitForPhase(ctx, workflowId, 'completed')
  assert.equal(first.council.artifacts.length, 5)
  assert.equal(first.council.interventions.length, 2)
  const firstSynthesis = first.council.artifacts.find((item) => item.kind === 'synthesis')
  const { content: firstText } = await orrery.getPlanCouncilArtifact(workflowId, firstSynthesis.artifactId)
  assert.match(firstText, /restart|recover|durab/i)
  const beforeCount = Object.keys(first.state.sessions).length
  const beforeUsage = first.state.usageFacts.length
  const plan = first.state.workflowPlans[workflowPlanId]['1']
  const specialist = participant(ctx, 'evidence-reviewer', 'Evidence Reviewer')
  const verifierPreview = await command(orrery, 'propose_workflow_patch', {
    workflowId: workflowPlanId, baseVersion: 1, reason: 'Verify the deployment token from the source fixture.',
    operations: [{ op: 'add-verifier', observes: plan.participants.filter((item) => item.role === 'Planner').map((item) => item.key),
      verifier: { key: specialist.key, label: specialist.label, role: 'Verifier',
        prompt: "Read README.md using a provider-native read tool. If reads use a shell-backed tool, use exactly: sed -n '1,240p' README.md. State the exact deployment verification token found in that file and cite README.md. Confirm whether the plans respect its one-host constraint. Keep the answer under 120 words, then stop.",
        endpoint: { kind: 'new', providerKind: specialist.providerKind, providerInstanceId: specialist.providerInstanceId, runtimeSettings: specialist.runtimeSettings },
        workspace: { cwd: workDir, access: 'read', workMode: 'local' },
      },
    }],
  })
  const previewState = await orrery.state()
  assert.equal(Object.keys(previewState.sessions).length, beforeCount)
  assert.equal(previewState.usageFacts.length, beforeUsage, 'Specialist preview must not execute a provider turn')
  assert.equal(verifierPreview.proposal.status, 'proposed')
  const patched = await approveAndCommit(orrery, verifierPreview.proposal)
  const specialistId = patched.executionMapping.participantSessionIds[specialist.key]
  assert.ok(specialistId)
  const verified = await waitForPhase(ctx, workflowId, 'ready-for-synthesis')
  assert.equal(Object.keys(verified.state.sessions).length, beforeCount + 1)
  const verification = verified.council.artifacts.find((item) => item.authorSessionId === specialistId && item.kind === 'peer-review')
  assert.ok(verification)
  const { content: verificationText } = await orrery.getPlanCouncilArtifact(workflowId, verification.artifactId)
  assert.match(verificationText, /VERIFY_BLUE_271/)
  assert.match(verificationText, /README\.md/)
  log('specialist preview stayed idle; one approved read-only verification turn published source evidence')

  const resynthesisPreview = await command(orrery, 'propose_workflow_patch', {
    workflowId: workflowPlanId, baseVersion: 2, reason: 'Include the specialist evidence in the final recommendation.',
    operations: [{ op: 'resynthesize', reason: 'FINAL_SCOPE_271: cite the specialist verification token VERIFY_BLUE_271 in your revised recommendation, and preserve the single-host scope. Keep the recommendation under 350 words.' }],
  })
  await approveAndCommit(orrery, resynthesisPreview.proposal)
  const final = await waitForPhase(ctx, workflowId, 'completed')
  const syntheses = final.council.artifacts.filter((item) => item.kind === 'synthesis')
  assert.deepEqual(syntheses.map((item) => item.version), [1, 2])
  assert.equal(final.council.artifacts.length, 7)
  const { content: finalText } = await orrery.getPlanCouncilArtifact(workflowId, syntheses.at(-1).artifactId)
  assert.match(finalText, /VERIFY_BLUE_271/)
  assert.ok(final.council.interventions.some((entry) => entry.text.includes('FINAL_SCOPE_271')))
  const memberIds = new Set(final.council.participantOrder)
  assert.equal(final.state.usageFacts.filter((fact) => memberIds.has(fact.sessionId)).length, 7)
  assert.equal(final.state.workspaceLeases.some((lease) => lease.status === 'active'), false)
  for (const id of memberIds) {
    assert.equal(final.state.sessions[id].runtimeSettings.model, ctx.modelPreset[ctx.provider.providerKind].model)
    assert.equal(final.state.sessions[id].runtimeSettings.sandbox, 'read-only')
    assert.equal(final.state.sessions[id].status, 'idle')
  }
  assert.equal(fs.readFileSync(path.join(workDir, 'README.md'), 'utf8'), fixture)
  saveEvidence(ctx, 'council-follow-up-evidence.json', { workflowId, workflowPlanId, council: final.council,
    verificationText, firstText, finalText, readApprovals: ctx.readApprovals, model: ctx.modelPreset[ctx.provider.providerKind].model })
  log('verified seven settled provider turns: proposals, peer reviews, synthesis, specialist evidence, and revised synthesis')
}
