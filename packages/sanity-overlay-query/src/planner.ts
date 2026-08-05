/**
 * Candidate planners — PRD §22.6 steps 4 to 7, §22.7 worked examples.
 *
 * The `[M-LOCAL]` slice: ID and slug planners (PRD §37 Phase 2), plus the
 * type planner that the two registered list queries need.
 *
 * A plan is a pure function of the registered definition and the call
 * parameters. It produces the base requests to issue and the rule for which
 * branch records join them — nothing else. Fetching, resolution, expansion and
 * evaluation happen in `evaluate.ts`, so a plan can be inspected and tested
 * without a dataset.
 */
import {OverlayQueryError} from './errors'
import type {BaseCandidateRequest} from './baseSource'
import type {OverlayQueryDefinition} from './types'

export interface CandidatePlanRequests {
  /** Base fetches to issue (§22.6 step 5). */
  readonly baseRequests: readonly BaseCandidateRequest[]
  /**
   * IDs that must be resolved virtually even when base returns nothing for
   * them — a branch-created document at a requested ID (§22.6 step 6).
   */
  readonly explicitIds: readonly string[]
  /**
   * Branch records of these types join the candidate set (§22.6 step 6): a
   * branch edit can make a document newly match a type or field predicate that
   * no base fetch could have selected.
   *
   * Empty for ID plans, and that is exact rather than an omission: no branch
   * record at a different ID can satisfy `_id == $id`.
   */
  readonly overlayTypes: readonly string[]
}

/** Read a parameter as a document ID, rejecting values that cannot be one. */
function idParam(def: OverlayQueryDefinition, params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new OverlayQueryError(
      'UNSUPPORTED_GROQ',
      `Query ${def.id} plans candidates from parameter ${JSON.stringify(name)}, which must be a ` +
        `non-empty string document ID; received ${JSON.stringify(value ?? null)}. Guessing a ` +
        `candidate set from an absent parameter would be a silent approximation (PRD §5.5).`,
      {queryId: def.id, parameter: name, received: value ?? null},
    )
  }
  return value
}

export function planCandidateRequests(
  def: OverlayQueryDefinition,
  params: Record<string, unknown>,
): CandidatePlanRequests {
  const plan = def.candidatePlan
  switch (plan.type) {
    case 'none':
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Query ${def.id} has no finite exact candidate plan: ${plan.reason}`,
        {queryId: def.id, reason: plan.reason},
      )

    case 'ids': {
      const ids = plan.idsFromParams.map((name) => idParam(def, params, name))
      return {baseRequests: [{kind: 'ids', ids}], explicitIds: ids, overlayTypes: []}
    }

    case 'ids-literal':
      return {
        baseRequests: [{kind: 'ids', ids: plan.ids}],
        explicitIds: plan.ids,
        overlayTypes: [],
      }

    case 'slug': {
      const value = params[plan.valueFromParam]
      if (value === undefined) {
        throw new OverlayQueryError(
          'UNSUPPORTED_GROQ',
          `Query ${def.id} plans candidates from parameter ` +
            `${JSON.stringify(plan.valueFromParam)}, which was not supplied.`,
          {queryId: def.id, parameter: plan.valueFromParam},
        )
      }
      // PRD §22.7: "exact slug-filtered pages plus all overlaid page documents".
      // The predicate reads a LOCAL field, so the base can answer it exactly;
      // the branch delta covers everything the base could not have known about.
      return {
        baseRequests: [
          {kind: 'field-equality', types: plan.types, path: plan.path, value},
        ],
        explicitIds: [],
        overlayTypes: plan.types,
      }
    }

    case 'types':
      return {
        baseRequests: [{kind: 'types', types: plan.types}],
        explicitIds: [],
        overlayTypes: plan.types,
      }

    default: {
      const exhaustive: never = plan
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Unknown candidate plan ${JSON.stringify(exhaustive)}`,
        {queryId: def.id},
      )
    }
  }
}
