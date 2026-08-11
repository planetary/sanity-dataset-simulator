/**
 * A MODE-2-SHAPED TOMBSTONE STILL SUPPRESSES A BASE DOCUMENT.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `e2e/specs/local/08-local-site.spec.ts` carried a skipped test —
 *
 *     test.skip(true, 'needs a shared base document — see specs/live/')
 *
 * — for *"a tombstoned document 404s on the branch view while the base still has
 * it"*. Two things about that skip did not survive checking:
 *
 *   1. `specs/live/01-staging-untouched.spec.ts` does NOT carry the test. It has
 *      the branch-title cases; there is no tombstone/404 case anywhere in it. So
 *      the pointer named a home that does not exist.
 *   2. The stated blocker — *"in local mode the Studio's world is the empty run
 *      overlay, so there is no shared id to delete"* — confuses "the Studio has
 *      no base" with "no id can be shared". The Studio can open, publish and
 *      delete the id `article-02`, and `examples/local-site/base-dataset.ndjson`
 *      contains `article-02`. The site is the process that holds both halves.
 *
 * What the skip was really guarding is a REAL difference, and it is the thing
 * this file measures rather than assumes: the tombstone Mode 2 can produce is
 * BRANCH-CREATED. `local-site-routes.test.ts` seeds its overlay WITH
 * `baseDocuments`, so its tombstoned `article-02` is base-derived — a different
 * record shape reaching the same suppression. Whether a branch-created tombstone
 * also suppresses a base row was covered nowhere.
 *
 * THE ORACLE
 * ──────────
 * The base dataset is `examples/local-site/base-dataset.ndjson`, read from disk,
 * and the same document is asserted PRESENT through a `mode: 'off'` client in
 * the same test. So "the row is gone" is measured against a live reading of the
 * very row, not against an assumption that it was ever there.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {
  createDocumentBaseSource,
  createFsOverlayStateLoader,
  createOverlayClient,
  seedOverlay,
} from '../../sanity-overlay-client/src/index'
import type {OverlayClient} from '../../sanity-overlay-client/src/index'
import {createSite} from '../../../examples/local-site/src/site'
import {loadNdjsonDataset, SITE_BASE_DATASET_PATH} from '../../../examples/local-site/src/dataset'
import {SITE_QUERIES} from '../../../examples/local-site/src/queries'

const BASE = loadNdjsonDataset(SITE_BASE_DATASET_PATH)

/** The id the Studio will address, and the slug the site routes it by. */
const SHARED_ID = 'article-02'
const SHARED_SLUG = 'article-2'

const baseTitle = ((): string => {
  const doc = BASE.find((d) => d._id === SHARED_ID)
  if (!doc) throw new Error(`the site base dataset no longer contains ${SHARED_ID}`)
  return doc.title as string
})()

let root = ''

function fixedClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 10, 12, 0, 0) + tick++ * 1000).toISOString()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'overlay-mode2-tombstone-'))

  /*
   * MODE 2 IN A BOTTLE: `baseDocuments` is omitted, so every record the seed
   * produces is branch-created (§17.2 precedence rule 2) — which is the only
   * kind of record an origin-mode Studio can make, because it has no base to
   * derive one from.
   *
   * `createOrReplace` on the PUBLISHED id is what a Studio publish leaves
   * behind, and a published version is the only thing `delete` can tombstone.
   */
  await seedOverlay({
    root,
    now: fixedClock(),
    edits: [
      {
        kind: 'createOrReplace',
        document: {
          _id: SHARED_ID,
          _type: 'article',
          title: 'Branch copy of a base id',
          slug: {_type: 'slug', current: SHARED_SLUG},
        },
      },
      {kind: 'delete', id: SHARED_ID},
    ],
  })
})

afterAll(async () => {
  if (root) await rm(root, {recursive: true, force: true})
})

const branchClient = (): OverlayClient =>
  createOverlayClient({
    mode: 'fs',
    base: createDocumentBaseSource(BASE),
    overlay: createFsOverlayStateLoader({root}),
    queries: SITE_QUERIES,
    perspective: 'drafts',
    caller: 'frontend',
  })

const stagingClient = (): OverlayClient =>
  createOverlayClient({
    mode: 'off',
    base: createDocumentBaseSource(BASE),
    queries: SITE_QUERIES,
    perspective: 'drafts',
    caller: 'frontend',
  })

const get = (client: OverlayClient, url: string): Promise<{status: number; body: string}> =>
  createSite({client}).handle({method: 'GET', url}) as Promise<{status: number; body: string}>

describe('a branch-created tombstone over a base id — the Mode 2 shape', () => {
  it('the base dataset really does still hold the document (the differential)', async () => {
    const staging = await get(stagingClient(), `/articles/${SHARED_SLUG}`)
    expect(staging.status).toBe(200)
    expect(staging.body).toContain(baseTitle)
  })

  it('404s on the branch view rather than serving the stale base row', async () => {
    const branch = await get(branchClient(), `/articles/${SHARED_SLUG}`)
    expect(branch.status).toBe(404)
    expect(branch.body).not.toContain(baseTitle)
  })

  it('drops it from the branch list while the staging list keeps it', async () => {
    const branch = await get(branchClient(), '/')
    const staging = await get(stagingClient(), '/')

    expect(branch.status).toBe(200)
    expect(branch.body).not.toContain(`/articles/${SHARED_SLUG}`)
    expect(staging.body).toContain(`/articles/${SHARED_SLUG}`)
  })
})
