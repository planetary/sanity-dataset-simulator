# Phase 2 — Core domain engine and memory adapter

**Status:** Draft
**Date:** 2026-08-03
**Source:** [docs/PRD-v1.md](../PRD-v1.md) (Revised feasibility specification, 2026-08-03)
**Roadmap phase:** 2 of 9 — see the [delivery roadmap](README.md)

> **Numbering note (applies wherever this document cites §37).** Roadmap phase numbers are offset by one from the PRD's internal §37 phase numbers. **Roadmap Phase 2 = PRD §37 Phase 1, "core domain and memory adapter."** In general roadmap Phase N = PRD §37 Phase N-1 for N = 1 through 7; roadmap Phase 8 covers PRD §37 Phases 7 and 8; roadmap Phase 9 maps to PRD §37 Phase 9, because the one-phase offset closes at the merge. See the [delivery roadmap, section 4](README.md#4-prd-phase-number-mapping).

---

## 1. Purpose and exit condition

Build the pure, dependency-free domain engine that every later phase sits on: canonical types and serialization, the mutation engine, the merge engine, the reference graph model, and an in-memory store adapter plus testkit. No storage backend, no Studio, no HTTP.

**Exit (PRD §37 Phase 1):** "Pure core behavior passes unit and property-based tests." The §37 Phase 1 *Tests* checklist enumerates four families, and this roadmap holds the phase to all four:

- [ ] Unit tests (PRD §35.2, §35.3, §35.4, §35.5, §35.6)
- [ ] Property-based tests (PRD §35.1 "Explore combinations of ancestor, base, and local mutations")
- [ ] Memory store contract tests (PRD §35.7)
- [ ] Invariant tests (PRD §34)

**Milestone framing (PRD §1.3, §1.4).** Sections §13 and §14 sit in the §§2-14 band and carry default milestone `[M-LOCAL]`; §§16-20 — the live base, merge engine, draft and published semantics, references and schema work built here — are `[M-LOCAL]` for basic behavior and `[M-PROD]` for *full conflict and migration coverage*; §§31-35, which include the §34 invariants and the §35 test strategy, default to `[M-PROD]`. This phase therefore builds `[M-LOCAL]` foundations and the structural hooks that `[M-PROD]` conflict coverage will need, but it **must not** be reported as completing `[M-PROD]`, and it cannot redefine `[M-LOCAL]` as complete — `[M-LOCAL]` acceptance is owned by roadmap Phase 3 (PRD §38.1). Per §1.4, implementing later-milestone foundations early is allowed; renaming an earlier milestone complete is not.

---

## 2. Prerequisites from Phase 1

Phase 1 (roadmap) = PRD §37 Phase 0 and closes the nine decisions listed at PRD §37 Phase 0 *Decisions* (as revised in v1.1) plus the six gates at PRD §0.3. The [Phase 1 plan](phase-1-audit-and-feasibility.md), section 7.2, records the same dependencies from the Phase 1 side.

**Hard gate constraint (PRD §0.3 preamble, §0.6).** Whatever the per-decision analysis below concludes, "the project does not enter full implementation until all six gates pass". Design and test-harness scaffolding for this phase may proceed while gates A-F are still open, but **no Phase 2 implementation is accepted as complete until all six gates pass, or until a written pivot decision is recorded** (§0.6). This matches the [delivery roadmap](README.md), section 5.2. The tables below therefore record which Phase 1 *outputs* the Phase 2 design consumes; they are not a licence to close Phase 2 before the gates close.

*Plan-level guidance: the blocking analysis below — and the mapping of each decision to the §0.3 gate that informs it — is sequencing judgement derived from the PRD's package boundaries (§10.1), not a PRD statement. The decision column reproduces the §37 Phase 0 checkboxes (as revised in PRD v1.1); the gate names are §0.3 titles.*

| Phase 1 decision (PRD §37 Phase 0) | Blocks Phase 2? | Reasoning |
|---|---|---|
| Approve client interception strategy from parallel Strategy A and B evidence (informed by Gate A: Studio data-plane interception) | **No** | Core has no Studio or transport surface (PRD §10.1: core has no Next.js or Vercel dependency). Interception blocks roadmap Phase 5, not core types. |
| Approve listener compatibility contract (informed by Gate B: listener and editor-state protocol) | **No** | Event shapes are a Studio/API concern (§21, §25.8). Core emits domain results, not listener frames. |
| Approve preview trust mode and fork policy (informed by Gate E: safety and trust boundary) | **No** | §26 is `[M-PREVIEW]`. Core holds no credentials (§34.15 is enforced at the runtime edge). |
| Approve the V1 query registry contents from Spike C (informed by Gate D: query parity) | **Partly — testkit only** | Registry shape (§22, `OverlayQueryDefinition`) determines which fixtures the testkit seeds for §35.11. Core merge/mutation work does not wait; testkit fixture *coverage* does. |
| Approve the launch-critical query, plugin, and asset lists (§6) | **No** | Launch-critical classification drives Spike C and Spike E scoring and Phase 6 registry scope; core types are unaffected. |
| Approve Blob physical layout (informed by Gate C: Blob concurrency) | **No** | §15 is `[M-PREVIEW]`; core types are storage-neutral. Core must expose `storageRef` (§13.2) as an opaque string so both fs and Blob adapters can fill it. |
| Approve auth model (informed by Gate E: safety and trust boundary) | **No** | Core performs no authentication and holds no credentials; the auth model lands with the API surface in roadmap Phases 3 and 4 (§26). |
| Approve launch feature degradation list (§32) | **No** | Affects Studio and query surfaces, not domain semantics. |
| Decide whether branch assets are launch-critical or deferred to Phase 7 (D01, Spike E) | **No** | Assets (§24) land in roadmap Phase 8. PRD v1.1 fixed the checkbox's deferral target to PRD Phase 7 ([Phase 1 plan, §9 resolution log OQ-9](phase-1-audit-and-feasibility.md#9-open-questions)); under either reading assets fall outside Phase 2. |

**Gate dependency** (PRD §0.3 feasibility gate, *not* a §37 Phase 0 decision):

| Gate | Blocks Phase 2? | Reasoning |
|---|---|---|
| Gate F: lifecycle (identity, retention) | **Partly** | Overlay identity input and hash rule (§12.1, §12.2) and lifecycle states (§12.3) are consumed directly by the manifest type (§13.1 `overlayId`, `status`, `source`). Identity must be settled before the manifest type is frozen. |

**Hard inputs this phase consumes:**

- Overlay identity input shape and `sha256(canonical-json-input).slice(0, 32)` rule (PRD §12.1) — the canonical JSON serializer built here must be the one that hashes it.
- Lifecycle state set and write/cleanup rules (PRD §12.3) — becomes `OverlayManifest.status`.
- Configuration shape including `mode: 'off' | 'fs' | 'blob' | 'memory'` (PRD §11.1) — `memory` is a first-class product mode, so the memory adapter built here is not test-only scaffolding.
- Pinned dependency versions (PRD §5.5).

---

## 3. Package scaffolding

*Plan-level guidance, grounded in PRD §10 and constrained by §10.1.*

```text
packages/
  sanity-overlay-core/
    types/          # §13 canonical data model, §13.6 paths, §12 identity types
    mutations/      # §13.7 operations, §25.6 primitives, §18.4-18.9 document actions
    merge/          # §17 three-way merge, §16.4 base deletion, §28.5 auto-rebase
    perspectives/   # §18.1-18.3 published / drafts / raw resolution
    conflicts/      # §13.11 taxonomy, §17.4 severity, §28.3 resolution operations
    references/     # §19 extraction, resolution, reverse scan, integrity, migration plans
    validation/     # §17.3 step 9 validation port, §20.5 timing hooks
  sanity-overlay-testkit/
```

Constraints that are testable in CI from day one:

- [ ] `[MUST]` Core package has **no** Next.js or Vercel dependency (PRD §10.1). Enforce with a dependency-boundary lint rule.
- [ ] *Plan-level guidance* (derived from the §10 package split; **not** a §10.1 MUST): core has no `node:fs`, no `@vercel/blob` and no `@sanity/client` **runtime** import — store access is through the adapter contract only (PRD §10.1 "Store adapters implement the same contract"). Type-only imports of Sanity document types are explicitly permitted, because §13.4 (`snapshot: SanityDocument`), §13.5 (`materialized: SanityDocument`) and §13.7 (`replaceDocument`) define core types in terms of them.
- [ ] *Plan-level guidance* — Core is Node-safe and browser-safe: no browser globals, no Node-only globals in shared paths. (PRD §10.1 states a Node-safety requirement only for `sanity-overlay-query`; the same rule is applied to core as plan-level guidance because core is imported by both the Studio and Next packages.)
- [ ] `[SHOULD]` Testkit provides deterministic fixture datasets and parity helpers (PRD §10.1).
- [ ] Exact versions pinned for every dependency named in PRD §5.5 that core touches (`groq-js` only if the testkit needs it; see §7 non-goals).

---

## 4. Workstream W1 — Types and serialization

PRD §37 Phase 1 checkboxes, reproduced verbatim, with the concrete schema each refers to.

- [ ] **Define manifest schema.** → `OverlayManifest` (PRD §13.1): `formatVersion`, `overlayId`, `status` (the six §12.3 lifecycle states), `base`, `source`, `revision`, timestamps, actors, `documentHeads: Record<string, OverlayDocumentHead>`, `transactionHead`, `conflictSummary {total, hard, soft}`, `checkpoint`, `promotion`, `expiresAt`. Also define `OverlayDocumentHead` (PRD §13.2) with `state`, `hasDraft`, `hasPublished`, `hasConflict`, `storageRef`, `checksum`, and `OverlayActor` (PRD §13.8).
- [ ] **Define document record schema.** → `OverlayDocumentRecord` (PRD §13.3) with `origin: 'base' | 'branch'`, the nullable `base` block (`published`/`draft` as `BaseDocumentVersion`, `lastObserved*Revision`, `baseStatus`), the `local` block (`published`/`draft` as `LocalDocumentVersion`, `publishedTombstone`, `draftTombstone`), and `conflicts`. Include `BaseDocumentVersion` (§13.4) and `LocalDocumentVersion` (§13.5: `materialized`, `touchedPaths`, `operations`, `ancestorKind`, `ancestorRevision`, `overlayRevision`).
- [ ] **Define operation schema.** → `OverlayOperation` union (PRD §13.7): `set`, `setIfMissing`, `unset`, `insert` (`before | after | replace`), `inc`, `dec`, `diffMatchPatch`, `replaceDocument`.
- [ ] **Define transaction schema.** → `OverlayTransactionRecord` (PRD §13.10): `transactionId`, `overlayRevisionBefore/After`, `actor`, `requestedAt`/`committedAt`, `mutations`, `affectedDocumentIds`, `resultChecksums`, `requestId`, `idempotencyKey`. Implement the document-level `OverlayMutation` envelope now defined in PRD §13.7 (v1.1): `create`, `createIfNotExists`, `createOrReplace`, `delete`, and `patch` with `ifRevision` precondition and `operations: OverlayOperation[]`, matching the §25.6 primitives (resolution of former Open question O1 — see §12).
- [ ] **Define conflict schema.** → `OverlayConflict` (PRD §13.11): the thirteen-member `type` union (v1.1 added `OVERLAY_SAME_PATH_CHANGED`), `severity: 'soft' | 'hard'`, `path`, `ancestorValue`/`baseValue`/`localValue`, `detectedAt`, `resolution` (`keep-local | accept-base | manual | rename | delete-local`). Encode default severities from the PRD §17.4 table as data, not scattered literals — the v1.1 table covers every union member, including an `OVERLAY_SAME_PATH_CHANGED` row (soft; first surfaced to the writing client at commit time per §17.11) (resolutions of former O2 and O3 — see §12).
- [ ] **Define canonical JSON serializer.** One serializer, shared by hashing, checkpoint output, and every adapter. Rules from PRD §14.3 apply to the serializer: deterministic key ordering for stable Git diffs, two-space indentation, newline at end of file. Additional grounding: §34.17 (checkpoint output deterministic for the same logical state), §12.1 (identity hash consumes canonical JSON). Must reject or strip prototype-polluting keys (PRD §35.14 "Malformed JSON prototype keys fail").
- [ ] **Define checksum functions.** Checksums appear on `OverlayDocumentHead.checksum` (§13.2), `BaseDocumentVersion.checksum` (§13.4), `CheckpointDocumentIntent.checksum` (§14.2), `OverlayTransactionRecord.resultChecksums` (§13.10), content-addressed snapshot filenames (§14.1 `snapshots/<sha256>.json`), and the synthetic `_rev` suffix (§13.9). Invariant §34.4: every document record checksum matches its serialized content. Checksum recomputation after a valid direct edit or Git merge is required (§14.3) and a stale stored checksum is repairable metadata, not a rejection — core exposes `recompute`/`verify` primitives so the Phase 3 fs adapter can honour that rule.
- [ ] **Define ID and path encoding.** Two distinct encoders: (a) `OverlayPath` / `OverlayPathSegment` (PRD §13.6) preserving keyed array identity `{_key: string}`, with numeric indexes allowed only when the array has no `_key` support and the whole array is treated as touched; (b) reversible, safe logical-ID encoding for storage keys (PRD §14.3 "Encode document IDs safely and reversibly"; must survive IDs with dots and `drafts.` prefixes per §35.9). Path traversal safety is asserted by the fs adapter in Phase 3 but the encoder contract is defined here.
- [ ] **Add format version handling.** `formatVersion: 1` is a literal on the manifest (§13.1), document record (§13.3), checkpoint intent (§14.2), transaction record (§13.10), and identity hash input (§12.1). Reads must reject unknown future versions with a structured error rather than best-effort parsing.
- [ ] **Add migration framework for future overlay format versions.** A registered, ordered, pure `vN -> vN+1` upgrade chain over manifest, document record, and transaction records, with a round-trip test harness. (Distinct from *content* migrations in §20.4 `OverlayMigration`, which are schema-driven and modelled in W4.)

Also in scope for W1 because later workstreams depend on them:

- [ ] Synthetic system field policy table (PRD §13.9) as data: `_id`, `_type`, `_createdAt`, `_updatedAt`, `_rev` behaviour for base-origin vs branch-created documents.
- [ ] Synthetic revision formatter `overlay.<overlayRevision>.<documentChecksumPrefix>` (PRD §13.9), plus a guard that code never treats a synthetic `_rev` as a valid Content Lake revision. Per PRD §13.2 (v1.1), all data-model checksums are SHA-256 over the canonical JSON serialization, hex encoded, and the prefix is the first 12 hex characters (resolution of former O4 — see §12).

---

## 5. Workstream W2 — Mutation engine

PRD §37 Phase 1 checkboxes, mapped to §13.7 operations, §25.6 primitives, and §18 semantics.

- [ ] **Implement create.** Branch-created document: `origin: 'branch'`, new logical ID, `_type` required at creation, `_createdAt` set once (PRD §13.9).
- [ ] **Implement create-if-not-exists.** Existence is evaluated against the *virtual* dataset — base plus overlay plus tombstones — not the overlay alone (PRD §35.4 "Create-if-not-exists against base and overlay").
- [ ] **Implement create-or-replace.** Follows §17.10 full-document replacement: store the complete replacement, mark all user fields touched, preserve protected system fields per policy, require explicit intent for `_type` changes, and treat `_id` changes as create-new plus reference migration (never in-place mutation).
- [ ] **Implement delete and tombstones.** Check incoming strong references in the virtual dataset and block the delete when a strong reference would become invalid — **unless the same transaction updates or deletes all referring documents** (PRD §18.8), which keeps legitimate multi-document delete transactions legal (§37 Phase 1 "Implement multi-document transactions", §35.4 "Multi-document transaction"). Otherwise set `local.publishedTombstone` and `local.draftTombstone` (PRD §13.3, §18.8). A tombstone suppresses inheritance; deleting a record is not a content delete (PRD §34.2). Preserve record metadata for diff, recovery and promotion (§18.8).
- [ ] **Implement set.** → §13.7 `{type: 'set'; path; value}`. Records `path` in `LocalDocumentVersion.touchedPaths` (§13.5) under the §17.6 object rules: track the nested path where possible, treat a full object replacement as touching the whole subtree, and preserve new upstream sibling fields when only one child path is touched. Covered by §35.4 "Set".
- [ ] **Implement set-if-missing.** → §13.7 `{type: 'setIfMissing'; path; value}`. Missingness is evaluated against the *resolved virtual document* — base merged with overlay per the §17.2 precedence — not the local record alone; this is the same base-vs-overlay existence question the PRD makes explicit for the parallel primitive in §35.4 "Create-if-not-exists against base and overlay". When the value is already present the operation is a no-op and records **no** touched path, so the path continues to inherit base. Covered by §35.4 "Set-if-missing".
- [ ] **Implement unset.** Explicit unset must be recorded as a tracked field tombstone / unset operation on a touched path, continue suppressing base fields added or changed later, and be removable to resume inheritance (PRD §17.5, invariant §34.11).
- [ ] **Implement insert.** `before | after | replace` against `_key` anchors (PRD §13.7, §17.7); non-keyed arrays are a full-array touch unless a safe numeric operation can be proven (§17.7).
- [ ] **Implement increment and decrement.** Converted into a resulting local value with the original operation retained as metadata; applied once per idempotent transaction; never replayed twice after retry; conflict when current base changed the same number after ancestor (PRD §17.8).
- [ ] **Implement diff-match-patch.** Applied to the client-observed value and stored as a materialized string; never replayed against a later base; same-path conflict when base text also changed (PRD §17.9).
- [ ] **Implement multi-document transactions.** All-or-nothing grouping; manifest commit is the single visibility point for a successful multi-document transaction (PRD §17.11).
- [ ] **Implement idempotency.** Per PRD v1.1, `idempotencyKey` is the deduplication authority (§5.3, §13.10): one idempotency key maps to one immutable transaction result (§34.6), a retried request with the same key returns the original result including its `transactionId`, and `transactionId` names and orders the committed record without participating in deduplication. Every successful transaction increments overlay revision exactly once (§34.5); retry does not duplicate an increment or insert (§35.4). (Resolution of former O5 — see §12.)
- [ ] **Implement synthetic revisions and timestamps.** Per PRD §13.9, including `_updatedAt` set to latest local mutation time in virtual output and deterministic output for the same logical state (§35.2 "Synthetic system fields are deterministic").

**Document actions (PRD §18.4-18.9).** *Plan-level sequencing:* §37 lists these under later phases' UI work, but their semantics are pure-core and PRD §35.5 tests them as unit tests, so the action reducers are built here. They are not a Studio surface — no UI in this phase.

- [ ] Edit (§18.4): editing base published or base draft creates/updates a local draft; autosave never changes local published unless live edit is explicitly enabled. Live edit mode is `[LATER]` and disabled by default (§18.10) — build the flag, not the feature.
- [ ] Publish (§18.5): validate resolved local draft and strong references, copy draft into local published, remove local draft, clear published tombstone, emit one branch transaction, and **never** call Sanity publish.
- [ ] Unpublish (§18.6): create/preserve a local draft of the resolved published document, set the published tombstone, remove local published only after the draft is safely stored, re-evaluate incoming strong references.
- [ ] Discard draft (§18.7): delete local draft state and draft-only touched paths/operations; fall back per perspective; do not remove local published.
- [ ] Delete (§18.8) and restore: strong-reference check first — the delete is blocked when a strong reference would become invalid *unless the same transaction updates or deletes all referring documents* — then both tombstones, explicit restore before checkpoint cleanup.
- [ ] Duplicate (§18.9): new logical ID, base revision metadata removed, `origin: 'branch'`, content and `_type` preserved, configured initial-value/duplicate transforms applied, starts as local draft.

---

## 6. Workstream W3 — Merge engine

PRD §37 Phase 1 checkboxes, mapped to §17, §16.4, §18.1-18.3 and §28.

- [ ] **Implement perspective resolution.** Virtual `published` (PRD §18.1), virtual `drafts` with its documented fallback chain (§18.2), and the partial/synthetic `raw` view returning base published, base draft, local published, local draft, tombstone metadata and conflict metadata, with no claim of parity with hosted raw or release perspectives (§18.3).
- [ ] **Implement touched path tracking.** `LocalDocumentVersion.touchedPaths` (§13.5). Object rules from §17.6: track nested paths where possible, treat full object replacement as touching the entire subtree, preserve new upstream sibling fields when only one child path is touched.
- [ ] **Implement three-way merge.** Inputs per §17.1 (`ancestor`, `currentBase`, `localMaterialized`, `localTouchedPaths`, `localTombstone`); precedence per §17.2 (tombstone > branch-created > local on touched paths > current base on untouched paths > ancestor only as recovery material); the ten-step algorithm of §17.3 including step 9 schema validation and step 10 deterministic checksum.
- [ ] **Implement explicit unset suppression.** §17.5 — absence alone is not an unset, because absence inherits base.
- [ ] **Implement keyed array merge.** §17.7: `_key` identity for object and Portable Text arrays, insertion tracked against stable `_key` anchors, key-collision detection, upstream deletion of a locally edited keyed item detected, independent upstream additions preserved, and deterministic ordering when both sides insert near the same anchor (`[MUST]`: an ordering must exist). This plan adopts the §17.7 `[SHOULD]` default ordering rule — base order → local insertion relative to recorded anchor → concurrent base insertions retain base order → local insertions at the same anchor retain local transaction order.
- [ ] **Implement structural conflict detection.** `PARENT_SHAPE_CHANGED` as hard conflict when the parent shape no longer supports the path (§17.3 step 7, §17.4), plus `ARRAY_ITEM_DELETED`, `ARRAY_KEY_COLLISION`, `BASE_TYPE_CHANGED`, and `LOCAL_ID_COLLISION` from the §13.11 taxonomy.
- [ ] **Implement base deletion recovery.** §16.4 matrix: untouched documents disappear; touched-and-modified documents preserve the materialized local document and mark a hard conflict; branch-created and locally tombstoned states behave per table. Invariant §34.14: base deletion never destroys a touched materialized document.
- [ ] **Implement automatic rebase for safe changes.** Allowed only under the four §28.5 preconditions (base changed only on untouched paths; array additions have distinct `_key`s; local operations apply without changing meaning; no base deletion or parent shape change). Must perform the five §28.5 steps: update ancestor snapshot and revision, preserve local materialized values, remove obsolete touched paths whose local value now equals base, record an audit transaction, revalidate the resolved document. Per PRD §13.3 (v1.1), the `base` block holds the current merge ancestor and is replaced only by rebase, in one transaction, with `firstTouchedAt` never modified (resolution of former O6 — see §12).
- [ ] **Implement manual conflict resolution operations.** The `resolution.type` set from §13.11 (`keep-local`, `accept-base`, `manual`, `rename`, `delete-local`), covering the §28.3 actions (keep branch value, accept current staging value, manually edit resolved value, remove local override and resume inheritance, keep document as branch-created after base deletion, accept base deletion, rename branch-created ID). Rebase modes from §28.4 (preview, accept-base, keep-local, full reset, freeze) are modelled as pure functions. Resolution creates a new overlay transaction (§28.1). Soft-conflict acknowledgement records actor/time/reason/base revision/local revision and is invalidated by a new base or local revision (§28.6).

*Scope boundary:* overlay-vs-overlay race handling (PRD §17.11) is a store-adapter concern (stale ETag/revision retry). Phase 2 provides the pure three-way overlay-head comparison function that §17.11 requires; the conditional-write retry loop belongs to Phases 3 and 4.

---

## 7. Workstream W4 — References

PRD §37 Phase 1 checkboxes, mapped to §19.

- [ ] **Implement reference extraction.** Walk a resolved document and yield every reference with its `OverlayPath`, target logical ID, and strong/weak classification (PRD §19.1, §19.5).
- [ ] **Implement virtual target resolution.** The §19.2 resolver order: normalize target logical ID → check applicable local tombstone → check branch-created or locally modified target → fall back to current base target → return missing-reference metadata when absent → apply requested perspective to the target. Core rule (§19.1): do not rewrite parent documents when a target changes.
- [ ] **Implement overlay reverse reference scan.** §19.4: scan overlay documents for local references; combine and deduplicate with base results (the base-side `references($ids)` query is issued by the adapter/query layer, so core takes base hits as an injected input); apply local tombstones and modifications before deciding integrity; bound recursive expansion by configuration (`query.maxReferenceDepth`, PRD §11.1); **report truncation as an error, not a complete result**.
- [ ] **Implement strong and weak integrity checks.** Strong references block target delete *unless the same transaction updates or deletes all referring documents* (§18.8); weak references permit it (§18.8, §19.5). A strong reference to a branch draft-only target blocks branch publish (§19.5). Invariant §34.10: strong references resolve to a published virtual target before branch publish. Unpublish re-evaluates strong references pointing at the newly unpublished document (§18.6).
- [ ] **Implement ID migration plan model.** §19.6: `_id` is immutable within one overlay document lineage; changing an ID creates a new document plus a migration plan for incoming references; never auto-crawl and rewrite references without showing the plan; preserve the old ID tombstone when needed to suppress the base document. Type changes (§19.7) are migrations that must validate every reference whose allowed `to` types may reject the new type. Plan shape reuses `OverlayMigration` (§20.4).

**Validation port.** PRD §17.3 step 9 requires schema validation inside the merge, and `validation/` is a core directory (§10), but the schema source is branch Studio code (§20.1). PRD v1.1 mandates the design this plan proposed: core consumes the branch schema as an injected, serialized schema artifact and never imports Studio code (§10.1), with the artifact extracted from branch schema code (§20.1). This phase therefore defines the validator as an injected port with a no-op default plus a fixture validator in the testkit, so merge output can be tested without Studio. Validation *timing* hooks follow §20.5. (Resolution of former O7 — see §12.)

---

## 8. Workstream W5 — Memory store and testkit

### 8.1 Memory adapter

`memory` is a configured runtime mode (PRD §11.1 `mode`), and store adapters must implement the same contract (§10.1). The memory adapter is the reference implementation of that contract and the yardstick for the fs adapter (Phase 3) and Blob adapter (Phase 4).

- [ ] Define the store contract interface (surface derived from PRD §35.7 behaviours, §13.10 transaction shape, and §25.5 preconditions `expectedOverlayRevision` / `expectedDocumentRevisions`).
- [ ] Implement the in-memory adapter against it, with injectable clock and ID source so every test is deterministic.

### 8.2 Contract test suite (PRD §35.7 — every adapter must pass)

- [ ] Create overlay.
- [ ] Read empty overlay.
- [ ] Conditional manifest write.
- [ ] Store and read document revision.
- [ ] Commit multi-document transaction.
- [ ] Idempotent transaction replay.
- [ ] Concurrent stale write rejection.
- [ ] List changed documents.
- [ ] Read by logical ID.
- [ ] Export canonical state.
- [ ] Import canonical state.
- [ ] Mark closed.
- [ ] Mark promoted.
- [ ] Retention metadata.
- [ ] Delete overlay.
- [ ] Orphan revision cleanup.
- [ ] Checksum corruption detection.

Blob-specific (§35.8) and filesystem-specific (§35.9) tests are explicitly **not** in this phase. Quality target: 100 percent pass rate for store contract tests (PRD §5.5).

### 8.3 Executable invariant checks (PRD §34)

Implement as assertions callable from both tests and runtime debug tooling. In scope for Phase 2 (the invariants that are pure-core or memory-adapter observable):

- [ ] §34.1 One logical document has at most one current local draft and one current local published state.
- [ ] §34.2 A tombstone suppresses inheritance; deleting a local file alone is not a content delete.
- [ ] §34.3 Every manifest document head points to an existing immutable revision or valid canonical record.
- [ ] §34.4 Every document record checksum matches its serialized content.
- [ ] §34.5 Every successful transaction increments overlay revision exactly once.
- [ ] §34.6 One idempotency key maps to one immutable transaction result.
- [ ] §34.8 Orphan revisions are never visible without a manifest or checkpoint reference.
- [ ] §34.11 A local unset continues to suppress later base values until explicitly removed.
- [ ] §34.12 Untouched paths always inherit current base values when structurally compatible.
- [ ] §34.13 Touched paths preserve local intent after base change.
- [ ] §34.14 Base deletion never destroys a touched materialized document.
- [ ] §34.17 Checkpoint output is deterministic for the same logical state (serializer-level assertion; checkpoint I/O is Phase 3/7).

Deferred with an owning phase, not dropped: §34.7 and §34.19 (Phase 4), §34.9 and §34.18 and §34.20 (Phase 8), §34.10 (partially here via W4, fully at publish/promotion), §34.15 (Phases 1 and 4 safety tests), §34.16 (Phase 6).

### 8.4 Unit test corpus

Reproduce the PRD lists as the phase's unit suite: §35.2 core merge tests (17 cases), §35.3 array tests (10 cases), §35.4 mutation tests (18 cases), §35.5 draft and action tests (11 cases), §35.6 reference tests (11 cases).

- [ ] §35.2 implemented in full.
- [ ] §35.3 implemented in full.
- [ ] §35.4 implemented in full.
- [ ] §35.5 implemented in full.
- [ ] §35.6 implemented in full, with base-side reverse-reference results supplied as fixtures.

### 8.5 Property-based tests

PRD §35.1 (v1.1) now enumerates a **required minimum property list** for this layer; the former ambiguity is resolved (see §12, former O8). The list below implements every §35.1 required property and adds three plan-level properties derived from the merge rules; plan-level additions are marked.

- [ ] Serializer determinism and fixpoint: same logical value serializes byte-identically across runs and key-insertion orders, and `serialize(parse(serialize(x)))` equals `serialize(x)` (§35.1, §14.3, §34.17).
- [ ] Path encoding round-trip: encode/decode of `OverlayPath` and logical IDs is lossless, including keyed segments, dots and `drafts.` prefixes (§35.1, §13.6, §14.3, §35.9).
- [ ] Merge identity: with no touched paths and current base equal to ancestor, resolution returns the current base unchanged (§35.1).
- [ ] Keyed array merge: resolved arrays contain no duplicate `_key`, and independent insertions from both sides are all present (§35.1, §17.7).
- [ ] Rebase idempotence: automatic rebase against the same current base is idempotent (§35.1, §28.5).
- [ ] Checksum integrity: stored checksums match recomputed checksums after any generated sequence of valid operations (§35.1, §34.4).
- [ ] Untouched-path inheritance: for any generated base change on paths disjoint from `touchedPaths`, merged output equals current base on those paths (§35.1, §34.12).
- [ ] Touched-path preservation: for any base change, merged output retains local intent on touched paths, with a conflict recorded when the base changed the same path (§35.1, §34.13).
- [ ] Unset persistence: an explicit unset keeps suppressing a path across arbitrary later base mutations until removed (§35.1, §34.11, §17.5).
- [ ] Transaction idempotence: replaying a transaction under the same idempotency key never changes overlay state and returns the original result (§35.1, §34.6, §5.3, §17.8).
- [ ] *Plan-level addition* — Merge determinism: `merge(ancestor, base, local)` is a pure function — repeated evaluation yields identical output and identical checksum (§17.3 step 10).
- [ ] *Plan-level addition* — Local-equals-ancestor collapse: when a local value equals the *ancestor*, merge removes the local touch and uses current base (§17.3 step 5).
- [ ] *Plan-level addition* — Local-equals-base override removal on rebase: when a local value now equals the current *base*, automatic rebase removes the obsolete touched path (§28.5 step 3, §35.2 "Local value equal to current base removes redundant override on rebase").

**Explicitly not a property:** merge commutativity across local operation order. PRD §17.7 `[MUST]`s only that *deterministic ordering exists* when both sides insert near the same anchor; the specific rule — base order → local insertion before or after the recorded anchor → concurrent base insertions retain base order → local insertions at the same anchor retain local transaction order — is tagged `[SHOULD]`, and this plan adopts it as the default. Under that adopted `[SHOULD]` default local operation order is semantically significant, so do not assert commutativity. Revisit this conclusion if the §1.1 `[SHOULD]` escape clause ("required unless implementation evidence shows that the behavior is unnecessary or unsafe") is ever exercised against the default ordering rule.

### 8.6 Testkit

- [ ] Deterministic fixture datasets and parity helpers (PRD §10.1 `[SHOULD]`).
- [ ] Fixture builders for ancestor / current base / local triples driving §35.2-§35.6.
- [ ] Deterministic clock, actor and ID generators.
- [ ] Fixture documents shaped to satisfy the §35.11 GROQ fixture list once the V1 query registry is approved — content coverage tracked here, query execution owned by roadmap Phase 6.
- [ ] Reusable contract-test runner exported so Phases 3 and 4 can run the same §35.7 suite against fs and Blob adapters unchanged.

---

## 9. Sequencing

*Plan-level guidance.*

| Step | Work | Depends on |
|---|---|---|
| 1 | W1 types, serializer, checksums, path/ID encoding | Phase 1 identity decision (§12) |
| 2 | Memory adapter skeleton + §35.7 contract suite (red) | Step 1 |
| 3 | W2 mutation primitives + idempotency | Steps 1-2 |
| 4 | W3 perspectives and three-way merge | Steps 1-3 |
| 5 | W3 arrays, structural conflicts, base deletion recovery | Step 4 |
| 6 | W4 references and integrity | Steps 4-5 |
| 7 | W2 document actions (publish/unpublish/discard/delete/duplicate/restore) | Steps 4-6 |
| 8 | W3 auto-rebase and manual resolution | Steps 5-7 |
| 9 | Invariant checks, property-based suite, testkit hardening | All |

Steps 3-6 are the critical path; W1 format-version migration framework and testkit fixture breadth can run in parallel.

---

## 10. Phase acceptance checklist

- [ ] All PRD §37 Phase 1 checkboxes in W1-W4 are implemented.
- [ ] §35.2, §35.3, §35.4, §35.5 and §35.6 unit suites pass in full.
- [ ] Property-based suite passes: every PRD §35.1 required property plus the §8.5 plan-level additions. *Plan-level guidance:* run it against a fixed seed corpus recorded in the repository so failures reproduce.
- [ ] Memory adapter passes 100 percent of the §35.7 store contract suite (PRD §5.5 quality target).
- [ ] Phase-2-scoped §34 invariants are executable and green (§8.3).
- [ ] Dependency-boundary lint proves core has no Next.js or Vercel dependency (PRD §10.1) and — *plan-level guidance*, per §3 — no `node:fs`, `@vercel/blob` or `@sanity/client` runtime import (type-only Sanity document types excepted).
- [ ] Serializer output is byte-identical for the same logical state (PRD §34.17, §14.3, §35.9 "Deterministic serialization"). *Plan-level guidance:* additionally verify across platforms and Node versions in CI.
- [ ] Contract-test runner is exported from the testkit and consumable by Phase 3.
- [ ] Implementation matches the §12 resolution log (PRD v1.1); no unresolved open questions remain for this phase.
- [ ] Phase report states which milestone claims are made: `[M-LOCAL]` foundations only; no `[M-LOCAL]`, `[M-PREVIEW]`, `[M-PROD]` or `[M-PROMO]` acceptance is claimed (PRD §1.4, §38).

---

## 11. Non-goals for this phase

| Not in Phase 2 | Owning roadmap phase |
|---|---|
| `FsOverlayStore`, atomic writes, direct-edit watcher, local history (PRD §14, §37 Phase 2) | Phase 3 |
| `BlobOverlayStore`, `ifMatch` concurrency, retention, identity migration (PRD §15, §37 Phase 3) | Phase 4 |
| Studio client facade, actions UI, listener emulation, conflict panel UI (PRD §21, §28.2-28.3) | Phase 5 |
| GROQ planner, evaluator, query registry, parity harness (PRD §22, §35.10-35.11) | Phase 6 (minimal ID/slug planners and reduced registry pulled into Phase 3 by the v1.1 §37 Phase 2 minimal slice) |
| Checkpoint export/import to `.sanity-overlay/` files, CI status checks, drift scan (PRD §29, §16.6) | Phase 7 (a minimal Blob-export CLI path lands in Phase 4 per the v1.1 §37 Phase 3 task) |
| Assets and promotion (PRD §24, §30) | Phase 8 |
| API routes, auth, CSRF, SSE (PRD §25, §26) | Phases 3, 4 and 7 |
| Live edit mode (PRD §18.10 `[LATER]`) | Out of milestone scope; flag only |

The API surface is split across three roadmap phases, not deferred to Phase 4: the local API and event surface (PRD §37 Phase 2 "Local API and client" — document endpoints, mutation endpoint, actions endpoint, status endpoint, local SSE or event bridge, no-staging-write guards) lands first in roadmap Phase 3; preview auth, overlay session, CSRF and the preview update channel follow in roadmap Phase 4 (PRD §37 Phase 3 "Preview API tasks"); checkpoint routes land in Phase 7.

Core does depend on the *intent format* awareness of PRD §14.2-14.3 (canonical `intent.json`, content-addressed snapshots, materialized runtime output) because W1's serializer and checksum rules must be able to produce it — but no file is written in this phase.

---

## 12. Open questions

Eight questions were recorded here when this plan was first written. The PRD v1.1 errata pass (2026-08-03; see the revision note in the [PRD header](../PRD-v1.md)) resolved all eight in place. The resolution log below maps each to its fix so implementation can cite the PRD directly; no open questions remain for this phase.

### Resolution log (PRD v1.1)

- **O1 — `OverlayMutation` was referenced but never defined. Resolved.** §13.7 now defines the document-level union: `create`, `createIfNotExists`, `createOrReplace`, `delete`, and `patch` with `ifRevision` and `operations: OverlayOperation[]`, matching the §25.6 primitives. `replaceDocument` remains a patch-level operation inside `OverlayOperation`.
- **O2 — Conflict type union omitted `OVERLAY_SAME_PATH_CHANGED`. Resolved.** The §13.11 union now includes it (thirteen members). Per §17.4 it is first surfaced to the writing client at commit time (§17.11), persisted only when it remains unresolved, and a persisted instance is soft and counted in `conflictSummary.soft`.
- **O3 — Default severity was unspecified for four conflict types. Resolved.** §17.4 now carries rows for `BASE_DRAFT_DELETED` (soft; local draft wins, §18.2 fallback), `BASE_TYPE_CHANGED` (hard), `ARRAY_KEY_COLLISION` (hard), `UNSUPPORTED_SCHEMA_MIGRATION` (hard; blocks branch publish and promotion), and `OVERLAY_SAME_PATH_CHANGED` (soft), and states that every §13.11 union member maps to a table row.
- **O4 — Checksum algorithm and synthetic revision precision. Resolved.** §13.2 now specifies SHA-256 over the canonical JSON serialization (§14.3 rules), hex encoded, for all data-model checksum fields, with `documentChecksumPrefix` as the first 12 hex characters.
- **O5 — Idempotency key vs transaction ID. Resolved.** §5.3 and §13.10 now make `idempotencyKey` the deduplication authority; a retried request with the same key returns the original result including its `transactionId`, which names and orders the record without participating in deduplication. §13.10 further makes `transactionId` server-assigned (unique, commit-time ordered, e.g. a ULID) so the §15.1 immutable transaction path is collision-free, and §25.5's request field is now advisory `clientTransactionId`.
- **O6 — Ancestor storage after auto-rebase. Resolved.** §13.3 now states the `base` block holds the current merge ancestor, captured at first touch and replaced only by explicit or automatic rebase (§28.4, §28.5) in one transaction, with `firstTouchedAt` never modified.
- **O7 — Schema validation scope inside core. Resolved.** §10.1 and §20.1 now mandate the injected-port design: core consumes a serialized schema artifact extracted from branch schema code and never imports Studio.
- **O8 — Required properties for the property-based layer. Resolved.** §35.1 now enumerates the required minimum property list, implemented in §8.5 together with three marked plan-level additions. The stricter four-family exit reading (unit, property-based, contract, invariant) stands as this plan's interpretation of the §37 Phase 1 exit.
