/**
 * The collection the app currently has open.
 *
 * `ipc-handlers` tracks a watcher per root, but the MCP server toggle needs a
 * single answer to "which collection would the AI be editing right now?" — and
 * needs to know when that answer changes, so a server bound to the old root can
 * be stopped rather than quietly serving a collection the user has navigated
 * away from. This lives in its own module so the menu/toggle can read it without
 * importing the whole IPC surface (and without a cycle back through it).
 */
type RootListener = (root: string | null) => void

let currentRoot: string | null = null
const listeners = new Set<RootListener>()

export function getCurrentRoot(): string | null {
  return currentRoot
}

/** Called whenever a collection is opened or (re)scanned. No-op if unchanged. */
export function setCurrentRoot(root: string | null): void {
  if (root === currentRoot) return
  currentRoot = root
  for (const l of listeners) l(root)
}

/** Subscribe to root changes; returns an unsubscribe fn. */
export function onRootChange(listener: RootListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
