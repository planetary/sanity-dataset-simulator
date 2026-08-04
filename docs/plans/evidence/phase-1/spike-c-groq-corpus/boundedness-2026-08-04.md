# Spike C — §22.6 boundedness, re-proven against an independent oracle

**Date:** 2026-08-04
**Closes:** evidence review `evidence-review-2026-08-04.md` finding **F6**
**Scope:** `packages/sanity-overlay-testkit/spike-c/**`, `test/spike-c-boundedness.test.ts`,
`test/mutation-gaps.test.ts`, `test/spike-c-parity.test.ts`
**Status:** F6 closed. Gate D's boundedness claim is now falsifiable. Three queries
reclassified Tier A → **Tier B**. **No query moved to Tier C; the §0.6 abort threshold is
not approached.**

---

## 1. What F6 actually said

The remedy for the *first* self-correction (parity cannot detect over-fetching) added
per-plan-type candidate ceilings to `mutation-gaps.test.ts`. F6 found those ceilings
largely restate the implementation:

```
mutation-gaps.test.ts:160-167   ceiling = every document of the candidate type
planner.ts:83-86                selects  every document of the candidate type
```

For the 9 `slug`/`types` queries the asserted ceiling **is** the full type scan.
`article-by-slug` scanned all 30 articles to return 1 document and passed comfortably.
A ceiling derived from the implementation cannot falsify the implementation — the same
defect as the first self-correction, one level up. Only 3 empty-overlay anchors were
implementation-independent, and one of those 3 was itself the type scan.

**§22.6's claim is about candidate sets that do not grow with the dataset.** What the
old suite proved was "the planner does not cross a type boundary".

---

## 2. Method — the oracle is independent by construction

`test/spike-c-boundedness.test.ts` derives every ceiling from **two things only**:

1. the semantics of the registered **query text**, read by a human, and
2. the **fixture dataset**, measured through `groq-js`.

Nothing in the ceiling table reads `def.candidatePlan`. No constant is copied from
`planner.ts`. `K` is parsed out of the query's own `[0...K]` slice rather than read from
the registry. Every entry carries a `why` recording the argument for why no exact planner
could do better.

Two things F6 called for and this adds:

- **A 10× fixture.** At 41 documents a linear bound and a constant bound are
  indistinguishable. The sweep runs every case at 30 articles and at 300.
- **Three honest classes**, assigned by hand:

| class | meaning |
| --- | --- |
| `constant` | candidate set does not grow with the dataset. §22.6's actual claim. |
| `result-proportional` | bounded by the size of the **answer** plus the branch delta. A planner cannot materialize fewer documents than it returns. |
| `type-linear` | grows with the **type** while the answer stays small. **NOT bounded** in the §22.6 sense. Recorded as an admission, classified Tier B, and pinned as growing so the classification cannot silently rot. |

### 2.1 A note on what is measured

The spike measures **candidate-set size**, not wire I/O. The `base-filter` plan models a
server-side filtered fetch — PRD §22.7's "exact slug-filtered pages plus all overlaid page
documents" — so only the documents the filter *returns* enter the candidate set. That
assumption is sound exactly when the filter reads **local fields** of the candidate types.
A predicate that traverses a reference can gain matches when the *target* is edited, which
is why `articles-by-author-name` cannot use it (see §5).

---

## 3. Per-query results

Independent ceiling vs. the planner's actual count. Empty overlay, so the branch delta is
0 and the numbers are the plan's own choice. `sel` = plan-selected
(`candidateCount − referenceExpansions`); `total` includes reference expansion.
Dataset: 30 articles / 3 pages / 39 documents at 1×; 300 articles / 309 documents at 10×.

| query | tier | answer | independent ceiling | sel @1× | sel @10× | total @1× | total @10× | class | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `article-by-id` | A | 1 | 1 | 1 | 1 | 9 | 9 | constant | PASS |
| `object-spread` | A | 1 | 1 | 1 | 1 | 9 | 9 | constant | PASS |
| `article-with-author` | A | 1 | 1 | 1 | 1 | 2 | 2 | constant | PASS |
| `pt-text` | A | 1 | 1 | 1 | 1 | 6 | 6 | constant | PASS |
| `page-featured-refs` | A | 1 | 1 | 1 | 1 | 8 | 8 | constant | PASS |
| `page-by-slug` | A | 1 | 1 (filtered base fetch) | 1 | 1 | 8 | 8 | constant | PASS |
| **`article-by-slug`** | A | 1 | **1** (filtered base fetch) | **1** | **1** | 7 | 7 | constant | **PASS — was 30** |
| `projection-rename` | A | 5 | 5 (`K` from query) | 5 | 5 | 10 | 10 | constant | PASS |
| `articles-ordered-sliced` | A | 20 | 20 (`K` from query) | 20 | 20 | 25 | 25 | constant | PASS |
| `recent-by-created-at` | B | 5 | 5 (`K` from query) | 5 | 5 | 14 | 14 | constant | PASS |
| `filter-by-tag` | A | 0 | 0 (filtered base fetch) | 0 | 0 | 0 | 0 | result-prop. | PASS |
| `references-author` | A | 6 | 6 (filtered base fetch) | 6 | 60 | 29 | 83 | result-prop. | PASS (answer 6→60) |
| `article-type-list` | A | 30 | 30 (= answer) | 30 | 300 | 35 | 305 | result-prop. | PASS (answer 30→300) |
| `multi-type-list` | A | 33 | 33 (= answer) | 33 | 303 | 38 | 308 | result-prop. | PASS (answer 33→303) |
| `article-count` | **B** | 1 | 30 (full type scan) | **30** | **300** | 35 | 305 | **type-linear** | **HONEST BOUND** |
| `stats-aggregate` | **B** | 1 | 30 (full type scan) | **30** | **300** | 35 | 305 | **type-linear** | **HONEST BOUND** |
| `articles-by-author-name` | **B** | 0 | 30 (full type scan) | **30** | **300** | 35 | 305 | **type-linear** | **HONEST BOUND** |

The full sweep is 17 queries × 6 overlay fixtures = 102 cases at 1×, again at 10×, plus
the growth and non-vacuity blocks: **522 assertions in
`test/spike-c-boundedness.test.ts`, all green.**

### 3.1 The one real planner improvement

A `base-filter` plan type was added. Where the query's predicate reads **local fields** of
the candidate types, the plan issues that predicate to the base as a filtered fetch and
takes only the returned documents, then unions every branch record of those types
(§22.6 step 6). This is what moves `article-by-slug` from **30 → 1** and `page-by-slug`,
`filter-by-tag`, `references-author` off the type scan.

The top-K plan was also tightened: it now fetches the top K of the **untouched** base order
and unions the affected set, rather than fetching `K + affected` and *then* adding
`affected` on top. An untouched base document with K untouched documents ordered above it
keeps them all above it after resolution, so it cannot enter the requested slice — making
`K + affected` exact rather than an over-fetch by `affected`.

No further improvement was attempted. A slug→id index over base was considered and
**rejected as unnecessary**: the filtered base fetch already reaches a constant candidate
count, so an index would optimize wire latency, not candidate-set size, and §22.6 is a
claim about the latter.

---

## 4. Tier reclassification

Three queries moved **Tier A → Tier B**. Each materializes every document of its type to
answer a small question, which PRD §22.3 places under Tier B's *"Large type-constrained
result sets"* and which §22.6 forbids at scale.

| query | from | to | reasoning |
| --- | --- | --- | --- |
| `article-count` | A | B | §22.6 step 14 evaluates the **original** query over the candidate set, so an aggregate must materialize everything it aggregates. A one-number answer costs a full type scan. Tier A's *"counts and aggregates over a proven finite candidate set"* is satisfied only in the sense that the type is finite — at 300 articles it fetches 300. Reaching Tier A needs an aggregate-pushdown planner (base count + overlay delta), which §22.6 does not describe. |
| `stats-aggregate` | A | B | As `article-count`; `math::sum` over a type materializes the whole type. |
| `articles-by-author-name` | A | B | The filter traverses a reference, so editing an author can add a referrer no base fetch selected. Exactness without a scan needs §22.6 step 10 (reverse-reference expansion over touched targets), which the spike planner does not implement. **PRD §22.7 itself specifies this plan as "Base candidates: all articles"** — the scan is PRD-sanctioned, and the honest tier for a PRD-sanctioned scan is B. |

### 4.1 §0.6 / §22.12 abort threshold — NOT approached

The threshold is *"more than 10 percent of launch-critical queries, or more than five
launch-critical queries, remain **Tier C**"*.

- **Tier C count: 1** (`unconstrained-star`), **unchanged** by this work. That entry is a
  deliberate structural-failure probe, not an application query.
- **Movement into Tier C: zero.** All three reclassifications land in Tier B, which Gate D
  accepts ("Tier A or **accepted** Tier B").
- Even counting all 18 registry entries as launch-critical, 1/18 = 5.6 % < 10 %, and
  1 ≤ 5. Both limbs pass with margin.
- Gate D's *"no launch-critical query is Tier C"* is unaffected.

**Caveat for the orchestrator.** The approved launch-critical list is a Phase 0 / D01
artifact (PRD §6, §39.3) and does not exist yet. This registry is a seed corpus. The
threshold arithmetic above is therefore provisional in its denominator, but the numerator
is what matters and it is **zero new Tier C queries**. The reclassification is a
*downgrade within the accepted range*, not an abort signal.

---

## 5. What remains genuinely unbounded, and why

Recorded plainly rather than papered over. All three are Tier B, pinned by a test that
asserts they **grow** at 10× (`≥ 5×` growth), so a future planner improvement will break
the test and force the classification to be updated rather than letting it rot.

| query | why it cannot currently do better |
| --- | --- |
| `article-count`, `stats-aggregate` | §22.6 step 14 hands the **original** query to `groq-js` over the candidate set. An aggregate is only correct if every aggregated document is present. Fixing this needs aggregate pushdown — evaluate `count()`/`sum()` against base, then apply the overlay delta arithmetically — a planner capability §22.6 does not specify. Out of spike scope; flagged for Phase 6. |
| `articles-by-author-name` | Filter-through-reference. Membership depends on a field of the **target**, so no base-side predicate over articles is complete once an author is edited. §22.6 step 10 (reverse-reference expansion) would bound it by the **referrer count** of the touched targets — better than a scan, but still not constant. §22.7 specifies the scan. |

Also honest: **reference expansion is not policed by `planSelected`** — it is subtracted
out deliberately, because dereference is a separate mechanism whose fan-out is a property
of the data, not the plan. To stop that being a loophole, the suite additionally pins the
**total** materialized count (expansion included) as equal at 1× and 10× for every
`constant`-class case. It is.

---

## 6. Non-vacuity — proven by mutation, not asserted

The first self-correction happened precisely because nothing proved an unbounded planner
would fail. Two mutations were applied to `planner.ts`, run, and reverted
(`git diff` clean, checksum `9888529…` restored and re-verified).

### M1 — fully unbounded planner

Every document of the resolved virtual dataset added to the candidate set for every query.

| suite | result |
| --- | --- |
| `spike-c-boundedness.test.ts` | **336 failed** / 186 passed |
| `spike-c-parity.test.ts` | 1 failed / **178 passed** |
| `mutation-gaps.test.ts` | 20 failed / 116 passed |

Note the middle row: **178 of 179 parity assertions still pass** with a planner that
fetches everything. That is the original self-correction's lesson reproduced on demand —
parity is preserved by any *superset* of the correct candidate set, so parity can never be
boundedness evidence.

### M2 — the pre-F6 planner (the F6 defect itself)

`base-filter` degraded back to a full type scan: `article-by-slug` fetches 30 documents to
return 1, exactly as F6 describes.

| suite | result |
| --- | --- |
| `spike-c-parity.test.ts` | **179 / 179 GREEN** |
| `mutation-gaps.test.ts` (the *old* GAP-2 ceiling) | **136 / 136 GREEN** |
| `spike-c-boundedness.test.ts` | **72 FAILED** |

**This is the closing evidence for F6.** The pre-existing suites — including the ceiling
block that was cited as the boundedness proof — are *completely blind* to the defect they
were written to catch. The new suite catches it 72 times. Restored: all green.

### Permanent guards

The mutation above is manual and therefore perishable, so the property is also pinned in
the suite itself (`test/spike-c-boundedness.test.ts` §4 and §5):

- an arithmetic check that a whole-dataset planner would violate **all 102** ceilings;
- a check that a full type scan violates **every `constant` ceiling** — i.e. the F6
  ceiling would have been vacuous and these are not;
- and, executed end to end through the real `evaluateRegistered`, the plan swapped for
  (a) a whole-dataset scan and (b) the pre-F6 type scan, both required to **exceed** the
  ceiling. Arguing arithmetically about what an unbounded planner *would* select is not
  the same as running one; these run one.

### A red found along the way

The first run of the new total-materialized test went **red on 6 cases**
(`recent-by-created-at` × all overlays). Root cause was **not** the planner: the 10× scale
harness cloned `_createdAt` verbatim, so ten documents tied on each timestamp, the top-5
`_createdAt` window drew from the tie group, and it dereferenced a different set of
authors. Scaling was changing the *answer* as well as the dataset. Fixed by giving added
documents timestamps strictly below every original on **every** field the registry orders
by, and the invariant is now itself asserted so it cannot regress silently.

---

## 7. Bottom line for Gate D

- §22.6's top-K / bounded-candidate claim is **established** for 10 `constant` and 4
  `result-proportional` queries, against ceilings that a type scan **fails**, at 10× scale.
- It is **explicitly not claimed** for 3 `type-linear` queries, which are now Tier B with
  reasoning recorded in `registry.ts` and pinned by a growth test.
- `gate-review.md`'s wording "boundedness re-proven" was accurate only for type-boundary
  crossing. It can now be stated for real, with the scope above. **The orchestrator owns
  that file — this document does not edit it.**
- The abort threshold is not in play: **zero queries moved to Tier C.**
