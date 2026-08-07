# Security review — 2026-08-06 (PRD §5.5, Phase 9 exit gate)

**Reviewer stance:** adversarial. Every claimed guarantee was treated as a hypothesis and attacked.
Where a control held, that is stated briefly; where it did not, there is a runnable reproduction.

**Method:** source reading plus read-only reproductions run out of a scratchpad against the shipped
modules (`writeGuard.mjs`, `previewWriteGuard.ts`, `readAllowlist.mjs`, `@sanity/client@7.26.0`).
Nothing in the repo was modified. No request was made to any Sanity API.

**Headline:** **3 P1, 0 P0.** §5.5's "no unresolved P0 or P1" bar is **not met today**.

| # | Severity | Finding |
| --- | --- | --- |
| 1 | **P1** | Write guard: a percent-encoded `?`/`#` truncates the classified path, so a write classifies as a read. Present in **both** guard implementations. |
| 2 | **P1** | WebSocket frame guard forwards un-judged fragment bytes when a control frame or a new final TEXT frame follows. |
| 3 | **P1** | Studio facade: `Transaction.patch(id, builderFn)` hands the callback a `Patch` bound to the **raw** client. |
| 4 | P2 | Mode 2 origin and the overlay API accept state-changing POSTs with no origin/CSRF check; the proxy also reflects any `Origin` with `Allow-Credentials: true`. |
| 5 | P2 | A patch path segment of `__proto__` is accepted, answered `committed: true`, and the write is **silently discarded** — a §5.5 silent-approximation violation. |
| 6 | P3 | `classifyTokenEnvKey` anchors the credential noun at the end of the name, missing `SANITY_TOKEN_PROD`-shaped spellings. |
| 7 | P3 | Mode 1 defaults: write guard **off**, bind **all interfaces**, upstream project chosen by the caller's `Host` header. |
| 8 | P3 | `OVERLAY_BASE` (the Mode 2 switch) is read from the ambient shell, outside the explicit-env rule that governs identity. |
| 9 | P3 | Duplicate JSON-RPC `method` keys are a parser differential the frame guard cannot see through. |
| 10 | P3 | Unguarded prototype-chain read on the record map: `_id: "__proto__"` yields an uncoded HTTP 500. |
| 11 | P3 | Credential-hygiene cluster: the CLI redactor is environment-keyed only, `apiUrl` query/userinfo is never stripped, one crash log prints a raw query string, and the live proxy-log path is tracked with no ignore rule. |

---

## P1-1 — Encoded `?`/`#` truncates the path the write guard classifies

**Vector.** `POST /data/query%3F/../actions/<dataset>`

**Code path.**
- `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs:248-257` — `analysePath` cuts at `?`/`#`, then
  decodes in a loop and **re-cuts after every decode pass**.
- `packages/sanity-overlay-client/src/previewWriteGuard.ts:176-184` — the identical logic in the
  packaged guard, i.e. the classifier `preview-write-impossibility.md` §6 nominates as the
  deployed-preview enforcement point.
- `examples/kitchen-sink/spikeB-proxy/proxy.mjs:490` and `:589` — the proxy classifies `req.url` but
  forwards `pathname + search`, i.e. the **raw** request line, unmodified.

The loop's own comment claims *"Repeated decoding can only ever reveal more path, so it can only ever
make the guard stricter."* That is false. A percent-encoded `?` is a **path character**, not a query
delimiter (RFC 3986 §3.3). Decoding it and then cutting there does not reveal more path — it
**discards** path, and everything after it, including the `..` segments that `readReason` step 0
exists to refuse.

**Reproduction** (`classifyRequest` from the shipped guard, no network):

```
ALLOW  POST /data/query%3f/../actions/parity          canonical=/data/query   reason=GROQ over POST (long-query fallback)
ALLOW  POST /data/query%3F/../mutate/parity           canonical=/data/query   reason=GROQ over POST (long-query fallback)
ALLOW  POST /projects/p/datasets/d/query%3f/../mutate canonical=/projects/p/datasets/d/query
ALLOW  GET  /ping%3f/../data/mutate/parity            canonical=/ping         reason=allowlisted read namespace
ALLOW  POST /data/query%23/../actions/parity          canonical=/data/query
```

`classifyPreviewRequest` from `previewWriteGuard.ts` returns the same verdicts for all of them.

The forwarded bytes are `/data/query%3F/../actions/parity`. Under RFC 3986 §5.2.4
`remove_dot_segments` — which every CDN and most origin routers apply, and which needs no decoding at
all, since `query%3F` is just a segment to be popped — that resolves to **`/data/actions/<dataset>`**,
the Studio write endpoint.

**This is the project's own stated blocking condition, not a new standard.** `writeGuard.mjs:66-73`
and `readReason` step 0 already rule that *"a request with two possible meanings is exactly what
default-deny is for"*. The truncation removes the second meaning from the guard's view before that
rule can fire.

**Independent corroboration.** The audit's second, independently-derived allowlist
(`e2e/audit/readAllowlist.mjs:83-106`) splits on `?`/`#` **on the raw string only** and therefore sees
the `..` and refuses. Every vector above trips the exact condition predicate **A5**
(`e2e/audit/predicates.mjs:185-199`) exists to detect — *"the proxy write guard calls read something
the independent allowlist calls a write"*. Two classifiers built from the same public source
disagree, in the dangerous direction, on a class the contract was supposed to have closed.

**Why the 236-case contract missed it.** `packages/sanity-overlay-testkit/src/writeGuardContract.ts:175`
covers `/data/mutate/<ds>%3Ffake=1` — *"percent-encoded `?` must not hide the path"* — which is the
**safe** direction (truncating a write path still leaves a write). The dangerous direction, where
truncation collapses a write onto an allowlisted read **prefix**, has no case.

**Severity rationale — P1, not P0.** The invariant the whole control rests on ("the guard matches a
canonical path") is falsified, and the defect is duplicated in the classifier earmarked as the *only*
door in the deployed-preview architecture, where §6 makes it load-bearing. It is **not** P0 because
the primary threat actor — page JS in a preview — cannot emit it: the WHATWG URL parser removes every
recognised dot-segment spelling before the request is issued. Verified:

```
http://…/data/query%3F/../actions/ds        => /data/actions/ds
http://…/data/query%3F/%2e%2e/actions/ds    => /data/actions/ds
http://…/data/query%3F/.%2e/actions/ds      => /data/actions/ds
```

so the vector needs a client that can write a raw request target (curl, Node, any non-browser tool).
The post-hoc network audit also catches it (A3's dot-segment check on the raw logged path, and A4/A5).
Neither of those is a fix: the request still reaches Content Lake, the proxy still logs
`blocked: false`, and the audit only runs in the e2e harness, not in a developer's session.

**What would close it.** Cut at `?`/`#` **once**, on the raw request line, and never again after
decoding. Verified against a local reimplementation of `analysePath` with the re-cut removed:

```
/data/query%3f/../actions/parity  -> /data/actions/parity   dotSegments=true   (blocked)
/data/query%3F/../mutate/parity   -> /data/mutate/parity    dotSegments=true   (blocked)
/ping%3f/../data/mutate/parity    -> /data/mutate/parity    dotSegments=true   (blocked)
/data/mutate/parity%3Ffake=1      -> /data/mutate/parity?fake=1                (still blocked — contract case holds)
/data/query?tag=x                 -> /data/query                               (still a read)
/data/query/parity?query=*[…]     -> /data/query/parity                        (still a read)
```

The fix must land in `writeGuard.mjs`, `previewWriteGuard.ts` **and** the shared contract (a red case
per vector above, in the dangerous direction), or the two implementations will drift apart on it.

---

## P1-2 — The WebSocket frame guard releases un-judged fragment bytes

**Vector.** A fragmented client message whose first frame carries the whole `mutate` JSON-RPC body,
followed by any control frame — or by a new final TEXT frame with an allowlisted method.

**Code path.** `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs`
- `:719-730` — `const isFragment = verdict.reason === 'fragment'` … `if (!isFragment || !enforce) releaseUpTo = scanned`.
  A **control frame** is classified `{write: false, reason: 'control frame'}` (`:600-604`), so it is
  not a fragment, so it advances `releaseUpTo` past **every byte scanned so far** — including the
  held fragment that has never been judged.
- `:606-612` — a TEXT frame with `fin = 1` sets `fragment = null`, silently discarding the
  in-progress chain, and judges **only its own payload**. An allowlisted method there flushes the
  discarded fragment too.

This contradicts the module's own contract at `:541-543`: *"Bytes are only released once the frame
they belong to has been parsed AND classified — a reader that forwarded optimistically could not take
the prefix of a mutation back."*

**Reproduction.** Frames built by hand, fed to `createRealtimeFrameGuard({enforce: true})`, forwarded
bytes decoded and unmasked to show what the upstream socket receives:

```
clean          A. plain mutate TEXT(fin=1)                          upstream saw: []
clean          B. fragmented mutate, no interleave                  upstream saw: []
*** LEAKED *** C. TEXT(fin=0, full mutate) + PING + CONT(fin=1)     upstream saw: op1/frag:{"jsonrpc":"2.0","method":"mutate","params":{"mutations":[{"createOrRe… , op9/FIN:hi
*** LEAKED *** D. TEXT(fin=0, full mutate) + TEXT(fin=1, query)     upstream saw: op1/frag:{…"method":"mutate"…} , op1/FIN:{…"method":"query"…}
*** LEAKED *** E. C, all in one TCP chunk                           (same as C — the `head` buffer path, proxy.mjs:950)
*** LEAKED *** F. TEXT(fin=0) + PONG + CONT(fin=0) + PONG + CONT(fin=1)   fragment bytes released twice
```

In C/E/F the guard *does* latch and the FIN continuation is never forwarded, so a compliant upstream
never completes the message. In D the guard never sees a write at all — its only verdict is
`query` — and both frames are forwarded, which upstream will read as a protocol violation
(RFC 6455 §5.4) rather than as a mutation.

**Severity rationale — P1.** Whether these complete a write depends entirely on how Sanity's bifur
server treats a fragmented message whose FIN never arrives, and a data frame arriving mid-fragment.
That is unknowable from here — which is precisely the "two possible meanings" situation the HTTP half
of this same file treats as blocking. The guard's stated invariant is false either way, and the
attacker-chosen `mutate` body reaches Content Lake's socket. Not P0: browser JS cannot reach it —
`WebSocket.send()` always emits a single unfragmented final frame, so the vector needs a raw
socket or a Node WebSocket library with explicit fragmentation. Also note this is the **latch**
claim's blast radius, not the latch itself: the latch works.

**What would close it.** `releaseUpTo` must only advance past a **judged message boundary**. Hold
control frames that arrive while `fragment !== null` behind that boundary too (or forward control
frames on a separate path that cannot advance `releaseUpTo`), and treat a TEXT frame arriving while
`fragment !== null` as a protocol violation that latches, rather than as a reset. Add all six cases
above to the frame-guard suite as red tests first.

---

## P1-3 — `Transaction.patch(id, builderFn)` hands the callback a raw-client-bound `Patch`

**Vector.**

```js
wrappedClient.transaction().patch('article-01', (p) => {
  p.set({title: 'owned'})
  p.commit()          // -> rawClient.mutate(...) -> POST /data/mutate/<ds>
  return p
})
```

**Code path.**
- `@sanity/client@7.26.0` `dist/index.js` `Transaction.patch` / `ObservableTransaction.patch`:
  `patchOps(new Patch(patchOrDocumentId, {}, this.#client))` — the callback receives a **fresh
  `Patch` holding `#client`**, and `#client` is the raw client the facade wrapped, because the
  facade invokes `fn.apply(target, args)` with `target` = the raw `Transaction`.
- `packages/sanity-overlay-studio/src/client/facade.ts:1010-1022` — `blockFluentCommit`'s non-`commit`
  branch re-wraps only the **return value**. It cannot see an object handed to a callback *inside*
  the call.

**Reproduction** (no network — the "client" is a stub whose `mutate` records that it was reached):

```
raw client mutate reached from inside the patch builder: true
[ { "ops": { "patch": { "id": "article-01", "set": { "title": "owned" } } },
    "options": { "returnFirst": true, "returnDocuments": true } } ]
```

**Severity rationale — P1.** This is the same class as the `SanityClient.config(newConfig)` escape
that `preview-write-impossibility.md` §3 vector 3 records as *"a live escape, now closed"*: a
delegated call hands out an unguarded client handle, and in a deployed preview there is no proxy
behind it. The fix for that one was declared *structural* (`facade.ts:857-882`, "any method — present
or future — whose return value IS a `@sanity/client` is re-wrapped"), and the structural claim does
not hold for capabilities passed *into* a call.

The oracle that was supposed to catch the class does not:
`packages/sanity-overlay-testkit/test/preview-write-impossibility.test.ts:237-263` says *"Walk every
callable on the shipped `SanityClient` prototype"* and then restricts itself to
`['config', 'clone', 'withConfig']`, checks only return values, and never touches `Patch` or
`Transaction`. The comment claims more than the test does — exactly the "confident evidence that
proved nothing" pattern this project has hit before.

Downgraded from P0 because it requires a deliberate, non-idiomatic `.commit()` **inside** the builder
callback (the idiomatic `patch => patch.set(…)` performs no I/O and is safe), and because an attacker
with page JS has cheaper routes — `wrapped.config()` returns `{...clientConfig}` including `token`,
by design.

**What would close it.** In `blockFluentCommit`, wrap function arguments as well as return values:
when a builder method is called with a callback, wrap the callback so any `Patch`/`Transaction`-shaped
argument it receives is passed through `blockFluentCommit` first. Then widen the
`preview-write-impossibility` oracle to walk `Patch.prototype` and `Transaction.prototype` and to
probe **callback parameters**, not just return values — and make its comment match its coverage.

---

## P2-4 — No CSRF/origin check on the write routes of the Mode 2 origin or the overlay API

**Vector.** Any web page the developer has open issues a **simple** cross-origin request — no
preflight, because `POST` + `Content-Type: text/plain` is CORS-safelisted:

```js
fetch('http://localhost:3999/v1/data/actions/parity',
      {method: 'POST', mode: 'no-cors', headers: {'Content-Type': 'text/plain'},
       body: JSON.stringify({actions: [/* … */]})})
```

**Code path.**
- `examples/kitchen-sink/spikeB-proxy/proxy.mjs:522-523` — `isOriginWriteRoute` routes the POST to the
  overlay handler. There is no authentication anywhere on this path: the identity is synthetic and
  fully granted by design (`originSafety.mjs:2-28`).
- `examples/kitchen-sink/spikeB-proxy/origin.mjs:160-168` — `readJson` parses the body with no
  `Content-Type` check, so the CORS-safelisted content type costs the attacker nothing.
- `packages/sanity-overlay-next/src/api.ts:928-946` — `readJsonBody`, same: no content-type check,
  and no `Origin` / `Sec-Fetch-Site` check on `POST /commit`.
- `examples/kitchen-sink/spikeB-proxy/proxy.mjs:143-157` — `corsHeaders` **reflects the request
  `Origin` verbatim with `Access-Control-Allow-Credentials: true`**, and `preflightHeaders` advertises
  `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`. So in Mode 2 the attacker can also **read** every
  response — the whole branch, every unpublished draft.

The loopback bind (`originSafety.mjs:99-129`, which is otherwise sound — see below) stops LAN
attackers. It does not stop a page running inside the developer's own browser, which is on loopback
by definition.

**Severity rationale — P2.** Remotely triggerable by any site the developer visits, with no user
interaction beyond having the proxy running, and it both writes and exfiltrates. It is not P1 because
the blast radius is the developer's **local overlay branch** — files under `.sanity-overlay/` — not
the shared Sanity dataset, and Mode 2 by construction has no Sanity credential to steal. Note the
overlay API at `:3998` is better off than the proxy: its CORS is a real allowlist defaulting to none
(`api.ts:110-119`, `server.ts:146`), so exfiltration is blocked there — but the blind write is not.

**What would close it.** On every state-changing route: require `Content-Type: application/json`
(which forces a preflight), and reject a request whose `Origin` is present and not on the allowlist,
or whose `Sec-Fetch-Site` is `cross-site`. Stop reflecting arbitrary origins with
`Allow-Credentials: true` in `proxy.mjs` — in Mode 2, allowlist the Studio origin the way
`createOverlayApi` already does.

---

## P2-5 — A `__proto__` patch path is accepted, reported committed, and silently dropped

**Vector.** `POST /commit` (or any Studio edit that reaches it) carrying a patch whose path is
`__proto__.polluted`, or `a.__proto__.b`.

**Code path.**
- `packages/sanity-overlay-next/src/translate.ts:187-191` — `parseSanityPath` accepts any non-empty
  field segment. Confirmed: `"__proto__.polluted"` → `["__proto__","polluted"]`,
  `"constructor.prototype.polluted"` → three segments, `unsupported: []`.
- `packages/sanity-overlay-core/src/actions/operations.ts:83-94` — `assertWritablePath` checks only
  `path[0]` against `PROTECTED_SYSTEM_FIELDS = ['_id','_rev','_createdAt']` (`:38`). It knows nothing
  about prototype keys.
- `packages/sanity-overlay-core/src/mutations/paths.ts:33` — `deepClone`'s `out[key] = …` converts an
  own `__proto__` key into a real `[[Prototype]]` swap, after which `Object.getOwnPropertyNames` no
  longer sees it. The data is **destroyed**, not rejected.
- `packages/sanity-overlay-next/src/api.ts:928-946` — `readJsonBody` is a bare `JSON.parse`; it does
  **not** go through `serialize.ts` `parse()`, which is the only thing in the codebase that calls
  `assertNoForbiddenKeys`.

**Observed behaviour** (real modules, executed):

```
patch set "__proto__.polluted"       => COMMITTED (200), value silently vanishes
patch set "a.__proto__.b"            => COMMITTED (200), persisted as "a": {}   <- write destroyed
patch set "constructor.prototype.x"  => REJECTED  OVERLAY_PROTOTYPE_KEY_REJECTED
create {..., "__proto__": {"isAdmin": true}, "keep": 2}
                                     => COMMITTED, isAdmin silently dropped
Object.prototype.polluted / .isAdmin => undefined in every case
```

**Severity rationale — P2.** This is **not** prototype pollution: `Object.prototype` is never reached
(see the clean-areas section). It is an **integrity** defect. The API answers
`{ok: true, committed: true, unsupported: []}` for a write it did not perform, and persists a bogus
touched path `$.__proto__` into `intent.json`. That is precisely what §5.5 forbids and what
`translate.ts:21-25` says this API must never do — the editor is told "saved" for content that exists
nowhere. Not P1 because it requires a document field literally named `__proto__`, which no schema
would produce, so it is not reachable by accident.

**What would close it.** Call `isForbiddenKey` (already exported from
`packages/sanity-overlay-core/src/serialize.ts:51`) inside `parseSanityPath` and inside
`assertWritablePath`, refusing with a coded error rather than dropping. Make `deepClone` accumulate
into a null-prototype object, or use `Object.defineProperty`, so a forbidden key survives to the
`serialize()` check instead of being erased. Note the current pass for `constructor`/`prototype` is
**incidental**: the only guard on that path is `serialize()` running transitively inside
`checksum()` from `applySyntheticSystemFields` (`mutations/state.ts:99-104` → `checksum.ts:162`).
Nothing in `mutations/`, `merge/`, `validation/` or `sanity-overlay-next/` calls `isForbiddenKey`
directly, so that protection is one refactor away from disappearing silently.

**Coverage gap to close with it.** `packages/sanity-overlay-testkit/test/core-w1.test.ts:201-235`
tests §35.14 only against `serialize`/`parse` directly. Nothing tests a prototype key arriving
through `/commit`, through `parseSanityPath`, or as a patch path segment.

---

## P3-6 — The startup credential check misses trailing-qualifier token names

`packages/sanity-overlay-studio/src/options.ts:130`

```js
const CREDENTIAL_NOUN = /(?:^|_)(?:TOKEN|SECRET|API_?KEY|CREDENTIALS?|PASSWORD|PAT)$/
```

Anchored at `$`, so the noun must be the **last** label. Missed spellings include
`SANITY_TOKEN_PROD`, `SANITY_API_TOKEN_STAGING`, `SANITY_TOKEN_V2`, `SANITY_KEY` — all plausible in a
Vercel project with more than one environment. `SANITY_API_VERSION` is the false positive the anchor
exists to avoid, and that is a real concern, but the anchor over-corrects.

**Severity rationale — P3.** The check is explicitly documented as name-based and defence-in-depth
(`options.ts:117-126`), the real containment is "no write-capable credential in the preview at all",
and `SANITY_READ_TOKEN` holding a write token defeats it anyway. **What would close it:** drop the
`$` anchor and instead exclude a short denylist of non-credential tails (`VERSION`, `URL`, `ID`,
`NAME`, `HOST`, `PREFIX`), which fails closed rather than open.

## P3-7 — Mode 1 defaults: guard off, every interface, caller-chosen project

`examples/kitchen-sink/spikeB-proxy/proxy.mjs:304, :319-320` — `blockWrites` defaults to **false**
and `bind` defaults to **undefined** (all interfaces, v4+v6). Both are documented in
`spikeB-proxy/README.md:40-42`, and `playwright.config.ts:107` sets `PROXY_BLOCK_WRITES=1`, so the
evidence runs are enforced. Still: the single control that PRD §36.1 Track B rests on is opt-in, and
its off state is one forgotten env var away in a hand-run session.

`proxy.mjs:437-449` — `resolveUpstreamHostname` derives the upstream from the caller's `Host` header
(`<label>.localhost` → `<label>.api.sanity.io`) and never checks `label` against the declared project.
Any client that can reach `:3999` can aim the proxy at any Sanity project. It gains no credential by
doing so (the proxy holds none; it forwards what the caller sends), which is why this is P3.

**What would close it:** default `blockWrites` to true with an explicit `PROXY_BLOCK_WRITES=0`
opt-out; default `bind` to loopback in Mode 1 as well; refuse a `Host` label that is not the declared
`projectId`.

## P3-8 — The Mode 2 switch is read from the ambient shell

`examples/kitchen-sink/spikeB-proxy/originSafety.mjs:57-60` and `runOrigin.mjs:64` — `OVERLAY_BASE=none`
exported in a shell is sufficient to start Mode 2 without anyone typing `--origin`. The project applies
its "explicit-only, refuse on disagreement" rule (`explicitEnv.mjs`, `studioIdentity.mjs`) to the
*identity* Mode 2 serves but not to the *decision to serve it*. Mitigated to P3 by the loopback bind,
the unmissable banner (`originStartupBanner`), and the fact that Mode 2 has no upstream and no
credential. **What would close it:** treat `OVERLAY_BASE` as a declared value via `loadExplicitEnv`,
or require the flag unconditionally.

## P3-9 — Duplicate JSON-RPC `method` keys are a parser differential

`examples/kitchen-sink/spikeB-proxy/writeGuard.mjs:655-680` — `judge` uses `JSON.parse`, which takes
the **last** duplicate key. A frame spelled `{"method":"mutate","method":"query",…}` classifies as
`query` and is forwarded verbatim, with `"method":"mutate"` still in the bytes. Reproduced:

```
*** LEAKED *** G. duplicate JSON keys: mutate then query
   guard verdicts : ["query"]
   upstream saw   : op1/FIN:{"jsonrpc":"2.0","method":"mutate","method":"query","params":{},"id":"d"}
```

**Severity rationale — P3.** It only becomes a write if the upstream parser takes the **first**
duplicate, and every mainstream JSON implementation takes the last, so this is a low-confidence
differential rather than a demonstrated bypass. Unlike the fragmentation vectors it **is** reachable
from browser JS (`ws.send()` on a raw `WebSocket`), which is why it is listed at all.
**What would close it:** reject a text frame whose top-level object declares `method` more than once —
a cheap scan of the raw payload before `JSON.parse`.

## P3-10 — Unguarded prototype-chain read on the record map returns an uncoded 500

`packages/sanity-overlay-core/src/mutations/state.ts:66` —
`return state.documents[toPublishedId(id)] ?? null` is a bare `[[Get]]` on a plain-object map, so a
mutation whose `_id` or `patch.id` is `"__proto__"`, `"constructor"` or `"toString"` returns
`Object.prototype` / the `Object` constructor / a function instead of `null`. Observed:

```
_id "__proto__"   => TypeError: Cannot read properties of undefined (reading 'publishedTombstone')
_id "constructor" => same
```

`packages/sanity-overlay-next/src/api.ts:917-919` maps a code-less error to HTTP 500 `INTERNAL`, so
the failure is unattributable. The same unguarded pattern is at `mutations/transaction.ts:193, :291`,
`api.ts:546, :640, :662`, and `merge/context.ts:50`. Note `encodeLogicalId('__proto__')` returns
`'__proto__'` verbatim (`encoding.ts:194`), so the id would reach the filesystem layer if this were
fixed without also adding a key check.

**Severity rationale — P3.** No data is written and no privilege is gained; the impact is an
unattributable 500 and a per-request crash, and it is reachable only through the overlay API on
loopback. **What would close it:** `Object.prototype.hasOwnProperty.call` at each lookup, or make
`documents` / `idempotencyLedger` a `Map` or a null-prototype object.

## P3-11 — Credential-hygiene cluster

None of these is a live credential disclosure today. Each is a control that claims more than it
currently delivers.

- **The CLI redactor is environment-keyed, not content-keyed.**
  `packages/sanity-overlay-cli/src/redact.ts:28-39` only masks values that are already in the env map
  under a name matching `SECRET_NAME` (`:17`). It has **no Sanity-token shape pattern**. This repo's
  own convention keeps `SANITY_API_READ_TOKEN` in an untracked root `.env` loaded by
  `examples/explicitEnv.mjs`, which the CLI never reads — so in the common case `secrets` is `[]` and
  the redactor is a no-op, while its header claims it "runs on every byte the CLI writes". A token
  arriving from a document field, a fixture, or `~/.config/sanity/config.json` is printed verbatim.
  There are also four divergent "is this a credential name?" regexes (`redact.ts:17`,
  `sanity-overlay-studio/src/options.ts:130`, `examples/explicitEnv.mjs:65`,
  `sanity-overlay-testkit/src/env.ts:126`). **Close it with** a second content pass
  (`/\bsk[A-Za-z0-9]{20,}\b/`, `/Bearer\s+[A-Za-z0-9._~+/-]{20,}/i`) and one shared exported constant.
- **`apiUrl` is never stripped of query or userinfo and is echoed into readable surfaces.**
  `packages/sanity-overlay-studio/src/options.ts:213-229` validates only scheme and absoluteness;
  `client/transport.ts:258` interpolates the full `url` into five error strings (`:260, :277, :289,
  :296, :305`), which reach `__SANITY_OVERLAY__.messages()`, `.session().failures[].message` and the
  status banner. `transport.ts:78` documents `headers` as *"e.g. a preview session token"*, so a
  deployment that puts that token in the URL instead would disclose it. **Close it with** stripping
  `search`/`username`/`password` in `resolveOverlayOptions`, and logging `origin + pathname`.
- **One crash log prints a raw query string.**
  `examples/kitchen-sink/spikeA/overlayServer.mjs:1007` logs `${request.method} ${request.url}` — the
  only place in the repo that logs an unsplit URL. Every other path in the same file uses `route`
  (pathname only). One-line fix.
- **The live proxy-log path is tracked with no ignore rule.** Eleven `proxy-log*.jsonl` files are in
  git under `examples/kitchen-sink/spikeB-proxy/`, including `proxy-log.jsonl`, which is the default
  live write target (`proxy.mjs:324`, `:401`). All eleven were content-audited and are clean — the
  complete key set is `at, blocked, frame, method, ms, opcode, path, reason, rpc, rpcId, status,
  upgrade, wouldBlock`, no headers, no bodies, no query strings. The risk is structural: any future
  field added to `logLine` gets committed on the next `git add -A`. **Close it with** an ignore rule
  plus `git add -f` for the deliberately-retained evidence files.

---

## What I attacked and could not break

**Path and URL normalisation, everything except the encoded delimiter.** I could not construct a
spelling where the guard's canonical path is an allowlisted read and the forwarded raw path routes to
a write, other than via P1-1. Specifically ruled out with reproductions:

- **Dot segments** in every spelling — `..`, `..%2f`, `%2e%2e`, `%252e%252e`, `;/../`, `//../` — all
  set `dotSegments` and are refused (`readReason` step 0).
- **Double and triple encoding** — the bounded 5-pass decode reaches the fixed point; `%252e%252e`
  resolves to `..` and is refused.
- **Encoded slash** `%2F` — `/data/query%2Factions%2Fds` decodes to `/data/query/actions/ds`, still a
  read on both sides; there is no write endpoint under `/data/query/`.
- **Null bytes and control characters** — `/ping%00../data/mutate/ds` fails the segment-aware prefix
  test (`hasSegmentPrefix`) and is refused. Fails closed in both directions.
- **Overlong / invalid UTF-8** (`%C0%AF`) — `safeDecode`'s per-triplet fallback leaves the bytes
  verbatim; the path no longer matches any allowlist entry and is refused.
- **Mixed case and Unicode case folding** — the guard lower-cases, and no case variant of `mutate` or
  `actions` folds into an allowlisted read word; fullwidth and Kelvin-sign variants fail the prefix
  test. The dangerous direction does not exist here.
- **Absolute-URI request lines** and protocol-relative `//host/path` — scheme+authority stripped, and
  `//x` is deliberately read as a duplicated slash rather than an authority; `//data/mutate/ds` is
  refused.
- **Oversized paths, missing leading slash, stacked version prefixes, trailing slashes** — all
  collapse to the same canonical form; none produces a false read.
- **Non-string / null / undefined request objects** — `classifyRequest(null)` and
  `classifyRequest({})` both return `write: true`. Fail-closed.

**The write-guard policy shape.** The inversion to `isWriteRequest = !isAllowedRead` is genuinely
default-deny. `GET /data/mutate/<ds>` and `GET /agent/action/patch/<ds>` are refused before the method
is consulted (`NO_READ_OPS`, `isAgentWriteAction`). The resource-scoped data plane
(`/projects/<p>/datasets/<d>/mutate`) is covered. `POST /data/query` is the only write-verb read and
it is correctly scoped.

**Origin mode's loopback bind.** `isLoopbackBind` (`originSafety.mjs:99-148`) is derived structurally,
not by denylist, and I could not evade it: `0.0.0.0`, `''`, `undefined`, `::`, `::ffff:10.0.0.1`,
`localhost.evil.test` and `notlocalhost` are all refused; `::1` is expanded numerically so
`0:0:0:0:0:0:0:1` and `[::1]%lo0` are recognised; `::ffff:127.0.0.1` is unwrapped to IPv4. Crucially,
`proxy.mjs:1037-1052` re-checks **the address the socket actually bound** on `listening`, so a
launcher that bypassed the config check (`listen(port)` with no host, or a `localhost` that DNS
resolves off-loopback) is still refused. There is no override flag anywhere. This control is sound.

**Origin mode cannot be enabled implicitly by absence.** `isOriginModeRequested` compares
`OVERLAY_BASE` verbatim — no trim, no case fold, no truthiness — and a missing `SANITY_API_HOST`
yields a Mode 1 502, not a fallback to Mode 2. `createProxyServer` throws when Mode 2 is requested
with no `originHandler`. (The ambient-shell reachability of the switch itself is P3-7.)

**`isOriginWriteRoute` strict-canonical equality.** `rawApiPath(rawUrl) === normalizePath(rawUrl)`
means no normalisation escape can *widen* Mode 2's two write routes: every Spike-F spelling makes the
two strings differ and the 403 stands. Dataset-scoping is enforced. Sound as designed — note it
inherits P1-1's canonical path, but only in the *narrowing* direction, so it is not a hole.

**`stagingHost.ts`.** `SANITY_API_HOST_RE` is anchored at both ends on a label boundary, so
`api.sanity.io.evil.example` and `xapi.sanity.io` are correctly not matched, while
`<projectId>.api.sanity.io` and `apicdn` are. Host extraction goes through `URL`, so IDN
(`api。sanity。io`), trailing root dots, ports, case and userinfo all normalise correctly.
The documented abstention on a bare relative path is the right call — guessing would fail open under
the proxy topology. `createStagingSafeFetch` checks before delegating and rejects rather than throwing
synchronously.

**The suite-wide outbound monitor.** Genuinely installed for every test file
(`vitest.config.ts:14` → `vitest.setup.ts`), patches `http.request`, `http.get`, `https.request`,
`https.get` **and** `fetch`, with the `get`-is-not-`request` near-miss explicitly handled. Its
`sanity.io`-suffix rule is deliberately broader than and independent of the runtime guard's, so one
bug cannot blind both. The documented blind spots (`node:http2`, raw `net`/`tls`) are real but
nothing in the project routes Sanity traffic through them, and the proxy's `tls.connect` path is
behind an injected `dialUpstream` seam in tests.

**Prototype pollution — `Object.prototype` is unreachable from any overlay HTTP body.** Nine
attacker-key-to-property-assignment sinks were traced from `api.ts` `readJsonBody` into core
(`mutations/paths.ts:33, :184, :188`, `merge/merge.ts:138, :183`, `mutations/transaction.ts:194, :292`,
`store-fs/fsStore.ts:664, :690, api.ts:227`). Every assignment target is a **freshly created** object
(`{...node}` at `paths.ts:152`, `[...node]` at `:164`, `{}` at `merge.ts:127`, `{...baseValue}` at
`merge.ts:172`), and nothing ever assigns into an object obtained through a prototype-chain read — so
the global prototype is never the receiver. Computed keys in object literals
(`mutations/state.ts:71`, `transaction.ts:217, :315`, `fsStore.ts:564`) use `CreateDataProperty`,
which does not fire the `__proto__` setter, and `mutations/ports.ts:57-72` buckets attacker-supplied
`baseDocuments` into `Map`s. Executed against the real modules:
`Object.prototype.polluted / .isAdmin / .x` was `undefined` in every case, including a `mergeDocument`
with `localTouchedPaths [["__proto__","x"]]`. `serialize.ts` itself is correct —
`assertNoForbiddenKeys` uses `getOwnPropertyNames` (not `keys`), which is the right choice for
`JSON.parse`'s own `__proto__` data property, and `parse`/`canonicalize`/`roundTrip` all route through
it. The **integrity** consequence of `__proto__` on this path is P2-5 and the crash is P3-10; the
security consequence does not exist.

**Persist-time serialization.** Every write in `packages/sanity-overlay-store-fs/src/fsStore.ts` goes
through canonical `serialize()` (`:1115, :1928, :1934, :2096-2097, :2118`) and every checkpoint read
through canonical `parse()` (`:1073, :2034`), so a forbidden own key cannot reach disk even if apply
time missed it.

**The devtools global carries no credential.** All three branches of `__SANITY_OVERLAY__` were
walked. `runtime.resolved` (`options.ts:49+`) has no token field — `assertNoWriteToken` reads env only
to refuse to boot, and names the *key*, never the value. `runtime.transport` returns an object literal
of `{apiUrl, commit, operation, resolve, state}` (`transport.ts:326-368`); `options.headers` stays
closure-private, and `runtime.ts:184-192` does not pass `headers` at all today. `runtime.echo` exposes
`sessionState()` and `authFailures()` = `{status, source, message}`. The `@sanity/client` that *does*
hold the token is created inside `clientFactory` (`runtime.ts:205-219`) and never retained on the
runtime, so nothing walks back to it. Installed non-enumerable and only when the overlay is enabled.
(The `apiUrl` echo is P3-11, and it is a URL, not a token.)

**Nothing credential-bearing is persisted.** No `token`/`authorization`/`cookie`/`headers` field
exists anywhere in `sanity-overlay-store-fs/src/*` or `sanity-overlay-core/src/checkpoint/*`. The only
auth-adjacent persisted field is `actor` → `createdBy`/`updatedBy`, and every network entry point
normalises it to `{type, id, displayName}` with an explicit allowlist
(`api.ts:148-157`, `spikeA/overlayServer.mjs:110-120`, `origin.mjs` hardcoded `DEFAULT_ACTOR`), so the
declared-but-unpopulated `OverlayActor.email` (`types/actor.ts:6`) cannot reach a Git-tracked
`manifest.json` over HTTP. The committed `examples/kitchen-sink/.sanity-overlay/manifest.json`
contains display names only.

**Repo hygiene.** The root `.env` is untracked, covered by `.gitignore:8`, and
`git log --all --diff-filter=A` shows it was never committed on any branch; it holds a read-token
spelling only. No token in any tracked fixture (`git ls-files | xargs grep -E 'sk[A-Za-z0-9]{40,}'`
matches only `pnpm-lock.yaml` integrity hashes). The only tracked `Bearer <…>` is a dummy in
`test/origin-boot.test.ts:362`. `e2e/.artifacts/` (Playwright traces, which capture request headers)
is ignored via `e2e/.gitignore:8`, and `playwright.config.ts:167` sets `storageState: undefined`.
The Spike F attack harness truncates tokens to 6 chars before anything leaves
(`spikeF/attackPass.ts:625-627`), and `spikeA/instrumentedClient.ts:233` redacts `options.token`
before publishing the client config to `window.__SPIKE_A__`.

**Error messages elsewhere.** `sanity-overlay-cli/src/errors.ts` is a plain carrier whose `details`
render downstream of `redact()` (`cli.ts:520`). `sanity-overlay-next/src/api.ts:917-926` emits only
`{code, message}`; its 404 uses `url.pathname`. `sanity-overlay-client/src/base.ts:90` deliberately
uses `url.pathname` rather than `url.href` even though the token is a header at `:86`.
`sanity-overlay-testkit/src/hosted.ts:51` builds a `Bearer` header and throws only status plus body.

**SSE frame encoding.** `packages/sanity-overlay-next/src/sse.ts:24` puts the payload through
`JSON.stringify`, which escapes newlines, so a payload cannot forge a frame. The `event` name is
never caller-controlled.

**JSONL log writing.** `proxy.mjs:398-406` and the overlay logs build lines with `JSON.stringify`, so
a request path containing newlines cannot forge a log record. Log-injection is not available.

**GROQ parameter interpolation.** The one place a path is interpolated into query text —
`packages/sanity-overlay-studio/src/client/reads.ts:214` — is gated by
`SAFE_ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_]*$/` applied to **every** segment (`:210`), and returns
`null` rather than degrading. Values and id/type lists go through GROQ parameters, never string
concatenation. Sound.

**Namespace coverage in the Studio facade.** `NAMESPACE_ROOTS` covers all eight namespace properties
`SanityClient@7.26.0` actually declares (`assets, datasets, live, mediaLibrary, projects, users,
agent, releases`), `NESTED_NAMESPACES` covers both nested ones, and `namespaceMethodKind` is
default-**write** for anything not explicitly declared a read or a push — so a new
`@sanity/client` method is refused on arrival rather than delegated. `live.events` is correctly
classified `push` and refused as an Observable on both the promise and observable clients. The four
version writes are refused. The namespace clients all hold their parent behind a `#private` field, so
there is no back-reference to walk. `config(newConfig)` returning `this` is closed by
`wrapIfClient`'s prototype-based test, and `Patch.clone()` / fluent chaining are re-wrapped.

**`dataRequest` coverage.** `_dataRequest` (`@sanity/client` `dist/index.js:918`) issues a POST only
when the endpoint is `mutate`/`actions` or the encoded query exceeds the GET size limit; both
mutating endpoints are in `MUTATING_DATA_ENDPOINTS` and intercepted, including the `resource:`-scoped
spelling, which shares the same `endpoint` token.

---

## §6 — verdict on `preview-write-impossibility.md`

Its claims were re-derived rather than restated. **The document is accurate, and its §5 conclusion —
*"Genuinely impossible in a deployed preview today: nothing"* — is right.** Everything it lists as
best-effort really is defeatable from the same JS context, and the mechanism it names is real: I
confirmed that `wrapped.config()` returns `{...clientConfig}` including `token` by design
(`facade.ts:876-881` deliberately keeps it a plain object), so a facade escape is not even necessary
for an adversary with page JS. Its vector table's `⚠️` markings for the facade layer are correctly
scoped as best-effort, and the `config(newConfig)` fix it records as closed is closed.

Two corrections to fold in when it is next revised:

1. **Vector 3 is not fully closed.** The fix is described as structural ("any method whose return
   value IS a `@sanity/client` is re-wrapped"). P1-3 above is the same class through a channel the
   structural rule does not cover — a client-bound capability passed *into* a call. The row should
   read `⚠️ partially closed` until that is fixed.
2. **The "After §6" column is optimistic for rows 4, 5 and 6.** Those rows are closed by the
   *packaged* guard `previewWriteGuard.ts`, which carries P1-1 verbatim. Until the normalisation is
   fixed there, the deployed-preview server-side layer has a hole in the exact place the document
   says it will not.

Its §8 "still needs a browser check" list remains outstanding and unchanged, and its §9 mutation-check
table (M1-M14) is the right shape of evidence — note that none of M12-M14 would have gone red for
P1-1, because the mutation was applied to the *policy* rather than to the *normaliser*.

---

## Gate assessment

| §5.5 requirement | Status |
| --- | --- |
| No unresolved **P0** | Met — none found. |
| No unresolved **P1** | **Not met — three open (P1-1, P1-2, P1-3).** |
| (informational) P2 / P3 | 2 P2, 6 P3 — none gate the exit. |

**Phase 9 exit should not be signed today.** All three P1s are narrow, well-localised fixes with a
clear red-test-first path, and none of them requires a design change. P1-1 is the one to fix first:
it is a two-line change in two files plus contract cases, it is duplicated in the classifier the
deployed-preview architecture depends on, and the project's own independent audit oracle already
flags it as an A5 disagreement.
