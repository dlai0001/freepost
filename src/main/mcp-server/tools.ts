/**
 * The Freepost MCP tool surface — what an AI app (Claude Desktop, ChatGPT) can
 * do to a collection.
 *
 * Design notes worth not re-litigating:
 *
 * - Writes take RAW FILE TEXT, not a structured model. The strict grammar plus
 *   `parseRequestFile` is already a validator and `writeRequestFile` already
 *   canonicalizes, so a parse error is a precise, actionable message the model
 *   can iterate against. Structured input would mean five per-kind JSON schemas
 *   in every client's context for no reliability gain.
 * - The tool count is kept small on purpose. Every tool's schema is context the
 *   user pays for on every turn, so create+update are one tool, folders are
 *   created implicitly, and delete/rename are one tool each for files+folders.
 * - No electron imports here: the CLI bundles this module.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { z } from 'zod'
import { buildSchema, getIntrospectionQuery, graphqlSync } from 'graphql'
import type { GqlSchemaSummary, ParseError, RequestFile, TreeNode } from '../../shared/model'
import { parseRequestFile, requestKindForPath, writeRequestFile } from '../../core/format'
import { dedupeRelPath, importOpenApi } from '../../core/importers/openapi'
import { parseIntrospection, FULL_INTROSPECTION_QUERY } from '../../core/graphql/introspection'
import { isLocalEnv, serializeEnvFile } from '../../core/env'
import { detectOperationType } from '../../core/graphql/operation'
import { sendHttp } from '../../engine'
import { listFiles, scanCollection } from '../collection'
import { executeRequest, jarFor, readEnvFile } from '../execute'
import { stripSecretDefaults } from '../starters'
import { formatSpec, type SpecKind } from './format-doc'
import { assertRunAllowed, assertWritable, resolveInRoot, ToolError, type ServerContext } from './context'

/** Body text over this is truncated — a whole response can blow a context window. */
const BODY_EXCERPT_LIMIT = 2000

type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] }
}

function failure(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true }
}

/**
 * Run a handler, turning expected failures into isError results.
 *
 * A thrown error would surface as a protocol fault; what we want is a message
 * the model can read and correct. ToolError is our own "you asked for something
 * not allowed"; anything else is unexpected and gets its message passed through.
 */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ToolError) return failure(e.message)
    return failure(e instanceof Error ? e.message : String(e))
  }
}

/** Render the collection tree as an indented outline (cheaper than JSON). */
function renderTree(node: TreeNode, depth = 0): string[] {
  const pad = '  '.repeat(depth)
  const lines: string[] = []
  if (depth > 0) {
    lines.push(
      node.type === 'folder'
        ? `${pad}${node.name}/`
        : `${pad}${node.path}${node.kind !== undefined ? `  [${node.kind}]` : '  [workflow]'}`
    )
  }
  for (const child of node.children ?? []) lines.push(...renderTree(child, depth + 1))
  return lines
}

/** Line-numbered parse errors, so the model can find what it got wrong. */
function renderParseErrors(errors: ParseError[]): string {
  return errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n')
}

/** Parse+strip+serialize: the one write path, so every writer gets the guardrails. */
function canonicalize(rel: string, content: string): { raw: string; file: RequestFile } {
  const kind = requestKindForPath(rel)
  if (kind === null) {
    throw new ToolError(
      `Not a request file: ${rel}. Use one of .curl (HTTP/GraphQL), .ws, .grpc, .mqtt, .mcp.`
    )
  }
  const parsed = parseRequestFile(content, kind)
  if (!parsed.ok) {
    throw new ToolError(
      `Parse error — nothing was written.\n\n${renderParseErrors(parsed.errors)}\n\n` +
        `Call get_format_spec${kind === 'curl' ? '' : ` with kind "${kind}"`} for the grammar.`
    )
  }
  return { raw: writeRequestFile(stripSecretDefaults(parsed.file)), file: parsed.file }
}

/** Summarize a schema for a model: root fields with args, then type names. */
function renderSchemaSummary(s: GqlSchemaSummary): string {
  const section = (title: string, fields: GqlSchemaSummary['queries']): string[] => {
    if (fields.length === 0) return []
    return [
      `## ${title}`,
      ...fields.map((f) => `- ${f.name}(${f.args.join(', ')}): ${f.type}`),
      ''
    ]
  }
  return [
    `# GraphQL schema`,
    `query: ${s.queryType ?? '—'} · mutation: ${s.mutationType ?? '—'} · subscription: ${s.subscriptionType ?? '—'}`,
    '',
    ...section('Queries', s.queries),
    ...section('Mutations', s.mutations),
    `## Types (${s.types.length})`,
    s.types.join(', ')
  ].join('\n')
}

/** Turn an SDL document into the same summary shape introspection produces. */
function summarizeSdl(sdl: string): GqlSchemaSummary {
  let schema: ReturnType<typeof buildSchema>
  try {
    schema = buildSchema(sdl)
  } catch (e) {
    throw new ToolError(`Not a valid GraphQL schema document: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Run the real introspection query against the local schema so the summary is
  // produced by exactly the same reducer the live-endpoint path uses.
  const res = graphqlSync({ schema, source: getIntrospectionQuery() })
  const summary = parseIntrospection(JSON.stringify(res))
  if (summary === null) throw new ToolError('Could not introspect the provided schema document.')
  return summary
}

export function registerFreepostTools(server: McpServer, ctx: ServerContext): void {
  const root = (): string => ctx.getRoot()

  // ---- 1. get_format_spec -------------------------------------------------
  server.registerTool(
    'get_format_spec',
    {
      title: 'Get the Freepost request-file format',
      description:
        'Returns the grammar for Freepost request files plus a canonical starter to copy. ' +
        'Call this BEFORE the first write_request of a given kind — the files are a strict ' +
        'bash grammar, not free-form scripts. Use kind "graphql" for GraphQL requests.',
      inputSchema: {
        kind: z
          .enum(['curl', 'graphql', 'websocat', 'grpc', 'mqtt', 'mcp'])
          .optional()
          .describe('Request kind. Omit for an overview plus the HTTP (.curl) example.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ kind }) => guard(async () => text(formatSpec(kind as SpecKind | undefined)))
  )

  // ---- 2. list_collection -------------------------------------------------
  server.registerTool(
    'list_collection',
    {
      title: 'List the collection',
      description:
        'Show every request, folder and environment in the collection as a tree. ' +
        'Paths shown here are what every other tool expects.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      guard(async () => {
        const tree = await scanCollection(root())
        const envs = (await listFiles(root()))
          .filter((f) => f.endsWith('.env.json') && !isLocalEnv(f))
          .sort()
        const lines = renderTree(tree)
        return text(
          [
            `Collection: ${tree.name} (${root()})`,
            '',
            lines.length > 0 ? lines.join('\n') : '(empty)',
            '',
            envs.length > 0 ? `Environments: ${envs.join(', ')}` : 'Environments: (none)'
          ].join('\n')
        )
      })
  )

  // ---- 3. read_request ----------------------------------------------------
  server.registerTool(
    'read_request',
    {
      title: 'Read a request file',
      description: 'Return the raw text of a request file, and whether it currently parses.',
      inputSchema: {
        path: z.string().describe('Collection-relative path, e.g. "Users/Get user.curl"')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ path }) =>
      guard(async () => {
        const abs = resolveInRoot(root(), path)
        if (!existsSync(abs)) throw new ToolError(`No such file: ${path}`)
        const raw = await fs.readFile(abs, 'utf8')
        const kind = requestKindForPath(path)
        if (kind === null) return text(raw)
        const parsed = parseRequestFile(raw, kind)
        const status = parsed.ok
          ? 'parses OK'
          : `PARSE ERRORS:\n${renderParseErrors(parsed.errors)}`
        return text(`${path} (${kind}) — ${status}\n\n${raw}`)
      })
  )

  // ---- 4. write_request ---------------------------------------------------
  server.registerTool(
    'write_request',
    {
      title: 'Create or update a request file',
      description:
        'Write a request file (creating parent folders as needed). The content must be a ' +
        'complete Freepost request file — see get_format_spec. It is parsed first: on a parse ' +
        'error nothing is written and you get the error back. On success it is re-serialized ' +
        'to canonical form and the canonical text is returned. Add test scripts under ' +
        'frontmatter scripts.test.',
      inputSchema: {
        path: z
          .string()
          .describe('Collection-relative path incl. extension, e.g. "Users/Create user.curl"'),
        content: z.string().describe('The complete file text, starting with #!/usr/bin/env bash')
      }
    },
    async ({ path, content }) =>
      guard(async () => {
        assertWritable(ctx, 'write_request')
        const abs = resolveInRoot(root(), path)
        const existed = existsSync(abs)
        const { raw } = canonicalize(path, content)
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, raw)
        return text(`${existed ? 'Updated' : 'Created'} ${path}\n\n${raw}`)
      })
  )

  // ---- 5. move_path -------------------------------------------------------
  server.registerTool(
    'move_path',
    {
      title: 'Move or rename a request or folder',
      description:
        'Rename or move a request file or a folder. The filename (minus extension) is the ' +
        "request's display name, so renaming is how you rename a request.",
      inputSchema: {
        from: z.string().describe('Existing collection-relative path'),
        to: z.string().describe('New collection-relative path')
      }
    },
    async ({ from, to }) =>
      guard(async () => {
        assertWritable(ctx, 'move_path')
        const fromAbs = resolveInRoot(root(), from)
        const toAbs = resolveInRoot(root(), to)
        if (!existsSync(fromAbs)) throw new ToolError(`No such path: ${from}`)
        if (existsSync(toAbs)) throw new ToolError(`Destination already exists: ${to}`)
        await fs.mkdir(dirname(toAbs), { recursive: true })
        await fs.rename(fromAbs, toAbs)
        return text(`Moved ${from} → ${to}`)
      })
  )

  // ---- 6. delete_path -----------------------------------------------------
  server.registerTool(
    'delete_path',
    {
      title: 'Delete a request or folder',
      description: 'Delete a request file, or a folder and everything in it. Not undoable.',
      inputSchema: { path: z.string().describe('Collection-relative path') },
      annotations: { destructiveHint: true }
    },
    async ({ path }) =>
      guard(async () => {
        assertWritable(ctx, 'delete_path')
        const abs = resolveInRoot(root(), path)
        if (!existsSync(abs)) throw new ToolError(`No such path: ${path}`)
        const dir = (await fs.stat(abs)).isDirectory()
        await fs.rm(abs, { recursive: dir, force: false })
        return text(`Deleted ${dir ? 'folder' : 'file'} ${path}`)
      })
  )

  // ---- 7. run_request -----------------------------------------------------
  server.registerTool(
    'run_request',
    {
      title: 'Run a request and its tests',
      description:
        'Execute a request for real (network call, using the collection/environment variables) ' +
        'and return the response plus the results of its test script. Use this to check that ' +
        'the tests you wrote actually pass. One-shot kinds only: .curl, .grpc, .mqtt (publish), ' +
        '.mcp. Session variables set by scripts persist across calls.',
      inputSchema: {
        path: z.string().describe('Collection-relative path of the request'),
        env: z
          .string()
          .optional()
          .describe('Environment file to use, e.g. "environments/local.env.json"')
      },
      annotations: { openWorldHint: true }
    },
    async ({ path, env }) =>
      guard(async () => {
        assertRunAllowed(ctx)
        const abs = resolveInRoot(root(), path)
        if (!existsSync(abs)) throw new ToolError(`No such file: ${path}`)
        const kind = requestKindForPath(path)
        if (kind === 'websocat') {
          throw new ToolError('WebSocket requests are long-lived; run them from the Freepost app.')
        }

        // A stdio .mcp file names a program to spawn. Never let an AI-initiated
        // call be the thing that first runs it.
        if (kind === 'mcp') {
          const parsed = parseRequestFile(await fs.readFile(abs, 'utf8'), 'mcp')
          if (
            parsed.ok &&
            parsed.file.mcp?.transport === 'stdio' &&
            !ctx.allowMcpSpawn(parsed.file)
          ) {
            throw new ToolError(
              `${path} spawns a local MCP server as a subprocess, which is not approved here. ` +
                'Approve the server in the Freepost app first, or run it from the CLI.'
            )
          }
        }

        if (kind === 'curl') {
          const parsed = parseRequestFile(await fs.readFile(abs, 'utf8'), 'curl')
          const q = parsed.ok ? parsed.file.frontmatter.graphql?.query : undefined
          if (q !== undefined && detectOperationType(q) === 'subscription') {
            throw new ToolError(
              'This is a GraphQL subscription — long-lived, so it cannot be run one-shot. ' +
                'Subscribe from the Freepost app instead.'
            )
          }
        }

        const report = await executeRequest({
          root: root(),
          path,
          envPath: env ?? ctx.envPath,
          session: ctx.session
        })

        const out: string[] = [`${path} → ${report.errored ? 'FAILED' : 'ok'}`]
        if (report.resolvedUrl !== '') out.push(`url: ${report.resolvedUrl}`)
        if (report.unresolved?.length) out.push(`unresolved variables: ${report.unresolved.join(', ')}`)
        if (report.transportError !== undefined) out.push(`transport error: ${report.transportError}`)
        const r = report.response
        if (r !== undefined) {
          const ct = r.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '—'
          out.push(`status: ${r.status} ${r.statusText} · ${Math.round(r.timeMs)}ms · ${r.sizeBytes} bytes · ${ct}`)
          const body = r.bodyText.length > BODY_EXCERPT_LIMIT
            ? `${r.bodyText.slice(0, BODY_EXCERPT_LIMIT)}\n… [truncated, ${r.bodyText.length} chars total]`
            : r.bodyText
          out.push('', 'body:', body)
        }
        for (const [label, outcome] of [
          ['pre-request', report.preScript],
          ['test', report.testScript]
        ] as const) {
          if (outcome === undefined) continue
          if (outcome.error !== undefined) out.push('', `${label} script error: ${outcome.error}`)
          if (outcome.tests.length > 0) {
            out.push('', `${label} results:`)
            for (const t of outcome.tests) {
              out.push(`  ${t.passed ? '✓' : '✗'} ${t.name}${t.error !== undefined ? ` — ${t.error}` : ''}`)
            }
          }
          if (outcome.consoleLines.length > 0) {
            out.push('', `${label} console:`, ...outcome.consoleLines.map((l) => `  ${l}`))
          }
        }
        return report.errored ? failure(out.join('\n')) : text(out.join('\n'))
      })
  )

  // ---- 8. import_openapi --------------------------------------------------
  server.registerTool(
    'import_openapi',
    {
      title: 'Import an OpenAPI/Swagger spec',
      description:
        'Generate one .curl request per operation from an OpenAPI 3 or Swagger 2 spec (JSON or ' +
        'YAML), grouped into folders by tag. Returns the files created — read and edit them ' +
        'with write_request to add test scripts.',
      inputSchema: {
        spec: z.string().optional().describe('The spec document itself (JSON or YAML text)'),
        specPath: z
          .string()
          .optional()
          .describe('Collection-relative path to a spec file, instead of passing `spec`'),
        targetDir: z
          .string()
          .optional()
          .describe('Collection-relative folder to import into. Defaults to the collection root.')
      }
    },
    async ({ spec, specPath, targetDir }) =>
      guard(async () => {
        assertWritable(ctx, 'import_openapi')
        if ((spec === undefined) === (specPath === undefined)) {
          throw new ToolError('Pass exactly one of `spec` or `specPath`.')
        }
        let doc: string
        if (specPath !== undefined) {
          const abs = resolveInRoot(root(), specPath)
          if (!existsSync(abs)) throw new ToolError(`No such file: ${specPath}`)
          doc = await fs.readFile(abs, 'utf8')
        } else {
          doc = spec!
        }

        const result = importOpenApi(doc)
        if (!result.ok) throw new ToolError(`Could not import the spec: ${result.error}`)
        if (result.files.length === 0) throw new ToolError('The spec produced no operations.')

        // Check the target folder up front so a bad one fails with a clear
        // message rather than as a confusing per-file escape error.
        if (targetDir !== undefined) resolveInRoot(root(), targetDir)
        const created: string[] = []
        for (const f of result.files) {
          const wanted =
            targetDir === undefined ? f.relPath : `${targetDir.replace(/\/+$/, '')}/${f.relPath}`
          const rel = dedupeRelPath(wanted, (candidate) => existsSync(resolve(root(), candidate)))
          const abs = resolveInRoot(root(), rel)
          await fs.mkdir(dirname(abs), { recursive: true })
          await fs.writeFile(abs, writeRequestFile(stripSecretDefaults(f.file)))
          created.push(rel)
        }
        return text(
          [
            `Imported ${created.length} request(s) from the spec:`,
            ...created.map((c) => `  ${c}`),
            '',
            'None of them have test scripts yet — add them with write_request.'
          ].join('\n')
        )
      })
  )

  // ---- 9. read_environment ------------------------------------------------
  server.registerTool(
    'read_environment',
    {
      title: 'List or read environments',
      description:
        'Without `name`: list the environment files. With `name`: return that environment\'s ' +
        'variables. Secret environments (*.local.env.json) are never listed or read.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe('Environment path, e.g. "environments/local.env.json"')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ name }) =>
      guard(async () => {
        if (name === undefined) {
          const envs = (await listFiles(root()))
            .filter((f) => f.endsWith('.env.json') && !isLocalEnv(f))
            .sort()
          return text(envs.length > 0 ? envs.join('\n') : 'No environments in this collection.')
        }
        const abs = resolveInRoot(root(), name)
        if (!name.endsWith('.env.json')) throw new ToolError(`Not an environment file: ${name}`)
        if (!existsSync(abs)) throw new ToolError(`No such environment: ${name}`)
        const values = readEnvFile(root(), name)
        return text(`${name}\n\n${JSON.stringify(values, null, 2)}`)
      })
  )

  // ---- 10. write_environment ----------------------------------------------
  server.registerTool(
    'write_environment',
    {
      title: 'Write an environment',
      description:
        'Create or overwrite an environment file with the given variables (replacing its whole ' +
        'contents). Do not put secrets here — this file is committed; secrets belong in a ' +
        '*.local.env.json, which this tool refuses to touch.',
      inputSchema: {
        name: z
          .string()
          .describe('Environment path, e.g. "environments/local.env.json"'),
        vars: z.record(z.string(), z.string()).describe('The complete variable map for this file')
      }
    },
    async ({ name, vars }) =>
      guard(async () => {
        assertWritable(ctx, 'write_environment')
        const abs = resolveInRoot(root(), name)
        if (!name.endsWith('.env.json')) {
          throw new ToolError(`Environment files must end in .env.json: ${name}`)
        }
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, serializeEnvFile(vars))
        return text(`Wrote ${name} with ${Object.keys(vars).length} variable(s).`)
      })
  )

  // ---- 11. describe_graphql_schema ----------------------------------------
  server.registerTool(
    'describe_graphql_schema',
    {
      title: 'Describe a GraphQL schema',
      description:
        'Summarize a GraphQL schema — queries and mutations with their argument types, plus the ' +
        'type names — so you can author operations without reading the whole schema. Pass ' +
        'exactly one of: `endpoint` (introspect a live server), `sdl` (schema document text), ' +
        'or `sdlPath` (a .graphql/.sdl file in the collection).',
      inputSchema: {
        endpoint: z.string().optional().describe('GraphQL endpoint URL to introspect'),
        sdl: z.string().optional().describe('Schema Definition Language text'),
        sdlPath: z.string().optional().describe('Collection-relative path to an SDL file')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ endpoint, sdl, sdlPath }) =>
      guard(async () => {
        const given = [endpoint, sdl, sdlPath].filter((v) => v !== undefined)
        if (given.length !== 1) {
          throw new ToolError('Pass exactly one of `endpoint`, `sdl`, or `sdlPath`.')
        }

        if (sdl !== undefined) return text(renderSchemaSummary(summarizeSdl(sdl)))

        if (sdlPath !== undefined) {
          const abs = resolveInRoot(root(), sdlPath)
          if (!existsSync(abs)) throw new ToolError(`No such file: ${sdlPath}`)
          return text(renderSchemaSummary(summarizeSdl(await fs.readFile(abs, 'utf8'))))
        }

        // Live introspection is a network call, so it answers to the same gate
        // as run_request.
        assertRunAllowed(ctx)
        const res = await sendHttp(
          {
            method: 'POST',
            url: endpoint!,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            bodyText: JSON.stringify({ query: FULL_INTROSPECTION_QUERY })
          },
          jarFor(root())
        )
        const summary = parseIntrospection(res.bodyText)
        if (summary === null) {
          throw new ToolError(
            `Introspection failed (HTTP ${res.status}) — not a GraphQL endpoint, or introspection is disabled. ` +
              `Response: ${res.bodyText.slice(0, 300)}`
          )
        }
        return text(`${renderSchemaSummary(summary)}\n\nEndpoint: ${endpoint}`)
      })
  )
}
