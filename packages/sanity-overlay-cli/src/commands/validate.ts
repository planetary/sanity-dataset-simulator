/**
 * `validate` — the PRD §34 invariant gate.
 *
 * Three independent sources of truth, none of them the CLI's own opinion:
 *
 * 1. `checkOverlayInvariants` — the twelve executable §34 invariants in core.
 * 2. `store.verifyChecksums` — the adapter recomputing every stored checksum,
 *    classified `repairable` per PRD §14.3.
 * 3. Per-document read failures collected by `loadRecords`, which is how an
 *    unparseable `intent.json` surfaces as a finding instead of a crash.
 *
 * `validate` never writes. Repairing a stale checksum is `normalize`'s job
 * (PRD §14.5), and a gate that silently fixed what it was measuring would
 * report clean forever.
 *
 * ## The §34.3 exemption
 *
 * §34.3 cross-checks a head's synthetic `_rev` prefix against the head
 * checksum. `documentHeadFromRecord` sets `head.checksum` to the checksum of the
 * §13.3 RECORD, while §13.9 builds the synthetic `_rev` from the checksum of the
 * materialized DOCUMENT. Those are two different hashes, so the sub-check cannot
 * hold for any manifest a real store wrote — every intact overlay reports it.
 * Treating it as a failure would make this command useless, and silently
 * dropping it would hide a real head/record mismatch, so it is reported
 * separately as a known issue and `--strict` still fails on it.
 */
import {stat} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {
  OVERLAY_INVARIANT_IDS,
  checkOverlayInvariants,
  createOverlayState,
  verifyCheckpoint,
} from 'sanity-overlay-core'
import type {OverlayInvariantViolation} from 'sanity-overlay-core'
import {readCheckpointDir} from 'sanity-overlay-store-fs'
import {usageError} from '../errors'
import {EXIT} from '../exit'
import {loadRecords, openOverlay} from '../overlay'
import {plural} from '../render'
import type {CommandContext} from '../types'

export interface ValidateOptions {
  /** Fail on known upstream issues too. */
  readonly strict?: boolean
  /** Verify a §29.1 checkpoint tree instead of the live overlay at `--root`. */
  readonly checkpoint?: string
}

/**
 * Verify a checkpoint tree under the STRICT reading of PRD §14.3.
 *
 * §14.3 says a stale stored checksum over a semantically valid file is
 * repairable metadata and must not be rejected — that is what makes a legitimate
 * Git merge survive. But it is byte-for-byte indistinguishable from a hand-edit,
 * so `import` (whose job is to load) repairs, and `validate` (whose entire job is
 * to verify) refuses. A verification command that silently repaired what it was
 * measuring would report clean forever, which is precisely the failure mode a
 * checkpoint gate exists to prevent.
 */
async function validateCheckpoint(ctx: CommandContext, dir: string): Promise<number> {
  const target = isAbsolute(dir) ? dir : resolve(ctx.root, dir)
  try {
    const stats = await stat(target)
    if (!stats.isDirectory()) throw new Error('not a directory')
  } catch {
    throw usageError(`--checkpoint ${target} is not a readable checkpoint directory`, {dir: target})
  }

  let files
  try {
    files = await readCheckpointDir(target)
  } catch (error) {
    throw usageError(
      `--checkpoint ${target} could not be read: ${(error as Error).message}`,
      {dir: target},
    )
  }

  const verification = verifyCheckpoint(files)
  const ok = verification.issues.length === 0

  ctx.emitJson({
    ok,
    checkpoint: {
      dir: target,
      ok,
      checked: verification.checked,
      issues: verification.issues,
      repairable: verification.repairable,
      corrupt: verification.corrupt,
    },
  })

  if (!ctx.json) {
    ctx.out(
      `checkpoint ${target}: ${plural(verification.checked, 'file')} checked, ${plural(
        verification.corrupt.length,
        'corrupt file',
      )}, ${plural(verification.repairable.length, 'repairable divergence', 'repairable divergences')}`,
    )
    for (const issue of verification.corrupt) {
      ctx.out(`  corrupt     ${issue.ref}  ${issue.kind}  ${issue.message}`)
    }
    for (const issue of verification.repairable) {
      ctx.out(`  repairable  ${issue.ref}  ${issue.kind}  ${issue.message}`)
    }
    if (verification.repairable.length > 0) {
      ctx.out('')
      ctx.out(
        'repairable divergence is rejected here and would be repaired by `import` (PRD §14.3).',
      )
      ctx.out(
        'note: a checkpoint carries no §13.3 records, so manifest document heads cannot be',
      )
      ctx.out(
        '      cross-checked against content — a structurally valid manifest.json edit can',
      )
      ctx.out('      only ever be classified repairable (PRD §29.1, §29.2).')
    }
  }

  return ok ? EXIT.OK : EXIT.FINDINGS
}

/**
 * The one §34.3 sub-check that no store-written manifest can satisfy. Matched on
 * the message rather than on a code because core reports §34.3 as a single ID;
 * the predicate is deliberately narrow so any OTHER §34.3 breach still fails.
 */
const KNOWN_RUNTIME_REVISION_ISSUE = /names runtime revision .* whose checksum prefix does not match/

function isKnownIssue(violation: OverlayInvariantViolation): boolean {
  return violation.invariant === '34.3' && KNOWN_RUNTIME_REVISION_ISSUE.test(violation.message)
}

export async function runValidate(
  ctx: CommandContext,
  options: ValidateOptions,
): Promise<number> {
  if (options.checkpoint !== undefined) return validateCheckpoint(ctx, options.checkpoint)

  const opened = await openOverlay(ctx.root, ctx.now)
  const loaded = await loadRecords(opened)

  const state = createOverlayState({
    overlayId: opened.overlayId,
    revision: opened.manifest.revision,
    documents: {...loaded.records},
  })

  const all = checkOverlayInvariants({
    state,
    manifest: opened.manifest,
    knownRefs: loaded.heads
      .filter((head) => loaded.records[head.logicalId] !== undefined)
      .map((head) => head.storageRef),
  })

  const knownIssues = all.filter(isKnownIssue)
  const violations = all.filter((violation) => !isKnownIssue(violation))
  const checksums = await opened.store.verifyChecksums(opened.overlayId)

  /* The adapter verifies the checksums of what it can reach; a base snapshot an
   * intent NAMES but that is no longer stored is unreachable, so it is detected
   * here and folded into the same `missing` list (PRD §34.3). */
  const missing = [...checksums.missing, ...loaded.missingSnapshots]

  const failed =
    violations.length > 0 ||
    checksums.issues.length > 0 ||
    missing.length > 0 ||
    loaded.unreadable.length > 0 ||
    (options.strict === true && knownIssues.length > 0)

  const report = {
    ok: !failed,
    overlayId: opened.overlayId,
    invariantsChecked: [...OVERLAY_INVARIANT_IDS],
    violations,
    knownIssues,
    unreadable: loaded.unreadable,
    recordsUnavailable: loaded.recordsUnavailable,
    checksums: {
      ok: checksums.ok && missing.length === 0,
      checked: checksums.checked,
      issues: checksums.issues,
      missing,
    },
  }
  ctx.emitJson(report)

  if (!ctx.json) {
    ctx.out(
      `${plural(violations.length, 'violation')}, ${plural(
        loaded.unreadable.length,
        'unreadable document',
      )}, ${plural(checksums.issues.length + missing.length, 'checksum issue')}`,
    )
    for (const violation of violations) {
      ctx.out(
        `  §${violation.invariant}  ${violation.documentId ?? '-'}  ${violation.message}`,
      )
    }
    for (const entry of loaded.unreadable) {
      ctx.out(`  unreadable  ${entry.logicalId}  ${entry.code}  ${entry.message}`)
    }
    for (const issue of checksums.issues) {
      ctx.out(
        `  checksum  ${issue.logicalId ?? '-'}  ${issue.ref}  expected ${issue.expected} got ${issue.actual}${issue.repairable ? '  (repairable)' : ''}`,
      )
    }
    for (const ref of missing) {
      ctx.out(`  missing  ${ref.logicalId ?? '-'}  ${ref.ref}  ${ref.reason}`)
    }
    for (const logicalId of loaded.recordsUnavailable) {
      ctx.out(`  note  ${logicalId}  review surface intact, immutable record not stored`)
    }
    if (knownIssues.length > 0) {
      ctx.out('')
      ctx.out(
        `known upstream issues (not failing without --strict): ${knownIssues.length}`,
      )
      for (const issue of knownIssues) {
        ctx.out(`  §${issue.invariant}  ${issue.documentId ?? '-'}  ${issue.message}`)
      }
    }
  }

  return failed ? EXIT.FINDINGS : EXIT.OK
}
