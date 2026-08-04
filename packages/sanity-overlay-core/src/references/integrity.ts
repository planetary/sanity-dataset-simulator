/**
 * PRD §18.8, §18.6, §19.5 and invariant §34.10 — strong and weak integrity.
 *
 * Three questions, one module:
 *
 * - **Delete** (§18.8): "Check incoming strong references in the virtual dataset.
 *   Block delete when a strong reference would become invalid unless the same
 *   transaction updates or deletes all referring documents." The *unless* clause
 *   is applied by the mutation engine (`blockingStrongReferences`), which knows
 *   the transaction; this module answers the first half — who points here.
 * - **Publish** (§19.5, §34.10): "Strong reference to a branch draft-only target
 *   blocks branch publish" / "Strong references resolve to a published virtual
 *   target before branch publish." That is the *outgoing* question, asked of the
 *   draft about to be published.
 * - **Unpublish** (§18.6): "Reevaluate strong references that point to the
 *   now-unpublished document." Reported, never blocking.
 *
 * `createStrongReferenceCheck` packages all three as the W2
 * {@link StrongReferenceCheck} port, so the mutation engine and the document
 * actions get real reference integrity by injection alone — no import from W4
 * into W2, and the no-op default stays the documented fallback.
 *
 * **Which perspective.** §18.8 says *the virtual dataset*, not one perspective, so
 * the incoming scan runs under both `drafts` and `published` and unions the
 * result: a strong reference held only by the published version of a referrer is
 * every bit as dangling after a delete as one held by its draft. Pass
 * `perspective` to narrow it when the caller genuinely means one view.
 */
import {encodeOverlayPath, toPublishedId} from '../encoding'
import type {BaseDocumentSource, StrongReferenceCheck, StrongReferenceIssue} from '../mutations/ports'
import {resolveDraft} from '../mutations/resolve'
import type {OverlayPath} from '../types/path'
import type {OverlayState} from '../mutations/state'
import {referenceRuleAt, type SerializedSchemaArtifact} from '../validation/schema'
import type {OverlayValidationIssue} from '../validation/validator'
import {extractReferences} from './extract'
import {resolveReferenceTarget} from './resolve'
import {
  scanReverseReferences,
  type BaseReverseReferenceHit,
  type BaseReverseReferenceSource,
  type ReverseReference,
} from './reverse'
import type {ReferencePerspective, ReferenceStrength} from './types'

/** Why an incoming reference is being reported (the §18.8 / §18.6 vocabulary). */
export type IncomingReferenceReason = StrongReferenceIssue['reason']

export interface ReferenceIntegrityContext {
  base?: BaseDocumentSource
  /** Base-side `references($ids)` answer (PRD §19.4), as data or as a source. */
  baseReferences?: BaseReverseReferenceSource | readonly BaseReverseReferenceHit[]
  /** PRD §20.1 artifact — decides schema-declared weakness (§19.5). */
  schema?: SerializedSchemaArtifact
  /** Narrow the scan to one perspective. Default: both, per §18.8. */
  perspective?: ReferencePerspective
}

export interface IncomingReferenceOptions extends ReferenceIntegrityContext {
  /** Reason stamped on every issue. Defaults to the §18.8 delete reason. */
  reason?: IncomingReferenceReason
}

const BOTH_PERSPECTIVES: readonly ReferencePerspective[] = ['drafts', 'published']

/**
 * Every direct reference pointing at `targetId`, deduplicated across the
 * perspectives that were scanned (PRD §19.4).
 *
 * The unreduced form behind {@link incomingReferences}: migration planning
 * (§19.6, §19.7) needs the reference rows themselves, not the delete-flavoured
 * issue projection. When a reference is visible under both perspectives the entry
 * keeps the first one scanned (`drafts`), since the pair addresses one and the
 * same reference.
 */
export function incomingReferenceGraph(
  state: OverlayState,
  targetId: string,
  options: ReferenceIntegrityContext = {},
): ReverseReference[] {
  const logicalId = toPublishedId(targetId)
  const perspectives =
    options.perspective === undefined ? BOTH_PERSPECTIVES : [options.perspective]

  const byKey = new Map<string, ReverseReference>()
  for (const perspective of perspectives) {
    const result = scanReverseReferences(state, {
      targetIds: [logicalId],
      perspective,
      maxReferenceDepth: 1,
      ...(options.base === undefined ? {} : {base: options.base}),
      ...(options.baseReferences === undefined ? {} : {baseReferences: options.baseReferences}),
      ...(options.schema === undefined ? {} : {schema: options.schema}),
    })

    for (const reference of result.references) {
      const key = `${reference.referringDocumentId} ${encodeOverlayPath(reference.path)} ${
        reference.targetId
      }`
      const existing = byKey.get(key)
      if (existing === undefined) byKey.set(key, {...reference})
      else existing.strength = strongest(existing.strength, reference.strength)
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.referringDocumentId !== b.referringDocumentId) {
      return a.referringDocumentId < b.referringDocumentId ? -1 : 1
    }
    const left = encodeOverlayPath(a.path)
    const right = encodeOverlayPath(b.path)
    if (left !== right) return left < right ? -1 : 1
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0
  })
}

/** Human-readable path, for messages a reviewer reads (`related[_key==r1]._ref`). */
function formatPath(path: OverlayPath): string {
  return path
    .map((segment) =>
      typeof segment === 'object' ? `[_key==${segment._key}]` : `.${String(segment)}`,
    )
    .join('')
    .replace(/^\./, '')
}

function issueKey(issue: StrongReferenceIssue): string {
  return `${issue.referringDocumentId} ${encodeOverlayPath(issue.path)} ${issue.targetId}`
}

/** "Strong" wins a disagreement: it is the safe direction for delete blocking. */
function strongest(a: ReferenceStrength, b: ReferenceStrength): ReferenceStrength {
  return a === 'strong' || b === 'strong' ? 'strong' : 'weak'
}

function sortIssues(issues: StrongReferenceIssue[]): StrongReferenceIssue[] {
  return issues.sort((a, b) => {
    if (a.referringDocumentId !== b.referringDocumentId) {
      return a.referringDocumentId < b.referringDocumentId ? -1 : 1
    }
    const left = encodeOverlayPath(a.path)
    const right = encodeOverlayPath(b.path)
    if (left !== right) return left < right ? -1 : 1
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0
  })
}

/**
 * Every reference pointing at `targetId` in the virtual dataset (PRD §18.8).
 *
 * Weak references are reported too, carrying `strength: 'weak'`: §19.5 lets them
 * dangle, so a caller that blocks must filter to `strong` — which is exactly what
 * the mutation engine does — while a caller that *reports* (a UI impact list)
 * wants both.
 *
 * Depth is deliberately 1. "Who points at this document" is answered completely by
 * the direct referrers, so a bounded closure never makes this answer partial.
 */
export function incomingReferences(
  state: OverlayState,
  targetId: string,
  options: IncomingReferenceOptions = {},
): StrongReferenceIssue[] {
  const reason = options.reason ?? 'target-deleted'
  return sortIssues(
    incomingReferenceGraph(state, targetId, options).map((reference) => ({
      referringDocumentId: reference.referringDocumentId,
      path: reference.path,
      targetId: reference.targetId,
      strength: reference.strength,
      reason,
    })),
  )
}

/**
 * References held by the draft about to be published that do not resolve to a
 * published virtual target (PRD §19.5, invariant §34.10).
 *
 * Weak references are included with `strength: 'weak'` so a UI can warn; only the
 * strong ones block, and that filtering belongs to the caller.
 */
export function publishReferenceIssues(
  state: OverlayState,
  documentId: string,
  options: ReferenceIntegrityContext = {},
): StrongReferenceIssue[] {
  const logicalId = toPublishedId(documentId)
  const resolveContext = options.base === undefined ? {} : {base: options.base}
  const draft = resolveDraft(state, logicalId, resolveContext)
  if (draft === null) return []

  const issues: StrongReferenceIssue[] = []
  for (const reference of extractReferences(draft, {
    ...(options.schema === undefined ? {} : {schema: options.schema}),
  })) {
    const target = resolveReferenceTarget(state, reference.targetId, {
      ...resolveContext,
      perspective: 'published',
    })
    if (target.publishedAvailable) continue

    issues.push({
      referringDocumentId: logicalId,
      path: reference.path,
      targetId: reference.targetId,
      strength: reference.strength,
      reason:
        target.origin === 'local-tombstone'
          ? 'target-deleted'
          : target.draftOnly
            ? 'target-draft-only'
            : 'target-unpublished',
    })
  }

  return sortIssues(issues)
}

/**
 * PRD §20.5 "On branch publish: run full document validation **and reference
 * checks**", expressed as validation issues so it composes with the §17.3 step 9
 * validator port.
 *
 * Two rules, both from the schema workflow:
 *
 * - §19.5 / §34.10 — a **strong** reference must resolve to a published virtual
 *   target. A weak one may dangle, so it is a warning.
 * - §20.3 / §19.7 — "References to disallowed target types": the reference field's
 *   allowed `to` list must contain the target's actual `_type`.
 *
 * A path the artifact says nothing about produces no issue; core never invents a
 * rule it was not given.
 */
export function referenceValidationIssues(
  state: OverlayState,
  documentId: string,
  options: ReferenceIntegrityContext = {},
): OverlayValidationIssue[] {
  const logicalId = toPublishedId(documentId)
  const resolveContext = options.base === undefined ? {} : {base: options.base}
  const document = resolveDraft(state, logicalId, resolveContext)
  if (document === null) return []

  const issues: OverlayValidationIssue[] = []
  for (const reference of extractReferences(document, {
    ...(options.schema === undefined ? {} : {schema: options.schema}),
  })) {
    const where = formatPath(reference.path)
    const target = resolveReferenceTarget(state, reference.targetId, {
      ...resolveContext,
      perspective: 'published',
    })

    if (!target.publishedAvailable) {
      issues.push({
        level: reference.strength === 'strong' ? 'error' : 'warning',
        ruleId: 'reference-not-published',
        message: `${
          reference.strength === 'strong' ? 'Strong' : 'Weak'
        } reference at ${JSON.stringify(where)} targets ${JSON.stringify(
          reference.targetId,
        )}, which has no published virtual document`,
        path: reference.path,
      })
    }

    const targetType =
      target.document?._type ??
      resolveReferenceTarget(state, reference.targetId, {...resolveContext, perspective: 'drafts'})
        .document?._type
    if (targetType === undefined) continue

    const rule = referenceRuleAt(options.schema, document._type, reference.path)
    if (rule === null || rule.to.length === 0 || rule.to.includes(targetType)) continue
    issues.push({
      level: 'error',
      ruleId: 'reference-type-not-allowed',
      message: `Reference at ${JSON.stringify(where)} targets type ${JSON.stringify(
        targetType,
      )}, which is not in [${rule.to.map((name) => JSON.stringify(name)).join(', ')}]`,
      path: reference.path,
    })
  }

  return issues
}

/**
 * The W4 implementation of the W2 {@link StrongReferenceCheck} port.
 *
 * `state` is the pre-transaction state, which is the state §18.8 asks about: the
 * "unless the same transaction …" exemption is expressed through
 * `transactionDocumentIds`, not by looking at half-applied state.
 */
export function createStrongReferenceCheck(
  state: OverlayState,
  context: ReferenceIntegrityContext = {},
): StrongReferenceCheck {
  return (input) => {
    if (input.action === 'publish') {
      return publishReferenceIssues(state, input.documentId, context)
    }
    return incomingReferences(state, input.documentId, {
      ...context,
      reason: input.action === 'unpublish' ? 'target-unpublished' : 'target-deleted',
    })
  }
}
