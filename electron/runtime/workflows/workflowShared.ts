// Shared workflow resource helpers: compensation/discard of sessions,
// subscriptions and their runtime resources, provider-start settling.
// Split out of sessionManager.ts; kernel access goes through WorkflowKernel.
import fs from 'node:fs'
import path from 'node:path'
import {
  clone,
  type JsonRecord,
} from '../runtimeCommon.js'
import {
  gitOutput,
} from '../workspace/gitWorkspace.js'
import type { WorkflowKernel } from './workflowKernel.js'

export function discardWorkflowSubscription(m: WorkflowKernel, subscriptionId: string) {
  m.clearTimer(subscriptionId)
  for (const [slotKey, slot] of Object.entries(
    (m.state.pendingActivations ?? {}) as JsonRecord,
  )) {
    if (slot.subscriptionId === subscriptionId) {
      delete m.state.pendingActivations[slotKey]
    }
  }
  delete m.state.subscriptions?.[subscriptionId]
}

export function workflowResourceDescriptors(m: WorkflowKernel, sessionIds: string[]) {
  return sessionIds
    .map((sessionId) => {
      const session = m.state.sessions[sessionId]
      return session
        ? {
            sessionId,
            cwd: session.cwd,
            project: clone(session.project),
          }
        : undefined
    })
    .filter(Boolean)
}

export function cleanupWorkflowResourceDescriptor(m: WorkflowKernel, descriptor) {
  if (descriptor?.project?.workMode === 'worktree' && descriptor.project.repoRoot) {
    try {
      gitOutput(descriptor.project.repoRoot, [
        'worktree',
        'remove',
        '--force',
        descriptor.cwd,
      ])
    } catch {
      // Worktree may already be absent.
    }
    if (descriptor.project.branch?.startsWith('orrery/')) {
      try {
        gitOutput(descriptor.project.repoRoot, [
          'branch',
          '-D',
          descriptor.project.branch,
        ])
      } catch {
        // Generated branch may already be absent.
      }
    }
  }
  try {
    fs.rmSync(m.channelStore.channelDir(descriptor.sessionId), {
      recursive: true,
      force: true,
    })
  } catch {
    // Best-effort recovery cleanup.
  }
}

export async function settleProviderStart(m: WorkflowKernel) {
  // Provider process failures (for example ENOENT or an immediate CLI
  // bootstrap error) are delivered asynchronously after startTurn returns.
  // Atomic workflow APIs cross two event-loop checks before reporting
  // success so those startup failures enter the same compensation path.
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

export function discardWorkflowSession(m: WorkflowKernel, sessionId: string) {
  const run = m.runs.get(sessionId)
  if (run) {
    // Compensation removes the live Session immediately, before an
    // asynchronous provider close/error can arrive. Detach the run from
    // killAll and make its eventual callbacks no-ops against that removed
    // Session.
    m.workflowCompensatedRuns.add(sessionId)
    m.runs.delete(sessionId)
    try {
      run.kill()
    } catch {
      // Best-effort provider compensation; live graph cleanup still runs.
    }
  }
  const session = m.state.sessions[sessionId]
  if (session?.project?.workMode === 'worktree' && session.project.repoRoot) {
    try {
      gitOutput(session.project.repoRoot, [
        'worktree',
        'remove',
        '--force',
        session.cwd,
      ])
    } catch {
      // The worktree may already have been removed or never fully created.
    }
    if (session.project.branch?.startsWith('orrery/')) {
      try {
        gitOutput(session.project.repoRoot, [
          'branch',
          '-D',
          session.project.branch,
        ])
      } catch {
        // Generated branch cleanup is best-effort compensation.
      }
    }
  }
  delete m.state.sessions[sessionId]
  m.state.nodes = m.state.nodes.filter(
    (node) => node.sessionId !== sessionId,
  )
  m.state.edges = m.state.edges.filter(
    (edge) => edge.source !== sessionId && edge.target !== sessionId,
  )
  for (const cluster of Object.values(m.state.clusters as JsonRecord)) {
    cluster.nodeIds = cluster.nodeIds.filter((id) => id !== sessionId)
    if (cluster.masterSessionId === sessionId) {
      delete cluster.masterSessionId
    }
  }
  m.runContext.delete(sessionId)
  try {
    fs.rmSync(m.channelStore.channelDir(sessionId), {
      recursive: true,
      force: true,
    })
  } catch {
    // Channel cleanup is best-effort and outside the product graph.
  }
}

