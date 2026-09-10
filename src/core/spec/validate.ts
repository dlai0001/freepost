/**
 * Validate an HTTP response against the OpenAPI/Swagger operation a request is
 * linked to. Pure (no fs/network) but depends on ajv, so it is main-process /
 * CLI only — never import from the renderer.
 *
 * The whole document is registered with ajv once per ParsedSpec and each
 * response schema is compiled as `{ $ref: 'freepost://spec#<pointer>' }`, so
 * `#/components/schemas/X` refs resolve for free. OpenAPI dialect quirks that
 * ajv would reject (`nullable`, draft-04 boolean `exclusiveMinimum`, `type:
 * file`, vendor annotations) are rewritten away in `prepareSchemaDoc`.
 */
import Ajv, { type ErrorObject, type Options, type ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import type {
  HttpResponseModel,
  SpecRef,
  SpecResponseKey,
  SpecValidationError,
  SpecValidationReport
} from '@shared/model'
import {
  allResponses,
  documentedStatuses,
  findOperation,
  isJsonMediaType,
  pickMediaType,
  pickResponse,
  escapePointerToken,
  type FoundOperation,
  type HeaderObject,
  type ParsedSpec,
  type PickedResponse
} from './index'

export interface ValidateInput {
  spec: ParsedSpec
  specRef: SpecRef
  operationId: string
  response: HttpResponseModel
}

const SPEC_URI = 'freepost://spec'

/** Keywords OpenAPI allows in schemas that are annotations to ajv at best and errors at worst. */
const DROP_KEYWORDS = new Set(['discriminator', 'xml', 'externalDocs', 'example', 'nullable'])

/**
 * Deep-clone the document and rewrite OpenAPI-isms into plain JSON Schema so
 * ajv (strict: false) compiles it: `nullable: true` widens `type` with 'null';
 * Swagger 2 boolean `exclusiveMinimum/Maximum` become numeric; `type: file` is
 * dropped; annotation-only keywords are removed.
 */
export function prepareSchemaDoc(spec: ParsedSpec): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(spec.doc)) as Record<string, unknown>
  delete clone.__baseUrlDefault
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.nullable === true) {
      delete obj.nullable
      // A bare `type` can simply be widened, which keeps ajv's error messages
      // specific ("must be integer,null"). But `nullable` carries no type of
      // its own when the permitted values come from a composition keyword, a
      // $ref, or an enum — widening does nothing there (and for a $ref the
      // sibling is ignored outright), so null has to be offered as its own
      // alternative: "null, or whatever the original schema said".
      const composed =
        obj.enum !== undefined ||
        obj.$ref !== undefined ||
        obj.anyOf !== undefined ||
        obj.oneOf !== undefined ||
        obj.allOf !== undefined ||
        obj.not !== undefined
      if (!composed && typeof obj.type === 'string') {
        obj.type = [obj.type, 'null']
      } else if (!composed && Array.isArray(obj.type)) {
        if (!obj.type.includes('null')) obj.type = [...obj.type, 'null']
      } else {
        const inner = { ...obj }
        for (const k of Object.keys(obj)) delete obj[k]
        obj.anyOf = [{ type: 'null' }, inner]
      }
    }
    if (obj.type === 'file') delete obj.type
    if (spec.isSwagger2) {
      if (obj.exclusiveMinimum === true && typeof obj.minimum === 'number') {
        obj.exclusiveMinimum = obj.minimum
        delete obj.minimum
      } else if (typeof obj.exclusiveMinimum === 'boolean') delete obj.exclusiveMinimum
      if (obj.exclusiveMaximum === true && typeof obj.maximum === 'number') {
        obj.exclusiveMaximum = obj.maximum
        delete obj.maximum
      } else if (typeof obj.exclusiveMaximum === 'boolean') delete obj.exclusiveMaximum
    }
    for (const k of DROP_KEYWORDS) delete obj[k]
    for (const v of Object.values(obj)) walk(v)
  }
  walk(clone)
  return clone
}

interface AjvBundle {
  strict: Ajv
  /** Header values arrive as strings; this instance coerces to the declared type. */
  coercing: Ajv
  compiled: Map<string, ValidateFunction>
}

const bundles = new WeakMap<ParsedSpec, AjvBundle>()

function makeAjv(spec: ParsedSpec, prepared: Record<string, unknown>, extra: Options): Ajv {
  const opts: Options = {
    strict: false,
    allErrors: true,
    validateSchema: false,
    validateFormats: true,
    allowUnionTypes: true,
    ...extra
  }
  const ajv = spec.is31 ? new Ajv2020(opts) : new Ajv(opts)
  addFormats(ajv)
  ajv.addSchema(prepared, SPEC_URI)
  return ajv
}

function getBundle(spec: ParsedSpec): AjvBundle {
  let b = bundles.get(spec)
  if (b === undefined) {
    const prepared = prepareSchemaDoc(spec)
    b = {
      strict: makeAjv(spec, prepared, {}),
      coercing: makeAjv(spec, prepared, { coerceTypes: 'array' }),
      compiled: new Map()
    }
    bundles.set(spec, b)
  }
  return b
}

/** Compile (cached) the schema at a JSON pointer inside the registered document. */
function compileAt(bundle: AjvBundle, pointer: string, coercing: boolean): ValidateFunction {
  const key = (coercing ? 'c:' : 's:') + pointer
  let fn = bundle.compiled.get(key)
  if (fn === undefined) {
    fn = (coercing ? bundle.coercing : bundle.strict).compile({ $ref: `${SPEC_URI}#${pointer}` })
    bundle.compiled.set(key, fn)
  }
  return fn
}

function toErrors(errs: ErrorObject[] | null | undefined, target: 'body' | 'header', pathPrefix = ''): SpecValidationError[] {
  if (!errs) return []
  return errs.map((e) => ({
    target,
    instancePath: pathPrefix + e.instancePath,
    keyword: e.keyword,
    message: describeError(e),
    schemaPath: e.schemaPath,
    params: e.params as Record<string, unknown>
  }))
}

/** ajv's messages are terse; add the specifics people need to act on them. */
function describeError(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>
  switch (e.keyword) {
    case 'required':
      return `missing required property "${String(p.missingProperty)}"`
    case 'additionalProperties':
      return `unexpected property "${String(p.additionalProperty)}"`
    case 'enum':
      return `must be one of: ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`
    case 'type':
      return `must be ${String(p.type)}`
    case 'format':
      return `must match format "${String(p.format)}"`
    default:
      return e.message ?? e.keyword
  }
}

function headerValue(response: HttpResponseModel, name: string): string | undefined {
  const want = name.toLowerCase()
  return response.headers.find((h) => h.name.toLowerCase() === want)?.value
}

/** Validate the response headers a documented response declares. */
function validateHeaders(
  bundle: AjvBundle,
  picked: PickedResponse,
  response: HttpResponseModel,
  spec: ParsedSpec
): SpecValidationError[] {
  const errors: SpecValidationError[] = []
  const headers = picked.response.headers
  if (!headers || typeof headers !== 'object') return errors
  for (const [name, def] of Object.entries(headers)) {
    if (!def || typeof def !== 'object') continue
    const lower = name.toLowerCase()
    const value = headerValue(response, name)
    if (value === undefined) {
      if (def.required === true) {
        errors.push({ target: 'header', instancePath: lower, keyword: 'required', message: 'required response header is missing' })
      }
      continue
    }
    // Header values arrive as strings and ajv's coercion mutates the holder,
    // so validate `{ v: value }` against a wrapper schema.
    let valueSchema: Record<string, unknown> | undefined
    if (spec.isSwagger2) valueSchema = swagger2HeaderSchema(def)
    else if (def.schema !== undefined && def.$ref === undefined) {
      valueSchema = { $ref: `${SPEC_URI}#${picked.pointer}/headers/${escapePointerToken(name)}/schema` }
    }
    if (valueSchema === undefined) continue
    try {
      const key = 'h:' + picked.pointer + '/' + name
      let fn = bundle.compiled.get(key)
      if (fn === undefined) {
        fn = bundle.coercing.compile({ type: 'object', properties: { v: valueSchema } })
        bundle.compiled.set(key, fn)
      }
      if (!fn({ v: value })) {
        errors.push(...toErrors(fn.errors, 'header').map((e) => ({ ...e, instancePath: lower })))
      }
    } catch {
      /* uncompilable header schema — ignore, the body check still stands */
    }
  }
  return errors
}

function swagger2HeaderSchema(def: HeaderObject): Record<string, unknown> {
  const { description: _d, required: _r, example: _e, ...schema } = def
  return schema as Record<string, unknown>
}
function keyOf(picked: PickedResponse, mediaType: string | undefined): SpecResponseKey {
  return mediaType === undefined ? { status: picked.key } : { status: picked.key, mediaType }
}

interface BodyCheck {
  errors: SpecValidationError[]
  key: SpecResponseKey
  /** 'no-schema' (nothing to check), 'skipped' (non-JSON media), or 'checked'. */
  outcome: 'no-schema' | 'skipped' | 'checked'
  reason?: string
}

/** Run the body schema of one documented response against the parsed body. */
function checkBody(
  bundle: AjvBundle,
  picked: PickedResponse,
  found: FoundOperation,
  response: HttpResponseModel,
  parsedBody: { ok: true; value: unknown } | { ok: false; empty: boolean },
  spec: ParsedSpec
): BodyCheck {
  const mt = pickMediaType(picked, found, headerValue(response, 'content-type'), spec)
  if (mt === undefined) return { errors: [], key: keyOf(picked, undefined), outcome: 'no-schema' }
  const key = keyOf(picked, mt.mediaType)
  if (mt.mediaType !== undefined && !isJsonMediaType(mt.mediaType)) {
    return { errors: [], key, outcome: 'skipped', reason: `documented media type ${mt.mediaType} is not JSON` }
  }
  if (!parsedBody.ok) {
    if (parsedBody.empty) {
      return {
        errors: [{ target: 'body', instancePath: '', keyword: 'body', message: 'expected a JSON body but the response was empty' }],
        key,
        outcome: 'checked'
      }
    }
    return { errors: [], key, outcome: 'skipped', reason: 'response body is not valid JSON' }
  }
  const fn = compileAt(bundle, mt.schemaPointer, false)
  const ok = fn(parsedBody.value)
  return { errors: ok ? [] : toErrors(fn.errors, 'body'), key, outcome: 'checked' }
}

/**
 * Validate `response` against the operation. Never throws: spec problems come
 * back as `verdict: 'error'`, unverifiable bodies as `verdict: 'skipped'`.
 */
export function validateResponse(input: ValidateInput): SpecValidationReport {
  const { spec, specRef, operationId: opId, response } = input
  const base: SpecValidationReport = { verdict: 'match', spec: specRef, specVersion: spec.version, errors: [] }
  try {
    const found = findOperation(spec, opId)
    if (found === undefined) return { ...base, verdict: 'error', reason: `operation "${opId}" not found in ${specRef.path}` }
    const bundle = getBundle(spec)

    const trimmed = response.bodyText.trim()
    let parsedBody: { ok: true; value: unknown } | { ok: false; empty: boolean }
    if (trimmed === '') parsedBody = { ok: false, empty: true }
    else {
      try {
        parsedBody = { ok: true, value: JSON.parse(trimmed) }
      } catch {
        parsedBody = { ok: false, empty: false }
      }
    }

    const closest = (exclude: string | undefined, threshold: number): SpecValidationReport['closestMatch'] => {
      let best: SpecValidationReport['closestMatch']
      for (const other of allResponses(found, spec)) {
        if (other.key === exclude) continue
        let check: BodyCheck
        try {
          check = checkBody(bundle, other, found, response, parsedBody, spec)
        } catch {
          continue
        }
        if (check.outcome !== 'checked') continue
        if (check.errors.length < threshold && (best === undefined || check.errors.length < best.errors.length)) {
          best = { response: check.key, errors: check.errors }
        }
      }
      return best
    }

    const picked = pickResponse(found, response.status, spec)
    if (picked === undefined) {
      return {
        ...base,
        verdict: 'undocumented-status',
        documentedStatuses: documentedStatuses(found.op),
        closestMatch: closest(undefined, Number.POSITIVE_INFINITY),
        reason: `status ${response.status} is not documented for ${opId}`
      }
    }

    const body = checkBody(bundle, picked, found, response, parsedBody, spec)
    const headerErrors = validateHeaders(bundle, picked, response, spec)
    if (body.outcome === 'skipped') {
      return { ...base, verdict: 'skipped', matchedResponse: body.key, errors: headerErrors, reason: body.reason }
    }
    const errors = [...body.errors, ...headerErrors]
    if (errors.length === 0) return { ...base, matchedResponse: body.key }
    return {
      ...base,
      verdict: 'mismatch',
      matchedResponse: body.key,
      errors,
      closestMatch: closest(picked.key, body.errors.length)
    }
  } catch (e) {
    return { ...base, verdict: 'error', reason: `schema compile failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
