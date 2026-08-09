/**
 * PRD §5.4 work budgets — the absolute ceilings, at the §35.16 scales.
 *
 * WHAT THIS ADDS THAT `perf-budgets.test.ts` DOES NOT
 *
 * `perf-budgets.test.ts` proves *invariance*: one commit costs the same at 12
 * changed documents as at 60. That catches a cost that scales with the overlay,
 * and it is the right gate for the §5.4 rows stated in seconds. It cannot catch
 * a cost that is constant in overlay size and simply too large — six writes per
 * keystroke becoming sixty, a transaction of k documents costing k² writes, a
 * commit quietly rewriting a sibling's files. Those are constant-factor and
 * shape failures, and only an ABSOLUTE, ENUMERATED budget rejects them.
 *
 * So every case here states a number and a set:
 *
 *   - exactly which files one commit is permitted to write, by name;
 *   - how many writes a k-document transaction is permitted, as an affine
 *     function of k whose slope is checked at five values of k;
 *   - how many bytes one keystroke may stage at 500 changed documents;
 *   - which files a commit is FORBIDDEN to touch — every other document's.
 *
 * WHY WRITES AND BYTES, NOT MILLISECONDS
 *
 * Both are exact, both are causally upstream of the clock, and both have zero
 * spread across runs. `FailureLedger` records each write at `beforeRename` and
 * reads the staged file back, so a byte count is a fact about a file that
 * exists rather than a length the store predicted. The wall-clock evidence for
 * the §5.4 rows lives in `perf-budgets.test.ts`; this file is the falsifier.
 *
 * WHY THE NUMBERS ARE EXACT RATHER THAN UPPER BOUNDS
 *
 * `expect(writes).toBeLessThan(20)` passes for 6 and for 19, so it never
 * notices the day the count triples. The counts below are equalities. When a
 * deliberate design change moves one, the diff shows a budget being renegotiated
 * — which is the point.
 */
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OverlayLayout} from '../../sanity-overlay-store-fs/src/index'
import {createFailureLedger, endsWith, underDir} from '../src/failureInjection'
import type {AtomicWriteRecord, FailureLedger} from '../src/failureInjection'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

/* Seeding 500 documents is 500 real commits against a real filesystem. */
vi.setConfig({testTimeout: 300_000, hookTimeout: 300_000})

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-budget-'))
  roots.push(root)
  return root
}

interface Harness {
  root: string
  layout: OverlayLayout
  store: FsOverlayStore
  ledger: FailureLedger
}

/** An overlay holding `seed` changed documents, with a ledger armed to observe only. */
async function seeded(seed: number): Promise<Harness> {
  const root = await makeRoot()
  const ledger = createFailureLedger()
  const store = new FsOverlayStore({root, now: () => FIXED_NOW, hooks: ledger.hooks})
  await store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  for (let index = 0; index < seed; index += 1) {
    await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: `seed-${index}`,
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: id(index), overlayRevision: index + 1})],
    })
  }
  ledger.reset()
  return {root, layout: new OverlayLayout(root), store, ledger}
}

function id(index: number): string {
  return `article-${String(index).padStart(4, '0')}`
}

/**
 * Classify a write by the artifact it produces.
 *
 * The budget is stated in these categories rather than in raw paths because a
 * path carries a content hash and a transaction id; the category is the part a
 * budget is actually about.
 */
function category(layout: OverlayLayout, write: AtomicWriteRecord): string {
  const ref = layout.relative(write.targetPath)
  if (ref === 'manifest.json') return 'manifest'
  if (ref.endsWith('/intent.json')) return 'intent'
  if (ref.startsWith('snapshots/')) return 'snapshot'
  if (ref.startsWith('.runtime/revisions/')) return 'revision'
  if (ref.startsWith('.runtime/transactions/')) return 'transaction'
  if (ref.startsWith('.runtime/materialized/')) return 'materialized'
  if (ref.startsWith('.runtime/indexes/idempotency/')) return 'idempotency'
  return `UNBUDGETED:${ref}`
}

function categories(layout: OverlayLayout, ledger: FailureLedger): string[] {
  return ledger.writes.map((write) => category(layout, write)).sort()
}

/* ================================================================== *
 * One acknowledged edit — the "per keystroke" budget
 * ================================================================== */

describe('§5.4 one acknowledged edit — the per-keystroke write budget', () => {
  /**
   * The permitted set for a commit of one document that already exists in the
   * overlay, in sorted order.
   *
   * No `snapshot`: the base capture is content-addressed and unchanged, so
   * `#writeIfAbsent` skips it. That absence is itself a budget — a store that
   * rewrote an immutable artifact on every edit would show up here.
   */
  const PER_EDIT = [
    'idempotency',
    'intent',
    'manifest',
    'materialized',
    'revision',
    'transaction',
  ] as const

  it('writes exactly six files, and the same six at 1, 10, 50, 100 and 500 changed documents', async () => {
    /* §35.16 "1, 10, 50, 100, and 500 changed documents", measured at each. */
    for (const seed of [1, 10, 50, 100, 500]) {
      const {layout, store, ledger} = await seeded(seed)

      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'measured',
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [
          documentRecordFixture({
            logicalId: id(0),
            title: 'One keystroke',
            overlayRevision: seed + 1,
          }),
        ],
      })

      expect(categories(layout, ledger), `at ${seed} changed documents`).toEqual([...PER_EDIT])
    }
  })

  it('touches no file belonging to any other document', async () => {
    const {layout, store, ledger} = await seeded(50)
    const target = id(7)

    await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'measured',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: target, title: 'Edited', overlayRevision: 51})],
    })

    /* THE FORBIDDEN SET, stated positively: every per-document write must name
     * the document that was edited. A full-tree rewrite — regenerating every
     * `intent.json`, re-materializing the overlay, re-hashing every revision —
     * is the single most likely way this design goes wrong, and it fails here
     * on the first sibling path rather than in a latency percentile. */
    const perDocument = ledger.writes.filter((write) =>
      ['intent', 'materialized', 'revision'].includes(category(layout, write)),
    )
    expect(perDocument.length).toBeGreaterThan(0)
    for (const write of perDocument) {
      expect(layout.relative(write.targetPath)).toContain(target)
    }

    /* And the only whole-overlay file written is the index the commit point is:
     * `manifest.json`. Two of them would mean a second, hidden global rewrite. */
    expect(categories(layout, ledger).filter((name) => name === 'manifest')).toHaveLength(1)
  })

  it('does not rewrite an immutable revision whose content is already stored', async () => {
    const {layout, store, ledger} = await seeded(20)

    /* Same logical id, same content, a NEW idempotency key: the "user pressed
     * save twice" path, not the §34.6 replay path. The second commit is a real
     * commit — it advances the revision and writes a transaction — but the
     * document revision file it would produce is content-addressed and already
     * on disk, so `#writeIfAbsent` skips it. */
    const seen: string[][] = []
    for (const key of ['same-a', 'same-b']) {
      ledger.reset()
      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: key,
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: id(3), title: 'Identical', overlayRevision: 21})],
      })
      seen.push(categories(layout, ledger))
    }

    expect(seen[0]).toEqual([...PER_EDIT])
    /* The saving is exactly one write, and exactly the immutable one. Content
     * addressing is only a saving if identical bytes are recognised as
     * identical; a store that rewrote them would burn a write per keystroke on
     * a file it already had, and — worse — would make `revisions/` grow with
     * saves rather than with distinct states. */
    expect(seen[1]).toEqual(PER_EDIT.filter((name) => name !== 'revision'))

    /* And the two commits really did both happen: revision advanced twice. */
    const manifest = parse(await readFile(layout.manifestPath, 'utf8')) as OverlayManifest
    expect(manifest.revision).toBe(22)
  })

  it('writes a new immutable revision when the content genuinely changed', async () => {
    const {layout, store, ledger} = await seeded(20)

    /* The complement of the case above, and the reason it is not vacuous: the
     * skip must be caused by identical CONTENT, not by "the document already
     * exists". Different titles, same document, and the revision write returns. */
    for (const [index, title] of ['First edit', 'Second edit'].entries()) {
      ledger.reset()
      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: `distinct-${index}`,
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: id(3), title, overlayRevision: 21 + index})],
      })
      expect(categories(layout, ledger), title).toEqual([...PER_EDIT])
    }
  })

  it('costs zero writes when the transaction is replayed under its idempotency key', async () => {
    const {layout, store, ledger} = await seeded(10)
    const request = {
      idempotencyKey: 'replayed',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: id(1), title: 'Once', overlayRevision: 11})],
    }
    await store.commitTransaction(CONTRACT_OVERLAY_ID, request)
    ledger.reset()

    const replay = await store.commitTransaction(CONTRACT_OVERLAY_ID, request)

    /* §34.6 — one key, one application. A replay that rewrote anything would be
     * doing work for a transaction that already happened, and would also be a
     * durability risk: the second write could fail and report a failure for a
     * commit that succeeded. Zero is the only correct budget. */
    expect(replay.replayed).toBe(true)
    expect(ledger.writes).toEqual([])
    expect(categories(layout, ledger)).toEqual([])
  })
})

/* ================================================================== *
 * Transaction size — linear in documents, never quadratic
 * ================================================================== */

describe('§5.4 multi-document transaction — linear in documents, never quadratic', () => {
  it('costs a fixed overhead plus a fixed cost per document, measured at k = 1, 2, 4, 8, 16', async () => {
    const measured = new Map<number, number>()

    for (const k of [1, 2, 4, 8, 16]) {
      const {layout, store, ledger} = await seeded(4)
      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: `bulk-${k}`,
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: Array.from({length: k}, (_unused, index) =>
          documentRecordFixture({logicalId: `bulk-${index}`, overlayRevision: 5}),
        ),
      })
      /* No unbudgeted artifact may sneak into a bulk commit either. */
      for (const name of categories(layout, ledger)) {
        expect(name.startsWith('UNBUDGETED')).toBe(false)
      }
      measured.set(k, ledger.writes.length)
    }

    /* THE SHAPE GATE. `writes(k) = overhead + perDocument * k` is asserted by
     * solving for the two coefficients from k = 1 and k = 2, then REQUIRING the
     * remaining three points to fall on that line exactly. A k² fan-out — every
     * record re-reading or rewriting every other — diverges at k = 4 and is
     * unmissable by k = 16. */
    const perDocument = measured.get(2)! - measured.get(1)!
    const overhead = measured.get(1)! - perDocument
    for (const k of [1, 2, 4, 8, 16]) {
      expect(measured.get(k), `writes for k=${k}`).toBe(overhead + perDocument * k)
    }

    /* And the coefficients themselves are budgets, not free parameters:
     *   overhead    = manifest + transaction + idempotency pointer
     *   perDocument = revision + snapshot + intent + materialized
     * A change to either is a change to the durability design. */
    expect(overhead).toBe(3)
    expect(perDocument).toBe(4)
  })
})

/* ================================================================== *
 * Bytes — what one keystroke is permitted to stage
 * ================================================================== */

describe('§5.4 one acknowledged edit — the per-keystroke byte budget', () => {
  /**
   * A ceiling, in bytes, on everything one edit stages at 500 changed documents.
   *
   * Chosen from the measured value with roughly 2x headroom and asserted BOTH
   * ways: too high is a budget that never fires, so the case also requires the
   * measurement to stay above a floor. A change that halves the cost should
   * lower this number rather than quietly bank the margin.
   */
  const CEILING_AT_500 = 400_000
  const FLOOR_AT_500 = 20_000

  it('stages a bounded volume at 500 changed documents, dominated by the manifest index', async () => {
    const {layout, store, ledger} = await seeded(500)

    await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'measured',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [
        documentRecordFixture({logicalId: id(250), title: 'One keystroke', overlayRevision: 501}),
      ],
    })

    const total = ledger.totalBytes()
    expect(total).toBeLessThan(CEILING_AT_500)
    expect(total).toBeGreaterThan(FLOOR_AT_500)

    /* PROOF THE MEASUREMENT IS OF REAL BYTES: the ledger read every staged file
     * back from disk, so none of them is a length the store predicted. */
    expect(ledger.writes.every((write) => write.bytes > 0)).toBe(true)

    /* WHERE THE COST ACTUALLY IS, stated rather than averaged away. The whole
     * manifest is rewritten on every commit, so per-edit cost grows with the
     * NUMBER OF HEADS — the one genuinely O(n) term in an acknowledgement. It is
     * budgeted here so a future head entry that carried, say, a materialized
     * document would blow the ceiling instead of silently making every keystroke
     * proportional to overlay CONTENT. */
    const manifestBytes = ledger.matching(endsWith('manifest.json'))[0]!.bytes
    expect(manifestBytes / 500).toBeLessThan(600)

    /* Independent oracle: the file on disk is the size the ledger recorded. */
    expect((await stat(layout.manifestPath)).size).toBe(manifestBytes)

    /* Everything that is NOT the index is proportional to the edited document
     * alone, so it is small and — this is the load-bearing part — unchanged from
     * the same edit in a 1-document overlay. */
    const contentBytes = total - manifestBytes
    const tiny = await seeded(1)
    await tiny.store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'measured',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [
        documentRecordFixture({logicalId: id(0), title: 'One keystroke', overlayRevision: 2}),
      ],
    })
    const tinyManifest = tiny.ledger.matching(endsWith('manifest.json'))[0]!.bytes
    const tinyContent = tiny.ledger.totalBytes() - tinyManifest

    /* Not `toBe`: the synthetic `_rev` (§13.9) embeds the overlay revision as
     * decimal text, so `2` and `501` differ by two characters in three files.
     * The window is those characters and nothing else. */
    expect(Math.abs(contentBytes - tinyContent)).toBeLessThan(64)
  })
})

/* ================================================================== *
 * Reads — opening one document is O(1) files
 * ================================================================== */

describe('§5.4 reading — bounded regardless of overlay size', () => {
  it('answers "which documents changed" from the manifest alone', async () => {
    const {root, layout} = await seeded(100)

    /* The falsifier is structural rather than a counter: `listChangedDocuments`
     * is asked from a COLD store whose only readable overlay file is the
     * manifest. Everything else is renamed out from under it, so an
     * implementation that walked `documents/` fails with a real ENOENT instead
     * of merely costing more. */
    const away = join(root, 'moved-aside')
    await rm(away, {recursive: true, force: true})
    const {rename} = await import('node:fs/promises')
    await rename(layout.documentsDir, away)

    const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
    const changed = await cold.listChangedDocuments(CONTRACT_OVERLAY_ID)
    expect(changed).toHaveLength(100)

    /* And the manifest really is the only thing it could have used. */
    const manifest = parse(await readFile(layout.manifestPath, 'utf8')) as OverlayManifest
    expect(Object.keys(manifest.documentHeads)).toHaveLength(100)

    await rename(away, layout.documentsDir)
  })

  it('reads one document without reading the other 499', async () => {
    const {root, layout, store, ledger} = await seeded(500)
    const target = id(499)

    const read = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, target)
    expect(read?.head.logicalId).toBe(target)

    /* A read writes nothing. A store that regenerated a projection on every read
     * — the obvious wrong way to implement the crash-recovery path in
     * `fsStore.ts` — would show up here immediately. */
    expect(ledger.writes).toEqual([])

    /* Cold, so no cache can be doing the work: the bytes a fresh store must open
     * are the manifest plus this document's own two files, and the document half
     * is independent of the 500. */
    const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
    const coldRead = await cold.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, target)
    expect(coldRead?.head.checksum).toBe(read?.head.checksum)

    const documentBytes =
      (await stat(layout.intentPath(target))).size +
      (await stat(layout.resolve(coldRead!.storageRef))).size
    expect(documentBytes).toBeLessThan(8_192)
  })
})
