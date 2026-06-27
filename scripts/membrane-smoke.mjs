import os from 'node:os'
import path from 'node:path'
import { RuntimeSessionManager } from '../dist-electron/electron/runtime/sessionManager.js'
import { cleanupRuntimeStorage } from './runtime-storage-cleanup.mjs'

const storageFile = path.join(
  os.tmpdir(),
  `orrery-membrane-smoke-${process.pid}.json`
)
const runtime = new RuntimeSessionManager({ storageFile })

const timeoutMs = Number(process.env.ORRERY_MEMBRANE_SMOKE_TIMEOUT_MS ?? 180000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const state = runtime.getState()
    const result = predicate(state)
    if (result) {
      return result
    }
    await sleep(750)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

function sessionStatus(sessionId) {
  return runtime.getState().sessions[sessionId]?.status
}

try {
  const createPrompt = [
    'Use the mcp__orrery_membrane__create_session tool exactly once.',
    'Create a claude-code session labeled "P2 Reporter" with this exact prompt:',
    '"Use the mcp__orrery_membrane__report tool exactly once with type verdict, verdict clean, summary p2 membrane report received, then stop."',
    'After the tool returns, reply only with the created session id.',
  ].join('\n')

  const { sessionId: sourceSessionId } = await runtime.createSession({
    prompt: createPrompt,
    agent: 'claude-code',
    label: 'P2 Source',
  })
  console.log(`[smoke] source=${sourceSessionId}`)

  const createEdge = await waitFor('create_session edge', (state) =>
    state.edges.find(
      (edge) =>
        edge.kind === 'create-session' && edge.source === sourceSessionId
    )
  )
  const targetSessionId = createEdge.target
  console.log(`[smoke] created target=${targetSessionId}`)

  const firstReport = await waitFor('target verdict report', (state) =>
    state.reports.find(
      (report) =>
        report.from === targetSessionId &&
        report.payload.type === 'verdict' &&
        report.payload.verdict === 'clean'
    )
  )
  console.log(
    `[smoke] first report source=${firstReport.envelope.source} verdict=${firstReport.payload.verdict}`
  )

  await waitFor('source session idle before resume', () =>
    sessionStatus(sourceSessionId) === 'idle' ? true : undefined
  )

  const resumePrompt = [
    `Use the mcp__orrery_membrane__resume_session tool exactly once for sessionId ${targetSessionId}.`,
    'Use this message: "Use the mcp__orrery_membrane__report tool exactly once with type verdict, verdict issues, summary p2 resume reached existing session, then stop."',
    'After the tool returns, reply only "resumed".',
  ].join('\n')

  await runtime.resumeSession({
    sessionId: sourceSessionId,
    message: resumePrompt,
  })

  await waitFor('resume_session edge', (state) =>
    state.edges.find(
      (edge) =>
        edge.kind === 'resume-session' &&
        edge.source === sourceSessionId &&
        edge.target === targetSessionId
    )
  )
  console.log(`[smoke] resumed target=${targetSessionId}`)

  const resumedReport = await waitFor('resumed target report', (state) =>
    state.reports.find(
      (report) =>
        report.from === targetSessionId &&
        report.payload.type === 'verdict' &&
        report.payload.verdict === 'issues'
    )
  )
  console.log(
    `[smoke] resumed report source=${resumedReport.envelope.source} verdict=${resumedReport.payload.verdict}`
  )

  const state = runtime.getState()
  console.log(
    `[smoke] ok nodes=${state.nodes.length} edges=${state.edges.length} reports=${state.reports.length}`
  )
} finally {
  await cleanupRuntimeStorage(runtime, storageFile)
}
