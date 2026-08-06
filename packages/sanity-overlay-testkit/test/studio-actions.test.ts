/**
 * `sanity-overlay-studio` — document actions (PRD §18.4–§18.9, §21.2, §21.7).
 *
 * TWO LAYERS, AND ONLY THE SECOND IS IN THIS FILE.
 *
 * 1. *Routing* is owned by the client facade: Studio's built-in publish,
 *    unpublish, delete, discard, duplicate and restore all reach the network
 *    through `client.action(...)` / `client.create(...)`, which the facade
 *    intercepts and commits to the overlay. `test/studio-facade.test.ts` pins
 *    that a publish becomes a `documentActions` commit and never touches the
 *    real client. Replacing the components would not make that safer — it would
 *    only add a second, weaker copy of the same guarantee.
 *
 * 2. *Availability* is owned here: the actions the overlay has **no** spelling
 *    for must not be reachable at all, because clicking them produces a
 *    confusing failure mid-edit. sanity 6.8.0 tags every built-in with a stable
 *    `.action` string (`SANITY_DEFINED_ACTIONS`), which is what this resolver
 *    filters on — not `displayName`, which is documented as debug-only.
 */
import {describe, expect, it} from 'vitest'
import {
  OVERLAY_BLOCKED_ACTIONS,
  OVERLAY_ROUTED_ACTIONS,
  overlayActionDecision,
  overlayDocumentActionsResolver,
  resolveOverlayDocumentActions,
} from '../../sanity-overlay-studio/src/actions'

interface FakeAction {
  action?: string
  displayName?: string
}

const BUILT_INS: FakeAction[] = [
  {action: 'publish', displayName: 'PublishAction'},
  {action: 'unpublish', displayName: 'UnpublishAction'},
  {action: 'discardChanges', displayName: 'DiscardChangesAction'},
  {action: 'duplicate', displayName: 'DuplicateAction'},
  {action: 'delete', displayName: 'DeleteAction'},
  {action: 'restore', displayName: 'HistoryRestoreAction'},
  {action: 'schedule', displayName: 'ScheduleAction'},
  {action: 'discardVersion', displayName: 'DiscardVersionAction'},
  {action: 'unpublishVersion', displayName: 'UnpublishVersionAction'},
  {action: 'linkToCanvas', displayName: 'LinkToCanvasAction'},
  {action: 'editInCanvas', displayName: 'EditInCanvasAction'},
  {action: 'unlinkFromCanvas', displayName: 'UnlinkFromCanvasAction'},
]

describe('the two action sets', () => {
  it('routes the six §18.4–§18.9 actions through the overlay', () => {
    expect([...OVERLAY_ROUTED_ACTIONS]).toEqual([
      'publish',
      'unpublish',
      'discardChanges',
      'delete',
      'duplicate',
      'restore',
    ])
  })

  it('blocks every action tied to hosted release or Canvas infrastructure', () => {
    expect([...OVERLAY_BLOCKED_ACTIONS].sort()).toEqual(
      [
        'schedule',
        'discardVersion',
        'unpublishVersion',
        'linkToCanvas',
        'editInCanvas',
        'unlinkFromCanvas',
      ].sort(),
    )
  })

  it('covers every built-in sanity 6.8.0 defines — none is left unclassified', () => {
    for (const builtIn of BUILT_INS) {
      const decision = overlayActionDecision(builtIn.action)
      expect(decision.verdict, builtIn.action).not.toBe('unknown')
    }
  })
})

describe('overlayActionDecision', () => {
  it.each([...OVERLAY_ROUTED_ACTIONS])('keeps %s and says where it goes', (action) => {
    const decision = overlayActionDecision(action)
    expect(decision.verdict).toBe('route')
    expect(decision.why).toMatch(/overlay/i)
  })

  it.each([...OVERLAY_BLOCKED_ACTIONS])('removes %s and says why', (action) => {
    const decision = overlayActionDecision(action)
    expect(decision.verdict).toBe('remove')
    expect(decision.why.length).toBeGreaterThan(20)
  })

  it('leaves a consumer’s own action alone rather than guessing', () => {
    expect(overlayActionDecision(undefined).verdict).toBe('keep')
    expect(overlayActionDecision('myCustomAction').verdict).toBe('keep')
  })
})

describe('resolveOverlayDocumentActions', () => {
  it('keeps the six routed built-ins and drops the six unrepresentable ones', () => {
    const kept = resolveOverlayDocumentActions(BUILT_INS).map((action) => action.action)
    expect(kept).toEqual([
      'publish',
      'unpublish',
      'discardChanges',
      'duplicate',
      'delete',
      'restore',
    ])
  })

  it('preserves the order Studio gave them', () => {
    const reordered = [
      {action: 'delete'},
      {action: 'publish'},
      {action: 'schedule'},
      {action: 'duplicate'},
    ]
    expect(resolveOverlayDocumentActions(reordered).map((a) => a.action)).toEqual([
      'delete',
      'publish',
      'duplicate',
    ])
  })

  it('keeps a plugin’s custom actions', () => {
    const custom = {action: undefined, displayName: 'MyAction'}
    expect(resolveOverlayDocumentActions([custom, {action: 'schedule'}])).toEqual([custom])
  })

  it('does not mutate the input array', () => {
    const prev = [...BUILT_INS]
    resolveOverlayDocumentActions(prev)
    expect(prev).toHaveLength(BUILT_INS.length)
  })

  it('filters on .action, not on displayName', () => {
    /* Scheduled-draft variants reuse keys — `PublishScheduledDraftAction.action`
     * is literally `"publish"`. A displayName-based filter would drop the real
     * publish button; an `.action`-based one keeps it. */
    const disguised = [{action: 'publish', displayName: 'PublishScheduledDraftAction'}]
    expect(resolveOverlayDocumentActions(disguised)).toEqual(disguised)
  })

  it('is empty in, empty out', () => {
    expect(resolveOverlayDocumentActions([])).toEqual([])
  })
})

/* ══════════════════════════════ installing the Phase 5 actions (§28, §29) */

/**
 * THE DELIVERY SEAM.
 *
 * `resolveOverlayDocumentActions` only ever REMOVED actions. Rebase, resolve
 * conflict and checkpoint are actions the overlay ADDS, and until the resolver
 * that actually runs in `config.ts` appends them they exist only as exported
 * functions nobody calls — the same "shipped but unreachable" failure the
 * barrel test covers, one layer further out.
 *
 * A FACTORY rather than a second bare function, because these actions need the
 * runtime (transport, the overlay's documents) that the availability filter
 * deliberately knows nothing about.
 */
describe('overlayDocumentActionsResolver — the overlay’s own actions reach the menu', () => {
  const OVERLAY_OWN: FakeAction[] = [
    {action: 'overlayRebase', displayName: 'OverlayRebaseAction'},
    {action: 'overlayResolveConflict', displayName: 'OverlayConflictResolutionAction'},
    {action: 'overlayCheckpoint', displayName: 'OverlayCheckpointAction'},
  ]

  it('appends the overlay’s actions to the built-ins', () => {
    const actions = overlayDocumentActionsResolver(OVERLAY_OWN)(BUILT_INS).map((e) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining(['overlayRebase', 'overlayResolveConflict', 'overlayCheckpoint']),
    )
  })

  it('still removes the blocked actions while appending its own', () => {
    const actions = overlayDocumentActionsResolver(OVERLAY_OWN)(BUILT_INS).map((e) => e.action)
    for (const blocked of OVERLAY_BLOCKED_ACTIONS) expect(actions).not.toContain(blocked)
    /* And the routed built-ins survive — appending must not replace the menu. */
    for (const routed of OVERLAY_ROUTED_ACTIONS) expect(actions).toContain(routed)
  })

  it('puts the overlay’s actions last, after the built-ins the editor expects first', () => {
    const actions = overlayDocumentActionsResolver(OVERLAY_OWN)(BUILT_INS).map((e) => e.action)
    expect(actions.slice(-3)).toEqual([
      'overlayRebase',
      'overlayResolveConflict',
      'overlayCheckpoint',
    ])
  })

  it('never appends the same action twice when the resolver runs again', () => {
    /* sanity 6.8.0 re-resolves `document.actions` per document. A resolver that
     * appended unconditionally would grow the menu without bound. */
    const resolve = overlayDocumentActionsResolver(OVERLAY_OWN)
    const once = resolve(BUILT_INS)
    const twice = resolve(once)
    expect(twice.filter((entry) => entry.action === 'overlayRebase')).toHaveLength(1)
    expect(twice).toHaveLength(once.length)
  })

  it('does not mutate the array Studio handed it', () => {
    const prev = [...BUILT_INS]
    overlayDocumentActionsResolver(OVERLAY_OWN)(prev)
    expect(prev).toHaveLength(BUILT_INS.length)
  })

  it('appends nothing when the overlay contributes nothing, and still filters', () => {
    const actions = overlayDocumentActionsResolver([])(BUILT_INS).map((e) => e.action)
    expect(actions).toEqual(resolveOverlayDocumentActions(BUILT_INS).map((e) => e.action))
  })
})
