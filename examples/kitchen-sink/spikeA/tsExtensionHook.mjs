// SPIKE A — a `.ts` fallback for Node's ESM resolver.
//
// WHY THIS EXISTS
// `sanity-overlay-core` and `sanity-overlay-store-fs` are consumed by bundlers
// (vitest, Vite) that accept extensionless relative specifiers — `./contract`,
// `./types/index`. Node's ESM resolver does not: it requires the exact filename,
// so `node --experimental-strip-types overlayServer.mjs` dies with
// ERR_MODULE_NOT_FOUND deep inside `core/src/index.ts`.
//
// Rather than rewrite hundreds of specifiers in packages this spike does not
// own, this resolve hook retries a failed relative resolution as `<spec>.ts` and
// then `<spec>/index.ts`. It is a *fallback*: a specifier that already resolves
// is never touched, so nothing shadows a real file.
//
// Registered by `runOverlayServer.mjs` via `module.register()`.

/** Specifiers we may extend: relative, and not already carrying a JS/TS extension. */
const EXTENDABLE = /^\.{1,2}\//
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (
      error?.code !== 'ERR_MODULE_NOT_FOUND' ||
      !EXTENDABLE.test(specifier) ||
      HAS_EXTENSION.test(specifier)
    ) {
      throw error
    }

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
