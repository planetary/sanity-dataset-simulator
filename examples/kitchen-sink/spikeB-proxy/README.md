# Spike A · Track B — HTTP API host / transport proxy

PRD §36.1 Track B. A dependency-free Node 22 reverse proxy that puts a controlled
API boundary between the pinned Studio (`sanity dev`, http://localhost:3333) and
`https://b1n03q3z.api.sanity.io`.

Everything here is **new, additive, and self-contained**. No existing file in
`examples/kitchen-sink` was modified — in particular `sanity.config.ts` is untouched;
the config change needed to route the Studio through the proxy is documented below
for the orchestrator to apply deliberately.

> ### Two modes
>
> Everything in **this** file describes **Mode 1 — proxy**: a real Sanity project,
> a real login, real grants, with only the data plane intercepted. It is the
> default and nothing about it has changed.
>
> There is also **Mode 2 — origin** (`--origin` / `OVERLAY_BASE=none`): no Sanity
> project, no account, no upstream at all. The server answers every request from
> `.sanity-overlay/` on disk, hands out a fabricated fully-granted `local-dev`
> identity, and refuses to bind anything but loopback.
>
> **Mode 2 is documented separately in [`ORIGIN.md`](./ORIGIN.md)** — what it
> serves, what it deliberately does not, and the safety controls that make a
> synthetic-identity server acceptable to run at all.

## Run

```bash
# read-only observation mode (writes still reach Content Lake)
node examples/kitchen-sink/spikeB-proxy/proxy.mjs

# overlay mode — the interesting one: all Content Lake writes are rejected locally
PROXY_BLOCK_WRITES=1 node examples/kitchen-sink/spikeB-proxy/proxy.mjs
```

| Env | Default | Purpose |
|---|---|---|
| `PROXY_PORT` | `3999` | Listen port. |
| `PROXY_BIND` | all interfaces (v4+v6) | Bind address. Leave unset so both `127.0.0.1` and `::1` work — Chrome may resolve `*.localhost` to either. |
| `SANITY_API_HOST` | `https://b1n03q3z.api.sanity.io` | Upstream origin. |
| `PROXY_BLOCK_WRITES` | off | `1` enables the write guard (below). |
| `PROXY_DERIVE_PROJECT_HOST` | on | Maps `<label>.localhost` → `<label>.api.sanity.io`. See "Project-hostname trap". |
| `PROXY_FORWARD_ORIGIN` | off (stripped) | `1` forwards the browser `Origin`/`Referer` upstream. Default strips them so Sanity sees a server-side call and does not apply its own CORS-origin allowlist. |
| `PROXY_REWRITE_COOKIES` | on | Strips `Domain=` and `Secure` from upstream `Set-Cookie`. Best-effort only — see "Cookies". |
| `PROXY_LOG` | `./proxy-log.jsonl` | JSONL request log. |
| `PROXY_VERBOSE` | off | Mirror each log line to stderr. |

### Request log

One JSONL line per request, written synchronously so a `SIGTERM` mid-run cannot lose evidence:

```json
{"at":"2026-08-04T04:52:10.362Z","method":"POST","path":"/v2025-02-19/data/actions/parity","status":403,"ms":0,"blocked":true}
```

`path` excludes the query string (GROQ queries and tokens are not logged).

## Write guard (`PROXY_BLOCK_WRITES=1`) — **default-deny**

Rejects with `403` and body `{"error":{"code":"OVERLAY_WRITE_BLOCKED", ...}}`.

The policy is inverted from the obvious one. An earlier version of this guard enumerated the
*write* endpoints (`/data/mutate`, `/data/actions`, `/assets/*`, …) and passed everything else;
Spike F showed that requires the author to have heard of every write endpoint Sanity ships, and
they had not — `POST /projects/<p>/tokens`, `PUT /users/me/keyvalue/<k>`,
`POST /schedules/<p>/<d>` and `POST /descriptors/claim` all sailed through, none of them under a
guarded prefix. So the guard now asks **"is this one of the reads I know about?"** and blocks
everything else. The classifier lives in [`writeGuard.mjs`](./writeGuard.mjs); its behaviour is
pinned by `packages/sanity-overlay-testkit/src/writeGuardContract.ts`.

**Allowed** (the whole list — anything not here is blocked):

| Scope | Allowed |
|---|---|
| any path | `OPTIONS` (CORS preflight, so the browser can actually receive the 403 that follows) |
| `/data/*` and `/projects/<p>/datasets/<d>/*`, `/canvases/<id>/*`, `/media-libraries/<id>/*`, `/dashboards/<id>/*` | `GET`/`HEAD` to `query`, `doc`, `listen`, `history`, `export`, `live/events`, `ping`; plus `POST /…/query` (the long-GROQ fallback Studio really uses) |
| resource bases | `GET`/`HEAD` on the base itself, `/acl`, `/settings` |
| root namespaces | `GET`/`HEAD` to `/ping`, `/help`, `/features`, `/journey`, `/intake/telemetry-status`, `/socket`, `/schedules`, `/users`, `/projects`, `/datasets`, `/assets`, and `/agent/<id>/bundles/…` |

Consequences worth knowing before you debug a 403:

- `/agent/action/{patch,generate,transform,translate,prompt}` is **blocked whatever the verb** —
  those endpoints have no read semantics, so a `GET` probe is a write (Spike F gap 23).
  Same for `/data/mutate`, `/data/actions` and `/…/upload`.
- `GET`/`HEAD` are allowlist-only like everything else. A read endpoint nobody has observed yet
  returns 403 until it is added — a loud, local failure, deliberately preferred over reinstating
  the assumption Spike F destroyed.
- A path containing `.` or `..` segments is **never** a read. The guard matches a canonical path
  but the proxy forwards the raw request line, so `/data/mutate/<ds>/../../query/<ds>` would
  otherwise be classified as a read while the bytes on the wire still say `mutate`.
- The API-version segment (`/v2025-02-19/…`, `/vX/…`) is stripped, leading slashes are optional,
  duplicate/trailing slashes collapse and percent-escapes are decoded before matching — the
  request is classified by what it *means*, not how it was spelled.

The guard is transport-independent: it runs on the `upgrade` path too (see below), because
otherwise two extra request headers turn any write into an unguarded tunnel.

## Streaming (the load-bearing requirement)

Per `listener-event-shapes.md`, `@sanity/client` 7 consumes `/data/listen` SSE over `fetch`,
not `EventSource`. The proxy therefore:

- pumps chunks manually (`upstreamRes.on('data') → res.write()`) rather than buffering, with
  explicit backpressure (`pause`/`drain`/`resume`);
- calls `res.flushHeaders()` and `socket.setNoDelay(true)` on both sockets for `text/event-stream`;
- strips `Accept-Encoding` on `/data/listen` requests so no gzip/br window can hold events back;
- forces `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`;
- disables all timeouts (`server.requestTimeout = 0`, `req.setTimeout(0)`) — Studio holds
  5–6 listen streams open for the lifetime of a pane;
- destroys the upstream socket on client abort, so unsubscribe releases resources
  (Gate B pass criterion 4).

Measured: welcome event through the proxy at **587 ms**, direct to Sanity at **783 ms** — the
proxy adds no measurable buffering delay.

## WebSocket upgrade (`/v<api>/socket/<dataset>`)

Studio's listener is not only `/data/listen` SSE — it also performs an RFC 6455 upgrade to
`/v2022-06-30/socket/<dataset>` (x38 in `proxy-log.jsonl`, the busiest non-data endpoint in the
session). Without an `upgrade` handler Node clears `req.upgrade` and replays the request down the
ordinary `request` path, where the hop-by-hop `Upgrade`/`Connection` headers are stripped — so
Sanity answers a plain 404, Studio logs *"No activity within 45000 milliseconds. Reconnecting."*
and every pane sits on *"Loading document…"*.

The handler dials upstream raw (`net`/`tls`, `ALPNProtocols: ['http/1.1']` so ALPN can never pick
h2), replays the request line and headers verbatim, writes any bytes the client pipelined behind
its head, then relays byte-for-byte in both directions. Nothing parses the stream after the 101 —
the 101 and the first frames routinely share one TCP segment. FIN on either leg ends the session
(`http.Server` sockets are `allowHalfOpen` and Node stops managing them once `upgrade` fires, so
nothing else would reap the pair).

**The write guard runs here too, before the upstream socket is dialled.** `http.Server` routes a
request to `upgrade` *instead of* `request` the moment it carries `Connection: Upgrade` +
`Upgrade: <x>`, and the guard lives in the `request` handler — so without this, two extra request
headers turn

```
POST /v2025-02-19/data/actions/<ds>
Connection: Upgrade
Upgrade: websocket

{"actions":[…]}
```

into an unguarded tunnel to Content Lake: Node hands the body over as the `head` buffer, and the
reply streams straight back. Every Spike F gap class is spellable that way. Blocked upgrades get
the same `403 OVERLAY_WRITE_BLOCKED` body, serialised by hand onto the raw socket (there is no
`ServerResponse` at that point in the lifecycle) with `Connection: close`, and are logged with
`"blocked": true, "upgrade": true`.

Pinned end-to-end by `packages/sanity-overlay-testkit/test/proxy-ws.test.ts` against a hand-rolled
mock upstream — no websocket dependency, `node:net` and `node:crypto` only — and by
`test/proxy-tls.test.ts` against a real `tls.createServer` with a certificate generated at test
time (SNI, ALPN, `secureConnect`, certificate rejection).

### The frame guard — what the tunnel actually carries

Guarding the handshake is not enough. Until evidence review F5b the handler classified the
**request line** and then piped bytes opaquely, so an allowlisted upgrade was an unaudited
bidirectional tunnel to Sanity carrying the user's credentials. What that tunnel carries was then
read out of `node_modules`, not assumed:

- `sanity@6.8.0`, `lib/WorkspaceLoader-BRx2afZV.js:8300-8303`, builds the URL and hands it to
  `fromUrl` from **`@sanity/bifur-client@1.0.0`**.
- That client is a **generic JSON-RPC 2.0 request/response channel**, not a one-way stream:
  `src/createClient.ts:42-49` is the envelope, and `createClient.ts:137` is the single `ws.send()`
  carrying every request — it takes `method: string` straight from its caller.
- `src/types.ts:6-15` declares
  `RequestMethod = 'doc' | 'query' | 'mutate' | 'presence_rollcall' | 'presence_announce' | 'presence_disconnect' | 'authorization'`.

**`'mutate'` is a declared client request method on this socket.** No shipped code path calls it —
Studio's document mutations go over HTTP `POST /data/mutate/<ds>`
(`lib/datastores-DqFH7RLd.js:1789`), and `@sanity/mutator` contains no WebSocket code at all — but
the bifur client is exposed to page JS as `__internal.bifur`
(`lib/datastores-DqFH7RLd.js:7958`), and nothing between that object and Content Lake checks
anything. **The channel could not be proven read-only, so it is enforced instead.**

Past the 101, on the **client → upstream leg only** (the server leg stays opaque; parsing it would
break on any protocol extension Sanity ships, and the threat points the other way):

1. every frame is parsed as RFC 6455 — masking, both extended length forms, continuation
   fragments, control frames;
2. its JSON-RPC method is classified against a read allowlist (`writeGuard.mjs`,
   `classifyRealtimeMethod`) — the same default-deny policy as the request line, at the frame
   layer. Allowed: `authorization`, `presence*`, `listen`, `doc`, `query`, and the
   `_subscribe`/`_unsubscribe` forms of the three `SubscribeMethods`. Blocked: `mutate` and
   everything else, including `mutate_subscribe`, binary frames, non-JSON text, and any frame with
   no method;
3. **every frame gets a JSONL log line** — method name and JSON-RPC id only, so an escape is
   server-side evidenced whether or not the policy is enforcing;
4. with `PROXY_BLOCK_WRITES=1` a refused frame is never forwarded and the connection is closed
   with RFC 6455 code **1008** (policy violation). Bytes are released only once the frame they
   belong to has been classified, so the prefix of a mutation split across two frames cannot leak
   ahead of the verdict.

```json
{"at":"…","method":"WS","path":"/v2022-06-30/socket/parity","status":1008,"blocked":true,"upgrade":true,"frame":true,"opcode":1,"rpc":"mutate","rpcId":"evil-1","wouldBlock":true,"reason":"…"}
```

**`params` is never logged.** The first frame the bifur client sends is
`{method:'authorization', params:{authorization:'Bearer <token>'}}`
(`@sanity/bifur-client/src/createClient.ts:107-125`); a guard that logged frame payloads would
write the user's credential to disk on every connection. `test/proxy-ws-frames.test.ts` asserts the
raw log file contains neither the token nor the string `Bearer`.

With `PROXY_BLOCK_WRITES=0` the tunnel stays byte-transparent — observation mode means the same
thing on both legs — but every frame is still classified and logged, with `wouldBlock` recording
the verdict that was not acted on.

**Residual gap, stated plainly:** this is enforcement against the protocol as vendored in
`@sanity/bifur-client@1.0.0`. If Sanity's server accepts a method not in that type union, the
allowlist will not know about it — but default-deny means the failure mode is a refused frame and a
log line, not a silent write.

## Pointing the Studio at the proxy

**Do not apply this blindly — read the project-hostname trap first.**

`defineConfig` accepts `apiHost` at the workspace/source level
(`SourceOptions.apiHost`, `sanity` 6.8.0):

```ts
// examples/kitchen-sink/sanity.config.ts — NOT applied by this spike
export default defineConfig({
  // ...
  apiHost: 'http://localhost:3999',
})
```

### The project-hostname trap

`@sanity/client` does **not** use `apiHost` verbatim. With `useProjectHostname` (the default),
`config.js` builds:

```
url = `${protocol}://${projectId}.${host}/v${apiVersion}`
```

So `apiHost: 'http://localhost:3999'` makes the browser request
**`http://b1n03q3z.localhost:3999/v2025-02-19/...`**, not `http://localhost:3999/...`.
The Studio type docs say the same thing ("the project ID will be prepended to the passed URL").

Two things follow:

1. **Resolution.** Chrome and Firefox resolve `*.localhost` to loopback per RFC 6761, so the
   request does reach the proxy. Safari and some Node/curl paths do **not** — add
   `127.0.0.1 b1n03q3z.localhost` to `/etc/hosts` if anything fails to resolve.
2. **Upstream mapping.** The proxy handles this natively: `PROXY_DERIVE_PROJECT_HOST` (on by
   default) rewrites the first label of the upstream hostname from the incoming `Host` header,
   so `b1n03q3z.localhost:3999` → `b1n03q3z.api.sanity.io`. Verified with
   `curl -H 'Host: b1n03q3z.localhost:3999' http://127.0.0.1:3999/v2025-02-19/ping` → `PONG`.

Bare `localhost:3999` also works (falls back to `SANITY_API_HOST`), which covers any
`useProjectHostname: false` client and all the curl checks below.

### Alternatives that avoid editing `sanity.config.ts`

- **Hybrid with Track A.** `unstable_clientFactory` (already wired in this Studio) can inject
  `apiHost` into every `ClientConfig` before constructing the client. That routes 100 % of
  Studio traffic through the proxy with zero change to `apiHost` in `defineConfig`, and is the
  cleanest way to combine the two tracks.
- **Transparent MITM.** `/etc/hosts` entry for `b1n03q3z.api.sanity.io` → `127.0.0.1` plus a
  locally-trusted TLS cert on :443. Needs no Studio config at all, but requires TLS termination
  (out of scope for a `node:`-builtins-only spike) and root to bind :443.

## Known obstacles for Studio-through-proxy

### Cookies — the real blocker for cookie auth

Sanity session cookies are scoped to `.sanity.io`. A browser will never send them to
`b1n03q3z.localhost:3999`, and cookies the proxy relays back cannot be re-scoped onto a
localhost origin in a way that survives:

- `Domain=.sanity.io` is rejected outright for a localhost origin → the proxy strips `Domain`.
- A cross-site XHR from `http://localhost:3333` to `http://b1n03q3z.localhost:3999` needs
  `SameSite=None`, which browsers only honour together with `Secure`, which requires HTTPS.
  Over plain-HTTP loopback that combination is unreachable.

**Consequence: `withCredentials` cookie auth does not work through an http:// localhost
apiHost.** Token auth via `Authorization: Bearer` does — verified end to end below. Studio dev
on localhost already uses a localStorage token for the data plane, so this is likely survivable,
but it must be confirmed in a browser run. If cookie auth turns out to be required, Track B
needs local TLS (a trusted cert on `https://b1n03q3z.localhost`), not a code change.

Note also `@sanity/client`'s own config normalisation: when a token **and** `withCredentials`
are both set it prints a warning and forces `withCredentials = false`; and a token on a
localhost browser origin triggers the browser-token warning unless
`ignoreBrowserTokenWarning: true`.

### CORS

The proxy is the browser-facing origin, so it owns CORS entirely and strips every upstream
`Access-Control-*` header to avoid duplicates:

- `Access-Control-Allow-Origin` echoes the request `Origin` verbatim (a wildcard is illegal
  with `withCredentials: true`); falls back to `*` for non-browser callers, without advertising
  credentials.
- `Access-Control-Allow-Credentials: true`, `Vary: Origin, ...`.
- `OPTIONS` preflight is answered **locally** (204) and never reaches Sanity; requested headers
  are reflected.
- Blocked writes still carry CORS headers, so the Studio can actually read the 403 body rather
  than seeing an opaque network error.

Side benefit: because preflight and CORS never touch Sanity, the proxy origin does **not** need
to be registered in the project's CORS-origins list.

### Compression

Normal JSON responses pass `Content-Encoding` through untouched (verified with `--compressed`);
the body is never decoded, so `Content-Length` stays valid. For `/data/listen` the proxy strips
`Accept-Encoding` on the way up and sets `no-transform` on the way down — a compressed SSE
stream would buffer events until the deflate window flushed.

### Header duplication (fixed)

Node emits `cache-control` (upstream) and `Cache-Control` (ours) as two header lines, which
`fetch()` joins into `no-cache, no-cache, no-transform`. All proxy-owned headers now go through
a case-insensitive `setHeader()` that replaces rather than shadows. Re-verified: SSE responses
now return exactly `cache-control: no-cache, no-transform`.

### Other things to watch in a browser run

- Studio treats `apiHost` as the staging/production discriminator
  (`Workspace.apiHost`: "Used to determine if the workspace points to staging or production").
  A localhost value puts it in neither bucket; watch for feature-flag or telemetry differences.
- `isDefaultApi` becomes `false`, so `cdnUrl === url` — the CDN is bypassed entirely. Harmless
  here (Studio pins `useCdn: false`) but it changes read paths for any CDN-using client.
- The login redirect flow (`/auth/login/<provider>?origin=...`) has not been exercised through
  the proxy; only token auth has.
- The `upgrade` path's TLS leg **is** now covered — `test/proxy-tls.test.ts` builds a self-signed
  certificate from `node:crypto` at test time, stands up a real `tls.createServer`, and drives the
  proxy's own `tls.connect` through it (SNI, ALPN, `secureConnect`, frames, teardown), plus a
  no-injection case that proves the proxy *rejects* an untrusted certificate with 502. What is
  still unproven is only the part no test can supply: that `tls.connect` succeeds against the real
  `<project>.api.sanity.io:443` with the public root store and Sanity's own ALPN behaviour.

## §36.1 Track B verification checklist → what the orchestrator should observe

| §36.1 Track B task | Status here | What to observe in the Studio run |
|---|---|---|
| Configure the pinned client or Studio to use the controlled API boundary | Proxy built + apiHost route documented (config change deliberately **not** applied) | Studio boots at :3333 with `apiHost` set; `proxy-log.jsonl` fills with the Spike A endpoint inventory (`/users/me`, `/projects/*`, `/features`, `/data/query`, `/data/listen`, `/descriptors/claim`, `/journey/*`) |
| Proxy allowlisted reads to Sanity | Verified (curl) | Document list and document pane render with real content; no 502s in the log |
| Intercept query, doc, mutation, action, asset, and listen endpoints | Verified (curl) | Every one of those paths appears in `proxy-log.jsonl` |
| Instrument project host, CORS, authentication, reconnect | Partially — project-host mapping and CORS verified by curl; **auth is token-only**, reconnect not yet exercised | No CORS errors in the browser console; identity resolves in the Studio user menu; kill + restart the proxy mid-session and confirm listeners reconnect and converge |
| Reject unknown write-capable endpoints | Verified (curl) | With `PROXY_BLOCK_WRITES=1`, typing in a field then publishing produces `403 OVERLAY_WRITE_BLOCKED` rows for `/data/actions/parity` in the log, **and zero successful writes**; reads keep working in the same session |

Concretely, the three observations that decide Track B:

1. **Boot works through the proxy** — Studio reaches an interactive document pane with no
   console CORS/auth errors, and the request log shows the full boot endpoint set.
2. **Listen streams live** — an edit made from a second tab (or `sanity documents create`)
   appears in the first tab; the `/data/listen/parity` rows stay open for minutes rather than
   completing in milliseconds.
3. **Write guard holds while reads survive** — with `PROXY_BLOCK_WRITES=1`, edit + publish
   yields only `blocked: true` rows for `/data/actions`, the dataset is unchanged afterwards,
   and queries/listeners in the same session keep returning 200.

## Substantiating a "re-verified live" claim (evidence review F3)

`docs/plans/evidence/phase-1/spike-f-safety-boundary/report.md:64` claims a live smoke run in
which **seven** request shapes all returned 403. The repository's only server-side proxy
evidence, `proxy-log.jsonl`, holds **14** blocked rows in total — four `/data/actions/parity`,
four `/descriptors/claim`, four `/intake/batch`, one `/data/mutate/parity`, one
`/assets/images/parity` — and **zero** DELETE, PUT or PATCH requests of any kind. Three of the
seven claimed shapes are non-POST verbs, so that log cannot be the log of the run that exercised
them. Only one of the seven (`/assets/images/parity`) has a blocked row at all. By this project's
standing rule (*server-side logs are the only trustworthy escape evidence*) the claim is currently
**unevidenced**.

The classifier half is already pinned: `test/proxy-log-replay.test.ts` asserts all seven shapes
classify as writes, with a non-vacuity oracle showing five of the seven escape the pre-Spike-F
guard. What follows is the live half — the exact server-side log lines a browser run must produce.

**Ground rules.**

1. **Never write to `proxy-log.jsonl`.** It is committed evidence of a different session. Point
   `PROXY_LOG` at a new file.
2. **`credentials: 'omit'` on every probe.** The guard blocks *before* the upstream socket is
   dialled, so a blocked probe carries no credentials anywhere. Omitting them means that if the
   guard were to fail, the escaped request reaches Sanity unauthenticated and 401s instead of
   mutating `parity`. The point is to evidence the guard, not to gamble the dataset.
3. **The proxy must be proven alive in the same log.** Two allowlisted reads are part of the
   checklist for exactly this reason: seven 403s from a proxy that 403s everything prove nothing.

### Step 1 — start the proxy with a dedicated log

```bash
cd examples/kitchen-sink
PROXY_BLOCK_WRITES=1 \
PROXY_LOG=spikeB-proxy/proxy-log-reverify.jsonl \
node spikeB-proxy/proxy.mjs
```

### Step 2 — fire all nine probes from the Studio tab, in one `evaluate_script`

Studio must already be running at `localhost:3333` with `apiHost` pointed at the proxy, so the
probes originate from the same browser origin as real Studio traffic.

```js
const API = 'http://b1n03q3z.localhost:3999'
const PROBES = [
  ['POST',   '/v2025-02-19/assets/images/parity'],
  ['POST',   '/v2025-02-19/agent/action/patch/parity'],
  ['DELETE', '/v2025-02-19/datasets/parity'],
  ['POST',   '/v2025-02-19/projects/b1n03q3z/datasets/parity/mutate'],
  ['POST',   '/v2025-02-19//data//mutate//parity'],
  ['POST',   '/v2025-02-19/DATA/MUTATE/parity'],
  ['POST',   '/v2025-02-19/data/..%2Fmutate/parity'],
  // The two liveness controls. These MUST come back 200.
  ['GET',    '/v2025-02-19/ping'],
  ['GET',    '/v2025-02-19/data/query/parity?query=*%5B_id%3D%3D%22article-01%22%5D%5B0%5D._id'],
]
const out = []
for (const [method, path] of PROBES) {
  try {
    const res = await fetch(API + path, {method, credentials: 'omit'})
    out.push({method, path, status: res.status})
  } catch (err) {
    out.push({method, path, status: 'NETWORK_ERROR', message: String(err)})
  }
}
return out
```

The browser-side statuses are **not** the evidence — they are a convenience. The evidence is the
log file. (If any `path` in the log differs from the string above, the browser normalised the URL;
record that as a finding rather than editing the expectation.)

### Step 3 — the log-record model the predicates are written against

`proxy-log.jsonl` and `proxy-log-reverify.jsonl` are **not** logs of request lines. Since the frame
guard landed the proxy writes **two record kinds into one stream**, and every predicate below is
defined over one kind or the other. Read this first or the counts will not mean what they say.

| kind | discriminator | `method` | fields written (exhaustive) |
|---|---|---|---|
| **request** | `"frame"` absent | a real HTTP method | `at`, `method`, `path`, `status`, `ms`, `blocked`, and `upgrade` only on an upgrade |
| **frame** | `"frame":true` | always `"WS"` | the above plus `opcode`, `rpc`, `rpcId`, `wouldBlock`, `reason` |

Three consequences that will bite a naive grep:

- `"status":101` matches **both** an accepted upgrade and every non-refused frame on it. In
  `proxy-log.jsonl` that is 4 upgrades and 61 frames = 65 hits, so `grep -c '"status":101'` does
  **not** count sockets.
- `"blocked":true` matches a refused frame (`"status":1008`) as well as a refused request
  (`"status":403`). Always pair `blocked` with `status`.
- `"method":"WS"` is a pseudo-method. Never feed a frame record to anything that classifies request
  lines — `WS` is on no read allowlist, so a default-deny guard calls it a write and the Studio's
  own listener socket is reported as newly blocked. `test/proxy-log-replay.test.ts`
  (`frames and request lines are different kinds of record`) pins this.
- `path` is the **pathname only** — the query string is stripped before logging. Match
  `/v2025-02-19/data/query/parity`, never `…/parity?query=…`.

`path` is logged **raw**: no dot-segment resolution, no case folding, no slash collapsing. Shapes
5–7 below must appear byte-for-byte as sent.

### Step 4 — the predicates the run must satisfy

Every predicate is a mechanical test over `proxy-log-reverify.jsonl`. `R` = the records with
`"frame"` absent; `F` = the records with `"frame":true`. `SHAPES` is the seven
`method`+`path` pairs in the table. A predicate that cannot be evaluated counts as **FAIL**.

| id | predicate | exact values to match |
|---|---|---|
| **P0** | `proxy-log-reverify.jsonl` exists and is non-empty; every line parses as JSON | — |
| **P1** | `git status --porcelain examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl` prints **nothing**, and that file still has exactly **730** lines — the committed session was not appended to or overwritten | line count `730` |
| **P2** | every record in `R` has `method` ∈ the HTTP set; every record in `F` has `"method":"WS"` and `"upgrade":true` | `GET HEAD POST PUT PATCH DELETE OPTIONS TRACE CONNECT` |
| **P3** | for each of the 7 `SHAPES`: **at least one** record in `R` with that exact `method` **and** that exact `path` **and** `"blocked":true` **and** `"status":403` | `"blocked":true,"status":403` |
| **P4** | for each of the 7 `SHAPES`: **zero** records in `R` with that exact `method`+`path` and `"blocked"` anything other than `true` | any `"blocked":false` on a shape = **FAIL** |
| **P5** | at least one record in `R` with `"method":"DELETE"` — the verb the committed log has never contained, and the single strongest signal that this is a new run | `"method":"DELETE"` |
| **P6** | at least one record in `R` with `"method":"OPTIONS"`, `"path":"/v2025-02-19/datasets/parity"`, `"status":204`, `"blocked":false` — a cross-origin `DELETE` is never a simple request, so its preflight proves the probe came from the browser and not from a shell | `"method":"OPTIONS"` + `"status":204` |
| **P7** | at least one record in `R` with `"method":"GET"`, `"path":"/v2025-02-19/ping"`, `"status":200`, `"blocked":false` | `"path":"/v2025-02-19/ping"` |
| **P8** | at least one record in `R` with `"method":"GET"`, `"path":"/v2025-02-19/data/query/parity"`, `"status":200`, `"blocked":false` | `"path":"/v2025-02-19/data/query/parity"` |
| **P9** | `grep -c 'Bearer' proxy-log-reverify.jsonl` is `0` **and** `grep -c '"params"' proxy-log-reverify.jsonl` is `0` — no frame payload or credential was ever written | `Bearer`, `"params"` |
| **P10** | every record in `F` has a non-empty `"reason"` string — a frame the guard forwarded without classifying would have none | `"reason":"…"` |

P7 and P8 together are the **liveness control**: seven 403s from a proxy that 403s everything prove
nothing. P4 is the **leak control**. P5 and P6 are the **freshness controls** — they are what
`proxy-log.jsonl` cannot satisfy, and therefore what stops an old log being offered in place of the
run.

The seven shapes, verbatim:

| # | `method` | `path` |
|---|---|---|
| 1 | `POST` | `/v2025-02-19/assets/images/parity` |
| 2 | `POST` | `/v2025-02-19/agent/action/patch/parity` |
| 3 | `DELETE` | `/v2025-02-19/datasets/parity` |
| 4 | `POST` | `/v2025-02-19/projects/b1n03q3z/datasets/parity/mutate` |
| 5 | `POST` | `/v2025-02-19//data//mutate//parity` |
| 6 | `POST` | `/v2025-02-19/DATA/MUTATE/parity` |
| 7 | `POST` | `/v2025-02-19/data/..%2Fmutate/parity` |

`OPTIONS` preflight rows on shape paths other than #3 are expected and are ignored by P3/P4, which
match on `method`+`path` together. If any `path` in the log differs from the string above, the
browser normalised the URL: record that as a finding, do **not** edit the expectation.

### Step 5 — run the predicates

```bash
node -e '
const fs=require("node:fs"), cp=require("node:child_process");
const LOG="examples/kitchen-sink/spikeB-proxy/proxy-log-reverify.jsonl";
const HTTP=new Set(["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS","TRACE","CONNECT"]);
const SHAPES=[
  ["POST","/v2025-02-19/assets/images/parity"],
  ["POST","/v2025-02-19/agent/action/patch/parity"],
  ["DELETE","/v2025-02-19/datasets/parity"],
  ["POST","/v2025-02-19/projects/b1n03q3z/datasets/parity/mutate"],
  ["POST","/v2025-02-19//data//mutate//parity"],
  ["POST","/v2025-02-19/DATA/MUTATE/parity"],
  ["POST","/v2025-02-19/data/..%2Fmutate/parity"],
];
let ok=true;
const P=(id,pass,note="")=>{ if(!pass) ok=false; console.log((pass?"PASS":"FAIL"),id,note); };

const raw=fs.existsSync(LOG)?fs.readFileSync(LOG,"utf8"):"";
const lines=raw.split("\n").filter(l=>l.trim());
let recs=null; try{ recs=lines.map(l=>JSON.parse(l)); }catch(e){}
P("P0", recs!==null && recs.length>0, `${lines.length} lines`);
// Stop here on an empty or unparseable log: P2/P4/P9/P10 are all satisfied
// vacuously by zero records, and a vacuous PASS is the failure mode this whole
// checklist exists to prevent.
if(recs===null || recs.length===0){ console.log("\nCLAIM NOT SUBSTANTIATED"); process.exit(1); }

const COMMITTED="examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl";
const dirty=cp.execSync("git status --porcelain "+COMMITTED).toString().trim();
const kept=fs.readFileSync(COMMITTED,"utf8").split("\n").filter(l=>l.trim()).length;
P("P1", dirty==="" && kept===730, dirty||`proxy-log.jsonl unmodified, ${kept} lines`);

const R=recs.filter(r=>r.frame!==true), F=recs.filter(r=>r.frame===true);
P("P2", R.every(r=>HTTP.has(r.method)) && F.every(r=>r.method==="WS"&&r.upgrade===true),
  `${R.length} request records, ${F.length} frame records`);

for(const [m,p] of SHAPES){
  const hit=R.some(r=>r.method===m&&r.path===p&&r.blocked===true&&r.status===403);
  P("P3", hit, `${m} ${p}`);
}
for(const [m,p] of SHAPES){
  const leak=R.filter(r=>r.method===m&&r.path===p&&r.blocked!==true);
  P("P4", leak.length===0, `${m} ${p}` + (leak.length?` LEAKED status=${leak.map(r=>r.status).join(",")}`:""));
}
P("P5", R.some(r=>r.method==="DELETE"));
P("P6", R.some(r=>r.method==="OPTIONS"&&r.path==="/v2025-02-19/datasets/parity"&&r.status===204&&r.blocked===false));
P("P7", R.some(r=>r.method==="GET"&&r.path==="/v2025-02-19/ping"&&r.status===200&&r.blocked===false));
P("P8", R.some(r=>r.method==="GET"&&r.path==="/v2025-02-19/data/query/parity"&&r.status===200&&r.blocked===false));
P("P9", !/Bearer/.test(raw) && !/"params"/.test(raw));
P("P10", F.every(r=>typeof r.reason==="string"&&r.reason.length>0), `${F.length} frame records`);

console.log(ok?"\nALL PREDICATES PASS":"\nCLAIM NOT SUBSTANTIATED");
process.exit(ok?0:1);
'
```

Run it from the repository root. Exit code 0 is the whole gate; every `FAIL` line names the
predicate and the offending shape.

### Step 6 — commit the log, then let the suite grade it

`git add examples/kitchen-sink/spikeB-proxy/proxy-log-reverify.jsonl` and commit it. Adding that
file makes `test/proxy-log-replay.test.ts` go **red** on its pinned
`the live re-verification has not happened yet` assertion — that is deliberate. Flipping that
literal to `true` switches the same suite from recording the claim as unevidenced to grading the
new log through `gradeReverifyLog`, which applies the same rule as P3/P4/P7/P8 above. The two
cannot drift: the grader is tested against synthetic logs *and* against `proxy-log.jsonl`, which
must fail on six of seven shapes.

Finally, update `spike-f-safety-boundary/report.md:64` to cite the new file and its line numbers
instead of asserting the run from memory.

## Verification already performed (no browser, curl + Node `fetch`)

| Check | Result |
|---|---|
| `GET /v2025-02-19/ping` | 200, body `PONG` |
| `POST /v2025-02-19/data/actions/parity` with `PROXY_BLOCK_WRITES=1` | 403 `OVERLAY_WRITE_BLOCKED`, `blocked:true` in log; same for `/data/mutate` and `/assets` |
| `GET /v2025-02-19/data/query/parity?query=*[_id=="article-01"][0]._id` + Bearer token | 200, `{"result":"article-01"}` — byte-identical to a direct call |
| `POST /v2025-02-19/data/query/parity` (GROQ over POST) with guard on | 200 — correctly **not** blocked |
| `GET /v2025-02-19/data/listen/parity?query=*&includeAllVersions=true` | 200 `text/event-stream`, `welcome` event at 587 ms, streamed incrementally, clean abort |
| `OPTIONS` preflight | 204 answered locally, requested headers reflected |
| Malformed request line | 400 + connection close, proxy survives |
| Unresolvable upstream | 502 `OVERLAY_PROXY_UPSTREAM` |
| `POST /data/actions` with guard **off** | forwarded; Sanity's own 400 returned (proves body passthrough without writing) |
