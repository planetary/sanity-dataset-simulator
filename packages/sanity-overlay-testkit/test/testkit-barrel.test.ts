/**
 * The testkit barrel is the package's public surface (plan §8.6): Phases 3 and 4
 * consume the store-contract runner, the deterministic fixture builders and the
 * write-guard contract through it, not by deep relative path.
 *
 * The Phase 2 acceptance audit (F-10) found the fixture builders and the
 * write-guard contract were never re-exported, so `src/index.ts` did not
 * actually deliver what §8.6 promises. This pins the surface so a future
 * re-organisation cannot quietly drop a consumer's import.
 */
import {describe, expect, it} from 'vitest'
import * as testkit from '../src/index'

describe('testkit barrel — plan §8.6 public surface', () => {
  it('exports the reusable store contract runner (PRD §35.7)', () => {
    expect(typeof testkit.runStoreContractSuite).toBe('function')
    expect(typeof testkit.documentRecordFixture).toBe('function')
    expect(typeof testkit.conflictFixture).toBe('function')
  })

  it('exports the deterministic merge fixture builders and seeded generators', () => {
    expect(typeof testkit.createRng).toBe('function')
    expect(typeof testkit.generateScenario).toBe('function')
    expect(typeof testkit.scenarioCorpus).toBe('function')
    expect(Array.isArray(testkit.MERGE_SEED_CORPUS)).toBe(true)
    expect(testkit.MERGE_SEED_CORPUS.length).toBeGreaterThan(0)
  })

  it('exports the reference fixtures, fixed clock and transaction-ID source', () => {
    expect(typeof testkit.fixedClock).toBe('function')
    expect(typeof testkit.createTransactionSource).toBe('function')
    expect(Array.isArray(testkit.BASE_DOCUMENTS)).toBe(true)
    expect(Array.isArray(testkit.BASE_REVERSE_HITS)).toBe(true)
    expect(testkit.REFERENCE_SCHEMA).toBeDefined()
  })

  it('exports the injected-validation port fixtures (plan §7 validation port)', () => {
    expect(typeof testkit.createFixtureValidator).toBe('function')
    expect(testkit.RELAXED_SCHEMA).toBeDefined()
  })

  it('exports the write-guard contract and the Spike F attack corpus (PRD §35.14)', () => {
    expect(typeof testkit.runWriteGuardContract).toBe('function')
    expect(typeof testkit.spikeFAttackVectors).toBe('function')
    expect(Array.isArray(testkit.WRITE_GUARD_CASES)).toBe(true)
    expect(testkit.spikeFAttackVectors().length).toBeGreaterThan(0)
  })

  it('keeps the generators usable through the barrel, not merely present', () => {
    // Non-vacuity: a re-export that resolved to `undefined` would satisfy a
    // `typeof` check on a namespace object in some bundlers. Call them.
    const rng = testkit.createRng(testkit.MERGE_SEED_CORPUS[0]!)
    const a = rng.next()
    const b = rng.next()
    expect(a).not.toBe(b)

    const scenario = testkit.generateScenario(testkit.MERGE_SEED_CORPUS[0]!)
    expect(scenario.ancestor).toBeDefined()
    expect(scenario.currentBase).toBeDefined()

    expect(testkit.fixedClock('2026-08-04T09:00:00.000Z')()).toBe('2026-08-04T09:00:00.000Z')
  })
})
