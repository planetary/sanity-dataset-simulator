/**
 * PRD §22.5: "[MUST] Provide a codemod that replaces direct Sanity client
 * imports with the environment-aware client and attaches stable query IDs where
 * queries are statically discoverable." §37 Phase 5: "Build and run
 * client-import codemod", "CI runs the codemod in check mode".
 *
 * ==========================================================================
 * WHAT THIS CODEMOD IS, AND WHAT IT REFUSES TO BE
 *
 * It is a transform over source TEXT. It is not a parser, it installs nothing,
 * and it never guesses. That is a deliberate bound, not a shortcut, and the
 * bound is enforced by the rule this suite exists to pin:
 *
 *   **A refusal anywhere in a file leaves the ENTIRE file byte-identical.**
 *
 * A half-migrated file is the worst outcome available here. It compiles, it
 * runs, and it reads from two different clients — one that resolves the overlay
 * and one that goes straight to the Content Lake. That is the exact split-brain
 * the overlay exists to prevent, and it is silent. So a construct the codemod
 * does not fully understand does not get a best-effort rewrite; it stops the
 * file and gets named in the report.
 *
 * The rewrite it DOES perform is alias-preserving: the local binding name never
 * changes, so no line other than the import statement is touched. What it
 * cannot do — supply the overlay client's configuration at the construction
 * site — is reported per call site as a follow-up rather than guessed at.
 * ==========================================================================
 */
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  checkSourcesForUnregisteredQueries,
  formatCodemodReport,
  runClientImportCodemod,
  rewriteClientImports,
} from '../../sanity-overlay-query/src/index'
import type {
  CodemodFileResult,
  RegisteredQuerySummary,
} from '../../sanity-overlay-query/src/index'

const REGISTRY: RegisteredQuerySummary[] = M_LOCAL_QUERIES.map((d) => ({id: d.id, query: d.query}))

const run = (source: string, file = 'app/lib/sanity.ts'): CodemodFileResult =>
  rewriteClientImports({file, source}, {registry: REGISTRY})

const constructs = (source: string): string[] => run(source).refusals.map((r) => r.construct)

/* ------------------------------------------------------------------ *
 * 1. The rewrite it performs.
 * ------------------------------------------------------------------ */

describe('§22.5: direct client imports become the environment-aware client', () => {
  it('rewrites a named import and leaves the local binding alone', () => {
    const result = run(`import {createClient} from '@sanity/client'\n\nexport const x = 1\n`)
    expect(result.changed).toBe(true)
    expect(result.code).toBe(
      `import {createOverlayClient as createClient} from 'sanity-overlay-client'\n\nexport const x = 1\n`,
    )
    expect(result.refusals).toEqual([])
  })

  it('keeps an existing alias, so no call site changes in that case either', () => {
    const result = run(`import {createClient as makeClient} from '@sanity/client'\n`)
    expect(result.code).toBe(
      `import {createOverlayClient as makeClient} from 'sanity-overlay-client'\n`,
    )
  })

  it('preserves the quote style and the rest of the line', () => {
    const result = run(`import { createClient } from "@sanity/client";\n`)
    expect(result.code).toBe(
      `import { createOverlayClient as createClient } from "sanity-overlay-client";\n`,
    )
  })

  it('rewrites every direct import in the file, not just the first', () => {
    const result = run(
      [
        `import {createClient} from '@sanity/client'`,
        `import {createClient as other} from 'next-sanity'`,
        ``,
      ].join('\n'),
    )
    expect(result.rewrites).toHaveLength(2)
    expect(result.code).not.toContain('@sanity/client')
    expect(result.code).not.toContain('next-sanity')
  })

  it('reports each rewrite with its position and both texts', () => {
    const result = run(`\nimport {createClient} from '@sanity/client'\n`)
    expect(result.rewrites).toHaveLength(1)
    expect(result.rewrites[0].line).toBe(2)
    expect(result.rewrites[0].kind).toBe('client-import')
    expect(result.rewrites[0].before).toContain('@sanity/client')
    expect(result.rewrites[0].after).toContain('sanity-overlay-client')
  })

  it('the rewritten file passes the lint rule that flagged the original', () => {
    // The two halves of §22.5 have to agree, or the codemod hands back
    // something CI still rejects. The lint rule is the independent oracle here:
    // it is a different module, written first, and it does not know the codemod
    // exists.
    const before = `import {createClient} from '@sanity/client'\n`
    const after = run(before).code
    const lint = (source: string) =>
      checkSourcesForUnregisteredQueries([{file: 'a.ts', source}], {
        registry: REGISTRY,
        mode: 'strict',
      })
    expect(lint(before).findings.map((f) => f.code)).toEqual(['direct-client-import'])
    expect(lint(after).findings).toEqual([])
    expect(runClientImportCodemod([{file: 'a.ts', source: before}], {registry: REGISTRY}).ok).toBe(
      false,
    )
    expect(runClientImportCodemod([{file: 'a.ts', source: after}], {registry: REGISTRY}).ok).toBe(
      true,
    )
  })
})

/* ------------------------------------------------------------------ *
 * 2. IDEMPOTENCE. A codemod that is not idempotent cannot run in CI
 *    check mode, and cannot be re-run after a rebase.
 * ------------------------------------------------------------------ */

describe('idempotence', () => {
  const sources = [
    `import {createClient} from '@sanity/client'\n`,
    `import {createClient as c} from '@sanity/client'\nconst client = c({})\n`,
    `import {createOverlayClient as createClient} from 'sanity-overlay-client'\n`,
    `export const nothing = 1\n`,
  ]

  it('a second pass changes nothing', () => {
    for (const source of sources) {
      const once = run(source).code
      const twice = run(once)
      expect(twice.code, source).toBe(once)
      expect(twice.changed, source).toBe(false)
      expect(twice.rewrites, source).toEqual([])
    }
  })

  it('an already-migrated file is reported as unchanged, not as rewritten', () => {
    const migrated = `import {createOverlayClient as createClient} from 'sanity-overlay-client'\n`
    const result = run(migrated)
    expect(result.changed).toBe(false)
    expect(result.code).toBe(migrated)
  })

  it('a file with no Sanity import at all is untouched', () => {
    const source = `import {useState} from 'react'\nconst q = '*[_id == $id][0]'\n`
    expect(run(source).code).toBe(source)
    expect(run(source).changed).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 3. WHAT IT REFUSES. Each of these is a construct where a text
 *    rewrite would produce working-looking code with different
 *    behaviour, which is the one outcome worse than not running.
 * ------------------------------------------------------------------ */

describe('refusals: constructs the codemod does not fully understand', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['default-import', `import client from '@sanity/client'\n`],
    ['namespace-import', `import * as sanity from '@sanity/client'\n`],
    ['side-effect-import', `import '@sanity/client'\n`],
    ['re-export', `export {createClient} from '@sanity/client'\n`],
    ['re-export', `export * from '@sanity/client'\n`],
    ['require', `const {createClient} = require('@sanity/client')\n`],
    ['dynamic-import', `const mod = await import('@sanity/client')\n`],
    ['subpath-import', `import {createClient} from '@sanity/client/stega'\n`],
    ['type-only-import', `import type {SanityClient} from '@sanity/client'\n`],
    ['unmapped-specifier', `import {createClient, requester} from '@sanity/client'\n`],
    ['mixed-default-and-named', `import client, {createClient} from '@sanity/client'\n`],
    ['live-subscription', `import {defineLive} from 'next-sanity'\n`],
  ]

  for (const [construct, source] of cases) {
    it(`refuses ${construct}: ${source.trim()}`, () => {
      const result = run(source)
      expect(result.refusals.map((r) => r.construct)).toContain(construct)
      expect(result.changed).toBe(false)
      expect(result.code).toBe(source)
    })
  }

  it('every refusal says where it is and why a rewrite would be wrong', () => {
    for (const [, source] of cases) {
      const [refusal] = run(source).refusals
      expect(refusal, source).toBeDefined()
      expect(refusal.line, source).toBe(1)
      expect(refusal.reason.length, source).toBeGreaterThan(40)
      /* The excerpt must be real text from the file, not a reconstruction. */
      expect(source.includes(refusal.source), source).toBe(true)
      expect(refusal.source.length, source).toBeGreaterThan(10)
    }
  })

  it('a refusal anywhere leaves the WHOLE file byte-identical', () => {
    // The central rule. The first import is perfectly rewritable; the second is
    // not. Rewriting the first would leave the file reading from two clients.
    const source = [
      `import {createClient} from '@sanity/client'`,
      `import * as sanity from '@sanity/client'`,
      ``,
    ].join('\n')
    const result = run(source)
    expect(result.code).toBe(source)
    expect(result.changed).toBe(false)
    expect(result.rewrites).toEqual([])
    expect(result.refusals.map((r) => r.construct)).toEqual(['namespace-import'])
  })

  it('a refusal stops the query-ID rewrites too, not just the import ones', () => {
    // The second half of the same rule, and the one a "best-effort" mode would
    // reach first: this file already imports the overlay client, so the ID
    // attachment is otherwise licensed — but the file ALSO holds a direct
    // client the codemod refused, and until that is resolved nobody knows which
    // client the `fetch` belongs to.
    const source =
      `import {createOverlayClient} from 'sanity-overlay-client'\n` +
      `import * as sanity from '@sanity/client'\n` +
      `export const rows = sanity.client.fetch('${M_LOCAL_QUERIES[0].query}')\n`
    const result = run(source)
    expect(result.code).toBe(source)
    expect(result.changed).toBe(false)
    expect(result.rewrites).toEqual([])
    expect(result.refusals.map((r) => r.construct)).toEqual(['namespace-import'])
  })

  it('the live refusal points at removal, not at a swap', () => {
    const refusal = run(`import {defineLive} from 'next-sanity'\n`).refusals[0]
    expect(refusal.reason).toMatch(/Content Lake|push/i)
    expect(refusal.reason).toMatch(/remove|delete/i)
  })
})

/* ------------------------------------------------------------------ *
 * 4. Stable query IDs — the second clause of the §22.5 sentence.
 * ------------------------------------------------------------------ */

describe('§22.5: stable query IDs where queries are statically discoverable', () => {
  const registered = M_LOCAL_QUERIES[0]

  it('replaces a registered query text with its ID in an overlay-backed file', () => {
    const source =
      `import {createClient} from '@sanity/client'\n` +
      `const client = createClient({})\n` +
      `export const rows = client.fetch('${registered.query}', {id})\n`
    const result = run(source)
    expect(result.code).toContain(`client.fetch('${registered.id}', {id})`)
    expect(result.code).not.toContain(registered.query)
    expect(result.rewrites.some((r) => r.kind === 'query-id')).toBe(true)
  })

  it('does NOT attach an ID in a file whose client is still the direct one', () => {
    // Without the import rewrite the receiver is a real @sanity/client, which
    // takes GROQ text. Substituting the ID there would silently query for the
    // literal string.
    const source =
      `import * as sanity from '@sanity/client'\n` +
      `export const rows = sanity.client.fetch('${registered.query}')\n`
    const result = run(source)
    expect(result.code).toBe(source)
    expect(result.refusals.map((r) => r.construct)).toEqual(['namespace-import'])
  })

  it('attaches IDs in a file that ALREADY imports the environment-aware client', () => {
    const source =
      `import {createOverlayClient} from 'sanity-overlay-client'\n` +
      `export const rows = client.fetch(\`${registered.query}\`)\n`
    const result = run(source)
    expect(result.code).toContain('client.fetch(`' + registered.id + '`)')
  })

  it('leaves an unregistered query text alone — there is no ID to attach', () => {
    const source =
      `import {createOverlayClient} from 'sanity-overlay-client'\n` +
      `export const rows = client.fetch('*[_type == "secret"]')\n`
    expect(run(source).code).toBe(source)
  })

  it('leaves a registered text that is NOT a fetch argument alone', () => {
    // A constant, a test fixture or documentation is not a call site, and
    // rewriting it would destroy the text the registry is checksummed against.
    const source =
      `import {createOverlayClient} from 'sanity-overlay-client'\n` +
      `export const QUERY = '${registered.query}'\n`
    expect(run(source).code).toBe(source)
  })

  it('is idempotent over query IDs too', () => {
    const source =
      `import {createOverlayClient} from 'sanity-overlay-client'\n` +
      `export const rows = client.fetch('${registered.query}')\n`
    const once = run(source).code
    expect(run(once).code).toBe(once)
  })
})

/* ------------------------------------------------------------------ *
 * 5. What it does not rewrite, stated per call site rather than
 *    implied. The construction site needs the overlay's base port and
 *    state loader, which no transform can invent.
 * ------------------------------------------------------------------ */

describe('follow-ups: the configuration the codemod cannot supply', () => {
  it('names every construction site of a rewritten binding', () => {
    const source =
      `import {createClient} from '@sanity/client'\n` +
      `export const a = createClient({projectId: 'p', dataset: 'd'})\n` +
      `export const b = createClient({projectId: 'p', dataset: 'staging'})\n`
    const result = run(source)
    expect(result.followUps).toHaveLength(2)
    expect(result.followUps.map((f) => f.line)).toEqual([2, 3])
    expect(result.followUps[0].detail).toMatch(/base|overlay|configur/i)
  })

  it('does not invent a configuration at the construction site', () => {
    const source = `import {createClient} from '@sanity/client'\nconst c = createClient({projectId: 'p'})\n`
    expect(run(source).code).toContain(`createClient({projectId: 'p'})`)
  })

  it('a mention inside a string is not a construction site', () => {
    const source =
      `import {createClient} from '@sanity/client'\n` +
      `const help = 'call createClient(config) yourself'\n`
    expect(run(source).followUps).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 6. Whole-project run and check mode.
 * ------------------------------------------------------------------ */

describe('running over a project', () => {
  const files = [
    {file: 'app/a.ts', source: `import {createClient} from '@sanity/client'\n`},
    {file: 'app/b.ts', source: `import * as sanity from '@sanity/client'\n`},
    {file: 'app/c.ts', source: `export const nothing = 1\n`},
  ]

  it('separates changed, refused and untouched files', () => {
    const report = runClientImportCodemod(files, {registry: REGISTRY})
    expect(report.filesChanged).toBe(1)
    expect(report.filesRefused).toBe(1)
    expect(report.filesChecked).toBe(3)
    expect(report.results.map((r) => r.file)).toEqual(['app/a.ts', 'app/b.ts', 'app/c.ts'])
  })

  it('check mode fails when a file would change OR is refused', () => {
    // §22.5 "CI runs the codemod in check mode": both a pending rewrite and a
    // refusal are unfinished migration work, and both must fail the build.
    expect(runClientImportCodemod(files, {registry: REGISTRY}).ok).toBe(false)
    expect(
      runClientImportCodemod([files[1]], {registry: REGISTRY}).ok,
      'refusal alone',
    ).toBe(false)
    expect(runClientImportCodemod([files[2]], {registry: REGISTRY}).ok, 'clean').toBe(true)
  })

  it('a project of already-migrated files is ok', () => {
    const migrated = files.map((f) => ({file: f.file, source: run(f.source).code}))
    // b.ts is refused, so drop it: the point is that a and c are stable.
    const report = runClientImportCodemod([migrated[0], migrated[2]], {registry: REGISTRY})
    expect(report.ok).toBe(true)
    expect(report.filesChanged).toBe(0)
  })

  it('the formatted report names the file, the construct and the reason', () => {
    const text = formatCodemodReport(runClientImportCodemod(files, {registry: REGISTRY}))
    expect(text).toContain('app/a.ts')
    expect(text).toContain('app/b.ts')
    expect(text).toContain('namespace-import')
    expect(text).toMatch(/1 file changed|1 changed/)
  })
})
