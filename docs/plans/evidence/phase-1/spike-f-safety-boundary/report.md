# Spike F report — safety and trust boundary (PRD §36.6)

**Date:** 2026-08-04 · **Status: FAIL for the facade as a security boundary — 6 real gaps + 4 architectural holes** · Suite: `examples/kitchen-sink/spikeF/attackPass.ts` (27 attacks + 2 verification entries), browser-executed against the live Studio with the local-echo facade enabled.

> **Correction notice.** An earlier revision of this report (08:27) claimed *25 blocked, 0 unexpected holes*. That run used an **earlier, weaker build of the attack suite** whose escape detection was unsound in two ways discovered afterwards:
> 1. **`@sanity/client` uses XMLHttpRequest in browsers, not `fetch`** (get-it's browser adapter prefers XHR; only `/data/listen` uses fetch). A fetch-only detector observes nothing.
> 2. **The performance resource-timing buffer holds 250 entries and then silently drops everything.** A Studio open for minutes makes that detector blind.
>
> The hardened suite taps XHR *and* fetch, raises and clears the timing buffer, and confirms escapes server-side by read-back. The corrected numbers are below. The earlier figures should not be cited.

## Result (hardened run)

| | |
|---|---|
| Attacks | 27 |
| Blocked | **17** |
| **Real (unexpected) gaps** | **6** |
| Architectural (expected) holes | 4 |

### Real facade gaps — must be fixed before any facade is trusted

| # | Attack | Sev | Root cause |
|---|---|---|---|
| 18 | `Patch.clone().commit()` | high | `blockFluentCommit` only re-wraps returns where `result === target`; `clone()` returns a **new** builder still bound to the real client |
| 19 | `Transaction.clone().commit()` | high | Same defect on the transaction builder |
| 20 | `request({url:'data/mutate/parity'})` (no leading slash) | high | Guard regex `/\/data\/(mutate\|actions)\b/` requires a leading slash, but `_getUrl` strips it — same endpoint, unguarded |
| 21 | `request()` → `/assets/*` | high | Write-URL guard covers only `/data/mutate` and `/data/actions`; the asset endpoint is not guarded at all |
| 23 | `client.agent.action.patch` | high | Agent Actions write documents via `POST /agent/action/patch/<dataset>` through a module-level `_request`. **Blocked by neither the facade nor the Track B proxy** — the proxy's allowlist explicitly passes `/agent/*`. Previously unlisted in every inventory |
| 24 | `client.datasets` reachable | medium | `datasets`/`releases`/`live` are object properties, never wrapped — project-plane operations the facade cannot see |

### Gap 7 — found later, by the write-guard TDD work (not in the attack suite)

| # | Attack surface | Sev | Root cause |
|---|---|---|---|
| 7 | `resource:`-configured clients write to **`/projects/<p>/datasets/<d>/mutate`** and `/canvases/<id>/mutate`, `/media-libraries/<id>/upload`, `/dashboards/<id>/…` | high | `@sanity/client`'s `resourceDataBase()` builds mutation URLs with **no `/data/` prefix at all**. Every `/data/`-anchored guard — facade *and* proxy — misses them entirely. Also: `buildAssetUploadUrl` emits `assets/images/<ds>` with **no leading slash**, compounding gap 3. |

Found by grepping every request-URL construction site in `@sanity/client` 7.26.0 (`uri:` literals, `_getDataUrl`, `_getUrl`, `buildAssetUploadUrl`, `resourceDataBase`) while building the write-guard contract. **Lesson: enumerate the client's URL builders rather than guessing endpoints from observed traffic** — observation only shows the paths the Studio happened to use.

### Architectural holes (expected; they define the trust model)

- **Attack 22 `client.assets.upload`** — `assets` is an object property, so the facade returns it untouched. Asset writes reach the network.
- **Attack 00** — the live Studio client is reachable by walking the React fiber tree; hiding the client is not a defence.
- **Attacks 25/26/27** — a **write-capable token is reachable from page JS** (`localStorage.__studio_auth_token_<projectId>`, and `client.config().token`, which the facade itself hands out). A fresh `createClient()` or a raw `fetch` with it writes freely.
- **Attack 28** — read-back confirmed **3 canary documents persisted** in Content Lake. All canaries and the uploaded asset were deleted; dataset verified back to the seeded fixture state (0 canaries, 0 image assets).

## §36.6 pass criteria

| Criterion | Status |
|---|---|
| Every staging write fails before reaching an authorized endpoint | **FAIL** — 6 client-layer gaps plus raw-fetch/fresh-client paths |
| Fork and untrusted preview code cannot access protected credentials | **NOT TESTED** — needs the deployed Vercel track (PRE-5) |
| Core overlay editing still works for the approved trust class | **PASS** — full local editing works; staging byte-identical after edit sessions |

## Conclusions

1. **A client-side facade is not a security boundary and cannot be made into one.** Even with every gap above fixed, attacks 25–27 remain: any page JS holding a write token can bypass it. This is exactly the §0.6 trigger *"staging write protection depends on branch-controlled code behaving honestly"*.
2. **Enforcement must be server-side**, and the deployed preview must hold **no write-capable credential** (§5.2). The Track B proxy's `PROXY_BLOCK_WRITES` returned 403 with `_rev` provably unchanged — but its allowlist must be corrected to cover `/agent/*` and `/assets/*`.
3. **D13/D14 implications:** the hybrid topology is now the only defensible option, with a corrected proxy allowlist and a read-only preview token. Recorded in [decisions.md](../decisions.md).
4. **Method lesson for all future spikes:** escape detection must observe XHR *and* fetch, must not rely on an unbounded resource-timing buffer, and must confirm server-side. An unsound detector produced a false "all clear" — the failure mode a security spike exists to prevent.

## Remediation status

- [x] **Write-guard contract built test-first** — `packages/sanity-overlay-testkit/src/writeGuardContract.ts`, a reusable `runWriteGuardContract(name, isWrite)` suite (**149 tests**) covering the whole class of each gap: URL-normalization variants (no/double/trailing slash, percent-encoding, `.`/`..`, case, API-version prefix), every write endpoint found in the client source, read-passthrough (incl. `POST /data/query`), and method cross-products. Written RED against the naive pre-Spike-F predicate: **63 of 123 failed**, reproducing every Spike F escape. Then green.
- [x] **Proxy fixed and re-verified live** — `spikeB-proxy/writeGuard.mjs` normalizes then classifies, **fail-closed** on unrecognized non-GET requests to write-capable prefixes. Live smoke test: all former escapes now 403 (`/assets/images/*`, `/agent/action/patch`, `DELETE /datasets/*`, `/projects/*/datasets/*/mutate`, `//data//mutate//`, `/DATA/MUTATE/`, `/data/..%2Fmutate/`) while reads still forward and OPTIONS preflight still returns 204.
- [x] **Non-vacuity guard in CI** — the suite re-runs the old broken predicate against the case table every run and requires it to fail ≥60 cases, so the contract can never silently become tautological.

## Follow-ups

- [ ] Fix gaps 18–21, 23, 24 in the facade (or drop the facade's security claim entirely and rely on the proxy — recommended).
- [ ] Provision preview environments with read-only tokens; CI scan for write-capable tokens (§11.3, §35.14).
- [ ] Promote attacks 18–27 into the permanent §35.14 security suite so regressions re-surface.
- [ ] Re-run against the deployed preview when the Vercel track starts (fork fixture, isolated gateway).
