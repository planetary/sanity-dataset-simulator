/**
 * Scaffold reconciliation — the §14.1 housekeeping files must stay CURRENT, not
 * merely exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS.
 *
 * `FsOverlayStore` scaffolds `.gitattributes`, `.gitignore` and `README.md` with
 * a write-if-absent, and `#scaffold()` is reached from exactly three places:
 * `createOverlay`, `importCanonical` and `importCheckpoint`. Reopening an
 * existing overlay never reaches it. That is correct for "do not clobber what
 * the developer wrote" and wrong for "a later version added a line that
 * matters", because an overlay created by an earlier version keeps its stale
 * copy forever and nothing repairs it.
 *
 * This was not hypothetical. `assets/blobs/** binary` was added to
 * `GITATTRIBUTES_CONTENT` when branch-local assets landed, and the overlay in
 * `examples/kitchen-sink/` — scaffolded weeks earlier — never received it. The
 * first real upload committed a PNG that Git believed was text, and
 * `repo-hygiene.test.ts` caught a raw `0x1a` in a "text" file.
 *
 * The consequence is worse than a red test, and `layout.ts` says so itself: an
 * asset blob is addressed BY ITS SHA-256, so a CRLF rewrite on checkout would
 * silently invalidate every record that names it. The identity and the bytes
 * would disagree and nothing would report it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT, AND WHY IT IS NOT "OVERWRITE THE FILE".
 *
 * Reconciliation must be ADDITIVE. `.gitattributes` and `.gitignore` are files a
 * developer is entitled to edit — the scaffolded README explicitly invites
 * hand-editing of this directory. Replacing them wholesale would silently
 * discard that. So the rule asserted here is: every line the current scaffold
 * requires is PRESENT, and every line the developer added SURVIVES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORACLES.
 *
 * Every assertion reads the file back off disk with `node:fs` after the store
 * has finished, never a value the store returned. The whole point of the bug is
 * that the store believed the scaffold was fine.
 */
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {
  GITATTRIBUTES_CONTENT,
  GITATTRIBUTES_FILE,
  GITIGNORE_CONTENT,
  GITIGNORE_FILE,
} from '../../sanity-overlay-store-fs/src/layout'
import {CONTRACT_BASE, CONTRACT_SOURCE} from '../src/storeContract'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const OVERLAY_ID = 'scaffold-reconcile'

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sanity-overlay-scaffold-'))
}

function newStore(root: string): FsOverlayStore {
  return new FsOverlayStore({root, now: () => FIXED_NOW})
}

/** Create the overlay, then hand back a root whose scaffold we can age by hand. */
async function scaffoldedRoot(): Promise<string> {
  const root = await freshRoot()
  await newStore(root).createOverlay({
    overlayId: OVERLAY_ID,
    base: CONTRACT_BASE,
    source: CONTRACT_SOURCE,
  })
  return root
}

/** The lines the current scaffold declares, ignoring blanks. */
function requiredLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

async function readScaffold(root: string, file: string): Promise<string> {
  return readFile(join(root, '.sanity-overlay', file), 'utf8')
}

async function writeScaffold(root: string, file: string, body: string): Promise<void> {
  await writeFile(join(root, '.sanity-overlay', file), body, 'utf8')
}

/**
 * `revalidate` is the documented repair entry point — the CLI's `normalize`
 * already calls it to fix a hand-edited overlay. Housekeeping files being stale
 * is the same kind of drift, so that is where reconciliation belongs.
 */
async function repair(root: string): Promise<void> {
  await newStore(root).revalidate(OVERLAY_ID)
}

describe('scaffold reconciliation (PRD §14.1)', () => {
  it('adds a required .gitattributes line that a stale overlay is missing', async () => {
    const root = await scaffoldedRoot()

    const assetLine = requiredLines(GITATTRIBUTES_CONTENT).find((line) => line.includes('blobs'))
    expect(assetLine, 'the scaffold must declare asset blobs binary').toBeDefined()

    /* Age the overlay by hand: exactly how one created before branch-local
       assets existed still looks on disk today. */
    const stale = requiredLines(GITATTRIBUTES_CONTENT).filter((line) => line !== assetLine)
    await writeScaffold(root, GITATTRIBUTES_FILE, `${stale.join('\n')}\n`)

    await repair(root)

    expect(
      await readScaffold(root, GITATTRIBUTES_FILE),
      'an overlay scaffolded before assets existed must gain the binary declaration; without ' +
        'it Git may CRLF-rewrite a blob whose SHA-256 is its identity',
    ).toContain(assetLine as string)
  })

  it('adds required .gitignore lines a stale overlay is missing', async () => {
    const root = await scaffoldedRoot()

    /* An overlay from before the lock and history directories existed. */
    await writeScaffold(root, GITIGNORE_FILE, '.runtime/\n')

    await repair(root)

    const onDisk = await readScaffold(root, GITIGNORE_FILE)
    for (const line of requiredLines(GITIGNORE_CONTENT)) {
      expect(onDisk, `runtime-only path ${line} must stay ignored (§14.1)`).toContain(line)
    }
  })

  it('preserves lines the developer added', async () => {
    const root = await scaffoldedRoot()

    await writeScaffold(
      root,
      GITATTRIBUTES_FILE,
      '# our own rule\ndocuments/** linguist-language=JSON\n',
    )

    await repair(root)

    const onDisk = await readScaffold(root, GITATTRIBUTES_FILE)
    expect(onDisk, 'reconciliation must be additive, never a replacement').toContain(
      'documents/** linguist-language=JSON',
    )
    expect(onDisk, 'the developer comment must survive too').toContain('# our own rule')
    expect(onDisk, 'and it must still add what the scaffold requires').toContain('binary')
  })

  /**
   * GIT IS THE ORACLE, NOT THE FILE CONTENTS.
   *
   * Every assertion above proves a LINE is present. None of them proves the line
   * DOES anything, and for most of this file's life it did not: the patterns
   * were spelled `.sanity-overlay/assets/blobs/**` while the `.gitattributes`
   * carrying them lives INSIDE `.sanity-overlay/`. Git resolves patterns
   * relative to the directory of the file that declares them, so it was looking
   * for `.sanity-overlay/.sanity-overlay/assets/blobs/` — a path that cannot
   * exist. All three rules were silent no-ops.
   *
   * The blob meanwhile inherited `text=auto, eol=lf` from the repository root,
   * so Git was entitled to rewrite its line endings on checkout — the exact
   * corruption the rule was added to prevent, on content whose SHA-256 is its
   * identity.
   *
   * A string assertion could never have caught that. `git check-attr` is the
   * only authority on what an attribute does, so this asks it.
   */
  it('declares attributes Git actually applies, not merely lines that look right', async () => {
    const root = await scaffoldedRoot()

    /* A real repository, because `check-attr` needs one to resolve against. */
    execFileSync('git', ['init', '--quiet'], {cwd: root})

    const overlay = join(root, '.sanity-overlay')
    const blob = join(overlay, 'assets', 'blobs', `${'a'.repeat(64)}.bin`)
    await mkdir(join(overlay, 'assets', 'blobs'), {recursive: true})
    await writeFile(blob, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x1a, 0x0a]))

    const ask = (path: string, attribute: string): string => {
      const out = execFileSync('git', ['check-attr', attribute, '--', path], {
        cwd: root,
        encoding: 'utf8',
      })
      return (out.trim().split(': ').pop() ?? '').trim()
    }

    expect(
      ask(blob, 'binary'),
      'an asset blob is addressed by its SHA-256; if Git does not consider it binary it may ' +
        'normalise line endings on checkout and silently invalidate every record naming it',
    ).toBe('set')

    /* The same spelling bug would have silenced these two as well, so they are
       part of the class rather than a separate concern.

       `linguist-generated=true` is a VALUED attribute, so Git answers with the
       value; only bare flags answer `set`. Asserting `set` here would fail on
       correct output. */
    expect(
      ask(join(overlay, 'snapshots', 'abc.json'), 'linguist-generated'),
      'generated snapshots must stay out of review diffs (§14.1)',
    ).toBe('true')
    expect(
      ask(join(overlay, '.runtime', 'materialized', 'x.json'), 'export-ignore'),
      'runtime artifacts must not ship in an archive (§14.1)',
    ).toBe('set')
  })

  it('is idempotent — repairing twice does not duplicate a line', async () => {
    const root = await scaffoldedRoot()

    await repair(root)
    const once = await readScaffold(root, GITATTRIBUTES_FILE)
    await repair(root)
    const twice = await readScaffold(root, GITATTRIBUTES_FILE)

    expect(twice).toEqual(once)

    for (const line of requiredLines(GITATTRIBUTES_CONTENT)) {
      const occurrences = twice.split('\n').filter((candidate) => candidate.trim() === line)
      expect(occurrences, `"${line}" must appear exactly once`).toHaveLength(1)
    }
  })
})
