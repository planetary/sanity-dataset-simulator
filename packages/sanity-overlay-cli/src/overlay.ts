/**
 * Opening an overlay, and reading it without dying on a broken file.
 *
 * Every command starts here. Two rules are enforced in one place rather than in
 * ten:
 *
 * 1. A store error becomes a `CliError` with `EXIT.OVERLAY` and the store's own
 *    `code`. The CLI does not invent a second error taxonomy over PRD §25.14.
 * 2. One unreadable document does not take down a whole report. `loadRecords`
 *    collects per-document failures so `validate` can *report* them — which is
 *    the entire point of `validate` — instead of throwing on the first one.
 */
import {stat} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {
  isOverlayStoreError,
  toPublishedId,
  type OverlayDocumentHead,
  type OverlayDocumentRecord,
  type OverlayManifest,
} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {CliError, overlayError, usageError} from './errors'
import {EXIT} from './exit'

export interface OpenedOverlay {
  readonly root: string
  readonly store: FsOverlayStore
  readonly manifest: OverlayManifest
  readonly overlayId: string
}

/** Turn any store failure into the CLI's overlay exit code, preserving its code. */
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (isOverlayStoreError(error)) {
    return overlayError(error.message, error.code, error.details)
  }
  return new CliError(EXIT.ERROR, 'INTERNAL', error instanceof Error ? error.message : String(error))
}

/** Resolve and validate `--root`, which must be an existing directory. */
export async function resolveRoot(cwd: string, rootOption: string | undefined): Promise<string> {
  const root = isAbsolute(rootOption ?? '') ? rootOption! : resolve(cwd, rootOption ?? '.')
  let stats
  try {
    stats = await stat(root)
  } catch {
    throw usageError(`Root ${root} does not exist`, {root})
  }
  if (!stats.isDirectory()) {
    throw usageError(`Root ${root} is not a directory`, {root})
  }
  return root
}

export function createStore(root: string, now: () => string): FsOverlayStore {
  return new FsOverlayStore({root, now})
}

/** Read the manifest, or fail with `EXIT.OVERLAY` and a message a human can act on. */
export async function openOverlay(root: string, now: () => string): Promise<OpenedOverlay> {
  const store = createStore(root, now)
  let manifest: OverlayManifest
  try {
    manifest = await store.inspect()
  } catch (error) {
    if (isOverlayStoreError(error) && error.code === 'OVERLAY_NOT_FOUND') {
      throw overlayError(
        `No overlay found at ${root} — there is no .sanity-overlay/manifest.json here (OVERLAY_NOT_FOUND)`,
        'OVERLAY_NOT_FOUND',
        {root},
      )
    }
    throw asCliError(error)
  }
  return {root, store, manifest, overlayId: manifest.overlayId}
}

export interface UnreadableDocument {
  readonly logicalId: string
  readonly code: string
  readonly message: string
}

export interface MissingRef {
  readonly kind: 'snapshot'
  readonly ref: string
  readonly logicalId: string
  readonly reason: string
}

export interface LoadedRecords {
  /** Logical ID → §13.3 record, for every document whose record survived. */
  readonly records: Record<string, OverlayDocumentRecord>
  /** Heads in manifest order, whether or not their record could be read. */
  readonly heads: readonly OverlayDocumentHead[]
  /**
   * Genuine damage: the read threw, or the canonical `intent.json` a head names
   * could not be parsed. These are findings.
   */
  readonly unreadable: readonly UnreadableDocument[]
  /**
   * Heads whose review surface is intact but whose immutable §13.3 record is
   * gone — a fresh `git clone` where `.runtime/` was never committed, or an
   * overlay restored from a checkpoint tree. The store contract calls this out
   * explicitly, so it is informational and NOT a finding.
   */
  readonly recordsUnavailable: readonly string[]
  /** A head's intent names a base snapshot that is no longer stored (PRD §34.3). */
  readonly missingSnapshots: readonly MissingRef[]
}

/** Read every document the manifest names, collecting failures instead of throwing. */
export async function loadRecords(opened: OpenedOverlay): Promise<LoadedRecords> {
  const heads = await opened.store.listChangedDocuments(opened.overlayId, {includeUnchanged: true})
  const records: Record<string, OverlayDocumentRecord> = {}
  const unreadable: UnreadableDocument[] = []
  const recordsUnavailable: string[] = []
  const missingSnapshots: MissingRef[] = []

  for (const head of heads) {
    let read
    try {
      read = await opened.store.readDocumentByLogicalId(opened.overlayId, head.logicalId)
    } catch (error) {
      const cli = asCliError(error)
      unreadable.push({logicalId: head.logicalId, code: cli.code, message: cli.message})
      continue
    }

    if (read === null) {
      unreadable.push({
        logicalId: head.logicalId,
        code: 'OVERLAY_HEAD_UNRESOLVABLE',
        message: `Manifest names a head for ${head.logicalId} but the store resolves nothing for it`,
      })
      continue
    }

    if (read.record) records[read.record.logicalId] = read.record
    else recordsUnavailable.push(head.logicalId)

    if (read.intent === null) {
      /* The store refuses malformed JSON and retains the last valid state
       * (PRD §14.3). With no cached previous value there is nothing to serve,
       * so the canonical review file for this head is effectively gone. */
      unreadable.push({
        logicalId: head.logicalId,
        code: 'INTENT_UNREADABLE',
        message: `documents/${head.logicalId}/intent.json could not be parsed or failed validation (PRD §14.3)`,
      })
      continue
    }

    const snapshotRef = read.intent.base.snapshotRef
    if (snapshotRef !== undefined && read.baseSnapshot === null) {
      missingSnapshots.push({
        kind: 'snapshot',
        ref: `snapshots/${snapshotRef}.json`,
        logicalId: head.logicalId,
        reason: `intent for ${head.logicalId} names base snapshot ${snapshotRef}, which is not stored`,
      })
    }
  }

  return {records, heads, unreadable, recordsUnavailable, missingSnapshots}
}

/** Resolve a user-supplied document ID against the overlay, normalizing `drafts.`. */
export function requireHead(
  manifest: OverlayManifest,
  documentId: string,
): OverlayDocumentHead {
  const logicalId = toPublishedId(documentId)
  const head = manifest.documentHeads[logicalId]
  if (head === undefined) {
    throw overlayError(
      `Overlay ${manifest.overlayId} does not touch document ${JSON.stringify(documentId)}`,
      'OVERLAY_DOCUMENT_NOT_IN_OVERLAY',
      {documentId, logicalId},
    )
  }
  return head
}

/** Document heads in logical-ID order — the CLI's one ordering rule for lists. */
export function sortedHeads(manifest: OverlayManifest): OverlayDocumentHead[] {
  return Object.values(manifest.documentHeads).sort((a, b) =>
    a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0,
  )
}
