# Handoff — Sanity Branch Overlay, session 2

**Date:** 2026-08-04 · **Suite: 2650 tests, 40 files, green** (`pnpm --filter sanity-overlay-testkit test`) · **Uncommitted work in the tree** — see §6.

> **SCOPE AMENDMENT — 2026-08-05.** Owner ruling: **this system never writes to a real Sanity dataset**, including its asset API. Promotion is out of scope **permanently, not deferred**. `packages/sanity-overlay-core/src/promotion/**` and its 108 tests were deleted; two structural guards replaced them (a suite-wide outbound-request monitor and a runtime host refusal). Binding statement: [PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity).

Read this first, then [gate-review.md](evidence/phase-1/gate-review.md), [live-validation-2026-08-04.md](evidence/phase-1/live-validation-2026-08-04.md), [evidence-review-2026-08-04.md](evidence/phase-1/evidence-review-2026-08-04.md), and [phase-2/acceptance-audit.md](evidence/phase-2/acceptance-audit.md).

---

## 1. Working agreements (non-negotiable — see [../../claude.md](../../claude.md))

- **Output style:** extremely concise, ADHD-friendly. Only *decisions taken* and *decisions needing the user*. Bullets, one line each.
- **TDD, strictly:** red test first, always. Watch it fail for the right reason, then minimum code to pass.
- **Bugs:** red test for the **instance plus the entire class** before fixing. Class tests stay as permanent regression coverage.
- **"Tests pass" is not evidence unless the tests could have failed.** Mutation-check load-bearing suites: break the implementation, confirm red, **restore and re-verify green**.
- **Subagent briefs must mandate red-first** and require the red→green transition in the final report.
- **Zero file overlap between parallel agents.** The orchestrator drives the browser.
- **Standing rule: server-side logs are the only trustworthy escape evidence.** Browser-side detection has produced false all-clears three times.

---

## 2. What exists

```
packages/
  sanity-overlay-core/     # W1 types/serializer/checksums/encoding · W2 mutations+actions
                           # W3 merge/perspectives/conflicts · W4 references/validation
                           # store/ (contract + MemoryOverlayStore) · invariants/ (12 §34 checks)
  sanity-overlay-store-fs/ # FsOverlayStore; contract.ts is now a re-export shim from core
  sanity-overlay-testkit/  # fixtures, contract runner, write-guard contract, 40 test files
examples/kitchen-sink/     # Studio 6.8.0, 4 doc types, the audit/spike target
  spikeA/                  # instrumentedClient, localEcho, echoProtocol, overlayServer, runOverlayServer
  spikeB-proxy/            # proxy.mjs (HTTP + WS upgrade + frame guard) · writeGuard.mjs (default-deny)
  spikeF/                  # attackPass.ts (27 attacks)
docs/plans/evidence/       # phase-1/ (spikes, gate review, evidence review, live validation)
                           # phase-2/ (acceptance audit)
```

**Infrastructure:** Sanity project `b1n03q3z`, datasets `parity` (41 fixture docs) + `scratch`. Token in gitignored `.env`. Re-seed: `cd examples/kitchen-sink && pnpm exec sanity dataset import ../../packages/sanity-overlay-testkit/fixtures/dataset.ndjson parity --replace`.

---

## 3. Status

**Phase 1 — NOT complete.** Gates: **A, B, D conditional pass · E partial · C, F not started.** No §0.6 abort threshold reached; no pivot required. Full detail and recorded risks in [gate-review.md](evidence/phase-1/gate-review.md).

**Phase 2 — engineering-complete, cannot be signed off.** §10 acceptance is 10/10 (two caveats, one CI-blocked). Plan §2 forbids signing Phase 2 until the six Phase 1 gates close.

### The milestone works

Proven live, 2026-08-04, with disk and upstream-API evidence ([live-validation](evidence/phase-1/live-validation-2026-08-04.md) §2): edit in real Studio → `.sanity-overlay/documents/<id>/intent.json` → survives reload → **staging untouched** (`_rev` unchanged, no `drafts.` document created upstream).

### What was wrong and is now fixed

1. **Every non-ASCII edit was silently lost.** diff-match-patch headers count UTF-8 **bytes**; the parser counted JS **characters**. The editor showed success while the overlay stayed empty. Found only by typing an em dash in a live browser — 2048 green tests could not see it. Two further defects surfaced in the same code: astral characters count **7** bytes (not 4 — a `TextEncoder` "fix" rejects valid patches, now guarded), and hunk starts are **rolling**, so `start1 + offset` misplaced hunk 2 of *any* multi-hunk patch including pure ASCII.
2. **The merge engine was never wired into the mutation layer.** `localWinsMerge` was still the production default and dropped base-only fields, so `publish()` promoted unmerged documents and all 11 §35.5 cases ran against a stub. Now wired; `promotionTouchedPaths()` added because publish/unpublish recorded no touched paths.
3. **Two full write-guard bypasses.** Node routes upgrades to `upgrade`, not `request`, so `POST /data/actions` with `Connection: Upgrade` returned 101 **with the mutation body delivered**. And dot-segment laundering — `/data/mutate/parity/../../query/parity` classified as a read. Both closed; the guard is now default-deny and the WS channel is RFC 6455-parsed and RPC-classified.
4. **Gate D boundedness was circular.** Reverting the planner leaves the two previously-cited suites fully green (179/179, 136/136) while the new suite catches it 72×. `article-by-slug`: 30 candidates → 1.
5. **A fail-open in the hybrid config.** Blank/whitespace `SPIKE_API_HOST` read as "configured" while being falsy at the injection site — Studio would run with **no proxy and no facade**, silently.
6. **A write rejected after a 401 still reached disk** before being reported failed.

### Corrections to previously-recorded claims

- **Gate A's "0 direct requests to Sanity" is withdrawn.** CDP capture recorded 4 direct `POST api.sanity.io/vX/intake/feedback`. Telemetry, not content — but interception is not total.
- **D13's rationale was false in code.** It claimed the factory "injects `apiHost` only, no method wrapping"; `instrumentedClient.ts` wrapped every method. Echo *requires* wrapping, so the decision record was corrected (not the conclusion — the proxy was always the boundary), and the described topology was made a real, tested code path. The identity hazard is now a test: **20,000 renders → 1 subscribe**, with a negative control reproducing the historical 40,000-call storm.

---

## 4. Blocked on the user

1. **Vercel project + private Blob token** → Spike B → Gates C, F, and E's deployed half. *This single unblock is worth more than everything else outstanding.*
2. **§0.6 human validation** — one human validation of the real Studio workflow per spike. The 2026-08-04 sessions were agent-driven and do not satisfy this by definition.
3. **D13 ratification; D01 and D09 sign-off** ([decisions.md](evidence/phase-1/decisions.md)). D01 is now only about *local* branch uploads — the Sanity-upload half was settled on 2026-08-05 (never). D10 and D11 are moot.
4. **Approve the launch-critical query list.** Gate D's Tier-C *ratio* has no denominator without it (numerator is zero, so the conclusion holds regardless).
5. **Ratify `query.maxCandidateDocuments`** — PRD §11.1 defines no value and it cannot be 5,000: `article-type-list` legitimately materialises 5,833 and `multi-type-list` 6,333. Either the cap sits above the largest legitimate answer, or list queries paginate.
6. **§28.6 conflict acknowledgements have no storage home.** PRD §13.3/§13.11 define no field. The invalidation rule is implemented; the schema field was deliberately **not** invented. Needs a spec decision.
7. **HTTP/1.1 concurrency ceiling** — accept the risk, or move the proxy to h2 (see §5).

---

## 5. Engineering next actions, in order

1. **Gate E remediation** — 5 of the 6 facade gaps remain (one was closed as a side effect of the auth work). Provision read-only preview tokens.
2. **Suite reliability under load.** `action-echo` and `proxy-concurrency` each failed once in a full run and passed in isolation and on re-run. Both are timing-sensitive. Fix before this becomes CI noise.
3. **Gate D latency** — three Tier-B queries miss §5.4: `article-count` and `stats-aggregate` transfer 4.8 MiB to return one scalar (needs aggregate pushdown, §22.6 step 14); `articles-by-author-name` is p50 2.2 s / p95 12.7 s against a 3 s budget (needs reverse-reference expansion, §22.6 step 10). Both are Phase 6.
4. **HTTP/1.1 starvation.** Boundary is exact: 5 concurrent streams complete, **6 never do**; Studio's own SSE listeners exhaust Chrome's 6-connection limit and crashed the structure tool live. Deliberately unpatched — bounding listeners trades a hang for permanent read-only flicker plus a refetch storm, and h2 rewrites the security boundary's transport and needs the WS frame guard re-implemented on RFC 8441 extended CONNECT.
5. **§22.6 step 8 unimplemented** — `article-type-list` materialises 833 authors it never dereferences (14% of its candidate set, on the query thinnest against budget). Pinned by test, not fixed.
6. **Token refresh is never invoked in the browser** — a session that 401s stays write-refusing until reload. Fail-closed and deliberate.
7. **No CI exists.** Blocks the cross-platform/cross-Node half of §10 row 7, and leaves the dependency-boundary lint manual-only.
8. **Three TLS claims are object-asserted only** — production `dialFromSpec` success path, derived-hostname SNI, `secureConnect` vs `connect` ordering.
9. **Phase 3** — `[M-LOCAL]`: CLI, local API, environment-aware client, direct-edit watcher, and a real Studio plugin (`sanity-overlay-studio`) replacing the localStorage-flag spike.

---

## 6. Repository state

- **Uncommitted:** substantial work across `packages/**`, `examples/kitchen-sink/**` and `docs/plans/evidence/**`. Nothing was committed by the orchestrator; two commits (`9b7c1cd`, `4059772`) appeared under the user's identity mid-session.
- **The `MUTANT` artifact is resolved.** `echoProtocol.ts` briefly carried a mutation-check artifact into `9b7c1cd`; `4059772` swept up the restore. A scan of HEAD finds no mutation artifacts. **This has now happened twice** — both times an agent was killed between breaking code and restoring it. Any pause during a mutation check needs a sweep before committing.
- **`proxy-log.jsonl` is pinned evidence** (730 lines) and a checklist predicate asserts it is unmodified. The 302 rows appended by the 2026-08-04 sessions were preserved separately as `proxy-log-milestone-2026-08-04.jsonl`; `proxy-log-reverify.jsonl` holds the Spike F re-verification. Do not append to the pinned log.
- **No `@types/node`** in the testkit — `tsc --noEmit` is broadly red workspace-wide for that reason alone, so **the test suite is currently the only real gate.**
- **Running the stack:**
  ```bash
  cd examples/kitchen-sink
  pnpm dev                                                   # Studio :3333
  PROXY_BLOCK_WRITES=1 node spikeB-proxy/proxy.mjs           # proxy :3999
  pnpm overlay:server                                        # overlay :3998
  ```
  Browser flags (localStorage, then reload): `SPIKE_LOCAL_ECHO=1`, `SPIKE_OVERLAY_PERSIST=1`, `SPIKE_API_HOST=http://localhost:3999`. Inspect `window.__SPIKE_ECHO__` / `window.__SPIKE_A__`.
- **Spike F re-verification** is a mechanical checklist — [spikeB-proxy/README.md](../../examples/kitchen-sink/spikeB-proxy/README.md) Steps 1–6, 11 predicates with a runnable script. Last run: `ALL PREDICATES PASS`.
