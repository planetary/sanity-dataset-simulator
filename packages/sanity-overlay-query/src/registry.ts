/**
 * Query registry — PRD §22.4 (model), §22.5 (registration requirements),
 * §22.9 (`QUERY_NOT_REGISTERED`, `QUERY_CHANGED`).
 *
 * The registry is the authority on what may be evaluated. §22.5 requires a
 * stable query ID, version-controlled query text and candidate plan, and
 * rejection of unregistered queries; §5.5 requires that nothing is silently
 * approximated. Both are enforced here rather than at the call site.
 */
import {sha256Hex} from '../../sanity-overlay-core/src/checksum'
import {OverlayQueryError} from './errors'
import type {OverlayQueryDefinition, QueryCaller, QueryPerspective} from './types'

/**
 * SHA-256 of the query text, hex encoded — the same primitive PRD §13.2 fixes
 * for every other checksum in the system. The text is hashed byte for byte:
 * normalising whitespace would let a reformat pass unreviewed, and §22.5 wants
 * a query change to be visible.
 */
export const queryTextChecksum = (query: string): string => sha256Hex(query)

/**
 * Validate one registration. The pinned `queryChecksum` must match the query
 * text, so editing the text without refreshing the registration fails loudly
 * (§22.5 "CI fails when a query changes without refreshed parity tests").
 */
export function defineOverlayQuery(def: OverlayQueryDefinition): OverlayQueryDefinition {
  const actual = queryTextChecksum(def.query)
  if (actual !== def.queryChecksum) {
    throw new OverlayQueryError(
      'QUERY_CHANGED',
      `Query ${def.id} does not match its registered checksum. ` +
        `The query text was edited without refreshing the registration (PRD §22.5).`,
      {queryId: def.id, registeredChecksum: def.queryChecksum, actualChecksum: actual},
    )
  }
  if (def.status !== 'unsupported') {
    if (def.candidatePlan.type === 'none') {
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Query ${def.id} is registered ${def.status} but carries no candidate plan.`,
        {queryId: def.id},
      )
    }
    if (!(def.maxCandidates > 0) || !(def.maxReferenceDepth > 0)) {
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Query ${def.id} must register positive maxCandidates and maxReferenceDepth (PRD §22.4).`,
        {queryId: def.id},
      )
    }
  }
  return def
}

export interface OverlayQueryRegistry {
  readonly definitions: readonly OverlayQueryDefinition[]
  has(id: string): boolean
  /** Look up by stable query ID. Throws `QUERY_NOT_REGISTERED` when absent. */
  get(id: string): OverlayQueryDefinition
  /**
   * Look up by ID and verify the caller's query text against the registered
   * checksum. Throws `QUERY_CHANGED` on drift (§22.9).
   */
  resolve(id: string, queryText?: string): OverlayQueryDefinition
  /** §22.4 `allowedCallers`. */
  assertCallerAllowed(def: OverlayQueryDefinition, caller: QueryCaller): void
  /** §22.4 `perspectives`. */
  assertPerspectiveRegistered(def: OverlayQueryDefinition, perspective: QueryPerspective): void
}

export function createQueryRegistry(
  definitions: readonly OverlayQueryDefinition[],
): OverlayQueryRegistry {
  const byId = new Map<string, OverlayQueryDefinition>()
  for (const def of definitions) {
    if (byId.has(def.id)) {
      throw new OverlayQueryError('QUERY_CHANGED', `Duplicate query id ${def.id} in registry.`, {
        queryId: def.id,
      })
    }
    byId.set(def.id, defineOverlayQuery(def))
  }

  const get = (id: string): OverlayQueryDefinition => {
    const def = byId.get(id)
    if (!def) {
      throw new OverlayQueryError(
        'QUERY_NOT_REGISTERED',
        `Query ${JSON.stringify(id)} is not registered. Unregistered queries are rejected, ` +
          `never approximated (PRD §22.5, §5.5).`,
        {queryId: id},
      )
    }
    return def
  }

  return {
    definitions,
    has: (id) => byId.has(id),
    get,
    resolve(id, queryText) {
      const def = get(id)
      if (queryText !== undefined && queryTextChecksum(queryText) !== def.queryChecksum) {
        throw new OverlayQueryError(
          'QUERY_CHANGED',
          `Query text for ${id} differs from the registered checksum (PRD §22.9).`,
          {
            queryId: id,
            registeredChecksum: def.queryChecksum,
            actualChecksum: queryTextChecksum(queryText),
          },
        )
      }
      return def
    },
    assertCallerAllowed(def, caller) {
      if (!def.allowedCallers.includes(caller)) {
        throw new OverlayQueryError(
          'QUERY_CALLER_NOT_ALLOWED',
          `Caller ${caller} is not registered for query ${def.id} (PRD §22.4 allowedCallers).`,
          {queryId: def.id, caller, allowedCallers: [...def.allowedCallers]},
        )
      }
    },
    assertPerspectiveRegistered(def, perspective) {
      if (!def.perspectives.includes(perspective)) {
        throw new OverlayQueryError(
          'QUERY_PERSPECTIVE_NOT_REGISTERED',
          `Perspective ${perspective} is not registered for query ${def.id} (PRD §22.4).`,
          {queryId: def.id, perspective, perspectives: [...def.perspectives]},
        )
      }
    },
  }
}
