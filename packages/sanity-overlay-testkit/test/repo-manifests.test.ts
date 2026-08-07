/**
 * WORKSPACE-WIDE install contract.
 *
 * `test/studio-install.test.ts` proves one package (`sanity-overlay-studio`)
 * declares what it imports. It exists because that package shipped with
 * `@sanity/client` imported and undeclared: a hard `ERR_MODULE_NOT_FOUND` at
 * Studio boot on a consumer's machine, and completely invisible in-repo, because
 * the workspace root hoists every dependency into a place Node happens to find.
 *
 * That defect was never Studio-specific. Any package here can acquire it, and
 * no test that imports a package through this monorepo can ever see it. So this
 * file generalises the oracle to every package in `packages/*`.
 *
 * The oracle is INDEPENDENT of the module graph on purpose: source text is
 * scanned for bare specifiers and compared against the manifest. Nothing here
 * imports any package under test. A test that resolved the imports would
 * resolve them through the hoisted root and pass on exactly the input that
 * breaks in the wild.
 *
 * WHY RELATIVE SPECIFIERS ARE NO LONGER SKIPPED.
 *
 * This file, and `test/studio-install.test.ts` before it, skipped every
 * specifier beginning with `.` — the stated reason being that cross-package
 * imports here are written as relative paths on purpose, packages being consumed
 * from source rather than from a build output, so a relative specifier is not a
 * dependency and cannot be missing from a manifest.
 *
 * The first half of that is true and still is. The conclusion was not. A
 * relative specifier that leaves its own package root, such as
 * `../../sanity-overlay-core/src/index` written inside
 * `packages/sanity-overlay-store-fs/src/`, is not "not a dependency" — it is a
 * dependency expressed in a form no manifest can declare and no installer can
 * satisfy. `packages/` is a directory that exists in this checkout and nowhere
 * else. Installed from a registry, or linked into a consumer's `node_modules`,
 * the path resolves to nothing and the package fails to load.
 *
 * That is the SAME defect the rest of this file exists to catch — an import the
 * consumer cannot resolve, invisible in-repo because the checkout happens to
 * have the file where the path points — and skipping the specifier hid the
 * larger half of it. Skipping meant the test named "the package can actually be
 * installed and resolved" was green while no package in the workspace could be
 * installed at all.
 *
 * So the convention changes: a relative specifier that stays inside its own
 * package is correct and is ignored; one that escapes is a defect and is named.
 * The 85 that exist today are pinned in KNOWN_ESCAPING below rather than
 * silently skipped, in the same self-cleaning shape as every other pinned list
 * here — a new one turns this red, and fixing one turns it red too, until the
 * entry is deleted. The pin is a blocked-work ledger, not an exemption.
 */
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {dirname, join, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

interface Manifest {
  name?: string
  type?: string
  private?: boolean
  bin?: Record<string, string>
  files?: string[]
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface Pkg {
  /** Directory name under `packages/`, which is also the package name here. */
  dir: string
  path: string
  manifest: Manifest
}

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo'])

function packages(): Pkg[] {
  return readdirSync(PACKAGES_DIR)
    .filter((entry) => statSync(join(PACKAGES_DIR, entry)).isDirectory())
    .map((dir) => {
      const path = join(PACKAGES_DIR, dir)
      return {
        dir,
        path,
        manifest: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Manifest,
      }
    })
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (SOURCE_EXT.some((ext) => entry.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

/*
 * ---------------------------------------------------------------------------
 * The scanner.
 *
 * This was a set of anchored regular expressions over comment-stripped text.
 * It reported two things that are not imports:
 *
 *   - `require('@vercel/blob')` written INSIDE a template literal, as fixture
 *     input to the module-boundary scanner in test/core-boundaries.test.ts;
 *   - the same shape inside an ordinary quoted string, as advice in a message.
 *
 * Both are text. Node resolves neither, so neither belongs in a manifest, and
 * a red result naming them is a defect report about correct code.
 *
 * A regex cannot tell the two apart, because the false positive is not
 * malformed — it is a perfect copy of the real thing, just quoted. What
 * separates them is POSITION, and position needs a lexer. So the scan is now a
 * single left-to-right pass that knows where string, template, comment and
 * regex literals begin and end, and it recognises an import by the token that
 * precedes the specifier rather than by the shape of the surrounding line.
 *
 * That also closes gaps the regexes had in the dangerous direction — a missed
 * import is an ERR_MODULE_NOT_FOUND that ships. An indented `require`, a
 * double-quoted specifier, and `import\n  {a}\nfrom 'x'` were all invisible
 * before and are found now.
 * ---------------------------------------------------------------------------
 */

interface Token {
  /** `string` carries a resolvable literal; everything else is positional. */
  kind: 'ident' | 'punct' | 'string' | 'opaque'
  value: string
}

const IDENT_CHAR = /[A-Za-z0-9_$]/

/**
 * A `/` opens a regex unless the previous token could END an expression, in
 * which case it is division. Getting this wrong is not cosmetic: reading `/`
 * as division when it opened `/['"]/` leaves the scanner inside a string for
 * the rest of the file and it reports nothing at all — silent under-report,
 * the failure mode this whole file exists to prevent. Hence the
 * "still reads the statements that follow" case above.
 */
const EXPRESSION_END_PUNCT = new Set([')', ']', '}'])
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const previous = (): Token | undefined => tokens[tokens.length - 1]
  let i = 0

  /** Consume a quoted string or a template, returning its static text. */
  const readLiteral = (quote: string): {text: string; interpolated: boolean} => {
    const template = quote === '`'
    let text = ''
    let interpolated = false
    let depth = 0
    i++
    while (i < source.length) {
      const c = source[i]
      if (depth > 0) {
        // Inside `${ … }` — real code, but nothing an import specifier can be
        // the whole of. Skip it wholesale, nested literals included, so its
        // quotes cannot desynchronise the outer template.
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === '"' || c === "'" || c === '`') {
          const nested = c
          i++
          while (i < source.length && source[i] !== nested) i += source[i] === '\\' ? 2 : 1
        }
        i++
        continue
      }
      if (c === '\\') {
        text += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) {
        i++
        break
      }
      if (template && c === '$' && source[i + 1] === '{') {
        interpolated = true
        depth = 1
        i += 2
        continue
      }
      // An unterminated quoted string: stop at the newline rather than run on.
      if (!template && c === '\n') break
      text += c
      i++
    }
    return {text, interpolated}
  }

  while (i < source.length) {
    const c = source[i]

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
      continue
    }

    /*
     * Comments out. Modules here document a consumer's own import line in
     * JSDoc (`import {defineOverlayConfig} from 'sanity-overlay-studio'`), and
     * a scanner that counted that would report a package as depending on
     * itself.
     */
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }

    if (c === '/') {
      const prev = previous()
      const isDivision =
        prev !== undefined &&
        ((prev.kind === 'ident' && !KEYWORDS_BEFORE_REGEX.has(prev.value)) ||
          prev.kind === 'string' ||
          prev.kind === 'opaque' ||
          (prev.kind === 'punct' && EXPRESSION_END_PUNCT.has(prev.value)))
      if (isDivision) {
        tokens.push({kind: 'punct', value: '/'})
        i++
        continue
      }
      i++
      let inClass = false
      while (i < source.length) {
        const r = source[i]
        if (r === '\\') i += 2
        else if (r === '[') {
          inClass = true
          i++
        } else if (r === ']') {
          inClass = false
          i++
        } else if (r === '/' && !inClass) {
          i++
          break
        } else if (r === '\n') break
        else i++
      }
      tokens.push({kind: 'opaque', value: 'regex'})
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      const {text, interpolated} = readLiteral(c)
      // An interpolated template is not a fixed specifier; nothing can be
      // declared for it, so it is opaque rather than a string.
      tokens.push(interpolated ? {kind: 'opaque', value: 'template'} : {kind: 'string', value: text})
      continue
    }

    if (IDENT_CHAR.test(c)) {
      let j = i
      while (j < source.length && IDENT_CHAR.test(source[j])) j++
      tokens.push({kind: 'ident', value: source.slice(i, j)})
      i = j
      continue
    }

    tokens.push({kind: 'punct', value: c})
    i++
  }

  return tokens
}

/**
 * Every module specifier a source really asks the loader for.
 *
 * A string literal is a specifier when — and only when — the token in front of
 * it is one of:
 *
 *   `from`      `import x from 'p'`, `export {x} from 'p'`, `export * from 'p'`
 *   `import`    `import 'p'` (side effect)
 *   `(`         and the token before THAT is `import` or `require`
 *
 * Position, not prose. `Buffer.from('hex')` has `(` in front of the literal and
 * `from` before that, so the callee rule rejects it; `{from: 'x'}` has `:`;
 * `declare module 'p'` has `module`, which is a declaration and not a request
 * for a module that must exist.
 */
function moduleSpecifiers(source: string): string[] {
  const tokens = tokenize(source)
  const out: string[] = []
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n]
    if (token.kind !== 'string') continue
    const prev = tokens[n - 1]
    if (prev === undefined) continue
    if (prev.kind === 'ident' && (prev.value === 'from' || prev.value === 'import')) {
      out.push(token.value)
      continue
    }
    if (prev.kind === 'punct' && prev.value === '(') {
      const callee = tokens[n - 2]
      if (callee?.kind === 'ident' && (callee.value === 'import' || callee.value === 'require')) {
        out.push(token.value)
      }
    }
  }
  return out
}

/** `sanity/structure` -> `sanity`; `@sanity/client/csm` -> `@sanity/client`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

interface Import {
  /** Bare package name a manifest would have to declare. */
  name: string
  /** Absolute path of the importing file. */
  file: string
  /** True for `node:fs` and friends — resolvable without any manifest entry. */
  builtin: boolean
}

function importsOf(pkg: Pkg): Import[] {
  const out: Import[] = []
  for (const file of sourceFiles(pkg.path)) {
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue
      if (specifier.startsWith('node:')) {
        out.push({name: specifier, file, builtin: true})
        continue
      }
      out.push({name: packageNameOf(specifier), file, builtin: false})
    }
  }
  return out
}

/**
 * The extensions tsc reads. No tsconfig in this workspace sets `allowJs`, so a
 * `.mjs`/`.cjs`/`.js` file is never typechecked wherever it sits — which means
 * the builtins it imports cannot make or break a `tsc --noEmit` run.
 */
const TYPECHECKED_EXT = ['.ts', '.tsx', '.mts', '.cts']

/** Absolute `include` roots from a package's own tsconfig. */
function typecheckRoots(pkg: Pkg): string[] {
  const configPath = join(pkg.path, 'tsconfig.json')
  if (!existsSync(configPath)) return []
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {include?: string[]}
  return (config.include ?? []).map((entry) => join(pkg.path, entry))
}

/** True when `tsc --noEmit -p <pkg>` would compile this file. */
function isTypechecked(pkg: Pkg, file: string): boolean {
  if (!TYPECHECKED_EXT.some((ext) => file.endsWith(ext))) return false
  return typecheckRoots(pkg).some((root) => file === root || file.startsWith(`${root}${sep}`))
}

function declaredNames(m: Manifest): Set<string> {
  return new Set([
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
    ...Object.keys(m.devDependencies ?? {}),
    ...Object.keys(m.optionalDependencies ?? {}),
  ])
}

function rel(file: string): string {
  return file.slice(REPO_ROOT.length + 1)
}

const ALL = packages()

/*
 * The scanner is the whole oracle, so it is tested against synthetic sources
 * before it is pointed at the repo. Two directions matter and they fail
 * differently:
 *
 *   UNDER-report — the scanner misses a real import, the package ships
 *   undeclared, and this file goes green on exactly the input it exists to
 *   catch. This is the dangerous direction.
 *
 *   OVER-report — the scanner counts code-shaped text that Node never
 *   resolves, and the failure names a defect that does not exist. That is how
 *   a check gets deleted.
 */
describe('the import scanner reads statements, not code-shaped text', () => {
  const found = (source: string): string[] => [...new Set(moduleSpecifiers(source))].sort()

  it('finds every form of real import', () => {
    expect(found(`import {a} from 'static-named'`)).toEqual(['static-named'])
    expect(found(`import * as ns from 'star'`)).toEqual(['star'])
    expect(found(`import type {A} from 'type-only'`)).toEqual(['type-only'])
    expect(found(`import 'side-effect'`)).toEqual(['side-effect'])
    expect(found(`import {\n  a,\n  b,\n} from 'multiline'`)).toEqual(['multiline'])
    expect(found(`export {a} from 're-export'`)).toEqual(['re-export'])
    expect(found(`export * from 'star-re-export'`)).toEqual(['star-re-export'])
    expect(found(`const m = await import('dynamic')`)).toEqual(['dynamic'])
    expect(found(`const m = require('commonjs')`)).toEqual(['commonjs'])
    expect(found(`import fs from 'node:fs'`)).toEqual(['node:fs'])
    expect(found(`import a from './relative'`)).toEqual(['./relative'])
  })

  it('finds the forms the anchored regexes used to miss', () => {
    /* Every one of these resolves at runtime. A scanner that cannot see them
     * lets the package ship undeclared, which is the whole defect class. */
    expect(found(`import a from "double-quoted"`)).toEqual(['double-quoted'])
    expect(found(`  const m = require('indented')`)).toEqual(['indented'])
    expect(found(`import\n  {a}\nfrom 'clause-on-own-line'`)).toEqual(['clause-on-own-line'])
    expect(found(`import a, {b as c} from 'default-plus-named'`)).toEqual(['default-plus-named'])
  })

  it('ignores a specifier that only appears in a comment', () => {
    expect(found(`// import {a} from 'in-line-comment'`)).toEqual([])
    expect(found(`/**\n * import {a} from 'in-block-comment'\n */`)).toEqual([])
    expect(found(`/* const a = require('in-block-comment') */`)).toEqual([])
  })

  /*
   * The bug this describe block was written for. `test/core-boundaries.test.ts`
   * feeds the module-boundary scanner a FIXTURE source as a template literal:
   *
   *   `const a = await import('node:fs/promises')\nconst b = require('@vercel/blob')\n`
   *
   * That text is data. Node resolves nothing in it, `@vercel/blob` is not and
   * must not be a testkit dependency, and the fixture's entire purpose is to be
   * a forbidden import that the OTHER scanner reports. Counting it made this
   * file red on a package that is correct.
   */
  it('ignores code-shaped text inside a template literal', () => {
    expect(found('const fixture = `const b = require(\'in-template\')\\n`')).toEqual([])
    expect(found('const fixture = `await import(\'in-template\')`')).toEqual([])
    expect(found('const fixture = `\nimport {a} from \'in-template\'\n`')).toEqual([])
    expect(found('const fixture = `\nexport {a} from \'in-template\'\n`')).toEqual([])
  })

  it('ignores code-shaped text inside a quoted string', () => {
    expect(found(`const advice = "run require('in-string') first"`)).toEqual([])
    expect(found(`throw new Error("add import 'in-string' to the entry point")`)).toEqual([])
  })

  it('does not mistake a method named from for a module specifier', () => {
    expect(found(`const b = Buffer.from('deadbeef', 'hex')`)).toEqual([])
    expect(found(`const a = Array.from('abc')`)).toEqual([])
  })

  it('still reads the statements that follow the text it skipped', () => {
    /* An over-eager skip that swallows the rest of the file is the under-report
     * failure in its worst form: the file goes green having read nothing. */
    expect(found('const t = `require(\'skipped\')`\nimport {a} from \'after-template\'')).toEqual([
      'after-template',
    ])
    expect(found(`const url = 'https://example.com'\nimport {a} from 'after-url'`)).toEqual([
      'after-url',
    ])
    expect(found(`const re = /['\`]/\nimport {a} from 'after-regex'`)).toEqual(['after-regex'])
  })

  it('is not blind on the real repo', () => {
    /*
     * Every assertion above is synthetic, and a scanner that returned [] for
     * everything would still satisfy the negative cases. This one fails if the
     * scan goes quiet on real sources: these two imports exist, are declared,
     * and would therefore never show up in any of the undeclared-import
     * assertions below no matter how blind the scanner became.
     */
    const seen = (dir: string): Set<string> =>
      new Set(
        importsOf(ALL.find((p) => p.dir === dir)!)
          .filter((i) => !i.builtin)
          .map((i) => i.name),
      )
    expect([...seen('sanity-overlay-query')]).toContain('groq-js')
    expect([...seen('sanity-overlay-testkit')]).toContain('vitest')
    expect([...seen('sanity-overlay-studio')]).toContain('@sanity/client')
  })
})

describe('a package is only asked for the types tsc actually needs', () => {
  /*
   * `isTypechecked` is the discriminator behind the `@types/node` check below,
   * and it is the difference between a defect report and a false one.
   *
   * `sanity-overlay-query/lint/check-queries.mjs` is a Node script: it imports
   * `node:fs`, and it will never be typechecked. It is a `.mjs` (no package
   * here sets `allowJs`, so tsc does not read JavaScript at all) and it sits
   * outside the `include` roots of the package's tsconfig. Demanding
   * `@types/node` for it names a problem that does not exist and cannot be
   * fixed by installing anything.
   */
  const query = ALL.find((p) => p.dir === 'sanity-overlay-query')!

  it('counts TypeScript inside the tsconfig include roots', () => {
    expect(isTypechecked(query, join(query.path, 'src/index.ts'))).toBe(true)
    expect(isTypechecked(query, join(query.path, 'src/lint/queryLint.ts'))).toBe(true)
    expect(isTypechecked(query, join(query.path, 'parity/index.ts'))).toBe(true)
  })

  it('does not count JavaScript, or TypeScript outside those roots', () => {
    expect(isTypechecked(query, join(query.path, 'lint/check-queries.mjs'))).toBe(false)
    expect(isTypechecked(query, join(query.path, '.ast-scratch.mjs'))).toBe(false)
    expect(isTypechecked(query, join(query.path, 'lint/somewhere.ts'))).toBe(false)
  })

  it('every tsconfig include entry is a directory this check can resolve', () => {
    /*
     * `isTypechecked` treats an include entry as a directory prefix. A glob
     * (`src/**` + '/' + `*.ts`) would silently match nothing, and a package would
     * drop out of the builtin scan without anyone noticing — the same silent
     * under-report the scanner above guards against. Fail here instead.
     */
    for (const pkg of ALL) {
      for (const root of typecheckRoots(pkg)) {
        expect(existsSync(root) && statSync(root).isDirectory(), `${pkg.dir}: ${root}`).toBe(true)
      }
    }
  })
})

describe('every package declares what it imports', () => {
  it.each(ALL.map((p) => [p.dir, p] as const))(
    '%s: every bare import is named in the manifest',
    (_dir, pkg) => {
      const declared = declaredNames(pkg.manifest)
      const own = pkg.manifest.name
      const undeclared = importsOf(pkg)
        .filter((i) => !i.builtin)
        .filter((i) => i.name !== own && !declared.has(i.name))
        .map((i) => `${i.name} (imported by ${rel(i.file)})`)

      expect([...new Set(undeclared)].sort()).toEqual([])
    },
  )

  it.each(ALL.map((p) => [p.dir, p] as const))(
    '%s: the runtime surface (src/) does not lean on devDependencies',
    (_dir, pkg) => {
      /*
       * A devDependency is not installed for a consumer. An import under `src/`
       * — the directory every package's `exports` points into — that only a
       * devDependency satisfies is the same ERR_MODULE_NOT_FOUND as an
       * undeclared one, just one install-flag away.
       *
       * `sanity-overlay-testkit` is exempt and only it: its `src/` IS test
       * harness (storeContract.ts and writeGuardContract.ts are vitest suites
       * that other packages run), so `vitest` under `src/` is the contract, not
       * a leak. Any other package appearing here is a real defect.
       */
      if (pkg.dir === 'sanity-overlay-testkit') return

      const runtime = new Set([
        ...Object.keys(pkg.manifest.dependencies ?? {}),
        ...Object.keys(pkg.manifest.peerDependencies ?? {}),
      ])
      const devOnly = Object.keys(pkg.manifest.devDependencies ?? {}).filter(
        (name) => !runtime.has(name),
      )
      const srcDir = join(pkg.path, 'src')
      const leaks = importsOf(pkg)
        .filter((i) => !i.builtin && i.file.startsWith(srcDir) && devOnly.includes(i.name))
        .map((i) => `${i.name} (imported by ${rel(i.file)})`)

      expect([...new Set(leaks)].sort()).toEqual([])
    },
  )
})

/*
 * ---------------------------------------------------------------------------
 * Imports that leave their own package.
 *
 * See the header for why these are a defect rather than a convention. The
 * question each answers is: would Node still find this file if the package were
 * unpacked on its own, anywhere else on disk? A specifier that resolves outside
 * the package directory answers no.
 * ---------------------------------------------------------------------------
 */

/**
 * True when `specifier`, written in `file`, resolves outside `pkgPath`.
 *
 * Bare specifiers are NOT this check's business — they resolve through
 * node_modules and are already covered by "every package declares what it
 * imports" above. Only path specifiers can escape a directory.
 */
function escapesPackage(pkgPath: string, file: string, specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false
  const target = specifier.startsWith('/') ? specifier : resolve(dirname(file), specifier)
  /*
   * The trailing separator is load-bearing. A bare `startsWith(pkgPath)` would
   * read `packages/sanity-overlay-core-extra/...` as being inside
   * `packages/sanity-overlay-core`, and an escape into a sibling whose name
   * merely starts with this one's would pass silently.
   */
  return target !== pkgPath && !target.startsWith(`${pkgPath}${sep}`)
}

/**
 * The top-level directories a package's own manifest publishes — the union of
 * the roots named by `exports`, `bin` and `files`.
 *
 * Scoping to these is the difference between the claim being made and a
 * different, false one. `sanity-overlay-testkit/test/` reaches into every
 * sibling package by relative path 275 times, and that is correct: it is the
 * workspace's test runner, it is not reachable from any `exports` entry, and no
 * consumer ever loads it. Flagging it would report 275 defects that do not
 * exist. What must resolve after an install is what `exports` and `bin` can
 * reach, and that is exactly what is scanned.
 */
function shippedRoots(pkg: Pkg): string[] {
  const entries = [
    ...Object.values(pkg.manifest.exports ?? {}),
    ...Object.values(pkg.manifest.bin ?? {}),
    ...(pkg.manifest.files ?? []),
  ]
  const roots = new Set<string>()
  for (const entry of entries) {
    const first = entry.replace(/^\.\//, '').split('/')[0]
    if (first !== '' && first !== '.') roots.add(first)
  }
  return [...roots].sort()
}

function escapingImports(pkg: Pkg): string[] {
  const roots = shippedRoots(pkg).map((root) => join(pkg.path, root) + sep)
  const out: string[] = []
  for (const file of sourceFiles(pkg.path)) {
    if (!roots.some((root) => file.startsWith(root))) continue
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (escapesPackage(pkg.path, file, specifier)) out.push(`${rel(file)} -> ${specifier}`)
    }
  }
  return [...new Set(out)].sort()
}

describe('an import that leaves its own package is found', () => {
  /*
   * Synthetic, because the pinned list below stops being able to prove anything
   * about the classifier the moment it is emptied — which is the whole goal. A
   * classifier that returned `false` for everything would satisfy an empty
   * KNOWN_ESCAPING forever and report the workspace as installable while it was
   * not. These cases keep it honest independently of the repo's state.
   */
  const P = `${sep}pkg`
  const FILE = join(P, 'src', 'a.ts')

  it('accepts specifiers that stay inside the package', () => {
    expect(escapesPackage(P, FILE, './b')).toBe(false)
    expect(escapesPackage(P, FILE, './nested/b')).toBe(false)
    expect(escapesPackage(P, FILE, '../lib/b')).toBe(false)
    expect(escapesPackage(P, join(P, 'src', 'deep', 'a.ts'), '../../b')).toBe(false)
  })

  it('rejects a specifier that resolves into a sibling package', () => {
    expect(escapesPackage(P, FILE, '../../other/src/index')).toBe(true)
    expect(escapesPackage(P, FILE, '../../../elsewhere')).toBe(true)
  })

  it('rejects an absolute specifier', () => {
    /* Absolute paths are checkout-specific in the same way and worse. */
    expect(escapesPackage(P, FILE, '/somewhere/else')).toBe(true)
  })

  it('is not fooled by a sibling whose name starts with this package name', () => {
    /* `/pkg` vs `/pkg-extra`: a prefix match without a separator says "inside". */
    expect(escapesPackage(P, FILE, '../../pkg-extra/src/index')).toBe(true)
  })

  it('leaves bare specifiers to the manifest check', () => {
    expect(escapesPackage(P, FILE, 'groq-js')).toBe(false)
    expect(escapesPackage(P, FILE, '@sanity/client')).toBe(false)
    expect(escapesPackage(P, FILE, 'node:fs')).toBe(false)
  })
})

describe('the shipped surface of a package is what gets scanned', () => {
  it('reads the roots a manifest actually publishes', () => {
    const cli = ALL.find((p) => p.dir === 'sanity-overlay-cli')!
    const query = ALL.find((p) => p.dir === 'sanity-overlay-query')!
    expect(shippedRoots(cli)).toEqual(['bin', 'src'])
    expect(shippedRoots(query)).toEqual(['parity', 'src'])
  })

  it('every package ships at least one directory, and it exists', () => {
    /*
     * Same failure mode `typecheckRoots` guards against: a manifest edit that
     * left `shippedRoots` empty would drop the package out of the scan below
     * with nothing going red — a silent under-report, which is the direction
     * this whole file treats as dangerous.
     */
    for (const pkg of ALL) {
      const roots = shippedRoots(pkg)
      expect(roots.length, `${pkg.dir}: ships nothing`).toBeGreaterThan(0)
      for (const root of roots) {
        expect(existsSync(join(pkg.path, root)), `${pkg.dir}: ${root}`).toBe(true)
      }
    }
  })
})

describe('no package imports its way out of its own directory', () => {
  /*
   * PINNED BLOCKED WORK, not an allowlist.
   *
   * Every entry here is a real defect: the importing package cannot be
   * installed while the entry stands. They are pinned rather than merely
   * skipped so that the count is visible, the work is enumerated, and the two
   * directions both fail — a NEW escaping import is red because it is not
   * listed, and a FIXED one is red because it still is.
   *
   * Clearing an entry means declaring the target as a workspace dependency
   * (`"sanity-overlay-core": "workspace:*"`) and importing it by package name.
   * That REQUIRES `pnpm install` at the repo root first: pnpm's isolated linker
   * creates `packages/<pkg>/node_modules/<dep>` only for dependencies a manifest
   * declares, and none are declared today, so a package-name import resolves to
   * `Cannot find package` until the install has run. Verified 2026-08-06 by
   * converting one import and watching it fail, then pass with the link in
   * place.
   *
   * Several targets are DEEP paths (`sanity-overlay-core/src/store/contract`,
   * `sanity-overlay-query/src/planner`). Those need a subpath `exports` entry
   * on the target package as well, or the import must move to the barrel.
   */
  const KNOWN_ESCAPING: Record<string, string[]> = {
    'sanity-overlay-cli': [
      'packages/sanity-overlay-cli/src/commands/cleanup.ts -> ../../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-cli/src/commands/codemod.ts -> ../../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-cli/src/commands/conflicts.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/diff.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/history.ts -> ../../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-cli/src/commands/inspect.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/lint.ts -> ../../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-cli/src/commands/normalize.ts -> ../../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-cli/src/commands/query.ts -> ../../../sanity-overlay-client/src/index',
      'packages/sanity-overlay-cli/src/commands/query.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/query.ts -> ../../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-cli/src/commands/rebase.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/reset.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/status.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/validate.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/commands/validate.ts -> ../../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-cli/src/diff.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/overlay.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/overlay.ts -> ../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-cli/src/records.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-cli/src/render.ts -> ../../sanity-overlay-core/src/index',
    ],
    'sanity-overlay-client': [
      'packages/sanity-overlay-client/src/assets.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-client/src/base.ts -> ../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-client/src/client.ts -> ../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-client/src/dev/seedOverlay.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-client/src/dev/seedOverlay.ts -> ../../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-client/src/env.ts -> ../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-client/src/fsLoader.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-client/src/fsLoader.ts -> ../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-client/src/overlaySource.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-client/src/overlaySource.ts -> ../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-client/src/types.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-client/src/types.ts -> ../../sanity-overlay-query/src/index',
    ],
    'sanity-overlay-core': [],
    'sanity-overlay-next': [
      'packages/sanity-overlay-next/src/api.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-next/src/api.ts -> ../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-next/src/api.ts -> ../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-next/src/queries.ts -> ../../sanity-overlay-query/src/index',
      'packages/sanity-overlay-next/src/rebase.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-next/src/server.ts -> ../../sanity-overlay-store-fs/src/index',
      'packages/sanity-overlay-next/src/translate.ts -> ../../sanity-overlay-core/src/index',
    ],
    'sanity-overlay-query': [
      'packages/sanity-overlay-query/src/registry.ts -> ../../sanity-overlay-core/src/checksum',
    ],
    'sanity-overlay-store-fs': [
      'packages/sanity-overlay-store-fs/src/assetStore.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-store-fs/src/checkpointIo.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-store-fs/src/contract.ts -> ../../sanity-overlay-core/src/store/contract',
      'packages/sanity-overlay-store-fs/src/errors.ts -> ../../sanity-overlay-core/src/store/errors',
      'packages/sanity-overlay-store-fs/src/fsStore.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-store-fs/src/intent.ts -> ../../sanity-overlay-core/src/store/intent',
      'packages/sanity-overlay-store-fs/src/layout.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-store-fs/src/watch.ts -> ../../sanity-overlay-core/src/index',
    ],
    'sanity-overlay-studio': [
      'packages/sanity-overlay-studio/src/client/facade.ts -> ../../../sanity-overlay-client/src/stagingHost',
      'packages/sanity-overlay-studio/src/client/incomingReferences.ts -> ../../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-studio/src/client/incomingReferences.ts -> ../../../sanity-overlay-query/src/baseSource',
      'packages/sanity-overlay-studio/src/client/incomingReferences.ts -> ../../../sanity-overlay-query/src/overlaySource',
      'packages/sanity-overlay-studio/src/client/incomingReferences.ts -> ../../../sanity-overlay-query/src/planner',
      'packages/sanity-overlay-studio/src/client/incomingReferences.ts -> ../../../sanity-overlay-query/src/registry',
      'packages/sanity-overlay-studio/src/client/incomingReferences.ts -> ../../../sanity-overlay-query/src/types',
      'packages/sanity-overlay-studio/src/client/perspective.ts -> ../../../sanity-overlay-query/src/baseSource',
      'packages/sanity-overlay-studio/src/client/perspective.ts -> ../../../sanity-overlay-query/src/overlaySource',
      'packages/sanity-overlay-studio/src/client/perspective.ts -> ../../../sanity-overlay-query/src/types',
      'packages/sanity-overlay-studio/src/client/readPlan.ts -> ../../../sanity-overlay-query/src/baseSource',
      'packages/sanity-overlay-studio/src/client/readPlan.ts -> ../../../sanity-overlay-query/src/evaluate',
      'packages/sanity-overlay-studio/src/client/readPlan.ts -> ../../../sanity-overlay-query/src/overlaySource',
      'packages/sanity-overlay-studio/src/client/readPlan.ts -> ../../../sanity-overlay-query/src/planner',
      'packages/sanity-overlay-studio/src/client/readPlan.ts -> ../../../sanity-overlay-query/src/registry',
      'packages/sanity-overlay-studio/src/client/readPlan.ts -> ../../../sanity-overlay-query/src/types',
      'packages/sanity-overlay-studio/src/client/readSource.ts -> ../../../sanity-overlay-query/src/baseSource',
      'packages/sanity-overlay-studio/src/client/readSource.ts -> ../../../sanity-overlay-query/src/overlaySource',
      'packages/sanity-overlay-studio/src/client/readSource.ts -> ../../../sanity-overlay-query/src/types',
      'packages/sanity-overlay-studio/src/client/reads.ts -> ../../../sanity-overlay-query/src/baseSource',
      'packages/sanity-overlay-studio/src/client/reads.ts -> ../../../sanity-overlay-query/src/overlaySource',
      'packages/sanity-overlay-studio/src/client/reads.ts -> ../../../sanity-overlay-query/src/types',
      'packages/sanity-overlay-studio/src/client/transport.ts -> ../../../sanity-overlay-client/src/stagingHost',
      'packages/sanity-overlay-studio/src/conflictPanel.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-studio/src/conflicts.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-studio/src/documentActions.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-studio/src/operations.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-studio/src/options.ts -> ../../sanity-overlay-client/src/env',
      'packages/sanity-overlay-studio/src/options.ts -> ../../sanity-overlay-client/src/stagingHost',
      'packages/sanity-overlay-studio/src/ui/conflictPanel.ts -> ../../../sanity-overlay-core/src/index',
    ],
    'sanity-overlay-testkit': [
      'packages/sanity-overlay-testkit/src/mergeFixtures.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-testkit/src/referenceFixtures.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-testkit/src/referenceFixtures.ts -> ../../sanity-overlay-core/src/references/index',
      'packages/sanity-overlay-testkit/src/referenceFixtures.ts -> ../../sanity-overlay-core/src/validation/index',
      'packages/sanity-overlay-testkit/src/storeContract.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-testkit/src/validationFixtures.ts -> ../../sanity-overlay-core/src/index',
      'packages/sanity-overlay-testkit/src/validationFixtures.ts -> ../../sanity-overlay-core/src/validation/index',
    ],
  }

  it('KNOWN_ESCAPING names every package, so a new one cannot be added unnoticed', () => {
    expect(Object.keys(KNOWN_ESCAPING).sort()).toEqual(ALL.map((p) => p.dir).sort())
  })

  it.each(ALL.map((p) => [p.dir, p] as const))(
    '%s: only the escaping imports known today are present',
    (dir, pkg) => {
      expect(escapingImports(pkg)).toEqual([...KNOWN_ESCAPING[dir]].sort())
    },
  )

  it('the workspace still cannot be installed, and the ledger says by how much', () => {
    /*
     * The headline `[M-LOCAL]` blocker as a single number, so progress is
     * legible and completion is unambiguous: this reaches 0 when every package
     * resolves its siblings by name. It is derived from the scan, not from the
     * pinned list, so it cannot drift from reality.
     */
    expect(ALL.flatMap((pkg) => escapingImports(pkg)).length).toBe(85)
  })
})

describe('every package declares the types for the builtins it uses', () => {
  /*
   * `node:fs` resolves at runtime with no manifest entry at all, so the check
   * above cannot see it — but `tsc` needs `@types/node` in the package's own
   * reachable node_modules, and without it the package cannot be typechecked in
   * isolation. That is not cosmetic: .github/workflows/ci.yml runs
   * `tsc --noEmit -p <package>` per package, and a package missing this entry
   * cannot be in that gate at all.
   *
   * The claim is about the TYPECHECK, so the scan is scoped to the files the
   * typecheck reads — `isTypechecked`. `sanity-overlay-query` is why: its only
   * `node:` import is in `lint/check-queries.mjs`, a Node script that is both
   * JavaScript and outside the tsconfig `include` roots. tsc never opens it,
   * `tsc --noEmit -p ../sanity-overlay-query` is clean today with no
   * `@types/node` anywhere, and flagging it demanded an install that would
   * change nothing. That was a false positive in this check, not a defect in
   * the package.
   *
   * KNOWN_MISSING is pinned rather than merely skipped, so it is self-cleaning
   * in BOTH directions: adding a new offender turns this red, and FIXING an
   * entry also turns it red, demanding the entry be deleted. It is not an
   * allowlist that can quietly rot.
   *
   * `sanity-overlay-client` IS a real entry: `src/fsLoader.ts` is TypeScript
   * inside `include`, it imports `node:fs` and `node:path`, and the package
   * reports 21 errors today for that reason alone (verified: with
   * `@types/node` reachable it is clean, 0 errors). It is excluded from the
   * typecheck gate in .github/workflows/ci.yml until this is run:
   *
   *   pnpm --filter sanity-overlay-client add -D -E "@types/node@^22.20.1"
   *
   * then delete 'sanity-overlay-client' from KNOWN_MISSING and commit the
   * updated pnpm-lock.yaml.
   */
  const KNOWN_MISSING = ['sanity-overlay-client']

  it('only the packages known to be missing @types/node are missing it', () => {
    const missing = ALL.filter((pkg) =>
      importsOf(pkg).some((i) => i.builtin && isTypechecked(pkg, i.file)),
    )
      .filter((pkg) => !declaredNames(pkg.manifest).has('@types/node'))
      .map((pkg) => pkg.dir)

    expect(missing.sort()).toEqual([...KNOWN_MISSING].sort())
  })
})

describe('the typecheck gate covers every package it can', () => {
  /*
   * `.github/workflows/ci.yml` runs `tsc --noEmit -p <project>` for a HAND
   * WRITTEN list of packages, because four of the eight are held out today.
   * A hand-written list rots in silence: a package gets fixed, or a new package
   * is added, and it simply never enters the gate. Nothing fails, so nobody
   * looks.
   *
   * So the list is pinned here in the same self-cleaning shape as KNOWN_MISSING
   * above. Every package must be either gated or explicitly excluded, and
   * moving one between the two turns this red until BOTH files agree.
   *
   * Each exclusion, with what clears it (the workflow carries the long form).
   * Counts are re-measured with `tsc --noEmit -p <package>`; they are comments,
   * so nothing turns red when they drift -- re-measure before trusting one.
   *
   *   sanity-overlay-client   21 errors, all missing @types/node (TS2307 on
   *                           node:*, TS2580 process/Buffer, TS2503 NodeJS, and
   *                           the `unref` on a DOM `number` timer handle that
   *                           follows from the same missing lib).
   *                           pnpm --filter sanity-overlay-client add -D -E "@types/node@^22.20.1"
   *   sanity-overlay-cli       0 errors. The remedy has already been applied:
   *                           @types/node is declared AND now present in
   *                           pnpm-lock.yaml. This exclusion is stale and the
   *                           package is ready to move into the gate; doing so
   *                           is a .github/workflows/ci.yml change, so both
   *                           files must move together to keep the assertion
   *                           below green.
   *   sanity-overlay-studio    0 errors. Same story: groq-js is declared and in
   *                           pnpm-lock.yaml, so the undeclared-import error is
   *                           gone. Stale exclusion, same paired move.
   *   sanity-overlay-testkit  39 errors, none in its own harness -- assets,
   *                           studio-observable, write-guard, client-revalidate,
   *                           proxy-tls, core-boundaries, and the untyped .mjs
   *                           imports from examples/kitchen-sink.
   */
  const EXCLUDED = [
    'sanity-overlay-cli',
    'sanity-overlay-client',
    'sanity-overlay-studio',
    'sanity-overlay-testkit',
  ]

  /*
   * Anchored at `run:` so a COMMENTED step cannot count. The previous version
   * of this job sat commented out in that file for exactly the reasons listed
   * above; a check that read those lines would have declared a gate that never
   * executed.
   */
  const gatedPackages = (): string[] => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
    return [...workflow.matchAll(/^ *run: .*tsc --noEmit -p \.\.\/(\S+)\s*$/gm)].map((m) => m[1])
  }

  it('runs tsc on at least one project', () => {
    /* The whole point. An empty gate passes every other assertion here. */
    expect(gatedPackages().length).toBeGreaterThan(0)
  })

  it('gates or explicitly excludes every package', () => {
    const gated = gatedPackages()
    expect([...gated].sort()).toEqual([...new Set(gated)].sort())
    expect([...gated, ...EXCLUDED].sort()).toEqual(ALL.map((p) => p.dir).sort())
  })
})

describe('every package manifest points at files that exist', () => {
  it.each(ALL.map((p) => [p.dir, p] as const))('%s: exports resolve', (_dir, pkg) => {
    const entries = Object.values(pkg.manifest.exports ?? {})
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(existsSync(join(pkg.path, entry)), `${pkg.dir}: exports -> ${entry}`).toBe(true)
    }
  })

  it.each(ALL.map((p) => [p.dir, p] as const))('%s: bin and files resolve', (_dir, pkg) => {
    for (const entry of Object.values(pkg.manifest.bin ?? {})) {
      expect(existsSync(join(pkg.path, entry)), `${pkg.dir}: bin -> ${entry}`).toBe(true)
    }
    for (const entry of pkg.manifest.files ?? []) {
      expect(existsSync(join(pkg.path, entry)), `${pkg.dir}: files -> ${entry}`).toBe(true)
    }
  })

  it.each(ALL.map((p) => [p.dir, p] as const))('%s: is ESM', (_dir, pkg) => {
    /* Everything here is loaded as ESM (relative source imports, top-level
     * await in bin/sanity-overlay.mjs). A package that forgets `type: module`
     * gets its .ts/.js read as CommonJS by the consumer's loader. */
    expect(pkg.manifest.type).toBe('module')
  })

  it('the directory name matches the package name', () => {
    /* Cross-package imports are relative paths built from directory names, and
     * `pnpm --filter <name>` addresses the manifest name. When the two drift,
     * one of the two stops working with no error at the point of the mistake. */
    expect(ALL.map((p) => [p.dir, p.manifest.name])).toEqual(ALL.map((p) => [p.dir, p.dir]))
  })
})

describe('the lockfile covers every workspace package', () => {
  /*
   * `pnpm install --frozen-lockfile` — what .github/workflows/ci.yml runs
   * before anything else — refuses to run when a workspace manifest is absent
   * from the lockfile's `importers` section, or lists a dependency the lockfile
   * does not record. A package added without re-running `pnpm install` is
   * therefore not a slow-burn problem: it takes the ENTIRE CI workflow down,
   * test job included, before a single test executes.
   *
   * Same pinned-list discipline as above: fixing an entry turns this red and
   * demands its removal.
   *
   * CLEARED 2026-08-05. `packages/sanity-overlay-cli` and
   * `packages/sanity-overlay-studio` were both absent until `pnpm install` was
   * run at the repo root and the updated pnpm-lock.yaml committed. Every
   * workspace package is now recorded, so the list is empty — and an empty list
   * is the point: adding a package without re-running the install turns this red
   * rather than taking CI down at the install step.
   */
  const KNOWN_UNLOCKED: string[] = []

  it('only the packages known to be absent from pnpm-lock.yaml are absent', () => {
    const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')
    /* `importers:` is a top-level block; its keys are indented two spaces and
     * the block ends at the next top-level key (`packages:`). Read only that
     * span so a path appearing elsewhere in the file cannot count. */
    const importersBlock = lock.slice(
      lock.indexOf('\nimporters:\n'),
      lock.indexOf('\npackages:\n'),
    )
    const recorded = new Set(
      [...importersBlock.matchAll(/^ {2}(\S+?):/gm)].map((m) => m[1]),
    )

    const absent = ALL.map((p) => `packages/${p.dir}`).filter((id) => !recorded.has(id))
    expect(absent.sort()).toEqual([...KNOWN_UNLOCKED].sort())
  })
})
