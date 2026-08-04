# Spike F report — safety and trust boundary (PRD §36.6)

**Date:** 2026-08-04 · **Status: PASS for the facade; ARCHITECTURAL HOLE CONFIRMED at the browser trust boundary** · Attack suite: `examples/kitchen-sink/spikeF/attackPass.ts` (27 attacks, browser-executed against the live Studio with the local-echo facade enabled).

## Result

| | |
|---|---|
| Attacks run | 27 |
| **Blocked** | **25** |
| Unexpected holes | **0** |
| Expected (architectural) holes | 4 findings, below |

**Blocked (25):** `client.create` / `createOrReplace` / `createIfNotExists` / `delete`; `mutate` promise + observable; `patch().commit()`; `transaction().commit()`; publish action; `withConfig().observable.action`; `request` → `/data/mutate`; `dataRequest('mutate')` and `('actions')`; **dataset override** via `withConfig({dataset:'scratch'})`; apiVersion-clone mutate; `clone().mutate`; config reconfigure escape; patch/transaction clone commits; relative-URL bypass; assets endpoint via `request`; **`client.assets.upload`**; agent action patch; datasets reachability; and a **freshly constructed `createClient(...).create()`**.

That last one matters: constructing a brand-new client did **not** escape, because the write-capable path still requires a token and the fresh client had none by default.

## The architectural hole (the important result)

> **A write-capable Sanity token is reachable from page JavaScript, and raw `fetch` with it writes to the dataset.**

- `localStorage.__studio_auth_token_b1n03q3z` holds a live `sk...` token; the same token is visible via `client.config().token`.
- Attack 26 (`rawFetch.dataMutate`) used it to `POST /data/mutate/parity` directly, **bypassing every client-layer control**, and created documents.
- Attack 28 verified the writes **persisted** in Content Lake: 3 canary objects existed afterwards (deleted during cleanup; dataset verified back to 41 fixture docs + Sanity's own system docs, 0 canaries).
- Attack 00 additionally showed the live Studio client is reachable by walking the React fiber tree — so "hide the client" is not a defence either.

### What this proves

1. **PRD §5.2 "Preview deployments contain no Sanity write token" is a hard requirement, not a nicety.** In `sanity dev` the Studio necessarily holds a user token with write grants; any code on the page can use it.
2. **A client-side facade can never satisfy Gate E on its own.** It is a correctness and ergonomics layer, not a security boundary. This is direct evidence for the §0.6 trigger *"Staging write protection depends on branch-controlled code behaving honestly."*
3. **Therefore the enforcement boundary must be server-side**: either the Track B proxy with `PROXY_BLOCK_WRITES` (which returned 403 with `_rev` provably unchanged), or the §25.13 isolated-gateway topology — and the deployed preview must carry a **read-only** token so no write-capable credential exists in the browser at all.

This strengthens the **D13 hybrid recommendation** (factory injects `apiHost`; proxy enforces) and pre-empts **D14**: the trust topology must not rely on branch code behaving honestly.

## §36.6 pass criteria

| Criterion | Status |
|---|---|
| Every staging write fails before reaching an authorized endpoint | **PASS for all 25 Studio-originated paths**; FAILS for raw fetch with a page-reachable write token — mitigated only by a server-side guard plus a read-only preview token |
| Fork and untrusted preview code cannot access protected credentials | **NOT TESTED** — needs the deployed Vercel track (PRE-5) |
| Core overlay editing still works for the approved trust class | **PASS** — full local editing throughout, staging byte-identical |

## Follow-ups

- [ ] Preview environment must be provisioned with a read-only token; CI must scan for write-capable tokens (§11.3, §35.14).
- [ ] Re-run this suite against the deployed preview once the Vercel track starts (fork fixture + isolated-gateway cases).
- [ ] Add attacks 25/26/27 to the permanent security suite (§35.14) so a regression re-surfaces them.
