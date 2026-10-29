# Sanity Dataset Simulator

**`npx sanity-sim`: a local Sanity Content Lake for your Studio and your app.**

Run it in a project folder and it boots a local dataset (empty, seeded from a file, or pulled read-only from your real dataset). It points the folder's Studio and app at that dataset for as long as it runs, and serves a management dashboard at `http://localhost:3939/`. Studio and your app need no changes, and no Sanity account is needed.

```bash
npx sanity-sim          # start, wire this folder, run your dev script
npx sanity-sim trust    # once: trust the local HTTPS certificate
```

- **Package:** [`packages/sanity-sim`](packages/sanity-sim/README.md), which covers how wiring works, the dashboard, syncing, commands, the compatibility table and known limitations.
- **Verified against:** a stock Sanity Studio 6.20 (standalone and embedded in Next.js 16), `@sanity/client` 8.13 and `next-sanity` 13.4. Covered: editing, publishing, history and review changes, uploads, search, Vision, and the full content release flow.
- **Examples:** [`examples/sim-next`](examples/sim-next) (Meridian: Next.js with an embedded Studio, exercising every field type) and [`examples/test-studio`](examples/test-studio) (a stock standalone Studio).
- **Design and evidence:** [`docs/plans/sanity-sim.md`](docs/plans/sanity-sim.md) (gap analysis, design and phases) and [`docs/plans/evidence/sanity-sim-phase-0/request-inventory.md`](docs/plans/evidence/sanity-sim-phase-0/request-inventory.md) (what Studio 6.20 actually calls).

`sanity-sim` never writes to Sanity. Syncing goes through a single GET-only function, and a token is only ever sent to `*.sanity.io`.

```bash
pnpm install
pnpm --filter sanity-sim test   # node:test suite, no network, no Sanity account
```

---

## The branch overlay (superseded)

> **Superseded on 2026-10-28** by `sanity-sim`'s sync with a document-level local layer (see [the plan](docs/plans/sanity-sim.md), §4.4). The packages below remain for reference and for their mutation engine, which `sanity-sim` does not depend on. The rest of this section is the overlay's original README.


**Git branches, but for your Sanity content.**

Normally every Sanity Studio in a team writes to the same shared dataset — there's no way to try out content changes in isolation the way you'd try out code changes on a branch. This project fixes that: your branch gets a **virtual dataset** made of two layers. Underneath is the real staging dataset, live and strictly read-only. On top sits a small set of JSON files in a `.sanity-overlay/` folder, committed to Git, recording only what your branch changed.

Edit, create, publish, and delete content in a real Sanity Studio; see the results on a real preview site; open a PR where content changes show up as a readable diff — and none of it ever touches the shared dataset.

**Status: pre-release.** Not on npm yet — you install it from locally-built tarballs (`pnpm pack`). The complete local workflow (a fresh outside project, a real Studio login, live staging underneath, edits and publishes that verifiably never reached the dataset) was validated by a human on 2026-08-11. Known gaps are listed under [What's missing](#whats-missing).

### The one rule: this system never writes to Sanity

This is a permanent, binding decision by the project owner, not a temporary limitation — see [PRD §0.0](docs/PRD-v1.md). No content mutations, no "promote branch to staging", no asset uploads to Sanity. Reading the staging dataset is the whole premise; writing to it will never be built.

And it's enforced by machinery, not by a paragraph in a README:

- the test suite has a global network monitor that **fails any test run** that sends a non-GET request to a `sanity.io` host;
- the runtime refuses to send unsafe HTTP methods to real Sanity hosts;
- the local proxy's write guard is default-deny — it blocks anything it can't prove is a read;
- startup crashes on purpose if it finds a write-capable Sanity token in the environment.

Two honest caveats: Sanity's telemetry pings can slip past the proxy (they carry no content), and the [2026-08-06 security review](docs/plans/evidence/phase-1/security-review-2026-08-06.md) still has 3 open high-priority findings against the guard.

### How it works

1. **Writes are intercepted in the browser.** When you edit in Studio, the overlay's client plugin catches the write before it leaves and sends it to a small local server (the *overlay API*) instead of Sanity.
2. **The first edit to a document snapshots its current staging version.** From then on the overlay tracks *what you meant to change* field by field (the "intent"), plus a fully assembled copy of your branch's version of the document.
3. **Reads are layered.** A read fetches the staging content, then applies your branch's overrides on top — including documents your branch created and documents it deleted (deletions are recorded as "tombstones" so the document stays gone even though staging still has it).
4. **GROQ queries must be registered ahead of time.** Each registered query is analyzed so the overlay can fetch a provably-complete set of candidate documents and evaluate the query locally. A query it can't prove it can answer correctly is **refused with an explanation — never answered approximately**. See the [query registry guide](docs/query-registry.md).
5. **The files are deterministic.** `.sanity-overlay/` is always serialized the exact same way byte-for-byte, so a Git diff of your content changes is stable and reviewable, like a code diff.

One environment variable, `OVERLAY_MODE`, picks the storage backend: `off` (plain Sanity, no overlay), `fs` (JSON files on disk — **the only overlay mode that works today**), `memory` (used by tests), `blob` (planned for deployed previews; currently throws).

### What works today

Legend: ✅ built and verified in a real browser · ⚠️ works at the engine level, but partial or without browser verification · ✗ not built.

| Feature | Local (`fs`) | Vercel preview (`blob`) |
|---|:---:|:---:|
| Install into a fresh project (from tarballs) | ✅ | ✗ |
| Studio editing — plain text, string, and slug fields | ✅ | ✗ |
| Studio editing — Portable Text (rich text), arrays, objects | ✅ | ✗ |
| Publish / unpublish / delete / discard / duplicate | ✅ | ✗ |
| Live, read-only staging content underneath your edits | ✅ | ✗ |
| Deterministic `.sanity-overlay/` files → reviewable Git diffs | ✅ | ✗ |
| Registered GROQ queries (site + CLI) | ✅ | ✗ |
| Studio document lists and search (exact unfiltered lists work; typing a search term is refused, see below) | ⚠️ | ✗ |
| References — following them, and finding what points at a document | ✅ | ✗ |
| References — picking one in the editor (targets your branch created) | ✅ | ✗ |
| Conflict detection, banner, and resolution (Studio action + API + CLI) | ✅ | ✗ |
| Checkpoint / export / import (CLI) | ✅ | ✗ |
| Branch-local assets (upload path exists; never exercised from a browser) | ⚠️ | ✗ |
| Overlay revision history + restore in Studio (a CLI log viewer exists) | ✗ | ✗ |
| Write-blocking, proven by server-side logs rather than trust | ✅ | ✗ |
| Persistence and PR identity across deploys | n/a | ✗ |

### Try it

You'll need Node 22+ and pnpm 10 (`corepack enable` picks up the pinned version).

```bash
pnpm install
pnpm test        # ~10,000 Node tests; no Sanity account needed
```

### Running the overlay in a project

If your app already mounts the overlay API routes (the `sanity-overlay-next` package is built for that), your normal `next dev` runs everything — no extra command. Otherwise, one command runs it standalone:

```bash
sanity-overlay dev
```

Run it from your project directory — the one that contains (or should contain) `.sanity-overlay/`. There's nothing to configure: every command defaults `--root` to the current directory, so you only pass it when operating on a project you aren't standing in.

It adopts an existing overlay as-is, creates a fresh one when you pass `--project <id> --dataset <name>`, and prints everything you need next: the port it's on, the env lines to paste into your Studio and your site, and the CLI commands for looking inside the branch. Ctrl-C stops it.

**No Sanity project yet?** `sanity-overlay dev --detached` creates an overlay with no project attached, so you can start building UI and content immediately and attach the real project later. Details, all flags, and the full command list: the [CLI README](packages/sanity-overlay-cli/README.md). Mounting the API inside a Next.js app instead: the [sanity-overlay-next README](packages/sanity-overlay-next/README.md).

### 60-second demo, no Sanity account

```bash
pnpm --filter local-site seed                    # writes a demo overlay to examples/local-site/.overlay-demo/
pnpm --filter local-site demo                    # http://localhost:4000 — the branch's view
pnpm --filter local-site staging -- --port=4001  # http://localhost:4001 — same site, staging's view
```

Open both ports: same routes, two different answers, both correct — that's the overlay.

### Browser test suite

It boots the entire stack (proxy, overlay API, Studio, demo site) by itself:

```bash
pnpm exec playwright install chromium    # once
pnpm exec playwright test                # fully local; E2E_MODE=live adds a real-dataset leg (needs .env)
```

The full local stack and its failure modes are documented in the [runbook](docs/runbook.md); the browser-test topology and its deliberate gaps in the [e2e README](e2e/README.md).

### Repository layout

```
packages/   core (types, mutations, merge) · store-fs (the .sanity-overlay/ files) ·
            query (registry + local GROQ) · client (read API for sites) ·
            studio (the Studio plugin) · next (the overlay HTTP API) ·
            cli (sanity-overlay <command>) · testkit (every test lives here)
examples/   kitchen-sink (a Studio wired up for testing, plus Phase 1 research rigs) ·
            local-site (the demo site)
e2e/        Playwright browser specs (local suite green 2026-08-11; not yet in CI)
docs/       PRD, roadmap, evidence, guides
```

### Documentation

| Document | What it's for |
|---|---|
| [PRD](docs/PRD-v1.md) | The full specification — the source of truth behind every claim here |
| [Migration guide](docs/migration-from-sanity-client.md) | Moving an existing project off `@sanity/client` |
| [Plugin compatibility](docs/plugin-compatibility.md) | Which hosted Studio features get disabled, and how |
| [Query registry](docs/query-registry.md) | Registering queries, checksums, and the lint gate |
| [Runbook](docs/runbook.md) | Known failure modes and how to recover |
| [Roadmap](docs/plans/README.md) | Phases, gates, and milestones |

### What's missing

- **Not on npm.** You install from `pnpm pack` tarballs. A fresh external project (using the real `sanity@6.8.0` peer packages) was validated this way on 2026-08-11.
- **Some editing flows have no browser proof yet.** Portable Text, keyed object arrays, objects and plain arrays *are* browser-verified as of 2026-08-11 (typed into a real Studio, checked against the files on disk, survives a reload). Still unverified in a browser: dragging to reorder array items, picking references inside arrays, and the hardest case — typing while someone else's change arrives mid-keystroke (cursor stability, PRD §35.12). Searching for a reference by typing a term is deliberately refused rather than approximated. Everything else is covered by the ~10,000 Node tests plus the local browser suite.
- **Branch assets are unverified in a browser.** Uploading works at the code level (the bytes land under `.sanity-overlay/` and the synthetic asset documents resolve), but no browser test has exercised it end to end.
- **No deployed previews.** `blob` mode and the deployed write-enforcement layer don't exist yet; the proxy only runs as a local process.
- **The browser suite isn't in CI.** Every browser test run is currently manual.
- **No revision history or restore in Studio.** Conflict detection *and resolution* are fully wired (Studio document action, HTTP API, and `sanity-overlay conflicts --resolve` all landed 2026-08-11), but browsing an overlay's edit history and restoring an old version only exist as a CLI log viewer so far.
- **The wire format can't say "this draft was superseded" explicitly.** When a branch publishes, the API reports `draft: null` plus a published body, and every consumer has to derive "the draft is gone because it was published" from that pair (PRD §18.2 rule R5). All readers currently derive it identically; adding an explicit `draftSuppressed` field to `/state` is the open follow-up.
- **This is not a Content Lake replacement.** Branches assume a single editor; hosted collaboration, document history, full-text search, and automations are out of scope.

### Contributing

Three house rules, applied without exception:

- **Test-driven, red first.** No production code before a failing test that demands it.
- **Bugs get class-level tests.** Find one instance, write tests for the whole family it belongs to — permanently.
- **"Tests pass" proves nothing unless they could have failed.** Load-bearing test suites get mutation-checked: break the code on purpose, watch the suite go red, restore it.
