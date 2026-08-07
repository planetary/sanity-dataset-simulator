/**
 * The Sanity CLI's config — and this example's ONLY chance to tell an ambient
 * `SANITY_STUDIO_PROJECT_ID` apart from a declared one.
 *
 * `sanity dev`, `sanity build` and `sanity deploy` all evaluate this file in
 * Node, before Vite starts. That matters because Vite then inlines
 * `SANITY_STUDIO_*` into the browser bundle from this directory's `.env` files
 * AND from the shell, merged, with the shell winning — after which nothing in
 * `sanity.config.ts` can tell which one it got.
 *
 * Here the two are still separable: `.env` is a file and can be read as one.
 * So the check happens here, once, for the whole Studio, and a disagreement
 * aborts the CLI before a browser bundle exists.
 *
 * See `studioIdentity.mjs` for what a consumer copying this example changes,
 * and `../explicitEnv.mjs` for why a disagreement is refused rather than
 * resolved by a precedence rule.
 */
import {fileURLToPath} from 'node:url'
import {defineCliConfig} from 'sanity/cli'
import {loadExplicitEnv} from '../explicitEnv.mjs'
import {
  DECLARED_STUDIO_IDENTITY,
  STUDIO_IDENTITY_KEYS,
  studioIdentity,
} from './studioIdentity.mjs'

/** This example's own `.env` files — the Studio-idiomatic declared source. */
const STUDIO_DIR = fileURLToPath(new URL('./', import.meta.url))

const declared = loadExplicitEnv({
  dirs: [STUDIO_DIR],
  keys: STUDIO_IDENTITY_KEYS,
  defaults: DECLARED_STUDIO_IDENTITY,
  who: 'kitchen-sink',
})

export default defineCliConfig({api: studioIdentity(declared)})
