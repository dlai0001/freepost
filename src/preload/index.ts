import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

function on(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  openCollection: () => ipcRenderer.invoke(IPC.collectionOpen),
  scanCollection: (root: string) => ipcRenderer.invoke(IPC.collectionScan, root),
  onCollectionChanged: (cb: (root: string) => void) =>
    on(IPC.collectionChanged, cb as (...args: unknown[]) => void),

  readRequest: (p: string) => ipcRenderer.invoke(IPC.requestRead, p),
  writeRequest: (p: string, f: unknown) => ipcRenderer.invoke(IPC.requestWrite, p, f),
  createRequest: (p: string, kind: string) => ipcRenderer.invoke(IPC.requestCreate, p, kind),
  renameRequest: (p: string, n: string) => ipcRenderer.invoke(IPC.requestRename, p, n),
  deleteRequest: (p: string) => ipcRenderer.invoke(IPC.requestDelete, p),
  executeRequest: (args: unknown) => ipcRenderer.invoke(IPC.requestExecute, args),

  listEnvs: (root: string) => ipcRenderer.invoke(IPC.envList, root),
  readEnv: (p: string) => ipcRenderer.invoke(IPC.envRead, p),

  getSession: () => ipcRenderer.invoke(IPC.sessionGet),
  setSessionVar: (n: string, v: string) => ipcRenderer.invoke(IPC.sessionSet, n, v),
  clearSession: () => ipcRenderer.invoke(IPC.sessionClear),

  search: (args: unknown) => ipcRenderer.invoke(IPC.searchQuery, args),

  readWorkflow: (p: string) => ipcRenderer.invoke(IPC.workflowRead, p),
  writeWorkflow: (p: string, wf: unknown) => ipcRenderer.invoke(IPC.workflowWrite, p, wf),
  validateWorkflow: (args: unknown) => ipcRenderer.invoke(IPC.workflowValidate, args),
  runWorkflow: (args: unknown) => ipcRenderer.invoke(IPC.workflowRun, args),
  onWorkflowProgress: (cb: (r: unknown) => void) =>
    on(IPC.workflowProgress, cb as (...args: unknown[]) => void),

  wsConnect: (args: unknown) => ipcRenderer.invoke(IPC.wsConnect, args),
  wsSend: (id: string, text: string) => ipcRenderer.invoke(IPC.wsSend, id, text),
  wsClose: (id: string) => ipcRenderer.invoke(IPC.wsClose, id),
  onWsEvent: (cb: (e: unknown) => void) => on(IPC.wsEvent, cb as (...args: unknown[]) => void),

  importPostman: (args: unknown) => ipcRenderer.invoke(IPC.importPostman, args)
}

contextBridge.exposeInMainWorld('freepost', api)
