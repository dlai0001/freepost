import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType
} from 'graphql'

/** A field-like row: object/interface fields and input fields share this shape
 *  (input fields simply have no `args`). */
interface FieldLike {
  name: string
  type: GraphQLType
  args?: readonly GraphQLArgument[]
  description?: string | null
  deprecationReason?: string | null
}

const BUILTIN_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID'])

/** Navigable = has its own page worth visiting (skip built-in scalars + introspection). */
function isNavigable(t: GraphQLNamedType): boolean {
  if (t.name.startsWith('__')) return false
  if (isScalarType(t)) return !BUILTIN_SCALARS.has(t.name)
  return true
}

function kindLabel(t: GraphQLNamedType): string {
  if (isObjectType(t)) return 'type'
  if (isInterfaceType(t)) return 'interface'
  if (isInputObjectType(t)) return 'input'
  if (isEnumType(t)) return 'enum'
  if (isUnionType(t)) return 'union'
  return 'scalar'
}

/** A GraphQL type reference (e.g. `[User!]!`) with its named type clickable. */
function TypeRef({
  type,
  onNav
}: {
  type: GraphQLType
  onNav: (name: string) => void
}): JSX.Element {
  const named = getNamedType(type)
  const full = type.toString()
  const idx = full.indexOf(named.name)
  const prefix = full.slice(0, idx)
  const suffix = full.slice(idx + named.name.length)
  if (!isNavigable(named)) return <span className="gql-field-type">{full}</span>
  return (
    <span className="gql-field-type">
      {prefix}
      <button className="gql-type-link" onClick={() => onNav(named.name)}>
        {named.name}
      </button>
      {suffix}
    </span>
  )
}

function ArgList({
  args,
  onNav
}: {
  args: readonly GraphQLArgument[]
  onNav: (name: string) => void
}): JSX.Element | null {
  if (args.length === 0) return null
  return (
    <span className="gql-field-args">
      (
      {args.map((a, i) => (
        <span key={a.name}>
          {i > 0 && ', '}
          {a.name}: <TypeRef type={a.type} onNav={onNav} />
        </span>
      ))}
      )
    </span>
  )
}

function FieldRow({
  field,
  onNav,
  onPick
}: {
  field: FieldLike
  onNav: (name: string) => void
  /** When set, the field name becomes a click-to-insert button (root fields only). */
  onPick?: (name: string) => void
}): JSX.Element {
  return (
    <div className="gql-ex-field">
      <div className="gql-ex-sig mono">
        {onPick !== undefined ? (
          <button
            className="gql-field-name gql-ex-pick"
            title="Insert into query"
            onClick={() => onPick(field.name)}
          >
            {field.name}
          </button>
        ) : (
          <span className="gql-field-name">{field.name}</span>
        )}
        <ArgList args={field.args ?? []} onNav={onNav} />
        {': '}
        <TypeRef type={field.type} onNav={onNav} />
      </div>
      {field.description !== undefined && field.description !== null && field.description !== '' && (
        <div className="gql-ex-desc">{field.description}</div>
      )}
      {field.deprecationReason !== undefined && field.deprecationReason !== null && (
        <div className="gql-ex-deprecated">Deprecated: {field.deprecationReason}</div>
      )}
    </div>
  )
}

/** A group of fields under a titled heading (root operations or a type's fields). */
function FieldGroup({
  title,
  fields,
  onNav,
  onPick
}: {
  title: string
  fields: FieldLike[]
  onNav: (name: string) => void
  onPick?: (name: string) => void
}): JSX.Element {
  return (
    <div className="gql-schema-group">
      <div className="gql-schema-title">
        {title} ({fields.length})
      </div>
      {fields.length === 0 && <div className="dim-note">none</div>}
      {fields.map((f) => (
        <FieldRow key={f.name} field={f} onNav={onNav} onPick={onPick} />
      ))}
    </div>
  )
}

/** Render the page for a single named type (fields, values, members, …). */
function TypeView({
  type,
  isRoot,
  onNav,
  onPick
}: {
  type: GraphQLNamedType
  /** True when this type is one of the schema's root operation types. */
  isRoot: boolean
  onNav: (name: string) => void
  onPick: (name: string) => void
}): JSX.Element {
  const pick = isRoot ? onPick : undefined
  return (
    <div>
      <div className="gql-ex-typehead">
        <span className="gql-ex-kind">{kindLabel(type)}</span>
        <span className="gql-ex-typename mono">{type.name}</span>
      </div>
      {type.description !== undefined && type.description !== null && type.description !== '' && (
        <div className="gql-ex-desc gql-ex-typedesc">{type.description}</div>
      )}

      {isObjectType(type) && type.getInterfaces().length > 0 && (
        <div className="gql-ex-implements mono">
          implements{' '}
          {type.getInterfaces().map((iface, i) => (
            <span key={iface.name}>
              {i > 0 && ', '}
              <button className="gql-type-link" onClick={() => onNav(iface.name)}>
                {iface.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {(isObjectType(type) || isInterfaceType(type)) && (
        <FieldGroup
          title="Fields"
          fields={Object.values(type.getFields())}
          onNav={onNav}
          onPick={pick}
        />
      )}

      {isInputObjectType(type) && (
        <FieldGroup title="Input fields" fields={Object.values(type.getFields())} onNav={onNav} />
      )}

      {isEnumType(type) && (
        <div className="gql-schema-group">
          <div className="gql-schema-title">Values ({type.getValues().length})</div>
          {type.getValues().map((v) => (
            <div key={v.name} className="gql-ex-field">
              <div className="gql-ex-sig mono">
                <span className="gql-field-name">{v.name}</span>
              </div>
              {v.description !== undefined && v.description !== null && v.description !== '' && (
                <div className="gql-ex-desc">{v.description}</div>
              )}
              {v.deprecationReason !== undefined && v.deprecationReason !== null && (
                <div className="gql-ex-deprecated">Deprecated: {v.deprecationReason}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {isUnionType(type) && (
        <div className="gql-schema-group">
          <div className="gql-schema-title">Possible types ({type.getTypes().length})</div>
          <div className="gql-types">
            {type.getTypes().map((m) => (
              <button key={m.name} className="chip gql-type-link" onClick={() => onNav(m.name)}>
                {m.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {isScalarType(type) && <div className="dim-note">Scalar type.</div>}
    </div>
  )
}

/**
 * Browsable schema explorer built on the full `GraphQLSchema` (from
 * buildClientSchema). Drill down from root Query/Mutation/Subscription into
 * types, follow type references, search, and click a root field to insert it.
 */
export default function GqlSchemaExplorer({
  schema,
  onPick
}: {
  schema: GraphQLSchema | null
  onPick: (name: string) => void
}): JSX.Element {
  const [path, setPath] = useState<string[]>([])
  const [search, setSearch] = useState('')

  const rootNames = useMemo(() => {
    const s = new Set<string>()
    if (schema === null) return s
    for (const t of [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()])
      if (t !== null && t !== undefined) s.add(t.name)
    return s
  }, [schema])

  const results = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q === '' || schema === null) return null
    const types: GraphQLNamedType[] = []
    const fields: { type: string; field: string }[] = []
    for (const t of Object.values(schema.getTypeMap())) {
      if (t.name.startsWith('__')) continue
      if (t.name.toLowerCase().includes(q)) types.push(t)
      if (isObjectType(t) || isInterfaceType(t) || isInputObjectType(t)) {
        for (const f of Object.values(t.getFields()))
          if (f.name.toLowerCase().includes(q)) fields.push({ type: t.name, field: f.name })
      }
    }
    return { types: types.slice(0, 60), fields: fields.slice(0, 60) }
  }, [schema, search])

  if (schema === null) {
    return (
      <div className="gql-schema">
        <div className="dim-note">Introspect the schema to browse it.</div>
      </div>
    )
  }

  const nav = (name: string): void => {
    setSearch('')
    setPath((p) => [...p, name])
  }
  const goToDepth = (d: number): void => {
    setSearch('')
    setPath((p) => p.slice(0, d))
  }

  const currentName = path[path.length - 1]
  const currentType = currentName !== undefined ? (schema.getType(currentName) ?? null) : null

  return (
    <div className="gql-schema gql-explorer">
      <input
        className="cell-input gql-ex-search"
        value={search}
        placeholder="Search the schema…"
        onChange={(e) => setSearch(e.target.value)}
      />

      {results !== null ? (
        <div>
          {results.types.length === 0 && results.fields.length === 0 && (
            <div className="dim-note">No matches.</div>
          )}
          {results.types.length > 0 && (
            <div className="gql-schema-group">
              <div className="gql-schema-title">Types ({results.types.length})</div>
              <div className="gql-types">
                {results.types.map((t) => (
                  <button key={t.name} className="chip gql-type-link" onClick={() => nav(t.name)}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {results.fields.length > 0 && (
            <div className="gql-schema-group">
              <div className="gql-schema-title">Fields ({results.fields.length})</div>
              {results.fields.map((f) => (
                <button
                  key={`${f.type}.${f.field}`}
                  className="gql-field mono"
                  title={`Go to ${f.type}`}
                  onClick={() => nav(f.type)}
                >
                  <span className="gql-field-name">{f.field}</span>
                  <span className="gql-field-args"> on {f.type}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : currentType !== null ? (
        <div>
          <div className="gql-ex-crumbs mono">
            <button className="gql-crumb" onClick={() => goToDepth(0)}>
              Schema
            </button>
            {path.map((n, i) => (
              <span key={`${n}-${i}`}>
                <span className="gql-crumb-sep">/</span>
                <button className="gql-crumb" onClick={() => goToDepth(i + 1)}>
                  {n}
                </button>
              </span>
            ))}
          </div>
          <TypeView
            type={currentType}
            isRoot={rootNames.has(currentType.name)}
            onNav={nav}
            onPick={onPick}
          />
        </div>
      ) : (
        <div>
          <FieldGroup
            title="Queries"
            fields={rootFields(schema.getQueryType())}
            onNav={nav}
            onPick={onPick}
          />
          <FieldGroup
            title="Mutations"
            fields={rootFields(schema.getMutationType())}
            onNav={nav}
            onPick={onPick}
          />
          <FieldGroup
            title="Subscriptions"
            fields={rootFields(schema.getSubscriptionType())}
            onNav={nav}
            onPick={onPick}
          />
        </div>
      )}
    </div>
  )
}

function rootFields(
  type: ReturnType<GraphQLSchema['getQueryType']>
): FieldLike[] {
  if (type === null || type === undefined) return []
  return Object.values(type.getFields())
}
