# sanity-sim — gap analysis and plan

*Written 2026-10-28. Compared against: `sanity` 6.20.0, `@sanity/client` 8.13.0, `next-sanity` 13.4.0, `@sanity/sdk-react` 3.10.0, `groq-js` 2.0.1, and HTTP API `v2025-02-19` (the last version that changes behavior).*

## Goal

```bash
npx sanity-sim
```

Run it in any project folder and you get the following:

1. It boots a local Content Lake look-alike. If the folder has no data yet, it initializes itself.
2. It points the Studio and/or app in that folder at the simulator for as long as it runs.
3. It serves a management dashboard at `/`.

Studio and the app work as-is: no code changes and no Sanity account needed.

## 1. Where the project stands

This repo is a **branch overlay**. A read-only *staging* dataset sits underneath, and branch edits live on top in `.sanity-overlay/`. Studio is wired in through a plugin (`defineOverlayConfig`). Sites read through a **registered-query** client that refuses any GROQ it can't prove complete. That was the right design for "never write to staging", but three parts of it fight the simulator goal:

| Overlay assumption | Simulator need |
|---|---|
| A base dataset exists upstream; local is a delta (intent, snapshot, three-way merge, conflicts, rebase) | The local store *is* the dataset. There is no upstream, so merge and conflicts are not needed |
| Studio needs the `sanity-overlay-studio` plugin plus about 4 `SANITY_STUDIO_OVERLAY_*` env vars | Studio works unchanged, apart from one host setting |
| Apps must migrate to `sanity-overlay-client` with pre-registered queries | Apps keep `@sanity/client` / `next-sanity` and arbitrary GROQ |

The good news: **"Mode 2 origin" is already 60% of a simulator**, but it is spike code in `examples/kitchen-sink/spikeB-proxy/origin.mjs`. It is a fake Sanity origin that never contacts Sanity. Today it answers:

- `/data/query`, as arbitrary GROQ through groq-js;
- `/data/mutate`, `/data/actions` (`document.*`) and `/data/doc`;
- `/data/listen`, as SSE;
- `/users/me`, `/projects`, `/datasets`, ACL and grants, plus the Studio "chrome" endpoints (`journey`, `features`, `intake`, keyvalue).

`sanity-overlay-core` contributes a solid mutation engine underneath: patches, paths, and Content Lake insert semantics. Both are worth keeping. The overlay's merge, conflict and registry layers are not needed for the simulator.

## 2. Gaps against the current Sanity API

Priority: **P0** blocks "Studio and app work unmodified" · **P1** is commonly hit · **P2** is a niche feature or nice to have.

### Platform and versions

| # | Gap | Pri |
|---|---|---|
| V1 | Pinned to `sanity@6.8.0` / `@sanity/client@7.26.0` (exact peer pins in `sanity-overlay-studio`). Current versions are 6.20.0 and **8.13.0, a major release later**. `next-sanity@13` peers on `@sanity/client ^7.28 \|\| ^8.11`, so the pinned client can't be installed alongside it | P0 |
| V2 | Studio v6 changed auth (`auth.providers` array, `auth.mode` removed) and switched the default search to `groq2024`. Neither has been run against the origin | P0 |
| V3 | The origin is not a package. It needs `--experimental-strip-types`, a resolve hook, and imports of `.ts` source. Every package is `private`, and nothing is on npm | P0 |
| V4 | `groq-js` 2.0.0 → 2.0.1 (fixes the `score()` pipe type) | P2 |

### Query API (`/data/query`)

| # | Gap | Pri |
|---|---|---|
| Q1 | **No `perspective` handling.** The corpus is always published + drafts, which amounts to `raw`. Since `v2025-02-19` the default is `published`, so **apps would leak drafts** and Studio's own `drafts` / `published` reads are wrong. **[Phase 0](evidence/sanity-sim-phase-0/request-inventory.md) F3: Studio always sends `raw` or `drafts` explicitly; ignoring `drafts` produces "Missing document" rows** | P0 |
| Q2 | No release-stack perspectives (`perspective=rel1,rel2,drafts`); no `versions.*` documents in the corpus | P1 |
| Q3 | No `syncTags` in responses, so `next-sanity` `defineLive` / `sanityFetch` cache tagging has nothing to key on | P0 for Next apps |
| Q4 | No `resultSourceMap`, which Presentation / visual editing / stega need | P1 |
| Q5 | Not handled: `returnQuery=false`, `explain`, `tag`, `cacheMode`, or strict 400s for bad params and unknown POST body fields | P2 |
| Q6 | No `apicdn` host. The client sends `useCdn:true` traffic to `<p>.apicdn.sanity.io`, and only `published` / `raw` are valid there | P1 |
| Q7 | Not verified in groq-js: `releases::all`, `sanity::versionOf` / `partOfRelease`, `text::query`, `documents::incomingGlobalDocumentReferenceCount`. `match` / `score` ranking is approximated (and flagged as such) | P1 |
| Q8 | GROQ error shape (`{error:{query,description,start,end,type}}`) needs to match exactly; Vision and the client display it | P2 |

### Writes

| # | Gap | Pri |
|---|---|---|
| W1 | `/data/mutate` options are ignored: `returnIds`, `returnDocuments`, `visibility`, `dryRun`, `autoGenerateArrayKeys`, caller-supplied `transactionId`. The response is missing `results[]` | P0 |
| W2 | The Actions API has only `document.*`, including the deprecated `discard` / `replaceDraft`. Missing: `document.version.{create,discard,replace,unpublish}` and `release.{create,edit,publish,schedule,unschedule,archive,unarchive,delete,import}`. **The Releases UI in Studio 6 is on by default and will error** | P0 (version) / P1 (release) |
| W3 | Releases data model: `_.releases.<id>` (`system.release`) and `versions.<id>.<docId>`, with state transitions (`active → scheduling → scheduled → published`) and locks while scheduled | P1 |
| W4 | No scheduler for scheduled releases / scheduled drafts, so nothing fires at `publishAt` | P2 |
| W5 | `ifRevisionID` / `ifPublishedRevisionId` optimistic locking needs real `_rev` per document (the origin reuses `transactionId` as `_rev`, which is fine, but must 409 on mismatch) | P1 |

### Realtime

| # | Gap | Pri |
|---|---|---|
| R1 | **Listen ignores its `query` filter** and over-delivers every event to every stream. No `transition: appear/disappear` computed per filter, which apps using `client.listen(filter)` rely on | P0 |
| R2 | **No `effects` (mendoza)** on mutation events. Studio's document store applies remote changes from mendoza effects; without them it refetches, and the overlay needed a whole "echo" layer to keep cursors stable. A real simulator should emit real effects. **[Phase 0](evidence/sanity-sim-phase-0/request-inventory.md) F2: worse than assumed. Events also lack `mutations` / `previousRev`, and stock Studio 6.20 crashes on the first keystroke** | P0 |
| R3 | No `includeAllVersions`, `includePreviousRevision`, `includeMutations`, `enableResume` / `Last-Event-ID` → `welcomeback` / `reset` | P1 |
| R4 | **No Live Content API** (`/data/live/events`), so `next-sanity` `<SanityLive>` never refreshes | P0 for Next apps |
| R5 | The Bifur socket (`/socket/<ds>`) is refused. That is presence only, but a refusal makes the client reconnect forever. Replace it with an accept-and-stay-quiet JSON-RPC stub | P2 |
| R6 | **The browser's 6-connection HTTP/1.1 limit.** Studio's listeners exhaust it, so the origin only works over HTTP/2, which needs TLS, which today means a self-signed cert the user must accept by hand (and Firefox can't at all). That is not zero-effort. See §4. **[Phase 0](evidence/sanity-sim-phase-0/request-inventory.md): measured 8 listen streams plus a websocket per open document; h1 hangs. Decision: HTTP/2 over TLS with a local CA** | P0 |

### Reads, history, export

| # | Gap | Pri |
|---|---|---|
| D1 | `/data/doc`: no `includeAllVersions` / `excludeContent`; must 400 on `perspective` | P2 |
| D2 | **History is empty.** Studio's review-changes and history panes show nothing, and revert/restore doesn't work. Needs a real transaction log with mendoza effects and `/data/history/{ds}/documents/{id}?revision\|time` | P1 |
| D3 | `/data/export` is unimplemented. `sanity dataset export` against the sim fails, and it's also the natural backup format | P1 |
| D4 | No import path for `sanity dataset export` tarballs (NDJSON + assets), which is the obvious seeding route | P1 |

### Assets

| # | Gap | Pri |
|---|---|---|
| A1 | The origin has **no `/assets/images` or `/assets/files` routes**. Image fields in Studio can't upload | P0 |
| A2 | No asset document metadata: `dimensions`, `lqip`, `palette`, `blurHash`, `thumbHash`, `sha1hash`, dedup by hash | P1 |
| A3 | **No image CDN.** `@sanity/image-url` builds `cdn.sanity.io/images/<p>/<ds>/<hash>-WxH.ext?w=&h=&fit=&crop=&rect=&fm=&auto=format&q=&dpr=` and the app's `<img>` tags hit the real CDN, which 404s for sim-only assets. Needs a local transform endpoint (`sharp`) **and** a way to route the URLs (see §4) | P0 |
| A4 | `from-url` upload; Media Library (global refs `dataset:<p>.<ds>:<id>`) | P2 |

### Studio boot and identity

| # | Gap | Pri |
|---|---|---|
| S1 | Newer Studios check permissions through the **Access API** (`/v2025-07-11/access/project/{id}/user-permissions/me` and `/me/check`). The origin only answers the legacy `/projects/{id}/grants` + `/acl`. Needs verifying against 6.20, because a missing grant renders Studio read-only. **[Phase 0](evidence/sanity-sim-phase-0/request-inventory.md) F5: 6.20 made no Access API calls, so this is downgraded** | P2 |
| S2 | `/auth/*` (providers, logout) and `/projects/{id}/users/{id}` (avatars) aren't answered | P1 |
| S3 | `/users/me/keyvalue` PUT returns 403, so pane layout doesn't persist. A sim should store it | P2 |
| S4 | No add-on dataset (`<dataset>-comments`), so Comments and Tasks break | P2 |
| S5 | Single project and single dataset only; `sanity dataset list` / workspace switchers with two datasets fail | P1 |
| S6 | Agent Actions, Canvas, Content Agent, embeddings, Functions: out of scope. Answer them with a clean 501 and a clear message | P2 |

### DX and product

| # | Gap | Pri |
|---|---|---|
| X1 | Running the demo takes **4 processes, about 10 env vars and a cert step** (see the demo recipe). The existing `sanity-overlay dev` runs the overlay API, not the origin | P0 |
| X2 | No auto-detection of projectId / dataset from `sanity.cli.ts`, `sanity.config.ts`, or `.env*` (`SANITY_STUDIO_*`, `NEXT_PUBLIC_SANITY_*`) | P0 |
| X3 | No dashboard. Today the only ways to inspect data are Studio and CLI verbs | P0 (requested) |
| X4 | Storage is the overlay format (intent / snapshot / records / `.runtime/`), which is heavy for a plain dataset. A simulator wants `sanity dataset export`-compatible NDJSON | P1 |
| X5 | Node-side `*.localhost` resolution breaks under Tailscale MagicDNS (seen on this machine), so the sim must not rely on `<projectId>.localhost` for Node clients | P1 |

## 3. Package name

**Recommendation: `sanity-sim`.** It is unclaimed on npm (checked 2026-10-28). It's 10 characters, says what it is, and `npx sanity-sim` reads naturally. The bin has the same name.

Runner-up: `lakesim`, if you want to stay clear of Sanity's trademark entirely. An unscoped `sanity-*` name is common in the ecosystem (`sanity-plugin-*`), but the README must say plainly that it's unofficial. Also free: `sanity-local`, `sanity-emulator`, `localake`.

## 4. Design

### 4.1 One command

```
npx sanity-sim            # in a project folder
```

1. **Detect.** Find `sanity.config.*` / `sanity.cli.*`, `package.json` (next / astro / remix / nuxt / sveltekit), and `.env*`. Resolve `projectId` and `dataset`. If nothing is found, use `projectId=simlocal` and `dataset=production`.
2. **Init if empty.** Create `.sanity-sim/` and ask once, interactively (or take a flag in CI), how to seed:
   - empty (default);
   - `--seed ./export.tar.gz|.ndjson`, a `sanity dataset export` file;
   - `--seed-from production`, a **read-only** Export API pull using the user's own `sanity login` / token. That's a GET only, so it fits the repo's "never write to Sanity" rule.
3. **Serve** on `https://localhost:3939`: the API under `/v*/…`, the image/file CDN under `/images/…` and `/files/…`, and the dashboard at `/`.
4. **Wire.** Run the project's own dev script (`npm run dev`, or `sanity dev` + `next dev` in a monorepo) **as child processes, with env injected** (§4.2). Ctrl-C stops everything. `--no-dev` runs the server only.

Other verbs, for when you need them: `sanity-sim reset`, `export`, `import`, `snapshot` / `restore`, `eject` (undo the wiring), `status`.

### 4.2 Pointing Studio and apps at it without code changes

This is the hard part. Sanity has **no official emulator or host override by env var**. Studio's docs say it always talks to the hosted Content Lake. Three layers, in order of how invisible they are:

| Target | Mechanism | Code change |
|---|---|---|
| **Node-side app code** (Next server components, route handlers, Astro / Remix loaders, scripts) | The child dev process gets `NODE_OPTIONS=--import sanity-sim/register`. That hook patches `fetch` / undici / `http(s).request` to rewrite `*.api.sanity.io`, `*.apicdn.sanity.io` and `cdn.sanity.io` to the sim. It works for `@sanity/client`, `next-sanity`, `groq` fetches and anything else | **None** |
| **Studio** (runs in the browser, so no Node hook can reach it) | Studio's `apiHost` workspace option is the supported knob. On first run the CLI adds a **one-line, guarded** wrapper: `export default withSanitySim(defineConfig({...}))`. It is a no-op unless `SANITY_STUDIO_SIM_URL` is set, and that variable only exists in the child env from §4.1. Plain `sanity dev` and `sanity deploy` are byte-for-byte unaffected. `sanity-sim eject` removes it | One generated line, idempotent and reversible |
| **Browser-side app code** (client components using `@sanity/client`, `<SanityLive>`, Presentation, `<img src="cdn.sanity.io/…">`) | Same pattern: the CLI injects `NEXT_PUBLIC_SANITY_SIM_URL` (or the framework's equivalent), and a codemod wraps the project's `createClient` / `imageUrlBuilder` call sites (one file in the standard next-sanity template). Image URLs could alternatively be rewritten server-side by the register hook when it sees them in query results | One generated line per client |

**Optional, later: `--intercept`**, for true zero-touch. A local CA plus a system proxy/PAC for `*.sanity.io`. It covers everything, but it changes system network and trust settings, so it must be an explicit opt-in that the user runs with their own approval.

**HTTP/2 / TLS (gap R6).** First, measure whether Studio 6.20 still opens more than 5 concurrent listen streams per host. The client has been moving toward a shared listener. If it doesn't, plain `http://localhost` works and the cert problem goes away. If it does, `sanity-sim` generates a local CA in `~/.sanity-sim/` and offers a one-time trust step that the user confirms (mkcert-style, macOS keychain prompt). It falls back to printing the accept-the-cert URL. Serve every host shape (`localhost`, `<projectId>.localhost`, `<projectId>.api.localhost`) from one listener.

### 4.3 Storage (`.sanity-sim/`)

```
.sanity-sim/
  config.json                    projectId, datasets, port, apiVersion floor
  datasets/<name>/local.ndjson        local layer: sorted by _id, one doc per line → stable git diffs (committed)
  datasets/<name>/tombstones.ndjson   local deletes of remote docs, with baseRev (committed)
  datasets/<name>/remote.ndjson       synced snapshot, §4.4 (gitignored cache; absent when never synced)
  datasets/<name>/remote.json         sync source, syncedAt, last remote transaction
  datasets/<name>/transactions.ndjson   append-only local log with mendoza effects (history API)
  assets/<sha1>.<ext>            local uploads; remote binaries and transforms cached in .sanity-sim/.cache (gitignored)
```

With no sync configured, `local.ndjson` *is* the dataset. Every file uses the same NDJSON shape as `sanity dataset export`, so import and export are trivial. In memory it's a `Map` with indexes by `_type` and by reference (for `references()` and incoming-reference counts). The file is rewritten on a debounce, and an fs watcher picks up hand edits.

### 4.4 Sync from a real dataset, with a local layer on top

The sim replaces the overlay as a separate product. A dataset in the sim has two layers:

```
effective view  =  remote snapshot  ⊕  local layer        (per _id, local wins)
                   (pulled, read-only)   (your edits + tombstones)
```

- **Remote snapshot.** `.sanity-sim/datasets/<name>/remote.ndjson` plus `remote.json` (source project/dataset, synced-at, last transaction id). Pulled with the Export API, plus Doc/Query reads for drafts and versions. It's a cache, so it's gitignored by default.
- **Local layer.** `local.ndjson` holds whole documents the user created or edited. `tombstones.ndjson` holds ids deleted locally that still exist remotely. This layer is the user's content and is committed.
- **Document-level granularity, keyed on the raw `_id`.** `drafts.x`, `x` and `versions.r.x` are separate entries. That matches how Content Lake stores them, so perspectives work unchanged on the merged corpus. A local edit to an unpublished draft shadows only that draft. Publishing locally writes a local `x` and tombstones `drafts.x`.
- **Writes always land in the local layer.** The first write to a remote document copies it into the local layer and records its remote `_rev` as `baseRev`. Nothing is ever sent to Sanity.
- **No query registry.** The whole dataset is local, so arbitrary GROQ runs on the merged corpus. That's the main simplification over the overlay, which avoided copying the dataset and had to prove each query complete.

**Sync.** The dashboard has a "Sync from `<project>/<dataset>`" button, with optional sync on startup (`--sync`) and an optional "follow" mode. Follow mode keeps one read-only `/data/listen` stream open to the remote, so the snapshot updates live.

- A sync replaces the remote snapshot and never touches the local layer.
- **Stale detection:** a local document whose remote `_rev` changed since its `baseRev` is flagged as stale. A local tombstone over a remote document that has since changed is flagged too.
- The dashboard's stale list offers four actions:
  - **Keep mine**: bump `baseRev`.
  - **Take remote**: drop the local copy.
  - **Merge**: three-way, field-level, reusing `sanity-overlay-core`'s merge with `baseRev` as the ancestor. That means fetching the ancestor through the History API, read-only.
  - **Diff**: show a field diff.
- Stale documents keep serving the local copy; nothing changes silently.
- Optional filters: `types` (passed to Export), and drafts/versions on or off.

**Credentials come from the project, read in this order:**
1. `SANITY_API_READ_TOKEN` / `SANITY_API_TOKEN` / `SANITY_AUTH_TOKEN` in `.env*`;
2. the user's `sanity login` session (`~/.config/sanity/config.json`);
3. no token, which works for public datasets (published documents only).

The project id and dataset come from the same detection as §4.1.

**The never-write rule moves from "refuse write tokens" to "never send one".** The overlay crashed on purpose when it saw a write-capable token. Projects commonly keep one in `.env` (`SANITY_API_WRITE_TOKEN`), so the sim instead:
- routes every upstream call through the existing default-deny write guard: GET only, plus a POST to `/data/query` for long queries;
- picks a read token when one exists;
- keeps the test-suite network monitor that fails any non-GET to `*.sanity.io`.

**Assets.** Asset documents sync with the dataset. Binaries are fetched lazily from `cdn.sanity.io` on first request (the CDN is public) and cached under `.sanity-sim/.cache/assets`. Locally uploaded assets live in the local layer like any document.

**Reset semantics.** The dashboard gives three choices:
- "Discard local changes" drops the local layer;
- "Re-sync" refreshes the remote snapshot;
- "Detach" freezes the snapshot and stops syncing.

### 4.5 Dashboard at `/`

`https://localhost:3939/` is free because every API path is versioned (`/v…`). It's a small SPA bundled into the package that talks to the sim's own public API plus a few `/_sim/*` admin routes:

- **Documents.** Browse by type with counts; drafts, published and versions shown side by side; raw JSON editor with `_id` / `_type` / `_ref` validation; create, duplicate, delete; publish and unpublish.
- **Query.** A GROQ playground with a perspective picker (published / drafts / raw / release stack), params, timing and `syncTags`.
- **Activity.** A live tail of transactions, plus a **request log** of every API call from Studio and the app with status, timing and perspective. That's the main debugging win over hosted Sanity.
- **Assets.** A gallery with metadata, upload, and finding which documents reference an asset.
- **Releases.** List, state, contained versions; publish or schedule now.
- **Dataset.** Import, export, snapshot and restore, reset; switch or create datasets.
- **Sync** (§4.4). The remote source and last-synced time, a Sync now button, a follow toggle, a "local changes" view (documents the user has changed vs remote, like a git status), and the stale list with keep, take, merge and diff.
- **Connections.** What's wired (Studio / app detected, last-seen clients, API versions in use), and any unsupported endpoints that were hit (501 count). That gives users an honest view of fidelity.

## 5. Build plan

The work goes in a new package, `packages/sanity-sim` (server + CLI + register hook + dashboard), depending on `sanity-overlay-core` for the mutation engine and on `groq-js`. The overlay packages stay as they are; see the open decision below.

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Spike** ✅ 2026-10-28, [Phase 0](evidence/sanity-sim-phase-0/request-inventory.md) | Upgrade the example to `sanity@6.20` / `@sanity/client@8`, point it at the current origin with only `apiHost`, and record every request Studio 6.20 makes on boot, edit, publish and releases. Measure concurrent listeners. Check the Access API. Check groq-js on `releases::all`, `versionOf`, `text::query` | A request inventory, and an h1-vs-h2 decision |
| **1. Core server** | Promote the origin into `sanity-sim` as a proper TS package. Perspectives (Q1, Q2), `syncTags`, mutate options (W1), `_rev` locking, filtered listen with mendoza effects (R1–R3), document + version actions (W2), Access API (S1), the apicdn host, multi-dataset, NDJSON store, import/export | Unmodified Studio 6.20 can create, edit, publish and unpublish with history; `@sanity/client@8` passes a contract suite run against both the sim and a real dataset (read-only) |
| **2. One command** | Detection, init and seeding, the child-process runner, the `register` hook, the Studio wrapper codemod, and `eject` | `npx sanity-sim` in a fresh `npm create sanity@latest` + next-sanity template works with zero manual steps |
| **3. Dashboard** | §4.5 | Every dashboard edit shows up live in Studio, and the other way round |
| **3b. Sync** | §4.4: credential detection, Export pull into a remote snapshot, the layered corpus, `baseRev` stale detection, the dashboard sync and stale views, follow mode | Sync a real dataset (read-only, network monitor green), edit in Studio, re-sync after a remote change, see the doc flagged stale, resolve it all three ways |
| **4. Fidelity** | Assets and image CDN (A1–A3), Live Content API (R4), history (D2), releases and the scheduler (W3, W4), the Bifur stub, the comments add-on dataset, `resultSourceMap` | Presentation tool + `<SanityLive>` work in the next-sanity template |
| **5. Ship** | npm publish, browser e2e in CI against the template projects, and a compatibility matrix in the README tracking Studio and client versions | `npx sanity-sim@latest` from the registry |

## 6. Open decisions

1. **What happens to the overlay?** **Decided 2026-10-28:** it is replaced by sync plus a document-level local layer inside the sim (§4.4). The overlay's Studio plugin, query registry, proxy mode and field-level intent are retired. `sanity-overlay-core` is kept for the mutation engine and for the three-way merge behind the "Merge" button.
2. **Should `.sanity-sim/` be committed by default?** Committing it gives shared fixture content and reviewable diffs. Gitignoring it gives personal scratch data. **Recommendation: commit documents, gitignore assets over 1 MB and the cache, and ask on init.**
3. **Is a one-line generated wrapper in `sanity.config.ts` acceptable?** It's the only supported path short of system-level interception.
