/**
 * `/data/doc/<ds>/<ids>` — THE EXISTENCE QUESTION, ANSWERED ABOUT THE BRANCH.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT ASKS IT. Five call sites in `sanity@6.8.0`, every one of them a raw
 * `client.request({uri: client.getDataUrl('doc', ids)})` rather than GROQ, so
 * none of them can be reached by the §22.6 read path:
 *
 *   datastores-DqFH7RLd.js:244   `fetchDocumentReadabilityChunked` — the
 *       FALLBACK inside `observeDocumentAvailability` (`:267`), taken whenever
 *       the preview store has no `_rev` for an id. `keyBy(response.omitted || [])`.
 *   datastores-DqFH7RLd.js:5533  `createBatchedGetDocumentExists` — reads
 *       `availability.omitted.reduce(…)` with NO guard.
 *   structureTool-EN0gOzyJ.js:739 `getDocumentExistence` — the delete-confirm
 *       and referring-documents probe. `({omitted}) => omitted.filter(…)`, also
 *       unguarded.
 *   useBundleDocuments-BYW8M9LS.js:33275  `cross-dataset-refs.availability` —
 *       the one that is NOT answered from the branch. It travels on a
 *       `withConfig({projectId, dataset})` clone and names ANOTHER dataset; see
 *       {@link OverlayDocRead.dataset}.
 *   useBundleDocuments-BYW8M9LS.js:34102  `gdr.availability`
 *
 * `@sanity/client@7.26.0` asks it too, from `documentsExists`
 * (`dist/index.browser.js:991`), reading the same `omitted` array.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT MATTERS, AND WHICH HALF OF IT ACTUALLY BITES.
 *
 * A document the branch CREATED mostly does not reach here: the preview store's
 * field fetch is GROQ, the §22.6 planner handles that shape, so `hasRev` is true
 * and `observeDocumentAvailability` returns READABLE without a probe.
 *
 * A document the branch DELETED reaches here every time. The GROQ path applies
 * the tombstone and answers `null`, `hasRev` is false, and the probe runs — and
 * staging still holds the document, so it answers "readable". A strong
 * reference to a document the branch removed therefore VALIDATES, and the
 * delete-confirm dialog reports referring documents that the branch no longer
 * has. Both are answers about staging handed to a caller asking about the
 * branch, which is exactly what §5.5 forbids.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A SECOND COPY OF THE READ PATH.
 *
 * `facade.ts` used to record that answering here "means teaching this facade
 * the `/data/doc` wire format — a second, weaker copy of the overlay read
 * path". Two things make that no longer true:
 *
 *   1. NO QUERY IS EVALUATED. The read path plans and evaluates GROQ. This is a
 *      lookup in the SAME {@link OverlayBranchLookup} the read path consumes,
 *      keyed by the SAME document address. One view, two spellings of "what
 *      does the branch hold".
 *   2. STAGING STILL ANSWERS. {@link overlayDocAnswer} does not replace base's
 *      response; it edits it. The envelope, `ms`, and every id the branch has no
 *      opinion about survive verbatim. The only thing this module owns is the
 *      rule "where the branch has an opinion, the branch wins" — which is
 *      `resolveVirtualDocument` (§22.6 step 13), not a second implementation of
 *      it.
 *
 * The wire format it must know is three facts, all of them already pinned by
 * `test/origin-data.test.ts` and agreed on by all six readers above:
 * `documents` is an array of bodies, `omitted` is an array of `{id, reason}`,
 * and the reason for "not there" is `existence`.
 */

type Rec = Record<string, unknown>

/**
 * The branch, as this module needs to see it: which document ADDRESS
 * (`drafts.x` or `x`) it holds a body for, and which address it has SUPPRESSED.
 *
 * Structurally satisfied by `sanity-overlay-query`'s `OverlaySource`, which is
 * what the runtime passes — but declared here rather than imported so that
 * nothing about the existence probe can drift into depending on the query
 * package. It is a view, not a query engine.
 */
/* NOT `OverlayBranchView`: `runtime.ts` already exports that name for the
 * DIAGNOSTIC view the status panel renders — sorted address arrays plus a
 * revision. This is a lookup, and the two must not be mistaken for each other. */
export interface OverlayBranchLookup {
  readonly documents: ReadonlyMap<string, Rec>
  readonly tombstones: ReadonlySet<string>
}

/** One `/data/doc` read that arrived through a client method. */
export interface OverlayDocRead {
  /**
   * The dataset the URL names.
   *
   * NOT decoration. `useBundleDocuments:33273` `fetchDocumentAvailability` is
   * the CROSS-DATASET availability probe: the client it travels on is a
   * `withConfig({projectId, dataset})` clone pointed at somebody else's
   * dataset, and it is still this facade's proxy because a clone of a wrapped
   * client is a wrapped client. Answering it from this branch would let a
   * document id that happens to collide decide the existence of a document in
   * a dataset the branch has never seen. The caller compares this against the
   * dataset the facade was built for and delegates on any mismatch.
   */
  readonly dataset: string
  readonly ids: readonly string[]
  /**
   * Did the EFFECTIVE query string ask for `excludeContent=true`?
   *
   * `@sanity/client` builds the query string from `options.query` and whatever
   * is already in the `uri` — and from nothing else (`_requestObservable`,
   * `dist/index.browser.js:1149-1176`). `useBundleDocuments:34104` puts
   * `excludeContent` at the TOP LEVEL of the options bag, where it is silently
   * ignored, so that call site is a CONTENT read despite reading like an
   * existence one. Getting this wrong in that direction would drop a document
   * body a caller asked for, so anything not unambiguously `true` is read as
   * "content wanted".
   */
  readonly excludeContent: boolean
}

/** What the branch has to say about one document address. */
export type OverlayDocOpinion =
  /** The branch holds a body at this address. It exists, with this content. */
  | {readonly kind: 'held'; readonly document: Rec}
  /** The branch has SUPPRESSED this address. It does not exist. */
  | {readonly kind: 'absent'}
  /** The branch has no opinion. Only base can answer. */
  | undefined

/**
 * `…/data/doc/<ds>/<ids>`, relative or absolute, with the id list terminal.
 *
 * The dataset segment is `[^/?#]+` and the ids are everything up to the query
 * string, which is how `getDataUrl('doc', ids.join(','))` spells it.
 */
const DOC_PATH = /(?:^|\/)data\/doc\/([^/?#]+)\/([^/?#]*)(?=$|[?#])/

/** `ids.join(',')`, undone — the same decoding `history.ts` does. */
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

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Is this value the string or boolean `true`?
 *
 * `@sanity/client`'s own `documentsExists` sends `excludeContent: !0` and
 * Studio sends `'true'`; a caller who sends `'false'` means false. Everything
 * else is read as "not excluded", which is the safe direction: it can only ADD
 * a branch body to an answer whose reader ignores `documents` anyway.
 */
function isTrueish(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
}

/**
 * Which `/data/doc` read this request is, or `undefined` when it is not one.
 *
 * Takes the WHOLE request object rather than the URL, because `excludeContent`
 * travels in `request.query` as often as in the URL.
 */
export function classifyOverlayDocRead(request: unknown): OverlayDocRead | undefined {
  if (!isRec(request)) return undefined
  const target = request.url ?? request.uri
  if (typeof target !== 'string') return undefined
  const match = DOC_PATH.exec(target)
  if (match === null) return undefined
  const ids = splitIds(match[2] as string)
  if (ids.length === 0) return undefined
  let dataset = match[1] as string
  try {
    dataset = decodeURIComponent(dataset)
  } catch {
    /* Same reasoning as `splitIds`: a malformed escape does not stop this being
     * the dataset segment the caller wrote. */
  }

  let excludeContent = isRec(request.query) && isTrueish(request.query.excludeContent)
  if (!excludeContent) {
    const questionMark = target.indexOf('?')
    if (questionMark !== -1) {
      const search = new URLSearchParams(target.slice(questionMark + 1))
      excludeContent = isTrueish(search.get('excludeContent'))
    }
  }
  return {dataset, ids, excludeContent}
}

/**
 * What the branch says about one document ADDRESS.
 *
 * A tombstone wins over a body, which is the same precedence
 * `resolveVirtualDocument` applies (§22.6 step 13) — and it has to be, or a
 * document that was edited and then deleted would read as present.
 */
export function overlayDocOpinion(
  view: OverlayBranchLookup,
  address: string,
): OverlayDocOpinion {
  if (view.tombstones.has(address)) return {kind: 'absent'}
  const document = view.documents.get(address)
  return document === undefined ? undefined : {kind: 'held', document}
}

export interface OverlayDocAnswerInput {
  readonly read: OverlayDocRead
  /**
   * Base's own answer, verbatim, or `undefined` when base was never asked —
   * which is allowed only when the branch has an opinion about EVERY id.
   */
  readonly base: unknown
  /** Positional, aligned with {@link OverlayDocRead.ids}. */
  readonly opinions: readonly OverlayDocOpinion[]
}

/**
 * Base's answer with the branch's opinions applied.
 *
 * EDITS RATHER THAN REPLACES: every key of the base envelope survives, and so
 * does every `documents` body and every `omitted` entry the branch said nothing
 * about. The three rules are:
 *
 *   held    the id is removed from `omitted` (it exists), and — unless the
 *           caller excluded content — its branch body replaces or joins
 *           `documents`.
 *   absent  the id gains `{id, reason: 'existence'}` in `omitted` and loses any
 *           body in `documents`.
 *   none    untouched, in both arrays.
 *
 * A FRESH object every call, arrays included: these travel into Studio state
 * and a shared one would let one pane's mutation of it reach another's.
 */
export function overlayDocAnswer(input: OverlayDocAnswerInput): Rec {
  const base = isRec(input.base) ? input.base : {}
  const baseDocuments = Array.isArray(base.documents) ? (base.documents as unknown[]) : []
  const baseOmitted = Array.isArray(base.omitted) ? (base.omitted as unknown[]) : []

  const held = new Map<string, Rec>()
  const absent = new Set<string>()
  input.read.ids.forEach((id, index) => {
    const opinion = input.opinions[index]
    if (opinion === undefined) return
    if (opinion.kind === 'absent') absent.add(id)
    else held.set(id, opinion.document)
  })

  const idOf = (entry: unknown): string | undefined => {
    if (!isRec(entry)) return undefined
    return typeof entry._id === 'string' ? entry._id : undefined
  }

  /* `documents`: drop what the branch suppressed, replace what it holds. */
  const documents: unknown[] = []
  const replaced = new Set<string>()
  for (const entry of baseDocuments) {
    const id = idOf(entry)
    if (id !== undefined && absent.has(id)) continue
    if (id !== undefined && held.has(id)) {
      if (!input.read.excludeContent) {
        documents.push({...(held.get(id) as Rec)})
        replaced.add(id)
      }
      continue
    }
    documents.push(entry)
  }
  if (!input.read.excludeContent) {
    /* In requested order, so a caller reading positionally sees the same shape
     * whether a body came from base or from the branch. */
    for (const id of input.read.ids) {
      if (!held.has(id) || replaced.has(id)) continue
      documents.push({...(held.get(id) as Rec)})
      replaced.add(id)
    }
  }

  /* `omitted`: drop what the branch holds, add what it suppressed. */
  const omitted: unknown[] = []
  const stated = new Set<string>()
  for (const entry of baseOmitted) {
    const id = isRec(entry) && typeof entry.id === 'string' ? entry.id : undefined
    if (id !== undefined && held.has(id)) continue
    if (id !== undefined && absent.has(id)) {
      /* AGREEMENT IS LEFT ALONE. When base already says `existence` its entry
       * passes through untouched, carrying whatever else it holds — the Mode-2
       * origin adds an `overlayAbsence` diagnostic to exactly this entry
       * (`origin.mjs:1163`), and rewriting a verdict we agree with would throw
       * it away for nothing.
       *
       * A DIFFERENT reason is overruled. `permission` means "it is there and you
       * may not read it", and the branch's answer is that it is not there at
       * all — so the branch's `existence` wins. */
      if (isRec(entry) && entry.reason === 'existence') omitted.push(entry)
      else omitted.push({id, reason: 'existence'})
      stated.add(id)
      continue
    }
    omitted.push(entry)
  }
  for (const id of input.read.ids) {
    if (!absent.has(id) || stated.has(id)) continue
    omitted.push({id, reason: 'existence'})
    stated.add(id)
  }

  return {...base, documents, omitted}
}
