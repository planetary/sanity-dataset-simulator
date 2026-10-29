# sanity-sim

**A local Sanity Content Lake.** Run one command in a project folder and your Studio and your app work against local data, without code changes and without a Sanity account. A management dashboard runs at the server root.

```bash
npx sanity-sim
```

> Unofficial. Not affiliated with or endorsed by Sanity.

## What happens when you run it

1. **Detects** what's in the folder: `sanity.config.*` / `sanity.cli.*`, `.env*` files (`SANITY_STUDIO_*`, `NEXT_PUBLIC_SANITY_*`, `PUBLIC_SANITY_*`, …), the framework (Next, Astro, SvelteKit, Vite, Remix, Nuxt), your dev script and your package manager.
2. **Initializes** `.sanity-sim/` on first run. In a terminal, if a Sanity project was detected, it offers to pull the real dataset first (read-only). Otherwise you start empty, or seed with `--seed file.ndjson`.
3. **Serves** the API and the dashboard on one port (default `3939`).
4. **Wires** the folder (see [Wiring](#wiring)), then **runs your dev script** with the environment that points everything at the simulator. Ctrl-C stops everything.

```
sanity-sim 0.1.0 · project abc123 · dataset production

  Dashboard  http://localhost:3939/
  API        https://localhost:3939  (Node/curl: http://localhost:3939)
  Data       .sanity-sim/ (1204 synced from abc123/production, 3 local, 0 deleted locally)
  Studio     wired sanity.config.ts
```

### One-time: trust the local certificate

Studio holds 8+ live connections per open document, which is more than browsers allow over HTTP/1.1 (6 per host). So the simulator serves **HTTP/2 over TLS** with a certificate from a per-machine local CA. Trust it once:

```bash
npx sanity-sim trust
```

The first `npx sanity-sim` in a terminal starts this step for you. It trusts the CA for your user only (no admin rights), and your OS asks you to confirm: the keychain password dialog on macOS, a security prompt on Windows. Linux adds it to Chrome's NSS store. The CA is **name-constrained to `localhost` names**, so trusting it cannot vouch for any other site. Firefox reads the system's certificates only at startup, so quit and reopen it afterwards (`security.enterprise_roots.enabled` must be on, which is the default on macOS). The dashboard is also available over plain `http://localhost:3939/` and needs no certificate.

**Cancelled, or on a managed machine?** If you cancel, or the OS refuses (some corporate policies block user-level trust), sanity-sim keeps running, prints the alternatives, and stops asking on later runs until you run `npx sanity-sim trust` again. The alternatives:

- Open `https://<projectId>.localhost:3939/` once and accept the warning. This works in Chrome, Edge and Safari, unless a managed browser forbids certificate exceptions.
- Ask IT to trust `~/.sanity-sim/ca/ca.pem`. Its name constraints limit it to `localhost`, `*.localhost` and loopback IPs, which is usually an easy approval.
- Use `--http`. No certificate is needed, but browsers allow only 6 HTTP/1.1 connections per host, so Studio stalls once several documents are open.

## Wiring

Sanity has no built-in way to point a Studio or app at another API host through the environment, so `sanity-sim` makes small, **marked, reversible** edits. Each edit is **inert unless sanity-sim's environment variables are present**, and those only exist in the processes `npx sanity-sim` starts. Plain `sanity dev`, `next dev`, builds and deploys behave exactly as before.

| What | How | Code change |
|---|---|---|
| Server-side code (Next server components and route handlers, Astro/Remix loaders, scripts) | The dev process gets `NODE_OPTIONS=--import sanity-sim/register`. It reroutes `fetch`, `http(s).request` and `tls.connect` for `*.api.sanity.io`, `*.apicdn.sanity.io`, `api.sanity.io` and `cdn.sanity.io` to the simulator. That covers `@sanity/client`, `next-sanity` and plain `fetch` | **none** |
| Studio (standalone or embedded) | The config's default export is wrapped with `withSanitySim(...)`, which sets `apiHost` when `SANITY_STUDIO_SIM_API_HOST` (or `NEXT_PUBLIC_SANITY_SIM_API_HOST`) is set | one marked block |
| Browser-side clients (`createClient({...})` in client components, Vite/Astro apps) | A guarded `apiHost` spread is added to the options object | one marked comment pair per call |

Undo everything with `npx sanity-sim eject`, which restores each file byte-for-byte. Pass `--no-wire` to skip the edits; server-side code still works through the register hook alone.

The register hook redirects TLS connections for Sanity's hostnames to the simulator. The simulator answers them with a certificate from a **second, Node-only CA**. That CA is handed to the dev processes through `NODE_EXTRA_CA_CERTS` and is never installed in your system trust store.

**Draft Mode without a token.** next-sanity's draft-mode route and `defineLive` need a read token, and the simulator accepts any token. If your project has none (no `SANITY_API_READ_TOKEN`, `SANITY_API_TOKEN`, … in the environment or `.env` files), the dev processes get a placeholder `SANITY_API_READ_TOKEN`, so Presentation and Draft Mode work out of the box. A token you do have is left alone.

## Dashboard

Open `http://localhost:3939/`:

- **Documents.** Browse by type, search, filter to local changes, and edit raw JSON with validation. Publish, unpublish, discard drafts, revert to the synced version, delete, and browse and restore local history.
- **Query.** GROQ with parameters and a perspective picker (published, drafts, raw, or a release), with timing and sync tags.
- **Activity.** Live transactions, plus every request Studio and your app made (filter by writes, errors or unsupported calls).
- **Assets.** A gallery with upload and reference counts.
- **Releases.** Create, publish now, schedule, archive and delete.
- **Sync.** Pull a real dataset, follow it live, see local changes like a `git status`, and resolve stale documents (keep mine, take synced, or a three-way merge).
- **Datasets.** Create and switch datasets, link a name to one and hot-swap it, import and export, discard local changes, wipe.
- **Connections.** Which clients are connected and which API versions they use, any endpoints they called that the simulator doesn't implement, certificate status, and snippets for wiring by hand.

## Workspaces and multiple projects

A Studio with several workspaces works as-is, including workspaces on **different projects**. The wiring sets `apiHost` on every workspace, and each project has its own datasets, links, releases and history:

- **Main project.** The one in `sanity.cli.*`, or else the first one found. It lives where it always has, in `.sanity-sim/`.
- **Other projects.** Each one lives in `.sanity-sim/projects/<projectId>/`. They are created on first use, just as datasets are. Asset files are content-addressed and shared between projects.

Requests are matched to a project the way Content Lake does it, by hostname (`<projectId>.localhost`, or `<projectId>.api.sanity.io` through the register hook). Paths like `/projects/<projectId>/…` are matched too. Every project id found in your Studio config is put on the certificate at startup. A project the simulator hasn't seen before gets its name added during its first TLS connection, so no restart is needed. When there is more than one project, the dashboard shows a project picker.

## Linked datasets (hot swap)

Keep several datasets side by side and choose which one your Studio and app see, without touching their config:

```bash
npx sanity-sim import empty-state.ndjson --dataset test-1
npx sanity-sim import big-catalog.ndjson --dataset test-2
npx sanity-sim link production test-1   # Studio and the app now see test-1 as "production"
npx sanity-sim link production test-2   # swap, while everything runs
npx sanity-sim unlink production
```

A **link** is a name, here `production`, that resolves to a stored dataset. Every request through that name reads and writes the target, and Sanity's alias spelling `~production` works too. Re-pointing a link while the simulator runs disconnects the listeners and live connections that came in through that name. Studio and `@sanity/client` reconnect and refetch, so the swap shows up within a few seconds, with no restart or reload. Next.js apps using the Live Content API get a sync-tag invalidation for both datasets. A document open in Studio that doesn't exist in the new dataset shows as deleted.

If the name you link already holds documents, they are kept as a stored dataset named `<name>-original`, so nothing is lost, and `npx sanity-sim unlink <name>` puts them back under the name. The same controls are on the dashboard's **Datasets** page, and the dataset picker shows links as `production → test-1`. Links live in `.sanity-sim/config.json`.

## Media Library

Studios with `mediaLibrary: {enabled: true}` work against a local **Media Library**: an asset library shared by every project in the folder, as a real one is shared by an organization's projects. Pick images and files from it in Studio, upload to it (from the picker or by dropping files on a field), and open an asset in it from the field's menu.

- **The picker.** Studio normally frames the hosted app at media.sanity.io. While `npx sanity-sim` runs, the Studio wiring points `mediaLibrary.__internal.frontendHost` at a small local picker served by the simulator, which speaks the same messages. Workspaces without Media Library are left alone.
- **Linking.** Choosing an asset links it into the dataset, as Content Lake does: an ordinary `sanity.imageAsset`/`sanity.fileAsset` document is created with `source.name: "sanity-media-library"` and a `media` reference back to the library, and the field gets Studio's usual `asset` reference plus a weak `media` global document reference. Front-ends resolve it with plain GROQ, and the image is served from the dataset's usual path.
- **The API.** Library lookup and listing, the library's own `query`/`doc`/`mutate`/`actions`/`listen`, `upload`, usage (`references/documents/<id>/to`), video `playback-info`, and the library CDN path `@sanity/image-url` builds for a Media Library client. The default library is `mlsimlocal`; a `libraryId` set in your Studio config is created locally on first use, so references keep their ids.
- **Synced from a real library.** When you sync a dataset whose assets came from a Media Library, the library assets it references come along, read-only (see [Syncing a real dataset](#syncing-a-real-dataset)).
- **Not simulated.** Video playback (Studio plays through Mux on a fixed host, so stored videos have no working player), aspects and asset editing in the picker, and private-asset signed URLs (a private synced asset's bytes can't be fetched without them).

Libraries live in `.sanity-sim/media-libraries/<id>/`, in the same files as a dataset.

## Syncing a real dataset

```bash
npx sanity-sim --sync            # pull before starting
npx sanity-sim --sync --follow   # …and keep the snapshot live
npx sanity-sim sync              # pull, then exit
```

A dataset in the simulator has two layers. The **synced snapshot** sits underneath; it's a cache and is gitignored. **Your local documents and deletions** sit on top and are committed. The layers combine per document id: a local copy wins, and a local deletion hides the synced document. Writes from Studio, your app or the dashboard always land in the local layer.

**Media Library assets come along.** If the dataset references a Media Library (images and files picked from one, `sanity.video` fields), sync also reads those library documents: each referenced asset with all its versions, through the same read-only path. They go into the local library's synced layer, so the picker lists them, "Open in Media Library" finds them, and you can pick them into other datasets. Their bytes are fetched from the asset's own URL the first time they're served, then cached. `--follow` pulls library assets that newly synced changes reference. A library your token can't read is reported, and the dataset sync still succeeds.

When the real dataset changes under a document you've edited, the document is flagged **stale** on the Sync page. Resolve it there by keeping yours, taking the synced version, or merging (field-level, three-way, with the ancestor read from Sanity's history API).

**Read-only, by construction.** Every request to Sanity goes through one function that refuses any method except GET. A token is only ever sent to `*.sanity.io`. Credentials come from your project's `.env` (`SANITY_API_READ_TOKEN`, `SANITY_API_TOKEN`, `SANITY_AUTH_TOKEN`, …) or your `sanity login` session. Without a token, only published documents of public datasets can be read.

## Files

```
.sanity-sim/
  config.json                         project, datasets, sync sources
  datasets/<name>/local.ndjson        your documents, sorted by _id (commit)
  datasets/<name>/tombstones.json     local deletions of synced documents (commit)
  datasets/<name>/base.json           synced _rev each local change was made against (commit)
  datasets/<name>/remote.ndjson       synced snapshot (gitignored)
  datasets/<name>/transactions.ndjson local history with mendoza effects (gitignored)
  assets/                             uploaded files by sha1
  media-libraries/<id>/               the local Media Library: your uploads (commit), synced assets (gitignored)
  .cache/                             synced assets fetched from Sanity's CDN (gitignored)
```

Everything is NDJSON in the same shape as `sanity dataset export`, so diffs stay readable and `import`/`export` are lossless.

## Commands

| Command | |
|---|---|
| `npx sanity-sim` | Start, wire, and run your dev script |
| `npx sanity-sim serve` | Start the simulator only |
| `npx sanity-sim sync` | Pull the real dataset (read-only) |
| `npx sanity-sim status` | Project, datasets, local changes, certificate |
| `npx sanity-sim import <file>` | NDJSON or a `sanity dataset export` `.tar.gz` (images and files included) |
| `npx sanity-sim export <file>` | NDJSON (`.ndjson.gz` to compress) |
| `npx sanity-sim link <name> <dataset>` | Point a name at a stored dataset; again to hot-swap |
| `npx sanity-sim unlink <name>` | Remove a link |
| `npx sanity-sim reset [--all]` | Discard local changes (or wipe everything) |
| `npx sanity-sim trust` | Trust the local HTTPS certificate |
| `npx sanity-sim eject` | Remove the wiring edits |

Options: `--port`, `--dataset`, `--project`, `--no-dev`, `--no-wire`, `--sync`, `--follow`, `--types <a,b>`, `--seed <file>`, `--http`, `--origin <url>`, `--root <dir>`, `--yes`.

## Compatibility

Verified against **Sanity Studio 6.20**, **@sanity/client 8.13**, **next-sanity 13.4** and **Next.js 16.4**, with the HTTP API at `v2025-02-19` (any `vYYYY-MM-DD`, `v1` and `vX` are accepted).

| Area | Status |
|---|---|
| Query API: GROQ, params, GET/POST | ✅ via groq-js 2 |
| Perspectives: `published` (default from v2025-02-19), `drafts`, `raw`, release stacks, `_originalId` | ✅ |
| `text::query` (Studio lists and search) | ✅ exact for unfiltered lists; prefix-token approximation for typed terms (reported in `simApproximations`) |
| `text::semanticSimilarity` inside `score()` (semantic search) | ✅ approximation: a document scores the share of the search words its text contains (no embeddings; reported in `simApproximations`) |
| `documents::incomingGlobalDocumentReferenceCount()`, `user::attributes()` | ✅ `0` (no other Sanity resources exist locally) and `{}` (the local user has no custom attributes) |
| `syncTags`, Live Content API (`/data/live/events`) | ✅ one coarse tag per dataset (over-invalidates, never under-) |
| `resultSourceMap` (Presentation, stega) | ✅ inferred conservatively for string values |
| Presentation and Draft Mode (next-sanity `defineEnableDraftMode`, `defineLive`, `<VisualEditing>`) | ✅ preview secrets, drafts in the preview, click-to-edit overlays, live draft edits, published pages revalidated by `<SanityLive>` (see `examples/sim-next`) |
| Mutate API: create/createOrReplace/createIfNotExists/patch/delete, query-based patch/delete, `ifRevisionID`, `returnIds`/`returnDocuments`/`dryRun`/`autoGenerateArrayKeys`/`transactionId`, atomic | ✅ patches applied by `@sanity/mutator` |
| Actions API: document, version and release actions; release scheduling | ✅ |
| Listen API: filters, transitions, `mutations`, `previousRev`/`resultRev`, mendoza `effects`, `includeResult`/`includePreviousRevision`/`includeAllVersions`, resume | ✅ |
| History: translog, document revisions, lifecycle events (Studio's history panel, review changes) | ✅ for local changes; synced documents have no prior history |
| Doc API, Export API | ✅ |
| Assets: upload, `from-url`, dedup by sha1, dimensions, LQIP, image CDN transforms (`w`, `h`, `fit`, `crop`, `rect`, `fm`, `auto=format`, `q`, `dpr`, …) | ✅ transforms and LQIP need `sharp` (optional dependency); without it, originals are served |
| Studio boot: users, projects, datasets, grants, ACL, features, release limits, key-value settings | ✅ one local user with every grant |
| Presence (Bifur websocket) | ⚠️ accepted and answered; single-user, so no presence |
| Comments and Tasks (add-on datasets) | ✗ features reported off |
| Media Library: library lookup, picker and uploads in Studio, linking into datasets, library GROQ/doc/mutate/listen, usage, CDN path | ✅ local picker in place of media.sanity.io; video stored but not playable (see [Media Library](#media-library)) |
| Agent Actions, Canvas, Functions, embeddings | ✗ clear 501, listed on the Connections page |

## Known limitations

- **Studio's feedback tunnel.** Studio sends Sentry error reports and feedback to a hardcoded `https://api.sanity.io/vX/intake/feedback` that ignores `apiHost`. No document content is involved, but those requests do leave your machine.
- **One local user.** No roles, no access control, and no real presence.
- **`--project` renames the main project.** To work with another project's data from the CLI, use the dashboard's project picker or the API (`x-sanity-sim-project` header) instead.
- **Loopback only.** The server binds to `127.0.0.1`/`::1` and accepts writes only from loopback browser origins (`--origin` adds one). It's a development tool, not a server to expose.
- **Search ranking.** Typed searches match by prefix tokens; there's no stemming and no hosted relevance scoring.
- **Large datasets.** Everything is held in memory. Sync a subset with `--types post,author` when the dataset is very large.
- **Requirements.** Node 22.12+ and `openssl` on PATH (for the certificate; without it, `--http`).

## License

MIT
