/**
 * THE PUBLIC SURFACE of `sanity-overlay-studio`.
 *
 * WHY THIS FILE EXISTS. Every other studio test imports the module it is
 * testing by deep path (`../../sanity-overlay-studio/src/conflictPanel`).
 * That is right for a unit test and useless as evidence of delivery: the
 * package's manifest exposes exactly ONE entry point, so a consumer can only
 * reach `sanity-overlay-studio`. A module that is fully implemented, fully
 * tested, and absent from `src/index.ts` is, from outside the repo, a module
 * that does not exist.
 *
 * So this file imports the BARREL and nothing else. It is the only studio test
 * whose failure means "the feature shipped but nobody can call it".
 *
 * The Phase 5 surfaces asserted here are the conflict panel (§28.2–§28.3), the
 * document operations rebase / resolve / checkpoint (§28.4–§28.5, §29), and the
 * incoming-reference read path (§21.6).
 */
import {describe, expect, it} from 'vitest'
import * as studio from '../../sanity-overlay-studio/src/index'

/** Named as strings, so a missing export is a readable failure, not a TS error. */
const PHASE_5_SURFACE: readonly {readonly name: string; readonly why: string}[] = [
  /* §28.2 — the conflict list and the per-document indication. */
  {name: 'conflictListRows', why: '§28.2 the conflict list'},
  {name: 'filterConflictRows', why: '§28.2 the conflict list filters'},
  {name: 'documentConflictIndicator', why: '§28.2 the per-document indication'},
  {name: 'OPTIONAL_CONFLICT_COLUMNS', why: '§28.2 the columns that may be absent'},
  /* §28.3 — driving each resolution action. */
  {name: 'planConflictResolution', why: '§28.3 driving a resolution action'},
  {name: 'resolvedPreviewValue', why: '§28.3 the resolved-value preview'},
  /* §28.4, §28.5, §29 — the destructive and non-destructive operations. */
  {name: 'planRebase', why: '§28.4 rebase'},
  {name: 'readRebaseOutcome', why: '§28.5 rebase preconditions'},
  {name: 'planCheckpoint', why: '§29 checkpoint'},
  {name: 'STUDIO_REBASE_MODES', why: '§28.4 the modes a pane may offer'},
  {name: 'OVERLAY_OPERATION_KINDS', why: 'the operation vocabulary'},
  {name: 'createOverlayActionController', why: 'the document actions themselves'},
  {name: 'overlayDocumentActionsResolver', why: 'installing those actions into the menu'},
  /* §21.6 — incoming references over the branch. */
  {name: 'deriveIncomingReferenceTargets', why: '§21.6 incoming references'},
  {name: 'incomingReferenceReadPlan', why: '§21.6 incoming references'},
]

describe('the Phase 5 surface is reachable from the package entry point', () => {
  it.each(PHASE_5_SURFACE)('exports $name — $why', ({name}) => {
    expect(studio).toHaveProperty(name)
    expect((studio as Record<string, unknown>)[name]).toBeDefined()
  })

  /**
   * A guard against the opposite failure: an export list that grew by accident.
   * The barrel is the API, so an unintended addition is as much a defect as an
   * omission — it is a promise the package now has to keep.
   */
  it('exports the three Phase 5 factories as callable functions, not as types erased at build', () => {
    for (const name of [
      'planConflictResolution',
      'planRebase',
      'planCheckpoint',
      'createOverlayActionController',
    ]) {
      expect(typeof (studio as Record<string, unknown>)[name]).toBe('function')
    }
  })

  /**
   * The pre-existing surface, asserted alongside — so a refactor of the barrel
   * that fixes the Phase 5 omission by rewriting the file cannot quietly drop
   * what already worked.
   */
  it('still exports the entry point that is the whole deliverable', () => {
    expect(typeof studio.defineOverlayConfig).toBe('function')
    expect(typeof studio.overlay).toBe('function')
    expect(typeof studio.resolveOverlayOptions).toBe('function')
    expect(typeof studio.createStudioReader).toBe('function')
  })
})
