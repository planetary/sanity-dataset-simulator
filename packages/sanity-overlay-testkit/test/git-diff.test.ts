/**
 * PRD §38.1 "Git diff is deterministic" — asserted with the real `git`.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Two acceptance lines rest on Git and neither was ever checked against Git:
 *
 *   §38.1  "Git diff is deterministic."
 *   §35.9  "Git diff contains semantic intent changes, not regenerated full
 *           materialized documents."
 *
 * `store-fs.test.ts` covers the second by walking the directory itself and
 * skipping names beginning `.runtime`. That is a *restatement of the intended
 * rule*, not a test of it: it would still pass if the `.gitignore` the store
 * writes were empty, misspelt, or never written at all — and for a while a
 * blanket `.gitignore` of `.sanity-overlay/` in this repository meant none of
 * the canonical tree was tracked by Git at all, which no test noticed. The
 * oracle has to be `git` itself: `git ls-files` for what is tracked,
 * `git check-ignore` for what is excluded, `git diff` for what a reviewer sees.
 *
 * The first line — determinism — was covered by comparing two stores that were
 * both handed the SAME frozen clock. That proves key ordering is stable and
 * proves nothing about the clock, which is the only nondeterministic input the
 * store has. §29.7 has a preview read committed `.sanity-overlay/` files out of
 * a deployment bundle, so what lands in a commit is a product surface, and
 * "is a second checkpoint of unchanged work an empty diff?" is a real question
 * about it. The last describe block below answers it with a moving wall clock
 * and names exactly which keys move.
 *
 * `git` is a hard requirement, not a skip. `repo-hygiene.test.ts` already shells
 * out to `git ls-files`; a suite that silently skips its only Git evidence when
 * Git is missing is how the gap above survived in the first place.
 */
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OverlayLayout} from '../../sanity-overlay-store-fs/src/index'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

/* Real filesystem I/O plus a `git` process per assertion. */
const TEST_TIMEOUT = 20_000

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const LATER_NOW = '2026-06-01T12:34:56.000Z'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})))
})

interface Repo {
  dir: string
  layout: OverlayLayout
  store: FsOverlayStore
  git(...args: string[]): string
  setNow(value: string): void
  /** `git add -A && git commit` — returns the commit subject. */
  commit(message: string): string
}

/**
 * A standalone Git repository with an overlay in it.
 *
 * Deliberately NOT a subdirectory of this repository: a parent `.gitignore` (or
 * a global one) would otherwise decide what is tracked, and the property under
 * test is what the STORE's own `.gitignore` achieves.
 */
async function scratchRepo(options: {now?: string} = {}): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), 'sanity-overlay-git-'))
  roots.push(dir)

  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      /* No user config, no global ignore file, no commit hooks, no signing:
       * whatever the machine running this has configured must not change the
       * answer. `core.excludesFile=` empties the global ignore explicitly. */
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Overlay Test',
        GIT_AUTHOR_EMAIL: 'overlay@example.invalid',
        GIT_COMMITTER_NAME: 'Overlay Test',
        GIT_COMMITTER_EMAIL: 'overlay@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    })

  git('init', '--quiet', '--initial-branch=main')
  git('config', 'core.excludesFile', '')

  let current = options.now ?? FIXED_NOW
  const store = new FsOverlayStore({root: dir, now: () => current})
  await store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })

  return {
    dir,
    layout: new OverlayLayout(dir),
    store,
    git,
    setNow: (value: string) => {
      current = value
    },
    commit(message: string): string {
      git('add', '-A')
      git('commit', '--quiet', '--no-verify', '-m', message)
      return git('log', '-1', '--pretty=%s').trim()
    },
  }
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '')
}

/** `git diff` hunk body lines, split by direction. */
function diffLines(patch: string): {added: string[]; removed: string[]} {
  const added: string[] = []
  const removed: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push(line.slice(1).trim())
    else if (line.startsWith('-')) removed.push(line.slice(1).trim())
  }
  return {added, removed}
}

/** The JSON keys a diff hunk touched, e.g. `"revision": 2,` → `revision`. */
function touchedKeys(patch: string): string[] {
  const {added, removed} = diffLines(patch)
  const keys = new Set<string>()
  for (const line of [...added, ...removed]) {
    const match = /^"([^"]+)":/.exec(line)
    if (match !== null) keys.add(match[1]!)
  }
  return [...keys].sort()
}

/* ------------------------------------------------------------------ *
 * What Git actually tracks
 * ------------------------------------------------------------------ */

describe('§14.1 the committed tree, according to git itself', () => {
  it(
    'tracks the canonical review surface and nothing generated',
    async () => {
      const repo = await scratchRepo()
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'First'}),
      )
      repo.commit('checkpoint')

      const tracked = lines(repo.git('ls-files')).sort()

      /* §14.1: manifest, one intent per touched document, content-addressed
       * snapshots, README and .gitattributes. Plus the .gitignore that keeps
       * everything else out. */
      expect(tracked).toContain('.sanity-overlay/manifest.json')
      expect(tracked).toContain('.sanity-overlay/documents/article-1/intent.json')
      expect(tracked).toContain('.sanity-overlay/README.md')
      expect(tracked).toContain('.sanity-overlay/.gitattributes')
      expect(tracked).toContain('.sanity-overlay/.gitignore')
      expect(tracked.filter((path) => path.startsWith('.sanity-overlay/snapshots/'))).toHaveLength(1)

      /* Nothing generated. This is the assertion the directory-walking version
       * could not make: it is `git` applying the store's own ignore rules. */
      expect(tracked.filter((path) => path.includes('/.runtime/'))).toEqual([])
      expect(tracked.filter((path) => path.includes('/.locks/'))).toEqual([])
      expect(tracked.filter((path) => path.includes('/.history/'))).toEqual([])
      expect(tracked.filter((path) => path.includes('/.tmp-'))).toEqual([])
    },
    TEST_TIMEOUT,
  )

  it(
    'leaves a clean working tree after a checkpoint — nothing generated leaks in',
    async () => {
      const repo = await scratchRepo()
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'First'}),
      )
      repo.commit('checkpoint')

      /* `--porcelain` lists modified AND untracked-but-not-ignored paths. An
       * empty answer means the materialized document, the transaction log and
       * the lock directory are all genuinely excluded — not merely absent from
       * a hand-written skip list. */
      expect(repo.git('status', '--porcelain')).toBe('')
    },
    TEST_TIMEOUT,
  )

  it(
    "excludes the generated materialization by the store's own .gitignore",
    async () => {
      const repo = await scratchRepo()
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'First'}),
      )

      const materialized = repo.layout.relative(repo.layout.materializedPath('article-1'))
      /* `-v` prints the rule that matched: source:line:pattern<TAB>path. The
       * rule must come from the overlay's own ignore file, so this cannot pass
       * because of some unrelated ignore this machine happens to carry. */
      const verdict = repo.git(
        'check-ignore',
        '-v',
        join('.sanity-overlay', materialized),
      ).trim()

      expect(verdict).toContain('.sanity-overlay/.gitignore')
      expect(verdict).toContain('.runtime/')
    },
    TEST_TIMEOUT,
  )
})

/* ------------------------------------------------------------------ *
 * §35.9 — what a reviewer sees when the branch changes
 * ------------------------------------------------------------------ */

describe('§35.9 the diff is semantic intent, not a regenerated document', () => {
  it(
    'moves only the manifest and the touched intent',
    async () => {
      const repo = await scratchRepo()
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'First'}),
      )
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-2', title: 'Sibling'}),
      )
      repo.commit('checkpoint')

      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Second'}),
      )

      expect(lines(repo.git('diff', '--name-only')).sort()).toEqual([
        '.sanity-overlay/documents/article-1/intent.json',
        '.sanity-overlay/manifest.json',
      ])
      /* The untouched sibling and the immutable snapshots do not move, and
       * nothing new is left untracked. */
      expect(repo.git('status', '--porcelain', '--untracked-files=all')).not.toContain('??')
    },
    TEST_TIMEOUT,
  )

  it(
    'shows the edited field, not a re-serialized document',
    async () => {
      const repo = await scratchRepo()
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'First'}),
      )
      repo.commit('checkpoint')

      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Second'}),
      )

      const intentPath = '.sanity-overlay/documents/article-1/intent.json'
      const patch = repo.git('diff', '--unified=0', '--', intentPath)
      const {added, removed} = diffLines(patch)

      /* The semantic change is present, both directions. */
      expect(added.join('\n')).toContain('"Second"')
      expect(removed.join('\n')).toContain('"First"')

      /* Only the override value and the intent's own checksum move. `checksum`
       * is derived from the rest of the file, so it is not noise: it is how a
       * reviewer sees that the semantic content changed. */
      expect(touchedKeys(patch)).toEqual(['checksum', 'value'])

      /* A REGENERATED DOCUMENT WOULD LOOK LIKE THIS — and must not.
       * `_rev` / `_createdAt` / `_updatedAt` are the materialized document's
       * synthetic system fields (§13.9); `body` is untouched content that a
       * full re-serialization would drag into every diff. */
      for (const forbidden of ['"_rev"', '"_createdAt"', '"_updatedAt"', '"body"', '"_key"']) {
        expect(patch).not.toContain(forbidden)
      }

      /* Bounded, not merely "smaller": a one-field edit is a handful of lines. */
      expect(added.length).toBeLessThanOrEqual(4)
      expect(removed.length).toBeLessThanOrEqual(4)
    },
    TEST_TIMEOUT,
  )

  it(
    'renders every intent as review-facing intent, never as a materialized document',
    async () => {
      const repo = await scratchRepo()
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'First'}),
      )
      repo.commit('checkpoint')

      /* `git show` of the committed blob — the exact bytes a reviewer opens. */
      const committed = repo.git(
        'show',
        'HEAD:.sanity-overlay/documents/article-1/intent.json',
      )
      const intent = parse(committed) as Record<string, unknown>

      expect(Object.keys(intent).sort()).toEqual([
        'base',
        'checksum',
        'conflicts',
        'draft',
        'formatVersion',
        'logicalId',
        'touchedPaths',
        'tombstones',
        'type',
      ].sort())
      /* §14.2: the review surface is `overrides`/`unsets`/`arrayOperations`,
       * and a full `replacement` only when explicitly chosen. */
      expect((intent.draft as Record<string, unknown>).mode).toBe('patch')
      expect((intent.draft as Record<string, unknown>).replacement).toBeUndefined()
      /* And it carries no clock of its own — see the determinism block below. */
      expect(committed).not.toContain('"updatedAt"')
      expect(committed).not.toContain('"createdAt"')
    },
    TEST_TIMEOUT,
  )
})

/* ------------------------------------------------------------------ *
 * §38.1 — determinism, with git as the comparator
 * ------------------------------------------------------------------ */

describe('§38.1 the diff is deterministic', () => {
  it(
    'two independent repositories produce a byte-identical patch',
    async () => {
      async function run(): Promise<string> {
        const repo = await scratchRepo()
        await repo.store.putDocumentRevision(
          CONTRACT_OVERLAY_ID,
          documentRecordFixture({logicalId: 'article-1', title: 'First'}),
        )
        repo.commit('checkpoint')
        await repo.store.putDocumentRevision(
          CONTRACT_OVERLAY_ID,
          documentRecordFixture({logicalId: 'article-1', title: 'Second'}),
        )
        return repo.git('diff')
      }

      const first = await run()
      const second = await run()

      /* `git diff` prints blob object ids in its `index` line, and a Git blob
       * id is SHA-1 over the content. Byte-identical patches therefore assert
       * identical content AND identical formatting AND identical paths — three
       * properties, one comparison, none of them computed by our own code. */
      expect(second).toBe(first)
      expect(first).not.toBe('')
    },
    TEST_TIMEOUT,
  )

  it(
    'the committed tree hashes to the same Git tree object',
    async () => {
      async function treeHash(): Promise<string> {
        const repo = await scratchRepo()
        await repo.store.putDocumentRevision(
          CONTRACT_OVERLAY_ID,
          documentRecordFixture({logicalId: 'article-2', title: 'Beta'}),
        )
        await repo.store.putDocumentRevision(
          CONTRACT_OVERLAY_ID,
          documentRecordFixture({logicalId: 'article-1', title: 'Alpha'}),
        )
        repo.commit('checkpoint')
        return repo.git('rev-parse', 'HEAD^{tree}').trim()
      }

      /* Independent oracle: Git's own content-addressed tree id over the whole
       * committed directory, including file names, modes and ordering. */
      expect(await treeHash()).toBe(await treeHash())
    },
    TEST_TIMEOUT,
  )
})

/* ------------------------------------------------------------------ *
 * The honest question: what does a REAL clock do to consecutive diffs?
 * ------------------------------------------------------------------ */

describe('a real clock — where wall-clock noise lands, and where it does not', () => {
  /**
   * The same logical state, written later.
   *
   * Every clock the store and the record carry moves — the store's own `now`,
   * the record's `createdAt`/`updatedAt`, the local version's timestamps, the
   * materialized document's `_updatedAt`, and the derived `runtimeRevision` —
   * **except the base capture**. §16.3 captures the base once, at first touch,
   * and `base.firstTouchedAt` does not move on later edits. Holding it fixed is
   * what makes this a test of the WRITE clock rather than of a re-capture; the
   * re-capture case has its own test below, because it behaves differently and
   * the difference is the finding.
   */
  function laterWrite(title: string): ReturnType<typeof documentRecordFixture> {
    const first = documentRecordFixture({logicalId: 'article-1', title, timestamp: FIXED_NOW})
    const later = documentRecordFixture({logicalId: 'article-1', title, timestamp: LATER_NOW})
    return {...later, base: first.base}
  }

  it(
    'leaves the review surface untouched when only the write clock moved',
    async () => {
      const repo = await scratchRepo({now: FIXED_NOW})
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Stable', timestamp: FIXED_NOW}),
      )
      repo.commit('checkpoint')

      repo.setNow(LATER_NOW)
      await repo.store.putDocumentRevision(CONTRACT_OVERLAY_ID, laterWrite('Stable'))

      const moved = lines(repo.git('diff', '--name-only')).sort()

      /* THE LOAD-BEARING CLAIM. `intent.json` is §14.2's review surface and
       * carries no timestamp field at all, so a second checkpoint of unchanged
       * work is an empty diff on every file a reviewer actually reads — and no
       * new snapshot is minted. */
      expect(moved).toEqual(['.sanity-overlay/manifest.json'])
      expect(repo.git('status', '--porcelain', '--untracked-files=all')).not.toContain('??')
    },
    TEST_TIMEOUT,
  )

  it(
    'confines the noise to the manifest, and to named bookkeeping keys',
    async () => {
      const repo = await scratchRepo({now: FIXED_NOW})
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Stable', timestamp: FIXED_NOW}),
      )
      repo.commit('checkpoint')

      repo.setNow(LATER_NOW)
      await repo.store.putDocumentRevision(CONTRACT_OVERLAY_ID, laterWrite('Stable'))

      const patch = repo.git('diff', '--unified=0', '--', '.sanity-overlay/manifest.json')

      /* §13.1 requires the manifest to carry `revision` and `updatedAt`, and
       * §13.2 requires each head to carry `updatedAt`, `runtimeRevision`,
       * `checksum` and `storageRef`. Every one of those is a true statement
       * about a write that really did happen — so this is bookkeeping churn on
       * an index file, not a regenerated document. What this test pins is that
       * it is CONFINED to those keys: if a content field ever appears here, the
       * manifest has started duplicating the review surface. */
      expect(touchedKeys(patch)).toEqual([
        'checksum',
        'revision',
        'runtimeRevision',
        'storageRef',
        'updatedAt',
      ])
    },
    TEST_TIMEOUT,
  )

  it(
    'commits the same intent bytes from two repositories on two different clocks',
    async () => {
      /* Same logical state, two repositories, two DIFFERENT wall clocks. The
       * committed intent blob must be the same Git object — determinism tested
       * against the one input that could actually break it. */
      async function intentBlob(record: ReturnType<typeof documentRecordFixture>, now: string) {
        const repo = await scratchRepo({now})
        await repo.store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)
        repo.commit('checkpoint')
        return repo.git('rev-parse', 'HEAD:.sanity-overlay/documents/article-1/intent.json').trim()
      }

      const early = documentRecordFixture({
        logicalId: 'article-1',
        title: 'Stable',
        timestamp: FIXED_NOW,
      })

      expect(await intentBlob(laterWrite('Stable'), LATER_NOW)).toBe(
        await intentBlob(early, FIXED_NOW),
      )
    },
    TEST_TIMEOUT,
  )

  it(
    'addresses an identical base capture identically from two repositories on two different clocks',
    async () => {
      /*
       * §14.3's "one immutable content-addressed snapshot for each distinct
       * captured base state" is a DEDUPLICATION guarantee, so the property that
       * matters is cross-machine, not per-store. The test above pins the intent
       * blob; this pins the snapshot, which is the file the address names.
       *
       * `laterWrite` moves every clock the write touches — the store's own
       * `now`, the record's `createdAt`/`updatedAt`, the local version's
       * timestamps, the materialized `_updatedAt`, the derived
       * `runtimeRevision` — and holds `record.base` fixed. So this is the exact
       * statement that the snapshot address is a function of the captured base
       * block and of nothing else: no wall clock is read while addressing.
       */
      async function snapshotBlobs(
        record: ReturnType<typeof documentRecordFixture>,
        now: string,
      ): Promise<string[]> {
        const repo = await scratchRepo({now})
        await repo.store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)
        repo.commit('checkpoint')
        /* Independent oracle: the filename is the store's content address, the
         * blob id is Git's own hash of the bytes under it. */
        return lines(repo.git('ls-files', '.sanity-overlay/snapshots')).map(
          (path) => `${path} ${repo.git('rev-parse', `HEAD:${path}`).trim()}`,
        )
      }

      const early = documentRecordFixture({
        logicalId: 'article-1',
        title: 'Stable',
        timestamp: FIXED_NOW,
      })

      const fromEarly = await snapshotBlobs(early, FIXED_NOW)
      expect(fromEarly).toHaveLength(1)
      expect(await snapshotBlobs(laterWrite('Stable'), LATER_NOW)).toEqual(fromEarly)
    },
    TEST_TIMEOUT,
  )

  /**
   * The other half of that rule, and a DECISION rather than an open finding.
   *
   * `baseSnapshotFrom` (sanity-overlay-core `store/intent.ts`) content-addresses
   * `{formatVersion, ...record.base}` — the whole §13.4 base block, INCLUDING
   * `firstTouchedAt` and each version's `capturedAt`. So a re-capture of a base
   * document whose bytes did not change, taken at a different wall time, is a
   * different address: `base.snapshotRef` moves in the reviewed intent, the
   * intent's own `checksum` moves with it, and a second snapshot file with
   * identical `snapshot` content is minted alongside the first.
   *
   * That looks like churn worth removing, and it was raised as such. It is kept,
   * for four reasons:
   *
   * 1. THE ADDRESS READS NO CLOCK. It is a pure function of the record — same
   *    record, same address, on any machine at any time, which is what the test
   *    directly above proves with a moving wall clock. What moves here is the
   *    RECORD, because `capturedAt` moved; §34.17 ("deterministic for the same
   *    logical state") is untouched. The doctrine `checkpoint/checkpoint.ts`
   *    states — no clock is READ while rendering, which is why the checkpoint
   *    format has no `exportedAt` — is a different rule from "stored §13.4
   *    timestamps are excluded from the state", and only the first is a rule.
   *
   * 2. THERE IS NO SEAM TO PUT THE METADATA IN. §14.3 also says *immutable*, and
   *    three independent guards enforce it literally: `exportCheckpoint` refuses
   *    to write a snapshot under a name it does not hash to, `verifyCheckpoint`
   *    classifies the same divergence as corrupt and NOT repairable, and both
   *    store adapters mint the name from the whole file. Narrowing the address
   *    while leaving the timestamps in the file makes every snapshot in every
   *    checkpoint corrupt — verified by mutation, and pinned by
   *    `checkpoint-format.test.ts` "refuses a snapshot whose capture metadata
   *    alone was edited".
   *
   * 3. REMOVING THEM FROM THE FILE LOSES THEM. Record revisions live under
   *    `.runtime/revisions/`, which §14.1 does not commit, so `snapshots/` is
   *    the only committed carrier of `firstTouchedAt` and `capturedAt`. The one
   *    remaining home is `intent.json`, whose §14.2 `base` block is
   *    `{publishedRevision?, draftRevision?, snapshotRef?}` — and putting a wall
   *    clock there would move the churn INTO the reviewed diff as a literal
   *    timestamp instead of an opaque `snapshotRef`. Strictly worse for the
   *    reviewer this was raised on behalf of.
   *
   * 4. THE TRIGGER IS NOT REACHABLE ON THE PATHS THAT MATTER. §16.3 first-touch
   *    captures exactly once and `firstTouchedAt` is never modified afterwards
   *    (`mutations/mutation.ts`, `merge/rebase.ts`). A §16.6 / §28.5 rebase
   *    replaces the block with a NEW base revision, so the address moves on the
   *    revision and the snapshot bytes regardless of the timestamp. A
   *    same-revision, same-bytes, new-time re-capture needs a caller to rebase
   *    onto a base deep-equal to the ancestor.
   *
   * Where this class of churn IS worth preventing, the codebase already prevents
   * it at the source rather than by narrowing an address — see
   * `conflicts/persist.ts` rule 2, which keeps a re-detected conflict's original
   * `detectedAt` so the reviewed intent does not move.
   */
  it(
    're-capturing an unchanged base at a new time moves snapshotRef and mints a second snapshot',
    async () => {
      const repo = await scratchRepo({now: FIXED_NOW})
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Stable', timestamp: FIXED_NOW}),
      )
      repo.commit('checkpoint')
      const before = lines(repo.git('ls-files', '.sanity-overlay/snapshots'))

      repo.setNow(LATER_NOW)
      /* Identical base DOCUMENT, later capture metadata. */
      await repo.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Stable', timestamp: LATER_NOW}),
      )

      const patch = repo.git(
        'diff',
        '--unified=0',
        '--',
        '.sanity-overlay/documents/article-1/intent.json',
      )
      expect(touchedKeys(patch)).toEqual(['checksum', 'snapshotRef'])

      /* And the old snapshot is still tracked while a new one appears untracked
       * — two files for one base document. */
      expect(before).toHaveLength(1)
      const untracked = lines(repo.git('status', '--porcelain', '--untracked-files=all')).filter(
        (line) => line.startsWith('?? ') && line.includes('/snapshots/'),
      )
      expect(untracked).toHaveLength(1)

      /* The two snapshot files differ ONLY in capture metadata: the base
       * document each carries is deep-equal. That is what makes this churn
       * rather than a real change. The committed one is read through
       * `git show`, the new one off disk, so neither reading depends on the
       * other. */
      type Capture = {published?: {snapshot?: unknown; capturedAt?: unknown}; firstTouchedAt?: unknown}
      const committed = parse(repo.git('show', `HEAD:${before[0]!}`)) as Capture
      const minted = parse(
        await readFile(join(repo.dir, untracked[0]!.slice(3).trim()), 'utf8'),
      ) as Capture

      expect(minted.published?.snapshot).toEqual(committed.published?.snapshot)
      expect(minted.published?.capturedAt).not.toBe(committed.published?.capturedAt)
      expect(minted.firstTouchedAt).not.toBe(committed.firstTouchedAt)
    },
    TEST_TIMEOUT,
  )
})

/* ------------------------------------------------------------------ *
 * The regression this file was written after
 * ------------------------------------------------------------------ */

describe('the overlay tree is trackable at all', () => {
  it(
    'is not excluded by this repository’s own ignore rules',
    async () => {
      /* A blanket `.gitignore` of `.sanity-overlay/` silently defeated every
       * assertion above — nothing was tracked, so nothing could diff. Ask git,
       * in THIS repository, whether the canonical paths are ignored. */
      const repoRoot = new URL('../../..', import.meta.url).pathname
      const probe = (relative: string): number => {
        try {
          execFileSync('git', ['check-ignore', '-q', relative], {cwd: repoRoot})
          return 0
        } catch (error) {
          return (error as {status?: number}).status ?? -1
        }
      }

      /* `git check-ignore -q` exits 0 when the path IS ignored, 1 when it is
       * not. The canonical files must be trackable; the runtime ones must not
       * be a concern of the root ignore file at all — the overlay's own
       * `.gitignore` handles them, which the check above already proved. */
      expect(probe('examples/kitchen-sink/.sanity-overlay/manifest.json')).toBe(1)
      expect(
        probe('examples/kitchen-sink/.sanity-overlay/documents/article-1/intent.json'),
      ).toBe(1)
    },
    TEST_TIMEOUT,
  )
})
