# Migration guide — a project already on `@sanity/client`

**Status:** Draft
**Date:** 2026-08-06
**Source:** [docs/PRD-v1.md](PRD-v1.md) §22.5, §11.2, §11.3, §37 Phase 9
**Audience:** a Next.js or Node application that reads Sanity today with `@sanity/client` or `next-sanity`, and a Studio that edits the same dataset

---

## Before you start — three things that are true today

1. **No package here is installable.** `packages/*/src` contains **106 relative import specifiers that escape their own package root** (measured 2026-08-06, testkit excluded; the count moves as work lands). Under pnpm's isolated linker a consumer's `node_modules/sanity-overlay-studio/src/client/transport.ts` resolves `../../../sanity-overlay-client/src/stagingHost` to a directory with no sibling package in it, and Studio fails to boot with `ERR_MODULE_NOT_FOUND`. Everything below therefore describes a migration you can currently only perform **inside this monorepo**, importing by relative path — exactly as `examples/kitchen-sink/sanity.config.ts` does. The package-boundary lint that would catch this is item 1 on the [phase-3 audit's](plans/evidence/phase-3/acceptance-audit.md) red-test list and is not written.
2. **`OVERLAY_MODE=blob` throws at startup.** There is no Blob adapter, so there is no preview-deployment story yet. `fs` and `off` are the modes that work.
3. **This system never writes to Sanity.** There is no promotion path. Content authored on a branch stays on the branch, in Git, forever. If your workflow depends on getting branch edits back into staging, this product does not do that and will not — see [PRD §0.0](PRD-v1.md).

---

## 1. What actually changes in your application

| Before | After |
|---|---|
| `createClient({projectId, dataset, apiVersion})` from `@sanity/client` | `createOverlayClient({mode, base, overlay, queries})` from `sanity-overlay-client` |
| `client.fetch(groqString, params)` | `client.fetch(queryId, params)` — **a registered ID, not GROQ text** |
| A query is whatever string you pass | A query is a registry entry with a pinned SHA-256 checksum, a candidate plan and limits |
| An unanswerable query silently returns something | An unanswerable query **throws** a structured `OverlayQueryError` |
| `defineLive` / `SanityLive` / `useLiveQuery` push Content Lake changes into the page | Removed. Subscribe to overlay changes with `client.watch()` / `client.revalidate()` |
| `defineConfig(workspace)` in `sanity.config.ts` | `defineOverlayConfig(workspace, {...})` |
| `SANITY_API_WRITE_TOKEN` somewhere in the environment | **Refused at startup.** The plugin throws in any overlay mode |

The single biggest conceptual change is the second row. The overlay does not have a dataset to run GROQ against; it has a base it can ask narrow questions of, plus a branch delta. A query is only answerable if the layer can prove it has fetched **every** document that could possibly match. That proof is what a registry entry is. Read the [query registry guide](query-registry.md) before migrating any query.

---

## 2. The migration, in order

### Step 1 — Inventory what bypasses the overlay

Run the lint rule in warn mode over your source. It reports and exits 0, so it is safe to run on an unmigrated tree.

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs lint --mode warn src app lib
```

Output is one finding per line:

```
<file>:<line>:<col>  warning  <code>  <message>
    <the literal, truncated to 160 chars>

N errors, N warnings in N files (N literals scanned)
```

Five rule codes, and each one is a distinct piece of migration work:

| Code | What it means for you |
|---|---|
| `direct-client-import` | A module resolving to `@sanity/client` or `next-sanity`. Every read through it renders base content while the deployment believes it is on a branch. The codemod handles most of these. |
| `live-bypass` | An import naming `defineLive`, `SanityLive`, `useLiveQuery` or `useLiveEvents`. **No import swap fixes this** — the pushes arrive already evaluated and overwrite whatever the overlay resolved. Remove the subscription. |
| `dynamic-query` | A GROQ literal that is interpolated (`${…}`) or an operand of `+`. It cannot be matched against a registry statically. Replace it with a registered constant. |
| `query-text-drift` | The literal differs from a registered query **only in whitespace**. Checksums are byte-for-byte, so this raises `QUERY_CHANGED` at runtime. Re-copy the registered text. |
| `unregistered-query` | A GROQ literal with no registry entry. Register it, or route it through one that exists. |

A literal counts as GROQ when it is tagged `` groq`…` ``, is the argument of `defineQuery(…)`, or matches `/(^\s*|[({|,=]\s*)\*\s*\[/`. **The scan is lexical, not a parse**: a query assembled from fragments, read from a file, or received over the network is invisible to it. Treat the report as a floor, not a census.

File selection is shared with the codemod: positional paths (or `.` under `--root`), extensions `.ts .tsx .js .jsx .mjs .cjs` (replaceable with `--ext`), and `node_modules .git .next dist build coverage` always skipped and not configurable. `--ignore <substring>` skips any path containing that substring, repeatable.

### Step 2 — Run the codemod in check mode

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs codemod src app lib
```

**Check mode is the default; there is no `--check` flag.** (The built-in help text says "`--check` by default", which is a documentation bug — passing `--check` to `codemod` is a usage error, exit 5. `--check` is a real flag, but on `ci`, where it selects check IDs.)

Check mode exits **2** if there is anything to do at all — a pending rewrite *or* a refusal. That is what makes it a CI gate.

### Step 3 — Apply it

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs codemod --write src app lib
```

Write mode exits 2 **only** on refusals. A clean run exits 0.

### Step 4 — Configure the environment

PRD §11.2's variables, with the spellings the code actually accepts. Every `OVERLAY_*` setting is read under three prefixes in this precedence: `SANITY_STUDIO_`, `SANITY_`, bare. `SANITY_STUDIO_` leads because it is the only prefix a Vite-built Studio bundle can see — a value that is actually reachable must never be shadowed by one that is not. **Blank is unset, not a value.**

| Variable | Required | Notes |
|---|---|---|
| `SANITY_PROJECT_ID` | Yes | Base project |
| `SANITY_BASE_DATASET` | Yes | The read-only base |
| `SANITY_API_VERSION` | Yes | Pinned, not floating |
| `SANITY_API_READ_TOKEN` | For private drafts | Server only. **Read-only.** |
| `OVERLAY_MODE` | **Yes** | `off` \| `fs` \| `memory`. `blob` throws. An absent value is **refused** by the read client, not defaulted — the old `?? 'off'` silently put readers on staging. |
| `OVERLAY_ROOT_DIR` | For `fs` | Directory containing `.sanity-overlay/` |
| `OVERLAY_API_URL` | Studio | Default `http://localhost:3998` |
| `OVERLAY_API_HOST` | Studio, optional | Points Studio's Sanity traffic at a proxy that can refuse writes. **Throws if it resolves to a real Sanity API host** — every spelling, including `<projectId>.api.sanity.io`. |
| `OVERLAY_STRICT_QUERIES` | Optional | Default `false`. See §5. |

**Delete every write-capable Sanity credential from the runtime.** `assertNoWriteToken` scans env var *names* at startup and **fails closed**: a name matching `(^|_)(TOKEN|SECRET|API_?KEY|CREDENTIALS?|PASSWORD|PAT)$` that is also Sanity-scoped and does **not** positively say read-only is treated as write-capable, and the Studio refuses to start:

```
[sanity-overlay-studio] refusing to start: `SANITY_API_TOKEN` names a Sanity credential whose
capability cannot be established from its name, so it is treated as write-capable. In overlay
mode no write-capable Sanity credential may exist in the application runtime (PRD §11.3) …
Remove it, rename it to say read-only (e.g. `SANITY_API_READ_TOKEN`), or set OVERLAY_MODE=off
for native Sanity.
```

`SANITY_API_TOKEN` and `SANITY_TOKEN` are both refused. Rename to `SANITY_API_READ_TOKEN`.

### Step 5 — Wire the client

```ts
import {
  createOverlayClient,
  createHttpBaseSource,
  createFsOverlayStateLoader,
  overlayClientConfigFromEnv,
} from 'sanity-overlay-client'

const cfg = overlayClientConfigFromEnv(process.env)   // {mode, overlayRoot?, perspective}

export const client = createOverlayClient({
  mode: cfg.mode,                                     // 'off' | 'fs'
  perspective: cfg.perspective,                       // 'published' | 'drafts' | 'raw'
  base: createHttpBaseSource({
    projectId: process.env.SANITY_PROJECT_ID!,
    dataset: process.env.SANITY_BASE_DATASET!,
    apiVersion: process.env.SANITY_API_VERSION!,
    token: process.env.SANITY_API_READ_TOKEN,
  }),
  ...(cfg.mode === 'fs'
    ? {overlay: createFsOverlayStateLoader({root: cfg.overlayRoot!})}
    : {}),
  queries: MY_QUERIES,                                // defaults to M_LOCAL_QUERIES
})
```

Notes that matter:

- `createHttpBaseSource` is **GET-only by design**. It wraps its `fetch` in `createStagingSafeFetch`, so an edit that introduces a non-GET fails at the call site rather than writing to the shared dataset.
- `mode: 'fs'` without an `overlay` loader throws: `createOverlayClient({mode: 'fs'}) requires an 'overlay' state loader`.
- `mode: 'off'` **never touches the overlay port** — it is a separate object, so "did the client read the overlay" is an observable fact rather than a claim. In `off` mode a base source with a `query()` method answers the whole query itself, which is a genuine passthrough.
- §22.5 discipline applies in **both** modes: an unregistered or `unsupported` query is refused with the overlay off too.

### Step 6 — Read surface

```ts
const article = await client.fetch<Article>('article-by-slug', {slug})

// diagnostics when you need them
const {result, diagnostics} = await client.fetchWithDiagnostics('article-by-slug', {slug})

client.revalidate()                 // drop the cached overlay view
const rev = await client.overlayRevision()
const stop = client.watch(() => {/* re-render */})
```

`OVERLAY_CACHE_TAG` is exported as the named substitution point for a Next.js port: `revalidateTag(OVERLAY_CACHE_TAG)` goes exactly where `client.revalidate()` goes today.

### Step 7 — The Studio

```diff
-import {defineConfig} from 'sanity'
-export default defineConfig(workspace)
+import {defineOverlayConfig} from 'sanity-overlay-studio'
+export default defineOverlayConfig(workspace, {env: process.env})
```

In `off` mode `defineOverlayConfig` returns your config **untouched**. In any other mode it composes onto each workspace: `unstable_clientFactory`, the hosted-feature flags, the overlay plugin, a tools filter, `document.comments.enabled: false`, a document-actions resolver, an inspectors filter, and — if you pass `layout` — the status banner.

`defineOverlayConfig` takes `{env, createClient, fetch, layout, documentActions, devtoolsTarget}` on top of the plugin options. The package entry point (`sanity-overlay-studio/src/index.ts`) supplies `createClient`, `layout` and `documentActions` for you; the in-repo example passes them explicitly because it imports the internal `config` module directly. **Consequence worth knowing:** the entry point is the only file that touches the peer dependencies, and nothing in the repository exercises it.

### Step 8 — Turn the gate on

Once the tree is clean, put both in CI in their failing modes:

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs lint --mode strict src app lib
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs codemod src app lib
```

Both exit 2 on findings. This is PRD §22.5's *"CI runs the codemod in check mode and the lint rule in error mode after migration."*

---

## 3. What the codemod does

Exactly two transformations, and it is a **lexical scanner** — no jscodeshift, no TypeScript AST, no program evaluation.

**1. The import rewrite**, alias-preserving:

```diff
-import {createClient} from '@sanity/client'
+import {createOverlayClient as createClient} from 'sanity-overlay-client'
```

The default binding map is `{createClient: 'createOverlayClient'}` and the **local binding never changes**, so an existing alias is preserved and no code outside the import statement is touched:

```diff
-import {createClient as makeClient} from '@sanity/client'
+import {createOverlayClient as makeClient} from 'sanity-overlay-client'
```

The target module defaults to `sanity-overlay-client` and is overridable with `--module <specifier>`. The binding map is not exposed as a flag.

**2. The query-ID rewrite.** In a file that is already overlay-backed — it imports the overlay module, or the codemod just rewrote an import into it — a **non-interpolated, non-concatenated** string literal passed as the first argument to a call named `fetch`, whose text matches a registered query byte for byte, is replaced with that query's ID:

```diff
-const article = await client.fetch(`*[_type == "article" && slug.current == $slug][0]`, {slug})
+const article = await client.fetch('article-by-slug', {slug})
```

The registry used is `M_LOCAL_QUERIES`.

### The whole-file rule

**Any refusal anywhere in a file leaves that file byte-identical.** Rewrites already computed for it are discarded. There is no partial migration of a file, because a file importing from two clients is the split-brain the codemod exists to prevent.

---

## 4. What the codemod refuses, and why

Twelve refusal constructs. Each is reported as `<file>:<line>:<col>  refused  <construct>  <reason>`. The reasons below are the ones the tool prints, abridged.

| Construct | Why it refuses | What you do |
|---|---|---|
| `live-subscription` | Sanity Live pushes Content Lake changes straight into the page, **already evaluated**, so they overwrite whatever the overlay resolved. No import swap fixes that. Checked **first**, before every other rule. | Remove the live subscription; subscribe to overlay changes (`client.watch` / `revalidate`) |
| `default-import` | The package's default export is not the factory this codemod maps, and no text rewrite can tell which member the file actually uses. | Import the named factory, re-run |
| `namespace-import` | A namespace import is used through member access that may itself be computed, so no static rewrite can be shown complete. | Replace with the named imports the file actually uses |
| `mixed-default-and-named` | The named half is rewritable and the default half is not; splitting it would leave the file importing from two clients. | Split it by hand first |
| `side-effect-import` | A bare import is kept for its side effects and the environment-aware client has different ones. | This is a decision about program start-up, not a rename — make it yourself |
| `type-only-import` | Overlay reads are typed by the query layer, not by the hosted client, so the replacement is a **different type**, not a renamed one. | Re-type against the query layer |
| `unmapped-specifier` | The statement imports a member with no environment-aware equivalent; rewriting only the mapped members would leave a second import pointing at the bypassed package. | Provide or remove the unmapped member |
| `re-export` | Redirecting a re-export silently changes what every consumer of that module receives. | A human decision |
| `require` | CommonJS `require` binds through arbitrary destructuring or property access, so the shape a rewrite must preserve is not visible in the statement. | Convert the file to ESM first |
| `dynamic-import` | A dynamic `import()` is consumed through a promise whose members are read later, possibly computed. | Convert to a static import |
| `dynamic-specifier` | The module specifier is built at runtime, so the module being imported is not knowable statically. | Make it a literal |
| `subpath-import` | A subpath entry point exposes a different surface from the package root; this codemod maps only the root factory. | Migrate the subpath usage by hand |

Recognised bypassing packages are `@sanity/client` and `next-sanity`, matched at the package boundary (`pkg` or `pkg/sub`, never `pkg-other`).

---

## 5. What the codemod cannot do — the follow-ups

For **every call site** of a rewritten binding, the codemod emits a follow-up rather than guessing:

```
<file>:<line>:<col>  follow-up  createClient() is now the environment-aware factory, which is
configured with a base port and an overlay state loader rather than a project id and a dataset.
The codemod does not invent that configuration: supply it here.
```

That is the honest boundary. Beyond it, the codemod does **none** of the following, and none of it is optional:

1. **Registering your queries.** The query-ID rewrite only fires on a literal that *already* matches an entry. Everything else stays as GROQ text and will be rejected at runtime. See the [query registry guide](query-registry.md).
2. **Producing candidate plans.** Every registry entry needs one, plus `maxCandidates` and `maxReferenceDepth`. There is no inference.
3. **Removing dynamic query construction.** `dynamic-query` findings are yours.
4. **Removing Sanity Live.** Refused, by design, and it is the change most likely to alter your page's data-freshness behaviour.
5. **Anything about writes.** Your Studio's writes are handled by the plugin's facade; anything in your *application* that mutates Sanity has no overlay equivalent and must be deleted. There is no promotion path.
6. **Assets.** `client.assets.upload` is refused by the facade and local-only upload is unbuilt. A migrated branch cannot contain a new image.
7. **Studio search, Vision, structure-list queries** that your custom Structure Builder code composes at runtime. The Studio's own reads take a separate path (`packages/sanity-overlay-studio/src/client/readPlan.ts`) that derives a registration from the query text at call time — see the honest caveat in §7.
8. **Migrating your schema.** Schema stays in branch code and is never serialized into overlay storage.

---

## 6. Verifying the migration

```bash
# 1 — no bypasses left
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs lint --mode strict src app lib

# 2 — nothing left for the codemod to do
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs codemod src app lib

# 3 — every registered query evaluates against a base fixture
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs query --list
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs query article-by-slug \
  --param slug=hello --base ./base-fixture.json --root <overlay-dir>

# 4 — the overlay on disk is internally consistent
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs validate --root <overlay-dir> --strict
```

Then the part no command can do: run the [§0.6 human validation script](plans/evidence/phase-1/human-validation-script.md) against your Studio.

---

## 7. Caveats you should carry forward

- **The Studio does not use the registry.** `readPlan.ts` computes a query's checksum from the same text it then registers, so §22.5's "editing a query without refreshing its checksum fails at construction" — real and load-bearing for a hand-written registry — is a **tautology on that path**. There are two planners in the codebase, and only the registry one is covered by the boundedness suite.
- **`strictQueries` ships as `false`.** With it on, once one document has branch state, every Studio-issued read the planner cannot prove complete throws `OverlayReadRefusedError` — and Studio composes GROQ at runtime, everywhere, for its own plumbing. Refusing all of it does not make the Studio safer; it makes it not boot. The default was changed to `false` on 2026-08-05 for that reason. Turn it on for your *application's* reads, deliberately, and understand what it does to the Studio before turning it on there.
- **`diagnostics.exact` is hard-coded `true`** and `diagnostics.unsupportedFeatures` is always `[]`. A caller learns a result is not exact by **catching an error**, never by reading a flag. Do not write logic against `diagnostics.exact`.
- **The lint rule reads literals; it does not evaluate your program.** Queries assembled from fragments or fetched at runtime are invisible to it and will fail at runtime instead.
- **`ci/scan.ts` extraction is textual** — no TypeScript compiler, no YAML parser. It can under-report, but it never fabricates.
