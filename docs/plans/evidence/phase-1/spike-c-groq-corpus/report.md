# Spike C report — GROQ query corpus (PRD §36.3)

**Date:** 2026-08-03, **materially revised 2026-08-04** · **Status: PASS for correctness; boundedness was NOT proven by the original suite (now fixed)** · **Attempts used:** 1 inventory + 1 planner pass + 1 test-quality repair (bound: 1 + 1 + 1 repair, §36.0) · **Deviation:** ran in the working tree, not an isolated `spike/c-groq-corpus` branch — the repo predates its first commit; waiver recorded.

> **Correction notice (2026-08-04).** A mutation-testing audit found the original parity suite **proved the wrong half of the claim**. Parity against a full-dataset oracle detects *under*-fetching (incompleteness) but is mathematically incapable of detecting *over*-fetching: a planner that loads the entire dataset for every plan type **passed all 463 tests**. The single boundedness assertion (`candidateCount < fullDatasetCount`, one query, one overlay) was too loose to compensate. §22.6's top-K proof — the actual point of the spike — was therefore unverified.
>
> Also unverified: the registry was **self-certifying** (it both defined the tier classification and generated the test list), so any Tier A entry could be downgraded or deleted with zero test signal; and the tombstone fixture covered exactly one article in one perspective.
>
> All fixed — see "Test-quality remediation" below. The correctness findings in this report stand; the efficiency/scalability claim did not, and is now separately evidenced.

## Deliverables

| §36.0 artifact | Location |
|---|---|
| Query registry | `packages/sanity-overlay-testkit/spike-c/registry.ts` — 18 entries: **16 Tier A, 1 Tier B, 1 unsupported** |
| Parity report | This file + test output below |
| Candidate counts | Diagnostics emitted per query; boundedness asserted in test ("top-K plan is genuinely bounded") |
| Tier C list | 1 entry: `unconstrained-star` (`*[]`), registered `unsupported`, structurally rejected |

## Method (§35.10)

- **System under test:** prototype candidate planners (`spike-c/planner.ts`) — `ids`, `slug`, `types`, bounded `top-k` (`baseFetchCount = sliceEnd + affectedCount`, §22.6) + recursive reference expansion (depth ≤ 3), evaluated through pinned `groq-js` 2.0.0.
- **Oracle:** same query over the **full** resolved virtual dataset (base ⊎ overlay, tombstones applied).
- **Overlay fixtures:** empty, filter-change, sort-change (slice membership), branch-create, tombstone, ref-target-change.
- **Matrix:** 17 supported queries × 6 overlays = **102 planner-vs-oracle equality checks**, plus 9 behavioral assertions covering the §35.11 list (filter/sort/slice change, branch-created enters, tombstoned leaves, deref change without parent rewrite, parent membership change, timestamp policy, structured `UNSUPPORTED_GROQ`).
- **Hosted empty-overlay parity:** 13 cases green against project `b1n03q3z` (`v2025-02-19`), published + drafts perspectives, incl. `pt::text`, aggregates, multi-type.

## Results

- **135/135 tests green** (`pnpm --filter sanity-overlay-testkit test`).
- **Mutation check:** deliberately dropping affected-doc handling from the top-K planner → **8 test failures**; restored → green. The suite detects candidate-incompleteness, the failure mode Gate D exists for.
- Latency: trivial at fixture scale (41 docs; full suite < 5 s). Representative-scale latency (§36.3 pass criterion 4) **deferred** until a realistic dataset volume exists — tracked below.

## Pass criteria (§36.3, v1.1)

- [x] Every launch-critical query Tier A or accepted Tier B — all 17 supported queries pass exactly.
- [x] No launch-critical query is Tier C.
- [x] Remaining Tier C below the §0.6 threshold (1 registered, deliberately unsupported, not launch-critical).
- [x] No launch-critical query depends on silent approximation (structured error proven).
- [ ] **Preview latency within budget on representative data — OPEN.** Re-run candidate-count/latency measurement when a representative-scale dataset exists.

## Test-quality remediation (2026-08-04, mutation-driven)

A 14-mutation audit plus 10 follow-up class probes found **9 coverage gaps**. 13 of 14 correctness mutations died fast (control M1 → 6 failures; tombstone-ignoring M4 → 8; overlay-ignoring M7 → 23), confirming the correctness half is genuinely tested. The gaps and their fixes, each proven red under its mutation then green after restore:

| Gap class | Mutation that survived | Fix (139 new tests in `test/mutation-gaps.test.ts`) |
|---|---|---|
| **Boundedness never asserted** | ids / slug+types / top-k planners made **unbounded** — all still passed | Per-plan-type ceilings on `planSelected = candidateCount − referenceExpansions` across all 17 queries × 6 overlays, plus three tight anchors. Red proof: unbounded ids → 6 failures, slug/types → 10, top-k → 4 |
| **Registry self-certifying** | Tier A entry downgraded to `unsupported`, or deleted outright | Inventory pinned: exact Tier A/B/unsupported id sets, count = 18, uniqueness, per-Tier-A executability, matrix size 17 × 6 = 102. Red proof: 6 and 5 failures |
| **Tombstone matrix too narrow** | Tombstones honoured only for `_type === 'article'` | 4 tombstone overlays (article/page/author/mixed) swept across all queries + 8 per-plan-type assertions + full drafts-perspective sweep. Red proof: 10 failures; also broadens M4 from 8 → 30 |

**Suite after remediation: 602 tests, all green** (463 pre-existing + 139 new).

**Residual weakness to watch:** most mutants are killed by exactly one test — there is no redundancy, so a single careless test edit can silently reopen a hole.

## Caveats for gate review

1. Greenfield corpus: 18 queries are the whole inventory by construction. Gate D closes for this corpus; any adopting codebase re-runs the inventory + classification.
2. Planner is spike-grade: published perspective only, materialized-overlay model (no field-level merge — that is Phase 2), reference expansion is naive full-document scan. Do not promote into `packages/` without rewrite (§0.6).
3. `recent-by-created-at` accepted Tier B under `preview-diverges` (§13.9); needs its promotion-order regression test in Phase 6.
