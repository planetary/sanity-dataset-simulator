/**
 * PRECONDITIONS THE UI CANNOT CREATE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEED EXISTS AT ALL, IN A SUITE WHOSE FIXTURES ARE OTHERWISE PURE UI.
 *
 * `article` declares FOUR required fields (`schemaTypes/article.ts:11-17`):
 * `title`, `slug`, `publishedAt` and `author`. Three of them a person types.
 * The fourth is a **strong reference**, and two facts about this stack make it
 * unreachable from the form:
 *
 *   1. THE REFERENCE PICKER COULD NOT FIND OVERLAY DOCUMENTS — FIXED 2026-08-10,
 *      AND THIS ENTRY IS KEPT AS THE RECORD OF WHY THE SEED STILL EXISTS.
 *
 *      Studio's reference search is a
 *      `score(boost(… match text::query($__query)), …)` findability query; the
 *      facade cannot answer it locally, so it is a recorded passthrough to the
 *      Mode 2 origin. The origin hydrated its GROQ corpus ONCE, at process
 *      start, and in this topology the Studio's writes go to the overlay API,
 *      never to the origin — so it answered a confident `[]` from a source that
 *      had been told nothing since boot, and the picker said *No results*.
 *      `origin.mjs` now re-reads the commit point on the same tick as the
 *      answer (`refreshFromDisk`), and
 *      `specs/local/09-branch-visibility.spec.ts` drives the picker through the
 *      real form and asserts the reference reaches `intent.json`.
 *
 *      THE SEED IS STILL CORRECT, for a different reason than it was written
 *      for: the specs that use it are about what a DOCUMENT ACTION does to the
 *      overlay, and making each of them depend on a search index as well would
 *      couple thirty assertions to one subsystem. Spec 09 owns the picker; the
 *      rest state their precondition and get on with their subject.
 *
 *   2. A STRONG REFERENCE MUST POINT AT A **PUBLISHED** DOCUMENT. Sanity's
 *      inferred reference validator resolves existence through
 *      `listenDocumentExists` (`datastores` dist ~5752), which reads
 *      `published.available || version?.available` — the DRAFT availability is
 *      not consulted, and the message is literally
 *      `validation:object.reference-not-published`. Measured: with a draft-only
 *      author the article's Publish button stays disabled through a reload and
 *      60 s of polling; with the same author published, it enables.
 *
 * So the seed writes exactly what the form cannot: a published `author`, and the
 * `author` reference on the article. Everything a person can type is still typed
 * by the specs, through the form, and every assertion is still against the disk.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT WRITES THROUGH THE PRODUCT'S OWN API, NOT THROUGH THE FILE SYSTEM.
 *
 * `POST /commit` on the overlay API is the same endpoint the Studio facade
 * posts to, with the same envelope — so the seed cannot produce a state the
 * product could not have produced, and it appears in the recorded overlay log
 * like any other write. Writing `intent.json` directly would bypass the store's
 * manifest and checksums and could fabricate a state that is not reachable.
 *
 * The idempotency key is a fresh UUID per call, deliberately: see
 * `04-document-actions.spec.ts` on why the key space matters here.
 */
import {URLS} from '../harness/paths.mjs'

type CommitKind = 'actions' | 'mutations' | 'documentActions'

/** One `/commit`, or a loud throw carrying the server's own words. */
export async function seedCommit(kind: CommitKind, payload: unknown[]): Promise<void> {
  const response = await fetch(`${URLS.overlayApi}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      kind,
      payload,
      baseDocuments: [],
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`seed ${kind} failed: ${response.status} ${text}`)
  }
  /* `200 {"committed": false, "replayed": true}` is a SUCCESSFUL HTTP call that
   * did nothing. A seed that silently did nothing is a spec that asserts about
   * a document that is not there, so it is an error here rather than later. */
  const body = JSON.parse(text) as {committed?: boolean; replayed?: boolean}
  if (body.committed !== true) {
    throw new Error(`seed ${kind} did not commit: ${text}`)
  }
}

/**
 * An author document that exists on the PUBLISHED layer.
 *
 * Create, then publish — the same two writes the Studio would make, in the same
 * order, because `sanity.action.document.publish` is defined in terms of an
 * existing draft.
 */
export async function seedPublishedAuthor(id: string, name: string): Promise<void> {
  await seedCommit('actions', [
    {
      actionType: 'sanity.action.document.create',
      publishedId: id,
      attributes: {
        _id: `drafts.${id}`,
        _type: 'author',
        _createdAt: new Date().toISOString(),
        name,
      },
      ifExists: 'fail',
    },
  ])
  await seedCommit('documentActions', [
    {actionType: 'sanity.action.document.publish', draftId: `drafts.${id}`, publishedId: id},
  ])
}

/**
 * A draft article carrying nothing but the reference the picker cannot set.
 *
 * `title`, `slug` and `publishedAt` are deliberately absent: the specs type
 * those into the form, so the document only becomes publishable because of what
 * the Studio did, not because of what this wrote.
 */
export async function seedArticleReferencing(articleId: string, authorId: string): Promise<void> {
  await seedCommit('actions', [
    {
      actionType: 'sanity.action.document.create',
      publishedId: articleId,
      attributes: {
        _id: `drafts.${articleId}`,
        _type: 'article',
        _createdAt: new Date().toISOString(),
        /* Strong: no `_weak`, no `_strengthenOnPublish`. That is the shape the
         * schema declares (`article.ts:17`) and the shape §18.8's
         * delete-protection semantics are about. */
        author: {_type: 'reference', _ref: authorId},
      },
      ifExists: 'fail',
    },
  ])
}
