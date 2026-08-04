# D13 hybrid topology — browser validation (PRD §36.1 Track B, §0.3 Gate A/E)

**Date:** 2026-08-04 · **Status: PASS** — Studio runs entirely through the Track B proxy, with the client factory doing nothing but inject `apiHost`.

## Topology under test

- `unstable_clientFactory` injects `apiHost` into every `ClientConfig` and **wraps no methods** — so none of Track A's identity-stability hazard exists (`spikeA/instrumentedClient.ts`, gated on `localStorage.SPIKE_API_HOST`).
- The local-echo facade was **disabled** (`SPIKE_LOCAL_ECHO` removed), so the proxy was the *only* thing between Studio and Content Lake.
- Proxy run with `PROXY_BLOCK_WRITES=1`, using the TDD-built `writeGuard.mjs`.

## Results

| Check | Result |
|---|---|
| Studio boots through proxy | **PASS** — document pane rendered, title `Article 11` loaded |
| Requests via proxy | **6+** (`/users/me`, `/projects/*/grants`, `/journey/*`, data plane) |
| **Requests direct to `api.sanity.io`** | **0** — the factory-injected `apiHost` captured 100% of client traffic |
| Edit attempted with echo OFF | Typed value rendered in the editor |
| Write outcome | **BLOCKED at the network layer**: proxy log `POST /v2025-02-19/data/actions/parity → 403 blocked:true` |
| Staging after the attempt | **Unchanged** — `article-11` still `{"_rev":"V2rkHT6iCw5OR37gl8ZtfG","title":"Article 11"}` |

This is the first end-to-end demonstration that **a client-side compromise cannot reach staging**: with no facade in play, the write still died at the proxy.

## Two findings from the run

1. **The browser-side detector was blind again.** `performance.getEntriesByType('resource')` reported `actionRequests: 0` while the proxy log recorded the blocked POST. Same root cause as the retracted Spike F result (XHR + resource-timing buffer). **Server-side logs are the only trustworthy escape evidence** — recorded as a standing method rule.
2. **`GET /v2022-06-30/socket/parity` 404s in a retry loop** through the proxy. Studio attempts a socket endpoint the proxy does not implement (WebSocket upgrade is unhandled). Harmless for editing — the data-plane listener uses fetch-streamed SSE, which works — but it should be either implemented or explicitly rejected to stop the retry storm.

## Consequence for D13

The hybrid is now the evidenced recommendation, not just a design argument:
- Track A alone: proven bypassable (Spike F) and carries the identity hazard.
- Track B alone: needs `apiHost` configured, and cookie auth is unusable over plain-HTTP loopback.
- **Hybrid**: factory guarantees 100% client coverage with zero wrapping risk; proxy provides the unbypassable, TDD-pinned enforcement boundary. Validated above.

Remaining for full Gate A/E sign-off: read-only preview token (so no write-capable credential exists in the browser at all), plus the deployed fork/gateway clauses on the Vercel track.
