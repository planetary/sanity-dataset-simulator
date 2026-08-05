// A resolver fallback for running the workspace's TypeScript sources under
// plain Node. Two fallbacks, both narrow, both only on a resolution that has
// already failed — nothing that resolves is ever redirected.
//
// 1. EXTENSIONLESS RELATIVE SPECIFIERS. `sanity-overlay-core` and friends are
//    written for bundlers (vitest, Vite), which accept `./types/index`. Node's
//    ESM resolver requires the exact filename, so a plain
//    `node --experimental-strip-types` run dies with ERR_MODULE_NOT_FOUND deep
//    inside `core/src/index.ts`. The hook retries `<spec>.ts` then
//    `<spec>/index.ts`.
//
// 2. BARE SPECIFIERS WITH NO LOCAL LINK. `sanity-overlay-query` declares
//    `groq-js`, but this workspace's `node_modules` was installed before that
//    package existed, so there is no `packages/sanity-overlay-query/node_modules`
//    for Node to walk into. Installing is not an option from here, so a failed
//    bare specifier is retried from a workspace package that DOES have the
//    dependency linked. After a `pnpm install` the first resolution succeeds and
//    this branch is never reached.
//
// Registered by `run.mjs` / `seed.mjs` via `module.register()`.

/** Specifiers we may extend: relative, and not already carrying a JS/TS extension. */
const EXTENDABLE = /^\.{1,2}\//
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/

/** A file inside a workspace package whose `node_modules` has the shared deps linked. */
const FALLBACK_PARENT = new URL(
  '../../packages/sanity-overlay-testkit/src/index.ts',
  import.meta.url,
).href

const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'])

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!NOT_FOUND.has(error?.code)) throw error

    if (EXTENDABLE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return await nextResolve(candidate, context)
        } catch {
          /* try the next shape; the original error is rethrown if none work */
        }
      }
      throw error
    }

    /* Bare specifier: retry from a package that has it linked. */
    if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
      try {
        return await nextResolve(specifier, {...context, parentURL: FALLBACK_PARENT})
      } catch {
        throw error
      }
    }

    throw error
  }
}
