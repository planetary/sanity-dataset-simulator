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

/**
 * What the planner needs to know about the BRANCH, and nothing more.
 *
 * §22.6's bounded top-K rule is stated as `baseFetchCount = requestedEnd +
 * affectedCount`, so a top-K plan is not a function of the registration and the
 * parameters alone — it also depends on how many documents the branch touched.
 * That dependency is made explicit here rather than by handing the planner an
 * overlay it could read anything out of: the only fact it receives is the set
 * of touched IDs.
 */
export interface CandidatePlanContext {
  /** Every ID the branch touched: overlay records and tombstones alike. */
  readonly affectedIds: readonly string[]
}

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

/**
 * Read a parameter as document IDs, rejecting values that cannot be any.
 *
 * A parameter may carry ONE ID (`*[_id == $id]`) or a LIST of them
 * (`*[_id in $ids]`, the single most common Studio shape). Both are equally
 * enumerable — the base request transfers exactly the IDs named, whether they
 * arrived through one parameter or several — so restricting the parameter to a
 * scalar bought no boundedness and cost the `in` shape its template plan.
 * Boundedness is still decided where it belongs: `maxCandidates` caps the
 * resolved set in `evaluate.ts` (§22.9), so a caller who passes a thousand IDs
 * to a query registered for one gets `CANDIDATE_LIMIT_EXCEEDED`, not a scan.
 *
 * What stays refused is the dangerous shape: an ABSENT or malformed parameter.
 * "No ID supplied, so fetch everything" is the failure mode §5.5 forbids.
 */
function idsParam(
  def: OverlayQueryDefinition,
  params: Record<string, unknown>,
  name: string,
): string[] {
  const value = params[name]
  const isId = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0

  if (isId(value)) return [value]
  if (Array.isArray(value) && value.every(isId)) return [...value]

  throw new OverlayQueryError(
    'UNSUPPORTED_GROQ',
    `Query ${def.id} plans candidates from parameter ${JSON.stringify(name)}, which must be a ` +
      `non-empty string document ID or an array of them; received ` +
      `${JSON.stringify(value ?? null)}. Guessing a candidate set from an absent parameter ` +
      `would be a silent approximation (PRD §5.5).`,
    {queryId: def.id, parameter: name, received: value ?? null},
  )
}

/** Read a parameter that must be present, rejecting an absent one loudly. */
function requiredParam(
  def: OverlayQueryDefinition,
  params: Record<string, unknown>,
  name: string,
): unknown {
  if (params[name] === undefined) {
    throw new OverlayQueryError(
      'UNSUPPORTED_GROQ',
      `Query ${def.id} plans candidates from parameter ${JSON.stringify(name)}, which was not ` +
        `supplied. Widening the candidate set to cover a missing parameter would be a silent ` +
        `approximation (PRD §5.5).`,
      {queryId: def.id, parameter: name},
    )
  }
  return params[name]
}

export function planCandidateRequests(
  def: OverlayQueryDefinition,
  params: Record<string, unknown>,
  context?: CandidatePlanContext,
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
      const ids = plan.idsFromParams.flatMap((name) => idsParam(def, params, name))
      return {baseRequests: [{kind: 'ids', ids}], explicitIds: ids, overlayTypes: []}
    }

    case 'ids-literal':
      return {
        baseRequests: [{kind: 'ids', ids: plan.ids}],
        explicitIds: plan.ids,
        overlayTypes: [],
      }

    case 'slug': {
      const value = requiredParam(def, params, plan.valueFromParam)
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

    case 'field-contains': {
      const value = requiredParam(def, params, plan.valueFromParam)
      // Array membership over a LOCAL array: same exactness argument as `slug`.
      return {
        baseRequests: [{kind: 'field-contains', types: plan.types, path: plan.path, value}],
        explicitIds: [],
        overlayTypes: plan.types,
      }
    }

    case 'references': {
      const value = requiredParam(def, params, plan.idFromParam)
      if (typeof value !== 'string' || value.length === 0) {
        throw new OverlayQueryError(
          'UNSUPPORTED_GROQ',
          `Query ${def.id} plans candidates from parameter ` +
            `${JSON.stringify(plan.idFromParam)}, which must be a non-empty document ID; ` +
            `received ${JSON.stringify(value ?? null)}. §22.3 admits references() for FINITE ` +
            `ids only.`,
          {queryId: def.id, parameter: plan.idFromParam, received: value ?? null},
        )
      }
      return {
        baseRequests: [{kind: 'references', types: plan.types, id: value}],
        explicitIds: [],
        overlayTypes: plan.types,
      }
    }

    case 'top-k': {
      if (!context) {
        // §22.6's own formula depends on `affectedCount`. Defaulting it to zero
        // would silently under-fetch the moment a branch existed, which is the
        // one failure mode candidate planning must never have, so this refuses
        // rather than guesses.
        throw new OverlayQueryError(
          'UNSUPPORTED_GROQ',
          `Query ${def.id} uses the bounded top-K plan, whose base fetch depends on the branch ` +
            `delta (§22.6). It cannot be planned without the set of touched document IDs.`,
          {queryId: def.id},
        )
      }
      if (!(plan.sliceEnd > 0) || plan.order.length === 0) {
        throw new OverlayQueryError(
          'UNSUPPORTED_GROQ',
          `Query ${def.id} registers a top-K plan without a positive slice end and an order.`,
          {queryId: def.id},
        )
      }
      return {
        baseRequests: [
          {
            kind: 'order-slice',
            types: plan.types,
            order: plan.order,
            limit: plan.sliceEnd,
            excludeIds: context.affectedIds,
          },
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
