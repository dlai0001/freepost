/**
 * The recorded-traffic store: <root>/.freepost/history/recorded.jsonl.
 *
 * Electron-free on purpose. Both the app's proxy lifecycle (record-proxy.ts,
 * which does import Electron) and the headless `freepost proxy` CLI append
 * here, and the CLI bundle must never drag Electron in — so the store, its
 * path helper and the default ports live in this module rather than beside the
 * lifecycle. Same precedent as execute.ts, which the GUI and the CLI share.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RecordedExchange } from '../shared/model'
import { ensureFreepostDir } from './collection'

export const DEFAULT_PROXY_PORT = 7699
export const DEFAULT_PROXY_HTTPS_PORT = 7700
/** The MQTT relay's own listener — 1883 (the broker default) shifted clear. */
export const DEFAULT_PROXY_MQTT_PORT = 7883

const RECORDED_CAP = 500

/**
 * The collection's recorded.jsonl. Single source of truth for the path — the
 * proxy appends here and the History ▸ Recorded handlers read/clear the same
 * file, so it must not be spelled out twice.
 */
export function recordedFilePath(root: string): string {
  return join(root, '.freepost', 'history', 'recorded.jsonl')
}

/**
 * Line counts per recorded.jsonl path, so a busy proxy doesn't re-read the
 * whole file on every append. Initialized by counting once on the first
 * append; a stale count (e.g. after History ▸ Clear) only trims early, and
 * the trim resets it from what's really on disk.
 */
const recordedCounts = new Map<string, number>()

/**
 * Append one exchange to <root>/.freepost/history/recorded.jsonl (the shape of
 * appendHistory in execute.ts: append, chmod 600, cap).
 */
export function appendRecorded(root: string, entry: RecordedExchange): void {
  try {
    ensureFreepostDir(root)
    const file = recordedFilePath(root)
    let count =
      recordedCounts.get(file) ??
      (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0)
    appendFileSync(file, JSON.stringify(entry) + '\n')
    count++
    // Recorded traffic carries full headers (incl. auth) — owner-only.
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best-effort; no-op on Windows */
    }
    // Only read + trim once the counter says the cap is exceeded.
    if (count > RECORDED_CAP * 2) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-RECORDED_CAP)
      writeFileSync(file, lines.join('\n') + '\n')
      count = lines.length
    }
    recordedCounts.set(file, count)
  } catch {
    // Recording persistence is best-effort; never break the proxied request.
  }
}
