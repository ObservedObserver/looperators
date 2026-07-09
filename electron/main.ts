import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeSessionManager } from './runtime/sessionManager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
let runtime: RuntimeSessionManager | undefined

function broadcastRuntimeEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('orrery:runtime-event', event)
  }
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'Orrery',
    backgroundColor: '#111111',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist/index.html'))
  }
}

app.whenReady().then(() => {
  runtime = new RuntimeSessionManager({
    storageFile:
      process.env.ORRERY_RUNTIME_STORAGE_FILE ??
      path.join(app.getPath('userData'), 'orrery-runtime-state.json'),
    broadcastRuntimeEvent,
  })

  ipcMain.handle('orrery:runtime-state', () => runtime.getState())
  ipcMain.handle('orrery:kernel-events', (_event, input) =>
    runtime.getKernelEvents(input)
  )
  ipcMain.handle('orrery:loop-timeline', (_event, input) =>
    runtime.getLoopTimeline(input)
  )
  ipcMain.handle('orrery:create-goal-loop', (_event, input) =>
    runtime.createGoalLoop(input)
  )
  ipcMain.handle('orrery:register-external-source', (_event, input) =>
    runtime.registerExternalSource(input)
  )
  ipcMain.handle('orrery:remove-external-source', (_event, input) =>
    runtime.removeExternalSource(input)
  )
  ipcMain.handle('orrery:emit-external-event', (_event, input) =>
    runtime.emitExternalEvent(input)
  )
  ipcMain.handle('orrery:get-project-context', (_event, input) =>
    runtime.getProjectContext(input)
  )
  ipcMain.handle('orrery:get-provider-setup-status', (_event, input) =>
    runtime.getProviderSetupStatus(input)
  )
  ipcMain.handle('orrery:upsert-provider-instance', (_event, input) =>
    runtime.upsertProviderInstance(input)
  )
  ipcMain.handle('orrery:choose-project-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose Project',
    })
    return { canceled: result.canceled, cwd: result.filePaths[0] }
  })
  ipcMain.handle('orrery:create-session', (_event, input) =>
    runtime.createSession(input)
  )
  ipcMain.handle('orrery:resume-session', (_event, input) =>
    runtime.resumeSession(input)
  )
  ipcMain.handle('orrery:archive-session', (_event, input) =>
    runtime.archiveSession(input)
  )
  ipcMain.handle('orrery:kill-session', (_event, sessionId) =>
    runtime.killSession(sessionId)
  )
  ipcMain.handle('orrery:respond-runtime-request', (_event, input) =>
    runtime.respondRuntimeRequest(input)
  )
  ipcMain.handle('orrery:answer-user-input', (_event, input) =>
    runtime.answerUserInput(input)
  )
  ipcMain.handle('orrery:upsert-cluster', (_event, input) =>
    runtime.upsertCluster(input)
  )
  ipcMain.handle('orrery:create-master-for-cluster', (_event, input) =>
    runtime.createMasterForCluster(input)
  )
  ipcMain.handle('orrery:assign-master-to-cluster', (_event, input) =>
    runtime.assignMasterToCluster(input)
  )
  ipcMain.handle('orrery:set-cluster-loop-policy', (_event, input) =>
    runtime.setClusterLoopPolicy(input)
  )
  ipcMain.handle('orrery:update-node-positions', (_event, input) =>
    runtime.updateNodePositions(input)
  )
  ipcMain.handle('orrery:start-master-loop', (_event, input) =>
    runtime.startMasterLoop(input)
  )
  ipcMain.handle('orrery:stop-master-loop', (_event, input) =>
    runtime.stopMasterLoop(input)
  )
  ipcMain.handle('orrery:freeze', (_event, input) => runtime.freeze(input))
  ipcMain.handle('orrery:get-working-tree-diff', (_event, input) =>
    runtime.getWorkingTreeDiff(input)
  )
  ipcMain.handle('orrery:get-workspace-files', (_event, input) =>
    runtime.getWorkspaceFiles(input)
  )
  ipcMain.handle('orrery:get-workspace-file-content', (_event, input) =>
    runtime.getWorkspaceFileContent(input)
  )
  ipcMain.handle('orrery:open-workspace', (_event, input) =>
    runtime.openWorkspace(input)
  )
  ipcMain.handle('orrery:create-terminal', (_event, input) =>
    runtime.createTerminal(input)
  )
  ipcMain.handle('orrery:get-terminal', (_event, input) =>
    runtime.getTerminal(input)
  )
  ipcMain.handle('orrery:run-terminal-command', (_event, input) =>
    runtime.runTerminalCommand(input)
  )
  ipcMain.handle('orrery:write-terminal-input', (_event, input) =>
    runtime.writeTerminalInput(input)
  )
  ipcMain.handle('orrery:clear-terminal', (_event, input) =>
    runtime.clearTerminal(input)
  )
  ipcMain.handle('orrery:close-terminal', (_event, input) =>
    runtime.closeTerminal(input)
  )

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  runtime?.killAll()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
