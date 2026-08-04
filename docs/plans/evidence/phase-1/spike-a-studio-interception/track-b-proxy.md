# Spike A — Track B: HTTP API host proxy (PRD §36.1 Track B)

**Date:** 2026-08-04 · **Status: transport layer PROVEN; Studio-layer run pending** · Implementation: `examples/kitchen-sink/spikeB-proxy/proxy.mjs` (Node built-ins only, zero deps) + `README.md`.

## Verification (curl/Node fetch — not yet a browser run)

| Check | Result |
|---|---|
| `GET /v2025-02-19/ping` through proxy | PASS — 200 `PONG` |
| `POST /data/actions/parity` with `PROXY_BLOCK_WRITES=1` | PASS — 403 `OVERLAY_WRITE_BLOCKED`; follow-up read confirms `article-01` `_rev` unchanged. Same for `/data/mutate`, `/assets` |
| Authenticated `GET /data/query/parity` | PASS — byte-identical to a direct API call |
| `/data/listen/parity` SSE | PASS — `welcome` frame at 429 ms (direct baseline 783 ms), incremental streaming, clean abort |
| `POST /data/query` (GROQ over POST) | PASS — correctly **not** blocked |
| OPTIONS preflight, malformed request, upstream failure, gzip, guard-off action passthrough | PASS (204 local preflight; 400 survives; 502 `OVERLAY_PROXY_UPSTREAM`) |

Evidence: `spikeB-proxy/proxy-log.jsonl`. Bug found and fixed during verification: duplicate `cache-control`/`Vary` headers (Node case-sensitivity) → case-insensitive `setHeader`.

## Obstacles found (load-bearing for the Gate A decision)

1. **Project-hostname trap.** `@sanity/client` builds `${protocol}://${projectId}.${apiHost}`, so `apiHost: 'http://localhost:3999'` resolves to `http://b1n03q3z.localhost:3999`. Chrome/Firefox map `*.localhost` to loopback; Safari may need `/etc/hosts`. Proxy handles it via `PROXY_DERIVE_PROJECT_HOST` (default on).
2. **Cookie auth is structurally dead over plain-HTTP loopback.** Sanity cookies are `.sanity.io`-scoped; relaying requires `SameSite=None` → `Secure` → HTTPS. **Token (`Authorization: Bearer`) auth works.** Track B therefore depends on Studio dev using token auth for the data plane, or on local TLS.
3. **CORS is an advantage** — proxy owns it fully (echoes `Origin`, strips upstream `Access-Control-*`, answers preflight, attaches CORS to the 403 so Studio can read the error). Proxy origin needs no project CORS registration.
4. **SSE must not be compressed** — proxy strips `Accept-Encoding` on `/data/listen` and sets `no-transform`.
5. **Unexercised:** login redirect flow, reconnect after proxy restart, WebSocket upgrade (unused in Spike A).

## Track B vs Track A

**B is stronger where it matters for safety:** it is a network chokepoint (nothing — plugin, future Studio version, raw fetch — escapes it), has no identity-stability hazard (Track A's ~40k-call resubscribe failure), and its contract is the versioned public HTTP API rather than Studio internals.

**B is weaker on intent:** it sees bytes, so overlay emulation must synthesize SSE frames with correct `previousRev`→`resultRev` chaining, `eventId` format and mendoza effects — which Track A gets for free by returning observables. B's chief risk is auth (cookie path unusable without TLS).

**Recommended topology for D13 (hybrid):** use `unstable_clientFactory` *only* to inject `apiHost` into every `ClientConfig` — no method wrapping, so no identity hazard — and let the proxy be the interception and enforcement layer. This yields Track A's guaranteed 100% client coverage plus Track B's bypass-proof boundary, and avoids editing `apiHost` in `defineConfig`.

**Next gate for B:** browser run proving (1) Studio boots through the proxy with token auth, (2) listen streams stay open and deliver a cross-tab edit, (3) publish produces only `blocked:true` rows while reads keep working.
