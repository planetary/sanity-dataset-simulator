/**
 * `attach` — bind a detached overlay to the real Sanity project (§13.1 base).
 *
 * The counterpart to `dev --detached`: teams start content before anyone
 * provisions a Sanity project (ids are assigned, not chosen), and until this
 * verb existed the eventual rebind was a documented MANUAL EDIT of
 * `manifest.json` — the one workflow that bypassed the store's conditional
 * writes, revision increments and actor stamps. The rebind now goes through
 * `writeManifestConditional` like every other manifest change.
 *
 * `--force` is required to rebind an overlay that is ALREADY attached: every
 * intent's captured base revisions were read from the old project, so pointing
 * the manifest somewhere else is a statement that the operator knows better —
 * which happens (a dataset copy, a project migration), but must be said.
 */
import type {OverlayActor} from 'sanity-overlay-core'
import {confirmationRequired, usageError} from '../errors'
import {EXIT} from '../exit'
import {openOverlay} from '../overlay'
import type {CommandContext} from '../types'

export interface AttachOptions {
  readonly project?: string
  readonly dataset?: string
  readonly apiVersion?: string
  readonly confirm?: boolean
  readonly dryRun?: boolean
  readonly force?: boolean
}

const ATTACH_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'sanity-overlay-cli',
  displayName: 'sanity-overlay CLI',
}

/** The sentinel `dev --detached` writes; the dot cannot appear in a real id. */
const DETACHED_PROJECT_ID = 'detached.local'

export async function runAttach(ctx: CommandContext, options: AttachOptions): Promise<number> {
  if (options.project === undefined || options.dataset === undefined) {
    throw usageError('attach needs both --project <sanityProjectId> and --dataset <name>')
  }
  if (options.project.includes('.')) {
    throw usageError(
      `--project ${JSON.stringify(options.project)} contains a dot, which no real Sanity ` +
        `project id can — attaching it would leave the overlay looking detached.`,
    )
  }

  const opened = await openOverlay(ctx.root, ctx.now)
  const manifest = opened.manifest
  const detached = manifest.base.projectId === DETACHED_PROJECT_ID

  if (!detached && options.force !== true) {
    throw usageError(
      `this overlay is already attached to ${manifest.base.projectId}/${manifest.base.dataset}. ` +
        `Every captured base revision was read from that project, so rebinding is a claim the ` +
        `operator must own — rerun with --force if you mean it (a dataset copy or project ` +
        `migration is the legitimate case).`,
    )
  }

  const next = {
    from: `${manifest.base.projectId}/${manifest.base.dataset}`,
    to: `${options.project}/${options.dataset}`,
    apiVersion: options.apiVersion ?? manifest.base.apiVersion,
  }

  const willWrite = options.confirm === true && options.dryRun !== true
  if (!willWrite) {
    ctx.emitJson({...next, applied: false})
    if (!ctx.json) {
      ctx.out(`would attach ${next.from}  ->  ${next.to}  (apiVersion ${next.apiVersion})`)
    }
    if (options.dryRun === true) return EXIT.OK
    throw confirmationRequired(
      `attaching rebinds this overlay's base identity from ${next.from} to ${next.to}. ` +
        `Rerun with --confirm to proceed, or --dry-run to see this report without the refusal.`,
      {from: next.from, to: next.to},
    )
  }

  await opened.store.writeManifestConditional(
    opened.overlayId,
    {
      ...manifest,
      base: {
        ...manifest.base,
        projectId: options.project,
        dataset: options.dataset,
        apiVersion: next.apiVersion,
      },
      revision: manifest.revision + 1,
    },
    manifest.revision,
    {actor: ATTACH_ACTOR},
  )

  ctx.emitJson({...next, applied: true})
  if (!ctx.json) {
    ctx.out(`attached ${next.from}  ->  ${next.to}; the rebind is recorded on the branch`)
  }
  return EXIT.OK
}
