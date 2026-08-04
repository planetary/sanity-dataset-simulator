# Sanity Branch Overlay — Delivery roadmap and plan index

**Status:** Draft
**Date:** 2026-08-03
**Source:** [docs/PRD-v1.md](../PRD-v1.md) (Revised feasibility specification, 2026-08-03)
**Roadmap phase:** Index for phases 1 through 9

---

## 1. Project summary and product boundary

The Sanity Branch Overlay creates a virtual Sanity dataset per branch by combining a live, read-only Sanity staging base with a branch-scoped copy-on-write overlay stored as local JSON files or private Vercel Blob objects (PRD §0.1). The architecture is fixed by PRD §0.2: the shared base is the live staging dataset and is never cloned per branch; local persistence lives under `.sanity-overlay/`; Vercel preview persistence lives in a private Vercel Blob namespace because normal Vercel Functions cannot persist writes to the deployed filesystem; schema changes stay in branch code and are never serialized into overlay storage; all branch Studio content writes route to the overlay and never mutate staging; reads resolve current staging content and then apply branch-local drafts, published versions, field overrides, new documents, and tombstones; queries are parsed and evaluated over a complete finite candidate set and fail clearly when exactness cannot be guaranteed; and promotion is a conflict-checked plan applied through normal Sanity actions and mutations.

**Product boundary (PRD §0.4).** This product is a branch-preview authoring layer. It is **not** a full replacement for Sanity Content Lake. Core document editing is in scope. Hosted collaboration, history, releases, scheduling, search infrastructure, source maps, automations, and third-party integrations are either degraded, custom, deferred, or unavailable. Production and shared staging continue to use Sanity Content Lake directly with `OVERLAY_MODE=off` (PRD §9.2).

Architecture vocabulary used throughout the phase plans — environment-aware client, Studio adapter, Overlay API, base client, overlay resolver, filesystem store, Blob store, query planner, GROQ evaluator, event bus, conflict engine, validator, checkpoint exporter, promotion planner, cleanup worker — is defined in PRD §9.1. Package names (`sanity-overlay-core`, `-store-fs`, `-store-blob`, `-query`, `-studio`, `-next`, `-cli`, `-testkit`) are defined in PRD §10.

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
| 8 | Assets and promotion | PRD Phases 7 + 8 | `[M-PROMO]` acceptance (§38.4) |
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

**Phase 8 — Assets and promotion (PRD §37 Phases 7 and 8).** Goal: branch-only assets can be authored and promoted safely, and approved content can move to staging through a conflict-checked, verified plan. Asset workstream (PRD Phase 7): custom asset source, local file upload, private Blob upload, signed operation URLs, metadata extraction, synthetic asset documents, authenticated preview delivery, asset usage tracking, delete protection, checkpoint metadata, Sanity upload during promotion, reference rewrite, asset cleanup. Promotion workstream (PRD Phase 8): promotion plan model, target revision fetch, conflict recomputation, schema validation, asset mapping, minimal patch generation, document action generation, operation ordering, human-readable diff, plan checksum and expiry, separate publisher authorization, apply with revision recheck, verify resulting revisions, recovery plan for partial multi-transaction apply, mark promoted and retain audit. Exit: PRD §37 Phase 7 and Phase 8 exits plus the `[M-PROMO]` acceptance list in §38.4. Milestone alignment: §24 assets default `[M-PROD]` unless branch uploads are explicitly deferred by D01; §30 promotion is `[M-PROMO]` (§1.3, §39.3).

**Phase 9 — Hardening and reusable release (PRD §37 Phase 9).** Goal: the package is safe for repeated use across codebases. Workstreams: performance budgets pass (§5.4), failure injection passes (§33), security review passes (§5.5: no unresolved P0 or P1 findings), documentation complete, example application, migration guide for existing Sanity clients, plugin compatibility guide, query registry guide, on-call and incident runbook, cleanup automation, versioned package release, and a Sanity upgrade compatibility process. Exit: versioned package release with security review passed (§37 Phase 9). Milestone alignment: PRD §38 defines no fifth release milestone, so Phase 9 exit evidence is measured against the §37 Phase 9 checklist, the §5.4 performance targets, and the §5.5 quality targets rather than an `[M-*]` acceptance list — codified since v1.1 in the §37 exit evidence policy. §39.5 is **not** Phase 9 evidence: its preamble scopes it to the production-ready preview release, which this roadmap places at Phase 7.

---

## 4. PRD phase-number mapping

The PRD's §37 implementation plan is zero-indexed (Phase 0 through Phase 9). This roadmap is one-indexed. **Roadmap Phase N = PRD §37 Phase N-1 for N = 1 through 7; roadmap Phase 8 covers PRD §37 Phases 7 and 8; roadmap Phase 9 = PRD §37 Phase 9 (the one-phase offset closes at the merge).** Every phase plan document must restate this mapping wherever it cites §37.

| Roadmap phase | PRD §37 phase | PRD §37 phase title | Notes |
|---|---|---|---|
| 1 | Phase 0 | Repository audit and feasibility | Also covers §36 spikes and §0.3 gates |
| 2 | Phase 1 | Core domain and memory adapter | |
| 3 | Phase 2 | Filesystem local mode | |
| 4 | Phase 3 | Blob preview mode | |
| 5 | Phase 4 | Studio core parity | |
| 6 | Phase 5 | Query layer and frontend migration | |
| 7 | Phase 6 | Conflicts, checkpoint, and CI | |
| 8 | Phase 7 **and** Phase 8 | Assets; promotion | **Merged.** Two PRD phases, one roadmap phase |
| 9 | Phase 9 | Hardening and reusable release | Numbering realigns because the Phase 8 merge closes the offset; still PRD Phase 9 |

Any bare "Phase N" in the PRD's §39 risk table or §39.3 decision table means the **PRD** phase, without exception; translate every occurrence through the table above. Examples: §39.1 "Phase 0 and 4" → roadmap Phases 1 and 5; D09 "Phase 0 exit", D01 "Phase 0 audit, before spike scheduling completes" (v1.1), and D08 "Phase 0 audit" → roadmap Phase 1; D06 retention and D12 base webhook invalidation, both due "Before Phase 3", → before roadmap Phase 4; PRD Phase 6 → roadmap Phase 7; PRD Phases 7 and 8 → roadmap Phase 8.

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
- **Phase 8 promotion depends on Phase 7 conflict recomputation.** Promotion recomputes conflicts against current staging revisions (§37 Phase 8; §30).
- **PRD §1.4 constraint.** Phase plans may implement later-milestone foundations early, but cannot redefine an earlier milestone as complete. A phase that lands a partial `[M-PROD]` slice does not thereby claim `[M-PROD]`.

### 5.2 Overlap opportunities — Plan-level guidance

The following is sequencing guidance added by this plan, not a PRD requirement:

- Design and test-harness scaffolding for Phase 2 (core domain) may proceed while gates are still open, but no Phase 2 implementation is accepted as complete until all six gates A–F pass (§0.3 preamble; §0.6 requires a written pivot decision before more implementation begins on a failed gate). Once the gates close, Phase 2 has no Studio, Blob, or query dependency (§10.1) and can proceed independently of Phases 4, 5 and 6.
- Phases 5 (Studio parity) and 6 (query layer) can run in parallel after Phase 3 lands, provided both consume the same environment-aware client contract. Studio structure and reference queries (§37 Phase 5 "Studio queries") are the shared seam and should be owned by one of the two workstreams explicitly.
- Phase 4 (Blob) and Phase 5 (Studio parity) can overlap: Blob work is store-layer and identity-layer, Studio work is client-facade and form-layer.
- Within Phase 8, the assets track (PRD Phase 7) and the promotion-plan model (PRD Phase 8) can start together; asset mapping and reference rewrite are the join point and must not be started until the asset store shape is fixed.
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
| 8 | `phase-8-assets-promotion.md` | Plan doc not yet written |
| 9 | `phase-9-hardening-release.md` | Plan doc not yet written |
| Cross-phase | [testing-strategy.md](testing-strategy.md) | Written |

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

**Tagging.** Use the PRD's normative tags verbatim: `[MUST]`, `[SHOULD]`, `[LATER]`, `[VALIDATE]`, `[OUT]`, plus milestone tags `[M-LOCAL]`, `[M-PREVIEW]`, `[M-PROD]`, `[M-PROMO]` (§1.1, §1.2). Combine them as `[MUST][M-LOCAL]`. Requirements inherit the default milestone map in §1.3 unless tagged explicitly. CI rejects newly added bare `[MUST]` or `[SHOULD]` tags outside sections with an explicit default milestone (§1.4).

**Traceability.** Every task, gate, and exit criterion cites its PRD section inline, e.g. `(PRD §36.2)`. Do not invent requirements, targets, or scope that are not in the PRD. Where a plan adds sequencing, grouping, or staffing structure that is not itself in the PRD, label it **"Plan-level guidance"**.

**Phase numbering.** Wherever a document cites PRD §37, it must state the offset explicitly: roadmap Phase N maps to PRD §37 Phase N-1 for N = 1 through 7; roadmap Phase 8 covers PRD §37 Phases 7 and 8; roadmap Phase 9 maps to PRD §37 Phase 9, because the one-phase offset closes at the merge. See [section 4](#4-prd-phase-number-mapping).

**Milestone discipline.** Per §1.4, a phase plan may implement later-milestone foundations early, but may not redefine an earlier milestone as complete. Acceptance tests report results by milestone.

**Formatting.** GitHub-flavored markdown. Tables where they clarify. Task lists as `- [ ]` items. Prefer faithful reproduction of PRD checklists over paraphrase. No emoji.

**Ambiguity handling.** Do not silently resolve a genuine PRD ambiguity or self-tension. Record it in an "Open questions" section at the end of the document and, where it blocks work, map it to a §39.3 decision ID and owner.

---

## 9. Status tracking

| Roadmap phase | Title | Status | Plan doc | Exit evidence location |
|---|---|---|---|---|
| 1 | Repository audit and feasibility gates | In progress (harness scaffolding done, 2026-08-03) | `phase-1-audit-and-feasibility.md` | [evidence/phase-1/](evidence/phase-1/gate-review.md) |
| 2 | Core domain engine and memory adapter | Not started | `phase-2-core-domain.md` | TBD |
| 3 | Local filesystem mode | Not started | `phase-3-local-fs-mode.md` | TBD |
| 4 | Blob preview persistence and identity | Not started | `phase-4-blob-preview.md` | TBD |
| 5 | Studio core parity | Not started | `phase-5-studio-parity.md` | TBD |
| 6 | GROQ query layer and frontend migration | Not started | `phase-6-query-layer.md` | TBD |
| 7 | Conflicts, checkpoint and CI | Not started | `phase-7-conflicts-checkpoint-ci.md` | TBD |
| 8 | Assets and promotion | Not started | `phase-8-assets-promotion.md` | TBD |
| 9 | Hardening and reusable release | Not started | `phase-9-hardening-release.md` | TBD |

### 9.1 Gate tracker (PRD §0.3)

- [ ] Gate A: Studio data-plane interception (Strategy A `unstable_clientFactory` and Strategy B HTTP proxy, run in parallel)
- [ ] Gate B: Listener and editor-state protocol
- [ ] Gate C: Blob concurrency
- [ ] Gate D: Query parity
- [ ] Gate E: Safety and trust boundary
- [ ] Gate F: Lifecycle

### 9.2 Milestone acceptance tracker (PRD §38)

`[M-LOCAL]` — Local MVP (§38.1), roadmap Phase 3:

- [ ] `OVERLAY_MODE=fs` works with live staging base.
- [ ] Existing document can be edited.
- [ ] New document can be created.
- [ ] Draft and branch publish work.
- [ ] Delete uses tombstone.
- [ ] Basic reference dereference works.
- [ ] Registered ID and slug queries work.
- [ ] Studio writes canonical files.
- [ ] Git diff is deterministic.
- [ ] Staging cannot be mutated.

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

`[M-PROMO]` — Promotion-ready release (§38.4), roadmap Phase 8:

- [ ] Promotion plan is deterministic.
- [ ] Current staging revision conflicts are detected.
- [ ] Target schema validation passes.
- [ ] Branch assets upload to Sanity (waived when D01 defers branch asset uploads; existing Sanity assets need no upload).
- [ ] Operations apply in safe order.
- [ ] Apply is permission-gated.
- [ ] Final target is verified.
- [ ] Audit record is retained.

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
| 5 | §38.4 unconditionally required branch asset upload | §38.4 now reads "waived when D01 defers branch asset uploads; existing Sanity assets need no upload". The D01 decision itself remains open — see 10.2. |
| 6 | `[M-PROD]` did not fully close at roadmap Phase 7 | The Phase 7 narrative scope caveat stands, and the new §37 "Exit evidence policy" confirms PRD Phases 6–8 close against the §38.3/§38.4 checklists only. Whether §24 stays in `[M-PROD]` scope still follows D01 — see 10.2. |
| 7 | Roadmap Phase 9 had no §38 milestone | The §37 "Exit evidence policy" now states PRD Phase 9 closes against its own task list plus the §5.4 performance targets and §5.5 quality targets, and scopes §39.5 to the production-ready preview release (§38.3). |
| 8 | PRD Phases 6–9 had no acceptance checklists | Same fix: the §37 "Exit evidence policy" makes the §38.3/§38.4 derivation explicit rather than assumed. |
| 9 | Gate A failure had no continuation path | §39.3 D13 now states: if neither strategy passes, PO and TO jointly issue a written pivot decision per §0.6, choosing the custom document tool (§0.5) or a hosted alternative. |

### 10.2 Still open — product decisions (PRD §39.3)

1. **D01 — Are branch asset uploads required for initial launch?** Owner: PO, CMS. Due: during the Phase 0 audit (roadmap Phase 1), before spike scheduling completes. Default: existing Sanity assets only; branch uploads deferred. Determines whether Spike E runs, whether §24 stays in `[M-PROD]` scope, and whether the §38.4 upload line applies.
2. **D09 — Is Presentation click-to-edit required for launch?** Owner: PO. Due: Phase 0 exit (roadmap Phase 1). Default: no; iframe preview only. If yes, Spike A instrumentation extends to the Presentation Tool per §36.1.
