/**
 * Write an overlay the way the Studio would have written it — for examples and
 * for tests that need a *real* `.sanity-overlay/` rather than a hand-built one.
 *
 * Every edit goes through the same three layers the Studio write path uses:
 * core's mutation engine and §18 document actions produce the §13.3 records,
 * and `FsOverlayStore` persists them as one transaction. Nothing here fabricates
 * a record or a manifest, so an overlay produced by this helper is
 * indistinguishable on disk from one produced by a Studio session — which is the
 * only reason a test that reads it proves anything.
 *
 * This is a development utility, not part of the read path. It is exported so an
 * example site can offer "show me the loop without opening Studio".
 */
import {
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  isSyntheticRev,
  type OverlayActor,
  type OverlayDocumentRecord,
  type OverlayOperation,
  type OverlayState,
  type SanityDocument,
} from 'sanity-overlay-core'
import {FsOverlayStore} from 'sanity-overlay-store-fs'

export type SeedEdit =
  /** Patch the draft of an existing (base or branch) document — PRD §18.4. */
  | {readonly kind: 'edit'; readonly id: string; readonly operations: readonly OverlayOperation[]}
  /**
   * Create a branch-only document. Use a `drafts.` ID for a Studio-style draft.
   *
   * Strict, per PRD §35.4: creating a document that already exists in the
   * virtual dataset raises `OVERLAY_DOCUMENT_ALREADY_EXISTS`. A demo script that
   * expects to be run twice wants `createOrReplace`, below — relaxing `create`
   * would hide a real duplicate-ID mistake.
   */
  | {readonly kind: 'create'; readonly document: SanityDocument}
  /** Create or overwrite — the re-runnable form, and what a Studio re-save does. */
  | {readonly kind: 'createOrReplace'; readonly document: SanityDocument}
  /** Delete — both tombstones, record metadata preserved (PRD §18.8). */
  | {readonly kind: 'delete'; readonly id: string}

export interface SeedOverlayOptions {
  /** Directory that will CONTAIN `.sanity-overlay/`. */
  readonly root: string
  readonly edits: readonly SeedEdit[]
  /** The base dataset the edits are layered over (the merge ancestor source). */
  readonly baseDocuments?: readonly SanityDocument[]
  readonly overlayId?: string
  readonly actor?: OverlayActor
  /** Injected clock. Defaults to wall time; pass a counter for determinism. */
  readonly now?: () => string
  readonly base?: {projectId: string; dataset: string; apiVersion: string}
  readonly source?: {repositoryId: string; branch: string}
  /**
   * Prefix for the transaction and idempotency keys this call generates.
   *
   * The default embeds the overlay revision observed when the call started, so
   * seeding the SAME overlay twice does not reuse a key. Reusing one is not a
   * harmless duplicate: PRD §34.6 makes one key map to one immutable result, so
   * the store would replay the first transaction and the second set of edits
   * would silently never land.
   */
  readonly keyPrefix?: string
}

export interface SeedOverlayResult {
  readonly overlayId: string
  readonly revision: number
  readonly affectedDocumentIds: readonly string[]
}

const DEFAULT_ACTOR: OverlayActor = {
  type: 'user',
  id: 'overlay-client-seed',
  displayName: 'Overlay client seed',
}

/**
 * Base documents usable as a merge ancestor (PRD §13.4, §13.9): a version with
 * no `_rev`, or one carrying a synthetic overlay `_rev`, cannot anchor one.
 */
function usableBaseDocuments(documents: readonly SanityDocument[]): SanityDocument[] {
  return documents.filter(
    (doc) => typeof doc._rev === 'string' && doc._rev.length > 0 && !isSyntheticRev(doc._rev),
  )
}

export async function seedOverlay(options: SeedOverlayOptions): Promise<SeedOverlayResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const actor = options.actor ?? DEFAULT_ACTOR
  const store = new FsOverlayStore({root: options.root, now})
  const base = createBaseSource(usableBaseDocuments(options.baseDocuments ?? []))

  let manifest
  try {
    manifest = await store.inspect()
  } catch {
    manifest = await store.createOverlay({
      overlayId: options.overlayId ?? 'local-site-demo',
      base: options.base ?? {projectId: 'local', dataset: 'base', apiVersion: '2025-02-19'},
      source: options.source ?? {repositoryId: 'local', branch: 'local-site-demo'},
      actor,
      ifNotExists: true,
    })
  }
  const overlayId = manifest.overlayId

  /* Hydrate from disk so seeding an existing overlay extends it rather than
   * silently starting from an empty state and losing prior edits. */
  const documents: Record<string, OverlayDocumentRecord> = {}
  for (const head of await store.listChangedDocuments(overlayId, {includeUnchanged: true})) {
    const read = await store.readDocumentByLogicalId(overlayId, head.logicalId)
    if (read?.record) documents[read.record.logicalId] = read.record
  }
  let state: OverlayState = createOverlayState({
    overlayId,
    revision: manifest.revision,
    documents,
  })

  const affected: string[] = []
  let sequence = 0
  const keyPrefix = options.keyPrefix ?? `seed-r${manifest.revision}`

  for (const seedEdit of options.edits) {
    sequence += 1
    const suffix = String(sequence).padStart(6, '0')
    const transactionOptions = {
      transactionId: `${keyPrefix}-${suffix}`,
      idempotencyKey: `${keyPrefix}-${overlayId}-${suffix}`,
      actor,
      now,
      base,
    }

    const applied =
      seedEdit.kind === 'delete'
        ? deleteDocument(state, {id: seedEdit.id}, transactionOptions)
        : applyTransaction(
            state,
            seedEdit.kind === 'create' || seedEdit.kind === 'createOrReplace'
              ? [{type: seedEdit.kind, document: seedEdit.document}]
              : [
                  {
                    type: 'patch',
                    id: `drafts.${seedEdit.id}`,
                    operations: [...seedEdit.operations],
                  },
                ],
            transactionOptions,
          )

    const records = applied.transaction.affectedDocumentIds
      .map((logicalId) => applied.state.documents[logicalId])
      .filter((record): record is OverlayDocumentRecord => record !== undefined)

    const stored = await store.commitTransaction(overlayId, {
      idempotencyKey: transactionOptions.idempotencyKey,
      actor,
      mutations: applied.transaction.mutations,
      records,
    })

    state = {...applied.state, revision: stored.manifest.revision}
    for (const id of applied.transaction.affectedDocumentIds) {
      if (!affected.includes(id)) affected.push(id)
    }
  }

  return {overlayId, revision: state.revision, affectedDocumentIds: affected}
}
