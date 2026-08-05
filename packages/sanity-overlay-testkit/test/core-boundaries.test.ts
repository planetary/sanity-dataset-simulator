/**
 * Dependency-boundary lint for `sanity-overlay-core` — plan §3 "Constraints that
 * are testable in CI from day one" and plan §10 "Dependency-boundary lint proves
 * core has no Next.js or Vercel dependency (PRD §10.1) and — plan-level guidance
 * — no `node:fs`, `@vercel/blob` or `@sanity/client` runtime import (type-only
 * Sanity document types excepted)".
 *
 * This is a *lint expressed as a test*, not a smoke check: every `.ts` file under
 * `packages/sanity-overlay-core/src` is parsed with the TypeScript compiler API
 * (already a devDependency of this package — no install), and the resulting AST
 * is inspected for
 *
 * 1. forbidden **runtime** module specifiers (`import type` is exempt, because
 *    plan §3 explicitly permits type-only imports of Sanity document types),
 * 2. imports that leave the core package at all — the guard that keeps the store
 *    contract in core instead of core reaching back into `sanity-overlay-store-fs`,
 * 3. browser-only and Node-only globals in shared paths (plan §3 "Core is
 *    Node-safe and browser-safe").
 *
 * An AST is used rather than a regex because core legitimately contains the
 * *word* `document` hundreds of times — as a parameter name, a property name and
 * in prose — and a regex cannot tell those from the browser global.
 *
 * Analyzer self-tests at the bottom pin the classifier's behaviour on synthetic
 * sources, so the "type-only Sanity import is permitted" and "runtime Sanity
 * import is not" rules are executable even while core imports neither.
 */
import {readFileSync, readdirSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_PACKAGE = resolve(HERE, '..', '..', 'sanity-overlay-core')
const CORE_SRC = join(CORE_PACKAGE, 'src')

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/**
 * PRD §10.1 `[MUST]` plus the plan §3 plan-level additions. Matched against the
 * module specifier itself and against its leading path segment, so `next/server`
 * and `@vercel/blob/client` are caught by `next` and `@vercel/blob`.
 */
const FORBIDDEN_RUNTIME_MODULES = [
  /* PRD §10.1 MUST — no Next.js, no Vercel. */
  'next',
  'vercel',
  '@vercel/blob',
  '@vercel/kv',
  '@vercel/functions',
  /* Plan §3 — store access is through the adapter contract only. */
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  /* Plan §3 — type-only Sanity document types are permitted; the client is not. */
  '@sanity/client',
  'sanity',
  '@sanity/types',
]

/** Node builtins are browser-unsafe, and plan §3 requires core to be browser-safe. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

/** Plan §3 "no browser globals". */
const BROWSER_ONLY_GLOBALS = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'alert',
  'XMLHttpRequest',
  'indexedDB',
  'HTMLElement',
  'requestAnimationFrame',
])

/** Plan §3 "no Node-only globals in shared paths". */
const NODE_ONLY_GLOBALS = new Set([
  'process',
  'Buffer',
  '__dirname',
  '__filename',
  'require',
  'global',
  'setImmediate',
  'NodeJS',
])

/* ------------------------------------------------------------------ *
 * Analyzer
 * ------------------------------------------------------------------ */

export interface ModuleReference {
  specifier: string
  /** `false` for `import type` / `export type` and for individually type-only specifiers. */
  runtime: boolean
  line: number
}

export interface GlobalReference {
  name: string
  line: number
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/**
 * Every module specifier a source file references, tagged runtime vs type-only.
 *
 * A whole-clause `import type {X} from 'm'` is type-only. So is
 * `import {type X} from 'm'` when *every* named binding is individually
 * type-only — that form emits no runtime import under `importsNotUsedAsValues`
 * defaults. A bare `import 'm'` has no clause at all and is always runtime.
 */
export function moduleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      let runtime = true
      if (clause !== undefined) {
        if (clause.isTypeOnly) {
          runtime = false
        } else if (
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        ) {
          runtime = false
        }
      }
      references.push({specifier: node.moduleSpecifier.text, runtime, line: lineOf(sourceFile, node)})
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push({
        specifier: node.moduleSpecifier.text,
        runtime: !node.isTypeOnly,
        line: lineOf(sourceFile, node),
      })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      references.push({
        specifier: node.moduleReference.expression.text,
        runtime: !node.isTypeOnly,
        line: lineOf(sourceFile, node),
      })
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const first = node.arguments[0]
      if ((isRequire || isDynamicImport) && first !== undefined && ts.isStringLiteral(first)) {
        references.push({specifier: first.text, runtime: true, line: lineOf(sourceFile, node)})
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

/** Names the file declares itself — parameters, locals, imports, types, classes. */
function declaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const add = (name: ts.Node | undefined): void => {
    if (name === undefined) return
    if (ts.isIdentifier(name)) {
      names.add(name.text)
      return
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) add(element.name)
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node)
    ) {
      add((node as {name?: ts.Node}).name)
    }
    if (ts.isCatchClause(node)) add(node.variableDeclaration?.name)
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return names
}

/** True when the identifier sits inside a type annotation, type alias or interface. */
function inTypePosition(node: ts.Identifier): boolean {
  let cursor: ts.Node | undefined = node.parent
  while (cursor !== undefined) {
    if (
      ts.isTypeNode(cursor) ||
      ts.isTypeAliasDeclaration(cursor) ||
      ts.isInterfaceDeclaration(cursor) ||
      ts.isTypeParameterDeclaration(cursor)
    ) {
      return true
    }
    if (ts.isSourceFile(cursor) || ts.isBlock(cursor)) return false
    cursor = cursor.parent
  }
  return false
}

/** True when the identifier is a *name being declared* or a member name, not a reference. */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node & {name?: ts.Node; right?: ts.Node; label?: ts.Node}
  if (parent === undefined) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isQualifiedName(parent) && parent.right === node) return true
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) {
    return true
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMetaProperty(parent)) return true
  return parent.name === node
}

/**
 * Globals a file reads without declaring them.
 *
 * Scope resolution is file-level rather than lexical: a name the file declares
 * anywhere is never reported. That under-reports the pathological case of a file
 * that shadows `process` in one function and reads the real global in another,
 * and in exchange it never misfires on core's many `document: SanityDocument`
 * parameters — the trade the plan §3 rule actually needs.
 */
export function freeGlobalReferences(
  sourceFile: ts.SourceFile,
  forbidden: ReadonlySet<string>,
): GlobalReference[] {
  const declared = declaredNames(sourceFile)
  const found: GlobalReference[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      if (!declared.has(node.text) && !isNamePosition(node) && !inTypePosition(node)) {
        found.push({name: node.text, line: lineOf(sourceFile, node)})
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

export function parseSource(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** Is `specifier` the forbidden module `forbidden`, or a subpath of it? */
function matchesModule(specifier: string, forbidden: string): boolean {
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`)
}

function isBareModule(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/')
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  const head = specifier.split('/')[0] ?? specifier
  return NODE_BUILTINS.has(head)
}

/* ------------------------------------------------------------------ *
 * Corpus
 * ------------------------------------------------------------------ */

function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...collectTypeScriptFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full)
    }
  }
  return files.sort()
}

/**
 * Per-test timeout for the corpus scans (ms).
 *
 * Each scanning test walks the TypeScript AST of every file under `core/src` —
 * roughly 1.0-1.6 s of CPU per test when the file runs alone. Vitest's default
 * `testTimeout` is 5 s, and under a full-suite run the whole repository's test
 * files share the same worker pool, so these five tests are the ones that lose
 * the race and time out. Nothing here waits on I/O or on another process: the
 * only failure mode a longer budget hides is "the machine was busy", which is
 * not a boundary violation. The assertions themselves are unchanged.
 */
const SCAN_TIMEOUT_MS = 60_000

interface CoreFile {
  path: string
  ref: string
  source: ts.SourceFile
}

function loadCoreFiles(): CoreFile[] {
  return collectTypeScriptFiles(CORE_SRC).map((path) => {
    const text = readFileSync(path, 'utf8')
    return {path, ref: relative(CORE_PACKAGE, path), source: parseSource(path, text)}
  })
}

/* ------------------------------------------------------------------ *
 * The lint
 * ------------------------------------------------------------------ */

describe('dependency boundary — sanity-overlay-core (plan §3, §10; PRD §10.1)', () => {
  const coreFiles = loadCoreFiles()

  it('scans a non-empty corpus of core source files', () => {
    /* A lint that silently scans nothing always passes. */
    expect(coreFiles.length).toBeGreaterThan(20)
    expect(coreFiles.some((file) => file.ref.endsWith('index.ts'))).toBe(true)
  }, SCAN_TIMEOUT_MS)

  it('has no Next.js, Vercel, node:fs, @vercel/blob or @sanity/client runtime import', () => {
    const violations: string[] = []

    for (const file of coreFiles) {
      for (const reference of moduleReferences(file.source)) {
        if (!reference.runtime) continue
        for (const forbidden of FORBIDDEN_RUNTIME_MODULES) {
          if (matchesModule(reference.specifier, forbidden)) {
            violations.push(
              `${file.ref}:${reference.line} runtime-imports ${JSON.stringify(reference.specifier)} (forbidden: ${forbidden})`,
            )
          }
        }
      }
    }

    expect(violations).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('imports no Node builtin at runtime, so core stays browser-safe', () => {
    const violations: string[] = []

    for (const file of coreFiles) {
      for (const reference of moduleReferences(file.source)) {
        if (!reference.runtime) continue
        if (isNodeBuiltin(reference.specifier)) {
          violations.push(`${file.ref}:${reference.line} imports Node builtin ${reference.specifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('imports nothing from outside the core package (no dependency inversion)', () => {
    /* The rule that keeps the §35.7 store contract *in* core: a core-resident
     * adapter must never reach back into `sanity-overlay-store-fs`. */
    const violations: string[] = []

    for (const file of coreFiles) {
      for (const reference of moduleReferences(file.source)) {
        if (isBareModule(reference.specifier)) continue
        const target = resolve(dirname(file.path), reference.specifier)
        if (!target.startsWith(CORE_SRC)) {
          violations.push(
            `${file.ref}:${reference.line} imports ${JSON.stringify(reference.specifier)}, which resolves outside ${relative(CORE_PACKAGE, CORE_SRC)}`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('declares no third-party dependency in its package manifest', () => {
    const manifest = JSON.parse(readFileSync(join(CORE_PACKAGE, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(manifest.dependencies ?? {}).toEqual({})
    expect(manifest.peerDependencies ?? {}).toEqual({})
  })

  it('uses no browser-only global', () => {
    const violations: string[] = []
    for (const file of coreFiles) {
      for (const reference of freeGlobalReferences(file.source, BROWSER_ONLY_GLOBALS)) {
        violations.push(`${file.ref}:${reference.line} reads browser global ${reference.name}`)
      }
    }
    expect(violations).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('uses no Node-only global', () => {
    const violations: string[] = []
    for (const file of coreFiles) {
      for (const reference of freeGlobalReferences(file.source, NODE_ONLY_GLOBALS)) {
        violations.push(`${file.ref}:${reference.line} reads Node global ${reference.name}`)
      }
    }
    expect(violations).toEqual([])
  }, SCAN_TIMEOUT_MS)
})

/* ------------------------------------------------------------------ *
 * Analyzer self-tests
 *
 * The lint above is only as trustworthy as its classifier, and two of its rules
 * (type-only Sanity imports permitted; `document` as a parameter is not the
 * browser global) can never be exercised by the real corpus — core must not
 * contain the violating forms. They are pinned here on synthetic sources.
 * ------------------------------------------------------------------ */

describe('boundary analyzer', () => {
  function analyze(text: string): ModuleReference[] {
    return moduleReferences(parseSource('synthetic.ts', text))
  }

  it('treats a whole-clause `import type` as non-runtime (plan §3 exemption)', () => {
    const [reference] = analyze(`import type {SanityDocument} from '@sanity/client'\n`)
    expect(reference).toEqual({specifier: '@sanity/client', runtime: false, line: 1})
  })

  it('treats an all-inline-type import as non-runtime', () => {
    const [reference] = analyze(`import {type SanityDocument} from '@sanity/client'\n`)
    expect(reference?.runtime).toBe(false)
  })

  it('treats a value import from the same module as runtime', () => {
    const [reference] = analyze(`import {createClient} from '@sanity/client'\n`)
    expect(reference).toEqual({specifier: '@sanity/client', runtime: true, line: 1})
  })

  it('treats a mixed value-and-type import as runtime', () => {
    const [reference] = analyze(
      `import {createClient, type SanityDocument} from '@sanity/client'\n`,
    )
    expect(reference?.runtime).toBe(true)
  })

  it('treats a bare side-effect import as runtime', () => {
    const [reference] = analyze(`import 'next/server'\n`)
    expect(reference).toEqual({specifier: 'next/server', runtime: true, line: 1})
  })

  it('catches dynamic import and require', () => {
    const references = analyze(
      `const a = await import('node:fs/promises')\nconst b = require('@vercel/blob')\n`,
    )
    expect(references.map((reference) => reference.specifier)).toEqual([
      'node:fs/promises',
      '@vercel/blob',
    ])
    expect(references.every((reference) => reference.runtime)).toBe(true)
  })

  it('catches a re-export of a forbidden module, and exempts `export type`', () => {
    expect(analyze(`export * from 'node:fs'\n`)[0]).toEqual({
      specifier: 'node:fs',
      runtime: true,
      line: 1,
    })
    expect(analyze(`export type {Stats} from 'node:fs'\n`)[0]?.runtime).toBe(false)
  })

  it('matches subpaths of a forbidden module', () => {
    expect(matchesModule('next/server', 'next')).toBe(true)
    expect(matchesModule('@vercel/blob/client', '@vercel/blob')).toBe(true)
    expect(matchesModule('nextauth', 'next')).toBe(false)
  })

  it('does not mistake a `document` parameter for the browser global', () => {
    const source = parseSource(
      'synthetic.ts',
      `export function read(document: {title?: string}): string | undefined {\n` +
        `  return document.title\n` +
        `}\n`,
    )
    expect(freeGlobalReferences(source, BROWSER_ONLY_GLOBALS)).toEqual([])
  })

  it('does not mistake a `document` property name for the browser global', () => {
    const source = parseSource(
      'synthetic.ts',
      `export const payload = {document: 1}\nexport const nested = payload.document\n`,
    )
    expect(freeGlobalReferences(source, BROWSER_ONLY_GLOBALS)).toEqual([])
  })

  it('does catch a real browser global read', () => {
    const source = parseSource('synthetic.ts', `export const w = window.innerWidth\n`)
    expect(freeGlobalReferences(source, BROWSER_ONLY_GLOBALS)).toEqual([{name: 'window', line: 1}])
  })

  it('does catch a real Node global read', () => {
    const source = parseSource('synthetic.ts', `export const mode = process.env.NODE_ENV\n`)
    expect(freeGlobalReferences(source, NODE_ONLY_GLOBALS)).toEqual([{name: 'process', line: 1}])
  })

  it('does not report a Node global used only as a type', () => {
    const source = parseSource(
      'synthetic.ts',
      `export function code(error: NodeJS.ErrnoException): string | undefined {\n` +
        `  return error.code\n` +
        `}\n`,
    )
    expect(freeGlobalReferences(source, NODE_ONLY_GLOBALS)).toEqual([])
  })
})
