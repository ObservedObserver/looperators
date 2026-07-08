import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RuntimeSessionManager } from '../../dist-electron/electron/runtime/sessionManager.js'

const fakeClaudeSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const prompt = readArg('-p') ?? ''
const backendSessionId = readArg('--resume') ?? readArg('--session-id') ?? 'fake-session'
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
process.on('SIGTERM', () => process.exit(143))
emit({
  type: 'assistant',
  session_id: backendSessionId,
  message: { content: [{ type: 'text', text: 'fake response for ' + backendSessionId }] },
})
if (prompt.includes('ORRERY_DELAY')) {
  setInterval(() => {}, 1000)
} else if (prompt.includes('ORRERY_SLEEP')) {
  setTimeout(() => {
    emit({ type: 'result', session_id: backendSessionId, result: 'slow result' })
  }, 1200)
} else {
  emit({ type: 'result', session_id: backendSessionId, result: 'fake result for ' + backendSessionId })
}
`

function installFakeClaude(tempRoot) {
  const fakeClaude = path.join(tempRoot, 'claude')
  fs.writeFileSync(fakeClaude, fakeClaudeSource)
  fs.chmodSync(fakeClaude, 0o755)
  process.env.ORRERY_CLAUDE_BIN = fakeClaude
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate()
    if (value) {
      return value
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function kernelEvents(runtime) {
  return runtime.getKernelEvents({ limit: 2000 }).events
}

async function createIdleSession(runtime, label, prompt = `bootstrap ${label}`) {
  const created = await runtime.createSession({
    prompt,
    label,
    cwd: process.cwd(),
  })
  await waitFor(
    `${label} idle`,
    () => runtime.getState().sessions[created.sessionId]?.status === 'idle'
  )
  return created.sessionId
}

function harness(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  installFakeClaude(tempRoot)
  const storageFile = path.join(tempRoot, 'runtime-state.json')
  const managers = new Set()
  const manager = (input = { storageFile }) => {
    const runtime = new RuntimeSessionManager(input)
    managers.add(runtime)
    return runtime
  }
  const cleanup = () => {
    for (const runtime of managers) {
      try {
        runtime.killAll()
      } catch {
        // Best-effort cleanup only.
      }
    }
    delete process.env.ORRERY_CLAUDE_BIN
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  return { tempRoot, storageFile, manager, cleanup }
}

test('gate=auto watcher: a finished source auto-delivers and activates the target (§8.3)', async () => {
  const { manager, cleanup } = harness('orrery-subs-auto-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const acceptor = await createIdleSession(runtime, 'Acceptor')

    const authored = runtime.authorSubscription({
      label: 'S3',
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: acceptor,
      action: { kind: 'deliver+activate', topic: 'changeset', note: 'Acceptance-check the changeset.' },
      gate: 'auto',
    })
    assert.equal(authored.subscription.gate, 'auto')
    assert.equal(
      authored.subscription.stop,
      undefined,
      'an acyclic permanent listener needs no forced guardrail'
    )

    await runtime.resumeSession({ sessionId: coder, message: 'do some work' })
    await waitFor(
      'acceptor auto-activation',
      () =>
        runtime.getState().subscriptions?.[authored.subscription.id]?.firings === 1 &&
        runtime.getState().sessions[acceptor]?.status === 'idle' &&
        !runtime.getState().pendingActivations?.[
          `${authored.subscription.id}→${acceptor}`
        ]
    )

    const log = kernelEvents(runtime)
    const pending = log.find((event) => event.type === 'activation.pending')
    const approved = log.find((event) => event.type === 'activation.approved')
    const activated = log.find(
      (event) =>
        event.type === 'activated' &&
        event.payload.subscriptionId === authored.subscription.id
    )
    assert.ok(pending && approved && activated, 'pending → approved → activated chain')
    assert.equal(approved.actor.kind, 'rule', 'auto gate approves as the rule actor')
    assert.ok(
      log.some(
        (event) =>
          event.type === 'delivered' &&
          event.payload.subscriptionId === authored.subscription.id &&
          event.payload.topic === 'changeset'
      ),
      'the firing delivered the changeset bundle'
    )

    const acceptorSession = runtime.getState().sessions[acceptor]
    const activationMessage = [...acceptorSession.messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(activationMessage.content, /Acceptance-check the changeset\./)
    assert.match(activationMessage.content, /new delivery/)
  } finally {
    cleanup()
  }
})

test('gate=master: pending activation waits for membrane approval; deny discards', async () => {
  const { manager, cleanup } = harness('orrery-subs-master-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const reviewer = await createIdleSession(runtime, 'Reviewer')
    const master = await createIdleSession(runtime, 'Master')
    runtime.upsertCluster({ clusterId: 'c1', label: 'C1', nodeIds: [coder, reviewer] })
    runtime.assignMasterToCluster({ clusterId: 'c1', sessionId: master })

    const authored = runtime.authorSubscription({
      label: 'S1',
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: reviewer,
      action: { kind: 'deliver+activate', topic: 'diff' },
      gate: 'master',
    })
    const slotKey = `${authored.subscription.id}→${reviewer}`

    await runtime.resumeSession({ sessionId: coder, message: 'produce work' })
    const slot = await waitFor(
      'pending slot',
      () => runtime.getState().pendingActivations?.[slotKey]
    )
    assert.equal(slot.status, 'pending')
    assert.equal(slot.masterSessionId, master, 'R1 routes the gate to the cluster master')

    // The master was activated with the decision request.
    await waitFor(
      'master notified',
      () => runtime.getState().sessions[master]?.status === 'idle'
    )
    const masterMessage = [...runtime.getState().sessions[master].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(masterMessage.content, /approve_activation/)
    assert.ok(masterMessage.content.includes(slotKey))

    // A stranger session cannot decide the gate.
    await assert.rejects(
      () =>
        runtime.handleMembraneRequest({
          tool: 'approve_activation',
          source: coder,
          input: { slotKey },
        }),
      /does not govern/
    )

    await runtime.handleMembraneRequest({
      tool: 'approve_activation',
      source: master,
      input: { slotKey, note: 'Focus on the API changes.' },
    })
    await waitFor(
      'reviewer activated after approval',
      () =>
        runtime.getState().subscriptions?.[authored.subscription.id]?.firings === 1 &&
        runtime.getState().sessions[reviewer]?.status === 'idle'
    )
    const reviewerMessage = [...runtime.getState().sessions[reviewer].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(
      reviewerMessage.content,
      /Focus on the API changes\./,
      "the master's note rides along on the activation"
    )
    const resumeEdge = runtime
      .getState()
      .edges.find(
        (edge) =>
          edge.kind === 'resume-session' &&
          edge.source === master &&
          edge.target === reviewer
      )
    assert.ok(resumeEdge, 'the approved firing draws the master → target edge (§12.5)')

    // Second firing: deny it.
    await runtime.resumeSession({ sessionId: coder, message: 'more work' })
    await waitFor(
      'second pending slot',
      () => runtime.getState().pendingActivations?.[slotKey]?.status === 'pending'
    )
    await waitFor(
      'master idle again',
      () => runtime.getState().sessions[master]?.status === 'idle'
    )
    await runtime.handleMembraneRequest({
      tool: 'deny_activation',
      source: master,
      input: { slotKey, reason: 'Not needed this round.' },
    })
    assert.equal(runtime.getState().pendingActivations?.[slotKey], undefined)
    const denied = kernelEvents(runtime).find(
      (event) => event.type === 'activation.denied'
    )
    assert.ok(denied)
    assert.equal(denied.actor.kind, 'master')
    assert.equal(denied.reason, 'Not needed this round.')
    assert.equal(
      runtime.getState().subscriptions?.[authored.subscription.id]?.firings,
      1,
      'a denied firing does not count'
    )
  } finally {
    cleanup()
  }
})

test('coalesce: triggers while the target is busy supersede the slot and fire once on idle', async () => {
  const { manager, cleanup } = harness('orrery-subs-coalesce-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const acceptor = await createIdleSession(runtime, 'Acceptor')

    const authored = runtime.authorSubscription({
      label: 'S3',
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: acceptor,
      action: { kind: 'deliver+activate', topic: 'changeset' },
      gate: 'auto',
    })
    const slotKey = `${authored.subscription.id}→${acceptor}`

    // Make the acceptor busy for ~1.2s, then let the coder finish twice.
    await runtime.resumeSession({ sessionId: acceptor, message: 'ORRERY_SLEEP long turn' })
    await runtime.resumeSession({ sessionId: coder, message: 'first change' })
    await waitFor(
      'first approved slot parked',
      () => runtime.getState().pendingActivations?.[slotKey]?.status === 'approved'
    )
    await runtime.resumeSession({ sessionId: coder, message: 'second change' })

    await waitFor(
      'coalesced firing after the acceptor went idle',
      () =>
        runtime.getState().subscriptions?.[authored.subscription.id]?.firings === 1 &&
        !runtime.getState().pendingActivations?.[slotKey] &&
        runtime.getState().sessions[acceptor]?.status === 'idle',
      12000
    )

    const log = kernelEvents(runtime)
    assert.ok(
      log.some((event) => event.type === 'activation.superseded'),
      'the older pending activation was superseded (latest wins)'
    )
    assert.equal(
      log.filter(
        (event) =>
          event.type === 'activated' &&
          event.payload.subscriptionId === authored.subscription.id
      ).length,
      1,
      'exactly one activation fired for two triggers'
    )
  } finally {
    cleanup()
  }
})

test('queue: triggers while the target is busy build an ordered backlog and fire one by one', async () => {
  const { manager, cleanup } = harness('orrery-subs-queue-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const acceptor = await createIdleSession(runtime, 'Acceptor')

    const authored = runtime.authorSubscription({
      label: 'S4',
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: acceptor,
      action: { kind: 'deliver+activate', topic: 'changeset' },
      gate: 'auto',
      concurrency: 'queue',
    })
    const baseSlotKey = `${authored.subscription.id}→${acceptor}`
    const queuedSlotKey = `${baseSlotKey}#2`

    // Make the acceptor busy for ~1.2s, then let the coder finish twice.
    await runtime.resumeSession({ sessionId: acceptor, message: 'ORRERY_SLEEP long turn' })
    await runtime.resumeSession({ sessionId: coder, message: 'first change' })
    await waitFor(
      'first approved slot parked',
      () => runtime.getState().pendingActivations?.[baseSlotKey]?.status === 'approved'
    )
    await runtime.resumeSession({ sessionId: coder, message: 'second change' })
    await waitFor(
      'second slot queued behind the first',
      () => runtime.getState().pendingActivations?.[queuedSlotKey]?.status === 'approved'
    )

    await waitFor(
      'both queued firings executed after the acceptor went idle',
      () =>
        runtime.getState().subscriptions?.[authored.subscription.id]?.firings === 2 &&
        !runtime.getState().pendingActivations?.[baseSlotKey] &&
        !runtime.getState().pendingActivations?.[queuedSlotKey] &&
        runtime.getState().sessions[acceptor]?.status === 'idle',
      15000
    )

    const log = kernelEvents(runtime)
    assert.ok(
      !log.some((event) => event.type === 'activation.superseded'),
      'queue never supersedes: both triggers keep their own slot'
    )
    const activated = log.filter(
      (event) =>
        event.type === 'activated' &&
        event.payload.subscriptionId === authored.subscription.id
    )
    assert.deepEqual(
      activated.map((event) => event.payload.slotKey),
      [baseSlotKey, queuedSlotKey],
      'the backlog drained in trigger order, one activation per trigger'
    )
  } finally {
    cleanup()
  }
})

test('deliver-only subscriptions forward the source bundle without activation', async () => {
  const { manager, cleanup } = harness('orrery-subs-deliver-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const observer = await createIdleSession(runtime, 'Observer')

    const authored = runtime.authorSubscription({
      label: 'progress-feed',
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: observer,
      action: { kind: 'deliver', topic: 'progress' },
      gate: 'auto',
    })

    await runtime.resumeSession({ sessionId: coder, message: 'make progress' })
    await waitFor(
      'deliver-only firing',
      () => runtime.getState().subscriptions?.[authored.subscription.id]?.firings === 1
    )

    const delivered = kernelEvents(runtime).find(
      (event) =>
        event.type === 'delivered' &&
        event.payload.subscriptionId === authored.subscription.id
    )
    assert.ok(delivered, 'the firing landed as a delivered fact')
    assert.equal(delivered.payload.source, coder, 'attributed to the trigger source')
    assert.ok(
      delivered.payload.files.some((file) => file.endsWith('turn-summary.md')),
      'the artifact bundle was forwarded'
    )
    assert.equal(
      runtime.getState().sessions[observer]?.status,
      'idle',
      'deliver-only never activates the target'
    )
    assert.equal(
      kernelEvents(runtime).filter(
        (event) =>
          event.type === 'activated' &&
          event.payload.subscriptionId === authored.subscription.id
      ).length,
      0
    )
  } finally {
    cleanup()
  }
})

test('gate authority follows master reassignment (live R1 routing)', async () => {
  const { manager, cleanup } = harness('orrery-subs-reassign-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const reviewer = await createIdleSession(runtime, 'Reviewer')
    const m1 = await createIdleSession(runtime, 'MasterOne')
    const m2 = await createIdleSession(runtime, 'MasterTwo')
    runtime.upsertCluster({ clusterId: 'c1', label: 'C1', nodeIds: [coder, reviewer] })
    runtime.assignMasterToCluster({ clusterId: 'c1', sessionId: m1 })

    const authored = runtime.authorSubscription({
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: reviewer,
      action: { kind: 'deliver+activate' },
      gate: 'master',
    })
    const slotKey = `${authored.subscription.id}→${reviewer}`
    await runtime.resumeSession({ sessionId: coder, message: 'work' })
    await waitFor(
      'pending slot',
      () => runtime.getState().pendingActivations?.[slotKey]?.status === 'pending'
    )
    await waitFor(
      'm1 settled',
      () => runtime.getState().sessions[m1]?.status === 'idle'
    )

    // Reassign governance to M2: the demoted master loses the gate.
    runtime.assignMasterToCluster({ clusterId: 'c1', sessionId: m2 })
    await assert.rejects(
      () =>
        runtime.handleMembraneRequest({
          tool: 'approve_activation',
          source: m1,
          input: { slotKey },
        }),
      /does not govern/
    )
    await runtime.handleMembraneRequest({
      tool: 'approve_activation',
      source: m2,
      input: { slotKey },
    })
    await waitFor(
      'firing after the new governor approved',
      () => runtime.getState().subscriptions?.[authored.subscription.id]?.firings === 1,
      12000
    )
  } finally {
    cleanup()
  }
})

test('static check: unguarded cycles get default maxFirings and cycle-aware gate defaults', async () => {
  const { manager, cleanup } = harness('orrery-subs-static-')
  try {
    const runtime = manager()
    const a = await createIdleSession(runtime, 'A')
    const b = await createIdleSession(runtime, 'B')

    // Acyclic + no gate specified → defaults to auto, no forced guardrail.
    const forward = runtime.authorSubscription({
      sourceSessionId: a,
      on: { on: 'finished' },
      targetSessionId: b,
      action: { kind: 'deliver+activate' },
    })
    assert.equal(forward.subscription.gate, 'auto')
    assert.equal(forward.subscription.stop, undefined)

    // Closing the cycle without a gate → defaults to master AND both cyclic
    // subscriptions get the default maxFirings guardrail (§6.4).
    const back = runtime.authorSubscription({
      sourceSessionId: b,
      on: { on: 'finished' },
      targetSessionId: a,
      action: { kind: 'deliver+activate' },
    })
    assert.equal(back.subscription.gate, 'master', 'cycle default gate is master')
    assert.equal(back.subscription.stop.maxFirings, 6)
    const forwardStored = runtime.getState().subscriptions[forward.subscription.id]
    assert.equal(
      forwardStored.stop.maxFirings,
      6,
      'the existing cyclic subscription was guarded too'
    )
    assert.ok(
      kernelEvents(runtime).some(
        (event) =>
          event.type === 'subscription.guarded' &&
          event.payload.subscriptionId === forward.subscription.id
      ),
      'force-applied guardrails are logged facts'
    )

    // Deliver-only back-edges do not close activation cycles.
    const c = await createIdleSession(runtime, 'C')
    const progress = runtime.authorSubscription({
      sourceSessionId: c,
      on: { on: 'finished' },
      targetSessionId: a,
      action: { kind: 'deliver', topic: 'progress' },
    })
    assert.equal(progress.subscription.stop, undefined)
  } finally {
    cleanup()
  }
})

test('stop conditions: whenReport stops without firing and freezes per onStop (§12.5 step 8)', async () => {
  const { manager, cleanup } = harness('orrery-subs-stop-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const reviewer = await createIdleSession(runtime, 'Reviewer')
    runtime.upsertCluster({ clusterId: 'c1', label: 'C1', nodeIds: [coder, reviewer] })

    const authored = runtime.authorSubscription({
      label: 'S2',
      sourceSessionId: reviewer,
      on: { on: 'report', match: { type: 'verdict', verdict: 'issues' } },
      targetSessionId: coder,
      action: { kind: 'deliver+activate', topic: 'review' },
      gate: 'auto',
      stop: { whenReport: { verdict: 'clean' }, maxFirings: 6 },
      onStop: 'freeze-cluster',
    })

    await runtime.handleMembraneRequest({
      tool: 'report',
      source: reviewer,
      input: { type: 'verdict', verdict: 'clean' },
    })

    await waitFor(
      'subscription stopped and cluster frozen',
      () =>
        runtime.getState().subscriptions?.[authored.subscription.id]?.state ===
          'stopped' && runtime.getState().clusters.c1?.frozen === true
    )
    assert.equal(
      runtime.getState().subscriptions[authored.subscription.id].firings,
      0,
      'the clean verdict stopped the edge without firing it'
    )
    const log = kernelEvents(runtime)
    const stopped = log.find((event) => event.type === 'subscription.stopped')
    assert.match(stopped.reason, /clean/)
    const reportEvent = log.find((event) => event.type === 'report.received')
    assert.equal(stopped.causeId, reportEvent.id, 'the stop chains to the verdict')
    assert.ok(
      log.some(
        (event) =>
          event.type === 'freeze.applied' && event.payload.targetId === 'c1'
      ),
      'onStop=freeze-cluster froze the scope'
    )
  } finally {
    cleanup()
  }
})

test('kill parity: killing a participant stops its subscriptions', async () => {
  const { manager, cleanup } = harness('orrery-subs-kill-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const acceptor = await createIdleSession(runtime, 'Acceptor')
    const authored = runtime.authorSubscription({
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: acceptor,
      action: { kind: 'deliver+activate' },
      gate: 'auto',
    })

    await runtime.resumeSession({ sessionId: coder, message: 'ORRERY_DELAY run forever' })
    await waitFor(
      'coder running',
      () => runtime.getState().sessions[coder]?.status === 'running'
    )
    runtime.killSession(coder)
    await waitFor(
      'subscription stopped after participant kill',
      () =>
        runtime.getState().subscriptions?.[authored.subscription.id]?.state ===
        'stopped'
    )
    const stopped = kernelEvents(runtime).find(
      (event) => event.type === 'subscription.stopped'
    )
    assert.match(stopped.reason, /killed/)
  } finally {
    cleanup()
  }
})

test('subscriptions and pending slots survive a restart', async () => {
  const { manager, storageFile, cleanup } = harness('orrery-subs-restart-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    const reviewer = await createIdleSession(runtime, 'Reviewer')
    const master = await createIdleSession(runtime, 'Master')
    runtime.upsertCluster({ clusterId: 'c1', label: 'C1', nodeIds: [coder, reviewer] })
    runtime.assignMasterToCluster({ clusterId: 'c1', sessionId: master })
    const authored = runtime.authorSubscription({
      sourceSessionId: coder,
      on: { on: 'finished' },
      targetSessionId: reviewer,
      action: { kind: 'deliver+activate', topic: 'diff' },
      gate: 'master',
    })
    const slotKey = `${authored.subscription.id}→${reviewer}`
    await runtime.resumeSession({ sessionId: coder, message: 'work' })
    await waitFor(
      'pending slot exists',
      () => runtime.getState().pendingActivations?.[slotKey]
    )
    await waitFor(
      'master settled',
      () => runtime.getState().sessions[master]?.status === 'idle'
    )
    runtime.killAll()

    const restored = manager({ storageFile })
    const state = restored.getState()
    assert.equal(state.subscriptions[authored.subscription.id].state, 'active')
    assert.equal(state.pendingActivations[slotKey].status, 'pending')

    // The restored runtime can still decide the parked gate.
    await restored.approveActivation({ slotKey })
    await waitFor(
      'restored firing executes',
      () =>
        restored.getState().subscriptions[authored.subscription.id].firings === 1 &&
        restored.getState().sessions[reviewer]?.status === 'idle',
      12000
    )
  } finally {
    cleanup()
  }
})

test('hero loop preset compiles to S1/S2 and walks the §12.5 sequence', async () => {
  const { manager, cleanup } = harness('orrery-subs-hero-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    runtime.upsertCluster({
      clusterId: 'c1',
      label: 'Hero',
      nodeIds: [coder],
      loopPolicy: {
        until: { whenReport: { verdict: 'clean' } },
        onStop: 'freeze',
        maxIterations: 3,
      },
    })
    const master = await runtime.createMasterForCluster({
      clusterId: 'c1',
      prompt: 'master bootstrap',
      label: 'Master',
      cwd: process.cwd(),
    })
    await waitFor(
      'master idle',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )

    await runtime.startMasterLoop({ clusterId: 'c1', reason: 'test loop' })
    const state = runtime.getState()
    const subs = Object.values(state.subscriptions)
    const s1 = subs.find((sub) => sub.label === 'S1')
    const s2 = subs.find((sub) => sub.label === 'S2')
    assert.ok(s1 && s2, 'the preset compiled into two subscriptions')
    assert.equal(s1.gate, 'master')
    assert.equal(s2.stop.whenReport.verdict, 'clean')
    assert.equal(s2.stop.maxFirings, 3)
    assert.equal(s2.onStop, 'freeze-cluster')
    const reviewerId = s1.target.sessionId
    assert.equal(state.sessions[reviewerId]?.label, 'Reviewer')
    assert.equal(state.clusters.c1.loopState.status, 'running')

    // Kick: the coder was idle, so S1 pends immediately (gate master).
    const s1Slot = `${s1.id}→${reviewerId}`
    await waitFor(
      'S1 pend from the loop kick',
      () => runtime.getState().pendingActivations?.[s1Slot]?.status === 'pending',
      12000
    )
    await waitFor(
      'reviewer bootstrap + master notification settled',
      () =>
        runtime.getState().sessions[reviewerId]?.status === 'idle' &&
        runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )

    // §12.5 step 2-ish: master approves the first review.
    await runtime.handleMembraneRequest({
      tool: 'approve_activation',
      source: master.sessionId,
      input: { slotKey: s1Slot },
    })
    await waitFor(
      'reviewer activated with the diff delivery',
      () =>
        runtime.getState().subscriptions[s1.id].firings === 1 &&
        runtime.getState().sessions[reviewerId]?.status === 'idle',
      12000
    )

    // Step 3-4: reviewer reports issues → S2 pends → master approves →
    // coder is activated with the review delivery.
    await runtime.handleMembraneRequest({
      tool: 'report',
      source: reviewerId,
      input: {
        type: 'verdict',
        verdict: 'issues',
        issues: [{ message: 'null pointer in foo()', file: 'foo.ts', line: 42, severity: 'error' }],
      },
    })
    const s2Slot = `${s2.id}→${coder}`
    await waitFor(
      'S2 pend after the issues verdict',
      () => runtime.getState().pendingActivations?.[s2Slot]?.status === 'pending'
    )
    await waitFor(
      'master idle for the S2 decision',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )
    await runtime.handleMembraneRequest({
      tool: 'approve_activation',
      source: master.sessionId,
      input: { slotKey: s2Slot },
    })
    await waitFor(
      'coder activated for iteration 1',
      () =>
        runtime.getState().subscriptions[s2.id].firings === 1 &&
        runtime.getState().sessions[coder]?.status === 'idle',
      12000
    )
    assert.equal(
      runtime.getState().clusters.c1.loopState.iterations,
      1,
      'iteration count = S2 firings (§6.2)'
    )
    const coderMessage = [...runtime.getState().sessions[coder].messages]
      .reverse()
      .find((message) => message.role === 'user')
    assert.match(coderMessage.content, /reviewer reported issues/i)
    const reviewDelivered = kernelEvents(runtime).find(
      (event) =>
        event.type === 'delivered' &&
        event.payload.subscriptionId === s2.id &&
        event.payload.topic === 'review'
    )
    assert.ok(reviewDelivered, 'the issues rode the channel as review.md')
    const reviewFile = reviewDelivered.payload.files.find((file) =>
      file.endsWith('review.md')
    )
    assert.match(fs.readFileSync(reviewFile, 'utf8'), /null pointer in foo\(\)/)

    // Step 5: the coder finishing re-fires S1 (the loop lives).
    await waitFor(
      'S1 pends again after the coder turn',
      () => runtime.getState().pendingActivations?.[s1Slot]?.status === 'pending'
    )
    await waitFor(
      'master idle for the second S1 decision',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )
    await runtime.handleMembraneRequest({
      tool: 'approve_activation',
      source: master.sessionId,
      input: { slotKey: s1Slot },
    })
    await waitFor(
      'reviewer re-activated (remembering earlier findings)',
      () =>
        runtime.getState().subscriptions[s1.id].firings === 2 &&
        runtime.getState().sessions[reviewerId]?.status === 'idle',
      12000
    )

    // Step 7-8: clean verdict → S2 stops without firing → freeze-cluster.
    await runtime.handleMembraneRequest({
      tool: 'report',
      source: reviewerId,
      input: { type: 'verdict', verdict: 'clean' },
    })
    await waitFor(
      'loop stopped and cluster frozen on clean',
      () =>
        runtime.getState().subscriptions[s2.id].state === 'stopped' &&
        runtime.getState().subscriptions[s1.id].state === 'stopped' &&
        runtime.getState().clusters.c1.frozen === true &&
        runtime.getState().clusters.c1.loopState.status === 'stopped'
    )
    assert.equal(
      runtime.getState().subscriptions[s2.id].firings,
      1,
      'the clean verdict never fired the edge'
    )

    const log = kernelEvents(runtime)
    const cleanReport = log
      .filter((event) => event.type === 'report.received')
      .at(-1)
    const s2Stopped = log.find(
      (event) =>
        event.type === 'subscription.stopped' &&
        event.payload.subscriptionId === s2.id
    )
    assert.equal(s2Stopped.causeId, cleanReport.id, 'stop chains to the clean verdict')
    assert.ok(
      log.some(
        (event) =>
          event.type === 'freeze.applied' && event.payload.targetId === 'c1'
      )
    )

    // Guards intact: master → target resume edges exist for each firing.
    const masterEdges = runtime
      .getState()
      .edges.filter(
        (edge) => edge.kind === 'resume-session' && edge.source === master.sessionId
      )
    assert.ok(masterEdges.length >= 3, 'each approved firing drew a master edge')
  } finally {
    cleanup()
  }
})

test('hero loop maxFirings guard stops the loop instead of firing past the cap', async () => {
  const { manager, cleanup } = harness('orrery-subs-max-')
  try {
    const runtime = manager()
    const coder = await createIdleSession(runtime, 'Coder')
    runtime.upsertCluster({
      clusterId: 'c1',
      label: 'MaxGuard',
      nodeIds: [coder],
      loopPolicy: {
        until: { whenReport: { verdict: 'clean' } },
        onStop: 'freeze',
        maxIterations: 1,
      },
    })
    const master = await runtime.createMasterForCluster({
      clusterId: 'c1',
      prompt: 'master bootstrap',
      label: 'Master',
      cwd: process.cwd(),
    })
    await waitFor(
      'master idle',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )
    await runtime.startMasterLoop({ clusterId: 'c1' })
    const subs = Object.values(runtime.getState().subscriptions)
    const s1 = subs.find((sub) => sub.label === 'S1')
    const s2 = subs.find((sub) => sub.label === 'S2')
    const reviewerId = s1.target.sessionId
    await waitFor(
      'reviewer + master settled',
      () =>
        runtime.getState().sessions[reviewerId]?.status === 'idle' &&
        runtime.getState().sessions[master.sessionId]?.status === 'idle',
      12000
    )

    // First issues verdict → approve → iteration 1 (the cap).
    await runtime.handleMembraneRequest({
      tool: 'report',
      source: reviewerId,
      input: { type: 'verdict', verdict: 'issues', issues: [{ message: 'first pass' }] },
    })
    const s2Slot = `${s2.id}→${coder}`
    await waitFor(
      'S2 pend',
      () => runtime.getState().pendingActivations?.[s2Slot]?.status === 'pending'
    )
    await waitFor(
      'master idle',
      () => runtime.getState().sessions[master.sessionId]?.status === 'idle'
    )
    await runtime.handleMembraneRequest({
      tool: 'approve_activation',
      source: master.sessionId,
      input: { slotKey: s2Slot },
    })
    await waitFor(
      'iteration 1 done',
      () => runtime.getState().subscriptions[s2.id].firings === 1,
      12000
    )

    // Second issues verdict hits the cap: stop + freeze, no firing.
    await runtime.handleMembraneRequest({
      tool: 'report',
      source: reviewerId,
      input: { type: 'verdict', verdict: 'issues', issues: [{ message: 'second pass' }] },
    })
    await waitFor(
      'maxFirings stop + freeze',
      () =>
        runtime.getState().subscriptions[s2.id].state === 'stopped' &&
        runtime.getState().clusters.c1.frozen === true
    )
    const stopped = kernelEvents(runtime).find(
      (event) =>
        event.type === 'subscription.stopped' &&
        event.payload.subscriptionId === s2.id
    )
    assert.match(stopped.reason, /maxFirings=1/)
    assert.equal(runtime.getState().subscriptions[s2.id].firings, 1)
  } finally {
    cleanup()
  }
})
