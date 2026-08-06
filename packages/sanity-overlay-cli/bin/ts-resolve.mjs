/**
 * A twelve-line ESM resolve hook, so the `sanity-overlay` binary runs the
 * TypeScript sources directly with no build step and no dependency.
 *
 * Node 22 strips TypeScript types natively, but its ESM resolver still requires
 * explicit file extensions. This repo imports across packages by extensionless
 * relative path (`../../sanity-overlay-core/src/index`), which is the convention
 * every package here already follows and which the test runner resolves for
 * itself. This hook does the same thing for `node`: try the specifier as given,
 * and on failure retry it as `.ts` and as `/index.ts`.
 *
 * Deliberately not a bundler and not `tsx`: the CLI's stated constraint is Node
 * built-ins only, and a resolver hook is the smallest thing that satisfies it.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await nextResolve(specifier, context)
    } catch (error) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return await nextResolve(specifier + suffix, context)
        } catch {
          /* try the next candidate */
        }
      }
      throw error
    }
  }
  return nextResolve(specifier, context)
}
