/**
 * Re-export shim. Review-facing document intent (PRD §14.2).
 *
 * The module now lives in `sanity-overlay-core/src/store/intent.ts` (plan §8.1,
 * PRD §10.1): a core-resident adapter cannot import its contract from a storage
 * package without inverting the dependency. This file keeps
 * `sanity-overlay-store-fs` and every existing importer working unchanged, and
 * re-exports the *same* declarations — so `instanceof` and `isOverlayStoreError`
 * still hold across package boundaries.
 */
export * from '../../sanity-overlay-core/src/store/intent'
