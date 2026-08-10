#!/usr/bin/env node
/**
 * Build one workspace package into `dist/`, so it can be installed from a
 * tarball by someone who does not have this repository.
 *
 * ## Why a build exists at all
 *
 * Until now every package's `exports` pointed at `./src/index.ts`. Inside this
 * workspace that works, because every launcher registers a `.ts` resolve hook
 * and vitest transforms TypeScript on the way in. Outside it, it does not work
 * at any level: Node refuses to strip types for anything under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and a bundler would have to
 * be told, per consumer, to transpile a dependency. `dist/` removes the
 * question — what ships is JavaScript and `.d.ts`.
 *
 * ## Why `tsc` and not a bundler
 *
 * These packages have subpath entry points (`sanity-overlay-query/planner`,
 * `sanity-overlay-client/stagingHost`, and six more). A bundler with one
 * bundle per entry point would give each of them its OWN copy of every shared
 * module, and with it a second copy of that module's state — two query
 * registries, two write-guard policies — which is precisely the class of
 * defect this codebase keeps finding. `tsc` emits one output file per input
 * file, so a module is a module no matter which entry point reaches it.
 *
 * ## The two things tsc will not do on its own
 *
 * 1. ROOT DIRECTORY. A package's sources import its siblings by package name;
 *    tsc resolves those through the pnpm links to `packages/<sibling>/src`,
 *    which puts them in the program. With `rootDir` set to the package, tsc
 *    refuses ("is not under rootDir"). So `rootDir` is `packages/`, everything
 *    lands under `dist/.tsc/<package>/`, and only this package's subtree is
 *    lifted into `dist/`. The siblings' output is discarded — each package
 *    emits its own when it is packed.
 *
 * 2. EXTENSIONS. The sources are written for `moduleResolution: bundler`, so a
 *    relative import has no extension. Node's ESM loader requires one. Every
 *    relative specifier in the emitted `.js` and `.d.ts` is therefore resolved
 *    against what was actually emitted and rewritten to `./x.js` or
 *    `./x/index.js`. Resolved, not guessed: a specifier that matches neither is
 *    a hard error rather than a broken tarball.
 */

import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

const pkgDir = resolve(process.argv[2] ?? process.cwd())
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const pkgName = basename(pkgDir)

const distDir = join(pkgDir, 'dist')
const stagingDir = join(distDir, '.tsc')

/* ------------------------------------------------------------------ *
 * 1. compile
 * ------------------------------------------------------------------ */

rmSync(distDir, {recursive: true, force: true})
mkdirSync(stagingDir, {recursive: true})

/**
 * The directories this package publishes, as top-level names under its root.
 * Derived from `exports` rather than hardcoded to `src`, because
 * `sanity-overlay-query` also ships `parity/`.
 */
const sourceRoots = [
  ...new Set(
    Object.values(manifest.exports ?? {})
      .map((entry) => String(entry).replace(/^\.\//, '').split('/')[0])
      .filter((root) => root !== '' && existsSync(join(pkgDir, root))),
  ),
]
if (sourceRoots.length === 0) {
  throw new Error(`${pkgName}: exports names no directory to build`)
}

/*
 * Extend the package's OWN tsconfig, not the workspace base.
 *
 * `.github/workflows/ci.yml` gates each package with `tsc --noEmit -p <pkg>`,
 * so that file is the definition of "this package typechecks". Building against
 * a different set of options would mean the declarations shipped to consumers
 * were produced under rules nobody checks — `sanity-overlay-studio` is the
 * proof: its tsconfig carries the `paths` that make `react` resolve, and
 * without them the build emitted `any` where a React type belonged while the
 * gate stayed green.
 */
const packageTsconfig = join(pkgDir, 'tsconfig.json')
const tsconfig = {
  extends: existsSync(packageTsconfig) ? packageTsconfig : join(REPO_ROOT, 'tsconfig.base.json'),
  compilerOptions: {
    declaration: true,
    declarationMap: false,
    sourceMap: true,
    /* `packages/`, so a sibling pulled in by a package-name import is inside
     * the root rather than an error. See the header. */
    rootDir: PACKAGES_DIR,
    outDir: stagingDir,
    noEmitOnError: false,
    skipLibCheck: true,
  },
  include: sourceRoots.map((root) => join(pkgDir, root, '**', '*.ts')),
}
const tsconfigPath = join(stagingDir, 'tsconfig.json')
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2))

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
let typeErrors = ''
try {
  execFileSync(process.execPath, [tsc, '-p', tsconfigPath], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  /*
   * Emit is NOT gated on a clean typecheck, deliberately. `noEmitOnError` is
   * false and the errors are reported here instead, because the typecheck gate
   * for this repository is `.github/workflows/ci.yml`, which holds two packages
   * out for reasons recorded in test/repo-manifests.test.ts. Making `pnpm pack`
   * the second, stricter gate would mean a package that CI is happy with cannot
   * be released, with the failure surfacing at the worst possible moment.
   */
  typeErrors = String(error.stdout ?? '') + String(error.stderr ?? '')
}

/* ------------------------------------------------------------------ *
 * 2. lift this package's own output out of the staging tree
 * ------------------------------------------------------------------ */

const emitted = join(stagingDir, pkgName)
if (!existsSync(emitted)) {
  throw new Error(
    `${pkgName}: tsc emitted nothing at ${emitted}\n${typeErrors || '(no compiler output)'}`,
  )
}
for (const root of readdirSync(emitted)) {
  cpSync(join(emitted, root), join(distDir, root), {recursive: true})
}
rmSync(stagingDir, {recursive: true, force: true})

/* ------------------------------------------------------------------ *
 * 3. give every relative specifier an extension Node can resolve
 * ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** `from '…'`, `import '…'`, `import('…')` — specifier positions only. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*|\bimport\(\s*)(['"])(\.[^'"]*)\2/g

let rewritten = 0
const unresolved = []
for (const file of walk(distDir)) {
  const isJs = file.endsWith('.js')
  const isDts = file.endsWith('.d.ts')
  if (!isJs && !isDts) continue

  const source = readFileSync(file, 'utf8')
  const next = source.replace(SPECIFIER, (whole, lead, quote, specifier) => {
    if (/\.(js|mjs|cjs|json)$/.test(specifier)) return whole
    const from = dirname(file)
    /* A `.d.ts` names the JS file; TypeScript maps `./x.js` back to `./x.d.ts`
     * itself, so both output kinds are probed against the emitted JavaScript. */
    if (existsSync(resolve(from, `${specifier}.js`))) {
      rewritten += 1
      return `${lead}${quote}${specifier}.js${quote}`
    }
    if (existsSync(resolve(from, specifier, 'index.js'))) {
      rewritten += 1
      return `${lead}${quote}${specifier}/index.js${quote}`
    }
    unresolved.push(`${file.slice(pkgDir.length + 1)} -> ${specifier}`)
    return whole
  })
  if (next !== source) writeFileSync(file, next)
}

if (unresolved.length > 0) {
  throw new Error(
    `${pkgName}: ${unresolved.length} relative specifier(s) in dist/ point at nothing that was ` +
      `emitted. The tarball would be broken on install:\n  ${unresolved.join('\n  ')}`,
  )
}

/* ------------------------------------------------------------------ *
 * 4. every publishConfig entry point must exist
 * ------------------------------------------------------------------ */

const published = manifest.publishConfig?.exports ?? {}
const missing = []
for (const [subpath, entry] of Object.entries(published)) {
  for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
    if (!existsSync(join(pkgDir, target))) missing.push(`${subpath} -> ${target}`)
  }
}
if (missing.length > 0) {
  throw new Error(
    `${pkgName}: publishConfig.exports points at files the build did not produce:\n  ` +
      missing.join('\n  '),
  )
}

const files = walk(distDir).length
console.log(
  `${pkgName}: built ${files} file(s) into dist/, rewrote ${rewritten} relative specifier(s)` +
    (typeErrors ? `\n${pkgName}: typecheck reported errors (emit continued):\n${typeErrors}` : ''),
)
