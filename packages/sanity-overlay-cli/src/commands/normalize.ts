/**
 * `normalize` — the file parse-error surface, and the way out of one
 * (PRD §14.3, §14.4, §14.5 `normalize --repair-checksums`, §37 Phase 2 "File
 * parse error UI" and "Reset actions").
 *
 * ## Division of labour with `validate`
 *
 * `validate` is the gate: it measures and never writes, so it can be trusted to
 * fail. `normalize` is the repair tool: it runs the §14.4 direct-edit workflow
 * (steps 2-4, 7 and 10) and, when asked, applies the one repair §14.3 licenses —
 * recomputing a stale checksum over a file that still validates semantically.
 *
 * Without `--repair-checksums` it reports the pending repairs and leaves every
 * canonical file byte-identical. A repair tool that silently repaired what it was
 * measuring would make the gate unfalsifiable.
 *
 * ## Why the prose matters here
 *
 * §14.3 requires the store to refuse malformed JSON, keep serving the last valid
 * state, and drop a `.broken` diagnostic copy. All of that already worked and
 * none of it was visible. Telling a developer "intent.json is unparseable" and
 * stopping there is not a UI — so every invalid file is reported with the copy
 * that holds its bytes and the two concrete routes out: restore it from Git, or
 * discard that document's branch state with `reset --document`.
 */
import type {
  OverlayChecksumIssue,
  OverlayRevalidationFailure,
} from '../../../sanity-overlay-store-fs/src/index'
import {CLI_NAME} from '../cli'
import {EXIT} from '../exit'
import {openOverlay} from '../overlay'
import {field, plural} from '../render'
import type {CommandContext} from '../types'

export interface NormalizeOptions {
  /** Apply the §14.3 checksum recomputation. Off by default: report, do not write. */
  readonly repairChecksums?: boolean
  readonly document?: string
}

/** A stale checksum over a semantically valid file — the only repairable class. */
function isPendingRepair(issue: OverlayChecksumIssue): boolean {
  return issue.repairable
}

function renderFailure(ctx: CommandContext, failure: OverlayRevalidationFailure): void {
  ctx.out(`  INVALID  ${failure.ref}`)
  ctx.out(`    ${failure.code}: ${failure.message}`)
  if (failure.brokenCopyRef !== undefined) {
    ctx.out(`    bytes preserved at .sanity-overlay/${failure.brokenCopyRef}`)
  }
  ctx.out(
    '    the store is still serving the last valid state for this file and will not serve',
  )
  ctx.out('    the broken one (PRD §14.3, §14.4 step 10). To recover, either:')
  ctx.out(`      git checkout -- .sanity-overlay/${failure.ref}`)
  if (failure.logicalId !== undefined) {
    ctx.out(
      `      ${CLI_NAME} reset --document ${failure.logicalId} --confirm    # discard branch state`,
    )
  }
}

export async function runNormalize(
  ctx: CommandContext,
  options: NormalizeOptions,
): Promise<number> {
  const opened = await openOverlay(ctx.root, ctx.now)
  const repair = options.repairChecksums === true

  const revalidation = await opened.store.revalidate(opened.overlayId, {
    repairChecksums: repair,
    ...(options.document === undefined ? {} : {logicalIds: [options.document]}),
  })

  /* `revalidate` repairs; `verifyChecksums` measures. Run the measurement after
   * the repair so the residual set is what the operator still has to deal with. */
  const checksums = await opened.store.verifyChecksums(opened.overlayId)
  const scoped =
    options.document === undefined
      ? checksums.issues
      : checksums.issues.filter((issue) => issue.logicalId === undefined || matches(issue, options))

  const pendingRepairs = scoped.filter(isPendingRepair)
  const corrupt = scoped.filter((issue) => !isPendingRepair(issue))
  const missing = options.document === undefined ? checksums.missing : []

  const ok =
    revalidation.invalid.length === 0 &&
    pendingRepairs.length === 0 &&
    corrupt.length === 0 &&
    missing.length === 0

  const report = {
    ok,
    overlayId: opened.overlayId,
    repairApplied: repair,
    checked: revalidation.checked,
    changed: revalidation.changed,
    manifestChanged: revalidation.manifestChanged,
    repaired: revalidation.repairedChecksums,
    pendingRepairs,
    corrupt,
    missing,
    invalid: revalidation.invalid,
  }
  ctx.emitJson(report)

  if (!ctx.json) {
    ctx.out(field('overlay', opened.overlayId))
    ctx.out(field('mode', repair ? 'repair' : 'report only'))
    ctx.out(field('checked', plural(revalidation.checked, 'file')))
    ctx.out(field('repaired', plural(revalidation.repairedChecksums.length, 'file')))
    ctx.out(
      field(
        'findings',
        `${plural(revalidation.invalid.length, 'invalid file')}, ${plural(
          pendingRepairs.length,
          'pending repair',
        )}, ${plural(corrupt.length, 'corruption', 'corruptions')}`,
      ),
    )

    for (const ref of revalidation.repairedChecksums) ctx.out(`  repaired  ${ref}`)
    for (const failure of revalidation.invalid) {
      ctx.out('')
      renderFailure(ctx, failure)
    }
    for (const issue of pendingRepairs) {
      ctx.out(
        `  stale     ${issue.ref}  stored ${issue.expected} recomputes to ${issue.actual}`,
      )
    }
    for (const issue of corrupt) {
      ctx.out(
        `  CORRUPT   ${issue.ref}  ${issue.kind}  expected ${issue.expected} got ${issue.actual}`,
      )
    }
    for (const ref of missing) ctx.out(`  MISSING   ${ref.ref}  ${ref.reason}`)

    if (pendingRepairs.length > 0 && !repair) {
      ctx.out('')
      ctx.out(
        `rerun with --repair-checksums to recompute ${plural(pendingRepairs.length, 'checksum')}.`,
      )
      ctx.out(
        '  A stale checksum over a semantically valid file is repairable metadata, not a',
      )
      ctx.out('  rejection — a legitimate Git merge produces one (PRD §14.3).')
    }
    if (corrupt.length > 0) {
      ctx.out('')
      ctx.out(
        'a content address that no longer matches its own content is NOT repairable: rewriting',
      )
      ctx.out('  the checksum would destroy the evidence. Restore those files from Git.')
    }
  }

  return ok ? EXIT.OK : EXIT.FINDINGS
}

/** Scope a checksum issue to `--document`, comparing IDs element-wise. */
function matches(issue: OverlayChecksumIssue, options: NormalizeOptions): boolean {
  return issue.logicalId === options.document
}
