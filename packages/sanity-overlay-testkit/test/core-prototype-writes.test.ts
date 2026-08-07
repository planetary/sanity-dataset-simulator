/**
 * §35.14 prototype keys, on the WRITE paths — not just on `serialize`/`parse`.
 *
 * WHY THIS FILE EXISTS
 * `core-w1.test.ts` proves `serialize()`/`parse()` reject `__proto__`,
 * `constructor` and `prototype`. Nothing proved the same for a key arriving as a
 * PATCH PATH SEGMENT or as an own key of a mutation's document body, and the
 * §5.5 security review (`docs/plans/evidence/phase-1/security-review-2026-08-06.md`
 * P2-5) showed the difference matters: a `set` at `__proto__.polluted` was
 * applied, answered success, and stored **nothing**.
 *
 * The mechanism is `deepClone` and `descend`'s `out[key] = …`: for the single
 * key `__proto__` a plain assignment runs `Object.prototype`'s `__proto__`
 * SETTER instead of creating an own property, so the value becomes a prototype
 * swap that `Object.keys` and `Object.getOwnPropertyNames` can no longer see.
 * The write is destroyed rather than refused, and the canonical serializer's
 * §35.14 guard never gets a chance to fire because there is no own key left to
 * find.
 *
 * THE CONTRACT THESE TESTS PIN
 *
 *   1. A forbidden key anywhere in an operation path is REFUSED with a coded
 *      error. §13.6 says a path segment names an object property; §35.14 says
 *      these three property names can never appear in canonical overlay JSON. A
 *      path that names one therefore addresses a member the format cannot hold,
 *      and §5.5 leaves exactly one legal answer: refuse, loudly.
 *   2. `deepClone` never converts an own key into a prototype swap. A forbidden
 *      own key SURVIVES the clone so the §35.14 guard in `serialize()` can
 *      reject it — one refactor of the apply path must not be able to make the
 *      protection vanish silently, which is what the review flagged.
 *   3. A prototype-chain read on the record map is not a document. `_id:
 *      "__proto__"` must resolve to "no such record", not to `Object.prototype`.
 *   4. `Object.prototype` is never polluted. This is the regression guard, not
 *      the headline: the review proved pollution is unreachable and this keeps it
 *      that way while the above change how the same input is refused.
 */
import {describe, expect, it} from 'vitest'
import {
  applyTransaction,
  createBaseSource,
  createOverlayState,
  FORBIDDEN_KEYS,
  getRecord,
  isForbiddenKey,
  serialize,
} from '../../sanity-overlay-core/src/index'
import type {OverlayMutation, OverlayOperation} from '../../sanity-overlay-core/src/index'
import {deepClone} from '../../sanity-overlay-core/src/mutations/paths'
import {applyOperation} from '../../sanity-overlay-core/src/mutations/operations'

type Rec = Record<string, unknown>

const ACTOR = {type: 'user', id: 'core-proto-test'} as const
const NOW = () => '2026-08-06T00:00:00.000Z'

const DOC = {
  _id: 'article-1',
  _type: 'article',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-01T00:00:00.000Z',
  title: 'kept',
  nested: {inner: 'kept'},
  list: ['a'],
  body: 'hello',
} as never

function commit(mutations: OverlayMutation[]): ReturnType<typeof applyTransaction> {
  const seeded = applyTransaction(
    createOverlayState({overlayId: 'proto-overlay'}),
    [{type: 'createOrReplace', document: DOC}],
    {
      transactionId: 'tx-seed',
      idempotencyKey: 'seed',
      actor: ACTOR,
      now: NOW,
      base: createBaseSource([]),
    },
  )
  return applyTransaction(seeded.state, mutations, {
    transactionId: 'tx-1',
    idempotencyKey: 'k-1',
    actor: ACTOR,
    now: NOW,
    base: createBaseSource([]),
  })
}

/** The own-key spelling `JSON.parse` produces — NOT an object literal, which swaps. */
function withOwnProtoKey(): Rec {
  return JSON.parse('{"__proto__": {"isAdmin": true}, "keep": 2}') as Rec
}

/* ------------------------------------------------------------------ *
 * 1. A forbidden key in an operation path is refused, for every operation
 * ------------------------------------------------------------------ */

/** Every §13.7 operation that carries a path — the whole family, not one instance. */
const PATH_OPERATIONS: Array<(path: (string | number)[]) => OverlayOperation> = [
  (path) => ({type: 'set', path, value: 'x'}) as OverlayOperation,
  (path) => ({type: 'setIfMissing', path, value: 'x'}) as OverlayOperation,
  (path) => ({type: 'unset', path}) as OverlayOperation,
  (path) => ({type: 'inc', path, amount: 1}) as OverlayOperation,
  (path) => ({type: 'dec', path, amount: 1}) as OverlayOperation,
  (path) => ({type: 'diffMatchPatch', path, patch: '@@ -1 +1 @@\n-h\n+H\n'}) as OverlayOperation,
  (path) =>
    ({type: 'insert', path, position: 'after', items: ['x']}) as unknown as OverlayOperation,
]

/** Every position a forbidden key can occupy in a path. */
const FORBIDDEN_PATHS: Array<[string, (string | number)[]]> = [
  ['root segment', ['__proto__']],
  ['root segment with a child', ['__proto__', 'polluted']],
  ['nested segment', ['nested', '__proto__', 'b']],
  ['leaf segment', ['nested', '__proto__']],
  ['constructor root', ['constructor', 'prototype', 'x']],
  ['prototype root', ['prototype', 'x']],
  ['nested constructor', ['nested', 'constructor']],
  ['nested prototype', ['nested', 'prototype']],
  ['under an array index', ['list', 0, '__proto__']],
]

describe('a prototype key in an operation path is refused, not applied', () => {
  for (const [label, path] of FORBIDDEN_PATHS) {
    for (const build of PATH_OPERATIONS) {
      const operation = build(path)
      it(`${operation.type} refuses a ${label}`, () => {
        let code: unknown
        expect(() => {
          try {
            applyOperation(DOC, operation)
          } catch (error) {
            code = (error as {code?: string}).code
            throw error
          }
        }).toThrow()
        /*
         * The EXACT code, not merely "it threw". `diffMatchPatch` and `insert`
         * already throw on these paths for an unrelated reason — the target is
         * not an existing string / not an array — so a looser assertion would
         * pass without the guard existing at all. Pinning
         * OVERLAY_PROTOTYPE_KEY_REJECTED is what proves the key check runs
         * FIRST, before any type check, for every operation.
         *
         * Coded also matters on its own: `sanity-overlay-next`'s `failure()`
         * maps a code-less throw to HTTP 500 INTERNAL, which is unattributable.
         */
        expect(code).toBe('OVERLAY_PROTOTYPE_KEY_REJECTED')
      })
    }
  }

  it('refuses through a whole transaction rather than committing an empty change', () => {
    expect(() =>
      commit([
        {
          type: 'patch',
          id: 'article-1',
          operations: [{type: 'set', path: ['__proto__', 'polluted'], value: 'yes'}],
        } as OverlayMutation,
      ]),
    ).toThrowError(/__proto__/)
  })

  it('refuses `a.__proto__.b` rather than persisting `a` as an empty object', () => {
    expect(() =>
      commit([
        {
          type: 'patch',
          id: 'article-1',
          operations: [{type: 'set', path: ['nested', '__proto__', 'b'], value: 'yes'}],
        } as OverlayMutation,
      ]),
    ).toThrowError(/__proto__/)
  })

  it('refuses the whole transaction when one operation of many is forbidden', () => {
    /* A partial commit would be the same defect wearing a smaller hat: the
     * caller is told the transaction landed and one of its operations did not. */
    expect(() =>
      commit([
        {
          type: 'patch',
          id: 'article-1',
          operations: [
            {type: 'set', path: ['title'], value: 'fine'},
            {type: 'set', path: ['__proto__', 'polluted'], value: 'yes'},
          ],
        } as OverlayMutation,
      ]),
    ).toThrowError(/__proto__/)
  })

  it('still accepts an ordinary path — the guard is about the key, not about depth', () => {
    const applied = commit([
      {
        type: 'patch',
        id: 'article-1',
        operations: [{type: 'set', path: ['nested', 'inner'], value: 'changed'}],
      } as OverlayMutation,
    ])
    const materialized = applied.state.documents['article-1']!.local.published!
      .materialized as unknown as Rec
    expect((materialized.nested as Rec).inner).toBe('changed')
  })

  it('accepts a `_key` whose VALUE is a forbidden word — that is data, not a property name', () => {
    const seeded = applyTransaction(
      createOverlayState({overlayId: 'proto-overlay'}),
      [
        {
          type: 'createOrReplace',
          document: {
            _id: 'keyed-1',
            _type: 'article',
            items: [{_key: '__proto__', label: 'first'}],
          } as never,
        },
      ],
      {
        transactionId: 'tx-seed',
        idempotencyKey: 'seed',
        actor: ACTOR,
        now: NOW,
        base: createBaseSource([]),
      },
    )
    const applied = applyTransaction(
      seeded.state,
      [
        {
          type: 'patch',
          id: 'keyed-1',
          operations: [
            {type: 'set', path: ['items', {_key: '__proto__'}, 'label'], value: 'second'},
          ],
        } as unknown as OverlayMutation,
      ],
      {
        transactionId: 'tx-1',
        idempotencyKey: 'k-1',
        actor: ACTOR,
        now: NOW,
        base: createBaseSource([]),
      },
    )
    const materialized = applied.state.documents['keyed-1']!.local.published!
      .materialized as unknown as Rec
    expect((materialized.items as Rec[])[0]!.label).toBe('second')
  })
})

/* ------------------------------------------------------------------ *
 * 2. deepClone preserves a forbidden own key so §35.14 can reject it
 * ------------------------------------------------------------------ */

describe('deepClone never turns an own key into a prototype swap', () => {
  it('keeps an own `__proto__` key as an own key', () => {
    const source = withOwnProtoKey()
    expect(Object.getOwnPropertyNames(source)).toContain('__proto__')

    const cloned = deepClone(source) as Rec
    /* The defect: `out['__proto__'] = …` runs the accessor, so the key is gone
     * and `isAdmin` is destroyed while the caller is told the clone succeeded. */
    expect(Object.getOwnPropertyNames(cloned)).toContain('__proto__')
    expect(cloned.keep).toBe(2)
  })

  it('keeps a forbidden own key nested inside the tree', () => {
    const source = JSON.parse('{"outer": {"__proto__": {"isAdmin": true}}}') as Rec
    const cloned = deepClone(source) as Rec
    expect(Object.getOwnPropertyNames(cloned.outer as Rec)).toContain('__proto__')
  })

  it('leaves the surviving key visible to the §35.14 serializer guard', () => {
    /* This is the whole point of preserving it: the canonical serializer is the
     * one place that already refuses these keys, and it can only refuse what it
     * can still see. */
    expect(() => serialize(deepClone(withOwnProtoKey()))).toThrowError(/prototype-polluting/i)
  })

  it('does not change the clone of an ordinary object', () => {
    const source = {a: 1, b: {c: [1, 2, {d: 'e'}]}}
    expect(deepClone(source)).toEqual(source)
  })
})

describe('a mutation document body carrying a forbidden own key is refused', () => {
  for (const kind of ['create', 'createIfNotExists', 'createOrReplace'] as const) {
    it(`${kind} refuses rather than dropping the field`, () => {
      const document = {...withOwnProtoKey(), _id: 'new-1', _type: 'article'}
      /* Re-create the own key: the spread above ran the accessor. */
      Object.defineProperty(document, '__proto__', {
        value: {isAdmin: true},
        writable: true,
        enumerable: true,
        configurable: true,
      })
      expect(() =>
        commit([{type: kind, document: document as never} as OverlayMutation]),
      ).toThrowError(/prototype|__proto__/i)
    })
  }
})

/* ------------------------------------------------------------------ *
 * 3. A prototype-chain read on the record map is not a document
 * ------------------------------------------------------------------ */

describe('record lookup never returns something off the prototype chain', () => {
  const state = createOverlayState({overlayId: 'proto-overlay'})

  for (const id of [
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'drafts.__proto__',
    'drafts.constructor',
  ]) {
    it(`getRecord(${JSON.stringify(id)}) is null`, () => {
      expect(getRecord(state, id)).toBeNull()
    })
  }
})

/* ------------------------------------------------------------------ *
 * 4. The regression guard the review's clean finding rests on
 * ------------------------------------------------------------------ */

describe('Object.prototype stays clean throughout', () => {
  it('is untouched by every vector above', () => {
    const proto = Object.prototype as unknown as Rec
    expect(proto.polluted).toBeUndefined()
    expect(proto.isAdmin).toBeUndefined()
    expect(proto.b).toBeUndefined()
  })

  it('agrees with the exported §35.14 key list', () => {
    expect([...FORBIDDEN_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype'])
    for (const key of FORBIDDEN_KEYS) expect(isForbiddenKey(key)).toBe(true)
    expect(isForbiddenKey('title')).toBe(false)
  })
})
