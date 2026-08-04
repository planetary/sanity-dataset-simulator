/**
 * Format version handling and the migration chain skeleton
 * (PRD §37 Phase 1 "Add format version handling" / "Add migration framework";
 * plan §4).
 *
 * `formatVersion: 1` is a literal on the manifest (§13.1), document record
 * (§13.3), checkpoint intent (§14.2), transaction record (§13.10) and identity
 * hash input (§12.1). Reads must reject unknown future versions with a
 * structured error rather than best-effort parsing.
 *
 * The migration chain is a registered, ordered, pure `vN -> vN+1` upgrade chain.
 * It is empty at v1 — there is no older version to upgrade from — but the
 * mechanism exists now so that a v2 format lands as data plus one registration,
 * not as a rewrite.
 *
 * This is distinct from *content* migrations (§20.4 `OverlayMigration`), which are
 * schema-driven and modelled in workstream W4.
 */
import {OverlayFormatVersionError, OverlayMigrationError} from './errors'
import {canonicalize} from './serialize'
import {OVERLAY_FORMAT_VERSION, type OverlayVersionedRecord} from './types/format-version'

export {OVERLAY_FORMAT_VERSION}
export type {OverlayFormatVersion, OverlayVersionedRecord} from './types/format-version'

/**
 * Assert that `value` is the format version this build supports.
 *
 * Throws {@link OverlayFormatVersionError} — carrying `code`,
 * `received` and `supportedVersion` — for any other value, including a numeric
 * string, a future version, and `undefined`.
 */
export function assertFormatVersion(value: unknown): asserts value is 1 {
  if (value !== OVERLAY_FORMAT_VERSION) {
    throw new OverlayFormatVersionError(value, OVERLAY_FORMAT_VERSION)
  }
}

/** Non-throwing form of {@link assertFormatVersion}. */
export function isSupportedFormatVersion(value: unknown): value is 1 {
  return value === OVERLAY_FORMAT_VERSION
}

/**
 * Read the `formatVersion` field of a persisted record and assert it is supported.
 * Use this at every read boundary (manifest, document record, transaction record).
 */
export function assertRecordFormatVersion(record: unknown): void {
  if (typeof record !== 'object' || record === null) {
    throw new OverlayFormatVersionError(
      undefined,
      OVERLAY_FORMAT_VERSION,
      'Expected an object carrying a formatVersion field',
    )
  }
  assertFormatVersion((record as {formatVersion?: unknown}).formatVersion)
}

/** A pure `from -> to` upgrade step. It must not mutate its input. */
export type OverlayMigrationStep = (record: OverlayVersionedRecord) => OverlayVersionedRecord

export interface RegisteredMigration {
  from: number
  to: number
  migrate: OverlayMigrationStep
}

export interface MigrationRegistryOptions {
  /** Version the chain upgrades to. Defaults to {@link OVERLAY_FORMAT_VERSION}. */
  targetVersion?: number
}

export interface MigrationRegistry {
  /** Version this registry upgrades records to. */
  readonly targetVersion: number
  /** Register one ordered, pure `from -> to` step. `to` must be `from + 1`. */
  register(from: number, to: number, migrate: OverlayMigrationStep): void
  /** Registered steps in ascending `from` order. */
  list(): RegisteredMigration[]
  /** True when a step is registered for `from`. */
  has(from: number): boolean
  /** Upgrade a record from its stored `formatVersion` to {@link targetVersion}. */
  migrate<T extends OverlayVersionedRecord>(record: T): OverlayVersionedRecord
  /** Drop every registration (test isolation). */
  clear(): void
}

/**
 * Create an isolated migration registry. The module-level {@link registerMigration}
 * and {@link migrate} delegate to one default registry targeting
 * {@link OVERLAY_FORMAT_VERSION}; tests and tooling can create their own.
 */
export function createMigrationRegistry(options: MigrationRegistryOptions = {}): MigrationRegistry {
  const targetVersion = options.targetVersion ?? OVERLAY_FORMAT_VERSION
  const steps = new Map<number, RegisteredMigration>()

  function register(from: number, to: number, step: OverlayMigrationStep): void {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new OverlayMigrationError(
        'OVERLAY_MIGRATION_INVALID',
        `Migration versions must be integers, received ${from} -> ${to}`,
        {from, to},
      )
    }
    if (to !== from + 1) {
      throw new OverlayMigrationError(
        'OVERLAY_MIGRATION_INVALID',
        `Migrations must be single-step: ${from} -> ${to} is not ${from} -> ${from + 1}`,
        {from, to},
      )
    }
    if (from < 1 || to > targetVersion) {
      throw new OverlayMigrationError(
        'OVERLAY_MIGRATION_INVALID',
        `Migration ${from} -> ${to} lies outside the supported range 1 -> ${targetVersion}`,
        {from, to, targetVersion},
      )
    }
    if (steps.has(from)) {
      throw new OverlayMigrationError(
        'OVERLAY_MIGRATION_INVALID',
        `A migration from version ${from} is already registered`,
        {from, to},
      )
    }
    steps.set(from, {from, to, migrate: step})
  }

  function migrateRecord<T extends OverlayVersionedRecord>(record: T): OverlayVersionedRecord {
    if (typeof record !== 'object' || record === null) {
      throw new OverlayFormatVersionError(
        undefined,
        targetVersion,
        'Expected an object carrying a formatVersion field',
      )
    }

    const startVersion = (record as {formatVersion?: unknown}).formatVersion
    if (typeof startVersion !== 'number' || !Number.isInteger(startVersion) || startVersion < 1) {
      throw new OverlayFormatVersionError(startVersion, targetVersion)
    }
    if (startVersion > targetVersion) {
      // A future version cannot be downgraded; reject rather than best-effort parse.
      throw new OverlayFormatVersionError(startVersion, targetVersion)
    }

    let current: OverlayVersionedRecord = record
    for (let version = startVersion; version < targetVersion; version++) {
      const step = steps.get(version)
      if (!step) {
        throw new OverlayMigrationError(
          'OVERLAY_MIGRATION_MISSING',
          `No registered migration from overlay format version ${version} to ${version + 1}`,
          {from: version, to: version + 1, targetVersion},
        )
      }
      // canonicalize gives each step a fresh, prototype-safe deep copy, so a step
      // that mutates its argument cannot corrupt the caller's record.
      const next = step.migrate(canonicalize(current))
      if (typeof next !== 'object' || next === null) {
        throw new OverlayMigrationError(
          'OVERLAY_MIGRATION_INVALID',
          `Migration ${version} -> ${version + 1} did not return a record`,
          {from: version, to: version + 1},
        )
      }
      current = {...next, formatVersion: step.to}
    }

    return current
  }

  return {
    targetVersion,
    register,
    list: () => [...steps.values()].sort((a, b) => a.from - b.from),
    has: (from: number) => steps.has(from),
    migrate: migrateRecord,
    clear: () => steps.clear(),
  }
}

/** The default chain, targeting {@link OVERLAY_FORMAT_VERSION}. Empty at v1. */
export const migrations: MigrationRegistry = createMigrationRegistry()

/** Register a pure `from -> to` step on the default chain. */
export function registerMigration(from: number, to: number, step: OverlayMigrationStep): void {
  migrations.register(from, to, step)
}

/**
 * Upgrade a persisted record to the current format version using the default
 * chain. At v1 this validates and returns the record unchanged.
 */
export function migrate<T extends OverlayVersionedRecord>(record: T): OverlayVersionedRecord {
  return migrations.migrate(record)
}
