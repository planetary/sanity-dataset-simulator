/**
 * THE UPSTREAM ORACLE — used only by `specs/live/`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AND WHY IT IS SHAPED LIKE THIS.
 *
 * The Phase 5 exit says *"network audit shows no staging writes"*. The proxy log
 * answers that from the transport's side — nothing write-shaped was forwarded.
 * The complementary question is answered from the other end: **is the dataset
 * the same afterwards as it was before?** That is a question only the upstream
 * API can answer, and answering it requires talking to Sanity, which is why this
 * file is confined to the live project.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO WRITE METHOD EXISTS HERE. THAT IS THE DESIGN, NOT A CONVENTION.
 *
 * `examples/local-site/README.md` makes the same argument about the read
 * client's base port: *"there is no mutate, no patch, no transaction method to
 * call"*. The strongest guarantee this module can offer is the same one — it
 * exports two functions, both `GET`, and there is nothing to misuse. It does not
 * "try not to write"; it cannot.
 *
 * Belt and braces: `request()` refuses any method but GET before it builds a
 * URL, so a future edit that added a verb fails immediately and locally rather
 * than reaching the network.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DELIBERATELY BYPASSES THE PROXY.
 *
 * Reading through :3999 would make the oracle depend on the thing under test. A
 * proxy that quietly served overlay content would then report the dataset
 * unchanged because it was answering from `.sanity-overlay/`. So these calls go
 * straight to `<project>.api.sanity.io` from Node, outside the browser and
 * outside the transport.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ITS CREDENTIALS ARE EXPLICIT, NEVER AMBIENT.
 *
 * This file used to read `SANITY_API_READ_TOKEN` (and two aliases) from
 * `process.env` first and the repo's `.env` only as a fallback, so a token
 * exported in the developer's shell won — and, together with the harness reading
 * `SANITY_STUDIO_PROJECT_ID` ambiently, a live run could authenticate to one
 * project while the Studio drove another and still report "unchanged". Both ends
 * now come from one declared source; see
 * `packages/sanity-overlay-testkit/src/env.ts`.
 */
import {loadExplicitEnv} from '../../packages/sanity-overlay-testkit/src/env'
import type {ExplicitEnv} from '../../packages/sanity-overlay-testkit/src/env'

import {API_VERSION, DATASET, PROJECT_ID} from '../harness/paths.mjs'

/**
 * The oracle must read the dataset the harness actually drives.
 *
 * `paths.mjs` declares the project and dataset the whole E2E stack is wired for.
 * If the declared `.env` names a different one, the two are pointed at different
 * data and the run's central claim — "this document's `_rev` did not move" —
 * would be made about a document the Studio never touched, i.e. it would pass
 * trivially. That is a worse outcome than a red suite, so this refuses.
 */
function assertHarnessAgrees(env: ExplicitEnv): void {
  for (const [key, harness, what] of [
    ['SANITY_PROJECT_ID', PROJECT_ID, 'project'],
    ['SANITY_BASE_DATASET', DATASET, 'dataset'],
  ] as const) {
    const declared = env[key]
    if (declared === undefined || declared === harness) continue
    throw new Error(
      `the live oracle would audit a different ${what} than the E2E harness drives: ` +
        `${key}=${declared} in the declared .env, but e2e/harness/paths.mjs is wired for ` +
        `${harness}. A fingerprint taken from ${declared} says nothing about ${harness}, ` +
        `so it would pass while proving nothing. Make them agree.`,
    )
  }
}

/**
 * A READ token, and only a read token.
 *
 * `assertNoWriteToken()` in `sanity-overlay-studio/src/options.ts` hard-crashes
 * the Studio at boot on any Sanity-scoped credential whose name does not say
 * read-only, so the repo's own `.env` uses `SANITY_API_READ_TOKEN`. The same
 * spellings are accepted here and nothing else is: a write-capable token in this
 * process would be a way for the suite itself to mutate the dataset it is
 * asserting is unchanged.
 *
 * All three spellings are read from the DECLARED source only. An ambient export
 * of any of them resolves absent — `loadExplicitEnv()` says so on the way past —
 * and the live specs skip, which is what they already did with no credentials.
 */
export function readToken(env: ExplicitEnv = loadExplicitEnv()): string | undefined {
  assertHarnessAgrees(env)
  for (const key of ['SANITY_API_READ_TOKEN', 'SANITY_READ_TOKEN', 'SANITY_API_READONLY_TOKEN']) {
    const value = env[key]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Are the live specs runnable on this machine at all? */
export function liveCredentialsAvailable(env: ExplicitEnv = loadExplicitEnv()): boolean {
  return readToken(env) !== undefined
}

const BASE = `https://${PROJECT_ID}.api.sanity.io/v${API_VERSION}`

async function request(method: 'GET', path: string): Promise<unknown> {
  if (method !== 'GET') {
    throw new Error(`the upstream oracle is read-only; refused ${method} ${path}`)
  }
  const token = readToken()
  const response = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: token === undefined ? {} : {authorization: `Bearer ${token}`},
  })
  if (!response.ok) {
    throw new Error(`upstream GET ${path} answered ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

export interface UpstreamDocument {
  _id: string
  _rev: string
  _type: string
  _updatedAt?: string
  [field: string]: unknown
}

/**
 * One document as the dataset currently holds it, or `null`.
 *
 * `_rev` is the field that matters: Content Lake changes it on every mutation,
 * so an unchanged `_rev` across a whole editing session is a positive statement
 * that nothing wrote to that document — stronger than "we saw no write go by".
 */
export async function getUpstreamDocument(id: string): Promise<UpstreamDocument | null> {
  const body = (await request('GET', `/data/doc/${DATASET}/${encodeURIComponent(id)}`)) as {
    documents?: UpstreamDocument[]
  }
  return body.documents?.[0] ?? null
}

/** A GROQ read. Used to prove a `drafts.<id>` document was never created. */
export async function upstreamQuery<T = unknown>(groq: string): Promise<T> {
  const body = (await request(
    'GET',
    `/data/query/${DATASET}?query=${encodeURIComponent(groq)}`,
  )) as {result: T}
  return body.result
}

/**
 * A stable fingerprint of one document's server-side state.
 *
 * `_rev` plus `_updatedAt`: either one moving means Content Lake wrote. Compared
 * before and after the run, this is the assertion the exit criterion asks for.
 */
export async function fingerprint(id: string): Promise<string> {
  const document = await getUpstreamDocument(id)
  if (document === null) return `${id}:absent`
  return `${id}:${document._rev}:${document._updatedAt ?? 'no-updatedAt'}`
}
