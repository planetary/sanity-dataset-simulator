# Plugin and hosted-feature compatibility guide

**Status:** Draft
**Date:** 2026-08-06
**Source:** [docs/PRD-v1.md](PRD-v1.md) §21.10 (features to disable), §21.11 (plugin classification), §21.12 (upgrade policy), §0.4 (product boundary)
**Verified against:** `sanity@6.8.0`, `@sanity/client@7.26.0`

---

## The rule this all follows

The overlay is a **branch-preview authoring layer**, not a replacement for Sanity Content Lake (PRD §0.4). Anything whose state lives in the hosted product — comments, tasks, releases, schedules, project events, hosted AI — has no overlay representation. It is not degraded; it is **absent**, and it is turned off rather than left to fail confusingly.

Everything below is what `packages/sanity-overlay-studio/src/features.ts` does, not what it intends to do.

---

## 1. Hosted features: what is off, and how

`HOSTED_FEATURES` is exactly seven entries. Each carries a `removal` classification — `clean`, `partial`, or `not-installed` — and a `lever` naming the mechanism.

| Feature | Removal | Lever | Mechanism |
|---|---|---|---|
| **Comments** | `clean` | plugin option | `document.comments.enabled: false`, set both by the plugin and at the root config, **plus** the `sanity/comments/comments` inspector is filtered out |
| **Tasks** | `clean` | workspace config | `tasks.enabled: false` at the root config |
| **Releases** | `clean` | workspace config | `releases.enabled: false` at the root, plus the `releases` tool name is filtered |
| **Scheduled Drafts** | `clean` | workspace config | `scheduledDrafts.enabled: false` and legacy `scheduledPublishing.enabled: false` at the root, plus the `schedules` tool is filtered and the `schedule` document action is removed |
| **Native History** | **`partial`** | resolver | Inspector-name filter only — see §2 |
| **AI Assist** | `not-installed` | none | Nothing in the config disables it; it is `@sanity/assist`, not a `sanity` dependency. What *is* enforced is the network half: `client.agent.action.*` is refused by the facade |
| **Vision** | `clean` | resolver | Tool-name filter |

Also removed, and not in PRD §21.10 — the header calls it "the same class of problem: product announcement cards advertise hosted features that do not work here":

- `announcements.enabled: false`

The two filter lists are literal and closed:

- `DISABLED_HOSTED_TOOL_NAMES` = `vision`, `releases`, `schedules`, `media-library`, `canvas`
- `DISABLED_HOSTED_INSPECTOR_NAMES` = `sanity/structure/history`, `sanity/comments/comments`

### Why the levers differ

They differ because `sanity@6.8.0` does. The file header records what was measured:

- `releases.enabled` **is** a key on `PluginOptions` and is **silently ignored** there for both registration and `Source.releases`, so it has to be set at the root.
- `scheduledDrafts.enabled` set from a plugin flips the runtime flag but **does not stop the tool and the `schedule` action being installed**.
- `prepareConfig` appends the hosted plugins *after* every user plugin, while `flattenConfig` puts the root config **last** — which is why the overlay's resolvers are composed to run last, and why the root config is used where a plugin option would be the obvious place.

Practical consequence: **the overlay's filters must run after yours.** `composeResolver` runs the consumer's resolver or array first and the overlay's second. Do not try to re-add a filtered tool downstream of the overlay; there is nothing downstream of it.

---

## 2. Native History cannot be cleanly removed — read this

This is the one honest asterisk in the list, and it is classified `partial` in code for exactly this reason.

**`sanity@6.8.0` has no on/off configuration key for document history.** What the overlay can do, and does, is filter the `sanity/structure/history` inspector out of the resolvers, and guard the code that opens it (`historyInspector && …`) so it degrades to a no-op. The visible panel and the revert button go away.

**What remains reachable:**

- the document-events and timeline machinery still runs;
- **`?rev=` and `?since=` pane params are still reachable by deep link**, as is the "compare versions" route;
- the Releases tool links straight to the history inspector when releases are enabled (they are not, here — but that is the coupling).

So: a user who pastes or bookmarks a `?rev=` URL gets a hosted-history view of **Content Lake transactions the overlay never produced**. Branch edits are not in it and never will be; base edits are. It is not wrong, it is answering a different question than the user thinks they asked.

The replacement — PRD §32.2 "Overlay revision history" — is **unbuilt**. The overlay does keep a local transaction log under `.sanity-overlay/.runtime/transactions/`, readable with `sanity-overlay history`, but it is explicitly not Sanity's document History and it is **not durable**: checkpoints drop it by design (PRD §29.1/§29.2), and `cleanup --keep-last`/`--keep-after-revision` prunes it. When the log is absent, `history` prints `history NOT RETAINED` rather than an empty list.

**One correction to the code's own prose.** `features.ts`'s explanation says the `restore` action "can be filtered out of the resolvers". It is not. `restore` is in `OVERLAY_ROUTED_ACTIONS`, so it is kept and routed like any other write, and a test pins that. The `why` text describes what is *possible*, not what is done.

---

## 3. Document actions

### Kept and routed through the overlay

```
publish   unpublish   discardChanges   delete   duplicate   restore
```

No component override for any of them. Routing belongs to the client facade, not to a replacement action: *"Replacing the action components would not make that safer — it would add a second, weaker copy of the same guarantee."* Note the key is `discardChanges`, not `discard`.

### Removed outright

```
schedule            discardVersion      unpublishVersion
linkToCanvas        editInCanvas        unlinkFromCanvas
```

Version actions belong to the Content Releases plane; Canvas actions are hosted infrastructure. Anything not in either list keeps its default behaviour.

### Added by the overlay

| Action ID | Label | Dialog |
|---|---|---|
| `overlayRebase` | *Rebase onto current base* | `{type: 'confirm'}` — message is the loss report, `tone: 'critical'` when destructive |
| `overlayResolveConflict` | *Resolve conflicts (N)* | `{type: 'dialog'}` — a custom panel, only when a renderer is injected |
| `overlayCheckpoint` | *Create checkpoint* | `{type: 'confirm'}`, `tone: 'primary'` |

Menu order is `rebase, conflictResolution, checkpoint`, and they are **appended, never prepended**.

The invariant, stated in the source: *"DESTRUCTION IS CONFIRMED, ALWAYS. `onHandle()` never sends. It opens the confirm dialog whose message IS the loss report, and only `dialog.onConfirm()` reaches the transport."* That is a browser-observable claim with no browser test; it is step **H20** of the [human validation script](plans/evidence/phase-1/human-validation-script.md).

**The conflict action is not usable today.** See §6.

---

## 4. The client facade: what a plugin can and cannot call

Any plugin that gets a client via `useClient()` receives the facade. The facade's namespace policy is **default-deny**: a method is a read only if it is explicitly listed as one; **anything not declared a read or a push is a write**, and writes are refused.

| Namespace | Reads allowed | Everything else |
|---|---|---|
| `assets` | *(none)* | refused — `upload` is a declared write |
| `datasets` | `list`, `getEmbeddingsSettings` | refused |
| `agent` | *(none)* | refused |
| `agent.action` | *(none)* | refused |
| `releases` | `get`, `fetchDocuments` | refused |
| `projects` | `list`, `getById` | refused |
| `users` | `getById` | refused |
| `live` | *(none)* | `events` is a **push** and gets its own refusal |
| `mediaLibrary` | *(none)* | refused |
| `mediaLibrary.video` | `getPlaybackInfo` | refused |

The policy is pinned against the installed `@sanity/client` prototypes, so **an upgrade that adds a method turns the suite red** rather than silently opening a hole.

Refusals are plain `Error`s stamped with a non-enumerable `sanityOverlayRefusal = true` — deliberately marked, so a host that funnels errors through a session observer does not read the overlay's own "no" as Sanity revoking the credential. The message shape:

```
[sanity-overlay-studio] blocked assets.upload: asset uploads are binary and live outside the
document overlay. Letting it through would put the editor and the overlay out of sync, and
could write to the shared dataset.
```

Reason strings by plane:

| Plane | Reason |
|---|---|
| documents | this document write could not be planned |
| asset | asset uploads are binary and live outside the document overlay |
| agent-action | Agent Actions mutate documents server-side, where the overlay cannot follow |
| dataset-admin | dataset administration is a project-plane operation, not a document edit |
| releases (version methods) | Content Releases are hosted version infrastructure the overlay does not reproduce |

Top-level write methods (`create`, `createIfNotExists`, `createOrReplace`, `delete`, `mutate`, `action`, the `mutate`/`actions` shapes of `dataRequest`, and `request` at a write endpoint) are **intercepted and echoed** to the overlay rather than refused — that is the editing path. `patch()` and `transaction()` return wrapped builders whose `.commit()` is blocked. `withConfig`, `clone` and `withUrlSourceMapping` re-wrap their result, so a plugin cannot escape by cloning.

`createVersion`, `replaceVersion`, `discardVersion` and `unpublishVersion` are refused outright.

---

## 5. Classifying your own plugins

PRD §21.11's table, with what this implementation adds.

| Plugin class | Default status | What to check here |
|---|---|---|
| Pure form component | Likely compatible | Test schema value and patch handling. Portable Text and keyed arrays are the risky ones, and they have **no browser coverage** — see H11–H14 of the [validation script](plans/evidence/phase-1/human-validation-script.md) |
| Preview component | Likely compatible | Test projections and references. A preview that composes GROQ at runtime hits the Studio read path, not the registry |
| Structure Builder customization | Compatible with query constraints | Audit your list queries. A list query the planner cannot bound is refused under `strictQueries`, and answered from an unbounded plan otherwise |
| Custom document action | Case-by-case | It must route its writes through the facade. A direct `fetch` to `api.sanity.io` bypasses the facade entirely and is caught only by the proxy — which is not present in every topology |
| Asset source | **Unsupported today** | `client.assets.upload` is refused; local-only overlay upload is unbuilt |
| Plugin using `useClient` reads only | Case-by-case | Confirm it receives the facade rather than constructing its own client |
| Plugin using direct HTTP endpoints | Unsupported until adapted | Endpoint audit required. `classifyWriteEndpoint` normalizes scheme, authority, percent-encoding, `.`/`..` segments, query, fragment and case before classifying, so laundering a path does not help |
| History, release, comments, tasks plugin | Unsupported | Disabled — see §1 |
| Visual editing plugin | Degraded | Source maps and mutation routing are unbuilt. Presentation click-to-edit is open decision **D09** |

### The CI check

`sanity-overlay ci --check unsupported-plugins --config <path>…` scans Studio config files textually and flags:

- imports of `@sanity/vision`, `@sanity/scheduled-publishing`, `@sanity/assist`, `@sanity/comments`, `@sanity/tasks`, `@sanity/dashboard`, `@sanity/production-preview`, `@sanity/google-maps-input`;
- calls to `visionTool`, `scheduledPublishing`, `scheduledDrafts`, `comments`, `tasks`, `assist`, `dashboardTool`, `mediaLibrary`, `canvasTool`.

It **skips** with zero files, and a skip is **not** a pass — the run fails unless the skip is allowed with `--allow-skip unsupported-plugins`. The scan is textual, so it can under-report but never fabricate.

### The §0.6 abort threshold

*"More than two mandatory plugins bypass the overlay and cannot be adapted safely"* ⇒ remove those plugins from overlay mode, or stop the native-Studio approach. Count them before you start, not after.

---

## 6. Known gaps in the Studio integration

Stated plainly, because several of these look built from the outside.

**The conflict panel is unreachable in a browser.** `createOverlayConflictPanel` is a real React component and its pure half is well tested. But the Studio's conflict report comes from `GET /state`, and neither overlay server returns a `conflicts` field or a `conflictSummary` there — conflicts are computed only inside `POST /resolve`, per read, from base documents the caller supplies. So `readConflictReport` always takes its "this API does not report conflicts" branch, and the document action renders as a **disabled "Conflict state unknown"** with the tooltip *"…which is not the same as clean."* The fix is server-side, not in the panel.

**The §28.2 "Overlay Conflicts" list tool does not exist.** `conflictListRows`, `filterConflictRows`, `OPTIONAL_CONFLICT_COLUMNS` and `documentConflictIndicator` are implemented, exported and tested; **no Studio tool renders them**. Both `tools` hooks are pure filters that only remove. The only rendered conflict summary is the one-line-per-conflict list appended to the status banner.

**`hostedFeatures: 'leave'` is computed but never consumed.** `resolveOverlayOptions` produces `disableHostedFeatures`, and neither the plugin nor the config wrapper reads it — the flags and filters are applied whenever the overlay is enabled. Setting `hostedFeatures: 'leave'` does **not** currently keep Comments/Tasks/Releases on, contrary to the option's own doc comment.

**Three banner states are unreachable from the shipped runtime**: `disabled-unexpectedly` (the runtime passes `expectedEnabled: resolved.enabled`, so the two are always equal), `schema-mismatch` (never passed), and `saving` (`pendingWrites` starts at `0` and is only ever decremented). The banner's `Base` detail line likewise always reads `live and read only` because a revision is never supplied.

**There is no update channel.** The Studio package contains no `EventSource`, no `WebSocket`, no reconnect and no backoff. `ui/statusLayout.ts` calls `runtime.refresh()` on a fixed `setInterval` of 5000 ms. The overlay API's SSE bridge at `GET /events` exists and works — nothing in the product subscribes to it. Studio's *own* listeners (`/data/listen/<dataset>`) are unaffected and stream normally; note that `@sanity/client@7` streams them **over `fetch`, not `EventSource`**, which is why a proxy must stream response bodies.

**`mode: 'blob'` throws at startup**, despite being a valid mode value with a storage label.

**`text::query(...)`** parses and then throws "not implemented" during evaluation. That is a `groq-js` limitation, not this package's, and it is why Studio's global search is a `[SHOULD]`-hide item in §21.10.

---

## 7. Upgrade policy

PRD §21.12 requires exact pins for `sanity`, `@sanity/client`, `@vercel/blob`, `groq-js`, `next-sanity`, Studio plugins and Portable Text packages; a full interception and Playwright run before any upgrade; a before/after comparison of client method usage and network calls; a block on automated dependency updates merging without approval; and the last validated versions recorded in the release notes.

**Where this stands today:**

- The **oracles are pinned exactly**: `{sanity: '6.8.0', client: '7.26.0'}`, with the facade's namespace policy derived from the installed client's own prototypes.
- The **manifest is not**. `packages/sanity-overlay-studio/package.json` declares peers `sanity: "6.8.0"` and `@sanity/client: "7.26.0"` today, but the ranges have drifted before; a caret range would admit a version that silently invalidates every library-derived oracle with nothing going red. Check it before every release.
- **The Playwright suite cannot run.** `@playwright/test` is not installed. So the second §21.12 `[MUST]` has no mechanism behind it.
- **No release-notes artifact exists.** The last-validated-versions record required by the fifth `[MUST]` is this document plus `docs/plans/evidence/`.

Until the Playwright half exists, the pre-upgrade procedure is: run the full Node suite, then run the [§0.6 human validation script](plans/evidence/phase-1/human-validation-script.md) before and after, and diff the recorded results.
