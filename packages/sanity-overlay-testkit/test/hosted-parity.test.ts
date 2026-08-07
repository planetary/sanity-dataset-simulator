import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {AmbientEnvConflictError, EXPLICIT_ENV_FILE, MANAGED_KEYS, loadExplicitEnv} from '../src/env'
import {hostedConfigFromEnv, hostedQuery} from '../src/hosted'
import {draftsPerspective, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'

// Empty-overlay parity, PR-loop tier (testing-strategy §2/§3):
// hosted Content Lake result vs pinned groq-js over the same fixture dataset.
// Projection-only queries so no metadata normalization is needed yet.
// Skips cleanly when no credentials are present (inner loop stays offline).

/**
 * Per-test budget (ms).
 *
 * Every case here makes a real HTTPS round-trip to the hosted Content Lake, so
 * its runtime is set by someone else's network and someone else's server, not by
 * anything this repository controls. Measured worst case over six full-suite
 * runs: 4.77 s — 95 % of vitest's 5 s default, i.e. a single slow response away
 * from a red suite that says nothing about parity.
 *
 * A timeout here could only ever mean "the network was slow", which is not the
 * claim these tests make; the parity assertions themselves are untouched and
 * still fail on any result mismatch.
 */
vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

/*
 * The ONLY source of hosted credentials in this suite.
 *
 * `loadExplicitEnv()` reads the repo-root `.env` and returns it. It does not
 * consult `process.env` and does not write to it, so a `SANITY_*` variable
 * exported in the developer's shell — from another repository, a `~/.zshrc`, a
 * CI runner — cannot reach these tests. With no `.env` (which is every CI run,
 * since the file is gitignored) `cfg` is `null` and the block below skips.
 */
const cfg = hostedConfigFromEnv(loadExplicitEnv())
const docs = loadFixtureDataset()
const published = publishedPerspective(docs)
const drafts = draftsPerspective(docs)

const CASES: Array<{name: string; query: string; params?: Record<string, unknown>}> = [
  {name: 'ID lookup', query: `*[_id == "article-01"][0]{title}`},
  {name: 'slug lookup', query: `*[_type == "page" && slug.current == $slug][0]{title}`, params: {slug: 'legacy-page'}},
  {name: 'order and slice', query: `*[_type == "article"] | order(publishedAt desc)[0...20]{title, "slug": slug.current}`},
  {name: 'reference dereference', query: `*[_id == "article-01"][0]{title, author->{name}}`},
  {name: 'references()', query: `*[_type == "article" && references("author-1")]{_id} | order(_id asc)`},
  {name: 'count over finite type', query: `count(*[_type == "article"])`},
  {name: 'nested projection', query: `*[_type == "page"]{title, hero{heading, cta{label}}} | order(title asc)`},
  {name: 'array membership', query: `*[_type == "article" && "even" in tags]{_id} | order(_id asc)`},
  {name: 'type list', query: `*[_type == "article"]{_id, title} | order(_id asc)`},
  {name: 'multi-type list', query: `*[_type in ["article", "page"]]{_id, _type} | order(_id asc)`},
  {name: 'aggregate over finite type', query: `math::sum(*[_type == "article"].sections[1].count)`},
  {name: 'Portable Text pt::text', query: `*[_id == "article-03"][0]{"text": pt::text(body)}`},
]

describe.skipIf(!cfg)('hosted empty-overlay parity (Gate D groundwork)', () => {
  for (const c of CASES) {
    it(`published: ${c.name}`, async () => {
      const hosted = await hostedQuery(cfg!, c.query, c.params ?? {})
      const local = await runGroq(c.query, published, c.params ?? {})
      expect(local).toEqual(hosted)
    })
  }

  it('drafts perspective: diverging draft wins on both sides', async () => {
    const q = `*[_id == "article-02"][0]{title}`
    const hosted = await hostedQuery(cfg!, q, {}, 'drafts')
    const local = await runGroq(q, drafts)
    expect(local).toEqual(hosted)
    expect(hosted).toEqual({title: 'Article 2 (DRAFT: retitled)'})
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * CREDENTIAL RESOLUTION IS EXPLICIT-ONLY.
 *
 * Owner requirement, 2026-08-06: *"Can we not have the E2E ever do random stuff
 * like that and just make stuff ONLY pull in very explicit stuff?"*
 *
 * The defect these tests pin: `hostedConfigFromEnv()` used to destructure
 * `process.env`, and `loadEnv()` used to fill `process.env` only where a key was
 * *unset* — a gap-filler, which means an exported shell variable BEAT the
 * repository's own `.env`. A developer with another project's `SANITY_PROJECT_ID`
 * in their shell silently ran this parity oracle, and the live E2E oracle,
 * against a project nobody chose.
 *
 * These cases run unconditionally — they are about configuration, not about the
 * network, so they must not be inside the `skipIf(!cfg)` block above. They are
 * the reason CI stays green with no secrets: absent means absent, never ambient.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('credentials come from the declared file and from nowhere else', () => {
  /** What a contaminated shell looks like. Every managed key, all of it wrong. */
  const AMBIENT = Object.freeze({
    SANITY_PROJECT_ID: 'someoneElsesProject',
    SANITY_BASE_DATASET: 'someoneElsesDataset',
    SANITY_API_VERSION: 'v1999-01-01',
    SANITY_API_READ_TOKEN: 'skAMBIENT-exported-in-a-shell',
    SANITY_READ_TOKEN: 'skAMBIENT-exported-in-a-shell',
    SANITY_API_READONLY_TOKEN: 'skAMBIENT-exported-in-a-shell',
    SANITY_STUDIO_PROJECT_ID: 'someoneElsesProject',
    SANITY_STUDIO_DATASET: 'someoneElsesDataset',
  })

  /** A path that cannot exist: the "CI has no `.env`" case, deterministically. */
  const NO_FILE = join(tmpdir(), 'sanity-overlay-no-such-explicit-env-file')

  const silent = (): void => {}

  /** A declared source, written where the repo can never be touched. */
  function declare(values: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'sanity-overlay-explicit-env-'))
    const file = join(dir, '.env')
    writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
    return file
  }

  /* ─── the load-bearing case ─────────────────────────────────────────────── */

  it('an ambient export alone configures nothing — every managed key resolves absent', () => {
    const env = loadExplicitEnv({file: NO_FILE, ambient: AMBIENT, warn: silent})
    for (const key of MANAGED_KEYS) expect(env[key], `${key} leaked in from the ambient env`).toBeUndefined()
  })

  it('and so the hosted parity suite SKIPS rather than reading a stranger’s project', () => {
    const env = loadExplicitEnv({file: NO_FILE, ambient: AMBIENT, warn: silent})
    expect(hostedConfigFromEnv(env)).toBeNull()
  })

  it('and the LIVE e2e oracle reports no credentials, so `specs/live/` skips too', async () => {
    const {liveCredentialsAvailable, readToken} = await import('../../../e2e/playwright/upstream')
    const env = loadExplicitEnv({file: NO_FILE, ambient: AMBIENT, warn: silent})
    expect(readToken(env)).toBeUndefined()
    expect(liveCredentialsAvailable(env)).toBe(false)
  })

  /* ─── non-vacuity: the declared file DOES configure a run ────────────────── */

  it('a declared file configures the hosted run — the absence above is not vacuous', () => {
    const file = declare({
      SANITY_PROJECT_ID: 'declaredProject',
      SANITY_BASE_DATASET: 'declaredDataset',
      SANITY_API_VERSION: 'v2025-02-19',
      SANITY_API_READ_TOKEN: 'skDECLARED-in-the-repo-file',
    })
    expect(hostedConfigFromEnv(loadExplicitEnv({file, ambient: {}, warn: silent}))).toEqual({
      projectId: 'declaredProject',
      dataset: 'declaredDataset',
      apiVersion: 'v2025-02-19',
      token: 'skDECLARED-in-the-repo-file',
    })
  })

  it('a declared file configures the live oracle — the absence above is not vacuous', async () => {
    const {readToken, liveCredentialsAvailable} = await import('../../../e2e/playwright/upstream')
    const {DATASET, PROJECT_ID} = await import('../../../e2e/harness/paths.mjs')
    const file = declare({
      SANITY_PROJECT_ID: PROJECT_ID,
      SANITY_BASE_DATASET: DATASET,
      SANITY_API_READ_TOKEN: 'skDECLARED-read-only',
    })
    const env = loadExplicitEnv({file, ambient: {}, warn: silent})
    expect(readToken(env)).toBe('skDECLARED-read-only')
    expect(liveCredentialsAvailable(env)).toBe(true)
  })

  /* ─── the loader never launders values through the process ───────────────── */

  it('never writes to process.env — the ambient/explicit distinction survives the call', () => {
    /*
     * Canary VALUES, not a bare snapshot.
     *
     * The first version of this test snapshotted `process.env` and compared it
     * afterwards, and a deliberate mutation — the old `if (process.env[k] ===
     * undefined) process.env[k] = v` — sailed straight through it: the loader
     * runs once at module scope before any test, so by the time the snapshot was
     * taken the keys were already written and the `undefined` guard skipped
     * them. A test that can only fail when it happens to run first is not a
     * test. These two values exist nowhere on any machine, so neither a
     * managed-key write nor a whole-file write can hide behind prior state.
     */
    const MANAGED_CANARY = 'canary-dataset-that-must-not-escape'
    const UNMANAGED_CANARY = 'canary-value-that-must-not-escape'
    const AMBIENT_CANARY = 'canary-ambient-that-must-not-escape'
    const file = declare({
      SANITY_STUDIO_DATASET: MANAGED_CANARY,
      SANITY_OVERLAY_CANARY_KEY: UNMANAGED_CANARY,
    })
    const before = JSON.stringify(process.env)

    loadExplicitEnv({file, ambient: {}, warn: silent})
    loadExplicitEnv({file: NO_FILE, ambient: {SANITY_PROJECT_ID: AMBIENT_CANARY}, warn: silent})

    expect(process.env.SANITY_STUDIO_DATASET, 'a managed key was written through').not.toBe(
      MANAGED_CANARY,
    )
    expect(process.env.SANITY_OVERLAY_CANARY_KEY, 'the whole file was written through').toBeUndefined()
    /* Canary rather than AMBIENT's value: a contaminated real shell may already
     * hold anything AMBIENT holds, which would fail this for the wrong reason —
     * observed on the first draft, running with SANITY_PROJECT_ID exported. */
    expect(process.env.SANITY_PROJECT_ID, 'the injected ambient map was written through').not.toBe(
      AMBIENT_CANARY,
    )
    expect(JSON.stringify(process.env)).toBe(before)
  })

  it('points at the repo-root .env, and at exactly one file', async () => {
    /*
     * Independent oracle: `e2e/harness/paths.mjs` derives REPO_ROOT by walking
     * up from `e2e/harness/`, the loader by walking up from
     * `packages/sanity-overlay-testkit/src/`. Two different walks, one answer —
     * so this cannot pass by restating the loader's own arithmetic, and it also
     * pins the fact that the E2E side and the testkit side read the SAME file.
     */
    const {REPO_ROOT} = await import('../../../e2e/harness/paths.mjs')
    expect(EXPLICIT_ENV_FILE).toBe(join(REPO_ROOT, '.env'))
  })

  /* ─── silently ignoring is better than silently using; saying so is best ─── */

  it('names every ambient key it is ignoring, and says it is ignoring it', () => {
    const said: string[] = []
    loadExplicitEnv({file: NO_FILE, ambient: AMBIENT, warn: (m) => said.push(m)})
    const text = said.join('\n')
    for (const key of MANAGED_KEYS) expect(text, `nothing was said about ${key}`).toContain(key)
    expect(text).toMatch(/ignor/i)
  })

  it('does not leak the ambient token value into the warning', () => {
    const said: string[] = []
    loadExplicitEnv({file: NO_FILE, ambient: AMBIENT, warn: (m) => said.push(m)})
    expect(said.join('\n')).not.toContain('skAMBIENT-exported-in-a-shell')
  })

  it('says nothing at all when the shell is clean', () => {
    const said: string[] = []
    loadExplicitEnv({file: NO_FILE, ambient: {PATH: '/usr/bin', HOME: '/home/x'}, warn: (m) => said.push(m)})
    expect(said).toEqual([])
  })

  /* ─── the ruling: disagreement is refused, not resolved ──────────────────── */

  it('refuses, rather than choosing, when ambient and the declared file disagree', () => {
    const file = declare({SANITY_PROJECT_ID: 'declaredProject'})
    expect(() =>
      loadExplicitEnv({file, ambient: {SANITY_PROJECT_ID: 'someoneElsesProject'}, warn: silent}),
    ).toThrow(AmbientEnvConflictError)
  })

  it('the refusal names the key and both origins', () => {
    const file = declare({SANITY_BASE_DATASET: 'parity'})
    let message = ''
    try {
      loadExplicitEnv({file, ambient: {SANITY_BASE_DATASET: 'production'}, warn: silent})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('SANITY_BASE_DATASET')
    expect(message).toContain('parity')
    expect(message).toContain('production')
    expect(message).toContain(file)
  })

  it('redacts a credential value in the refusal — a refusal must not print a token', () => {
    const file = declare({SANITY_API_READ_TOKEN: 'skDECLARED-secret-aaa'})
    let message = ''
    try {
      loadExplicitEnv({file, ambient: {SANITY_API_READ_TOKEN: 'skAMBIENT-secret-bbb'}, warn: silent})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('SANITY_API_READ_TOKEN')
    expect(message).not.toContain('skDECLARED-secret-aaa')
    expect(message).not.toContain('skAMBIENT-secret-bbb')
  })

  it('accepts an ambient value that merely agrees, silently', () => {
    const said: string[] = []
    const file = declare({SANITY_PROJECT_ID: 'declaredProject'})
    const env = loadExplicitEnv({
      file,
      ambient: {SANITY_PROJECT_ID: 'declaredProject'},
      warn: (m) => said.push(m),
    })
    expect(env.SANITY_PROJECT_ID).toBe('declaredProject')
    expect(said).toEqual([])
  })

  it('treats an empty ambient value as absent, not as a disagreement', () => {
    const file = declare({SANITY_PROJECT_ID: 'declaredProject'})
    const said: string[] = []
    const env = loadExplicitEnv({file, ambient: {SANITY_PROJECT_ID: '  '}, warn: (m) => said.push(m)})
    expect(env.SANITY_PROJECT_ID).toBe('declaredProject')
    expect(said).toEqual([])
  })

  /* ─── the live oracle must audit the dataset the harness actually drives ─── */

  it('refuses a declared project that is not the one the E2E harness drives', async () => {
    const {readToken} = await import('../../../e2e/playwright/upstream')
    const {PROJECT_ID} = await import('../../../e2e/harness/paths.mjs')
    const file = declare({
      SANITY_PROJECT_ID: 'someOtherProject',
      SANITY_API_READ_TOKEN: 'skDECLARED-read-only',
    })
    const env = loadExplicitEnv({file, ambient: {}, warn: silent})
    expect(() => readToken(env)).toThrow(/someOtherProject/)
    expect(() => readToken(env)).toThrow(new RegExp(PROJECT_ID))
  })
})
