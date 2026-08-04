# Gate review — Phase 1

Per [phase-1 plan §5](../../phase-1-audit-and-feasibility.md): a gate closes only with evidence covering **every clause** of its PRD §0.3 text, plus the §0.6 requirement of automated tests **and one human validation of the actual Studio workflow**. A failed gate requires a written pivot decision here before implementation continues.

**Review date:** 2026-08-04 · **Reviewer:** TO (agent-assisted) · **Human validation:** OUTSTANDING for every gate (§0.6 requires it explicitly; no gate may be signed without it).

| Gate | Status | Evidence |
|---|---|---|
| **A** — Studio data-plane interception | **PASS (conditional)** — both tracks ran in parallel as §0.3 requires, and the **hybrid was validated in the browser**: Studio boots entirely through the proxy (0 direct requests to Sanity), and with the facade disabled a write still died at the proxy with staging unchanged. Conditions: document actions not yet echoed; auth-failure/reconnect/logout paths untested; D13 ratification pending. | [report.md](spike-a-studio-interception/report.md), [hybrid-validation.md](spike-a-studio-interception/hybrid-validation.md), [write-block-validation.md](spike-a-studio-interception/write-block-validation.md), [track-b-proxy.md](spike-a-studio-interception/track-b-proxy.md) |
| **B** — Listener and editor-state protocol | **PARTIAL** — real event shapes captured from the pinned version; synthetic events delivered to the pair listener with an intact `previousRev → resultRev` chain; save state settles. Not yet done: the §21.4.1 five-criterion automated matrix, reconnect convergence, unsubscribe, two-pane/two-tab. | [listener-event-shapes.md](spike-a-studio-interception/listener-event-shapes.md), [write-block-validation.md](spike-a-studio-interception/write-block-validation.md) |
| **C** — Blob concurrency | **NOT STARTED** — deferred with the Vercel track (PRE-5). Needs a Vercel project + private Blob token. | pending `spike-b-blob-transaction/` |
| **D** — Query parity | **PASS for correctness; boundedness re-proven after a test-quality failure.** 18-query registry, 102 planner-vs-oracle checks, 13 hosted empty-overlay cases, structured `UNSUPPORTED_GROQ`. **A mutation audit found the original suite could not detect over-fetching** — an entirely unbounded planner passed all 463 tests, so §22.6's top-K proof was unverified; the registry was also self-certifying. Fixed with 139 tests (per-plan-type candidate ceilings, pinned registry inventory, 4-way tombstone matrix); suite now 602 green. Open: representative-scale latency. | [spike-c-groq-corpus/report.md](spike-c-groq-corpus/report.md) |
| **E** — Safety and trust boundary | **FAIL (facade) / open (topology).** Hardened Spike F: **17 blocked, 6 REAL gaps, 4 architectural holes.** Gaps: patch/transaction `clone().commit()`, leading-slash-less `request` to `/data/mutate`, unguarded `/assets/*`, **`client.agent.action.patch` (bypasses the Track B proxy too — its allowlist passes `/agent/*`)**, and reachable `client.datasets`. Architectural: a write-capable token is reachable from page JS; raw fetch and fresh clients write freely (3 canaries persisted, verified, cleaned). An earlier 25/0 result came from an unsound detector and is retracted. Conclusion: enforcement must be server-side with a corrected allowlist and a read-only preview token. | [spike-f-safety-boundary/report.md](spike-f-safety-boundary/report.md), [track-b-proxy.md](spike-a-studio-interception/track-b-proxy.md) |
| **F** — Lifecycle | **NOT STARTED** — deferred with the Vercel track (PRE-5); Spike B carries all Gate F clauses per PRD v1.1. | pending `spike-b-blob-transaction/` |

**Unlettered:** Spike D (schema compatibility) **PASS** — [spike-d-schema-compatibility/report.md](spike-d-schema-compatibility/report.md). Spike E skipped per the D01 default (existing assets only).

## Phase 1 exit status

PRD §37 Phase 0 exit requires **all six gates**. Current: **A, D pass conditionally; B, E partial; C, F not started.**

**Phase 1 is therefore NOT complete**, and Gate E is now a *failing* gate rather than merely an incomplete one — the facade does not hold as a security boundary and the fixes are engineering work, not a pivot (§0.6's trigger for this class points at moving credentials to an isolated gateway / disabling writable preview editing for the untrusted class, which the hybrid topology does).

The blocking work is:

1. **Vercel credentials** (user action) — a Vercel project + private Blob store token unblocks Spike B, which closes Gates C and F and the deployed half of Gate E.
2. **Human validation** (user action) — §0.6 requires one human validation of the real Studio workflow per spike; none has been recorded.
3. **D01 / D09 sign-off, D13 ratification** — see [decisions.md](decisions.md).
4. **Engineering breadth** (no blocker): document-action echo, auth/reconnect flows, §21.4.1 automated matrix, Track B browser run, representative-scale query latency.
5. **Gate E remediation** (new, from the hardened Spike F): fix the 6 facade gaps or drop the facade's security claim; correct the proxy allowlist to guard `/agent/*` and `/assets/*`; provision read-only preview tokens; promote attacks 18–27 into the permanent §35.14 suite.

No §0.6 abort threshold has been reached. No pivot decision is required.
