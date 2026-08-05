/**
 * Dependency-boundary lint for `sanity-overlay-query`, expressed as a test.
 *
 * PRD §10.1 `[MUST]`: "Query package can run in Node.js without browser
 * globals." The query layer is the one package the PRD names Node-safety for
 * explicitly, because it runs inside a Next.js route handler as well as in the
 * Studio. This file holds it to BOTH halves — no browser-only globals so it
 * runs on a server, and no Node-only globals or Node builtins so it runs in a
 * browser — plus the §10.1 prohibitions core carries: no Next.js, no Vercel, no
 * filesystem, no hosted Sanity client.
 *
 * Every `.ts` file under the package is parsed with the TypeScript compiler API
 * and the AST is inspected. An AST rather than a regex because the package
 * legitimately contains the word `document` in prose, parameter names and
 * property names hundreds of times, and a regex cannot tell those from the
 * browser global.
 *
 * The classifier's own behaviour is pinned by self-tests on synthetic sources
 * at the bottom, so "a type-only import is permitted, a runtime import is not"
 * is executable even while the package imports neither.
 */
import {readFileSync, readdirSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUERY_PACKAGE = resolve(HERE, '..', '..', 'sanity-overlay-query')

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

const FORBIDDEN_RUNTIME_MODULES = [
  /* PRD §10.1 — no Next.js, no Vercel anywhere below the app layer. */
  'next',
  'vercel',
  '@vercel/blob',
  '@vercel/kv',
  '@vercel/functions',
  /* Storage reaches the query layer through its ports, never directly. */
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
  /* The hosted client is an adapter concern; type-only Sanity types are fine. */
  '@sanity/client',
  'sanity',
  '@sanity/types',
]

/** The only runtime dependency the package may take (PRD §5.5 pins it). */
const ALLOWED_EXTERNAL_MODULES = new Set(['groq-js'])

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

const BROWSER_ONLY_GLOBALS = new Set([
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'alert', 'XMLHttpRequest', 'indexedDB', 'HTMLElement', 'requestAnimationFrame',
])

const NODE_ONLY_GLOBALS = new Set([
  'process', 'Buffer', '__dirname', '__filename', 'require', 'global', 'setImmediate', 'NodeJS',
])

/* ------------------------------------------------------------------ *
 * Analyzer
 * ------------------------------------------------------------------ */

interface ModuleReference {
  specifier: string
  /** `false` for `import type` / `export type` and for type-only specifiers. */
  runtime: boolean
  line: number
}

interface GlobalReference {
  name: string
  line: number
}

const lineOf = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1

export function analyzeSource(text: string, fileName = 'input.ts') {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const modules: ModuleReference[] = []
  const globals: GlobalReference[] = []

  const declaredNames = new Set<string>()
  const collectDeclared = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declaredNames.add(node.name.text)
    }
    ts.forEachChild(node, collectDeclared)
  }
  collectDeclared(file)

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.isTypeOnly === true
      const allSpecifiersTypeOnly =
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.length > 0 &&
        node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)
      modules.push({
        specifier: node.moduleSpecifier.text,
        runtime: !typeOnly && !allSpecifiersTypeOnly,
        line: lineOf(file, node),
      })
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const allSpecifiersTypeOnly =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)
      modules.push({
        specifier: node.moduleSpecifier.text,
        runtime: !node.isTypeOnly && !allSpecifiersTypeOnly,
        line: lineOf(file, node),
      })
    }
    if (
      ts.isIdentifier(node) &&
      (BROWSER_ONLY_GLOBALS.has(node.text) || NODE_ONLY_GLOBALS.has(node.text)) &&
      !declaredNames.has(node.text)
    ) {
      const parent = node.parent
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        ((ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node)
      if (!isPropertyName) globals.push({name: node.text, line: lineOf(file, node)})
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  return {modules, globals}
}

const matchesModule = (specifier: string, forbidden: string): boolean =>
  specifier === forbidden || specifier.startsWith(`${forbidden}/`)

const isRelative = (specifier: string): boolean => specifier.startsWith('.')

function collectFiles(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...collectFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const FILES = collectFiles(join(QUERY_PACKAGE, 'src'))
  .concat(collectFiles(join(QUERY_PACKAGE, 'parity')))
  .map((path) => ({
    path,
    ref: relative(QUERY_PACKAGE, path),
    analysis: analyzeSource(readFileSync(path, 'utf8'), path),
  }))

/* ------------------------------------------------------------------ *
 * The lint over the real package
 * ------------------------------------------------------------------ */

describe('PRD §10.1: sanity-overlay-query dependency boundaries', () => {
  it('the lint actually has files to inspect', () => {
    expect(FILES.length).toBeGreaterThan(5)
    expect(FILES.map((f) => f.ref)).toContain('src/evaluate.ts')
  })

  it('takes no forbidden runtime dependency', () => {
    const violations: string[] = []
    for (const file of FILES) {
      for (const reference of file.analysis.modules) {
        if (!reference.runtime) continue
        for (const forbidden of FORBIDDEN_RUNTIME_MODULES) {
          if (matchesModule(reference.specifier, forbidden)) {
            violations.push(`${file.ref}:${reference.line} imports ${reference.specifier}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('imports no Node builtin, so the package is browser-safe', () => {
    const violations: string[] = []
    for (const file of FILES) {
      for (const reference of file.analysis.modules) {
        if (!reference.runtime || isRelative(reference.specifier)) continue
        const bare = reference.specifier.replace(/^node:/, '').split('/')[0]
        if (NODE_BUILTINS.has(bare) || reference.specifier.startsWith('node:')) {
          violations.push(`${file.ref}:${reference.line} imports ${reference.specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('takes exactly one external runtime dependency: the pinned groq-js', () => {
    const external = new Set<string>()
    for (const file of FILES) {
      for (const reference of file.analysis.modules) {
        if (!reference.runtime || isRelative(reference.specifier)) continue
        external.add(reference.specifier)
      }
    }
    expect([...external].sort()).toEqual([...ALLOWED_EXTERNAL_MODULES].sort())
  })

  it('the pinned groq-js version in package.json matches the rest of the workspace', () => {
    const manifest = JSON.parse(readFileSync(join(QUERY_PACKAGE, 'package.json'), 'utf8'))
    // PRD §5.5 requires an EXACT pin, not a range.
    expect(manifest.dependencies['groq-js']).toBe('2.0.0')
    const testkit = JSON.parse(
      readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'),
    )
    expect(manifest.dependencies['groq-js']).toBe(testkit.dependencies['groq-js'])
  })

  it('references no browser-only global', () => {
    const violations: string[] = []
    for (const file of FILES) {
      for (const reference of file.analysis.globals) {
        if (BROWSER_ONLY_GLOBALS.has(reference.name)) {
          violations.push(`${file.ref}:${reference.line} uses ${reference.name}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('references no Node-only global', () => {
    const violations: string[] = []
    for (const file of FILES) {
      for (const reference of file.analysis.globals) {
        if (NODE_ONLY_GLOBALS.has(reference.name)) {
          violations.push(`${file.ref}:${reference.line} uses ${reference.name}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('reaches into sanity-overlay-core only for pure, dependency-free helpers', () => {
    // Cross-package imports are relative in this repo until `pnpm install`
    // links the workspace. The rule that matters is which MODULE is reached,
    // not the shape of the specifier: core's store and adapter modules are not
    // the query layer's business.
    const crossPackage: string[] = []
    for (const file of FILES) {
      for (const reference of file.analysis.modules) {
        if (reference.specifier.includes('../../')) crossPackage.push(reference.specifier)
      }
    }
    expect(crossPackage).toEqual(['../../sanity-overlay-core/src/checksum'])
  })
})

/* ------------------------------------------------------------------ *
 * Analyzer self-tests. Without these the lint above could be green because
 * it detects nothing rather than because the package is clean.
 * ------------------------------------------------------------------ */

describe('the boundary analyzer itself', () => {
  const runtimeSpecifiers = (source: string) =>
    analyzeSource(source)
      .modules.filter((m) => m.runtime)
      .map((m) => m.specifier)

  it('flags a runtime import of a forbidden module', () => {
    expect(runtimeSpecifiers(`import {readFileSync} from 'node:fs'`)).toEqual(['node:fs'])
  })

  it('exempts a type-only import', () => {
    expect(runtimeSpecifiers(`import type {SanityClient} from '@sanity/client'`)).toEqual([])
  })

  it('exempts an import whose every specifier is type-only', () => {
    expect(runtimeSpecifiers(`import {type A, type B} from 'sanity'`)).toEqual([])
  })

  it('flags a mixed import as runtime', () => {
    expect(runtimeSpecifiers(`import {type A, createClient} from '@sanity/client'`)).toEqual([
      '@sanity/client',
    ])
  })

  it('flags a re-export of a forbidden module and exempts `export type`', () => {
    expect(runtimeSpecifiers(`export * from 'next/server'`)).toEqual(['next/server'])
    expect(runtimeSpecifiers(`export type {A} from 'next/server'`)).toEqual([])
  })

  it('matches subpaths of a forbidden module', () => {
    expect(matchesModule('@vercel/blob/client', '@vercel/blob')).toBe(true)
    expect(matchesModule('nextish', 'next')).toBe(false)
  })

  it('flags a browser-only global but not a same-named property or local', () => {
    const globals = (source: string) => analyzeSource(source).globals.map((g) => g.name)
    expect(globals(`window.alert('x')`)).toEqual(['window'])
    expect(globals(`const o = {document: 1}; o.document`)).toEqual([])
    expect(globals(`function f(document: string) { return document }`)).toEqual([])
  })

  it('flags a Node-only global but not a same-named property', () => {
    const globals = (source: string) => analyzeSource(source).globals.map((g) => g.name)
    expect(globals(`process.env.X`)).toEqual(['process'])
    expect(globals(`const o = {process: 1}; o.process`)).toEqual([])
  })
})
