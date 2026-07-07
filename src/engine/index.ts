/**
 * Public surface of the request engine — the ONLY module in the codebase
 * allowed to use network APIs (PLAN.md "Network policy").
 */

export { sendHttp, loadPem } from './http'
export type { SendHttpRequest, SendHttpOptions } from './http'
export { acquireToken } from './oauth'
export { CookieJar } from './cookies'
export type { StoredCookie } from './cookies'
export { WsClient } from './ws'
export type { WsState, WsConnectArgs, WsClientEvents } from './ws'
export { shouldBypassProxy } from './proxy'
