/**
 * THE LEDGER — a pure test that covers a WIRING concern must say so, in writing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CATEGORY THIS EXISTS TO STOP
 *
 * Five features passed their unit tests and did not work in a browser, and the
 * five tests that missed them shared one shape: **pure** (no real filesystem, no
 * real HTTP, no real store) while the thing being asserted was **wiring** — does
 * the composed config contain this, does the real endpoint accept this, does the
 * path Studio actually calls return this. A test that builds its own seam and
 * then measures it proves the factory works. It cannot prove anything called it.
 *
 * Pure tests are not the problem. Pure tests over PURE FUNCTIONS are correct,
 * fast, and the majority of this suite — `core-w3-merge`, `query-pushdown` and
 * their neighbours should never grow a filesystem. The problem is the pair:
 * pure test, wiring subject, and nothing real anywhere else covering the seam.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A LEDGER AND NOT A BAN
 *
 * The obvious guard is "no test may import `config.ts` without booting a
 * server". It was rejected, and the reason is worth keeping:
 *
 *  - It is WRONG. `resolveOverlayOptions`, `deriveOverlayStatus`, `planRebase`,
 *    `classifyWriteEndpoint` are pure decisions that live in wiring modules. A
 *    ban makes the honest, cheap, exhaustive test of a pure function illegal and
 *    pushes people to boot a server to assert a string — slower suite, worse
 *    signal, and eventually the check gets disabled.
 *  - It is UNACTIONABLE. "This file is banned" tells an author to delete work.
 *    It never tells them what would be enough.
 *  - It CANNOT SEE THE THING THAT MATTERS. Purity is syntax. Whether a seam is
 *    covered somewhere real is a fact about the whole suite, and no per-file
 *    rule can read it.
 *
 * So this file asks for a decision instead of forbidding a shape. Every pure
 * test file is classified once, by hand, as `pure-logic` or `wiring`; every
 * `wiring` entry states where the seam is covered for real, or admits it is
 * blind. Three things make that more than a comment:
 *
 *  1. **It is total.** A new pure test file that nobody classified fails this
 *     test, with a message that says exactly which line to add. The cost lands
 *     on the author, once, at the moment they can still choose differently.
 *  2. **`where` is checked, not trusted.** An entry claiming its seam is covered
 *     elsewhere must name a test file that EXISTS and is itself REAL. You cannot
 *     discharge a wiring seam by pointing at another pure test — which is
 *     precisely the circle the five defects lived inside.
 *  3. **`blind` is rationed.** {@link BLIND_BUDGET} is an exact count, so a new
 *     blind seam cannot be added without deleting an old one or arguing the
 *     number up in review. Fixing one goes red too, demanding the number come
 *     down. That is the only assertion here that a per-file verdict does not
 *     already imply, and it is the only one that RESTRAINS rather than records.
 *
 * WHAT IT STILL CANNOT DO: it cannot tell whether a `smoke` or `elsewhere` claim
 * is true in substance — only that the file named is real. That residue is
 * deliberate and is the reason the verdicts carry prose. A check that pretended
 * to verify the claim would be the same false comfort in a new place.
 *
 * (It is named `*smoke*` because the agent that wrote it owns that filename
 * pattern in this package. It is a ledger, not a smoke test.)
 */
import {readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const TEST_DIR = new URL('.', import.meta.url).pathname

/**
 * What makes a test file REAL.
 *
 * Deliberately syntactic and deliberately generous: a file that so much as
 * imports `node:fs` is out of scope here, because the failure mode this ledger
 * chases is the file that touches NOTHING outside its own imports. A file that
 * reaches a filesystem, a socket or a process has, at minimum, had the
 * opportunity to be wrong about the outside world.
 */
const REAL_MARKERS =
  /from '(?:node:fs|node:fs\/promises|node:child_process|node:http|node:https|node:net|node:tls|node:worker_threads)'|createServer\(|startOverlayApiServer|FsOverlayStore|FsOverlayAssetStore/

function testFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((entry) => entry.endsWith('.test.ts'))
    .sort()
}

function isReal(file: string): boolean {
  return REAL_MARKERS.test(readFileSync(join(TEST_DIR, file), 'utf8'))
}

/* ═══════════════════════════════════════════════════════════ the ledger */

type Seam = 'smoke' | 'elsewhere' | 'partial' | 'blind'

interface WiringEntry {
  seam: Seam
  /** A REAL test file that covers the seam. Required unless `seam: 'blind'`. */
  where?: string
  /** One line. What the pure test proves, and what is left over. */
  note: string
}

/**
 * Pure tests over pure functions. Correct as they are; no seam is owed.
 *
 * The rule for membership: everything the file imports is `sanity-overlay-core`
 * or `sanity-overlay-query` (the two dependency-free decision packages), or the
 * file drives a §0.6 spike fixture that ships to nobody.
 */
const PURE_LOGIC: readonly string[] = [
  'checkpoint-format.test.ts',
  'core-conflict-persistence.test.ts',
  'core-dmp-unicode.test.ts',
  'core-invariants.test.ts',
  'core-overlay-heads.test.ts',
  'core-properties.test.ts',
  'core-prototype-writes.test.ts',
  'core-r5-supersession.test.ts',
  'core-read-batch.test.ts',
  'core-record-from-intent.test.ts',
  'core-serializer-golden.test.ts',
  'core-w1.test.ts',
  'core-w2-merge-integration.test.ts',
  'core-w2.test.ts',
  'core-w3-arrays.test.ts',
  'core-w3-merge.test.ts',
  'core-w3-perspectives.test.ts',
  'core-w3-rebase.test.ts',
  'core-w3-resolution.test.ts',
  'core-w4-integrity.test.ts',
  'core-w4-migration.test.ts',
  'core-w4-references.test.ts',
  'core-w4-validation.test.ts',
  'core-w5-memory.test.ts',
  'mutation-gaps.test.ts',
  'offline-parity.test.ts',
  'query-address-space.test.ts',
  'query-boundedness.test.ts',
  'query-parity.test.ts',
  'query-pushdown.test.ts',
  'query-registry.test.ts',
  'spike-a-read-queries.test.ts',
  'spike-c-boundedness.test.ts',
  'spike-c-parity.test.ts',
  'spike-d-schema.test.ts',
]

/**
 * Pure tests whose subject is WIRING. Each one owes an answer to: "where is the
 * seam this file stops short of actually exercised?"
 */
const WIRING: Readonly<Record<string, WiringEntry>> = {
  'ci-github.test.ts': {
    seam: 'blind',
    note:
      'PR comment + status decisions against a recording client. Real GitHub is unreachable from ' +
      'this repository BY DESIGN (§39.2 D14: no fork secrets), so the delivery boundary can never ' +
      'be crossed here; `ci-repo-gates.test.ts` proves the workflow invokes it, nothing proves ' +
      'GitHub accepts it.',
  },
  'cli-diff.test.ts': {
    seam: 'elsewhere',
    where: 'cli-runner.test.ts',
    note: 'diff rendering over a fixture; the CLI is spawned as a real process there.',
  },
  'codemod-client-imports.test.ts': {
    seam: 'elsewhere',
    where: 'ci-repo-gates.test.ts',
    note: 'a text transform; the seam is "CI runs it in check mode", which is asserted on the real workflow files.',
  },
  'next-translate.test.ts': {
    seam: 'elsewhere',
    where: 'next-commit.test.ts',
    note: 'intercepted-write translation; the real API applies the same translation over a real store there, and again in the smoke boot.',
  },
  'preview-write-guard.test.ts': {
    seam: 'blind',
    note:
      'the guard\'s classification is exhaustive; nothing boots a DEPLOYED preview bundle and ' +
      'checks the guard is installed in it. `preview-write-impossibility.test.ts` reasons about the ' +
      'threat model and `origin-safety.test.ts` covers the server half, but the browser-bundle ' +
      'installation is unreachable without a real deployment.',
  },
  'query-live-bypass.test.ts': {
    seam: 'blind',
    note:
      '`client.live` bypass, asserted against a hand-built client. The smoke boot wraps a real ' +
      '@sanity/client but never subscribes to a live channel — a live subscription needs a Content ' +
      'Lake, and this suite may not talk to one.',
  },
  'studio-actions.test.ts': {
    seam: 'smoke',
    where: 'studio-boot-smoke.test.ts',
    note: '§21.10 availability filter; the smoke boot resolves the REAL config and pins that `schedule` is gone and the built-ins are not.',
  },
  'studio-banner.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note:
      'the smoke boot proves the layout is INSTALLED on the real workspace and that the runtime it ' +
      'reads reports the revision `/state` reports. Rendering it is blind: a React component needs ' +
      'a renderer and this package has no DOM environment.',
  },
  'studio-config.test.ts': {
    seam: 'smoke',
    where: 'studio-boot-smoke.test.ts',
    note: 'the wrapper\'s decisions; the smoke boot imports the real config file and resolves it through sanity 6.8.0\'s own reducer.',
  },
  'studio-conflict-panel-ui.test.ts': {
    seam: 'blind',
    note:
      'the panel controller, handed a runtime. The smoke boot proves the CHANNEL is live (a real ' +
      '`/state` carries `conflicts`), but nothing drives a real hard conflict from a real API into ' +
      'the panel — producing one over HTTP needs two divergent writers, which no test does yet.',
  },
  'studio-conflict-panel.test.ts': {
    seam: 'blind',
    note: 'pure §28.2/§28.3 decisions; same missing seam as `studio-conflict-panel-ui.test.ts`.',
  },
  'studio-conflicts.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note:
      '`readConflictReport` over a hand-written body. The smoke boot pins that a REAL `/state` ' +
      'carries a `conflicts` field and that the runtime reads it as "available" — the §5.5 ' +
      'distinction between "none" and "not reported". A non-empty report is still blind.',
  },
  'studio-devtools.test.ts': {
    seam: 'smoke',
    where: 'studio-boot-smoke.test.ts',
    note: 'the view, handed a runtime; the smoke boot proves the real config installs `__SANITY_OVERLAY__` and that it agrees with an independent `/state`.',
  },
  'studio-doc-existence.test.ts': {
    seam: 'elsewhere',
    where: 'studio-reference-validation.test.ts',
    note:
      'the `/data/doc` existence probe against a hand-built client, read through six transcribed ' +
      'consumers. The seam — does sanity 6.8.0 actually route the question here, and does the ' +
      'answer change what validation concludes — is driven for real there: the real ' +
      '`createDocumentPreviewStore` over the real `@sanity/client`, a real overlay API and a ' +
      'loopback lake over real HTTP.',
  },
  'studio-document-action-delivery.test.ts': {
    seam: 'smoke',
    where: 'studio-boot-smoke.test.ts',
    note:
      'the same transcribed resolver, but over a config this file writes and a stub fetch. The ' +
      'smoke boot runs it over the real `examples/kitchen-sink/sanity.config.ts` and a real API.',
  },
  'studio-echo-supersession.test.ts': {
    seam: 'partial',
    where: 'action-echo.test.ts',
    note:
      '§18.2 R5 through the echo: hydration seeding, the pair-snapshot tap and the publish ' +
      'frame all refuse the superseded base draft. Found live 2026-08-11 in a real browser ' +
      'over the real parity dataset; the companion file drives the same echo through a real ' +
      'overlay server on disk, and e2e/specs/local/04-document-actions.spec.ts drives publish ' +
      'in a real pane.',
  },
  'studio-echo.test.ts': {
    seam: 'partial',
    where: 'action-echo.test.ts',
    note:
      'listener-frame construction. The smoke boot proves an echoed write lands in the overlay on ' +
      'disk; nothing delivers a frame into a real Studio pane, which needs a renderer.',
  },
  'studio-echo-refusals.test.ts': {
    seam: 'partial',
    where: 'studio-branch-created-consistency.test.ts',
    note:
      'every path where the echo declines to build a frame, and that each one refuses visibly ' +
      'and asks the pane to re-read rather than parking it on "Saving…". The companion file ' +
      'drives the same echo through a REAL overlay server on disk and asks the REAL ' +
      '@sanity/mutator whether the pane settled; what is left over is the renderer.',
  },
  'studio-facade-capability-escape.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note:
      'namespace refusals against a hand-built client. The smoke boot wraps a REAL @sanity/client ' +
      'and proves a patch never reaches the base host; the exotic namespaces are still only ' +
      'exercised against a double.',
  },
  'studio-facade.test.ts': {
    seam: 'partial',
    where: 'spike-a-client-identity.test.ts',
    note: 'identity stability and method wrapping; the 20 000-render pin is real-HTTP there, the write plane is real in the smoke boot.',
  },
  'studio-features.test.ts': {
    seam: 'smoke',
    where: 'studio-boot-smoke.test.ts',
    note: 'the flag values; the smoke boot pins that the real workspace carries them.',
  },
  'studio-findability.test.ts': {
    seam: 'elsewhere',
    where: 'origin-findability.test.ts',
    note: 'search/findability plans; the same questions are asked of a real origin server over HTTP there.',
  },
  'studio-history-endpoints.test.ts': {
    seam: 'partial',
    where: 'origin-boot.test.ts',
    note: 'history reads through the facade, asserted with sanity 6.8.0 readers transcribed from the pinned dist; the real origin is driven over a socket there but only for status, so the NDJSON translog contract is still unenforced end to end.',
  },
  'studio-guard-refusals.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note: 'refusal classification; the smoke boot proves the guard lets an ordinary branch edit through and keeps it off the base host. Refusal PATHS are still doubles.',
  },
  'studio-live-bypass.test.ts': {
    seam: 'blind',
    note: 'same missing seam as `query-live-bypass.test.ts`: no real live channel exists to bypass.',
  },
  'studio-operations.test.ts': {
    seam: 'elsewhere',
    where: 'studio-operations-e2e.test.ts',
    note: '`planRebase`/`planCheckpoint` decisions; both are driven onto a real store over real HTTP there and again in the smoke boot.',
  },
  'studio-options.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note:
      'exhaustive option resolution. The smoke boot resolves options from a real environment for ' +
      'the `fs` + `apiUrl` + `apiHost` path only; the refusal paths (write token present, blob ' +
      'mode, Sanity apiHost) are pure-only, which is correct — they throw before anything boots.',
  },
  'studio-plan-boundedness.test.ts': {
    seam: 'elsewhere',
    where: 'perf-budgets.test.ts',
    note: 'plan-size bounds; measured against a real store and a real API there.',
  },
  'studio-reads-facade.test.ts': {
    seam: 'elsewhere',
    where: 'studio-read-paths.test.ts',
    note: 'GROQ through the facade; the two read paths are compared against a real overlay over HTTP there.',
  },
  'studio-reads-overlay.test.ts': {
    seam: 'elsewhere',
    where: 'studio-read-paths.test.ts',
    note:
      'overlay read planning. The smoke boot additionally covers the OTHER read path — the pair ' +
      'listener\'s `getDocuments` — which is the one the original defect used.',
  },
  'studio-references.test.ts': {
    seam: 'blind',
    note:
      '§21.6 incoming-reference plans. Nothing drives a real delete against a real overlay holding ' +
      'a branch-created referrer, so the combined base-plus-overlay read is never actually issued.',
  },
  'studio-status.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note: 'status derivation; the smoke boot pins `healthy` for a real, reachable overlay. The degraded states are pure-only.',
  },
  'studio-strict-queries.test.ts': {
    seam: 'blind',
    note:
      'strict-mode refusals. The smoke boot runs the shipped default (warn), so no test boots a ' +
      'real Studio with `strictQueries: true` — which is the setting a deployed preview would use.',
  },
  'studio-surface.test.ts': {
    seam: 'elsewhere',
    where: 'studio-install.test.ts',
    note: 'the barrel\'s exports; resolution from outside the monorepo is checked for real there and in `pack-install.test.ts`.',
  },
  'studio-transport.test.ts': {
    seam: 'smoke',
    where: 'studio-boot-smoke.test.ts',
    note: 'transport over an injected fetch; the smoke boot drives the same transport over a real socket.',
  },
  'studio-write-guard.test.ts': {
    seam: 'elsewhere',
    where: 'proxy-cors.test.ts',
    note: 'endpoint classification; the enforcement boundary is the proxy, and the proxy suite runs the guard behind a real server.',
  },
  /*
   * `write-guard.test.ts` USED TO BE HERE, and this note is why it is not.
   *
   * It was classified `elsewhere` on the grounds that the guard is a pure
   * predicate over a request line. That stopped being the whole file when the
   * derived completeness check was added: it enumerates every `/data/<op>` out
   * of the SHIPPED `sanity@6.8.0` dist, so the suite now reads the filesystem
   * and its denominator is a real installed package rather than a list. This
   * ledger noticed before anyone did — "these grew a real filesystem/socket/
   * store — good news; remove them from the ledger" — which is the whole point
   * of it, so the entry is removed rather than the check weakened.
   *
   * The enforcement seam is unchanged and still covered: `proxy-cors.test.ts`
   * runs the same guard behind a real proxy, and `origin-referring-documents.test.ts`
   * drives the `/data/references` case through a real server with a real client.
   */
  'listener-matrix.test.ts': {
    seam: 'blind',
    note:
      'the §21.4.1 five criteria over a simulated listener. No real listener stream is ever ' +
      'subscribed to — that needs a Content Lake, which this suite may not reach.',
  },
  'spike-a-auth-flows.test.ts': {
    seam: 'blind',
    note: 'the auth-failure/logout protocol over a simulated session; no real 401 from a real host is ever observed.',
  },
  'spike-a-facade-gaps.test.ts': {
    seam: 'partial',
    where: 'studio-boot-smoke.test.ts',
    note: 'the Spike F escape classes against a hand-built client; the smoke boot exercises the same facade wrapping a real one.',
  },
  'testkit-barrel.test.ts': {
    seam: 'elsewhere',
    where: 'ci-repo-gates.test.ts',
    note: 'the testkit\'s own public surface; every real test in this package consumes it, so a broken barrel takes the suite down before this file speaks.',
  },
}

/**
 * How many `blind` seams the suite is allowed to carry. THE RATCHET.
 *
 * Exact, not an upper bound, and that is the point: adding a blind seam goes red
 * because the count rose, and CLOSING one goes red because it fell. The second
 * direction is not pedantry — it is what makes the number stay honest instead of
 * drifting into a ceiling nobody has approached in a year.
 */
const BLIND_BUDGET = 10

/* ═══════════════════════════════════════════════════════════ the checks */

describe('every pure test file is classified, and every wiring seam is accounted for', () => {
  const files = testFiles()
  const pure = files.filter((file) => !isReal(file))
  const classified = new Set([...PURE_LOGIC, ...Object.keys(WIRING)])

  it('classifies every pure test file — a new one cannot arrive unnoticed', () => {
    const unclassified = pure.filter((file) => !classified.has(file))
    expect(
      unclassified,
      unclassified.length === 0
        ? ''
        : `\n\nThese test files are PURE — they touch no filesystem, no socket and no store — and ` +
          `nobody has said what they are for.\n\n` +
          unclassified.map((file) => `  ${file}`).join('\n') +
          `\n\nAdd each one to exactly one list in ${'`test/pure-wiring-ledger-smoke.test.ts`'}:\n\n` +
          `  PURE_LOGIC  — it tests a pure function (core / query decisions). Nothing more is owed.\n` +
          `  WIRING      — it tests composition, transport, delivery or a cross-module contract.\n` +
          `                Then say where that seam is covered for real:\n` +
          `                  {seam: 'smoke'|'elsewhere'|'partial', where: '<a REAL test file>', note: '…'}\n` +
          `                  {seam: 'blind', note: 'why nothing covers it'}   ← counts against BLIND_BUDGET\n\n` +
          `Read the header of this file before choosing. The five browser defects of 2026-08-06 ` +
          `were all "pure test, wiring subject, nothing real anywhere".`,
    ).toEqual([])
  })

  it('carries no stale entries — every classified file still exists and is still pure', () => {
    const missing = [...classified].filter((file) => !files.includes(file)).sort()
    expect(missing, 'classified but no longer present; delete the entry').toEqual([])

    const nowReal = [...classified].filter((file) => files.includes(file) && isReal(file)).sort()
    expect(
      nowReal,
      'these grew a real filesystem/socket/store — good news; remove them from the ledger',
    ).toEqual([])
  })

  it('never discharges a wiring seam by pointing at another PURE test', () => {
    /* THE ASSERTION THAT IS NOT A COMMENT. "Covered elsewhere" is exactly the
     * claim the five defects were killed by, so it is the one claim checked
     * mechanically: the file named must exist and must itself be real. */
    for (const [file, entry] of Object.entries(WIRING)) {
      if (entry.seam === 'blind') {
        expect(entry.where, `${file}: a blind seam names nowhere`).toBeUndefined()
        expect(entry.note.length, `${file}: a blind seam owes a reason`).toBeGreaterThan(40)
        continue
      }
      expect(entry.where, `${file}: seam "${entry.seam}" must name where it is covered`).toBeDefined()
      const where = entry.where as string
      expect(files, `${file}: names ${where}, which does not exist`).toContain(where)
      expect(isReal(where), `${file}: names ${where}, which is itself a PURE test`).toBe(true)
    }
  })

  it('holds the blind seams to their budget, in both directions', () => {
    const blind = Object.entries(WIRING)
      .filter(([, entry]) => entry.seam === 'blind')
      .map(([file]) => file)
      .sort()
    expect(
      blind.length,
      `\n\nBlind wiring seams:\n${blind.map((file) => `  ${file}`).join('\n')}\n\n` +
        `BLIND_BUDGET is ${BLIND_BUDGET}. If this went UP you added a wiring test with nothing real ` +
        `behind it — cover the seam instead, or argue the number up in review. If it went DOWN you ` +
        `closed one: lower the budget in the same commit, so the ratchet holds.`,
    ).toBe(BLIND_BUDGET)
  })

  it('is not vacuous — the classifier really does separate the suite', () => {
    /* A ledger that classified everything as pure, or nothing, would satisfy
     * every assertion above. These pin that both sides are populated and that
     * the REAL detector actually fires. */
    expect(pure.length).toBeGreaterThan(20)
    expect(files.length - pure.length).toBeGreaterThan(20)
    expect(isReal('studio-boot-smoke.test.ts')).toBe(true)
    expect(isReal('core-w3-merge.test.ts')).toBe(false)
    expect(Object.keys(WIRING).length).toBeGreaterThan(20)
  })
})
