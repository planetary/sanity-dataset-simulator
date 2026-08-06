/**
 * `sanity-overlay-studio` — the three §21.7 actions that had no Studio surface:
 * **rebase**, **resolve conflict** and **checkpoint** (PRD §28.4, §28.5, §29).
 *
 * WHERE THE WORK HAPPENS, AND WHY IT IS NOT HERE.
 *
 * Core owns `autoRebase`, `applyRebaseMode` and `exportCheckpoint`; all three
 * need the §13.3 record — the base block, `touchedPaths`, `unsetPaths`, the
 * ancestor snapshot — which lives in the overlay store and is not in the
 * Studio's hydration answer. Reconstructing it in the browser would be a second,
 * weaker copy of the store. So the Studio's job is to *decide what to ask for*,
 * *show what will be lost*, and *refuse to ask until that is confirmed*. That is
 * what this file pins.
 *
 * The bar is the CLI's, because the CLI already solved the same problem: it
 * prints the loss report FIRST and exits `CONFIRMATION_REQUIRED` when `--confirm`
 * is absent (`commands/rebase.ts`, `commands/reset.ts`). A Studio button that
 * skipped that would be strictly more dangerous than the terminal.
 */
import {describe, expect, it, vi} from 'vitest'
import {REBASE_MODES} from '../../sanity-overlay-core/src/index'
import type {OverlayConflict} from '../../sanity-overlay-core/src/index'
import {
  OVERLAY_OPERATION_KINDS,
  planCheckpoint,
  planRebase,
  readRebaseOutcome,
} from '../../sanity-overlay-studio/src/operations'
import {readConflictReport} from '../../sanity-overlay-studio/src/conflicts'
import {createOverlayActionController} from '../../sanity-overlay-studio/src/documentActions'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'

/* ------------------------------------------------------------------ */

const DOCUMENTS = [
  {
    logicalId: 'article-1',
    schemaType: 'article',
    runtimeRevision: 'rev-1',
    draft: {_id: 'drafts.article-1', _type: 'article', title: 'Local'},
  },
  {
    logicalId: 'article-2',
    schemaType: 'article',
    runtimeRevision: 'rev-2',
    published: {_id: 'article-2', _type: 'article', title: 'Also local'},
  },
]

const HARD: OverlayConflict = {
  id: 'c-hard',
  documentId: 'article-2',
  severity: 'hard',
  type: 'BASE_DOCUMENT_DELETED',
  detectedAt: '2026-08-02T00:00:00.000Z',
}

const SOFT: OverlayConflict = {
  id: 'c-soft',
  documentId: 'article-1',
  severity: 'soft',
  type: 'SAME_PATH_CHANGED',
  path: ['title'],
  ancestorValue: 'A',
  baseValue: 'B',
  localValue: 'Local',
  detectedAt: '2026-08-01T00:00:00.000Z',
}

/** A transport that records what it was asked to send and answers `ok`. */
function fakeTransport(
  answer: Partial<{outcome: 'ok' | 'degraded' | 'fatal'; body: Record<string, unknown>}> = {},
): OverlayTransport & {sent: unknown[]} {
  const sent: unknown[] = []
  return {
    apiUrl: 'http://localhost:3998',
    sent,
    commit: vi.fn(async () => ({outcome: 'ok' as const})),
    resolve: vi.fn(async () => ({outcome: 'ok' as const})),
    query: vi.fn(async () => ({outcome: 'ok' as const})),
    state: vi.fn(async () => ({outcome: 'ok' as const})),
    operation: vi.fn(async (command: unknown) => {
      sent.push(command)
      return {outcome: answer.outcome ?? ('ok' as const), ...(answer.body ? {body: answer.body} : {})}
    }),
  } as unknown as OverlayTransport & {sent: unknown[]}
}

/* ══════════════════════════════════════════════ §28.4 / §28.5 rebase ═════ */

describe('planRebase — the §28.4 modes', () => {
  it('knows every mode core defines, plus §28.5’s automatic rebase', () => {
    for (const mode of REBASE_MODES) {
      const plan = planRebase({mode, documents: DOCUMENTS, confirmed: true})
      expect(plan.ok, mode).toBe(true)
    }
    expect(planRebase({mode: 'auto', documents: DOCUMENTS, confirmed: true}).ok).toBe(true)
  })

  it('refuses a mode core has never heard of', () => {
    const plan = planRebase({mode: 'obliterate' as never, documents: DOCUMENTS, confirmed: true})
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/mode/i)
  })

  it('sends the documents and the mode, and nothing it made up', () => {
    const plan = planRebase({mode: 'accept-base', documents: DOCUMENTS, confirmed: true})
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.command).toEqual({
      kind: 'rebase',
      mode: 'accept-base',
      documentIds: ['article-1', 'article-2'],
    })
  })

  it('scopes to one document when the pane asks for one', () => {
    const plan = planRebase({
      mode: 'accept-base',
      documents: DOCUMENTS,
      documentId: 'drafts.article-1',
      confirmed: true,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    /* The draft address resolves to the logical document the overlay keys on. */
    expect(plan.command.documentIds).toEqual(['article-1'])
  })

  it('refuses a document the overlay does not hold rather than rebasing everything', () => {
    const plan = planRebase({
      mode: 'accept-base',
      documents: DOCUMENTS,
      documentId: 'article-404',
      confirmed: true,
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/article-404/)
  })

  it('refuses when the overlay holds nothing to rebase', () => {
    expect(planRebase({mode: 'accept-base', documents: [], confirmed: true}).ok).toBe(false)
  })

  /* ---- destruction ---- */

  it('needs no confirmation for a preview, which changes nothing (§28.4)', () => {
    const plan = planRebase({mode: 'preview', documents: DOCUMENTS})
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.loss.destructive).toBe(false)
  })

  it.each(['auto', ...REBASE_MODES.filter((mode) => mode !== 'preview')] as const)(
    'refuses %s until the loss is confirmed',
    (mode) => {
      const plan = planRebase({mode, documents: DOCUMENTS})
      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.needsConfirmation).toBe(true)
      expect(plan.loss.destructive).toBe(true)
      /* The CLI's contract: the report exists whether or not it is confirmed. */
      expect(plan.loss.documents.map((entry) => entry.logicalId)).toEqual([
        'article-1',
        'article-2',
      ])
      expect(plan.loss.summary.length).toBeGreaterThan(30)
    },
  )

  it('says something different for a full reset than for an ancestor move', () => {
    const reset = planRebase({mode: 'full-reset', documents: DOCUMENTS})
    const acceptBase = planRebase({mode: 'accept-base', documents: DOCUMENTS})
    expect(reset.ok).toBe(false)
    expect(acceptBase.ok).toBe(false)
    if (reset.ok || acceptBase.ok) return
    expect(reset.loss.summary).not.toBe(acceptBase.loss.summary)
    /* A full reset takes the whole branch state, and must say so. */
    expect(reset.loss.summary).toMatch(/all|entire|every|whole/i)
  })

  it('names the last local revision of everything it will overwrite', () => {
    const plan = planRebase({mode: 'full-reset', documents: DOCUMENTS})
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.loss.documents).toEqual([
      {logicalId: 'article-1', schemaType: 'article', lastLocalRevision: 'rev-1', hasConflict: false},
      {logicalId: 'article-2', schemaType: 'article', lastLocalRevision: 'rev-2', hasConflict: false},
    ])
  })

  it('flags the documents that carry a conflict, because those lose the most', () => {
    const plan = planRebase({
      mode: 'full-reset',
      documents: [{...DOCUMENTS[0]!, conflicts: [SOFT]}, DOCUMENTS[1]!],
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.loss.documents[0]?.hasConflict).toBe(true)
    expect(plan.loss.documents[1]?.hasConflict).toBe(false)
  })
})

describe('readRebaseOutcome — §28.5 preconditions come back from the overlay', () => {
  it('reports a document the overlay could not rebase automatically', () => {
    const outcome = readRebaseOutcome({
      documents: [
        {logicalId: 'article-1', applied: true, blockedBy: []},
        {logicalId: 'article-2', applied: false, blockedBy: ['base-change-scope', 'array-keys']},
      ],
    })
    expect(outcome.applied).toEqual(['article-1'])
    expect(outcome.blocked).toEqual([
      {logicalId: 'article-2', blockedBy: ['base-change-scope', 'array-keys']},
    ])
    expect(outcome.ok).toBe(false)
  })

  it('is ok when every document rebased', () => {
    const outcome = readRebaseOutcome({documents: [{logicalId: 'a', applied: true, blockedBy: []}]})
    expect(outcome.ok).toBe(true)
    expect(outcome.blocked).toEqual([])
  })

  it('does not claim success from a body that says nothing', () => {
    /* An overlay API that answered 200 with no report has not told us a rebase
     * happened. Reading silence as success is how a blocked rebase becomes an
     * editor believing their branch is up to date. */
    for (const body of [undefined, {}, {documents: 'nope'}]) {
      const outcome = readRebaseOutcome(body as never)
      expect(outcome.ok).toBe(false)
      expect(outcome.reported).toBe(false)
    }
  })
})

/* ══════════════════════════════════════════════════ §29 checkpoint ═══════ */

describe('planCheckpoint — §29', () => {
  it('is not destructive and needs no confirmation', () => {
    const plan = planCheckpoint({conflicts: readConflictReport({documents: []})})
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.command.kind).toBe('checkpoint')
  })

  it('carries an operator note when one is given, and omits the key otherwise', () => {
    const withNote = planCheckpoint({
      conflicts: readConflictReport({documents: []}),
      note: 'before the redesign',
    })
    expect(withNote.ok).toBe(true)
    if (!withNote.ok) return
    expect(withNote.command.note).toBe('before the redesign')
    const without = planCheckpoint({conflicts: readConflictReport({documents: []})})
    expect(without.ok && 'note' in without.command).toBe(false)
  })

  /**
   * §28.1 — "Hard conflicts block … checkpoint confirmation when configured."
   */
  it('refuses when a hard conflict is open and clean conflicts are required', () => {
    const conflicts = readConflictReport({
      documents: [{logicalId: 'article-2', conflicts: [HARD]}],
    })
    const plan = planCheckpoint({conflicts, requireCleanConflicts: true})
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/hard conflict/i)
  })

  it('allows a soft conflict through, which §28.1 permits', () => {
    const conflicts = readConflictReport({
      documents: [{logicalId: 'article-1', conflicts: [SOFT]}],
    })
    expect(planCheckpoint({conflicts, requireCleanConflicts: true}).ok).toBe(true)
  })

  it('refuses on an UNKNOWN conflict state rather than assuming it is clean', () => {
    /* §28.1 again: an overlay that does not report conflicts has not said there
     * are none. "Require clean" cannot be satisfied by ignorance. */
    const silent = readConflictReport({documents: [{logicalId: 'a'}]})
    const plan = planCheckpoint({conflicts: silent, requireCleanConflicts: true})
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/not report|unknown/i)
    /* …and it is allowed when the caller did NOT ask for clean conflicts. */
    expect(planCheckpoint({conflicts: silent}).ok).toBe(true)
  })
})

describe('the operation vocabulary', () => {
  it('names exactly the operations the overlay API is asked to perform', () => {
    expect([...OVERLAY_OPERATION_KINDS].sort()).toEqual(
      ['checkpoint', 'conflictResolution', 'rebase'].sort(),
    )
  })
})

/* ════════════════════════════════ the §21.7 actions, as a controller ════ */

function controllerFor(
  kind: 'rebase' | 'checkpoint' | 'conflictResolution',
  overrides: Record<string, unknown> = {},
) {
  const transport = fakeTransport()
  const refresh = vi.fn(async () => {})
  const controller = createOverlayActionController({
    kind,
    transport,
    refresh,
    documents: DOCUMENTS,
    conflicts: readConflictReport({
      documents: [
        {logicalId: 'article-1', conflicts: [SOFT]},
        {logicalId: 'article-2', conflicts: [HARD]},
      ],
    }),
    ...overrides,
  } as never)
  return {controller, transport, refresh}
}

describe('createOverlayActionController — OverlayRebaseAction', () => {
  it('describes an enabled action for a document the overlay holds', () => {
    const {controller} = controllerFor('rebase')
    const description = controller.describe({id: 'article-1', type: 'article'})
    expect(description).not.toBeNull()
    expect(description!.label).toMatch(/rebase/i)
    expect(description!.disabled).toBe(false)
  })

  it('disables itself, with a reason, for a document the overlay does not hold', () => {
    const {controller} = controllerFor('rebase')
    const description = controller.describe({id: 'article-404', type: 'article'})
    expect(description!.disabled).not.toBe(false)
    expect(description!.title).toMatch(/overlay|branch|no local/i)
  })

  /** The load-bearing one. */
  it('sends NOTHING until the confirm dialog is confirmed', async () => {
    const {controller, transport} = controllerFor('rebase')
    const first = controller.describe({id: 'article-1', type: 'article'})!
    expect(first.dialog).toBeFalsy()

    first.onHandle!()

    const opened = controller.describe({id: 'article-1', type: 'article'})!
    expect(opened.dialog).toBeTruthy()
    expect(opened.dialog!.type).toBe('confirm')
    expect(opened.dialog!.tone).toBe('critical')
    /* The loss report, in the dialog, before anything is sent. */
    expect(opened.dialog!.message).toMatch(/article-1/)
    expect(opened.dialog!.message).toMatch(/rev-1/)
    /* Nothing has left the browser. */
    expect(transport.sent).toEqual([])

    await opened.dialog!.onConfirm()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]).toMatchObject({
      kind: 'rebase',
      payload: {kind: 'rebase', documentIds: ['article-1']},
    })
    /* An idempotency key travels with it, so a retried click cannot rebase twice. */
    expect((transport.sent[0] as {idempotencyKey: string}).idempotencyKey).toMatch(/rebase/)
  })

  it('sends nothing when the dialog is cancelled, and closes it', async () => {
    const {controller, transport} = controllerFor('rebase')
    controller.describe({id: 'article-1', type: 'article'})!.onHandle!()
    const opened = controller.describe({id: 'article-1', type: 'article'})!
    opened.dialog!.onCancel()
    expect(controller.describe({id: 'article-1', type: 'article'})!.dialog).toBeFalsy()
    expect(transport.sent).toEqual([])
  })

  it('refreshes the overlay state after a successful operation', async () => {
    const {controller, refresh} = controllerFor('rebase')
    controller.describe({id: 'article-1', type: 'article'})!.onHandle!()
    await controller.describe({id: 'article-1', type: 'article'})!.dialog!.onConfirm()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reports a §28.5 blockage instead of claiming the rebase happened', async () => {
    const transport = fakeTransport({
      body: {documents: [{logicalId: 'article-1', applied: false, blockedBy: ['array-keys']}]},
    })
    const controller = createOverlayActionController({
      kind: 'rebase',
      transport,
      refresh: async () => {},
      documents: DOCUMENTS,
      conflicts: readConflictReport({documents: []}),
    } as never)
    controller.describe({id: 'article-1', type: 'article'})!.onHandle!()
    await controller.describe({id: 'article-1', type: 'article'})!.dialog!.onConfirm()
    expect(controller.state().error).toMatch(/array-keys|blocked|could not/i)
  })

  it('surfaces a transport failure rather than reporting a silent success', async () => {
    const transport = fakeTransport({outcome: 'degraded'})
    const controller = createOverlayActionController({
      kind: 'rebase',
      transport,
      refresh: async () => {},
      documents: DOCUMENTS,
      conflicts: readConflictReport({documents: []}),
    } as never)
    controller.describe({id: 'article-1', type: 'article'})!.onHandle!()
    await controller.describe({id: 'article-1', type: 'article'})!.dialog!.onConfirm()
    expect(controller.state().error).toBeTruthy()
  })
})

describe('createOverlayActionController — OverlayCheckpointAction', () => {
  it('is not a critical dialog, because a checkpoint destroys nothing', () => {
    const {controller} = controllerFor('checkpoint')
    const description = controller.describe({id: 'article-1', type: 'article'})!
    expect(description.label).toMatch(/checkpoint/i)
    description.onHandle!()
    const opened = controller.describe({id: 'article-1', type: 'article'})!
    expect(opened.dialog!.tone).not.toBe('critical')
  })

  it('is available even for a document the overlay does not hold — it is overlay-wide', () => {
    const {controller} = controllerFor('checkpoint')
    expect(controller.describe({id: 'article-404', type: 'article'})!.disabled).toBe(false)
  })
})

describe('createOverlayActionController — OverlayConflictResolutionAction', () => {
  it('is hidden entirely for a document with no conflict', () => {
    const {controller} = controllerFor('conflictResolution')
    expect(controller.describe({id: 'article-99', type: 'article'})).toBeNull()
  })

  it('shows the conflict count and its severity for a conflicted document', () => {
    const {controller} = controllerFor('conflictResolution')
    const soft = controller.describe({id: 'article-1', type: 'article'})!
    expect(soft.label).toMatch(/conflict/i)
    expect(soft.tone).toBe('caution')
    const hard = controller.describe({id: 'article-2', type: 'article'})!
    expect(hard.tone).toBe('critical')
  })

  it('offers exactly the §28.3 actions core says apply, per conflict', () => {
    const {controller} = controllerFor('conflictResolution')
    const panel = controller.conflictPanel!('article-1')
    expect(panel).toHaveLength(1)
    expect(panel[0]!.actions.map((action) => action.action)).toEqual([
      'keep-branch-value',
      'accept-current-staging',
      'manual-edit',
      'remove-local-override',
    ])
  })

  it('drives a non-destructive resolution straight through', async () => {
    const {controller, transport, refresh} = controllerFor('conflictResolution')
    const result = await controller.resolve!({
      conflictId: 'c-soft',
      documentId: 'article-1',
      action: 'keep-branch-value',
    })
    expect(result.ok).toBe(true)
    expect(transport.sent[0]).toMatchObject({
      kind: 'conflictResolution',
      payload: {
        kind: 'conflictResolution',
        conflictId: 'c-soft',
        action: 'keep-branch-value',
        resolution: 'keep-local',
      },
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('refuses a destructive resolution that was not confirmed, and sends nothing', async () => {
    const {controller, transport} = controllerFor('conflictResolution')
    const result = await controller.resolve!({
      conflictId: 'c-soft',
      documentId: 'article-1',
      action: 'accept-current-staging',
    })
    expect(result.ok).toBe(false)
    expect(transport.sent).toEqual([])
    if (result.ok) return
    expect(result.loss?.summary).toMatch(/discard|lose|not recoverable/i)
  })

  it('sends the destructive resolution once it IS confirmed', async () => {
    const {controller, transport} = controllerFor('conflictResolution')
    const result = await controller.resolve!({
      conflictId: 'c-soft',
      documentId: 'article-1',
      action: 'accept-current-staging',
      confirmed: true,
    })
    expect(result.ok).toBe(true)
    expect(transport.sent).toHaveLength(1)
  })

  it('refuses a conflict ID the overlay never reported', async () => {
    const {controller, transport} = controllerFor('conflictResolution')
    const result = await controller.resolve!({
      conflictId: 'c-nope',
      documentId: 'article-1',
      action: 'keep-branch-value',
    })
    expect(result.ok).toBe(false)
    expect(transport.sent).toEqual([])
  })
})
