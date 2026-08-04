# Spike A · Track B — HTTP API host / transport proxy

PRD §36.1 Track B. A dependency-free Node 22 reverse proxy that puts a controlled
API boundary between the pinned Studio (`sanity dev`, http://localhost:3333) and
`https://b1n03q3z.api.sanity.io`.

Everything here is **new, additive, and self-contained**. No existing file in
`examples/kitchen-sink` was modified — in particular `sanity.config.ts` is untouched;
the config change needed to route the Studio through the proxy is documented below
for the orchestrator to apply deliberately.

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
mock upstream — no websocket dependency, `node:net` and `node:crypto` only.

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
- The `upgrade` path is verified against a hand-rolled mock upstream over plain HTTP; the
  TLS leg (`tls.connect` to `<project>.api.sanity.io:443`) has not been exercised in a test.

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
