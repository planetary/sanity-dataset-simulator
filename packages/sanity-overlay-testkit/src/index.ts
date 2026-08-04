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
