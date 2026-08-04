/**
 * PRD §37 Phase 1 "Add format version handling".
 *
 * `formatVersion: 1` is a literal on the manifest (§13.1), document record
 * (§13.3), checkpoint intent (§14.2), transaction record (§13.10) and identity
 * hash input (§12.1). The literal type lives here so every §13 type and the
 * version guard share one source.
 */

/** The only overlay format version this build reads or writes. */
export const OVERLAY_FORMAT_VERSION = 1

export type OverlayFormatVersion = typeof OVERLAY_FORMAT_VERSION

/** Anything persisted with a format version stamp. */
export interface OverlayVersionedRecord {
  formatVersion: number
  [key: string]: unknown
}
