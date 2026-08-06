/**
 * The canonical checkpoint file format — PRD §14.1, §14.3, §29.1, §29.2, §29.7,
 * invariant §34.17.
 *
 * `sanity-overlay-core/src/checkpoint` renders overlay state to a *file set*
 * (relative path → exact file bytes) and parses one back. It is pure: no
 * `node:*`, no clock, no filesystem — which is precisely what makes byte-identity
 * assertable. The filesystem half (writing the set to a directory, watching it
 * for direct edits) is `checkpoint-fs.test.ts`.
 *
 * Every assertion here uses an oracle independent of the code under test:
 * checksums are recomputed with `sha256Hex`/`checksum` over the exact file text,
 * key ordering is read back out of the raw text with a regex, and encoded
 * directory names are decoded with `decodeLogicalId`.
 */
import {describe, expect, it} from 'vitest'
import {
  CHECKPOINT_CHECKSUMS_FILE,
  CHECKPOINT_MANIFEST_FILE,
  MemoryOverlayStore,
  OVERLAY_FORMAT_VERSION,
  checkOverlayInvariants,
  checkpointFilesFromRecord,
  checkpointFilesToRecord,
  checkpointStateFromBundle,
  checksum,
  decodeLogicalId,
  encodeLogicalId,
  exportCheckpoint,
  importCheckpoint,
  isOverlayStoreError,
  parse,
  serialize,
  sha256Hex,
  verifyCheckpoint,
} from '../../sanity-overlay-core/src/index'
import type {
  OverlayCheckpointChecksums,
  OverlayCheckpointFiles,
  OverlayCheckpointState,
} from '../../sanity-overlay-core/src/index'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

/** Two documents, one with a dotted logical ID, both carrying a captured base. */
async function seedState(): Promise<OverlayCheckpointState> {
  const store = new MemoryOverlayStore({now: () => FIXED_NOW})
  await store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  await store.commitTransaction(CONTRACT_OVERLAY_ID, {
    idempotencyKey: 'checkpoint-seed',
    actor: CONTRACT_ACTOR,
    mutations: [{type: 'patch', id: 'article-1', operations: []}],
    records: [
      documentRecordFixture({logicalId: 'article-1', title: 'One'}),
      documentRecordFixture({logicalId: 'legacy.page.v2', title: 'Dotted'}),
    ],
  })
  return checkpointStateFromBundle(await store.exportCanonical(CONTRACT_OVERLAY_ID))
}

/** Mutable copy of a rendered file set, for tampering. */
function mutable(files: OverlayCheckpointFiles): Map<string, string> {
  return new Map(files)
}

/** Top-level object keys, read out of the raw text rather than from a parse. */
function topLevelKeys(text: string): string[] {
  return [...text.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].map((match) => match[1]!)
}

function intentPath(logicalId: string): string {
  return `documents/${encodeLogicalId(logicalId)}/intent.json`
}

function checksumsOf(files: OverlayCheckpointFiles): OverlayCheckpointChecksums {
  return parse(files.get(CHECKPOINT_CHECKSUMS_FILE)!) as OverlayCheckpointChecksums
}

/** Rewrite one file and drop it out of sync with the checksum manifest. */
function handEdit(files: Map<string, string>, path: string, from: string, to: string): void {
  const text = files.get(path)
  if (text === undefined) throw new Error(`no such checkpoint file: ${path}`)
  if (!text.includes(from)) throw new Error(`${path} does not contain ${JSON.stringify(from)}`)
  files.set(path, text.replace(from, to))
}

describe('checkpoint file rendering (PRD §14.1, §29.1)', () => {
  it('emits exactly the §29.1 canonical layout', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)

    expect([...files.keys()]).toEqual([
      CHECKPOINT_CHECKSUMS_FILE,
      intentPath('article-1'),
      intentPath('legacy.page.v2'),
      CHECKPOINT_MANIFEST_FILE,
      ...Object.keys(state.snapshots)
        .sort()
        .map((address) => `snapshots/${address}.json`),
    ].sort())
  })

  it('encodes document IDs safely and reversibly (PRD §14.3)', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)

    const directories = [...files.keys()]
      .filter((path) => path.startsWith('documents/'))
      .map((path) => path.split('/')[1]!)

    for (const directory of directories) {
      expect(directory).not.toContain('/')
      expect(directory).not.toContain('.')
    }
    expect(directories.map((directory) => decodeLogicalId(directory)).sort()).toEqual([
      'article-1',
      'legacy.page.v2',
    ])
  })

  it('writes canonical JSON: sorted keys, two-space indent, trailing newline', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)

    for (const [path, text] of files) {
      expect(text.endsWith('\n'), `${path} must end with a newline`).toBe(true)
      expect(text.endsWith('\n\n'), `${path} must end with exactly one newline`).toBe(false)
      /* Key order read back out of the bytes, not out of a re-serialization. */
      const keys = topLevelKeys(text)
      expect(keys, `${path} keys must be sorted`).toEqual([...keys].sort())
      /* Indentation of the first nested level is exactly two spaces. */
      expect(text.split('\n')[1]).toMatch(/^ {2}\S/)
      /* Parsing and re-serializing is a fixpoint (§34.17). */
      expect(serialize(parse(text))).toBe(text)
    }
  })

  it('content-addresses every base snapshot at snapshots/<sha256>.json', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)

    const snapshotPaths = [...files.keys()].filter((path) => path.startsWith('snapshots/'))
    expect(snapshotPaths.length).toBeGreaterThan(0)
    for (const path of snapshotPaths) {
      const address = path.slice('snapshots/'.length, -'.json'.length)
      expect(address).toMatch(/^[0-9a-f]{64}$/)
      expect(checksum(parse(files.get(path)!))).toBe(address)
    }
  })

  it('carries a checksum manifest covering every other file', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)
    const manifest = checksumsOf(files)

    expect(manifest.formatVersion).toBe(OVERLAY_FORMAT_VERSION)
    expect(manifest.overlayId).toBe(CONTRACT_OVERLAY_ID)
    expect(manifest.algorithm).toBe('sha256')

    /* Every file except the checksum manifest itself is listed, hashed over its
     * exact bytes — the truncated-write detector. */
    const listed = Object.keys(manifest.files).sort()
    const expected = [...files.keys()].filter((path) => path !== CHECKPOINT_CHECKSUMS_FILE).sort()
    expect(listed).toEqual(expected)
    for (const path of expected) {
      expect(manifest.files[path]).toBe(sha256Hex(files.get(path)!))
    }

    /* The manifest is itself tamper-evident. */
    const {checksum: root, ...rest} = manifest
    expect(root).toBe(checksum(rest))
  })

  it('recomputes each intent checksum on export (PRD §29.2)', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)

    for (const document of state.documents) {
      const intent = parse(files.get(intentPath(document.logicalId))!) as Record<string, unknown>
      const {checksum: stored, ...rest} = intent
      expect(stored).toBe(checksum(rest))
    }
  })
})

describe('checkpoint determinism (invariant §34.17)', () => {
  it('renders byte-identical output for the same logical state', async () => {
    const state = await seedState()
    const first = exportCheckpoint(state)
    const second = exportCheckpoint(state)
    expect(checkpointFilesToRecord(second)).toEqual(checkpointFilesToRecord(first))
  })

  it('is insensitive to input ordering', async () => {
    const state = await seedState()
    const shuffled: OverlayCheckpointState = {
      manifest: {
        ...state.manifest,
        /* Reverse the head insertion order: the same logical state. */
        documentHeads: Object.fromEntries(
          Object.entries(state.manifest.documentHeads).reverse(),
        ),
      },
      documents: [...state.documents].reverse(),
      snapshots: Object.fromEntries(Object.entries(state.snapshots).reverse()),
    }

    expect(checkpointFilesToRecord(exportCheckpoint(shuffled))).toEqual(
      checkpointFilesToRecord(exportCheckpoint(state)),
    )
  })

  it('passes the executable §34.17 invariant check', async () => {
    const state = await seedState()
    const renderings = [
      checkpointFilesToRecord(exportCheckpoint(state)),
      checkpointFilesToRecord(exportCheckpoint(state)),
    ]
    expect(checkOverlayInvariants({checkpointRenderings: renderings})).toEqual([])
  })

  it('embeds no wall clock', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)
    /* `exportedAt` is a transfer-bundle field; a checkpoint must not carry one,
     * or two exports of one state would differ. */
    expect(files.get(CHECKPOINT_CHECKSUMS_FILE)).not.toContain('exportedAt')
  })
})

describe('checkpoint round trip (PRD §29.7)', () => {
  it('import(export(state)) reproduces the same logical state', async () => {
    const state = await seedState()
    const imported = importCheckpoint(exportCheckpoint(state))

    expect(imported.repaired).toEqual([])
    expect(imported.issues).toEqual([])
    expect(imported.state.manifest).toEqual(state.manifest)
    expect(imported.state.documents).toEqual(state.documents)
    expect(imported.state.snapshots).toEqual(state.snapshots)
  })

  it('re-export is byte-identical', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)
    const imported = importCheckpoint(files)

    expect(checkpointFilesToRecord(imported.files)).toEqual(checkpointFilesToRecord(files))
    expect(checkpointFilesToRecord(exportCheckpoint(imported.state))).toEqual(
      checkpointFilesToRecord(files),
    )
  })

  it('survives a plain-object transport', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)
    const transported = checkpointFilesFromRecord(
      JSON.parse(JSON.stringify(checkpointFilesToRecord(files))) as Record<string, string>,
    )

    expect(importCheckpoint(transported).state.manifest).toEqual(state.manifest)
  })

  it('rejects a checkpoint whose overlay ID is not the expected one', async () => {
    const state = await seedState()
    const files = exportCheckpoint(state)

    try {
      importCheckpoint(files, {expectOverlayId: 'some-other-overlay'})
      expect.unreachable('expected an identity mismatch')
    } catch (error) {
      expect(isOverlayStoreError(error, 'OVERLAY_IDENTITY_MISMATCH')).toBe(true)
    }
  })
})

describe('divergence detection — corrupt input fails clearly (PRD §29.7 step 3)', () => {
  async function corrupt(
    mutate: (files: Map<string, string>, state: OverlayCheckpointState) => void,
  ): Promise<{code: string; repairable: unknown}> {
    const state = await seedState()
    const files = mutable(exportCheckpoint(state))
    mutate(files, state)
    try {
      importCheckpoint(files)
      expect.unreachable('expected the corrupt checkpoint to be refused')
    } catch (error) {
      expect(isOverlayStoreError(error)).toBe(true)
      const store = error as {code: string; details: Record<string, unknown>}
      return {code: store.code, repairable: store.details.repairable}
    }
  }

  it('refuses a snapshot whose bytes no longer hash to its own name', async () => {
    const outcome = await corrupt((files, state) => {
      const address = Object.keys(state.snapshots)[0]!
      handEdit(files, `snapshots/${address}.json`, 'base body', 'tampered body')
      /* Keep the checksum manifest consistent, so the *only* signal left is the
       * violated content address. */
      const manifestPath = CHECKPOINT_CHECKSUMS_FILE
      const record = parse(files.get(manifestPath)!) as OverlayCheckpointChecksums
      const next: OverlayCheckpointChecksums = {
        ...record,
        files: {
          ...record.files,
          [`snapshots/${address}.json`]: sha256Hex(files.get(`snapshots/${address}.json`)!),
        },
        checksum: '',
      }
      const {checksum: _drop, ...rest} = next
      files.set(manifestPath, serialize({...next, checksum: checksum(rest)}))
    })

    expect(outcome.code).toBe('CHECKSUM_MISMATCH')
    expect(outcome.repairable).toBe(false)
  })

  it('refuses a checkpoint with no checksum manifest', async () => {
    const outcome = await corrupt((files) => {
      files.delete(CHECKPOINT_CHECKSUMS_FILE)
    })
    expect(outcome.code).toBe('OVERLAY_STORE_CORRUPT')
  })

  it('refuses a checksum manifest that fails its own root checksum', async () => {
    const outcome = await corrupt((files) => {
      handEdit(files, CHECKPOINT_CHECKSUMS_FILE, '"algorithm": "sha256"', '"algorithm": "sha256x"')
    })
    expect(outcome.code).toBe('OVERLAY_STORE_CORRUPT')
  })

  it('refuses a checkpoint missing a listed file', async () => {
    const outcome = await corrupt((files) => {
      files.delete(intentPath('article-1'))
    })
    expect(outcome.code).toBe('OVERLAY_STORE_CORRUPT')
  })

  it('refuses an intent file that no manifest head reaches (§34.3)', async () => {
    const state = await seedState()
    const files = mutable(exportCheckpoint(state))
    const smuggled = intentPath('smuggled-doc')
    files.set(smuggled, files.get(intentPath('article-1'))!)
    const record = parse(files.get(CHECKPOINT_CHECKSUMS_FILE)!) as OverlayCheckpointChecksums
    const next = {
      ...record,
      files: {...record.files, [smuggled]: sha256Hex(files.get(smuggled)!)},
    }
    const {checksum: _drop, ...rest} = next
    files.set(CHECKPOINT_CHECKSUMS_FILE, serialize({...next, checksum: checksum(rest)}))

    try {
      importCheckpoint(files)
      expect.unreachable('expected the unreferenced intent to be refused')
    } catch (error) {
      expect(isOverlayStoreError(error, 'OVERLAY_STORE_CORRUPT')).toBe(true)
    }
  })

  it('refuses malformed JSON', async () => {
    const outcome = await corrupt((files) => {
      files.set(intentPath('article-1'), '{"logicalId": "article-1",\n')
    })
    expect(outcome.code).toBe('OVERLAY_STORE_CORRUPT')
  })

  it('refuses prototype-polluting keys (PRD §35.14)', async () => {
    const polluted = '{\n  "__proto__": {\n    "polluted": true\n  }\n}\n'
    const outcome = await corrupt((files) => {
      files.set(intentPath('article-1'), polluted)
    })
    expect(outcome.code).toBe('OVERLAY_STORE_CORRUPT')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('never returns partial state from a corrupt checkpoint', async () => {
    const state = await seedState()
    const files = mutable(exportCheckpoint(state))
    files.set(intentPath('article-1'), 'not json at all')

    expect(() => importCheckpoint(files)).toThrow()
    /* The one good document is not smuggled out through the verification report. */
    const report = verifyCheckpoint(files)
    expect(report.ok).toBe(false)
    expect(report.corrupt.map((issue) => issue.ref)).toContain(intentPath('article-1'))
  })
})

describe('repairable metadata — a hand edit is not corruption (PRD §14.3)', () => {
  /** A developer edits `intent.json` by hand; both stored checksums go stale. */
  async function handEdited(): Promise<{
    state: OverlayCheckpointState
    files: Map<string, string>
  }> {
    const state = await seedState()
    const files = mutable(exportCheckpoint(state))
    handEdit(files, intentPath('article-1'), '"One"', '"Edited by hand"')
    return {state, files}
  }

  it('classifies a stale intent checksum as repairable, not corrupt', async () => {
    const {files} = await handEdited()
    const report = verifyCheckpoint(files)

    expect(report.ok).toBe(false)
    expect(report.corrupt).toEqual([])
    expect(report.repairable.length).toBeGreaterThan(0)
    expect(report.repairable.every((issue) => issue.repairable)).toBe(true)
    expect(report.repairable.map((issue) => issue.ref)).toContain(intentPath('article-1'))
  })

  it('repairs by default and keeps the hand-edited content', async () => {
    const {files} = await handEdited()
    const imported = importCheckpoint(files)

    expect(imported.repaired).toContain(intentPath('article-1'))
    const article = imported.state.documents.find((intent) => intent.logicalId === 'article-1')!
    expect(article.draft?.overrides).toEqual([{path: ['title'], value: 'Edited by hand'}])

    /* Checksums are recomputed, not preserved: the repaired file set is exactly
     * what a fresh export of the repaired state produces (PRD §29.2). */
    expect(article.checksum).toBe(
      checksum(Object.fromEntries(Object.entries(article).filter(([key]) => key !== 'checksum'))),
    )
    expect(checkpointFilesToRecord(imported.files)).toEqual(
      checkpointFilesToRecord(exportCheckpoint(imported.state)),
    )
    /* And the repaired set now verifies clean. */
    expect(verifyCheckpoint(imported.files).ok).toBe(true)
  })

  it('rejects the same input when the caller asks for strictness', async () => {
    const {files} = await handEdited()
    try {
      importCheckpoint(files, {onDivergence: 'reject'})
      expect.unreachable('expected the stale checksum to be reported')
    } catch (error) {
      expect(isOverlayStoreError(error, 'CHECKSUM_MISMATCH')).toBe(true)
      expect((error as {details: Record<string, unknown>}).details.repairable).toBe(true)
    }
  })

  it('repairs a stale checksum-manifest entry for the overlay manifest', async () => {
    const state = await seedState()
    const files = mutable(exportCheckpoint(state))
    /* A Git merge rewrites manifest.json to a semantically valid newer revision;
     * the stored file hash is now stale. */
    handEdit(files, CHECKPOINT_MANIFEST_FILE, '"revision": 1', '"revision": 2')

    const report = verifyCheckpoint(files)
    expect(report.corrupt).toEqual([])
    expect(report.repairable.map((issue) => issue.ref)).toContain(CHECKPOINT_MANIFEST_FILE)

    const imported = importCheckpoint(files)
    expect(imported.state.manifest.revision).toBe(2)
    expect(imported.repaired).toContain(CHECKPOINT_MANIFEST_FILE)
    expect(verifyCheckpoint(imported.files).ok).toBe(true)
  })
})
