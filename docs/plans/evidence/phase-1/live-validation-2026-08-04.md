# Live browser validation — 2026-08-04

**Operator:** TO (orchestrator, driving Chrome via chrome-devtools MCP)
**Stack:** Studio `localhost:3333` → proxy `localhost:3999` (`PROXY_BLOCK_WRITES=1`) → overlay server `localhost:3998` → `.sanity-overlay/`
**Flags:** `SPIKE_LOCAL_ECHO=1`, `SPIKE_OVERLAY_PERSIST=1`, `SPIKE_API_HOST=http://localhost:3999`

Two live sessions were run. The first found three defects and is recorded here because
one of them was a silent data-loss bug that the entire automated suite could not see. The
second is the passing run.

Standing rule (PRD §0.6 practice, [HANDOFF](../../HANDOFF.md) §3): **server-side logs are the
only trustworthy escape evidence.** Browser-side observation is recorded below only where it
is labelled as such, and never carries a gate claim on its own.

---

## 1. Session A — defect-finding run

### 1.1 Silent loss of every non-ASCII edit (critical)

Editing a title to `Article 1 — OVERLAY EDIT` (leading space, U+2014 EM DASH) produced:

```
overlay persist: POST /commit … (actions) did not land:
Error: Hunk declares length2 25 but its context and insertions total 23 characters
```

The write was correctly blocked and correctly echoed to Studio, so **the editor showed a
successful edit**, while the overlay remained at `revision 0, documents: []`. The edit was lost
with no user-visible error.

Root cause, verified numerically before any fix: diff-match-patch unidiff headers count
**UTF-8 bytes**; `core/src/mutations/diff-match-patch.ts` counted **JavaScript characters**.
Context 8 + insertion 15 = 23 characters, but 8 + 17 = 25 bytes — exactly the declared
`length2`. The two agree only for ASCII, which is why 2048 passing tests never saw it.

Fixing it surfaced two further defects in the same code, both independent of Unicode:

- **Astral characters count 7 bytes, not 4.** dmp walks UTF-16 code units and charges a lead
  surrogate 4 and a trailing surrogate 3, symmetrically in `patch_make` and `patch_fromText`.
  A `TextEncoder`-based implementation — the obvious "correct" one — rejects valid patches.
  Now pinned by a named guard test that fails loudly under exactly that substitution.
- **Hunk starts are rolling.** The previous `start1 + offset` double-counted and misplaced
  hunk 2 of *any* multi-hunk patch, ASCII included. This is a silent-corruption defect, not a
  rejection, and it was live in plain English content.

Fixtures were generated and round-trip-verified against `@sanity/diff-match-patch@3.2.0` as an
independent oracle, then extracted back out of the test file to catch transcription drift.
Mutation checks: byte-vs-char **32 red**, offset mapping **12 red**, rolling starts **7 red**.

### 1.2 Structure tool crash under boot load (high)

Studio reported `Socket timed out on request to …/data/doc/parity/drafts.author-2` and the
structure tool crashed. In the log the OPTIONS preflight completed twice and **the GET has no
completed row at all** — rows are written on completion, so the request hung.

At that moment six long-lived streams were open against the same host: 5 × `data/listen/parity`
(300 s+) plus 1 × `agent/<id>/bundles/mine/listen`. Chrome's HTTP/1.1 per-host connection limit
is 6. Corroborating log evidence: `/data/listen/parity` shows **72 preflights against 34
completed GETs**.

Reproduced in `test/proxy-concurrency.test.ts` with an exact boundary — unbounded pool + 6
streams completes in <500 ms (so neither the proxy nor its `maxSockets: Infinity` upstream agent
is the bottleneck); pool of 6 with 5 streams completes; **pool of 6 with 6 streams never
completes and writes no row**; closing one stream recovers immediately; an h2 control with 6
streams + 1 request over one TCP session completes.

**Not patched, deliberately.** Recorded as a Gate A risk. Bounding the listener streams was
refuted on evidence: a reconnect gap of 200 ms–2 s puts open form fields into read-only
(`WorkspaceLoader-BRx2afZV.js:10970`), and evicted listeners reconnect immediately and
re-saturate — trading a load-dependent hang for permanent flicker plus a refetch storm. Serving
h2 is the correct fix but rewrites the transport of the project's only security boundary and
would require re-implementing the WebSocket frame guard on RFC 8441 extended CONNECT.

### 1.3 Gate A's "0 direct requests to Sanity" is false (evidence review F1, confirmed)

CDP-layer network capture — not page JS, which produced three prior false all-clears — recorded
**4 × `POST https://api.sanity.io/vX/intake/feedback`** going direct, bypassing the proxy
entirely. Telemetry rather than content, but the claim as written does not hold: interception
is not total. Gate A's evidence is downgraded accordingly in [gate-review.md](gate-review.md).

---

## 2. Session B — passing run

Same stack, after the fixes. Edit applied: `Article 1` → `Article 1 — OVERLAY EDIT ✅ 日本語`,
chosen to cover em dash, an astral emoji (surrogate pair) and CJK in one string.

| Claim | Evidence | Source |
|---|---|---|
| Write blocked, never reaches staging | `__SPIKE_ECHO__.blocked` = 2 actions, `handled: true` | browser |
| Studio settles | `errors: []`, listener frames emitted with intact `previousRev → resultRev` across `appear` → `update` | browser |
| Commit succeeds | `persist: {committed: 1, failed: 0}` | browser |
| **Lands on disk, Unicode intact** | `.sanity-overlay/documents/article-01/intent.json` → `draft.overrides[0].value === "Article 1 — OVERLAY EDIT ✅ 日本語"`, `touchedPaths: [["title"]]` | **disk** |
| **Survives reload** | reopened Studio hydrated and replayed: `hydrated: true, replayed: 1`, field renders the full string | browser + disk |
| **Staging untouched** | direct query to Sanity: `article-01` still `"Article 1"`, `_rev` `V2rkHT6iCw5OR37gl8ZtfG` unchanged and equal to the `base.publishedRevision` recorded in `intent.json`; **no `drafts.article-01` exists at all** | **upstream API** |

The last row is the load-bearing one: no draft was created upstream, and the base revision the
overlay records matches what staging still holds.

**WebSocket:** one transient `502` on the first upgrade attempt, then healthy — `101` with
frames flowing and classified per-frame (`presence_announce` allowlisted, control frames noted).
The channel is not an opaque tunnel. The 502 was checked before reporting rather than after; it
did not recur.

**`POST /descriptors/claim` → 403**, as designed. It is `uploadSchema()` (Studio source,
`WorkspaceLoader-BRx2afZV.js:5911`, "Uploads the schema to Content Lake"), gated on the
`deployStudio` grant — a write. Studio ran normally without it. Recorded as a known degradation,
not a regression.

---

## 3. Spike F re-verification — evidence review F3 closed

F3 held that Spike F's "proxy re-verified live" claim was unevidenced: the report listed 7
blocked shapes, while `proxy-log.jsonl` contained 6 blocked rows and **zero DELETE/PUT/PATCH
requests of any kind**.

The checklist in [spikeB-proxy/README.md](../../../../examples/kitchen-sink/spikeB-proxy/README.md)
(Steps 3–6) was executed against a dedicated log, `proxy-log-reverify.jsonl`:

```
PASS P0 181 lines            PASS P3 × 7 shapes (blocked:true, status:403)
PASS P1 unmodified, 730      PASS P4 × 7 shapes (zero leaks)
PASS P2 163 request, 18 frame   PASS P5  PASS P6  PASS P7  PASS P8  PASS P9  PASS P10

ALL PREDICATES PASS
```

All 7 attack shapes returned 403 at the proxy; both liveness controls (`/ping`,
`/data/query/parity`) returned 200, so the run is not a trivial deny-everything. P5 (a `DELETE`
appears) and P6 (its CORS preflight appears) are the freshness controls — neither can be
satisfied by the committed log, so a stale log cannot pass. P9 confirms no credential or frame
payload was written.

**Bookkeeping note.** P1 failed on the first attempt because the two live sessions above had
appended 302 rows to the committed `proxy-log.jsonl`. The committed 730-line prefix was verified
byte-identical (append-only, no rewrite), the 302 new rows were preserved as
`proxy-log-milestone-2026-08-04.jsonl`, and the pinned baseline was restored. No evidence was
discarded.

---

## 4. What this validation does and does not establish

**Establishes:** the local editing milestone works end to end in a real Studio, including
non-ASCII content; staging is provably untouched; the proxy blocks all 7 Spike F shapes with
server-side evidence and liveness/freshness controls; the WebSocket channel is classified rather
than tunnelled.

**Does not establish:**

- **§0.6 human validation.** These runs were driven by an agent. §0.6 requires *one human
  validation of the actual Studio workflow per spike*; that remains outstanding and is a user
  action, not an engineering one.
- **Cursor/selection stability and keystroke loss under real debounce** — §21.4.1 criterion 2's
  input-device half. The protocol half is automated; this half is inherently a browser property
  and was not measured by scripted `input` events.
- **The HTTP/1.1 ceiling is unfixed.** Session B did not crash, but nothing changed to prevent
  it; the boundary is load-dependent and remains a Gate A risk.
- **Gates C and F** — untouched here; they need Vercel credentials.
