# `e2e/` — the browser suite roadmap Phase 5 exits on

> **Status: runs locally, green.** `@playwright/test` is installed at the
> workspace root and the local suite passed on 2026-08-11 — 63 passed, 4
> skipped (recorded in `e2e/.artifacts/run/`). It is **not in CI** — every browser assertion is a
> manual run. The live suite (`E2E_MODE=live`) needs the repo `.env`
> credentials and skips without them. Scenario-by-scenario coverage and the
> deliberate gaps are listed below, without rounding up.

## Install

```bash
pnpm add -D -w @playwright/test          # root devDependency (-w = workspace root)
pnpm exec playwright install chromium    # the browser binary
```

Chromium only, and not as a shortcut: `@sanity/client` builds
`<projectId>.<apiHost>`, so a Studio told `apiHost: http://localhost:3999`
requests `http://b1n03q3z.localhost:3999`. Chromium and Firefox resolve
`*.localhost` to loopback per RFC 6761; WebKit does not. Adding WebKit would
mean an `/etc/hosts` entry as a hidden precondition.

## Run

```bash
pnpm exec playwright test                  # hermetic. No Sanity account needed.
E2E_MODE=live pnpm exec playwright test    # against the real project + READ token
```

```bash
node --test e2e/audit/predicates.test.mjs      # runs today · 31 assertions
node --test e2e/playwright/selectors.test.mjs  # runs today · 56 assertions
node e2e/audit/runAudit.mjs                    # the network audit, standalone
```

---

## The two modes

| | `E2E_MODE=local` (default) | `E2E_MODE=live` |
|---|---|---|
| Proxy | Mode 2 **origin** — no upstream socket exists | Mode 1 **proxy**, `PROXY_BLOCK_WRITES=1` |
| Sanity account | none | real project + `SANITY_API_READ_TOKEN` |
| Base dataset | none — the overlay is the whole world | the real `parity` dataset |
| "Staging untouched" | **structural** (there is nothing to touch) | **asserted against the upstream API** |
| Specs | `e2e/specs/local/` | `e2e/specs/live/` |

They are complements, not alternatives. `local` is the one that runs anywhere
and in CI; `live` is the only one that can discharge the exit criterion's actual
words, because that criterion is a statement about a real dataset.

---

## Decision: the suite starts the stack (`webServer`), it is not a precondition

Five processes have to agree on three things — which overlay root is being
written, which JSONL log the network audit will read, and which ports everything
is on. A hand-started stack gets one of those wrong *silently*, and the failure
mode is not a red test: it is a **green run that audited the wrong file**.

That is not hypothetical. `proxy-log.jsonl` is pinned evidence with a test
asserting exactly 730 lines, and it has been contaminated twice by someone
starting the proxy without `PROXY_LOG` set. The config sets it, into
`e2e/.artifacts/run/`, every time.

`reuseExistingServer` is **false everywhere, including locally.** A Studio you
already had running has unknown environment: possibly `mode: off`, possibly
pointed at `examples/kitchen-sink/.sanity-overlay/` — in which case the suite
would edit real committed overlay state and still pass every assertion. A busy
port is a loud failure telling you to stop your dev stack. That is the correct
trade, and it is the reason the ports are fixed rather than negotiated: the
overlay API grants CORS to `http://localhost:3333` and to **no other origin**, so
a Studio that fell back to 3334 would fail every `/state` and `/commit` and the
banner would sit in `offline` — a failure that looks like a product bug and is
not one.

The one thing the suite cannot start is a Sanity account, which is why `live`
skips itself with a stated reason rather than failing.

### What it starts

| port | process | notes |
|---|---|---|
| 3999 | transport proxy | `runOrigin.mjs --origin` (local) or `proxy.mjs` (live). `PROXY_LOG` → run dir. |
| 3998 | **overlay recorder** | `e2e/harness/overlayHarness.mjs` — records, then forwards |
| 3997 | overlay API | `examples/kitchen-sink/overlayApiServer.mjs` (the **product** server, `sanity-overlay-next`), behind the recorder. `E2E_OVERLAY_SERVER=spike` swaps in `spikeA/runOverlayServer.mjs` for bisecting. |
| 3996 | harness control | `POST /reset` — never told to any browser origin |
| 3333 | Studio | `sanity dev`, product path, clean storage |
| 4000 | local site | `SANITY_OVERLAY_MODE=fs` — the branch view |
| 4001 | local site | `SANITY_OVERLAY_MODE=off` — the staging view |

---

## Determinism and self-cleaning

- **A fixed run directory**, `e2e/.artifacts/run/`, wiped at config-import time
  (`harness/runDir.mjs`). Fixed rather than timestamped because Playwright
  workers do not share module state and a per-worker id would mean per-worker
  logs. Wiped at *config import* rather than in `globalSetup` because
  Playwright's ordering of `globalSetup` against `webServer` has changed between
  versions, and a setup that ran second would delete the proxy's log out from
  under it.
- **A per-run overlay root**, `e2e/.artifacts/run/overlay-root/`. Never
  `examples/kitchen-sink/`, which holds committed overlay state from real
  sessions.
- **Reset between specs is a server restart**, not `rm -rf`: `FsOverlayStore`
  holds an open manifest and serialises commits, so a directory that vanishes
  mid-queue produces errors that look like product bugs. The harness stops the
  server, empties the root, and starts it again;
  `openOverlay(..., {ifNotExists: true})` re-initialises an empty directory, so
  there is no seed fixture to drift.
- **`workers: 1`, `fullyParallel: false`.** There is one Studio, one overlay, one
  proxy. The stack is not shardable and pretending otherwise buys minutes and
  costs the determinism the suite exists for.
- **The run directory is gitignored** (`e2e/.gitignore`). Committing an audit log
  is a deliberate act: copy it into `docs/plans/evidence/` under a dated name,
  the way `proxy-log-reverify.jsonl` was.

---

## The network audit

**Server-side logs are the only trustworthy escape evidence.** Browser-side
detection has produced false all-clears on this project three times, most
concretely when CDP capture missed four `POST api.sanity.io/vX/intake/feedback`
going direct. Nothing in the audit reads anything the page says about itself.

### Two planes, because one is not enough

`docs/plans/evidence/phase-3/acceptance-audit.md` §3.2.3 names the hole:

> *"In plugin mode the proxy is structurally blind to the write path. The facade
> sends writes to the overlay API at :3998; they never traverse the proxy at all.
> So the proxy log cannot audit them even in principle, and no other server-side
> artifact does."*

The proxy log proves the **negative** — nothing write-shaped was forwarded
towards Sanity. It cannot prove the **positive** — that the writes happened at
all. A run in which the editor silently did nothing produces a spotless proxy
log. So `harness/overlayHarness.mjs` interposes a recording pass-through in front
of the overlay API and the audit reads both:

```
browser :3333 ─┬─► proxy :3999 ──► (live only) Content Lake     → proxy-log.jsonl
               └─► recorder :3998 ──► overlay API :3997 ──► disk → overlay-log.jsonl
```

### The predicates

`e2e/audit/predicates.mjs`. Modelled on the eleven mechanical predicates in
`examples/kitchen-sink/spikeB-proxy/README.md` Step 4, with the same controls.

| id | predicate |
|---|---|
| **A0** | the proxy log exists, is non-empty, every line parses. *Evaluation stops here* — zero records satisfy A3/A4/A8 vacuously |
| **A1** | request records carry a real verb; frame records carry `WS` + `upgrade` |
| **A2** | every request record has an ISO timestamp and a numeric status |
| **A3** | **escape, classifier-free** — nothing with a mutating verb was forwarded (only `GET`/`HEAD`/`OPTIONS`, plus `POST …/query`) |
| **A4** | **escape, independent allowlist** — every request `readAllowlist.mjs` calls a write was blocked |
| **A4b** | every blocked request was blocked with `403` |
| **A5** | **disagreement** — the proxy's own guard never calls "read" something the independent allowlist calls a write |
| **A6** | **liveness** — at least one request succeeded. Seven 403s from a proxy that 403s everything prove nothing |
| **A7** | **freshness** — every record was written during this run |
| **A8** | **credential hygiene** — no `Bearer`, no `"params"` |
| **A9** | every WS frame was classified; no `mutate` frame forwarded |
| **B0–B1** | the overlay log parses; every request hit a route the overlay server implements |
| **B2** | **liveness, and the anti-vacuity predicate for the whole audit** — at least one write was committed |
| **B3** | **freshness** for the overlay plane |
| **B4** | the overlay log carries no credential and no document content |
| **C0–C1** | the committed `proxy-log.jsonl` is clean in git and still exactly 730 lines |

Three overlapping nets ask the same question three ways. A3 knows nothing about
Sanity's API. A4 uses an allowlist re-derived without reading the guard. A5 asks
whether the two disagree in the dangerous direction. Any one can catch what the
others are blind to.

### The negative controls run today

`node --test e2e/audit/predicates.test.mjs` — 31 assertions, green. Every
predicate is fed an input that must make it fail, and the assertion is on the
red. Including the strongest control:

> **The committed `proxy-log.jsonl` fails this audit.** On **A7** (freshness) —
> it is 2026-08-04 and cannot be evidence of a run today — and, less expectedly,
> on **A3/A4**. It records five forwarded write-capable requests:
> `POST /data/actions/parity → 400` ×1, `POST /descriptors/claim → 200` ×3,
> `POST /intake/batch → 401` ×1. None is a dataset content write — Sanity
> rejected the `actions` probe with 400 (the proxy README documents it
> deliberately: *"proves body passthrough without writing"*) and the telemetry
> ingest with 401. `descriptors/claim` did succeed; it is schema-descriptor
> upload and one of the four endpoints Spike F found sailing through the
> pre-default-deny guard. This corroborates history the project has already
> recorded — Gate A's *"0 direct requests to Sanity"* is formally withdrawn —
> read out of a server log by a mechanical predicate rather than out of a memory.

---

## Scenario inventory — asserted vs scaffolded

**"Asserted"** means the spec contains real assertions against a real oracle (the
DOM, the disk, a server log, or the upstream API) and will genuinely pass or fail
on behaviour. **It does not mean it has been run** — see the status note at the
top.

| # | Scenario | File | Status | Oracle |
|---|---|---|---|---|
| 1 | Studio boots on the product path; banner healthy | `local/01-boot.spec.ts` | **asserted** | DOM + manifest on disk |
| 2 | Edit → `intent.json` on disk → survives reload | `local/02-edit-persists.spec.ts` | **asserted** | disk + transaction log |
| 3 | Non-ASCII round-trip (em dash, astral, CJK, RTL, combining, multi-hunk) | `local/03-unicode.spec.ts` | **asserted** | exact string + byte-length on disk |
| 4 | Actions: publish, unpublish, delete, discard, duplicate | `local/04-document-actions.spec.ts` | **asserted** | disk (tombstones, layers, manifest heads) |
| 4b | Action *availability*: six routed present, six blocked absent | `local/04-document-actions.spec.ts` | **asserted** | DOM |
| 4c | Action: **restore** | `local/04-document-actions.spec.ts` | **scaffolded** (`fixme`) | blocked on §32.2 overlay revision history |
| 4d | Overlay-contributed actions (rebase / resolve / checkpoint) | `local/04-document-actions.spec.ts` | **scaffolded** (`skip`) | not wired: `createOverlayActionController` has no call site |
| 5 | Comments, Tasks, Releases, Scheduled Drafts absent | `local/05-hosted-features.spec.ts` | **asserted** | DOM, test ids from the pinned dist |
| 5b | Vision absent | `local/05-hosted-features.spec.ts` | **asserted, weak** | kitchen-sink never installed Vision — labelled in the spec |
| 5c | Native History absent | `local/05-hosted-features.spec.ts` | **scaffolded** (`skip`) | removal is `partial` in 6.8.0 — asserting it would assert something untrue |
| 6 | Branch-**created** documents appear in list panes | `local/06-list-panes.spec.ts` | **asserted** | DOM |
| 6b | **Tombstoned** documents disappear from list panes | `local/06-list-panes.spec.ts` | **asserted** | DOM, after disk confirms the tombstone |
| 6c | Branch-**edited** documents show branch titles in list panes | `live/01-staging-untouched.spec.ts` | **asserted (live)** | DOM over a real base |
| 7 | A guard 403 does **not** log the editor out | `local/07-guard-403.spec.ts` | **asserted** | DOM + disk (a write still succeeds afterwards) |
| 7b | A **genuine** Sanity 401 still ends the session | `local/07-guard-403.spec.ts` | **scaffolded** (`skip`) | no upstream in Mode 2; unit-covered |
| 8 | The site renders branch content; `mode: off` renders staging | `local/08-local-site.spec.ts` | **asserted** | server-rendered HTML from two ports |
| 8b | A tombstoned document 404s on the site | `local/08-local-site.spec.ts` | **scaffolded** (`skip`) | needs an id shared by base and Studio |
| 9 | Network audit — no staging writes | `local/99-network-audit.spec.ts` | **asserted** | two server-side JSONL logs |
| 10 | Portable Text typed into a real editor lands as keyed blocks, exact text | `local/10-structured-fields.spec.ts` | **asserted** | disk (`intent.json`), then DOM after reload |
| 10b | Keyed object-array items: both member types, `_key` identity, number stays a number | `local/10-structured-fields.spec.ts` | **asserted** | disk |
| 10c | Editing an existing keyed item updates by `_key`, not delete+insert | `local/10-structured-fields.spec.ts` | **asserted** | disk (`_key` stable across edits) |
| 10d | Primitive array items land in order | `local/10-structured-fields.spec.ts` | **asserted** | disk |
| 10e | All structured values survive a full reload | `local/10-structured-fields.spec.ts` | **asserted** | DOM + disk |
| 10 | Staging untouched, against the upstream API | `live/01-staging-untouched.spec.ts` | **asserted (live)** | `_rev` + `_updatedAt` + no `drafts.<id>` |
| — | Selector provenance against the pinned build | `playwright/selectors.test.mjs` | **asserted, RUNS TODAY** | `sanity@6.8.0` dist |
| — | Audit predicate negative controls | `audit/predicates.test.mjs` | **asserted, RUNS TODAY** | synthetic logs + the committed log |

### Not covered, deliberately

- **PRD §35.12's keystroke line** — *"Active scalar and Portable Text fields
  remain client-authoritative without cursor jumps or lost keystrokes."* That
  needs character-level input under a concurrent remote patch and a different,
  much more delicate spec than any here. `interactions.ts` uses `fill()` and says
  so.
- **§35.13 Scenarios B, C, D** — live base change, same-field conflict, upstream
  deletion. All three need staging to be mutated *underneath* the overlay between
  steps. That is legal under §0.0 (the base is read-only to us; someone else
  moves it) but this suite has no way to move it, and inventing one would mean
  giving the suite a write token.
- **§35.13 Scenario A step 9–10 (checkpoint → Git)** and **Scenario F (Blob stale
  write)** — blocked on the checkpoint action and on Gate C respectively.
- **Reference selection and keyed-array REORDER (drag)** — §35.12 items with no
  spec here. Named so the gap is visible. Portable Text editing, keyed-array
  add/edit and primitive arrays left this list on 2026-08-11
  (`local/10-structured-fields.spec.ts`) — a run that immediately found two
  product defects the Node suites could not see: numeric insert anchors
  rejected instead of clamped (Studio's opening PT batch 400'd forever), and
  the raw `[-1]` anchor stored to disk crashing the next hydration.

---

## What runs today

```
node --test e2e/audit/predicates.test.mjs        31 assertions   green
node --test e2e/playwright/selectors.test.mjs    56 assertions   green
```

The first proves the network audit can fail. The second proves every selector
the browser specs use exists in `sanity@6.8.0` — so a Studio upgrade produces one
red assertion naming the id, rather than twelve mysterious timeouts.

**Mutation-checked, 2026-08-06.** `isVerbSafe()` was changed to `return true`
and the independent allowlist's default-deny branch to `read: true`; the controls
went from 31/31 green to **5 failures across three suites**, then back to 31/31
on restore. The predicates bite.

**The harness is exercised, not just written.** `startOverlayHarness()` was run
for real against `overlayApiServer.mjs`: the recorder forwarded `/health`,
`/state` and a deliberate 404, wrote five well-formed JSONL records, and
`POST /reset` restarted the child against an emptied root which re-initialised
itself. `node e2e/audit/runAudit.mjs` over that log then failed on **A0** (no
proxy log — none ran), **B1** (the deliberate bad route) and **B2** (no commits),
and passed **C0/C1** — the pinned log clean, 730 lines. That is the audit working
end to end on data a server actually wrote.

## What needs a human

1. **`pnpm add -D -w @playwright/test && pnpm exec playwright install chromium`.**
2. **The first run.** The test *ids* are verified statically; the *interactions*
   in `playwright/interactions.ts` cannot be — whether `Title` is the accessible
   name of the title input, or whether the pane footer reads `Saved`, is a fact
   about a rendered Studio. They are all in one file for exactly that reason.
3. **Confirm `sanity dev` boots in Mode 2 without a login.** It did on
   2026-08-05 by hand; the suite assumes it.
4. **A `.env` with `SANITY_API_READ_TOKEN`** for `E2E_MODE=live`. A
   write-capable token must not be present: `assertNoWriteToken()` hard-crashes
   the Studio at boot, and `upstream.ts` accepts read spellings only.
5. **§0.6 human validation.** An agent-driven run does not satisfy it by
   definition, and neither does this suite.
