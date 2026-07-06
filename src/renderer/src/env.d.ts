/// <reference types="vite/client" />
import type { FreepostApi } from '../../shared/ipc'

declare global {
  interface Window {
    freepost: FreepostApi
  }
}

export {}
