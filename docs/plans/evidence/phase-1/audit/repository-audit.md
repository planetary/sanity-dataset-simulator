# Repository and platform audit — Phase 1, Workstream 1

**Date:** 2026-08-03 · **Target:** `examples/kitchen-sink` (greenfield repo; decision PRE-1 makes it the audit target) · Answers each PRD §37 Phase 0 audit item.

| Audit item | Finding |
|---|---|
| Studio version and plugins | `sanity` 6.8.0 (pinned). Plugins: `structureTool` only. No third-party plugins → plugin-bypass risk (§39.1) currently zero; revisit if plugins are added. |
| `@sanity/client`, `next-sanity`, visual editing versions | `@sanity/client` 7.26.0 (pinned). `next-sanity`, visual editing: not yet installed — added when the Next app shell lands (Phase 3 target: `next` 16.3.0). |
| Schema types | 4 document types: `article`, `author`, `page`, `siteSettings`. Object shapes per schema files; covers keyed arrays, PT + inline object, strong/weak refs, nested objects, slugs. |
| Custom inputs, previews, actions, tools, Structure Builder | None. Adversarial custom-input case (component calling native client, §20.3) to be added deliberately during Spike A. |
| Frontend GROQ queries | 9-query corpus in `packages/sanity-overlay-testkit/test/hosted-parity.test.ts` — this is the registry seed. No app queries yet; Spike C expands corpus to full §35.11 list. |
| Direct Sanity client imports | None outside testkit (`src/hosted.ts` uses raw fetch, read-only). |
| Native mutation call sites | None. Seeding uses CLI import only. |
| Asset workflows | None yet. Fixture has no image assets; add during Spike E if D01 makes assets launch-critical (default: deferred). |
| Auth and preview protection | None yet — no deployed preview (Vercel track deferred, PRE-5). |
| Dataset measurements (parity, 41 docs) | article 32 (avg 915 B, max 952 B), author 5 (avg 241 B), page 3 (avg 591 B), siteSettings 1. Drafts: 2. All far under §15.6 guardrails; `--big` generator flag produces the ~2 MB probe on demand. |
| Cross-dataset / global references | None. Confirmed out of scope (Tier C, §22.3). |
| Hosted features in use (releases, scheduled drafts, comments, tasks, AI Assist) | None. |
| Alternatives matrix | Unchanged from PRD §0.5 — no project-specific evidence contradicts the overlay choice at this scale. |
| Repository / fork trust classification | Single trusted maintainer, private repo, no fork PRs expected → provisional `trusted-repository` topology (D14 default). Formal classification re-done before Spike F. |
| Authentication calls / preview-secret exposure paths | One secret: viewer token in gitignored `.env`, server/CLI-side only. No client bundle exists yet to leak it. |

**Caveat:** this is a greenfield audit — findings like "no plugins, no mutation call sites" are true by construction, not by discovery. The audit must be re-run against any real codebase that adopts the overlay (the reusable-package goal, §3.1).
