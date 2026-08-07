/**
 * `sanity-overlay-studio` — the INSTALL contract.
 *
 * The product goal is one line in an existing Sanity project:
 *
 *     export default defineOverlayConfig({ …their config… })
 *
 * That line only works if the package resolves in the consumer's node_modules.
 * pnpm's default `node-linker=isolated` gives a package access to exactly what
 * its own manifest declares — nothing else on disk. So an import the manifest
 * does not name is not a lint nit: it is a hard `ERR_MODULE_NOT_FOUND` at
 * Studio boot, on the consumer's machine, for the one line that is the whole
 * deliverable. It cannot be caught by any test that imports the package through
 * this monorepo, because the workspace root hoists everything.
 *
 * The oracle here is therefore INDEPENDENT of the module graph: the source tree
 * is scanned for bare specifiers, and that set is compared against the manifest.
 * Nothing in this file imports the package under test.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, '../../sanity-overlay-studio')
const SRC_DIR = join(PKG_DIR, 'src')

interface Manifest {
  name?: string
  type?: string
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, {optional?: boolean}>
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Manifest
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Comments out. Several modules document the consumer's own line in JSDoc —
 * `import {defineOverlayConfig} from 'sanity-overlay-studio'` — and a scanner
 * that counted that would report the package as depending on itself. Stripping
 * comments is what makes the scan an oracle rather than a text-similarity test.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Every bare module specifier the package imports, mapped to the package name
 * a manifest would have to declare (`sanity/structure` -> `sanity`).
 *
 * Deliberately a text scan rather than a TypeScript program: what matters is
 * what Node's resolver will be handed, and that is the literal in the source.
 */
function declaredImports(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  /*
   * Anchored to the start of a line, because `config.ts` names the package in a
   * runtime error message — "Import defineOverlayConfig from
   * 'sanity-overlay-studio'" — and an unanchored `from '…'` would read that
   * advice to the user as a dependency. Node only resolves what a real
   * statement asks for, so the oracle must match statements, not prose.
   *
   * The span between the keyword and `from` is restricted to the characters an
   * import/export clause can contain — identifiers, braces, commas, `*`, and
   * whitespace including newlines, so `import {\n  a,\n} from 'x'` still
   * matches. Anything richer (a `(`, a backtick) means this was never an import
   * statement, so the match stops rather than running on into the file.
   */
  const patterns = [
    /^import[\w\s{},*$]*?\sfrom\s+'([^']+)'/gm,
    /^export[\w\s{},*$]*?\sfrom\s+'([^']+)'/gm,
    /^import\s+'([^']+)'/gm,
    /\bimport\(\s*'([^']+)'\s*\)/g,
  ]

  for (const file of sourceFiles(SRC_DIR)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1]
        /*
         * Path specifiers are skipped HERE because this function's job is to
         * map bare specifiers onto manifest entries, and a path is not one.
         *
         * That skip used to mean the class went unchecked entirely, and it is
         * why the describe block below — "the package can actually be installed
         * and resolved" — was green while this package could not be installed
         * at all: 30 of its imports reach out through `../../../` into sibling
         * package directories that exist only in this checkout.
         *
         * It is checked now, in `test/repo-manifests.test.ts` ("no package
         * imports its way out of its own directory"), which owns it for the
         * whole workspace rather than for this package alone and reads sources
         * with a position-aware lexer rather than the anchored regexes here.
         * The 85 that remain are pinned there as a blocked-work ledger.
         */
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue
        if (specifier.startsWith('node:')) continue
        const parts = specifier.split('/')
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        const seen = found.get(name) ?? []
        if (!seen.includes(file)) seen.push(file)
        found.set(name, seen)
      }
    }
  }
  return found
}

describe('the package can actually be installed and resolved', () => {
  it('declares every bare import as a dependency or a peer dependency', () => {
    const pkg = manifest()
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ])

    const undeclared = [...declaredImports().entries()]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (imported by ${files.map((f) => f.slice(PKG_DIR.length + 1)).join(', ')})`)

    expect(undeclared).toEqual([])
  })

  it('does not import anything a Studio consumer would have to add themselves', () => {
    /*
     * "Add themselves" is the whole assertion, and it is a statement about
     * PEERS. A peer dependency is not installed by the package manager on the
     * consumer's behalf, so a peer the consumer does not already have turns the
     * one-line install into "one line plus an install" — and, if they skip it,
     * into `ERR_MODULE_NOT_FOUND` at Studio boot.
     *
     * A HARD dependency is the opposite: npm/pnpm install it as part of
     * installing this package, so the consumer adds nothing. `groq-js` is the
     * live case — the read planner parses the GROQ Studio composes at runtime,
     * and no Studio ships groq-js as a resolvable top-level module. It must
     * therefore be a hard dependency and NOT a peer, which is the mirror image
     * of the `@sanity/client` rule below: groq-js has no cross-copy identity
     * (the studio parses only to derive a plan and hands the original query TEXT
     * to `sanity-overlay-query`, which re-parses with its own copy), whereas a
     * second `@sanity/client` copy would make the facade wrap a different class
     * than Studio holds.
     *
     * So the oracle is: an import must be either something every Studio already
     * has, or something this package's own manifest pulls in.
     */
    const pkg = manifest()
    const alreadyInAnyStudio = new Set(['react', 'sanity', '@sanity/client'])
    const installedForTheConsumer = new Set(Object.keys(pkg.dependencies ?? {}))
    const unexpected = [...declaredImports().keys()].filter(
      (name) => !alreadyInAnyStudio.has(name) && !installedForTheConsumer.has(name),
    )
    expect(unexpected).toEqual([])
  })

  it('declares its peers as peers, not as hard dependencies', () => {
    const pkg = manifest()
    /* A hard dependency on `react` or `@sanity/client` installs a SECOND copy
     * beside the Studio's. Two `@sanity/client` copies means the facade wraps a
     * different class than the one Studio holds, and the interception silently
     * covers nothing. */
    for (const name of ['react', 'sanity', '@sanity/client']) {
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain(name)
      expect(Object.keys(pkg.peerDependencies ?? {})).toContain(name)
    }
  })

  it('points its entry point at a file that exists', () => {
    const pkg = manifest()
    const entry = pkg.exports?.['.']
    expect(typeof entry).toBe('string')
    expect(() => statSync(join(PKG_DIR, entry as string))).not.toThrow()
  })

  it('is ESM, like the Studio bundle that loads it', () => {
    expect(manifest().type).toBe('module')
  })
})
