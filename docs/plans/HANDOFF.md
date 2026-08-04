# Handoff — Sanity Branch Overlay, session 1

**Date:** 2026-08-04 · **Suite: 602 tests, 9 files, all green** (`pnpm --filter sanity-overlay-testkit test`) · **Nothing is committed yet** — the user wants one commit when Phase 1 is complete, validated, and reviewed.

Read this first, then [README.md](README.md) (roadmap), [phase-1-audit-and-feasibility.md](phase-1-audit-and-feasibility.md), and [evidence/phase-1/gate-review.md](evidence/phase-1/gate-review.md).

---

## 1. Working agreements (non-negotiable — see [../../claude.md](../../claude.md))

- **Output style:** extremely concise, ADHD-friendly. Report only *decisions taken* and *decisions needing the user's opinion*. Bullets, one line each. No prose blocks.
- **TDD, strictly:** red test first, always. Watch it fail for the right reason, then write the minimum code to pass. Never implementation-first.
- **Bugs:** when any bug/edge case is found, write a red test for the **instance plus the entire class** before fixing. Class-level tests stay as permanent regression coverage.
- **Subagent briefs must mandate red-first** and require the agent to report the red→green transition.
- **"Tests pass" is not evidence unless the tests could have failed.** Mutation-check load-bearing suites.
- **Parallelize with subagents, zero file overlap.** The orchestrator drives the browser (agents have no browser access).
- **Browser automation:** use chrome-devtools MCP, batch work into few `evaluate_script` calls. Playwright MCP wedged in this session.

---

## 2. What exists

```
packages/
  sanity-overlay-core/        # W1 (types, canonical serializer, pure-TS SHA-256, path/ID encoding,
                              #     format version) + W2 (mutations/, actions/) — zero dependencies
  sanity-overlay-store-fs/    # store contract + FsOverlayStore (.sanity-overlay/ layout, atomic writes)
  sanity-overlay-testkit/     # fixtures + 9 test files (602 tests); spike-c/ and spike-d/ prototypes;
                              #   src/storeContract.ts + src/writeGuardContract.ts = reusable suites
examples/kitchen-sink/        # Sanity Studio, 4 doc types, the audit/spike target
  spikeA/                     # instrumentedClient.ts (unstable_clientFactory), localEcho.ts, eventSourceTap.ts
  spikeB-proxy/               # proxy.mjs + writeGuard.mjs (TDD-built classifier)
  spikeF/                     # attackPass.ts (27 attacks)
docs/plans/evidence/phase-1/  # all spike reports, decisions.md, gate-review.md
```

**Infrastructure:** Sanity test project `b1n03q3z` ("sanity-overlay-test"), datasets `parity` (seeded, 41 fixture docs) + `scratch`. Viewer token in gitignored `.env`. Re-seed: `cd examples/kitchen-sink && pnpm exec sanity dataset import ../../packages/sanity-overlay-testkit/fixtures/dataset.ndjson parity --replace`.

---

## 3. Phase 1 status — NOT complete

| Gate | Status |
|---|---|
| **A** interception | PASS (conditional) — hybrid validated in browser |
| **B** listener protocol | PARTIAL — shapes captured, chain intact; §21.4.1 automated matrix missing |
| **C** Blob concurrency | **BLOCKED — needs Vercel credentials** |
| **D** query parity | PASS for correctness; boundedness re-proven after a test-quality failure; latency criterion open |
| **E** safety boundary | **FAIL (facade)** — 6 real gaps; enforcement must be server-side |
| **F** lifecycle | **BLOCKED — needs Vercel credentials** |

**Blocking Phase 1 exit:**
1. **Vercel project + private Blob token** (user action) → unblocks Spike B → Gates C and F.
2. **Human validation** (user action) — §0.6 requires one human validation of the real Studio workflow per spike; none recorded.
3. **D01 / D09 sign-off, D13 ratification** — see `evidence/phase-1/decisions.md`.

### Key results

- **`unstable_clientFactory` works in sanity 6.8.0** and intercepts every client. Facade wrappers **must be identity-stable** or Studio enters a ~40k-call resubscribe storm (black screen).
- **Studio writes via the Actions API** (`POST /data/actions`, tag `document.commit`), not `mutate`.
- **Local editing with zero writes proven** — scalar/keyed-array/Portable-Text edits render, save state settles, staging byte-identical.
- **D13 = hybrid** (factory injects `apiHost` only; proxy enforces), validated: Studio booted through the proxy with **0 direct requests to Sanity**, and with the facade *disabled* a write still died at the proxy (403) leaving staging unchanged.
- **Spike F: 17/27 blocked, 6 real gaps** — patch/transaction `clone().commit()`, leading-slash-less `request`, unguarded `/assets/*`, `client.agent.action.patch` (also bypassed the proxy), reachable `client.datasets`. Plus a 7th found later: `resource:`-configured clients write to `/projects/<p>/datasets/<d>/mutate` with **no `/data/` prefix**.
- **Architectural:** a write-capable token is reachable from page JS; raw `fetch` writes freely. **A client-side facade can never be a security boundary.** Preview must hold a read-only token.

### Three self-corrections (read these — they are the method lessons)

1. **Spike F "25 blocked / 0 holes" was wrong and is retracted.** The detector only watched `window.fetch`, but `@sanity/client` uses **XMLHttpRequest** in browsers; the resource-timing buffer also drops entries past 250. Real result: 17 blocked, 6 gaps.
2. **Spike C parity proved only half the claim.** Parity against a full-dataset oracle cannot detect *over*-fetching — an entirely unbounded planner passed all 463 tests, so §22.6's top-K proof was unverified. The registry was also self-certifying. Fixed with 139 red-first tests.
3. **The proxy's WebSocket 404 is a blocker, not harmless.** Studio's `ws://…/v2022-06-30/socket/parity` upgrade 404s → `No activity within 45000 milliseconds. Reconnecting.` → panes hang on "Loading document…". The earlier hybrid run passed only because it finished inside the 45 s window.

**Standing rule: server-side logs are the only trustworthy escape evidence.** Browser-side detection produced false all-clears three times.

---

## 4. Next actions, in order

1. **Proxy WebSocket upgrade (TDD)** — `server.on('upgrade')` → dial upstream `wss://` → pipe both sockets. Unblocks interactive Studio-through-proxy. Red test first: assert a WS handshake through the proxy returns 101, not 404.
2. **Wire FsOverlayStore into the facade** — the milestone the user is waiting for. Today `localEcho.ts` holds writes **in memory only**, so a reload loses them. Route intercepted writes to `FsOverlayStore` so edits land in `.sanity-overlay/`. Validate in the browser: edit → file appears on disk → reload → edit persists → staging untouched.
3. **Re-run the adversarial evidence review** (the previous run stalled — see §5).
4. **Fix the 6 facade gaps** or drop the facade's security claim and rely on the proxy (recommended). Red tests for each gap **plus its class** first.
5. **Phase 2 W3/W4** — merge engine, references (core `merge/`, `perspectives/`, `conflicts/`, `references/` are still empty).
6. **Remaining Gate A/B breadth** — document-action echo (publish/unpublish/delete/discard/duplicate/restore are blocked but not echoed), auth-failure/reconnect/logout flows, two-pane/two-tab, §21.4.1 automated matrix.
7. **Vercel track last** (decision PRE-5): Spike B → Gates C, F, and the deployed half of E.

---

## 5. Paused work — how to resume

**All subagents are stopped. Nothing is mid-write; the suite is green.**

| Work | State | How to resume |
|---|---|---|
| W2 mutation engine | **Delivered** — `core/src/mutations/`, `core/src/actions/`, `test/core-w2.test.ts`, green. Never sent a completion report, so its design notes are lost. | Nothing to resume. If you need its rationale, read the code. |
| Store contract + FsOverlayStore | **Delivered** — `store-fs/src/*`, `test/store-fs.test.ts`, `testkit/src/storeContract.ts`, green. Also never reported. | Nothing to resume; proceed to wiring (next action 2). |
| 5-reviewer evidence audit | **STALLED and lost** — 5 agents started, 0 results, journal frozen. Not recoverable. | Re-launch fresh. Script saved at `~/.claude/projects/<project>/<session>/workflows/scripts/phase1-evidence-review-wf_5d48b964-00b.js` — re-invoke `Workflow({scriptPath: "<that path>"})`, or write a new one. It audits: spike-c claims, spike-a claims, spike-f safety, gate claims, test quality. |

**Known flake:** `test/store-fs.test.ts > Import canonical state` once took 5703 ms against vitest's 5000 ms default — raise that test's timeout before it bites CI.

**Contaminated commit:** `HEAD` (588b82e) contains committed mutation artifacts in `spike-c/planner.ts` (`// MUTATION: affected-doc handling removed`, `// AUDIT MUTATION: planner deleted`) from an audit that committed instead of restoring. **The working tree is correct.** Fix in the next commit; do not `git checkout` that file.

---

## 6. Running the stack

```bash
# Studio (port 3333)
cd examples/kitchen-sink && pnpm exec sanity dev

# Proxy with write guard (port 3999) — NOTE: WS upgrade unimplemented, panes hang; fix first
cd examples/kitchen-sink && PROXY_BLOCK_WRITES=1 node spikeB-proxy/proxy.mjs

# Tests
pnpm --filter sanity-overlay-testkit test
```

Browser flags (localStorage, then reload):
- `SPIKE_LOCAL_ECHO=1` — facade blocks writes and echoes locally (in-memory only)
- `SPIKE_API_HOST=http://localhost:3999` — route all client traffic through the proxy
- Spike F: `await import('/spikeF/attackPass.ts')` then `window.__SPIKE_F__.runAttackPass()` — **creates canary docs; clean them up afterwards**

**Current browser state:** echo ON, proxy bypassed (because of the WS bug) — Studio at `localhost:3333` is safe to click through; Title/Tags/Body edits work, Publish does not settle, reload loses edits.
