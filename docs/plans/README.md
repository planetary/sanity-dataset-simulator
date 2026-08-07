# Sanity Branch Overlay — Delivery roadmap and plan index

**Status:** Draft
**Date:** 2026-08-03
**Source:** [docs/PRD-v1.md](../PRD-v1.md) (Revised feasibility specification, 2026-08-03)
**Roadmap phase:** Index for phases 1 through 9

---

## 0. SCOPE AMENDMENT — 2026-08-05 — promotion is out of scope permanently

**Owner ruling, 2026-08-05.** This system must never write to a real Sanity dataset. Branch edits live in `.sanity-overlay/` or a private Vercel Blob namespace; pushing content back to staging is out of scope **permanently, not deferred**. Nothing is written to Sanity's asset API either. The binding statement is [PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity); this document is corrected to match it.

What changed here:

- **Roadmap Phase 8 is now assets only.** Its promotion half is struck. There is no `[M-PROMO]` exit.
- **The `[M-PROMO]` milestone tracker (§9.2) is retired.**
- **The Phase 7→8 promotion sequencing constraint (§5.1) is void**, as is the promotion half of the §5.2 overlap note.
- **D01 is half settled:** branch assets are never uploaded to Sanity. Whether *local* branch asset uploads are launch-critical is still open.
- **Assets remain in scope** in their local and private-Blob form. Without them a branch cannot contain a new image at all.

---

## 1. Project summary and product boundary

The Sanity Branch Overlay creates a virtual Sanity dataset per branch by combining a live, read-only Sanity staging base with a branch-scoped copy-on-write overlay stored as local JSON files or private Vercel Blob objects (PRD §0.1). The architecture is fixed by PRD §0.2: the shared base is the live staging dataset and is never cloned per branch; local persistence lives under `.sanity-overlay/`; Vercel preview persistence lives in a private Vercel Blob namespace because normal Vercel Functions cannot persist writes to the deployed filesystem; schema changes stay in branch code and are never serialized into overlay storage; all branch Studio content writes route to the overlay and never mutate staging; reads resolve current staging content and then apply branch-local drafts, published versions, field overrides, new documents, and tombstones; queries are parsed and evaluated over a complete finite candidate set and fail clearly when exactness cannot be guaranteed; and **promotion is out of scope permanently** — see [section 0](#0-scope-amendment--2026-08-05--promotion-is-out-of-scope-permanently) and [PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity). Branch content is never written back to staging.

**Product boundary (PRD §0.4).** This product is a branch-preview authoring layer. It is **not** a full replacement for Sanity Content Lake. Core document editing is in scope. Hosted collaboration, history, releases, scheduling, search infrastructure, source maps, automations, and third-party integrations are either degraded, custom, deferred, or unavailable. Production and shared staging continue to use Sanity Content Lake directly with `OVERLAY_MODE=off` (PRD §9.2).

Architecture vocabulary used throughout the phase plans — environment-aware client, Studio adapter, Overlay API, base client, overlay resolver, filesystem store, Blob store, query planner, GROQ evaluator, event bus, conflict engine, validator, checkpoint exporter, cleanup worker — is defined in PRD §9.1. (§9.1's "promotion planner" is retired; the module was deleted on 2026-08-05.) Package names (`sanity-overlay-core`, `-store-fs`, `-store-blob`, `-query`, `-studio`, `-next`, `-cli`, `-testkit`) are defined in PRD §10.

---

## 2. Roadmap

> **Numbering warning.** Roadmap phase numbers are **offset by one** from the PRD's internal §37 phase numbers. See [section 4, PRD phase-number mapping](#4-prd-phase-number-mapping), before reading any narrative below.

| Roadmap phase | Title | PRD §37 mapping | Milestone exit |
|---|---|---|---|
| 1 | Repository audit and feasibility gates | PRD Phase 0 + §36 spikes + §0.3 gates | All six gates A–F pass or architecture pivot per §0.6 |
| 2 | Core domain engine and memory adapter | PRD Phase 1 | Pure core passes unit, property-based, contract, invariant tests |
| 3 | Local filesystem mode | PRD Phase 2 | `[M-LOCAL]` acceptance (§38.1) |
| 4 | Blob preview persistence and identity | PRD Phase 3 | `[M-PREVIEW]` acceptance (§38.2) |
| 5 | Studio core parity | PRD Phase 4 | Studio E2E suite passes, no staging writes |
| 6 | GROQ query layer and frontend migration | PRD Phase 5 | Empty-overlay and fixture parity exact |
| 7 | Conflicts, checkpoint and CI | PRD Phase 6 | `[M-PROD]` acceptance (§38.3) |
| 8 | Assets (local and preview only) | PRD Phase 7, minus its Sanity-upload tasks | Branch assets can be authored, previewed and checkpointed — **no `[M-PROMO]`; promotion is out of scope** |
| 9 | Hardening and reusable release | PRD Phase 9 | Versioned package release, security review passed |

---

## 3. Phase narratives

**Phase 1 — Repository audit and feasibility gates (PRD §37 Phase 0).** Goal: produce enough project-specific evidence to either enter implementation or pivot the architecture. Workstreams are the PRD Phase 0 audit checklist (Studio and plugin inventory, client and visual-editing versions, schema types, custom inputs and Structure Builder code, all frontend GROQ queries, direct client imports, native mutation call sites, asset workflows, auth and preview protection, staging document counts and sizes, cross-dataset references, hosted-feature usage, alternatives matrix, repository and fork trust classification, and — as a separate audit item — authentication calls and preview-secret exposure paths), the six spikes in PRD §36 (A Studio interception, B Blob manifest transaction, C GROQ corpus, D schema compatibility, E assets only if D01 classifies branch uploads as launch-critical, F safety and trust boundary), and the Phase 0 decisions listed in §37 (interception strategy, listener compatibility contract, preview trust mode and fork policy, V1 query registry contents from Spike C, launch-critical query/plugin/asset lists, Blob physical layout, auth model, launch degradation list, asset launch-criticality). Exit: **all six gates A–F in PRD §0.3 pass, or a written pivot decision per §0.6 precedes further implementation.** Spike bounds and required evidence are fixed by §36.0; a partial prototype does not count as a pass (§0.6). Milestone alignment: gate-specific, no `[M-*]` tag (§1.3).

**Phase 2 — Core domain engine and memory adapter (PRD §37 Phase 1).** Goal: implement the pure, dependency-free domain core so that every later adapter is a thin persistence shell. Workstreams: types and serialization (manifest, document record, operation, transaction and conflict schemas, canonical JSON serializer, checksums, ID and path encoding, format version handling, overlay-format migration framework); the mutation engine (create, create-if-not-exists, create-or-replace, delete and tombstones, set, set-if-missing, unset, insert, inc/dec, diff-match-patch, multi-document transactions, idempotency, synthetic revisions and timestamps); the merge engine (perspective resolution, touched-path tracking, three-way merge, explicit unset suppression, keyed array merge, structural conflict detection, base deletion recovery, automatic rebase, manual resolution operations); and references (extraction, virtual target resolution, overlay reverse-reference scan, strong and weak integrity checks, ID migration plan model). Exit: pure core passes unit, property-based, memory store contract, and invariant tests (§37 Phase 1; §35). Milestone alignment: `[M-LOCAL]` default for PRD §§2–14 (§1.3), with the core package carrying no Next.js or Vercel dependency (§10.1).

**Phase 3 — Local filesystem mode (PRD §37 Phase 2).** Goal: a developer or coding agent can complete a full local schema and content workflow against the live staging base with `OVERLAY_MODE=fs`. Workstreams: `FsOverlayStore` (atomic temp-file-plus-rename writes, expected revision checks, canonical serialization, direct-edit watcher, invalid file recovery, local runtime history, local cleanup); local API and client (environment-aware client in `fs` mode, document/mutation/actions/status endpoints, local SSE or event bridge, no-staging-write guards); the CLI (`inspect`, `status`, `validate`, `diff`, `reset`, `rebase`, `conflicts`, `query`, `export`, `import`); and local UX (Studio overlay banner, local conflict tool, file parse error UI, reset actions). Exit: PRD §37 Phase 2 acceptance plus the full `[M-LOCAL]` acceptance list in §38.1. Milestone alignment: `[M-LOCAL]`. **This phase must pull forward minimal slices of Studio integration (§21) and the query layer (§22)** — see [section 5.3](#53-known-tension-m-local-crosses-phase-boundaries).

**Phase 4 — Blob preview persistence and identity (PRD §37 Phase 3).** Goal: a Vercel Preview Deployment supports durable branch editing with `OVERLAY_MODE=blob` and no Vercel Sandbox. Workstreams: the Blob store (pin and verify `@vercel/blob`, `BlobOverlayStore`, private store authentication, cache-bypassed manifest reads, immutable document revisions and transaction records, conditional `ifMatch` manifest writes, retry and reapply logic, orphan revision cleanup, retention metadata, and the v1.1 minimal checkpoint export task that dumps Blob overlay state to canonical `.sanity-overlay/` files through the CLI, satisfying §38.2); overlay identity (derive PR identity from trusted Vercel system variables, branch fallback, branch-to-PR migration, cross-redeployment persistence, isolation tests); the preview API (preview auth integration, overlay session, CSRF protection, Blob mutation and status endpoints, SSE or polling update channel, health checks); and preview UX (banner, saving/conflict/storage error states, uncheckpointed revision counter, closed-overlay read-only state). Exit: PRD §37 Phase 3 acceptance plus the `[M-PREVIEW]` acceptance list in §38.2. Milestone alignment: `[M-PREVIEW]` (§1.3 defaults for §15 and §§23, 25, 26).

**Phase 5 — Studio core parity (PRD §37 Phase 4).** Goal: required native-looking editing workflows pass browser tests through the interception strategy selected at Gate A. Workstreams: the client facade (`fetch`, `getDocument`, `getDocuments`, create methods, patch builder, transaction builder, `mutate`, `action`, audited `request` delegation, observable APIs, `listen` compatibility, `withConfig`/`config`, block unknown writes); document actions (publish, unpublish, delete, discard, duplicate, restore, rebase, resolve conflict, checkpoint); forms and references (scalars, objects, keyed arrays, Portable Text, slugs, existing and branch-created references, reference search, incoming references); and disabling hosted-only features (Comments, Tasks, Releases, Scheduled Drafts, native History controls, AI Assist and hosted Agent Actions, Vision, incompatible plugins). Exit: full Studio E2E suite passes, network audit shows no staging writes, upgrade compatibility baseline recorded (§37 Phase 4 acceptance). Milestone alignment: §21 is `[M-LOCAL]` for core Studio editing and `[M-PROD]` for full compatibility and upgrade policy (§1.3); this phase completes the `[M-PROD]` half.

**Phase 6 — GROQ query layer and frontend migration (PRD §37 Phase 5).** Goal: every required frontend and Studio query is exact or explicitly unsupported, with no silent approximation (§5.5). Workstreams: inventory and registry (stable query ID, registered checksum, candidate plan, limits, parity fixture, Tier A/B/C classification); the planner (ID, type and multi-type candidate planners, reference and reverse-reference expansion, candidate completeness checks, capacity limits, query diagnostics); the evaluator (pin `groq-js`, parse, inject dataset and context values, evaluate resolved candidates, normalize metadata, return exactness diagnostics); frontend migration (client-import codemod, lint rule for direct client imports and unregistered queries, environment-aware client swap, query IDs, remove dynamic unsupported query construction, disable native Sanity Live in overlay mode, overlay event refetch, preview error UI); and Studio queries (structure lists, document previews, reference lookups, incoming references, preview search). Exit: empty-overlay parity exact, overlay fixture parity exact, all critical routes render, unsupported queries fail clearly (§37 Phase 5 acceptance). Milestone alignment: §22 is `[M-LOCAL]` for ID and slug queries and `[M-PROD]` for the full audited corpus (§1.3); this phase completes the `[M-PROD]` half.

**Phase 7 — Conflicts, checkpoint and CI (PRD §37 Phase 6).** Goal: branch state is reviewable, reproducible, and safe to retain. Workstreams: conflict UX (conflict list tool, document conflict panel, keep local, accept base, manual value, remove override, base deletion resolution, conflict acknowledgement); checkpoint (Blob export, canonical file generation, checksum manifest, downloadable bundle, CLI apply, checkpoint confirmation, import and seed on preview startup, divergence detection); and CI (validate overlay file schemas, validate branch schema, validate strong references, run query parity tests, check unsupported plugins, check no write tokens in preview configuration, check checkpoint status policy, report conflict summary on PR, schedule recurring base drift scan, refresh PR status when drift changes conflicts). Exit: PRD §37 Phase 6 exit plus the `[M-PROD]` acceptance list in §38.3, evidenced against the §39.5 definition of done, whose preamble scopes it to "the production-ready preview release". Milestone alignment: `[M-PROD]` (§1.3 defaults for §§27–29 and §§31–35). **Scope caveat:** this phase's exit closes the §38.3 acceptance list only, not every requirement carrying a `[M-PROD]` default. §1.3 also defaults §24 (Assets) to `[M-PROD]` "unless branch asset uploads are explicitly deferred", and those asset requirements are scheduled in roadmap Phase 8 — so `[M-PROD]` is not fully discharged at Phase 7 unless D01 removes §24 from `[M-PROD]` scope. Per §1.4 this phase must not be recorded as completing requirements it did not build; see [section 10](#10-open-questions), resolution log row 6 and open decision D01.

**Phase 8 — Branch assets, local and preview only (PRD §37 Phase 7).** Goal: a branch can contain a new image, stored where the branch stores everything else. Asset workstream: custom asset source, local file upload, private Blob upload, signed operation URLs, metadata extraction, synthetic asset documents, authenticated preview delivery, asset usage tracking, delete protection, checkpoint metadata, asset cleanup. Exit: PRD §37 Phase 7 exit, minus its Sanity-upload tasks. Milestone alignment: §24 assets default `[M-PROD]` unless branch uploads are explicitly deferred by D01.

> **Struck 2026-08-05 ([PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity)).** The promotion workstream (PRD §37 Phase 8, §30) and the two asset tasks that existed only to serve it — *Sanity upload during promotion* and *reference rewrite* — are out of scope permanently. `packages/sanity-overlay-core/src/promotion/**` and its 108 tests were deleted on the same day. There is no `[M-PROMO]` exit for this phase.
>
> **Known gap, unresolved:** `client.assets.upload` is refused outright by the Studio facade today, so adding a new image to a branch does not work yet. The design direction is local-only upload into the overlay; it is unbuilt.

**Phase 9 — Hardening and reusable release (PRD §37 Phase 9).** Goal: the package is safe for repeated use across codebases. Workstreams: performance budgets pass (§5.4), failure injection passes (§33), security review passes (§5.5: no unresolved P0 or P1 findings), documentation complete, example application, migration guide for existing Sanity clients, plugin compatibility guide, query registry guide, on-call and incident runbook, cleanup automation, versioned package release, and a Sanity upgrade compatibility process. Exit: versioned package release with security review passed (§37 Phase 9). Milestone alignment: PRD §38 defines no fifth release milestone, so Phase 9 exit evidence is measured against the §37 Phase 9 checklist, the §5.4 performance targets, and the §5.5 quality targets rather than an `[M-*]` acceptance list — codified since v1.1 in the §37 exit evidence policy. §39.5 is **not** Phase 9 evidence: its preamble scopes it to the production-ready preview release, which this roadmap places at Phase 7.

---

## 4. PRD phase-number mapping

The PRD's §37 implementation plan is zero-indexed (Phase 0 through Phase 9). This roadmap is one-indexed. **Roadmap Phase N = PRD §37 Phase N-1 for N = 1 through 8; roadmap Phase 9 = PRD §37 Phase 9.** (Before 2026-08-05, roadmap Phase 8 merged PRD Phases 7 and 8 and the offset closed at the merge. With PRD Phase 8 out of scope, roadmap Phase 8 maps to PRD Phase 7 alone and the offset closes because PRD Phase 8 no longer exists.) Every phase plan document must restate this mapping wherever it cites §37.

| Roadmap phase | PRD §37 phase | PRD §37 phase title | Notes |
|---|---|---|---|
| 1 | Phase 0 | Repository audit and feasibility | Also covers §36 spikes and §0.3 gates |
| 2 | Phase 1 | Core domain and memory adapter | |
| 3 | Phase 2 | Filesystem local mode | |
| 4 | Phase 3 | Blob preview mode | |
| 5 | Phase 4 | Studio core parity | |
| 6 | Phase 5 | Query layer and frontend migration | |
| 7 | Phase 6 | Conflicts, checkpoint, and CI | |
| 8 | Phase 7 | Assets | PRD Phase 8 (promotion) is **out of scope permanently** (2026-08-05), so the merge no longer applies |
| 9 | Phase 9 | Hardening and reusable release | Numbering realigns because the Phase 8 merge closes the offset; still PRD Phase 9 |

Any bare "Phase N" in the PRD's §39 risk table or §39.3 decision table means the **PRD** phase, without exception; translate every occurrence through the table above. Examples: §39.1 "Phase 0 and 4" → roadmap Phases 1 and 5; D09 "Phase 0 exit", D01 "Phase 0 audit, before spike scheduling completes" (v1.1), and D08 "Phase 0 audit" → roadmap Phase 1; D06 retention and D12 base webhook invalidation, both due "Before Phase 3", → before roadmap Phase 4; PRD Phase 6 → roadmap Phase 7; PRD Phase 7 → roadmap Phase 8. D10 and D11 are moot (2026-08-05) — both asked a question about promotion.

---

## 5. Sequencing and dependencies

### 5.1 Hard sequencing constraints (PRD-derived)

- **Phase 1 blocks all implementation.** The project does not enter full implementation until all six gates in PRD §0.3 pass (§0.3 preamble). Failed gates produce a written pivot decision before more implementation begins (§0.6).
- **Gate A (D13) has no default.** If neither Studio interception strategy passes, the project stops and chooses between a custom document tool and a hosted Sanity alternative (§0.6, §39.3 D13). Phases 3, 5 and 6 all depend on the selected strategy.
- **Gate C blocks Phase 4.** Blob concurrency evidence (§0.3 Gate C, §36.2) must exist before `BlobOverlayStore` implementation; the §0.6 fallback is a transactional database adapter.
- **Gate D blocks Phase 6 scope.** The Tier A/B/C classification from Spike C (§36.3) determines whether general preview parity can be claimed at all (§0.6 threshold: more than 10 percent of launch-critical queries, or more than five, remaining Tier C).
- **Gate E blocks Phase 4 preview auth.** The trust topology decision (D14) must precede any preview deployment holding overlay credentials (§0.3 Gate E, §36.6).
- **Gate F blocks the Phase 2 manifest type.** The overlay identity input, the `sha256(canonical-json-input).slice(0, 32)` hash rule, and the lifecycle state set (§12.1–§12.3) are consumed directly by `OverlayManifest.overlayId`, `status` and `source` (§13.1), so identity must be settled before the manifest type is frozen. See the [Phase 2 plan](phase-2-core-domain.md), section 2, and the [Phase 1 plan](phase-1-audit-and-feasibility.md), section 7.2.
- **Phase 2 blocks Phases 3 and 4.** Both store adapters implement the same contract (§10.1) and must pass the same contract test suite (§5.1), which is defined in Phase 2.
- **Phase 7 checkpoint depends on Phase 4 Blob state.** Blob export and canonical file generation operate on the manifest and revision layout produced in Phase 4 (§37 Phase 6 checkpoint tasks; §29).
- ~~**Phase 8 promotion depends on Phase 7 conflict recomputation.**~~ **VOID — 2026-08-05** ([PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity)): there is no promotion, so this constraint is removed rather than reordered.
- **PRD §1.4 constraint.** Phase plans may implement later-milestone foundations early, but cannot redefine an earlier milestone as complete. A phase that lands a partial `[M-PROD]` slice does not thereby claim `[M-PROD]`.

### 5.2 Overlap opportunities — Plan-level guidance

The following is sequencing guidance added by this plan, not a PRD requirement:

- Design and test-harness scaffolding for Phase 2 (core domain) may proceed while gates are still open, but no Phase 2 implementation is accepted as complete until all six gates A–F pass (§0.3 preamble; §0.6 requires a written pivot decision before more implementation begins on a failed gate). Once the gates close, Phase 2 has no Studio, Blob, or query dependency (§10.1) and can proceed independently of Phases 4, 5 and 6.
- Phases 5 (Studio parity) and 6 (query layer) can run in parallel after Phase 3 lands, provided both consume the same environment-aware client contract. Studio structure and reference queries (§37 Phase 5 "Studio queries") are the shared seam and should be owned by one of the two workstreams explicitly.
- Phase 4 (Blob) and Phase 5 (Studio parity) can overlap: Blob work is store-layer and identity-layer, Studio work is client-facade and form-layer.
- ~~Within Phase 8, the assets track (PRD Phase 7) and the promotion-plan model (PRD Phase 8) can start together; asset mapping and reference rewrite are the join point.~~ **VOID — 2026-08-05** ([PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity)): Phase 8 is a single assets track. Asset mapping and reference rewrite existed only to serve promotion and are struck.
- Phase 9 documentation, runbook, and migration-guide work can start during Phase 7 and be finished in Phase 9.
- Everything downstream of Phase 1 is blocked in full if the §0.6 abort thresholds are hit; overlap planning does not survive a pivot.

### 5.3 Known tension: `[M-LOCAL]` crosses phase boundaries

PRD §38.1 defines `[M-LOCAL]` acceptance as including "Existing document can be edited", "Studio writes canonical files", and "Registered ID and slug queries work". PRD §1.3 confirms that §21 (Studio integration) defaults to `[M-LOCAL]` **for core Studio editing** and that §22 (GROQ layer) defaults to `[M-LOCAL]` **for ID and slug queries** — with the remainder of both sections deferred to `[M-PROD]`. But PRD §37 places the Studio client facade in Phase 4 (roadmap Phase 5) and the query planner/registry in Phase 5 (roadmap Phase 6).

**Consequence:** roadmap Phase 3 must pull forward the minimal `[M-LOCAL]` slices of both, namely:

- Core Studio editing sufficient for §38.1: edit existing document, create new document, draft and branch publish, tombstone delete, basic reference dereference, canonical file writes (§21 `[M-LOCAL]` scope per §1.3).
- ID and slug query planning and evaluation sufficient for §38.1 "Registered ID and slug queries work", including the reduced ID/slug query registry (§22 `[M-LOCAL]` scope per §1.3; since v1.1 the reduced registry is a §37 Phase 2 minimal-slice task, with the full registry, codemod, and lint enforcement remaining in §37 Phase 5).

Per §1.4, landing those slices in Phase 3 **does not** make roadmap Phase 5 or Phase 6 complete, and does not permit claiming `[M-PROD]`. The full compatibility, upgrade-policy, and audited-corpus work stays in Phases 5 and 6.

**Resolved in PRD v1.1:** PRD §37 Phase 2 now carries an explicit "Minimal Studio and query slice `[M-LOCAL]`" checklist defining the pulled-forward boundary — core Studio editing through the Gate A strategy (scalar, object, keyed array, Portable Text, slug, and reference fields; create, edit, publish, unpublish, discard, delete, duplicate), a reduced query registry with only the ID and slug entries plus parity fixtures, and ID and slug candidate planners. See the resolution log in [Open questions](#10-open-questions).

---

## 6. Kill and pivot criteria

Reproduced from PRD §0.6. **The PRD is the source of truth; if this table and [PRD §0.6](../PRD-v1.md) diverge, the PRD wins.** Reaching any trigger also reopens the alternatives matrix in §0.5 (§0.5 decision rule 3).

| Trigger | Required response | Primarily affects (roadmap phases) — Plan-level guidance |
|---|---|---|
| Neither Studio interception strategy supports scalar, object, keyed array, Portable Text, reference, draft, publish, unpublish, delete, authentication, and save-state flows | Stop native-Studio parity work and decide between a custom document tool or a hosted Sanity alternative | Phases 1, 3, 5 |
| Listener emulation causes lost keystrokes, cursor jumps, stuck save indicators, duplicate patches, or stale panes after two focused repair attempts | Stop and change the Studio integration strategy | Phases 1, 5 |
| More than 10 percent of launch-critical queries, or more than five launch-critical queries, remain Tier C after the query audit | Add a shared base mirror or stop claiming general preview parity | Phases 1, 6 |
| More than two mandatory plugins bypass the overlay and cannot be adapted safely | Remove those plugins from overlay mode or stop the native Studio approach | Phases 1, 5 |
| Staging write protection depends on branch-controlled code behaving honestly while untrusted fork code receives secrets | Move credentials into an isolated overlay gateway or disable writable preview editing for that trust class | Phases 1, 4 |
| Blob retries cannot prove no lost updates for two tabs or agent plus human editing | Replace Blob state with a transactional database adapter | Phases 1, 4 |
| Cold mutation acknowledgement remains above 5 seconds p95 after one focused optimization pass | Degrade to explicit save, use a stable gateway, or replace Blob storage | Phases 4, 9 |
| Checkpoint output repeatedly requires full-document diffs for large documents | Use intent records plus generated snapshots as specified in §§14 and 29 | Phase 7 |

The trigger and response columns are reproduced from the two-column §0.6 table. The third column is not in the PRD: it is **plan-level guidance** mapping each trigger to the phases it primarily affects, and its numbers are **roadmap** phase numbers (see [section 4](#4-prd-phase-number-mapping)), not PRD §37 phase numbers.

Execution rules that apply to every phase (§0.6): each spike runs in an isolated branch with a reproducible fixture and an evidence report; each strategy receives at most two focused implementation attempts before an architecture review; a repair attempt must target an observed failure and must not broaden scope; a spike passes only with automated tests plus one human validation of the actual Studio workflow; a partial prototype does not count as a pass; failed gates produce a written pivot decision before more implementation begins.

---

## 7. Document index

| Roadmap phase | Plan document | State |
|---|---|---|
| 1 | [phase-1-audit-and-feasibility.md](phase-1-audit-and-feasibility.md) | Written |
| 2 | [phase-2-core-domain.md](phase-2-core-domain.md) | Written |
| 3 | `phase-3-local-fs-mode.md` | Plan doc not yet written |
| 4 | `phase-4-blob-preview.md` | Plan doc not yet written |
| 5 | `phase-5-studio-parity.md` | Plan doc not yet written |
| 6 | `phase-6-query-layer.md` | Plan doc not yet written |
| 7 | `phase-7-conflicts-checkpoint-ci.md` | Plan doc not yet written |
| 8 | `phase-8-assets.md` | Plan doc not yet written — assets only; promotion is out of scope (2026-08-05) |
| 9 | `phase-9-hardening-release.md` | Plan doc not yet written |
| Cross-phase | [testing-strategy.md](testing-strategy.md) | Written |

### 7.1 Phase 9 documentation set

PRD §37 Phase 9 names a documentation set as part of its exit checklist. These are the documents, and they live outside `docs/plans/` because they are product documentation rather than delivery planning:

| Document | Phase 9 checklist line | State |
|---|---|---|
| [README.md](../../README.md) | Documentation complete | Written 2026-08-06 |
| [migration-from-sanity-client.md](../migration-from-sanity-client.md) | Migration guide for existing Sanity clients | Written 2026-08-06 |
| [plugin-compatibility.md](../plugin-compatibility.md) | Plugin compatibility guide | Written 2026-08-06 |
| [query-registry.md](../query-registry.md) | Query registry guide | Written 2026-08-06 |
| [runbook.md](../runbook.md) | On-call and incident runbook | Written 2026-08-06 |
| `examples/local-site/` + `examples/kitchen-sink/` | Example application | Built; not owned by this document |
| [evidence/phase-1/human-validation-script.md](evidence/phase-1/human-validation-script.md) | *Not a Phase 9 line* — it discharges §0.6 for Phase 1 and is listed here because it is the procedure every gate is blocked on | Written 2026-08-06, **never run** |

Writing them does not tick the Phase 9 boxes. Phase 9 also requires performance budgets, failure injection, a security review with no unresolved P0/P1 findings, cleanup automation, a versioned package release and a Sanity upgrade compatibility process, and it closes against the §5.4 and §5.5 targets. The security review has been **run** ([security-review-2026-08-06.md](evidence/phase-1/security-review-2026-08-06.md)) and **found 3 P1 and 0 P0**, so that line is measured and failing rather than absent. Nothing else on the list is discharged, and no package is publishable (see §9 note 2).

Source of truth: [PRD-v1.md](../PRD-v1.md). Frequently referenced sections: [§0 Read this first](../PRD-v1.md), [§1 Requirement language](../PRD-v1.md), [§5 Success criteria](../PRD-v1.md), [§36 Feasibility spikes](../PRD-v1.md), [§37 Implementation plan](../PRD-v1.md), [§38 Acceptance criteria](../PRD-v1.md), [§39 Risks and open decisions](../PRD-v1.md).

---

## 8. Document conventions for phase plan authors

Every plan document under `docs/plans/` must follow these rules.

**Header block.** Start each document with:

```markdown
# <Title>

**Status:** Draft
**Date:** 2026-08-03
**Source:** [docs/PRD-v1.md](../PRD-v1.md) (Revised feasibility specification, 2026-08-03)
**Roadmap phase:** N of 9 — see the [delivery roadmap](README.md)
```

**Naming and location.** Roadmap index lives at `docs/plans/README.md`. Phase documents are `docs/plans/phase-N-<slug>.md`, using the filenames in [section 7](#7-document-index). Links between documents are relative (for example `[Phase 2 plan](phase-2-core-domain.md)`, `[PRD](../PRD-v1.md)`).

**Tagging.** Use the PRD's normative tags verbatim: `[MUST]`, `[SHOULD]`, `[LATER]`, `[VALIDATE]`, `[OUT]`, plus milestone tags `[M-LOCAL]`, `[M-PREVIEW]`, `[M-PROD]` (§1.1, §1.2). **`[M-PROMO]` is retired (2026-08-05) — do not add it to any new requirement.** Combine them as `[MUST][M-LOCAL]`. Requirements inherit the default milestone map in §1.3 unless tagged explicitly. CI rejects newly added bare `[MUST]` or `[SHOULD]` tags outside sections with an explicit default milestone (§1.4).

**Traceability.** Every task, gate, and exit criterion cites its PRD section inline, e.g. `(PRD §36.2)`. Do not invent requirements, targets, or scope that are not in the PRD. Where a plan adds sequencing, grouping, or staffing structure that is not itself in the PRD, label it **"Plan-level guidance"**.

**Phase numbering.** Wherever a document cites PRD §37, it must state the offset explicitly: roadmap Phase N maps to PRD §37 Phase N-1 for N = 1 through 8; roadmap Phase 9 maps to PRD §37 Phase 9, because PRD Phase 8 (promotion) no longer exists and the one-phase offset closes there. See [section 4](#4-prd-phase-number-mapping). *(Corrected 2026-08-06: this paragraph still carried the pre-amendment "roadmap Phase 8 covers PRD §37 Phases 7 and 8", which [section 4](#4-prd-phase-number-mapping) superseded on 2026-08-05.)*

**Milestone discipline.** Per §1.4, a phase plan may implement later-milestone foundations early, but may not redefine an earlier milestone as complete. Acceptance tests report results by milestone.

**Formatting.** GitHub-flavored markdown. Tables where they clarify. Task lists as `- [ ]` items. Prefer faithful reproduction of PRD checklists over paraphrase. No emoji.

**Ambiguity handling.** Do not silently resolve a genuine PRD ambiguity or self-tension. Record it in an "Open questions" section at the end of the document and, where it blocks work, map it to a §39.3 decision ID and owner.

---

## 9. Status tracking

**Corrected 2026-08-06.** This table previously listed phases 2 through 9 as "Not started" while their packages were built and the suite stood at 89 files / 6,558 tests — recorded as finding F-12 in the [phase-3 acceptance audit](evidence/phase-3/acceptance-audit.md). The wording below separates two things the old table conflated: **work built** and **milestone signed**. Per PRD §1.4 the second never follows from the first.

| Roadmap phase | Title | Work built | Signable? | Plan doc | Exit evidence |
|---|---|---|---|---|---|
| 1 | Repository audit and feasibility gates | Spikes A, C, D, F run; B and E partly | **No** — A, B, D conditional; E partial; C, F not started; §0.6 human validation outstanding for every gate | `phase-1-audit-and-feasibility.md` | [gate-review.md](evidence/phase-1/gate-review.md) |
| 2 | Core domain engine and memory adapter | Engineering-complete (§10 acceptance 10/10, two caveats) | **No** — blocked by Phase 1's gate constraint | `phase-2-core-domain.md` | [phase-2/acceptance-audit.md](evidence/phase-2/acceptance-audit.md) |
| 3 | Local filesystem mode | Store, CLI (16 commands), environment-aware client, watcher, Studio plugin | **No** — §38.1 audited at 6 met / 3 partial / 1 not met, plus four structural blockers | `phase-3-local-fs-mode.md` (not written) | [phase-3/acceptance-audit.md](evidence/phase-3/acceptance-audit.md) |
| 4 | Blob preview persistence and identity | **Nothing.** `OVERLAY_MODE=blob` throws at startup | No | `phase-4-blob-preview.md` (not written) | — |
| 5 | Studio core parity | Facade, document actions, hosted-feature removal, overlay-aware reads, conflict panel | **No** — none of the three exit lines discharged; there is no browser E2E suite that can run | `phase-5-studio-parity.md` (not written) | [phase-3/acceptance-audit.md §3](evidence/phase-3/acceptance-audit.md) |
| 6 | GROQ query layer and frontend migration | Registry, planner, evaluator, codemod, lint rule; 17/17 Spike C queries within §5.4 budgets | Partial — the Studio uses a **second, uncovered** planner and does not consume the registry | `phase-6-query-layer.md` (not written) | [spike-c-groq-corpus/](evidence/phase-1/spike-c-groq-corpus/report.md) |
| 7 | Conflicts, checkpoint and CI | Conflict engine, resolution actions, export/import, 8 CI checks, GitHub PR reporting | Partial — the conflict panel is unreachable in a browser (`GET /state` reports no conflicts) | `phase-7-conflicts-checkpoint-ci.md` (not written) | — |
| 8 | Branch assets (local and preview only) | Asset store, synthetic asset documents, delivery, usage tracking — **never verified in a browser**; `client.assets.upload` is refused, so a branch cannot contain a new image | No | `phase-8-assets.md` (not written) | — |
| 9 | Hardening and reusable release | Documentation set written ([§7.1](#71-phase-9-documentation-set)); example application built; security review run | **No** — no package is installable; the security review found **3 P1, 0 P0**, so §5.5's "no unresolved P0 or P1" bar is not met; no performance or failure-injection evidence; no release | `phase-9-hardening-release.md` (not written) | [security-review-2026-08-06.md](evidence/phase-1/security-review-2026-08-06.md) |

**Two notes that govern every row.**

1. **The Phase 1 gate constraint still binds.** PRD §0.3's preamble and [§5.1](#51-hard-sequencing-constraints-prd-derived) both say implementation does not complete until all six gates pass. Nothing below Phase 1 can be signed until they do, and the §0.6 human validation is user-owned work — see the [human validation script](evidence/phase-1/human-validation-script.md).
2. **No package is installable.** Packages cross-import their siblings by relative filesystem path that escapes their own root — **106 such specifiers** across `packages/*/src` as measured on 2026-08-06 (testkit excluded). Everything above runs from inside this monorepo only.

### 9.1 Gate tracker (PRD §0.3)

No box is ticked, because **§0.6's one human validation of the actual Studio workflow is outstanding for every gate** and no gate may be signed without it. Current standing per [gate-review.md](evidence/phase-1/gate-review.md):

- [ ] Gate A: Studio data-plane interception — **conditional pass.** Both tracks ran in parallel. The *"0 direct requests to Sanity"* claim is **withdrawn** (4 direct telemetry POSTs, CDP capture). Conditions: D13 ratification, the HTTP/1.1 concurrency ceiling, §0.6 human validation.
- [ ] Gate B: Listener and editor-state protocol — **conditional pass.** §21.4.1 criteria 1, 3, 4, 5 automated; criterion 2 is split and its **input-device half (cursor jumps, keystroke loss under real debounce) is browser-only and unmeasured**.
- [ ] Gate C: Blob concurrency — **not started.** User-blocked on a Vercel project and a private Blob token.
- [ ] Gate D: Query parity — **pass on correctness, boundedness and latency (2026-08-05).** 17/17 within §5.4 budgets; Tier C count 1. Open: `query.maxCandidateDocuments` unratified, and the launch-critical query list does not exist so the Tier-C *ratio* has no denominator.
- [ ] Gate E: Safety and trust boundary — **partial.** All 6 facade gaps closed; proxy default-deny with live 403 evidence. Remaining: a read-only preview token and the deployed (Vercel) half.
- [ ] Gate F: Lifecycle — **not started.** User-blocked, same unblock as C.

The procedure that closes the §0.6 clause for Gates A and B is [evidence/phase-1/human-validation-script.md](evidence/phase-1/human-validation-script.md).

### 9.2 Milestone acceptance tracker (PRD §38)

`[M-LOCAL]` — Local MVP (§38.1), roadmap Phase 3. **No box is ticked: `[M-LOCAL]` cannot be signed** while the Phase 1 gate constraint binds. The audited verdict per line, from the [phase-3 acceptance audit](evidence/phase-3/acceptance-audit.md) (2026-08-06) — **6 met, 3 partial, 1 not met**:

- [ ] `OVERLAY_MODE=fs` works with live staging base. — **NOT MET.** No artifact. The environment-variable drift that caused it has since been fixed (the read client now accepts all three prefixes and refuses an absent mode), but the live-base evidence still does not exist.
- [ ] Existing document can be edited. — **MET** at the Node layer and live on the *spike* stack; not on the product path.
- [ ] New document can be created. — **MET**, with the same caveat; the one live artifact came from Mode 2, which has no base at all.
- [ ] Draft and branch publish work. — **PARTIAL.** Node evidence reads from disk or a restarted server; no browser evidence on the product path.
- [ ] Delete uses tombstone. — **MET.** Every assertion has staging holding the document as the control.
- [ ] Basic reference dereference works. — **MET**, with the best oracle in the repo (a live Content Lake comparison) — which is `describe.skipIf` and vanishes silently in CI.
- [ ] Registered ID and slug queries work. — **MET** for the §37 Phase 2 slice. Caveat: the *Studio* does not use that registry.
- [ ] Studio writes canonical files. — **PARTIAL.** The write reaches disk and the file is canonical, but nothing composes the shipped `unstable_clientFactory` with a real server, and the write is performed by spike code.
- [ ] Git diff is deterministic. — **PARTIAL.** Byte-level determinism is well evidenced (hand-derived golden, cross-tree byte equality, `eol=lf`, CI matrix). No test invokes `git`. *(The audit's separate claim that `.gitignore` hides the overlay from Git is **stale** — `.sanity-overlay/` is tracked as of 2026-08-06.)*
- [ ] Staging cannot be mutated. — **MET; the best-evidenced claim in the repository.** Four independent layers, with non-vacuity controls on both sides — a too-weak guard *and* a block-everything guard both fail the contract.

`[M-PREVIEW]` — Preview MVP (§38.2), roadmap Phase 4:

- [ ] `OVERLAY_MODE=blob` works on Vercel Preview.
- [ ] Overlay identity survives redeployments.
- [ ] Private Blob state persists.
- [ ] Studio edits persist.
- [ ] Preview updates after edit.
- [ ] Conditional writes prevent lost updates.
- [ ] Reviewer can see overlay status.
- [ ] Blob state exports to Git.

`[M-PROD]` — Production-ready preview release (§38.3), roadmap Phase 7. Checking every box below closes the §38.3 acceptance list, not the whole `[M-PROD]` default scope: §1.3 also defaults §24 (Assets) to `[M-PROD]`, and those requirements land in roadmap Phase 8 unless D01 explicitly defers branch asset uploads (§1.4; [section 10](#10-open-questions), row 6):

- [ ] All critical Studio workflows pass.
- [ ] All required queries are registered and exact.
- [ ] Conflict UI works.
- [ ] Base deletion recovery works.
- [ ] Strong references are enforced.
- [ ] Checkpoint and import work.
- [ ] Cleanup and retention work.
- [ ] Security suite passes.
- [ ] Observability and alerts exist.
- [ ] Feature degradation is documented in Studio.

~~`[M-PROMO]` — Promotion-ready release (§38.4), roadmap Phase 8~~ — **RETIRED 2026-08-05** ([PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity)).

There is no promotion-ready release. The eight acceptance lines that stood here — deterministic plan, staging revision conflicts, target schema validation, **branch assets upload to Sanity**, safe operation order, permission-gated apply, target verification, audit record — are all void, because none of them can be satisfied without writing to a real Sanity dataset. The milestone tag itself is retired: no requirement carries `[M-PROMO]`.

Roadmap Phase 8's exit is now PRD §37 Phase 7's asset checklist minus its Sanity-upload tasks. It carries no `[M-*]` acceptance list of its own.

---

## 10. Open questions

Nine questions were recorded here when this roadmap was first written. The PRD v1.1 errata pass (2026-08-03; see the revision note in the [PRD header](../PRD-v1.md)) resolved the structural ones in place. The resolution log below maps each original question to its fix; the genuinely open product decisions remain tracked in PRD §39.3.

### 10.1 Resolution log (PRD v1.1)

| # | Original question | Resolution in PRD v1.1 |
|---|---|---|
| 1 | Minimal `[M-LOCAL]` Studio and query slice was undefined | §37 Phase 2 now carries a "Minimal Studio and query slice `[M-LOCAL]`" checklist: core Studio editing through the Gate A strategy (scalar, object, keyed array, Portable Text, slug, reference fields; create, edit, publish, unpublish, discard, delete, duplicate), a reduced ID/slug query registry with parity fixtures, and ID and slug candidate planners. Roadmap Phase 3 implements it; per §1.4 it does not close Phases 5 or 6. |
| 2 | Query registry ownership at `[M-LOCAL]` was unclear | Same fix: a reduced registry with only the ID and slug entries ships in roadmap Phase 3; the full registry, codemod, and lint enforcement remain roadmap Phase 6 (§22.5). |
| 3 | Blob export was required at `[M-PREVIEW]` but built at `[M-PROD]` | §37 Phase 3 now includes a "Minimal checkpoint export" task satisfying §38.2 through the CLI; the full checkpoint workflow, confirmation, and import remain PRD Phase 6 (roadmap Phase 7). |
| 4 | Gate D scope contradicted Spike C scope | §0.3 Gate D now requires every launch-critical query to be Tier A or accepted Tier B, with Tier C below the §0.6 threshold and no launch-critical query in Tier C, and names the Spike C pass criteria (§36.3) as the closing standard. "Launch-critical" is now a defined term (§6). |
| 5 | §38.4 unconditionally required branch asset upload | v1.1 made the line conditional on D01. **Overtaken 2026-08-05:** §38.4 is superseded in full and branch assets are never uploaded to Sanity, so the line is void rather than conditional. |
| 6 | `[M-PROD]` did not fully close at roadmap Phase 7 | The Phase 7 narrative scope caveat stands. **Amended 2026-08-05:** with §38.4 retired, PRD Phases 6–7 close against the §38.3 checklist only. Whether §24 stays in `[M-PROD]` scope still follows D01 — see 10.2. |
| 7 | Roadmap Phase 9 had no §38 milestone | The §37 "Exit evidence policy" now states PRD Phase 9 closes against its own task list plus the §5.4 performance targets and §5.5 quality targets, and scopes §39.5 to the production-ready preview release (§38.3). |
| 8 | PRD Phases 6–9 had no acceptance checklists | Same fix: the §37 "Exit evidence policy" makes the §38.3/§38.4 derivation explicit rather than assumed. |
| 9 | Gate A failure had no continuation path | §39.3 D13 now states: if neither strategy passes, PO and TO jointly issue a written pivot decision per §0.6, choosing the custom document tool (§0.5) or a hosted alternative. |

### 10.2 Still open — product decisions (PRD §39.3)

1. **D01 — Are *local* branch asset uploads required for initial launch?** Owner: PO, CMS. Due: during the Phase 0 audit (roadmap Phase 1), before spike scheduling completes. Default: existing Sanity assets only; local branch uploads deferred. Determines whether Spike E runs and whether §24 stays in `[M-PROD]` scope.
   - **Half settled 2026-08-05** ([PRD §0.0 scope amendment](../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity)): whether branch assets are ever uploaded **to Sanity** is decided — *never*. The §38.4 upload line is void regardless of how the rest of D01 lands, so that clause no longer forms part of this decision.
2. **D09 — Is Presentation click-to-edit required for launch?** Owner: PO. Due: Phase 0 exit (roadmap Phase 1). Default: no; iframe preview only. If yes, Spike A instrumentation extends to the Presentation Tool per §36.1.
