/**
 * `attach` — bind a detached overlay to the real Sanity project (§13.1 base).
 *
 * `dev --detached` exists because teams start content before anyone provisions
 * a Sanity project (ids are assigned, not chosen). Attaching used to be a
 * documented MANUAL EDIT of `manifest.json` — the one workflow the store's own
 * discipline (conditional writes, revision increments, actor stamps) was told
 * to look away from. This verb closes that: the rebind goes through
 * `writeManifestConditional` like every other manifest change, and follows the
 * reset/rebase confirm discipline (`--confirm` to write, `--dry-run` wins).
 */
import {readFileSync} from 'node:fs'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {runCliCapture} from '../../sanity-overlay-cli/test-support/overlayFixture'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 11, 23, 0, tick++)).toISOString()
}

async function overlayRoot(base: {projectId: string; dataset: string}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cli-attach-'))
  roots.push(root)
  const store = new FsOverlayStore({root, now: makeClock()})
  await store.createOverlay({
    overlayId: 'attach-test-overlay-0000000000',
    base: {...base, apiVersion: '2025-02-19'},
    source: {repositoryId: 'local:attach-test'},
  })
  return root
}

const detachedRoot = (): Promise<string> =>
  overlayRoot({projectId: 'detached.local', dataset: 'detached'})

function manifestOf(root: string): {base: {projectId: string; dataset: string}; revision: number} {
  return JSON.parse(readFileSync(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'))
}

describe('attach — confirm discipline', () => {
  it('refuses without --confirm, printing the rebind it would record', async () => {
    const root = await detachedRoot()
    const run = await runCliCapture(
      ['attach', '--project', 'b1n03q3z', '--dataset', 'production'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.CONFIRMATION_REQUIRED)
    expect(run.stdout).toContain('detached.local')
    expect(run.stdout).toContain('b1n03q3z')
    expect(`${run.stdout}${run.stderr}`).toContain('--confirm')
    expect(manifestOf(root).base.projectId).toBe('detached.local')
  })

  it('--dry-run reports the plan and writes nothing, even with --confirm', async () => {
    const root = await detachedRoot()
    const run = await runCliCapture(
      ['attach', '--project', 'b1n03q3z', '--dataset', 'production', '--confirm', '--dry-run'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    expect(manifestOf(root).base.projectId).toBe('detached.local')
  })
})

describe('attach — the rebind', () => {
  it('attaches with --confirm, through the store (revision bumps, base rewritten)', async () => {
    const root = await detachedRoot()
    const before = manifestOf(root)

    const run = await runCliCapture(
      ['attach', '--project', 'b1n03q3z', '--dataset', 'production', '--confirm'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('b1n03q3z/production')

    const after = manifestOf(root)
    expect(after.base.projectId).toBe('b1n03q3z')
    expect(after.base.dataset).toBe('production')
    /* Through the store, not a raw file edit: the conditional write IS the
     * §34.5 exactly-once revision increment. */
    expect(after.revision).toBe(before.revision + 1)
  })

  it('refuses an already-attached overlay without --force, naming the current identity', async () => {
    const root = await overlayRoot({projectId: 'realproj1', dataset: 'production'})
    const run = await runCliCapture(
      ['attach', '--project', 'otherproj', '--dataset', 'production', '--confirm'],
      {cwd: root},
    )
    expect(run.code).not.toBe(EXIT.OK)
    expect(`${run.stdout}${run.stderr}`).toContain('realproj1')
    expect(`${run.stdout}${run.stderr}`).toContain('--force')
    expect(manifestOf(root).base.projectId).toBe('realproj1')
  })

  it('--force rebinds an attached overlay', async () => {
    const root = await overlayRoot({projectId: 'realproj1', dataset: 'production'})
    const run = await runCliCapture(
      ['attach', '--project', 'otherproj', '--dataset', 'staging', '--confirm', '--force'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    expect(manifestOf(root).base.projectId).toBe('otherproj')
    expect(manifestOf(root).base.dataset).toBe('staging')
  })
})

describe('attach — identity validation', () => {
  it('needs both --project and --dataset', async () => {
    const root = await detachedRoot()
    const run = await runCliCapture(['attach', '--project', 'b1n03q3z', '--confirm'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(`${run.stdout}${run.stderr}`).toContain('--dataset')
  })

  it('refuses a project id that could not be a real one (the sentinel dot)', async () => {
    const root = await detachedRoot()
    const run = await runCliCapture(
      ['attach', '--project', 'still.detached', '--dataset', 'production', '--confirm'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.USAGE)
    expect(manifestOf(root).base.projectId).toBe('detached.local')
  })
})
