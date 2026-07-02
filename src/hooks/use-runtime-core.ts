import { useMemo, useState } from 'react'

import {
  createEmptyGraphState,
  type GraphState,
} from '@/shared/graph-state'
import { projectSession } from '@/shared/session-projection'
import { createDemoGraphState } from '@/shared/demo-state'
import { useRuntimeClient } from '@/runtime-client'
import { demoMode } from '@/lib/workspace'
import { invalidCwdsFromDiagnostics, sessionRecoveryState } from '@/lib/diagnostics'
import { sessionSort } from '@/lib/session-display'
import { activityEvents } from '@/lib/graph-view'

export function useRuntimeCore() {
  const [runtimeState, setRuntimeState] = useState<GraphState>(
    demoMode ? createDemoGraphState : createEmptyGraphState
  )
  const [selectedSessionId, setSelectedSessionId] = useState<
    string | null | undefined
  >(demoMode ? 'sess-p1-accept' : undefined)
  const [runtimeError, setRuntimeError] = useState<string>()
  const runtimeClient = useRuntimeClient({ disabled: demoMode })
  const runtimeApi = demoMode ? undefined : runtimeClient.runtime
  const isRuntimeAvailable = Boolean(runtimeApi)
  const isElectron = !demoMode && runtimeClient.kind === 'electron'
  const runtimeHostPlatform =
    runtimeClient.kind === 'electron' || runtimeClient.kind === 'http'
      ? runtimeClient.platform
      : undefined
  const runtimeModeLabel = demoMode
    ? 'demo'
    : runtimeClient.kind === 'electron'
      ? 'electron'
      : runtimeClient.kind === 'http'
        ? 'web runtime'
        : runtimeClient.kind === 'connecting'
          ? 'connecting'
        : 'no runtime'
  const runtimeStatusText =
    runtimeClient.kind === 'http'
      ? `Web runtime ${runtimeClient.runtimeUrl}`
      : runtimeClient.kind === 'electron'
        ? 'Electron runtime'
        : runtimeClient.kind === 'connecting'
          ? `Connecting to web runtime ${runtimeClient.runtimeUrl}`
          : runtimeClient.kind === 'unavailable' && runtimeClient.runtimeUrl
            ? `No runtime at ${runtimeClient.runtimeUrl}`
        : demoMode
          ? 'Demo graph'
          : 'No runtime client'
  const runtimeUnavailableText = demoMode
    ? 'Demo mode uses sample data. Remove ?demo=1 to connect to a runtime.'
    : runtimeClient.kind === 'unavailable' && runtimeClient.error
      ? runtimeClient.error
      : runtimeClient.kind === 'connecting'
        ? `Connecting to web runtime at ${runtimeClient.runtimeUrl}.`
        : 'Runtime is unavailable. Start the desktop app or the web runtime server.'

  const selectedSession = selectedSessionId
    ? runtimeState.sessions[selectedSessionId]
    : undefined
  const selectedSessionProjection = useMemo(
    () => (selectedSession ? projectSession(selectedSession) : undefined),
    [selectedSession]
  )
  const selectedNode = selectedSessionId
    ? runtimeState.nodes.find((node) => node.sessionId === selectedSessionId)
    : undefined
  const selectedManagedCluster = selectedSessionId
    ? Object.values(runtimeState.clusters).find((cluster) =>
        cluster.nodeIds.includes(selectedSessionId)
      )
    : undefined
  const selectedSessionFrozen =
    selectedNode?.frozen === true || selectedManagedCluster?.frozen === true
  const openRuntimeRequests = selectedSessionProjection?.openRequests ?? []
  const openUserInputRequests = selectedSessionProjection?.userInputRequests ?? []
  const sessions = Object.values(runtimeState.sessions).sort(sessionSort)
  const providerInstances = runtimeState.providerInstances ?? []
  const runtimeDiagnostics = useMemo(
    () => runtimeState.diagnostics ?? [],
    [runtimeState.diagnostics]
  )
  const invalidProjectCwds = useMemo(
    () => invalidCwdsFromDiagnostics(runtimeDiagnostics),
    [runtimeDiagnostics]
  )
  const selectedRecoveryState =
    selectedSession !== undefined
      ? sessionRecoveryState({
          session: selectedSession,
          diagnostics: runtimeDiagnostics,
          frozen: selectedSessionFrozen,
        })
      : undefined
  const reportsById = useMemo(
    () => new Map(runtimeState.reports.map((report) => [report.id, report])),
    [runtimeState.reports]
  )
  const graphActivity = useMemo(
    () => activityEvents(runtimeState),
    [runtimeState]
  )
  const selectedSessionIsMaster = selectedSession?.role === 'master'
  const canResume =
    Boolean(selectedSession) &&
    selectedSession?.status !== 'running' &&
    selectedSession?.status !== 'pending' &&
    selectedSession?.status !== 'killed' &&
    !selectedSessionFrozen
  const canKill =
    selectedSession?.status === 'running' || selectedSession?.status === 'pending'
  const canActOnPlan = Boolean(isRuntimeAvailable && selectedSession && canResume)

  return {
    runtimeClient,
    runtimeApi,
    isRuntimeAvailable,
    isElectron,
    runtimeHostPlatform,
    runtimeModeLabel,
    runtimeStatusText,
    runtimeUnavailableText,
    runtimeState,
    setRuntimeState,
    runtimeError,
    setRuntimeError,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionProjection,
    selectedNode,
    selectedManagedCluster,
    selectedSessionFrozen,
    selectedSessionIsMaster,
    openRuntimeRequests,
    openUserInputRequests,
    sessions,
    providerInstances,
    runtimeDiagnostics,
    invalidProjectCwds,
    selectedRecoveryState,
    reportsById,
    graphActivity,
    canResume,
    canKill,
    canActOnPlan,
  }
}
