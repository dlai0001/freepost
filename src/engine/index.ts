/**
 * Public surface of the request engine — the ONLY module in the codebase
 * allowed to use network APIs (PLAN.md "Network policy").
 */

export { sendHttp } from './http'
export type { SendHttpRequest, SendHttpOptions } from './http'
export { CookieJar } from './cookies'
export type { StoredCookie } from './cookies'
export { WsClient } from './ws'
export type { WsState, WsConnectArgs, WsClientEvents } from './ws'
