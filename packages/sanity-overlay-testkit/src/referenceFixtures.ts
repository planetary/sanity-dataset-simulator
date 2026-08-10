/**
 * Deterministic fixtures for the Phase 2 workstream W4 reference suites
 * (plan docs/plans/phase-2-core-domain.md §7, §8.4, §8.6; PRD §19, §35.6).
 *
 * Everything here is hand-rolled and deterministic: a fixed clock, a counter-based
 * transaction ID source, and a small literal reference graph. No dependency is
 * added, matching the `test/core-w1.test.ts` convention.
 *
 * The **base-side** reverse-reference results are fixtures on purpose. PRD §19.4
 * issues `references($ids)` against Sanity from the adapter/query layer, so core
 * takes those hits as an injected input; this file is the stand-in for that query
 * (plan §8.4: "with base-side reverse-reference results supplied as fixtures").
 */
import type {OverlayActor, SanityDocument} from 'sanity-overlay-core'
import type {BaseReverseReferenceHit} from 'sanity-overlay-core/references'
import type {SerializedSchemaArtifact} from 'sanity-overlay-core/validation'

export const REFERENCE_ACTOR: OverlayActor = {
  type: 'user',
  id: 'user-w4',
  displayName: 'Ada',
}

export const REFERENCE_INSTANT = '2026-08-04T09:00:00.000Z'

/** A clock that always returns the same instant, so output is byte-stable. */
export function fixedClock(instant: string = REFERENCE_INSTANT): () => string {
  return () => instant
}

/** Counter-based transaction option builder (deterministic, no randomness). */
export function createTransactionSource(): (
  overrides?: Record<string, unknown>,
) => {
  transactionId: string
  idempotencyKey: string
  actor: OverlayActor
  now: () => string
} {
  let counter = 0
  return (overrides = {}) => {
    counter += 1
    const seq = String(counter).padStart(6, '0')
    return {
      transactionId: `01JW4${seq}`,
      idempotencyKey: `w4-key-${seq}`,
      actor: REFERENCE_ACTOR,
      now: fixedClock(),
      ...overrides,
    }
  }
}

/* ------------------------------------------------------------------ *
 * The base reference graph
 *
 *   page-1.author        -> author-1   (strong)
 *   page-1.editor        -> author-2   (weak)
 *   page-2.related[r1]   -> author-1   (strong)
 *   review-1.page        -> page-1     (strong)   — one hop further out
 * ------------------------------------------------------------------ */

export const BASE_AUTHOR_1: SanityDocument = {
  _id: 'author-1',
  _type: 'author',
  _rev: 'base-author-1-r1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Grace Hopper',
}

export const BASE_AUTHOR_2: SanityDocument = {
  _id: 'author-2',
  _type: 'author',
  _rev: 'base-author-2-r1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Alan Turing',
}

export const BASE_PAGE_1: SanityDocument = {
  _id: 'page-1',
  _type: 'page',
  _rev: 'base-page-1-r1',
  _createdAt: '2026-01-02T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Compilers',
  author: {_type: 'reference', _ref: 'author-1'},
  editor: {_type: 'reference', _ref: 'author-2', _weak: true},
}

export const BASE_PAGE_2: SanityDocument = {
  _id: 'page-2',
  _type: 'page',
  _rev: 'base-page-2-r1',
  _createdAt: '2026-01-03T00:00:00.000Z',
  _updatedAt: '2026-01-03T00:00:00.000Z',
  title: 'Bugs',
  related: [{_key: 'r1', _type: 'reference', _ref: 'author-1'}],
}

export const BASE_REVIEW_1: SanityDocument = {
  _id: 'review-1',
  _type: 'review',
  _rev: 'base-review-1-r1',
  _createdAt: '2026-01-04T00:00:00.000Z',
  _updatedAt: '2026-01-04T00:00:00.000Z',
  page: {_type: 'reference', _ref: 'page-1'},
}

export const BASE_DOCUMENTS: readonly SanityDocument[] = Object.freeze([
  BASE_AUTHOR_1,
  BASE_AUTHOR_2,
  BASE_PAGE_1,
  BASE_PAGE_2,
  BASE_REVIEW_1,
])

/**
 * The base-side `references($ids)` result set (PRD §19.4), as the adapter would
 * return it. Deliberately *pathless* for one hit so the dedupe path that has to
 * cope with a coarse base answer is exercised.
 */
export const BASE_REVERSE_HITS: readonly BaseReverseReferenceHit[] = Object.freeze([
  {
    referringDocumentId: 'page-1',
    targetId: 'author-1',
    path: ['author'],
    strength: 'strong',
  },
  {
    referringDocumentId: 'page-2',
    targetId: 'author-1',
    path: ['related', {_key: 'r1'}],
    strength: 'strong',
  },
  {
    referringDocumentId: 'page-1',
    targetId: 'author-2',
    path: ['editor'],
    strength: 'weak',
  },
  // Pathless hit: `references($ids)` returns documents, not paths.
  {referringDocumentId: 'review-1', targetId: 'page-1'},
])

/* ------------------------------------------------------------------ *
 * Serialized schema artifact (PRD §20.1) — never extracted from Studio here,
 * just written out as the artifact core is contractually given.
 * ------------------------------------------------------------------ */

export const REFERENCE_SCHEMA: SerializedSchemaArtifact = {
  schemaCommit: 'schema-sha-1',
  types: [
    {
      name: 'author',
      fields: [{name: 'name', type: 'string', required: true}],
    },
    {
      name: 'editor',
      fields: [{name: 'name', type: 'string', required: true}],
    },
    {
      name: 'page',
      fields: [
        {name: 'title', type: 'string', required: true},
        {name: 'author', type: 'reference', to: ['author']},
        {name: 'editor', type: 'reference', weak: true, to: ['author', 'editor']},
        {
          name: 'related',
          type: 'array',
          of: [{type: 'reference', to: ['author']}],
        },
      ],
    },
    {
      name: 'review',
      fields: [{name: 'page', type: 'reference', to: ['page']}],
    },
  ],
}
