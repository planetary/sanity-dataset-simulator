/**
 * PRD §22.5: "[MUST] CI runs the codemod in check mode and the lint rule in
 * error mode after migration."
 *
 * ==========================================================================
 * THE GAP THIS CLOSES
 *
 * The unregistered-query checker existed as a pure function and a standalone
 * `lint/check-queries.mjs`. §22.5 does not ask for a checker; it asks for
 * ENFORCEMENT — a build that FAILS. A rule nobody runs is documentation, and
 * the standalone script was reachable only by typing its path.
 *
 * So the rule gets the same front door every other gate in this project has:
 * one CLI, one exit-code contract, and a CI step that runs it. The exit codes
 * are the CLI's own, not the script's, because a script and a subcommand that
 * disagreed about what "2" means is precisely how a CI gate ends up green by
 * accident:
 *
 *   0  clean
 *   2  FINDINGS — an unregistered query, a drifted text, a direct client, a
 *      live subscription, or a pending/refused codemod rewrite
 *   5  USAGE — the invocation was wrong
 *
 * Nothing here asserts on a value the CLI just computed: every case writes real
 * files into a real temp directory and asserts on the process's exit code and
 * bytes.
 * ==========================================================================
 */
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {runCliCapture} from '../../sanity-overlay-cli/test-support/overlayFixture'
import {M_LOCAL_QUERIES} from '../../sanity-overlay-query/src/index'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cli-lint-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const full = join(root, name)
    await mkdir(dirname(full), {recursive: true})
    await writeFile(full, content, 'utf8')
  }
  return root
}

const REGISTERED = M_LOCAL_QUERIES[0]

/* ------------------------------------------------------------------ *
 * 1. `lint` — the rule in error mode.
 * ------------------------------------------------------------------ */

describe('sanity-overlay lint', () => {
  it('exits 0 on a project whose queries are all registered', async () => {
    const root = await project({
      'app/page.tsx': `const q = \`${REGISTERED.query}\`\n`,
      'app/other.ts': `export const label = 'nothing to see'\n`,
    })
    const run = await runCliCapture(['lint'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('0 errors')
  })

  it('FAILS THE BUILD on an unregistered query', async () => {
    // The whole point of the ticket: printing is not enforcement.
    const root = await project({'app/page.tsx': `const q = '*[_type == "secret"]{_id}'\n`})
    const run = await runCliCapture(['lint'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    expect(run.stdout + run.stderr).toContain('unregistered-query')
    expect(run.stdout + run.stderr).toContain('app/page.tsx')
  })

  it('fails on a direct client import and on a live subscription', async () => {
    for (const [name, source, code] of [
      ['app/a.ts', `import {createClient} from '@sanity/client'\n`, 'direct-client-import'],
      ['app/b.ts', `import {defineLive} from 'next-sanity'\n`, 'live-bypass'],
    ] as const) {
      const root = await project({[name]: source})
      const run = await runCliCapture(['lint'], {cwd: root})
      expect(run.code, name).toBe(EXIT.FINDINGS)
      expect(run.stdout + run.stderr, name).toContain(code)
    }
  })

  it('--mode warn reports the same finding and does NOT fail', async () => {
    // §22.5 "[SHOULD] Allow a local development warning mode during migration".
    const root = await project({'app/page.tsx': `const q = '*[_type == "secret"]'\n`})
    const run = await runCliCapture(['lint', '--mode', 'warn'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('unregistered-query')
  })

  it('rejects an unknown --mode instead of quietly picking one', async () => {
    const root = await project({'app/page.tsx': `const q = 'x'\n`})
    const run = await runCliCapture(['lint', '--mode', 'lenient'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
  })

  it('scans an explicit path and honours --ignore', async () => {
    const root = await project({
      'node_modules/pkg/index.js': `const q = '*[_type == "vendor"]'\n`,
      'generated/schema.ts': `const q = '*[_type == "generated"]'\n`,
      'app/clean.ts': `export const x = 1\n`,
    })
    expect((await runCliCapture(['lint'], {cwd: root})).code).toBe(EXIT.FINDINGS)
    expect(
      (await runCliCapture(['lint', '--ignore', 'generated'], {cwd: root})).code,
      'node_modules is always skipped, generated is ignored',
    ).toBe(EXIT.OK)
    expect((await runCliCapture(['lint', 'app'], {cwd: root})).code, 'explicit path').toBe(EXIT.OK)
  })

  it('--json emits the machine-readable report', async () => {
    const root = await project({'app/page.tsx': `const q = '*[_type == "secret"]'\n`})
    const run = await runCliCapture(['lint', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout) as {
      ok: boolean
      errorCount: number
      findings: Array<{code: string; file: string}>
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.errorCount).toBe(1)
    expect(parsed.findings[0].code).toBe('unregistered-query')
  })

  it('reports the query ID a registered literal resolves to', async () => {
    // §22.5 "every production frontend query has a stable query ID": the client
    // is called with the ID, so the rule says which one.
    const root = await project({'app/page.tsx': `const q = \`${REGISTERED.query}\`\n`})
    const run = await runCliCapture(['lint', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout) as {resolved: Array<{queryId: string}>}
    expect(parsed.resolved.map((r) => r.queryId)).toEqual([REGISTERED.id])
  })
})

/* ------------------------------------------------------------------ *
 * 2. `codemod` — check mode by default, write only when asked.
 * ------------------------------------------------------------------ */

describe('sanity-overlay codemod', () => {
  it('check mode fails when a file still needs migrating, and writes nothing', async () => {
    const source = `import {createClient} from '@sanity/client'\n`
    const root = await project({'app/sanity.ts': source})
    const run = await runCliCapture(['codemod'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    expect(await readFile(join(root, 'app/sanity.ts'), 'utf8'), 'check mode must not write').toBe(
      source,
    )
  })

  it('--write applies the rewrite, and a re-run is then clean', async () => {
    const root = await project({'app/sanity.ts': `import {createClient} from '@sanity/client'\n`})
    const written = await runCliCapture(['codemod', '--write'], {cwd: root})
    expect(written.code).toBe(EXIT.OK)
    expect(await readFile(join(root, 'app/sanity.ts'), 'utf8')).toBe(
      `import {createOverlayClient as createClient} from 'sanity-overlay-client'\n`,
    )
    expect((await runCliCapture(['codemod'], {cwd: root})).code, 'idempotent').toBe(EXIT.OK)
  })

  it('a refused file fails check mode and is left byte-identical by --write', async () => {
    const source = `import * as sanity from '@sanity/client'\n`
    const root = await project({'app/sanity.ts': source})
    const check = await runCliCapture(['codemod'], {cwd: root})
    expect(check.code).toBe(EXIT.FINDINGS)
    expect(check.stdout + check.stderr).toContain('namespace-import')
    const write = await runCliCapture(['codemod', '--write'], {cwd: root})
    expect(write.code).toBe(EXIT.FINDINGS)
    expect(await readFile(join(root, 'app/sanity.ts'), 'utf8')).toBe(source)
  })

  it('a clean project exits 0 in both modes', async () => {
    const root = await project({'app/x.ts': `export const x = 1\n`})
    expect((await runCliCapture(['codemod'], {cwd: root})).code).toBe(EXIT.OK)
    expect((await runCliCapture(['codemod', '--write'], {cwd: root})).code).toBe(EXIT.OK)
  })

  it('--json emits the machine-readable report', async () => {
    const root = await project({'app/sanity.ts': `import * as s from '@sanity/client'\n`})
    const run = await runCliCapture(['codemod', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout) as {
      ok: boolean
      filesRefused: number
      results: Array<{refusals: Array<{construct: string}>}>
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.filesRefused).toBe(1)
    expect(parsed.results[0].refusals[0].construct).toBe('namespace-import')
  })

  it('attaches the registered query ID when it writes', async () => {
    const root = await project({
      'app/sanity.ts':
        `import {createClient} from '@sanity/client'\n` +
        `export const rows = client.fetch('${REGISTERED.query}')\n`,
    })
    await runCliCapture(['codemod', '--write'], {cwd: root})
    const after = await readFile(join(root, 'app/sanity.ts'), 'utf8')
    expect(after).toContain(`client.fetch('${REGISTERED.id}')`)
  })
})

/* ------------------------------------------------------------------ *
 * 3. The two gates agree.
 * ------------------------------------------------------------------ */

describe('the codemod produces something the lint rule accepts', () => {
  it('a migrated project passes lint, and the original did not', async () => {
    const root = await project({
      'app/sanity.ts':
        `import {createClient} from '@sanity/client'\n` +
        `export const rows = client.fetch('${REGISTERED.query}')\n`,
    })
    expect((await runCliCapture(['lint'], {cwd: root})).code, 'before').toBe(EXIT.FINDINGS)
    expect((await runCliCapture(['codemod', '--write'], {cwd: root})).code).toBe(EXIT.OK)
    expect((await runCliCapture(['lint'], {cwd: root})).code, 'after').toBe(EXIT.OK)
  })

  it('the ID the codemod wrote is one the runtime will actually accept', () => {
    // Closes the §22.5 loop end to end. The oracle is deliberately a DIFFERENT
    // surface from the one that produced the ID: `query --list` enumerates the
    // registry the evaluator resolves against, so an ID the codemod invented,
    // stale-copied or mis-cased could not survive this.
    return (async () => {
      const root = await project({
        'app/sanity.ts':
          `import {createClient} from '@sanity/client'\n` +
          `export const rows = client.fetch('${REGISTERED.query}')\n`,
      })
      await runCliCapture(['codemod', '--write'], {cwd: root})
      const after = await readFile(join(root, 'app/sanity.ts'), 'utf8')
      const attached = /client\.fetch\('([^']+)'\)/.exec(after)?.[1]
      expect(attached).toBeDefined()

      const listed = await runCliCapture(['query', '--list', '--json'], {cwd: root})
      const ids = (JSON.parse(listed.stdout) as {queries: Array<{id: string}>}).queries.map(
        (q) => q.id,
      )
      expect(ids).toContain(attached)
    })()
  })
})
