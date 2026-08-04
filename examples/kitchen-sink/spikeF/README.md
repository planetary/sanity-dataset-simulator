# Spike F — attack pass against the local-echo write-block facade

PRD **§36.6** (safety and trust boundary), threat list **§26.9**, safety success **§5.2**,
hard safety guards **§11.3**, stop criteria **§0.6**.

`attackPass.ts` exports `runAttackPass(): Promise<AttackReport>`: 27 scored attacks that each
try to mutate the Sanity dataset `parity` (project `b1n03q3z`) through a different escape hatch
from the write-block facade in `../spikeA/localEcho.ts`. **A successful attack is a security
hole, not a passing test.**

Everything here is new and additive. No existing file was modified.

---

## Running it

### Preconditions

1. The Studio must be running from source — `pnpm --dir examples/kitchen-sink dev` (Vite dev
   server on `http://localhost:3333`). The suite is loaded as a raw `.ts` module from the dev
   server; a production `sanity build` bundle cannot serve it.
2. The facade must be installed: `localStorage.SPIKE_LOCAL_ECHO = '1'`, then **reload**, then
   open any document pane so the Studio constructs its client. The suite refuses to run
   otherwise (see *Preflight* below) — without the facade every attack would write for real.
3. Capture Spike A evidence **before** running this. The attacks add entries to
   `window.__SPIKE_A__.calls` / `window.__SPIKE_ECHO__.blocked`, so the "548 calls, stable"
   figure in `write-block-validation.md` is only reproducible on a clean page load.

### Invocation (browser)

Two steps, because a module namespace object is not serializable across the CDP boundary. The
module registers itself on `window.__SPIKE_F__` at import time.

```js
// step 1 — load the module (Vite transforms the TS on demand)
await import('/spikeF/attackPass.ts')

// step 2 — run it
const report = await window.__SPIKE_F__.runAttackPass()
```

Playwright / chrome-devtools MCP:

```js
await page.evaluate(() => import('/spikeF/attackPass.ts').then(() => true))
const report = await page.evaluate(() => window.__SPIKE_F__.runAttackPass())
// also available afterwards as window.__SPIKE_F__.lastReport
```

The suite takes roughly 25–45 s (27 attacks × a 450 ms settle window, plus real network
round-trips for whatever gets through). It never throws: every attack is individually guarded
and one failure cannot abort the run.

### Optional knobs

| Global | Effect |
|---|---|
| `window.__SPIKE_F_CLIENT__` | Hand the suite the exact client instance to attack. Skips discovery. |
| `window.__SPIKE_F_FORCE__ = true` | Skip the preflight guard. **Control run only** — with the facade off, attacks 1–16 will write for real (all canary ids, all listed in `cleanup`). Useful to prove the attacks are not no-ops. |

### Preflight

If `localStorage.SPIKE_LOCAL_ECHO !== '1'` or `window.__SPIKE_ECHO__.enabled !== true`, the
report contains a single `00.preflight` entry explaining what is missing and nothing is
attempted. Treat that as "the run did not happen", not as a pass.

---

## How a verdict is reached

`blocked: true` means **no write request reached an authorized endpoint**. Three independent
detectors feed that decision:

1. **Facade record** — a new entry in `window.__SPIKE_ECHO__.blocked` (method + `handled` flag).
2. **Transport taps** — `window.fetch` *and* `XMLHttpRequest.prototype.open/send` are wrapped for
   the duration of the run (both restored afterwards), recording URL, method and status.
   Wrapping only `fetch` would have been useless: **`get-it`'s browser adapter uses
   `XMLHttpRequest` whenever it exists**, so in a real browser every Sanity mutation is an XHR.
   Only `/data/listen` goes over `fetch`. This matters for any future network-layer guard as
   much as it does for this evidence tap.
3. **Resource timing** — `performance.getEntriesByType('resource')` deltas filtered to
   `/data/mutate`, `/data/actions`, `/assets/`, `/agent/action/` (plus `/datasets` for the
   sub-client probe), with `responseStatus` where the browser exposes it. Catches anything that
   used neither tapped transport.
4. **The server's own answer** — decisive and transport-independent: if the thrown error carries
   an HTTP status, a Sanity `traceId` or a permissions/not-found body, the request provably
   reached the endpoint. This is what catches an escape even if both taps miss it.

A request that reached the endpoint and was rejected **401/403 by the server** is still reported
as `blocked: false`. §36.6 requires the write to fail *before* reaching an authorized endpoint;
"the server happened to say no" is not a guard we control.

Two softer verdicts appear in `evidence`, both with `blocked: true`:

- `severity: 'low'` — "no egress, but the facade did not record it — the call failed
  client-side". Nothing guarded the call; it died locally (bad payload, missing sub-client). Not
  a clean pass — repair the local failure and it may well escape.
- `severity: 'medium'` — "no egress and no facade record — unexplained". Verify by hand.

`summary.holes` counts unexpected holes (things to fix). `summary.expectedHoles` counts the
attacks we predicted cannot be stopped by a client-side facade at all. Entries with
`category: 'verification'` (`00.clientDiscovery`, `28.verify.persistedCanaries`) are excluded
from the counts.

---

## The attacks, and the prediction for each

Predictions were made by reading `localEcho.ts` and `@sanity/client@7.26.0` before running
anything. "expected-hole" is a claim about architecture, not about this implementation.

### Blocked by design — a failure here is a real regression (§36.6 core property)

| # | Attack | What it proves | Prediction |
|---|---|---|---|
| 01 | `client.create()` | §36.6 "attempt client.create through facade" | blocked (`WRITE_METHODS`) |
| 02 | `client.createOrReplace()` | separate method on the allowlist | blocked |
| 03 | `client.createIfNotExists()` | separate method on the allowlist | blocked |
| 04 | `client.delete()` | destructive write path | blocked |
| 05 | `client.mutate([...])` promise | raw mutation array | blocked (echoed, `handled=true`) |
| 06 | `client.observable.mutate(...)` | the observable client is a *different object*; subscribing is what fires the request | blocked (`observable` is re-proxied) |
| 07 | `client.patch(id).set().commit()` | builders bind to the **real** client — the facade author flagged this | blocked (`blockFluentCommit`, `handled=false`) |
| 08 | `client.transaction().…commit()` | same | blocked, not echoed |
| 09 | `client.action({publish})` | facade blocks publish but does **not** echo it | blocked, `handled=false` |
| 10 | `client.withConfig({apiVersion}).observable.action(...)` | Studio's *actual* write path (localEcho note 4) | blocked |
| 11 | `client.request({url:'/data/mutate/parity'})` | raw request escape | blocked (`WRITE_URL_RE`) |
| 12 | `client.dataRequest('mutate', …)` | Studio's live-edit path | blocked |
| 13 | `client.dataRequest('actions', …)` | Actions API one level down | blocked |
| 14 | `client.withConfig({dataset:'scratch'}).create()` | §11.3 "endpoints accept only the configured dataset" — does a dataset-swapped clone escape? | blocked (clone re-wrapped) |
| 15 | `client.withConfig({apiVersion:'2021-03-25'}).mutate()` | clone via config change | blocked |
| 16 | `client.clone().mutate()` | clone escape | blocked |

### Facade gaps found by reading `localEcho.ts` — predicted **holes**, and they are fixable

| # | Attack | Why it escapes | Severity |
|---|---|---|---|
| 17 | `client.clone().config({}).create()` | **`SanityClient.config(newConfig)` returns `this`** — the raw, unproxied client (`index.browser.js:2761`). `config` is not in any of the facade's special-cased branches, so the default wrapper hands the target straight to the caller. One call and the facade is gone. Run against a `clone()` so the live Studio client is never reconfigured. | critical |
| 18 | `client.patch(id).set().clone().commit()` | `blockFluentCommit` only re-wraps a return value when `result === target`. `Patch.clone()` returns a **new** `Patch` still holding the real client (`#client.mutate(...)`). | high |
| 19 | `client.transaction().…clone().commit()` | identical for `Transaction.clone()` | high |
| 20 | `client.request({url:'data/mutate/parity'})` | **leading-slash bypass**: the facade matches `/\/data\/(mutate\|actions)\b/`, but `_getUrl` does `uri.replace(/^\//, '')` — so a URL without the leading slash is the same endpoint and does not match the guard. | high |
| 21 | `client.request({url:'/assets/images/parity', method:'POST'})` | `WRITE_URL_RE` covers only `/data/mutate` and `/data/actions`; the asset endpoint is not guarded on the `request()` path either. Sends a text body deliberately, so it cannot create an asset — reaching the endpoint is the finding. | high |
| 22 | `client.assets.upload('image', <1×1 png>)` | `client.assets` is an **object property, not a function**, so the facade's `typeof value !== 'function'` branch returns it untouched, and `AssetsClient` holds the real `httpRequest`. Already known (`write-block-validation.md` finding 8) — marked `expectedHole` for that reason, but it is fixable. **May create a real asset**; the id lands in `cleanup`. | high |
| 23 | `client.agent.action.patch({...})` | same sub-client class of bug, previously unlisted: Agent Actions write documents via `POST /agent/action/patch/<dataset>` and call the module-level `_request` directly. Blocked by neither the facade **nor the Spike B proxy**, whose allowlist explicitly passes `/agent/*` through. | high |
| 24 | `client.datasets.list()` | non-destructive reachability probe for the same class: an unwrapped sub-client reaching the network proves `datasets.create()` / `.delete()` would too — a *project-plane* mutation the facade cannot even see. | medium |

### Expected holes — a facade cannot fix these (§0.6, argument for the network guard)

| # | Attack | Why it is architectural |
|---|---|---|
| 25 | `createClient({projectId, dataset, token}).create(...)` | A brand-new client never touches the facade. The only question is whether page JS can reach a write-capable credential — see 27. This is the §0.6 finding "staging write protection depends on branch-controlled code behaving honestly": it does not, and cannot. |
| 26 | `fetch('https://b1n03q3z.api.sanity.io/v.../data/mutate/parity', {method:'POST'})` | §26.9 "preview calls native Sanity mutation endpoint" / "cross-site mutation request". Uses the discovered bearer token, or `credentials: 'include'` when there is none. |
| 27 | Credential scan (localStorage / sessionStorage / window / cookies / `client.config().token`) | §5.2 "preview deployments contain no Sanity write token". In a Studio this is *by design*: `localStorage.__studio_auth_token_<projectId>` holds the user's session token, and `client.config()` hands the token to any caller. `blocked` here means "no write-capable credential is reachable from page JS". |

### Verification entries (not scored)

| # | Entry | Purpose |
|---|---|---|
| 00 | `clientDiscovery` | Records how the client under attack was obtained: an injected handle, a **React fiber walk that finds the live Studio client** (which is itself a finding — any injected script can drive it), or `spikeClientFactory()`. The factory path constructs the client exactly as `unstable_clientFactory` does, so the facade is tested faithfully, but Studio-instance reachability is *not* proven. |
| 28 | `verify.persistedCanaries` | Server-side read-back of `*[_id match "spike-f-canary-*"]` plus assets by filename. This is the independent proof that a write actually landed in Content Lake, and it seeds `cleanup`. |

---

## Reading the result

- `summary.holes === 0` **and** `summary.expectedHoles` limited to 25/26/27 → the facade is doing
  everything a facade can do.
- Any of 01–16 with `blocked: false` → **regression in the facade**; the Spike A pass claim in
  `write-block-validation.md` no longer holds.
- 17–24 with `blocked: false` → the gaps documented above. 17, 18, 19, 20 and 21 are ordinary
  bugs in `localEcho.ts` and should be fixed there; 22, 23, 24 are the sub-client class and need
  a structural fix (wrap object properties too, or drop the facade in favour of the network
  guard).
- 25, 26, 27 with `blocked: false` → **expected**, and is the evidence for the §0.6 pivot line:
  *"Staging write protection depends on branch-controlled code behaving honestly while untrusted
  fork code receives secrets → move credentials into an isolated overlay gateway or disable
  writable preview editing for that trust class."*

### §36.6 pass-criteria mapping

| §36.6 task | Covered by |
|---|---|
| Attempt `client.create` through facade or proxy | 01–03, 14, 17, 25 |
| Attempt raw native mutation request | 11, 12, 13, 20, 26 |
| Attempt plugin direct mutation | 06, 07, 08, 18, 19, 23, and `00.clientDiscovery` (a plugin can reach the live client through React internals) |
| Attempt asset direct upload | 21, 22 |
| Attempt dataset override | 14 (facade) and 25 (fresh client) |
| Inspect network logs | every attack's `evidence` carries method + URL + HTTP status from three detectors |
| Remove write token from preview environment | 27 (`tokensFound`) — this suite reports reachability; removing the token is an environment change |
| Fork fixture / isolated-gateway route | **not covered** — deployment-level tasks, out of scope for an in-page suite |

| §36.6 pass criterion | Verdict source |
|---|---|
| Every staging write fails before reaching an authorized endpoint | `summary.holes === 0` **and** attack 28 finds nothing persisted |
| Fork and untrusted preview code cannot access protected credentials | attack 27 `blocked === true` |
| Core overlay editing still works for the approved trust class | *not* covered here — that is the Spike A evidence (`write-block-validation.md`) |

---

## Cleanup

Everything a successful attack can create is prefixed `spike-f-canary-` and, if a write actually
went out, listed in `report.cleanup`. Attack 28 additionally reads the dataset back, so the list
covers anything the per-attack detectors missed.

```bash
cd examples/kitchen-sink

# what exists
./node_modules/.bin/sanity documents query '*[_id match "spike-f-canary-*"]._id' --dataset parity

# delete (ids from report.cleanup)
./node_modules/.bin/sanity documents delete --dataset parity <id> [<id> ...]
```

Asset ids (`image-…`) in `cleanup` need `sanity documents delete` too, and only after any
referencing document is gone.

---

## Caveats

- **Attribution window.** Network hits are attributed to whichever attack was running. If the
  Studio itself emits a write-endpoint request during a 450 ms settle window (e.g. an asset
  upload in another tab of the same page), it could be misattributed. Run with no pending
  editor changes; the matched URLs are printed in `evidence` so misattribution is visible.
- **Spike A counters move.** Attacks run through the instrumented client, so
  `__SPIKE_A__.calls` and `__SPIKE_ECHO__.blocked` grow. Capture Spike A evidence first.
- **The client under attack may not be Studio's.** Check `00.clientDiscovery` before claiming
  anything about reachability of the live instance.
- **Node smoke runs are not faithful.** The harness can be exercised under `tsx` with stubbed
  globals, but Node resolves `@sanity/client`'s node build (a different transport, no XHR, no
  resource timing) and rejects a `Blob` request body, so attack 22 cannot be exercised there.
  Browser results are the evidence.
