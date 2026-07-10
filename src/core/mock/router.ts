/**
 * Mock-server routing: turn a collection's request files + their saved response
 * examples into an HTTP router. Pure data-in/data-out — no sockets, no fs — so
 * it lives in src/core and is exhaustively unit-testable. The engine
 * (src/engine/mock-server.ts) owns the actual listener and calls these.
 */
import type { RequestFile, SavedExample } from '../../shared/model'

/** One path segment of a route: a fixed string, or a `${VAR}` wildcard. */
export type RouteSegment = { literal: string } | { param: string }

/** A matchable route built from one request file and its examples. */
export interface MockRoute {
  method: string
  segments: RouteSegment[]
  /** Collection-relative path of the source request (for logs/debugging). */
  sourcePath: string
  examples: SavedExample[]
}

/** Header name (lower-case) that overrides which example is served. */
export const EXAMPLE_HEADER = 'x-freepost-mock-example'
/** Query param that overrides which example is served. */
export const EXAMPLE_QUERY = '__example'

/** Split a (possibly `${VAR}`-templated) request URL into path segments. */
export function pathToSegments(url: string): RouteSegment[] {
  // Mask ${...} refs so a templated host/path still parses as a URL, and so a
  // var inside a path segment marks that segment as a wildcard.
  const varNames = new Map<string, string>()
  const masked = url.replace(/\$\{([^}]+)\}/g, (_m, inner: string) => {
    const token = `__fpvar${varNames.size}__`
    // Friendly param name: the bare variable name, dropping any :-/:? default.
    varNames.set(token, inner.split(/[:\-?]/)[0] || 'param')
    return token
  })
  let pathname: string
  try {
    pathname = new URL(masked).pathname
  } catch {
    const q = masked.indexOf('?')
    pathname = q >= 0 ? masked.slice(0, q) : masked
    if (!pathname.startsWith('/')) pathname = '/' + pathname
  }
  const parts = pathname.split('/').filter((s) => s !== '')
  return parts.map((seg) => {
    const varMatch = seg.match(/__fpvar\d+__/)
    if (varMatch !== null) return { param: varNames.get(varMatch[0]) ?? 'param' }
    let literal = seg
    try {
      literal = decodeURIComponent(seg)
    } catch {
      /* leave as-is if it isn't valid percent-encoding */
    }
    return { literal }
  })
}

/** Number of wildcard segments — used to prefer more-specific routes. */
function paramCount(route: MockRoute): number {
  return route.segments.filter((s) => 'param' in s).length
}

/**
 * Build the route table from HTTP request files that have saved examples.
 * Only `.curl` (HTTP) files with at least one example become routes. Routes are
 * ordered most-specific-first (fewest wildcards) so a literal route wins over a
 * wildcard one at the same path shape.
 */
export function buildRoutes(
  files: { relPath: string; file: RequestFile; examples: SavedExample[] }[]
): MockRoute[] {
  const routes: MockRoute[] = []
  for (const { relPath, file, examples } of files) {
    if (file.http === undefined || examples.length === 0) continue
    routes.push({
      method: file.http.method.toUpperCase(),
      segments: pathToSegments(file.http.url),
      sourcePath: relPath,
      examples
    })
  }
  routes.sort((a, b) => paramCount(a) - paramCount(b))
  return routes
}

/** Split an incoming request path into decoded segments. */
function incomingSegments(path: string): string[] {
  const clean = path.split('?')[0]
  return clean
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
}

/** Find the route matching this method + path, binding any path params. */
export function matchRoute(
  routes: MockRoute[],
  method: string,
  path: string
): { route: MockRoute; params: Record<string, string> } | null {
  const wantMethod = method.toUpperCase()
  const segs = incomingSegments(path)
  for (const route of routes) {
    if (route.method !== wantMethod) continue
    if (route.segments.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < segs.length; i++) {
      const rs = route.segments[i]
      if ('literal' in rs) {
        if (rs.literal !== segs[i]) {
          ok = false
          break
        }
      } else {
        params[rs.param] = segs[i]
      }
    }
    if (ok) return { route, params }
  }
  return null
}

/**
 * Choose which saved example a matched route serves:
 *  1. an explicit override (`?__example=name` or the X-Freepost-Mock-Example
 *     header) if it names an existing example,
 *  2. else the example flagged `active`,
 *  3. else the first example in file order.
 */
export function pickExample(
  route: MockRoute,
  opts: { headers?: Record<string, string>; query?: URLSearchParams } = {}
): SavedExample | undefined {
  if (route.examples.length === 0) return undefined
  const override =
    opts.query?.get(EXAMPLE_QUERY) ??
    (opts.headers !== undefined ? opts.headers[EXAMPLE_HEADER] : undefined)
  if (override !== undefined && override !== null && override !== '') {
    const named = route.examples.find((e) => e.name === override)
    if (named !== undefined) return named
  }
  return route.examples.find((e) => e.active === true) ?? route.examples[0]
}
