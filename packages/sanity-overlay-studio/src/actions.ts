/**
 * Document actions in an overlay workspace (PRD §18.4–§18.9, §21.2, §21.7).
 *
 * TWO LAYERS, AND ONLY THE SECOND LIVES HERE.
 *
 * *Routing* belongs to the client facade. Studio's built-in publish, unpublish,
 * delete, discard, duplicate and restore all reach the network through
 * `client.action(...)` / `client.create(...)`, and the facade intercepts those,
 * plans them into §18 overlay operations and commits them. Replacing the action
 * components would not make that safer — it would add a second, weaker copy of
 * the same guarantee, and it would lose the built-ins' validation, disabled
 * states, keyboard shortcuts and i18n.
 *
 * *Availability* belongs here. An action the overlay has no spelling for must
 * not be clickable at all: clicking it produces a confusing failure in the
 * middle of an edit, which is exactly the experience §21.10 exists to prevent.
 *
 * The filter keys on `.action`, the stable identifier sanity 6.8.0 stamps on
 * every built-in (`SANITY_DEFINED_ACTIONS`). `displayName` is documented as
 * debug-only and is *not* 1:1 with behaviour — `PublishScheduledDraftAction`
 * carries `action: 'publish'` — so filtering on it would drop the real publish
 * button.
 */

/** The six §18.4–§18.9 actions the overlay implements. */
export const OVERLAY_ROUTED_ACTIONS = [
  'publish',
  'unpublish',
  'discardChanges',
  'delete',
  'duplicate',
  'restore',
] as const

/**
 * Actions tied to infrastructure the overlay does not reproduce.
 *
 * Releases and Scheduled Drafts are hosted version infrastructure (§32.2
 * "Unavailable"); Canvas is a hosted editing surface that writes outside the
 * overlay entirely.
 */
export const OVERLAY_BLOCKED_ACTIONS = [
  'schedule',
  'discardVersion',
  'unpublishVersion',
  'linkToCanvas',
  'editInCanvas',
  'unlinkFromCanvas',
] as const

export type OverlayActionVerdict = 'route' | 'remove' | 'keep' | 'unknown'

export interface OverlayActionDecision {
  action: string | undefined
  verdict: OverlayActionVerdict
  why: string
}

const ROUTED = new Set<string>(OVERLAY_ROUTED_ACTIONS)
const BLOCKED = new Set<string>(OVERLAY_BLOCKED_ACTIONS)

const BLOCKED_WHY: Readonly<Record<string, string>> = Object.freeze({
  schedule:
    'scheduling is hosted release infrastructure; the overlay has no scheduler and the ' +
    'schedule would silently target the real dataset',
  discardVersion:
    'release versions do not exist in the overlay (§32.3 "Release perspectives: Unavailable")',
  unpublishVersion:
    'release versions do not exist in the overlay (§32.3 "Release perspectives: Unavailable")',
  linkToCanvas: 'Canvas is a hosted editing surface that writes outside the overlay',
  editInCanvas: 'Canvas is a hosted editing surface that writes outside the overlay',
  unlinkFromCanvas: 'Canvas is a hosted editing surface that writes outside the overlay',
})

export function overlayActionDecision(action: string | undefined): OverlayActionDecision {
  if (action !== undefined && ROUTED.has(action)) {
    return {
      action,
      verdict: 'route',
      why:
        `\`${action}\` reaches the network through the intercepted client, so it is planned ` +
        `into overlay operations and committed to the overlay API — never to staging`,
    }
  }
  if (action !== undefined && BLOCKED.has(action)) {
    return {action, verdict: 'remove', why: BLOCKED_WHY[action] as string}
  }
  return {
    action,
    verdict: 'keep',
    why:
      'not a Sanity-defined action the overlay classifies; left in place, and its writes are ' +
      'still guarded by the client facade',
  }
}

/**
 * `document.actions` resolver for an overlay workspace.
 *
 * Must run *after* every plugin that contributes actions. In sanity 6.8.0 that
 * means the root config: user plugins resolve before the hosted ones, and only
 * the root config sees the full list.
 */
export function resolveOverlayDocumentActions<T extends {action?: string}>(
  prev: readonly T[],
): T[] {
  return prev.filter((entry) => overlayActionDecision(entry.action).verdict !== 'remove')
}

/**
 * The resolver `config.ts` installs once the overlay contributes actions of its
 * own — rebase (§28.4), resolve conflict (§28.3) and checkpoint (§29).
 *
 * A FACTORY, because those three need the runtime — the transport to send on,
 * the overlay's documents to compute loss from — which the availability filter
 * above deliberately knows nothing about. The caller builds the action objects
 * from {@link createOverlayActionController} and hands them in already bound.
 *
 * APPENDED, NEVER PREPENDED. The first entry of `document.actions` is the one
 * sanity 6.8.0 renders as the primary button; putting a destructive rebase
 * there would make it the default click in the editing surface.
 *
 * IDEMPOTENT. Studio re-resolves `document.actions` per document, and a resolver
 * that appended unconditionally would grow the menu on every open. Matching is
 * on `.action` — the same stable key the filter uses — so re-running over an
 * already-resolved list is a no-op rather than a duplicate.
 */
export function overlayDocumentActionsResolver<T extends {action?: string}>(
  appended: readonly T[],
): (prev: readonly T[]) => T[] {
  return (prev) => {
    const kept = resolveOverlayDocumentActions(prev)
    const present = new Set(kept.map((entry) => entry.action))
    return [...kept, ...appended.filter((entry) => !present.has(entry.action))]
  }
}
