/**
 * `sanity-overlay-next` — the Studio-dialect translator (PRD §13.6, §13.7, §18).
 *
 * WHY THIS UNIT EXISTS IN A SHIPPED PACKAGE
 * The local API receives what Studio's write facade intercepted: an Actions API
 * payload or a raw `/data/mutate` body. Neither is a PRD §13.7 mutation, and
 * core will not guess. Something has to translate, and it has to be the party
 * that owns the endpoint — so it lives beside the endpoint.
 *
 * `examples/kitchen-sink/spikeA/overlayTranslate.ts` proved the shape. It is
 * spike code (PRD §0.6) and is NOT imported here: this file drives an
 * independent rewrite, and the two are free to diverge. Where the spike had to
 * re-declare the §13.7 union to stay dependency-free for a browser bundle, this
 * one imports it from `sanity-overlay-core`, so a drift in the mutation shape is
 * a compile error rather than a runtime surprise inside `applyTransaction`.
 *
 * Assertion discipline: every expectation below is a hand-written literal of
 * what the PRD says the result must be. Nothing is compared against a value the
 * translator computed.
 */
import {describe, expect, it} from 'vitest'
import {
  parseSanityPath,
  translateDocumentActions,
  translateInterceptedWrite,
} from '../../sanity-overlay-next/src/index'

describe('parseSanityPath — PRD §13.6 path decoding', () => {
  it('reads named fields, numeric indexes and _key predicates', () => {
    expect(parseSanityPath('title')).toEqual(['title'])
    expect(parseSanityPath('meta.seo.title')).toEqual(['meta', 'seo', 'title'])
    expect(parseSanityPath('body[0]')).toEqual(['body', 0])
    expect(parseSanityPath('body[-1]')).toEqual(['body', -1])
    expect(parseSanityPath('body[_key=="abc"]')).toEqual(['body', {_key: 'abc'}])
    expect(parseSanityPath("body[_key=='abc'].children[2].text")).toEqual([
      'body',
      {_key: 'abc'},
      'children',
      2,
      'text',
    ])
  })

  it('refuses an accessor whose semantics it would have to guess', () => {
    /* §5.5 — silent approximation is the defect. A slice, a filter or a bare
     * `[]` selects a SET of positions; translating it to any single path would
     * write to the wrong element and look like it worked. */
    expect(() => parseSanityPath('body[]')).toThrow(/unsupported path accessor/)
    expect(() => parseSanityPath('body[0:2]')).toThrow(/unsupported path accessor/)
    expect(() => parseSanityPath('body[_type=="block"]')).toThrow(/unsupported path accessor/)
    expect(() => parseSanityPath('body[0')).toThrow(/unbalanced/)
    expect(() => parseSanityPath('')).toThrow(/non-empty string/)
  })
})

describe('translateInterceptedWrite — raw /data/mutate bodies', () => {
  const mutate = (payload: unknown) => translateInterceptedWrite({kind: 'mutations', payload})

  it('carries create, createIfNotExists, createOrReplace and delete straight through', () => {
    const doc = {_id: 'drafts.a', _type: 'article', title: 'A'}
    expect(mutate([{create: doc}]).mutations).toEqual([{type: 'create', document: doc}])
    expect(mutate([{createIfNotExists: doc}]).mutations).toEqual([
      {type: 'createIfNotExists', document: doc},
    ])
    expect(mutate([{createOrReplace: doc}]).mutations).toEqual([
      {type: 'createOrReplace', document: doc},
    ])
    expect(mutate([{delete: {id: 'a'}}]).mutations).toEqual([{type: 'delete', id: 'a'}])
  })

  it('refuses a create with no _type, because §13.9 identity needs one', () => {
    const result = mutate([{create: {_id: 'drafts.a', title: 'A'}}])
    expect(result.mutations).toEqual([])
    expect(result.unsupported).toEqual([expect.stringContaining('_type')])
  })

  it('refuses delete-by-query and patch-by-query rather than widening them', () => {
    expect(mutate([{delete: {query: '*[_type == "article"]'}}]).unsupported).toEqual([
      expect.stringContaining('delete by query'),
    ])
    expect(mutate([{patch: {query: '*[_type == "article"]', set: {a: 1}}}]).unsupported).toEqual([
      expect.stringContaining('patch by query'),
    ])
  })

  it('emits patch operations in Content Lake apply order, not object order', () => {
    /* `applyOperations` in core is order-sensitive, so this is behaviour. The
     * source object below deliberately lists them in the OPPOSITE order. */
    const result = mutate([
      {
        patch: {
          id: 'drafts.a',
          diffMatchPatch: {body: '@@ -1 +1 @@'},
          insert: {after: 'items[-1]', items: [{_key: 'k'}]},
          inc: {views: 2},
          set: {title: 'new'},
          unset: ['old'],
          setIfMissing: {meta: {}},
        },
      },
    ])
    expect(result.mutations).toEqual([
      {
        type: 'patch',
        id: 'drafts.a',
        operations: [
          {type: 'setIfMissing', path: ['meta'], value: {}},
          {type: 'unset', path: ['old']},
          {type: 'set', path: ['title'], value: 'new'},
          {type: 'inc', path: ['views'], amount: 2},
          {type: 'insert', path: ['items', -1], position: 'after', items: [{_key: 'k'}]},
          {type: 'diffMatchPatch', path: ['body'], patch: '@@ -1 +1 @@'},
        ],
      },
    ])
  })

  it('drops the empty-action guard pseudo field and the patch it is alone in', () => {
    /* Studio prepends an unset of this field so an empty edit still forms a
     * legal patch. It is transport, not content: a zero-operation patch would
     * still bump the overlay revision and rewrite intent.json, breaking the
     * §14.3 "diff shows semantic change only" rule. */
    const guard = '_empty_action_guard_pseudo_field_'
    expect(mutate([{patch: {id: 'drafts.a', unset: [guard]}}]).mutations).toEqual([])
    expect(mutate([{patch: {id: 'drafts.a', unset: [`${guard}.nested`]}}]).mutations).toEqual([])
    expect(
      mutate([{patch: {id: 'drafts.a', unset: [guard], set: {title: 'x'}}}]).mutations,
    ).toEqual([
      {type: 'patch', id: 'drafts.a', operations: [{type: 'set', path: ['title'], value: 'x'}]},
    ])
  })

  it('drops the Content Lake revision precondition, which cannot hold here', () => {
    /* The overlay stamps synthetic revisions (§13.9) in a different revision
     * space, so an `ifRevisionID` from Content Lake can only ever fail. */
    const result = mutate([{patch: {id: 'drafts.a', ifRevisionID: 'abc', set: {title: 'x'}}}])
    expect(result.unsupported).toEqual([])
    expect(result.mutations).toEqual([
      {type: 'patch', id: 'drafts.a', operations: [{type: 'set', path: ['title'], value: 'x'}]},
    ])
  })

  it('reports an unrecognised patch key instead of ignoring it', () => {
    expect(mutate([{patch: {id: 'drafts.a', reverse: true}}]).unsupported).toEqual([
      expect.stringContaining('reverse'),
    ])
  })

  it('records the perspective-qualified ids the write touched, in first-seen order', () => {
    /* The caller ships base documents for these ids, so the server can capture
     * a merge ancestor on first touch (§13.3). Order is first-seen, and an id
     * is not repeated. */
    const result = mutate([
      {patch: {id: 'drafts.b', set: {t: 1}}},
      {patch: {id: 'drafts.a', set: {t: 1}}},
      {patch: {id: 'drafts.b', set: {t: 2}}},
    ])
    expect(result.documentIds).toEqual(['drafts.b', 'drafts.a'])
  })

  it('accepts the transaction envelope Studio actually posts', () => {
    /* `dataRequest('mutate', {mutations, transactionId})` — the array is nested. */
    expect(
      mutate({mutations: [{delete: {id: 'a'}}], transactionId: 't1'}).mutations,
    ).toEqual([{type: 'delete', id: 'a'}])
  })
})

describe('translateInterceptedWrite — Actions API payloads', () => {
  const actions = (payload: unknown) => translateInterceptedWrite({kind: 'actions', payload})

  it('turns an edit action into a patch on the version it names', () => {
    const result = actions([
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.a',
        publishedId: 'a',
        patch: {set: {title: 'x'}},
      },
    ])
    expect(result.mutations).toEqual([
      {type: 'patch', id: 'drafts.a', operations: [{type: 'set', path: ['title'], value: 'x'}]},
    ])
  })

  it('prefers versionId over draftId over publishedId as the patch target', () => {
    const result = actions([
      {
        actionType: 'sanity.action.document.version.replace',
        versionId: 'versions.r1.a',
        draftId: 'drafts.a',
        publishedId: 'a',
        patch: {set: {title: 'x'}},
      },
    ])
    expect(result.mutations[0]).toMatchObject({type: 'patch', id: 'versions.r1.a'})
  })

  it('reads `ifExists: ignore` as createIfNotExists', () => {
    const attributes = {_id: 'drafts.a', _type: 'article'}
    expect(
      actions([{actionType: 'sanity.action.document.create', attributes}]).mutations,
    ).toEqual([{type: 'create', document: attributes}])
    expect(
      actions([{actionType: 'sanity.action.document.create', attributes, ifExists: 'ignore'}])
        .mutations,
    ).toEqual([{type: 'createIfNotExists', document: attributes}])
  })

  it('keys a delete action on the logical id, because it tombstones both perspectives', () => {
    const result = actions([
      {actionType: 'sanity.action.document.delete', publishedId: 'a', draftId: 'drafts.a'},
    ])
    expect(result.mutations).toEqual([{type: 'delete', id: 'a'}])
  })

  it('refuses to translate a document action into a mutation, and says why', () => {
    /* publish/unpublish/discard are §18.4-§18.9 state transitions, not §13.7
     * mutations. Collapsing them here would re-derive §18 semantics core owns. */
    for (const actionType of [
      'sanity.action.document.publish',
      'sanity.action.document.unpublish',
      'sanity.action.document.discard',
    ]) {
      const result = actions([{actionType, publishedId: 'a'}])
      expect(result.mutations).toEqual([])
      expect(result.unsupported).toEqual([expect.stringContaining('document action')])
    }
  })
})

describe('translateDocumentActions — the §18.4-§18.9 reducer half', () => {
  it('names the reducer for each Studio action, keyed on the logical id', () => {
    expect(
      translateDocumentActions([
        {actionType: 'sanity.action.document.publish', draftId: 'drafts.a'},
        {actionType: 'sanity.action.document.unpublish', publishedId: 'b'},
        {actionType: 'sanity.action.document.discard', versionId: 'versions.r1.c'},
        {actionType: 'sanity.action.document.delete', publishedId: 'd'},
      ]).steps,
    ).toEqual([
      {type: 'publish', id: 'a'},
      {type: 'unpublish', id: 'b'},
      {type: 'discardDraft', id: 'c'},
      {type: 'delete', id: 'd'},
    ])
  })

  it('turns replaceDraft into a restore carrying the body to come back to', () => {
    expect(
      translateDocumentActions([
        {
          actionType: 'sanity.action.document.replaceDraft',
          publishedId: 'a',
          attributes: {_id: 'drafts.a', _type: 'article', title: 'old'},
        },
      ]).steps,
    ).toEqual([
      {
        type: 'restore',
        id: 'a',
        target: 'draft',
        document: {_id: 'drafts.a', _type: 'article', title: 'old'},
      },
    ])
  })

  it('translates the overlay duplicate action', () => {
    const result = translateDocumentActions([
      {actionType: 'sanity.overlay.document.duplicate', publishedId: 'a', newId: 'drafts.b'},
    ])
    expect(result.steps).toEqual([{type: 'duplicate', id: 'a', newId: 'b'}])
    expect(result.documentIds).toEqual(['a', 'b'])
  })

  it('refuses a mutation routed to the action translator', () => {
    const result = translateDocumentActions([
      {actionType: 'sanity.action.document.edit', draftId: 'drafts.a', patch: {set: {t: 1}}},
    ])
    expect(result.steps).toEqual([])
    expect(result.unsupported).toEqual([expect.stringContaining('not a document action')])
  })
})

describe('an unknown interception point is reported, never guessed at', () => {
  it('returns no mutations and one reason', () => {
    const result = translateInterceptedWrite({
      kind: 'telepathy' as unknown as 'mutations',
      payload: [],
    })
    expect(result.mutations).toEqual([])
    expect(result.unsupported).toEqual([expect.stringContaining('telepathy')])
  })
})
