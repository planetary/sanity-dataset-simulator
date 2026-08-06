/**
 * Test-support only: build a *real* `.sanity-overlay/` in a temp directory.
 *
 * Nothing here is shipped. It exists so a CLI test asserts against an overlay
 * that was written the way the Studio writes one — `seedOverlay` drives core's
 * mutation engine and `FsOverlayStore`, so no record or manifest is hand-built.
 * A CLI test that read a fabricated directory would prove nothing about the CLI
 * against real state.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {seedOverlay, type SeedEdit} from '../../sanity-overlay-client/src/dev/seedOverlay'
import {
  createConflict,
  persistConflicts,
  type CreateConflictInput,
  type OverlayActor,
  type SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {runCli, type RunCliOptions} from '../src/index'

export const FIXTURE_OVERLAY_ID = 'cli-fixture-0000000000000000000'

export const FIXTURE_BASE_DOCUMENTS: readonly SanityDocument[] = Object.freeze([
  {
    _id: 'article-1',
    _type: 'article',
    _rev: 'base-rev-article-1',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    title: 'Base article title',
    tags: ['base'],
    slug: {current: 'base-article'},
    author: {_type: 'reference', _ref: 'author-1'},
    body: [
      {_key: 'block-a', _type: 'block', text: 'first'},
      {_key: 'block-b', _type: 'block', text: 'second'},
    ],
  },
  {
    _id: 'author-1',
    _type: 'author',
    _rev: 'base-rev-author-1',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    name: 'Ada Lovelace',
    slug: {current: 'ada'},
  },
  {
    _id: 'page-home',
    _type: 'page',
    _rev: 'base-rev-page-home',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    title: 'Home',
    slug: {current: 'home'},
    hero: {heading: 'Base heading', cta: {label: 'Base label'}},
  },
])

/** Edits used by most fixtures: one modified document plus one branch-created one. */
export const DEFAULT_EDITS: readonly SeedEdit[] = Object.freeze<SeedEdit[]>([
  {
    kind: 'edit',
    id: 'article-1',
    operations: [
      {type: 'set', path: ['title'], value: 'Branch article title'},
      {type: 'set', path: ['body', {_key: 'block-b'}, 'text'], value: 'second, edited'},
      {type: 'unset', path: ['tags']},
    ],
  },
  {
    kind: 'create',
    document: {
      _id: 'article-2',
      _type: 'article',
      title: 'Branch-only article',
      slug: {current: 'branch-only'},
    },
  },
])

export interface OverlayFixtureOptions {
  readonly edits?: readonly SeedEdit[]
  readonly baseDocuments?: readonly SanityDocument[]
  readonly overlayId?: string
  /** Create the directory but seed nothing, so there is no `.sanity-overlay/`. */
  readonly empty?: boolean
}

export interface OverlayFixture {
  readonly root: string
  readonly overlayId: string
}

const roots: string[] = []

/** Remove every temp root this module created. Call from `afterEach`. */
export async function cleanupOverlayFixtures(): Promise<void> {
  const pending = roots.splice(0, roots.length)
  await Promise.all(pending.map((root) => rm(root, {recursive: true, force: true})))
}

/** A monotonic, deterministic clock so seeded overlays are byte-stable. */
export function fixedClock(startMs = Date.UTC(2026, 0, 1)): () => string {
  let tick = 0
  return () => new Date(startMs + tick++ * 1000).toISOString()
}

export async function createOverlayFixture(
  options: OverlayFixtureOptions = {},
): Promise<OverlayFixture> {
  const root = await mkdtemp(join(tmpdir(), 'sanity-overlay-cli-'))
  roots.push(root)
  const overlayId = options.overlayId ?? FIXTURE_OVERLAY_ID
  if (options.empty) return {root, overlayId}

  await seedOverlay({
    root,
    overlayId,
    now: fixedClock(),
    edits: [...(options.edits ?? DEFAULT_EDITS)],
    baseDocuments: [...(options.baseDocuments ?? FIXTURE_BASE_DOCUMENTS)],
    base: {projectId: 'proj-cli', dataset: 'production', apiVersion: '2024-10-01'},
    source: {repositoryId: 'github:planetary/cli', branch: 'feature/cli'},
  })
  return {root, overlayId}
}

const CONFLICT_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'cli-fixture',
  displayName: 'CLI fixture',
}

/**
 * Persist §13.11 conflicts onto an existing record through the real path:
 * core's `createConflict` builds them, core's `persistConflicts` folds them onto
 * the §13.3 record, and `FsOverlayStore` writes the revision and the §13.1
 * summary. Nothing is hand-edited on disk.
 */
export async function seedConflicts(
  fixture: OverlayFixture,
  logicalId: string,
  conflicts: readonly Omit<CreateConflictInput, 'documentId' | 'detectedAt'>[],
  options: {readonly resolveAll?: boolean; readonly now?: string} = {},
): Promise<void> {
  const at = options.now ?? '2026-02-01T00:00:00.000Z'
  const store = new FsOverlayStore({root: fixture.root, now: () => at})
  const read = await store.readDocumentByLogicalId(fixture.overlayId, logicalId)
  if (!read?.record) throw new Error(`no record for ${logicalId} in ${fixture.root}`)

  const built = conflicts.map((input) =>
    createConflict({...input, documentId: logicalId, detectedAt: at}),
  )
  const withConflicts = persistConflicts(read.record, built)
  const next = options.resolveAll
    ? {
        ...withConflicts,
        conflicts: withConflicts.conflicts.map((conflict) => ({
          ...conflict,
          resolution: {type: 'keep-local' as const, resolvedAt: at, resolvedBy: CONFLICT_ACTOR},
        })),
      }
    : withConflicts

  await store.putDocumentRevision(fixture.overlayId, next, {actor: CONFLICT_ACTOR})
}

export interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the CLI as a caller would, capturing both streams and the exit code. */
export async function runCliCapture(
  argv: readonly string[],
  options: Omit<RunCliOptions, 'argv' | 'io'> & {cwd: string},
): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  const code = await runCli({
    ...options,
    argv,
    io: {
      out: (chunk) => {
        stdout += chunk
      },
      err: (chunk) => {
        stderr += chunk
      },
    },
  })
  return {code, stdout, stderr}
}
