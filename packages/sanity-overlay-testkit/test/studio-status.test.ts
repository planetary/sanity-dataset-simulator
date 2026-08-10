/**
 * `sanity-overlay-studio` — the overlay status model (PRD §21.3, §32, §33).
 *
 * §21.3 does not merely ask for a badge: it specifies a *state machine* whose
 * output governs whether editing is allowed at all —
 *
 *   | State                        | Editing behavior                          |
 *   |------------------------------|-------------------------------------------|
 *   | Healthy                      | Normal                                    |
 *   | Saving                       | Optimistic edit continues                 |
 *   | Offline / storage unavailable| Read-only after the retry buffer limit    |
 *   | Soft conflict                | Editing allowed                           |
 *   | Hard conflict                | Draft editing allowed; branch publish blocked |
 *   | Schema mismatch              | Affected documents blocked from publish   |
 *   | Overlay identity mismatch    | Fatal screen. No reads or writes          |
 *   | Overlay disabled unexpectedly| Fatal screen. No fallback to staging writes |
 *
 * So the interesting question is never "what colour is the banner" — it is
 * *which state wins when several are true at once*, because getting that
 * ordering wrong means a fatal condition rendered as a warning and an editor
 * typing into a document that cannot be saved. The precedence is pinned first
 * and hardest below.
 *
 * Pure: no React, no DOM. The banner component renders this and nothing else.
 */
import {describe, expect, it} from 'vitest'
import {
  deriveOverlayStatus,
  OVERLAY_BANNER_STATES,
  type OverlayStatusInput,
} from '../../sanity-overlay-studio/src/status'

function input(overrides: Partial<OverlayStatusInput> = {}): OverlayStatusInput {
  return {
    enabled: true,
    mode: 'fs',
    apiUrl: 'http://localhost:3998',
    overlayId: 'branch-feature/new-hero',
    connection: 'ok',
    session: 'active',
    revision: 42,
    pendingWrites: 0,
    degradedWrites: 0,
    uncheckpointedEdits: 0,
    conflicts: {hard: 0, soft: 0},
    ...overrides,
  }
}

describe('the state set', () => {
  it('is exactly the §21.3 table', () => {
    expect([...OVERLAY_BANNER_STATES]).toEqual([
      'identity-mismatch',
      'disabled-unexpectedly',
      'unauthenticated',
      'offline',
      /* Added 2026-08-09. The overlay API answers `409` when this session's view
       * of the branch is behind another writer's and its own reconciliation did
       * not close the gap; nothing this session sends will be accepted until the
       * tab reloads. Placed below `offline` because an unreachable API cannot
       * report it, and above everything below because it is the only remaining
       * state in which writes are permanently refused rather than delayed. */
      'branch-moved',
      'schema-mismatch',
      'hard-conflict',
      'soft-conflict',
      'saving',
      'healthy',
    ])
  })

  it('is ordered most severe first, which is also the precedence order', () => {
    const states = [...OVERLAY_BANNER_STATES]
    expect(states[0]).toBe('identity-mismatch')
    expect(states[states.length - 1]).toBe('healthy')
  })
})

describe('precedence — the part that must not drift', () => {
  it('reports healthy when nothing is wrong', () => {
    expect(deriveOverlayStatus(input()).state).toBe('healthy')
  })

  it('lets identity mismatch beat every other simultaneous condition', () => {
    const status = deriveOverlayStatus(
      input({
        identityMismatch: true,
        connection: 'unreachable',
        session: 'unauthenticated',
        schemaMismatch: true,
        conflicts: {hard: 3, soft: 5},
        pendingWrites: 2,
      }),
    )
    expect(status.state).toBe('identity-mismatch')
    expect(status.editing).toBe('blocked')
    expect(status.fatal).toBe(true)
  })

  it('lets an unexpectedly disabled overlay beat everything below it', () => {
    const status = deriveOverlayStatus(
      input({enabled: false, expectedEnabled: true, conflicts: {hard: 1, soft: 0}}),
    )
    expect(status.state).toBe('disabled-unexpectedly')
    expect(status.fatal).toBe(true)
    expect(status.editing).toBe('blocked')
    expect(status.headline).toMatch(/never falls back|no fallback/i)
  })

  it('does not call a deliberately-off overlay a fault', () => {
    const status = deriveOverlayStatus(input({enabled: false, expectedEnabled: false, mode: 'off'}))
    expect(status.state).toBe('healthy')
    expect(status.fatal).toBe(false)
    expect(status.editing).toBe('normal')
    expect(status.headline).toMatch(/native/i)
  })

  it.each(['unauthenticated', 'logged-out'] as const)(
    'makes the Studio read-only when the session is %s',
    (session) => {
      const status = deriveOverlayStatus(input({session, conflicts: {hard: 2, soft: 0}}))
      expect(status.state).toBe('unauthenticated')
      expect(status.editing).toBe('read-only')
    },
  )

  it('reports offline above schema and conflict states', () => {
    const status = deriveOverlayStatus(
      input({connection: 'unreachable', schemaMismatch: true, conflicts: {hard: 1, soft: 1}}),
    )
    expect(status.state).toBe('offline')
  })

  it('keeps editing optimistic while offline until the retry buffer is exhausted', () => {
    expect(deriveOverlayStatus(input({connection: 'unreachable', degradedWrites: 1})).editing).toBe(
      'normal',
    )
    expect(
      deriveOverlayStatus(input({connection: 'unreachable', degradedWrites: 25})).editing,
    ).toBe('read-only')
  })

  it('reports schema mismatch above conflicts, and blocks publish', () => {
    const status = deriveOverlayStatus(input({schemaMismatch: true, conflicts: {hard: 0, soft: 4}}))
    expect(status.state).toBe('schema-mismatch')
    expect(status.publishBlocked).toBe(true)
    expect(status.editing).toBe('normal')
  })

  it('reports a hard conflict above a soft one, and blocks branch publish only', () => {
    const status = deriveOverlayStatus(input({conflicts: {hard: 1, soft: 9}}))
    expect(status.state).toBe('hard-conflict')
    expect(status.editing).toBe('normal')
    expect(status.publishBlocked).toBe(true)
  })

  it('allows editing and publishing with only soft conflicts', () => {
    const status = deriveOverlayStatus(input({conflicts: {hard: 0, soft: 2}}))
    expect(status.state).toBe('soft-conflict')
    expect(status.publishBlocked).toBe(false)
    expect(status.editing).toBe('normal')
  })

  it('reports saving while writes are in flight, below every fault state', () => {
    expect(deriveOverlayStatus(input({pendingWrites: 3})).state).toBe('saving')
    expect(deriveOverlayStatus(input({pendingWrites: 3, conflicts: {hard: 0, soft: 1}})).state).toBe(
      'soft-conflict',
    )
  })
})

describe('the banner content (§21.3)', () => {
  it('names the overlay, the mode, the base and the revision', () => {
    const status = deriveOverlayStatus(
      input({
        base: {dataset: 'parity', revision: 'abc123'},
        revision: 42,
        uncheckpointedEdits: 5,
        conflicts: {hard: 0, soft: 2},
      }),
    )
    const byLabel = Object.fromEntries(status.lines.map((line) => [line.label, line.value]))
    expect(byLabel.Overlay).toContain('feature/new-hero')
    expect(byLabel.Storage).toContain('filesystem')
    expect(byLabel.Base).toContain('parity')
    expect(byLabel.Base).toMatch(/read.only/i)
    expect(byLabel['Overlay revision']).toBe('42')
    expect(byLabel.Conflicts).toBe('2 soft, 0 hard')
    expect(byLabel.Checkpoint).toMatch(/5/)
  })

  it('reports the uncheckpointed edit count as the number the brief asks for', () => {
    expect(deriveOverlayStatus(input({uncheckpointedEdits: 0})).uncheckpointedEdits).toBe(0)
    expect(deriveOverlayStatus(input({uncheckpointedEdits: 7})).uncheckpointedEdits).toBe(7)
  })

  it('says "up to date" rather than "behind by 0 revisions"', () => {
    const status = deriveOverlayStatus(input({uncheckpointedEdits: 0}))
    const checkpoint = status.lines.find((line) => line.label === 'Checkpoint')
    expect(checkpoint?.value).toMatch(/up to date/i)
  })

  it('shows the overlay API URL when the overlay server is unreachable, so it can be fixed', () => {
    const status = deriveOverlayStatus(input({connection: 'unreachable'}))
    expect(status.headline).toContain('http://localhost:3998')
  })

  it('reports no overlay id honestly instead of inventing one', () => {
    const status = deriveOverlayStatus(input({overlayId: null}))
    const overlay = status.lines.find((line) => line.label === 'Overlay')
    expect(overlay?.value).toMatch(/local|unnamed|not set/i)
  })
})

describe('severity maps to something a UI can use without re-deriving it', () => {
  it.each([
    ['healthy', 'neutral'],
    ['saving', 'neutral'],
    ['soft-conflict', 'warning'],
    ['hard-conflict', 'critical'],
    ['offline', 'critical'],
    ['schema-mismatch', 'critical'],
    ['unauthenticated', 'critical'],
    ['identity-mismatch', 'critical'],
    ['disabled-unexpectedly', 'critical'],
  ])('%s is %s', (state, severity) => {
    const cases: Record<string, Partial<OverlayStatusInput>> = {
      healthy: {},
      saving: {pendingWrites: 1},
      'soft-conflict': {conflicts: {hard: 0, soft: 1}},
      'hard-conflict': {conflicts: {hard: 1, soft: 0}},
      offline: {connection: 'unreachable'},
      'schema-mismatch': {schemaMismatch: true},
      unauthenticated: {session: 'unauthenticated'},
      'identity-mismatch': {identityMismatch: true},
      'disabled-unexpectedly': {enabled: false, expectedEnabled: true},
    }
    const status = deriveOverlayStatus(input(cases[state]))
    expect(status.state).toBe(state)
    expect(status.severity).toBe(severity)
  })
})
