export {loadFixtureDataset, publishedPerspective, draftsPerspective} from './fixtures'
export type {FixtureDocument} from './fixtures'
export {runGroq} from './groq'
export {loadEnv} from './env'
export {hostedConfigFromEnv, hostedQuery} from './hosted'
export type {HostedConfig} from './hosted'

/**
 * Reusable store contract runner (PRD §35.7, plan §8.6) — exported so the
 * filesystem adapter (Phase 3) and the Blob adapter (Phase 4) run the identical
 * seventeen-case suite unchanged.
 */
export {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  conflictFixture,
  documentRecordFixture,
  runStoreContractSuite,
} from './storeContract'
export type {
  DocumentRecordFixtureOptions,
  StoreContractFactory,
  StoreContractHarness,
} from './storeContract'

/**
 * Deterministic fixture builders and generators (plan §8.6): ancestor / current
 * base / local triples for §35.2-§35.6, plus the seeded generators, fixed clock
 * and transaction-ID source that keep every suite reproducible.
 */
export * from './mergeFixtures'
export * from './referenceFixtures'
export * from './validationFixtures'

/**
 * Reusable write-guard classifier contract, including the Spike F attack
 * vectors (PRD §35.14) — exported so any enforcement point can be held to the
 * same corpus.
 */
export {
  SPIKE_F_ATTACK_NUMBERS,
  SPIKE_F_UNCLASSIFIABLE_ATTACKS,
  SPIKE_F_WITNESS_GAPS,
  WRITE_GUARD_CASES,
  runWriteGuardContract,
  spikeFAttackVectors,
  spikeFWitnesses,
} from './writeGuardContract'
export type {
  WriteGuardCase,
  WriteGuardGroup,
  WriteGuardPredicate,
  WriteGuardRequest,
} from './writeGuardContract'
