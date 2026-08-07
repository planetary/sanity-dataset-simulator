/**
 * WHICH PROJECT AND DATASET THIS STUDIO OPENS — the one place it is decided.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOR A CONSUMER COPYING THIS EXAMPLE.
 *
 * Configuring a Studio through `SANITY_STUDIO_PROJECT_ID` / `SANITY_STUDIO_DATASET`
 * is how Studios work, and nothing here changes that: put them in this
 * directory's `.env` (or `.env.local`), exactly as the Sanity docs say, and
 * both `sanity dev` and every launcher in this example pick them up. The
 * constants below are only what this repository's own copy is pointed at when
 * no `.env` says otherwise, so a fresh clone runs with no setup.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE READ IS FUNNELLED THROUGH ONE FUNCTION.
 *
 * A Studio is a Vite bundle. Vite inlines `SANITY_STUDIO_*` at build time from
 * BOTH this directory's `.env` files and the shell that ran the build, merged
 * into one `process.env` with the shell winning — dotenv does not overwrite a
 * variable that is already exported. Inside the browser the two are therefore
 * indistinguishable, and there is no filesystem to go and check.
 *
 * That is the whole reason the guard cannot live here. It lives in
 * `sanity.cli.ts`, which the Sanity CLI evaluates in Node before it starts
 * Vite, where `.env` can still be read as a file and compared against the
 * ambient environment. A disagreement aborts the CLI, so by the time this
 * function runs in a browser, `process.env` has already been vouched for.
 *
 * Keeping the browser-side read to ONE named function is what makes that
 * pairing checkable — `test/examples-explicit-env.test.ts` asserts that no
 * other file under `examples/` reads a project identity out of an ambient
 * environment, and this is the single declared exception.
 *
 * NO `node:` IMPORTS. This module is in the browser bundle. Adding one breaks
 * `sanity build`.
 */

/**
 * What this repository's copy of the example is pointed at.
 *
 * Keyed by environment variable name rather than by `projectId`/`dataset` so it
 * can be handed to the declared-source loader as its lowest-precedence layer
 * without either side restating the spellings.
 */
export const DECLARED_STUDIO_IDENTITY = Object.freeze({
  SANITY_STUDIO_PROJECT_ID: 'b1n03q3z',
  SANITY_STUDIO_DATASET: 'parity',
})

/** The keys that decide whose content this Studio opens. */
export const STUDIO_IDENTITY_KEYS = Object.freeze(Object.keys(DECLARED_STUDIO_IDENTITY))

/** Blank is unset, not a value — an exported-but-empty variable configures nothing. */
function present(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve the Studio's identity from an environment map.
 *
 * @param {Record<string, string|undefined>} [env] `process.env` in the browser
 *   bundle; the loader's resolved values in every Node launcher.
 * @returns {{projectId: string, dataset: string}}
 */
export function studioIdentity(env) {
  const source = env ?? {}
  return {
    projectId:
      present(source.SANITY_STUDIO_PROJECT_ID) ??
      DECLARED_STUDIO_IDENTITY.SANITY_STUDIO_PROJECT_ID,
    dataset: present(source.SANITY_STUDIO_DATASET) ?? DECLARED_STUDIO_IDENTITY.SANITY_STUDIO_DATASET,
  }
}
