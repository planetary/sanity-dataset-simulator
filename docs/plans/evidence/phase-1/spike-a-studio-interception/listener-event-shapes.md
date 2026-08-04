# Listener event shapes — captured live (PRD §21.4.1 contract input)

**Captured:** 2026-08-04, sanity 6.8.0 / @sanity/client 7.26.0, via fetch-tap tee on `/data/listen` streams (client v7 streams SSE over `fetch`, NOT `EventSource` — Track B proxies must stream fetch bodies).

## Streams Studio opens for one document pane (6 total)

| Tag | Query | Params |
|---|---|---|
| `sanity.studio.document.pair.listen` | `*[_id in $ids]` ($ids = [published, draft]) | `includeAllVersions=true`, `visibility=transaction`, mutations included |
| `sanity.studio.preview.global` | `*` (unconstrained!) | `includeAllVersions=true`, `visibility=query`, `effectFormat=mendoza` |
| `sanity.studio.preview.observe-document-set.listen` | `*[sanity::versionOf($published)]` etc. | effects-only |
| `sanity.studio.listen-search-query` | `*[_type == $type]` | list pane |
| `sanity.studio.releases.listen` | `*[_type=="system.release" ...]` | `visibility=query` |

**Overlay implications:** the unconstrained `*` global preview listener and `sanity::versionOf` queries cannot be candidate-planned exactly (Tier C, §22.3) — overlay listen emulation must instead emit synthetic events scoped to overlay-changed documents; Studio uses these to invalidate previews, so overlay-scoped emission suffices for overlay changes.

## Event types observed

`welcome` (per stream, on open), `mutation`, `message`. Reconnect not yet captured.

## Pair-listener `mutation` event (the load-bearing shape)

```json
{
  "eventId": "<transactionId>#<documentId>@<opaque>",
  "documentId": "drafts.article-03",
  "transactionId": "a10ed5e8-fa35-4fed-8171-12ee2f304a02",
  "transition": "update",
  "identity": "pa9MITSCy",
  "mutations": [
    {"patch": {"id": "drafts.article-03", "unset": ["_empty_action_guard_pseudo_field_"], "unsetIsEmpty": false}},
    {"patch": {"id": "drafts.article-03", "unsetIsEmpty": false, "diffMatchPatch": {"title": "@@ -8,16 +8,17 @@\n  3 (\n-listener\n+SSE shape\n  cap\n"}}}
  ],
  "previousRev": "47510899-...",
  "resultRev": "a10ed5e8-...",
  "timestamp": "2026-08-04T04:45:11.793801Z",
  "visibility": "transaction",
  "effects": {"apply": ["<mendoza>"], "revert": ["<mendoza>"]},
  "transactionCurrentEvent": 1,
  "transactionTotalEvents": 1,
  "messageDispatchedAt": "...",
  "projection": null
}
```

Notes:
- The Actions API edit generates a guard patch (`unset _empty_action_guard_pseudo_field_`) + the real patch (`diffMatchPatch` for text edits).
- Streams with `visibility=query` receive the same event without `mutations` (effects-only) or with both, depending on stream flags; the pair listener (visibility=transaction) is the one Studio's save state depends on.
- `resultRev` equals `transactionId` — synthetic overlay events must maintain `previousRev` → `resultRev` chaining for pane convergence.

## `transactionCurrentEvent` / `transactionTotalEvents` are **per listener**

The count is scoped to the documents matching *that stream's* filter, not to the transaction as a
whole. `sequentializeListenerEvents` → `allPendingTransactionEventsReceived` groups by
`transactionId` and holds the group until `mutations.length === transactionTotalEvents`, so a
publish (2 documents) must be announced as `1/2, 2/2` to the pair listener and as `1/1` to a stream
matching only one of the two. A shared count parks every partially-matching pane until the 30 s
`resolveChainDeadline`.

## Document-action wire payloads (sanity 6.8.0 `serverOperationImpls`)

Read out of `node_modules/sanity/lib/datastores-*.js`, not inferred. These are the payloads the
facade intercepts, and the frames it must answer with — pinned by
`packages/sanity-overlay-testkit/test/action-echo.test.ts`.

| Operation | Intercepted call | Echoed frames (in order) |
|---|---|---|
| publish | `action({actionType:'sanity.action.document.publish', draftId, publishedId, ifPublishedRevisionId})` | `published: createOrReplace(<draft body>)`, then `draft: delete` |
| unpublish | `action({actionType:'sanity.action.document.unpublish', draftId, publishedId})` | `draft: createOrReplace(<published body>)`, then `published: delete` |
| delete | `action({actionType:'sanity.action.document.delete', includeDrafts:[…], publishedId})` | one `delete` per entry of `includeDrafts`, then `published: delete` |
| discard changes | `action({actionType:'sanity.action.document.discard', draftId})` | `draft: delete` |
| restore (history) | `action({actionType:'sanity.action.document.replaceDraft', publishedId, attributes})` | `draft: createOrReplace(attributes)` |
| restore (from deleted) | `action([{…create, ifExists:'fail'}, {…replaceDraft}])` | one frame — the `replaceDraft` subsumes the guarded create |
| duplicate | `create({...source, _id:'drafts.<new>'}, {tag:'document.duplicate'})` — **not** an Actions API call | `newDraft: createOrReplace(copy)` |

`duplicate` omits only `_createdAt`, `_updatedAt` and `_system` from the source, so the copy still
carries the **source's `_rev`** — the only identifying trace of the original on the wire.

A surviving document's `transition` is `appear` exactly when the pane does not hold it yet and
`update` otherwise; it is therefore decided at delivery time, not when the write is intercepted.
`disappear` clears the revision store entry, because `sequentializeListenerEvents` takes the next
base revision as `undefined` after a disappear.
