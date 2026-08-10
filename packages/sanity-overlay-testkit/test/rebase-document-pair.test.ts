/**
 * A rebase must not depend on the ORDER of `baseDocuments`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 *
 * `api.ts` built the current-base map as
 *
 *     currentBase.set(toPublishedId(document._id), document)
 *
 * `drafts.article-1` and `article-1` both reduce to `article-1`, so the two
 * halves of a document PAIR landed on one key and the last entry of the array
 * won. `sanity-overlay-studio`'s `runtime.baseDocuments()` always emits both
 * addresses, published first — so in a real Studio the base DRAFT always became
 * "the current base", was compared against a §17.1 ancestor captured from the
 * base PUBLISHED snapshot, and every path the draft differed on looked like the
 * base having moved under the branch. The answer was `200 ok:true` with
 * `committed:false` and `blockedBy: ["base-changed-only-on-untouched-paths"]`:
 * enabled button, accepted click, nothing changed, nothing said so.
 *
 * Every document a person edits in staging has a draft, so this was the
 * ordinary case rather than an edge one.
 *
 * THE CLASS
 *
 * `toPublishedId` as a MAP KEY is lossy by construction: it is only safe when
 * the value is per-LOGICAL-DOCUMENT (a §13.3 record, which carries both
 * perspectives inside it) or when the value is the id itself (a membership Set).
 * It is wrong wherever the value is a per-ADDRESS document, which is what a
 * caller-supplied `baseDocuments` array holds. Core already has the right shape
 * for this and has had it all along — `createBaseSource` keeps two maps,
 * `getPublished` and `getDraft` — and it is what the commit and resolve paths
 * already use. The rebase path was the one place that invented its own.
 *
 * The CLI's `rebase --base` had the mirror-image half of the same bug: it keyed
 * by the document's own `_id` and then only ever LOOKED UP the published
 * address, so a base draft supplied in the file was silently ignored even for a
 * record whose ancestor was captured from the base draft. Both are covered here,
 * because one fix that leaves the other is the drift this class keeps producing.
 *
 * ORACLES. `manifest.revision` and the intent files as `node:fs` sees them, and
 * a separate `GET /state` round trip. Never the body of the call under test —
 * the defect's whole signature was a response that said `ok: true`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest, SanityDocument} from '../../sanity-overlay-core/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApiServer} from '../../sanity-overlay-next/src/index'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

const OVERLAY_ID = 'rebase-pair-000000000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'
const LOGICAL_ID = 'article-1'
const DRAFT_ID = `drafts.${LOGICAL_ID}`

const BRANCH_TITLE = 'Branch title the editor typed'

/** The base as it stood when the branch first touched the document. */
const BASE_AT_FIRST_TOUCH: SanityDocument = {
  _id: LOGICAL_ID,
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Base title',
  summary: 'Base summary',
}

/**
 * The base, moved — on `summary`, which the branch never touched.
 *
 * §28.5 precondition 1 is "the base changed only on untouched paths", so this
 * document is the one that MUST let an automatic rebase through.
 */
const BASE_MOVED: SanityDocument = {
  ...BASE_AT_FIRST_TOUCH,
  _rev: 'lake-rev-2',
  summary: 'Base summary, edited upstream',
}

/**
 * The base DRAFT of the same document, as staging holds it.
 *
 * Its `title` differs from the published one — which is the whole point: if the
 * draft is mistaken for "the current base", the branch's own touched path looks
 * like it moved upstream and precondition 1 fails.
 */
const BASE_DRAFT: SanityDocument = {
  ...BASE_MOVED,
  _id: DRAFT_ID,
  _rev: 'lake-draft-rev-2',
  title: 'A title somebody left in the staging draft',
}

const roots: string[] = []
const running: OverlayApiServer[] = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
  await cleanupOverlayFixtures()
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rebase-pair-'))
  roots.push(root)
  return root
}

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

async function boot(root: string): Promise<OverlayApiServer> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: {projectId: 'rebase-pair', dataset: 'branch', apiVersion: '2025-02-19'},
    source: {repositoryId: 'sanity-dataset-simulator', branch: 'rebase-pair'},
  })
  running.push(server)
  return server
}

async function post(
  server: OverlayApiServer,
  route: string,
  body: unknown,
): Promise<{status: number; json: Record<string, any>}> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {status: response.status, json: (await response.json()) as Record<string, any>}
}

async function state(server: OverlayApiServer): Promise<Record<string, any>> {
  const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
  return (await response.json()) as Record<string, any>
}

/** THE ORACLE: the manifest as `node:fs` sees it. */
async function manifestOnDisk(root: string): Promise<OverlayManifest> {
  return parse(
    await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
  ) as OverlayManifest
}

/** THE SECOND ORACLE: the §14.2 intent file's recorded base published revision. */
async function intentAncestorRevision(root: string): Promise<string | null> {
  const raw = await readFile(
    join(root, '.sanity-overlay', 'documents', LOGICAL_ID, 'intent.json'),
    'utf8',
  )
  const intent = parse(raw) as {base?: {publishedRevision?: string}}
  return intent.base?.publishedRevision ?? null
}

/** An overlay with one branch edit anchored to {@link BASE_AT_FIRST_TOUCH}. */
async function seeded(): Promise<{root: string; server: OverlayApiServer}> {
  const root = await makeRoot()
  const server = await boot(root)
  const edit = await post(server, '/commit', {
    idempotencyKey: 'branch-edit',
    kind: 'actions',
    payload: [
      {
        actionType: 'sanity.action.document.edit',
        draftId: DRAFT_ID,
        publishedId: LOGICAL_ID,
        patch: {set: {title: BRANCH_TITLE}},
      },
    ],
    baseDocuments: [BASE_AT_FIRST_TOUCH],
  })
  expect(edit.json.committed, JSON.stringify(edit.json)).toBe(true)
  return {root, server}
}

async function rebaseWith(
  server: OverlayApiServer,
  baseDocuments: readonly SanityDocument[],
  key = `rebase-${Math.random()}`,
): Promise<{status: number; json: Record<string, any>}> {
  return post(server, '/commit', {
    idempotencyKey: key,
    kind: 'rebase',
    payload: {mode: 'auto', documentIds: [LOGICAL_ID]},
    baseDocuments,
  })
}

/* ================================================================== *
 * The instance: the order the Studio actually sends
 * ================================================================== */

describe('POST /commit kind: rebase, with the document pair the Studio sends', () => {
  it('rebases when `baseDocuments` is [published, draft] — the ordinary case', async () => {
    const {root, server} = await seeded()
    const before = await manifestOnDisk(root)
    expect(await intentAncestorRevision(root)).toBe(BASE_AT_FIRST_TOUCH._rev)

    await rebaseWith(server, [BASE_MOVED, BASE_DRAFT])

    /* ORACLE 1 — the manifest on disk moved. */
    const after = await manifestOnDisk(root)
    expect(after.revision).toBeGreaterThan(before.revision)

    /* ORACLE 2 — the recorded ancestor is the MOVED PUBLISHED revision, which is
     * the one thing a rebase is for. Had the draft been mistaken for the base,
     * this would read `lake-draft-rev-2`. */
    expect(await intentAncestorRevision(root)).toBe(BASE_MOVED._rev)

    /* ORACLE 3 — a separate round trip agrees, and local intent survived. */
    const entry = (await state(server)).documents.find(
      (document: Record<string, any>) => document.logicalId === LOGICAL_ID,
    )
    expect(entry.baseRevisionAtFirstTouch).toBe(BASE_MOVED._rev)
    expect(entry.draft.title).toBe(BRANCH_TITLE)
  })

  /**
   * THE PROPERTY, not the instance.
   *
   * A rebase reads a SET of base documents. If its answer depends on the order
   * they arrive in, something is collapsing them — whatever the current answer
   * happens to be. This case is what makes the fix a fix rather than a
   * reordering.
   */
  it('gives the same answer for every ordering of the pair', async () => {
    const orders: ReadonlyArray<readonly SanityDocument[]> = [
      [BASE_MOVED, BASE_DRAFT],
      [BASE_DRAFT, BASE_MOVED],
    ]

    const outcomes: Array<{delta: number; ancestor: string | null}> = []
    for (const order of orders) {
      const {root, server} = await seeded()
      const before = await manifestOnDisk(root)
      await rebaseWith(server, order)
      const after = await manifestOnDisk(root)
      outcomes.push({
        delta: after.revision - before.revision,
        ancestor: await intentAncestorRevision(root),
      })
    }

    expect(outcomes[0]).toEqual(outcomes[1])
    /* NON-VACUITY: "the same answer" must be the RIGHT answer, not the same
     * blockage twice. */
    expect(outcomes[0]?.delta).toBeGreaterThan(0)
    expect(outcomes[0]?.ancestor).toBe(BASE_MOVED._rev)
  })

  it('does not treat the base draft as the current base when the published one is absent', async () => {
    /* §5.5. The record's ancestor was captured from the base PUBLISHED snapshot,
     * so the draft is not the document a rebase may replace it with. Refusing
     * visibly is the requirement; quietly adopting the draft's `title` as
     * "upstream" is the failure. */
    const {root, server} = await seeded()
    const before = await manifestOnDisk(root)

    const result = await rebaseWith(server, [BASE_DRAFT])

    expect(result.json.committed).toBe(false)
    expect((await manifestOnDisk(root)).revision).toBe(before.revision)
    expect(await intentAncestorRevision(root)).toBe(BASE_AT_FIRST_TOUCH._rev)
  })

  it('still refuses when no usable base document is supplied at all', async () => {
    const {server} = await seeded()
    const result = await rebaseWith(server, [])

    expect(result.status).toBe(400)
    expect(result.json.error.code).toBe('BASE_REQUIRED')
  })

  it('accepts the pair when only the draft address names the document', async () => {
    /* BASE_REQUIRED is about "did the caller state a current base for this
     * document at all". A payload carrying only `drafts.X` states one — it is
     * the wrong PERSPECTIVE for this record, which is a §28.5 blockage reported
     * per document, not a malformed request. The two must not be conflated: a
     * 400 tells the Studio to fetch something, a blockage tells the editor why
     * their button did nothing. */
    const {server} = await seeded()
    const result = await rebaseWith(server, [BASE_DRAFT])

    expect(result.status).toBe(200)
    expect(result.json.ok).toBe(true)
    expect(result.json.committed).toBe(false)
  })
})

/* ================================================================== *
 * The other half of the pair: a record anchored to the base DRAFT
 * ================================================================== */

describe('a record whose §17.1 ancestor is the base DRAFT', () => {
  /**
   * `ancestorKind` is `base-draft` whenever the branch first touches a document
   * that HAS an unpublished draft in staging (`mutations/mutation.ts:260`). For
   * those records the draft is the current base and the published document is
   * not — the exact mirror of the case above, and the reason the fix is a
   * perspective RULE rather than "prefer the published one".
   */
  const DRAFT_AT_FIRST_TOUCH: SanityDocument = {
    ...BASE_AT_FIRST_TOUCH,
    _id: DRAFT_ID,
    _rev: 'lake-draft-rev-1',
  }
  const DRAFT_MOVED: SanityDocument = {
    ...DRAFT_AT_FIRST_TOUCH,
    _rev: 'lake-draft-rev-3',
    summary: 'Draft summary, edited upstream',
  }

  async function seededOnDraft(): Promise<{root: string; server: OverlayApiServer}> {
    const root = await makeRoot()
    const server = await boot(root)
    const edit = await post(server, '/commit', {
      idempotencyKey: 'branch-edit-on-draft',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: DRAFT_ID,
          publishedId: LOGICAL_ID,
          patch: {set: {title: BRANCH_TITLE}},
        },
      ],
      /* Both addresses, so the record's ancestor is captured from the DRAFT. */
      baseDocuments: [BASE_AT_FIRST_TOUCH, DRAFT_AT_FIRST_TOUCH],
    })
    expect(edit.json.committed, JSON.stringify(edit.json)).toBe(true)

    /* NON-VACUITY: the fixture really did produce a draft-anchored record. If
     * the ancestor were the published snapshot, the case below would be a
     * duplicate of the one above rather than its mirror. */
    const intent = parse(
      await readFile(join(root, '.sanity-overlay', 'documents', LOGICAL_ID, 'intent.json'), 'utf8'),
    ) as {base?: {draftRevision?: string}}
    expect(intent.base?.draftRevision).toBe(DRAFT_AT_FIRST_TOUCH._rev)

    return {root, server}
  }

  it('rebases onto the moved base DRAFT, in either array order', async () => {
    const deltas: number[] = []
    for (const order of [
      [BASE_MOVED, DRAFT_MOVED],
      [DRAFT_MOVED, BASE_MOVED],
    ] as const) {
      const {root, server} = await seededOnDraft()
      const before = await manifestOnDisk(root)
      const result = await rebaseWith(server, order)
      expect(result.json.documents[0].perspective).toBe('draft')
      deltas.push((await manifestOnDisk(root)).revision - before.revision)
    }

    expect(deltas[0]).toBe(deltas[1])
    expect(deltas[0]).toBeGreaterThan(0)
  })

  it('keeps the editor’s own value — a rebase moves the ancestor, not the intent', async () => {
    const {root, server} = await seededOnDraft()
    await rebaseWith(server, [BASE_MOVED, DRAFT_MOVED])

    const entry = (await state(server)).documents.find(
      (document: Record<string, any>) => document.logicalId === LOGICAL_ID,
    )
    expect(entry.draft.title).toBe(BRANCH_TITLE)

    /* The ancestor the intent records has moved to the DRAFT's new revision —
     * which is the fact under test, and the one that would have read
     * `lake-draft-rev-1` while the pair was being collapsed. §28.5 replaces the
     * merge ancestor; it does not re-materialise untouched fields, so this is
     * asserted on the recorded revision rather than on the rendered body. */
    const intent = parse(
      await readFile(join(root, '.sanity-overlay', 'documents', LOGICAL_ID, 'intent.json'), 'utf8'),
    ) as {base?: {draftRevision?: string; publishedRevision?: string}}
    expect(JSON.stringify(intent.base)).toContain(DRAFT_MOVED._rev as string)
  })
})

/* ================================================================== *
 * The same class, in the CLI
 * ================================================================== */

describe('`sanity-overlay rebase --base` reads the pair the same way', () => {
  /** The CLI fixture's `article-1` base, and its branch edit on `title`. */
  const FIXTURE_ID = 'article-1'

  async function baseFile(root: string, documents: readonly unknown[]): Promise<string> {
    const path = join(root, 'base.json')
    await writeFile(path, JSON.stringify(documents), 'utf8')
    return path
  }

  async function fixtureManifest(root: string): Promise<OverlayManifest> {
    return parse(
      await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ) as OverlayManifest
  }

  const movedPublished = {
    _id: FIXTURE_ID,
    _type: 'article',
    _rev: 'base-rev-article-1-moved',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-02T00:00:00.000Z',
    title: 'Base article title',
    tags: ['base'],
    slug: {current: 'base-article'},
    author: {_type: 'reference', _ref: 'author-1'},
    body: [
      {_key: 'block-a', _type: 'block', text: 'first, edited upstream'},
      {_key: 'block-b', _type: 'block', text: 'second'},
    ],
  }
  const movedDraft = {
    ...movedPublished,
    _id: `drafts.${FIXTURE_ID}`,
    _rev: 'base-rev-article-1-draft',
    title: 'A title left in the staging draft',
  }

  it('is unaffected by a base draft appearing alongside the published document', async () => {
    const alone = await createOverlayFixture()
    const withDraft = await createOverlayFixture()

    const runAlone = await runCliCapture(
      [
        'rebase',
        '--document',
        FIXTURE_ID,
        '--base',
        await baseFile(alone.root, [movedPublished]),
        '--confirm',
        '--json',
      ],
      {cwd: alone.root},
    )
    const runWithDraft = await runCliCapture(
      [
        'rebase',
        '--document',
        FIXTURE_ID,
        '--base',
        await baseFile(withDraft.root, [movedPublished, movedDraft]),
        '--confirm',
        '--json',
      ],
      {cwd: withDraft.root},
    )

    expect(runWithDraft.code).toBe(runAlone.code)
    expect(runWithDraft.code).toBe(EXIT.OK)

    /* The oracle is the manifest on disk in each root, not the printed report. */
    const aloneRevision = (await fixtureManifest(alone.root)).revision
    const withDraftRevision = (await fixtureManifest(withDraft.root)).revision
    expect(withDraftRevision).toBe(aloneRevision)

    const outcomeOf = (stdout: string): Record<string, any> => {
      const parsed = JSON.parse(stdout) as {documents?: Record<string, any>[]}
      const found = parsed.documents?.find((entry) => entry.logicalId === FIXTURE_ID)
      if (found === undefined) throw new Error(`no outcome for ${FIXTURE_ID} in ${stdout}`)
      return found
    }
    expect(outcomeOf(runWithDraft.stdout).applied).toBe(outcomeOf(runAlone.stdout).applied)
    /* NON-VACUITY: both must have actually rebased. */
    expect(outcomeOf(runAlone.stdout).applied).toBe(true)
  })

  it('is unaffected by the order of the two addresses in the --base file', async () => {
    const first = await createOverlayFixture()
    const second = await createOverlayFixture()

    await runCliCapture(
      [
        'rebase',
        '--document',
        FIXTURE_ID,
        '--base',
        await baseFile(first.root, [movedPublished, movedDraft]),
        '--confirm',
      ],
      {cwd: first.root},
    )
    await runCliCapture(
      [
        'rebase',
        '--document',
        FIXTURE_ID,
        '--base',
        await baseFile(second.root, [movedDraft, movedPublished]),
        '--confirm',
      ],
      {cwd: second.root},
    )

    expect((await fixtureManifest(second.root)).revision).toBe(
      (await fixtureManifest(first.root)).revision,
    )
  })
})
