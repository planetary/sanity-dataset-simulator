/**
 * `sanity-overlay-next` — a write that cannot be stored faithfully must never be
 * answered `committed: true` (PRD §5.5).
 *
 * THE DEFECT THIS FILE PINS
 * `docs/plans/evidence/phase-1/security-review-2026-08-06.md` P2-5: a Studio
 * patch whose path is `__proto__.polluted` reached `/commit`, was answered
 * `{ok: true, committed: true, unsupported: []}`, wrote a bogus `$.__proto__`
 * into the reviewer-facing `intent.json`, and stored **no value at all**. A
 * sibling — `a.__proto__.b` — persisted `"a": {}`, i.e. the write was replaced by
 * a different, wrong one and still reported as committed.
 *
 * That is not prototype pollution — the review proved `Object.prototype` is
 * unreachable and this file re-checks it — it is the SILENT APPROXIMATION §5.5
 * forbids, and it is the same failure shape as the Unicode data loss found
 * earlier: the editor sees "saved" for content that exists nowhere.
 *
 * WHY REFUSE RATHER THAN STORE
 * Storing faithfully is not available. §35.14 makes `__proto__`, `constructor`
 * and `prototype` illegal own keys in canonical overlay JSON, and the store
 * writes every byte through `serialize()` — so a document holding one can never
 * reach disk. §13.6 defines a path segment as naming an object property, and a
 * property the canonical format cannot represent is not an addressable member.
 * The only §5.5-legal answer is a refusal the caller can see, which for this API
 * means the `unsupported` channel (a declared, wire-visible reason) or a coded
 * error — never a silent drop under a `committed: true`.
 *
 * WHAT "THE CLASS" MEANS HERE
 * Not "the `set` operation". Every patch key that carries a path, every position
 * a forbidden segment can occupy, every create-shaped mutation whose body can
 * carry a forbidden own key, both interception dialects (`actions` and
 * `mutations`), and the mixed case where a legal operation shares a patch with an
 * illegal one.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayApi} from '../../sanity-overlay-next/src/index'
import type {OverlayApi} from '../../sanity-overlay-next/src/index'
import {
  parseSanityPath,
  translateActions,
  translateMutations,
} from '../../sanity-overlay-next/src/translate'

type Rec = Record<string, unknown>

const OVERLAY_ID = 'next-proto-overlay-000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const apis: OverlayApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 7, 6, 0, 0, tick)).toISOString()
  }
}

async function boot(): Promise<{api: OverlayApi; root: string}> {
  const root = await mkdtemp(join(tmpdir(), 'next-proto-'))
  roots.push(root)
  const now = makeClock()
  const api = await createOverlayApi({
    store: new FsOverlayStore({root, now}),
    overlayId: OVERLAY_ID,
    now,
    origins: [STUDIO_ORIGIN],
  })
  apis.push(api)
  return {api, root}
}

async function commit(api: OverlayApi, body: unknown): Promise<{status: number; json: Rec}> {
  const response = await api.handle(
    new Request('http://localhost:3998/commit', {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: JSON.stringify(body),
    }),
  )
  return {status: response.status, json: (await response.json()) as Rec}
}

async function readIntent(root: string, logicalId: string): Promise<string | null> {
  try {
    return await readFile(
      join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json'),
      'utf8',
    )
  } catch {
    return null
  }
}

/** The own-key spelling `JSON.parse` produces. An object literal would swap instead. */
function bodyWithOwnProtoKey(id: string): Rec {
  const document = JSON.parse(
    `{"_id": ${JSON.stringify(id)}, "_type": "article", "keep": 2, "__proto__": {"isAdmin": true}}`,
  ) as Rec
  return document
}

/* ------------------------------------------------------------------ *
 * 1. The translator refuses the path rather than producing one
 * ------------------------------------------------------------------ */

const FORBIDDEN_PATH_SPELLINGS = [
  '__proto__',
  '__proto__.polluted',
  'a.__proto__.b',
  'a.__proto__',
  'constructor',
  'constructor.prototype.polluted',
  'prototype',
  'a.prototype.b',
  'a.constructor.b',
  'list[0].__proto__',
  'list[_key=="k1"].__proto__',
]

describe('parseSanityPath refuses a §35.14 key in any segment', () => {
  for (const spelling of FORBIDDEN_PATH_SPELLINGS) {
    it(`refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => parseSanityPath(spelling)).toThrowError(/prototype|__proto__|constructor/i)
    })
  }

  it('still parses the paths Studio actually emits', () => {
    expect(parseSanityPath('title')).toEqual(['title'])
    expect(parseSanityPath('body[0].text')).toEqual(['body', 0, 'text'])
    expect(parseSanityPath('body[_key=="a"].children[-1]')).toEqual([
      'body',
      {_key: 'a'},
      'children',
      -1,
    ])
    /* A field whose NAME merely contains a forbidden word is ordinary content. */
    expect(parseSanityPath('constructorName')).toEqual(['constructorName'])
    expect(parseSanityPath('myPrototype')).toEqual(['myPrototype'])
  })

  it('accepts a `_key` VALUE that spells a forbidden word — that is data', () => {
    expect(parseSanityPath('items[_key=="__proto__"].label')).toEqual([
      'items',
      {_key: '__proto__'},
      'label',
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 2. Every patch key that carries a path declares the refusal
 * ------------------------------------------------------------------ */

const PATCH_BODIES: Array<[string, Rec]> = [
  ['set', {set: {'__proto__.polluted': 'x'}}],
  ['setIfMissing', {setIfMissing: {'__proto__.polluted': 'x'}}],
  ['unset', {unset: ['__proto__.polluted']}],
  ['inc', {inc: {'__proto__.polluted': 1}}],
  ['dec', {dec: {'__proto__.polluted': 1}}],
  ['diffMatchPatch', {diffMatchPatch: {'__proto__.polluted': '@@ -1 +1 @@\n-a\n+b\n'}}],
  ['insert', {insert: {after: '__proto__.list[-1]', items: [{_key: 'k'}]}}],
]

describe('translateMutations declares every forbidden patch path in `unsupported`', () => {
  for (const [key, patch] of PATCH_BODIES) {
    it(`patch.${key} produces no mutation and one declared reason`, () => {
      const result = translateMutations([{patch: {id: 'article-1', ...patch}}])
      expect(result.mutations).toEqual([])
      expect(result.unsupported.length).toBeGreaterThan(0)
      expect(result.unsupported.join(' ')).toMatch(/__proto__/)
    })
  }

  it('declares the refusal on the actions dialect too', () => {
    const result = translateActions([
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
        patch: {set: {'__proto__.polluted': 'x'}},
      },
    ])
    expect(result.mutations).toEqual([])
    expect(result.unsupported.join(' ')).toMatch(/__proto__/)
  })

  it('keeps the legal half of a mixed patch and still declares the illegal half', () => {
    const result = translateMutations([
      {patch: {id: 'article-1', set: {title: 'kept', '__proto__.polluted': 'x'}}},
    ])
    expect(result.mutations).toHaveLength(1)
    expect(result.unsupported.join(' ')).toMatch(/__proto__/)
  })
})

/* ------------------------------------------------------------------ *
 * 3. `/commit` — the load-bearing assertion
 * ------------------------------------------------------------------ */

describe('POST /commit never answers `committed: true` for a write it discarded', () => {
  it('refuses a `__proto__.polluted` patch', async () => {
    const {api, root} = await boot()
    const {json} = await commit(api, {
      idempotencyKey: 'proto-1',
      kind: 'mutations',
      payload: [
        {createOrReplace: {_id: 'article-1', _type: 'article', title: 'seed'}},
        {patch: {id: 'article-1', set: {'__proto__.polluted': 'yes'}}},
      ],
    })

    expect(json.unsupported).not.toEqual([])
    expect(String((json.unsupported as string[]).join(' '))).toMatch(/__proto__/)

    /* The bogus touched path the review found in the reviewer-facing file. */
    const intent = await readIntent(root, 'article-1')
    if (intent !== null) expect(intent).not.toMatch(/__proto__/)
  })

  it('refuses `a.__proto__.b` rather than persisting `a` as an empty object', async () => {
    const {api, root} = await boot()
    await commit(api, {
      idempotencyKey: 'seed-2',
      kind: 'mutations',
      payload: [{createOrReplace: {_id: 'article-2', _type: 'article', title: 'seed'}}],
    })
    const {json} = await commit(api, {
      idempotencyKey: 'proto-2',
      kind: 'mutations',
      payload: [{patch: {id: 'article-2', set: {'a.__proto__.b': 'yes'}}}],
    })

    expect(String((json.unsupported as string[]).join(' '))).toMatch(/__proto__/)
    expect(json.committed).not.toBe(true)

    const intent = await readIntent(root, 'article-2')
    /* `"a": {}` is the write REPLACED BY A DIFFERENT ONE, which §5.5 rules out
     * just as firmly as dropping it. */
    if (intent !== null) expect(intent).not.toMatch(/"a"\s*:\s*\{\s*\}/)
  })

  it('refuses a create whose body carries a forbidden own key', async () => {
    const {api, root} = await boot()
    const {json} = await commit(api, {
      idempotencyKey: 'proto-3',
      kind: 'mutations',
      payload: [{createOrReplace: bodyWithOwnProtoKey('article-3')}],
    })

    /* Either a coded refusal or a declared `unsupported`, but NEVER a silent
     * `committed: true` with `isAdmin` gone. */
    const declared =
      json.ok === false || (Array.isArray(json.unsupported) && json.unsupported.length > 0)
    expect(declared).toBe(true)
    expect(json.committed).not.toBe(true)

    const intent = await readIntent(root, 'article-3')
    expect(intent).toBeNull()
  })

  it('reports the refusal with the §35.14 code, not a generic 500', async () => {
    const {api} = await boot()
    const {status, json} = await commit(api, {
      idempotencyKey: 'proto-4',
      kind: 'mutations',
      payload: [{createOrReplace: bodyWithOwnProtoKey('article-4')}],
    })
    expect(json.ok).toBe(false)
    expect(status).toBeLessThan(500)
    expect((json.error as Rec).code).toBe('OVERLAY_PROTOTYPE_KEY_REJECTED')
  })

  it('a document id spelling a prototype key is a coded refusal, not a 500', async () => {
    const {api} = await boot()
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const {status, json} = await commit(api, {
        idempotencyKey: `proto-id-${id}`,
        kind: 'mutations',
        payload: [{patch: {id, set: {title: 'x'}}}],
      })
      /* An uncoded HTTP 500 is unattributable — the caller cannot tell a bad
       * request from a broken server (review P3-10). */
      expect(status).not.toBe(500)
      if (json.ok === false) expect((json.error as Rec).code).not.toBe('INTERNAL')
    }
  })

  it('the documentActions path reads no record off the prototype chain either', async () => {
    /* Same class, second entry point. `commitDocumentActions` looks a `restore`
     * step's target up in the document map directly, so a caller-supplied id of
     * `__proto__` resolved to `Object.prototype` and was then interrogated for
     * `local.draftTombstone`. */
    const {api} = await boot()
    for (const id of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      for (const actionType of [
        'sanity.action.document.replaceDraft',
        'sanity.action.document.publish',
        'sanity.action.document.delete',
      ]) {
        const {status, json} = await commit(api, {
          idempotencyKey: `proto-action-${actionType}-${id}`,
          kind: 'documentActions',
          payload: [
            {
              actionType,
              publishedId: id,
              attributes: {_id: id, _type: 'article', title: 'x'},
            },
          ],
        })
        expect(status).not.toBe(500)
        if (json.ok === false) expect((json.error as Rec).code).not.toBe('INTERNAL')
      }
    }
  })

  it('still commits an ordinary edit — the guard is about the key, not about patching', async () => {
    const {api, root} = await boot()
    const {json} = await commit(api, {
      idempotencyKey: 'ok-1',
      kind: 'mutations',
      payload: [
        {createOrReplace: {_id: 'article-9', _type: 'article', title: 'seed'}},
        {patch: {id: 'article-9', set: {title: 'edited'}}},
      ],
    })
    expect(json.committed).toBe(true)
    expect(json.unsupported).toEqual([])
    expect(await readIntent(root, 'article-9')).toMatch(/edited/)
  })
})

describe('Object.prototype is still unreachable from every vector above', () => {
  it('is clean', () => {
    const proto = Object.prototype as unknown as Rec
    expect(proto.polluted).toBeUndefined()
    expect(proto.isAdmin).toBeUndefined()
    expect(proto.b).toBeUndefined()
  })
})
