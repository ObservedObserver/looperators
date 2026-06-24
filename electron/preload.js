import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orrery', {
  platform: process.platform,
  runtime: {
    getState: () => ipcRenderer.invoke('orrery:runtime-state'),
    createSession: (input) => ipcRenderer.invoke('orrery:create-session', input),
    resumeSession: (input) => ipcRenderer.invoke('orrery:resume-session', input),
    killSession: (sessionId) =>
      ipcRenderer.invoke('orrery:kill-session', sessionId),
    upsertCluster: (input) => ipcRenderer.invoke('orrery:upsert-cluster', input),
    createMasterForCluster: (input) =>
      ipcRenderer.invoke('orrery:create-master-for-cluster', input),
    assignMasterToCluster: (input) =>
      ipcRenderer.invoke('orrery:assign-master-to-cluster', input),
    setClusterLoopPolicy: (input) =>
      ipcRenderer.invoke('orrery:set-cluster-loop-policy', input),
    onEvent: (listener) => {
      const wrappedListener = (_event, payload) => listener(payload)
      ipcRenderer.on('orrery:runtime-event', wrappedListener)

      return () => {
        ipcRenderer.removeListener('orrery:runtime-event', wrappedListener)
      }
    },
  },
})
