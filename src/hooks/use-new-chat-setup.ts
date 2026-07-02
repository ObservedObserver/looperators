import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type {
  AgentSession,
  GraphState,
  ProjectContext,
  ProviderSetupStatus,
  WorkMode,
} from '@/shared/graph-state'
import type {
  ProviderInstance,
  ProviderKind,
  ProviderReasoningEffort,
  ProviderRuntimeMode,
} from '@/shared/provider-runtime'
import {
  providerCapability,
  providerRuntimeModeCapability,
} from '@/shared/provider-runtime'
import type { RuntimeApi, RuntimeClient } from '@/runtime-client'
import {
  defaultWorkspaceCwd,
  demoMode,
  latestSessionCwd,
  projectNameFromCwd,
  projectOptionsFromSessions,
  validateProjectCwd,
} from '@/lib/workspace'
import { invalidCwdsFromDiagnostics } from '@/lib/diagnostics'
import { providerInstanceForKind } from '@/lib/provider-catalog'
import { sessionSort } from '@/lib/session-display'

export function useNewChatSetup({
  runtimeApi,
  runtimeClient,
  runtimeUnavailableText,
  setRuntimeState,
  setRuntimeError,
  sessions,
  invalidProjectCwds,
  providerInstances,
  selectedSession,
  showRawEvents,
}: {
  runtimeApi: RuntimeApi | undefined
  runtimeClient: RuntimeClient
  runtimeUnavailableText: string
  setRuntimeState: Dispatch<SetStateAction<GraphState>>
  setRuntimeError: Dispatch<SetStateAction<string | undefined>>
  sessions: AgentSession[]
  invalidProjectCwds: Set<string>
  providerInstances: ProviderInstance[]
  selectedSession: AgentSession | undefined
  showRawEvents: boolean
}) {
  const [newProviderKind, setNewProviderKind] =
    useState<ProviderKind>('claude-code')
  const [newCwd, setNewCwd] = useState(defaultWorkspaceCwd)
  const [newWorkMode, setNewWorkMode] = useState<WorkMode>('local')
  const [newBranch, setNewBranch] = useState('')
  const [newRuntimeMode, setNewRuntimeMode] =
    useState<ProviderRuntimeMode>('approval-required')
  const [newModel, setNewModel] = useState('')
  const [newReasoningEffort, setNewReasoningEffort] =
    useState<ProviderReasoningEffort>('medium')
  const [newProjectContext, setNewProjectContext] = useState<ProjectContext>()
  const [providerSetupStatus, setProviderSetupStatus] =
    useState<ProviderSetupStatus>()
  const [isLoadingProviderSetupStatus, setIsLoadingProviderSetupStatus] =
    useState(false)
  const [savingProviderInstanceId, setSavingProviderInstanceId] = useState<string>()
  const [providerInstanceError, setProviderInstanceError] = useState<string>()
  const projectContextSeqRef = useRef(0)
  const providerSetupSeqRef = useRef(0)

  const newProviderInstance = providerInstanceForKind(
    providerInstances,
    newProviderKind
  )

  const changeNewProviderKind = useCallback((providerKind: ProviderKind) => {
    setNewProviderKind(providerKind)
    setNewModel('')
    const runtimeModes = providerCapability(providerKind).runtimeModes
    setNewRuntimeMode((current) =>
      providerRuntimeModeCapability(providerKind, current)
        ? current
        : runtimeModes[0]?.id ?? 'approval-required'
    )
  }, [])

  const newCwdValidation = useMemo(() => validateProjectCwd(newCwd), [newCwd])
  const newChatProjects = useMemo(
    () =>
      projectOptionsFromSessions(
        sessions,
        newCwd,
        defaultWorkspaceCwd(),
        newProjectContext,
        invalidProjectCwds
      ),
    [invalidProjectCwds, newCwd, newProjectContext, sessions]
  )

  const chooseNewChatProject = useCallback(async () => {
    if (!runtimeApi) {
      setRuntimeError(runtimeUnavailableText)
      return
    }

    try {
      const result = await runtimeApi.chooseProjectFolder()
      if (result.canceled || !result.cwd) {
        return
      }

      setNewCwd(result.cwd)
      setNewWorkMode('local')
      setNewBranch('')
      setRuntimeError(undefined)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error))
    }
  }, [runtimeApi, runtimeUnavailableText, setRuntimeError])

  const saveProviderInstance = useCallback(
    async (providerInstance: ProviderInstance) => {
      if (!runtimeApi) {
        setProviderInstanceError(runtimeUnavailableText)
        return
      }

      setSavingProviderInstanceId(providerInstance.providerInstanceId)
      setProviderInstanceError(undefined)
      try {
        const result = await runtimeApi.upsertProviderInstance(providerInstance)
        setRuntimeState(result.state)
      } catch (error) {
        setProviderInstanceError(error instanceof Error ? error.message : String(error))
      } finally {
        setSavingProviderInstanceId(undefined)
      }
    },
    [runtimeApi, runtimeUnavailableText, setRuntimeState]
  )

  const restoreCwdFallback = useCallback((state: GraphState) => {
    setNewCwd((current) => {
      if (current.trim().length > 0) {
        return current
      }

      const restoredSessions = Object.values(state.sessions).sort(sessionSort)
      return (
        latestSessionCwd(
          restoredSessions,
          invalidCwdsFromDiagnostics(state.diagnostics ?? [])
        ) ?? defaultWorkspaceCwd()
      )
    })
  }, [])

  useEffect(() => {
    if (demoMode || runtimeClient.kind !== 'http') {
      return
    }

    let isMounted = true
    runtimeClient
      .getConfig()
      .then((config) => {
        const defaultCwd = config.workspace?.defaultCwd
        if (!isMounted || !defaultCwd) {
          return
        }

        setNewCwd((current) =>
          current.trim().length > 0 ? current : defaultCwd
        )
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setRuntimeError(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      isMounted = false
    }
  }, [runtimeClient, setRuntimeError])

  useEffect(() => {
    if (!runtimeApi || !newCwdValidation.ok) {
      setNewProjectContext(undefined)
      return
    }

    const requestId = projectContextSeqRef.current + 1
    projectContextSeqRef.current = requestId
    const cwd = newCwd.trim()
    let isMounted = true

    runtimeApi
      .getProjectContext({ cwd })
      .then((context) => {
        if (isMounted && projectContextSeqRef.current === requestId) {
          setNewProjectContext(context)
        }
      })
      .catch((error: unknown) => {
        if (isMounted && projectContextSeqRef.current === requestId) {
          setNewProjectContext({
            cwd,
            projectName: projectNameFromCwd(cwd),
            isGitRepo: false,
            branches: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

    return () => {
      isMounted = false
    }
  }, [newCwd, newCwdValidation.ok, runtimeApi])

  useEffect(() => {
    if (!showRawEvents || selectedSession || !runtimeApi) {
      setProviderSetupStatus(undefined)
      setIsLoadingProviderSetupStatus(false)
      return
    }

    const requestId = providerSetupSeqRef.current + 1
    providerSetupSeqRef.current = requestId
    let isMounted = true
    setIsLoadingProviderSetupStatus(true)

    runtimeApi
      .getProviderSetupStatus({
        providerKind: newProviderKind,
        providerInstanceId: newProviderInstance.providerInstanceId,
        cwd: newCwd.trim() || undefined,
      })
      .then((status) => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setProviderSetupStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setProviderSetupStatus({
            providerKind: newProviderKind,
            providerInstanceId: newProviderInstance.providerInstanceId,
            generatedAt: new Date().toISOString(),
            checks: [
              {
                id: 'setup-status',
                label: 'Setup status',
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          })
        }
      })
      .finally(() => {
        if (isMounted && providerSetupSeqRef.current === requestId) {
          setIsLoadingProviderSetupStatus(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [
    newCwd,
    newProviderInstance.binaryPath,
    newProviderInstance.providerInstanceId,
    newProviderKind,
    runtimeApi,
    selectedSession,
    showRawEvents,
  ])

  useEffect(() => {
    if (
      newWorkMode === 'worktree' &&
      newProjectContext?.cwd === newCwd.trim() &&
      newProjectContext.isGitRepo === false
    ) {
      setNewWorkMode('local')
      setNewBranch('')
    }
  }, [newCwd, newProjectContext, newWorkMode])

  return {
    newProviderKind,
    newCwd,
    setNewCwd,
    newWorkMode,
    setNewWorkMode,
    newBranch,
    setNewBranch,
    newRuntimeMode,
    setNewRuntimeMode,
    newModel,
    setNewModel,
    newReasoningEffort,
    setNewReasoningEffort,
    newProjectContext,
    providerSetupStatus,
    isLoadingProviderSetupStatus,
    savingProviderInstanceId,
    providerInstanceError,
    newProviderInstance,
    changeNewProviderKind,
    newCwdValidation,
    newChatProjects,
    chooseNewChatProject,
    saveProviderInstance,
    restoreCwdFallback,
  }
}

export type NewChatSetupState = ReturnType<typeof useNewChatSetup>
