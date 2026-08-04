# Gate review — Phase 1

Per [phase-1 plan §5](../../phase-1-audit-and-feasibility.md): a gate closes only with evidence covering **every clause** of its PRD §0.3 text, plus the §0.6 requirement of automated tests **and one human validation of the actual Studio workflow**. A failed gate requires a written pivot decision here before implementation continues.

**Review date:** 2026-08-04 · **Reviewer:** TO (agent-assisted) · **Human validation:** OUTSTANDING for every gate (§0.6 requires it explicitly; no gate may be signed without it).

| Gate | Status | Evidence |
|---|---|---|
| **A** — Studio data-plane interception | **PASS (conditional)** — both tracks ran in parallel as §0.3 requires. Track A intercepts 100% of clients and proved full local editing with 0 network writes; Track B is a bypass-proof network guard. Conditions: document actions not yet echoed; auth-failure/reconnect/logout paths untested; Track B not yet browser-run. D13 hybrid recommendation pending ratification. | [report.md](spike-a-studio-interception/report.md), [write-block-validation.md](spike-a-studio-interception/write-block-validation.md), [track-b-proxy.md](spike-a-studio-interception/track-b-proxy.md) |
| **B** — Listener and editor-state protocol | **PARTIAL** — real event shapes captured from the pinned version; synthetic events delivered to the pair listener with an intact `previousRev → resultRev` chain; save state settles. Not yet done: the §21.4.1 five-criterion automated matrix, reconnect convergence, unsubscribe, two-pane/two-tab. | [listener-event-shapes.md](spike-a-studio-interception/listener-event-shapes.md), [write-block-validation.md](spike-a-studio-interception/write-block-validation.md) |
| **C** — Blob concurrency | **NOT STARTED** — deferred with the Vercel track (PRE-5). Needs a Vercel project + private Blob token. | pending `spike-b-blob-transaction/` |
| **D** — Query parity | **PASS (one criterion open)** — 18-query registry, 102 planner-vs-oracle checks across 6 overlay fixtures, 13 hosted empty-overlay cases, structured `UNSUPPORTED_GROQ`, mutation-test proves the suite detects candidate-incompleteness. Open: representative-scale latency. | [spike-c-groq-corpus/report.md](spike-c-groq-corpus/report.md) |
| **E** — Safety and trust boundary | **PARTIAL — with a confirmed architectural finding.** Spike F ran 27 attacks: **25 blocked, 0 unexpected holes**, including dataset override, every clone/builder escape, asset upload, and a freshly constructed client. **But** a write-capable token is reachable from page JS and raw `fetch` with it wrote to the dataset (canaries created, verified, then cleaned). Conclusion: a client-side facade cannot satisfy Gate E alone — enforcement must be server-side (proxy/gateway) **and** the preview must carry a read-only token. Fork/deployment clauses still need the Vercel track. | [spike-f-safety-boundary/report.md](spike-f-safety-boundary/report.md), [write-block-validation.md](spike-a-studio-interception/write-block-validation.md), [track-b-proxy.md](spike-a-studio-interception/track-b-proxy.md) |
| **F** — Lifecycle | **NOT STARTED** — deferred with the Vercel track (PRE-5); Spike B carries all Gate F clauses per PRD v1.1. | pending `spike-b-blob-transaction/` |

**Unlettered:** Spike D (schema compatibility) **PASS** — [spike-d-schema-compatibility/report.md](spike-d-schema-compatibility/report.md). Spike E skipped per the D01 default (existing assets only).

## Phase 1 exit status

PRD §37 Phase 0 exit requires **all six gates**. Current: **A, D pass conditionally; B, E partial; C, F not started.**

**Phase 1 is therefore NOT complete.** It is complete *for the local track*, which is what PRE-5 scoped. The blocking work is:

1. **Vercel credentials** (user action) — a Vercel project + private Blob store token unblocks Spike B, which closes Gates C and F and the deployed half of Gate E.
2. **Human validation** (user action) — §0.6 requires one human validation of the real Studio workflow per spike; none has been recorded.
3. **D01 / D09 sign-off, D13 ratification** — see [decisions.md](decisions.md).
4. **Engineering breadth** (no blocker): document-action echo, auth/reconnect flows, §21.4.1 automated matrix, Track B browser run, representative-scale query latency.

No §0.6 abort threshold has been reached. No pivot decision is required.
