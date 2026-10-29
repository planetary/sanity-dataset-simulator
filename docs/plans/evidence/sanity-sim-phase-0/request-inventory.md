# sanity-sim Phase 0 — Studio 6.20 against the Mode 2 origin

*Run on 2026-10-28 (the browser's UTC date was the 29th). Plan: [../../sanity-sim.md](../../sanity-sim.md) §5, Phase 0.*

## Question

Point a **stock** Studio at the existing Mode 2 origin by changing nothing except `apiHost`. What does it call, what breaks, and does the origin have to speak HTTP/2?

## Setup

| | |
|---|---|
| Studio | `examples/sim-spike`: `sanity@6.20.0`, `@sanity/vision@6.20.0`, `@sanity/client@8.13.0`, React 19.3.1. Its config is `defineConfig` + `structureTool` + `visionTool` + the kitchen-sink schema. The **only** change from a stock project is `apiHost` from `SANITY_STUDIO_API_HOST`. No overlay plugin, no client factory. It has its own lockfile, outside the pnpm workspace (see the dependency note at the end). |
| Origin | `examples/kitchen-sink/spikeB-proxy/runOrigin.mjs --origin` against a **scratch copy** of `examples/kitchen-sink/.sanity-overlay` |
| h1 leg | `PROXY_TLS=0`, `apiHost: http://localhost:3990`, driven by hand in the Claude browser pane |
| h2 leg | Self-signed TLS, `apiHost: https://localhost:3991`, driven by `examples/sim-spike/drive.mjs`: headless Chromium through the repo's Playwright, `ignoreHTTPSErrors` exactly as `playwright.config.ts` does, Chrome DevTools Protocol network capture. Run three times; the third run was from the isolated install with fresh data, and the results matched |

Reproduce:

```bash
# origin (h2)
PROXY_TLS_DIR=<scratch>/tls PROXY_TLS_SOURCE=self-signed PROXY_TLS_NAMES=b1n03q3z.localhost,localhost \
  node --experimental-strip-types examples/kitchen-sink/spikeB-proxy/runOrigin.mjs --origin \
  --root=<scratch copy of a .sanity-overlay parent> --port=3991 --bind=127.0.0.1 \
  --project=b1n03q3z --dataset=parity --log=<scratch>/h2-log.jsonl
# studio
cd examples/sim-spike && pnpm install --ignore-workspace
SANITY_STUDIO_API_HOST=https://localhost:3991 ./node_modules/.bin/sanity dev --port 3336
# drive
node examples/sim-spike/drive.mjs <outDir> http://localhost:3336 3991
```

## Decision: HTTP/2 is required (h1 is not viable)

**h1, measured.** Boot works, and the Structure lists render. Opening one document puts **8 `/data/listen` streams plus the Bifur websocket** on the single API host. Chrome caps HTTP/1.1 at 6 connections per host. The origin log shows 8 listen preflights but only 6 listen GETs. The document's own `GET /data/doc/…` and `GET /data/history/…/events/…` were preflighted and **never sent**, and the pane sat on "Loading document…" indefinitely.

The streams open when a document is open:

| tag | query | notable params |
|---|---|---|
| `sanity.studio.releases.listen` | `system.release` docs | `includeAllVersions`, `visibility=query` |
| `sanity.studio.tasks-store` | `tasks.task` | `includeResult` |
| `sanity.studio.listen-search-query` | `*[_type == $type]` (the open list) | |
| `sanity.studio.preview.global` | `*` | `effectFormat=mendoza`, `includeMutations=false` |
| `sanity.studio.document.pair.listen` | `*[_id in $ids]` (published + draft) | `effectFormat=mendoza`, `enableResume=true` |
| `sanity.studio.preview.observe-document-set.listen` | `*[sanity::versionOf($publishedId)]` | `visibility=transaction`, `includeMutations=false` |
| `sanity.studio.preview.observe-document-set.listen` | `sanity.canvas.link` for the doc | |
| `sanity.studio.comments-store` | `comment` on the doc (on the **main** dataset) | `includeResult` |
| *(Vision, when open)* | `vision.sharedQuery` | API version = **today's date** |

Domain sharding can't fix this, because every stream goes to the one `<projectId>.<apiHost>` origin, and browsers only speak h2 over TLS. So:

- **The sim serves HTTP/2 over TLS.** On h2 the same document opens in **≈870 ms**, with every request multiplexed on one connection (CDP reports `h2` for every response).
- **The certificate is the remaining zero-effort problem.** The Claude browser pane refused the self-signed origin outright (`ERR_CERT_AUTHORITY_INVALID`) and offers no way past it. Chrome needs a manual accept, and Firefox can't use the cert for `wss:` at all. That is exactly what a first-time `npx sanity-sim` user would hit.
- **The plan:** generate a per-machine local CA on first run and offer a **one-time, user-confirmed** trust step (the OS keychain prompt, mkcert-style). Fall back to printing the accept-this-URL instruction. Installing trust changes system security settings, so it must always be the user's explicit action, never silent.

## Flow results (h2)

| Flow | Result | Cause |
|---|---|---|
| Boot, project and dataset metadata, user | ✅ | |
| Structure lists | ⚠️ renders, but the Author list shows **"Missing document — drafts.author-3 / drafts.author-4"** | Probable cause **F3** (perspective) |
| Open document | ✅ ≈870 ms | |
| **Edit a field** | ❌ **Studio crashes on the first keystroke** ("The structure tool crashed", `TypeError … reading '0' at Mutation.appliesToMissingDocument`) | **F2** |
| Create document | ❌ same crash (the create action itself returned 200) | **F2** |
| Upload image, publish, history panel | ⛔ not reached; blocked behind the crash | **F2** |
| Releases tool | ⚠️ renders empty; **create release → 400** | **F4** |
| Vision query | ✅ | |
| Global search | ✅ (`perspective=raw`) | |

## Findings

**F1 — Every Studio write was refused by the origin's anti-forgery gate.** *Fixed in this phase.* `assertWriteIsNotForged` refused `Sec-Fetch-Site: cross-site` before consulting `Origin`. A Studio on `http://localhost:<port>` writing to `https://<project>.localhost:<port>` differs in scheme **and** site, so Chrome labels every write `cross-site`, and all of them came back 403 `OVERLAY_ORIGIN_FORBIDDEN_ORIGIN`.

The tests never sent the header a real browser sends. The fix lets a granted (loopback or allow-listed) `Origin` decide first; `cross-site` still refuses whenever no granted Origin vouches for the request.
- Red-first: a new case in `origin-csrf.test.ts`, one per `Sec-Fetch-Site` value, failed on the `cross-site` value and passes after the fix.
- `origin-csrf` and `origin-safety` both pass (107 tests).

**F2 — Listener `mutation` events lack `mutations` / `previousRev` / `effects`, and Studio 6.20 crashes on them.** The origin deliberately omitted `effects`, expecting Studio to refetch. In 6.20 the document pair listener (which does **not** send `includeMutations=false`) feeds events into `BufferedDocument`. That calls `Mutation.appliesToMissingDocument`, which dereferences `mutations[0]`. **This is the top Phase 1 item.**

Every event needs the following:
- `previousRev` and `resultRev`;
- `mutations` (the mutations as applied, per document);
- `effects: {apply, revert}` in mendoza format when `effectFormat=mendoza` is requested;
- the stream's own query filter applied (gap R1).

**F3 — Studio always sends an explicit perspective, and the origin ignores it.** Every Studio query carries `perspective=raw` or `perspective=drafts`. The origin evaluates every query against the same raw corpus.
- Counts across the runs: 98 `raw` queries vs 24 `drafts`.
- `drafts` is used for `preview.document-paths` and some `sanity.studio` queries. It must overlay drafts onto published and **report published ids**. Answering it with raw `drafts.*` ids is the probable cause of the "Missing document drafts.author-N" rows.
- The `published` default for apps (gap Q1) is still untested, because Studio never relies on the default.

**F4 — Release actions are unimplemented.** Opening the release dialog sends `sanity.action.release.create` with `dryRun: true` (to validate), and that returns 400. The release list query is `*[_type=="system.release" && _id in path("_.releases.*")]` with `perspective=raw`.

**F5 — No Access API calls.** Gap S1 is downgraded. Studio 6.20 still reads permissions from `/projects/{id}/grants` (v2025-02-19) and `/projects/{id}/datasets/{ds}/acl` (v2021-06-07). It made no `/access/…/user-permissions/me` request in any flow exercised here.

**F6 — API versions in the wild.** Seen: `v2021-06-07`, `v2021-12-15`, `v2022-06-30` (socket), `v2023-12-11`, `v2023-12-18`, `v2024-09-01`, `v2024-09-19`, `v2025-02-19`, `v2025-03-01`, `v2025-06-27` (`/datasets`, from Vision), `v2026-05-04` (`/users/me`), and **the current date** (`v2026-10-29`, Vision). The sim must accept any `vYYYY-MM-DD` and gate behavior on `>= 2025-02-19`, never on an exact version.

**F7 — An endpoint not in the plan's inventory: `GET /data/history/{ds}/events/documents/{id}?limit=`.** Studio calls it on every document open. The origin answers 200 with an empty timeline. Studio also reads `/data/history/{ds}/transactions/{ids}` with `excludeContent`, `includeIdentifiedDocumentsOnly`, `effectFormat=mendoza`, `fromTransaction`, `limit`.

**F8 — Comments and Tasks listen on the main dataset**, not a `-comments` add-on dataset, in this configuration. They return empty and are harmless. Gap S4 stays P2.

**F9 — The Bifur websocket (`/socket/{ds}`, v2022-06-30) opens on every boot.** On h2 it doesn't compete for connections. The origin's refusal path didn't visibly break anything in these flows, but it still belongs in Phase 1 as an accept-and-idle stub.

**F10 — groq-js 2.0.0 against the newer GROQ functions.** Each was evaluated directly on a four-document dataset with published, draft, version and release documents.

Supported:
- `releases::all()`
- `sanity::versionOf`
- `sanity::partOfRelease`
- `sanity::projectId()` / `dataset()` (needs the `sanity` evaluate option)
- `path("_.releases.*")`
- `match` + `score()`. Every match scores `1`, so there's no hosted-style ranking.

Not implemented (they throw):
- `text::query`
- `documents::incomingGlobalDocumentReferenceCount`

The sim needs its own implementations for those two, plus a relevance approximation for `score()`.

## Request inventory

Every distinct request seen across the h2 runs (`OPTIONS` excluded). "Status" is what the **origin** answered, not what a correct sim must answer.

| Request | API version(s) | Params seen | Origin status | Needed for |
|---|---|---|---|---|
| `GET /users/me` | v2026-05-04, v2021-06-07 | | 200 | boot (identity) |
| `GET /users/me/keyvalue/{keys}` | v2025-02-19 | | 200 (`value: null`) | pane layout, announcements |
| `GET /projects/{p}` | v2021-12-15 | `includeMembers`, `includeFeatures`, `includeOrganization` | 200 | boot |
| `GET /projects/{p}/datasets` | v2025-02-19 | `datasetProfile`, `addonFor` | 200 | boot, dataset picker |
| `GET /projects/{p}/datasets/{ds}/acl` | v2021-06-07 | | 200 | permissions |
| `GET /projects/{p}/grants` | v2025-02-19 | | 200 | permissions |
| `GET /projects/{p}/user-applications` | v2025-02-19, v2024-09-01 | | 200 `[]` | chrome |
| `GET /datasets` | v2025-06-27 | | 200 | Vision dataset picker |
| `GET /features` | v2025-02-19 | | 200 `[]` | chrome |
| `GET /journey/{topic}` (scheduled-drafts, content-releases, scheduled-publishing, asset-limit, document-limit, announcements, trial, tasks, comments) | v2025-02-19, v2024-09-19, v2023-12-11 | `studioVersion` | 200 | upsells and banners |
| `GET /schedules/{p}/{ds}` | v2025-02-19 | `limit` | 200 `[]` | legacy scheduled publishing |
| `GET /help` | v1 | `m`, `locale` | 200 `[]` | help menu |
| `GET /intake/telemetry-status` | v2023-12-18 | | 200 (denied) | telemetry |
| `GET /ping` | v2025-03-01 | | 200 | connectivity check |
| `WS /socket/{ds}` | v2022-06-30 | | refused | presence (Bifur) |
| `GET /data/query/{ds}` | v2025-02-19, today's date | `perspective` (`raw`/`drafts`), `returnQuery` | 200 (perspective ignored, F3) | everything |
| `GET /data/doc/{ds}/{ids}` | v2025-02-19 | | 200 | open document |
| `GET /data/history/{ds}/events/documents/{id}` | v2025-02-19 | `limit` | 200 empty | document open, history (F7) |
| `GET /data/history/{ds}/transactions/{ids}` | v2025-02-19 | `excludeContent`, `limit`, `includeIdentifiedDocumentsOnly`, `effectFormat`, `fromTransaction` | 200 empty | history, review changes |
| `GET /data/listen/{ds}` (8 kinds, see above) | v2025-02-19, today's date | `includeAllVersions`, `visibility`, `effectFormat=mendoza`, `includeMutations`, `includeResult`, `enableResume` | 200, with filter and event shape wrong (F2) | realtime |
| `POST /data/actions/{ds}`: `document.edit`, `document.create` (`publishedId`, `attributes`; draft id in `attributes._id`; the edit sends `draftId` + `publishedId` + `patch`) | v2025-02-19 | body `transactionId` | 200 (after F1) | editing |
| `POST /data/actions/{ds}`: `release.create` (`releaseId`, `metadata{title,description,releaseType,cardinality}`, `dryRun`, `skipCrossDatasetReferenceValidation`) | v2025-02-19 | | **400** (F4) | releases |

**Not observed, because the flows were blocked behind F2:** `/assets/images|files` upload, the image CDN, `document.publish` / `unpublish` / `discard` / `delete` action shapes, `version.*` actions, history-panel reads beyond the open-time calls. The origin has no `assets` route at all. These are the first things to capture once F2 is fixed.

## Dependency note

Installing a second Studio version into the shared pnpm workspace re-resolved shared transitive dependencies. Sanity 6.8.0 in `kitchen-sink` picked up `@sanity/sdk@3.10.0` against its `^2.9.0` peer, which risks the existing e2e suite. The spike is therefore excluded from the workspace (`!examples/sim-spike` in `pnpm-workspace.yaml`) and has its own lockfile. The root lockfile is unchanged.

The real upgrade (gap V1) has to bump the overlay packages' exact peer pins together with the shared dependencies, not side by side.
