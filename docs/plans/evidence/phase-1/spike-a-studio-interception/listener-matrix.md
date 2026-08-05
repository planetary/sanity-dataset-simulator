# §21.4.1 listener compatibility matrix — automated

**Date:** 2026-08-04 · **Pinned:** `sanity` 6.8.0 / `@sanity/client` 7.26.0 · **Suites:**
`packages/sanity-overlay-testkit/test/listener-matrix.test.ts` (35 tests),
`test/action-echo.test.ts` (30 tests) and `test/spike-a-auth-flows.test.ts` (88 tests), all
`vitest run`, no browser.

Closes the Gate B gap recorded in [gate-review.md](../gate-review.md): *"Not yet done: the §21.4.1
five-criterion automated matrix, reconnect convergence, unsubscribe, two-pane/two-tab"* — and the
Gate A condition *"auth-failure/reconnect/logout paths untested"*.

## How it is testable at all

`localEcho.ts` needs a live Studio, so it was never unit-testable. The protocol it implements is
not: the revision store, the subscriber registry, the plan→frame builder and the intercepted-write
planner were extracted into **`examples/kitchen-sink/spikeA/echoProtocol.ts`** — dependency-free,
injectable clock, no `window`. `localEcho.ts` is now flags, logging, rxjs and the identity-stable
proxies wrapped around it, so the browser behaviour and the tested behaviour are the same code.

Convergence claims are settled by an **independent oracle** (`Pane` in `listener-matrix.test.ts`),
a re-derivation of `@sanity/mutator`'s rules — chain check, create-first-when-missing,
`_rev = resultRev` — not by asking the emitter whether it agrees with itself.

## The five criteria (PRD §21.4.1, verbatim)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Save state reaches a stable committed state after every supported action. | **AUTOMATED** | 7 actions × table-driven: every frame carries Studio's own `transactionId` as `resultRev`, and the pane's HEAD revision equals the protocol's head afterwards. Plus `transactionTotalEvents` equals the number of frames the subscriber actually receives, so `allPendingTransactionEventsReceived` releases the transaction. |
| 2 | No lost keystrokes, duplicate patches, cursor jumps, or stale pane state occur in the E2E fixture. | **PARTIAL — protocol half automated** | Unbroken chain across a 5-mutation sequence; a 7-edit burst arrives in submission order with none lost; re-emitting a transaction id delivers nothing; a pane is not stale after edit→publish. **Cursor jumps and Portable-Text keystroke loss are browser properties and remain a human check.** |
| 3 | Reconnect produces the current head without replaying an already committed mutation. | **AUTOMATED** | After a drop, the reconnect snapshot fetch reseeds the chain and the next frame chains off *its* revision; re-emitting the pre-drop transaction delivers nothing, and the following edit still chains. An upstream mutation event from another client reseeds the chain without a snapshot fetch. **The auth variant too:** after a 401 on the stream plus a token refresh, the pane converges on a head another writer moved, the pre-401 transaction is not replayed, and after a *logout* no reconnecting pane is served at all. |
| 4 | Unsubscription stops updates and releases resources. | **AUTOMATED** | Delivery stops; `subscriberCount()` returns to 0; a double unsubscribe does not release another pane's subscription. Logout applies the same rule to the whole session: every subscription is released, and one taken out afterwards is never registered. |
| 5 | Event payloads are documented as a version-pinned compatibility contract. | **AUTOMATED** | Exact key set asserted (no extra keys) on every frame of all 7 actions, plus `type`/`visibility`/`identity`/`projection`/`eventId` values, the deliberate absence of `effects`, and monotonic timestamps under a frozen clock. Versions pinned in code via `contractVersions()`. |

## Two panes / two tabs

| Case | Result |
|---|---|
| Two subscribers on the same pair | Both converge to an identical document and revision |
| A pane opened mid-session | Converges with the pane that was open from the start — the second tab's snapshot fetch is non-authoritative and must not reset a synthetic revision |
| A document action across differently-scoped panes | Pair pane gets 2 frames (1/2, 2/2); a published-only pane gets 1 frame (1/1) and still converges |
| One pane's handler throws | The other pane still receives the frame |

**The per-subscriber event count is load-bearing and was wrong before.** The old builder stamped
`1/1` on every frame. `sequentializeListenerEvents` buffers a transaction until it has seen
`transactionTotalEvents` frames, so a shared count would park any pane matching only part of a
multi-document transaction until the 30 s deadline. Counters are now computed per subscriber at
delivery time, exactly as the real server scopes them to each listener's filter.

## Document-action echo (Gate A breadth, PRD §18.4-§18.9)

Six actions moved from *blocked, not echoed* to *blocked, echoed and persisted*. The wire shapes
were read out of `node_modules/sanity/lib/datastores-*.js` (`serverOperationImpls`) at the pinned
version, not guessed.

| Studio action | Wire payload | Frames emitted | Core reducer |
|---|---|---|---|
| Publish | `sanity.action.document.publish` | published `createOrReplace` **then** draft `disappear` (§18.5 order) | `publish` |
| Unpublish | `sanity.action.document.unpublish` | draft `createOrReplace` **then** published `disappear` (§18.6 "draft safely stored first") | `unpublish` |
| Delete | `sanity.action.document.delete` (`includeDrafts`) | one `disappear` per draft Studio reports, then published | `deleteDocument` |
| Discard | `sanity.action.document.discard` | draft `disappear` only | `discardDraft` |
| Restore | `sanity.action.document.replaceDraft` (`attributes`) | draft `createOrReplace`; `appear` when it was deleted | `restore` + `createOrReplace` |
| Duplicate | `client.create(copy, {tag: 'document.duplicate'})` | new draft `appear` | `duplicate` |

Two findings worth keeping:

1. **Duplicate is not an Actions API call.** It is a tagged `create`, and the copy keeps the
   *source's* `_rev` (only `_createdAt`, `_updatedAt`, `_system` are omitted). That surviving
   revision is the only trace of the original on the wire, and is what the echo layer matches
   against the revision store to identify the source for core's `duplicate`. With no match it
   degrades to a plain `create` rather than guessing.
2. **Restore-from-deleted arrives as two actions** — a guarded `create` (`ifExists: 'fail'`) then
   the `replaceDraft`. The replaceDraft is a full-body replacement and subsumes the create, so the
   create is suppressed; echoing both would emit two frames for one transaction and leave the
   second unchainable.

### Limitation: document-action echo needs persistence on

The echo layer forwards patches, it never materializes an edited document — that is core's job.
So the body a publish promotes comes back from the overlay server's `/commit` response. With
`SPIKE_OVERLAY_PERSIST=1` the promoted body is the one the user typed. With persistence **off**,
the only body available is the pre-edit snapshot; the protocol emits the frame anyway (a pane that
never settles is worse than one showing stale content) and reports it loudly through
`__SPIKE_ECHO__.errors`. Pinned by *"reports loudly rather than silently publishing a stale body"*.

## Auth failure, reconnect and logout (Gate A + Gate B breadth)

`spike-a-auth-flows.test.ts`. The facade answers every intercepted write with a synthetic
`{transactionId}` success. That is correct while the write is *going somewhere*; it stops being
correct the moment the write provably cannot land. The table below is what the layer now does, and
every row is pinned:

| Situation | Studio is told |
|---|---|
| persistence off, session live | success — the in-memory echo, unchanged |
| persistence on, `/commit` accepted | success |
| persistence on, `/commit` 5xx or server down | success, loudly degraded (`persist.failed`, `errors`, `console.error`) |
| **401/403 anywhere in the session** | **failure** — the promise rejects / the observable errors |
| **any write after logout** | **failure** |

The 5xx row is deliberately *not* a failure. Persistence is a strict addition to the echo, an
outage is transient, and the layer already shouts. A 401 is not transient — retrying cannot help —
so it is the one case where a synthetic success would be a lie about content that exists nowhere.
This distinction is the whole point of the change, and it is mutation-checked in both directions.

What was added to `echoProtocol.ts` to make it testable at all: a session state
(`active | unauthenticated | logged-out`), `noteAuthFailure`, `restoreSession`, `logout` and
`acknowledgeWrite` — the veto `blockedResult` consults before handing back a success. Three
properties are load-bearing:

1. **An auth failure never touches the revision store.** An expired token says nothing about what
   the Content Lake holds; a dropped or invented revision only surfaces 30 s later as a
   `sequentializeListenerEvents` deadline, far from its cause.
2. **A refused write emits no listener frame.** `onDelivered` — which schedules the echo — simply
   never runs, so HEAD does not advance for a mutation that exists nowhere.
3. **Logout is terminal.** A late 401 cannot downgrade it to the recoverable state, and a late
   `subscribe` cannot re-open delivery.

Two findings from the sanity 6.8.0 sources, read out rather than guessed:

- **Logout is `client.request({uri: '/auth/logout', method: 'POST'})`**, issued on a
  middleware-stripped `withConfig` clone and awaited through `Promise.allSettled`
  (`node_modules/sanity/lib/WorkspaceLoader-BRx2afZV.js`, `logout()`). The facade recognises it,
  releases every pane *synchronously* (Studio does not wait for the response, so neither may the
  release), and still passes the request through — swallowing it would leave a live token behind.
- **A 401/403 reaches this layer in four different shapes** — `ClientError.statusCode`,
  `HttpError.response.statusCode`, the API error body in `details` / `response.body`, and a bare
  `fetch` Response's `status`. All four are recognised; a 500, a `TypeError: fetch failed` and the
  digits "401" inside a message are all deliberately *not*, because a false positive stops every
  remaining write in the session.

### Side effect: one of Gate E's six facade gaps is closed

The write guard was a raw regex over the caller's spelling (`/\/data\/(mutate|actions)\b/`), which
is what let Spike F escape it with a **leading-slash-less** `request({uri: 'data/mutate'})`. Adding
a second URL guard for `/auth/logout` would have reproduced the same bug, so both now go through
one normaliser (`requestPath`) covering the whole variant family: absolute URL, missing or doubled
slash, trailing slash, query, fragment, case, `.`/`..` segments and percent-encoding. 30 tests, and
the facade-level `request({uri: 'data/mutate/parity'})` escape is pinned as blocked. The other five
Gate E gaps are untouched — they are not in this layer.

## Still requires a browser or a human

Not claimed by these suites, and not closeable without Studio running:

- **Cursor position and selection stability** under typing, paste, undo/redo and array reorder
  (§21.4.1's "cursor jumps" clause) — a DOM property.
- **Portable Text keystroke loss** under a real debounce window.
- The **publish/unpublish/delete/discard/duplicate/restore buttons visibly settling** in the Studio
  UI. The protocol now supplies what `BufferedDocument.consumeUnresolved` needs; that the UI acts
  on it is the human check §0.6 requires.
- **Custom document actions** — none are defined in the kitchen-sink schema.
- **Reconnect through the real transport** (SSE drop, `welcomeback`/`reset` events). The protocol's
  reseed behaviour is proven; that Studio re-runs the pair snapshot fetch on reconnect is observed
  from its source, not from a live drop.
- **Auth failure and logout — the Studio half only.** The protocol half is now automated (above).
  What a browser still has to show:
  - that a **real expired/revoked token** produces one of the four recognised error shapes on the
    live pair stream, rather than a fifth this layer has never seen;
  - that Studio's **auth store actually issues** `POST /auth/logout` through the injected client
    when the user clicks Sign out — read out of its source, never observed live;
  - that Studio's UI **shows the rejected write as failed** (the promise rejects and the observable
    errors with a `statusCode`-carrying error, which is the shape its handlers expect — but that it
    renders as an error toast rather than a silently stuck pane is a DOM claim);
  - **token refresh** through the real auth store, i.e. that a refreshed session re-runs the pair
    snapshot fetch. `restoreSession()` models it; nothing calls it in the browser yet, so a live
    session that 401s stays write-refusing until reload. That is the safe direction, and it is the
    one gap in this area that is a *known behaviour limit* rather than merely unobserved.
