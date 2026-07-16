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
export type { CookieRecord } from './cookies'
export { WsClient } from './ws'
export type { WsState, WsConnectArgs, WsClientEvents } from './ws'
export { subscribeGraphql } from './gql-subscribe'
export type { GqlTransport, GqlSubscribeArgs, GqlSubscribeHandlers } from './gql-subscribe'
export { shouldBypassProxy } from './proxy'
export { MockServer } from './mock-server'
export type { MockState, MockStartArgs, MockServerEvents } from './mock-server'
export { startMcpHttpServer } from './mcp-http'
export type { McpHttpServerHandle, McpHttpStartArgs } from './mcp-http'
export { sendGrpcUnary, GrpcStreamClient } from './grpc'
export type { GrpcCallArgs, GrpcResponse, GrpcStreamState, GrpcStreamEvents } from './grpc'
export { publishMqtt, MqttSubscribeClient, mqttConnectArgs } from './mqtt'
export type {
  MqttPublishArgs,
  MqttPublishResult,
  MqttSubscribeArgs,
  MqttSubState,
  MqttSubEvents,
  MqttMessage
} from './mqtt'
export { callMcp, McpSessionClient, mcpConnectArgs, coerceToolArgs } from './mcp'
export type {
  McpCallArgs,
  McpConnectArgs,
  McpResponse,
  McpIntrospection,
  McpSessionState,
  McpSessionEvents,
  McpSamplingResponder,
  McpElicitationResponder
} from './mcp'
