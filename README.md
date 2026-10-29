# @planetary/sanity-sim

**A local Sanity Content Lake.** Run one command in a project folder and your Sanity Studio and your app work against local data: no code changes, no Sanity account, and nothing sent to Sanity. A dashboard for the data runs alongside.

```bash
npx @planetary/sanity-sim
```

It boots a local dataset (empty, seeded from a file, or pulled read-only from your real one), points the folder's Studio and app at it for as long as it runs, starts your dev server, and serves a dashboard at `http://localhost:3939/`. Stop it with Ctrl-C and everything is back to normal.

Use it to develop and test against content you can break, demo a site offline, try a migration on a copy, run end-to-end tests without a shared dataset, or swap between whole datasets while your app keeps running.

> Unofficial. Not affiliated with or endorsed by Sanity.

**Contents:** [Quick start](#quick-start) · [How it works](#how-it-works) · [The local certificate](#the-local-certificate) · [Dashboard](#dashboard) · [Datasets, links and hot swaps](#datasets-links-and-hot-swaps) · [Syncing a real dataset](#syncing-a-real-dataset) · [Presentation, Draft Mode and Live](#presentation-draft-mode-and-live) · [Workspaces and multiple projects](#workspaces-and-multiple-projects) · [Media Library](#media-library) · [Files, and what to commit](#files-and-what-to-commit) · [Commands](#commands) · [Using it without the CLI wiring](#using-it-without-the-cli-wiring) · [Compatibility](#compatibility) · [Known limitations](#known-limitations) · [Examples](#examples) · [Developing sanity-sim](#developing-sanity-sim)

## Quick start

**Requirements:** Node.js 22.12 or newer, and `openssl` on your PATH (for the local certificate; without it, use `--http`). A Sanity Studio and/or an app that uses `@sanity/client` or `next-sanity`.

Run it once with `npx`, or add it to the project so the whole team gets the same version:

```bash
npx @planetary/sanity-sim               # one-off

npm install --save-dev @planetary/sanity-sim
npx sanity-sim                          # once installed, the command is `sanity-sim`
```

Then, in the folder that holds your Studio and/or app:

```bash
npx sanity-sim                          # start empty, wire the folder, run your dev script
npx sanity-sim --seed content.ndjson    # …starting from an export (NDJSON or `sanity dataset export` .tar.gz)
npx sanity-sim --sync                   # …starting from your real dataset, pulled read-only
```

The first run in a terminal asks to trust a local HTTPS certificate (your OS shows a confirmation; see [The local certificate](#the-local-certificate)), creates `.sanity-sim/` for the data, and prints where everything is:

```
sanity-sim 0.1.0 · project abc123 · dataset production

  Dashboard  http://localhost:3939/
  API        https://localhost:3939  (Node/curl: http://localhost:3939)
  Data       .sanity-sim/ (1204 synced from abc123/production, 3 local, 0 deleted locally)
  Studio     wired sanity.config.ts
```

Your Studio and app now read and write the simulator. When you're done with sanity-sim for good, `npx sanity-sim eject` removes its edits from your files.

## How it works

1. **Detect.** It finds `sanity.config.*` and `sanity.cli.*`, `.env*` files (`SANITY_STUDIO_*`, `NEXT_PUBLIC_SANITY_*`, `PUBLIC_SANITY_*`, …), your framework (Next.js, Astro, SvelteKit, Vite, Remix, Nuxt), your dev script and your package manager. The project id and dataset come from there.
2. **Initialize.** On first run it creates `.sanity-sim/`. In a terminal, when a Sanity project was detected, it offers to pull the real dataset first (read-only). Otherwise you start empty, or with `--seed`.
3. **Serve.** One port (default `3939`, or the next free one) serves both the Content Lake API and the dashboard, over HTTP/2 with TLS and plain HTTP.
4. **Wire.** It makes small, marked edits so your Studio and browser code talk to the simulator (below), then runs your dev script with the environment that activates them. Ctrl-C stops everything.

### Wiring

Sanity has no setting that points a Studio or app at another API host through the environment, so sanity-sim makes small, **marked, reversible** edits. Each edit is **inert unless sanity-sim's environment variables are present**, and those only exist in the processes sanity-sim starts. Plain `sanity dev`, `next dev`, builds and deploys behave exactly as before, so the edits are safe to commit.

| What | How | Code change |
|---|---|---|
| Server-side code (Next.js server components and route handlers, Astro/Remix loaders, scripts) | The dev process gets `NODE_OPTIONS=--import @planetary/sanity-sim/register`, which reroutes `fetch`, `http(s).request` and `tls.connect` for `*.api.sanity.io`, `*.apicdn.sanity.io`, `api.sanity.io` and `cdn.sanity.io` to the simulator. That covers `@sanity/client`, `next-sanity` and plain `fetch` | **none** |
| Studio (standalone or embedded) | The config's default export is wrapped in `withSanitySim(...)`, which sets `apiHost` (and the Media Library picker) when `SANITY_STUDIO_SIM_API_HOST` or `NEXT_PUBLIC_SANITY_SIM_API_HOST` is set | one marked block |
| Browser-side clients (`createClient({...})` in client components, Vite and Astro apps) | A guarded `apiHost` spread is added to the options object | one marked comment pair per call |

`npx sanity-sim eject` restores each file byte for byte. `--no-wire` skips the edits; server-side code still works through the register hook alone.

The register hook redirects TLS connections for Sanity's hostnames to the simulator, which answers them with a certificate from a **second, Node-only CA**. That CA reaches the dev processes through `NODE_EXTRA_CA_CERTS` and is never installed in your system trust store.

### What "local" means

- **Writes stay on your machine.** Everything Studio, your app or the dashboard writes goes to `.sanity-sim/`.
- **Sanity is only ever read.** Syncing goes through one function that refuses any method except GET, and a token is only ever sent to `*.sanity.io`.
- **Loopback only.** The server binds to `127.0.0.1` and `::1`, and accepts writes only from loopback browser origins (`--origin` adds one).
- **One local user, every grant.** There are no roles or access control; any token is accepted.

## The local certificate

Studio keeps 8+ live connections open per document, more than browsers allow over HTTP/1.1 (6 per host). So the simulator serves **HTTP/2 over TLS**, with a certificate from a per-machine local CA kept in `~/.sanity-sim/ca/`. Trust it once:

```bash
npx sanity-sim trust
```

The first run in a terminal starts this step for you. It trusts the CA for your user only (no admin rights), and your OS asks you to confirm: the keychain password dialog on macOS, a security prompt on Windows; on Linux it goes into Chrome's NSS store. The CA is **name-constrained to `localhost` names**, so trusting it cannot vouch for any other site. Firefox reads system certificates only at startup, so quit and reopen it afterwards (`security.enterprise_roots.enabled` must be on, the default on macOS). The dashboard also answers over plain `http://localhost:3939/` and needs no certificate.

**Cancelled, or on a managed machine?** sanity-sim keeps running, prints the alternatives, and stops asking until you run `npx sanity-sim trust` again:

- Open `https://<projectId>.localhost:3939/` once and accept the warning (Chrome, Edge and Safari, unless a managed browser forbids exceptions).
- Ask IT to trust `~/.sanity-sim/ca/ca.pem`. Its name constraints limit it to `localhost`, `*.localhost` and loopback IPs, which is usually an easy approval.
- Use `--http`. No certificate is needed, but Studio stalls once several documents are open.

## Dashboard

Open `http://localhost:3939/`:

- **Documents.** Browse by type, search, filter to local changes, and edit raw JSON with validation. Publish, unpublish, discard drafts, revert to the synced version, delete, and browse and restore local history.
- **Query.** GROQ with parameters and a perspective picker (published, drafts, raw, or a release), with timing and sync tags.
- **Activity.** Live transactions, plus every request Studio and your app make (filter to writes, errors or unsupported calls).
- **Assets.** A gallery with upload and reference counts.
- **Releases.** Create, publish now, schedule, archive and delete content releases.
- **Sync.** Pull a real dataset, follow it live, see local changes like `git status`, and resolve stale documents (keep mine, take synced, or a three-way merge).
- **Datasets.** Create, switch, link and hot-swap datasets; import, export, discard local changes, wipe.
- **Connections.** Connected clients and their API versions, endpoints they called that the simulator doesn't implement, certificate status, and snippets for wiring by hand.

## Datasets, links and hot swaps

Keep several datasets side by side and choose which one your Studio and app see, without touching their config:

```bash
npx sanity-sim import empty-state.ndjson --dataset test-1
npx sanity-sim import big-catalog.tar.gz --dataset test-2
npx sanity-sim link production test-1   # Studio and the app now see test-1 as "production"
npx sanity-sim link production test-2   # swap, while everything runs
npx sanity-sim unlink production        # back to production's own documents
```

A **link** is a name (here `production`) that resolves to a stored dataset: every request through that name reads and writes the target, and Sanity's alias spelling `~production` works too. Re-pointing a link while the simulator runs disconnects the listeners and live connections that came in through that name. Studio and `@sanity/client` reconnect and refetch, so the swap shows up within seconds, with no restart or reload, and Next.js apps using the Live Content API get a sync-tag invalidation for both datasets.

If the name already held documents, they're kept as a stored dataset named `<name>-original`, and `unlink` puts them back. The same controls are on the dashboard's **Datasets** page. Links live in `.sanity-sim/config.json`.

## Syncing a real dataset

```bash
npx sanity-sim --sync            # pull before starting
npx sanity-sim --sync --follow   # …and keep the snapshot live
npx sanity-sim sync              # pull, then exit
npx sanity-sim --sync --types post,author   # only some document types
```

A dataset in the simulator has two layers. The **synced snapshot** sits underneath; it's a cache, and gitignored. **Your local documents and deletions** sit on top, and are meant to be committed. The layers combine per document id: a local copy wins, and a local deletion hides the synced document. Writes from Studio, your app or the dashboard always land in the local layer.

When the real dataset changes under a document you've edited, the document is flagged **stale** on the Sync page. Resolve it by keeping yours, taking the synced version, or merging (field-level and three-way, with the ancestor read from Sanity's history API).

**Credentials** come from your project's `.env` (`SANITY_API_READ_TOKEN`, `SANITY_API_TOKEN`, `SANITY_AUTH_TOKEN`, …) or your `sanity login` session. Without a token, only published documents of public datasets can be read. Images and files are fetched from Sanity's CDN the first time they're served, then cached.

**Media Library assets come along.** If the dataset references a Media Library (images and files picked from one, `sanity.video` fields), sync also reads those library documents, read-only, so references resolve locally. A library your token can't read is reported, and the dataset sync still succeeds.

## Presentation, Draft Mode and Live

next-sanity's preview stack works against the simulator unchanged: `defineEnableDraftMode`, `defineLive` with `<SanityLive>`, `<VisualEditing>`, stega, and Studio's Presentation tool.

- **Preview secrets** are created and validated through the simulator, so the draft-mode route works.
- **A read token is provided.** Draft Mode needs one and the simulator accepts any, so if your project has none, the dev processes get a placeholder `SANITY_API_READ_TOKEN`. A token you do have is left alone.
- **Live content.** Every write emits sync-tag invalidations on the Live Content API, so open pages update without a reload. After each start, the first live client for a dataset also gets one invalidation, which refreshes anything Next.js cached before the data changed (a reseed, a reset, an import while nothing was listening).
- **Content source maps** for click-to-edit overlays are inferred for string values.

## Workspaces and multiple projects

A Studio with several workspaces works as-is, including workspaces on **different projects**. The wiring sets `apiHost` on every workspace, and each project has its own datasets, links, releases and history:

- **Main project:** the one in `sanity.cli.*`, or else the first one found. It lives in `.sanity-sim/`.
- **Other projects:** each in `.sanity-sim/projects/<projectId>/`, created on first use. Asset files are content-addressed and shared between projects.

Requests are matched to a project the way Content Lake does it: by hostname (`<projectId>.localhost`, or `<projectId>.api.sanity.io` through the register hook), or by paths like `/projects/<projectId>/…`. Every project id in your Studio config goes on the certificate at startup, and one the simulator hasn't seen gets its name added on its first TLS connection, with no restart. With more than one project, the dashboard shows a project picker.

## Media Library

Studios with `mediaLibrary: {enabled: true}` work against a local **Media Library**, shared by every project in the folder (as a real one is shared by an organization's projects). Pick images and files from it in Studio, upload to it from the picker or by dropping files on a field, and open an asset in it from the field's menu.

- **The picker.** Studio normally frames the hosted app at media.sanity.io. While sanity-sim runs, the Studio wiring points it at a small local picker served by the simulator, which speaks the same messages.
- **Linking.** Choosing an asset links it into the dataset as Content Lake does: an ordinary `sanity.imageAsset` or `sanity.fileAsset` document with `source.name: "sanity-media-library"` and a `media` reference back to the library, while the field gets its usual `asset` reference plus a weak `media` global document reference. Front-ends resolve it with plain GROQ.
- **The API.** Library lookup and listing, the library's own query, doc, mutate, actions and listen endpoints, uploads, usage, video playback info, and the library CDN path that `@sanity/image-url` builds. The default library is `mlsimlocal`; a `libraryId` in your Studio config is created locally on first use, so references keep their ids.
- **Not simulated:** video playback (Studio plays through Mux on a fixed host), aspects and asset editing in the picker, and signed URLs for private assets.

## Files, and what to commit

```
.sanity-sim/
  config.json                         project, datasets, links, sync sources
  datasets/<name>/local.ndjson        your documents, sorted by _id            (commit)
  datasets/<name>/tombstones.json     local deletions of synced documents      (commit)
  datasets/<name>/base.json           synced _rev each local change began from (commit)
  datasets/<name>/remote.ndjson       synced snapshot                          (gitignored)
  datasets/<name>/transactions.ndjson local history with mendoza effects       (gitignored)
  assets/                             uploaded files, by sha1
  media-libraries/<id>/               the local Media Library                  (uploads committed, synced assets gitignored)
  projects/<projectId>/               other projects, same layout
  .cache/                             synced assets fetched from Sanity's CDN  (gitignored)
```

Everything is NDJSON in the same shape as `sanity dataset export`, so diffs stay readable and import/export is lossless. sanity-sim writes a `.gitignore` inside `.sanity-sim/` for the cache files. Commit the rest when the local content belongs with the code (fixtures, a demo dataset, test states); gitignore the whole folder when it doesn't.

## Commands

| Command | |
|---|---|
| `npx sanity-sim` | Start, wire the folder, and run your dev script |
| `npx sanity-sim serve` | Start the simulator only |
| `npx sanity-sim sync` | Pull the real dataset (read-only), then exit |
| `npx sanity-sim status` | Project, datasets, links, local changes, certificate |
| `npx sanity-sim import <file>` | Import NDJSON or a `sanity dataset export` `.tar.gz` (images and files included) |
| `npx sanity-sim export <file>` | Export NDJSON (`.ndjson.gz` to compress) |
| `npx sanity-sim link <name> <dataset>` | Point a name at a stored dataset; run again to hot-swap |
| `npx sanity-sim unlink <name>` | Remove a link, restoring the name's own documents |
| `npx sanity-sim reset [--all]` | Discard local changes (keeps the synced snapshot); `--all` wipes everything |
| `npx sanity-sim trust` | Trust the local HTTPS certificate |
| `npx sanity-sim eject` | Remove sanity-sim's edits from your Studio config and clients |

| Option | |
|---|---|
| `--port <n>` | Port for the API and dashboard (default `3939`; the next free one if taken) |
| `--dataset <name>` | Dataset to use (default: detected, else `production`) |
| `--project <id>` | Project id (default: detected, else `simlocal`) |
| `--seed <file>` | Import this file when the dataset is empty |
| `--sync`, `--follow` | Pull the real dataset before starting; keep it live |
| `--types <a,b>` | Sync only these document types |
| `--no-dev` | Don't run the project's dev script |
| `--no-wire` | Don't edit the Studio config or clients |
| `--http` | Plain HTTP only (no certificate; Studio stalls past six connections) |
| `--origin <url>` | Allow a non-loopback browser origin |
| `--root <dir>` | Project folder (default: the current directory) |
| `--yes` | Accept defaults without prompting (CI, scripts) |

## Using it without the CLI wiring

`npx sanity-sim serve` (or `--no-wire`) runs only the simulator; point clients at it yourself:

- **Studio:** `apiHost: 'https://localhost:3939'` in `sanity.config.ts`.
- **`@sanity/client`:** `createClient({projectId, dataset, apiVersion, apiHost: 'https://localhost:3939', useCdn: false})`. Node clients can use `http://localhost:3939` instead, with `useProjectHostname: false`.
- **Any Node process, unchanged:** `SANITY_SIM_URL=http://localhost:3939 node --import @planetary/sanity-sim/register your-script.js` reroutes its Sanity requests (`SANITY_SIM_TLS_PORT` and `NODE_EXTRA_CA_CERTS` add TLS interception for clients that bypass `fetch`).

The dashboard's **Connections** page shows these snippets with the right port filled in. The package also exports the simulator itself (`Simulator`, `startServer`) for tests that want an in-process Content Lake.

## Compatibility

Verified against **Sanity Studio 6.20**, **`@sanity/client` 8.13**, **next-sanity 13.4** and **Next.js 16.4**, with the HTTP API at `v2025-02-19` (any `vYYYY-MM-DD`, `v1` and `vX` are accepted).

| Area | Status |
|---|---|
| Query API: GROQ, params, GET and POST | ✅ via groq-js 2 |
| Perspectives: `published` (default from v2025-02-19), `drafts`, `raw`, release stacks, `_originalId` | ✅ |
| `text::query` (Studio lists and search) | ✅ exact for unfiltered lists; prefix-token approximation for typed terms (reported in `simApproximations`) |
| `text::semanticSimilarity` inside `score()` | ✅ approximation by word overlap, no embeddings (reported in `simApproximations`) |
| `documents::incomingGlobalDocumentReferenceCount()`, `user::attributes()` | ✅ `0` and `{}` (no other Sanity resources or user attributes exist locally) |
| `syncTags`, Live Content API | ✅ one coarse tag per dataset (over-invalidates, never under-) |
| `resultSourceMap` (Presentation, stega) | ✅ inferred conservatively for string values |
| Presentation and Draft Mode (`defineEnableDraftMode`, `defineLive`, `<VisualEditing>`) | ✅ |
| Mutate API: all mutation types, query-based patch and delete, `ifRevisionID`, `returnIds`/`returnDocuments`/`dryRun`/`autoGenerateArrayKeys`/`transactionId`, atomic | ✅ patches applied by `@sanity/mutator` |
| Actions API: document, version and release actions; release scheduling | ✅ |
| Listen API: filters, transitions, mutations, revisions, mendoza effects, `includeResult`/`includePreviousRevision`/`includeAllVersions`, resume | ✅ |
| History: transactions, document revisions, lifecycle events (Studio's history panel and review changes) | ✅ for local changes; synced documents have no prior history |
| Doc API, Export API | ✅ |
| Assets: upload, `from-url`, dedup by sha1, dimensions, LQIP, image transforms (`w`, `h`, `fit`, `crop`, `rect`, `fm`, `auto=format`, `q`, `dpr`, …) | ✅ transforms and LQIP need `sharp` (an optional dependency); without it, originals are served |
| Studio boot: users, projects, datasets, grants, ACL, features, release limits, key-value settings | ✅ one local user with every grant |
| Media Library: lookup, picker and uploads in Studio, linking, library API, usage, CDN path | ✅ local picker in place of media.sanity.io; video stored but not playable |
| Presence (Bifur websocket) | ⚠️ accepted and answered; single-user, so no presence |
| Comments and Tasks (add-on datasets) | ✗ reported as off |
| Agent Actions, Canvas, Functions, embeddings, GraphQL | ✗ a clear 501, listed on the Connections page |

## Known limitations

- **Studio's feedback tunnel.** Studio sends Sentry error reports and feedback to a hardcoded `https://api.sanity.io/vX/intake/feedback` that ignores `apiHost`. No document content is involved, but those requests leave your machine.
- **One local user.** No roles, no access control, no real presence. Code that should fail without permission will succeed locally.
- **No webhooks or Functions.** Publishing locally never calls your webhook endpoints or Sanity Functions.
- **The API CDN isn't a CDN.** `apicdn` hostnames return the same live data as the API, with no caching delay.
- **Search ranking.** Typed searches match by prefix tokens; there's no stemming and no hosted relevance scoring.
- **Large datasets.** Everything is held in memory. Sync a subset with `--types` when the dataset is very large.
- **`--project` renames the main project.** To work with another project's data, use the dashboard's project picker or the `x-sanity-sim-project` header.

## Examples

Two example projects live in this repository. Each keeps its own lockfile, outside the pnpm workspace, because they run newer Studio versions than the rest of the repo.

### [`examples/sim-next`](examples/sim-next): Meridian

A Next.js 16 site with an embedded Studio for a fictional outdoor magazine and shop, built to exercise as much of Sanity as one project reasonably can:

- **Every field type:** all core types, plus `code`, `color` and `table` from Sanity's official plugins, and `sanity.video` through Media Library.
- **Structure:** a recursive navigation menu, a page builder with ten section types, nested arrays, a self-referencing category tree, localized fields, a settings singleton, and rich text with every Portable Text feature.
- **References everywhere:** single, multi-type, filtered and weak; related content across articles, products and events.
- **Document states:** drafts over published documents, a draft-only article, and a scheduled content release.
- **Studio:** a custom desk structure, Presentation configured for every type, Vision, Media Library.
- **Site:** a page per type, draft mode with `<SanityLive>` and `<VisualEditing>`, and a list fetched in the browser to show the client-side path.

```bash
cd examples/sim-next
pnpm install --ignore-workspace
node ../../packages/sanity-sim/bin/sanity-sim.js --seed seed.tar.gz
```

Open the site at http://localhost:3000, the Studio at http://localhost:3000/studio, and the dashboard at http://localhost:3939. The seed (51 documents with photos and PDFs) is built by `scripts/build-seed.mjs`, and `scripts/record-demo.mjs` records a captioned video tour of the whole stack. See [its README](examples/sim-next/README.md).

### [`examples/test-studio`](examples/test-studio): a stock Studio

A plain, standalone Studio 6.20 (projectId `simtest1`) with a small blog schema and a five-document seed: the simplest possible setup, for trying sanity-sim by hand.

```bash
cd examples/test-studio
pnpm install --ignore-workspace
npx sanity-sim --seed seed.ndjson
```

Then open http://localhost:3333.

## Developing sanity-sim

The package lives in [`packages/sanity-sim`](packages/sanity-sim): plain ESM JavaScript with no build step, so the source is what ships.

```bash
pnpm install
pnpm --filter @planetary/sanity-sim test   # node:test, no network, no Sanity account
```

The suite covers the Content Lake API surface, a `@sanity/client` contract suite, the register hook, sync against a second simulator standing in for Sanity, Media Library, Draft Mode secrets, the CLI and the Studio wiring. It runs in CI, which is started by hand from the repository's Actions tab for now. The browser-level checks (Studio, Presentation, Media Library, the Meridian site) are run by hand against the examples.

Design notes and evidence: [`docs/plans/sanity-sim.md`](docs/plans/sanity-sim.md) (gap analysis, design and phases) and [`docs/plans/evidence/sanity-sim-phase-0/request-inventory.md`](docs/plans/evidence/sanity-sim-phase-0/request-inventory.md) (what Studio actually calls).

### Also in this repository: the branch overlay

The other packages (`packages/sanity-overlay-*`), `examples/kitchen-sink`, `examples/local-site` and most of `docs/` belong to the **branch overlay**, this repository's earlier approach: Git-committed content branches layered over a read-only staging dataset. It was superseded on 2026-10-28 by sanity-sim's sync with a document-level local layer ([the plan](docs/plans/sanity-sim.md), §4.4). It remains for reference and keeps its own CI; its specification is the [PRD](docs/PRD-v1.md), with the [runbook](docs/runbook.md) and [CLI README](packages/sanity-overlay-cli/README.md) for running it.

## License

MIT

The dashboard's test-tube mark uses "Test Tube Bold Duotone" from [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
