/**
 * Re-export shim. Structured store errors (PRD §25.14 error contract).
 *
 * The module now lives in `sanity-overlay-core/src/store/errors.ts` (plan §8.1,
 * PRD §10.1): a core-resident adapter cannot import its contract from a storage
 * package without inverting the dependency. This file keeps
 * `sanity-overlay-store-fs` and every existing importer working unchanged, and
 * re-exports the *same* declarations — so `instanceof` and `isOverlayStoreError`
 * still hold across package boundaries.
 */
export * from 'sanity-overlay-core/store/errors'
