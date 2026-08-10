/**
 * `export` and `import` — the two transfer surfaces, and nothing of their own.
 *
 * ## What these front
 *
 * | Flag pair                  | Domain call                                   | Shape                                    |
 * |----------------------------|-----------------------------------------------|------------------------------------------|
 * | `--output` / `--input DIR` | `FsOverlayStore.exportCheckpoint` / `importCheckpoint` over core's `exportCheckpoint`/`importCheckpoint` | PRD §29.1 review tree: `manifest.json`, `documents/<id>/intent.json`, `snapshots/`, `checksums.json` |
 * | `--bundle FILE`            | `OverlayStore.exportCanonical` / `importCanonical` | PRD §35.7 lossless portable bundle       |
 *
 * The checkpoint tree is the default because it is the thing a human reviews and
 * Git stores (§29.1, §29.4). The bundle is lossless — it carries the runtime
 * records and the transaction log — and is what moves an overlay between
 * adapters (§35.7).
 *
 * ## Determinism
 *
 * `exportCheckpoint` is a pure function of overlay state, so the tree is
 * byte-stable by construction (§34.17). `exportCanonical` stamps `exportedAt`
 * from the store's clock, which would make two exports of identical state differ
 * — so the bundle export runs against a store whose clock is pinned to the
 * manifest's own `updatedAt`. The bundle is then a function of overlay state
 * alone, and its checksum is still the store's own.
 */
import {stat} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {writeFile} from 'node:fs/promises'
import type {OverlayManifest} from 'sanity-overlay-core'
import {confirmationRequired, usageError} from '../errors'
import {EXIT} from '../exit'
import {asCliError, createStore, openOverlay} from '../overlay'
import {plural, toJson} from '../render'
import type {CommandContext} from '../types'
import {readFile} from 'node:fs/promises'

export interface ExportOptions {
  /** Directory to write the §29.1 checkpoint tree into. */
  readonly output?: string
  /** File to write the §35.7 portable bundle into. */
  readonly bundle?: string
  readonly noTransactions?: boolean
  /**
   * Record the checkpoint in PRD §13.1 `manifest.checkpoint` as well as writing
   * the tree.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THIS IS OPT-IN, WHEN THE OVERLAY API's CHECKPOINT ENDPOINT IS NOT.
   *
   * `export --output` is also how a human INSPECTS a branch — write a tree to
   * `/tmp`, diff it, verify its checksums, throw it away. A read command that
   * silently advanced the overlay revision and rewrote the manifest would make
   * looking at a branch change it, and would break the §34.17 property this
   * command is otherwise pinned on: two consecutive exports of unchanged state
   * are byte-identical. Marking bumps the revision and stamps a timestamp, so
   * the second export could not match the first.
   *
   * The API endpoint has no such ambiguity — a `POST /commit kind: checkpoint`
   * from a Studio is a deliberate act with a button behind it — so it always
   * marks. This flag is how the same act is spelled from a terminal or a CI job.
   * ─────────────────────────────────────────────────────────────────────────
   */
  readonly markCheckpoint?: boolean
  /**
   * The commit that will carry this checkpoint, when the caller already knows it.
   *
   * Requires `--mark-checkpoint`; see {@link runExport} for why it is refused
   * rather than ignored on its own. Omitted, the marker records the checkpoint
   * without naming a commit, which is the honest answer for a tree that has not
   * been committed yet — see the note on `OverlayManifest['checkpoint']`.
   */
  readonly commitSha?: string
}

export interface ImportOptions {
  /** Directory holding a §29.1 checkpoint tree. */
  readonly input?: string
  /** File holding a §35.7 portable bundle. */
  readonly bundle?: string
  readonly overwrite?: boolean
  readonly confirm?: boolean
  /**
   * Refuse repairable divergence instead of normalizing it (`onDivergence:
   * 'reject'`). The default follows PRD §29.7 step 3 and repairs, because a
   * legitimate Git merge must survive an import; `--strict` is for the caller
   * who would rather stop than accept a file whose bytes changed.
   */
  readonly strict?: boolean
  readonly noVerifyChecksum?: boolean
}

const absolute = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

/**
 * Stamp PRD §13.1 `manifest.checkpoint`, returning what was written.
 *
 * The revision advances by one, matching the overlay API's checkpoint endpoint
 * exactly: the manifest is the revision authority, `writeManifestConditional`
 * requires the successor revision, and the marker names the revision it
 * produced — so `checkpoint.overlayRevision === manifest.revision` immediately
 * afterwards and §29.6 counts zero uncheckpointed revisions.
 */
async function markCheckpoint(
  opened: {store: ReturnType<typeof createStore>; overlayId: string},
  now: () => string,
  commitSha?: string,
): Promise<NonNullable<OverlayManifest['checkpoint']>> {
  const current = await opened.store.readManifest(opened.overlayId)
  const overlayRevision = current.revision + 1
  const checkpoint = {
    overlayRevision,
    ...(commitSha === undefined ? {} : {commitSha}),
    createdAt: now(),
  }
  try {
    await opened.store.writeManifestConditional(
      opened.overlayId,
      {...current, revision: overlayRevision, checkpoint},
      current.revision,
    )
  } catch (error) {
    throw asCliError(error)
  }
  return checkpoint
}

export async function runExport(ctx: CommandContext, options: ExportOptions): Promise<number> {
  if (options.output === undefined && options.bundle === undefined) {
    throw usageError(
      'export requires --output <dir> (checkpoint tree, PRD §29.4) or --bundle <file> (portable bundle, PRD §35.7)',
    )
  }

  /*
   * REFUSED, NOT IGNORED. A `--commit-sha` that silently did nothing is how a CI
   * job comes to believe it attributed a checkpoint it did not — and the belief
   * would be invisible, because the tree it wrote is identical either way.
   */
  if (options.commitSha !== undefined && options.markCheckpoint !== true) {
    throw usageError(
      'export --commit-sha names the commit that will carry a checkpoint, so it requires ' +
        '--mark-checkpoint. Without it, `export` writes a tree and records nothing in ' +
        'PRD §13.1 `manifest.checkpoint`, and the sha would be dropped in silence.',
    )
  }
  if (options.markCheckpoint === true && options.output === undefined) {
    throw usageError(
      'export --mark-checkpoint records a §29.1 checkpoint tree in the manifest, so it requires ' +
        '--output <dir>. The §35.7 portable bundle (--bundle) is a transfer format, not a ' +
        'checkpoint, and marking one would claim a review surface that was never written.',
    )
  }

  const opened = await openOverlay(ctx.root, ctx.now)

  if (options.output !== undefined) {
    const dir = absolute(ctx.root, options.output)

    /*
     * MARKED BEFORE THE RENDER, for the same reason the API endpoint marks
     * before its own: `exportCheckpoint` writes `manifest.json` and
     * `checksums.json` together, so stamping afterwards would leave the tree's
     * checksum file describing bytes the tree no longer holds — and the
     * COMMITTED manifest would still say "never checkpointed", which is the
     * whole defect this flag exists to close.
     */
    const marker = options.markCheckpoint === true
      ? await markCheckpoint(opened, ctx.now, options.commitSha)
      : null

    const result = await opened.store.exportCheckpoint(opened.overlayId, {dir})
    ctx.emitJson({
      overlayId: result.overlayId,
      dir: result.dir,
      files: result.files,
      checksum: result.checksums.checksum,
      ...(marker === null
        ? {marked: false}
        : {
            marked: true,
            checkpointRevision: marker.overlayRevision,
            attributedToCommit: marker.commitSha !== undefined,
            ...(marker.commitSha === undefined ? {} : {commitSha: marker.commitSha}),
          }),
    })
    if (!ctx.json) {
      ctx.out(`wrote ${plural(result.files.length, 'file')} to ${result.dir}`)
      ctx.out(`checkpoint checksum ${result.checksums.checksum}`)
      if (marker !== null) {
        ctx.out(
          marker.commitSha === undefined
            ? `recorded checkpoint at revision ${marker.overlayRevision} (not attributed to a commit yet — commit this tree)`
            : `recorded checkpoint at revision ${marker.overlayRevision}, attributed to commit ${marker.commitSha}`,
        )
      }
    }
    return EXIT.OK
  }

  /* Pinned clock — see the determinism note in the module header. */
  const pinned = createStore(ctx.root, () => opened.manifest.updatedAt)
  const bundle = await pinned.exportCanonical(opened.overlayId, {
    includeTransactions: options.noTransactions !== true,
  })
  const target = absolute(ctx.root, options.bundle!)
  await writeFile(target, toJson(bundle), 'utf8')

  ctx.emitJson({
    overlayId: bundle.overlayId,
    output: target,
    documents: bundle.documents.length,
    snapshots: Object.keys(bundle.snapshots).length,
    transactions: bundle.transactions.length,
    checksum: bundle.checksum,
  })
  if (!ctx.json) {
    ctx.out(
      `wrote ${plural(bundle.documents.length, 'document')} and ${plural(
        bundle.transactions.length,
        'transaction',
      )} to ${target}`,
    )
    ctx.out(`bundle checksum ${bundle.checksum}`)
  }
  return EXIT.OK
}

/** True when `root` already holds an overlay whose manifest can be read at all. */
async function overlayExists(ctx: CommandContext): Promise<boolean> {
  try {
    await createStore(ctx.root, ctx.now).inspect()
    return true
  } catch {
    return false
  }
}

export async function runImport(ctx: CommandContext, options: ImportOptions): Promise<number> {
  if (options.input === undefined && options.bundle === undefined) {
    throw usageError(
      'import requires --input <dir> (checkpoint tree, PRD §29.4) or --bundle <file> (portable bundle, PRD §35.7)',
    )
  }

  const existing = await overlayExists(ctx)
  if (existing && options.overwrite === true && options.confirm !== true) {
    throw confirmationRequired(
      `import --overwrite would replace the overlay already stored at ${ctx.root}. Rerun with --confirm.`,
      {root: ctx.root},
    )
  }

  const store = createStore(ctx.root, ctx.now)

  if (options.input !== undefined) {
    const dir = absolute(ctx.root, options.input)
    try {
      const stats = await stat(dir)
      if (!stats.isDirectory()) throw new Error('not a directory')
    } catch {
      throw usageError(`--input ${dir} is not a readable checkpoint directory`, {dir})
    }

    let result
    try {
      result = await store.importCheckpoint(dir, {
        ...(options.overwrite === true ? {overwrite: true} : {}),
        onDivergence: options.strict === true ? 'reject' : 'repair',
      })
    } catch (error) {
      throw asCliError(error)
    }

    ctx.emitJson({
      overlayId: result.overlayId,
      dir: result.dir,
      /* A checkpoint is the review surface, not a full backup (PRD §29.1). */
      lossless: false,
      importedDocuments: result.importedDocuments,
      importedSnapshots: result.importedSnapshots,
      repaired: result.repaired,
      issues: result.issues,
    })
    if (!ctx.json) {
      ctx.out(
        `imported ${plural(result.importedDocuments, 'document')} and ${plural(
          result.importedSnapshots,
          'snapshot',
        )} from ${result.dir}`,
      )
      for (const ref of result.repaired) ctx.out(`  repaired stale checksum  ${ref}`)
      if (result.repaired.length > 0) {
        ctx.out(
          `  (${plural(result.repaired.length, 'file')} had stale checksum metadata and was normalized per PRD §14.3; rerun with --strict to refuse instead)`,
        )
      }
      ctx.out(
        'note: a checkpoint carries no runtime records and no transaction log (PRD §29.1, §29.2),',
      )
      ctx.out(
        '      so the overlay is now in the documented fresh-clone state: the review surface is',
      )
      ctx.out(
        '      complete, idempotency keys did not survive. Use --bundle for a lossless transfer.',
      )
    }
    return EXIT.OK
  }

  const file = absolute(ctx.root, options.bundle!)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw usageError(`--bundle file ${file} could not be read`, {file})
  }
  let bundle: unknown
  try {
    bundle = JSON.parse(text)
  } catch (error) {
    throw usageError(`--bundle file ${file} is not valid JSON: ${(error as Error).message}`, {file})
  }

  let result
  try {
    result = await store.importCanonical(bundle as never, {
      ...(options.overwrite === true ? {overwrite: true} : {}),
      verifyChecksum: options.noVerifyChecksum !== true,
    })
  } catch (error) {
    throw asCliError(error)
  }

  ctx.emitJson({
    overlayId: result.manifest.overlayId,
    input: file,
    /* The §35.7 bundle carries records and the transaction log, so an import
     * reproduces the exporting store — including its idempotency ledger. */
    lossless: true,
    importedDocuments: result.importedDocuments,
    importedSnapshots: result.importedSnapshots,
    importedTransactions: result.importedTransactions,
  })
  if (!ctx.json) {
    ctx.out(
      `imported ${plural(result.importedDocuments, 'document')}, ${plural(
        result.importedSnapshots,
        'snapshot',
      )} and ${plural(result.importedTransactions, 'transaction')} from ${file}`,
    )
    ctx.out('note: the portable bundle is lossless — runtime records and the transaction log came with it.')
  }
  return EXIT.OK
}
