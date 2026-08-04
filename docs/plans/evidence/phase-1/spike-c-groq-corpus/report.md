# Spike C report — GROQ query corpus (PRD §36.3)

**Date:** 2026-08-03 · **Status: PASS** (for the current greenfield corpus; see caveats) · **Attempts used:** 1 inventory + 1 planner pass (bound: 1 + 1 + 1 repair, §36.0) · **Deviation:** ran in the working tree, not an isolated `spike/c-groq-corpus` branch — the repo predates its first commit; waiver recorded.

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

## Caveats for gate review

1. Greenfield corpus: 18 queries are the whole inventory by construction. Gate D closes for this corpus; any adopting codebase re-runs the inventory + classification.
2. Planner is spike-grade: published perspective only, materialized-overlay model (no field-level merge — that is Phase 2), reference expansion is naive full-document scan. Do not promote into `packages/` without rewrite (§0.6).
3. `recent-by-created-at` accepted Tier B under `preview-diverges` (§13.9); needs its promotion-order regression test in Phase 6.
