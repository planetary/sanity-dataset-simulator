/**
 * Build the site's client from the environment (PRD §9.2, §11.1).
 *
 * One factory, and the environment decides what it does:
 *
 *   SANITY_OVERLAY_MODE=off   read the base dataset only (the "staging" view)
 *   SANITY_OVERLAY_MODE=fs    read `.sanity-overlay/` layered over base
 *   SANITY_OVERLAY_ROOT=…     the directory that CONTAINS `.sanity-overlay/`
 *   SANITY_OVERLAY_PERSPECTIVE=published|drafts   default: drafts
 *
 * The base dataset is the committed NDJSON snapshot unless a real project is
 * configured:
 *
 *   SANITY_PROJECT_ID / SANITY_DATASET / SANITY_API_VERSION / SANITY_READ_TOKEN
 *
 * in which case reads go to the hosted query API over GET. Nothing in this path
 * can write to it.
 */
import {
  createDocumentBaseSource,
  createFsOverlayStateLoader,
  createHttpBaseSource,
  createOverlayClient,
  overlayClientConfigFromEnv,
} from '../../../packages/sanity-overlay-client/src/index'
import type {
  OverlayClient,
  OverlayClientBaseSource,
} from '../../../packages/sanity-overlay-client/src/index'
import {SITE_BASE_DATASET_PATH, loadNdjsonDataset} from './dataset'
import {SITE_QUERIES} from './queries'

export type SiteEnv = Record<string, string | undefined>

export interface SiteClientDescription {
  readonly client: OverlayClient
  /** Human-readable summary, for the startup banner. */
  readonly summary: string
}

export function createSiteBaseSource(env: SiteEnv): {
  source: OverlayClientBaseSource
  summary: string
} {
  const projectId = env.SANITY_PROJECT_ID
  const dataset = env.SANITY_DATASET
  if (projectId && dataset) {
    return {
      source: createHttpBaseSource({
        projectId,
        dataset,
        apiVersion: env.SANITY_API_VERSION ?? '2025-02-19',
        ...(env.SANITY_READ_TOKEN === undefined ? {} : {token: env.SANITY_READ_TOKEN}),
      }),
      summary: `hosted ${projectId}/${dataset} (read-only, GET)`,
    }
  }

  const path = env.SITE_BASE_DATASET ?? SITE_BASE_DATASET_PATH
  return {source: createDocumentBaseSource(loadNdjsonDataset(path)), summary: `file ${path}`}
}

export function createSiteClient(env: SiteEnv): SiteClientDescription {
  const config = overlayClientConfigFromEnv(env)
  const base = createSiteBaseSource(env)

  if (config.mode === 'off') {
    return {
      client: createOverlayClient({
        mode: 'off',
        base: base.source,
        queries: SITE_QUERIES,
        perspective: config.perspective,
        caller: 'frontend',
      }),
      summary: `mode=off  base=${base.summary}`,
    }
  }

  /* The loader normalises the root, so the banner reports the path that will
   * actually be opened rather than the string that was typed. */
  const overlay = createFsOverlayStateLoader({root: config.overlayRoot as string})
  return {
    client: createOverlayClient({
      mode: 'fs',
      base: base.source,
      overlay,
      queries: SITE_QUERIES,
      perspective: config.perspective,
      caller: 'frontend',
    }),
    summary: `mode=fs  overlay=${overlay.root}/.sanity-overlay  base=${base.summary}  perspective=${config.perspective}`,
  }
}
