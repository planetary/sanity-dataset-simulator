/**
 * Build the site's client from a settled configuration map (PRD §9.2, §11.1).
 *
 * One factory, and the map decides what it does:
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
 *
 * THE PARAMETER IS NOT `process.env`, AND ITS NAME SAYS SO. `run.mjs` used to
 * hand this function `{...process.env, …}`, which meant an exported
 * `SANITY_PROJECT_ID` from any other project silently moved the site's reads
 * onto that project's content. The caller now resolves the four identity keys
 * from a declared source (`../explicitEnv.mjs`) and passes only what it settled;
 * this file stays a pure function of what it is given.
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
  /** Non-fatal notices the launcher should print. Never contains a credential. */
  readonly warnings: readonly string[]
}

export interface SiteBaseSourceDescription {
  readonly source: OverlayClientBaseSource
  readonly summary: string
  readonly warnings: readonly string[]
}

export interface SiteBaseSourceOptions {
  /**
   * Injected for tests, exactly as `createHttpBaseSource` documents its own.
   * It is how `examples-explicit-env.test.ts` asserts the resolved token where
   * it actually lands — on the `Authorization` header of the outbound request —
   * rather than on a value the resolver had just computed.
   */
  readonly fetchImpl?: typeof fetch
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SPELLINGS, AND WHY THE DECLARED ONE WINS.
 *
 * This example used to read `SANITY_DATASET` and `SANITY_READ_TOKEN`. The
 * repository declares `SANITY_BASE_DATASET` and `SANITY_API_READ_TOKEN` — in the
 * root `.env`, in PRD §11.2, in the testkit's `MANAGED_KEYS`, in
 * `sanity-overlay-testkit/src/hosted.ts` and in `e2e/playwright/upstream.ts`.
 * Five say one thing and one said another, so the one is the defect.
 *
 * It was not a cosmetic defect. The obvious move — copy the repo's own `.env`
 * into `examples/local-site/.env` — produced a HALF configuration: the project
 * id matched, the dataset did not, and this function fell silently back to the
 * committed NDJSON fixture while every visible signal said "pointed at the real
 * dataset". Silent fallback to the wrong data source is exactly what the rest of
 * this change exists to abolish.
 *
 * The token spelling matters for a second reason: `assertNoWriteToken` in
 * `sanity-overlay-studio/src/options.ts` hard-crashes on any Sanity-scoped
 * credential whose NAME does not say read-only, which is why the declared
 * spelling is the explicit one.
 *
 * The legacy spellings keep working — an example that broke on upgrade would be
 * its own defect — but they now say they are legacy, and two spellings that
 * disagree are refused rather than silently ranked. Same ruling as
 * `examples/explicitEnv.mjs`, for the same reason: a precedence rule here would
 * decide, invisibly, which of two datasets a developer's `.env` meant.
 */
const SPELLINGS = {
  projectId: {declared: 'SANITY_PROJECT_ID', legacy: [] as string[]},
  dataset: {declared: 'SANITY_BASE_DATASET', legacy: ['SANITY_DATASET']},
  apiVersion: {declared: 'SANITY_API_VERSION', legacy: [] as string[]},
  token: {declared: 'SANITY_API_READ_TOKEN', legacy: ['SANITY_READ_TOKEN']},
} as const

/** Every key this example will read for the hosted base, both spellings. */
export const SITE_BASE_KEYS: readonly string[] = Object.values(SPELLINGS).flatMap((spelling) => [
  spelling.declared,
  ...spelling.legacy,
])

/** Anything whose NAME claims it is a credential. Values are never printed. */
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|_KEY)$/

function show(key: string, value: string): string {
  return SECRET_KEY.test(key) ? `<redacted, ${value.length} chars>` : JSON.stringify(value)
}

/** Blank is absent — an exported-but-empty variable configures nothing. */
function present(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * One setting, however it was spelled.
 *
 * @throws when the declared spelling and a legacy one name different things.
 */
function resolveSpelling(
  settled: SiteEnv,
  spelling: {declared: string; legacy: readonly string[]},
  warnings: string[],
): string | undefined {
  const declared = present(settled[spelling.declared])

  for (const key of spelling.legacy) {
    const legacy = present(settled[key])
    if (legacy === undefined) continue

    if (declared === undefined) {
      warnings.push(
        `[local-site] ${key} is the legacy spelling of ${spelling.declared}, which is what this ` +
          `repository's .env, PRD §11.2 and the testkit all declare. It still works — rename it ` +
          `when convenient.`,
      )
      return legacy
    }
    /* Equal values are not a disagreement, and pass in silence. */
    if (legacy !== declared) {
      throw new Error(
        `[local-site] REFUSING to guess: ${spelling.declared} and ${key} are two spellings of ` +
          `one setting and they disagree.\n` +
          `  ${spelling.declared} = ${show(spelling.declared, declared)}\n` +
          `  ${key} = ${show(key, legacy)}\n` +
          `Ranking them silently would decide which of two you meant. Delete ${key} — ` +
          `${spelling.declared} is the declared spelling — or make the two agree.`,
      )
    }
  }

  return declared
}

export function createSiteBaseSource(
  settled: SiteEnv,
  options: SiteBaseSourceOptions = {},
): SiteBaseSourceDescription {
  const warnings: string[] = []
  const projectId = resolveSpelling(settled, SPELLINGS.projectId, warnings)
  const dataset = resolveSpelling(settled, SPELLINGS.dataset, warnings)
  const apiVersion = resolveSpelling(settled, SPELLINGS.apiVersion, warnings)
  const token = resolveSpelling(settled, SPELLINGS.token, warnings)

  /*
   * HALF A CONFIGURATION IS AN ERROR, NOT A FALLBACK.
   *
   * A declared project id is an unambiguous statement of intent to read a hosted
   * dataset. Answering it with the committed fixture answers a question nobody
   * asked, and answers it invisibly — the exact failure this file was fixed for.
   *
   * Neither being set is a different case and stays silent: nothing was
   * declared, so the snapshot is the honest answer and the documented default.
   */
  if ((projectId === undefined) !== (dataset === undefined)) {
    const missing = projectId === undefined ? SPELLINGS.projectId.declared : SPELLINGS.dataset.declared
    const given = projectId === undefined ? SPELLINGS.dataset.declared : SPELLINGS.projectId.declared
    throw new Error(
      `[local-site] half a hosted configuration: ${given} is declared but ${missing} is not.\n` +
        `Reading the hosted query API needs both. Falling back to the committed NDJSON snapshot ` +
        `here would serve staging content to a site that was configured for a real dataset, and ` +
        `say nothing about it — so this refuses instead. Declare ${missing} in ` +
        `examples/local-site/.env, or remove ${given} to read the snapshot on purpose.`,
    )
  }

  if (projectId !== undefined && dataset !== undefined) {
    return {
      source: createHttpBaseSource({
        projectId,
        dataset,
        apiVersion: apiVersion ?? '2025-02-19',
        ...(token === undefined ? {} : {token}),
        ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      }),
      summary: `hosted ${projectId}/${dataset} (read-only, GET)`,
      warnings,
    }
  }

  const path = settled.SITE_BASE_DATASET ?? SITE_BASE_DATASET_PATH
  return {
    source: createDocumentBaseSource(loadNdjsonDataset(path)),
    summary: `file ${path}`,
    warnings,
  }
}

export function createSiteClient(
  settled: SiteEnv,
  options: SiteBaseSourceOptions = {},
): SiteClientDescription {
  const config = overlayClientConfigFromEnv(settled)
  const base = createSiteBaseSource(settled, options)

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
      warnings: base.warnings,
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
    warnings: base.warnings,
  }
}
