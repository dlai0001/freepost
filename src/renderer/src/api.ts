/**
 * Access to the preload-exposed IPC surface. The renderer NEVER opens sockets
 * itself (zero-network guarantee) — everything goes through window.freepost.
 */
import type { FreepostApi } from '../../shared/ipc'

/** True when running inside Electron with the preload bridge present. */
export function hasApi(): boolean {
  return typeof window !== 'undefined' && typeof window.freepost !== 'undefined'
}

/** The bridge. Only call after hasApi() has been checked at the app root. */
export function fp(): FreepostApi {
  return window.freepost
}

/** Normalize an unknown thrown value into a displayable message. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
