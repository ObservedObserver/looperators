import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orrery', {
  platform: process.platform,
  workspace: {
    defaultCwd: process.cwd(),
  },
  runtime: {
    getState: () => ipcRenderer.invoke('orrery:runtime-state'),
    getProjectContext: (input) =>
      ipcRenderer.invoke('orrery:get-project-context', input),
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
    onEvent: (listener) => {
      const wrappedListener = (_event, payload) => listener(payload)
      ipcRenderer.on('orrery:runtime-event', wrappedListener)

      return () => {
        ipcRenderer.removeListener('orrery:runtime-event', wrappedListener)
      }
    },
  },
})
