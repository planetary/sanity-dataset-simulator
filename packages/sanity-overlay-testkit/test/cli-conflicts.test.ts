/**
 * `conflicts` — the §28.2 conflict list as a command.
 *
 * Conflicts are seeded through core (`createConflict` + `persistConflicts`) and
 * persisted by `FsOverlayStore`, so the command reads the same bytes a Studio
 * session would have produced. The exit code is load-bearing: an unresolved
 * conflict must fail a script, a resolved one must not.
 */
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
  seedConflicts,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

describe('conflicts', () => {
  it('exits OK on an overlay with none', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['conflicts'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('0 unresolved')
  })

  it('reads as English rather than as a counter', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['conflicts'], {cwd: root})
    expect(run.stdout).toContain('(0 listed)')
    expect(run.stdout).not.toMatch(/listeds/)
  })

  it('agrees in number when exactly one conflict is listed', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(fixture, 'article-1', [{type: 'SAME_PATH_CHANGED', path: ['title']}])
    const run = await runCliCapture(['conflicts'], {cwd: fixture.root})
    expect(run.stdout).toContain('1 unresolved conflict (1 listed)')
  })

  it('exits FINDINGS and lists an unresolved conflict', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(fixture, 'article-1', [
      {type: 'SAME_PATH_CHANGED', path: ['title'], baseValue: 'base', localValue: 'local'},
    ])

    const run = await runCliCapture(['conflicts'], {cwd: fixture.root})

    expect(run.code).toBe(EXIT.FINDINGS)
    expect(run.stdout).toContain('article-1')
    expect(run.stdout).toContain('SAME_PATH_CHANGED')
    expect(run.stdout).toContain('title')
  })

  it('reports severity and the §13.1 summary in --json', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(fixture, 'article-1', [
      {type: 'SAME_PATH_CHANGED', path: ['title']},
      {type: 'BASE_DOCUMENT_DELETED'},
    ])

    const run = await runCliCapture(['conflicts', '--json'], {cwd: fixture.root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.summary).toEqual({total: 2, hard: 1, soft: 1})
    expect(parsed.conflicts.map((conflict: any) => conflict.type).sort()).toEqual([
      'BASE_DOCUMENT_DELETED',
      'SAME_PATH_CHANGED',
    ])
    expect(parsed.conflicts.every((conflict: any) => conflict.resolved === false)).toBe(true)
  })

  it('hides resolved conflicts by default and shows them with --all', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(
      fixture,
      'article-1',
      [{type: 'SAME_PATH_CHANGED', path: ['title']}],
      {resolveAll: true},
    )

    const quiet = await runCliCapture(['conflicts', '--json'], {cwd: fixture.root})
    expect(quiet.code).toBe(EXIT.OK)
    expect(JSON.parse(quiet.stdout).conflicts).toEqual([])

    const loud = await runCliCapture(['conflicts', '--all', '--json'], {cwd: fixture.root})
    expect(loud.code).toBe(EXIT.OK)
    const parsed = JSON.parse(loud.stdout)
    expect(parsed.conflicts).toHaveLength(1)
    expect(parsed.conflicts[0].resolved).toBe(true)
    expect(parsed.conflicts[0].resolution).toBe('keep-local')
  })

  it('--document restricts to one document', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(fixture, 'article-1', [{type: 'SAME_PATH_CHANGED', path: ['title']}])
    await seedConflicts(fixture, 'article-2', [{type: 'SAME_PATH_CHANGED', path: ['title']}])

    const run = await runCliCapture(['conflicts', '--document', 'article-2', '--json'], {
      cwd: fixture.root,
    })
    const parsed = JSON.parse(run.stdout)

    expect(parsed.conflicts.map((conflict: any) => conflict.documentId)).toEqual(['article-2'])
  })

  it('--actions lists the §28.3 resolution actions that apply', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(fixture, 'article-1', [{type: 'SAME_PATH_CHANGED', path: ['title']}])

    const run = await runCliCapture(['conflicts', '--actions', '--json'], {cwd: fixture.root})
    const parsed = JSON.parse(run.stdout)

    /* Core's §28.3 vocabulary verbatim — the CLI must not rename the actions,
     * because the name is what a reviewer would pass back to the resolver. */
    expect(parsed.conflicts[0].actions).toEqual(
      expect.arrayContaining([
        'keep-branch-value',
        'accept-current-staging',
        'manual-edit',
        'remove-local-override',
      ]),
    )
  })

  it('orders conflicts deterministically', async () => {
    const fixture = await createOverlayFixture()
    await seedConflicts(fixture, 'article-2', [{type: 'SAME_PATH_CHANGED', path: ['title']}])
    await seedConflicts(fixture, 'article-1', [{type: 'PARENT_SHAPE_CHANGED', path: ['hero']}])

    const first = await runCliCapture(['conflicts', '--json'], {cwd: fixture.root})
    const second = await runCliCapture(['conflicts', '--json'], {cwd: fixture.root})

    expect(second.stdout).toBe(first.stdout)
    /* IDs are core's `conflictId()` verbatim — the storage path encoding, not
     * the CLI's display notation. Reformatting them would break the join back
     * to the record. */
    expect(JSON.parse(first.stdout).conflicts.map((c: any) => c.id)).toEqual([
      'article-1:PARENT_SHAPE_CHANGED:$.hero',
      'article-2:SAME_PATH_CHANGED:$.title',
    ])
  })
})
