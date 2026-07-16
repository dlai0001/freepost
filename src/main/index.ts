import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { registerIpcHandlers } from './ipc-handlers'
import { installApplicationMenu } from './menu'
import { stopAppMcpServer } from './mcp-server/app-toggle'
import { stopAppProxy } from './record-proxy'

function createWindow(): void {
  // Once the renderer has dealt with unsaved changes it confirms; we then let
  // the window close without re-prompting.
  let closeConfirmed = false

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Freepost',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Zero-network guarantee: external links open in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Hand window-close back to the renderer so it can prompt to save unsaved
  // tabs. The renderer replies via IPC.appCloseConfirmed once it's safe to quit.
  win.on('close', (e) => {
    if (closeConfirmed) return
    e.preventDefault()
    win.webContents.send(IPC.appBeforeClose)
  })
  ipcMain.handle(IPC.appCloseConfirmed, (e) => {
    if (e.sender !== win.webContents) return
    closeConfirmed = true
    win.close()
  })

  win.on('closed', () => {
    ipcMain.removeHandler(IPC.appCloseConfirmed)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  installApplicationMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Never leave the MCP or proxy listeners behind: they are bound to the app's
// lifetime, and a stray port that still answers after the window is gone would
// be a surprise.
app.on('will-quit', () => {
  void stopAppMcpServer()
  void stopAppProxy()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
