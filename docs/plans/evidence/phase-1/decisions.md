# Phase 1 decision log

Running log for [phase-1 plan §4](../../phase-1-audit-and-feasibility.md). Format per entry: ID, owner, date, evidence, chosen option, default accepted?

## Pre-decisions (plan-level, recorded for gate review)

| ID | Decision | Owner | Date | Outcome |
|---|---|---|---|---|
| PRE-1 | Audit target: greenfield repo, so `examples/kitchen-sink` is the audit/spike target and reference consumer. §37 Phase 0 audit items about "existing" usage are answered against it. | TO | 2026-08-03 | Recorded; re-audit required for any real adopting codebase |
| PRE-2 | Pinned versions (§5.5): `sanity` 6.8.0, `@sanity/client` 7.26.0, `groq-js` 2.0.0, `@vercel/blob` 2.6.1 (when used), `vitest` 4.1.10, react 19.2.8, typescript 5.9.3. | TO | 2026-08-03 | Exact pins in package.json files |
| PRE-3 | CI datasets: pooled pair (`parity` + `scratch`) re-seeded per run with a CI lock. | TO | 2026-08-03 | Default accepted |
| PRE-4 | Sanity test project `b1n03q3z` ("sanity-overlay-test"), datasets `parity` (seeded) + `scratch`, viewer token in gitignored `.env`, API pinned `v2025-02-19`. | TO | 2026-08-03 | Token was echoed in an agent transcript — rotate if shared |
| PRE-5 | Sequencing: local track first, Vercel track last. Gates C and F remain open until Spike B runs; no dependent phase may be recorded complete meanwhile (§0.3, §1.4, §5.2). | PO (user), TO | 2026-08-03 | Recorded |

## §39.3 decisions

| ID | Decision | Owner | Status | Evidence and rationale |
|---|---|---|---|---|
| **D13** | Which Studio interception strategy is selected? | TO | **HYBRID — validated end-to-end 2026-08-04; awaiting ratification.** Browser run ([hybrid-validation.md](spike-a-studio-interception/hybrid-validation.md)): factory injects `apiHost` only (no method wrapping), Studio boots fully through the proxy with **0 direct requests to Sanity**, and with the facade **disabled** an edit still died at the proxy (`403 blocked:true`) leaving staging byte-identical. | Both tracks ran (§0.3 Gate A requires parallel tracks). **Track A** (`unstable_clientFactory`) is present and functional in 6.8.0, intercepts every client incl. `withConfig` chains, and proved full local editing with 0 network writes — but it is `unstable_`-prefixed beta, carries an identity-stability hazard (a naive wrapper caused a ~40k-call resubscribe storm), and a facade is bypassable by constructing a fresh client. **Track B** (HTTP proxy) is a bypass-proof network chokepoint on the versioned public API with an airtight write guard, but cannot see intent and cannot use cookie auth over plain-HTTP loopback. **Recommendation: hybrid** — `unstable_clientFactory` injects `apiHost` only (no method wrapping ⇒ no identity hazard), proxy performs interception and enforcement. Gets A's 100% client coverage plus B's unbypassable boundary. |
| D08 | Which Studio plugins are mandatory? | PO, TO | **RESOLVED (default accepted)** | Audit found only `structureTool`; no third-party plugins. §0.6 "more than two mandatory plugins bypass the overlay" threshold not reachable at present. Re-evaluate per adopting codebase. |
| D07 | Which document types exceed bounded candidate-query guardrails? | TO | **RESOLVED (none, at fixture scale)** | Spike C: all 4 document types plan exactly; top-K proof holds; candidate counts < full dataset. Open sub-item: representative-scale latency (see Gate D). |
| D15 | Timestamp policy per `_updatedAt`/`_createdAt` query | TO, CMS | **RESOLVED** | Spike C registry: `recent-by-created-at` classified Tier B with `preview-diverges` and a required promotion-order regression test in Phase 6. Default ("unsupported until registered explicitly") honoured for all others. |
| D01 | Are branch asset uploads required for initial launch? | PO, CMS | **DEFAULT ASSUMED — needs PO/CMS sign-off** | Default: existing Sanity assets only, branch uploads deferred to PRD Phase 7. Spike E therefore skipped. Note from Spike A: `client.assets.upload` is currently NOT covered by the facade — if D01 flips, asset interception becomes required work. |
| D09 | Is Presentation click-to-edit required for launch? | PO | **DEFAULT ASSUMED — needs PO sign-off** | Default: no, iframe preview only. Spike A's conditional Presentation task therefore not run. |
| D03 | Which identity provider controls preview edit vs read-only? | SEC | **OPEN — Vercel track (PRE-5)** | Deferred with Gate E deployment clauses. |
| D14 | Which preview trust topology? | SEC | **OPEN — but Spike F narrows it** | Provisional default (trusted-repository, no fork secrets) is **no longer sufficient on its own**: Spike F proved a page-reachable write token defeats any client-side control via raw `fetch`. Whichever topology is chosen must (a) enforce server-side and (b) ensure the preview holds only a read-only token. This is the §0.6 trigger "staging write protection depends on branch-controlled code behaving honestly" — recorded now so the topology decision is made with the evidence. |

## Gate-blocking decisions still required from the user

- **D01** and **D09** — defaults assumed and documented above; a sign-off (or override) closes them.
- **D13** — hybrid recommendation above; needs TO ratification.
