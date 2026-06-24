import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orrery', {
  platform: process.platform,
  runtime: {
    getState: () => ipcRenderer.invoke('orrery:runtime-state'),
    createSession: (input) => ipcRenderer.invoke('orrery:create-session', input),
    resumeSession: (input) => ipcRenderer.invoke('orrery:resume-session', input),
    killSession: (sessionId) =>
      ipcRenderer.invoke('orrery:kill-session', sessionId),
    onEvent: (listener) => {
      const wrappedListener = (_event, payload) => listener(payload)
      ipcRenderer.on('orrery:runtime-event', wrappedListener)

      return () => {
        ipcRenderer.removeListener('orrery:runtime-event', wrappedListener)
      }
    },
  },
})
