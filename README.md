# Sanity Branch Overlay

A virtual Sanity dataset per branch: a **live, read-only** staging base plus a branch-scoped copy-on-write overlay stored as JSON under `.sanity-overlay/` and committed to Git. A branch can edit, create, publish and delete content — visible in Studio and a preview site — without anything reaching the shared dataset.

**Status: pre-release.** Installable from locally-built tarballs (`pnpm pack`; not on npm). The full local workflow — fresh external project, real Studio login, live staging base, edits and publishes that never reached the dataset — was human-validated on 2026-08-11. See [Limitations](#limitations).

## This system never writes to Sanity

Binding owner ruling, permanent — [PRD §0.0](docs/PRD-v1.md). No mutations, no promotion, no asset uploads. Reading staging is the premise; writing to it will never be built.

Enforced structurally, not by documentation: a suite-wide outbound monitor fails any test run that sends a non-GET to a `sanity.io` host, the runtime refuses unsafe methods bound for real Sanity hosts, the proxy write guard is default-deny, and startup throws if a write-capable credential is present. Known gaps are documented honestly: telemetry can bypass the proxy, and the [2026-08-06 security review](docs/plans/evidence/phase-1/security-review-2026-08-06.md) has 3 open P1 findings.

## How it works

1. Studio writes are intercepted at the client and routed to a local overlay API — none reach Sanity.
2. First edit captures a base snapshot, then tracks field-level intent plus a materialized branch document.
3. Reads resolve staging content, then apply branch overrides, new documents and tombstones on top.
4. Registered GROQ queries are planned into a finite candidate set and evaluated locally; anything unprovable is **refused, never approximated** ([query registry](docs/query-registry.md)).
5. `.sanity-overlay/` serialization is canonical and byte-deterministic, so the Git diff is reviewable.

`OVERLAY_MODE` selects the store: `off` (native Sanity), `fs` (JSON files, **the only working overlay mode**), `memory` (tests), `blob` (not implemented, throws).

## What works where

✅ built and browser-validated · ⚠️ engine-level only, or partial · ✗ not built

| Feature | Local (`fs`) | Vercel preview (`blob`) |
|---|:---:|:---:|
| Install into a fresh project (tarballs) | ✅ | ✗ |
| Studio editing — scalar, slug, text fields | ✅ | ✗ |
| Portable Text, arrays, objects | ⚠️ | ✗ |
| Publish / unpublish / delete / discard / duplicate | ✅ | ✗ |
| Live read-only staging base under the overlay | ✅ | ✗ |
| Canonical `.sanity-overlay/` files, deterministic Git diff | ✅ | ✗ |
| Registered GROQ queries (site + CLI) | ✅ | ✗ |
| Studio lists and search (unfiltered exact; typed search refused) | ⚠️ | ✗ |
| References — resolve + incoming | ✅ | ✗ |
| References — authoring via the picker (branch-created targets) | ✅ | ✗ |
| Conflict detection + banner (resolution panel partial) | ⚠️ | ✗ |
| Checkpoint / export / import (CLI) | ✅ | ✗ |
| Branch assets (upload path exists, no browser pass) | ⚠️ | ✗ |
| Overlay revision history + restore (Studio; CLI log viewer exists) | ✗ | ✗ |
| Write-block enforcement, server-side audited | ✅ | ✗ |
| Durable persistence + PR identity across deploys | n/a | ✗ |

## Try it

Prereqs: Node 22+, pnpm 10 (`corepack enable` picks up the pinned version).

```bash
pnpm install
pnpm test        # ~10,000 Node tests; no Sanity account needed
```

60-second demo, no Sanity account needed:

```bash
pnpm --filter local-site seed                    # writes examples/local-site/.overlay-demo/
pnpm --filter local-site demo                    # :4000 — branch view
pnpm --filter local-site staging -- --port=4001  # :4001 — same routes, base view
```

Browser suite — boots the whole stack (proxy, overlay API, Studio, site) by itself:

```bash
pnpm exec playwright install chromium    # once
pnpm exec playwright test                # hermetic; E2E_MODE=live adds the real-dataset leg (needs .env)
```

The full local stack (Studio + proxy + overlay API + site) is documented in the [runbook](docs/runbook.md); the e2e topology and its deliberate gaps in [e2e/README](e2e/README.md).

## Repository layout

```
packages/   core (types, mutations, merge) · store-fs · query · client ·
            studio (the plugin) · next (overlay HTTP API) · cli · testkit (all tests)
examples/   kitchen-sink (Studio + Phase 1 spike rigs) · local-site (demo site)
e2e/        Playwright specs (local suite 58/58 green 2026-08-11; not in CI)
docs/       PRD, roadmap, evidence, guides
```

## Documentation

| Document | For |
|---|---|
| [PRD](docs/PRD-v1.md) | The specification — source of truth for every claim |
| [Migration guide](docs/migration-from-sanity-client.md) | Moving a project off `@sanity/client` |
| [Plugin compatibility](docs/plugin-compatibility.md) | Which hosted Studio features are disabled and how |
| [Query registry](docs/query-registry.md) | Registering queries, checksums, the lint gate |
| [Runbook](docs/runbook.md) | Known failure modes and recovery |
| [Roadmap](docs/plans/README.md) | Phases, gates, milestones |

## Limitations

- **Not on npm.** Install is from `pnpm pack` tarballs; a fresh external project (real `sanity@6.8.0` peers) was validated 2026-08-11.
- **Browser coverage stops at scalar and slug fields.** Portable Text, keyed arrays, objects and reference *authoring* have no browser evidence; reference search with a typed term is a declared refusal. ~10,000 Node tests + the local E2E suite cover the rest.
- **Branch assets are unverified in a browser.** The local upload path exists (bytes land under `.sanity-overlay/`, synthetic asset documents resolve); no browser pass has exercised it.
- **No deployed previews.** `blob` mode and the deployed enforcement layer don't exist; the proxy is a local process.
- **E2E runs locally, not in CI.** Every browser assertion is a manual run.
- **Conflict UI is partial.** Soft conflicts surface in the banner with resolution options (seen live 2026-08-11); overlay revision history and restore are unbuilt.
- **Wire shape can't say "draft superseded".** A branch publish leaves `draft: null` + a published body; consumers derive suppression from that pair (§18.2 R5). Every reader now derives it identically — a `draftSuppressed` field on `/state` is the open follow-up.
- **Not a Content Lake replacement.** Single-editor branches; hosted collaboration, history, search and automations are out of scope.

## Contributing

- **TDD, red first.** No production code before a failing test that demands it.
- **Bugs get class-level tests.** One instance ⇒ enumerate and cover the family, permanently.
- **"Tests pass" is not evidence unless they could have failed.** Mutation-check load-bearing suites.
