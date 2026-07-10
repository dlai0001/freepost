/**
 * Public surface of the request engine — the ONLY module in the codebase
 * allowed to use network APIs (PLAN.md "Network policy").
 */

export { sendHttp, loadPem } from './http'
export type { SendHttpRequest, SendHttpOptions } from './http'
export {
  acquireToken,
  refreshToken,
  startAuthorizationCodeFlow,
  generatePkce,
  buildAuthorizeUrl
} from './oauth'
export type { AuthorizeFlowArgs, AuthorizeResult } from './oauth'
export { CookieJar } from './cookies'
export type { StoredCookie } from './cookies'
export { WsClient } from './ws'
export type { WsState, WsConnectArgs, WsClientEvents } from './ws'
export { subscribeGraphql } from './gql-subscribe'
export type { GqlTransport, GqlSubscribeArgs, GqlSubscribeHandlers } from './gql-subscribe'
export { shouldBypassProxy } from './proxy'
