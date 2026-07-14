/**
 * In-memory search index (PLAN.md "Search").
 *
 * Indexed fields: name (filename), labels, description, URL, method.
 * Query syntax: whitespace-separated terms ANDed together; `label:foo`
 * filters by case-insensitive exact label match; every other term is a
 * case-insensitive substring match against name/description/url/method.
 */

import type { Frontmatter, HttpRequestModel, SearchEntry, WsRequestModel } from '@shared/model'

/** Known filename suffixes, longest first so `.workflow.json` wins over `.json`. */
const KNOWN_SUFFIXES = ['.workflow.json', '.curl', '.ws', '.grpc', '.mqtt', '.mcp']

/** Basename of `path` with the request/workflow extension stripped. */
function nameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  for (const suffix of KNOWN_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) return base.slice(0, -suffix.length)
  }
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Build one index entry from a parsed request or workflow file. */
export function buildSearchEntry(
  path: string,
  type: 'request' | 'workflow',
  frontmatter: Frontmatter | undefined,
  http?: HttpRequestModel,
  ws?: WsRequestModel,
  wfDescription?: string
): SearchEntry {
  return {
    path,
    name: nameFromPath(path),
    type,
    labels: frontmatter?.label ?? [],
    description: frontmatter?.description ?? wfDescription,
    method: http?.method,
    url: http?.url ?? ws?.url
  }
}

interface ParsedQuery {
  labelFilters: string[]
  textTerms: string[]
}

function parseQuery(query: string): ParsedQuery {
  const labelFilters: string[] = []
  const textTerms: string[] = []
  for (const raw of query.split(/\s+/)) {
    if (raw === '') continue
    const term = raw.toLowerCase()
    if (term.startsWith('label:')) {
      labelFilters.push(term.slice('label:'.length))
    } else {
      textTerms.push(term)
    }
  }
  return { labelFilters, textTerms }
}

/**
 * Query the index. Terms combine with AND; empty query returns all entries.
 * Results are sorted by name.
 */
export function queryIndex(entries: SearchEntry[], query: string): SearchEntry[] {
  const { labelFilters, textTerms } = parseQuery(query)

  const matches = entries.filter((entry) => {
    const labels = entry.labels.map((l) => l.toLowerCase())
    if (!labelFilters.every((filter) => labels.includes(filter))) return false

    if (textTerms.length === 0) return true
    const haystack = [entry.name, entry.description, entry.url, entry.method]
      .filter((f): f is string => f !== undefined)
      .join('\n')
      .toLowerCase()
    return textTerms.every((term) => haystack.includes(term))
  })

  return matches.sort((a, b) => a.name.localeCompare(b.name))
}
