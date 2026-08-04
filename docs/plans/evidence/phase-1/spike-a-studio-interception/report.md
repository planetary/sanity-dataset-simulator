# Spike A report — Studio interception, authentication, listener (PRD §36.1)

**Date:** 2026-08-03/04 · **Status: PASS for core editing; document actions and Track B browser run outstanding** · Attempts: Track A 1 + 1 targeted repair; Track B 1 (within the §36.0 bound of two per strategy plus one repair). Pinned: `sanity` 6.8.0, `@sanity/client` 7.26.0.

Companion evidence: [listener-event-shapes.md](listener-event-shapes.md) · [write-block-validation.md](write-block-validation.md) · [track-b-proxy.md](track-b-proxy.md)

## Track A — client-factory facade

1. **`unstable_clientFactory` exists and works in 6.8.0** — typed `(options: ClientConfig) => SanityClient`, consumed by `WorkspaceLoader`. Invoked 4× at boot; every client, including `withConfig()` chains 3 deep, flows through it. No unintercepted client observed.
2. **Identity stability is a hard requirement.** A naive Proxy returning a fresh function per property access caused an infinite resubscribe loop (~40k client calls, saturated main thread, black screen). Fixed with per-target memoized wrappers + `WeakMap` client cache. **Design rule for the real facade.**
3. **Writes travel via the Actions API**, not `mutate`: edit → debounce → `observable.action(...)` → `POST /data/actions?tag=sanity.studio.document.commit`. Publish is a further action. The overlay's §25.7 actions endpoint is the primary write path to emulate.
4. **Full local editing proven** with **0** network writes and staging byte-identical afterwards — see [write-block-validation.md](write-block-validation.md).
5. **Client method inventory:** `config` (dominant), `withConfig`, `fetch`, `observable.fetch`, `request`, `observable.request`, `observable.action`, `observable.listen`, `getUrl`, `getDataUrl`. Studio internal `apiVersion v2026-05-04` for platform calls; data plane `v2025-02-19`; `useCdn: false`, `withCredentials: true`.
6. **Endpoint surface:** `/data/{query,listen,actions,doc,history/*}`, `/users/me`, `/projects/*/{grants,user-applications,datasets}`, `/features`, `/descriptors/claim`, `/ping`, `/help`, `/journey/*`, `/agent/*/bundles/mine/listen`, telemetry intake.
7. **GROQ-layer implications:** Studio uses `sanity::versionOf()` (slug uniqueness, version observation) and `text::query` (search); the global preview listener subscribes to unconstrained `*`. All are Tier C for exact candidate planning — overlay listen emulation must emit synthetic overlay-scoped events instead.

## Track B — HTTP proxy

Transport layer proven (streaming SSE, airtight write guard, CORS owned locally); cookie auth structurally unusable over plain-HTTP loopback while token auth works; `apiHost` resolves as `<projectId>.<apiHost>`. Full detail and the Track A/B comparison in [track-b-proxy.md](track-b-proxy.md).

## §36.1 pass criteria

| Criterion | Status |
|---|---|
| At least one strategy supports required field and document workflows | **PASS for fields** (scalar, keyed array, Portable Text); document actions blocked but not yet echoed |
| Save state settles correctly | **PASS** — indicator settles, Publish enables, rev chain intact |
| No lost keystrokes, duplicate patches, cursor jumps, stale panes | **PASS** in observed sessions (no formal keystroke-loss harness yet) |
| Login, current-user, refresh, logout, authorization failures predictable | **PARTIAL** — boot/login/current-user observed; logout, token refresh and auth-failure paths not exercised |
| Reconnect converges to current overlay head | **NOT TESTED** |
| Custom actions work | **NOT TESTED** (none defined in the kitchen-sink schema) |
| No staging write is possible | **PASS via facade** for all Studio-originated paths; note the architectural caveat that a facade alone cannot stop a freshly constructed client — that is precisely why the hybrid topology (Track B enforcement) is recommended. Spike F quantifies this. |
| No unhandled client call required for core editing | **PASS** |

## Outstanding before Gate A/B can be signed

- [ ] Document actions echoed (publish, unpublish, delete, discard, duplicate, restore) — currently blocked-not-echoed.
- [ ] Reconnect, logout/refresh, auth-failure flows.
- [ ] Two panes / two tabs convergence.
- [ ] Track B browser run (Studio boots through proxy on token auth; listen streams; writes blocked while reads work).
- [ ] Formal editor-state matrix (§21.4.1 five pass criteria) as an automated E2E, rather than ad-hoc observation.

**Assessment:** the load-bearing risk in Gate A — *can Studio's data plane be intercepted at all, and can content be edited without touching Content Lake* — is **answered yes, with working code**. What remains is breadth, not feasibility.
