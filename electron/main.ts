import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeSessionManager } from './runtime/sessionManager.js'
import { AppUpdateController } from './appUpdater.js'
import type { AppUpdateState } from '../shared/app-update.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
let runtime: RuntimeSessionManager | undefined
let updates: AppUpdateController | undefined

function broadcastRuntimeEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('orrery:runtime-event', event)
  }
}

function broadcastUpdateState(state: AppUpdateState) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('orrery:update-state-changed', state)
  }
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'looperators',
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
  updates = new AppUpdateController({ broadcast: broadcastUpdateState })
  runtime = new RuntimeSessionManager({
    storageFile:
      process.env.ORRERY_RUNTIME_STORAGE_FILE ??
      path.join(app.getPath('userData'), 'orrery-runtime-state.json'),
    broadcastRuntimeEvent,
  })
  const humanCommand = (kind: string, input: Record<string, any> = {}) =>
    runtime.dispatchCommand({
      kind,
      actor: { kind: 'human' },
      commandId: input?.commandId,
      idempotencyKey: input?.idempotencyKey,
      expectedVersion: input?.expectedVersion,
      reason: input?.reason,
      input,
    })

  ipcMain.handle('orrery:runtime-state', () => runtime.getState())
  ipcMain.handle('orrery:update-state', () => updates.getState())
  ipcMain.handle('orrery:check-for-updates', () =>
    updates.checkForUpdates('manual'),
  )
  ipcMain.handle('orrery:open-update-page', () => updates.openReleasePage())
  ipcMain.handle('orrery:kernel-events', (_event, input) =>
    runtime.getKernelEvents(input),
  )
  ipcMain.handle('orrery:dispatch-command', (_event, command) =>
    runtime.dispatchCommand({ ...command, actor: { kind: 'human' } }),
  )
  ipcMain.handle('orrery:loop-timeline', (_event, input) =>
    runtime.getLoopTimeline(input),
  )
  ipcMain.handle('orrery:stop-loop', (_event, input) => humanCommand('stop_loop', input))
  ipcMain.handle('orrery:create-goal-loop', (_event, input) =>
    humanCommand('create_goal_loop', input),
  )
  ipcMain.handle('orrery:start-review-workflow', (_event, input) =>
    humanCommand('start_review_workflow', input),
  )
  ipcMain.handle('orrery:start-plan-council', (_event, input) =>
    humanCommand('start_plan_council', input),
  )
  ipcMain.handle('orrery:get-plan-council', (_event, input) =>
    runtime.getPlanCouncil(input),
  )
  ipcMain.handle('orrery:get-plan-council-artifact', (_event, input) =>
    runtime.getPlanCouncilArtifact(input),
  )
  ipcMain.handle('orrery:start-plan-council-cross-review', (_event, input) =>
    humanCommand('start_plan_council_cross_review', input),
  )
  ipcMain.handle('orrery:start-plan-council-synthesis', (_event, input) =>
    humanCommand('start_plan_council_synthesis', input),
  )
  ipcMain.handle('orrery:stop-plan-council', (_event, input) =>
    humanCommand('stop_plan_council', input),
  )
  ipcMain.handle('orrery:start-draft-workflow', (_event, input) =>
    humanCommand('start_draft_workflow', input),
  )
  ipcMain.handle('orrery:start-handoff-workflow', (_event, input) =>
    humanCommand('start_handoff_workflow', input),
  )
  ipcMain.handle('orrery:start-goal-workflow', (_event, input) =>
    humanCommand('start_goal_workflow', input),
  )
  ipcMain.handle('orrery:connect-agents', (_event, input) =>
    humanCommand('connect_agents', input),
  )
  ipcMain.handle('orrery:stop-subscription', (_event, input) =>
    humanCommand('stop_subscription', input),
  )
  ipcMain.handle('orrery:register-external-source', (_event, input) =>
    humanCommand('register_external_source', input),
  )
  ipcMain.handle('orrery:remove-external-source', (_event, input) =>
    humanCommand('remove_external_source', input),
  )
  ipcMain.handle('orrery:emit-external-event', (_event, input) =>
    runtime.emitExternalEvent(input),
  )
  ipcMain.handle('orrery:list-templates', () => runtime.listTemplates())
  ipcMain.handle('orrery:apply-template', (_event, input) =>
    humanCommand('apply_template', input),
  )
  ipcMain.handle('orrery:save-template', (_event, input) =>
    humanCommand('save_template', input),
  )
  ipcMain.handle('orrery:remove-template', (_event, input) =>
    humanCommand('remove_template', input),
  )
  ipcMain.handle('orrery:get-project-context', (_event, input) =>
    runtime.getProjectContext(input),
  )
  ipcMain.handle('orrery:get-provider-setup-status', (_event, input) =>
    runtime.getProviderSetupStatus(input),
  )
  ipcMain.handle('orrery:upsert-provider-instance', (_event, input) =>
    humanCommand('upsert_provider_instance', input),
  )
  ipcMain.handle('orrery:choose-project-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose Project',
    })
    return {
      canceled: result.canceled,
      cwd: result.filePaths[0],
    }
  })
  ipcMain.handle('orrery:create-session', (_event, input) =>
    humanCommand('create_session', input),
  )
  ipcMain.handle('orrery:resume-session', (_event, input) =>
    humanCommand('resume_session', input),
  )
  ipcMain.handle('orrery:archive-session', (_event, input) =>
    humanCommand('archive_session', input),
  )
  ipcMain.handle('orrery:kill-session', (_event, sessionId) =>
    humanCommand('kill_session', { sessionId }),
  )
  ipcMain.handle('orrery:respond-runtime-request', (_event, input) =>
    humanCommand('respond_runtime_request', input),
  )
  ipcMain.handle('orrery:answer-user-input', (_event, input) =>
    humanCommand('answer_user_input', input),
  )
  ipcMain.handle('orrery:upsert-cluster', (_event, input) =>
    humanCommand('upsert_scope', input),
  )
  ipcMain.handle('orrery:create-master-for-cluster', (_event, input) =>
    humanCommand('create_master', input),
  )
  ipcMain.handle('orrery:assign-master-to-cluster', (_event, input) =>
    humanCommand('assign_master', input),
  )
  ipcMain.handle('orrery:set-cluster-loop-policy', (_event, input) =>
    humanCommand('set_loop_policy', input),
  )
  ipcMain.handle('orrery:update-node-positions', (_event, input) =>
    humanCommand('update_node_positions', input),
  )
  ipcMain.handle('orrery:start-master-loop', (_event, input) =>
    humanCommand('start_loop', input),
  )
  ipcMain.handle('orrery:stop-master-loop', (_event, input) =>
    humanCommand('stop_loop', input),
  )
  ipcMain.handle('orrery:freeze', (_event, input) => humanCommand('freeze', input))
  ipcMain.handle('orrery:unfreeze', (_event, input) => runtime.unfreeze(input))
  ipcMain.handle('orrery:cleanup-channels', (_event, input) =>
    runtime.cleanupChannels(input),
  )
  ipcMain.handle('orrery:get-working-tree-diff', (_event, input) =>
    runtime.getWorkingTreeDiff(input),
  )
  ipcMain.handle('orrery:get-workspace-files', (_event, input) =>
    runtime.getWorkspaceFiles(input),
  )
  ipcMain.handle('orrery:get-workspace-file-content', (_event, input) =>
    runtime.getWorkspaceFileContent(input),
  )
  ipcMain.handle('orrery:open-workspace', (_event, input) =>
    runtime.openWorkspace(input),
  )
  ipcMain.handle('orrery:create-terminal', (_event, input) =>
    runtime.createTerminal(input),
  )
  ipcMain.handle('orrery:get-terminal', (_event, input) =>
    runtime.getTerminal(input),
  )
  ipcMain.handle('orrery:run-terminal-command', (_event, input) =>
    runtime.runTerminalCommand(input),
  )
  ipcMain.handle('orrery:write-terminal-input', (_event, input) =>
    runtime.writeTerminalInput(input),
  )
  ipcMain.handle('orrery:clear-terminal', (_event, input) =>
    runtime.clearTerminal(input),
  )
  ipcMain.handle('orrery:close-terminal', (_event, input) =>
    runtime.closeTerminal(input),
  )

  createMainWindow()
  updates.configure()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
}).catch((error: unknown) => {
  // Without this handler a startup failure (e.g. the persisted-state version
  // guard) is an unhandled rejection: the process exits with no window and no
  // message. Surface it, then quit.
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('looperators failed to start', message)
  app.quit()
})

app.on('window-all-closed', () => {
  runtime?.killAll()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  updates?.dispose()
})
