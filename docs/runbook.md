# Runbook — on-call and incident

**Status:** Draft
**Date:** 2026-08-06
**Source:** [docs/PRD-v1.md](PRD-v1.md) §14.3–§14.4 (file rules and recovery), §25.14 (error contract), §33 (failure injection), §37 Phase 9
**Scope:** local `fs` mode. There is no deployed preview, no Blob adapter and no preview enforcement layer, so there is nothing on-call for in production.

---

## 0. Orientation

### What can be running

| Process | Port | Started by |
|---|---|---|
| Studio | 3333 | `pnpm --filter kitchen-sink dev` |
| Track B proxy (write guard) | 3999 | `node examples/kitchen-sink/spikeB-proxy/proxy.mjs` |
| Overlay API | 3998 | `node examples/kitchen-sink/overlayApiServer.mjs` |
| Site reading the overlay | 4000 | `pnpm --filter local-site dev` |

Port 3333 is fixed: the overlay API grants CORS to exactly one origin.

### First three commands, always

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs status   --root <dir>
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs validate --root <dir>
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs history  --root <dir> --limit 20
```

`status` reads the manifest only and never opens a record — it is safe on a broken overlay. `validate` **never writes**; repairing is `normalize`'s job, and *"a gate that silently fixed what it was measuring would report clean forever."*

### Exit codes

`0` clean · `1` internal error (a bug) · `2` findings · `3` confirmation required · `4` overlay missing/corrupt/absent document · `5` usage error · `6` query refused by the registry.

**`2` is not a crash.** It means the command ran and found something.

### Two safety properties to rely on under pressure

- **`reset`, `rebase` and `cleanup` never write without `--confirm`**, and all three support `--dry-run`. `--dry-run` wins even with `--confirm`.
- **Every byte the CLI writes to stdout and stderr is passed through a redactor.** Any env var whose *name* matches `/(TOKEN|SECRET|PASSWORD|PASSPHRASE|API_?KEY|CREDENTIAL|PRIVATE_KEY|_AUTH)/i` and whose value is 8+ characters is replaced with `«redacted»`. You can paste CLI output into a ticket.

---

## 1. The overlay API is unreachable

### Symptom

The banner turns critical:

```
The overlay API at http://localhost:3998 is unreachable. Edits are held locally and will be retried.
```

and after **20** degraded writes (`RETRY_BUFFER_LIMIT`) it escalates:

```
The overlay API at http://localhost:3998 is unreachable. Too many edits are unsaved — editing is
now read-only to avoid losing more.
```

Console messages, exact:

| Cause | Message |
|---|---|
| No `fetch` implementation | `[sanity-overlay-studio] no fetch implementation available for <url>` |
| `fetch` threw — the real "unreachable" | `[sanity-overlay-studio] the overlay API at <url> is unreachable: <error.message>` |
| Non-JSON body | `[sanity-overlay-studio] the overlay API at <url> answered <status> with a body that is not JSON (<first 120 chars>)` |
| Non-2xx or `body.ok === false` | `[sanity-overlay-studio] <url> answered <status>: <detail>` |

### What is actually happening

The transport classifies every call into three outcomes:

```
ok        the overlay accepted and persisted it        → editor: saved
degraded  transient (5xx, offline, malformed answer)   → editor: saved, loudly
fatal     401/403; it provably cannot ever land        → editor: NOT saved
```

Unreachability is always `degraded`, never `fatal`. Edits are held client-side.

### Diagnose

```bash
curl -s http://localhost:3998/health
curl -s http://localhost:3998/state | head -c 400
```

Implemented routes: `/health`, `/events`, `/state`, `/resolve`, `/query`, `/query/plan`, `/commit`. Anything else answers:

```json
{"ok":false,"error":{"code":"NOT_FOUND","message":"no route for GET /whatever"}}
```

### Recover

1. Restart the overlay API on the **same `--root`**. Held edits are retried.
2. Check the banner returns to *"Branch overlay active…"*.
3. Confirm on disk — the only trustworthy check:
   ```bash
   node packages/sanity-overlay-cli/bin/sanity-overlay.mjs status --root <dir>
   ```
   The revision must have advanced.

### The failure mode this prevents

`createOverlayTransport` calls `assertNoStagingWrite` **at construction** and throws if `apiUrl` points at Sanity. That is deliberate: `call()` converts every fetch throw into `degraded`, so a degraded write aimed at Sanity would render as *"saved, loudly"* — a staging write reported as a save. Construction-time is the last moment it can fail honestly.

### Adjacent: the Studio refuses to start at all

```
[sanity-overlay-studio] refusing to start: `SANITY_API_TOKEN` names a Sanity credential whose
capability cannot be established from its name, so it is treated as write-capable…
```

Name-based and **fails closed**. `SANITY_API_TOKEN` and `SANITY_TOKEN` are refused; `SANITY_API_READ_TOKEN` is not. Rename it or set `OVERLAY_MODE=off`.

---

## 2. Checksum divergence — repairable or corrupt

**These are two different incidents.** The distinction is a boolean field on the finding, not a judgement call.

> `repairable` distinguishes the two §14.3 cases: a stale *metadata* checksum on a semantically valid file is repairable and must not be rejected (the manual Git merge case), whereas **a content-addressed artifact whose bytes no longer hash to its own filename is corruption.**

| Finding kind | Condition | `repairable` |
|---|---|---|
| `intent` | `intentChecksum(value) !== value.checksum` | **true** — repair it |
| `intent` | file does not parse | false |
| `revision` | unparseable, or recomputed ≠ the head's checksum | false |
| `snapshot` | unparseable, or recomputed ≠ its own filename | false |

Plus a `missing` list: `neither the immutable revision nor the canonical intent file exists`.

### Diagnose

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs validate --root <dir>
```

```
  checksum  <logicalId|->  <ref>  expected <expected> got <actual>  (repairable)
  missing   <logicalId|->  <ref>  <reason>
```

CI appends the remediation inline: `` (repairable — `normalize --repair-checksums`) ``.

### Case A — repairable (the Git merge case)

The overwhelmingly common cause: someone resolved a merge conflict in `intent.json` by hand, so the content is valid and the recorded checksum is stale.

```bash
# report only, writes nothing
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs normalize --root <dir>

# repair
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs normalize --root <dir> --repair-checksums
```

```
  repaired  <ref>
  stale     <ref>  stored <expected> recomputes to <actual>
```

Scope it with `--document <id>` when you know which one moved.

### Case B — corrupt (do not repair)

```
  CORRUPT   <ref>  <kind>  expected <expected> got <actual>
```

`normalize` refuses these, and the reason is the important part:

> a content address that no longer matches its own content is **NOT** repairable: rewriting the checksum would destroy the evidence. Restore those files from Git.

```bash
git checkout -- <dir>/.sanity-overlay/<ref>
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs validate --root <dir>
```

### Case C — `intent.json` does not parse

```
  INVALID  <ref>
    OVERLAY_STORE_CORRUPT: <ref> is not valid overlay state: <reason>
    bytes preserved at .sanity-overlay/<ref>.broken
    the store is still serving the last valid state for this file and will not serve
    the broken one (PRD §14.3, §14.4 step 10). To recover, either:
      git checkout -- .sanity-overlay/<ref>
      sanity-overlay reset --document <logicalId> --confirm    # discard branch state
```

The broken bytes are preserved as `<ref>.broken` (gitignored) and the store keeps serving the last valid state. Nothing is lost by taking your time.

### Checkpoints are stricter than overlays

`validate --checkpoint <dir>` **rejects** repairable divergence, which `import` would have repaired:

```
repairable divergence is rejected here and would be repaired by `import` (PRD §14.3).
note: a checkpoint carries no §13.3 records, so manifest document heads cannot be
      cross-checked against content — a structurally valid manifest.json edit can
      only ever be classified repairable (PRD §29.1, §29.2).
```

`import --strict` makes an import reject rather than repair; the default is `onDivergence: 'repair'`.

### Related primitives

`OVERLAY_CHECKSUM_INVALID`, from three places:

- `Expected a 64-character lowercase hex SHA-256 checksum, received <value>`
- `Overlay revision "<r>" must be non-empty and contain no dot`
- `Synthetic overlay revision "<rev>" is not a valid Content Lake <context>`

Synthetic revisions are `overlay.<overlayRevision>.<12-hex-prefix>`.

---

## 3. Conflicts

### What a conflict is

The base moved under a branch edit. That is a normal event, not an incident — the base is live and read-only to us, and someone else moves it (PRD §8.4).

Conflict identity is **derived, never generated**:

```
`${documentId}:${type}:${path === undefined ? '$' : encodeOverlayPath(path)}`
```

which is what makes merge a pure function and two evaluations byte-identical.

Persistence is **not** an append-only log. The stored list is the set of disagreements *currently true*: newly detected ones are added, a previously known one is kept (preserving `detectedAt` and any `resolution`) **only while all three compared values are unchanged**, and one that is no longer detected is **dropped — resolved or not**.

### Severity, and what it blocks

| Type | Default severity |
|---|---|
| `SAME_PATH_CHANGED`, `OVERLAY_SAME_PATH_CHANGED`, `BASE_DRAFT_DELETED` | soft |
| `REFERENCE_TARGET_DELETED` | soft — **hard** when the reference is strong |
| `PARENT_SHAPE_CHANGED`, `BASE_DOCUMENT_DELETED`, `BASE_TYPE_CHANGED`, `ARRAY_ITEM_DELETED`, `ARRAY_KEY_COLLISION`, `STRONG_REFERENCE_INVALID`, `LOCAL_ID_COLLISION`, `SCHEMA_VALIDATION_ERROR`, `UNSUPPORTED_SCHEMA_MIGRATION` | hard |

**Hard conflicts block branch publish; draft editing continues.** Soft conflicts do not block anything — local values win — but they are a review gate.

### Diagnose

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs conflicts --root <dir> --actions
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs conflicts --root <dir> --all      # incl. resolved
```

Columns: `SEVERITY | DOCUMENT | TYPE | PATH | STATE`, where state is `unresolved` or `resolved:<type>`. Exits **2** if anything is unresolved.

**The CLI deliberately offers no resolution.** §28.3 actions need a value and an actor, *"and a CLI that guessed either would be resolving on the reviewer's behalf."*

### Resolve

Seven panel actions, mapped onto five resolution types:

| Action | Resolution |
|---|---|
| `keep-branch-value` | keep-local |
| `accept-current-staging` | accept-base |
| `manual-edit` | manual |
| `remove-local-override` | accept-base |
| `keep-as-branch-created` | keep-local |
| `accept-base-deletion` | delete-local |
| `rename-branch-id` | rename |

Which apply depends on the conflict:

- `LOCAL_ID_COLLISION` → keep-branch-value, rename-branch-id
- `BASE_DOCUMENT_DELETED` → keep-as-branch-created, accept-base-deletion
- has a `path` → keep-branch-value, accept-current-staging, manual-edit, remove-local-override

Every resolution emits a `ConflictResolutionTransaction` — §28.1 requires the audit record.

### ⚠ Today, resolution has no working UI

**The overlay API's `GET /state` returns no conflict field**, so the Studio's report always resolves to *"this overlay API does not report conflicts"* and the document action renders as a disabled **Conflict state unknown**. Conflicts are computed only inside `POST /resolve`, per read.

So an on-call path today is:

1. Confirm the conflict exists — `sanity-overlay conflicts --root <dir> --actions`.
2. Decide.
3. Apply it with `rebase`, or by editing the branch value in Studio, or by `reset --document <id> --confirm` if the branch change is expendable.

### Rebase

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs rebase --root <dir> \
  --base ./base-snapshot.json --mode auto --dry-run
```

- `--base <file.json>` is **mandatory** — `fs` mode has no live base connection.
- `--mode` defaults to `auto`; the others come from core's `REBASE_MODES` (e.g. `accept-base`, `keep-local`).
- **Any blocked document exits 2 and writes nothing at all** — not even the documents that would have succeeded. Rebase is all-or-nothing.
- `--confirm` required to write.

### Scheduled drift detection

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs ci --check base-drift --base ./base.json --root <dir>
```

Re-runs the §17.3 merge per document against a fresh base, recomputes the summary, and **never writes**. Per-document drift is a warning; a *changed* summary versus the manifest is an error.

**Known narrowing:** the drift check passes `localTouchedPaths` but not §17.5 `unsetPaths`, so a held-down unset can be under-reported.

---

## 4. A wedged commit queue

There are **two** serialised queues. Both were explicitly hardened, and the hardening is why this is a short section.

### Server side — the overlay API

```ts
let queue: Promise<void> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.then(() => undefined, () => undefined)   // the tail is FLATTENED
  return run
}
```

> **THE TAIL IS FLATTENED**, and that is the whole of it. A tail that carried the rejection would leave every later `queue.then(task)` **skipping its task — one poisoned autosave wedging every autosave after it** — and would hand the same rejection to `close()`, which awaits this chain.

**Symptom if it ever regresses:** autosaves stop reaching disk while the Studio reports success (a silent no-op, not an error), and `close()` never settles so `SIGINT` hangs.

On this mutex: `POST /commit` and the direct-edit watcher pass. **Reads are deliberately not queued.** `announceCommit` fires only *after* the enqueue resolves — durability precedes notification.

### Client side — the Studio transport

```ts
const run = queue.then(task, task)                     // runs on BOTH settle paths
queue = run.then(() => undefined, () => undefined)
```

Stronger, because the echo's revision chain is a sequence: transaction N+1 declares `previousRev` = transaction N's `resultRev`. *"Letting two commits race means the overlay can apply them in the other order, and the pane's chain and the stored one diverge with no signal until a much later read."*

Both `commit` and `operation` share this queue, so a document action cannot interleave with the edit whose revision chain it is about to rewrite.

### The wedge that is real: a terminal session state

Session is `active | unauthenticated | logged-out`.

- `noteAuthFailure()` → `unauthenticated`, with:
  ```
  auth failure <status> on the <source>: <message> — the session is no longer authorized,
  so writes will not be acknowledged until the token is refreshed
  ```
- `logout()` is **terminal**. Listeners are cleared:
  ```
  session logged out: every listener subscription is released and no further write will be acknowledged
  ```
  *"`logged-out` — terminal. A new session arrives with a new page load."*

**Recovery from `logged-out` is a page reload. There is no in-session route out.** From `unauthenticated`, `restoreSession()` recovers automatically when a `GET /users/me` or `GET /auth/id` goes past carrying a live identity — piggybacking on the round trip Studio already makes after refreshing its token. It never recovers `logged-out`.

While in either state, writes are refused rather than acknowledged:

```
the session is logged out: this write cannot be persisted and must not be reported to the editor as saved
the session is not authenticated (HTTP <status>): this write cannot be persisted and must not be reported to the editor as saved
```

### ⚠ A guard 403 must not log you out

Recorded live, 2026-08-06: Studio said *"Your Sanity session is no longer authenticated. Editing is read-only"* while the session was fine. **The only 4xx responses in that session were the Track B write guard refusing writes** — which is the system working.

The fix: the transport ends a session only when the overlay body **declares** `origin: 'sanity' | 'content-lake' | 'upstream'`. An overlay refusal (`OVERLAY_*` code) is never an auth signal.

**Operational consequence, and a real gap:** neither overlay server ever sets one of those origins — both emit `origin: 'commit'` or `origin: 'direct-edit'`. So the session-ending path is currently **unreachable from the shipped servers**. If you see the unauthenticated banner, the cause is Studio's own auth state (a genuine sign-out or an expired token), not the overlay.

### Symptom of a stuck client queue

`pendingWrites` non-zero indefinitely, showing as *"Saving N change(s) to the overlay…"*. Note that in the shipped runtime `pendingWrites` starts at `0` and is only ever decremented, so the `saving` banner state is currently unreachable — if you see it, `runtime.ts` has changed since 2026-08-06.

---

## 5. The HTTP/1.1 concurrency ceiling

**This is a known, deliberately unpatched risk** ([gate-review](plans/evidence/phase-1/gate-review.md) recorded risk 1). It is load-dependent, so a clean session proves nothing.

### Symptom

The Studio structure tool crashes or hangs. The recorded instance:

```
Socket timed out on request to
http://b1n03q3z.localhost:3999/v2025-02-19/data/doc/parity/drafts.author-2
```

The CORS preflight for that path answered `204` **twice** and the GET has **no completed row at all** — rows are written on completion, so a request with no row never finished. Nine minutes later, once the page had settled, the same endpoint answered `200` in **184 ms**. The endpoint was never broken.

### Cause

Chrome's HTTP/1.1 per-host connection limit is **6**. Studio's own long-lived `/data/listen/<dataset>` streams (plus an agent bundle listener) consume all six, and every subsequent request starves. The proxy speaks plain HTTP/1.1; real Sanity avoids this with HTTP/2 multiplexing.

### The boundary, exactly

Reproduced in `packages/sanity-overlay-testkit/test/proxy-concurrency.test.ts`:

```
  unbounded pool, six streams  -> completes, six still open
  pool of 6, five streams      -> completes, five still open
  pool of 6, six streams       -> never completes          <- HERE
  close one stream             -> recovers immediately
  h2c, six streams + a request -> completes, on ONE TCP session
```

Neither the proxy nor its upstream agent is the bottleneck — the unbounded-pool case proves that.

### Diagnose

```bash
grep -c '/data/listen/' "$PROXY_LOG"
grep -c 'OPTIONS'       "$PROXY_LOG"
```

The signature is **preflights far exceeding completed GETs**. The live session showed **72 preflights against 34 completed GETs**.

### Mitigate now

- Close document panes. Recovery is immediate the moment a listener slot frees.
- Reload the tab.
- Avoid keeping six-plus panes open on one Studio tab.

### Why it is not patched

Both obvious fixes were evaluated and rejected on evidence:

- **Bounding the listener streams** trades a load-dependent hang for **permanent read-only flicker plus a refetch storm** — a reconnect gap of 200 ms–2 s puts open form fields into read-only, and evicted listeners reconnect immediately and re-saturate.
- **Serving HTTP/2** is the correct fix but rewrites the transport of the project's only security boundary and requires re-implementing the WebSocket frame guard on RFC 8441 extended CONNECT. The test's h2 leg uses cleartext `h2c`, **which browsers do not speak** — a real deployment needs TLS with ALPN `h2` and a trusted certificate.

The test asserting the failure is deliberately pinned red-when-fixed: *"WHEN THE PROXY LEARNS TO SPEAK HTTP/2 THIS ASSERTION FLIPS RED… whoever lands it must come here, flip this to `toBe(true)`, and move it into the invariant block. A `skip` would let the whole finding evaporate; a literal cannot."*

**Accepting or fixing this is an owner decision** and is listed as blocking any Gate A sign-off that assumes interactive stability.

---

## 6. Other things you will hit

### Proxy write guard 403 — working as designed

```json
{"error":{"code":"OVERLAY_WRITE_BLOCKED","message":"Writes to Content Lake are blocked by the overlay proxy (PRD §36.1 Track B)."}}
```

Logged with `"blocked":true`. The guard is **default-deny**: it asks *"is this one of the reads I know about?"*, so an unobserved read endpoint 403s until it is added. Paths containing `.` or `..` segments are never classified as reads. `/agent/action/*`, `/data/mutate`, `/data/actions` and `/…/upload` are blocked **whatever the verb**.

A guard 403 must not log the editor out — see §4.

**⚠ The guard has a known bypass, open as of 2026-08-06.** The [security review](plans/evidence/phase-1/security-review-2026-08-06.md) records **P1-1**: a percent-encoded `?` or `#` truncates the path the guard classifies, so `POST /data/query%3F/../actions/<dataset>` classifies as a **read** and is forwarded. The defect is present in **both** guard implementations — the proxy's `writeGuard.mjs` and the packaged `previewWriteGuard.ts` — and the proxy forwards the raw request line unmodified. Two further P1s (a WebSocket frame-guard fragment leak, and `Transaction.patch(id, builderFn)` handing the callback a `Patch` bound to the **raw** client) are open alongside it.

Operationally: **do not treat a clean proxy log as proof that nothing escaped** until those close. The independent oracles — a direct read of the upstream `_rev`, and the absence of a `drafts.<id>` document upstream — remain valid and are what step H27 of the [human validation script](plans/evidence/phase-1/human-validation-script.md) checks.

### Overlay identity mismatch — the Studio stops

```
[sanity-overlay-studio] the overlay API reports overlay "<x>" but this Studio is configured
for "<y>". Editing is stopped.
```

Banner `identity-mismatch`, severity critical, `editing: 'blocked'`, fatal — the whole Studio is replaced by an error screen. It is the top of the precedence order:

```
identity-mismatch > disabled-unexpectedly > unauthenticated > offline
> schema-mismatch > hard-conflict > soft-conflict > saving > healthy
```

Cause: the overlay server's `--id` (or derived PR/branch identity) disagrees with what the plugin derived. Fix the configuration; do not edit through it.

### `OVERLAY_MODE` absent

The read client **refuses** rather than defaulting. The rationale is the sharpest operational warning in the repo: the old `?? 'off'` meant a misspelled or unpropagated variable **silently put a reader on staging while every other signal said "branch."** `off` is a perfectly good setting — it just has to be chosen.

Every setting is readable under three prefixes: `SANITY_STUDIO_`, `SANITY_`, bare. Blank is unset, not a value.

### Path traversal

```
OVERLAY_PATH_ESCAPE: Refusing to touch "<candidate>": it resolves outside the overlay root "<root>"
```

Also: `INVALID_REQUEST: FsOverlayStore root must be an absolute path, received "<root>"`.

### Query refusals

`QUERY_NOT_REGISTERED` 422 · `QUERY_CHANGED` 422 · `UNSUPPORTED_GROQ` 422 · `CANDIDATE_LIMIT_EXCEEDED` 413 · `REFERENCE_DEPTH_EXCEEDED` 422 · `INVALID_GROQ` 400 · `GROQ_EVALUATION_FAILED` 500 · `QUERY_CALLER_NOT_ALLOWED` 403 · `QUERY_PERSPECTIVE_NOT_REGISTERED` 422. CLI exit **6**. See the [query registry guide](query-registry.md).

On the example site these render as an error page carrying the §22.9 status — **never a silent answer from base**.

### Pinned evidence you can destroy by accident

- `examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl` is pinned at **exactly 730 lines** and asserted by audit predicates. It has been contaminated twice by someone starting the proxy without `PROXY_LOG` set. **Always set `PROXY_LOG`.**
- `examples/kitchen-sink/.sanity-overlay/` is **committed evidence** from the 2026-08-04/05 sessions. Always start the overlay server with `--root` pointing at a scratch directory.

If you contaminate the log: the committed prefix is append-only, so verify the prefix is byte-identical, preserve the new rows under a dated filename, and restore the pinned baseline. That is what was done on 2026-08-04 — no evidence was discarded.

---

## 7. Reset, cleanup and last resorts

### Discard branch state

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs reset --root <dir> --document <id> --dry-run
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs reset --root <dir> --document <id> --confirm
```

Requires **exactly one** of `--all` or `--document <id>` — *"refusing to guess which state to destroy."* The loss report always prints first.

### Reclaim space

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs cleanup --root <dir> --dry-run
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs cleanup --root <dir> \
  --keep-last 50 --confirm
```

Orphan collection always runs; the runtime log is pruned **only** if `--keep-last <n>` or `--keep-after-revision <n>` is given. Dangling idempotency pointers are cleared regardless — and the command prints the cost: **a retried request carrying a discarded idempotency key will re-apply.**

### Take a checkpoint before doing anything destructive

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs export --root <dir> --bundle ./rescue.json
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs export --root <dir> --output ./review-tree
```

`--bundle` is the lossless portable form (includes the transaction log unless `--no-transactions`) and is byte-stable because the clock is pinned to `manifest.updatedAt`. `--output` is the §29.1 review tree.

To restore:

```bash
node packages/sanity-overlay-cli/bin/sanity-overlay.mjs import --root <dir> --bundle ./rescue.json \
  --overwrite --confirm
```

`--overwrite` over an existing overlay without `--confirm` exits 3. `--strict` rejects repairable divergence instead of repairing it.

**A checkpoint carries no runtime records and no transaction log** — that is by design (PRD §29.1/§29.2), and `import` prints the note every time.

### Git is the real backup

`.sanity-overlay/` is committed and canonically serialized. `git checkout -- <path>` is a legitimate recovery step and is named as one in the CLI's own output.

---

## 8. What has no runbook, because it does not exist

- **Vercel preview / Blob mode.** `OVERLAY_MODE=blob` throws at startup. Gates C and F are not started.
- **A deployed enforcement layer.** The proxy is a local process. No preview auth, no CSRF, no session, no HMAC.
- **Alerting and observability.** PRD §38.3 lists *"Observability and alerts exist"*; nothing does. The signals available are the CLI's exit codes, the proxy JSONL log, and the overlay server's stdout.
- **Branch assets.** `client.assets.upload` is refused; local-only upload is unbuilt. The asset store and delivery code exist and have never been exercised in a browser.
- **The browser E2E suite.** `@playwright/test` is not installed and `playwright.config.ts` cannot be imported. What runs today:
  ```bash
  node --test e2e/audit/predicates.test.mjs
  node --test e2e/playwright/selectors.test.mjs
  node e2e/audit/runAudit.mjs
  ```
- **Overlay revision history.** `sanity-overlay history` reads the local transaction log and prints `history NOT RETAINED` when it is absent. It is not Sanity's History and it is **not durable** — checkpoints drop it, `cleanup` prunes it.
