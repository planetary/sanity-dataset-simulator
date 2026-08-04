/**
 * Workstream W3 — perspective resolution (plan §6; PRD §18.1-§18.3).
 *
 * Pure: the record and the current base documents come in, a resolution comes
 * out. Time arrives as `now`; schema validation arrives as the injected
 * §17.3 step 9 `MergeValidator` port.
 */

export {
  OVERLAY_PERSPECTIVES,
  resolveDraftsPerspective,
  resolvePerspective,
  resolvePublishedPerspective,
  resolveRawPerspective,
  unsetPathsFromOperations,
} from './resolve'
export type {
  OverlayPerspective,
  PerspectiveBase,
  PerspectiveRequest,
  PerspectiveResolution,
  PerspectiveSource,
  RawPerspectiveView,
} from './resolve'
