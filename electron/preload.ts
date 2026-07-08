import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orrery', {
  platform: process.platform,
  workspace: {
    defaultCwd: process.cwd(),
  },
  runtime: {
    getState: () => ipcRenderer.invoke('orrery:runtime-state'),
    getKernelEvents: (input) =>
      ipcRenderer.invoke('orrery:kernel-events', input),
    getLoopTimeline: (input) =>
      ipcRenderer.invoke('orrery:loop-timeline', input),
    createGoalLoop: (input) =>
      ipcRenderer.invoke('orrery:create-goal-loop', input),
    getProjectContext: (input) =>
      ipcRenderer.invoke('orrery:get-project-context', input),
    getProviderSetupStatus: (input) =>
      ipcRenderer.invoke('orrery:get-provider-setup-status', input),
    upsertProviderInstance: (input) =>
      ipcRenderer.invoke('orrery:upsert-provider-instance', input),
    chooseProjectFolder: () => ipcRenderer.invoke('orrery:choose-project-folder'),
    createSession: (input) => ipcRenderer.invoke('orrery:create-session', input),
    resumeSession: (input) => ipcRenderer.invoke('orrery:resume-session', input),
    archiveSession: (input) =>
      ipcRenderer.invoke('orrery:archive-session', input),
    killSession: (sessionId) =>
      ipcRenderer.invoke('orrery:kill-session', sessionId),
    respondRuntimeRequest: (input) =>
      ipcRenderer.invoke('orrery:respond-runtime-request', input),
    answerUserInput: (input) =>
      ipcRenderer.invoke('orrery:answer-user-input', input),
    upsertCluster: (input) => ipcRenderer.invoke('orrery:upsert-cluster', input),
    createMasterForCluster: (input) =>
      ipcRenderer.invoke('orrery:create-master-for-cluster', input),
    assignMasterToCluster: (input) =>
      ipcRenderer.invoke('orrery:assign-master-to-cluster', input),
    setClusterLoopPolicy: (input) =>
      ipcRenderer.invoke('orrery:set-cluster-loop-policy', input),
    updateNodePositions: (input) =>
      ipcRenderer.invoke('orrery:update-node-positions', input),
    startMasterLoop: (input) =>
      ipcRenderer.invoke('orrery:start-master-loop', input),
    stopMasterLoop: (input) =>
      ipcRenderer.invoke('orrery:stop-master-loop', input),
    freeze: (input) => ipcRenderer.invoke('orrery:freeze', input),
    getWorkingTreeDiff: (input) =>
      ipcRenderer.invoke('orrery:get-working-tree-diff', input),
    getWorkspaceFiles: (input) =>
      ipcRenderer.invoke('orrery:get-workspace-files', input),
    getWorkspaceFileContent: (input) =>
      ipcRenderer.invoke('orrery:get-workspace-file-content', input),
    openWorkspace: (input) =>
      ipcRenderer.invoke('orrery:open-workspace', input),
    createTerminal: (input) =>
      ipcRenderer.invoke('orrery:create-terminal', input),
    getTerminal: (input) =>
      ipcRenderer.invoke('orrery:get-terminal', input),
    runTerminalCommand: (input) =>
      ipcRenderer.invoke('orrery:run-terminal-command', input),
    writeTerminalInput: (input) =>
      ipcRenderer.invoke('orrery:write-terminal-input', input),
    clearTerminal: (input) =>
      ipcRenderer.invoke('orrery:clear-terminal', input),
    closeTerminal: (input) =>
      ipcRenderer.invoke('orrery:close-terminal', input),
    onEvent: (listener) => {
      const wrappedListener = (_event, payload) => listener(payload)
      ipcRenderer.on('orrery:runtime-event', wrappedListener)

      return () => {
        ipcRenderer.removeListener('orrery:runtime-event', wrappedListener)
      }
    },
  },
})
