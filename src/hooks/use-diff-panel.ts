import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentSession,
  WorkingTreeDiffResult,
} from '@/shared/graph-state'
import type { RuntimeApi } from '@/runtime-client'

export function useDiffPanel({
  runtimeApi,
  runtimeUnavailableText,
  isRuntimeAvailable,
  selectedSession,
  selectedSessionId,
}: {
  runtimeApi: RuntimeApi | undefined
  runtimeUnavailableText: string
  isRuntimeAvailable: boolean
  selectedSession: AgentSession | undefined
  selectedSessionId: string | null | undefined
}) {
  const [isDiffPanelOpen, setIsDiffPanelOpen] = useState(false)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)
  const [workingTreeDiff, setWorkingTreeDiff] =
    useState<WorkingTreeDiffResult>()
  const [diffTurnId, setDiffTurnId] = useState<string>()
  const [diffPanelError, setDiffPanelError] = useState<string>()
  const diffRequestSeqRef = useRef(0)

  const selectedWorkingTreeDiff =
    workingTreeDiff?.sessionId === selectedSessionId ? workingTreeDiff : undefined
  const canOpenDiffPanel = Boolean(isRuntimeAvailable && selectedSession)

  useEffect(() => {
    setDiffTurnId(undefined)
    setWorkingTreeDiff(undefined)
    setDiffPanelError(undefined)
  }, [selectedSessionId])

  const loadSelectedWorkingTreeDiff = useCallback(
    async (requestedTurnId = diffTurnId) => {
      if (!selectedSessionId) {
        diffRequestSeqRef.current += 1
        setWorkingTreeDiff(undefined)
        setDiffPanelError(undefined)
        setIsLoadingDiff(false)
        return
      }

      if (!runtimeApi) {
        diffRequestSeqRef.current += 1
        setWorkingTreeDiff(undefined)
        setIsLoadingDiff(false)
        setDiffPanelError(runtimeUnavailableText)
        return
      }

      const requestSeq = diffRequestSeqRef.current + 1
      diffRequestSeqRef.current = requestSeq
      const requestedSessionId = selectedSessionId
      setWorkingTreeDiff((current) =>
        current?.sessionId === requestedSessionId ? current : undefined
      )
      setIsLoadingDiff(true)
      setDiffPanelError(undefined)

      try {
        const result = await runtimeApi.getWorkingTreeDiff({
          sessionId: requestedSessionId,
          ...(requestedTurnId ? { turnId: requestedTurnId } : {}),
        })
        if (
          diffRequestSeqRef.current !== requestSeq ||
          result.sessionId !== requestedSessionId
        ) {
          return
        }
        setWorkingTreeDiff(result)
      } catch (error) {
        if (diffRequestSeqRef.current !== requestSeq) {
          return
        }
        setDiffPanelError(error instanceof Error ? error.message : String(error))
      } finally {
        if (diffRequestSeqRef.current === requestSeq) {
          setIsLoadingDiff(false)
        }
      }
    },
    [diffTurnId, runtimeApi, runtimeUnavailableText, selectedSessionId]
  )

  useEffect(() => {
    if (!isDiffPanelOpen) {
      return
    }

    void loadSelectedWorkingTreeDiff(diffTurnId)
  }, [diffTurnId, isDiffPanelOpen, loadSelectedWorkingTreeDiff])

  const openWorkingTreeDiff = useCallback(() => {
    setDiffTurnId(undefined)
    if (isDiffPanelOpen) {
      void loadSelectedWorkingTreeDiff(undefined)
      return
    }
    setIsDiffPanelOpen(true)
  }, [isDiffPanelOpen, loadSelectedWorkingTreeDiff])

  const openTurnDiff = useCallback(
    (turnId: string) => {
      setDiffTurnId(turnId)
      if (isDiffPanelOpen) {
        void loadSelectedWorkingTreeDiff(turnId)
        return
      }
      setIsDiffPanelOpen(true)
    },
    [isDiffPanelOpen, loadSelectedWorkingTreeDiff]
  )

  return {
    isDiffPanelOpen,
    setIsDiffPanelOpen,
    isLoadingDiff,
    workingTreeDiff,
    selectedWorkingTreeDiff,
    diffTurnId,
    diffPanelError,
    canOpenDiffPanel,
    loadSelectedWorkingTreeDiff,
    openWorkingTreeDiff,
    openTurnDiff,
  }
}
