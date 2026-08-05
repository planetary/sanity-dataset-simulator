# `examples/local-site` — the consumer half of the loop

Edit a document in Studio, reload this site, see your edit. Staging is untouched.

That sentence was not runnable before this example existed: the Studio wrote a
branch overlay to `.sanity-overlay/` and nothing read it back. This is the
missing half — a small server-rendered site that reads **exclusively** through
`packages/sanity-overlay-client`, so what it renders is the branch view, not the
staging view.

No framework, no `next`, no install: `node:http` plus the workspace packages.
See [Why not Next.js (yet)](#why-not-nextjs-yet).

---

## The 60-second version (no Studio needed)

```bash
# 1. Write a demo overlay the way a Studio session would.
#    It goes to examples/local-site/.overlay-demo/, NOT to the Studio's own
#    overlay — seeding into a live editing session would overwrite its work.
pnpm --filter local-site seed

# 2. Serve the branch view of that demo overlay
pnpm --filter local-site demo                       # http://127.0.0.1:4000

# 3. In another terminal, serve the SAME site with the overlay off
pnpm --filter local-site staging -- --port=4001     # http://127.0.0.1:4001
```

Open both. `:4000` shows `Edited on the branch ✅`, has
`/articles/created-on-the-branch`, and has **no** `article-02`. `:4001` shows
`Article 1`, has no branch article, and still has `article-02`. Same code, same
base dataset, one environment variable apart.

`pnpm --filter local-site dev` is the same thing pointed at the **Studio's**
overlay (`examples/kitchen-sink/.sanity-overlay/`) — that is the loop below.

---

## The real loop (Studio → overlay → site)

Four processes. Ports: Studio `3333`, transport proxy `3999`, overlay server
`3998`, site `4000`.

```bash
# ── terminal 1 ── the transport proxy, in default-deny write mode.
#    Nothing the Studio tries to write can reach Content Lake.
PROXY_BLOCK_WRITES=1 node examples/kitchen-sink/spikeB-proxy/proxy.mjs

# ── terminal 2 ── the overlay persistence server.
#    Writes `.sanity-overlay/` inside examples/kitchen-sink.
pnpm --filter kitchen-sink overlay:server

# ── terminal 3 ── the Studio
pnpm --filter kitchen-sink dev          # http://localhost:3333

# ── terminal 4 ── this site, reading that same overlay
pnpm --filter local-site dev            # http://127.0.0.1:4000
```

In the Studio's browser console, once, then reload the Studio:

```js
localStorage.SPIKE_LOCAL_ECHO = '1'
localStorage.SPIKE_OVERLAY_PERSIST = '1'
```

(Routing Studio through the proxy needs `apiHost: 'http://localhost:3999'` in
`examples/kitchen-sink/sanity.config.ts` — see
[`spikeB-proxy/README.md`](../kitchen-sink/spikeB-proxy/README.md), which
documents the change deliberately rather than applying it.)

### What you will see

1. Open `http://127.0.0.1:4000/`. The list shows the base titles from
   `base-dataset.ndjson`, except for anything the overlay already changed.
2. In Studio, open **Article 1** and change its title to `Hello from the branch`.
   Wait for the pane to settle to *Saved*.
3. Reload `http://127.0.0.1:4000/`. The list entry now reads
   **Hello from the branch**, and so does
   `http://127.0.0.1:4000/articles/article-1`. The footer's
   `overlay revision: N` has gone up.
4. Create a new article in Studio and give it a slug. Reload: it is in the list,
   and `/articles/<your-slug>` renders.
5. Delete an article in Studio. Reload: it is gone from the list, and its own URL
   returns **404** — not the stale staging row.

You do not need to restart the site. It probes the overlay manifest before every
read and re-loads when the revision changes; `fs.watch` shortens the window
further. To force it:

```bash
curl -X POST http://127.0.0.1:4000/revalidate
```

---

## Proving staging is untouched

Three independent checks, in increasing strength.

**1. Nothing wrote to the base dataset.** The base dataset is the committed file
`examples/local-site/base-dataset.ndjson`.

```bash
git status --porcelain examples/local-site/base-dataset.ndjson   # empty
shasum -a 256 examples/local-site/base-dataset.ndjson            # before and after
```

**2. The site renders staging on demand.** Same process, same dataset, overlay
off:

```bash
pnpm --filter local-site staging -- --port=4001
```

`:4001` is the staging view. If your Studio edit appears there, the overlay has
leaked into base; it does not, and `test/client-modes.test.ts` asserts it.

**3. No write path exists.** The read client's base port
(`createDocumentBaseSource`, `createHttpBaseSource`) has `fetchCandidates` and
`query` and nothing else — there is no mutate, no patch, no transaction method to
call. `createHttpBaseSource` issues `GET` only. And with the Spike B proxy in
`PROXY_BLOCK_WRITES=1` mode, any write the Studio attempts is rejected at the
transport before it reaches Content Lake; `proxy-log.jsonl` records every attempt
with `"blocked":true`.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SANITY_OVERLAY_MODE` | `off` (`fs` via `pnpm dev`) | `off` = base only; `fs` = `.sanity-overlay/` over base (PRD §9.2, §11.1) |
| `SANITY_OVERLAY_ROOT` | `examples/kitchen-sink` | The directory that **contains** `.sanity-overlay/` |
| `SANITY_OVERLAY_PERSPECTIVE` | `drafts` | `published` or `drafts` (PRD §18.1–§18.2) |
| `SITE_PORT` | `4000` | Listen port |
| `SITE_BASE_DATASET` | `./base-dataset.ndjson` | NDJSON base dataset |
| `SANITY_PROJECT_ID` + `SANITY_DATASET` | unset | Set both to read the **real** dataset over the hosted query API instead of the file |
| `SANITY_API_VERSION` | `2025-02-19` | |
| `SANITY_READ_TOKEN` | unset | Read token for a private dataset |

`mode: off` is genuinely inert, not a flag consulted late: the client never calls
the overlay port at all, which `test/client-modes.test.ts` proves by handing it a
loader that throws on any access.

---

## Shape of the code

```
src/queries.ts      registered GROQ (PRD §22.4/§22.5) — the site may only ask what is registered
src/data.ts         TRANSPORT-FREE. listArticles(client) / getArticleBySlug(client, slug)
src/render.ts       pure HTML. data in, string out
src/site.ts         routing. returns {status, headers, body} — no socket
src/server.ts       the only file that imports node:http
src/createClient.ts environment → client (mode, base source, overlay root)
src/dataset.ts      the committed NDJSON base dataset
```

Routes: `GET /`, `GET /articles/<slug>`, `POST /revalidate`.

An unregistered or Tier C query is refused with its structured code
(`QUERY_NOT_REGISTERED`, `UNSUPPORTED_GROQ`) and the HTTP status PRD §22.9
assigns it — rendered as an error page, never silently answered from base.

---

## Why not Next.js (yet)

`pnpm add` is unavailable in the environment this was built in, so `next` cannot
be installed, and scaffolding an app that cannot run would be worse than
useless. The layering above is the port plan, not an accident:

| Today | Next.js |
|---|---|
| `src/data.ts` | unchanged — a Server Component calls the same functions |
| `src/render.ts` | becomes JSX; same props |
| `src/site.ts` | becomes `app/page.tsx` + `app/articles/[slug]/page.tsx` |
| `src/server.ts` | deleted |
| `src/createClient.ts` | unchanged, called from a module-scope singleton |
| `revalidateSite(client)` in `src/site.ts` | `revalidateTag(OVERLAY_CACHE_TAG)` |
| `POST /revalidate` | `app/api/revalidate/route.ts` |
| overlay-revision cache key | `fetch(..., {next: {tags: [OVERLAY_CACHE_TAG]}})` |

To do it: `pnpm --filter local-site add next react react-dom`, then move the four
files above. `OVERLAY_CACHE_TAG` is already exported from
`sanity-overlay-client` so the tag name is shared rather than retyped.

Note that ISR revalidation is a **cache** trigger; the client's own probe against
`manifest.json` stays useful in `next dev`, where the overlay changes far more
often than a deployment does.

---

## Running under plain Node

`run.mjs` and `seed.mjs` register `tsExtensionHook.mjs` before importing
anything. It does two narrow things, only on a resolution that has already
failed:

- retries an extensionless relative specifier as `<spec>.ts` / `<spec>/index.ts`,
  because the workspace packages are written for bundlers;
- retries a bare specifier (`groq-js`) from a workspace package that has it
  linked, because this workspace's `node_modules` predates
  `sanity-overlay-query`. After a `pnpm install` the first resolution succeeds
  and that branch is never reached.

---

## Tests

```bash
pnpm --filter sanity-overlay-testkit exec vitest run \
  test/client-modes.test.ts test/client-revalidate.test.ts \
  test/client-http-base.test.ts test/local-site-routes.test.ts
```

- `test/client-modes.test.ts` — overlay-aware reads in both directions; `mode: off` inertness.
- `test/client-revalidate.test.ts` — change detection and the revalidation trigger.
- `test/client-http-base.test.ts` — the hosted base adapter: GET only, parameterised.
- `test/local-site-routes.test.ts` — the rendered HTML, which is the thing that was wrong.

The overlay assertions are mutation-checked: making the client ignore the overlay
turns 22 of them red, and breaking tombstone suppression alone turns 7 red. A test
that stays green when the overlay is ignored would be testing nothing.
