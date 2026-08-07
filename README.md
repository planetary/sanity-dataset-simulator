# Sanity Branch Overlay

A virtual Sanity dataset per branch: a **live, read-only** Sanity staging base, plus a branch-scoped copy-on-write overlay stored as JSON files under `.sanity-overlay/`. A branch can edit, create, publish, unpublish and delete content, and see the result in Studio and in a preview site, without any of it reaching the shared dataset.

**Status: pre-release, in active development.** No package is publishable or installable yet. Phase 1's feasibility gates are not all closed. Read [What this does not do](#what-this-does-not-do) before you rely on anything here.

---

## THIS SYSTEM NEVER WRITES TO SANITY

**Owner ruling, 2026-08-05. Binding. Not a preference and not a deferral.** — [PRD §0.0](docs/PRD-v1.md)

> This system must **NEVER** write to a real Sanity dataset. Ever.

Two consequences, and the second is broader than the first:

1. **Promotion is out of scope permanently.** Pushing approved branch content back to staging — the planner, its apply path, its authorization model, and the `[M-PROMO]` release it was the acceptance list for — **will not be built.** `packages/sanity-overlay-core/src/promotion/**` and its 108 tests were deleted on the day of the ruling, so there is nothing for a future contributor to finish.
2. **Assets are never pushed to Sanity either.** Nothing here calls Sanity's asset API. `client.assets.upload` against a real Sanity host is the same violation as a mutate and is refused on the same grounds.

Reading the live staging dataset remains the premise of the product. Writing to it is out of scope, permanently.

**This is enforced structurally, not by documentation:**

| Guard | Where |
|---|---|
| Suite-wide outbound monitor — any non-GET to a `sanity.io` host fails the test run | `packages/sanity-overlay-testkit/vitest.setup.ts` |
| Runtime host refusal for unsafe methods bound for a real Sanity API host | `packages/sanity-overlay-client/src/stagingHost.ts`, wired into the Studio transport, the Studio facade and the HTTP base source |
| Default-deny write guard in the Track B proxy | `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs` |
| Facade write-plane refusals, derived from the installed `@sanity/client` prototypes so an upgrade that adds a method goes red | `packages/sanity-overlay-studio/src/client/writeGuard.ts` |
| Startup throw when a write-capable Sanity credential is present in overlay mode | `packages/sanity-overlay-studio/src/options.ts` (`assertNoWriteToken`) |
| Attack corpus | `packages/sanity-overlay-testkit/src/writeGuardContract.ts` |

**Two corrections you should know before reading any older claim:**

- Interception is **not total**. CDP-layer network capture on 2026-08-04 recorded 4 × `POST https://api.sanity.io/vX/intake/feedback` going direct, bypassing the proxy. That is telemetry, not content — but the previously stated *"0 direct requests to Sanity"* is **withdrawn**. See [live-validation §1.3](docs/plans/evidence/phase-1/live-validation-2026-08-04.md).
- The guards above are **layered, not individually sound**. The [security review of 2026-08-06](docs/plans/evidence/phase-1/security-review-2026-08-06.md) found **3 P1 findings and 0 P0**, including a percent-encoded `?`/`#` that truncates the path the write guard classifies — present in *both* guard implementations — so a write can classify as a read. PRD §5.5's *"no unresolved P0 or P1 security findings"* is **not met today**.

---

## The two modes

`OVERLAY_MODE` selects the storage adapter. It is read under three spellings — `SANITY_STUDIO_OVERLAY_MODE`, `SANITY_OVERLAY_MODE`, `OVERLAY_MODE` — most browser-reachable first. **An absent mode is refused by the read client, not defaulted**, because the old `?? 'off'` silently put a reader on staging while every other signal said "branch".

| Mode | What it does | Status |
|---|---|---|
| `off` | No overlay. Reads and writes go to Sanity Content Lake natively. This is what production and shared staging use. | Works |
| `fs` | Overlay state under `.sanity-overlay/` as canonical JSON, committed to Git. Local development and coding agents. | **The only working overlay mode** |
| `blob` | Overlay state in a private Vercel Blob namespace, for Vercel Preview Deployments. | **Not implemented.** The Studio plugin throws at startup: *"mode `blob` is configured but no Blob store adapter ships yet."* Gates C and F are not started. |
| `memory` | In-memory store, nothing persisted. Tests and contract runs. | Works |

The Studio plugin defaults to `fs` with a warning if no mode is configured. That default is a safety decision: installing the plugin is the opt-in, and defaulting to `off` would mean a consumer who added the line and forgot the variable would keep editing staging while believing they were on a branch.

---

## How it works, in six lines

1. All Studio content writes are intercepted at the client and routed to a local overlay API. None reach Sanity.
2. The first edit to a document captures the complete base document and its base revision, then tracks **field-level intent** — a list of `{path, value}` overrides — plus a materialized branch document.
3. Reads resolve the current staging content, then apply branch drafts, published versions, field overrides, new documents and tombstones on top.
4. Queries are **not** sent to Sanity. A registered query is parsed with `groq-js`, planned into a **complete finite candidate set**, those candidates are fetched from the base, the branch is overlaid, and the query is evaluated locally.
5. When exactness cannot be proven, the query is **refused with a structured error** — never approximated. See the [query registry guide](docs/query-registry.md).
6. `.sanity-overlay/` is committed. Serialization is canonical and byte-deterministic so the diff is reviewable.

---

## Repository layout

```
packages/
  sanity-overlay-core/      types, canonical serializer, checksums, mutation engine,
                            three-way merge, conflicts, references, invariants, memory store
  sanity-overlay-store-fs/  FsOverlayStore — atomic temp-file-plus-rename, direct-edit watcher
  sanity-overlay-query/     registry, candidate planner, groq-js evaluator, lint rule, codemod
  sanity-overlay-client/    environment-aware client, base source, staging-host guard
  sanity-overlay-studio/    the Studio plugin: client facade, document actions, status banner,
                            conflict panel, hosted-feature removal
  sanity-overlay-next/      the overlay HTTP API (/state, /commit, /resolve, /query, /events)
  sanity-overlay-cli/       16 commands — inspect, status, validate, diff, reset, rebase,
                            conflicts, query, export, import, normalize, history, cleanup,
                            lint, codemod, ci
  sanity-overlay-testkit/   fixtures, contract runner, write-guard contract, the whole suite
examples/
  kitchen-sink/             Studio 6.8.0 against project b1n03q3z / dataset parity.
                            Also holds the Phase 1 spike rigs (spikeA, spikeB-proxy, spikeF).
  local-site/               a small site that reads the overlay — the example application
e2e/                        Playwright specs and harness (written, never run — see below)
docs/                       PRD, roadmap, phase plans, evidence, and the guides below
```

**One test runner.** `packages/sanity-overlay-testkit` runs Vitest; every other package's `test` script prints `tested via sanity-overlay-testkit`.

```bash
pnpm install
pnpm test                    # == pnpm -r test
pnpm --filter sanity-overlay-testkit test
```

---

## Running the stack locally

Four terminals. Ports are fixed: **3333** Studio, **3999** proxy, **3998** overlay API, **4000** site. Port 3333 is not negotiable — the overlay API grants CORS to exactly one origin.

```bash
# 1 — Track B proxy, default-deny write guard                          :3999
PROXY_BLOCK_WRITES=1 PROXY_LOG=/tmp/overlay-proxy.jsonl \
  node examples/kitchen-sink/spikeB-proxy/proxy.mjs

# 2 — overlay persistence server                                        :3998
node examples/kitchen-sink/overlayApiServer.mjs --root=<a scratch dir> --port=3998

# 3 — the Studio                                                        :3333
pnpm --filter kitchen-sink dev

# 4 — a site reading that overlay                                       :4000
pnpm --filter local-site dev
```

Two things to get right:

- **`PROXY_LOG` is not optional.** The default path is `examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl`, which is pinned evidence at exactly 730 lines and has been contaminated twice.
- **`--root` should be a scratch directory.** `examples/kitchen-sink/.sanity-overlay/` is committed evidence from real sessions.

To route the Studio through the proxy, set `SANITY_STUDIO_OVERLAY_API_HOST=http://localhost:3999` in `examples/kitchen-sink/.env`. Without it the Studio talks to Sanity directly and the proxy — the only server-side boundary — sees nothing.

### The 60-second path, no Studio and no Sanity account

```bash
pnpm --filter local-site seed                    # writes examples/local-site/.overlay-demo/
pnpm --filter local-site demo                    # http://127.0.0.1:4000  — branch view
pnpm --filter local-site staging -- --port=4001  # http://127.0.0.1:4001  — OVERLAY_MODE=off
```

Two windows side by side: the same routes, one reading the overlay and one reading the base.

### On-disk layout

Relative to the directory containing `.sanity-overlay/`:

```
.sanity-overlay/manifest.json                                   overlay identity, revision, heads
.sanity-overlay/documents/<logical-id>/intent.json              the review surface — field-level intent
.sanity-overlay/snapshots/<sha256>.json                         first-touch base snapshots
.sanity-overlay/assets/{blobs,records}/                         created on demand
.sanity-overlay/.runtime/                                       materialized docs, transactions,
                                                                revisions, idempotency — gitignored
```

`drafts.article-01` and `article-01` share one directory: the key is the logical (published) ID.

---

## The CLI

No build step. It imports TypeScript directly and needs Node 22.

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs --help
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs status --root <dir>
```

> The bare `sanity-overlay` command is **not on PATH in this checkout** — the package is `private` and nothing depends on its bin. Invoke it by path.

Exit codes are part of the contract: `0` clean · `1` internal error · `2` findings (violations, conflicts, changes) · `3` confirmation required · `4` overlay missing or corrupt · `5` usage error · `6` query refused by the registry.

`reset`, `rebase` and `cleanup` never write without `--confirm`, and all three support `--dry-run`. Every stream is passed through a secret redactor: any env var whose *name* looks like a credential and whose value is 8+ characters is replaced with `«redacted»` in both stdout and stderr.

---

## Documentation

| Document | For |
|---|---|
| [Migration guide](docs/migration-from-sanity-client.md) | A project already on `@sanity/client` — the codemod, what it refuses, what it cannot do |
| [Plugin compatibility guide](docs/plugin-compatibility.md) | Which hosted Studio features are disabled, how, and what residue remains |
| [Query registry guide](docs/query-registry.md) | Registering a query, checksums, `UNSUPPORTED_GROQ`, the lint gate |
| [Runbook](docs/runbook.md) | The failure modes actually seen, with the exact error strings and the recovery |
| [§0.6 human validation script](docs/plans/evidence/phase-1/human-validation-script.md) | The browser procedure every gate is currently blocked on |
| [Security review, 2026-08-06](docs/plans/evidence/phase-1/security-review-2026-08-06.md) | 3 P1, 0 P0 — §5.5's bar is **not** met today |
| [PRD](docs/PRD-v1.md) | The specification. Source of truth for every claim |
| [Delivery roadmap](docs/plans/README.md) | Nine phases, gate tracker, milestone trackers |
| [Phase 1 evidence](docs/plans/evidence/phase-1/gate-review.md) | Gate status, and the risks recorded against each |

---

## What this does not do

Stated plainly, because this project has an established pattern of documentation running ahead of reality.

### Out of scope permanently

- **Writing to Sanity, in any form.** Promotion, asset upload, mutations, actions. See above.
- **Reproducing Sanity Content Lake.** This is a branch-preview authoring layer (PRD §0.4). Hosted collaboration, history, releases, scheduling, search infrastructure, source maps and automations are degraded, custom, deferred or unavailable.
- **Collaborative editing.** Optimised for one active editor or agent per branch.

### Built but not yet usable

- **No package is installable.** Every package cross-imports its siblings by relative filesystem path that escapes its own root — **106 such specifiers** across `packages/*/src` as measured on 2026-08-06 (testkit excluded; the number moves as work lands). Under pnpm's isolated linker a consumer's copy resolves `../../../` to a directory that has no sibling package in it. The test titled *"the package can actually be installed and resolved"* skips relative specifiers by construction, so it cannot see this. Everything below therefore runs from inside this monorepo only.
- **Branch assets do not work.** `client.assets.upload` is refused outright by the facade, and local-only upload into the overlay is designed but unbuilt. A branch cannot contain a new image. The asset store, synthetic asset documents and delivery code exist in `packages/sanity-overlay-core/src/assets/` and `store-fs/src/assetStore.ts` and have **never been verified in a browser**.
- **`OVERLAY_MODE=blob` throws at startup.** There is no Blob adapter. Gates C and F are not started and are blocked on a Vercel project plus a private Blob token.
- **A deployed preview has no enforcement layer.** The proxy is a local process. There is no preview deployment, no preview auth, no CSRF, no session. Gate E's deployed half is untouched.
- **The E2E suite cannot run.** `e2e/` holds ten Playwright specs, a harness and a network auditor. `@playwright/test` is not installed anywhere in the workspace and `playwright.config.ts` cannot be imported. What *does* run today: `node --test e2e/audit/predicates.test.mjs`, `node --test e2e/playwright/selectors.test.mjs`, `node e2e/audit/runAudit.mjs`.
- **The conflict panel is unreachable in a browser.** It is built, exported and unit-tested, but the overlay API's `GET /state` returns no conflict field, so the Studio's conflict report always resolves to *"this overlay API does not report conflicts"* and the document action renders as a disabled **Conflict state unknown**. Conflicts *are* computed — but only inside `POST /resolve`, per read.
- **The §28.2 "Overlay Conflicts" list tool does not exist.** `conflictListRows` and `filterConflictRows` are implemented and exported; no Studio tool renders them.
- **Overlay revision history does not exist.** Native History is removed; PRD §32.2's replacement is unbuilt.
- **The overlay API's `/events` SSE bridge has no shipping consumer.** The Studio package contains no `EventSource` and no reconnect logic; it polls `GET /state` on a fixed 5-second interval with no backoff.
- **The local overlay API is spike code.** `examples/kitchen-sink/spikeA/overlayServer.mjs` is the implementation the shipped Studio plugin points at by default. PRD §0.6 declares spike code disposable and forbids promoting it into `packages/` without a test-first rewrite. `packages/sanity-overlay-next` is the product implementation of the same endpoints and is not yet what the example boots.

### Never verified in a browser

The Node suite is large (89 files, ~6,558 tests as of 2026-08-06) and unusually adversarial. It is not a substitute for a browser, and the project has the scar to prove it: every non-ASCII edit was silently lost for an unknown period, and it took **typing an em dash into a real Studio** to find it. 2048 green tests could not.

Unverified in a browser today: cursor and selection stability, keystroke loss under a real debounce, Portable Text editing, document actions settling, the confirm dialogs actually blocking, auth-failure and token-refresh paths, reconnect through the real listener transport, and branch assets. The [human validation script](docs/plans/evidence/phase-1/human-validation-script.md) is the procedure for closing that list.

---

## Contributing

Read [CLAUDE.md](CLAUDE.md) first. Two rules are non-negotiable:

- **TDD, red first.** No production code before a failing test that demands it. A test that passes on first run is not a test.
- **A bug gets a class-level test, not an instance test.** One instance ⇒ enumerate the family and cover it. Those tests stay in the permanent suite.

And one house rule that comes out of this project's own history: **"tests pass" is not evidence unless the tests could have failed.** Mutation-check load-bearing suites — break the implementation deliberately, confirm the tests go red, restore, re-verify green.

Documentation conventions for anything under `docs/plans/` are in [docs/plans/README.md §8](docs/plans/README.md).
