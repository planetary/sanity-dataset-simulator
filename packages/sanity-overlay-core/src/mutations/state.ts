/**
 * Overlay state the mutation engine operates on, plus the synthetic system field
 * stamping every write goes through (PRD §13.3, §13.5, §13.9, §13.10).
 *
 * `OverlayState` is the in-memory projection of the persisted §13 model that the
 * pure engine needs: the overlay revision counter (§34.5), the document records
 * (§13.3), the committed transaction log (§13.10), and the idempotency ledger
 * (§34.6). Storage layout is a Phase 3/4 concern; nothing here touches I/O.
 */
import {checksum, syntheticRev} from '../checksum'
import {DRAFTS_PREFIX, isDraftId, toPublishedId} from '../encoding'
import type {SanityDocument} from '../types/document'
import {OVERLAY_FORMAT_VERSION, type OverlayFormatVersion} from '../types/format-version'
import type {OverlayActor} from '../types/actor'
import type {OverlayDocumentRecord, LocalDocumentVersion} from '../types/record'
import type {OverlayTransactionRecord} from '../types/transaction'
import {deepClone} from './paths'

/** Which of a document's two local versions a mutation targets. */
export type VersionKind = 'draft' | 'published'

/** `drafts.x` targets the draft version, `x` the published version (PRD §18.1, §18.2). */
export function versionKindFor(id: string): VersionKind {
  return isDraftId(id) ? 'draft' : 'published'
}

/** The perspective-specific document ID for a logical ID (PRD §13.9 `_id` rule). */
export function documentIdFor(logicalId: string, version: VersionKind): string {
  return version === 'draft' ? `${DRAFTS_PREFIX}${logicalId}` : logicalId
}

export interface OverlayState {
  formatVersion: OverlayFormatVersion
  overlayId: string
  /** PRD §13.1 `revision`. Incremented exactly once per committed transaction (§34.5). */
  revision: number
  documents: Readonly<Record<string, OverlayDocumentRecord>>
  /** Committed transaction records in commit order (PRD §13.10). */
  transactions: readonly OverlayTransactionRecord[]
  /** `idempotencyKey` → committed transaction record (PRD §34.6). */
  idempotencyLedger: Readonly<Record<string, OverlayTransactionRecord>>
}

export interface CreateOverlayStateOptions {
  overlayId?: string
  revision?: number
  documents?: Record<string, OverlayDocumentRecord>
  transactions?: readonly OverlayTransactionRecord[]
  idempotencyLedger?: Record<string, OverlayTransactionRecord>
}

/** An empty overlay at revision 0. */
export function createOverlayState(options: CreateOverlayStateOptions = {}): OverlayState {
  return {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId: options.overlayId ?? 'overlay-test',
    revision: options.revision ?? 0,
    documents: options.documents ?? {},
    transactions: options.transactions ?? [],
    idempotencyLedger: options.idempotencyLedger ?? {},
  }
}

/** Look up a document record by logical ID (`drafts.` prefixes are normalized away). */
export function getRecord(state: OverlayState, id: string): OverlayDocumentRecord | null {
  return state.documents[toPublishedId(id)] ?? null
}

/** Return a copy of `state` with one document record replaced. */
export function withRecord(state: OverlayState, record: OverlayDocumentRecord): OverlayState {
  return {...state, documents: {...state.documents, [record.logicalId]: record}}
}

/* ------------------------------------------------------------------ *
 * Synthetic system fields (PRD §13.9)
 * ------------------------------------------------------------------ */

export interface SyntheticFieldInput {
  document: SanityDocument
  /** The document ID for the target perspective (`drafts.` form for drafts). */
  documentId: string
  /** Overlay revision this version is stamped with (PRD §13.9 `_rev`). */
  overlayRevision: number | string
  /** Mutation time (PRD §13.9 `_updatedAt` = "latest local mutation time"). */
  now: string
  /** Existing `_createdAt`: preserved from base, or set once at branch creation. */
  createdAt?: string
}

/**
 * Stamp `_id`, `_updatedAt`, `_createdAt` and the synthetic `_rev` on a
 * materialized document (PRD §13.9).
 *
 * The checksum feeding `_rev` is taken over the document *without* `_rev`, so the
 * value is well-defined and deterministic for the same logical state
 * (PRD §35.2 "Synthetic system fields are deterministic").
 */
export function applySyntheticSystemFields(input: SyntheticFieldInput): SanityDocument {
  const next = deepClone(input.document)
  next._id = input.documentId
  next._createdAt = input.createdAt ?? input.document._createdAt ?? input.now
  next._updatedAt = input.now
  delete next._rev
  next._rev = syntheticRev(input.overlayRevision, checksum(next))
  return next
}

/**
 * The revision a `patch.ifRevision` precondition is compared against (PRD §13.7).
 *
 * A locally modified version reports its synthetic `_rev` (§13.9); an untouched
 * base-origin version reports the observed Content Lake revision.
 */
export function currentRevisionOf(
  record: OverlayDocumentRecord | null,
  version: VersionKind,
): string | null {
  if (record === null) return null
  const local = version === 'draft' ? record.local.draft : record.local.published
  if (local !== null) return local.materialized._rev ?? local.overlayRevision
  if (record.base === null) return null
  const base = version === 'draft' ? record.base.draft : record.base.published
  return base === null ? null : base.revision
}

/** A new empty local version, used when a document is first touched. */
export function createLocalVersion(
  input: Pick<
    LocalDocumentVersion,
    'materialized' | 'touchedPaths' | 'operations' | 'ancestorKind' | 'overlayRevision'
  > & {ancestorRevision?: string; createdAt: string; updatedAt: string},
): LocalDocumentVersion {
  const version: LocalDocumentVersion = {
    materialized: input.materialized,
    touchedPaths: input.touchedPaths,
    operations: input.operations,
    ancestorKind: input.ancestorKind,
    overlayRevision: input.overlayRevision,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
  if (input.ancestorRevision !== undefined) version.ancestorRevision = input.ancestorRevision
  return version
}

/** Empty local block for a new record (PRD §13.3). */
export function emptyLocalBlock(): OverlayDocumentRecord['local'] {
  return {published: null, draft: null, publishedTombstone: false, draftTombstone: false}
}

export interface NewRecordInput {
  overlayId: string
  logicalId: string
  schemaType: string
  origin: OverlayDocumentRecord['origin']
  now: string
  actor?: OverlayActor
  base?: OverlayDocumentRecord['base']
  runtimeRevision: string
}

/** Build a fresh §13.3 document record. */
export function createDocumentRecord(input: NewRecordInput): OverlayDocumentRecord {
  const record: OverlayDocumentRecord = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId: input.overlayId,
    logicalId: input.logicalId,
    schemaType: input.schemaType,
    origin: input.origin,
    base: input.base ?? null,
    local: emptyLocalBlock(),
    conflicts: [],
    runtimeRevision: input.runtimeRevision,
    createdAt: input.now,
    updatedAt: input.now,
  }
  if (input.actor !== undefined) {
    record.createdBy = input.actor
    record.updatedBy = input.actor
  }
  return record
}
