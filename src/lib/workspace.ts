import {
  type AgentSession,
  type ProjectContext,
} from '@/shared/graph-state'
import {
  getActiveRuntimeClient,
} from '@/runtime-client'
import {
  compactPath,
} from '@/lib/format'

export type ProjectCwdValidation = {
  ok: boolean
  message: string
}

export type NewChatProjectOption = {
  id: string
  name: string
  cwd: string
  isGitRepo?: boolean
  currentBranch?: string
  branches: string[]
  error?: string
}

export const chooseProjectOptionValue = '__orrery_choose_project__'

export function isDemoModeRequested() {
  if (typeof window === 'undefined') {
    return false
  }

  const value = new URLSearchParams(window.location.search).get('demo')
  return value === '1' || value === 'true'
}

export function defaultWorkspaceCwd() {
  if (isDemoModeRequested()) {
    return ''
  }

  return getActiveRuntimeClient().workspace.defaultCwd ?? ''
}

export function latestSessionCwd(
  sessions: AgentSession[],
  invalidCwds = new Set<string>()
) {
  const latestSession =
    sessions.find((session) => {
      const cwd = session.project?.cwd ?? session.cwd
      return !session.archived && !invalidCwds.has(cwd)
    }) ??
    sessions.find((session) => {
      const cwd = session.project?.cwd ?? session.cwd
      return !invalidCwds.has(cwd)
    })
  return latestSession?.project?.cwd ?? latestSession?.cwd
}

export function projectNameFromCwd(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) {
    return 'Project'
  }

  const parts = trimmed.split('/').filter(Boolean)
  const name = parts[parts.length - 1]
  if (!name || name === '~') {
    return compactPath(trimmed)
  }

  return name
}

export function uniqueStrings(values: (string | undefined)[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  )
}

export function branchCandidatesForSession(session: AgentSession) {
  const project = session.project
  if (!project) {
    return []
  }

  return uniqueStrings([
    project.baseBranch,
    project.workMode === 'local' ? project.branch : undefined,
  ])
}

export function projectOptionsFromSessions(
  sessions: AgentSession[],
  selectedCwd: string,
  fallbackCwd: string,
  projectContext?: ProjectContext,
  invalidCwds = new Set<string>()
): NewChatProjectOption[] {
  const projects = new Map<string, NewChatProjectOption>()

  function addProject({
    cwd,
    name,
    isGitRepo,
    currentBranch,
    branches = [],
    error,
  }: {
    cwd?: string
    name?: string
    isGitRepo?: boolean
    currentBranch?: string
    branches?: string[]
    error?: string
  }) {
    const normalizedCwd = cwd?.trim()
    if (!normalizedCwd) {
      return
    }

    const existing = projects.get(normalizedCwd)
    if (existing) {
      existing.branches = uniqueStrings([...existing.branches, ...branches])
      existing.isGitRepo = existing.isGitRepo ?? isGitRepo
      existing.currentBranch = existing.currentBranch ?? currentBranch
      existing.error = existing.error ?? error
      return
    }

    projects.set(normalizedCwd, {
      id: normalizedCwd,
      name: name?.trim() || projectNameFromCwd(normalizedCwd),
      cwd: normalizedCwd,
      isGitRepo,
      currentBranch,
      branches: uniqueStrings(branches),
      error,
    })
  }

  addProject({ cwd: selectedCwd })
  addProject({ cwd: fallbackCwd })
  addProject({
    cwd: projectContext?.cwd,
    name: projectContext?.projectName,
    isGitRepo: projectContext?.isGitRepo,
    currentBranch: projectContext?.currentBranch,
    branches: uniqueStrings([
      projectContext?.currentBranch,
      ...(projectContext?.branches ?? []),
    ]),
    error: projectContext?.error,
  })

  sessions.forEach((session) => {
    const sessionProjectCwd = session.project?.cwd ?? session.cwd
    if (invalidCwds.has(sessionProjectCwd)) {
      return
    }

    addProject({
      cwd: sessionProjectCwd,
      name: session.project?.name,
      isGitRepo: session.project?.repoRoot ? true : undefined,
      currentBranch:
        session.project?.workMode === 'local' ? session.project.branch : undefined,
      branches: branchCandidatesForSession(session),
    })
  })

  return Array.from(projects.values())
}

export function validateProjectCwd(value: string): ProjectCwdValidation {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      message: 'Choose a project folder before starting.',
    }
  }

  if (trimmed !== '~' && !trimmed.startsWith('/') && !trimmed.startsWith('~/')) {
    return {
      ok: false,
      message: 'Use an absolute path or ~/path.',
    }
  }

  return {
    ok: true,
    message: `Selected cwd: ${compactPath(trimmed)}`,
  }
}

export const demoMode = isDemoModeRequested()
