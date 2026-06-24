import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeSessionManager } from './runtime/sessionManager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
let runtime

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
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  runtime = new RuntimeSessionManager({
    storageFile: path.join(app.getPath('userData'), 'orrery-runtime-state.json'),
  })

  ipcMain.handle('orrery:runtime-state', () => runtime.getState())
  ipcMain.handle('orrery:create-session', (_event, input) =>
    runtime.createSession(input)
  )
  ipcMain.handle('orrery:resume-session', (_event, input) =>
    runtime.resumeSession(input)
  )
  ipcMain.handle('orrery:kill-session', (_event, sessionId) =>
    runtime.killSession(sessionId)
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
