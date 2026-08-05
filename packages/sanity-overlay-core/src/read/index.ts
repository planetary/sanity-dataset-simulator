/**
 * Batch virtual-document reads (plan §6; PRD §18.1, §18.2, §22.2).
 *
 * Pure: overlay records and a read-only base view come in, virtual documents come
 * out. No IO, no GROQ, no clock — `now` and the §17.3 step 9 validator are
 * injected, exactly as in the single-document perspective resolver this builds on.
 */

export {overlayDocumentIds, resolveDocumentBatch, resolveVersionBatch} from './batch'
export type {
  BatchReadEntry,
  BatchReadOrigin,
  BatchReadRequestBase,
  BatchReadResult,
  DocumentBatchRequest,
  OverlayDocumentIdOptions,
  OverlayRecordMap,
  VersionBatchRequest,
} from './batch'
