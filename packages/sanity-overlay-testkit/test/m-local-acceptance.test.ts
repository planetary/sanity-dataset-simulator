/**
 * `[M-LOCAL]` ACCEPTANCE (PRD §38.1), MEASURED RATHER THAN ASSERTED.
 *
 * ==========================================================================
 * WHY THIS IS A TEST AND NOT (ANOTHER) AUDIT DOCUMENT
 *
 * There is already an audit document:
 * `docs/plans/evidence/phase-3/acceptance-audit.md`, dated 2026-08-06, verdict
 * *6 met · 3 partially met · 1 not met*. It is careful work and it is now
 * materially STALE, in the specific way a document always goes stale — silently,
 * while staying quotable. Two of the four blockers it named have been fixed and
 * the file cannot know:
 *
 *   - It found line 1 "not implemented as written — the read client reads
 *     `SANITY_OVERLAY_MODE`, not PRD §11.2's `OVERLAY_MODE`".
 *     `sanity-overlay-client/src/env.ts:122` now reads
 *     `overlayEnvValue(env, 'OVERLAY_MODE')`, which accepts all three
 *     spellings. Measured below.
 *   - It found line 9 "never observed through git — `.gitignore` ignores
 *     `.sanity-overlay/` repo-wide; nothing under it is tracked; no test invokes
 *     git". `.gitignore:11` now says `.sanity-overlay/` is COMMITTED,
 *     deliberately, and `git-diff.test.ts` carries a `§38.1 the diff is
 *     deterministic` block that shells out to real `git`. Measured below.
 *
 * So the artefact for an acceptance list is the same thing this repository
 * already decided for the upgrade baseline: a ledger that RE-DERIVES its claims
 * from the tree and fails when they stop being true. Specifically:
 *
 *   §1  the ledger is about the PRD's ACTUAL list — §38.1 is parsed out of
 *       `docs/PRD-v1.md` and must match this file line for line, so an edit to
 *       either side is a red test rather than a silent divergence;
 *   §2  every artefact a verdict rests on exists, at the path named;
 *   §3  a `met` verdict has to name something that measures it, and a `partial`
 *       has to say what is missing — a checkbox with no evidence and no stated
 *       gap cannot be spelled in this file at all.
 *
 * ==========================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not SIGN `[M-LOCAL]`, and no test can. The 2026-08-06 audit's first
 * blocker is a process rule, not a code fact — PRD §0.3 "the project does not
 * enter full implementation until all six gates pass", with Gate E partial and
 * Gates C and F not started (`docs/plans/evidence/phase-1/gate-review.md`) —
 * and §0.6 still wants one human validation of the real Studio workflow.
 * Those are owner rulings. This file answers the narrower question that is
 * actually measurable: for each acceptance line, IS THERE EVIDENCE, WHERE, AND
 * WHAT IS STILL MISSING.
 */
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/* ------------------------------------------------------------------ *
 * The ledger, as data
 * ------------------------------------------------------------------ */

type Verdict =
  /** Evidence exists, at a layer that could have failed, for the whole line. */
  | 'met'
  /** Evidence exists for part of it; `missing` says what is not covered. */
  | 'partial'

interface AcceptanceEntry {
  /** The PRD line, VERBATIM. §1 below re-parses §38.1 and demands equality. */
  line: string
  verdict: Verdict
  /** Repo-relative paths whose tests measure it. Every one is checked to exist. */
  measuredBy: readonly string[]
  /** Why the verdict is what it is — the reasoning, not a restatement. */
  why: string
  /** Required on `partial`, forbidden on `met`: what evidence is absent. */
  missing?: string
}

export const M_LOCAL_ACCEPTANCE: readonly AcceptanceEntry[] = Object.freeze([
  {
    line: '`OVERLAY_MODE=fs` works with live staging base.',
    verdict: 'partial',
    measuredBy: [
      'packages/sanity-overlay-client/src/env.ts',
      'packages/sanity-overlay-testkit/test/client-modes.test.ts',
      'e2e/specs/live/01-staging-untouched.spec.ts',
    ],
    why:
      'The spelling half is now met and was the 2026-08-06 blocker: `env.ts` resolves the setting ' +
      'through `overlayEnvValue(env, "OVERLAY_MODE")`, which accepts PRD §11.2\'s bare spelling ' +
      'alongside `SANITY_OVERLAY_MODE` and the `SANITY_STUDIO_` prefix a Vite bundle can see. The ' +
      'BASE half is not: `E2E_MODE=local` is Mode 2, where the overlay root IS the dataset and ' +
      'there is no staging to read.',
    missing:
      'a run of the product path against a LIVE staging base. `specs/live/` is written for exactly ' +
      'this and is credential-gated (`SANITY_API_READ_TOKEN`), so it skips rather than asserts on ' +
      'any machine without a token — which is every machine in CI today.',
  },
  {
    line: 'Existing document can be edited.',
    verdict: 'partial',
    measuredBy: [
      'packages/sanity-overlay-testkit/test/core-w3-merge.test.ts',
      'e2e/specs/live/01-staging-untouched.spec.ts',
      'e2e/specs/local/02-edit-persists.spec.ts',
    ],
    why:
      '"Existing" means a document the BASE already holds, so the branch has something to override. ' +
      'The merge semantics are covered at the unit layer over a real base corpus; the browser half ' +
      'needs a Studio whose world contains a base document, which Mode 2 does not have. ' +
      '`02-edit-persists.spec.ts` proves the edit path itself against a branch-created document.',
    missing:
      'the same browser assertion over a BASE document. It exists in `specs/live/` (`the branch ' +
      'title is what the Studio shows, while the dataset still says otherwise`) and is ' +
      'credential-gated.',
  },
  {
    line: 'New document can be created.',
    verdict: 'met',
    measuredBy: [
      'e2e/specs/local/02-edit-persists.spec.ts',
      'e2e/specs/local/06-list-panes.spec.ts',
      'e2e/specs/local/09-branch-visibility.spec.ts',
    ],
    why:
      'Created through the real form, asserted on the disk rather than on the pane, and asserted ' +
      'again through a surface that reads it back — the list pane, which is where the 2026-08-05 ' +
      '"empty structure list" defect lived and is the reason a create test that only checks ' +
      '`intent.json` is not enough.',
  },
  {
    line: 'Draft and branch publish work.',
    verdict: 'met',
    measuredBy: [
      'e2e/specs/local/04-document-actions.spec.ts',
      'packages/sanity-overlay-testkit/test/studio-document-action-delivery.test.ts',
    ],
    why:
      'Both halves are driven through the real document action: `publish moves the value onto the ' +
      'published layer` reads the published override off disk, and `a document action in a NEW ' +
      'page load is not replayed away` covers the idempotency-ledger defect that made a second ' +
      'publish report success while writing nothing.',
  },
  {
    line: 'Delete uses tombstone.',
    verdict: 'met',
    measuredBy: [
      'e2e/specs/local/04-document-actions.spec.ts',
      'e2e/specs/local/06-list-panes.spec.ts',
      'e2e/specs/local/08-local-site.spec.ts',
      'packages/sanity-overlay-testkit/test/site-branch-tombstone-over-base.test.ts',
    ],
    why:
      'Four surfaces, and the line is specifically that the record SURVIVES: `04` asserts the ' +
      'tombstone lands and the file is still there, `06` that the pane drops it, `08` that the ' +
      'consumer site 404s it on the branch WHILE the staging view still serves the same slug — ' +
      'the differential that stops a broken site passing as a suppression.',
  },
  {
    line: 'Basic reference dereference works.',
    verdict: 'met',
    measuredBy: [
      'e2e/specs/local/09-branch-visibility.spec.ts',
      'packages/sanity-overlay-testkit/test/studio-reference-validation.test.ts',
      'packages/sanity-overlay-testkit/test/studio-doc-existence.test.ts',
    ],
    why:
      'Reference RESOLUTION is measured in three positions that disagree with each other unless it ' +
      'is right: the picker finds a branch document and the reference it sets reaches disk; a ' +
      'strong reference to a branch-created document validates while one to a branch-DELETED ' +
      'document does not; and a reference to an id nothing holds still fails. The last two are the ' +
      'controls — without them "validates" could be validation being off.',
  },
  {
    line: 'Registered ID and slug queries work.',
    verdict: 'met',
    measuredBy: [
      'packages/sanity-overlay-testkit/test/query-registry.test.ts',
      'packages/sanity-overlay-testkit/test/lint-unregistered-queries.test.ts',
      'packages/sanity-overlay-testkit/test/studio-strict-queries.test.ts',
      'packages/sanity-overlay-testkit/test/query-parity.test.ts',
    ],
    why:
      'The registry is enforced rather than described: unregistered queries are linted against the ' +
      'source, the registry manifest is checksum-pinned, and parity is decided by `groq-js` ' +
      'evaluating the same query over the same corpus rather than by an expected value written by ' +
      'hand.',
  },
  {
    line: 'Studio writes canonical files.',
    verdict: 'met',
    measuredBy: [
      'packages/sanity-overlay-testkit/test/git-diff.test.ts',
      'packages/sanity-overlay-testkit/test/store-fs.test.ts',
      'e2e/specs/local/02-edit-persists.spec.ts',
    ],
    why:
      'THE 2026-08-06 CAVEAT IS ANSWERED, AND PART OF IT WAS A CATEGORY ERROR. That audit graded ' +
      'this line down because the committed manifest names `spike-a-studio` and `overlay-local-api` ' +
      'as its writers, "neither of which is `sanity-overlay-studio`". In this topology the Studio ' +
      'never writes a file: the facade POSTs `/commit` and the overlay API writes the tree, so ' +
      '`overlay-local-api` is the CORRECT writer and its presence is not evidence of the spike ' +
      'path. What distinguishes the two is the banner — it renders only when `defineOverlayConfig` ' +
      'registered a runtime — and every E2E spec waits for it before doing anything, so all 58 ' +
      'passing specs are product-path runs. Canonicality itself is decided by the store\'s own ' +
      'serialiser tests and by git.',
  },
  {
    line: 'Git diff is deterministic.',
    verdict: 'met',
    measuredBy: ['packages/sanity-overlay-testkit/test/git-diff.test.ts'],
    why:
      'THE OTHER 2026-08-06 BLOCKER, NOW RESOLVED. It read "`.gitignore:10` ignores ' +
      '`.sanity-overlay/` repo-wide; nothing under it is tracked; no test invokes git". Both facts ' +
      'have moved: `.gitignore:11` now states that `.sanity-overlay/` is COMMITTED deliberately, ' +
      'and `git-diff.test.ts` shells out to real `git` (`execFileSync`) under a `§38.1 the diff is ' +
      'deterministic` heading, with a separate block isolating where wall-clock noise may and may ' +
      'not land.',
  },
  {
    line: 'Staging cannot be mutated.',
    verdict: 'partial',
    measuredBy: [
      'packages/sanity-overlay-testkit/test/no-staging-writes.test.ts',
      'packages/sanity-overlay-testkit/test/write-guard.test.ts',
      'packages/sanity-overlay-testkit/test/preview-write-guard.test.ts',
      'e2e/specs/local/07-guard-403.spec.ts',
      'e2e/specs/local/99-network-audit.spec.ts',
      'e2e/specs/live/01-staging-untouched.spec.ts',
    ],
    why:
      'The strongest local form is structural rather than asserted: `E2E_MODE=local` runs Chromium ' +
      'with `--host-resolver-rules=MAP *.sanity.io ~NOTFOUND`, so a direct write is not refused, it ' +
      'is UNROUTABLE — and the Studio still boots and edits still land, which no page-side listener ' +
      'could establish. On top of that sit two independent guard implementations under one ' +
      'contract, a suite-level outbound-request monitor that is deliberately not a copy of the ' +
      'guard, and a server-side audit of the proxy log.',
    missing:
      '"staging is untouched" asserted AGAINST THE UPSTREAM API — a byte-comparison of the real ' +
      'dataset before and after an edit session. That is what `specs/live/` is for, and it is ' +
      'credential-gated. In `local` mode the claim is true by construction because there is no ' +
      'staging at all, which is a different and weaker statement than the acceptance line makes.',
  },
])

/* ------------------------------------------------------------------ *
 * §1 — the ledger is about the PRD's actual list
 * ------------------------------------------------------------------ */

/**
 * §38.1's checkbox lines, read out of the PRD.
 *
 * The heading is matched exactly and the list is taken up to the next heading,
 * so a line added to §38.1 lands in this array without anyone remembering to
 * come here.
 */
function prdAcceptanceLines(): string[] {
  const prd = readFileSync(join(REPO, 'docs/PRD-v1.md'), 'utf8')
  const start = prd.indexOf('### 38.1 Local MVP')
  if (start === -1) throw new Error('PRD §38.1 heading not found — the anchor moved')
  const rest = prd.slice(start)
  const end = rest.indexOf('\n### ', 1)
  const section = end === -1 ? rest : rest.slice(0, end)
  return section
    .split('\n')
    .filter((line) => line.startsWith('- [ ] ') || line.startsWith('- [x] '))
    .map((line) => line.slice('- [ ] '.length).trim())
}

describe('§1 the ledger and PRD §38.1 are the same list', () => {
  it('names every acceptance line the PRD does, in order and verbatim', () => {
    /* Both directions at once. A line added to the PRD shows up as a missing
     * entry; a line invented here shows up as an extra one; and a reworded PRD
     * line fails on the text rather than silently re-pointing an old verdict at
     * a new requirement. */
    expect(M_LOCAL_ACCEPTANCE.map((entry) => entry.line)).toEqual(prdAcceptanceLines())
  })

  it('finds a §38.1 list at all — the parser is not vacuous', () => {
    /* An anchor that stopped matching would make the assertion above compare two
     * empty arrays and pass. */
    expect(prdAcceptanceLines().length).toBe(10)
  })
})

/* ------------------------------------------------------------------ *
 * §2 — every artefact a verdict rests on exists
 * ------------------------------------------------------------------ */

describe('§2 the evidence named by each verdict is really there', () => {
  it.each(M_LOCAL_ACCEPTANCE.map((entry) => [entry.line, entry] as const))(
    '%s',
    (_line, entry) => {
      expect(entry.measuredBy.length).toBeGreaterThan(0)
      for (const relative of entry.measuredBy) {
        expect(`${relative}: ${existsSync(join(REPO, relative))}`).toBe(`${relative}: true`)
      }
    },
  )

  /**
   * THE TRAP THIS EXISTS FOR, and it is the one an acceptance list is most
   * likely to fall into.
   *
   * `e2e/specs/live/**` is credential-gated: `test.skip(!liveCredentialsAvailable())`
   * at the top of the file means that on any machine without
   * `SANITY_API_READ_TOKEN` — which is every CI machine today — those specs
   * report as SKIPPED, not failed. A `met` verdict resting only on them would
   * therefore be green everywhere while asserting nothing anywhere.
   *
   * So `live/` may support a verdict, never carry one alone. A line whose only
   * evidence is gated is by definition `partial`, and this is the check that
   * makes that spelling compulsory rather than remembered.
   */
  it('no `met` verdict rests only on credential-gated evidence', () => {
    const gatedOnly = M_LOCAL_ACCEPTANCE.filter(
      (entry) =>
        entry.verdict === 'met' &&
        entry.measuredBy.every((relative) => relative.startsWith('e2e/specs/live/')),
    )
    expect(gatedOnly.map((entry) => entry.line)).toEqual([])

    /* The denominator: `live/` really is gated, so the rule above is about
     * something. Read out of the spec rather than assumed. */
    const liveSpec = readFileSync(join(REPO, 'e2e/specs/live/01-staging-untouched.spec.ts'), 'utf8')
    expect(liveSpec).toMatch(/test\.skip\(\s*!liveCredentialsAvailable\(\)/)
  })

  it('every named artefact is tracked by git, or is named as new in this tree', () => {
    /*
     * A verdict resting on a file nobody else has is a verdict nobody else can
     * reproduce, so the oracle is git's own index. Untracked-but-present is
     * legitimate exactly once — while a change is still uncommitted — and the
     * honest way to encode that is to make the exceptions ENUMERATED rather
     * than excused: a file may be untracked only if this list names it, so the
     * list has to be emptied when the work is committed.
     */
    const tracked = new Set(
      execFileSync('git', ['ls-files'], {cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
        .split('\n')
        .filter((line) => line !== ''),
    )
    expect(tracked.size).toBeGreaterThan(100)

    /** Added 2026-08-10, not yet committed. Empty this when the batch lands. */
    const NEW_IN_THIS_TREE: readonly string[] = [
      'e2e/specs/local/09-branch-visibility.spec.ts',
      'packages/sanity-overlay-testkit/test/site-branch-tombstone-over-base.test.ts',
      'packages/sanity-overlay-testkit/test/studio-reference-validation.test.ts',
      'packages/sanity-overlay-testkit/test/studio-doc-existence.test.ts',
    ]

    const untracked = M_LOCAL_ACCEPTANCE.flatMap((entry) =>
      entry.measuredBy.filter((relative) => !tracked.has(relative)),
    )
    expect(untracked.filter((relative) => !NEW_IN_THIS_TREE.includes(relative))).toEqual([])
    /* …and the exception list cannot outlive its reason: an entry that IS now
     * tracked has to be removed from it. */
    expect(NEW_IN_THIS_TREE.filter((relative) => tracked.has(relative))).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * §3 — a verdict cannot be spelled without its reasoning
 * ------------------------------------------------------------------ */

describe('§3 the ledger cannot record an empty claim', () => {
  it('every `partial` says what is missing, and every `met` claims nothing is', () => {
    for (const entry of M_LOCAL_ACCEPTANCE) {
      if (entry.verdict === 'partial') {
        expect(`${entry.line}: has a stated gap`).toBe(
          entry.missing !== undefined && entry.missing.length > 60
            ? `${entry.line}: has a stated gap`
            : `${entry.line}: MISSING a stated gap`,
        )
      } else {
        /* A `met` row carrying a `missing` note is a `partial` mislabelled. */
        expect(`${entry.line}: ${entry.missing === undefined}`).toBe(`${entry.line}: true`)
      }
    }
  })

  it('every entry gives reasoning, not a restatement of the line', () => {
    for (const entry of M_LOCAL_ACCEPTANCE) {
      expect(entry.why.length).toBeGreaterThan(120)
      expect(entry.why).not.toBe(entry.line)
    }
  })

  it('reports the standing count, so a change of verdict is a change of diff', () => {
    /* Not a target. The number is here so that moving a row from `partial` to
     * `met` cannot happen without editing a line that says so out loud. */
    const met = M_LOCAL_ACCEPTANCE.filter((entry) => entry.verdict === 'met').length
    const partial = M_LOCAL_ACCEPTANCE.filter((entry) => entry.verdict === 'partial').length
    expect({met, partial}).toEqual({met: 7, partial: 3})
  })
})

/* ------------------------------------------------------------------ *
 * §4 — Gate E, and the half of it that is not a code fact
 * ------------------------------------------------------------------ */

/**
 * PRD §0.3 Gate E: *"Preview and local environments cannot mutate staging. Fork
 * previews receive no overlay secrets. The trust model for same-repository PR
 * code is explicitly approved."*
 *
 * THREE CLAUSES, AND ONLY ONE OF THEM IS MEASURABLE FROM THIS REPOSITORY.
 * Stating that plainly is the point of this block: `gate-review.md` records
 * Gate E as "partial", and a reader deserves to know WHICH part, rather than
 * discovering it when a deployment is attempted.
 */
const GATE_E_CLAUSES: readonly {
  clause: string
  measurable: boolean
  measuredBy: readonly string[]
  note: string
}[] = Object.freeze([
  {
    clause: 'Preview and local environments cannot mutate staging.',
    measurable: true,
    measuredBy: [
      'packages/sanity-overlay-testkit/test/no-staging-writes.test.ts',
      'packages/sanity-overlay-testkit/test/write-guard.test.ts',
      'packages/sanity-overlay-testkit/test/preview-write-guard.test.ts',
      'packages/sanity-overlay-testkit/test/preview-write-impossibility.test.ts',
    ],
    note:
      'The LOCAL half only. "Preview" here means a deployed Vercel preview, and none exists — ' +
      'there is no Blob storage adapter, no `vercel.json` and no deployed app, so the guard has ' +
      'never run in the environment the clause is about. What is measured is the guard itself, ' +
      'in two independent implementations under one contract, plus the impossibility argument for ' +
      'the preview client.',
  },
  {
    clause: 'Fork previews receive no overlay secrets.',
    measurable: false,
    measuredBy: [],
    note:
      'A property of CI and deployment configuration — which secrets a fork-originated workflow run ' +
      'is granted — and there is no deployment. Nothing in this repository can measure it, and a ' +
      'test that pretended to would be measuring a local YAML file rather than a platform policy.',
  },
  {
    clause: 'The trust model for same-repository PR code is explicitly approved.',
    measurable: false,
    measuredBy: [],
    note:
      'An owner ruling (D14, "trusted-repository with no fork secrets" is the recorded default). ' +
      'Approval is not a code fact and no test can produce it.',
  },
])

describe('§4 Gate E — what this repository can and cannot say', () => {
  it('each measurable clause names evidence that exists', () => {
    for (const clause of GATE_E_CLAUSES) {
      if (!clause.measurable) continue
      expect(clause.measuredBy.length).toBeGreaterThan(0)
      for (const relative of clause.measuredBy) {
        expect(`${relative}: ${existsSync(join(REPO, relative))}`).toBe(`${relative}: true`)
      }
    }
  })

  it('each UNmeasurable clause names no evidence, and says why not', () => {
    /* The failure this prevents is the comfortable one: quietly attaching a
     * local test to a clause about a platform, and reading the green tick as
     * the gate closing. */
    for (const clause of GATE_E_CLAUSES) {
      if (clause.measurable) continue
      expect(`${clause.clause}: ${clause.measuredBy.length}`).toBe(`${clause.clause}: 0`)
      expect(clause.note.length).toBeGreaterThan(80)
    }
  })

  it('reports that Gate E is not closable here, and by how much', () => {
    const measurable = GATE_E_CLAUSES.filter((clause) => clause.measurable).length
    expect({of: GATE_E_CLAUSES.length, measurable}).toEqual({of: 3, measurable: 1})
  })
})
