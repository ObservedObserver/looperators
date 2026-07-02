import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from 'react'

import type {
  AgentSession,
  GraphState,
  RuntimeStateDiagnostic,
} from '@/shared/graph-state'
import type { RuntimeApi } from '@/runtime-client'
import { latestReportForSession } from '@/lib/reports'
import { sessionRecoveryState } from '@/lib/diagnostics'
import { sessionMatchesSearch } from '@/lib/session-display'

export function useSessionList({
  runtimeApi,
  runtimeUnavailableText,
  runtimeState,
  setRuntimeState,
  setRuntimeError,
  sessions,
  runtimeDiagnostics,
}: {
  runtimeApi: RuntimeApi | undefined
  runtimeUnavailableText: string
  runtimeState: GraphState
  setRuntimeState: Dispatch<SetStateAction<GraphState>>
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>
  sessions: AgentSession[]
  runtimeDiagnostics: RuntimeStateDiagnostic[]
}) {
  const [sessionSearch, setSessionSearch] = useState('')
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [archivingSessionIds, setArchivingSessionIds] = useState<
    Record<string, boolean>
  >({})

  const runningSessions = sessions.filter(
    (session) => session.status === 'running' || session.status === 'pending'
  )
  const archivedSessionCount = sessions.filter((session) => session.archived).length
  const filteredSessions = sessions.filter((session) => {
    if (session.archived && !showArchivedSessions) {
      return false
    }

    const node = runtimeState.nodes.find(
      (candidate) => candidate.sessionId === session.sessionId
    )
    const managedCluster = Object.values(runtimeState.clusters).find((cluster) =>
      cluster.nodeIds.includes(session.sessionId)
    )
    const latestReport = latestReportForSession(
      runtimeState.reports,
      session.sessionId
    )
    const recovery = sessionRecoveryState({
      session,
      diagnostics: runtimeDiagnostics,
      frozen: node?.frozen === true || managedCluster?.frozen === true,
    })

    return sessionMatchesSearch({
      session,
      latestReport,
      recovery,
      query: sessionSearch,
    })
  })

  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (!runtimeApi) {
        setRuntimeError(runtimeUnavailableText)
        return
      }

      setArchivingSessionIds((current) => ({
        ...current,
        [sessionId]: true,
      }))
      setRuntimeError(undefined)

      try {
        const result = await runtimeApi.archiveSession({
          sessionId,
          archived,
        })
        setRuntimeState(result.state)
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error))
      } finally {
        setArchivingSessionIds((current) => {
          const next = { ...current }
          delete next[sessionId]
          return next
        })
      }
    },
    [runtimeApi, runtimeUnavailableText, setRuntimeError, setRuntimeState]
  )

  return {
    sessionSearch,
    setSessionSearch,
    showArchivedSessions,
    setShowArchivedSessions,
    archivingSessionIds,
    runningSessions,
    archivedSessionCount,
    filteredSessions,
    setSessionArchived,
  }
}

export type SessionListState = ReturnType<typeof useSessionList>
