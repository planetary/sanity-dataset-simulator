// SPIKE B — a `.ts` fallback for Node's ESM resolver.
//
// WHY THIS EXISTS
// `origin.mjs` imports `sanity-overlay-core` and `sanity-overlay-store-fs`,
// whose internal specifiers are extensionless (`./contract`, `./types/index`).
// Bundlers accept that; Node's ESM resolver does not — it wants the exact
// filename — so `node --experimental-strip-types runOrigin.mjs` would die with
// ERR_MODULE_NOT_FOUND deep inside `core/src/index.ts`.
//
// Rather than rewrite hundreds of specifiers in packages this spike does not
// own, this resolve hook retries a failed *relative* resolution as `<spec>.ts`
// and then `<spec>/index.ts`. It is strictly a FALLBACK: a specifier that
// already resolves is never touched, so nothing here can shadow a real file.
//
// Registered by `runOrigin.mjs` via `module.register()`. Mode 1
// (`node proxy.mjs`) never loads it and never needs it — that is the whole
// reason `originSafety.mjs` is a separate, dependency-free module.

/** Specifiers we may extend: relative, and not already carrying a JS/TS extension. */
const EXTENDABLE = /^\.{1,2}\//
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/

/**
 * Workspace packages a BARE specifier may be resolved from as a fallback.
 *
 * `sanity-overlay-query` and `origin.mjs` both want `groq-js@2.0.0`, but the
 * pnpm workspace only materialised the symlink under two packages; Node's
 * resolver walks up from `examples/kitchen-sink/spikeB-proxy` and finds
 * nothing but pnpm's virtual store. Vitest never notices because Vite retries a
 * failed bare import from its project root, which IS the testkit. Installs are
 * out of scope for this spike and package.json is not ours to change, so the
 * launcher retries the same way Vite does, from a package that pins the same
 * version. If a real install ever lands, the first `nextResolve` succeeds and
 * this never runs.
 */
const BARE_FALLBACK_PARENTS = [
  new URL('../../../packages/sanity-overlay-testkit/package.json', import.meta.url).href,
  new URL('../../../packages/sanity-overlay-query/package.json', import.meta.url).href,
]

const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'])

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!NOT_FOUND.has(error?.code)) throw error

    if (!EXTENDABLE.test(specifier)) {
      /* A bare specifier: retry it from a workspace package that has it. */
      if (specifier.startsWith('#') || specifier.startsWith('node:')) throw error
      for (const parentURL of BARE_FALLBACK_PARENTS) {
        try {
          return await nextResolve(specifier, {...context, parentURL})
        } catch {
          /* try the next parent; the original error is rethrown if none work */
        }
      }
      throw error
    }

    if (HAS_EXTENSION.test(specifier)) throw error

    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        /* try the next shape; the original error is rethrown if none work */
      }
    }
    throw error
  }
}
