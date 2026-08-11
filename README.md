# Sanity Branch Overlay

A virtual Sanity dataset per branch: a **live, read-only** staging base plus a branch-scoped copy-on-write overlay stored as JSON under `.sanity-overlay/` and committed to Git. A branch can edit, create, publish and delete content — visible in Studio and a preview site — without anything reaching the shared dataset.

**Status: pre-release.** Nothing is installable outside this monorepo yet. See [Limitations](#limitations).

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

## Try it

```bash
pnpm install
pnpm test
```

60-second demo, no Sanity account needed:

```bash
pnpm --filter local-site seed                    # writes examples/local-site/.overlay-demo/
pnpm --filter local-site demo                    # :4000 — branch view
pnpm --filter local-site staging -- --port=4001  # :4001 — same routes, base view
```

The full local stack (Studio + proxy + overlay API + site) is documented in the [runbook](docs/runbook.md).

## Repository layout

```
packages/   core (types, mutations, merge) · store-fs · query · client ·
            studio (the plugin) · next (overlay HTTP API) · cli · testkit (all tests)
examples/   kitchen-sink (Studio + Phase 1 spike rigs) · local-site (demo site)
e2e/        Playwright specs (written, not yet runnable)
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

- **Not installable.** Packages cross-import siblings by relative path; everything runs from inside this monorepo only.
- **Never verified in a browser.** ~6,500 Node tests, zero browser passes — the [human validation script](docs/plans/evidence/phase-1/human-validation-script.md) is the closing procedure.
- **Branch assets don't work.** Uploads are refused; local-only asset storage is designed but unbuilt.
- **No deployed previews.** `blob` mode and the deployed enforcement layer don't exist; the proxy is a local process.
- **E2E suite can't run.** Playwright isn't installed in the workspace yet.
- **Conflict UI is incomplete.** Conflicts are computed per read, but the panel is unreachable and revision history is unbuilt.
- **Not a Content Lake replacement.** Single-editor branches; hosted collaboration, history, search and automations are out of scope.

## Contributing

- **TDD, red first.** No production code before a failing test that demands it.
- **Bugs get class-level tests.** One instance ⇒ enumerate and cover the family, permanently.
- **"Tests pass" is not evidence unless they could have failed.** Mutation-check load-bearing suites.
