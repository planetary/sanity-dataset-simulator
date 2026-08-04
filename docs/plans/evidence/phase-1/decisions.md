# Phase 1 decision log

Running log for [phase-1 plan §4](../../phase-1-audit-and-feasibility.md). Format per entry: ID, owner, date, evidence, chosen option, default accepted?

## Recorded

| ID | Decision | Owner | Date | Outcome |
|---|---|---|---|---|
| PRE-1 | Audit target: this is a greenfield repo with no existing Sanity app, so `examples/kitchen-sink` is built as the audit/spike target and reference consumer. §37 Phase 0 audit items about "existing" usage are answered against it. | TO | 2026-08-03 | Plan-level decision, recorded here for gate review |
| PRE-2 | Pinned versions (PRD §5.5): `sanity` 6.8.0, `@sanity/client` 7.26.0, `groq-js` 2.0.0, `next` 16.3.0 (when app shell lands), `@vercel/blob` 2.6.1, `vitest` 4.1.10, react 19.2.8, typescript 5.9.3 (5.x line; 7.x compiler not adopted). | TO | 2026-08-03 | Exact pins in package.json files |
| PRE-3 | CI datasets: pooled pair (`parity` + `scratch`) re-seeded per run with a CI lock; ephemeral per-run datasets only if contention flakiness appears ([testing-strategy §5](../../testing-strategy.md)). | TO | 2026-08-03 | Default accepted |

## Open (due this phase — see phase-1 plan §4.2)

- [ ] D01 — branch asset uploads launch-critical? (PO, CMS; due during audit, before spike scheduling completes)
- [ ] D03, D07, D08, D09, D13, D14, D15 — per §39.3
- [ ] Launch-critical query/plugin/asset lists (PO + TO; asset list co-approved by CMS)
