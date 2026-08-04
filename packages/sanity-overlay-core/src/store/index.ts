/**
 * Workstream W5 — the store contract and the in-memory adapter (plan §8.1).
 *
 * ## Why the store surface lives in core
 *
 * PRD §10.1 makes the contract adapter-neutral ("Store adapters implement the
 * same contract") and plan §8.1 assigns it to this phase, alongside the memory
 * adapter that is its reference implementation. Hosting it here is what lets
 * `sanity-overlay-store-fs` (Phase 3) and the Blob adapter (Phase 4) depend on
 * core rather than on each other; the previous location inside the filesystem
 * package would have forced a core-resident adapter to import from a storage
 * package, inverting the dependency. Nothing in this directory touches `node:*`,
 * a filesystem, a network or a browser API, so it stays inside the plan §3
 * boundary — enforced by `test/core-boundaries.test.ts`.
 */

/* Structured store errors — PRD §25.14. */
export * from './errors'

/* The adapter-neutral store contract — PRD §35.7, plan §8.1. */
export * from './contract'

/* Review-facing document intent and content-addressed base snapshots — PRD §14.2. */
export * from './intent'

/* The in-memory adapter — PRD §11.1 `mode: 'memory'`, plan §8.1. */
export * from './memoryStore'
