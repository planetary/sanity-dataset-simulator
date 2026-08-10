/**
 * The overlay status model — PRD §21.3 banner, §32 degradation, §33 failure modes.
 *
 * §21.3 is not a badge specification: it is a state machine whose output governs
 * whether editing is allowed at all. The interesting question is therefore never
 * "what colour is the banner" but *which state wins when several are true at
 * once* — get that wrong and a fatal condition renders as a warning while the
 * editor types into a document that can never be saved.
 *
 * So the state list below IS the precedence order, and it is walked top to
 * bottom. Pure: no React, no DOM, no clock. The banner component renders this
 * and derives nothing of its own.
 */

import type {OverlaySessionState} from './client/echo'
import type {OverlayMode} from './options'

/** §21.3's table, ordered most severe first. The order is the precedence. */
export const OVERLAY_BANNER_STATES = [
  'identity-mismatch',
  'disabled-unexpectedly',
  'unauthenticated',
  'offline',
  /**
   * §14.4's other writer won, and this session is behind it.
   *
   * BELOW `offline` because an unreachable API cannot tell you the branch moved,
   * and ABOVE everything else because it is the only remaining state in which
   * writes are accepted by the editor and refused by the server *permanently*.
   * Conflicts and schema mismatches still let edits land; this does not.
   */
  'branch-moved',
  'schema-mismatch',
  'hard-conflict',
  'soft-conflict',
  'saving',
  'healthy',
] as const

export type OverlayBannerState = (typeof OVERLAY_BANNER_STATES)[number]

export type OverlaySeverity = 'neutral' | 'warning' | 'critical'

/** What the editor may do. */
export type OverlayEditing =
  /** Normal editing. */
  | 'normal'
  /** Reads work, writes do not. */
  | 'read-only'
  /** Fatal: neither reads nor writes. */
  | 'blocked'

export interface OverlayStatusLine {
  label: string
  value: string
}

export interface OverlayStatusInput {
  enabled: boolean
  /** What the configuration *said* should happen. A mismatch is fatal (§21.3). */
  expectedEnabled?: boolean
  mode: OverlayMode
  apiUrl: string
  overlayId: string | null
  connection: 'ok' | 'unreachable'
  session: OverlaySessionState
  revision?: number
  /** Writes committed but not yet acknowledged. */
  pendingWrites: number
  /** Writes the overlay API could not accept (transient). */
  degradedWrites: number
  /**
   * Writes the §34.6 ledger answered from its record instead of applying
   * (`transport.ts` `replayed`).
   *
   * A LINE, NOT A BANNER STATE, and the distinction is deliberate. The banner
   * states are a precedence machine governing whether editing is allowed at
   * all, and a replay does not change that: reads work, writes work, and the
   * named transaction really is in the ledger. What it does change is whether
   * "saved" can be believed for THAT write — which is a fact to put in front of
   * the editor, not a mode to put the Studio into. Absent or `0` renders
   * nothing, so a healthy session is unchanged.
   */
  replayedWrites?: number
  /** Edits since the last checkpoint (§29.6). */
  uncheckpointedEdits: number
  conflicts: {hard: number; soft: number}
  /**
   * A commit came back `409` after the server had already reconciled once
   * (`transport.ts` outcome `stale`).
   *
   * It LATCHES, and that is the point: the session's in-memory revision chain is
   * behind the disk and nothing it sends will be accepted until the tab reloads.
   * A banner that cleared itself on the next successful read would let the
   * editor keep typing into a document that cannot be saved — the failure this
   * state exists to make impossible.
   */
  branchMoved?: boolean
  schemaMismatch?: boolean
  identityMismatch?: boolean
  base?: {dataset: string; revision?: string}
}

export interface OverlayStatus {
  state: OverlayBannerState
  severity: OverlaySeverity
  editing: OverlayEditing
  fatal: boolean
  publishBlocked: boolean
  headline: string
  lines: OverlayStatusLine[]
  uncheckpointedEdits: number
  conflicts: {hard: number; soft: number}
}

/**
 * §21.3 "Read-only after local retry buffer limit". The number is the buffer:
 * below it the editor keeps typing optimistically, above it the overlay has
 * demonstrably stopped accepting writes and pretending otherwise loses work.
 */
const RETRY_BUFFER_LIMIT = 20

const SEVERITY: Readonly<Record<OverlayBannerState, OverlaySeverity>> = Object.freeze({
  'identity-mismatch': 'critical',
  'disabled-unexpectedly': 'critical',
  unauthenticated: 'critical',
  offline: 'critical',
  'branch-moved': 'critical',
  'schema-mismatch': 'critical',
  'hard-conflict': 'critical',
  'soft-conflict': 'warning',
  saving: 'neutral',
  healthy: 'neutral',
})

const STORAGE_LABEL: Readonly<Record<OverlayMode, string>> = Object.freeze({
  off: 'native Sanity (overlay off)',
  fs: 'filesystem (.sanity-overlay)',
  blob: 'Vercel Blob',
  memory: 'in-memory (nothing is persisted)',
})

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function deriveOverlayStatus(input: OverlayStatusInput): OverlayStatus {
  const conflicts = input.conflicts
  const expectedEnabled = input.expectedEnabled ?? input.enabled

  const {state, headline, editing, publishBlocked} = classify(input, expectedEnabled)

  const lines: OverlayStatusLine[] = [
    {
      label: 'Overlay',
      value: input.overlayId ?? 'local (no branch or PR identity set)',
    },
    {label: 'Storage', value: STORAGE_LABEL[input.mode]},
    {
      label: 'Base',
      value:
        input.base === undefined
          ? 'live and read only'
          : `${input.base.revision ? `${input.base.revision}/` : ''}${input.base.dataset}, live and read only`,
    },
    {label: 'Overlay revision', value: input.revision === undefined ? '—' : String(input.revision)},
    {label: 'Conflicts', value: `${conflicts.soft} soft, ${conflicts.hard} hard`},
    {
      label: 'Checkpoint',
      value:
        input.uncheckpointedEdits === 0
          ? 'up to date'
          : `behind by ${pluralize(input.uncheckpointedEdits, 'edit')}`,
    },
    {label: 'Overlay API', value: input.apiUrl},
  ]

  /* Appended, and only when there is something to say — see
   * {@link OverlayStatusInput.replayedWrites}. */
  if ((input.replayedWrites ?? 0) > 0) {
    lines.push({
      label: 'Replayed writes',
      value:
        `${pluralize(input.replayedWrites ?? 0, 'write')} answered from the idempotency ledger ` +
        `and NOT applied — re-read those documents`,
    })
  }

  return {
    state,
    severity: SEVERITY[state],
    editing,
    fatal: editing === 'blocked',
    publishBlocked,
    headline,
    lines,
    uncheckpointedEdits: input.uncheckpointedEdits,
    conflicts,
  }
}

function classify(
  input: OverlayStatusInput,
  expectedEnabled: boolean,
): {
  state: OverlayBannerState
  headline: string
  editing: OverlayEditing
  publishBlocked: boolean
} {
  if (input.identityMismatch === true) {
    return {
      state: 'identity-mismatch',
      headline:
        'Overlay identity mismatch: the stored overlay was written for a different branch, ' +
        'repository or dataset. Reads and writes are stopped.',
      editing: 'blocked',
      publishBlocked: true,
    }
  }

  if (!input.enabled && expectedEnabled) {
    return {
      state: 'disabled-unexpectedly',
      headline:
        'The overlay was expected but is unavailable. Editing is stopped — the overlay never ' +
        'falls back to writing the shared dataset.',
      editing: 'blocked',
      publishBlocked: true,
    }
  }

  if (!input.enabled) {
    return {
      state: 'healthy',
      headline: 'Overlay off — this Studio is editing the native Sanity dataset.',
      editing: 'normal',
      publishBlocked: false,
    }
  }

  if (input.session !== 'active') {
    return {
      state: 'unauthenticated',
      headline:
        input.session === 'logged-out'
          ? 'Signed out. The overlay will not acknowledge writes; reload after signing in.'
          : 'Your Sanity session is no longer authenticated. Editing is read-only until the ' +
            'token refreshes.',
      editing: 'read-only',
      publishBlocked: true,
    }
  }

  if (input.connection === 'unreachable') {
    const exhausted = input.degradedWrites >= RETRY_BUFFER_LIMIT
    return {
      state: 'offline',
      headline:
        `The overlay API at ${input.apiUrl} is unreachable. ` +
        (exhausted
          ? 'Too many edits are unsaved — editing is now read-only to avoid losing more.'
          : 'Edits are held locally and will be retried.'),
      editing: exhausted ? 'read-only' : 'normal',
      publishBlocked: true,
    }
  }

  if (input.branchMoved === true) {
    return {
      state: 'branch-moved',
      headline:
        'The branch moved underneath this session — another writer (a CLI run, an agent, a Git ' +
        'merge or a second tab) changed the overlay, and edits made here are no longer being ' +
        'saved. Reload the Studio to pick up the current branch state. Nothing was written to ' +
        'the shared dataset.',
      editing: 'read-only',
      publishBlocked: true,
    }
  }

  if (input.schemaMismatch === true) {
    return {
      state: 'schema-mismatch',
      headline:
        'Schema mismatch between the branch schema and stored overlay documents. Affected ' +
        'documents cannot be published.',
      editing: 'normal',
      publishBlocked: true,
    }
  }

  if (input.conflicts.hard > 0) {
    return {
      state: 'hard-conflict',
      headline:
        `${pluralize(input.conflicts.hard, 'hard conflict')} with the current base. Draft ` +
        'editing continues; branch publish is blocked until they are resolved.',
      editing: 'normal',
      publishBlocked: true,
    }
  }

  if (input.conflicts.soft > 0) {
    return {
      state: 'soft-conflict',
      headline:
        `${pluralize(input.conflicts.soft, 'soft conflict')} with the current base. Local ` +
        'values are winning; review them before promotion.',
      editing: 'normal',
      publishBlocked: false,
    }
  }

  if (input.pendingWrites > 0) {
    return {
      state: 'saving',
      headline: `Saving ${pluralize(input.pendingWrites, 'change')} to the overlay…`,
      editing: 'normal',
      publishBlocked: false,
    }
  }

  return {
    state: 'healthy',
    headline: 'Branch overlay active. Edits stay local and never reach the shared dataset.',
    editing: 'normal',
    publishBlocked: false,
  }
}
