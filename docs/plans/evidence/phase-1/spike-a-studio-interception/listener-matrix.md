# §21.4.1 listener compatibility matrix — automated

**Date:** 2026-08-04 · **Pinned:** `sanity` 6.8.0 / `@sanity/client` 7.26.0 · **Suites:**
`packages/sanity-overlay-testkit/test/listener-matrix.test.ts` (34 tests) and
`test/action-echo.test.ts` (30 tests), both `vitest run`, no browser.

Closes the Gate B gap recorded in [gate-review.md](../gate-review.md): *"Not yet done: the §21.4.1
five-criterion automated matrix, reconnect convergence, unsubscribe, two-pane/two-tab."*

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
| 3 | Reconnect produces the current head without replaying an already committed mutation. | **AUTOMATED** | After a drop, the reconnect snapshot fetch reseeds the chain and the next frame chains off *its* revision; re-emitting the pre-drop transaction delivers nothing, and the following edit still chains. An upstream mutation event from another client reseeds the chain without a snapshot fetch. |
| 4 | Unsubscription stops updates and releases resources. | **AUTOMATED** | Delivery stops; `subscriberCount()` returns to 0; a double unsubscribe does not release another pane's subscription. |
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

## Still requires a browser or a human

Not claimed by these suites, and not closeable without Studio running:

- **Cursor position and selection stability** under typing, paste, undo/redo and array reorder
  (§21.4.1's "cursor jumps" clause) — a DOM property.
- **Portable Text keystroke loss** under a real debounce window.
- The **publish/unpublish/delete/discard/duplicate/restore buttons visibly settling** in the Studio
  UI. The protocol now supplies what `BufferedDocument.consumeUnresolved` needs; that the UI acts
  on it is the human check §0.6 requires.
- **Custom document actions** — none are defined in the kitchen-sink schema.
- **Auth failure, token refresh and logout** paths.
- **Reconnect through the real transport** (SSE drop, `welcomeback`/`reset` events). The protocol's
  reseed behaviour is proven; that Studio re-runs the pair snapshot fetch on reconnect is observed
  from its source, not from a live drop.
