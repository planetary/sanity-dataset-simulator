# Phase 1 — Repository audit and feasibility gates

**Status:** Draft
**Date:** 2026-08-03
**Source:** [docs/PRD-v1.md](../PRD-v1.md) (Revised feasibility specification, 2026-08-03)
**Roadmap phase:** 1 of 9 — see the [delivery roadmap](README.md)

**PRD phase mapping.** This roadmap phase implements **PRD §37 Phase 0**. Roadmap phase numbers are **offset by one** from the PRD's internal §37 phase numbers: roadmap Phase N = PRD §37 Phase N-1 for N = 1 through 7; roadmap Phase 8 covers PRD §37 Phases 7 and 8; roadmap Phase 9 maps to PRD §37 Phase 9, because the one-phase offset closes at the merge. Every reference to a "PRD Phase" below uses the PRD's own numbering; every reference to a "roadmap Phase" uses this plan set's numbering. See the [delivery roadmap, section 4](README.md#4-prd-phase-number-mapping).

**Primary PRD sections:** [§0](../PRD-v1.md) (gates, alternatives, stop criteria), [§36](../PRD-v1.md) (spikes), [§37 Phase 0](../PRD-v1.md) (task breakdown), [§39](../PRD-v1.md) (risks and open decisions).

---

## 1. Purpose and exit condition

### 1.1 Purpose

Phase 1 produces **evidence**, not product code. Its job is to determine whether the branch overlay architecture in PRD §0.2 is buildable against this specific repository, this Studio version, and this staging dataset — before any production implementation begins.

### 1.2 Exit condition

**Exit:** All six critical gates in PRD §0.3 pass, **or** the architecture is revised through a written pivot decision (PRD §37 Phase 0 exit; PRD §0.6).

> "Failed gates produce a written pivot decision before more implementation begins." (PRD §0.6)

### 1.3 The six gates, quoted (PRD §0.3)

> The project does not enter full implementation until all six gates pass:

- [ ] **Gate A: Studio data-plane interception.** Run two implementation tracks in parallel: Strategy A uses `unstable_clientFactory`; Strategy B uses an HTTP API host proxy. Each track must cover document fetches, mutations, actions, raw requests, client cloning, Studio authentication flows, and all network calls needed for core editing. `unstable_clientFactory` is a hidden beta hook and has no stability guarantee, so it cannot be the only investigated path. [S08] [S35] [S42]
- [ ] **Gate B: Listener and editor-state protocol.** The selected strategy must reproduce the observable behavior Studio requires for save indicators, form state, document panes, references, Portable Text, reconnects, and unsubscription. Spike instrumentation must capture the actual event shapes used by the pinned Studio version. Current Sanity APIs require `includeAllVersions=true` to observe drafts and release versions on API versions from 2025-02-19. [S38] [S41]
- [ ] **Gate C: Blob concurrency.** A private Blob manifest can be read without stale cache, conditionally replaced with `ifMatch`, retried after a precondition failure, and recovered after partial writes without blindly replaying unsafe operations. [S02] [S03] [S04] [S05]
- [ ] **Gate D: Query parity.** Every launch-critical frontend and required Studio query is classified Tier A or accepted Tier B (section 22.3) and returns the same result as native Sanity when no overlay is present, and the expected virtual result when overlays are present. Remaining Tier C queries stay below the section 0.6 abort threshold, and no launch-critical query is Tier C. The Spike C pass criteria (section 36.3) are the closing standard for this gate.
- [ ] **Gate E: Safety and trust boundary.** Preview and local environments cannot mutate staging. Fork previews receive no overlay secrets. The trust model for same-repository PR code is explicitly approved.
- [ ] **Gate F: Lifecycle.** Blob state survives preview redeployments, keys to the PR or branch rather than the deployment URL, exports to Git, reports base drift, and cleans up safely after PR closure. Vercel exposes Git and pull request metadata through system environment variables. [S06]

### 1.4 Gate-to-spike mapping (plan-level guidance)

Gate letters (§0.3) and spike letters (§36) **do not correspond one-to-one**. Use this table, not the letters, to decide what evidence closes which gate.

| Gate (§0.3) | Evidence source | Notes |
|---|---|---|
| Gate A | Spike A, Track A and Track B (§36.1) | Both tracks must run; at least one must pass |
| Gate B | Spike A shared editor and listener tasks (§36.1) plus the listener compatibility contract (§21.4.1) | Pass criteria are in §21.4.1, reproduced in §3.1 |
| Gate C | Spike B (§36.2) | |
| Gate D | Spike C (§36.3) | |
| Gate E | Spike F (§36.6) plus audit trust classification (§37 Phase 0) | Requires topology selection first (§25.13) |
| Gate F | Spike B (§36.2), whose task list now covers all Gate F lifecycle clauses: redeployment survival, PR isolation, PR-keyed identity, export to canonical files, base drift reporting, and closed-overlay cleanup | Resolved in PRD v1.1 — see §9, resolution log OQ-5 |
| — | Spike D (§36.4) | Schema compatibility has **no** lettered gate; it is a §39.1 decision gate in its own right |
| — | Spike E (§36.5) | Conditional; see §4.2 and decision D01 |

---

## 2. Workstream 1 — Repository and platform audit

Every checkbox below is reproduced from the PRD §37 Phase 0 "Audit" block. Grouping is **plan-level guidance**; the items and their wording are normative.

### 2.1 Studio, schema, and plugin inventory

- [ ] Inventory Sanity Studio version and plugins.
- [ ] Inventory all schema types.
- [ ] Inventory custom inputs, previews, actions, tools, and Structure Builder code.

Plan-level guidance: record exact resolved versions, not semver ranges — the pinned Studio and client revisions become the compatibility contract for Spike A (§21.5) and definition-of-done item 15 (§39.5). Flag every custom input component that calls native Sanity APIs directly (§20.3); §39.1 lists plugin bypass as a PRD Phase 0 and PRD Phase 4 decision gate (roadmap Phases 1 and 5).

### 2.2 Client and query inventory

- [ ] Inventory `@sanity/client`, `next-sanity`, and visual editing versions.
- [ ] Inventory all frontend GROQ queries.
- [ ] Inventory all direct Sanity client imports.
- [ ] Inventory all native mutation call sites.

Plan-level guidance: direct input to Spike C (§36.3) and to the query registry shape in §22.4. Direct client imports and native mutation call sites are the target set for the codemod and ESLint rule required by §22.5 in roadmap Phase 6.

### 2.3 Dataset measurements

- [ ] Measure staging dataset document counts by type.
- [ ] Measure representative document sizes.
- [ ] Identify cross-dataset and global references.

Plan-level guidance: compare against the §15.6 guardrails (25 / 500 document thresholds, 2 MB per document, 1 MB manifest) and the bounded top-K rule in §22.6. Cross-dataset and global references to branch-local targets are Tier C (§22.3) and must be recorded as such.

### 2.4 Hosted-feature and asset usage

- [ ] Inventory asset workflows.
- [ ] Identify releases, scheduled drafts, comments, tasks, AI Assist, and other hosted features in use.

Plan-level guidance: feeds the launch feature degradation list decision (§4.1), scored against the §32.1 parity statuses. Asset findings determine whether D01 makes Spike E in-scope (§4.2).

### 2.5 Trust classification and secret exposure

- [ ] Inventory auth and preview protection.
- [ ] Classify repository and fork trust assumptions.
- [ ] Inventory authentication calls and preview-secret exposure paths.

Plan-level guidance: classify against the two topologies in §25.13 (trusted repository versus isolated gateway) and the V1 trust assumptions in §26.1.1. Prerequisite for Spike F, whose bound is "one attack pass **after a provisional topology is selected**" (§36.0, §36.6 ordering rule).

### 2.6 Architecture justification

- [ ] Complete the alternatives matrix with project-specific evidence.

Plan-level guidance: extend the §0.5 matrix with measured, project-specific findings for each row (dataset clone, Content Release per branch, filesystem-only, private Blob, persistent Sandbox, database overlay, custom Studio document tool). Per §0.5 decision rule 1, prefer the smallest architecture that passes all six gates; per rule 3, this matrix is reopened whenever a §0.6 kill criterion is reached.

---

## 3. Workstream 2 — Feasibility spikes

Reproduced from PRD §36. Execution bounds and required evidence artifacts are from §36.0. Cross-spike stop rules are in §6.

**PRD §37 Phase 0 "Spikes" checklist.** The phase-level spike tracker, reproduced verbatim. Each item is closed by the correspondingly lettered subsection below (§3.1 through §3.6) reaching a pass under its own criteria and the §0.6 execution rules.

- [ ] Complete Spike A.
- [ ] Complete Spike B.
- [ ] Complete Spike C.
- [ ] Complete Spike D.
- [ ] Complete Spike E if D01 classifies branch uploads as launch-critical (D01 is decided during the audit, before spike scheduling completes).
- [ ] Complete Spike F.

### 3.0 Execution bounds table (§36.0)

| Spike | Default implementation bound | Required evidence |
|---|---|---|
| A: Studio interception and listener | Two focused agent attempts per strategy, then at most one targeted repair pass. The repair pass is not a third attempt: per §0.6 it must target one observed failure without broadening scope; further work requires an architecture review | E2E video or trace, network log, client method inventory, event-shape inventory, test report |
| B: Blob transaction | One implementation pass and one failure-injection repair pass | Store contract report, ETag conflict trace, orphan recovery trace, lifecycle and export trace |
| C: GROQ corpus | One inventory pass, one planner pass, one parity repair pass | Query registry, parity report, candidate counts, Tier C list |
| D: Schema compatibility | One fixture pass and one migration repair pass | Compatibility matrix and validation report |
| E: Assets | Run only when D01, decided during the Phase 0 audit before spike scheduling completes, classifies branch uploads as launch-critical | Upload, preview, checkpoint, and promotion trace |
| F: Safety boundary | One attack pass after a provisional topology is selected (§36.6 ordering rule) | Secret scan, network trace, fork test, native-write test |

Universal rules (§0.6): each spike runs in an isolated branch with a reproducible fixture and an evidence report; a spike passes only with automated tests **plus one human validation of the actual Studio workflow**; a partial prototype does not count as a pass.

### 3.1 Spike A — Studio interception, authentication, and listener protocol (§36.1)

**Feeds:** Gate A and Gate B. **Goal (§36.1):** Prove that standard Studio editing can operate through at least one overlay data-plane strategy without writing to Content Lake.

Track A and Track B **run in parallel** and neither is preferred before evidence exists (§0.3 Gate A; §21.5).

#### Track A: client-factory facade

- [ ] Pin exact Sanity Studio and client versions.
- [ ] Configure an overlay workspace with `unstable_clientFactory`.
- [ ] Instrument every client method and network request.
- [ ] Instrument Studio boot, login, current-user, token refresh, logout, and auth failure flows.
- [ ] Return a facade around a read-only native client.
- [ ] Intercept document fetch, mutation, action, request, and listen behavior.
- [ ] Preserve `withConfig`, `config`, promise, and observable behavior.

Reference surface for the facade: required promise methods, `[VALIDATE]` observable methods, delegated methods, and blocked methods in §21.4.

#### Track B: HTTP API host or transport proxy

- [ ] Configure the pinned client or Studio to use the controlled API boundary.
- [ ] Proxy allowlisted reads to Sanity.
- [ ] Intercept query, doc, mutation, action, asset, and listen endpoints.
- [ ] Instrument project host, CORS, authentication, and reconnect behavior.
- [ ] Reject unknown write-capable endpoints.

#### Shared editor and listener tasks

- [ ] Implement local observable updates.
- [ ] Capture actual event objects used by Studio.
- [ ] Reproduce subscription, welcome, mutation, reconnect, and unsubscribe behavior.
- [ ] Forward or emulate `includeAllVersions=true` behavior where required. [S38] [S41]
- [ ] Replace publish and unpublish actions.
- [ ] Test scalar, object, keyed array, Portable Text, and reference fields.
- [ ] Test create, duplicate, delete, restore, discard, draft, and published state.
- [ ] Test two panes and two tabs.
- [ ] Verify no Sanity mutation request occurs.
- [ ] Inventory all methods, endpoints, event fields, and auth calls used.
- [ ] If D09 requires Presentation click-to-edit for launch, extend instrumentation to Presentation Tool preview loading and overlay edit-intent routing (§23.4); otherwise record iframe-only preview as the validated scope.

#### Listener compatibility contract (§21.4.1)

The listener contract is "a named feasibility item, not a generic observable wrapper" (§21.4.1). Gate B is **not** closed by §36.1 alone. Spike A must instrument and reproduce:

- [ ] Subscription creation, welcome or initial readiness behavior, unsubscribe, reconnect, and resubscribe.
- [ ] Query and parameter filtering used by the document store.
- [ ] Mutation events for create, draft edit, publish, unpublish, discard, delete, restore, and duplicate.
- [ ] Event fields actually consumed by Studio, including result, previous revision, mutations or effects, transaction identity, document identity, and visibility behavior.
- [ ] Draft and version coverage with `includeAllVersions=true` where the pinned API version requires it. [S38] [S41]
- [ ] Save indicator transitions from local optimistic patch to committed revision.
- [ ] Document pane, reference pane, and preview pane synchronization.
- [ ] No duplicate echo of the writer's local mutation.
- [ ] Portable Text stability under typing, selection changes, paste, undo, redo, and array reordering.
- [ ] Recovery after temporary API or event-stream loss.

#### Pass criteria (§36.1)

- At least one strategy supports all required field and document workflows.
- Save state settles correctly.
- No lost keystrokes, duplicate patches, cursor jumps, or stale panes occur.
- Login, current-user, refresh, logout, and authorization failures behave predictably.
- Reconnect converges to the current overlay head.
- Custom actions work.
- No staging write is possible.
- No unhandled client call is required for core editing.

#### Gate B pass criteria (§21.4.1)

Reproduced verbatim. Plan-level guidance: per the gate-to-spike mapping in section 1.4 of this plan, these five are the criteria Gate B is scored against; the §36.1 criteria above are Gate A evidence.

1. Save state reaches a stable committed state after every supported action.
2. No lost keystrokes, duplicate patches, cursor jumps, or stale pane state occur in the E2E fixture.
3. Reconnect produces the current head without replaying an already committed mutation.
4. Unsubscription stops updates and releases resources.
5. Event payloads are documented as a version-pinned compatibility contract.

#### Fail response (§36.1, §21.5)

- If only one strategy passes, adopt it with its documented risk controls.
- If neither passes, evaluate the custom document tool with an explicit reduced-parity decision.
- Do not proceed under an assumption of native Studio compatibility.

Decision rule after Spike A (§21.5): only A passes → use A with exact version pinning, source-level compatibility tests, and documented upgrade risk. Only B passes → use B and keep Studio client usage behind the proxy contract. Both pass → prefer the approach with better listener, authentication, plugin, and upgrade behavior; a hybrid is allowed. Neither passes → decide whether a custom document tool is acceptable; otherwise stop the project.

- [ ] Open a Sanity support or partner inquiry about supported client injection and transport customization. The response is evidence, not a blocker for the spike (§21.5).

### 3.2 Spike B — Blob manifest transaction (§36.2)

**Feeds:** Gate C and all Gate F lifecycle clauses (PRD v1.1 extended this spike's task list to cover Gate F in full). **Goal:** Prove durable low-concurrency branch state without a database.

- [ ] Pin `@vercel/blob`.
- [ ] Create private Blob store.
- [ ] Write immutable document revision.
- [ ] Write manifest.
- [ ] Read manifest with cache bypass.
- [ ] Update manifest with `ifMatch`.
- [ ] Force stale ETag failure.
- [ ] Reapply a disjoint scalar transaction safely.
- [ ] Reject unsafe same-path text, numeric, and array reapply.
- [ ] Force partial write.
- [ ] Run orphan cleanup.
- [ ] Verify state across Vercel redeployment.
- [ ] Verify separate PR isolation.
- [ ] Verify overlay identity keys to PR or branch metadata, never the deployment URL.
- [ ] Export overlay state to canonical `.sanity-overlay/` files and verify a minimal round-trip import.
- [ ] Detect and report base drift for an idle overlay.
- [ ] Run the closed-overlay retention and cleanup path.

Reference behavior: the write algorithm in §15.3 (steps 11-19 define the `ifMatch`, reread, conflict-detection, and 409 path), the retry policy in §15.4, the read algorithm in §15.5, and the pinned-SDK verification list in §15.8 (`ifMatch`, ETag return values, `BlobPreconditionFailedError`, private `useCache: false` reads, signed operation scope, list pagination).

#### Pass criteria (§36.2)

- Latest manifest is consistently readable.
- Conditional writes prevent lost updates.
- Retry reruns conflict detection and preserves idempotency.
- Partial writes do not expose partial logical state.
- Same PR resolves the same overlay after redeployment.
- Gate F lifecycle behaviors are demonstrated: PR-keyed identity, export to canonical files, base drift reporting, and safe cleanup after closure.

**Fail response:** per §0.6, if Blob retries cannot prove no lost updates for two tabs or agent plus human editing, replace Blob state with a transactional database adapter (the deferred adapter option in §0.5).

### 3.3 Spike C — GROQ query corpus (§36.3)

**Feeds:** Gate D. **Goal:** Determine exact support level using real project queries. (Plan-level guidance: depends on the §2.2 query inventory — see §7.1.)

- [ ] Inventory every frontend GROQ query.
- [ ] Inventory Studio structure and reference queries.
- [ ] Classify each query by candidate plan.
- [ ] Build planners for ID, slug, and bounded top-K type queries.
- [ ] Evaluate through pinned `groq-js`.
- [ ] Compare empty overlay output to native Sanity.
- [ ] Add mutations that affect filter, sort, slice, timestamp ordering, and dereference.
- [ ] Measure candidate counts and latency.
- [ ] Identify queries requiring a shared mirror.

Classification uses the Tier A / Tier B / Tier C definitions in §22.3; registry entries use the `OverlayQueryDefinition` shape in §22.4; candidate plans follow §22.6, including the bounded top-K rule and its proof obligation.

#### Pass criteria (§36.3)

- Every launch-critical frontend and required Studio query is Tier A or accepted Tier B (section 22.3).
- No launch-critical query is Tier C.
- Remaining Tier C queries stay below the section 0.6 abort threshold.
- No launch-critical query depends on silent approximation.
- Preview latency stays within budget on representative data.

**Fail response:** per §0.6, if more than 10 percent of launch-critical queries, or more than five launch-critical queries, remain Tier C after the query audit, add a shared base mirror or stop claiming general preview parity.

### 3.4 Spike D — Schema branch compatibility (§36.4)

**Feeds:** no lettered gate; it is its own decision gate in §39.1 ("Schema changes make inherited documents uneditable → Spike D"). **Goal:** Prove a branch schema can safely edit live base documents through the overlay. (Plan-level guidance: depends on the §2.1 schema type inventory — see §7.1.)

- [ ] Add optional field.
- [ ] Add required field.
- [ ] Rename field with migration.
- [ ] Change scalar type.
- [ ] Change nested object shape.
- [ ] Change reference target types.
- [ ] Add new document type.
- [ ] Remove document type from branch schema.
- [ ] Run validation and conflict reporting.

Expected behavior per change type is tabulated in §20.2; the compatibility scanner's required findings are in §20.3; migration file shape is in §20.4.

#### Pass criteria (§36.4)

- Compatible changes work normally.
- Incompatible changes fail visibly.
- No base data is lost.
- Migration path is explicit.

**Fail response:** the PRD specifies **no spike-specific fail response** for Spike D (§36.4 has no fail-response block, and §0.6 lists no schema-compatibility abort trigger). A failure therefore routes to the generic §0.6 response: at most two focused implementation attempts, then an architecture review, and a written pivot decision before implementation continues. Whether the failing change is blocked outright is determined by the §20.2 expected-behavior table and the §20.3 scanner findings, and escalates through the §39.1 decision gate "Schema changes make inherited documents uneditable → Spike D".

### 3.5 Spike E — Asset source (§36.5) — conditional

**Feeds:** no lettered gate; conditional on D01. **Runs only when D01 classifies branch uploads as launch-critical (§36.0, §37 Phase 0).** Per PRD v1.1, D01 is decided **during the Phase 0 audit, before spike scheduling completes** (§39.3), so the spike is either scheduled or formally skipped with no circularity; record the outcome in `decisions.md` either way. The default when unanswered is "Existing Sanity assets only; branch uploads deferred".

**Goal:** Prove branch-only upload, preview, checkpoint metadata, and promotion.

- [ ] Add custom asset source.
- [ ] Upload local image.
- [ ] Upload private Blob image.
- [ ] Create synthetic asset reference.
- [ ] Render in preview.
- [ ] Enforce authentication.
- [ ] Upload to Sanity during promotion.
- [ ] Rewrite reference.

Reference behavior: existing-asset guarantees in §24.1, the `OverlayAssetRecord` shape in §24.2, the local and Blob workflows in §24.3 and §24.4, and asset security requirements in §24.5.

#### Pass criteria (§36.5)

- Existing and branch assets coexist.
- Draft asset is not public.
- Promotion produces normal Sanity asset reference.

**Fail response:** the PRD specifies **no spike-specific fail response** for Spike E (§36.5 has no fail-response block, and §0.6 lists no asset abort trigger). A failure routes to the generic §0.6 response — architecture review and a written pivot decision — and falls back to the D01 default, "Existing Sanity assets only; branch uploads deferred" (§39.3). Per PRD v1.1 the deferral target is PRD Phase 7 (roadmap Phase 8) — see §9, resolution log OQ-9. Existing Sanity assets remain native and usable regardless (§24.1, §39.2).

### 3.6 Spike F — Safety and trust boundary (§36.6)

**Feeds:** Gate E. **Goal:** Prove overlay mode cannot write staging or expose credentials outside the approved trust class. Runs **after** a topology is provisionally selected (§36.0; topologies in §25.13). PRD v1.1 codifies the ordering in §36.6: select the provisional trust topology first (the D14 default: trusted-repository with no fork secrets), run the attack pass against it, and close Gate E on that evidence; if the spike fails, switch topology or disable writable preview editing for the failing trust class per §0.6, then rerun the attack pass before Gate E closes.

- [ ] Remove write token from preview environment.
- [ ] Attempt `client.create` through facade or proxy.
- [ ] Attempt raw native mutation request.
- [ ] Attempt plugin direct mutation.
- [ ] Attempt asset direct upload.
- [ ] Attempt dataset override.
- [ ] Inspect network logs.
- [ ] Deploy a fork fixture and verify all overlay secrets are absent.
- [ ] In isolated-gateway mode, add a malicious branch route and verify it cannot read gateway credentials.

Threat list to draw additional cases from: §26.9. Fork requirements: §26.1.1.

#### Pass criteria (§36.6)

- Every staging write fails before reaching an authorized endpoint.
- Fork and untrusted preview code cannot access protected credentials.
- Core overlay editing still works for the approved trust class.

**Fail response:** per §0.6, if staging write protection depends on branch-controlled code behaving honestly while untrusted fork code receives secrets, move credentials into an isolated overlay gateway or disable writable preview editing for that trust class.

---

## 4. Workstream 3 — Decision log

### 4.1 PRD §37 Phase 0 "Decisions" checklist

- [ ] Approve client interception strategy from parallel Strategy A and B evidence.
- [ ] Approve listener compatibility contract.
- [ ] Approve preview trust mode and fork policy.
- [ ] Approve the V1 query registry contents from Spike C: the audited query list, tier classification, and candidate plans. Registry implementation and enforcement (codemod, lint rule, CI checks) remain Phase 5 work (§22.5).
- [ ] Approve the launch-critical query, plugin, and asset lists (PO and TO jointly; the asset list also requires CMS per D01, §6).
- [ ] Approve Blob physical layout.
- [ ] Approve auth model.
- [ ] Approve launch feature degradation list.
- [ ] Decide whether branch assets are launch-critical or deferred to Phase 7 (D01).

Supporting PRD references, in order: §21.5 decision rule table; §21.4.1 pass criteria; §25.13 and §26.1.1; §22.4 and §22.5; the §6 launch-critical definition; §15.1 and §15.6; §26.4 and §26.5; §32; §24 and decision D01. PRD v1.1 fixed the final item's deferral target (previously "Phase 4", now PRD Phase 7, which matches §37 Phase 7, the §39.1 branch-asset risk row, and §7.2 below) and added the registry-contents and launch-critical-list items — see §9, resolution log OQ-8 and OQ-9.

### 4.2 §39.3 open decisions due at or before this phase's gates

The first five columns reproduce §39.3, which supplies only ID, decision, owner, deadline or gate, and default when unanswered. The final column, **"Spike or audit that supplies evidence", is plan-level guidance** — the PRD does not map decisions to evidence sources.

| ID | Decision | Owner | Deadline or gate (PRD numbering) | Default when unanswered | Spike or audit that supplies evidence |
|---|---|---|---|---|---|
| D01 | Are branch asset uploads required for initial launch? | PO, CMS | Phase 0 audit, before spike scheduling completes | Existing Sanity assets only; branch uploads deferred | §2.4 asset workflow inventory; gates Spike E |
| D03 | Which identity provider controls preview edit versus read-only access? | SEC | Gate E | Vercel Authentication plus application role mapping | §2.5 audit; Spike F |
| D07 | Which document types exceed bounded candidate-query guardrails? | TO | Spike C | Mark unsupported until a custom planner exists | §2.3 measurements; Spike C |
| D08 | Which Studio plugins are mandatory? | PO, TO | Phase 0 audit | Disable unvalidated plugins in overlay workspace | §2.1 audit; Spike A |
| D09 | Is Presentation click-to-edit required for launch? | PO | Phase 0 exit | No; iframe preview only | §2.2 visual editing inventory; if yes, the conditional Spike A Presentation task (§36.1) |
| D13 | Which Studio interception strategy is selected? | TO | Gate A | No default. If neither passes, PO and TO jointly issue a written pivot decision per §0.6, choosing the custom document tool (§0.5) or a hosted alternative | Spike A |
| D14 | Which preview trust topology is selected? | SEC | Gate E | Trusted-repository with no fork secrets | §2.5 audit; Spike F |
| D15 | What timestamp policy applies to each `_updatedAt` or `_createdAt` query? | TO, CMS | Spike C | Unsupported until registered explicitly | Spike C |

Owner codes (§39.3): `PO` human product owner, `TO` technical owner responsible for evidence and architecture, `SEC` security owner, `CMS` content operations owner.

**Plan-level guidance.** Decisions **not** due in this phase, listed so they are not pulled forward: D02, D04, D05, D06, D10, D11, D12 (§39.3). The exclusion list and the two checkboxes below are plan-added; the PRD states only each decision's own deadline. D04 is due before PRD Phase 4 (roadmap Phase 5); D06 and D12 before PRD Phase 3 (roadmap Phase 4); D02 and D05 before PRD Phase 6 (roadmap Phase 7); D10 and D11 before PRD Phase 8 (roadmap Phase 8).

- [ ] Record each decision above in `decisions.md` with: decision ID, owner, date, evidence links, chosen option, and whether the default was accepted.
- [ ] Re-confirm the §39.2 "decisions already made" list is still consistent with spike evidence; raise a pivot decision if any is contradicted.

---

## 5. Evidence and artifact organization

**Plan-level guidance.** The PRD requires "an isolated branch with a reproducible fixture and an evidence report" per spike (§0.6) and names required artifacts per spike (§36.0). It does not prescribe file locations. This layout is proposed by this plan.

```text
docs/plans/evidence/phase-1/
  audit/                        # one file per §2 group, plus alternatives-matrix.md
  spike-a-studio-interception/  # report.md (Track A + Track B), client-method-inventory.md,
                                # event-shape-inventory.md, network-logs/, e2e-traces/
  spike-b-blob-transaction/     # report.md, store-contract-report.md, etag-conflict-trace.md,
                                # orphan-recovery-trace.md, lifecycle-and-export-trace.md
  spike-c-groq-corpus/          # report.md, query-registry.json, parity-report.md,
                                # candidate-counts.md, tier-c-list.md
  spike-d-schema-compatibility/ # report.md, compatibility-matrix.md, validation-report.md
  spike-e-assets/               # only if D01 makes branch uploads launch-critical:
                                # report.md, upload-preview-checkpoint-promotion-trace.md
  spike-f-safety-boundary/      # report.md, secret-scan.md, network-trace.md,
                                # fork-test.md, native-write-test.md
  decisions.md                  # running log for §4.1 and §4.2
  gate-review.md                # per-gate pass/fail with evidence links, or the pivot decision
```

Each spike folder's file set is the §36.0 "Required evidence" column for that spike.

Branch naming: `spike/<letter>-<slug>`, that is `spike/a-studio-interception`, `spike/b-blob-transaction`, `spike/c-groq-corpus`, `spike/d-schema-compatibility`, `spike/e-assets`, `spike/f-safety-boundary`.

Each `report.md` must state: pinned versions used, fixture reproduction steps, automated test results, the human Studio validation record (§0.6), attempts consumed against the §36.0 bound, pass or fail against the spike's own criteria, and which gate clauses it closes.

- [ ] `gate-review.md` records each of Gate A-F as pass or fail with links to the evidence that closes every clause of the gate text.
- [ ] Any failed gate produces a written pivot decision in `gate-review.md` before implementation continues (§0.6).

---

## 6. Stop rules

### 6.1 Execution rules (PRD §0.6, verbatim)

- Each spike runs in an isolated branch with a reproducible fixture and an evidence report.
- Each strategy receives at most two focused implementation attempts before an architecture review.
- A repair attempt must target an observed failure. It must not broaden scope.
- A spike passes only with automated tests plus one human validation of the actual Studio workflow.
- A partial prototype does not count as a pass.
- Failed gates produce a written pivot decision before more implementation begins.

### 6.2 Abort or pivot thresholds (PRD §0.6, verbatim)

| Trigger | Required response |
|---|---|
| Neither Studio interception strategy supports scalar, object, keyed array, Portable Text, reference, draft, publish, unpublish, delete, authentication, and save-state flows | Stop native-Studio parity work and decide between a custom document tool or a hosted Sanity alternative |
| Listener emulation causes lost keystrokes, cursor jumps, stuck save indicators, duplicate patches, or stale panes after two focused repair attempts | Stop and change the Studio integration strategy |
| More than 10 percent of launch-critical queries, or more than five launch-critical queries, remain Tier C after the query audit | Add a shared base mirror or stop claiming general preview parity |
| More than two mandatory plugins bypass the overlay and cannot be adapted safely | Remove those plugins from overlay mode or stop the native Studio approach |
| Staging write protection depends on branch-controlled code behaving honestly while untrusted fork code receives secrets | Move credentials into an isolated overlay gateway or disable writable preview editing for that trust class |
| Blob retries cannot prove no lost updates for two tabs or agent plus human editing | Replace Blob state with a transactional database adapter |
| Cold mutation acknowledgement remains above 5 seconds p95 after one focused optimization pass | Degrade to explicit save, use a stable gateway, or replace Blob storage |
| Checkpoint output repeatedly requires full-document diffs for large documents | Use intent records plus generated snapshots as specified in sections 14 and 29 |

The last two rows are measured in later roadmap phases but are reproduced here because §36.0 states that cross-spike stop rules are in §0.6, and because reaching any of them reopens the §0.5 alternatives matrix (§0.5 decision rule 3).

---

## 7. Sequencing

**Plan-level guidance.** The PRD imposes only two ordering constraints of its own: Spike F runs after a provisional topology is selected (§36.0, §36.6) and Spike E runs only if D01 classifies branch uploads as launch-critical (§36.0). Everything else below is plan-level sequencing.

### 7.1 Ordering within Phase 1

1. **Audit first, partially.** Version pinning (§2.1, §2.2) is a hard prerequisite for Spikes A, B, and C. The query inventory (§2.2) gates Spike C. The schema type inventory (§2.1) gates Spike D. The trust classification (§2.5) plus a provisional D14 topology selection gates Spike F ("one attack pass after a provisional topology is selected", §36.0, §36.6).
2. **Decide D01 early.** Spike E only exists if branch uploads are launch-critical. Per PRD v1.1, D01's deadline is during the Phase 0 audit, before spike scheduling completes (§39.3), matching the scheduling need.
3. **Run in parallel once unblocked:** Spike A (both tracks concurrently, mandated by Gate A), Spike B, Spike C, Spike D. These have no dependency on each other.
4. **Run Spike F last**, against the interception strategy selected by D13, so the attack pass tests the real boundary rather than a hypothetical one.
5. **Gate review and decision close-out.** Complete §4.1 and §4.2, then write `gate-review.md`.

### 7.2 Dependencies on later roadmap phases

Future-phase plan documents are named but not yet written; their filenames are the ones listed in the [delivery roadmap](README.md), section 7.

| Phase 1 output | Blocks |
|---|---|
| All six gates A-F (§0.3) | Every later roadmap phase. "The project does not enter full implementation until all six gates pass" (§0.3 preamble), and a failed gate requires a written pivot decision before implementation continues (§0.6). Design and test-harness scaffolding for [roadmap Phase 2](phase-2-core-domain.md) may proceed while gates are open, but no Phase 2 implementation is accepted as complete until the gates close |
| Gate F lifecycle clauses / overlay identity and lifecycle rules (§12.1-§12.3) | [Roadmap Phase 2 — Core domain engine and memory adapter](phase-2-core-domain.md) (PRD Phase 1): `OverlayManifest.overlayId`, `status` and `source` (§13.1) cannot be frozen until overlay identity and the lifecycle state set are settled |
| Spike A / Gate A / Gate B / D13 | Roadmap Phase 5 — Studio core parity (`phase-5-studio-parity.md`, PRD Phase 4): the entire integration strategy. Also gates the minimal `[M-LOCAL]` Studio slice pulled forward into roadmap Phase 3 and the Studio queries in roadmap Phase 6 (roadmap sections 5.1 and 5.3) |
| Spike B / Gate C / Gate F | Roadmap Phase 4 — Blob preview persistence and identity (`phase-4-blob-preview.md`, PRD Phase 3): store contract and overlay identity |
| Spike C / Gate D / D07 / D15 / approved V1 query registry | Roadmap Phase 6 — GROQ query layer and frontend migration (`phase-6-query-layer.md`, PRD Phase 5): registry, planners, parity fixtures. Also gates the minimal ID and slug query slice pulled forward into roadmap Phase 3 (roadmap section 5.3) and the §35.11 fixture coverage carried by the roadmap Phase 2 testkit |
| Spike D | Schema conflict and migration work in roadmap Phase 3 (`phase-3-local-fs-mode.md`, basic) and roadmap Phase 7 (`phase-7-conflicts-checkpoint-ci.md`, full) |
| Spike F / Gate E / D03 / D14 | Roadmap Phase 4 preview topology and roadmap Phase 5 preview Studio deployment |
| Spike E / D01 | Roadmap Phase 8 — Assets and promotion (`phase-8-assets-promotion.md`, PRD Phases 7 and 8) |
| Approved launch feature degradation list | Roadmap Phase 5 onwards; drives the §32 parity matrix and the disabled-feature list |
| Approved Blob physical layout | Roadmap Phase 4 storage adapter |

---

## 8. Out of scope for this phase

- **No production implementation.** "The project does not enter full implementation until all six gates pass" (§0.3). Spike code is throwaway evidence code on `spike/*` branches; it is not the roadmap Phase 2 (PRD §37 Phase 1) core engine and must not be promoted into `packages/` without being rewritten under the roadmap Phase 2 test regime.
- **No milestone claims.** Per §1.4, phase plans may implement later-milestone foundations early, but cannot redefine an earlier milestone as complete. Nothing in Phase 1 may be reported as `[M-LOCAL]`, `[M-PREVIEW]`, `[M-PROD]`, or `[M-PROMO]` acceptance.
- **No architecture lock-in by inertia.** "Do not preserve the overlay architecture merely because implementation has started" (§0.5 decision rule 2).
- **Spike E is conditional**, not default; skipping it is the PRD default (§39.3 D01).
- Decisions D02, D04, D05, D06, D10, D11, D12 are not resolved here (§4.2).

---

## 9. Open questions

Nine questions were recorded here when this plan was first written. The PRD v1.1 errata pass (2026-08-03; see the revision note in the [PRD header](../PRD-v1.md)) resolved all of the structural ones in place. The resolution log below maps each to its fix. The remaining live decisions are the product decisions themselves — D01 and D09 — tracked in §4.2 and PRD §39.3.

### Resolution log (PRD v1.1)

- **OQ-1 — Gate D absolutism versus the Tier C tolerance. Resolved.** §0.3 Gate D now requires every launch-critical query to be Tier A or accepted Tier B, with Tier C below the §0.6 threshold and no launch-critical query in Tier C, and names the Spike C pass criteria (§36.3) as the closing standard — and §36.3's pass criteria were themselves rewritten in the same launch-critical vocabulary, so the two sections now state one standard (§3.3).
- **OQ-2 — "Launch-critical" was undefined. Resolved.** §6 now defines launch-critical, and the §37 Phase 0 decisions checklist requires PO and TO to jointly approve the launch-critical query, plugin, and asset lists during this phase, with CMS co-approving the asset list per D01 (§2.4, §4.1).
- **OQ-3 — D01 timing. Resolved.** §39.3 now sets D01's deadline at "Phase 0 audit, before spike scheduling completes", so Spike E can be scheduled or formally skipped inside this phase.
- **OQ-4 — D09 had no evidence source. Resolved.** §36.1 now carries a conditional Spike A task: if D09 requires Presentation click-to-edit, instrumentation extends to Presentation Tool preview loading and overlay edit-intent routing (§23.4); otherwise iframe-only preview is recorded as the validated scope.
- **OQ-5 — Gate F was only partly covered by a spike. Resolved.** §36.2 Spike B now includes PR-keyed identity, canonical file export with round-trip import, base drift reporting, and closed-overlay cleanup tasks, plus a matching pass criterion, so Spike B evidence closes every Gate F clause (§1.4, §3.2).
- **OQ-6 — Spike A attempt budget. Resolved.** §36.0 now states the repair pass is not a third attempt: it must target one observed failure without broadening scope, and further work requires an architecture review.
- **OQ-7 — Spike F ordering versus Gate E. Resolved.** §36.6 codifies the provisional-then-ratify reading: select the provisional topology (D14 default) first, run the attack pass, close Gate E on the evidence, and rerun after any topology switch (§3.6).
- **OQ-8 — Scope of "Approve V1 query registry" at Phase 0. Resolved.** The §37 Phase 0 decision now approves the registry **contents** from Spike C (audited query list, tier classification, candidate plans); implementation and enforcement remain PRD Phase 5 (§22.5, §4.1).
- **OQ-9 — Deferred branch assets' landing phase. Resolved.** The §37 Phase 0 decision now reads "launch-critical or deferred to Phase 7 (D01)", consistent with §37 Phase 7, the §39.1 risk row, and §7.2.

### Still open — product decisions

- **D01 — Are branch asset uploads required for initial launch?** Owner: PO, CMS. Due during the audit, before spike scheduling completes. Default: existing Sanity assets only; branch uploads deferred to PRD Phase 7 (roadmap Phase 8).
- **D09 — Is Presentation click-to-edit required for launch?** Owner: PO. Due at Phase 0 exit. Default: no; iframe preview only. If yes, the conditional Spike A Presentation task runs (§3.1).
