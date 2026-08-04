# Phase 2 acceptance audit — core domain engine

**Date:** 2026-08-04 · **Auditor:** read-only agent (no source or test file modified)
**Spec:** [docs/plans/phase-2-core-domain.md](../../phase-2-core-domain.md) §4-§8, §10, §11 · **PRD:** [docs/PRD-v1.md](../../../PRD-v1.md) §34, §35.1-§35.7

**Suite state at audit time:** 12 Phase-2-relevant files, 403 tests, all green.
Core-only (excluding `store-fs.test.ts`, which is Phase 3): 369 tests.
Per file — w1 72, w2 63, w3-arrays 19, w3-merge 42, w3-perspectives 20, w3-rebase 29, w3-resolution 18, w4-integrity 35, w4-migration 20, w4-references 30, w4-validation 21, store-fs 34.

> **Gate constraint (plan §2, PRD §0.3, §0.6).** Phase 2 **cannot be signed off regardless of this audit** until all six Phase 1 gates pass or a written pivot is recorded. Gates C and F are blocked on Vercel credentials and Gate E currently FAILs (see [HANDOFF §3](../../HANDOFF.md)). This document audits **implementation completeness only** and takes no position on gate status.

---

## 1. Headline verdict

**Phase 2 is NOT complete.** The four workstreams W1-W4 are genuinely built and genuinely tested — all five PRD unit corpora are covered case-for-case, and the merge/reference engines are high quality. What is missing is the *fifth* workstream (W5, plan §8) and three of the ten §10 acceptance items.

**Corpus counts (verified case-by-case against the PRD text, not test titles):**

| PRD corpus | Required | Present | Verdict |
|---|---:|---:|---|
| §35.2 core merge | 17 | **17** | complete (one case lives outside its §35.2 block — see F-04) |
| §35.3 arrays | 10 | **10** | complete |
| §35.4 mutations | 18 | **18** | complete |
| §35.5 draft/actions | 11 | **11** | complete (two are port-mocked — see F-02) |
| §35.6 references | 11 | **11** | complete |
| §35.7 store contract | 17 | **17** | suite exists; **no memory adapter runs it** |
| §35.1 property list (plan §8.5) | 13 | **8** generative, 3 example-based, 2 missing | incomplete |
| §34 invariants (plan §8.3) | 12 | **4** | incomplete |

**Shortest list of what remains:**

1. **Build the memory store adapter** (plan §8.1). It does not exist anywhere in the repo. `memory` is a first-class product mode (PRD §11.1), and §10 requires it to pass 100 % of the §35.7 suite. The suite is written and exported; only the adapter is missing.
2. **Move the store contract interface out of `sanity-overlay-store-fs`.** `OverlayStore` is defined at `packages/sanity-overlay-store-fs/src/contract.ts:382`, so the Phase 4 Blob adapter would have to depend on the filesystem package. Plan §8.1 owns this interface in Phase 2.
3. **Wire and test the W3 merge port into W2.** `createMergeResolver` is never injected outside one two-line adapter test; every W2/action/perspective path runs on the `localWinsMerge` stub, which by its own docstring violates §17.2 rule 4 / invariant §34.12 (F-01, highest severity).
4. **Implement the remaining 8 of 12 §8.3 invariants** (§34.1, .2, .3, .4, .5, .6, .8, .17) as callable checks.
5. **Complete the §8.5 property list**: checksum integrity over generated operation sequences (missing), transaction idempotence as a property (missing), and make serializer/path-encoding properties generative rather than hardcoded tables.
6. **Add the dependency-boundary enforcement** required by §3 and §10. Core is *de facto* clean (verified by grep: zero non-relative runtime imports), but nothing proves it — there is no lint config and no CI in the repo at all.
7. **Export the testkit fixtures.** `mergeFixtures`, `referenceFixtures`, `validationFixtures` are not re-exported from `packages/sanity-overlay-testkit/src/index.ts`; Phases 3-4 cannot consume them as a package.

**Not a problem:** no milestone over-claim was found. `packages/sanity-overlay-core/src/index.ts:11` and `packages/sanity-overlay-store-fs/src/index.ts:13` both state `[M-LOCAL]` **foundations** with "No milestone acceptance is claimed", satisfying §10's last checkbox and PRD §1.4. The §12 resolution log (O1-O8) is honoured in code; O1-O7 verified individually below, O8 only partially (see F-05).

---

## 2. Traceability matrix

Verdict key: **IT** implemented+tested · **IU** implemented-untested · **P** partial · **M** missing · **MM** mis-mapped.

### 2.1 §4 W1 — types and serialization

| Plan §4 checkbox | Implementation | Test | Verdict |
|---|---|---|---|
| Define manifest schema (§13.1, §13.2, §13.8) | `core/src/types/manifest.ts:1-90`, `types/actor.ts` | `core-w1.test.ts:601` | **P** — assertions are on a test-authored literal (F-08) |
| Define document record schema (§13.3-13.5) | `core/src/types/record.ts:1-84` | `core-w1.test.ts:613` | **P** — same literal-smoke pattern; exercised for real throughout W2/W3 |
| Define operation schema (§13.7) | `core/src/types/operations.ts:1-58` | `core-w1.test.ts:613`, all of `core-w2.test.ts` | **IT** |
| Define transaction schema + `OverlayMutation` envelope (§13.10, O1) | `types/transaction.ts:1-30`, `types/operations.ts` | `core-w1.test.ts:635`, `core-w2.test.ts:1272` | **IT** |
| Define conflict schema, severities as data (§13.11, §17.4, O2/O3) | `types/conflict.ts:8-122` (13 members, table at :86) | `core-w1.test.ts:648` | **P** — only 3 of 13 severity rows verified against PRD (F-03) |
| Canonical JSON serializer (§14.3, §34.17, §12.1, §35.14) | `core/src/serialize.ts:136,168,197`; forbidden keys `:31,51` | `core-w1.test.ts:124-231` | **IT** |
| Checksum functions (§13.2, §34.4) | `core/src/checksum.ts:149,161,169,182` | `core-w1.test.ts:49-122` (oracle = `node:crypto`, FIPS vectors) | **IT** — best-oracled suite in the repo |
| ID and path encoding (§13.6, §14.3, §35.9) | `core/src/encoding.ts:71,134,242,270` | `core-w1.test.ts:232-369` | **IT** (table-driven, not generative — see §8.5 row) |
| Format version handling (§13.1 etc.) | `core/src/version.ts:33,40,48` | `core-w1.test.ts:404-437` | **IT** |
| Migration framework `vN -> vN+1` + round-trip harness | `core/src/version.ts:93,187,195` | `core-w1.test.ts:438-468` | **IT** |
| Synthetic system field policy table (§13.9) | `types/system-fields.ts:1-88` | `core-w1.test.ts:664` | **IT** |
| Synthetic rev formatter + Content Lake guard (§13.9, O4) | `checksum.ts:206,227,232,242`; prefix `:182` | `core-w1.test.ts:371-403` | **IT** |

### 2.2 §5 W2 — mutation engine (PRD §35.4, 18 cases)

| PRD §35.4 case | Implementation | Test | Verdict |
|---|---|---|---|
| 1 Create | `mutations/mutation.ts:540` | `core-w2.test.ts:161`, `:187` | **IT** |
| 2 Create-if-not-exists against base **and** overlay | `mutation.ts:540` + `mutations/resolve.ts:129` | `core-w2.test.ts:205` (covers base, overlay, absent, tombstoned) | **IT** |
| 3 Create-or-replace (§17.10) | `mutation.ts:540` | `core-w2.test.ts:246`, `:280` | **IT** |
| 4 Delete (+ tombstones, §18.8, §34.2) | `mutation.ts:540`, `:518` | `core-w2.test.ts:297`, `:1301` | **IT** |
| 5 Set (§17.6) | `mutations/operations.ts:242` | `core-w2.test.ts:314`, `:330` | **IT** |
| 6 Set-if-missing (resolved virtual doc) | `operations.ts:242` + `resolve.ts` | `core-w2.test.ts:343` | **IT** |
| 7 Unset (tracked tombstone, §17.5) | `operations.ts:242`, `:387` | `core-w2.test.ts:361`, `:377` | **IT** |
| 8 Insert before | `operations.ts:242` | `core-w2.test.ts:391` | **IT** |
| 9 Insert after | `operations.ts:242` | `core-w2.test.ts:412` | **IT** |
| 10 Replace array segment | `operations.ts:242` | `core-w2.test.ts:431` | **IT** |
| 11 Increment (§17.8) | `operations.ts:242` | `core-w2.test.ts:458` | **IT** |
| 12 Decrement | `operations.ts:242` | `core-w2.test.ts:471` | **IT** |
| 13 Diff-match-patch (§17.9) | `mutations/diff-match-patch.ts` | `core-w2.test.ts:481`, `:1083-1180` | **IT** |
| 14 Multi-document transaction (§17.11) | `mutations/transaction.ts:64` | `core-w2.test.ts:497`, `:524` | **IT** |
| 15 Revision precondition success | `mutation.ts:102`, `state.ts:114` | `core-w2.test.ts:543` | **IT** |
| 16 Revision precondition failure | same | `core-w2.test.ts:577` | **IT** |
| 17 Duplicate idempotency key returns original (O5, §34.6) | `transaction.ts:53,64,84` | `core-w2.test.ts:606` (asserts `replay.state === first.state`) | **IT** |
| 18 Retry does not duplicate increment or insert | `transaction.ts:84` | `core-w2.test.ts:630` | **IT** |

### 2.3 §5 W2 — document actions (PRD §35.5, 11 cases)

| PRD §35.5 case | Implementation | Test | Verdict |
|---|---|---|---|
| 1 Edit base published creates local draft | `actions/index.ts:125` | `core-w2.test.ts:679` | **IT** |
| 2 Edit base draft anchored correctly | `actions/index.ts:125` + `mutation.ts:209` | `core-w2.test.ts:699` | **IT** |
| 3 Branch publish creates local published, removes draft | `actions/index.ts:174` | `core-w2.test.ts:717`, `:769` | **IT** |
| 4 Branch unpublish creates draft + published tombstone | `actions/index.ts:269` | `core-w2.test.ts:737`, `:757` | **IT** |
| 5 Discard local draft preserves local published | `actions/index.ts:352` | `core-w2.test.ts:781` | **IT** |
| 6 Delete sets both tombstones | `actions/index.ts:386` | `core-w2.test.ts:805` | **IT** |
| 7 Restore clears intended tombstones | `actions/index.ts:405` | `core-w2.test.ts:821` | **IT** |
| 8 Duplicate creates branch draft with new ID | `actions/index.ts:446` | `core-w2.test.ts:840` | **IT** |
| 9 Publish blocks on schema error | `actions/index.ts:145,192` | `core-w2.test.ts:872` (mock validator) **and** `core-w4-validation.test.ts:160` (real fixture validator + real `publish`) | **IT** |
| 10 Publish blocks on strong ref to draft-only target | `actions/index.ts:195`, `references/integrity.ts:183,296` | `core-w2.test.ts:901` (**mock port**), `core-w4-integrity.test.ts:657` (real engine, but through `publishReferenceIssues`, not `publish()`) | **P** — see F-02 |
| 11 Unpublish reports affected strong references | `actions/index.ts:287` | `core-w2.test.ts:953` (**mock port**), `core-w4-integrity.test.ts:706` | **P** — see F-02 |

### 2.4 §6 W3 — merge engine (PRD §35.2 17 cases, §35.3 10 cases)

| PRD §35.2 case | Implementation | Test | Verdict |
|---|---|---|---|
| 1 Untouched scalar inherits current base | `merge/merge.ts:279` | `core-w3-merge.test.ts:98` | **IT** |
| 2 Touched scalar overrides unchanged base | `merge.ts:279` | `core-w3-merge.test.ts:121` | **IT** |
| 3 Same scalar both sides → soft conflict, local wins | `merge.ts:279`, `conflicts/create.ts:46` | `core-w3-merge.test.ts:140` | **IT** |
| 4 Local value equal to current base removes redundant override **on rebase** | `merge/rebase.ts:356` (step 3) | `core-w3-rebase.test.ts:323` + property `:552` | **IT** — but the same-named test inside the §35.2 block (`core-w3-merge.test.ts:169`) asserts the **opposite** (`removedTouchedPaths` is `[]`). See F-04 |
| 5 Explicit unset suppresses current and later base | `merge.ts:92`, `merge/touch-tree.ts` | `core-w3-merge.test.ts:218` | **IT** |
| 6 Nested child touch preserves new upstream siblings | `merge.ts:279` | `core-w3-merge.test.ts:246` | **IT** |
| 7 Parent object changed to scalar → hard conflict | `merge.ts:279` | `core-w3-merge.test.ts:274` | **IT** |
| 8 Base deletion returns local materialized doc | `merge/base-deletion.ts:76` | `core-w3-merge.test.ts:302`, `:674-745` | **IT** |
| 9 Untouched base deletion returns no document | `base-deletion.ts:76` | `core-w3-merge.test.ts:324` | **IT** |
| 10 Branch-created document resolves without base | `merge.ts:279` | `core-w3-merge.test.ts:340` | **IT** |
| 11 Published tombstone suppresses base published | `perspectives/resolve.ts:256` | `core-w3-perspectives.test.ts:47` | **IT** |
| 12 Draft tombstone follows documented fallback | `perspectives/resolve.ts:281` | `core-w3-perspectives.test.ts:61`, `:327` | **IT** |
| 13 Local draft precedence in drafts perspective | `perspectives/resolve.ts:281` | `core-w3-perspectives.test.ts:109` | **IT** |
| 14 Local published precedence in published perspective | `perspectives/resolve.ts:256` | `core-w3-perspectives.test.ts:136` | **IT** |
| 15 Base draft used when no local state | `perspectives/resolve.ts:281` | `core-w3-perspectives.test.ts:156` | **IT** |
| 16 Base published fallback when no draft | `perspectives/resolve.ts:281` | `core-w3-perspectives.test.ts:174` | **IT** |
| 17 Synthetic system fields deterministic | `mutations/state.ts:98`, `checksum.ts:206` | `core-w3-merge.test.ts:365`, `core-w2.test.ts:1182` | **IT** |

| PRD §35.3 case | Implementation | Test | Verdict |
|---|---|---|---|
| 1 Local edit to keyed item survives base insertion | `merge/arrays.ts:67` | `core-w3-arrays.test.ts:71` | **IT** |
| 2 Base edit to different keyed item inherited | `arrays.ts:67` | `core-w3-arrays.test.ts:95` | **IT** |
| 3 Same keyed item both sides conflicts | `arrays.ts:67` | `core-w3-arrays.test.ts:116` | **IT** |
| 4 Base deletes locally edited item → hard conflict | `arrays.ts:67` | `core-w3-arrays.test.ts:144` (+ negative case `:169`) | **IT** |
| 5 Local deletes base keyed item by explicit op | `arrays.ts:67`, `operations.ts:387` | `core-w3-arrays.test.ts:191` (+ regression class `:362-443`) | **IT** |
| 6 Distinct keys at same anchor, deterministic | `arrays.ts:67` (adopted §17.7 `[SHOULD]` order) | `core-w3-arrays.test.ts:211`, `:444-513` | **IT** |
| 7 Duplicate `_key` rejected | `arrays.ts:56,67` | `core-w3-arrays.test.ts:238` (same-side **and** cross-side) | **IT** |
| 8 Portable Text spans/blocks preserve keys | `arrays.ts:67` | `core-w3-arrays.test.ts:281` | **IT** |
| 9 Non-keyed array = full-array touch | `mutations/paths.ts:371`, `arrays.ts` | `core-w3-arrays.test.ts:309` | **IT** |
| 10 Numeric index patch does not target shifted item | `paths.ts:371` (`touchedPathFor`) | `core-w3-arrays.test.ts:331` | **IT** |

| Other §6 checkbox | Implementation | Test | Verdict |
|---|---|---|---|
| Touched path tracking (§13.5, §17.6) | `merge/touch-tree.ts:1-84`, `operations.ts` | `core-w2.test.ts:1067`, `core-w3-merge.test.ts:246` | **IT** |
| Three-way merge, 10 steps incl. step 9 + 10 | `merge/merge.ts:279`, `merge/validation.ts` | `core-w3-merge.test.ts:482-563` | **IT** |
| Structural conflicts (`PARENT_SHAPE_CHANGED`, `ARRAY_ITEM_DELETED`, `ARRAY_KEY_COLLISION`, `BASE_TYPE_CHANGED`, `LOCAL_ID_COLLISION`) | `merge.ts`, `arrays.ts`, `conflicts/create.ts:46` | `core-w3-merge.test.ts:570-672`, `core-w3-arrays.test.ts:144,238` | **IT** |
| Base deletion recovery matrix (§16.4, §34.14) | `merge/base-deletion.ts:76` | `core-w3-merge.test.ts:674-745` | **IT** |
| Automatic rebase, 4 preconditions + 5 steps (§28.5, O6) | `merge/rebase.ts:44,356` | `core-w3-rebase.test.ts:67-404` (incl. `:311` `firstTouchedAt` never modified) | **IT** |
| Manual resolution ops + rebase modes + acknowledgement (§28.1, §28.3, §28.4, §28.6) | `conflicts/resolve.ts:31,87,176,311,331`, `rebase.ts:442,528` | `core-w3-resolution.test.ts:73-310`, `core-w3-rebase.test.ts:410-504` | **IT** |
| Overlay-head comparison fn required by §17.11 (plan §6 scope boundary) | `OVERLAY_SAME_PATH_CHANGED` type exists (`types/conflict.ts:10`); no comparison function found | — | **M** — low priority, but the plan explicitly promises "the pure three-way overlay-head comparison function that §17.11 requires" |

### 2.5 §7 W4 — references and validation port (PRD §35.6, 11 cases)

| PRD §35.6 case | Implementation | Test | Verdict |
|---|---|---|---|
| 1 Local target edit dereferences everywhere | `references/resolve.ts:212` | `core-w4-references.test.ts:384` | **IT** |
| 2 Parents not rewritten for target field edit | `references/resolve.ts` (§19.1 rule) | `core-w4-references.test.ts:398` | **IT** |
| 3 Branch-created target selectable and dereferenceable | `references/resolve.ts:148` | `core-w4-references.test.ts:415` | **P** — "dereferenceable" proven; "selectable" (search/list) has no surface in Phase 2 and is not noted as deferred |
| 4 Local target tombstone → missing reference | `resolve.ts:148` | `core-w4-references.test.ts:442` | **IT** |
| 5 Strong reference blocks target delete | `references/integrity.ts:159,296` | `core-w4-integrity.test.ts:478` (real `deleteDocument` + real check) | **IT** |
| 6 Weak reference permits target delete | `integrity.ts:159` | `core-w4-integrity.test.ts:505` | **IT** |
| 7 Reverse reference combines base and overlay | `references/reverse.ts:296` | `core-w4-integrity.test.ts:193`, `:225` | **IT** |
| 8 Local change removes a base reference | `reverse.ts:296`, `integrity.ts:159` | `core-w4-integrity.test.ts:241`, `:543` | **IT** |
| 9 Local change adds a reference | same | `core-w4-integrity.test.ts:253`, `:562` | **IT** |
| 10 ID migration plan includes all incoming refs | `references/migration.ts:198` | `core-w4-migration.test.ts:57`, `:209` | **IT** |
| 11 Type migration detects incompatible targets | `references/migration.ts:318` | `core-w4-migration.test.ts:281` | **IT** |

| Other §7 checkbox | Implementation | Test | Verdict |
|---|---|---|---|
| Reference extraction with path + strength (§19.1, §19.5) | `references/extract.ts:40,65` | `core-w4-references.test.ts:37-230` | **IT** |
| Virtual target resolution, 6-step order (§19.2) | `references/resolve.ts:98,148` | `core-w4-references.test.ts:232-381` (one test per step) | **IT** |
| Reverse scan bounded by `query.maxReferenceDepth`, truncation is an **error** | `references/reverse.ts:125,296,395` | `core-w4-integrity.test.ts:298-416` | **IT** |
| Strong/weak integrity + §18.8 "unless same transaction" exemption | `integrity.ts:159,296`, `mutation.ts:518` | `core-w4-integrity.test.ts:514`, `:529` | **IT** |
| §34.10 strong refs published before branch publish | `integrity.ts:183` | `core-w4-integrity.test.ts:623-705` | **IT** |
| ID immutability + migration plan model (§19.6, §20.4) | `migration.ts:130,198,408,425,436` | `core-w4-migration.test.ts:56-278` | **IT** |
| Validation port: injected, no-op default, fixture validator, §20.5 timing | `validation/validator.ts:21,98,103,112,159`, `validation/schema.ts`, testkit `src/validationFixtures.ts` | `core-w4-validation.test.ts:59-196`, `:202-256` | **IT** |

### 2.6 §8 W5 — memory store, contract suite, invariants, properties, testkit

| Plan item | Implementation | Test | Verdict |
|---|---|---|---|
| §8.1 Define the store contract interface | `store-fs/src/contract.ts:382` (**wrong package**) | via `store-fs.test.ts` | **P** |
| §8.1 In-memory adapter with injectable clock/ID | **nothing** — no `MemoryOverlayStore` anywhere in the repo | — | **M** |
| §8.2 All 17 §35.7 cases | `testkit/src/storeContract.ts:279-960` (one `it()` per line, all 17) | run against `FsOverlayStore` only (`store-fs.test.ts`) | **P** — suite complete, subject missing |
| §8.3 §34.1 one draft + one published | — | — | **M** |
| §8.3 §34.2 tombstone suppresses inheritance | behaviour in `mutation.ts:435`, `resolve.ts:75` | `core-w2.test.ts:297`, `:805` | **IU** as an invariant (no callable check) |
| §8.3 §34.3 heads point to existing revision | `store-fs/src/contract.ts:373` (fs `dangling`) | `store-fs.test.ts` | **M** for core |
| §8.3 §34.4 checksum matches content | `checksum.ts:169` `verifyChecksum` primitive | `core-w1.test.ts:91`, contract "Checksum corruption detection" | **P** — primitive only, no record-level invariant |
| §8.3 §34.5 one increment per transaction | enforced in `transaction.ts:133` | `core-w2.test.ts:497`, `:630` | **IU** as an invariant |
| §8.3 §34.6 one key → one result | `transaction.ts:53,84` | `core-w2.test.ts:606` | **IU** as an invariant |
| §8.3 §34.8 orphan revisions invisible | `store-fs` only | `store-fs.test.ts` | **M** for core |
| §8.3 §34.11 unset suppression | `merge/invariants.ts:73` | `core-w3-merge.test.ts:769`, `:996` | **IT** |
| §8.3 §34.12 untouched inheritance | `merge/invariants.ts:88` | `core-w3-merge.test.ts:780`, `:996` | **IT** |
| §8.3 §34.13 touched preservation | `merge/invariants.ts:116` | `core-w3-merge.test.ts:791`, `:996` | **IT** |
| §8.3 §34.14 base deletion recovery | `merge/invariants.ts:149` | `core-w3-merge.test.ts:802`, `:996` | **IT** |
| §8.3 §34.17 checkpoint determinism | `serialize.ts:136` by construction | `core-w1.test.ts:125` | **P** — no callable assertion |
| §8.4 §35.2 / §35.3 / §35.4 / §35.5 / §35.6 in full | see §2.2-§2.5 | — | **IT** (67/67 named cases) |
| §8.5 property list (13) | see §2.7 | — | **P** |
| §8.6 Deterministic fixture datasets + parity helpers | `testkit/src/fixtures.ts`, `fixtures/dataset.ndjson` | `mutation-gaps.test.ts`, `offline-parity.test.ts` | **IT** (Phase 1 carry-over) |
| §8.6 Fixture builders for ancestor/base/local triples | `testkit/src/mergeFixtures.ts:74-277` | used by all W3 tests | **P** — not exported from `src/index.ts` |
| §8.6 Deterministic clock, actor and ID generators | test-local (`core-w2.test.ts:56-73`, `referenceFixtures.ts:19`) | — | **P** — not a testkit export |
| §8.6 Fixtures shaped for the §35.11 GROQ list | `testkit/fixtures/dataset.ndjson` (41 docs, Phase 1) | `spike-c-parity.test.ts` | **P** — not re-verified against the §35.11 list post-registry approval |
| §8.6 Contract-test runner exported | `testkit/src/index.ts` re-exports `runStoreContractSuite` | consumed by `store-fs.test.ts:40` | **IT** |

### 2.7 §8.5 property suite, item by item

| Plan §8.5 property | Where | Generative? | Verdict |
|---|---|---|---|
| Serializer determinism + fixpoint | `core-w1.test.ts:125`, `:157` | **No** — 2 hand-written objects + 9 literal samples | **P** (PRD §35.1 says "arbitrary documents and key orders") |
| Path + logical-ID encoding round-trip | `core-w1.test.ts:255` (15 cases), `:310` (18 cases) | **No** — `it.each` tables | **P** |
| Merge identity | `core-w3-merge.test.ts:853` | Yes, 32 seeds | **IT** |
| Keyed array merge (no dup `_key`, insertions kept) | `core-w3-arrays.test.ts:515` | Yes | **IT** |
| Rebase idempotence | `core-w3-rebase.test.ts:511` | Yes | **IT** |
| Checksum integrity after generated op sequences | — | — | **M** |
| Untouched-path inheritance | `core-w3-merge.test.ts:888` | Yes | **IT** |
| Touched-path preservation + same-path conflict | `core-w3-merge.test.ts:913` | Yes | **IT** |
| Unset persistence across later base mutations | `core-w3-merge.test.ts:941` | Yes | **IT** |
| Transaction idempotence (replay never changes state) | `core-w2.test.ts:606`, `:630` | **No** — two fixed scenarios | **P/M** as a property |
| *(plan)* Merge determinism | `core-w3-merge.test.ts:870` | Yes | **IT** |
| *(plan)* Local-equals-ancestor collapse | `core-w3-merge.test.ts:969` | Yes | **IT** |
| *(plan)* Local-equals-base removal on rebase | `core-w3-rebase.test.ts:552` | Yes | **IT** |

**Seed corpus reproducibility (plan §10) is genuinely satisfied for the generative half.** `testkit/src/mergeFixtures.ts:41` is a mulberry32 PRNG (platform- and Node-version-independent); `:64` records 32 append-only seeds; `core-w3-merge.test.ts:848` asserts the corpus is ≥32 and duplicate-free; every property assertion embeds `seed` in the compared object so a failure names its reproducer. This is the right shape.

### 2.8 §10 phase acceptance checklist

| §10 item | Verdict | Evidence |
|---|---|---|
| All §37 Phase 1 checkboxes in W1-W4 implemented | **Yes**, with the §17.11 head-comparison function outstanding (§2.4) | §2.1-§2.5 |
| §35.2-§35.6 unit suites pass in full | **Yes** — 67/67 named cases, all green | §1 count table |
| Property suite: every §35.1 property + plan additions, fixed seed corpus | **No** — 8/13 generative, 1 missing outright | §2.7 |
| Memory adapter passes 100 % of §35.7 | **No** — no memory adapter exists | §2.6 |
| Phase-2-scoped §34 invariants executable and green | **No** — 4 of 12 | §2.6 |
| Dependency-boundary lint proves no Next.js/Vercel/`node:fs`/`@vercel/blob`/`@sanity/client` runtime import | **No enforcement.** No `eslint.config.*`, no `.eslintrc`, no `.github/`, no boundary test. Manual grep confirms core is clean today | F-06 |
| Serializer byte-identical for the same logical state | **Partial** — `core-w1.test.ts:125,140,145` prove key-order and formatting stability in-process; no cross-run, cross-platform, or cross-Node check, and no CI to run one | F-07 |
| Contract-test runner exported and consumable by Phase 3 | **Yes** — `testkit/src/index.ts`, consumed at `store-fs.test.ts:40` | — |
| Implementation matches the §12 resolution log; no open questions | **Mostly** — O1 ✓ (`types/operations.ts` union), O2 ✓ (13 members, `types/conflict.ts:8`), O3 ✓ (`:86` table matches §17.4), O4 ✓ (`checksum.ts:182` 12-hex prefix, `:161` SHA-256 over canonical JSON), O5 ✓ (`transaction.ts:84`), O6 ✓ (`core-w3-rebase.test.ts:311`), O7 ✓ (`validation/` injected port, zero Studio import), **O8 partial** (§2.7) | — |
| Phase report claims `[M-LOCAL]` foundations only, no acceptance | **Yes** — `core/src/index.ts:11`, `store-fs/src/index.ts:13` | — |

### 2.9 §11 non-goals — leakage check

| Non-goal | Present in repo? | Counted as Phase 2? |
|---|---|---|
| `FsOverlayStore`, atomic writes, canonical layout (Phase 3) | Yes — `packages/sanity-overlay-store-fs/**` (3 426 LoC), `store-fs.test.ts` (34 tests) | **No** — its own header calls it "roadmap Phase 3". But it *hosts* the Phase 2 store contract interface (F-09) |
| Checkpoint `intent.json` / content-addressed snapshots (Phase 3/7) | Yes — `store-fs/src/intent.ts` (323 LoC) | No |
| GROQ planner / registry (Phase 6) | Yes — `testkit/spike-c/**` | No — labelled Phase 1 spike |
| Studio facade / listener emulation (Phase 5) | Yes — `examples/kitchen-sink/spikeA/**`, `overlay-server.test.ts`, `proxy-ws.test.ts` | No — Phase 1 spike evidence |
| Live edit mode (§18.10 `[LATER]`) | Flag only, and enabling it throws — `actions/index.ts:95` | Correct: "build the flag, not the feature" |

**No Phase-2 progress document exists** (`docs/plans/evidence/phase-2/` was empty before this audit), so nothing currently *claims* the above as Phase 2 work. The risk is prospective, not realised.

---

## 3. Adversarial findings, by severity

### F-01 — HIGH · The W3 merge engine is never wired into W2; every action runs on a stub that is documented to be wrong
`packages/sanity-overlay-core/src/mutations/ports.ts:100`

```ts
export const localWinsMerge: MergeResolver = (input) => input.localMaterialized
```

Its own docstring (`ports.ts:92-98`) concedes: *"the local materialized document wins wholesale. That is the §17.2 precedence rule 3 without rule 4's untouched-path inheritance… Every W2 test fixes both sides so the distinction is not exercised."*

`mutations/resolve.ts:36` makes this the default (`context.merge ?? localWinsMerge`), and **grep across the entire repo finds exactly zero injections of the `merge` port** — `createMergeResolver` (`merge/merge.ts:417`) appears only in its own two-assertion adapter test at `core-w3-merge.test.ts:823`. Consequences:

- All 11 §35.5 action tests, both W4 integrity/validation composition suites, and `documentExists`/`setIfMissing`/`createIfNotExists` existence resolution run under a merge that violates invariant §34.12.
- `publish()` at `actions/index.ts:183` publishes `resolveDraft(...)`, i.e. the **unmerged** local materialized document. In production wiring that silently discards every upstream change on untouched paths at publish time.
- The engine's two halves have never been exercised together. Both are individually excellent; the composition is unproven.

This is the single largest gap between "W1-W4 implemented" and "Phase 2 works".

### F-02 — MEDIUM-HIGH · Two §35.5 cases are proved only against a hand-written mock of the port they depend on
`core-w2.test.ts:914-925` and `:961-972` construct `StrongReferenceCheck` functions that **return a literal issue list**. They prove `publish`/`unpublish` react to a port, not that the reference engine ever produces that verdict for a draft-only target. The real engine is exercised at `core-w4-integrity.test.ts:657` (`publishReferenceIssues`) and `:706`, but never through `publish()`/`unpublish()` — unlike the delete path, which *is* genuinely composed at `core-w4-integrity.test.ts:465-512` via `createStrongReferenceCheck`. The composed publish/unpublish path is missing for no reason: the adapter exists.

### F-03 — MEDIUM · The §17.4 severity table is 3/13 verified; a wrong severity would pass
`core-w1.test.ts:648-662`. The loop is:

```ts
for (const type of types) expect(['soft','hard']).toContain(DEFAULT_CONFLICT_SEVERITY[type])
```

`DEFAULT_CONFLICT_SEVERITY` is typed `Record<OverlayConflictType, 'soft'|'hard'>`, so this assertion is guaranteed by the type system and can only fail on `undefined`. Only `PARENT_SHAPE_CHANGED`, `BASE_DRAFT_DELETED` and the `REFERENCE_TARGET_DELETED` strength split are checked against the PRD. Flipping `ARRAY_KEY_COLLISION` or `UNSUPPORTED_SCHEMA_MIGRATION` to `'soft'` in `types/conflict.ts:86` would pass this test. (I verified by hand that the table at `types/conflict.ts:88-102` **is** currently correct against PRD §17.4, and the 13-member union at `:8-21` matches PRD §13.11 exactly — the bug is in the test, not the data.)

### F-04 — MEDIUM · A §35.2 case name inside the §35.2 block asserts the opposite of the PRD line
`core-w3-merge.test.ts:169`, titled *"Local value equal to current base removes redundant override (§17.3 step 5 collapse)"*, ends with:

```ts
expect(result.removedTouchedPaths).toEqual([])
```

i.e. the override is **not** removed. The reasoning is correct — §17.3 step 5 fires on `local == ancestor`, not `local == base`, and the comment says so — and the genuine PRD case ("…**on rebase**") is covered at `core-w3-rebase.test.ts:323` plus the property at `:552`. But a reader auditing the `describe('§35.2 core merge unit tests')` block by name will count case 4 as satisfied by a test that proves the negative. This is the same failure mode as the previously reported mis-mapping; the coverage is real, the labelling is not. Renaming to "…does **not** collapse at merge time (§17.3 step 5 is local==ancestor); see rebase for the §35.2 case" would close it with no behaviour change.

### F-05 — MEDIUM · The "property-based" layer is narrower than PRD §35.1 requires
PRD §35.1: *"generated over arbitrary valid documents, paths, and operation sequences."* The generator (`testkit/src/mergeFixtures.ts:361`) varies scalar values at **7 fixed paths of one fixed document** (`SCALAR_PATHS`, `:284`) plus at most one keyed insertion per side. It never generates document shapes, nesting depth, type changes, Portable Text, or operation sequences. Consequences:

- The five merge properties are really "value-combination sweeps over one fixture".
- Two required properties have no generative form at all: **checksum integrity after any generated operation sequence** (absent entirely) and **transaction idempotent replay** (two hand-written cases).
- Serializer fixpoint and path/ID round-trip are `it.each` tables, not generation — the two properties PRD §35.1 lists first.

The seeds and reproducibility machinery are right; the generator's range is the gap.

### F-06 — MEDIUM · No dependency-boundary enforcement exists at all
§3 and §10 both require it. There is no `eslint.config.*`, no `.eslintrc*`, no `.github/` directory, and no test asserting core's import graph. `pnpm test` is `pnpm -r test`, which for both non-testkit packages is `echo 'tested via sanity-overlay-testkit'`. Core is clean today (grep for `node:`, `@sanity/`, `@vercel/`, `next` in `packages/sanity-overlay-core/src` returns only comments and identifiers named `node`), but nothing stops the first regression. A single test that walks `core/src/**` and asserts every `import` specifier is relative would satisfy the `[MUST]` half of the requirement in ~15 lines.

### F-07 — MEDIUM · "Serializer byte-identical" is asserted only within one process
`core-w1.test.ts:125` compares two objects built with different key insertion order in the same run; `:140` pins integer-like key ordering; `:145` pins indentation and trailing newline. Nothing checks stability across runs, platforms or Node versions — and with no CI in the repo, the plan's "additionally verify across platforms and Node versions in CI" cannot be satisfied. A committed golden-bytes fixture compared byte-for-byte would cover the cross-run half cheaply.

### F-08 — LOW-MEDIUM · One describe block's assertions cannot fail from a production regression
`core-w1.test.ts:471-673`, *"W1 type-level smoke: §13 schemas construct and hold their shape"*. `manifest` (`:481`) and `record` (`:520`) are object literals **authored in the test**; assertions like `expect(record.origin).toBe('base')` (`:614`), `expect(manifest.status).toBe('active')` (`:603`) and `expect(manifest.conflictSummary.total).toBe(hard + soft)` (`:606`) restate the literal. Their real value is the TypeScript type annotation, which is a compile-time check, not a test. The three lines that *do* exercise code — `assertRecordFormatVersion` (`:609`) and the two `serialize(parse(serialize(x)))` round-trips (`:610`, `:632`) — are worth keeping; the rest inflates the green count by ~4 tests.

Related, smaller: `core-w3-merge.test.ts:497` labels `expect(result.checksum).toBe(checksum(result.document))` an "independent oracle". It is not — merge computes the same call internally. It still catches "hashed the wrong object", so keep it, but drop the claim.

### F-09 — LOW-MEDIUM · The store contract lives in the filesystem adapter, inverting the package boundary
`packages/sanity-overlay-store-fs/src/contract.ts:382` defines `OverlayStore` — the interface plan §8.1 assigns to Phase 2 and §10.1 says every adapter implements. Its own comment (`:44`) says the split *"lets the identical §35.7 suite run against memory, filesystem and Blob"*, which is exactly why it should not sit inside one of those three. As written, Phase 4's Blob adapter must take a runtime dependency on `sanity-overlay-store-fs`.

### F-10 — LOW · Testkit fixtures are private to the test folder
`packages/sanity-overlay-testkit/src/index.ts` re-exports only `fixtures`, `groq`, `env`, `hosted` and `storeContract`. `mergeFixtures.ts`, `referenceFixtures.ts`, `validationFixtures.ts` and `writeGuardContract.ts` are reachable only by deep relative path from `test/`. Plan §8.6 lists the triple builders and the deterministic clock/actor/ID generators as testkit deliverables for later phases; the deterministic clock and transaction-ID counter in fact live inside `core-w2.test.ts:56-73` and are not reusable at all.

### F-11 — LOW · Two plan promises with no artefact
- Plan §6 scope boundary: *"Phase 2 provides the pure three-way overlay-head comparison function that §17.11 requires."* No such function exists; only the `OVERLAY_SAME_PATH_CHANGED` conflict type (`types/conflict.ts:10`).
- §35.6 case 3 asserts "dereferenceable" but not "selectable" (`core-w4-references.test.ts:415`); the selection surface belongs to Phase 6 but the test does not say so.

---

## 4. The red tests to write next, in priority order

Each must be written **red first** and observed failing for the stated reason before any code changes (CLAUDE.md TDD rule).

1. **Merge-port composition (closes F-01).** In `core-w2.test.ts` or a new `core-w5-composition.test.ts`: build a base document, `edit()` one path, then move the **base** on a *different, untouched* path; assert `resolveDraft(state, id, {base, merge: createMergeResolver({...})})` returns the new upstream value on the untouched path **and** the branch value on the touched one. Then assert the same through `publish()`. *Expected red:* passes with the injected resolver, fails when `merge` is omitted — proving the default stub is unsafe. Follow with the class: `resolvePublished`, `documentExists`, `setIfMissing` missingness, and `duplicate()`'s source resolution, all against a moved base. Then decide whether `localWinsMerge` should remain the default or become an explicit opt-in.

2. **Composed publish/unpublish reference blocking (closes F-02).** In `core-w4-integrity.test.ts`, reuse the existing `checked(state)` helper (`:465`) and call the real `publish()` on a document holding a strong reference to a branch draft-only target; assert `OverlayActionBlockedError` with `reason: 'strong-reference-invalid'`. Same for `unpublish()` reporting real `affectedStrongReferences`. *Expected red:* fails today only if the wiring is wrong — run it before trusting it; if it passes first try, mutate `publishReferenceIssues` to return `[]` and confirm it goes red.

3. **Severity table transcribed from the PRD (closes F-03).** Replace the loop at `core-w1.test.ts:648` with a literal 13-row expected map transcribed by hand from PRD §17.4 and `toEqual` it against `DEFAULT_CONFLICT_SEVERITY`. *Expected red:* flip one row in the test first and watch it fail; then transcribe correctly.

4. **Memory adapter + §35.7 suite (closes the §10 blocker).** Create `packages/sanity-overlay-store-memory`; add `runStoreContractSuite('MemoryOverlayStore', …)` as the **first** thing written. *Expected red:* all 17 cases fail with "not implemented". Then build the adapter with injectable clock and ID source. Move `OverlayStore` (F-09) into core or a shared `store-contract` package in the same change, since both adapters must import it.

5. **Checksum-integrity property over generated operation sequences (closes half of F-05).** Extend `mergeFixtures.ts` with an operation-sequence generator (`set` / `unset` / `inc` / `insert` over the recorded seeds), apply each sequence through `applyTransaction`, and assert every resulting record's stored checksum equals `checksum(record)` recomputed. *Expected red:* write the assertion against a deliberately stale head first.

6. **Transaction-idempotence property (closes the other half of F-05).** For each seed, generate a mutation list, apply it twice under one `idempotencyKey`, and assert `serialize(state₂) === serialize(state₁)` and `transaction₂ === transaction₁` including `transactionId`.

7. **Generative serializer and path/ID round-trip (F-05, PRD §35.1's first two required properties).** Add a JSON-value generator (nested objects, arrays, unicode, empty-string keys, `-0`, deep nesting) and an `OverlayPath` generator (string segments with dots/brackets/backslashes, `{_key}` segments, numeric indexes) driven by the same recorded seeds; assert `serialize(parse(serialize(x))) === serialize(x)` and `decode(encode(p))` deep-equals `p` across the corpus.

8. **Dependency-boundary test (closes F-06).** A test that reads every `.ts` under `packages/sanity-overlay-core/src`, extracts import specifiers, and asserts each starts with `.`. *Expected red:* add a temporary `import {x} from 'node:path'` in a scratch copy to confirm it fires — or simply assert against a deliberately wrong allowlist first. Extend to a `package.json` check for `next`, `@vercel/*`, `@sanity/client`.

9. **Golden serializer bytes (closes F-07).** Commit a fixture file of expected canonical output for a representative document; assert `serialize(doc)` equals the committed bytes exactly. Fails on any cross-run or cross-version drift, without needing CI.

10. **Remaining §8.3 invariants (closes the §10 invariant item).** In priority order: §34.4 (record checksum matches serialized content — needs a record-level `checkDocumentIntegrity`), §34.5 and §34.6 (assertions over an `OverlayState` + transaction log, callable from debug tooling), §34.1 (at most one current local draft and one current local published), §34.2, §34.17. Each needs the same treatment as `merge/invariants.ts`: write the check, then a red test that feeds it a **deliberately broken** state and asserts the violation is reported — the pattern already used well at `core-w3-merge.test.ts:769-822`.

11. **Rename the §35.2 case-4 test (closes F-04)** and add a one-line pointer to `core-w3-rebase.test.ts:323`. No behaviour change; pure traceability repair.

12. **Overlay-head three-way comparison function (closes F-11).** Write the red test for §17.11's structured conflict response — same path changed by two overlay heads returns current head + requested intent + conflict path — then implement.
