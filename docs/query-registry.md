# Query registry guide

**Status:** Draft
**Date:** 2026-08-06
**Source:** [docs/PRD-v1.md](PRD-v1.md) §22 (GROQ query layer), especially §22.2–§22.6, §22.9 (error policy), §5.5 (no silent approximation)

---

## 1. Why a registry exists at all

The overlay has no dataset to run GROQ against. It has a base it can ask **narrow, structured questions** of, and a branch delta on top.

So a query is answered like this: parse it with a pinned `groq-js`, **plan** a finite candidate set, fetch exactly those candidates from the base, overlay the branch, and evaluate locally over the result. That is only correct if the candidate set is **provably complete** — if a document that could have matched was never fetched, the answer is silently wrong.

Nothing infers that proof from the query text. **You supply it**, as a candidate plan, and the registry is where it lives.

The consequence is PRD §5.5, and it is the whole design in one line:

> **No silent query approximation.** A query that cannot be proven exact is refused with a structured error, never answered approximately.

---

## 2. Registering a query

A registry entry is an `OverlayQueryDefinition`. Eleven required fields, two optional.

```ts
export interface OverlayQueryDefinition {
  readonly id: string
  readonly description: string
  readonly query: string
  readonly queryChecksum: string
  readonly allowedCallers: readonly QueryCaller[]        // 'frontend' | 'studio' | 'agent' | 'test'
  readonly perspectives: readonly QueryPerspective[]     // 'published' | 'drafts' | 'raw'
  readonly candidatePlan: CandidatePlan
  readonly systemTimestampPolicy: SystemTimestampPolicy  // 'preserve-base' | 'preview-diverges' | 'unsupported'
  readonly maxCandidates: number
  readonly maxReferenceDepth: number
  readonly status: QueryTier                             // 'tier-a' | 'tier-b' | 'unsupported'
  readonly parityFixture?: string
  readonly notes?: string
}
```

Build one with `defineOverlayQuery(...)`, and a registry with `createQueryRegistry([...])`. `createQueryRegistry` validates **every** definition, so a bad entry throws at **module load**, not at query time.

```ts
import {defineOverlayQuery, queryTextChecksum} from 'sanity-overlay-query'

export const ARTICLE_BY_SLUG = defineOverlayQuery({
  id: 'article-by-slug',
  description: 'One article by its slug, for the article route.',
  query: '*[_type == "article" && slug.current == $slug][0]',
  queryChecksum: '…64 lowercase hex chars…',
  allowedCallers: ['frontend', 'studio', 'agent', 'test'],
  perspectives: ['published', 'drafts'],
  candidatePlan: {type: 'slug', types: ['article'], path: ['slug', 'current'], fromParam: 'slug'},
  systemTimestampPolicy: 'preserve-base',
  maxCandidates: 64,
  maxReferenceDepth: 3,
  status: 'tier-a',
  parityFixture: 'm-local-overlays',
})
```

### Candidate plans

Ten plan types exist in `types.ts`, and `planCandidateRequests` is the single exported entry point that turns one into base requests.

| `type` | Bounds the candidate set by | Registered in the shipped registry? |
|---|---|---|
| `ids` | document IDs from a parameter | yes |
| `ids-literal` | a fixed list of IDs | yes |
| `slug` | field equality on a local path | yes |
| `field-contains` | local array membership | yes |
| `references` | documents referencing one finite ID | yes |
| `types` | one or more `_type` values (also covers multi-type) | yes |
| `top-k` | an ordered slice — needs the branch's touched-ID set | yes |
| `aggregate` | an additive base scalar plus a branch delta | **no** |
| `reverse-reference` | the referrers of the touched documents | **no** |
| `none` | nothing — the entry must be `status: 'unsupported'` | yes (one, deliberately) |

`aggregate` and `reverse-reference` planners exist and are exercised by the Spike C rig; nothing in the shipped `M_LOCAL_QUERIES` uses them. (`mLocalRegistry.ts`'s header still says aggregates "have no planner here" — that comment is stale; the absence is registry-level now, not planner-level.)

`top-k`, `aggregate` and `reverse-reference` all need a `CandidatePlanContext` carrying the branch's touched-document IDs. **`planCandidateRequests` is called without a context by the overlay API's `POST /query/plan` endpoint**, so those three plan types raise `UNSUPPORTED_GROQ` there.

### Limits

`maxCandidates` and `maxReferenceDepth` are **required, per-query, and have no defaults**. `defineOverlayQuery` rejects non-positive values on any supported entry.

There is no `maxCandidateDocuments` identifier in the code — it appears only in comments citing PRD §11.1, which defines no value. Ratifying a global cap is still an open owner decision, and it **cannot be 5,000**: two legitimate Tier-A list queries in the Spike C corpus materialise 5,833 and 6,333 candidates. The shipped registry uses three private constants instead: `64` for lookups, `4096` for lists, `256` for slices.

### Tiers

`status` is `'tier-a' | 'tier-b' | 'unsupported'`. **Tier C is spelled `'unsupported'`** — "registered so it fails loudly".

Only two behaviours branch on it: `defineOverlayQuery` skips plan/limit validation for `unsupported`, and `evaluateOverlayQuery` throws `UNSUPPORTED_GROQ` for it. **Nothing branches on `tier-b`** — the A/B distinction is documentation, describing whether the bound is a constant or a property of the data.

Registering a Tier C query is not a formality. It is how you make a refusal **executable**: the shipped registry contains `unconstrained-star` (`*[]`, `candidatePlan: {type: 'none'}`, `maxCandidates: 0`) so the refusal path has a test that could fail.

---

## 3. The checksum workflow

### How it is computed

```ts
export const queryTextChecksum = (query: string): string => sha256Hex(query)
```

SHA-256 over the UTF-8 bytes of the query text, lowercase hex. **No normalization at all** — not whitespace, not comments, not indentation. The source states why: *"normalising whitespace would let a reformat pass unreviewed."*

### What happens when it does not match

`QUERY_CHANGED`, HTTP 422, from three places:

| When | Message |
|---|---|
| Registration (`defineOverlayQuery`, and therefore `createQueryRegistry`) | `Query <id> does not match its registered checksum. The query text was edited without refreshing the registration (PRD §22.5).` |
| Call time, when `registry.resolve(id, queryText)` is given the text | `Query text for <id> differs from the registered checksum (PRD §22.9).` |
| Duplicate ID in the registry | `Duplicate query id <id> in registry.` |

All three carry `details: {queryId, registeredChecksum, actualChecksum}`.

The first is the one that matters day to day: because the registry validates on construction, **editing a query's text without refreshing its checksum crashes at module load**, not on the request that happens to use it.

### How to update a checksum

**There is no command and no flag for this.** I checked the whole CLI: `normalize --repair-checksums` repairs the §14.4 *record* checksums on overlay files and has nothing to do with query registration.

The procedure, as the code supports it today:

1. Edit the query text.
2. Compute the new value. Either read it off the thrown error's `details.actualChecksum`, or:
   ```bash
   node --input-type=module -e '
   import {createHash} from "node:crypto"
   const q = `*[_type == "article" && slug.current == $slug][0]`
   console.log(createHash("sha256").update(q, "utf8").digest("hex"))'
   ```
   or call the exported `queryTextChecksum(query)`.
3. Paste it into the definition as a **string literal**. The shipped registry pins all fifteen by hand, on purpose.
4. If you also maintain the JSON mirror at `packages/sanity-overlay-query/lint/m-local-registry.json` — the manifest the standalone lint runner reads — update it too. Its `$comment` says it is "generated from" `mLocalRegistry.ts`, but **no generator script exists in the repo**; a test fails if the two drift.
5. Refresh the parity fixture and re-run the parity suite. PRD §22.5: *"CI fails when a query changes without refreshed parity tests."*

**Do not** compute the checksum from the same variable you are registering. That pattern exists in one example file and it defeats the entire mechanism — the check becomes a tautology. (This is also what the Studio's own read path does; see §7.)

---

## 4. `UNSUPPORTED_GROQ` — what it actually means

**It is not a blacklist of GROQ constructs.** The layer does not parse a query and refuse `count()`, `_score` or `geo::` by name. `UNSUPPORTED_GROQ` means one thing:

> **the candidate set cannot be proven complete** — so answering would be an approximation, and PRD §5.5 forbids that.

Here is every condition that produces it, in the order you would meet them.

### At registration

| Condition | The point |
|---|---|
| `status` is not `unsupported` but `candidatePlan.type === 'none'` | A supported query with no plan is a contradiction |
| `maxCandidates` or `maxReferenceDepth` is not positive on a supported entry | An unbounded query is not bounded |

### At plan time

| Condition | The point |
|---|---|
| An ID parameter is absent, empty, or not a string / array of non-empty strings | *"Guessing a candidate set from an absent parameter would be a silent approximation."* |
| A required plan parameter (`slug`, `field-contains`, `references`, `reverse-reference`) was not supplied | *"Widening the candidate set to cover a missing parameter would be a silent approximation."* |
| `candidatePlan.type === 'none'` | `Query <id> has no finite exact candidate plan: <reason>` |
| A `references` plan's parameter is not a non-empty string | §22.3 admits `references()` for **finite IDs only** |
| `top-k` planned without a `CandidatePlanContext` | Its base fetch depends on the branch delta |
| `top-k` without a positive slice end and an order | |
| `aggregate` planned without a context | *"assuming an empty branch would double-count every edited document"* |
| `aggregate: 'sum'` without a path | |
| `reverse-reference` planned without a context | *"assuming an empty branch would miss every article whose author the branch edited"* |

### At evaluation time

| Condition | The point |
|---|---|
| `status === 'unsupported'` | Registered Tier C — refuse loudly |
| An **aggregate**-planned query whose filter **dereferences** (`->`) | The base half decides membership from base state, so editing a reference *target* would move documents between halves without base knowing. *"Refused rather than returning a recombined number that is not the answer."* |
| A **reverse-reference**-planned query with a dereference **chain deeper than 1** | Reverse-reference expansion is complete for a single hop; at depth *n* a document whose ancestor was edited references nothing the base half can see |
| An aggregate plan against a base source with no `fetchAggregate` | *"Fetching the aggregated type and summing it locally would return the right answer by transferring everything, which §22.2 forbids"* |
| An extended request against a base source with no `fetchExtendedCandidates` | *"Falling back to a broader fetch filtered locally would return the right answer by over-fetching"* |

Note the shape of those last two. Both would return **the correct value**. Both are refused anyway, because they get it by transferring the dataset — which is the thing the overlay exists not to do.

### The other refusal codes

`UNSUPPORTED_GROQ` is one of nine. All are `OverlayQueryError`, whose `toJSON()` emits `{name, code, httpStatus, message, details}`.

| Code | HTTP | Fires when |
|---|---|---|
| `QUERY_NOT_REGISTERED` | 422 | The ID is not in the registry. *"Unregistered queries are rejected, never approximated."* |
| `QUERY_CHANGED` | 422 | Checksum mismatch, or a duplicate ID |
| `UNSUPPORTED_GROQ` | 422 | Above |
| `CANDIDATE_LIMIT_EXCEEDED` | 413 | `candidates.size > maxCandidates`, checked **after** reference expansion |
| `REFERENCE_DEPTH_EXCEEDED` | 422 | Unexpanded references remain past `maxReferenceDepth` |
| `INVALID_GROQ` | 400 | `groq-js` failed to parse the registered text |
| `GROQ_EVALUATION_FAILED` | 500 | `groq-js` threw during evaluation |
| `QUERY_CALLER_NOT_ALLOWED` | 403 | Caller not in `allowedCallers` |
| `QUERY_PERSPECTIVE_NOT_REGISTERED` | 422 | Perspective not in `perspectives` |

The last two are extensions beyond PRD §22.9's table, flagged as such in the source. §22.9 also names `BASE_UNAVAILABLE` and `OVERLAY_STORE_UNAVAILABLE` (both 503); those are store-layer codes, not query-layer ones.

Through the CLI, every one of these exits **6** (`EXIT.QUERY_REFUSED`) carrying the query layer's own code.

---

## 5. Diagnostics — and one thing not to build on

Every successful call returns `{result, diagnostics}`:

```
queryId  candidateCount  baseRequestCount  referenceDepth  durationMs
conflictsTouched  unsupportedFeatures  exact  planSelectedCount
baseFetchDocuments  referenceExpansions  evaluatorInvocations
candidateBytes  candidateIds
```

**`exact` is hard-coded `true` and `unsupportedFeatures` is hard-coded `[]`.** The justification is in the source and it is coherent — *"a registered Tier A/B query is exact by construction: the paths that cannot be proven exact throw above rather than degrading this flag"* — but the practical rule for a caller is blunt:

> **You learn a result is not exact by catching an error, never by reading `diagnostics.exact`.** Do not write logic against that field.

Two more to know: `evaluatorInvocations` is hard-coded `1`, and `candidateBytes` is `0` unless you pass `measureBytes: true` (and even then it is `JSON.stringify(doc).length`, a character count, not bytes). `durationMs` is *"emitted as evidence and is deliberately never a pass/fail gate."*

---

## 6. The lint gate — strict vs warn

Five rules, and **severity is not per-rule**. It is set once per run from the mode:

- `--mode strict` → every finding is an `error` → the run's `ok` is false → **exit 2**
- `--mode warn` → every finding is a `warning` → `ok` is always true → **exit 0**, with the identical findings printed

**The default is `strict`.** An unknown value is a usage error (exit 5) with a message that says what warn mode is for: *"`warn` is the §22.5 migration mode and does not fail the build."*

That maps directly onto PRD §22.5's pair of requirements — `[MUST]` reject unregistered queries in strict preview mode, `[SHOULD]` allow a local development warning mode during migration.

### The five rules, in the order they are evaluated per literal

1. **`direct-client-import`** — a specifier resolving to `@sanity/client` or `next-sanity` (exact package or `pkg/subpath`, never `pkg-other`), in `import … from`, bare `import '…'`, `require('…')` or `import('…')` position.
2. **`live-bypass`** — the same specifier, but the import clause names `defineLive`, `SanityLive`, `useLiveQuery` or `useLiveEvents`. Reported separately because *"no import swap fixes that"*.
3. **`dynamic-query`** — a GROQ-looking literal that is interpolated or an operand of `+`. Checked **before** registry matching, deliberately.
4. **exact registry match** — not a finding. Recorded in `report.resolved` with its `queryId`.
5. **`query-text-drift`** — no exact match, but the whitespace-normalized form matches a registered query. Byte-for-byte checksums mean this raises `QUERY_CHANGED` at runtime, so it is worth its own code.
6. **`unregistered-query`** — the fallthrough.

Output:

```
<file>:<line>:<col>  <severity>  <code>  <message>
    <literal, truncated to 160 chars>

N errors, N warnings in N files (N literals scanned)
```

### What it cannot see

It is a **lexical scan, not a parse**. A query assembled from fragments, read from a file, or received over the network is invisible to it. Treat a clean report as a floor.

### Two runners, two registries

- **`sanity-overlay lint`** uses the in-process `M_LOCAL_QUERIES`.
- **`packages/sanity-overlay-query/lint/check-queries.mjs`** reads the JSON manifest by default (`--registry`, `--mode`, `--ext`, `--ignore`, `--json`), and **re-verifies every pinned checksum with `node:crypto`**, exiting 2 on a mismatch:
  ```
  registry manifest <path>: query <id> does not match its pinned checksum (<pinned> != <actual>)
  ```

Point them at your own registry, or they will report every one of your queries as unregistered.

---

## 7. Running a registered query from the CLI

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs query --list
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs query article-by-slug \
  --param slug=hello \
  --base ./base-fixture.json \
  --perspective drafts \
  --caller agent \
  --root <overlay-dir>
```

- The positional argument is a **query ID, not GROQ text**.
- `--param name=value`, repeatable. The value is parsed as JSON when it parses, otherwise treated as a plain string.
- `--base <file.json>` supplies the base dataset. **Omitting it evaluates against an empty base** — useful, and a trap if you forget. `fs` mode has no live base connection.
- `--caller` defaults to `agent`; `--perspective` defaults to `drafts`.
- Registry refusal exits **6** with the layer's own code.

---

## 8. Honest caveats

- **The Studio does not use the registry.** `packages/sanity-overlay-studio/src/client/readPlan.ts` computes a checksum from the query text and immediately registers a definition with `id: 'studio:<first 16 hex>'` and that checksum. The check is a tautology on that path. `M_LOCAL_QUERIES` is never imported by the Studio package at all.
- **Therefore there are two planners**, and only `packages/sanity-overlay-query/src/planner.ts` is covered by the boundedness suite's 10× fixture and unbounded-mutant sweep. The planner a real Studio runs is the uncovered one.
- **`strictQueries` ships as `false`.** With it on, once one document has branch state, every Studio-issued read the planner cannot prove complete throws `OverlayReadRefusedError` — and Studio composes GROQ at runtime for its own plumbing. The default was changed on 2026-08-05 for that reason. No test exercises a Studio-shaped workload under strict mode with branch state.
- **`parityFixture` is not validated.** It is a free-form string; the only assertion is that it is truthy. Every shipped entry sets `'m-local-overlays'`, which is not a key in the parity overlay map.
- **The launch-critical query list does not exist.** Gate D's Tier-C *ratio* is measured against it. The numerator is zero, so the conclusion holds under any denominator — but the ratio cannot be formally closed without the list, and approving it is an owner decision.
- **Gate D's latency evidence is real and recent.** Aggregate pushdown (§22.6 step 14), reverse-reference expansion (step 10) and dereference-path analysis (step 8) all landed on 2026-08-05: `article-count` p95 went 1,469 → 5.8 ms, `stats-aggregate` 2,999.7 → 4.6 ms, `articles-by-author-name` 12,691 → 15.0 ms. **17 of 17 queries are within the §5.4 budgets.** That evidence is in [spike-c-groq-corpus/latency-2026-08-04.md](plans/evidence/phase-1/spike-c-groq-corpus/latency-2026-08-04.md) — and it is Spike C's prototype registry, not the shipped one.
