# Preview write impossibility — threat model

**Requirement (owner, 2026-08-06):** *"A preview Studio instance can never write to the Sanity API in any way. Think through all edge cases and ensure it's not possible."*

**Clarification (owner, same day):** the goal is **not** to cut the Studio off from Sanity. Reads and authentication must keep working. The requirement is that there is *no path to writing* — everything is intercepted.

**Standard applied:** a motivated attacker with page-level JavaScript execution and a logged-in editor's session. Every layer not tested is assumed not to work.

**Honest headline:**

> In **local development** through `spikeB-proxy`, writes are stopped by a default-deny network guard and this holds against the stated threat model.
>
> In a **deployed preview today**, they are **not**. The proxy does not exist there, no CSP is served, and every remaining control is client-side and defeatable by page JS holding the editor's own token. The gap is closed by three concrete, named pieces of work — §6 — two of which are now built and packaged, and one of which belongs to `sanity-overlay-next`.

---

## 0. The premise: the browser already holds a write-capable credential

This is the fact the whole model turns on, and it is read out of the shipped packages rather than assumed.

| Claim | Source | Pinned by |
| --- | --- | --- |
| The Studio stores a per-project auth token in `localStorage` under `__studio_auth_token_<projectId>`, value `{token?: string}` | `sanity@6.8.0` `lib/WorkspaceLoader-BRx2afZV.js:1979` (`getAuthTokenStorageKey`), `createLocalStorageStorage` immediately below | `preview-write-impossibility.test.ts` §0 |
| That token is handed to `@sanity/client` and sent as `Authorization: Bearer …` | `_createAuthStore` → `clientFactory({...AUTH_CLIENT_OPTIONS, token})`; `@sanity/client@7.26.0` `config().token` | `preview-write-impossibility.test.ts` §0 |
| The token carries the **editor's own grants**, including write | It is the credential the Studio uses to publish today | — |

Consequences, stated plainly:

- **No environment variable revokes it.** A read-only token in Vercel env constrains the *server*; it does not touch what the browser holds.
- **No wrapper around `@sanity/client` survives a script that never uses the client.** `fetch`, `XMLHttpRequest`, `sendBeacon` and `WebSocket` are all one line away and all accept a bearer header.
- Therefore **the facade is not, and cannot be, the answer.** It is worth having — see §4 — but presenting it as a guarantee would be a claim our code cannot keep.

---

## 1. The three enforcement layers

| Layer | Who enforces | Can page JS defeat it? |
| --- | --- | --- |
| **Browser-enforced** — CSP `connect-src` confining the page to our own origin | The browser. Not our code, cannot be argued with. | **No.** |
| **Server-enforced** — the default-deny write guard on our origin, plus a read-only token for anything the server does itself | Our server, and Sanity for the token scope | **No**, provided the page cannot reach Sanity directly (which is what the browser layer buys). |
| **Best-effort** — the client facade, `stagingHost.ts`, the browser write barrier | Our own code, running in the same JS context as the attacker | **Yes, trivially.** |

### Why `connect-src` is not "block Sanity"

`connect-src` is **origin-scoped, never method-scoped**. It cannot distinguish a read from a write. A policy excluding `*.api.sanity.io` outright would take reads *and authentication* down with it, which is not the requirement.

The shape that satisfies the requirement:

1. **Every Sanity request — reads and auth included — leaves through our own origin.** The deployed equivalent of `spikeB-proxy/proxy.mjs`. Auth survives because the proxy forwards it; `/users/me` already returns 200 through the local proxy today.
2. **The default-deny write guard runs there**, server-side, where page JS cannot reach it.
3. **`connect-src` then confines the page to our origin.** This is what makes (1) and (2) non-optional rather than a suggestion: without it the guard is a speed bump; with it the guard is the only door.

---

## 2. Local dev vs deployed preview — the structural difference

| | Local dev (`spikeB-proxy`) | Deployed preview **today** | Deployed preview **after §6** |
| --- | --- | --- | --- |
| All Sanity traffic forced through our origin | ✅ via `apiHost` → `localhost:3999` | ❌ browser talks to Sanity directly | ✅ via `apiHost` → our origin |
| Default-deny write guard | ✅ `writeGuard.mjs` | ❌ does not exist | ✅ `previewWriteGuard.ts`, mounted by `sanity-overlay-next` |
| RFC 6455 frame inspection on the bifur socket | ✅ `createRealtimeFrameGuard` | ❌ | ⚠️ serverless cannot proxy WebSocket — the socket is **refused** by CSP instead (§5 vector 9a) |
| CSP `connect-src` | ❌ (not needed: nothing else runs on the page) | ❌ | ✅ `previewCsp.ts` |
| Server-side read-only token | n/a | ❌ | ✅ operator-supplied |

`apiHost` is the switch that moves the boundary. `resolveOverlayOptions` now **warns loudly** when it is unset in overlay mode (naming that every control is then client-side and best-effort) and **throws** when it points at a real Sanity host — a "proxy" that is the thing being proxied looked correctly configured while enforcing nothing.

---

## 3. Vector table

Scored against: *can this reach Sanity with a write?* — first as things stand in a deployed preview, then under the §6 architecture.

| # | Vector | Stopped by | Exists today (local) | Exists today (deployed) | After §6 |
| --- | --- | --- | --- | --- | --- |
| 1 | `@sanity/client` created outside our factory (third-party plugin, or one bundling its own copy) | CSP + server guard | ✅ proxy | ❌ **open** | ✅ browser + server |
| 2 | Raw `fetch` / `XHR` / `sendBeacon` to `*.api.sanity.io` with the editor's token | CSP + server guard; barrier (best-effort) | ✅ proxy | ⚠️ barrier only | ✅ browser + server |
| 3 | `withConfig({apiHost})` / `clone()` / **`config(newConfig)`** re-pointing a client back at Sanity | Facade (best-effort) + CSP + server guard | ✅ | ⚠️ **was open — now closed in the facade**, §4 | ✅ |
| 4 | `resource:`-configured client (`/projects/<p>/datasets/<d>/mutate`, no `/data/` prefix) | Server guard; facade | ✅ | ⚠️ facade only | ✅ |
| 5 | `createVersion` / `replaceVersion` / `discardVersion` / `unpublishVersion` (call `_dataRequest` directly) | Facade refusal + server guard | ✅ | ⚠️ facade only | ✅ |
| 6 | `client.assets.upload`, `client.agent.action.*`, `client.datasets.*`, `client.releases.*` | Facade namespace policy + server guard | ✅ | ⚠️ facade only | ✅ |
| 7 | Studio's own egress: `descriptors/claim`, `intake/batch`, **`intake/feedback`** | CSP + server guard; barrier | ⚠️ **feedback escaped the proxy** | ❌ **open** | ✅ browser |
| 8 | `apiHost` unset or blank → traffic goes direct | Startup refusal / warning | ✅ blank→unset | ⚠️ **now warns**; Sanity-valued `apiHost` **now throws** | ✅ |
| 9a | WebSocket (`wss://…/socket/<ds>`, `@sanity/bifur-client`, declares a `mutate` RPC method) | Frame guard (local) / CSP (deployed) | ✅ frame guard | ❌ **open** | ✅ browser (connection refused) |
| 9b | Service worker, iframe, popup to a sanity.io origin | CSP `worker-src` / `frame-src` / `child-src` | ❌ | ❌ **open** | ✅ browser |
| 9c | Form POST (`connect-src` does not govern it) | CSP `form-action` | ❌ | ❌ **open** | ✅ browser |
| 10 | Other Sanity-owned origins (`apicdn.sanity.io`, `sanity-cdn.com`, `api.sanity.work`) | CSP origin inventory | partial | ❌ **open** | ✅ browser |
| 11 | Write token reachable from the browser bundle | Startup refusal (§7) | ⚠️ **name check had a fail-open — now fixed** | ⚠️ same | ✅ |

**Legend:** ✅ closed by a layer page JS cannot defeat · ⚠️ closed only by our own code (best-effort) · ❌ not closed.

### Notes on individual vectors

**Vector 3 — a live escape, now closed.** `SanityClient.config(newConfig)` *mutates in place and returns `this`* (`@sanity/client@7.26.0` `SanityClient.ts:1220-1236`). It was not in `CLONING_METHODS` — nothing new is constructed, so it did not look like a clone — so it fell through to the facade's default branch and handed the caller the **raw** client. One line defeated the entire facade, and re-pointed the client at Sanity on the way past:

```js
wrapped.config({apiHost: 'https://api.sanity.io'}).mutate([…])
```

`ObservableSanityClient.config` was the identical hole one level down. Spike F recorded the request shape as **attack 17** — where the *proxy* stops it. There is no proxy in a deployed preview, so it was live. See §4 for the fix and why it is structural rather than a list entry.

**Vector 7 — the escape that already happened.** `sanity@6.8.0` `lib/index.js:1431`:

```js
FEEDBACK_TUNNEL_URL = "https://api.sanity.io/vX/intake/feedback"
```

handed to a Sentry `BrowserClient` with `transport: makeFetchTransport`. A raw `fetch` POST to an **absolute** URL — outside `@sanity/client`, therefore outside the facade, and immune to `apiHost` injection. That is why a live CDP capture caught four of them going direct past the proxy. Its sibling `/intake/batch` additionally leaves via `navigator.sendBeacon` (`lib/index.js:13064`). Treat these as proof that the direct path is real, not theoretical.

**Vector 9a — the socket is a two-way channel.** `sanity@6.8.0` `lib/WorkspaceLoader-BRx2afZV.js:8300-8303` builds `wss://<p>.api.sanity.io/v2022-06-30/socket/<ds>` and hands it to `@sanity/bifur-client@1.0.0`, whose `RequestMethod` union (`src/types.ts:6-15`) includes **`'mutate'`**. No shipped code path calls it, but the client is exposed to page JS as `__internal.bifur` and nothing between that object and Content Lake checks anything. Also note `getBifurClient` reads `client.withConfig(...).config().url` and constructs the socket **itself** — it never goes through our facade.

**Vector 11 — see §7.**

---

## 4. What was added in code, and what each layer is worth

### `packages/sanity-overlay-client/src/previewWriteGuard.ts` — SERVER-ENFORCED

The default-deny classifier, **packaged**. Until now the only implementation lived in `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs` — a local Node process, importable by nothing. This is the same policy as a package export, so a deployment's own origin can run it.

Behaviourally pinned by `runWriteGuardContract` — the same 236-case contract the proxy passes — plus a case-for-case agreement test against the proxy guard, so the two cannot drift quietly. Includes the realtime RPC method classifier (`mutate` excluded).

### `packages/sanity-overlay-client/src/previewCsp.ts` — BROWSER-ENFORCED

Generates the policy and, more importantly, **validates** one. `cspPermitsSanityConnection(header, url)` implements real CSP host-source semantics — wildcard labels, scheme upgrade allowances, `default-src` fallback, first-declaration-wins — because a substring check would report a policy as safe in the dangerous direction. Every uncertainty resolves toward `true` ("this policy does *not* protect you"): an absent directive is unrestricted.

`previewCspDirectives()` **refuses to emit** a policy whose `connect-src` would admit a Sanity origin, checked against a deliberately wide origin inventory (`SANITY_BROWSER_ORIGINS`). Also closes vectors 9b and 9c: `frame-src`, `child-src`, `worker-src`, `form-action`, `base-uri`, `object-src 'none'`.

**This is an assertion on a configuration artifact. It does not prove a browser honours it** — see §8.

### `packages/sanity-overlay-client/src/browserWriteBarrier.ts` — BEST-EFFORT

Patches `fetch`, `XMLHttpRequest.prototype.{open,send}`, `navigator.sendBeacon` and `WebSocket` to refuse unsafe-method traffic to Sanity hosts. It catches vector 7 — the Sentry tunnel and the beacon — which is Studio's own accidental egress and the traffic that actually escaped.

`EventSource` is deliberately **not** patched: it can only ever issue a GET, so refusing it would break `client.listen()` and Live Events while closing nothing.

It is defeatable in two lines (`iframe.contentWindow.fetch`). The test suite carries that as an explicit **negative control** so no reader can mistake the barrier for enforcement. Its ledger is a diagnostic; an empty ledger is not evidence.

### `packages/sanity-overlay-studio/src/client/facade.ts` — BEST-EFFORT

The vector-3 fix. Not "add `config` to the list" — the list is an inventory and Spike F's standing lesson is that an inventory is never complete. Instead: **any** return value that *is* a `@sanity/client` is re-wrapped, in the main proxy, in namespace proxies and in fluent builders. A future `this`-returning method is covered on arrival. `isSanityClientInstance` is prototype-based, so `config()` with no argument still returns a plain configuration object rather than a proxy.

A companion test walks the **real shipped class** and asserts no probed method hands back the raw client — the oracle is `@sanity/client`, not a list in our test file. A second test asserts `NAMESPACE_ROOTS` covers every namespace-shaped property of a real client, so a `@sanity/client` release adding `client.canvas` goes red on the next test run rather than silently exposing an unguarded plane.

### `packages/sanity-overlay-studio/src/options.ts` — startup refusals

- `apiHost` that resolves to a real Sanity API host → **throws** (host-anchored, so case / trailing dot / port / project-hostname forms all fail at once).
- `apiHost` unset in overlay mode → **warns**, naming that every control is then client-side and best-effort.
- The credential check, rewritten — §7.

---

## 5. What is genuinely impossible today vs what is only best-effort

**In a deployed preview, right now:**

*Genuinely impossible (a layer page JS cannot defeat):* **nothing.** There is no CSP and no server-side guard in the deployed path. Every control is our own code running in the attacker's JS context.

*Best-effort, and real against accidents and against non-adversarial code paths:*
- every write through a client obtained from `unstable_clientFactory`, including clones, re-configurations (now), builders, namespaces and the four version writes;
- every write through `fetch` / `XHR` / `sendBeacon` / `WebSocket` **on the patched globals**, including the Sentry feedback tunnel;
- a `StagingWriteRefusedError` before any request leaves, for anything addressed to a Sanity host with an unsafe method.

*Not closed at all:* a fresh `createClient`, a pristine `fetch`, a service worker, an iframe, the bifur socket, and any Sanity origin reached before our code loads.

**In local dev through `spikeB-proxy`:** writes are stopped by default-deny classification at the network boundary, which page JS cannot reach — with the one documented exception that `intake/feedback` bypasses the proxy entirely because its URL is hard-coded (vector 7), now additionally covered by the barrier.

---

## 6. What `sanity-overlay-next` must expose for a deployed preview to be covered

`sanity-overlay-next` today exposes the **overlay API** (`createOverlayApi`, `startOverlayApiServer` — commit / state / query / resolve). It does **not** expose a Sanity forward proxy. Three additions are required; the classifier and the CSP for them already exist and are packaged.

1. **A same-origin Sanity forward proxy handler.** `handle(Request) → Response` mounted at e.g. `/api/sanity/[...path]`, forwarding to `https://<projectId>.api.sanity.io` (and `apicdn`), preserving the `Authorization` header so **auth continues to work** — this is exactly what the local proxy does today and why `/users/me` returns 200 through it.
2. **The default-deny guard mounted on that handler**, refusing before forwarding, with `classifyPreviewRequest(...).reason` and `.path` in both the log line and the 403 body. Import `isPreviewWriteRequest` / `classifyPreviewRequest` from `sanity-overlay-client`.
3. **The security headers on every HTML response.** `previewSecurityHeaders({selfOrigin})` from `sanity-overlay-client`.

Two constraints the implementation must design around:

- **`apiHost` and the project hostname.** `@sanity/client` builds `<projectId>.<apiHost>`, so `apiHost = https://preview.example.com` yields `https://<projectId>.preview.example.com` — a *different origin*, which `connect-src 'self'` would block. Either provision a wildcard subdomain and add that exact origin to `connect-src` (it is still not a Sanity origin), or configure the Studio's clients with `useProjectHostname: false` plus the `resource:` data plane (`/projects/<p>/datasets/<d>/…`), which is genuinely same-origin. `runtime.clientFactory` already controls the options passed to `createClient`, so the second is reachable. **This decision is not made here and needs an owner ruling.**
- **WebSocket.** A serverless function cannot proxy a WebSocket upgrade, so `createRealtimeFrameGuard` has nowhere to run in a Vercel deployment. The available control is to **refuse the connection** via `connect-src` (Studio loses presence; it does not lose editing). If real-time presence is required, the proxy needs a runtime with raw socket access.

---

## 7. The token check — a confirmed fail-open, fixed

**Before:** `WRITE_TOKEN_PATTERN = /WRITE_TOKEN$/` in `options.ts`. Measured:

```
CAUGHT   SANITY_WRITE_TOKEN, SANITY_STUDIO_WRITE_TOKEN, SANITY_API_WRITE_TOKEN
MISSED   SANITY_API_TOKEN, SANITY_TOKEN, SANITY_DEPLOY_TOKEN
```

`SANITY_API_TOKEN` is the name **Sanity's own documentation uses most** — the single likeliest way a write-capable credential arrives in a preview was the one spelling the check could not see. The check tested a naming convention, and the wrong half of it.

**After:** `classifyTokenEnvKey(key)` → `'not-a-credential' | 'read-only' | 'write-capable-or-unknown'`, along three axes:

- **credential noun**, anchored at the end of the name: `TOKEN | SECRET | API_KEY | APIKEY | CREDENTIAL(S) | PASSWORD | PAT`. (`SANITY_API_VERSION` is not one.)
- **Sanity scoping**, as a *name label* never a substring — `INSANITY_TOKEN` and `SANITYX_TOKEN` are somebody else's credentials, and refusing them would make the check a nuisance that gets disabled. `GITHUB_TOKEN`, `NPM_TOKEN`, `VERCEL_TOKEN` are untouched. A bare `…WRITE_TOKEN` is still caught regardless of scoping, preserving the old behaviour.
- **read-only escape hatch**, also label-matched: `READ | READONLY | READ_ONLY | VIEWER`. `SANITY_ALREADY_TOKEN` and `SANITY_BREADCRUMB_TOKEN` contain the letters "read" and assert nothing; both are refused.

Rules: `write-capable-or-unknown` **throws**; `read-only` is allowed (it is the recommended server-side architecture) but **warns** if it carries a browser-reachable prefix (`SANITY_STUDIO_`, `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`), because that value is compiled into JavaScript served to every visitor. Inert in `mode: 'off'`.

**Why it is still name-based.** Capability cannot be read off a name; establishing it means asking Sanity, which is a **network call at startup**. A probe that fails open when the network is down would answer "no write token" for precisely the reason it could not tell — worse than no probe, because it looks like evidence — and it would put a boot-time round trip on the critical path of every Studio load. **Decision: name-based, fail closed.** A Sanity-scoped credential whose name does not positively say read-only is treated as write-capable. The cost is a false positive on an oddly-named read token: loud, at startup, one rename from fixed.

`classifyTokenEnvKey` and `isBrowserReachableEnvKey` are exported so a deployment check and a CI scan ask the same question the Studio asks, rather than three that drift.

---

## 8. What still needs a browser check

None of the browser-enforced column has been observed in a browser. Specifically outstanding:

1. **Does the generated CSP actually block a direct `fetch` to `api.sanity.io` from the preview page?** Assert from the DevTools console, not from our own code.
2. **Does the Studio still authenticate and read with `connect-src 'self'`** and all Sanity traffic routed through our origin? This is the load-bearing product question and the reason the "block Sanity outright" framing was dropped.
3. **What breaks when the bifur socket is refused?** Expected: presence indicators disappear. Confirm editing, publishing-interception and the document pair listener are unaffected.
4. **Does `sanity-cdn.com` being outside `connect-src` break Studio auto-updates?** If so, auto-updates must be disabled in preview builds (they should be anyway — a preview should run the code it was built from).
5. **Server-side log confirmation.** Per the standing rule in this project — *server-side logs are the only trustworthy escape evidence* — the acceptance test is a proxy log showing zero forwarded writes across a full editing session, **not** a browser-side "0 direct requests" claim. Browser-side detection has produced a false all-clear three times here.

---

## 9. Verification record

**Suite:** 113 files / 7718 tests, 0 failures. Baseline before this work: 111 files / 7336 tests, 0 failures.

**New tests:** `preview-write-impossibility.test.ts` (77), `preview-write-guard.test.ts` (267 — the 236-case shared write-guard contract plus 31 of its own), plus additions to `studio-options.test.ts` (68 total) and `studio-config.test.ts` (27 total).

**Mutation checks** — every load-bearing control broken, confirmed red, restored, confirmed green, restore verified byte-identical:

| Mutation | Broken | Restored |
| --- | --- | --- |
| M1 facade `wrapIfClient` (the `config()` fix) | 4 failed / 73 passed | 0 / 77 |
| M2 token check — widened classifier reverted to `/WRITE_TOKEN$/` | 17 failed / 78 passed | 0 / 95 |
| M3 token check — read-only match loosened to a substring | 1 failed / 67 passed | 0 / 68 |
| M4 `apiHost` Sanity refusal disabled | 6 failed / 71 passed | 0 / 77 |
| M5 CSP validator — "absent directive is unrestricted" inverted | 1 failed / 76 passed | 0 / 77 |
| M6 CSP validator — host-source wildcard matching disabled | 4 failed / 73 passed | 0 / 77 |
| M7 CSP builder — refusal to emit a Sanity-admitting policy removed | 1 failed / 76 passed | 0 / 77 |
| M8 browser barrier — `fetch` refusal disabled | 2 failed / 75 passed | 0 / 77 |
| M9 browser barrier — `sendBeacon` refusal disabled | 1 failed / 76 passed | 0 / 77 |
| M10 browser barrier — `WebSocket` refusal disabled | 1 failed / 76 passed | 0 / 77 |
| M11 browser barrier — `XMLHttpRequest` refusal disabled | 1 failed / 76 passed | 0 / 77 |
| M12 preview guard — default-deny floor made default-allow | 5 failed / 339 passed | 0 / 344 |
| M13 preview guard — dot-segment ambiguity rule disabled | 6 failed / 261 passed | 0 / 267 |
| M14 preview guard — `mutate` added to the realtime allowlist | 1 failed / 266 passed | 0 / 267 |

**Still green:** `no-staging-writes.test.ts`, `studio-guard-refusals.test.ts`, `write-guard.test.ts` (the proxy's contract run) — the owner's ruling that this system never writes to a real Sanity dataset is unchanged and unweakened.
