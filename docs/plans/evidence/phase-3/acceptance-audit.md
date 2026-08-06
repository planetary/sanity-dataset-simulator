# Phase 3 acceptance audit — `[M-LOCAL]` (PRD §38.1) and roadmap Phase 5 exit

**Date:** 2026-08-06 · **Auditor:** read-only agent (no source, test or existing doc modified; this file is the only write)
**Scope:** PRD [§38.1](../../../PRD-v1.md) `[M-LOCAL]` acceptance, owned by roadmap Phase 3; roadmap Phase 5 exit (PRD §37 Phase 4)
**Read:** PRD §0.0, §0.3, §0.6, §10, §11, §14, §21, §22, §35.12–§35.13, §37, §38.1 · [roadmap](../../README.md) · [gate-review](../phase-1/gate-review.md) · [live-validation-2026-08-04](../phase-1/live-validation-2026-08-04.md) · [evidence-review-2026-08-04](../phase-1/evidence-review-2026-08-04.md) · [phase-2/acceptance-audit](../phase-2/acceptance-audit.md) · [HANDOFF](../../HANDOFF.md) · [MORNING-2026-08-05](../../MORNING-2026-08-05.md)

> **The tree was moving while this was written.** Three agents were editing
> `packages/sanity-overlay-{query,store-fs,cli,studio}/**` and
> `examples/kitchen-sink/spikeA/**` concurrently. Everything below describes the
> working tree as read on **2026-08-06, 12:55–13:40 local**, at git `3587f67`
> plus whatever was uncommitted at that moment. Every file:line citation should
> be re-checked before it is acted on. The suite was run once, read-only:
> **89 files / 6558 tests, all green, 22.6 s.**

---

## 1. Headline verdict

**`[M-LOCAL]` cannot be signed.** Not because the work is thin — most of it is
built and a good deal of it is proven harder than the PRD asks — but because
four things stand between the code and the acceptance list, and two of them are
structural rather than incremental.

**The shortest list of what blocks it:**

1. **The Phase 1 gate constraint still binds, unchanged.** PRD §0.3's preamble —
   "the project does not enter full implementation until all six gates pass" —
   and roadmap [§5.1](../../README.md) ("Phase 1 blocks all implementation")
   are the same rule that stopped [Phase 2 being signed](../phase-2/acceptance-audit.md).
   [gate-review.md](../phase-1/gate-review.md) is still the current record:
   **A, B, D conditional pass; E partial; C and F not started**, and §0.6's
   *one human validation of the actual Studio workflow* is **outstanding for
   every gate**. Nothing since 2026-08-04 has changed that; the file has not been
   touched since. So `[M-LOCAL]` is blocked for the same reason Phase 2 was,
   plus one that has grown: Gate E's deployed half and Gates C and F all wait on
   the same Vercel unblock. **This is a user-owned blocker, not an engineering one.**
2. **The local API — the thing that turns a Studio write into a canonical file —
   is spike code.** `examples/kitchen-sink/spikeA/overlayServer.mjs` (its own
   header line 1: `// SPIKE A`) and `examples/kitchen-sink/spikeB-proxy/origin.mjs`
   are the only implementations of `/commit`, `/state`, `/resolve`, `/query`.
   The shipped Studio package points at the first of them by default
   (`packages/sanity-overlay-studio/src/options.ts:57`, `http://localhost:3998`).
   PRD §37 Phase 2 places the local API inside the product; §0.6 declares spike
   code disposable and forbids promoting it without a test-first rewrite. Every
   acceptance line that requires a byte to reach disk currently runs through
   software the project has itself labelled throwaway.
3. **No package can be installed.** Every package cross-imports its siblings by
   relative filesystem path that escapes its own root — 54 such specifiers, e.g.
   `packages/sanity-overlay-studio/src/client/transport.ts:21` →
   `../../../sanity-overlay-client/src/stagingHost`. The test whose title is
   *"the package can actually be installed and resolved"* skips relative
   specifiers by construction (`test/studio-install.test.ts:99`). So
   [MORNING §1](../../MORNING-2026-08-05.md)'s "change `defineConfig` →
   `defineOverlayConfig`, done" is not reachable from a registry install, and
   §38.1 line 8 ("Studio writes canonical files") is true only for a Studio that
   lives inside this monorepo.
4. **The product path has never been evidenced against a live staging base.**
   The two canonical files on disk name their writers:
   `examples/kitchen-sink/.sanity-overlay/manifest.json` records
   `spike-a-studio` ("Studio (spike A local echo)") and `local-dev`
   ("Local Dev (Mode 2 origin)"). Neither is `sanity-overlay-studio`. The one
   committed product-plugin session log
   (`spikeB-proxy/proxy-log-plugin-session-2026-08-05.jsonl`, 177 rows) contains
   **zero** write attempts. The intersection *product plugin × live base × a
   write landing on disk* has no artifact anywhere in the repository.

Two smaller blockers finish the list: **line 1 is not implemented as written**
(the read client reads `SANITY_OVERLAY_MODE`, not PRD §11.2's `OVERLAY_MODE`),
and **line 9 has never been observed through git** (`.gitignore:10` ignores
`.sanity-overlay/` repo-wide; nothing under it is tracked; no test invokes git).

**Counts: 6 met · 3 partially met · 1 not met.** The "met" verdicts are
honest at the layers that exist and their tests could have failed; they carry
the systemic caveat in §1 item 4 rather than being downgraded for it. Where the
caveat *is* the defect — line 8 — the row is graded down.

---

## 2. The ten acceptance lines

Verdict key: **MET** · **PARTIAL** · **NOT MET**.
"Could it have failed?" asks whether the cited artifact is capable of going red
for a real regression, or merely restates what the implementation already did.

| # | §38.1 line | Verdict | Evidence | Could it have failed? |
|---|---|---|---|---|
| 1 | `OVERLAY_MODE=fs` works with live staging base | **NOT MET** | No artifact. `packages/sanity-overlay-client/src/env.ts:27` reads `SANITY_OVERLAY_MODE`; PRD §11.2 specifies `OVERLAY_MODE`. `createHttpBaseSource` (`src/base.ts:60`) is the only live-base adapter and its only test drives a `node:http` stub on loopback (`test/client-http-base.test.ts:44-60`). `test/hosted-parity.test.ts` does reach the live dataset but through its own `fetch` helper (`src/hosted.ts:24`) and compares groq-js against fixtures — the overlay client is not in that path. | **n/a — there is nothing to falsify.** The mode/root plumbing is tested (`test/client-modes.test.ts:384-406`) but only under the package's own spelling, so it cannot fail on the PRD's. |
| 2 | Existing document can be edited | **MET** (Node-level; not live on the product path) | Core: `core-w2.test.ts:679` (§35.5 case 1). Facade: `studio-facade.test.ts:209-262` — `mutate`, `dataRequest(mutate)`, `request('data/mutate/…')` never reach the real client. Disk: `overlay-server.test.ts:430` writes the intercepted edit to `documents/<id>/intent.json`; `:519` reads it back from a **restarted** server. Read-back: `client-modes.test.ts:121`. Live: [live-validation §2](../phase-1/live-validation-2026-08-04.md) — disk + upstream `_rev` unchanged, **on the spike stack**. | **Yes.** Branch and base titles are deliberately different literals; the disk assertions read a restarted process. Historically proven: the em-dash byte/char defect made exactly this class red after 2048 tests had missed it. |
| 3 | New document can be created | **MET** (same caveat) | `core-w2.test.ts:161`; facade `create`/`createOrReplace`/`createIfNotExists` intercepted (`studio-facade.test.ts:210-219`); `client-modes.test.ts:134` "includes a branch-created document that no base fetch could select"; `local-site-routes.test.ts:157`; live artifact `examples/kitchen-sink/.sanity-overlay/documents/origin-proof-1/intent.json` — **but that was Mode 2, which has no base at all.** | **Yes** for the read assertions (a branch-created row cannot come from base by construction). **No** for "with a live staging base" — Mode 2 removes the base, so it cannot fail on base interaction. |
| 4 | Draft and branch publish work | **PARTIAL** | Core: `core-w2.test.ts:717,737,769,781` (§35.5 cases 3–5). Protocol: `action-echo.test.ts:314-394` (the two §18.5 frames, in order, chained off each document's own previous revision). Disk: `action-echo.test.ts:618` publish, `:648` unpublish, `:680` discard — read back off the filesystem or a restarted server, and routed through core's own reducers, not reimplemented. **Missing:** no browser evidence on the product path. [write-block-validation.md](../phase-1/spike-a-studio-interception/write-block-validation.md) recorded the publish button going dead (`handled: false`); the fix has Node evidence only. §21.4.1 criterion 2's input-device half remains unmeasured ([gate-review](../phase-1/gate-review.md) row B). | **Yes** at the Node layer — `action-echo.test.ts:617` asserts persistence claims are read from disk or a restarted server, "never from the response body of the write that made the claim". The browser half has no test that could fail because it has no test. |
| 5 | Delete uses tombstone | **MET** | `core-w2.test.ts:297,805` (both tombstones set, record survives); `action-echo.test.ts:712`; `client-modes.test.ts:143` omits the tombstoned document rather than serving its stale base row; `local-site-routes.test.ts:167,174` (list drop **and** 404, not a stale render); `studio-reads-facade.test.ts:221` with staging as the negative control. | **Yes.** Every assertion has staging holding the document as the control, so a tombstone that failed to suppress would show the base row and go red. |
| 6 | Basic reference dereference works | **MET** | Registry: `article-with-author`, `article-by-slug-with-author`, `page-featured-refs` (`mLocalRegistry.ts:85,184,99`). Parity against a whole-dataset oracle written out longhand (`query-parity.test.ts`, header lines 8-13). Live oracle: `hosted-parity.test.ts` case "reference dereference" vs the real Content Lake. Client: `client-modes.test.ts:169`. Site: `local-site-routes.test.ts:187`. Core: §35.6 cases 1-4 (`core-w4-references.test.ts:384-442`). | **Yes**, and with the best oracle in the repo for this line — the hosted leg compares against Sanity itself. **But** see F-8: that leg is `describe.skipIf` and vanishes silently in CI. Studio-side reference *search/picker* has no coverage. |
| 7 | Registered ID and slug queries work | **MET** for the `[M-LOCAL]` slice as PRD §37 Phase 2 defines it | `mLocalRegistry.ts` (14 supported entries + one Tier C registered so the refusal is executable, `:330`), pinned SHA-256 checksums as literals so an edited query fails at construction. Parity: `query-parity.test.ts`. Boundedness: `query-boundedness.test.ts` — ceilings derived from the query text and fixture data only, base source wrapped in the file's own recorder, a **10× fixture** (`:794`), and deliberately unbounded/type-scanning mutants required to break the ceilings (`:907-976`). Consumers: `sanity-overlay-client` and `sanity-overlay-cli/src/commands/query.ts:106`. | **Yes — the strongest query evidence in the project.** It closes evidence-review F6 outright: the previous ceiling restated the planner; this one is read off the query, and the non-vacuity mutants prove it can catch over-fetching, which parity mathematically cannot. **Caveat, not a downgrade:** the *Studio* does not use this registry at all — see F-6. |
| 8 | Studio writes canonical files | **PARTIAL** | The write reaches disk (`overlay-server.test.ts:430`, `action-echo.test.ts:617-830`) and the file is canonical (`store-fs.test.ts` §14.1/§14.3 blocks). But the seam is: product facade → `createOverlayTransport` (tested against an injected `fetch` stub) → **spike server** → `FsOverlayStore`. No test composes the shipped `unstable_clientFactory` with a real server. And the package that owns the Studio half cannot be installed (F-1). | **Partly.** The disk half is genuinely falsifiable. The transport half asserts against a stub `fetch` the test supplies; the product-to-server composition has no test at any level, so nothing in that seam can go red. |
| 9 | Git diff is deterministic | **PARTIAL** | Bytes: `core-serializer-golden.test.ts` — the expected text was **derived by hand from the §14.3 rules, not captured from a run**, and hashed; `.gitattributes` pins `eol=lf`; the CI matrix (ubuntu + macos × Node 22.22.2/24) runs it. Cross-tree: `store-fs.test.ts` builds the same logical state in two independent working trees from shuffled key order and asserts byte equality. Churn: `store-fs.test.ts` "Git diff contains semantic intent changes…" asserts only `documents/<id>/intent.json` and `manifest.json` move and that intent carries no `_rev`. **But** `.gitignore:10` ignores `.sanity-overlay/` repo-wide and `git ls-files` on the example overlay returns nothing; the "git diff" test walks the directory by hand and skips `.runtime` itself; and both determinism tests inject a fixed clock while the real `manifest.json` carries `createdAt`, `updatedAt` and `transactionHead`. | **The byte-level half: yes** — a hand-derived golden is the right oracle and cross-checkout drift would break it. **The git-level half: no** — git is never invoked, so nothing here could fail on a real diff, and under a real clock the manifest would churn on every write for identical logical content. |
| 10 | Staging cannot be mutated | **MET — the best-evidenced line in the project** | Four independent layers. (a) Host guard: `sanity-overlay-client/src/stagingHost.ts`, wired into the base source (`base.ts:69`), the Studio transport (`transport.ts:119` — refuses at *construction*, because a commit-time refusal would render as "saved") and the facade (`facade.ts:40`). (b) Suite-wide enforcement: `testkit/vitest.setup.ts` → `src/outboundMonitor.ts`, patching `http/https .request` **and** `.get` (Node's `get` does not route through the exported `request`) plus `fetch`; deliberately keeps its own broader predicate so one bug cannot blind guard and oracle together. (c) Facade write planes derived from the **real** `@sanity/client@7.26.0` prototypes (`studio/src/client/writeGuard.ts:163`, `test/spike-a-facade-gaps.test.ts:633`), so an upgrade that adds a method goes red. (d) Proxy: default-deny `writeGuard.mjs` + `writeGuardContract.ts`, live-403 evidence with liveness and freshness controls ([live-validation §3](../phase-1/live-validation-2026-08-04.md)) and server-side `_rev` read-back. | **Yes, provably.** `write-guard.test.ts:49-68` pins the suite from **both** directions — a guard that is too weak *and* a block-everything guard both fail it. `no-staging-writes.test.ts:259` keeps a degenerate method-only implementation as a control and requires it to miss the corpus. `studio-facade.test.ts:507` keeps `naivelyWrap` as a negative control reproducing the historical 40 000-call storm. Caveats that do not move the verdict: Gate A's "0 direct requests" is **withdrawn** (4 direct telemetry POSTs); §11.3's hard guards are mostly unbuilt (F-9); the proxy is spike code. |

---

## 3. Roadmap Phase 5 exit (PRD §37 Phase 4, Studio core parity)

Its stated exit is three lines. **None of the three is discharged**, though the
underlying *task list* is largely built — facade, document actions, hosted-feature
disabling, and now an overlay-aware read path all exist and are well tested. It
is the exit **evidence**, not the work, that is missing.

### 3.1 "Full Studio E2E suite passes" — **NOT MET**

**There is no browser E2E suite of any kind.** No `playwright.config.*`, no
`*.spec.ts`, no `e2e/` directory anywhere in the repository. `.playwright-mcp/`
holds three ad-hoc MCP session logs from 2026-08-03 and is not a suite.

What an E2E suite would mean here is not a matter of opinion — the PRD writes it
out twice:

- **§35.12 Studio integration tests**, 25 items "run against the pinned Studio
  build", including *"Add, reorder, edit, and remove keyed array item"*,
  *"Validation marker appears"*, *"Save indicator resolves"*, *"Conflict badge
  and panel work"*, and — decisively — *"Active scalar and Portable Text fields
  remain client-authoritative without cursor jumps or lost keystrokes"*.
- **§35.13 Browser E2E scenarios A–F**, six end-to-end narratives.

What exists instead is 6558 Node tests plus two agent-driven browser sessions
recorded in prose. That is not a substitute, and the project already knows why:
the §35.12 keystroke line is a DOM property, and [gate-review](../phase-1/gate-review.md)
row B concedes it as "criterion 2's input-device half … inherently a browser
property and was not measured by scripted `input` events". Of the §35.13
scenarios, **A** needs a checkpoint plus a Git assertion (blocked by F-5), **B**,
**C** and **D** need staging to be mutated *underneath* the overlay between steps
— entirely legal under §0.0, since the base is read-only to us and someone else
moves it — and have never been run; **D** step 6 is void under §0.0; **F** is
Blob and waits on Gate C.

Some §35.12 items *are* discharged at the unit layer against real library
oracles — the listener matrix (`listener-matrix.test.ts`, four of five §21.4.1
criteria), hosted-feature removal (`studio-features.test.ts`), the observable
return-type contract read off a real `@sanity/client` prototype
(`studio-observable-contract.test.ts`, written because a `{subscribe}` double
agreed with the facade and both disagreed with rxjs). Those are worth counting.
They do not make the line true.

### 3.2 "Network audit shows no staging writes" — **PARTIAL**

The evidence class is right — server-side proxy logs — and it holds for the
shapes it contains. Three things stop it discharging the line:

1. **The headline is withdrawn.** [live-validation §1.3](../phase-1/live-validation-2026-08-04.md):
   CDP capture recorded **4 × `POST https://api.sanity.io/vX/intake/feedback`**
   going direct. Telemetry, not content — but "no staging writes" and
   "interception is total" are different claims and only the first survives.
2. **The one product-plugin log audits reads only.** I counted
   `proxy-log-plugin-session-2026-08-05.jsonl`: 177 rows, methods GET/OPTIONS
   plus a single blocked `POST /intake/batch`. No `/data/mutate`, no
   `/data/actions`, no `/assets`.
3. **In plugin mode the proxy is structurally blind to the write path.** The
   facade sends writes to the overlay API at `:3998`; they never traverse the
   proxy at all. So the proxy log cannot audit them even in principle, and no
   other server-side artifact does.

The suite-wide outbound monitor is genuine enforcement and genuinely strong —
but it audits the **test process**, not a running Studio.

### 3.3 "Upgrade compatibility baseline recorded" — **PARTIAL / NOT RECORDED**

A *live* baseline exists and is better than most projects manage:
`listener-matrix.test.ts:40` pins `{sanity: '6.8.0', client: '7.26.0'}`;
`spike-a-facade-gaps.test.ts:633` derives the namespace policy from the installed
client's own prototypes so an upgrade that adds a method turns the suite red;
`proxy-log-replay.test.ts` justifies each allow/deny from named lines of
`sanity@6.8.0` / `@sanity/client@7.26.0` source.

Two things stop it counting as *recorded*:

- **No artifact.** PRD §21.12 asks for an upgrade policy; `docs/plans/evidence/`
  has `phase-1/` and `phase-2/` and nothing else. There is no baseline document,
  no supported-version matrix, no upgrade runbook.
- **The manifest contradicts the pins.** `packages/sanity-overlay-studio/package.json`
  declares peers `"sanity": "^6.8.0"` and `"@sanity/client": "^7.25.0"`. A
  consumer on `sanity@6.9.0` satisfies that range and silently invalidates every
  "read off the library" oracle, with nothing going red. PRD §10.1 is a `[MUST]`:
  *"Studio package pins compatible Sanity versions."*

---

## 4. Adversarial findings, by severity

### F-1 (CRITICAL) — No package is installable; the test that should catch it skips the whole class

Every package reaches into its siblings by relative path **above its own root**.
54 such specifiers. Studio alone:

```
packages/sanity-overlay-studio/src/client/transport.ts:21   ../../../sanity-overlay-client/src/stagingHost
packages/sanity-overlay-studio/src/client/facade.ts:40      ../../../sanity-overlay-client/src/stagingHost
packages/sanity-overlay-studio/src/client/readPlan.ts:44-59 ../../../sanity-overlay-query/src/{baseSource,evaluate,overlaySource,planner,registry,types}
packages/sanity-overlay-studio/src/client/reads.ts:57-59    ../../../sanity-overlay-query/src/{baseSource,overlaySource,types}
packages/sanity-overlay-studio/src/client/readSource.ts:26-28  (same three)
packages/sanity-overlay-studio/src/conflicts.ts             ../../sanity-overlay-core/src/index
```

Under pnpm's default isolated linker a consumer's
`node_modules/sanity-overlay-studio/src/client/transport.ts` resolves `../../../`
to a directory that has no `sanity-overlay-client` in it. `ERR_MODULE_NOT_FOUND`
at Studio boot — precisely the defect
[MORNING §4](../../MORNING-2026-08-05.md) says was found and fixed for
`@sanity/client`, in the same file, one layer down.

The oracle cannot see it. `test/studio-install.test.ts:99`:

```ts
if (specifier.startsWith('.') || specifier.startsWith('/')) continue
```

and `test/repo-manifests.test.ts:20-23` documents the skip as deliberate
("packages are consumed from source, not from a build output. Relative
specifiers are therefore not dependencies and are skipped, not flagged").

That is a defensible *policy* — but then two claims have to go with it:
`studio-install.test.ts`'s own `describe` title, *"the package can actually be
installed and resolved"*, is an over-claim (it proves the bare-specifier half),
and [MORNING §1](../../MORNING-2026-08-05.md)'s "change `defineConfig` →
`defineOverlayConfig`, run the overlay API, done" describes something a consumer
cannot do. `examples/kitchen-sink/sanity.config.ts:36` confirms the shape of the
problem: it imports `../../packages/sanity-overlay-studio/src/config` — the
**internal** module — and hand-injects `createClient` and `layout`, so the
package entry point (`src/index.ts`, the only file that touches the peers) is
never exercised by anything, in-repo or out.

### F-2 (HIGH) — The local API is spike code, and the product points at it

`examples/kitchen-sink/spikeA/overlayServer.mjs` (36 KB; header line 1
`// SPIKE A — the overlay persistence server`) and
`examples/kitchen-sink/spikeB-proxy/origin.mjs` (64 KB) are the only
implementations of `/commit`, `/state`, `/resolve`, `/query`. The shipped Studio
defaults to the first (`options.ts:57`). PRD §37 Phase 2 lists document,
mutation, actions and status endpoints plus a local event bridge as *product*
tasks; PRD §0.6 says spike code "is disposable and must never be promoted into
`packages/` without being rewritten test-first". Nobody has promoted it — it is
simply being used in place of the thing that was supposed to replace it.

Both files are well written and well tested (`overlay-server.test.ts` is 1400+
lines and its persistence assertions read from restarted processes). That is not
the point: `[M-LOCAL]` line 8 says *Studio writes canonical files*, and the
component that performs the write is not in the product.

Related: `origin.mjs` fabricates a `local-dev` identity with full grants and
answers `/acl` with `filter: "true"`. It is honest about this, and
`originSafety.mjs` refuses any non-loopback bind with no override. Recorded, not
scored.

### F-3 (HIGH) — Three env-var vocabularies, and the mismatch fails open

| PRD §11.2 | read client | Studio | example site | testkit |
|---|---|---|---|---|
| `OVERLAY_MODE` | `SANITY_OVERLAY_MODE` (`env.ts:27`) | both, browser-visible wins (`options.ts:67`) | `SANITY_OVERLAY_MODE` | — |
| `OVERLAY_ROOT_DIR` | `SANITY_OVERLAY_ROOT` (`env.ts:47`) | — | same | — |
| `SANITY_BASE_DATASET` | — | — | `SANITY_DATASET` (`local-site/src/createClient.ts:45`) | `SANITY_BASE_DATASET` (`src/hosted.ts:14`) |
| `SANITY_API_READ_TOKEN` | — | — | `SANITY_READ_TOKEN` | `SANITY_API_READ_TOKEN` |

The Studio's dual reading is documented and correct (Vite exposes only
`SANITY_STUDIO_*`). The others are not. Two concrete consequences:

- A consumer who follows PRD §11.2 and sets `OVERLAY_MODE=fs` gets
  `mode: 'off'` — `env.ts:27` defaults to `'off'` for an absent key and only
  throws for an *unrecognised value*, so the misspelling is silent.
- A consumer who sets `SANITY_PROJECT_ID` + `SANITY_BASE_DATASET` for the example
  site gets the **committed NDJSON fixture** served as if it were staging, because
  `createClient.ts:45` looks for `SANITY_DATASET`.

`env.ts:8-10`'s own docstring: *"Nothing here silently falls back… a client that
quietly served staging content because a variable was misspelled is the bug this
whole package exists to fix."* Both cases above are that bug, one level up.

### F-4 (HIGH) — The product path has no live-base artifact

`examples/kitchen-sink/.sanity-overlay/manifest.json` names its writers:
`documentHeads["article-01"].updatedBy` = `spike-a-studio`
("Studio (spike A local echo)"), `documentHeads["origin-proof-1"].updatedBy` =
`local-dev` ("Local Dev (Mode 2 origin)"). So the live evidence chain is:

- **spike echo × live base** — [live-validation §2](../phase-1/live-validation-2026-08-04.md),
  the strongest live evidence in the project (disk value, upstream `_rev`
  unchanged, no `drafts.` document created);
- **product plugin × no base at all** — Mode 2, `origin-proof-1`;
- **product plugin × live base** — reads only. 177 rows, zero writes.

Since Mode 2 removes the base entirely (`origin.mjs` header: "there is no Sanity
project, no account, no upstream and no base dataset"), it cannot evidence any
line containing the words *live staging base*.

### F-5 (HIGH) — "Git diff is deterministic" is asserted without git

`.gitignore:10` is `.sanity-overlay/`, repo-wide.
`git ls-files examples/kitchen-sink/.sanity-overlay` returns nothing. The
canonical review surface — PRD §0.2 "local overlay files are immediately visible
in Git", §14.2 "the file an agent edits and a reviewer reads" — is invisible to
git in the only repository where the workflow has ever run.

No test invokes `git diff` or `git status` against an overlay tree.
`store-fs.test.ts`'s "Git diff contains semantic intent changes…" hand-rolls
`trackedFiles()` and skips `.runtime` itself, so it models the diff rather than
observing it. And both determinism tests inject `FIXED_NOW`, while the real
`manifest.json` carries `createdAt`, `updatedAt` and `transactionHead` — under a
real clock the manifest moves on every write regardless of whether the logical
content changed.

The byte-level determinism work is genuinely good (hand-derived golden,
cross-tree byte equality, `.gitattributes` `eol=lf`, CI matrix). It just is not
the claim the line makes.

### F-6 (MEDIUM-HIGH) — The Studio does not use the registry, and its registration certifies itself

`packages/sanity-overlay-studio/src/client/readPlan.ts:690-696`:

```ts
const checksum = queryTextChecksum(query)
definition = defineOverlayQuery({
  id: `studio:${checksum.slice(0, 16)}`,
  query,
  queryChecksum: checksum,
```

The checksum is computed from the same text it is then checked against, so
§22.5's "editing a query without refreshing its checksum fails at registry
construction" — real and load-bearing for `mLocalRegistry.ts` — is a tautology on
this path. `M_LOCAL_QUERIES` is never imported by the Studio package at all.

The consequence that matters: there are now **two planners**
(`sanity-overlay-query/src/planner.ts` for the registry path,
`studio/src/client/readPlan.ts` for the derived path) and only the first is
covered by `query-boundedness.test.ts`'s 10× fixture and unbounded-mutant sweep.
The planner a real Studio actually runs is the uncovered one. `[M-LOCAL]` line 7
is met for the frontend client and the CLI; it says nothing about the Studio.

### F-7 (MEDIUM-HIGH) — The shipped strict-mode default and Studio's own plumbing are in direct conflict

`options.ts:221` — `strictQueries: options.strictQueries ?? envFlag(…) ?? true`.
`reads.ts:330` — refuses any unplannable read once `branchHasState(overlay)`.
`reads.ts:18-23` explains why refusing everything is wrong: *"Studio composes
GROQ at runtime, everywhere, for its own plumbing… Refusing every query the
planner cannot prove complete does not make the Studio safer — it makes it not
boot."*

Both statements are in the same package. With the shipped default, the moment one
document is edited, every unplannable Studio-issued read throws
`OverlayReadRefusedError`. No test exercises the composite:
`studio-reads-facade.test.ts:407` asserts the refusal in isolation and `:419`
asserts the empty-branch exemption, but nothing runs a Studio-shaped workload
under strict with branch state. [MORNING §3.1](../../MORNING-2026-08-05.md)
already reports an empty structure list in Mode 2 for a neighbouring reason.

### F-8 (MEDIUM) — The only live-Content-Lake oracle still vanishes silently

`test/hosted-parity.test.ts:48` is still `describe.skipIf(!cfg)` —
evidence-review **F7, unremediated**. `hostedConfigFromEnv()` returns `null`
without credentials (`src/hosted.ts:14`) and 13 cases disappear with the suite
still green. `.github/workflows/ci.yml` deliberately carries no secrets ("NO
secrets and NO env block, by design"), so **CI never runs them**. Those 13 cases
are the only independent oracle for line 6 and for the empty-overlay half of
line 7. They passed here because of this machine's `.env`, which is a property
of my environment, not of the suite.

The repo already knows the better pattern: `test/proxy-log-replay.test.ts:939` —
*"A PINNED LITERAL, not a skip. `describe.skipIf` would let the whole leg…"*.

### F-9 (MEDIUM) — PRD §11.3's hard safety guards are mostly unbuilt

Of ten `[MUST]` guards, one is implemented: the write-token startup throw, and
only in the Studio (`options.ts:107-120`, matching `/WRITE_TOKEN$/` against env
**key names**). Missing: the same throw in `sanity-overlay-client`; "overlay
mutation endpoints accept only configured project and base dataset values";
"refuse when `VERCEL_ENV` is production"; "CI scans preview environment
configuration for write-capable tokens"; "CI identifies fork pull requests and
verifies that draft read tokens, Blob credentials and overlay secrets are
absent". `.github/workflows/ci.yml` has two jobs, `test` and `typecheck`, and no
security scan of any kind.

Several of these are `[M-PREVIEW]` and correctly deferred. The client-side
write-token throw and the endpoint project/dataset guard are not, and they are
the difference between *cannot* and *does not*.

### F-10 (MEDIUM) — Three of seven packages are outside the typecheck gate

`.github/workflows/ci.yml` gates `core`, `store-fs`, `query`; it excludes
`client` (16 errors, all missing `@types/node` — the manifest declares no
`dependencies` key at all), `cli` (30, same class), `studio` (was 1: the
undeclared `groq-js`, now fixed and declared) and `testkit` (24). The exclusions
are pinned in `test/repo-manifests.test.ts` so they cannot rot silently, which is
the right shape. But the `groq-js` defect was a *type* error that two
manifest-scanning tests caught by luck of what they scan; the next one of its
species in `client` or `cli` has nothing looking for it.

Two of that file's CI comments are now stale and actively misleading: it warns
that `cli` and `studio` are absent from `pnpm-lock.yaml`'s `importers` and that
"the whole workflow is down before any test runs". Both are present
(`pnpm-lock.yaml:35` and `:57`). Someone acting on that comment would do
unnecessary work.

### F-11 (LOW-MEDIUM) — Peer ranges admit versions that invalidate every library-derived oracle

`packages/sanity-overlay-studio/package.json`: `"sanity": "^6.8.0"`,
`"@sanity/client": "^7.25.0"`. The oracles are pinned exactly:
`listener-matrix.test.ts:40` `{sanity: '6.8.0', client: '7.26.0'}`;
`spike-a-facade-gaps.test.ts:633` reads the installed prototypes. Under
`sanity@6.9.0` — inside the declared range — the facade could miss a whole new
write plane with nothing red. PRD §10.1 `[MUST]`.

### F-12 (LOW) — Recorded state has drifted from the repository again

`docs/plans/README.md` §9 lists roadmap phases 2–9 as **"Not started"** and both
`[M-LOCAL]` and `[M-PREVIEW]` trackers entirely unticked, while roadmap Phase 3's
packages are built and the suite is 89 files / 6558 tests. Test counts on record:
`HANDOFF.md:3` says 2650 / 40; `MORNING-2026-08-05.md:5` says 84 / 6381;
`phase-2/acceptance-audit.md` says 403 for its slice. Actual: **89 / 6558**. This
is the same class evidence-review F12 recorded on 2026-08-04 and it has
recurred; a single generated counts file would end it.

---

## 5. The red tests to write next, in priority order

Each must be written **red first** and observed failing for the stated reason
before any code moves (CLAUDE.md TDD rule). Where a test is expected to pass on
first run, mutate the implementation and confirm it goes red before trusting it.

1. **Package-escape lint (closes F-1).** New `test/package-boundaries.test.ts`,
   or extend `repo-manifests.test.ts`: for every package under `packages/`, parse
   every source file, resolve each relative specifier against its own directory,
   and assert the result stays inside that package root. *Expected red
   immediately:* ~54 violations across studio, client, cli, store-fs and query.
   Write the assertion **before** choosing the fix — the fix is a policy decision
   (bare specifiers plus `workspace:*` deps, or an explicit "source-only
   monorepo" ruling that also deletes the install claim from
   `studio-install.test.ts`'s title and from MORNING §1), and the test should
   exist either way.
2. **PRD-spelled environment contract (closes F-3).** Two reds.
   (a) `overlayClientConfigFromEnv({OVERLAY_MODE: 'fs', OVERLAY_ROOT_DIR: dir})`
   returns `{mode: 'fs', overlayRoot: dir}`. (b)
   `createSiteBaseSource({SANITY_PROJECT_ID, SANITY_BASE_DATASET, SANITY_API_READ_TOKEN})`
   returns the **hosted** source, not the NDJSON file. Then a class test: every
   env name any package reads is in one exported table, and that table's PRD
   column matches §11.2.
3. **Live-base smoke for `mode: 'fs'` (closes the evidence half of line 1).**
   Credential-gated: `createOverlayClient({mode: 'fs', base: createHttpBaseSource(<live>)})`
   over a temp overlay that edits one fixture document; assert the **branch**
   title for the edited document and the **live** title for an untouched one, and
   assert via the outbound monitor that every request it made was a GET. *Red
   first with the overlay empty* — both titles must then be the live one. Ship it
   with (4) so it cannot silently skip.
4. **Hosted-leg non-vacuity (closes F-8).** Fail when `hostedConfigFromEnv()` is
   `null` and a CI marker env var is set. Two lines, and it converts a silent skip
   into a decision. Then decide whether CI gets a read-only token; the §0.6
   evidence rules make an unrun oracle worth very little.
5. **Strict-mode Studio workload (closes F-7).** Red: with `strictQueries` at its
   **shipped default** and one document edited, replay the GROQ shapes a real
   Studio issues — take them from the 31 `GET /data/query/parity` rows in
   `proxy-log-plugin-session-2026-08-05.jsonl`, which are the genuine ones — and
   assert each is *answered*, not refused. Expect most to go red. Then decide
   whether the default should be `true`; whichever way it lands, the test is the
   record.
6. **Studio derived-plan boundedness at 10× (closes F-6).** Point
   `query-boundedness.test.ts`'s harness — the query-text-derived ceilings, the
   independent base recorder, the unbounded and type-scanning mutants, the 10×
   fixture — at `deriveStudioReadPlan` + `evaluateStudioRead`. The registry
   planner has this; the planner Studio runs does not. Add a red test that a
   Studio-derived registration whose text is altered after registration is
   rejected, which today it cannot be.
7. **A real `git` oracle for line 9 (closes F-5).** `git init` a temp repo, write
   an overlay through `FsOverlayStore` with a **real** clock, commit, write the
   same logical state again, assert `git diff --name-only` is empty. *Expected
   red:* `manifest.json` moves on `updatedAt`. Then decide whether the manifest's
   clock fields belong in the committed tree or under `.runtime/`. Second case: a
   semantic edit changes exactly `documents/<id>/intent.json` and nothing else.
   Third: remove `.sanity-overlay/` from `.gitignore:10` for a fixture root, or
   record why the canonical review surface is untracked.
8. **Product path, end to end, against a live base (closes F-4 at the automated
   level; the browser half remains a §0.6 human item).** Boot the overlay server
   on a temp root; build the workspace through `overlayWorkspacePatch` with a real
   `@sanity/client` pointed at the live project; call
   `client.patch(id).set({title}).commit()` through the returned
   `unstable_clientFactory`; assert (a) the value in `intent.json` on disk,
   (b) the live `_rev` unchanged via an independent GET, (c) the outbound monitor
   recorded no non-GET to Sanity. Every layer exists; nothing composes them. This
   is also the test that would have caught F-1 by accident, so write (1) first.
9. **§11.3 guard set (closes F-9).** One red test per unbuilt `[MUST]`, in this
   order: client-side write-token startup throw; overlay endpoint refusing a
   project or dataset it was not configured for; `VERCEL_ENV=production` refusal.
   Assertions before guards.
10. **Peer-range vs pinned-oracle consistency (closes F-11).** Assert the studio
    manifest's `sanity` / `@sanity/client` ranges admit exactly the versions the
    library-derived oracles are pinned to. Red today. Then either narrow the
    ranges or record the supported matrix as the Phase 5 upgrade baseline — which
    also discharges part of §3.3.

**Not a test, but ahead of most of these in value:** a browser E2E harness. §3.1
is the largest single hole in the project and none of the ten items above
touches it. PRD §35.13 scenarios **B**, **C** and **E** are the highest-value
starting three — B and C are the only checks that the live base moving under a
branch behaves as §17.3 says, and E is the reference-dereference line seen from
the outside.

---

## 6. What survived

Recorded plainly, because a review that only finds fault is as useless as one
that finds none.

- **`[M-LOCAL]` line 10 is the best-evidenced claim in the repository**, and it
  got that way by the right method: four independent layers, a host guard that
  needs no endpoint inventory, an enforcement monitor that keeps its own
  deliberately broader predicate so one bug cannot blind both it and its subject,
  and non-vacuity controls on both sides — too-weak *and* block-everything both
  fail the guard contract.
- **`query-boundedness.test.ts` closes evidence-review F6 properly.** Ceilings
  read off the query text and the fixture data, a base source wrapped in the
  file's own recorder rather than trusting diagnostics, a 10× fixture so linear
  and constant are distinguishable, and unbounded mutants run through the *real*
  evaluator and required to break the ceilings. `derefPaths.ts` closes §22.6
  step 8, which [gate-review](../phase-1/gate-review.md) risk 2 recorded as
  unimplemented, and it over-approximates in the safe direction on purpose.
- **`core-serializer-golden.test.ts` is the right shape for a determinism
  oracle**: the expectation was derived by hand from the §14.3 rules rather than
  captured from a run, so it can disagree with the implementation.
- **`studio-observable-contract.test.ts` is a model of learning from a defect.**
  The unit suite's `{subscribe}` double agreed with the facade and both disagreed
  with rxjs; the replacement takes its oracle from the library, invokes the real
  client first, and asserts `instanceof RealObservable`. That is the correct
  response to "behaviour proven only against doubles".
- **The persistence assertions in `overlay-server.test.ts` and
  `action-echo.test.ts` read from disk or from a *restarted* server**, never from
  the response body of the write that made the claim — stated as a discipline in
  the file header and actually followed.
- **`repo-hygiene.test.ts`** turns the NUL-byte mutation-artifact incident into a
  repository-wide property whose denominator is `git ls-files`, so nobody has to
  maintain a list.

The pattern from [evidence-review-2026-08-04](../phase-1/evidence-review-2026-08-04.md)
holds and has, if anything, sharpened: **this project's artifacts hold up under
attack; its claims about them run ahead.** Every finding above is a gap between
something true (the bytes are deterministic, the write guard is sound, the
package declares its bare imports) and something stated (the git diff is
deterministic, staging cannot be mutated, the package can be installed). The
work is ahead of the paperwork, and the paperwork is what acceptance is.
