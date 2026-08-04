# Testing strategy

**Status:** Draft
**Date:** 2026-08-03
**Source:** [docs/PRD-v1.md](../PRD-v1.md) (v1.1) — implements §35 (test strategy), §36 (spike evidence), §5.5 (quality targets)
**Scope:** cross-phase; harness is built in roadmap Phase 1 and graduates to CI

---

## 1. Test fixtures

- **Fixture dataset** — checked-in `.ndjson` + assets, deterministic `_id`s. Content is deliberately adversarial:
  - keyed arrays, Portable Text (marks, spans, inline blocks), non-keyed array
  - strong + weak references, a reference chain, a cycle
  - draft/published pairs that diverge
  - IDs with dots and `drafts.` prefixes (§35.9)
  - one ~2 MB document (§15.6 guardrail)
  - ~30 articles so a `[0...20]` ordered slice exercises the §22.6 top-K proof
  - every §35.11 fixture line traces to specific seeded documents
- **Example app** — `examples/kitchen-sink`: Next.js + embedded Studio consuming the overlay packages as a real user would. One page per registered query pattern (listing with ordered slice, page-by-slug, article with author dereference, reference-filtered list). Target for §35.12 Studio tests and §35.13 E2E scenarios; doubles as the §37 Phase 9 example application.
- **Sanity test project** — dedicated project, never real staging (§11.3). Datasets: `parity` (re-seeded from the ndjson before each run) and `scratch` (promotion round-trip). Write tokens exist only in CI seeding/promotion jobs.

## 2. Parity oracles (§35.10)

| Oracle | Method | Catches |
|---|---|---|
| **Empty-overlay parity** | Registered query natively against hosted Sanity vs through the overlay with an empty overlay; deep-equal after metadata normalization | `groq-js` vs hosted Content Lake drift [S18][S19]; read-path non-transparency |
| **Overlay parity** | Apply scripted mutations; compute the expected virtual dataset explicitly (base fixture + same mutations in memory); `groq-js` over the full expected dataset (oracle, no planning) vs the real planner + evaluator; exact equality | Candidate-planning bugs — planner fetched too few documents |
| **Promotion round-trip** | Promote overlay to `scratch`, query natively, compare with virtual results modulo registered timestamp policies (§13.9) | End-to-end divergence between preview and promoted reality |
| **Listener parity** | Record real pinned-Studio event traffic against the test dataset via proxy; recordings are golden fixtures for emulation tests | Gate B protocol mismatches (§36.1, §21.4.1) |

## 3. Three loops, by feedback speed

| Loop | When | Credentials | Runs |
|---|---|---|---|
| **Inner** (seconds) | every save | none | Unit (§35.2–35.6), property-based (§35.1 list), §35.7 contract suite on memory + fs adapters, offline query parity against the fixture snapshot |
| **PR** (minutes) | every PR | read token | Hosted empty-overlay + overlay parity; Playwright on example app in `fs` mode; network capture asserting **zero** Sanity mutation requests; dataset export before/after suite, diffed ("staging unchanged" as a hard assertion) |
| **Nightly / labeled** (slow) | scheduled or label | Blob + write tokens | Real Vercel Blob contract + failure injection (§35.8, §35.15 — ETag semantics are not emulatable locally); two-tab stale-write races; preview-deployment E2E; promotion round-trip; **drift canary**: daily empty-overlay parity against pinned versions |

## 4. Sequencing

- The harness is **not** post-hoc: it is Spike A/B/C evidence (§36). Build order in Phase 1: kitchen-sink schema → fixture dataset → harness skeleton → spikes run inside it → evidence graduates to permanent CI.
- Contract-test runner is exported from `sanity-overlay-testkit` so Phases 3/4 run the identical §35.7 suite against fs and Blob adapters unchanged.

## 5. Decisions

- **Taken:** pooled dataset pair (`parity` + `scratch`) re-seeded per run, with a CI lock. Revisit ephemeral per-run datasets only if contention flakiness appears (dataset creation is plan-dependent).
- **Open:** none.
