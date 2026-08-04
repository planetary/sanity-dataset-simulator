import {describe, expect, it} from 'vitest'
import {loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {loadBaseArtifact} from '../spike-d/artifact'
import {applyMutations, planRenameMigration} from '../spike-d/migration'
import {scan} from '../spike-d/scanner'
import * as variants from '../spike-d/variants'

// SPIKE D (PRD §36.4): each schema change scanned against live base documents.
// Pass criteria: compatible changes work normally; incompatible changes fail
// visibly; no base data is lost; migration path is explicit.

const artifact = loadBaseArtifact()
const docs = publishedPerspective(loadFixtureDataset())
const snapshot = JSON.stringify(docs) // no-base-data-loss sentinel

describe('Spike D: baseline', () => {
  it('base schema over base documents produces zero findings', () => {
    expect(scan(artifact, docs)).toEqual([])
  })
})

describe('Spike D: the eight §36.4 changes', () => {
  it('1. add optional field — compatible, zero findings', () => {
    expect(scan(variants.addOptionalField(artifact), docs)).toEqual([])
  })

  it('2. add required field — every article errors visibly until populated', () => {
    const f = scan(variants.addRequiredField(artifact), docs)
    const missing = f.filter((x) => x.code === 'MISSING_REQUIRED_FIELD' && x.path === 'summary')
    expect(missing).toHaveLength(30)
    expect(missing.every((x) => x.severity === 'hard')).toBe(true)
  })

  it('3. rename field — fails before migration, clean after, no data lost', () => {
    const branch = variants.renameField(artifact)
    const before = scan(branch, docs)
    expect(before.some((x) => x.code === 'MISSING_REQUIRED_FIELD' && x.path === 'headline')).toBe(true)
    expect(before.some((x) => x.code === 'UNKNOWN_FIELD' && x.path === 'title')).toBe(true)

    const migration = planRenameMigration(docs)
    expect(migration.affectedTypes).toEqual(['article'])
    expect(migration.operations).toHaveLength(30)

    const migrated = docs.map((d) => {
      const op = migration.operations.find((o) => o.documentId === d._id)
      return op ? applyMutations(d, op.mutations) : d
    })
    expect(scan(branch, migrated)).toEqual([])
    // No data loss: every headline equals the original title
    for (const d of migrated.filter((x) => x._type === 'article')) {
      const original = docs.find((x) => x._id === d._id)!
      expect(d.headline).toBe(original.title)
    }
  })

  it('4. change scalar type — hard TYPE_MISMATCH on every article', () => {
    const f = scan(variants.changeScalarType(artifact), docs)
    const mismatches = f.filter((x) => x.code === 'TYPE_MISMATCH' && x.path === 'publishedAt')
    expect(mismatches).toHaveLength(30)
  })

  it('5. change nested object shape — flagged at the nested path', () => {
    const f = scan(variants.changeNestedShape(artifact), docs)
    expect(f.some((x) => x.code === 'UNKNOWN_FIELD' && x.path === 'hero.cta.label')).toBe(true)
  })

  it('6. change reference target types — disallowed target detected', () => {
    const f = scan(variants.changeReferenceTargets(artifact), docs)
    const bad = f.filter((x) => x.code === 'DISALLOWED_REFERENCE_TARGET' && x.path === 'featuredArticle')
    expect(bad).toHaveLength(1)
    expect(bad[0].documentId).toBe('siteSettings')
    expect(bad[0].detail).toContain('"article"')
  })

  it('7. add new document type — base unaffected, branch-created doc valid', () => {
    const branch = variants.addDocumentType(artifact)
    expect(scan(branch, docs)).toEqual([])
    const event = {_id: 'event-1', _type: 'event', _createdAt: 'x', _updatedAt: 'x', _rev: 'x', title: 'Launch'}
    expect(scan(branch, [...docs, event])).toEqual([])
    const invalid = {_id: 'event-2', _type: 'event', _createdAt: 'x', _updatedAt: 'x', _rev: 'x'}
    expect(scan(branch, [invalid]).some((x) => x.code === 'MISSING_REQUIRED_FIELD' && x.path === 'title')).toBe(true)
  })

  it('8. remove document type — base pages become unknown, policy required', () => {
    const f = scan(variants.removeDocumentType(artifact), docs)
    const unknown = f.filter((x) => x.code === 'UNKNOWN_TYPE')
    expect(unknown.map((x) => x.documentId).sort()).toEqual(['legacy.page.v2', 'page-about', 'page-home'])
    expect(unknown.every((x) => x.severity === 'hard')).toBe(true)
  })
})

describe('Spike D: pass criteria', () => {
  it('no base data is lost — scanning and migration never mutate base documents', () => {
    expect(JSON.stringify(docs)).toBe(snapshot)
  })
})
