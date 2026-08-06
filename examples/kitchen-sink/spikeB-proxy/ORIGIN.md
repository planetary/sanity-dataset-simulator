# Two modes: proxy and origin

The Spike B server runs in one of two modes. They are different products with a
shared transport, not two settings of the same thing.

| | **Mode 1 — proxy** (default) | **Mode 2 — origin** |
|---|---|---|
| Sanity project | required, real | **none** |
| Sanity account / login | required, real | **none** |
| Upstream | `https://<project>.api.sanity.io` | **none — never dialled** |
| Base dataset | live staging dataset (PRD §0.2) | **empty; every document is branch-created** |
| Identity | the real logged-in user | **fabricated `local-dev`, all grants** |
| Intercepted | the data plane only | everything |
| Bind address | anything | **loopback only, no override** |
| Opt-in | none needed — it is the default | **required: `--origin` / `OVERLAY_BASE=none`** |
| Write guard | `PROXY_BLOCK_WRITES` | **forced on, not overridable** |

Mode 1 is unchanged by any of this. It is still the default, still what
`node proxy.mjs` starts, and every Mode 1 default in `resolveProxyConfig` is
pinned by `origin-safety.test.ts` (`Mode 1 is unchanged`).

---

## Mode 2 is a deliberate extension of the PRD, not a config tweak

PRD §0.2 fixes the overlay's base as a **live staging dataset**. The whole
mental model of the system — three-way merge against a base, `origin: 'base'`
records, checkpoint promotion back upstream — assumes something is up there.

Mode 2 removes it. The server stops being a proxy and becomes an **origin**:
it answers from `.sanity-overlay/` and never opens a socket to Sanity. So:

- **Every document is branch-created** (PRD §17.2 precedence rule 2). There is
  no base version to merge against, no ancestor, no upstream `_rev`.
- **Every read resolves through `EMPTY_BASE_SOURCE`.** That is the path most
  likely to expose an assumption that "there is always something upstream", so
  `origin-data.test.ts` drives it deliberately rather than incidentally.
- **The identity is fabricated.** Not stubbed — there is nothing to stub. No
  session, no token, no store, nothing to verify against.

This is why it is a separate mode with an explicit flag rather than
`SANITY_API_HOST=""`.

---

## Running it

```bash
node --experimental-strip-types \
  examples/kitchen-sink/spikeB-proxy/runOrigin.mjs \
  --origin --root=examples/kitchen-sink --port=3999
```

Then point Studio at it — in `sanity.config.ts`:

```ts
apiHost: 'http://localhost:3999'
```

`--origin` is required. Running `runOrigin.mjs` without it prints what it would
have done and exits 2. There is no way to reach Mode 2 by omitting something.

Flags (each also readable from the environment):

| flag | env | default |
|---|---|---|
| `--origin` | `OVERLAY_BASE=none` | **required** |
| `--root=<dir>` | `OVERLAY_ROOT` | `examples/kitchen-sink` — the dir that *contains* `.sanity-overlay/` |
| `--port=<n>` | `PROXY_PORT` | `3999` |
| `--bind=<addr>` | `PROXY_BIND` | `127.0.0.1` — non-loopback is refused |
| `--project=<id>` | `SANITY_STUDIO_PROJECT_ID` | `b1n03q3z` |
| `--dataset=<name>` | `SANITY_STUDIO_DATASET` | `parity` |
| `--overlay=<id>` | `OVERLAY_ID` | `overlay-origin-local` |
| `--log=<path>` | `PROXY_LOG` | `./proxy-log.jsonl` |

`--experimental-strip-types` and the resolve hook in `tsResolveHook.mjs` are
needed because `origin.mjs` imports the TypeScript sources of
`sanity-overlay-core` and `sanity-overlay-store-fs`, whose internal specifiers
are extensionless. Mode 1 (`node proxy.mjs`) needs neither: the only Mode 2 code
it links against is `originSafety.mjs`, which is dependency-free on purpose.

---

## Safety

The Mode 2 identity grants everything to whoever asks. On loopback that is
fine — it is your own machine and your own file tree. Anywhere else it is an
unauthenticated write surface. Three controls, each with tests in
`packages/sanity-overlay-testkit/test/origin-safety.test.ts`.

### 1. Loopback only, twice, with no override

`assertLoopbackBind()` runs at **construction** against the configured bind, and
again on the `listening` event against the address the socket **actually bound** —
because `listen()` takes its own host argument and never consults the config, so
a mis-wired launcher could otherwise walk straight past the first check. A
non-loopback bind at listen time closes the server and emits an error.

`bind: undefined` is Node's "every interface" and is **refused**, not defaulted.
Mode 2's own default is `127.0.0.1`.

Loopback is decided structurally, not by denylist: `127.0.0.0/8`, `::1` in any
spelling (`0:0:0:0:0:0:0:1`, `[::1]`, `::1%lo0`), `::ffff:127.x.x.x`, and the
hostname `localhost`. `localhost.evil.test`, `notlocalhost`, `0.0.0.0`, `::`,
`10.x`, `192.168.x`, `169.254.x` and every public address are refused.

There is **no flag that turns this off**. That is deliberate.

### 2. Explicit opt-in, never inference

`isOriginModeRequested()` returns true only for an explicit `origin: true`
option (what `--origin` sets) or `OVERLAY_BASE` **exactly** equal to `none`. No
trimming, no case folding, no truthiness. A missing `SANITY_API_HOST` stays
Mode 1 and fails with a 502, which is the correct loud harmless failure.

### 3. The write guard is not weakened

`writeGuard.mjs` is untouched. It still runs first, still default-deny, and
`write-guard.test.ts` still runs the full contract against it unchanged.

What Mode 2 adds is a second question asked of the *same* verdict:

```
blocked_in_mode_2(r)  =  isWriteRequest(r)  AND  NOT isOriginWriteRoute(r, dataset)
```

`isOriginWriteRoute` accepts exactly two endpoints:

- `POST /data/mutate/<the one dataset>`
- `POST /data/actions/<the one dataset>`

and it is **strict-canonical**: the guard's own `normalizePath()` output must
already equal what the caller sent. Every Spike F normalisation escape therefore
misses — no leading slash, upper case, duplicated separators, percent-encoded
separators, dot segments, stacked version prefixes, trailing slash, absolute
URLs pointed at `<project>.api.sanity.io`. The dataset is compared too, so a
dataset-swapped client clone (attack 14, `POST /data/mutate/scratch`) has no
destination here.

The upgrade path does **not** get the exemption at all. "The same write, but
wearing two extra headers" is exactly the shape that handler's 403 exists to
stop.

#### What Mode 2 does serve that Mode 1 blocks — stated plainly

Mode 1's guard answers one question: *does this write to Content Lake?* In
Mode 2 there is no Content Lake, and `POST /data/{mutate,actions}/<ds>` is the
endpoint the mode exists to serve — Studio cannot save without it.

Eighteen of the twenty-seven Spike F attacks are exactly that request line
(1–13, 15–19: every way `@sanity/client` can be persuaded to reach its own
mutation endpoint). In Mode 2 they land in the overlay — a local file tree the
user owns, under the §14 checkpoint model, with nothing upstream behind it. The
list is pinned as data in `origin-safety.test.ts`
(`OVERLAY_SERVED_ATTACKS`), so widening the origin allowlist turns that file red
before it turns anything else green.

The other nine stay 403 in both modes: 14 (other dataset), 20 (no leading
slash), 21/22 (assets), 23 (agent actions), 24 ×3 (datasets), 25/26 (absolute
URL at `api.sanity.io`).

### Startup banner

Mode 2 prints, every time:

```
[proxy] ============================================================
[proxy] MODE 2 — ORIGIN. There is NO Sanity project and NO upstream.
[proxy] Identity is SYNTHETIC: a fabricated `local-dev` user with all
[proxy] grants. Nothing is authenticated and nothing can be.
[proxy] LOOPBACK ONLY — bound to http://127.0.0.1:3999. Do not expose this port.
[proxy] Every document is branch-created; there is no base dataset.
```

---

## What Mode 2 serves

The endpoint list was **derived from evidence, not guessed**: the five committed
`proxy-log*.jsonl` files are JSONL request logs of real `sanity dev` sessions
against the Track B proxy (730 lines for the first full boot plus four later
sessions). `origin-boot.test.ts` reads those files at test time and replays every
distinct `(method, path)` against a running Mode 2 origin, so an endpoint that
appears in a future recorded session appears there as a failure rather than as a
404.

### Identity and permissions — a stub, and obviously one

| endpoint | answer |
|---|---|
| `GET /users/me` | `{id: 'local-dev', name: 'Local Dev (no Sanity account)', email: 'local-dev@overlay.invalid', role/roles: administrator}` |
| `GET /projects/<p>/datasets/<d>/acl` | `[{filter: 'true', permissions: ['read','create','update','history','editHistory']}]` |
| `GET /projects/<p>/grants` | one synthetic `administrator` role |

`.invalid` is reserved by RFC 2606 so it can never resolve. The permission names
are the `DocumentValuePermission` union read out of `sanity@6.8.0`'s types; the
`filter: 'true'` shape is what `createGrantsStore` → `matchesFilter` evaluates
as `*[true]` against a single-document dataset.

There is no session store, no token, no expiry. An unauthenticated request and a
request carrying a garbage `Authorization: Bearer` get byte-identical answers —
pinned by a test, because that is the honest description of "no auth system".

### Project and dataset metadata

`GET /projects/<p>`, `/projects/<p>/datasets`, `/projects/<p>/datasets/<d>`,
`/projects/<p>/user-applications`, `/datasets`. Shapes taken from
`SanityProject` / `ProjectData` / `DatasetsResponse` in the vendored
`@sanity/client@7.26.0` and `sanity@6.8.0` type declarations.

A project id or dataset name other than the configured one is a **404**, not a
plausible answer for the wrong one.

### Console banners

`GET /journey/{announcements,trial,asset-limit,document-limit,scheduled-drafts,content-releases}`,
`/features`, `/schedules/<p>/<d>`, `/v1/help`, `/intake/telemetry-status`,
`/ping`, `/data/ping/<ds>`. All honestly empty or disabled — there is no trial,
no quota and no organisation to report.

### Data plane, from the overlay

| endpoint | composition |
|---|---|
| `GET /data/doc/<ds>/<ids>` | core `resolveVersionBatch` over the `FsOverlayStore` records |
| `GET,POST /data/query/<ds>` | `groq-js@2.0.0` over the full overlay corpus |
| `POST /data/mutate/<ds>` | wire mutations → core `OverlayMutation[]` → `applyTransaction` → `store.commitTransaction` |
| `POST /data/actions/<ds>` | wire actions → core §18 reducers (`publish`, `unpublish`, `discardDraft`, `deleteDocument`) |
| `GET /data/listen/<ds>` | SSE: `welcome`, then a `mutation` event per affected document |
| `GET /agent/<id>/bundles/mine/listen` | SSE, empty |

`omitted` speaks Content Lake's vocabulary (`reason: 'existence'`), because
Studio branches on it; core's finer absence reason rides along under
`overlayAbsence` so a diagnosis is still possible without pretending it is part
of the Sanity wire contract.

#### Why GROQ is evaluated directly and not through `sanity-overlay-query`

That package exists to make a query **exact** over a base dataset it cannot see
in full: it registers queries, plans the minimum set of base candidates to
fetch, and refuses anything it cannot plan (PRD §22.2 forbids approximate
results). Mode 2 has no base. The overlay is not a diff against a dataset, it
**is** the dataset, so the candidate set is "everything" and there is nothing to
plan or to bound. Running the original query over the complete corpus is the
exact answer by construction — which is the property §22.2 protects. It also
means Studio's arbitrary, unregistered GROQ works, which a registry could never
allow.

Persistence, the mutation engine, perspective resolution and the §18 reducers
are all composed from the existing packages. `origin.mjs` owns no overlay
semantics; it is HTTP plus translation.

#### The structure list is a *findability* query, and it needed two fixes

A Studio structure list pane does **not** send `*[_type == "article"]`. It sends
the search service's findability query, built by `createSearchQuery` in
`sanity@6.8.0`:

```groq
// findability-mvi:5
// findability-source: list
*[_type in $__types && ([@, _id] match text::query($__query) || references($__rawQuery)) && (_type == $type)] {
  _type, _id, _originalId, "orderings": [_updatedAt]
} | order(orderings[0] desc) [0...$__limit]
```

Two things in it defeat `groq-js@2.0.0`, and in Mode 2 — with no upstream to
fall back to — either one means **an empty content list**, which is the worst
possible failure for a branch overlay whose whole purpose is editing content:

1. `[0...$__limit]` — groq-js answers *"slicing must use constant numbers"*. The
   query never parses, so not one document comes back.
2. `text::query(...)` — groq-js parses it, then throws *"not implemented"*
   during evaluation. It is Content Lake's hosted full-text index.

**What the parameters actually carry.** Not assumed — `origin-findability.test.ts`
extracts Studio's own `prefixLast()` out of the installed dist and runs it:

| case | `$__query` | `$__rawQuery` | `$__limit` |
|---|---|---|---|
| unfiltered pane (`searchQuery \|\| ""`) | `"*"` | `""` | `(limit ?? 1000) + 1` |
| typed term `Born` | `"Born*"` | `"Born"` | ditto |

That is the crux. For the case the structure list overwhelmingly uses — no
search term — the predicate means **"match everything of these types"**. Over a
Mode 2 dataset, which *is* the overlay in full, that answer is **exact**.
Returning nothing was never an honest degradation; it was simply wrong.

**How it is answered now.** Before evaluation, `origin.mjs`:

- retries the parse with integer parameters substituted into slice endpoints —
  and *only* after groq-js has already refused the source, so a query groq-js
  accepts is never rewritten;
- resolves every `<expr> match text::query($p)` by evaluating `<expr>` once per
  document with that document as `@`, collecting its text leaves, and applying
  groq-js's own `match` operator, then rewrites the predicate to
  `_id in $<generated ids>`. Evaluating the left-hand side rather than
  pattern-matching one captured query shape means `[@, _id]`, a plain field path
  and a dereference all work.

`references($__rawQuery)` needs no special handling: groq-js implements
`references`, and with the empty raw term of an unfiltered pane it is false for
every document, so the list result above cannot be explained by it. With a typed
term that *is* a document id, it does what it says — referencing documents show
up in the pane.

**Where this is approximate, it says so.** With a typed term, hosted
`text::query` does stemming, language analysis and relevance ranking against an
index this process does not have. Mode 2 substitutes case-insensitive prefix
token matching over the document's own text. Every such response carries

```json
"overlayApproximation": [
  {"function": "text::query", "term": "Born*", "matched": 1, "reason": "…"}
]
```

alongside `result`, and logs a warning. `"*"` is **not** reported as an
approximation, because it is exact. System fields (`_rev`, `_createdAt`,
`_key`, `_ref`, …) are excluded from the searchable text — a document should not
surface because its revision hash contained your term; `_id` still participates,
because Studio's predicate names it explicitly.

Used as a **value** rather than as the right-hand side of `match`,
`text::query()` has no honest local answer at all and raises 501.

---

## What Mode 2 does NOT do

Listed explicitly, because a stub that half-works and fails confusingly at
runtime is worse than an honest "this is missing".

### Declared and answered with 501

- **`GET /socket/<ds>` as a plain GET** — a 501 naming itself. The real upgrade
  is handled; see below.
- **`/data/export`**.

### Blocked by the write guard, in both modes

These are `blocked: true` in the committed Mode 1 logs and the recorded Studio
booted anyway, so keeping them 403 costs nothing:

- `POST /descriptors/claim`
- `POST /intake/batch` (telemetry)
- `POST /assets/images/<ds>`, `POST /assets/files/<ds>` — **no asset uploads**
- `PUT /users/me/keyvalue/<k>` — pane layout and sort order do not persist
  across reloads. `GET` answers `value: null`, which is the "not set yet"
  answer Studio already handles on a fresh account.
- `POST /agent/action/*`, `PUT|DELETE /datasets/*`, and everything else
  default-denied.

### Served, but deliberately thin

- **Document history** — `GET /data/history/<ds>/…` returns an empty timeline.
  The overlay *does* keep transactions (PRD §13.10), but Studio's history UI
  reads Content Lake's mendoza event stream, which is a different model;
  translating one into the other is PRD §37 Phase 5 work. Empty is honest: the
  document has no *Content Lake* history because it has never been there.
- **Listen events carry no `effects`.** Mendoza patches are what Studio applies
  *optimistically* to a document it already holds; fabricating one would corrupt
  the pane. Without it Studio refetches — slower, and correct.
- **Listen events are not filtered by the listener's GROQ.** Every open stream
  on the dataset receives every affected document. Over-delivery costs a
  refetch; under-delivery parks a pane on "Loading document…" for the 30 s
  `resolveChainDeadline`. The `transactionCurrentEvent`/`transactionTotalEvents`
  counts stay consistent for every listener as a result, which is what
  `allPendingTransactionEventsReceived` needs.
- **Mutation shapes not implemented raise a 400 naming them** rather than being
  dropped: query-scoped `delete`/`patch`, and patch paths using slices,
  predicates or wildcards (`arr[0:2]`, `arr[cond]`, `arr[]`). Implemented:
  `set`, `setIfMissing`, `unset`, `inc`, `dec`, `insert`, `diffMatchPatch`, and
  paths of the form `a.b`, `a[0]`, `a[_key=="k"]`.
- **Action types not implemented raise a 400 naming them.** Implemented:
  `create`, `delete`, `discard`, `edit`, `publish`, `replaceDraft`,
  `unpublish`. Not implemented: content releases, document versions, scheduled
  publishes — answering 200 to those would tell Studio a release was created
  when nothing happened.

### ⚠️ The one thing that needs a browser check

**The `@sanity/bifur-client` realtime socket
(`GET /v2022-06-30/socket/<ds>`).**

Mode 2 completes the RFC 6455 handshake, keeps the socket alive, answers `ping`
with `pong`, and answers **every JSON-RPC request with an explicit JSON-RPC
error** (`-32601`) naming the gap. That is a middle position between the two
things it could do instead:

- refusing the upgrade makes the client reconnect forever — the recorded
  sessions show exactly that (`GET /socket/parity` 404 ×33, 502 ×18);
- fabricating `authorization` and `presence` results would invent collaborators
  and session state out of nothing.

**This has not been verified against a live Studio.** The handshake, the framing
and the error payload are covered by tests in `origin-boot.test.ts`, but whether
sanity 6.8.0 tolerates an erroring bifur channel gracefully — or whether it
surfaces a connection-status error banner — is a browser question. Presence and
realtime multi-tab sync are unavailable in Mode 2 either way; the HTTP data
plane and the `/data/listen` SSE stream are not affected.

**Also unverified in a browser:** the full Studio boot. Every recorded request
line is satisfiable (tested), but "Studio renders the desk and saves an edit"
is a claim only a browser can settle.

---

## Tests

| file | property |
|---|---|
| `test/origin-safety.test.ts` | loopback-only, explicit opt-in, the guard is not weakened, Mode 1 is unchanged |
| `test/origin-boot.test.ts` | every recorded request line is served / blocked / declared; synthetic identity; the bifur handshake |
| `test/origin-data.test.ts` | empty base; branch-create → read back; GROQ over overlay; patch/publish/delete; restart durability; the listen stream |
| `test/origin-findability.test.ts` | the structure list: Studio's verbatim findability query returns the overlay; the parameter shapes, established by running Studio's own `prefixLast`; typed search narrows; approximation is declared; branch-created in, tombstoned out |
| `test/write-guard.test.ts` | the write-guard contract itself, unchanged |

Mutation-checked: removing the loopback restriction → 4 red; inferring Mode 2
instead of requiring the opt-in → 6 red; canonicalising the origin write
allowlist instead of requiring an already-canonical request line → 14 red;
making the findability text match find nothing → 7 red; dropping tombstone
suppression from the list corpus → 7 red. Each restored and re-verified green.
