import {describe, expect, it} from 'vitest'
import {
  createStateTargetResolver,
  dereference,
  extractReferences,
  isReferenceValue,
  resolveReferenceTarget,
} from '../../sanity-overlay-core/src/references/index'
import type {VirtualTargetResolver} from '../../sanity-overlay-core/src/references/index'
import {
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  edit,
  resolveDraft,
  resolvePublished,
  unpublish,
} from '../../sanity-overlay-core/src/index'
import type {OverlayState, SanityDocument} from '../../sanity-overlay-core/src/index'
import {
  BASE_DOCUMENTS,
  BASE_PAGE_1,
  BASE_PAGE_2,
  REFERENCE_SCHEMA,
  createTransactionSource,
} from '../src/referenceFixtures'

// Phase 2 workstream W4 — references (plan docs/plans/phase-2-core-domain.md §7).
// PRD §19.1 core rule, §19.2 resolver, §19.5 strong/weak classification,
// §35.6 reference tests.

/* ------------------------------------------------------------------ *
 * §19.1 / §19.5 — reference extraction
 * ------------------------------------------------------------------ */

describe('extractReferences (PRD §19.1, §19.5)', () => {
  it('yields every reference with its OverlayPath, target logical ID and strength', () => {
    const references = extractReferences(BASE_PAGE_1)

    expect(references).toEqual([
      {
        path: ['author'],
        rawRef: 'author-1',
        targetId: 'author-1',
        targetVersion: 'published',
        strength: 'strong',
      },
      {
        path: ['editor'],
        rawRef: 'author-2',
        targetId: 'author-2',
        targetVersion: 'published',
        strength: 'weak',
      },
    ])
  })

  it('records keyed array identity in the path, never a numeric index', () => {
    const references = extractReferences(BASE_PAGE_2)

    expect(references).toHaveLength(1)
    expect(references[0]?.path).toEqual(['related', {_key: 'r1'}])
    expect(references[0]?.targetId).toBe('author-1')
  })

  it('falls back to a numeric index for arrays without _key support', () => {
    const document: SanityDocument = {
      _id: 'page-3',
      _type: 'page',
      tags: [{_type: 'reference', _ref: 'author-1'}],
    }

    expect(extractReferences(document)[0]?.path).toEqual(['tags', 0])
  })

  it('normalizes a drafts. target and keeps the raw _ref', () => {
    const document: SanityDocument = {
      _id: 'page-4',
      _type: 'page',
      author: {_type: 'reference', _ref: 'drafts.author-1'},
    }

    expect(extractReferences(document)[0]).toMatchObject({
      rawRef: 'drafts.author-1',
      targetId: 'author-1',
      targetVersion: 'draft',
    })
  })

  it('walks nested objects and arrays of objects', () => {
    const document: SanityDocument = {
      _id: 'page-5',
      _type: 'page',
      hero: {cta: {_type: 'reference', _ref: 'author-2'}},
      body: [
        {_key: 'b1', _type: 'block', mark: {_type: 'reference', _ref: 'author-1'}},
        {_key: 'b2', _type: 'block'},
      ],
    }

    expect(extractReferences(document).map((reference) => reference.path)).toEqual([
      ['body', {_key: 'b1'}, 'mark'],
      ['hero', 'cta'],
    ])
  })

  it('treats a reference node as a leaf and ignores system fields', () => {
    const document: SanityDocument = {
      _id: 'page-6',
      _type: 'page',
      _rev: 'r1',
      author: {_type: 'reference', _ref: 'author-1', _weak: false, _key: 'ignored'},
    }

    expect(extractReferences(document)).toHaveLength(1)
  })

  it('is deterministic across object key insertion order', () => {
    const a: SanityDocument = {
      _id: 'p',
      _type: 'page',
      zeta: {_type: 'reference', _ref: 'author-2'},
      alpha: {_type: 'reference', _ref: 'author-1'},
    }
    const b: SanityDocument = {
      _id: 'p',
      _type: 'page',
      alpha: {_type: 'reference', _ref: 'author-1'},
      zeta: {_type: 'reference', _ref: 'author-2'},
    }

    expect(extractReferences(a)).toEqual(extractReferences(b))
    expect(extractReferences(a).map((reference) => reference.path)).toEqual([['alpha'], ['zeta']])
  })

  it('returns nothing for a null or reference-free document', () => {
    expect(extractReferences(null)).toEqual([])
    expect(extractReferences({_id: 'a', _type: 'author', name: 'x'})).toEqual([])
  })

  describe('strength classification (PRD §19.5)', () => {
    it('defaults to strong when neither the value nor the schema says otherwise', () => {
      const document: SanityDocument = {
        _id: 'page-7',
        _type: 'page',
        author: {_type: 'reference', _ref: 'author-1'},
      }
      expect(extractReferences(document)[0]?.strength).toBe('strong')
    })

    it('honours a schema-declared weak reference field', () => {
      const document: SanityDocument = {
        _id: 'page-8',
        _type: 'page',
        // No `_weak` on the value: the artifact is the only source of weakness.
        editor: {_type: 'reference', _ref: 'author-2'},
      }

      expect(extractReferences(document, {schema: REFERENCE_SCHEMA})[0]).toMatchObject({
        strength: 'weak',
        weakFromSchema: true,
      })
    })

    it('lets an explicit _weak: false on the value override a weak schema field', () => {
      const document: SanityDocument = {
        _id: 'page-9',
        _type: 'page',
        editor: {_type: 'reference', _ref: 'author-2', _weak: false},
      }

      expect(extractReferences(document, {schema: REFERENCE_SCHEMA})[0]?.strength).toBe('strong')
    })

    it('classifies a schema-weak reference inside a keyed array member', () => {
      const schema = {
        schemaCommit: 'schema-sha-1',
        types: [
          {
            name: 'page',
            fields: [{name: 'related', type: 'array', of: [{type: 'reference', weak: true, to: ['author']}]}],
          },
        ],
      }
      const document: SanityDocument = {
        _id: 'page-10',
        _type: 'page',
        related: [{_key: 'r1', _type: 'reference', _ref: 'author-1'}],
      }

      expect(extractReferences(document, {schema})[0]?.strength).toBe('weak')
    })
  })

  it('recognizes reference values structurally', () => {
    expect(isReferenceValue({_type: 'reference', _ref: 'a'})).toBe(true)
    expect(isReferenceValue({_ref: 'a'})).toBe(true)
    expect(isReferenceValue({_type: 'reference'})).toBe(false)
    expect(isReferenceValue({_ref: 42})).toBe(false)
    expect(isReferenceValue(null)).toBe(false)
    expect(isReferenceValue('author-1')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * §19.2 — virtual target resolution
 * ------------------------------------------------------------------ */

const base = createBaseSource(BASE_DOCUMENTS)
const tx = createTransactionSource()

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-w4'})
}

/** Edit `author-1`'s name locally; `edit` writes a local draft (PRD §18.4). */
function withEditedAuthor(state: OverlayState = emptyState()): OverlayState {
  return edit(
    state,
    {id: 'author-1', operations: [{type: 'set', path: ['name'], value: 'Grace B. Hopper'}]},
    {...tx(), base},
  ).state
}

function resolvedPage(state: OverlayState, id: string): SanityDocument {
  const resolved = resolvePublished(state, id, {base})
  if (resolved === null) throw new Error(`fixture: ${id} did not resolve`)
  return resolved
}

describe('resolveReferenceTarget (PRD §19.2)', () => {
  it('step 1 — normalizes the target logical ID before anything else', () => {
    const resolved = resolveReferenceTarget(emptyState(), 'drafts.author-1', {
      base,
      perspective: 'published',
    })

    expect(resolved.requestedId).toBe('drafts.author-1')
    expect(resolved.targetId).toBe('author-1')
    expect(resolved.origin).toBe('base')
  })

  it('step 2 — an applicable local tombstone wins over every later step', () => {
    const state = deleteDocument(emptyState(), {id: 'author-1'}, {...tx(), base}).state
    const resolved = resolveReferenceTarget(state, 'author-1', {base, perspective: 'published'})

    expect(resolved.origin).toBe('local-tombstone')
    expect(resolved.available).toBe(false)
    expect(resolved.document).toBeNull()
    expect(resolved.missing).toEqual({
      targetId: 'author-1',
      perspective: 'published',
      reason: 'tombstoned',
    })
  })

  it('step 2 — a published tombstone does not suppress the drafts perspective', () => {
    const state = unpublish(emptyState(), {id: 'author-1'}, {...tx(), base}).state

    expect(resolveReferenceTarget(state, 'author-1', {base, perspective: 'published'}).origin).toBe(
      'local-tombstone',
    )
    expect(resolveReferenceTarget(state, 'author-1', {base, perspective: 'drafts'}).origin).toBe(
      'local-modified',
    )
  })

  it('step 3 — a branch-created target resolves as branch-created', () => {
    const state = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'author-3', _type: 'author', name: 'Ada Lovelace'}}],
      {...tx(), base},
    ).state
    const resolved = resolveReferenceTarget(state, 'author-3', {base, perspective: 'published'})

    expect(resolved.origin).toBe('branch-created')
    expect(resolved.available).toBe(true)
    expect(resolved.document?.name).toBe('Ada Lovelace')
  })

  it('step 3 — a locally modified base target resolves as locally modified', () => {
    const resolved = resolveReferenceTarget(withEditedAuthor(), 'author-1', {
      base,
      perspective: 'drafts',
    })

    expect(resolved.origin).toBe('local-modified')
    expect(resolved.document?.name).toBe('Grace B. Hopper')
  })

  it('step 4 — falls back to the current base target', () => {
    const resolved = resolveReferenceTarget(emptyState(), 'author-2', {
      base,
      perspective: 'published',
    })

    expect(resolved.origin).toBe('base')
    expect(resolved.document?.name).toBe('Alan Turing')
  })

  it('step 5 — returns missing-reference metadata when the target is absent', () => {
    const resolved = resolveReferenceTarget(emptyState(), 'author-404', {
      base,
      perspective: 'published',
    })

    expect(resolved.origin).toBe('missing')
    expect(resolved.available).toBe(false)
    expect(resolved.missing).toEqual({
      targetId: 'author-404',
      perspective: 'published',
      reason: 'not-found',
    })
  })

  it('step 6 — applies the requested perspective to the target', () => {
    const state = withEditedAuthor()

    expect(
      resolveReferenceTarget(state, 'author-1', {base, perspective: 'published'}).document?.name,
    ).toBe('Grace Hopper')
    expect(
      resolveReferenceTarget(state, 'author-1', {base, perspective: 'drafts'}).document?.name,
    ).toBe('Grace B. Hopper')
  })

  it('step 6 — delegates to the injected resolver port', () => {
    const calls: Array<{logicalId: string; perspective: string}> = []
    const resolveTarget: VirtualTargetResolver = (request) => {
      calls.push({logicalId: request.logicalId, perspective: request.perspective})
      return {_id: request.logicalId, _type: 'author', name: 'from-port'}
    }

    const resolved = resolveReferenceTarget(emptyState(), 'author-1', {
      base,
      perspective: 'drafts',
      resolveTarget,
    })

    expect(resolved.document?.name).toBe('from-port')
    expect(calls).toContainEqual({logicalId: 'author-1', perspective: 'drafts'})
  })

  it('defaults to the drafts perspective', () => {
    expect(resolveReferenceTarget(withEditedAuthor(), 'author-1', {base}).document?.name).toBe(
      'Grace B. Hopper',
    )
  })

  it('reports a draft-only target (PRD §19.5, invariant §34.10)', () => {
    const state = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'drafts.author-9', _type: 'author', name: 'Draft only'}}],
      {...tx(), base},
    ).state

    const resolved = resolveReferenceTarget(state, 'author-9', {base, perspective: 'drafts'})
    expect(resolved.draftOnly).toBe(true)
    expect(resolved.publishedAvailable).toBe(false)
    expect(
      resolveReferenceTarget(state, 'author-9', {base, perspective: 'published'}).available,
    ).toBe(false)
  })

  it('a base-backed target is not draft-only', () => {
    expect(resolveReferenceTarget(emptyState(), 'author-1', {base}).draftOnly).toBe(false)
  })

  it('createStateTargetResolver is the default step-6 port', () => {
    const resolver = createStateTargetResolver(withEditedAuthor(), {base})

    expect(resolver({logicalId: 'author-1', perspective: 'drafts'})?.name).toBe('Grace B. Hopper')
    expect(resolver({logicalId: 'author-1', perspective: 'published'})?.name).toBe('Grace Hopper')
    expect(resolver({logicalId: 'nope', perspective: 'published'})).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * PRD §35.6 reference tests — cases 1 to 4
 * ------------------------------------------------------------------ */

describe('PRD §35.6 reference tests (1-4)', () => {
  it('1. local target edit changes dereference everywhere', () => {
    const state = withEditedAuthor()

    const fromPage1 = extractReferences(resolvedPage(state, 'page-1'))[0]!
    const fromPage2 = extractReferences(resolvedPage(state, 'page-2'))[0]!

    expect(dereference(state, fromPage1, {base, perspective: 'drafts'}).document?.name).toBe(
      'Grace B. Hopper',
    )
    expect(dereference(state, fromPage2, {base, perspective: 'drafts'}).document?.name).toBe(
      'Grace B. Hopper',
    )
  })

  it('2. parent documents are not rewritten for a target field edit (PRD §19.1)', () => {
    const before = emptyState()
    const after = withEditedAuthor(before)

    // No record was created for either referring document.
    expect(Object.keys(after.documents)).toEqual(['author-1'])
    expect(after.documents['page-1']).toBeUndefined()
    expect(after.documents['page-2']).toBeUndefined()

    // And the resolved parents are unchanged.
    expect(resolvePublished(after, 'page-1', {base})).toEqual(BASE_PAGE_1)
    expect(resolvePublished(after, 'page-2', {base})).toEqual(BASE_PAGE_2)
    expect(extractReferences(resolvedPage(after, 'page-1'))).toEqual(
      extractReferences(resolvedPage(before, 'page-1')),
    )
  })

  it('3. branch-created target is selectable and dereferenceable', () => {
    let state = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'author-3', _type: 'author', name: 'Ada Lovelace'}}],
      {...tx(), base},
    ).state
    state = edit(
      state,
      {
        id: 'page-1',
        operations: [{type: 'set', path: ['author'], value: {_type: 'reference', _ref: 'author-3'}}],
      },
      {...tx(), base},
    ).state

    // `edit` writes a local draft (§18.4), so the new reference lives on the
    // drafts perspective of the parent.
    const parent = resolveDraft(state, 'page-1', {base})
    const reference = extractReferences(parent).find((candidate) => candidate.path[0] === 'author')
    expect(reference?.targetId).toBe('author-3')

    const target = dereference(state, reference!, {base, perspective: 'published'})
    expect(target.origin).toBe('branch-created')
    expect(target.available).toBe(true)
    expect(target.document?.name).toBe('Ada Lovelace')
  })

  it('4. local target tombstone creates a missing reference', () => {
    const state = deleteDocument(emptyState(), {id: 'author-1'}, {...tx(), base}).state
    const reference = extractReferences(BASE_PAGE_1)[0]!

    const target = dereference(state, reference, {base, perspective: 'published'})
    expect(target.available).toBe(false)
    expect(target.missing?.reason).toBe('tombstoned')
    expect(target.origin).toBe('local-tombstone')
  })
})
