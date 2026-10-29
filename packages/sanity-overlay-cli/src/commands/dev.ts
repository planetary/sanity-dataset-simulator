/**
 * `dev` — run the overlay locally, in one command (roadmap "pleasant DX").
 *
 * This is the distributable answer to "how do I run this thing": start the
 * REAL overlay API server (`startOverlayApiServer`, the same code every
 * launcher and test uses) against `--root`, create the overlay when the
 * directory has none, and print the wiring a developer needs next — the env
 * lines for their Studio and their site, the port, and the CLI verbs for
 * looking inside the branch. Before this command, "run the overlay" meant
 * knowing which launcher script to start with which env vars; that knowledge
 * lived in a runbook, which is exactly where setup knowledge goes to be
 * discovered too late.
 *
 * TWO DELIBERATE REFUSALS:
 *
 *   - No identity is ever guessed. Creating an overlay stamps `base`
 *     (projectId/dataset) into the manifest permanently (PRD §13.1), and a
 *     wrong guess would poison every later identity check. A fresh directory
 *     needs `--project` and `--dataset`, stated plainly.
 *   - The CORS grant names ONE studio origin (default `http://localhost:3333`)
 *     — this API serves the entire branch, drafts included, and the server's
 *     own default-deny stance (see `OverlayApiOptions.origins`) is kept, not
 *     widened.
 */
import {existsSync} from 'node:fs'
import {basename, join} from 'node:path'
import process from 'node:process'
import {startOverlayApiServer} from 'sanity-overlay-next'
import type {OverlayActor} from 'sanity-overlay-core'
import {usageError} from '../errors'
import {EXIT} from '../exit'
import type {CommandContext} from '../types'

export interface DevOptions {
  /** Port for the overlay API. `0` binds an ephemeral port. Default 3998. */
  readonly port?: number
  /** The one origin granted CORS. Default `http://localhost:3333`. */
  readonly studioOrigin?: string
  /** Base identity, required only when creating a fresh overlay. */
  readonly project?: string
  readonly dataset?: string
  readonly apiVersion?: string
  /**
   * Create the overlay with a sentinel identity — no Sanity project yet.
   *
   * The common cold start: content and UI work begin before anyone provisions
   * a Sanity project (whose id is ASSIGNED, so it cannot be supplied ahead of
   * time). In `fs` mode the manifest's base identity is an inert label —
   * nothing contacts Sanity — so the only thing that matters is that the
   * label cannot be mistaken for a real project: `detached.local` contains a
   * dot, which no real project id can.
   */
  readonly detached?: boolean
  readonly overlayId?: string
  readonly branch?: string
  readonly repository?: string
  /**
   * Test seam: resolves to trigger shutdown. Defaults to SIGINT/SIGTERM —
   * the command IS the dev server and blocks until one arrives.
   */
  readonly until?: Promise<void>
  /** Test seam: called with the bound server before blocking. */
  readonly onReady?: (server: {url: string; port: number}) => void
}

const DEV_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'sanity-overlay-cli',
  displayName: 'sanity-overlay CLI',
}

const DEFAULT_STUDIO_ORIGIN = 'http://localhost:3333'
const DEFAULT_API_VERSION = '2025-02-19'

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}

export async function runDev(ctx: CommandContext, options: DevOptions = {}): Promise<number> {
  const studioOrigin = options.studioOrigin ?? DEFAULT_STUDIO_ORIGIN
  const manifestPath = join(ctx.root, '.sanity-overlay', 'manifest.json')
  const creating = !existsSync(manifestPath)

  if (options.detached === true && (options.project !== undefined || options.dataset !== undefined)) {
    throw usageError(
      '--detached means "no Sanity project yet", which contradicts --project/--dataset. ' +
        'Pass one or the other.',
    )
  }

  const detached = options.detached === true
  if (creating && !detached && (options.project === undefined || options.dataset === undefined)) {
    throw usageError(
      `dev found no .sanity-overlay/ in ${ctx.root} and will not invent an identity for one. ` +
        `Pass --project <sanityProjectId> and --dataset <name> to create it (the identity is ` +
        `stamped into the manifest, PRD §13.1), pass --detached to start with no Sanity ` +
        `project at all, or --root the directory that already has an overlay.`,
    )
  }

  const server = await startOverlayApiServer({
    root: ctx.root,
    port: options.port ?? 3998,
    host: '127.0.0.1',
    now: ctx.now,
    origins: [studioOrigin],
    actor: DEV_ACTOR,
    ...(options.overlayId === undefined ? {} : {overlayId: options.overlayId}),
    ...(creating
      ? {
          base: detached
            ? {projectId: 'detached.local', dataset: 'detached', apiVersion: DEFAULT_API_VERSION}
            : {
                projectId: options.project!,
                dataset: options.dataset!,
                apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
              },
          source: {
            repositoryId: options.repository ?? `local:${basename(ctx.root)}`,
            ...(options.branch === undefined ? {} : {branch: options.branch}),
          },
        }
      : {}),
  })

  try {
    const heads = await server.store.listChangedDocuments(server.overlayId, {
      includeUnchanged: true,
    })
    const manifest = await server.store.inspect()
    const unresolved = manifest.conflictSummary?.total ?? 0

    ctx.emitJson({
      url: server.url,
      port: server.port,
      root: ctx.root,
      overlayId: server.overlayId,
      revision: server.revision,
      documents: heads.length,
      unresolvedConflicts: unresolved,
      created: creating,
    })

    if (!ctx.json) {
      const line = (text = ''): void => ctx.out(text)
      line(`sanity-overlay dev`)
      line()
      line(
        `  overlay   ${server.overlayId}` +
          `  (revision ${server.revision} · ${heads.length} documents · ${unresolved} unresolved conflicts)` +
          (creating ? '  — created just now' : ''),
      )
      if (detached || manifest.base?.projectId === 'detached.local') {
        line(
          `  detached  no Sanity project is attached; everything works locally. When the real ` +
            `project exists:  sanity-overlay attach --project <id> --dataset <name> --confirm`,
        )
      }
      line(`  root      ${ctx.root}`)
      line(`  api       ${server.url}   (health: ${server.url}/health)`)
      line(`  studio    CORS granted to ${studioOrigin}`)
      line()
      line(`Wire your Studio (defineOverlayConfig reads these):`)
      line(`  SANITY_STUDIO_OVERLAY_MODE=fs`)
      line(`  SANITY_STUDIO_OVERLAY_API_URL=${server.url}`)
      line()
      line(`Wire your app or site (sanity-overlay-client):`)
      line(`  SANITY_OVERLAY_MODE=fs`)
      line(`  SANITY_OVERLAY_ROOT=${ctx.root}`)
      line()
      /* Bare commands, with the directory named once above them. `--root`
       * defaults to the cwd, and printing it on every line taught readers it
       * was mandatory — the same thing the READMEs used to imply. */
      line(`Look inside the branch any time (from ${ctx.root}):`)
      line(`  sanity-overlay status`)
      line(`  sanity-overlay diff`)
      line(`  sanity-overlay conflicts`)
      line()
      line(`Edits stay local in .sanity-overlay/ and never reach the shared dataset.`)
      line(`Press Ctrl-C to stop.`)
    }

    options.onReady?.({url: server.url, port: server.port})
    await (options.until ?? waitForSignal())
  } finally {
    await server.close()
  }

  if (!ctx.json) ctx.out('stopped.')
  return EXIT.OK
}
