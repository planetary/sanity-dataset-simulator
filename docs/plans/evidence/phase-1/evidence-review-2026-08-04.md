# Adversarial evidence review — Phase 1

**Date:** 2026-08-04 · **Method:** read-only. Every claim in `gate-review.md`, `decisions.md` and the five spike reports was traced to the artifact that is supposed to back it; the artifact was then read, replayed or re-run. No file in the repo was modified except this one.

**Posture:** the goal was falsification. Where a claim survived attack it is marked **holds** and said so plainly. Where it did not, the specific artifact and line are cited.

**What I ran:** full testkit suite (`vitest run`, 20 files / 1103 tests, all green); a replay of all 88 distinct request lines in `proxy-log.jsonl` through the current `writeGuard.mjs`; 17 hand-built adversarial URL probes against the guard; a byte-count audit of `fixtures/dataset.ndjson`.

---

## 1. Verdict table

| # | Claim (source) | Evidence located | Verdict | Reason |
|---|---|---|---|---|
| 1 | "Studio boots entirely through the proxy — **0 direct requests to Sanity**" (`gate-review.md:9`, `hybrid-validation.md:18`) | none locatable | **refuted as evidence** | An absence-of-egress claim; the proxy log can only record what *arrived*. The same doc (`hybrid-validation.md:26`) records the browser detector was blind in that same run. |
| 2 | D13 hybrid = "factory injects `apiHost` only, **wraps no methods** ⇒ no identity hazard" (`hybrid-validation.md:7`, `decisions.md:19`) | `spikeA/instrumentedClient.ts:115-134` | **refuted** | `spikeClientFactory` *always* returns `instrument(base,…)` (line 133) — a Proxy wrapping every function and re-wrapping `withConfig`/`clone` (46, 86-88). No code path exists that injects `apiHost` without wrapping. |
| 3 | "with the facade disabled a write still died at the proxy, staging byte-identical" (`gate-review.md:9`, `hybrid-validation.md:19-20`) | `proxy-log.jsonl` (403 rows), server read-back in doc | **holds** | Server-side 403 + server-side `_rev` read-back. Correct evidence class. Single instance, one endpoint. |
| 4 | "BLOCKER: proxy does not implement WebSocket upgrade" (`hybrid-validation.md:27-32`) | `proxy.mjs:575-728`, `test/proxy-ws.test.ts` (35 tests) | **stale-pessimistic** | Implemented and guarded. But see #5 — the fix is not validated end-to-end. |
| 5 | WS upgrade fix is proven | `test/proxy-ws.test.ts` header lines 10-13; `proxy-log.jsonl` | **weakened** | Entirely against a hand-rolled `node:net` mock. The production `tls.connect` branch (`proxy.mjs:637-644`) has **zero** coverage. `proxy-log.jsonl` has **0** rows with `upgrade:true`; all 38 `/socket/parity` rows are pre-fix 404s. |
| 6 | "Proxy fixed and **re-verified live** — all former escapes now 403 (`/agent/action/patch`, `DELETE /datasets/*`, `/projects/*/datasets/*/mutate`, `//data//mutate//`, `/DATA/MUTATE/`, `/data/..%2Fmutate/`)" (`spike-f report:64`) | `proxy-log.jsonl` | **unevidenced** | The repo's only server-side log holds 6 blocked rows: 4× `/data/actions/parity`, 1× `/data/mutate/parity`, 1× `/assets/images/parity`. Zero DELETE/PUT/PATCH requests of any kind. None of the seven cited shapes appears. |
| 7 | "writeGuard.mjs normalizes then classifies, **fail-closed on unrecognized non-GET requests to write-capable prefixes**" (`spike-f report:64`) | `writeGuard.mjs:11-82, 330-376` | **stale-pessimistic** | The guard is now full **default-deny** on every verb including GET/HEAD — strictly stronger than the report describes. |
| 8 | Write-guard contract is non-vacuous, covers the *class* of each gap (`spike-f report:63-65`) | `src/writeGuardContract.ts`, `test/write-guard.test.ts:49-148` | **holds — strongest artifact in the repo** | Hand-written case table independent of the implementation; pins both the old broken predicate (≥60 misclassifications) *and* a block-everything guard (must fail all ≥45 read cases); dot-segment laundering class is *generated* from the write-endpoint inventory, not enumerated. 17 independent adversarial probes found no escape. |
| 9 | Default-deny guard is safe to run | replay of `proxy-log.jsonl` through `writeGuard.mjs` | **weakened** | 4 request lines the live Studio previously completed would now 403: `POST /descriptors/claim` (3×, was HTTP 200), `POST /intake/batch`, `GET /`, `GET /favicon.ico`. Deliberate (`writeGuard.mjs:24`) but never met a live Studio. |
| 10 | Gate D "boundedness re-proven … per-plan-type candidate ceilings" (`gate-review.md:12`, `spike-c report:48`) | `test/mutation-gaps.test.ts:148-229` | **weakened** | For `slug`/`types` plans (9 of 17 queries) the "ceiling" is *every document of the type* — `mutation-gaps.test.ts:160-167` restates `planner.ts:83-86` exactly. `article-by-slug` scans all 30 articles to return 1 doc and passes. Only 3 empty-overlay anchors are independent constants. |
| 11 | Gate D correctness — 102 planner-vs-oracle checks, tombstone matrix, drafts sweep | `test/spike-c-parity.test.ts` (111 tests), `mutation-gaps.test.ts:240-330` | **holds** | Oracle (`planner.ts:137-144`) evaluates the original query over the full virtual dataset through groq-js — genuinely separate from candidate selection. 4-way tombstone sweep + drafts-perspective sweep are real breadth. |
| 12 | "13 hosted empty-overlay cases green" (`gate-review.md:12`, `spike-c report:26`) | `test/hosted-parity.test.ts:33` | **holds today / structurally fragile** | Ran live here (13/13 pass against `b1n03q3z`). But `describe.skipIf(!cfg)` means the entire leg silently vanishes with no `.env` and the suite still reports green. Nothing asserts it ran. |
| 13 | D15 "RESOLVED — `recent-by-created-at` Tier B with `preview-diverges`" (`decisions.md:22`) | `test/spike-c-parity.test.ts:90-94` | **weakened (tautology)** | The test asserts the registry literal equals itself (`registry.ts:27-31`). No overlay fixture ever changes `_createdAt`, so the divergence has never been demonstrated. |
| 14 | Registry no longer self-certifying | `mutation-gaps.test.ts:64-132` | **holds** | Tier A/B/unsupported id sets, count, uniqueness and matrix size are pinned as literals outside `registry.ts`. Real. |
| 15 | Spike F "17 blocked, 6 real gaps, 4 architectural holes" | `spikeF/attackPass.ts:818-900, 1371-1429` | **holds for the gaps / weakened for "blocked"** | The 6 gaps are corroborated by code (see #17). "Blocked" is still a browser-side negative (`attackPass.ts:844-846`); the only server-side oracle (`verifyPersistence`) queries `spike-f-canary*` documents/assets — sound for these 27 attacks (all writes target canary ids), not a general escape detector. |
| 16 | "A client-side facade is not a security boundary and cannot be made into one" (`spike-f report:56`) | `attackPass.ts:1300-1368` (attacks 25-27) | **holds** | Correct and, if anything, understated. |
| 17 | Facade gaps 18-24 still open (`spike-f report:69`) | `localEcho.ts:1023, 1246` | **holds** | `WRITE_URL_RE = /\/data\/(mutate\|actions)\b/` unchanged (gaps 20, 21); `blockFluentCommit` still `result === t ? proxy : result` (gaps 18, 19). No `agent`/`datasets`/`assets` handling anywhere in the file. |
| 18 | Spike A "no staging write is possible — PASS via facade for all Studio-originated paths" (`report.md:31`) | `localEcho.ts` + Spike F | **weakened** | `patch().clone().commit()` and `request({url:'data/mutate/x'})` are ordinary `@sanity/client` calls Studio code *could* make; "Studio-originated" is doing heavy lifting. The report's own caveat covers the fresh-client case but not these. |
| 19 | write-block-validation.md: zero writes, staging byte-identical (article-07) | `write-block-validation.md:20-25, 37-42` | **holds** | Server-side read-back: `_rev` unchanged, no `drafts.article-07`. Correct evidence class. The browser-side counters in the same table are not what carries it. |
| 20 | Track B: `/data/actions`, `/data/mutate`, `/assets` all 403 with guard on (`track-b-proxy.md:10`) | `proxy-log.jsonl` blocked rows | **holds** | All three appear as live 403 rows. The old proxy did guard `/assets` (`git show 588b82e:…/proxy.mjs:155`), so this does not contradict Spike F gap 21, which is about the *facade*. |
| 21 | Spike D compatibility matrix — 8 changes, 6 finding codes, severities pinned | `test/spike-d-schema.test.ts`, `mutation-gaps.test.ts:366-417` | **holds** | Severity invariant + reachability-of-all-six-codes assertion is a genuine class test. |
| 22 | Spike D "No base data is lost — byte-identical base snapshot asserted" (`spike-d report:36`) | `test/spike-d-schema.test.ts:14, 93-95` | **weakened** | Proves the in-memory fixture array was not mutated in-process. That is object-identity hygiene, not a data-integrity guarantee. |
| 23 | Spike D "12 tests green (145/145 suite-wide)" (`spike-d report:10`) | actual run | **stale** | 10 tests in that file; 1103 suite-wide. |
| 24 | Repository audit dataset measurements (41 docs; article 32 avg 915 B max 952 B; author 5; page 3; siteSettings 1; drafts 2) | `fixtures/dataset.ndjson` | **holds — verified exactly** | Recomputed independently; every number matches to the byte. |
| 25 | Audit "no plugins, no mutation call sites, no direct client imports" | `repository-audit.md:22` self-caveat | **holds, self-caveated** | True by construction on a greenfield repo; the doc says so itself. |
| 26 | "Suite: 602 tests, 9 files" (`gate-review.md:12`, HANDOFF:3) | actual run | **stale** | 20 files, 1103 tests. `write-guard.test.ts` alone is 357 (report says 149). `mutation-gaps` 139 and `spike-c-parity` 111 do match. |
| 27 | Gates C, F "NOT STARTED — needs Vercel" | — | **holds** | Nothing to falsify. |
| 28 | HANDOFF §4.2 "localEcho holds writes in memory only; a reload loses them" | `localEcho.ts:788-1004`, `spikeA/overlayServer.mjs`, `test/overlay-server.test.ts` (24 tests) | **stale-pessimistic** | Persistence is wired: `POST /commit` → `FsOverlayStore`, plus `/state` boot hydration. Node-side tested; browser round-trip unevidenced. |

---

## 2. Findings, by severity

### F1 (high) — Gate A's headline number is the exact detector class that has now failed four times

`hybrid-validation.md:18` reports **"Requests direct to `api.sanity.io`: 0"** and marks Gate A **PASS (conditional)** on it (`gate-review.md:9`). Eight lines later the *same document* records that `performance.getEntriesByType('resource')` reported `actionRequests: 0` while the proxy log showed a blocked POST — i.e. the detector available in that run was demonstrably blind. There is no artifact in the repo that distinguishes "0 direct requests" from "0 direct requests visible to a detector we know was blind". `proxy-log.jsonl` cannot help: a proxy log is a record of arrivals, and no arrival log can prove a non-arrival elsewhere.

This is the project's own standing rule applied to its own headline claim, and it fails.

**To close:** stop observing absence, enforce it. Run Studio with `*.api.sanity.io` blackholed (hosts file, or a DevTools/CDP request-blocking rule) while the proxy is up, and show the workflow still completes. Red first: with the proxy *down* and the blackhole up, the workflow must fail. Until then Gate A should read PARTIAL, not PASS.

### F2 (high) — the D13 topology in the evidence is not a topology the code can produce

`hybrid-validation.md:7` and `decisions.md` D13 both rest on: *"the factory injects `apiHost` only and **wraps no methods** — so none of Track A's identity-stability hazard exists."* That is the entire reason the hybrid is recommended over Track B alone.

`examples/kitchen-sink/spikeA/instrumentedClient.ts:115-134`:

```ts
export function spikeClientFactory(options: ClientConfig): SanityClient {
  const apiHost = hybridApiHost()
  if (apiHost) options = {...options, apiHost}
  ...
  const base = isEchoEnabled() ? wrapWithLocalEcho(real) : real
  return instrument(base, `client#${log?.factoryInvocations ?? 0}`)   // ← unconditional
}
```

`instrument` (line 64) proxies every function property and re-instruments `withConfig`/`clone` results (lines 46, 86-88). Setting `SPIKE_API_HOST` adds `apiHost`; it does not remove wrapping. So the validated run had full Track-A method wrapping in place, mitigated by the same `wrapperCache` memoisation Track A needed. **The claimed differentiator was never exercised.** (The write-block half of that run is unaffected — echo was off, so writes went to the proxy and died there.)

**To close:** add a factory branch that returns `createClient(options)` untouched when `SPIKE_API_HOST` is set and instrumentation is not explicitly requested, then re-run the browser validation against *that*.

### F3 (high) — the Spike F remediation's "re-verified live" has no server-side artifact

`spike-f-safety-boundary/report.md:64` claims a live smoke test in which `/assets/images/*`, `/agent/action/patch`, `DELETE /datasets/*`, `/projects/*/datasets/*/mutate`, `//data//mutate//`, `/DATA/MUTATE/` and `/data/..%2Fmutate/` all returned 403.

`examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl` — 422 lines, the repo's only server-side proxy evidence — contains **six** blocked rows in total:

```
04:52:10.362  POST /v2025-02-19/data/actions/parity   403
04:52:10.659  POST /v2025-02-19/data/mutate/parity    403
04:52:10.828  POST /v2025-02-19/assets/images/parity  403
04:55:29.556  POST /v2025-02-19/data/actions/parity   403
12:50:51.413  POST /v2025-02-19/data/actions/parity   403
14:38:59.511  POST /v2025-02-19/data/actions/parity   403
```

and **zero** DELETE, PUT or PATCH requests of any kind (method histogram: GET 256, OPTIONS 154, POST 12). None of the seven cited shapes is present. The run may have happened against a different `PROXY_LOG`; either way, by the project's own standing rule this claim is currently unevidenced, and it is the claim that Gate E remediation rests on.

**To close:** re-run the smoke with `PROXY_LOG` pointed at a committed file, and cite line numbers in the report.

### F4 (high) — default-deny is an unvalidated live behaviour change

I replayed all 88 distinct `method + path` pairs in `proxy-log.jsonl` through the current `writeGuard.mjs`. Four requests the live Studio previously completed would now be 403:

| was | now | request | occurrences |
|---|---|---|---|
| 200 | **403** | `POST /v2025-02-19/descriptors/claim` | 3 |
| 401 | **403** | `POST /v2023-12-18/intake/batch` | 1 |
| 200 | **403** | `GET /` | 1 |
| 404 | **403** | `GET /favicon.ico` | 1 |

Nothing previously blocked would now pass. `writeGuard.mjs:24` names `/descriptors/claim` explicitly as a deliberate casualty — that is a defensible policy call, and the tradeoff is documented honestly at lines 54-65. The problem is evidentiary: the only browser run showing Studio booting through the proxy (`hybrid-validation.md`) predates default-deny by a whole guard rewrite. No artifact shows Studio boots under the guard that is now in the tree.

**To close:** one browser boot with `PROXY_BLOCK_WRITES=1` under the current guard, proxy log committed. If `/descriptors/claim` turns out to be load-bearing, it becomes an allowlist entry with a log line — exactly the process the guard's header prescribes.

### F5 (high) — the WS fix is mock-only, and the tunnel it opens is unguarded past the handshake

Two separate issues.

**(a) Coverage.** `test/proxy-ws.test.ts` is 35 solid tests — RFC 6455 framing, both-direction piping, `head` pipelining, teardown on either leg, blocked-upgrade composition — but its header (lines 10-13) states everything is hand-rolled on `node:net` against a mock upstream. `proxy.mjs:637-644` branches to `tls.connect({ALPNProtocols:['http/1.1'], servername: hostname})` when the upstream is `https:` — i.e. always, in production. That branch has zero coverage. `proxy-log.jsonl` has **0** rows with `upgrade:true`, and all 38 `/socket/parity` rows are the pre-fix 404s. HANDOFF §3.3 is stale-pessimistic about the *code*, but nothing yet shows the fix works against real Sanity or unsticks a real document pane.

**(b) Scope of the guard.** `proxy.mjs:552-574` argues correctly and at length that the guard must run on the upgrade path, and it does (line 603). But it classifies the *handshake request line only*. After the 101, `clientSocket.pipe(upstreamSocket)` / `upstreamSocket.pipe(clientSocket)` (lines 667, 676) relay bytes opaquely, and `/socket` is an allowlisted read namespace (`writeGuard.mjs:144`). Nothing in the repo establishes that Sanity's `/v2022-06-30/socket/<ds>` protocol is read-only. If it accepts anything mutating, the proxy has an unguarded bidirectional tunnel on an allowlisted path — and this is precisely the "endpoint we assumed was safe by looking at it" failure mode Spike F was created to kill.

**To close:** (a) a TLS-upstream upgrade test plus one browser run with a document pane held open past 45 s, log committed; (b) either evidence that the socket protocol cannot mutate, or a frame-level ruling recorded in the guard header.

### F6 (medium-high) — Gate D boundedness is proven only for `ids` and `top-k`; for `slug`/`types` the ceiling *is* a full type scan

`mutation-gaps.test.ts:160-167`:

```ts
case 'slug':
case 'types': {
  const inBase = dataset.filter((d) => types.includes(d._type)).length
  const inOverlay = [...overlay.documents.values()].filter(...).length
  return inBase + inOverlay
}
```

`planner.ts:83-86` selects exactly that set. The ceiling therefore restates the implementation with zero slack and is **linear in dataset size**. `mutation-gaps.test.ts:208-215` goes further and pins `article-type-list` at exactly 30 of 30 articles — enshrining the full type scan as correct. Nine of the seventeen supported queries are `slug` or `types` plans, including `article-by-slug`, which scans all 30 articles to return one document and passes the ceiling comfortably.

The `top-k` ceiling (`sliceEnd + 2 * affected.size`, line 176) is likewise the planner's own `baseFetchCount = sliceEnd + affected.size` (`planner.ts:94`) with a factor of two. Only the three empty-overlay anchors (lines 199-228: `=== 1`, `=== 30`, `=== 20`) are independent constants, and one of those three is the full type scan.

This does kill mutations E2/E3/E4 as claimed — those made the planners pull the *whole 41-document dataset*, which crosses a type boundary. It does not establish §22.6's boundedness property, which is about candidate sets that do not grow with the dataset. `gate-review.md:12` reads "boundedness re-proven"; what was re-proven is "the planner does not cross type boundaries".

**To close:** either assert a constant ceiling for `ids`/`slug` plans and a sublinear one for `types` aggregates, or restate the claim honestly as type-scoped scanning and re-open §22.6. Either way it needs a 10× fixture — at 41 documents a linear bound and a constant bound are indistinguishable.

### F7 (medium) — the hosted-parity leg can silently disappear

`test/hosted-parity.test.ts:33` — `describe.skipIf(!cfg)`. `hostedConfigFromEnv()` returns `null` when `SANITY_API_READ_TOKEN` is unset (`src/hosted.ts:15`), and the 13 cases vanish with the suite still green. Gate D cites those 13 cases as evidence. They did run on this machine (13/13 passed against `b1n03q3z`), so the claim is true today — but that is a property of my `.env`, not of the suite, and CI without secrets would report exactly the same green.

**To close:** a test that fails when `cfg` is null and a CI marker env var is set.

### F8 (medium) — "17 blocked" is still browser-side for the blocked half

`spikeF/attackPass.ts:844-846`:

```ts
const reached = hits.some((hit) => !isTransportFailure(hit)) || answered
const escaped = reached || hits.length > 0 || answer.networkFailure
const blocked = !escaped
```

`blocked` is a negative over browser-side taps. The hardening is real — XHR *and* fetch, timing buffer raised to 5000 and cleared (`attackPass.ts:339-394`), plus a `bufferFullDuringRun` warning stitched into the evidence string (line 885). But `XMLHttpRequest.prototype` monkeypatching installed at run time cannot see a request from an iframe's `contentWindow`, a Worker, `navigator.sendBeacon`, or any code holding a pre-tap method reference.

The one server-side oracle, `verifyPersistence` (line 1371), queries only `*[_id match "spike-f-canary*"]` plus assets by `originalFilename`. That is *sufficient for these 27 attacks* — I checked every `canaryIds`/`run` pair and all writes target canary ids — but it is not a general escape detector, and the "17 blocked" figure should not be reused as though it were server-verified.

**To close:** run the attack pass with the Track B proxy in front and diff the proxy log against the suite's verdicts. Two independent detectors, one of them server-side.

### F9 (medium) — Spike D's "no base data is lost" measures the wrong thing

`test/spike-d-schema.test.ts:14` snapshots `JSON.stringify(docs)` at module load; line 94 re-compares at the end of the file. That catches a scanner or migration that mutates its input array in place — worth having — but §36.4's criterion "no base data is lost" is about base *data*. The report (`spike-d report:36`) presents the in-process sentinel as satisfying the criterion. Weakened, not refuted; the report should say which of the two it proved.

### F10 (medium) — D15's evidence is a tautology

`test/spike-c-parity.test.ts:90-94` asserts `byId('recent-by-created-at').status === 'tier-b'` and `.systemTimestampPolicy === 'preview-diverges'` — i.e. that `registry.ts:27-31` contains the literals it contains. No overlay fixture in `spike-c/overlay.ts` ever modifies `_createdAt` or `_updatedAt`, so the `preview-diverges` behaviour has never been exercised. `decisions.md:22` marks D15 **RESOLVED**; the spike report's own caveat 3 defers the promotion-order regression test to Phase 6. The two are inconsistent — D15 should read "policy recorded; behaviour unverified until Phase 6".

> **Note added 2026-08-05** ([PRD §0.0 scope amendment](../../../PRD-v1.md#00-scope-amendment--2026-08-05--this-system-never-writes-to-sanity)): the observation above is unchanged and still correct. Promotion has since gone out of scope permanently, so the deferred test cannot be a promotion-order test; the inconsistency it identifies in D15 remains open on its own terms.

### F11 (low-medium) — facade gaps 18-24: claim verified, still open

For the record, since Gate E's remediation list depends on it. `localEcho.ts:1023` is still `const WRITE_URL_RE = /\/data\/(mutate|actions)\b/` — gap 20 (no leading slash) and gap 21 (`/assets/*`) untouched. `localEcho.ts:1246` is still `return result === t ? proxy : result` inside `blockFluentCommit` — the precise root cause of gaps 18 and 19. No mention of `agent`, `datasets`, `releases` or `assets` anywhere in the file's interception layer (`WRITE_METHODS`, line 1012, is seven method names). The Spike F follow-up checklist is accurate and current.

### F12 (low) — counts are stale everywhere

`gate-review.md:12` and HANDOFF say 602 tests / 9 files; actual is **1103 / 20**. `spike-f report:63` says the write-guard contract is 149 tests; `write-guard.test.ts` now reports **357**. `spike-d report:10` says 12 tests / 145 suite-wide; actual **10 / 1103**. `spike-c report:30` says 135/135. Counts that match: `mutation-gaps` 139, `spike-c-parity` 111 (102 matrix + 9 behavioural).

### F13 (low) — the gate review no longer describes the repository

Landed since these docs were written, with no evidence document and no gate coverage: `core/src/{merge,references,validation,perspectives,conflicts}` (~9 files, 254 tests across `core-w3-*`/`core-w4-*`), `spikeA/overlayServer.mjs` + `overlayTranslate.ts` (~960 lines, 24 tests), and the `localEcho` → overlay-server persistence path (`localEcho.ts:788-1004`). `gate-review.md:29`'s "engineering breadth (no blocker)" list and HANDOFF §4 both predate all of it. HANDOFF §4.2 ("wire FsOverlayStore into the facade") is done.

Note: the overlay server binds `127.0.0.1` (`overlayServer.mjs:215`) and CORS-restricts to `http://localhost:3333` (216-217, 355-358), so it is not a staging-write surface. It is still a new unclaimed network surface, and the browser half of the persistence round-trip (edit → file on disk → reload → edit survives) has no artifact.

---

## 3. Claims I could not check

| Claim | Why not |
|---|---|
| Every browser-observed figure: `__SPIKE_A__.calls = 548 (stable)`, "5 synthetic events, all delivered", "Publish button becomes enabled", "save state settles", "6+ requests via proxy", "document pane rendered" | No browser access from this agent. These are exactly the claims the standing rule distrusts; several of them have no server-side counterpart at all. |
| Whether Studio still boots under the current default-deny guard | Requires a live Studio + proxy run (F4). |
| Whether `/descriptors/claim` is load-bearing for Studio | Undocumented Sanity endpoint; only a live run answers it. |
| Whether Sanity's `/socket` WS protocol can carry a mutation | Requires either Sanity documentation I do not have or a live probe (F5b). |
| The ~40k-call resubscribe storm (`report.md:10`, the basis of the identity-stability design rule) | Historical browser observation, no artifact. The mitigation is visible in code (`instrumentedClient.ts:54-55`, `localEcho.ts:1219`) but the failure it prevents is not reproducible from the repo. |
| `listener-event-shapes.md` payloads and stream inventory | Captured live; no recorded tee in the repo. The overlay code depends on them heavily (`localEcho.ts:14-53`), so a captured-fixture file would be worth more than the prose. |
| That the Spike D schema artifact really came from `sanity schema extract --enforce-required-fields` | `spike-d/artifact.ts` loads a committed file; I did not re-run the CLI. |
| Spike C representative-scale latency | Correctly marked OPEN by the report. |
| Gates C and F | Not started. |
| Whether the 3 Spike F canaries were actually cleaned from `parity` | Requires a live dataset query. |

---

## 4. Highest-value red tests to write next

Ordered by how much of a live gate claim each one converts from assertion to evidence.

1. **Egress-denial harness (Gate A, F1).** Blackhole `*.api.sanity.io` at the hosts/CDP layer, boot Studio through the proxy, complete the edit workflow. Red first: with the proxy *stopped* and the blackhole up, the workflow must fail. This is the only test that can retire the "0 direct requests" claim.
2. **Live-guard replay (F4).** Assert that every non-blocked line in `proxy-log.jsonl` is still classified a read by the current guard, with the deliberate exceptions pinned as an explicit named list. Red today: 4 rows. Cheap, pure, and it turns the default-deny tradeoff into a reviewable diff.
3. **TLS upgrade test (F5a).** `proxy-ws.test.ts` against a `tls`/`https` mock upstream with ALPN `http/1.1`. `proxy.mjs:637-644` currently has zero coverage and it is the branch production uses.
4. **Zero-wrapping factory mode (F2).** Red test: with `SPIKE_API_HOST` set and instrumentation off, `spikeClientFactory(cfg) === createClient(cfg)`-shaped — no Proxy, `client.fetch === client.fetch`. Then re-run the browser hybrid validation against that mode.
5. **Sublinear boundedness at 10× scale (F6).** Same `planUpperBound` sweep against a 300-article fixture, with `ids`/`slug` plans asserted against a *constant*. `article-by-slug` should go red at 30 → 300.
6. **Facade gap class tests (F11).** Per the project's own rule, before any fix: `patch().clone().commit()`, `transaction().clone().commit()`, `request({url:'data/mutate/x'})` (and every normalisation variant), `assets.upload`, `agent.action.{patch,generate,transform,translate,prompt}`, `datasets.delete`, `releases`, `live`. The cleanest route is to make `localEcho`'s predicate *be* `writeGuard.isWriteRequest` and run `runWriteGuardContract` against it — one import turns 357 existing tests into facade coverage.
7. **Hosted-leg non-vacuity (F7).** Fail when `SANITY_API_READ_TOKEN` is absent and a CI marker is set.
8. **`_createdAt` divergence fixture (F10).** An overlay that rewrites `_createdAt`, asserting the documented `preview-diverges` ordering. Converts D15 from a literal-equals-literal check into a behavioural one.
9. **Attack-pass × proxy cross-check (F8).** Run `attackPass.ts` with the proxy in front and diff the proxy log against the suite's per-attack verdicts. Any disagreement is a detector bug in one of them — which is the point.

---

## 5. What survived

Said plainly, because a review that only finds fault is as useless as one that finds none.

- **`writeGuard.mjs` + `writeGuardContract.ts` are the strongest artifacts in this repository.** The default-deny inversion is the correct response to Spike F's lesson, the header documents its own tradeoffs including the ones that hurt (lines 54-65, 76-82), and the contract is a hand-written case table genuinely independent of the implementation. The two non-vacuity guards (`write-guard.test.ts:49-68`) pin the suite from both directions — a guard that is too weak *and* a guard that blocks everything both fail it. The dot-segment laundering class is generated from the write-endpoint inventory rather than enumerated, which is how you cover a class rather than an instance. I threw 17 adversarial spellings at it — percent-encoded separators, double-encoding, overlong `%C0%AF`, `;`-parameter plus `..`, GET probes at write endpoints, no-leading-slash asset upload, `PUT /users/me/keyvalue` — and found no escape.
- **Running the guard on the `upgrade` path** (`proxy.mjs:552-603`) is a class of bug most proxies ship with. The reasoning recorded there is correct and the earlier "it's just a GET on a read-only channel" argument is explicitly retracted in place.
- **Spike C's correctness half is real.** The oracle is structurally separate from candidate selection, the 4-way tombstone sweep and the drafts-perspective sweep are genuine breadth, and the registry-inventory pinning closes the self-certification hole properly.
- **The two claims that are backed server-side** — `write-block-validation.md`'s `_rev` read-back and the hybrid run's 403 with staging unchanged — are the right evidence class and they hold.
- **`repository-audit.md`'s dataset measurements are exact.** Every byte figure reproduced independently.
- **Gate E's own conclusion is correct.** "A client-side facade is not a security boundary and cannot be made into one" is the right call, reached the hard way, and the report does not soften it.

The pattern in the failures above is consistent and worth naming: **this project's server-side artifacts hold up under attack, and its browser-side ones do not.** Three of the five high-severity findings (F1, F3, F4) are the same defect — a claim that would be trivially evidenced by a committed proxy log, asserted instead from a transient observation. The standing rule is right; it is not yet being applied to the gate table itself.
