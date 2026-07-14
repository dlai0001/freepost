/**
 * MCP schema snapshots (F5). The snapshot for `api/tools.mcp` lives beside it as
 * `api/tools.mcp.snapshot.json` — a plain file in the collection, so `git diff`
 * reviews a server's schema change like any other code review.
 */
export {
  buildSnapshot,
  diffSnapshots,
  serializeSnapshot,
  parseSnapshot,
  type McpSnapshot,
  type McpSnapshotTool,
  type McpDriftEntry,
  type McpDriftReport
} from './snapshot'

/** The snapshot file that belongs to a `.mcp` request path. */
export function snapshotPathFor(requestPath: string): string {
  return `${requestPath}.snapshot.json`
}
