# sanity-overlay-next

The overlay's HTTP API: the server your Studio plugin and your site talk to. One framework-neutral handler, two ways to run it. If you're new to the project, read the [root README](../../README.md) first.

## Option 1 — mount it inside your Next.js app (no extra process)

`createOverlayApi()` returns a `handle(Request): Promise<Response>` you can export straight from an App Router catch-all route. Your normal `next dev` then runs the overlay too — no separate command, no extra port:

```ts
// app/api/sanity-overlay/[[...route]]/route.ts
import {createOverlayApi} from 'sanity-overlay-next'
import {FsOverlayStore} from 'sanity-overlay-store-fs'

const api = await createOverlayApi({
  store: new FsOverlayStore({root: process.cwd(), now: () => new Date().toISOString()}),
  now: () => new Date().toISOString(),
  // origins: not needed here — an App Router mounting is same-origin.
})

export const GET = (request: Request) => api.handle(request)
export const POST = (request: Request) => api.handle(request)
```

Point the Studio at it with `SANITY_STUDIO_OVERLAY_API_URL=<your-app-origin>/api/sanity-overlay`.

Route names are matched exactly (`/state`, `/commit`, `/resolve`, `/query`, `/events`, `/health`) — `/state/anything` is a 404, not a fuzzy match.

## Option 2 — run it standalone

When there's no host app (a Studio-only repo, a coding agent, CI), run the same handler as its own `node:http` server. The easy way is the CLI ([`sanity-overlay dev`](../sanity-overlay-cli/README.md)); programmatically it's:

```ts
import {startOverlayApiServer} from 'sanity-overlay-next'

const server = await startOverlayApiServer({
  root: process.cwd(),             // the directory containing .sanity-overlay/
  port: 3998,
  origins: ['http://localhost:3333'],   // the ONE origin granted CORS — see below
})
console.log(server.url)
// … later:
await server.close()
```

`root` is **required here** — a library doesn't get to assume your working directory. (The CLI is the layer that defaults it to the current directory, which is why `sanity-overlay dev` needs no arguments.) A relative path resolves against the process cwd.

## Things worth knowing

- **CORS is default-deny.** This API serves your entire branch — every draft, every unpublished edit — so no origin is granted unless you name it. The standalone server exists for exactly one client (your Studio dev origin); a same-origin App Router mounting needs no grant at all.
- **Restart-transparent.** The server holds no state the `.sanity-overlay/` files don't: a restart (or a fresh clone of a committed overlay) rebuilds its world from disk, including materializing documents from the committed intent + snapshot files.
- **Writes are idempotent.** Every `/commit` carries an idempotency key; a retried request replays the recorded answer instead of applying twice.
- **Queries go through the registry.** `/query` only answers queries registered ahead of time ([query registry guide](../../docs/query-registry.md)); anything it can't prove complete is refused with a reason, never approximated.
- **Direct edits are watched.** Hand-editing (or `git checkout`-ing) `documents/<id>/intent.json` is a supported workflow — the server revalidates, recomputes checksums, and refuses malformed files while keeping the last valid state.
- **Assets are on by default** for the standalone server (uploads land under `.sanity-overlay/`); an embedded `createOverlayApi` answers `501 ASSETS_NOT_CONFIGURED` until you hand it an asset store — a stated refusal rather than a silent 404.
