/**
 * SANITY'S HISTORY WIRE FORMATS, for the branch documents base has never heard
 * of (PRD §5.5, §32.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS FOR, observed live 2026-08-09 in a running Studio,
 * three-plus times per branch document:
 *
 *     Error fetching events TypeError: Cannot read properties of undefined
 *       (reading 'drafts.e2e-unicode-multihunk')   at getEditEvents
 *
 * `sanity@6.8.0` reads a document's transaction log as **NDJSON** — one JSON
 * object per line, over the GLOBAL `fetch`:
 *
 *   lib/useBundleDocuments-BYW8M9LS.js:4812  getTransactionsLogs
 *       getJsonStream(client.getUrl(`/data/history/<ds>/transactions/<ids>?…`),
 *                     client.config().token)
 *   lib/datastores-DqFH7RLd.js:6879          getStream
 *       splits the body on "\n", JSON.parses every non-empty line, and at EOF
 *       parses whatever is left in the buffer as one more line.
 *   lib/useBundleDocuments-BYW8M9LS.js:4965  getEditEvents
 *       transactions.filter((tx) => getEffectState(tx.effects[documentId]) …)
 *
 * So `{"transactions":[]}` — a JSON envelope answered on an NDJSON endpoint —
 * does NOT mean "no transactions". It decodes to exactly ONE transaction: the
 * envelope. It has no `effects`, and `tx.effects[documentId]` throws with the
 * document id in the message. That is the reported error, in full.
 *
 * TWO INVARIANTS FALL OUT, and they are not the same one:
 *
 *   1. an EMPTY translog is an EMPTY BODY — {@link EMPTY_TRANSLOG_NDJSON} —
 *      never `{"transactions":[]}` and never `[]`;
 *   2. every NON-EMPTY line must carry an `effects` object keyed by document
 *      id. `excludeContent=true` strips CONTENT, never effects;
 *      `effectFormat=mendoza` is what puts them on the wire. A server that
 *      honours the first and drops the second re-arms the identical TypeError.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE CAN AND CANNOT REACH.
 *
 * The translog is fetched with the global `fetch`, so no wrapper around a
 * client method sees it — `facade.ts` has recorded that since it was written,
 * and it is still true. {@link EMPTY_TRANSLOG_NDJSON} is therefore stated here
 * as the contract for whatever serves `apiHost`, not as something this package
 * can enforce.
 *
 * The other two history reads DO travel on `client.request` /
 * `client.observable.request`, and those this module classifies so the facade
 * can answer them:
 *
 *   /data/history/<ds>/events/documents/<ids>   useBundleDocuments…:5006
 *       read as `response.events[documentId]?.map(…) || []` — so `events` is an
 *       OBJECT KEYED BY DOCUMENT ID, not an array. An array is tolerated (the
 *       `?.` swallows it) and is still the wrong shape; `nextCursor` must be a
 *       string or `loadMore` carries `undefined` as a cursor.
 *   /data/history/<ds>/documents/<ids>          useBundleDocuments…:5101
 *       read as `response.documents[0]`, with NO optional chaining. An envelope
 *       without `documents` throws exactly like the translog does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT CLASSIFIED HERE.
 *
 * `/data/doc/<ds>/<ids>?excludeContent=true` is in the same family — Studio
 * indexes its answer by document id too (`datastores-DqFH7RLd.js:5533`
 * `availability.omitted.reduce(…)`, `structureTool-EN0gOzyJ.js:744`
 * `({omitted}) => omitted.filter(…)`, both of which throw on a missing
 * `omitted`) — but it is an EXISTENCE question, not a history one, and the
 * overlay origin already answers it from branch state. Claiming it here would
 * override a correct answer with a guess. It stays delegated, and
 * `test/studio-history-endpoints.test.ts` pins that boundary.
 */

type Rec = Record<string, unknown>

/**
 * The body an empty upstream transaction log must be answered with: nothing.
 *
 * NDJSON's empty document is zero lines. See the header — this is the exact
 * value whose absence produced the reported crash, and it is a constant rather
 * than a comment so the contract can be asserted.
 */
export const EMPTY_TRANSLOG_NDJSON = ''

/** One `/data/history` read that arrived through a client method. */
export type OverlayHistoryRead =
  | {readonly kind: 'events'; readonly ids: readonly string[]}
  | {readonly kind: 'documents'; readonly ids: readonly string[]}

/**
 * `…/data/history/<ds>/{events/documents|documents}/<ids>`, relative or
 * absolute, with the id list terminal.
 *
 * `transactions` is NOT in the alternation and must not be added: that endpoint
 * is a stream this facade never sees, and a `client.request` answer for it
 * would be JSON where a caller expects NDJSON.
 */
const HISTORY_PATH =
  /(?:^|\/)data\/history\/[^/?#]+\/(events\/documents|documents)\/([^/?#]*)(?=$|[?#])/

/** `ids.join(',')`, undone. */
function splitIds(raw: string): string[] {
  const out: string[] = []
  for (const segment of raw.split(',')) {
    if (segment === '') continue
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      /* A malformed escape is not a reason to refuse to classify — the raw
       * segment is still the id the caller asked about. */
    }
    out.push(decoded)
  }
  return out
}

/** Which history read this URL is, or `undefined` when it is not one. */
export function classifyOverlayHistoryRead(url: unknown): OverlayHistoryRead | undefined {
  if (typeof url !== 'string') return undefined
  const match = HISTORY_PATH.exec(url)
  if (match === null) return undefined
  const ids = splitIds(match[2])
  if (ids.length === 0) return undefined
  return match[1] === 'documents' ? {kind: 'documents', ids} : {kind: 'events', ids}
}

/**
 * "This document has no upstream history" — said in the shape Studio reads.
 *
 * A FRESH object every call: these travel into Studio state, and a shared one
 * would let one pane's mutation of it reach another's.
 */
export function emptyOverlayHistoryAnswer(read: OverlayHistoryRead): Rec {
  if (read.kind === 'documents') return {documents: []}
  const events: Rec = {}
  for (const id of read.ids) events[id] = []
  return {events, nextCursor: ''}
}
