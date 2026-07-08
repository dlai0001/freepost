import { describe, expect, it } from 'vitest'
import { detectOperationType } from './operation'

describe('detectOperationType', () => {
  it('detects query, mutation, and subscription', () => {
    expect(detectOperationType('query { me { id } }')).toBe('query')
    expect(detectOperationType('mutation { logout }')).toBe('mutation')
    expect(detectOperationType('subscription { onMessage { id } }')).toBe('subscription')
  })

  it('treats a shorthand selection set as a query', () => {
    expect(detectOperationType('{ me { id } }')).toBe('query')
  })

  it('returns null for an empty or fragment-only document', () => {
    expect(detectOperationType('')).toBeNull()
    expect(detectOperationType('   ')).toBeNull()
    expect(detectOperationType('fragment F on User { id }')).toBeNull()
  })

  it('returns null on a parse error', () => {
    expect(detectOperationType('subscription { onMessage')).toBeNull()
    expect(detectOperationType('not graphql at all !!!')).toBeNull()
  })

  it('uses the first operation when no name is given', () => {
    const doc = 'query A { a } subscription B { b }'
    expect(detectOperationType(doc)).toBe('query')
  })

  it('selects the named operation when multiple are present', () => {
    const doc = 'query A { a } subscription B { b }'
    expect(detectOperationType(doc, 'B')).toBe('subscription')
    expect(detectOperationType(doc, 'A')).toBe('query')
  })

  it('returns null when the named operation is absent', () => {
    expect(detectOperationType('query A { a }', 'Z')).toBeNull()
  })
})
