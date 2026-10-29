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

On macOS this asks for your password through the system keychain dialog. The CA is **name-constrained to `localhost` names**, so trusting it cannot vouch for any other site. If you skip this step, open `https://localhost:3939` once and accept the certificate. That works in Chrome; Firefox needs the trust step, then a full quit and reopen (it reads the system's certificates only at startup, and only while `security.enterprise_roots.enabled` is on, which is the default on macOS). The dashboard is also available over plain `http://localhost:3939/` and needs no certificate.

## Wiring

Sanity has no built-in way to point a Studio or app at another API host through the environment, so `sanity-sim` makes small, **marked, reversible** edits. Each edit is **inert unless sanity-sim's environment variables are present**, and those only exist in the processes `npx sanity-sim` starts. Plain `sanity dev`, `next dev`, builds and deploys behave exactly as before.

| What | How | Code change |
|---|---|---|
| Server-side code (Next server components and route handlers, Astro/Remix loaders, scripts) | The dev process gets `NODE_OPTIONS=--import sanity-sim/register`. It reroutes `fetch`, `http(s).request` and `tls.connect` for `*.api.sanity.io`, `*.apicdn.sanity.io`, `api.sanity.io` and `cdn.sanity.io` to the simulator. That covers `@sanity/client`, `next-sanity` and plain `fetch` | **none** |
| Studio (standalone or embedded) | The config's default export is wrapped with `withSanitySim(...)`, which sets `apiHost` when `SANITY_STUDIO_SIM_API_HOST` (or `NEXT_PUBLIC_SANITY_SIM_API_HOST`) is set | one marked block |
| Browser-side clients (`createClient({...})` in client components, Vite/Astro apps) | A guarded `apiHost` spread is added to the options object | one marked comment pair per call |

Undo everything with `npx sanity-sim eject`, which restores each file byte-for-byte. Pass `--no-wire` to skip the edits; server-side code still works through the register hook alone.

The register hook redirects TLS connections for Sanity's hostnames to the simulator. The simulator answers them with a certificate from a **second, Node-only CA**. That CA is handed to the dev processes through `NODE_EXTRA_CA_CERTS` and is never installed in your system trust store.

## Dashboard

Open `http://localhost:3939/`:

- **Documents.** Browse by type, search, filter to local changes, and edit raw JSON with validation. Publish, unpublish, discard drafts, revert to the synced version, delete, and browse and restore local history.
- **Query.** GROQ with parameters and a perspective picker (published, drafts, raw, or a release), with timing and sync tags.
- **Activity.** Live transactions, plus every request Studio and your app made (filter by writes, errors or unsupported calls).
- **Assets.** A gallery with upload and reference counts.
- **Releases.** Create, publish now, schedule, archive and delete.
- **Sync.** Pull a real dataset, follow it live, see local changes like a `git status`, and resolve stale documents (keep mine, take synced, or a three-way merge).
- **Datasets.** Create and switch datasets, import and export, discard local changes, wipe.
- **Connections.** Which clients are connected and which API versions they use, any endpoints they called that the simulator doesn't implement, certificate status, and snippets for wiring by hand.

## Syncing a real dataset

```bash
npx sanity-sim --sync            # pull before starting
npx sanity-sim --sync --follow   # …and keep the snapshot live
npx sanity-sim sync              # pull, then exit
```

A dataset in the simulator has two layers. The **synced snapshot** sits underneath; it's a cache and is gitignored. **Your local documents and deletions** sit on top and are committed. The layers combine per document id: a local copy wins, and a local deletion hides the synced document. Writes from Studio, your app or the dashboard always land in the local layer.

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
| `syncTags`, Live Content API (`/data/live/events`) | ✅ one coarse tag per dataset (over-invalidates, never under-) |
| `resultSourceMap` (Presentation, stega) | ✅ inferred conservatively for string values |
| Mutate API: create/createOrReplace/createIfNotExists/patch/delete, query-based patch/delete, `ifRevisionID`, `returnIds`/`returnDocuments`/`dryRun`/`autoGenerateArrayKeys`/`transactionId`, atomic | ✅ patches applied by `@sanity/mutator` |
| Actions API: document, version and release actions; release scheduling | ✅ |
| Listen API: filters, transitions, `mutations`, `previousRev`/`resultRev`, mendoza `effects`, `includeResult`/`includePreviousRevision`/`includeAllVersions`, resume | ✅ |
| History: translog, document revisions, lifecycle events (Studio's history panel, review changes) | ✅ for local changes; synced documents have no prior history |
| Doc API, Export API | ✅ |
| Assets: upload, `from-url`, dedup by sha1, dimensions, LQIP, image CDN transforms (`w`, `h`, `fit`, `crop`, `rect`, `fm`, `auto=format`, `q`, `dpr`, …) | ✅ transforms and LQIP need `sharp` (optional dependency); without it, originals are served |
| Studio boot: users, projects, datasets, grants, ACL, features, release limits, key-value settings | ✅ one local user with every grant |
| Presence (Bifur websocket) | ⚠️ accepted and answered; single-user, so no presence |
| Comments and Tasks (add-on datasets) | ✗ features reported off |
| `text::semanticSimilarity`, `documents::incomingGlobalDocumentReferenceCount`, `user::attributes` | ✗ clear 400 |
| Agent Actions, Canvas, Media Library, Functions, embeddings | ✗ clear 501, listed on the Connections page |

## Known limitations

- **Studio's feedback tunnel.** Studio sends Sentry error reports and feedback to a hardcoded `https://api.sanity.io/vX/intake/feedback` that ignores `apiHost`. No document content is involved, but those requests do leave your machine.
- **One local user.** No roles, no access control, and no real presence.
- **Loopback only.** The server binds to `127.0.0.1`/`::1` and accepts writes only from loopback browser origins (`--origin` adds one). It's a development tool, not a server to expose.
- **Search ranking.** Typed searches match by prefix tokens; there's no stemming and no hosted relevance scoring.
- **Large datasets.** Everything is held in memory. Sync a subset with `--types post,author` when the dataset is very large.
- **Requirements.** Node 22.12+ and `openssl` on PATH (for the certificate; without it, `--http`).

## License

MIT
