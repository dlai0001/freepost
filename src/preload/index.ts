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
  lastCollection: () => ipcRenderer.invoke(IPC.collectionLast),
  checkCollectionSecurity: (root: string) =>
    ipcRenderer.invoke(IPC.collectionSecurityCheck, root),

  readRequest: (p: string) => ipcRenderer.invoke(IPC.requestRead, p),
  writeRequest: (p: string, f: unknown) => ipcRenderer.invoke(IPC.requestWrite, p, f),
  formatRequest: (f: unknown) => ipcRenderer.invoke(IPC.requestFormat, f),
  parseCommand: (args: unknown) => ipcRenderer.invoke(IPC.commandParse, args),
  createRequest: (p: string, kind: string) => ipcRenderer.invoke(IPC.requestCreate, p, kind),
  renameRequest: (p: string, n: string) => ipcRenderer.invoke(IPC.requestRename, p, n),
  deleteRequest: (p: string) => ipcRenderer.invoke(IPC.requestDelete, p),
  executeRequest: (args: unknown) => ipcRenderer.invoke(IPC.requestExecute, args),

  listEnvs: (root: string) => ipcRenderer.invoke(IPC.envList, root),
  readEnv: (p: string) => ipcRenderer.invoke(IPC.envRead, p),
  createEnv: (args: unknown) => ipcRenderer.invoke(IPC.envCreate, args),
  writeEnv: (args: unknown) => ipcRenderer.invoke(IPC.envWrite, args),
  deleteEnv: (args: unknown) => ipcRenderer.invoke(IPC.envDelete, args),
  renameEnv: (args: unknown) => ipcRenderer.invoke(IPC.envRename, args),
  duplicateEnv: (args: unknown) => ipcRenderer.invoke(IPC.envDuplicate, args),

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

  importPostman: (args: unknown) => ipcRenderer.invoke(IPC.importPostman, args),
  browseImportFile: () => ipcRenderer.invoke(IPC.importBrowse),
  browseFile: (args?: unknown) => ipcRenderer.invoke(IPC.fileBrowse, args),
  importFile: (args: unknown) => ipcRenderer.invoke(IPC.importFile, args),
  importCommand: (args: unknown) => ipcRenderer.invoke(IPC.importCommand, args),
  importOpenApi: (args: unknown) => ipcRenderer.invoke(IPC.importOpenApi, args),
  listOpenApiFromUrl: (args: unknown) => ipcRenderer.invoke(IPC.importOpenApiListUrl, args),
  importOpenApiFromUrl: (args: unknown) => ipcRenderer.invoke(IPC.importOpenApiApplyUrl, args),

  codegenTargets: () => ipcRenderer.invoke(IPC.codegenTargets),
  generateCode: (args: unknown) => ipcRenderer.invoke(IPC.codegenGenerate, args),

  listHistory: (root: string) => ipcRenderer.invoke(IPC.historyList, root),
  clearHistory: (root: string) => ipcRenderer.invoke(IPC.historyClear, root),

  saveExample: (args: unknown) => ipcRenderer.invoke(IPC.exampleSave, args),
  listExamples: (args: unknown) => ipcRenderer.invoke(IPC.exampleList, args),
  deleteExample: (args: unknown) => ipcRenderer.invoke(IPC.exampleDelete, args),
  setActiveExample: (args: unknown) => ipcRenderer.invoke(IPC.exampleSetActive, args),

  startMock: (args: unknown) => ipcRenderer.invoke(IPC.mockStart, args),
  stopMock: (args: unknown) => ipcRenderer.invoke(IPC.mockStop, args),
  mockStatus: (args: unknown) => ipcRenderer.invoke(IPC.mockStatus, args),
  onMockLog: (cb: (e: unknown) => void) => on(IPC.mockLog, cb as (...args: unknown[]) => void),

  acquireOAuthToken: (args: unknown) => ipcRenderer.invoke(IPC.oauthAcquire, args),
  authorizeOAuthStart: (args: unknown) => ipcRenderer.invoke(IPC.oauthAuthorizeStart, args),
  authorizeOAuthCancel: (id: string) => ipcRenderer.invoke(IPC.oauthAuthorizeCancel, id),
  onOAuthAuthorizeEvent: (cb: (e: unknown) => void) =>
    on(IPC.oauthAuthorizeEvent, cb as (...args: unknown[]) => void),
  introspectGraphql: (args: unknown) => ipcRenderer.invoke(IPC.gqlIntrospect, args),
  subscribeGraphql: (args: unknown) => ipcRenderer.invoke(IPC.gqlSubscribe, args),
  unsubscribeGraphql: (id: string) => ipcRenderer.invoke(IPC.gqlUnsubscribe, id),
  onGqlSubEvent: (cb: (e: unknown) => void) =>
    on(IPC.gqlSubEvent, cb as (...args: unknown[]) => void),
  startGrpcStream: (args: unknown) => ipcRenderer.invoke(IPC.grpcStreamStart, args),
  cancelGrpcStream: (id: string) => ipcRenderer.invoke(IPC.grpcStreamCancel, id),
  onGrpcStreamEvent: (cb: (e: unknown) => void) =>
    on(IPC.grpcStreamEvent, cb as (...args: unknown[]) => void),
  browseDataFile: () => ipcRenderer.invoke(IPC.browseDataFile),

  onAppBeforeClose: (cb: () => void) => on(IPC.appBeforeClose, cb as (...args: unknown[]) => void),
  confirmAppClose: () => ipcRenderer.invoke(IPC.appCloseConfirmed)
}

contextBridge.exposeInMainWorld('freepost', api)
