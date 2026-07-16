/**
 * The application menu.
 *
 * Freepost ran on Electron's default menu until the MCP server needed somewhere
 * to live. Building a template means we now own the standard roles too, so the
 * platform basics (Edit's copy/paste, which the renderer's inputs depend on;
 * the macOS app menu; window management) are spelled out here rather than
 * inherited.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '../shared/ipc'
import {
  copyMcpConfigSnippet,
  isMcpServerRunning,
  mcpServerUrl,
  setMcpServerChangeListener,
  toggleAppMcpServer
} from './mcp-server/app-toggle'
import { isProxyRunning, proxyTarget, proxyUrl, setProxyChangeListener } from './record-proxy'

const isMac = process.platform === 'darwin'
const DOCS_URL = 'https://dlai0001.github.io/freepost/'

/**
 * The proxy checkbox opens the modal rather than toggling directly: starting
 * needs a target URL, and stopping deserves a look at what was recorded. The
 * menu redraw right after snaps the checkbox back to the real running state.
 */
function openProxyUi(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.proxyOpenUi)
  refreshApplicationMenu()
}

function toolsMenu(): MenuItemConstructorOptions {
  const running = isMcpServerRunning()
  const url = mcpServerUrl()
  const proxyOn = isProxyRunning()
  return {
    label: 'Tools',
    submenu: [
      {
        id: 'mcp-server-toggle',
        label: 'MCP Server',
        type: 'checkbox',
        checked: running,
        click: () => void toggleAppMcpServer()
      },
      {
        // Not a control — it's where the user reads the URL to paste into their
        // AI app, so it has to be visible without opening a settings pane.
        label: running && url !== null ? `Listening on ${url}` : 'Not running',
        enabled: false
      },
      {
        label: 'Copy AI app config snippet',
        enabled: running,
        click: () => copyMcpConfigSnippet()
      },
      { type: 'separator' },
      {
        id: 'proxy-server-toggle',
        label: 'Proxy Server (Record)',
        type: 'checkbox',
        checked: proxyOn,
        click: () => openProxyUi()
      },
      {
        label: proxyOn ? `Recording → ${proxyTarget()} on ${proxyUrl()}` : 'Not recording',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'About the MCP server…',
        click: () => void shell.openExternal(`${DOCS_URL}help/ai-apps.html`)
      }
    ]
  }
}

function template(): MenuItemConstructorOptions[] {
  const macApp: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      ]
    : []

  return [
    ...macApp,
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      // The renderer is a normal web page: without these roles, copy and paste
      // stop working in every editor in the app.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])
          : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    toolsMenu(),
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Freepost Documentation',
          // Zero-network guarantee: docs open in the OS browser, never in-app.
          click: () => void shell.openExternal(DOCS_URL)
        }
      ]
    }
  ]
}

/** Rebuild and install the menu. Cheap; called whenever the toggle's state changes. */
export function refreshApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()))
}

export function installApplicationMenu(): void {
  // The toggles' labels and status lines are derived state — rebuild on change
  // rather than trying to mutate menu items in place.
  setMcpServerChangeListener(refreshApplicationMenu)
  setProxyChangeListener(refreshApplicationMenu)
  refreshApplicationMenu()
}
