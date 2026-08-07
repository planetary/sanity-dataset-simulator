/**
 * The STATIC half of PRD §22.5.
 *
 * §22.5 requires four things of an unregistered query. Three are runtime
 * behaviours and already exist (`QUERY_NOT_REGISTERED`, structural rejection,
 * and a caller/perspective gate): they catch a query when it RUNS. The fourth —
 * "[MUST] Provide an ESLint rule that blocks unregistered GROQ construction …
 * [MUST] CI runs … the lint rule in error mode after migration" — is a
 * BUILD-time check, and its whole value is catching the query before it runs.
 *
 * This file tests that check. What it is NOT: an ESLint plugin. Installing one
 * is not possible here, and the useful part of the rule is not the plugin
 * packaging — it is the decision "is this GROQ literal registered?", which is a
 * pure function and is tested as one, plus a runnable entry point CI can call.
 *
 * DETECTION LIMITS ARE TESTED AS LIMITS, not left implied. §22.5 itself says
 * dynamic query construction is forbidden "unless a custom planner exists",
 * which concedes that a statically-built checker cannot resolve a query
 * assembled at runtime. The cases it cannot resolve are pinned below with the
 * outcome they actually produce, so nobody reads this suite as full coverage.
 */
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  checkSourceForUnregisteredQueries,
  checkSourcesForUnregisteredQueries,
  formatQueryLintReport,
  looksLikeGroq,
  scanStringLiterals,
} from '../../sanity-overlay-query/src/index'
import type {
  QueryLintFinding,
  RegisteredQuerySummary,
} from '../../sanity-overlay-query/src/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUERY_PACKAGE = resolve(HERE, '..', '..', 'sanity-overlay-query')
const CLI = join(QUERY_PACKAGE, 'lint', 'check-queries.mjs')
const MANIFEST = join(QUERY_PACKAGE, 'lint', 'm-local-registry.json')

const REGISTRY: RegisteredQuerySummary[] = M_LOCAL_QUERIES.map((d) => ({id: d.id, query: d.query}))

const check = (source: string, mode: 'strict' | 'warn' = 'strict'): QueryLintFinding[] =>
  checkSourceForUnregisteredQueries({file: 'app/page.tsx', source, registry: REGISTRY, mode})

const codes = (source: string): string[] => check(source).map((f) => f.code)

/* ------------------------------------------------------------------ *
 * 1. The literal scanner. Everything else is built on it, so its own
 *    behaviour is pinned before any GROQ classification happens.
 * ------------------------------------------------------------------ */

describe('the source scanner finds string literals and nothing else', () => {
  const texts = (source: string) => scanStringLiterals(source).map((l) => l.text)

  it('finds single, double and backtick literals', () => {
    expect(texts(`const a = 'one'; const b = "two"; const c = \`three\``)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('ignores line comments, block comments and JSDoc', () => {
    const source = [
      `// const q = '*[_type == "article"]'`,
      `/* const q = "*[_type == \\"page\\"]" */`,
      `/** @example \`*[_id == $id][0]\` */`,
      `const real = 'kept'`,
    ].join('\n')
    expect(texts(source)).toEqual(['kept'])
  })

  it('reports 1-based line and column', () => {
    const found = scanStringLiterals(`const a = 1\nconst b = 'x'\n`)
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(2)
    expect(found[0].column).toBe(11)
  })

  it('handles escapes without ending the literal early', () => {
    expect(texts(`const a = 'it\\'s'; const b = "say \\"hi\\""`)).toEqual([`it's`, `say "hi"`])
  })

  it('records template interpolation instead of pretending the text is static', () => {
    const found = scanStringLiterals('const q = `*[_type == "${type}"]`')
    expect(found).toHaveLength(1)
    expect(found[0].interpolated).toBe(true)
    expect(found[0].kind).toBe('template')
  })

  it('records a tagged template tag and an enclosing call', () => {
    expect(scanStringLiterals('const q = groq`*[_id == $id]`')[0].tag).toBe('groq')
    expect(scanStringLiterals('const q = defineQuery(`*[_id == $id]`)')[0].callee).toBe(
      'defineQuery',
    )
    expect(scanStringLiterals('client.fetch(`*[_id == $id]`)')[0].callee).toBe('fetch')
  })

  it('records string concatenation, in both directions', () => {
    expect(scanStringLiterals(`const q = '*[_type == "' + type + '"]'`).map((l) => l.concatenated))
      .toEqual([true, true])
    expect(scanStringLiterals(`const q = 'plain'`)[0].concatenated).toBe(false)
  })

  it('does not mistake a regex literal for code, nor division for a regex', () => {
    // A regex can legally contain a quote; if the scanner treated `/` as
    // division it would then read the rest of the file as a string.
    expect(texts(`const re = /['"]/; const after = 'found'`)).toEqual(['found'])
    expect(texts(`const half = total / 2; const after = 'found'`)).toEqual(['found'])
  })
})

/* ------------------------------------------------------------------ *
 * 2. What counts as GROQ. Both directions, because a classifier that
 *    says yes to everything would make the whole check useless noise.
 * ------------------------------------------------------------------ */

describe('GROQ classification', () => {
  const only = (source: string) => scanStringLiterals(source)[0]

  it('recognises a filter, an aggregate and a tagged or defineQuery literal', () => {
    expect(looksLikeGroq(only(`const q = '*[_type == "article"]'`))).toBe(true)
    expect(looksLikeGroq(only(`const q = 'count(*[_type == "article"])'`))).toBe(true)
    expect(looksLikeGroq(only('const q = groq`*[_id == $id][0]`'))).toBe(true)
    expect(looksLikeGroq(only('const q = defineQuery(`*[_id == $id][0]`)'))).toBe(true)
  })

  it('does not flag ordinary strings that merely contain punctuation', () => {
    for (const source of [
      `const a = 'hello world'`,
      `const b = "https://example.com/path?a=1"`,
      `const c = 'array[0]'`,
      `const d = '2 * [3]'`,
      `const e = "SELECT * FROM articles"`,
    ]) {
      expect(looksLikeGroq(only(source)), source).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 3. The rule itself.
 * ------------------------------------------------------------------ */

describe('§22.5: unregistered GROQ is reported', () => {
  it('a registered query, byte for byte, is not reported', () => {
    const registered = M_LOCAL_QUERIES[0].query
    expect(check(`const q = \`${registered}\``)).toEqual([])
  })

  it('every registered query in the registry passes its own rule', () => {
    // A rule that flagged the registry's own texts would be unusable, and this
    // sweeps all of them rather than trusting one.
    for (const def of M_LOCAL_QUERIES) {
      expect(check(`const q = \`${def.query}\``), def.id).toEqual([])
    }
  })

  it('an unregistered query IS reported, with its location and text', () => {
    const source = `import {client} from './client'\nconst rows = client.fetch('*[_type == "secret"]{_id}')\n`
    const findings = check(source)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('unregistered-query')
    expect(findings[0].severity).toBe('error')
    expect(findings[0].line).toBe(2)
    expect(findings[0].file).toBe('app/page.tsx')
    expect(findings[0].query).toContain('_type == "secret"')
    expect(findings[0].message).toMatch(/not registered/i)
  })

  it('a registered query whose TEXT has drifted is reported separately', () => {
    // Reformatting is a change under §22.5 — the runtime raises QUERY_CHANGED
    // for exactly this, because the checksum is over the bytes. Reporting it as
    // "unregistered" would send the reader looking for the wrong fix.
    const drifted = M_LOCAL_QUERIES[0].query.replace(/ /g, '  ')
    const findings = check(`const q = \`${drifted}\``)
    expect(findings.map((f) => f.code)).toEqual(['query-text-drift'])
    expect(findings[0].message).toMatch(/QUERY_CHANGED|whitespace|drift/i)
  })

  it('several queries in one file are all reported, in source order', () => {
    const source = [
      `const a = '*[_type == "a"]'`,
      `const b = '*[_type == "b"]'`,
      `const c = 'not groq'`,
    ].join('\n')
    const findings = check(source)
    expect(findings.map((f) => f.line)).toEqual([1, 2])
  })

  it('warn mode reports the same findings at warning severity', () => {
    // §22.5 "[SHOULD] Allow a local development warning mode during migration".
    const source = `const q = '*[_type == "secret"]'`
    const strict = check(source, 'strict')
    const warn = check(source, 'warn')
    expect(warn.map((f) => f.code)).toEqual(strict.map((f) => f.code))
    expect(warn.every((f) => f.severity === 'warning')).toBe(true)
    expect(strict.every((f) => f.severity === 'error')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 4. Dynamic construction — §22.5 forbids it, and it is also precisely
 *    what a static checker cannot resolve. Reported as its own code so
 *    the report never implies it was checked against the registry.
 * ------------------------------------------------------------------ */

describe('§22.5: dynamic query construction', () => {
  it('an interpolated template is reported as dynamic, not as unregistered', () => {
    expect(codes('const q = `*[_type == "${type}"]{_id}`')).toEqual(['dynamic-query'])
  })

  it('a concatenated query is reported as dynamic', () => {
    expect(codes(`const q = '*[_type == "' + type + '"]{_id}'`)).toContain('dynamic-query')
  })

  it('interpolation into an otherwise REGISTERED text is still dynamic', () => {
    // The static parts matching a registration proves nothing about the text
    // that will actually run, so this must not be waved through.
    const registered = M_LOCAL_QUERIES[0].query
    const interpolated = registered.replace('$id', '${id}')
    expect(codes(`const q = \`${interpolated}\``)).toEqual(['dynamic-query'])
  })

  it('the dynamic finding says why it cannot be resolved', () => {
    const finding = check('const q = `*[_type == "${type}"]`')[0]
    expect(finding.message).toMatch(/dynamic|cannot be resolved statically/i)
  })
})

/* ------------------------------------------------------------------ *
 * 5. THE LIMITS. Pinned as tests so the checker is never read as
 *    complete coverage. Each of these is a query the rule does NOT see.
 * ------------------------------------------------------------------ */

describe('what this checker cannot detect, stated as executable limits', () => {
  it('a query held only in a variable that is assembled at runtime is invisible', () => {
    const source = [
      `const parts = ['*', '[', '_type == "secret"', ']']`,
      `const q = parts.join('')`,
      `client.fetch(q)`,
    ].join('\n')
    // The individual fragments are not GROQ-shaped, so nothing is reported.
    // This is the case PRD §22.5 answers with "remove dynamic unsupported
    // query construction" rather than with a smarter linter.
    expect(check(source)).toEqual([])
  })

  it('a query loaded from a file or a network response is invisible', () => {
    expect(check(`const q = await loadQuery('article-by-id')`)).toEqual([])
  })

  it('a GROQ literal in a NON-query context is still reported — false positives are possible', () => {
    // A documentation constant or a test fixture that holds a query gets
    // flagged like any other. Recorded rather than hidden: the mitigation is
    // registering it or moving it, not making the rule quieter.
    const findings = check(`const example = '*[_type == "x"]'`)
    expect(findings.map((f) => f.code)).toEqual(['unregistered-query'])
  })

  it('a query embedded mid-sentence in prose is NOT detected', () => {
    // The other direction of the same trade-off. The rule requires the filter
    // to start the literal or to follow an opening bracket, pipe, comma or
    // equals, because "contains `*[`" also reports `'2 * [3]'` and every
    // sentence that multiplies by an array index. A checker whose output is
    // mostly noise gets switched off, so the miss is chosen deliberately.
    expect(check(`const help = 'write your filter like *[_type == "x"]'`)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 5b. THE OTHER HALF OF THE §22.5 RULE.
 *
 * "[MUST] Provide an ESLint rule that blocks unregistered GROQ
 * construction AND DIRECT OVERLAY-BYPASSING SANITY CLIENTS in
 * preview-aware application code."
 *
 * The GROQ half above was built first. This half was missing entirely,
 * and it is the half that matters more: an unregistered query is
 * REFUSED at runtime by the registry, so the worst case is a loud 422.
 * A direct `@sanity/client` never reaches the registry at all — it
 * reads the Content Lake and renders base content while every other
 * signal in the deployment says "branch". That failure is silent.
 *
 * Native Sanity Live is the same hole with a push instead of a pull, so
 * it gets its own code rather than being folded into the import
 * finding: §37 Phase 5 lists "Disable native Sanity Live in overlay
 * mode" as its own task, and the fix is a deletion, not a swap.
 * ------------------------------------------------------------------ */

describe('§22.5: direct overlay-bypassing Sanity clients', () => {
  it('a named import from @sanity/client is reported', () => {
    const findings = check(`import {createClient} from '@sanity/client'\n`)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('direct-client-import')
    expect(findings[0].severity).toBe('error')
    expect(findings[0].line).toBe(1)
    expect(findings[0].message).toMatch(/overlay/i)
  })

  it('reports every import form, not only the named one', () => {
    for (const source of [
      `import client from '@sanity/client'`,
      `import * as sanity from '@sanity/client'`,
      `import '@sanity/client'`,
      `export {createClient} from '@sanity/client'`,
      `const {createClient} = require('@sanity/client')`,
      `const mod = await import('@sanity/client')`,
      `import {createClient} from '@sanity/client/stega'`,
      `import {createClient} from 'next-sanity'`,
    ]) {
      expect(codes(source), source).toContain('direct-client-import')
    }
  })

  it('does not report the environment-aware client, nor a lookalike path', () => {
    for (const source of [
      `import {createOverlayClient} from 'sanity-overlay-client'`,
      `import {createOverlayClient} from '../../sanity-overlay-client/src/index'`,
      `import {thing} from '@sanity/client-lookalike'`,
      `import {defineField} from 'sanity'`,
    ]) {
      expect(check(source), source).toEqual([])
    }
  })

  it('does not report the module name when it is data rather than an import', () => {
    // A dependency list, an error message or an allowlist mentions the package
    // without importing it. Flagging those is how a rule becomes noise.
    for (const source of [
      `const externals = ['@sanity/client', 'next-sanity']`,
      `throw new Error('do not import @sanity/client here')`,
      `const map = {'@sanity/client': 'sanity-overlay-client'}`,
    ]) {
      expect(check(source), source).toEqual([])
    }
  })

  it('warn mode downgrades the severity without losing the finding', () => {
    const source = `import {createClient} from '@sanity/client'`
    expect(check(source, 'warn').map((f) => f.severity)).toEqual(['warning'])
    expect(check(source, 'strict').map((f) => f.severity)).toEqual(['error'])
  })
})

describe('§37 Phase 5: native Sanity Live is an overlay bypass of its own', () => {
  it('importing defineLive or SanityLive is reported as live-bypass, not as an import', () => {
    for (const source of [
      `import {defineLive} from 'next-sanity'`,
      `import {SanityLive} from 'next-sanity/live'`,
      `import {defineLive, sanityFetch} from 'next-sanity'`,
    ]) {
      expect(codes(source), source).toEqual(['live-bypass'])
    }
  })

  it('the message says why a rewrite is not the fix', () => {
    const finding = check(`import {defineLive} from 'next-sanity'`)[0]
    // Live pushes Content Lake changes straight into the page: there is no
    // overlay-aware equivalent to swap in, so the fix is removal plus the
    // overlay's own change subscription.
    expect(finding.message).toMatch(/Content Lake|bypass/i)
    expect(finding.message).toMatch(/remove|delete|overlay event|watch/i)
  })

  it('a live import is ONE finding, not a live-bypass plus a client import', () => {
    // Reporting both would send the reader to swap the import, which is the
    // wrong fix and leaves the subscription in place.
    expect(codes(`import {defineLive} from 'next-sanity'`)).toEqual(['live-bypass'])
  })

  it('a client obtained indirectly and used as `.live.events()` is NOT detected', () => {
    // Stated as a limit, like every other. The rule reads module specifiers and
    // import clauses; it does not resolve values. The case is closed instead by
    // the environment-aware client having no `.live` at all — pinned in
    // test/query-live-bypass.test.ts.
    expect(check(`getClient().live.events().subscribe(render)`)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 5c. §22.5 "Every production frontend query used in overlay mode has
 * a stable query ID". A rule that only says "not registered" leaves the
 * reader to grep the registry for the ID by hand; the resolution is
 * already computed to decide the finding, so it is reported.
 * ------------------------------------------------------------------ */

describe('§22.5: a registered literal resolves to the ID that must be called', () => {
  it('reports the query ID for a literal that matches a registration byte for byte', () => {
    const def = M_LOCAL_QUERIES[0]
    const report = checkSourcesForUnregisteredQueries(
      [{file: 'app/page.tsx', source: `const q = \`${def.query}\`\n`}],
      {registry: REGISTRY, mode: 'strict'},
    )
    expect(report.ok).toBe(true)
    expect(report.resolved).toEqual([
      {file: 'app/page.tsx', line: 1, column: 11, queryId: def.id},
    ])
  })

  it('resolves nothing for an unregistered or drifted literal', () => {
    const drifted = M_LOCAL_QUERIES[0].query.replace(/ /g, '  ')
    for (const source of [`const q = '*[_type == "secret"]'`, `const q = \`${drifted}\``]) {
      const report = checkSourcesForUnregisteredQueries([{file: 'a.ts', source}], {
        registry: REGISTRY,
        mode: 'strict',
      })
      expect(report.resolved, source).toEqual([])
    }
  })
})

/* ------------------------------------------------------------------ *
 * 6. Whole-project checking and the report.
 * ------------------------------------------------------------------ */

describe('checking a project', () => {
  const files = [
    {file: 'app/ok.ts', source: `const q = \`${M_LOCAL_QUERIES[0].query}\``},
    {file: 'app/bad.ts', source: `const q = '*[_type == "secret"]{_id}'`},
    {file: 'app/plain.ts', source: `const label = 'no queries here'`},
  ]

  it('reports per file and refuses the run when anything is unregistered', () => {
    const report = checkSourcesForUnregisteredQueries(files, {registry: REGISTRY, mode: 'strict'})
    expect(report.filesChecked).toBe(3)
    expect(report.errorCount).toBe(1)
    expect(report.warningCount).toBe(0)
    expect(report.ok).toBe(false)
    expect(report.findings.map((f) => f.file)).toEqual(['app/bad.ts'])
  })

  it('warn mode reports the same problem but does not fail the run', () => {
    const report = checkSourcesForUnregisteredQueries(files, {registry: REGISTRY, mode: 'warn'})
    expect(report.findings).toHaveLength(1)
    expect(report.errorCount).toBe(0)
    expect(report.warningCount).toBe(1)
    expect(report.ok).toBe(true)
  })

  it('a clean project is ok', () => {
    const report = checkSourcesForUnregisteredQueries(files.slice(0, 1).concat(files.slice(2)), {
      registry: REGISTRY,
      mode: 'strict',
    })
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
  })

  it('the formatted report names the file, the position and the fix', () => {
    const report = checkSourcesForUnregisteredQueries(files, {registry: REGISTRY, mode: 'strict'})
    const text = formatQueryLintReport(report)
    expect(text).toContain('app/bad.ts')
    expect(text).toContain('unregistered-query')
    expect(text).toMatch(/1 error/)
  })
})

/* ------------------------------------------------------------------ *
 * 7. The rule over this repository's own query package.
 * ------------------------------------------------------------------ */

describe('the [M-LOCAL] query package passes its own rule', () => {
  const collect = (directory: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') out.push(...collect(full))
      } else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  const sources = collect(join(QUERY_PACKAGE, 'src'))
    .concat(collect(join(QUERY_PACKAGE, 'parity')))
    .map((path) => ({file: relative(QUERY_PACKAGE, path), source: readFileSync(path, 'utf8')}))

  it('has files to check', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  it('reports nothing: every GROQ literal in the package is a registered query', () => {
    const report = checkSourcesForUnregisteredQueries(sources, {
      registry: REGISTRY,
      mode: 'strict',
    })
    expect(formatQueryLintReport(report)).toContain('0 errors')
    expect(report.findings).toEqual([])
  })

  it('and it found the registry file\'s queries rather than scanning nothing', () => {
    const registryFile = sources.find((s) => s.file.endsWith('mLocalRegistry.ts'))!
    const groq = scanStringLiterals(registryFile.source).filter(looksLikeGroq)
    expect(groq.length).toBe(M_LOCAL_QUERIES.length)
  })
})

/* ------------------------------------------------------------------ *
 * 8. The runnable entry point. CI runs a process, not a function.
 * ------------------------------------------------------------------ */

describe('the CI entry point', () => {
  const project = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'query-lint-'))
    for (const [name, content] of Object.entries(files)) {
      const full = join(root, name)
      mkdirSync(dirname(full), {recursive: true})
      writeFileSync(full, content, 'utf8')
    }
    return root
  }

  const run = (args: string[]): {status: number; output: string} => {
    try {
      const output = execFileSync(process.execPath, [CLI, ...args], {encoding: 'utf8'})
      return {status: 0, output}
    } catch (error) {
      const failure = error as {status?: number; stdout?: string; stderr?: string}
      return {status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`}
    }
  }

  it('exits 0 on a project whose queries are all registered', () => {
    const root = project({
      'app/page.tsx': `const q = \`${M_LOCAL_QUERIES[0].query}\`\n`,
      'app/other.ts': `export const label = 'nothing to see'\n`,
    })
    const result = run(['--registry', MANIFEST, root])
    expect(result.status).toBe(0)
    expect(result.output).toContain('0 errors')
  })

  it('exits 1 and names the file when a query is not registered', () => {
    const root = project({'app/page.tsx': `const q = '*[_type == "secret"]{_id}'\n`})
    const result = run(['--registry', MANIFEST, root])
    expect(result.status).toBe(1)
    expect(result.output).toContain('app/page.tsx')
    expect(result.output).toContain('unregistered-query')
  })

  it('exits 0 in warn mode with the same finding printed', () => {
    const root = project({'app/page.tsx': `const q = '*[_type == "secret"]{_id}'\n`})
    const result = run(['--registry', MANIFEST, '--mode', 'warn', root])
    expect(result.status).toBe(0)
    expect(result.output).toContain('unregistered-query')
  })

  it('skips node_modules and honours --ignore', () => {
    const root = project({
      'node_modules/pkg/index.js': `const q = '*[_type == "vendor"]'\n`,
      'generated/schema.ts': `const q = '*[_type == "generated"]'\n`,
    })
    expect(run(['--registry', MANIFEST, root]).status).toBe(1)
    expect(run(['--registry', MANIFEST, '--ignore', 'generated/', root]).status).toBe(0)
  })

  it('fails with a distinct status when the registry manifest is unusable', () => {
    const root = project({'app/page.tsx': `const q = 'x'\n`})
    const broken = join(root, 'broken.json')
    writeFileSync(
      broken,
      JSON.stringify({queries: [{id: 'x', query: '*[_id == $id]', queryChecksum: 'deadbeef'}]}),
      'utf8',
    )
    const result = run(['--registry', broken, root])
    // Not 1: a configuration failure must not be mistaken for a clean or a
    // dirty codebase, or CI cannot tell "the check failed" from "the check
    // could not run".
    expect(result.status).toBe(2)
    expect(result.output).toMatch(/checksum/i)
    expect(run(['--registry', join(root, 'missing.json'), root]).status).toBe(2)
  })
})

/* ------------------------------------------------------------------ *
 * 9. The manifest the entry point defaults to cannot drift from the
 *    registry it claims to represent.
 * ------------------------------------------------------------------ */

describe('the shipped registry manifest', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    queries: Array<{id: string; query: string; queryChecksum: string}>
  }

  it('lists exactly the registered queries, with the registered text', () => {
    expect(manifest.queries.map((q) => q.id)).toEqual(M_LOCAL_QUERIES.map((d) => d.id))
    for (const [index, entry] of manifest.queries.entries()) {
      expect(entry.query, entry.id).toBe(M_LOCAL_QUERIES[index].query)
    }
  })

  it('carries the §22.5 checksum, verified against node:crypto', () => {
    for (const entry of manifest.queries) {
      expect(entry.queryChecksum, entry.id).toBe(
        createHash('sha256').update(entry.query, 'utf8').digest('hex'),
      )
    }
  })
})
